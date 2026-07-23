// Portable secrets-store contract:
// - construction is filesystem-lazy and all public operations are synchronous;
// - callers inject the exact names they are allowed to read or mutate;
// - getSecret/setSecret/listSecrets/removeSecret form the backend-neutral API;
// - listAllowedNames exposes policy names, never values, for env scrubbing;
// - list operations return masked metadata, while exportEnv is an internal,
//   audited boundary for subprocess and integration environment injection.
// - withExclusiveLock synchronously composes a secret mutation with related
//   metadata writes without allowing another process to observe a mixed state.
// Backends may change storage details, but must preserve these semantics and
// must never place secret values or previews in the audit log.

import fs from "node:fs";
import path from "node:path";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

const SNAPSHOT_VERSION = 1;
const MANAGED_ENV_BEGIN = "# BEGIN OPENAGI MANAGED SECRETS";
const MANAGED_ENV_END = "# END OPENAGI MANAGED SECRETS";
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class SecretsStore {
  constructor({
    dataDir = resolveDataDir(),
    allowlist = [],
    env = process.env,
    now = () => new Date(),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.dir = path.join(this.dataDir, "secrets");
    this.snapshotPath = path.join(this.dir, "secrets.json");
    this.auditPath = path.join(this.dir, "audit.jsonl");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.envPath = path.join(this.dataDir, ".env");
    this.allowlist = normalizeAllowlist(allowlist);
    this.env = env;
    this.now = now;
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = positiveInteger(staleLockMs, DEFAULT_STALE_LOCK_MS);
    this.lockDepth = 0;
  }

  initialize({
    decidedBy = "system:initialize",
    migrationValues = {}
  } = {}) {
    return this.#withMutationLock(() => {
      const loaded = this.#loadFresh({ decidedBy, migrationValues });
      this.#hydrateProcessEnv(loaded.snapshot);
      this.#writeEnvProjection(loaded.snapshot);
      this.#audit({
        action: "initialize",
        decidedBy,
        count: this.#configuredEntries(loaded.snapshot).length,
        migrated: loaded.migrated
      });
      return {
        initialized: true,
        migrated: loaded.migrated,
        count: this.#configuredEntries(loaded.snapshot).length
      };
    });
  }

  getSecret(name, { decidedBy = "system:access" } = {}) {
    return this.#withMutationLock(() => {
      const secretName = this.#assertAllowed(name, { action: "access", decidedBy });
      const { snapshot } = this.#loadFresh({ decidedBy });
      const record = snapshot.secrets[secretName];
      this.#audit({
        action: "access",
        name: secretName,
        decidedBy,
        found: Boolean(record)
      });
      return record?.value ?? null;
    });
  }

  setSecret(name, value, { decidedBy = "system:set" } = {}) {
    return this.#withMutationLock(() => {
      const secretName = this.#assertAllowed(name, { action: "set", decidedBy });
      const normalized = normalizeSecretValue(value);
      if (!normalized) {
        this.#audit({
          action: "set",
          name: secretName,
          decidedBy,
          accepted: false,
          reason: "blank-value"
        });
        throw new TypeError("Secret value must not be blank; use removeSecret to clear it");
      }

      const { snapshot } = this.#loadFresh({ decidedBy });
      const timestamp = this.#timestamp();
      snapshot.secrets[secretName] = {
        value: normalized,
        updatedAt: timestamp
      };
      snapshot.updatedAt = timestamp;
      this.#persistSnapshot(snapshot);
      this.#hydrateProcessEnv(snapshot);
      this.#writeEnvProjection(snapshot);
      this.#audit({
        action: "set",
        name: secretName,
        decidedBy,
        accepted: true
      });
      return maskedSecret(secretName, normalized);
    });
  }

  listSecrets({ decidedBy = "system:list" } = {}) {
    return this.#withMutationLock(() => {
      const { snapshot } = this.#loadFresh({ decidedBy });
      const listed = this.#configuredEntries(snapshot)
        .map(([name, record]) => maskedSecret(name, record.value))
        .sort((left, right) => left.name.localeCompare(right.name));
      this.#audit({
        action: "list",
        decidedBy,
        count: listed.length
      });
      return listed;
    });
  }

  listSecretNames({ decidedBy = "system:list" } = {}) {
    return this.listSecrets({ decidedBy }).map((entry) => entry.name);
  }

  listAllowedNames() {
    return [...this.allowlist].sort();
  }

  withExclusiveLock(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("SecretsStore exclusive operation must be a function");
    }
    if (operation.constructor?.name === "AsyncFunction") {
      throw new TypeError("SecretsStore exclusive operations must be synchronous");
    }
    return this.#withMutationLock(() => {
      const result = operation(this);
      if (result && typeof result.then === "function") {
        throw new TypeError("SecretsStore exclusive operations must be synchronous");
      }
      return result;
    });
  }

  removeSecret(name, { decidedBy = "system:remove" } = {}) {
    return this.#withMutationLock(() => {
      const secretName = this.#assertAllowed(name, { action: "remove", decidedBy });
      const { snapshot } = this.#loadFresh({ decidedBy });
      const removed = Boolean(snapshot.secrets[secretName]);
      if (removed) {
        delete snapshot.secrets[secretName];
        snapshot.updatedAt = this.#timestamp();
        this.#persistSnapshot(snapshot);
      }
      delete this.env[secretName];
      this.#hydrateProcessEnv(snapshot);
      this.#writeEnvProjection(snapshot);
      this.#audit({
        action: "remove",
        name: secretName,
        decidedBy,
        removed
      });
      return removed;
    });
  }

  exportEnv({ decidedBy = "system:export", names } = {}) {
    return this.#withMutationLock(() => {
      const selected = names === undefined
        ? this.listSecretNames({ decidedBy: `${safeActor(decidedBy)}:list` })
        : normalizeRequestedNames(names);
      const exported = {};
      for (const name of selected) {
        const value = this.getSecret(name, { decidedBy });
        if (value !== null) exported[name] = value;
      }
      return exported;
    });
  }

  #withMutationLock(operation) {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return operation();
      } finally {
        this.lockDepth -= 1;
      }
    }

    this.#secureStorage();
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
            fd = undefined;
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this.#breakStaleLock() && Date.now() >= deadline) {
          throw new Error("Secrets store is busy.");
        }
        if (!acquired) waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }

    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this.#releaseMutationLock(token);
    }
  }

  #breakStaleLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return false;
    }
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  #releaseMutationLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // A failed release leaves a bounded stale lock rather than deleting
      // another process's ownership record.
    }
  }

  #loadFresh({ decidedBy, migrationValues = {} }) {
    this.#secureStorage();
    this.#assertSafeFileOrAbsent(this.snapshotPath);
    if (!fs.existsSync(this.snapshotPath)) {
      const snapshot = this.#migrateLegacyEnv(migrationValues);
      this.#persistSnapshot(snapshot);
      this.#hydrateProcessEnv(snapshot);
      this.#writeEnvProjection(snapshot);
      this.#audit({
        action: "migrate",
        decidedBy,
        count: this.#configuredEntries(snapshot).length
      });
      return { snapshot, migrated: true };
    }

    let rawSnapshot;
    try {
      rawSnapshot = readJsonFile(this.snapshotPath);
    } catch {
      // JSON parser diagnostics can include a slice of malformed input.
      // Never let a corrupted secret value cross an HTTP/model boundary
      // through an exception message.
      throw new TypeError("Secrets snapshot could not be read safely");
    }
    const snapshot = normalizeSnapshot(
      rawSnapshot,
      this.#timestamp(),
      this.allowlist
    );
    this.#secureFile(this.snapshotPath);
    return { snapshot, migrated: false };
  }

  #migrateLegacyEnv(migrationValues = {}) {
    const timestamp = this.#timestamp();
    const parsed = parseEnvAssignments(readTextIfPresent(this.envPath));
    const secrets = Object.create(null);
    for (const name of this.allowlist) {
      const source = Object.hasOwn(parsed, name)
        ? parsed[name]
        : migrationValues?.[name];
      const value = normalizeSecretValue(source);
      if (!value) continue;
      secrets[name] = { value, updatedAt: timestamp };
    }
    return {
      version: SNAPSHOT_VERSION,
      updatedAt: timestamp,
      secrets
    };
  }

  #persistSnapshot(snapshot) {
    this.#assertSafeFileOrAbsent(this.snapshotPath);
    writeJsonAtomic(this.snapshotPath, snapshot, 0o600);
    this.#secureFile(this.snapshotPath);
  }

  #writeEnvProjection(snapshot) {
    ensureDir(this.dataDir);
    this.#assertSafeFileOrAbsent(this.envPath);
    const existing = readTextIfPresent(this.envPath);
    const preserved = preserveUnmanagedEnv(existing, this.allowlist);
    const managed = this.#configuredEntries(snapshot)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, record]) => `${name}=${record.value}`);
    const lines = [...preserved];
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(
      MANAGED_ENV_BEGIN,
      "# Allowlisted values are projected from secrets/secrets.json.",
      ...managed,
      MANAGED_ENV_END
    );
    writeTextAtomic(this.envPath, `${lines.join("\n")}\n`, 0o600);
    this.#secureFile(this.envPath);
  }

  #hydrateProcessEnv(snapshot) {
    const projected = parseEnvAssignments(readTextIfPresent(this.envPath));
    for (const name of this.allowlist) {
      if (!snapshot.secrets[name] && Object.hasOwn(projected, name)) delete this.env[name];
    }
    for (const [name, record] of this.#configuredEntries(snapshot)) {
      this.env[name] = record.value;
    }
  }

  #configuredEntries(snapshot) {
    return Object.entries(snapshot.secrets)
      .filter(([name, record]) => this.allowlist.has(name) && typeof record?.value === "string" && record.value);
  }

  #assertAllowed(name, { action, decidedBy }) {
    const normalized = String(name ?? "").trim();
    if (ENV_NAME_RE.test(normalized) && this.allowlist.has(normalized)) return normalized;
    this.#secureStorage();
    this.#audit({
      action,
      name: ENV_NAME_RE.test(normalized) ? normalized : "[invalid]",
      decidedBy,
      accepted: false,
      reason: "not-allowlisted"
    });
    throw new TypeError(`Unknown secret name: ${ENV_NAME_RE.test(normalized) ? normalized : "[invalid]"}`);
  }

  #audit({ action, decidedBy, ...details }) {
    this.#assertSafeFileOrAbsent(this.auditPath);
    appendJsonLine(this.auditPath, {
      timestamp: this.#timestamp(),
      action,
      decidedBy: safeActor(decidedBy),
      ...details
    }, 0o600);
    this.#secureFile(this.auditPath);
  }

  #secureStorage() {
    ensureDir(this.dir);
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Secrets storage path is not a safe directory.");
    }
    this.#secureDirectory(this.dir);
  }

  #secureDirectory(directory) {
    try {
      fs.chmodSync(directory, 0o700);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }

  #secureFile(file) {
    if (!fs.existsSync(file)) return;
    this.#assertSafeFileOrAbsent(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }

  #timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("SecretsStore now() must return a valid date");
    return date.toISOString();
  }

  #assertSafeFileOrAbsent(file) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Secrets storage contains an unsafe file path.");
    }
  }
}

export function createSecretsStore(options = {}) {
  return new SecretsStore(options);
}

function normalizeAllowlist(input) {
  if (
    !input
    || typeof input === "string"
    || typeof input[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("SecretsStore allowlist must be iterable");
  }
  const normalized = new Set();
  for (const name of input) {
    const value = String(name ?? "").trim();
    if (!ENV_NAME_RE.test(value)) {
      throw new TypeError(`Invalid allowlisted secret name: ${value || "[blank]"}`);
    }
    normalized.add(value);
  }
  return normalized;
}

function normalizeRequestedNames(names) {
  if (
    !names
    || typeof names === "string"
    || typeof names[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("Secret names must be an iterable of names");
  }
  return [...new Set([...names].map((name) => String(name ?? "").trim()))];
}

function normalizeSecretValue(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replaceAll("\0", "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function normalizeSnapshot(raw, fallbackTimestamp, allowlist) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Secrets snapshot must be an object");
  }
  if (!raw.secrets || typeof raw.secrets !== "object" || Array.isArray(raw.secrets)) {
    throw new TypeError("Secrets snapshot must contain a secrets object");
  }
  const secrets = Object.create(null);
  for (const [name, rawRecord] of Object.entries(raw.secrets)) {
    if (!ENV_NAME_RE.test(name)) throw new TypeError("Secrets snapshot contains an invalid name");
    if (!allowlist.has(name)) continue;
    const record = typeof rawRecord === "string" ? { value: rawRecord } : rawRecord;
    const value = normalizeSecretValue(record?.value);
    if (!value) continue;
    secrets[name] = {
      value,
      updatedAt: validTimestamp(record?.updatedAt, fallbackTimestamp)
    };
  }
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: validTimestamp(raw.updatedAt, fallbackTimestamp),
    secrets
  };
}

function validTimestamp(value, fallback) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function maskedSecret(name, value) {
  const last4 = value.length > 4 ? value.slice(-4) : null;
  return {
    name,
    last4,
    preview: last4 ? `****${last4}` : "****"
  };
}

function readTextIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseEnvAssignments(text) {
  const parsed = Object.create(null);
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (!ENV_NAME_RE.test(name)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

function preserveUnmanagedEnv(text, allowlist) {
  const preserved = [];
  let inManagedBlock = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (rawLine.trim() === MANAGED_ENV_BEGIN) {
      inManagedBlock = true;
      continue;
    }
    if (rawLine.trim() === MANAGED_ENV_END) {
      inManagedBlock = false;
      continue;
    }
    if (inManagedBlock) continue;
    const separator = rawLine.indexOf("=");
    const name = separator > 0 ? rawLine.slice(0, separator).trim() : "";
    if (allowlist.has(name)) continue;
    preserved.push(rawLine);
  }
  return preserved;
}

function safeActor(value) {
  const normalized = String(value ?? "").trim();
  return SAFE_ACTOR_RE.test(normalized) ? normalized : "unspecified";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitSynchronously(milliseconds) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, Math.max(1, milliseconds));
}

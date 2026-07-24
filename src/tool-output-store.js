import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import {
  appendJsonLine,
  ensureDir,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

const REF_PATTERN = /^out_[a-f0-9]{16}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const OWNER_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7E]{1,256}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENTRY_FIELDS = new Set([
  "chars",
  "createdAt",
  "ownerId",
  "ownerType",
  "projectId",
  "ref",
  "sha256"
]);
const EVENT_FIELDS = new Set(["entry", "op", "sequence", "version"]);
const SNAPSHOT_FIELDS = new Set(["entries", "sequence", "version"]);
const SIDECAR_FIELDS = new Set(["entry", "version"]);
const MAX_ENTRIES = 10_000;
const MAX_SEQUENCE = 1_000_000_000;
const MAX_CONTENT_CHARS = 32 * 1024 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 4 * 1024;
const MAX_SIDECAR_BYTES = 2 * 1024;
const MAX_LOCK_BYTES = 2 * 1024;
const MAX_DIRECTORY_ENTRIES = 20_000;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

// Oversized model-facing tool results live here so context truncation never
// destroys evidence. Each new content file is bound to immutable project
// ownership and a content digest in both the journal and a small sidecar.
export class ToolOutputStore {
  constructor({
    dir,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS
  } = {}) {
    this.dir = path.resolve(dir ?? path.join(resolveDataDir(), "tool-outputs"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.formatPath = path.join(this.dir, "format.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = positiveInteger(staleLockMs, DEFAULT_STALE_LOCK_MS);
    this.entries = new Map();
    this.blockedRefs = new Set();
    this.sequence = 0;
    this.journalHealthy = true;
    this.snapshotInvalid = false;
    this.lockDepth = 0;
    ensureDir(this.dir);
    this._withMutationLock(() => {
      this._restoreDurableState({ migrateLegacy: true, backfillSidecars: true });
    });
  }

  put(value, {
    projectId = "default",
    ownerType = null,
    ownerId = null
  } = {}) {
    const content = String(value ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    if (content.length > MAX_CONTENT_CHARS || bytes > MAX_CONTENT_BYTES) {
      throw new RangeError("Tool output exceeds its durable content bound.");
    }
    const normalizedProjectId = normalizeProjectId(projectId);
    const normalizedOwnerType = normalizeOptionalIdentifier(
      ownerType,
      OWNER_TYPE_PATTERN,
      "owner type"
    );
    const normalizedOwnerId = normalizeOptionalIdentifier(
      ownerId,
      PRINTABLE_ASCII_PATTERN,
      "owner id"
    );

    return this._withMutationLock(() => {
      this._restoreDurableState({ migrateLegacy: true, backfillSidecars: true });
      if (!this.journalHealthy) {
        throw persistenceError(
          "Tool-output journal is corrupt or exceeds its replay bound."
        );
      }
      if (this.entries.size >= MAX_ENTRIES) {
        throw new RangeError(`Tool-output entry limit reached (${MAX_ENTRIES}).`);
      }
      if (this.sequence >= MAX_SEQUENCE) {
        throw new RangeError("Tool-output sequence limit reached.");
      }

      const ref = this._uniqueRef();
      const entry = {
        ref,
        projectId: normalizedProjectId,
        ownerType: normalizedOwnerType,
        ownerId: normalizedOwnerId,
        chars: content.length,
        sha256: contentDigest(content),
        createdAt: nowIso()
      };
      const sequence = this.sequence + 1;
      const event = {
        version: 1,
        sequence,
        op: "put",
        entry
      };
      if (jsonByteLength(event) > MAX_EVENT_LINE_BYTES) {
        throw new RangeError("Tool-output journal event exceeds its persistence bound.");
      }

      const contentPath = this._contentPath(ref);
      const sidecarPath = this._sidecarPath(ref);
      let committed = false;
      try {
        this._writeFormatMarker();
        writeTextAtomic(contentPath, content);
        writeJsonAtomic(sidecarPath, { version: 1, entry });
        appendJsonLine(this.eventsPath, event);
        committed = true;
      } catch (error) {
        // appendJsonLine may throw after the bytes reached durable storage.
        // Reconcile under the same process-wide lock before removing files.
        this._restoreDurableState({ backfillSidecars: false });
        committed = entriesEqual(this.entries.get(ref), entry)
          && this.sequence >= sequence;
        if (!committed) {
          safeUnlink(sidecarPath);
          safeUnlink(contentPath);
          throw error;
        }
      }

      if (committed && this.sequence < sequence) {
        this.entries.set(ref, entry);
        this.sequence = sequence;
      }
      this._writeSnapshotBestEffort();
      return ref;
    });
  }

  read(ref, {
    offset = 0,
    maxChars = 12000,
    projectId = "default"
  } = {}) {
    const id = String(ref ?? "");
    if (!REF_PATTERN.test(id)) throw new Error("Invalid tool-output ref.");
    const requestedProjectId = normalizeProjectId(projectId);

    let entry = this.entries.get(id);
    if (!entry && this.journalHealthy) {
      // A second process may have committed the ref since this instance was
      // constructed. Reload only while holding the same lock used by writers.
      this._withMutationLock(() => {
        this._restoreDurableState({ backfillSidecars: true });
      });
      entry = this.entries.get(id);
    }
    if (!entry || this.blockedRefs.has(id)) {
      throw persistenceError("Tool-output ref is unavailable or unindexed.");
    }
    if (entry.projectId !== requestedProjectId) {
      const error = new Error("Tool-output ref is outside the current project.");
      error.code = "PROJECT_BOUNDARY_VIOLATION";
      throw error;
    }

    const sidecar = this._readSidecar(id);
    if (!sidecar || !entriesEqual(sidecar, entry)) {
      throw persistenceError("Tool-output ownership metadata is missing or corrupt.");
    }
    const text = readBoundedUtf8File(this._contentPath(id), MAX_CONTENT_BYTES);
    if (
      text.length !== entry.chars
      || text.length > MAX_CONTENT_CHARS
      || contentDigest(text) !== entry.sha256
    ) {
      throw persistenceError("Tool-output content failed its integrity check.");
    }
    const start = normalizeOffset(offset, text.length);
    const limit = normalizeReadLimit(maxChars);
    return {
      ref: id,
      offset: start,
      totalChars: text.length,
      content: text.slice(start, start + limit),
      hasMore: start + limit < text.length
    };
  }

  _restoreDurableState({
    migrateLegacy = false,
    backfillSidecars = false
  } = {}) {
    const metadataExisted = this._metadataExists();
    const snapshot = this._loadSnapshot();
    const replay = this._replayJournal(snapshot);
    this.entries = replay.entries;
    this.sequence = replay.sequence;
    this.journalHealthy = replay.healthy;
    this.blockedRefs = new Set();

    if (migrateLegacy && !metadataExisted) {
      this._migrateLegacyFiles();
    }
    if (backfillSidecars) {
      this._backfillAndValidateSidecars();
    } else {
      this._validateExistingSidecars();
    }
  }

  _loadSnapshot() {
    this.snapshotInvalid = false;
    let value;
    try {
      value = JSON.parse(readBoundedUtf8File(this.snapshotPath, MAX_SNAPSHOT_BYTES));
    } catch (error) {
      if (error?.code !== "ENOENT") this.snapshotInvalid = true;
      return null;
    }
    if (!isPlainRecord(value) || !onlyKeys(value, SNAPSHOT_FIELDS)) {
      this.snapshotInvalid = true;
      return null;
    }
    if (
      (value.version !== 1 && value.version !== 2)
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 0
      || value.sequence > MAX_SEQUENCE
      || !Array.isArray(value.entries)
      || value.entries.length > MAX_ENTRIES
    ) {
      this.snapshotInvalid = true;
      return null;
    }
    const entries = new Map();
    try {
      for (const raw of value.entries) {
        const entry = normalizeStoredEntry(raw);
        if (entries.has(entry.ref)) {
          this.snapshotInvalid = true;
          return null;
        }
        entries.set(entry.ref, entry);
      }
    } catch {
      this.snapshotInvalid = true;
      return null;
    }
    if (value.sequence !== entries.size) {
      this.snapshotInvalid = true;
      return null;
    }
    return { entries, sequence: value.sequence };
  }

  _replayJournal(snapshot) {
    let text;
    try {
      text = readBoundedUtf8File(this.eventsPath, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return snapshot
          ? { ...snapshot, healthy: snapshot.sequence === 0 }
          : {
              entries: new Map(),
              sequence: 0,
              healthy: !this.snapshotInvalid
            };
      }
      return {
        ...(snapshot ?? { entries: new Map(), sequence: 0 }),
        healthy: false
      };
    }
    if (!text.trim()) {
      return snapshot
        ? { ...snapshot, healthy: snapshot.sequence === 0 }
        : {
            entries: new Map(),
            sequence: 0,
            healthy: !this.snapshotInvalid
          };
    }

    const entries = new Map();
    let sequence = 0;
    let healthy = true;
    for (const rawLine of text.split(/\r?\n/u)) {
      if (!rawLine) continue;
      if (Buffer.byteLength(rawLine, "utf8") > MAX_EVENT_LINE_BYTES) {
        healthy = false;
        break;
      }
      let event;
      try {
        event = JSON.parse(rawLine);
      } catch {
        healthy = false;
        break;
      }
      const normalized = normalizeEvent(event);
      if (
        !normalized
        || normalized.sequence !== sequence + 1
        || entries.has(normalized.entry.ref)
        || entries.size >= MAX_ENTRIES
      ) {
        // Stop at gaps, duplicate sequences, duplicate refs, and malformed
        // records. Never accept apparently valid records after corruption.
        healthy = false;
        break;
      }
      entries.set(normalized.entry.ref, normalized.entry);
      sequence = normalized.sequence;
    }

    if (sequence === 0 && !healthy && snapshot) {
      return { ...snapshot, healthy: false };
    }
    return { entries, sequence, healthy };
  }

  _migrateLegacyFiles() {
    const names = boundedDirectoryNames(this.dir);
    if (!names) {
      this.journalHealthy = false;
      return;
    }
    const legacyNames = names.filter((name) => /^out_[a-f0-9]{16}\.txt$/.test(name));
    if (legacyNames.length > MAX_ENTRIES) {
      this.journalHealthy = false;
      return;
    }
    if (legacyNames.length > 0) this._writeFormatMarker();
    let changed = false;
    for (const name of legacyNames) {
      const ref = name.slice(0, -4);
      if (this.entries.has(ref)) continue;
      let text;
      let stat;
      try {
        text = readBoundedUtf8File(this._contentPath(ref), MAX_CONTENT_BYTES);
        stat = fs.statSync(this._contentPath(ref));
      } catch {
        this.blockedRefs.add(ref);
        continue;
      }
      if (text.length > MAX_CONTENT_CHARS) {
        this.blockedRefs.add(ref);
        continue;
      }
      const entry = {
        ref,
        projectId: "default",
        ownerType: null,
        ownerId: null,
        chars: text.length,
        sha256: contentDigest(text),
        createdAt: new Date(stat.mtimeMs).toISOString()
      };
      const sequence = this.sequence + 1;
      writeJsonAtomic(this._sidecarPath(ref), { version: 1, entry });
      appendJsonLine(this.eventsPath, {
        version: 1,
        sequence,
        op: "put",
        entry
      });
      this.entries.set(ref, entry);
      this.sequence = sequence;
      changed = true;
    }
    if (changed) {
      writeJsonAtomic(this.snapshotPath, this._snapshotValue());
    }
  }

  _backfillAndValidateSidecars() {
    let changed = false;
    for (const [ref, original] of [...this.entries]) {
      let entry = original;
      if (!entry.sha256) {
        try {
          const text = readBoundedUtf8File(this._contentPath(ref), MAX_CONTENT_BYTES);
          if (text.length !== entry.chars || text.length > MAX_CONTENT_CHARS) {
            throw persistenceError("Tool-output content length is corrupt.");
          }
          entry = { ...entry, sha256: contentDigest(text) };
          this.entries.set(ref, entry);
          changed = true;
        } catch {
          this.entries.delete(ref);
          this.blockedRefs.add(ref);
          continue;
        }
      }
      const existing = this._readSidecar(ref, { tolerateMissing: true });
      if (existing) {
        if (!entriesEqual(existing, entry)) {
          this.entries.delete(ref);
          this.blockedRefs.add(ref);
        }
        continue;
      }
      try {
        writeJsonAtomic(this._sidecarPath(ref), { version: 1, entry });
        changed = true;
      } catch {
        this.entries.delete(ref);
        this.blockedRefs.add(ref);
      }
    }
    if (this.entries.size > 0) this._writeFormatMarker();
    if (changed) this._writeSnapshotBestEffort();
  }

  _validateExistingSidecars() {
    for (const [ref, entry] of [...this.entries]) {
      const existing = this._readSidecar(ref, { tolerateMissing: true });
      if (existing && !entriesEqual(existing, entry)) {
        this.entries.delete(ref);
        this.blockedRefs.add(ref);
      }
    }
  }

  _readSidecar(ref, { tolerateMissing = false } = {}) {
    try {
      const value = JSON.parse(
        readBoundedUtf8File(this._sidecarPath(ref), MAX_SIDECAR_BYTES)
      );
      if (
        !isPlainRecord(value)
        || !onlyKeys(value, SIDECAR_FIELDS)
        || value.version !== 1
      ) {
        return null;
      }
      const entry = normalizeStoredEntry(value.entry);
      return entry.sha256 ? entry : null;
    } catch (error) {
      if (tolerateMissing && error?.code === "ENOENT") return null;
      return null;
    }
  }

  _writeSnapshotBestEffort() {
    const value = this._snapshotValue();
    if (jsonByteLength(value) > MAX_SNAPSHOT_BYTES) {
      console.warn("[tool-outputs] snapshot exceeds its persistence bound.");
      return;
    }
    try {
      writeJsonAtomic(this.snapshotPath, value);
    } catch (error) {
      // The append-only event and ownership sidecar remain authoritative.
      console.warn(`[tool-outputs] snapshot refresh failed: ${error?.message ?? error}`);
    }
  }

  _snapshotValue() {
    return {
      version: 2,
      sequence: this.sequence,
      entries: [...this.entries.values()]
    };
  }

  _writeFormatMarker() {
    writeJsonAtomic(this.formatPath, {
      version: 2,
      ownership: "sidecar-sha256"
    });
  }

  _metadataExists() {
    return pathExists(this.eventsPath)
      || pathExists(this.snapshotPath)
      || pathExists(this.formatPath)
      || this._hasOwnershipSidecar();
  }

  _hasOwnershipSidecar() {
    let directory;
    try {
      directory = fs.opendirSync(this.dir);
      let count = 0;
      for (;;) {
        const item = directory.readSync();
        if (!item) return false;
        count += 1;
        if (count > MAX_DIRECTORY_ENTRIES) return true;
        if (item.isFile() && /^out_[a-f0-9]{16}\.meta\.json$/.test(item.name)) {
          return true;
        }
      }
    } catch {
      return false;
    } finally {
      try { directory?.closeSync(); } catch { /* best effort */ }
    }
  }

  _uniqueRef() {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const ref = createId("out");
      if (
        !this.entries.has(ref)
        && !pathExists(this._contentPath(ref))
        && !pathExists(this._sidecarPath(ref))
      ) {
        return ref;
      }
    }
    throw new Error("Unable to allocate a unique tool-output ref.");
  }

  _contentPath(ref) {
    return path.join(this.dir, `${ref}.txt`);
  }

  _sidecarPath(ref) {
    return path.join(this.dir, `${ref}.meta.json`);
  }

  _withMutationLock(operation) {
    if (this.lockDepth > 0) return operation();
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex")
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      let descriptor;
      try {
        descriptor = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, token, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        break;
      } catch (error) {
        try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { /* best effort */ }
        if (error?.code !== "EEXIST") {
          try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new Error("Tool-output store is busy.");
        }
        waitSynchronously(LOCK_RETRY_MS);
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      try {
        if (readBoundedUtf8File(this.lockPath, MAX_LOCK_BYTES) === token) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {
        // Never remove a lock whose ownership token cannot be verified.
      }
    }
  }

  _breakStaleLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = readBoundedUtf8File(this.lockPath, MAX_LOCK_BYTES);
    } catch {
      return false;
    }
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (readBoundedUtf8File(this.lockPath, MAX_LOCK_BYTES) !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeEvent(value) {
  if (
    !isPlainRecord(value)
    || !onlyKeys(value, EVENT_FIELDS)
    || value.version !== 1
    || value.op !== "put"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || value.sequence > MAX_SEQUENCE
  ) {
    return null;
  }
  try {
    return {
      sequence: value.sequence,
      entry: normalizeStoredEntry(value.entry)
    };
  } catch {
    return null;
  }
}

function normalizeStoredEntry(value) {
  if (!isPlainRecord(value) || !onlyKeys(value, ENTRY_FIELDS)) {
    throw new TypeError("Invalid tool-output entry.");
  }
  const ref = String(value.ref ?? "");
  if (!REF_PATTERN.test(ref)) throw new TypeError("Invalid tool-output ref.");
  const projectId = normalizeProjectId(value.projectId ?? "default");
  const ownerType = normalizeOptionalIdentifier(
    value.ownerType,
    OWNER_TYPE_PATTERN,
    "owner type"
  );
  const ownerId = normalizeOptionalIdentifier(
    value.ownerId,
    PRINTABLE_ASCII_PATTERN,
    "owner id"
  );
  if (
    !Number.isSafeInteger(value.chars)
    || value.chars < 0
    || value.chars > MAX_CONTENT_CHARS
  ) {
    throw new TypeError("Invalid tool-output character count.");
  }
  const sha256 = value.sha256 == null ? null : String(value.sha256);
  if (sha256 !== null && !SHA256_PATTERN.test(sha256)) {
    throw new TypeError("Invalid tool-output digest.");
  }
  const createdAt = String(value.createdAt ?? "");
  if (!isIsoDate(createdAt)) throw new TypeError("Invalid tool-output creation time.");
  return {
    ref,
    projectId,
    ownerType,
    ownerId,
    chars: value.chars,
    sha256,
    createdAt
  };
}

function normalizeProjectId(value) {
  const text = String(value ?? "default").trim().toLowerCase() || "default";
  if (!PROJECT_ID_PATTERN.test(text)) throw new TypeError("Invalid project id.");
  return text;
}

function normalizeOptionalIdentifier(value, pattern, label) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!pattern.test(text)) throw new TypeError(`Invalid tool-output ${label}.`);
  return text;
}

function normalizeOffset(value, totalChars) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(totalChars, Math.trunc(numeric));
}

function normalizeReadLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 12000;
  return Math.max(1, Math.min(50000, Math.trunc(numeric) || 12000));
}

function entriesEqual(left, right) {
  return Boolean(
    left
    && right
    && left.ref === right.ref
    && left.projectId === right.projectId
    && left.ownerType === right.ownerType
    && left.ownerId === right.ownerId
    && left.chars === right.chars
    && left.sha256 === right.sha256
    && left.createdAt === right.createdAt
  );
}

function contentDigest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function readBoundedUtf8File(filePath, maxBytes) {
  const pathStat = fs.lstatSync(filePath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw persistenceError("Persistence path is not a regular file.");
  }
  const descriptor = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw persistenceError("Persistence file exceeds its read bound.");
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (count === 0) break;
      offset += count;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function boundedDirectoryNames(dir) {
  let directory;
  const names = [];
  try {
    directory = fs.opendirSync(dir);
    for (;;) {
      const item = directory.readSync();
      if (!item) return names;
      if (names.length >= MAX_DIRECTORY_ENTRIES) return null;
      names.push(item.name);
    }
  } finally {
    try { directory?.closeSync(); } catch { /* best effort */ }
  }
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoDate(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function jsonByteLength(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("Value is not JSON serializable.");
  return Buffer.byteLength(text, "utf8");
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

function persistenceError(message) {
  const error = new Error(message);
  error.code = "TOOL_OUTPUT_PERSISTENCE_ERROR";
  return error;
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

let defaultStore;

export function defaultToolOutputStore() {
  defaultStore ??= new ToolOutputStore();
  return defaultStore;
}

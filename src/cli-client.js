import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { writeJsonAtomic } from "./file-utils.js";
import { SecretsStore } from "./secrets-store.js";
import { SETUP_FIELDS } from "./setup-wizard.js";
import { redactKnownValues } from "./redact.js";
import { secretRedactionSpellings } from "./credential-redaction.js";

// Client used by the `openagi` CLI to talk to a daemon — either the LOCAL one
// (default) or a REMOTE "main" hub (e.g. OpenAGI running on a Distiller / Pi
// that holds all the integrations). A device running only the CLI in remote
// mode is a "node": it sends messages/observations to the main and renders
// replies, without configuring any integrations of its own.
//
// Target resolution precedence (first wins):
//   1. explicit { remote, token } (CLI --remote / --token flags)
//   2. env OPENAGI_REMOTE / OPENAGI_REMOTE_TOKEN
//   3. <dataDir>/node.json remote metadata + SecretsStore OPENAGI_REMOTE_TOKEN
//   4. local default: http://127.0.0.1:<PORT|43210> with OPENAGI_AUTH_TOKEN

const DEFAULT_LOCAL_PORT = () => Number.parseInt(process.env.PORT ?? "43210", 10);
const REMOTE_TOKEN_KEY = "OPENAGI_REMOTE_TOKEN";

export function nodeConfigPath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "node.json");
}

export function readNodeConfig(dataDir = resolveDataDir()) {
  return readPairedTargetState(dataDir, {
    decidedBy: "cli:node-config-read"
  });
}

export function writeNodeConfig({ remote, token }, dataDir = resolveDataDir()) {
  const normalizedRemote = normalizePairingRemote(remote);
  const normalizedToken = nonBlankToken(token);
  const secrets = createPairingStore(dataDir);
  return withStoreExclusiveLock(secrets, () => {
    const previousConfig = readRawNodeConfig(dataDir);
    const legacyToken = previousConfig?.remote
      ? nonBlankToken(previousConfig.token)
      : null;
    secrets.initialize({
      decidedBy: "cli:pair:init",
      migrationValues: legacyToken
        ? { [REMOTE_TOKEN_KEY]: legacyToken }
        : {}
    });
    const previousToken = secrets.getSecret(REMOTE_TOKEN_KEY, {
      decidedBy: "cli:pair:previous"
    });
    try {
      // Cross-file crash consistency: remove the usable credential first,
      // publish the new remote metadata second, and publish the replacement
      // credential last. A process death at any boundary therefore leaves
      // either a complete pair or metadata with no credential.
      setPairingToken(secrets, null, {
        decidedBy: "cli:pair:stage"
      });
      const file = writeNodeMetadata(normalizedRemote, dataDir);
      if (normalizedToken) {
        setPairingToken(secrets, normalizedToken, {
          decidedBy: "cli:pair"
        });
      }
      return file;
    } catch {
      restorePairingState(secrets, {
        dataDir,
        previousConfig,
        previousToken,
        decidedBy: "cli:pair:rollback"
      });
      throw new Error("Node pairing metadata could not be persisted safely.");
    }
  });
}

export function clearNodeConfig(dataDir = resolveDataDir()) {
  const secrets = createPairingStore(dataDir);
  return withStoreExclusiveLock(secrets, () => {
    const config = readRawNodeConfig(dataDir);
    if (!config) return false;
    const legacyToken = config.remote ? nonBlankToken(config.token) : null;
    secrets.initialize({
      decidedBy: "cli:unpair:init",
      migrationValues: legacyToken
        ? { [REMOTE_TOKEN_KEY]: legacyToken }
        : {}
    });
    const previousToken = secrets.getSecret(REMOTE_TOKEN_KEY, {
      decidedBy: "cli:unpair:previous"
    });
    try {
      // Token-first removal makes an abrupt exit before metadata deletion
      // unusable rather than binding a credential to stale metadata.
      setPairingToken(secrets, null, { decidedBy: "cli:unpair" });
      fs.rmSync(nodeConfigPath(dataDir));
      return true;
    } catch {
      restorePairingState(secrets, {
        dataDir,
        previousConfig: config,
        previousToken,
        decidedBy: "cli:unpair:rollback"
      });
      throw new Error("Node pairing metadata could not be removed safely.");
    }
  });
}

// Normalize a host/url into a base URL. Accepts "distiller.local",
// "distiller.local:43210", "http://x", "https://x" — defaults to http and the
// daemon port when missing.
export function normalizeBase(target) {
  let t = String(target).trim();
  if (!/^https?:\/\//.test(t)) t = `http://${t}`;
  const u = new URL(t);
  if (!u.port && u.protocol === "http:") u.port = String(DEFAULT_LOCAL_PORT());
  return u.origin;
}

export function resolveTarget({ remote, token, dataDir = resolveDataDir() } = {}) {
  // 1. explicit flag
  if (remote) {
    return {
      url: normalizeBase(remote),
      token: resolveExplicitRemoteToken(token),
      source: "flag",
      remote: true
    };
  }
  // 2. env
  if (process.env.OPENAGI_REMOTE) {
    return {
      url: normalizeBase(process.env.OPENAGI_REMOTE),
      token: resolveExplicitRemoteToken(token),
      source: "env",
      remote: true
    };
  }
  // 3. saved node pairing
  const paired = readPairedTargetState(dataDir, {
    decidedBy: "cli:resolve-node"
  });
  if (paired?.remote) {
    return {
      url: normalizeBase(paired.remote),
      token: token ?? paired.token,
      source: "node.json",
      remote: true
    };
  }
  // 4. local default. The token is usually only in <dataDir>/.env (the wizard
  // wrote it there, not into the CLI's environment) — peek it so `openagi
  // status/chat/doctor` work locally right after setup without exporting it.
  return {
    url: normalizeBase(`127.0.0.1:${DEFAULT_LOCAL_PORT()}`),
    token: token ?? process.env.OPENAGI_AUTH_TOKEN ?? peekEnvToken(dataDir),
    source: "local",
    remote: false
  };
}

function readRawNodeConfig(dataDir) {
  try {
    const file = nodeConfigPath(dataDir);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeNodeMetadata(remote, dataDir) {
  const file = nodeConfigPath(dataDir);
  assertSafeNodeConfigPath(file);
  writeJsonAtomic(file, { remote: normalizePairingRemote(remote) }, 0o600);
  return file;
}

export function reconcileLegacyNodePairing({
  dataDir = resolveDataDir(),
  store,
  decidedBy = "cli:legacy-node-migration"
} = {}) {
  const secrets = store ?? createPairingStore(dataDir);
  return withStoreExclusiveLock(secrets, () => {
    const config = readRawNodeConfig(dataDir);
    return reconcileLegacyNodePairingLocked(config, secrets, {
      dataDir,
      decidedBy
    });
  });
}

function reconcileLegacyNodePairingLocked(config, secrets, {
  dataDir,
  decidedBy
}) {
  const legacyToken = config?.remote ? nonBlankToken(config.token) : null;
  const initialized = secrets.initialize({
    decidedBy,
    migrationValues: legacyToken
      ? { [REMOTE_TOKEN_KEY]: legacyToken }
      : {}
  });
  let token = null;
  if (typeof secrets.getSecret === "function") {
    token = secrets.getSecret(REMOTE_TOKEN_KEY, {
      decidedBy: `${decidedBy}:access`
    });
  }
  if (legacyToken) {
    try {
      writeNodeMetadata(config.remote, dataDir);
    } catch {
      throw new Error("Legacy node pairing token could not be migrated safely.");
    }
  }
  return {
    initialized,
    token,
    legacyTokenRemoved: Boolean(legacyToken)
  };
}

function resolveExplicitRemoteToken(explicitToken) {
  if (explicitToken !== undefined && explicitToken !== null) {
    return nonBlankToken(explicitToken);
  }
  // A persisted pairing credential is scoped to the saved node.json target.
  // A one-off --remote or OPENAGI_REMOTE selection must supply its own token
  // explicitly (or through the caller's environment), otherwise an attacker-
  // controlled host could receive the token for a different paired main.
  return nonBlankToken(process.env[REMOTE_TOKEN_KEY]);
}

function readPairedTargetState(dataDir, { decidedBy }) {
  const secrets = createPairingStore(dataDir);
  try {
    return withStoreExclusiveLock(secrets, () => {
      const config = readRawNodeConfig(dataDir);
      if (!config?.remote) return null;
      const remote = normalizePairingRemote(config.remote);
      const legacyToken = nonBlankToken(config.token);
      const token = legacyToken
        ? reconcileLegacyNodePairingLocked(config, secrets, {
            dataDir,
            decidedBy
          }).token
        : secrets.getSecret(REMOTE_TOKEN_KEY, { decidedBy });
      return {
        ...config,
        remote,
        token
      };
    });
  } catch {
    // Preserve usable remote metadata, but fail closed on credentials when
    // either half of the pair cannot be read under the shared lock.
    const config = readRawNodeConfig(dataDir);
    try {
      return config?.remote
        ? { remote: normalizePairingRemote(config.remote), token: null }
        : null;
    } catch {
      return null;
    }
  }
}

function createPairingStore(dataDir) {
  return new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    // Pairing credentials are scoped to node.json's saved remote. Keeping
    // store hydration out of the ambient process environment prevents a
    // later one-off --remote target from inheriting the saved credential.
    env: Object.create(null)
  });
}

function withStoreExclusiveLock(store, operation) {
  if (typeof store.withExclusiveLock === "function") {
    return store.withExclusiveLock(operation);
  }
  return operation(store);
}

function setPairingToken(store, value, { decidedBy }) {
  const normalized = nonBlankToken(value);
  if (normalized) {
    return store.setSecret(REMOTE_TOKEN_KEY, normalized, { decidedBy });
  }
  return store.removeSecret(REMOTE_TOKEN_KEY, { decidedBy });
}

function restorePairingState(store, {
  dataDir,
  previousConfig,
  previousToken,
  decidedBy
}) {
  let tokenNeutralized = false;
  let metadataNeutralized = false;
  try {
    setPairingToken(store, null, {
      decidedBy: `${decidedBy}:neutralize-token`
    });
    tokenNeutralized = true;
  } catch { /* a later metadata removal still fails closed */ }
  try {
    fs.rmSync(nodeConfigPath(dataDir), { force: true });
    metadataNeutralized = true;
  } catch { /* a removed token still fails closed */ }
  if (!tokenNeutralized || !metadataNeutralized) return false;

  if (previousConfig?.remote) {
    try {
      writeNodeMetadata(previousConfig.remote, dataDir);
    } catch {
      // After successful neutralization, an atomic restore can only leave the
      // previous metadata or no metadata. Restoring its matching token last
      // remains safe in either case.
    }
  }
  try {
    setPairingToken(store, previousToken, {
      decidedBy: `${decidedBy}:restore-token`
    });
  } catch {
    // A thrown store mutation may have committed or may have done nothing.
    // The only published metadata is the previous remote, so both outcomes
    // are credential-safe.
  }
  return true;
}

function assertSafeNodeConfigPath(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Node pairing metadata path is unsafe.");
  }
}

function nonBlankToken(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function normalizePairingRemote(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TypeError("Node pairing requires a non-blank remote");
  }
  return normalizeBase(normalized);
}

function peekEnvToken(dataDir, key = "OPENAGI_AUTH_TOKEN") {
  try {
    for (const raw of fs.readFileSync(path.join(dataDir, ".env"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const prefix = `${key}=`;
      if (line.startsWith(prefix)) {
        const v = line.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "");
        return v || null;
      }
    }
  } catch { /* no env file */ }
  return null;
}

export class CliClient {
  constructor(target, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
    this.target = target;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.target.token) h.authorization = `Bearer ${this.target.token}`;
    return h;
  }

  async request(method, route, body) {
    const url = this.target.url + route;
    const redactValues = secretRedactionSpellings(this.target.token);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return {
        ok: res.ok,
        status: res.status,
        json: redactKnownValues(json, redactValues),
        text: redactKnownValues(text, redactValues)
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        json: null,
        text: "",
        error: error.name === "AbortError"
          ? "timeout"
          : redactKnownValues(error?.message ?? String(error), redactValues)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  health() { return this.request("GET", "/health"); }
  status() { return this.request("GET", "/health"); }
  chat(text, { from = "cli", sessionId } = {}) {
    return this.request("POST", "/message", { text, from, sessionId });
  }
  tick() { return this.request("POST", "/tick", {}); }
  tasks() { return this.request("GET", "/tasks"); }
  integrations() { return this.request("GET", "/integrations/status"); }
}

// Run the diagnostic ladder (Hermes-style `doctor`). Returns an array of
// { name, ok, detail, fix? } checks plus an overall ok. Pure aside from the
// client calls, so it's unit-testable with a stubbed client.
export async function runDoctor(client) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

  const target = client.target;
  add("target", true, `${target.remote ? "remote main" : "local daemon"} → ${target.url} (via ${target.source})`);

  const health = await client.health();
  if (!health.ok) {
    if (health.status === 401) {
      add("daemon", false, "reachable but rejected the token (401)", target.remote
        ? "Pass the main's OPENAGI_AUTH_TOKEN via --token, OPENAGI_REMOTE_TOKEN, or `openagi pair`."
        : "Set OPENAGI_AUTH_TOKEN to the value in <dataDir>/.env, or run `openagi setup`.");
    } else if (health.status === 0) {
      add("daemon", false, `unreachable (${health.error ?? "no response"})`, target.remote
        ? `Is the main up and bound to your LAN? On the main: HOST=0.0.0.0 openagi serve. Check ${target.url}/health.`
        : "Start it with `openagi serve` (or check it's running under systemd/launchd).");
    } else {
      add("daemon", false, `HTTP ${health.status}`, "Check the daemon logs.");
    }
    return { ok: false, checks }; // nothing else is meaningful if the daemon is down
  }
  add("daemon", true, "reachable + authorized");

  const h = health.json ?? {};
  if (h.firstRun) {
    add("setup", false, "first-run — setup has never completed", "Open the dashboard and finish the wizard: `openagi setup`.");
  } else {
    add("setup", true, "setup completed");
  }

  const provider = h.status?.agentHost;
  const deterministic = /deterministic/i.test(provider?.provider ?? "");
  if (provider?.providerConfigured && !deterministic) {
    add("model", true, `provider: ${provider.provider}`);
  } else {
    add("model", false,
      deterministic ? "running the deterministic fallback — no real LLM, replies are canned" : "no LLM provider configured — the agent can't reason",
      "Add a model API key via `openagi setup`.");
  }

  // Task sources (best-effort — needs auth; skip quietly if it 401s).
  const integ = await client.integrations();
  if (integ.ok && Array.isArray(integ.json?.integrations)) {
    const sources = integ.json.integrations.filter((s) => ["linear", "buildbetter"].includes(s.id));
    const connected = sources.filter((s) => (s.paths ?? []).some((p) => p.kind === "api" && p.configured));
    add("task-sources", connected.length > 0,
      connected.length > 0 ? `connected: ${connected.map((s) => s.name).join(", ")}` : "no task sources connected",
      connected.length > 0 ? undefined : "Connect Linear/BuildBetter in the dashboard Integrations tab, or drop files in <dataDir>/inbox.");
  }

  return { ok: checks.every((c) => c.ok), checks };
}

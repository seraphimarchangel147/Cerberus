import path from "node:path";
import util from "node:util";
import {
  appendJsonLine,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const CREDENTIAL_POOL_CONFIG_VERSION = 1;
export const CREDENTIAL_POOL_STRATEGIES = Object.freeze([
  "round_robin",
  "least_used",
  "fill_first",
  "random"
]);
export const CREDENTIAL_BILLING_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const LITERAL_SECRET_FIELDS = new Set([
  "apiKey",
  "accessToken",
  "credential",
  "key",
  "refreshToken",
  "secret",
  "token",
  "value"
]);
const DEFAULT_PROVIDER_ENV_KEYS = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY"
});
const LEASE_VALUES = new WeakMap();
const LEASE_REFRESH_VALUES = new WeakMap();

export class CredentialPoolExhaustedError extends Error {
  constructor(provider, { failures = [] } = {}) {
    super(`Credential pool exhausted for provider ${safeProviderName(provider)}.`);
    this.name = "CredentialPoolExhaustedError";
    this.code = "CREDENTIAL_POOL_EXHAUSTED";
    this.provider = safeProviderName(provider);
    this.failures = failures.map(safeFailure);
  }
}

export class CredentialLease {
  constructor({ provider, id, type, secretName = null, value, refreshToken = null }) {
    this.provider = safeProviderName(provider);
    this.id = safeCredentialId(id);
    this.type = type === "oauth" ? "oauth" : "api_key";
    this.secretName = SECRET_NAME_RE.test(String(secretName ?? "")) ? String(secretName) : null;
    LEASE_VALUES.set(this, value);
    LEASE_REFRESH_VALUES.set(this, refreshToken);
    Object.freeze(this);
  }

  get value() {
    return LEASE_VALUES.get(this);
  }

  get credential() {
    return LEASE_VALUES.get(this);
  }

  get refreshToken() {
    return LEASE_REFRESH_VALUES.get(this);
  }

  toJSON() {
    return {
      provider: this.provider,
      id: this.id,
      type: this.type,
      secretName: this.secretName,
      credential: "[REDACTED]"
    };
  }

  [util.inspect.custom]() {
    return `CredentialLease <${this.provider}/${this.id} [REDACTED]>`;
  }
}

export function classifyCredentialFailure(error) {
  const status = errorStatus(error);
  const text = errorText(error);
  if (status === 402) return { kind: "billing", status, retrySame: false };
  if (status === 401) return { kind: "auth", status, retrySame: false };
  if (status === 429 && isPlanOrUsageLimit(text)) {
    return { kind: "usage_limit", status, retrySame: false };
  }
  if (status === 429) return { kind: "transient_rate_limit", status, retrySame: true };
  return { kind: "other", status, retrySame: false };
}

export class CredentialPool {
  constructor({
    provider,
    credentials = [],
    strategy = "round_robin",
    env = process.env,
    secretsStore = null,
    now = Date.now,
    random = Math.random,
    refreshOAuth = null,
    onEvent = null,
    dataDir = null
  } = {}) {
    this.provider = safeProviderName(provider);
    this.strategy = normalizeStrategy(strategy);
    this.env = env ?? {};
    this.secretsStore = secretsStore;
    this.now = typeof now === "function" ? now : Date.now;
    this.random = typeof random === "function" ? random : Math.random;
    this.refreshOAuth = typeof refreshOAuth === "function" ? refreshOAuth : null;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    const stateDir = dataDir
      ? path.join(path.resolve(dataDir), "credential-pools", this.provider)
      : null;
    this.statePath = stateDir ? path.join(stateDir, "state.json") : null;
    this.eventsPath = stateDir ? path.join(stateDir, "events.jsonl") : null;
    this.entries = normalizeCredentials(credentials);
    this.states = new Map(this.entries.map((entry) => [entry.id, {
      uses: 0,
      successes: 0,
      failures: 0,
      cooldownUntil: 0,
      blockedReason: null,
      refreshedValue: null,
      liveValue: null
    }]));
    this.roundRobinCursor = 0;
    this.rotationCount = 0;
    this.#restoreState();
  }

  get size() {
    return this.entries.length;
  }

  isConfigured() {
    return this.entries.some((entry) => {
      const state = this.states.get(entry.id);
      return nonBlankSecret(this.#resolveValue(entry, state));
    });
  }

  syncCredential(id, value) {
    const state = this.states.get(String(id));
    if (!state) return false;
    state.liveValue = nonBlankSecret(value) ? String(value) : null;
    if (["missing", "auth"].includes(state.blockedReason) && state.liveValue) {
      state.blockedReason = null;
    }
    return true;
  }

  beginRequest(options = {}) {
    return new CredentialPoolRequest(this, options);
  }

  acquire({ excludeIds = [] } = {}) {
    const excluded = new Set(Array.from(excludeIds, String));
    const available = this.#availableEntries().filter((entry) => !excluded.has(entry.id));
    if (available.length === 0) throw this.exhausted();
    const entry = this.#selectEntry(available);
    const state = this.states.get(entry.id);
    const value = this.#resolveValue(entry, state);
    if (!nonBlankSecret(value)) {
      state.blockedReason = "missing";
      return this.acquire({ excludeIds: [...excluded, entry.id] });
    }
    const refreshToken = this.#resolveRefreshToken(entry);
    state.uses += 1;
    const lease = new CredentialLease({
      provider: this.provider,
      id: entry.id,
      type: entry.type,
      secretName: entry.secretName,
      value,
      refreshToken
    });
    this.#persistState("selected", lease);
    return lease;
  }

  async execute(operation, options = {}) {
    return this.beginRequest(options).execute(operation, options);
  }

  recordSuccess(lease) {
    const state = this.#stateForLease(lease);
    state.successes += 1;
    this.#persistState("success", lease);
  }

  exhausted(failures = []) {
    return new CredentialPoolExhaustedError(this.provider, { failures });
  }

  resetCredential(id) {
    const state = this.states.get(String(id));
    if (!state) return false;
    state.cooldownUntil = 0;
    state.blockedReason = null;
    state.refreshedValue = null;
    state.liveValue = null;
    this.#persistState("reset", { id: String(id) });
    return true;
  }

  reset() {
    for (const entry of this.entries) this.resetCredential(entry.id);
  }

  snapshot() {
    const now = Number(this.now());
    return {
      provider: this.provider,
      strategy: this.strategy,
      size: this.entries.length,
      rotationCount: this.rotationCount,
      credentials: this.entries.map((entry) => {
        const state = this.states.get(entry.id);
        return {
          id: entry.id,
          type: entry.type,
          secretName: entry.secretName,
          uses: state.uses,
          successes: state.successes,
          failures: state.failures,
          available: !state.blockedReason && state.cooldownUntil <= now,
          cooldownUntil: state.cooldownUntil > now
            ? new Date(state.cooldownUntil).toISOString()
            : null,
          blockedReason: state.blockedReason
        };
      })
    };
  }

  toJSON() {
    return this.snapshot();
  }

  _recordFailure(lease, classification) {
    const state = this.#stateForLease(lease);
    state.failures += 1;
    if (classification.kind === "billing") {
      state.cooldownUntil = Number(this.now()) + CREDENTIAL_BILLING_COOLDOWN_MS;
    } else if (classification.kind === "usage_limit") {
      state.blockedReason = "usage_limit";
    }
    this.#persistState("failure", lease, {
      kind: classification.kind,
      status: classification.status
    });
  }

  async _refresh(lease, error, override) {
    const refresh = typeof override === "function" ? override : this.refreshOAuth;
    if (lease.type !== "oauth" || !refresh) return false;
    try {
      const refreshed = await refresh({
        provider: this.provider,
        id: lease.id,
        credential: lease.value,
        refreshToken: lease.refreshToken,
        error
      });
      const value = typeof refreshed === "string"
        ? refreshed
        : refreshed?.accessToken ?? refreshed?.credential ?? null;
      if (!nonBlankSecret(value)) return false;
      const state = this.#stateForLease(lease);
      state.refreshedValue = String(value);
      state.blockedReason = null;
      LEASE_VALUES.set(lease, String(value));
      if (lease.secretName && typeof this.secretsStore?.setSecret === "function") {
        this.secretsStore.setSecret(lease.secretName, String(value), {
          decidedBy: `credential-pool:${this.provider}:${lease.id}:refresh`
        });
      }
      this.#persistState("refreshed", lease);
      return true;
    } catch {
      return false;
    }
  }

  _blockAuth(lease) {
    this.#stateForLease(lease).blockedReason = "auth";
    this.#persistState("blocked", lease, { reason: "auth" });
  }

  _rotate(fromLease, toLease, reason) {
    this.rotationCount += 1;
    // Credential rotation changes the prompt-cache identity. The provider must
    // treat the next request as a full-price cache miss; keeping the turn alive
    // is more important than preserving a stale cache binding.
    this.#emit({
      type: "credential_rotation",
      provider: this.provider,
      fromId: fromLease?.id ?? null,
      toId: toLease?.id ?? null,
      reason,
      promptCacheReset: true,
      pricingImpact: "full-price"
    });
    this.#persistState("rotated", fromLease ?? toLease, {
      toId: toLease?.id ?? null,
      reason,
      promptCacheReset: true,
      pricingImpact: "full-price"
    });
  }

  #availableEntries() {
    const now = Number(this.now());
    return this.entries.filter((entry) => {
      const state = this.states.get(entry.id);
      return !state.blockedReason && state.cooldownUntil <= now;
    });
  }

  #selectEntry(available) {
    if (this.strategy === "fill_first") return available[0];
    if (this.strategy === "least_used") {
      return [...available].sort((left, right) => {
        const delta = this.states.get(left.id).uses - this.states.get(right.id).uses;
        return delta || this.entries.indexOf(left) - this.entries.indexOf(right);
      })[0];
    }
    if (this.strategy === "random") {
      const value = Math.max(0, Math.min(0.999999999, Number(this.random()) || 0));
      return available[Math.floor(value * available.length)];
    }
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const index = (this.roundRobinCursor + offset) % this.entries.length;
      const entry = this.entries[index];
      if (!available.includes(entry)) continue;
      this.roundRobinCursor = (index + 1) % this.entries.length;
      return entry;
    }
    return available[0];
  }

  #resolveValue(entry, state) {
    if (nonBlankSecret(state.liveValue)) return state.liveValue;
    if (nonBlankSecret(state.refreshedValue)) return state.refreshedValue;
    if (entry.resolve) return entry.resolve();
    return resolveSecretReference(entry.secretName, {
      secretsStore: this.secretsStore,
      env: this.env,
      decidedBy: `credential-pool:${this.provider}:${entry.id}`
    });
  }

  #resolveRefreshToken(entry) {
    if (entry.resolveRefreshToken) return entry.resolveRefreshToken();
    return resolveSecretReference(entry.refreshTokenSecretName, {
      secretsStore: this.secretsStore,
      env: this.env,
      decidedBy: `credential-pool:${this.provider}:${entry.id}:refresh`
    });
  }

  #stateForLease(lease) {
    if (!(lease instanceof CredentialLease) || lease.provider !== this.provider) {
      throw new TypeError("Credential lease does not belong to this pool");
    }
    const state = this.states.get(lease.id);
    if (!state) throw new TypeError("Credential lease is no longer registered");
    return state;
  }

  #emit(event) {
    try { this.onEvent?.(Object.freeze({ ...event })); } catch { /* advisory only */ }
  }

  #restoreState() {
    if (!this.statePath) return;
    const saved = readJsonFile(this.statePath, null);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    this.roundRobinCursor = nonNegativeInteger(saved.roundRobinCursor, 0);
    this.rotationCount = nonNegativeInteger(saved.rotationCount, 0);
    const credentials = saved.credentials && typeof saved.credentials === "object"
      ? saved.credentials
      : {};
    for (const entry of this.entries) {
      const raw = credentials[entry.id];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const state = this.states.get(entry.id);
      state.uses = nonNegativeInteger(raw.uses, 0);
      state.successes = nonNegativeInteger(raw.successes, 0);
      state.failures = nonNegativeInteger(raw.failures, 0);
      state.cooldownUntil = nonNegativeNumber(raw.cooldownUntil, 0);
      state.blockedReason = ["usage_limit", "auth"].includes(raw.blockedReason)
        ? raw.blockedReason
        : null;
    }
  }

  #persistState(action, lease, detail = {}) {
    if (!this.statePath || !this.eventsPath) return;
    const snapshot = {
      version: CREDENTIAL_POOL_CONFIG_VERSION,
      provider: this.provider,
      strategy: this.strategy,
      roundRobinCursor: this.roundRobinCursor,
      rotationCount: this.rotationCount,
      credentials: Object.fromEntries(this.entries.map((entry) => {
        const state = this.states.get(entry.id);
        return [entry.id, {
          uses: state.uses,
          successes: state.successes,
          failures: state.failures,
          cooldownUntil: state.cooldownUntil,
          blockedReason: state.blockedReason
        }];
      }))
    };
    writeJsonAtomic(this.statePath, snapshot, 0o600);
    appendJsonLine(this.eventsPath, {
      at: new Date(Number(this.now())).toISOString(),
      provider: this.provider,
      credentialId: CREDENTIAL_ID_RE.test(String(lease?.id ?? ""))
        ? String(lease.id)
        : null,
      action,
      ...detail
    }, 0o600);
  }
}

export class CredentialPoolRequest {
  constructor(pool, { refreshOAuth = null } = {}) {
    if (!(pool instanceof CredentialPool)) throw new TypeError("CredentialPoolRequest requires a pool");
    this.pool = pool;
    this.refreshOAuth = typeof refreshOAuth === "function" ? refreshOAuth : null;
    this.lease = null;
  }

  acquire() {
    if (!this.lease) this.lease = this.pool.acquire();
    return this.lease;
  }

  async execute(operation, { fallback = null, refreshOAuth = this.refreshOAuth } = {}) {
    if (typeof operation !== "function") throw new TypeError("Credential operation must be a function");
    const attempted = new Set();
    const failures = [];
    let genericRetriedId = null;
    let authRefreshedId = null;

    for (;;) {
      let lease;
      try {
        if (this.lease && !attempted.has(this.lease.id)) {
          lease = this.lease;
        } else {
          lease = this.pool.acquire({ excludeIds: attempted });
          if (this.lease && this.lease.id !== lease.id) {
            this.pool._rotate(this.lease, lease, failures.at(-1)?.kind ?? "unavailable");
          }
          this.lease = lease;
        }
      } catch (error) {
        const exhausted = error instanceof CredentialPoolExhaustedError
          ? this.pool.exhausted(failures)
          : error;
        if (exhausted instanceof CredentialPoolExhaustedError && typeof fallback === "function") {
          return fallback(exhausted);
        }
        throw exhausted;
      }

      try {
        const result = await operation(lease);
        this.pool.recordSuccess(lease);
        return result;
      } catch (error) {
        const classification = classifyCredentialFailure(error);
        if (classification.kind === "other") throw error;
        this.pool._recordFailure(lease, classification);
        failures.push({ id: lease.id, ...classification });

        if (classification.kind === "transient_rate_limit" && genericRetriedId !== lease.id) {
          genericRetriedId = lease.id;
          continue;
        }

        if (classification.kind === "auth" && authRefreshedId !== lease.id) {
          authRefreshedId = lease.id;
          if (await this.pool._refresh(lease, error, refreshOAuth)) {
            this.lease = lease;
            continue;
          }
          this.pool._blockAuth(lease);
        }

        attempted.add(lease.id);
        const previous = lease;
        this.lease = null;
        try {
          const next = this.pool.acquire({ excludeIds: attempted });
          this.pool._rotate(previous, next, classification.kind);
          this.lease = next;
        } catch (error) {
          const exhausted = error instanceof CredentialPoolExhaustedError
            ? this.pool.exhausted(failures)
            : error;
          if (exhausted instanceof CredentialPoolExhaustedError && typeof fallback === "function") {
            return fallback(exhausted);
          }
          throw exhausted;
        }
      }
    }
  }
}

export class CredentialPoolRegistry {
  constructor(pools = []) {
    this.pools = new Map();
    for (const pool of pools) this.register(pool);
  }

  register(pool) {
    if (!(pool instanceof CredentialPool)) throw new TypeError("CredentialPoolRegistry accepts CredentialPool instances");
    this.pools.set(pool.provider, pool);
    return pool;
  }

  get(provider) {
    return this.pools.get(normalizeProviderLookup(provider)) ?? null;
  }

  has(provider) {
    return this.get(provider) !== null;
  }

  beginRequest(provider, options = {}) {
    const pool = this.get(provider);
    return pool ? pool.beginRequest(options) : null;
  }

  async execute(provider, operation, options = {}) {
    const pool = this.get(provider);
    if (!pool) throw new CredentialPoolExhaustedError(provider);
    return pool.execute(operation, options);
  }

  snapshot() {
    return {
      version: CREDENTIAL_POOL_CONFIG_VERSION,
      providers: Object.fromEntries(
        [...this.pools.entries()].map(([provider, pool]) => [provider, pool.snapshot()])
      )
    };
  }

  toJSON() {
    return this.snapshot();
  }
}

export function loadCredentialPoolConfig({
  dataDir = resolveDataDir(),
  configPath = path.join(dataDir, "credential-pools.json"),
  env = process.env,
  secretsStore = null
} = {}) {
  const fileConfig = readJsonFile(configPath, {});
  let configured = env?.OPENAGI_CREDENTIAL_POOLS;
  if (typeof secretsStore?.getSecret === "function") {
    try {
      configured = secretsStore.getSecret("OPENAGI_CREDENTIAL_POOLS", {
        decidedBy: "credential-pool:config"
      }) ?? configured;
    } catch {
      // A configured process value remains the backward-compatible fallback.
    }
  }
  const envConfig = parseEnvironmentConfig(configured);
  return mergeConfig(fileConfig, envConfig);
}

export function createCredentialPoolRegistry({
  config,
  dataDir = resolveDataDir(),
  configPath = path.join(dataDir, "credential-pools.json"),
  env = process.env,
  secretsStore = null,
  providerEnvKeys = DEFAULT_PROVIDER_ENV_KEYS,
  now = Date.now,
  random = Math.random,
  refreshOAuth = null,
  onEvent = null
} = {}) {
  const loaded = config ?? loadCredentialPoolConfig({
    dataDir,
    configPath,
    env,
    secretsStore
  });
  const providers = normalizeProviderConfig(loaded);
  const envKeys = normalizeProviderEnvKeys(providerEnvKeys);
  for (const [provider, envName] of Object.entries(envKeys)) {
    if (providers[provider]?.credentials?.length) continue;
    const value = env?.[envName];
    if (!nonBlankSecret(value)) continue;
    providers[provider] = {
      strategy: "round_robin",
      credentials: [{ id: "env", type: "api_key", secretName: envName }]
    };
  }
  return new CredentialPoolRegistry(
    Object.entries(providers).flatMap(([provider, definition]) => {
      const credentials = Array.isArray(definition?.credentials) ? definition.credentials : [];
      if (credentials.length === 0) return [];
      return [new CredentialPool({
        provider,
        credentials,
        strategy: definition.strategy,
        env,
        secretsStore,
        now,
        random,
        refreshOAuth,
        onEvent,
        dataDir
      })];
    })
  );
}

function normalizeCredentials(credentials) {
  if (!Array.isArray(credentials)) throw new TypeError("Credential pool credentials must be an array");
  const seen = new Set();
  return credentials.map((raw, index) => {
    const record = typeof raw === "string" ? { secretName: raw } : raw;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("Credential pool entries must be secret-name references");
    }
    for (const field of LITERAL_SECRET_FIELDS) {
      if (Object.hasOwn(record, field)) {
        throw new TypeError(`Credential pool entries cannot contain literal secret field ${field}`);
      }
    }
    const secretName = normalizeSecretName(record.secretName ?? record.envName, "secretName");
    const refreshTokenSecretName = record.refreshTokenSecretName == null
      ? null
      : normalizeSecretName(record.refreshTokenSecretName, "refreshTokenSecretName");
    const id = safeCredentialId(record.id ?? `credential-${index + 1}`);
    if (seen.has(id)) throw new TypeError(`Duplicate credential pool id ${id}`);
    seen.add(id);
    const type = String(record.type ?? "api_key").toLowerCase();
    if (!["api_key", "oauth"].includes(type)) {
      throw new TypeError("Credential type must be api_key or oauth");
    }
    if (typeof record.resolve !== "function" && !secretName) {
      throw new TypeError("Credential pool entries require a secretName reference or resolver");
    }
    return Object.freeze({
      id,
      type,
      secretName,
      refreshTokenSecretName,
      resolve: typeof record.resolve === "function" ? record.resolve : null,
      resolveRefreshToken: typeof record.resolveRefreshToken === "function"
        ? record.resolveRefreshToken
        : null
    });
  });
}

function normalizeProviderConfig(raw) {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const source = root.providers && typeof root.providers === "object" ? root.providers : root;
  const providers = {};
  for (const [rawProvider, definition] of Object.entries(source)) {
    if (rawProvider === "version") continue;
    const provider = safeProviderName(rawProvider);
    const normalized = Array.isArray(definition) ? { credentials: definition } : definition;
    if (!normalized || typeof normalized !== "object") continue;
    providers[provider] = {
      strategy: normalizeStrategy(normalized.strategy),
      credentials: Array.isArray(normalized.credentials) ? [...normalized.credentials] : []
    };
  }
  return providers;
}

function normalizeProviderEnvKeys(raw) {
  const result = {};
  for (const [provider, envName] of Object.entries(raw ?? {})) {
    result[safeProviderName(provider)] = normalizeSecretName(envName, "provider env name");
  }
  return result;
}

function mergeConfig(fileConfig, envConfig) {
  const fileProviders = normalizeProviderConfig(fileConfig);
  const envProviders = normalizeProviderConfig(envConfig);
  return {
    version: CREDENTIAL_POOL_CONFIG_VERSION,
    providers: { ...fileProviders, ...envProviders }
  };
}

function parseEnvironmentConfig(value) {
  if (value == null || String(value).trim() === "") return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new TypeError("OPENAGI_CREDENTIAL_POOLS must be a JSON object of secret-name references");
  }
}

function resolveSecretReference(secretName, { secretsStore, env, decidedBy }) {
  if (!secretName) return null;
  if (secretsStore && typeof secretsStore.getSecret === "function") {
    try {
      const value = secretsStore.getSecret(secretName, { decidedBy });
      if (nonBlankSecret(value)) return value;
    } catch {
      return null;
    }
    return null;
  }
  return env?.[secretName] ?? null;
}

function normalizeSecretName(value, label) {
  const name = String(value ?? "").trim();
  if (!name) return null;
  if (!SECRET_NAME_RE.test(name)) throw new TypeError(`${label} must be an uppercase environment secret name`);
  return name;
}

function normalizeStrategy(value) {
  const strategy = String(value ?? "round_robin").trim().toLowerCase();
  if (!CREDENTIAL_POOL_STRATEGIES.includes(strategy)) {
    throw new TypeError(`Unknown credential pool strategy ${strategy}`);
  }
  return strategy;
}

function safeProviderName(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_NAME_RE.test(provider)) throw new TypeError("Credential pool provider name is invalid");
  return provider;
}

function normalizeProviderLookup(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  return PROVIDER_NAME_RE.test(provider) ? provider : "";
}

function safeCredentialId(value) {
  const id = String(value ?? "").trim();
  if (!CREDENTIAL_ID_RE.test(id)) throw new TypeError("Credential pool id is invalid");
  return id;
}

function errorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.response?.statusCode,
    error?.body?.status,
    error?.error?.status
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

function errorText(error) {
  const parts = [
    error?.message,
    error?.body?.error?.message,
    error?.body?.message,
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
    error?.error?.message,
    typeof error?.body === "string" ? error.body : null
  ];
  return parts.filter((value) => typeof value === "string").join(" ").toLowerCase();
}

function isPlanOrUsageLimit(text) {
  return /\b(?:plan|quota|usage|credit|spend|monthly|daily)\b.{0,80}\b(?:limit|cap|exceed|exhaust|reached)\b/.test(text)
    || /\b(?:limit|cap)\b.{0,40}\b(?:reached|exceeded)\b/.test(text);
}

function safeFailure(failure) {
  return {
    id: CREDENTIAL_ID_RE.test(String(failure?.id ?? "")) ? String(failure.id) : null,
    kind: [
      "auth",
      "billing",
      "transient_rate_limit",
      "usage_limit"
    ].includes(failure?.kind) ? failure.kind : "unknown",
    status: Number.isInteger(failure?.status) ? failure.status : null
  };
}

function nonBlankSecret(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

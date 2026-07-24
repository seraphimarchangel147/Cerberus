import { createHash, createHmac, randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";

export const RESPONSES_CONTINUATION_ENV = "OPENAGI_RESPONSES_CONTINUATION";

const CONTINUATION_MODES = new Set(["off", "auto", "on"]);
const LINEAGE_ROLES = new Set(["assistant", "user"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_UNSUPPORTED_TTL_MS = 15 * 60 * 1000;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 50_000;
const MAX_CANONICAL_STRING_BYTES = 256 * 1024;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_TOOL_COUNT = 512;
const MAX_IDENTITY_TEXT = 4096;
const MAX_RESPONSE_ID = 4096;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const RESPONSE_ID_RE = /^[\x21-\x7e]+$/u;
const PROCESS_CREDENTIAL_IDENTITY_KEY = randomBytes(32);
const EMPTY_LINEAGE_IDENTITY = digest(
  "openagi-conversation-lineage-seed-v1",
  "empty"
);

export function parseResponsesContinuationMode(value) {
  if (typeof value !== "string") return "off";
  const mode = value.trim().toLowerCase();
  return CONTINUATION_MODES.has(mode) ? mode : "off";
}

export function resolveResponsesContinuationMode(source = process.env) {
  if (typeof source === "string") {
    return parseResponsesContinuationMode(source);
  }
  if (
    source === null
    || typeof source !== "object"
    || utilTypes.isProxy(source)
  ) {
    return "off";
  }
  try {
    return parseResponsesContinuationMode(
      readDataProperty(source, RESPONSES_CONTINUATION_ENV)
    );
  } catch {
    return "off";
  }
}

export function createVisibleToolCatalogIdentity(tools = []) {
  return digest(
    "openagi-visible-tool-catalog-v2",
    normalizeVisibleToolCatalog(tools)
  );
}

export function createOpenAIPromptCacheKey(input = {}) {
  assertSafeRecordShell(input, "prompt cache input");
  const model = requireBoundedText(readDataProperty(input, "model"), "model");
  const stableInstructions = readDataProperty(input, "stableInstructions");
  const instructions = stableInstructions === undefined
    ? (readDataProperty(input, "instructions") ?? "")
    : stableInstructions;
  const tools = readDataProperty(input, "tools") ?? [];

  if (typeof instructions !== "string") {
    throw new TypeError("instructions must be a string");
  }
  assertStringBytes(instructions, "instructions");

  return digest("openagi-openai-prompt-cache-v2", {
    model,
    instructions,
    tools: normalizeVisibleToolCatalog(tools)
  });
}

export function createConversationContentIdentity(value) {
  return digest("openagi-conversation-content-v1", value);
}

export function createConversationLineageIdentity(messages = []) {
  return extendConversationLineageIdentity(EMPTY_LINEAGE_IDENTITY, messages);
}

export function extendConversationLineageIdentity(baseIdentity, messages = []) {
  const base = requireDigest(baseIdentity, "base lineage identity");
  const normalizedMessages = normalizeLineageMessages(messages);
  let lineage = base;
  for (const message of normalizedMessages) {
    lineage = digest("openagi-conversation-lineage-step-v1", {
      previous: lineage,
      message
    });
  }
  return lineage;
}

export function createCredentialLeaseIdentity(input = {}) {
  assertSafeRecordShell(input, "credential lease");
  const provider = requireBoundedText(
    readDataProperty(input, "provider"),
    "credential provider"
  ).toLowerCase();
  requireBoundedText(readDataProperty(input, "id"), "credential lease id");
  const type = requireBoundedText(readDataProperty(input, "type"), "credential type");
  const credential = readDataProperty(input, "credential");
  if (credential === undefined) {
    throw new TypeError("credential is required");
  }
  return keyedDigest(PROCESS_CREDENTIAL_IDENTITY_KEY, "openagi-credential-lease-v2", {
    provider,
    type,
    credential
  });
}

export function createRoutingIdentity(routing = {}) {
  return digest("openagi-provider-routing-v1", routing);
}

export function continuationUnsupported(error) {
  const facts = safeErrorFacts(error);
  const code = `${facts.code} ${facts.type}`.toLowerCase();
  const message = facts.message.toLowerCase();
  const explicitCode = [
    "invalid_previous_response_id",
    "previous_response_not_found",
    "response_not_found",
    "unsupported_previous_response_id",
    "zero_data_retention",
    "zdr"
  ].some((token) => code.includes(token));
  const mentionsContinuation = [
    "previous_response_id",
    "previous response",
    "response continuation",
    "zero data retention",
    "zdr"
  ].some((token) => message.includes(token));
  const mentionsUnsupported = [
    "not found",
    "not supported",
    "unsupported",
    "cannot use",
    "can't use",
    "disabled",
    "does not exist",
    "invalid"
  ].some((token) => message.includes(token));
  const compatibleStatus = [400, 404, 409, 422].includes(facts.status);
  return compatibleStatus
    && (explicitCode || (mentionsContinuation && mentionsUnsupported));
}

export class ResponsesContinuationStore {
  constructor({
    mode = resolveResponsesContinuationMode(),
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    unsupportedTtlMs = DEFAULT_UNSUPPORTED_TTL_MS,
    now = Date.now
  } = {}) {
    this.mode = parseResponsesContinuationMode(mode);
    this.maxEntries = boundedInteger(maxEntries, DEFAULT_MAX_ENTRIES, 1, 4096);
    this.ttlMs = boundedInteger(ttlMs, DEFAULT_TTL_MS, 1, 24 * 60 * 60 * 1000);
    this.unsupportedTtlMs = boundedInteger(
      unsupportedTtlMs,
      DEFAULT_UNSUPPORTED_TTL_MS,
      1,
      24 * 60 * 60 * 1000
    );
    this.now = typeof now === "function" ? now : Date.now;
    this.entries = new Map();
    this.lineages = new Map();
    this.reservations = new Map();
    this.unsupportedCapabilities = new Map();
    this.counters = {
      hits: 0,
      misses: 0,
      claims: 0,
      staleClaims: 0,
      commits: 0,
      rejectedCommits: 0,
      evictions: 0,
      invalidations: 0,
      unsupportedFallbacks: 0
    };
  }

  claim(identity, options = {}) {
    if (this.mode === "off") {
      this.counters.misses += 1;
      return miss("off");
    }

    const resolved = resolveIdentity(identity);
    const expected = resolveContinuationState(options);
    if (!resolved || !expected) {
      this.counters.misses += 1;
      return miss(!resolved ? "invalid_identity" : "invalid_claim");
    }

    const now = this.currentTime();
    this.purgeExpired(now);
    const reservation = this.reserve(resolved, expected, now);
    const unsupported = this.unsupportedStatusFor(resolved.capabilityKey, now);
    if (this.mode === "auto" && unsupported.unsupported) {
      this.counters.misses += 1;
      return {
        ...miss("unsupported", reservation),
        retryAfterMs: unsupported.retryAfterMs
      };
    }

    const entry = this.entries.get(resolved.key);
    if (!entry) {
      this.counters.misses += 1;
      return miss("not_found", reservation);
    }

    // Deletion precedes every result. JavaScript runs this section
    // synchronously, so two callers cannot claim the same response ID.
    this.entries.delete(resolved.key);
    this.counters.claims += 1;
    if (entry.contextEpoch !== expected.contextEpoch) {
      this.counters.misses += 1;
      this.counters.staleClaims += 1;
      this.counters.invalidations += 1;
      return miss("context_epoch_mismatch", reservation);
    }
    if (entry.lineageIdentity !== expected.lineageIdentity) {
      this.counters.misses += 1;
      this.counters.staleClaims += 1;
      this.counters.invalidations += 1;
      return miss("lineage_mismatch", reservation);
    }

    this.counters.hits += 1;
    return {
      hit: true,
      reason: "claimed",
      responseId: entry.responseId,
      reservation
    };
  }

  // Compatibility entry point with consuming semantics. New callers should
  // use claim() so single-use behavior is explicit at the call site.
  lookup(identity, options = {}) {
    return this.claim(identity, options);
  }

  commit(identity, responseId, options = {}) {
    if (this.mode === "off") {
      return { committed: false, reason: "off" };
    }

    const resolved = resolveIdentity(identity);
    const attempt = resolveCommitAttempt(options);
    if (!resolved || !attempt?.reservation) {
      return { committed: false, reason: "invalid_input" };
    }

    const now = this.currentTime();
    this.purgeExpired(now);
    const reservation = this.reservations.get(resolved.key);
    if (!reservation || reservation.token !== attempt.reservation) {
      this.counters.rejectedCommits += 1;
      return { committed: false, reason: "stale_reservation" };
    }
    // A reservation is a one-shot CAS capability, including on a rejected
    // commit. Reusing it can never replace a newer provider response.
    this.reservations.delete(resolved.key);
    const normalizedResponseId = normalizeResponseId(responseId);
    const state = attempt.state;
    if (!normalizedResponseId || !state) {
      this.counters.rejectedCommits += 1;
      return { committed: false, reason: "invalid_input" };
    }
    if (state.contextEpoch <= reservation.contextEpoch) {
      this.counters.rejectedCommits += 1;
      return { committed: false, reason: "stale_context" };
    }
    const unsupported = this.unsupportedStatusFor(resolved.capabilityKey, now);
    if (this.mode === "auto" && unsupported.unsupported) {
      return { committed: false, reason: "unsupported" };
    }

    const previous = this.lineages.get(resolved.key);
    if (previous && state.contextEpoch <= previous.contextEpoch) {
      this.counters.rejectedCommits += 1;
      return {
        committed: false,
        reason: state.contextEpoch === previous.contextEpoch
          ? "duplicate_context"
          : "stale_context"
      };
    }

    this.entries.delete(resolved.key);
    this.lineages.delete(resolved.key);
    const expiresAt = now + this.ttlMs;
    this.entries.set(resolved.key, {
      responseId: normalizedResponseId,
      capabilityKey: resolved.capabilityKey,
      lineageIdentity: state.lineageIdentity,
      contextEpoch: state.contextEpoch,
      expiresAt
    });
    this.lineages.set(resolved.key, {
      capabilityKey: resolved.capabilityKey,
      contextEpoch: state.contextEpoch,
      expiresAt
    });
    this.counters.commits += 1;
    this.enforceEntryLimit();
    return { committed: true, reason: "committed" };
  }

  abandon(identity, reservation) {
    const resolved = resolveIdentity(identity);
    const token = normalizeReservation(reservation);
    if (!resolved || !token) {
      return { abandoned: false, reason: "invalid_input" };
    }
    const current = this.reservations.get(resolved.key);
    if (!current || current.token !== token) {
      return { abandoned: false, reason: "stale_reservation" };
    }
    this.reservations.delete(resolved.key);
    return { abandoned: true, reason: "abandoned" };
  }

  invalidate(identity) {
    const resolved = resolveIdentity(identity);
    if (!resolved) return { invalidated: false, count: 0 };
    const entry = this.entries.delete(resolved.key);
    const lineage = this.lineages.delete(resolved.key);
    const reservation = this.reservations.delete(resolved.key);
    const count = Number(entry) + Number(lineage) + Number(reservation);
    if (count > 0) this.counters.invalidations += count;
    return { invalidated: count > 0, count };
  }

  invalidateAll() {
    const count = this.entries.size + this.lineages.size + this.reservations.size;
    this.entries.clear();
    this.lineages.clear();
    this.reservations.clear();
    this.counters.invalidations += count;
    return { invalidated: count > 0, count };
  }

  markUnsupported(identity, { ttlMs = this.unsupportedTtlMs } = {}) {
    const resolved = resolveCapability(identity);
    if (!resolved) return { marked: false, reason: "invalid_identity" };

    const now = this.currentTime();
    this.purgeExpired(now);
    const duration = boundedInteger(
      ttlMs,
      this.unsupportedTtlMs,
      1,
      24 * 60 * 60 * 1000
    );
    this.unsupportedCapabilities.delete(resolved.capabilityKey);
    this.unsupportedCapabilities.set(resolved.capabilityKey, {
      expiresAt: now + duration
    });
    let invalidated = 0;
    for (const [key, entry] of this.entries) {
      if (entry.capabilityKey !== resolved.capabilityKey) continue;
      this.entries.delete(key);
      invalidated += 1;
    }
    for (const [key, entry] of this.lineages) {
      if (entry.capabilityKey !== resolved.capabilityKey) continue;
      this.lineages.delete(key);
      invalidated += 1;
    }
    for (const [key, entry] of this.reservations) {
      if (entry.capabilityKey !== resolved.capabilityKey) continue;
      this.reservations.delete(key);
      invalidated += 1;
    }
    this.counters.invalidations += invalidated;
    this.counters.unsupportedFallbacks += 1;
    this.enforceUnsupportedLimit();
    return {
      marked: true,
      reason: "unsupported_recorded",
      retryAfterMs: duration,
      invalidated
    };
  }

  recordUnsupportedFallback(identity, options) {
    return this.markUnsupported(identity, options);
  }

  unsupportedStatus(identity) {
    const resolved = resolveCapability(identity);
    if (!resolved) {
      return {
        unsupported: false,
        reason: "invalid_identity",
        retryAfterMs: 0
      };
    }
    const now = this.currentTime();
    this.purgeExpired(now);
    return this.unsupportedStatusFor(resolved.capabilityKey, now);
  }

  clearUnsupported(identity) {
    const resolved = resolveCapability(identity);
    if (!resolved) return { cleared: false, count: 0 };
    const cleared = this.unsupportedCapabilities.delete(resolved.capabilityKey);
    return { cleared, count: cleared ? 1 : 0 };
  }

  stats() {
    this.purgeExpired(this.currentTime());
    return {
      mode: this.mode,
      entries: this.entries.size,
      lineages: this.lineages.size,
      reservations: this.reservations.size,
      unsupportedCapabilities: this.unsupportedCapabilities.size,
      maxEntries: this.maxEntries,
      ...this.counters
    };
  }

  clear() {
    const entries = this.entries.size;
    const lineages = this.lineages.size;
    const reservations = this.reservations.size;
    const unsupportedCapabilities = this.unsupportedCapabilities.size;
    this.entries.clear();
    this.lineages.clear();
    this.reservations.clear();
    this.unsupportedCapabilities.clear();
    return { entries, lineages, reservations, unsupportedCapabilities };
  }

  currentTime() {
    try {
      const value = this.now();
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : Date.now();
    } catch {
      return Date.now();
    }
  }

  purgeExpired(now) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const [key, entry] of this.lineages) {
      if (entry.expiresAt <= now) this.lineages.delete(key);
    }
    for (const [key, entry] of this.reservations) {
      if (entry.expiresAt <= now) this.reservations.delete(key);
    }
    for (const [key, entry] of this.unsupportedCapabilities) {
      if (entry.expiresAt <= now) this.unsupportedCapabilities.delete(key);
    }
  }

  unsupportedStatusFor(capabilityKey, now) {
    const entry = this.unsupportedCapabilities.get(capabilityKey);
    if (!entry) {
      return {
        unsupported: false,
        reason: "supported_or_unknown",
        retryAfterMs: 0
      };
    }
    if (entry.expiresAt <= now) {
      this.unsupportedCapabilities.delete(capabilityKey);
      return {
        unsupported: false,
        reason: "expired",
        retryAfterMs: 0
      };
    }
    return {
      unsupported: true,
      reason: "unsupported",
      retryAfterMs: Math.max(0, entry.expiresAt - now)
    };
  }

  enforceEntryLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.counters.evictions += 1;
    }
    while (this.lineages.size > this.maxEntries) {
      const oldestKey = this.lineages.keys().next().value;
      this.lineages.delete(oldestKey);
    }
    while (this.reservations.size > this.maxEntries) {
      const oldestKey = this.reservations.keys().next().value;
      this.reservations.delete(oldestKey);
    }
  }

  enforceUnsupportedLimit() {
    while (this.unsupportedCapabilities.size > this.maxEntries) {
      const oldestKey = this.unsupportedCapabilities.keys().next().value;
      this.unsupportedCapabilities.delete(oldestKey);
    }
  }

  reserve(resolved, expected, now) {
    const token = randomBytes(24).toString("base64url");
    this.reservations.delete(resolved.key);
    this.reservations.set(resolved.key, {
      token,
      capabilityKey: resolved.capabilityKey,
      contextEpoch: expected.contextEpoch,
      expiresAt: now + this.ttlMs
    });
    this.enforceEntryLimit();
    return token;
  }
}

function miss(reason, reservation = null) {
  return {
    hit: false,
    reason,
    responseId: null,
    reservation
  };
}

function resolveIdentity(identity) {
  let value;
  try {
    value = canonicalSnapshot(identity);
  } catch {
    return null;
  }
  if (!isSafeRecord(value)) return null;
  const capability = resolveCapability(value);
  if (!capability) return null;

  const sessionId = optionalBoundedText(value.sessionId);
  const promptIdentity = optionalDigest(value.promptIdentity);
  const toolIdentity = optionalDigest(value.toolIdentity);
  if (
    !sessionId
    || !promptIdentity
    || !toolIdentity
  ) {
    return null;
  }

  return {
    capabilityKey: capability.capabilityKey,
    key: digest("openagi-responses-continuation-identity-v2", {
      sessionId,
      sessionIncarnation: capability.sessionIncarnation,
      provider: capability.provider,
      endpoint: capability.endpoint,
      model: capability.model,
      credentialIdentity: capability.credentialIdentity,
      routingIdentity: capability.routingIdentity,
      projectId: capability.projectId,
      memoryScope: capability.memoryScope,
      promptIdentity,
      toolIdentity
    })
  };
}

function resolveCapability(identity) {
  let value;
  try {
    value = canonicalSnapshot(identity);
  } catch {
    return null;
  }
  if (!isSafeRecord(value)) return null;
  const provider = optionalBoundedText(value.provider)?.toLowerCase();
  const endpoint = normalizeEndpoint(value.endpoint);
  const model = optionalBoundedText(value.model);
  const credentialIdentity = optionalDigest(value.credentialIdentity);
  const routingIdentity = optionalDigest(value.routingIdentity);
  const sessionIncarnation = optionalBoundedText(value.sessionIncarnation);
  const projectId = optionalBoundedText(value.projectId);
  const memoryScope = optionalBoundedText(value.memoryScope);
  if (
    !provider
    || !endpoint
    || !model
    || !credentialIdentity
    || !routingIdentity
    || !sessionIncarnation
    || (!projectId && !memoryScope)
  ) {
    return null;
  }
  return {
    provider,
    endpoint,
    model,
    credentialIdentity,
    routingIdentity,
    sessionIncarnation,
    projectId,
    memoryScope,
    capabilityKey: digest("openagi-responses-continuation-capability-v2", {
      provider,
      endpoint,
      model,
      credentialIdentity,
      routingIdentity,
      sessionIncarnation,
      projectId,
      memoryScope
    })
  };
}

function resolveContinuationState(options) {
  let value;
  try {
    value = canonicalSnapshot(options);
  } catch {
    return null;
  }
  if (!isSafeRecord(value)) return null;
  const lineageIdentity = optionalDigest(value.lineageIdentity);
  const contextEpoch = value.contextEpoch;
  if (
    !lineageIdentity
    || !Number.isSafeInteger(contextEpoch)
    || contextEpoch < 0
  ) {
    return null;
  }
  return { lineageIdentity, contextEpoch };
}

function resolveCommitAttempt(options) {
  let value;
  try {
    value = canonicalSnapshot(options);
  } catch {
    return null;
  }
  const reservation = normalizeReservation(value.reservation);
  if (!reservation) return null;
  const lineageIdentity = optionalDigest(value.lineageIdentity);
  const contextEpoch = value.contextEpoch;
  const state = lineageIdentity
    && Number.isSafeInteger(contextEpoch)
    && contextEpoch >= 0
    ? { lineageIdentity, contextEpoch }
    : null;
  return { reservation, state };
}

function normalizeEndpoint(value) {
  const text = optionalBoundedText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol.toLowerCase()) || !parsed.hostname) {
      return null;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/gu, "") || "/";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function normalizeResponseId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RESPONSE_ID
    || !RESPONSE_ID_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeReservation(value) {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : null;
}

function optionalDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value) ? value : null;
}

function requireDigest(value, label) {
  const normalized = optionalDigest(value);
  if (!normalized) {
    throw new TypeError(`${label} must be a lowercase SHA-256 identity`);
  }
  return normalized;
}

function optionalBoundedText(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTITY_TEXT
    || value !== value.trim()
    || /[\r\n\0]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function requireBoundedText(value, label) {
  const normalized = optionalBoundedText(value);
  if (!normalized) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return normalized;
}

function normalizeVisibleToolCatalog(tools) {
  const values = safeArrayValues(tools, "tools", MAX_TOOL_COUNT);
  return values.map((tool) => normalizeVisibleTool(tool));
}

function normalizeVisibleTool(tool) {
  assertSafeRecordShell(tool, "tool definition");
  const nestedValue = readDataProperty(tool, "function");
  const nested = nestedValue === undefined
    ? null
    : assertSafeRecordShell(nestedValue, "nested tool definition");
  const type = optionalBoundedText(readDataProperty(tool, "type")) ?? "function";
  const name = requireBoundedText(
    readDataProperty(tool, "name") ?? readDataProperty(nested, "name"),
    "tool name"
  );
  const rawDescription = readDataProperty(tool, "description")
    ?? readDataProperty(nested, "description")
    ?? "";
  if (typeof rawDescription !== "string") {
    throw new TypeError("tool description must be a string");
  }
  assertStringBytes(rawDescription, "tool description");
  const parameters = readDataProperty(tool, "parameters")
    ?? readDataProperty(nested, "parameters")
    ?? readDataProperty(tool, "input_schema")
    ?? readDataProperty(tool, "inputSchema")
    ?? readDataProperty(tool, "schema")
    ?? {};
  const normalized = {
    type,
    name,
    description: rawDescription,
    parameters: canonicalSnapshot(parameters)
  };
  const strict = readDataProperty(tool, "strict")
    ?? readDataProperty(nested, "strict");
  if (strict !== undefined && typeof strict !== "boolean") {
    throw new TypeError("tool strict must be a boolean");
  }
  if (typeof strict === "boolean") normalized.strict = strict;
  return normalized;
}

function normalizeLineageMessages(messages) {
  const values = safeArrayValues(messages, "messages", MAX_ARRAY_LENGTH);
  return values.map((message) => normalizeLineageMessage(message));
}

function normalizeLineageMessage(message) {
  assertSafeRecordShell(message, "conversation message");
  const rawRole = readDataProperty(message, "role");
  if (typeof rawRole !== "string") {
    throw new TypeError("conversation message role must be a string");
  }
  const role = rawRole.trim().toLowerCase();
  if (!LINEAGE_ROLES.has(role)) {
    throw new TypeError("conversation message role must be user or assistant");
  }
  const override = readDataProperty(message, "contentIdentity");
  let contentIdentity;
  if (override !== undefined) {
    contentIdentity = requireDigest(override, "message content identity");
  } else {
    const content = readDataProperty(message, "content");
    if (content === undefined) {
      throw new TypeError("conversation message content is required");
    }
    contentIdentity = createConversationContentIdentity(content);
  }
  return { role, contentIdentity };
}

function digest(domain, value) {
  const hash = createHash("sha256");
  hash.update(domain);
  hash.update("\0");
  hash.update(canonicalJson(value));
  return hash.digest("hex");
}

function keyedDigest(key, domain, value) {
  const hash = createHmac("sha256", key);
  hash.update(domain);
  hash.update("\0");
  hash.update(canonicalJson(value));
  return hash.digest("hex");
}

function canonicalJson(value) {
  const normalized = canonicalSnapshot(value);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_CANONICAL_BYTES) {
    throw new RangeError("canonical input exceeds the supported byte size");
  }
  return json;
}

function canonicalSnapshot(value) {
  const state = {
    ancestors: new Set(),
    nodes: 0,
    bytes: 0
  };
  return canonicalValue(value, state, 0);
}

function canonicalValue(value, state, depth) {
  state.nodes += 1;
  consumeCanonicalBytes(state, 8);
  if (state.nodes > MAX_CANONICAL_NODES) {
    throw new RangeError("canonical input exceeds the supported node count");
  }
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError("canonical input exceeds the supported depth");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertStringBytes(value, "canonical string");
    consumeCanonicalBytes(state, Buffer.byteLength(value, "utf8"));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical numbers must be finite");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    throw new TypeError("canonical input must not contain BigInt values");
  }
  if (
    value === undefined
    || typeof value === "function"
    || typeof value === "symbol"
  ) {
    throw new TypeError("canonical input contains an unsupported value");
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError("canonical input must not contain proxies");
  }
  if (state.ancestors.has(value)) {
    throw new TypeError("canonical input must not contain cycles");
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = safeArrayValues(value, "canonical array", MAX_ARRAY_LENGTH);
      return items.map((item) => canonicalValue(item, state, depth + 1));
    }
    if (!isSafeRecord(value)) {
      throw new TypeError("canonical objects must have a plain prototype");
    }
    const keys = safeRecordKeys(value, "canonical object");
    const result = {};
    for (const key of keys.sort(compareStrings)) {
      consumeCanonicalBytes(state, Buffer.byteLength(key, "utf8"));
      result[key] = canonicalValue(
        readRequiredDataProperty(value, key, "canonical object"),
        state,
        depth + 1
      );
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function consumeCanonicalBytes(state, count) {
  state.bytes += count;
  if (state.bytes > MAX_CANONICAL_BYTES) {
    throw new RangeError("canonical input exceeds the supported byte size");
  }
}

function assertSafeRecordShell(value, label) {
  if (!isSafeRecord(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of safeRecordKeys(value, label)) {
    const item = readRequiredDataProperty(value, key, label);
    if (
      typeof item === "function"
      || typeof item === "symbol"
      || utilTypes.isProxy(item)
    ) {
      throw new TypeError(`${label} contains executable or proxied data`);
    }
  }
  return value;
}

function isSafeRecord(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeRecordKeys(value, label) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${label} keys are not safely readable`);
  }
  if (keys.length > MAX_OBJECT_KEYS) {
    throw new RangeError(`${label} exceeds the supported key count`);
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} must not contain symbol keys`);
    }
    if (UNSAFE_KEYS.has(key)) {
      throw new TypeError(`${label} contains an unsafe key`);
    }
    assertStringBytes(key, `${label} key`);
    const descriptor = safeDescriptor(value, key, label);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain only enumerable data properties`);
    }
  }
  return keys;
}

function safeArrayValues(value, label, maximum) {
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const lengthDescriptor = safeDescriptor(value, "length", label);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new RangeError(`${label} exceeds the supported size`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${label} keys are not safely readable`);
  }
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  if (keys.length !== length + 1) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }
  const result = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = safeDescriptor(value, key, label);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain only data elements`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

function readDataProperty(value, key) {
  if (value === null || value === undefined) return undefined;
  const descriptor = safeDescriptor(value, key, "input");
  if (!descriptor.exists) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError("input must not contain accessor properties");
  }
  return descriptor.value;
}

function readRequiredDataProperty(value, key, label) {
  const descriptor = safeDescriptor(value, key, label);
  if (!descriptor.exists || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`${label} must contain only data properties`);
  }
  return descriptor.value;
}

function safeDescriptor(value, key, label) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor ? { ...descriptor, exists: true } : { exists: false };
  } catch {
    throw new TypeError(`${label} properties are not safely readable`);
  }
}

function assertStringBytes(value, label) {
  if (Buffer.byteLength(value, "utf8") > MAX_CANONICAL_STRING_BYTES) {
    throw new RangeError(`${label} exceeds the supported byte size`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeErrorFacts(error) {
  if (
    error === null
    || (typeof error !== "object" && typeof error !== "function")
    || utilTypes.isProxy(error)
  ) {
    return {
      status: null,
      code: "",
      type: "",
      message: typeof error === "string" ? error.slice(0, 4096) : ""
    };
  }
  try {
    return {
      status: safeOwnInteger(error, ["status", "statusCode"]),
      code: safeOwnString(error, ["providerCode", "code"]),
      type: safeOwnString(error, ["providerType", "type"]),
      message: safeOwnString(error, ["message"])
    };
  } catch {
    return { status: null, code: "", type: "", message: "" };
  }
}

function safeOwnString(value, keys) {
  for (const key of keys) {
    const descriptor = safeDescriptor(value, key, "error");
    if (
      descriptor.exists
      && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "string"
    ) {
      return descriptor.value.slice(0, 4096);
    }
  }
  return "";
}

function safeOwnInteger(value, keys) {
  for (const key of keys) {
    const descriptor = safeDescriptor(value, key, "error");
    if (
      descriptor.exists
      && Object.hasOwn(descriptor, "value")
      && Number.isInteger(descriptor.value)
    ) {
      return descriptor.value;
    }
  }
  return null;
}

function boundedInteger(value, fallback, min, max) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

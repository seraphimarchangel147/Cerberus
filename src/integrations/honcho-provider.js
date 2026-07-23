import { createHash } from "node:crypto";

const HONCHO_API_VERSION = "v3";
const DEFAULT_HONCHO_BASE_URL = "https://api.honcho.dev";
const DEFAULT_HONCHO_WORKSPACE_ID = "openagi";
const DEFAULT_HONCHO_PEER_ID = "openagi-user";
const DEFAULT_HONCHO_AGENT_PEER_ID = "openagi-agent";
const DEFAULT_HONCHO_TIMEOUT_MS = 5_000;
const MAX_HONCHO_ID_CHARS = 512;
const MAX_HONCHO_CONTENT_CHARS = 25_000;
const MAX_HONCHO_RESULT_CHARS = 25_000;
const MAX_HONCHO_RESPONSE_BYTES = 256 * 1024;

/**
 * Portable request scope shared by external-memory provider operations.
 *
 * Provider implementations accept exactly one object argument. The optional
 * signal lets callers cancel an operation without depending on a provider's
 * transport. Implementations must reject cancellation and must not return raw
 * backend payloads, credentials, or transport response objects.
 *
 * @typedef {Object} ExternalMemoryScope
 * @property {string} [userId] Stable identity for the modeled user.
 * @property {string} [observerId] Stable identity for the observing agent.
 * @property {AbortSignal} [signal] Optional caller-owned cancellation signal.
 */

/**
 * @typedef {ExternalMemoryScope & {
 *   query?: string
 * }} ExternalMemoryGetInput
 */

/**
 * @typedef {ExternalMemoryScope & {
 *   content: string | Object | Array<unknown>,
 *   metadata?: {
 *     action?: string,
 *     supersededIds?: Array<string>
 *   }
 * }} ExternalMemorySetInput
 */

/**
 * @typedef {ExternalMemoryScope & {
 *   query: string
 * }} ExternalMemoryQueryInput
 */

/**
 * @typedef {Object} ExternalMemoryGetResult
 * @property {string} provider
 * @property {string} userId
 * @property {string} observerId
 * @property {string} model Bounded provider-generated user model.
 */

/**
 * @typedef {Object} ExternalMemorySetResult
 * @property {string} provider
 * @property {string} userId
 * @property {string} observerId
 * @property {boolean} accepted
 */

/**
 * @typedef {Object} ExternalMemoryQueryResult
 * @property {string} provider
 * @property {string} userId
 * @property {string} observerId
 * @property {string} answer Bounded provider-generated answer.
 */

/**
 * Portable external-memory provider contract.
 *
 * @typedef {Object} ExternalMemoryProvider
 * @property {(input: ExternalMemoryGetInput) => Promise<ExternalMemoryGetResult>} getUserModel
 * @property {(input: ExternalMemorySetInput) => Promise<ExternalMemorySetResult>} setUserModel
 * @property {(input: ExternalMemoryQueryInput) => Promise<ExternalMemoryQueryResult>} queryUserModel
 */

export const EXTERNAL_MEMORY_PROVIDER_METHODS = Object.freeze([
  "getUserModel",
  "setUserModel",
  "queryUserModel"
]);

export class HonchoProviderError extends Error {
  constructor(message, { code = "HONCHO_ERROR", operation = null, status = null } = {}) {
    super(message);
    this.name = "HonchoProviderError";
    this.code = code;
    this.operation = operation;
    this.status = status;
  }
}

export function isExternalMemoryProvider(provider) {
  return Boolean(
    provider
    && EXTERNAL_MEMORY_PROVIDER_METHODS.every((method) => typeof provider[method] === "function")
  );
}

export function assertExternalMemoryProvider(provider) {
  const missing = EXTERNAL_MEMORY_PROVIDER_METHODS.filter(
    (method) => typeof provider?.[method] !== "function"
  );
  if (missing.length > 0) {
    throw new TypeError(
      `External memory provider must implement: ${missing.join(", ")}.`
    );
  }
  return provider;
}

/**
 * Turn a runtime identity into a Honcho v3 identifier.
 *
 * Honcho IDs permit only ASCII letters, digits, underscores, and hyphens.
 * Unsafe or overlong inputs get a readable prefix plus a hash of the exact
 * original input, so two Unicode or punctuation-heavy identities cannot
 * silently collapse onto the same peer.
 */
export function stableHonchoId(value, fallback = "openagi") {
  const raw = String(value ?? "").trim();
  if (!raw) return safeFallbackId(fallback);
  if (/^[A-Za-z0-9_-]+$/.test(raw) && raw.length <= MAX_HONCHO_ID_CHARS) {
    return raw;
  }

  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
  const suffix = `-${hash}`;
  const maxPrefixLength = MAX_HONCHO_ID_CHARS - suffix.length;
  const prefix = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, maxPrefixLength)
    .replace(/[-_]+$/g, "");
  const safePrefix = prefix || safeFallbackId(fallback).slice(0, maxPrefixLength);
  return `${safePrefix}${suffix}`;
}

/**
 * Additive external-memory provider backed by the Honcho v3 HTTP API.
 *
 * The built-in OpenAGI memory remains authoritative and is not read or
 * replaced here. This contract stores explicit user-model facts as Honcho
 * conclusions, reads the static representation, and uses Honcho dialectic
 * chat for reasoned queries.
 */
export class HonchoMemoryProvider {
  #apiKey;
  #fetchImpl;
  #logger;
  #workspaceReady = false;
  #workspaceInFlight = null;
  #readyPeers = new Set();
  #peerInFlight = new Map();

  constructor(options = {}) {
    const apiKey = String(options.apiKey ?? "").trim();
    if (!apiKey) {
      throw new Error("HONCHO_API_KEY is required when Honcho memory is enabled.");
    }
    if (typeof options.fetchImpl !== "function" && typeof globalThis.fetch !== "function") {
      throw new Error("Honcho memory requires a fetch implementation.");
    }

    this.provider = "honcho";
    this.baseUrl = normalizeBaseUrl(
      String(options.baseUrl ?? "").trim() || DEFAULT_HONCHO_BASE_URL
    );
    this.workspaceId = stableHonchoId(
      options.workspaceId ?? DEFAULT_HONCHO_WORKSPACE_ID,
      DEFAULT_HONCHO_WORKSPACE_ID
    );
    this.peerId = stableHonchoId(
      options.peerId ?? DEFAULT_HONCHO_PEER_ID,
      DEFAULT_HONCHO_PEER_ID
    );
    this.agentPeerId = stableHonchoId(
      options.agentPeerId ?? DEFAULT_HONCHO_AGENT_PEER_ID,
      DEFAULT_HONCHO_AGENT_PEER_ID
    );
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.#apiKey = apiKey;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#logger = normalizeLogger(options.logger);
  }

  /**
   * @param {ExternalMemoryGetInput} input
   * @returns {Promise<ExternalMemoryGetResult>}
   */
  async getUserModel(input = {}) {
    const { userId, observerId, signal } = this.#resolveScope(input);
    const searchQuery = input.query === undefined
      ? undefined
      : requireText(input.query, "Honcho user-model search query", 10_000);
    await this.#ensureModelPeers(userId, observerId, signal);
    const response = await this.#request(
      `/workspaces/${encodeURIComponent(this.workspaceId)}`
        + `/peers/${encodeURIComponent(observerId)}/representation`,
      {
        operation: "get user model",
        signal,
        body: {
          target: userId,
          ...(searchQuery ? { search_query: searchQuery } : {})
        }
      }
    );
    const model = validateRepresentationResponse(response);
    return {
      provider: this.provider,
      userId,
      observerId,
      model
    };
  }

  /**
   * @param {ExternalMemorySetInput} input
   * @returns {Promise<ExternalMemorySetResult>}
   */
  async setUserModel(input = {}) {
    const { userId, observerId, signal } = this.#resolveScope(input);
    const content = conclusionContent(input.content, input.metadata);
    await this.#ensureModelPeers(userId, observerId, signal);
    const response = await this.#request(
      `/workspaces/${encodeURIComponent(this.workspaceId)}/conclusions`,
      {
        operation: "set user model",
        signal,
        body: {
          conclusions: [{
            content,
            session_id: null,
            observer_id: observerId,
            observed_id: userId
          }]
        }
      }
    );
    validateConclusionsResponse(response, {
      content,
      observerId,
      userId
    });
    return {
      provider: this.provider,
      userId,
      observerId,
      accepted: true
    };
  }

  /**
   * @param {ExternalMemoryQueryInput} input
   * @returns {Promise<ExternalMemoryQueryResult>}
   */
  async queryUserModel(input = {}) {
    const { userId, observerId, signal } = this.#resolveScope(input);
    const text = requireText(input.query, "Honcho user-model query", 10_000);
    await this.#ensureModelPeers(userId, observerId, signal);
    const response = await this.#request(
      `/workspaces/${encodeURIComponent(this.workspaceId)}`
        + `/peers/${encodeURIComponent(observerId)}/chat`,
      {
        operation: "query user model",
        signal,
        body: {
          query: text,
          target: userId,
          reasoning_level: "minimal",
          stream: false
        }
      }
    );
    const answer = validateChatResponse(response);
    return {
      provider: this.provider,
      userId,
      observerId,
      answer
    };
  }

  #resolveScope(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Honcho provider input must be an object.");
    }
    const signal = normalizeAbortSignal(input.signal);
    return {
      userId: stableHonchoId(input.userId ?? this.peerId, DEFAULT_HONCHO_PEER_ID),
      observerId: stableHonchoId(
        input.observerId ?? this.agentPeerId,
        DEFAULT_HONCHO_AGENT_PEER_ID
      ),
      signal
    };
  }

  async #ensureModelPeers(userId, observerId, signal) {
    if (signal?.aborted) {
      throw new HonchoProviderError(
        "Honcho request was aborted before peer bootstrap.",
        { code: "HONCHO_ABORTED", operation: "bootstrap peers" }
      );
    }
    await Promise.all([
      this.#ensurePeer(observerId, signal),
      this.#ensurePeer(userId, signal)
    ]);
  }

  async #ensureWorkspace(signal) {
    if (this.#workspaceReady) return;
    if (!this.#workspaceInFlight) {
      const pending = this.#request("/workspaces", {
        operation: "bootstrap workspace",
        body: { id: this.workspaceId }
      }).then((response) => {
        validateBootstrapResponse(response, this.workspaceId, "workspace");
        this.#workspaceReady = true;
      });
      this.#workspaceInFlight = pending;
      void pending.finally(() => {
        if (this.#workspaceInFlight === pending) this.#workspaceInFlight = null;
      }).catch(() => {});
    }
    return waitForOperation(this.#workspaceInFlight, signal, "bootstrap workspace");
  }

  async #ensurePeer(peerId, signal) {
    if (this.#readyPeers.has(peerId)) return;
    const existing = this.#peerInFlight.get(peerId);
    if (existing) {
      return waitForOperation(existing, signal, "bootstrap peer");
    }

    const pending = (async () => {
      await this.#ensureWorkspace();
      const response = await this.#request(
        `/workspaces/${encodeURIComponent(this.workspaceId)}/peers`,
        {
          operation: "bootstrap peer",
          body: { id: peerId }
        }
      );
      validateBootstrapResponse(response, peerId, "peer");
      this.#readyPeers.add(peerId);
    })();
    this.#peerInFlight.set(peerId, pending);
    void pending.finally(() => {
      if (this.#peerInFlight.get(peerId) === pending) {
        this.#peerInFlight.delete(peerId);
      }
    }).catch(() => {});
    return waitForOperation(pending, signal, "bootstrap peer");
  }

  async #request(route, { operation, body, signal }) {
    if (signal?.aborted) {
      const error = new HonchoProviderError(
        `Honcho request was aborted during ${operation}.`,
        { code: "HONCHO_ABORTED", operation }
      );
      this.#warn(error.message);
      throw error;
    }
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let timeoutId;
    let rejectInterruption;
    const interruption = new Promise((_, reject) => {
      rejectInterruption = reject;
    });
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort();
      rejectInterruption(new HonchoProviderError(
        `Honcho request was aborted during ${operation}.`,
        { code: "HONCHO_ABORTED", operation }
      ));
    };
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectInterruption(new HonchoProviderError(
        `Honcho request timed out during ${operation}.`,
        { code: "HONCHO_TIMEOUT", operation }
      ));
    }, this.timeoutMs);

    const request = (async () => {
      const response = await this.#fetchImpl(
        `${this.baseUrl}/${HONCHO_API_VERSION}${route}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );
      if (!response || typeof response.ok !== "boolean") {
        throw new HonchoProviderError(
          `Honcho returned an invalid response during ${operation}.`,
          { code: "HONCHO_INVALID_RESPONSE", operation }
        );
      }
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : null;
        throw new HonchoProviderError(
          `Honcho request failed during ${operation}`
            + `${status === null ? "." : ` (HTTP ${status}).`}`,
          { code: "HONCHO_HTTP_ERROR", operation, status }
        );
      }
      return readJsonResponse(response, operation);
    })();

    try {
      return await Promise.race([request, interruption]);
    } catch (error) {
      if (error instanceof HonchoProviderError) {
        this.#warn(error.message);
        throw error;
      }
      const abortFailure = callerAborted
        || (error?.name === "AbortError" && signal?.aborted);
      const timeoutFailure = !abortFailure && (timedOut || error?.name === "AbortError");
      const safeError = new HonchoProviderError(
        abortFailure
          ? `Honcho request was aborted during ${operation}.`
          : timeoutFailure
          ? `Honcho request timed out during ${operation}.`
          : `Honcho request could not be completed during ${operation}.`,
        {
          code: abortFailure
            ? "HONCHO_ABORTED"
            : timeoutFailure
              ? "HONCHO_TIMEOUT"
              : "HONCHO_NETWORK_ERROR",
          operation
        }
      );
      this.#warn(safeError.message);
      throw safeError;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  #warn(message) {
    try {
      this.#logger(message);
    } catch {
      // Optional diagnostics must never change provider behavior.
    }
  }
}

export function createExternalMemoryProvider(options = {}) {
  const env = options.env ?? process.env;
  const selected = String(
    options.provider ?? env.OPENAGI_MEMORY_PROVIDER ?? ""
  ).trim().toLowerCase();
  if (!selected || selected === "builtin" || selected === "built-in" || selected === "none") {
    return null;
  }
  if (selected !== "honcho") {
    throw new Error("Unsupported external memory provider selection.");
  }

  const provider = new HonchoMemoryProvider({
    apiKey: options.apiKey ?? env.HONCHO_API_KEY,
    baseUrl: options.baseUrl ?? env.HONCHO_URL,
    workspaceId: options.workspaceId ?? env.HONCHO_WORKSPACE_ID,
    peerId: options.peerId,
    agentPeerId: options.agentPeerId,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    logger: options.logger
  });
  return assertExternalMemoryProvider(provider);
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
    if (url.username || url.password || url.search || url.hash) throw new Error("unsafe URL");
    if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
      throw new Error("plaintext HTTP is not loopback");
    }
    return url.toString().replace(/\/+$/g, "");
  } catch {
    throw new Error(
      "HONCHO_URL must be HTTPS, or plaintext HTTP on a loopback host, without credentials or query data."
    );
  }
}

function isLoopbackHostname(value) {
  const hostname = String(value ?? "").toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

function normalizeTimeout(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_HONCHO_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120_000) {
    throw new Error("Honcho timeout must be an integer from 1 to 120000 milliseconds.");
  }
  return parsed;
}

function normalizeLogger(logger) {
  if (typeof logger === "function") return logger;
  if (logger && typeof logger.warn === "function") {
    return (message) => logger.warn(message);
  }
  return () => {};
}

function safeFallbackId(value) {
  const safe = String(value ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_HONCHO_ID_CHARS);
  return safe || "openagi";
}

function requireText(value, label, maxChars) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxChars) {
    throw new RangeError(`${label} cannot exceed ${maxChars} characters.`);
  }
  return value;
}

function normalizeAbortSignal(signal) {
  if (signal === undefined || signal === null) return undefined;
  if (
    typeof signal !== "object"
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("Honcho provider signal must be an AbortSignal.");
  }
  return signal;
}

function waitForOperation(promise, signal, operation) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      new HonchoProviderError(
        `Honcho request was aborted during ${operation}.`,
        { code: "HONCHO_ABORTED", operation }
      )
    );
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function conclusionContent(value, metadata) {
  const replacement = serializeUserModel(value);
  if (metadata?.action !== "correct") return replacement;
  const supersededIds = normalizeSupersededIds(metadata.supersededIds);
  return serializeUserModel({
    action: "supersede",
    replacement,
    supersededLocalMemoryIds: supersededIds
  });
}

function normalizeSupersededIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("Honcho correction supersededIds must be an array.");
  }
  if (value.length > 100) {
    throw new RangeError("Honcho correction cannot supersede more than 100 memory IDs.");
  }
  return [...new Set(value.map((id) => {
    const text = requireText(id, "Honcho superseded memory ID", MAX_HONCHO_ID_CHARS);
    return text;
  }))];
}

function serializeUserModel(value) {
  const content = typeof value === "string"
    ? value
    : JSON.stringify(canonicalJsonValue(value, new Set(), "$"));
  return requireText(content, "Honcho user model", MAX_HONCHO_CONTENT_CHARS);
}

function canonicalJsonValue(value, ancestors, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Honcho user model contains a non-finite number at ${path}.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Honcho user model is not JSON-serializable at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Honcho user model contains a circular reference at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalJsonValue(
        item,
        ancestors,
        `${path}[${index}]`
      ));
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalJsonValue(value[key], ancestors, `${path}.${key}`);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function validateBootstrapResponse(response, expectedId, kind) {
  requireResponseRecord(response, `bootstrap ${kind}`);
  if (response.id !== expectedId) {
    throw invalidResponse(`Honcho returned an invalid ${kind} during bootstrap.`);
  }
}

function validateConclusionsResponse(response, { content, observerId, userId }) {
  if (!Array.isArray(response) || response.length < 1) {
    throw invalidResponse("Honcho returned invalid conclusions after a user-model write.");
  }
  for (const conclusion of response) {
    requireResponseRecord(conclusion, "set user model");
    boundedResponseString(conclusion.id, "Honcho conclusion ID", MAX_HONCHO_ID_CHARS, {
      allowEmpty: false
    });
    boundedResponseString(
      conclusion.content,
      "Honcho conclusion content",
      MAX_HONCHO_CONTENT_CHARS
    );
    boundedResponseString(
      conclusion.observer_id,
      "Honcho conclusion observer ID",
      MAX_HONCHO_ID_CHARS,
      { allowEmpty: false }
    );
    boundedResponseString(
      conclusion.observed_id,
      "Honcho conclusion observed ID",
      MAX_HONCHO_ID_CHARS,
      { allowEmpty: false }
    );
  }
  if (!response.some((conclusion) => (
    conclusion.content === content
    && conclusion.observer_id === observerId
    && conclusion.observed_id === userId
  ))) {
    throw invalidResponse("Honcho did not acknowledge the submitted user-model conclusion.");
  }
}

function validateRepresentationResponse(response) {
  requireResponseRecord(response, "get user model");
  return boundedResponseString(
    response.representation,
    "Honcho user-model representation",
    MAX_HONCHO_RESULT_CHARS
  );
}

function validateChatResponse(response) {
  requireResponseRecord(response, "query user model");
  if (response.content === null) return "";
  return boundedResponseString(
    response.content,
    "Honcho user-model answer",
    MAX_HONCHO_RESULT_CHARS
  );
}

function requireResponseRecord(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`Honcho returned an invalid response during ${operation}.`);
  }
  return value;
}

function boundedResponseString(value, label, maxChars, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw invalidResponse(`${label} is missing or invalid.`);
  }
  if (value.length > maxChars) {
    throw new HonchoProviderError(
      `${label} exceeds the ${maxChars}-character limit.`,
      { code: "HONCHO_RESULT_TOO_LARGE" }
    );
  }
  return value;
}

function invalidResponse(message) {
  return new HonchoProviderError(message, { code: "HONCHO_INVALID_RESPONSE" });
}

async function readJsonResponse(response, operation) {
  try {
    if (response.status === 204) return null;
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HONCHO_RESPONSE_BYTES) {
      throw responseTooLarge(operation);
    }
    const text = await readBoundedResponseText(response, operation);
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof HonchoProviderError) throw error;
    throw new HonchoProviderError(
      `Honcho returned invalid JSON during ${operation}.`,
      { code: "HONCHO_INVALID_RESPONSE", operation }
    );
  }
}

async function readBoundedResponseText(response, operation) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = typeof value === "string"
          ? new TextEncoder().encode(value)
          : value;
        if (!(chunk instanceof Uint8Array)) {
          throw invalidResponse(`Honcho returned an invalid body during ${operation}.`);
        }
        bytes += chunk.byteLength;
        if (bytes > MAX_HONCHO_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Best-effort cancellation after enforcing the response cap.
          }
          throw responseTooLarge(operation);
        }
        text += decoder.decode(chunk, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock?.();
    }
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    if (typeof text !== "string") {
      throw invalidResponse(`Honcho returned an invalid body during ${operation}.`);
    }
    if (new TextEncoder().encode(text).byteLength > MAX_HONCHO_RESPONSE_BYTES) {
      throw responseTooLarge(operation);
    }
    return text;
  }

  if (typeof response.json === "function") {
    const text = JSON.stringify(await response.json());
    if (new TextEncoder().encode(text).byteLength > MAX_HONCHO_RESPONSE_BYTES) {
      throw responseTooLarge(operation);
    }
    return text;
  }
  throw invalidResponse(`Honcho returned no readable body during ${operation}.`);
}

function responseTooLarge(operation) {
  return new HonchoProviderError(
    `Honcho response exceeds the ${MAX_HONCHO_RESPONSE_BYTES}-byte limit during ${operation}.`,
    { code: "HONCHO_RESPONSE_TOO_LARGE", operation }
  );
}

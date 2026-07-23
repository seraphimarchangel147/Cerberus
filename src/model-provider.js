import { createHash } from "node:crypto";
import {
  CredentialPool,
  CredentialPoolExhaustedError,
  createCredentialPoolRegistry
} from "./credential-pool.js";
import { MoaProvider, normalizeMoaModelSpec } from "./moa-provider.js";
import { ModelRouter } from "./model-router.js";
import { defaultToolOutputStore } from "./tool-output-store.js";
import { TOOL_SEARCH_BRIDGE_NAMES, resolveToolSearchMode } from "./tool-search.js";
import {
  CONTEXT_GATEWAY_RATIO,
  compressLiveContext,
  contextCompressionTrigger,
  contextInputTokens,
  estimateContextTokens,
  markLiveContextSyntheticTurn
} from "./memory-condenser.js";
import { summarizeText } from "./utils.js";

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_REQUEST_HOPS = 6;
const DEFAULT_MAX_TURN_SECONDS = 900;
// Max silence (no streamed tokens/events) before a single request is treated
// as stalled. A model that keeps producing output — even slowly, like Kimi —
// resets this on every event and is never aborted for being slow. 0 disables
// stall detection and falls back to the fixed per-request timeout.
const DEFAULT_STALL_TIMEOUT_MS = 120000;
// Budget for the final "stop, no tools, answer now" call made when a turn is
// cut short (stall / timeout / iteration-cap). Mirrors Hermes forcing a reply
// at the iteration limit instead of returning nothing.
const DEFAULT_FORCE_ANSWER_MS = 60000;
const DEFAULT_PROVIDER_MAX_RETRIES = 3;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 500;
const MAX_PROVIDER_RETRY_DELAY_MS = 8000;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8000;
const DEFAULT_CONTEXT_COMPACT_CHARS = 120000;
const DEFAULT_CONTEXT_KEEP_RECENT_HOPS = 4;
const DEFAULT_CONTEXT_DIGEST_CHARS = 4000;
const DEFAULT_CONTEXT_ESTIMATE_CHARS_PER_TOKEN = 4;
const MAX_CACHE_IDENTITY_SESSIONS = 1000;
const RUNTIME_CACHE_IDENTITIES = new WeakMap();
const UNKNOWN_CONTEXT_WINDOW_WARNINGS = new Set();
const MIN_CONTEXT_DIGEST_CHARS = 40;
const SYNTHETIC_CONTINUE = [
  "[system] Continue the same task now.",
  "Use the accumulated tool results and conversation above.",
  "Do not repeat completed work; keep using tools if needed, then give the user a final answer."
].join(" ");
const GOAL_JUDGE_INSTRUCTIONS = [
  "You are a cheap goal-completion judge.",
  "Decide whether the stated goal is fully satisfied by the latest assistant progress.",
  "Return only JSON: {\"satisfied\":true|false,\"why\":\"short reason\"}."
].join(" ");
const GOAL_JUDGE_MAX_TOKENS = 256;

class TurnDeadlineError extends Error {
  constructor() {
    super("The turn wall-clock deadline was reached.");
    this.name = "TurnDeadlineError";
  }
}

// A SINGLE model request exceeded the per-request timeout (this.timeoutMs).
// Distinct from TurnDeadlineError (the whole-turn wall-clock guard): one slow
// hop must NOT nuke the entire turn with a raw undici "This operation was
// aborted" — the loop catches this and stops gracefully with a partial summary.
class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`A single model request exceeded the ${Math.round(timeoutMs)}ms request timeout.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// The model stopped streaming output for longer than the stall window (it went
// silent, as opposed to still-producing-tokens-slowly). Recoverable: the turn
// forces a final answer, same as a request timeout — never a raw abort.
class ModelStallError extends Error {
  constructor(stallMs) {
    super(`The model produced no output for ${Math.round(stallMs)}ms (stalled).`);
    this.name = "ModelStallError";
    this.stallMs = stallMs;
  }
}

export class ProviderError extends Error {
  constructor(message, {
    status = null,
    retryAfterMs = null,
    providerCode = null,
    providerType = null,
    cause = null
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderError";
    this.status = Number.isInteger(status) ? status : null;
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
    this.providerCode = typeof providerCode === "string" ? providerCode : null;
    this.providerType = typeof providerType === "string" ? providerType : null;
  }
}

const RETRYABLE_PROVIDER_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function retryAfterMs(response, now = Date.now()) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function isRetryableNetworkError(error) {
  if (!error || error instanceof ProviderError) return false;
  if (error instanceof TurnDeadlineError || error instanceof RequestTimeoutError || error instanceof ModelStallError) return false;
  if (error.name === "AbortError") return false;
  return error instanceof TypeError
    || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "ETIMEDOUT"].includes(error.code);
}

async function responseProviderError(response) {
  const body = await response.json().catch(() => ({}));
  const detail = body?.error && typeof body.error === "object" ? body.error : {};
  return new ProviderError(
    detail.message ?? `Provider request failed with ${response.status}`,
    {
      status: response.status,
      retryAfterMs: retryAfterMs(response),
      providerCode: detail.code,
      providerType: detail.type
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

// Retry only the model HTTP request. Tool execution stays outside this helper,
// so replaying a transient provider request can never repeat a side effect.
export async function requestWithRetry(doRequest, options = {}) {
  const retries = nonNegativeInteger(options.retries, DEFAULT_PROVIDER_MAX_RETRIES);
  const baseDelayMs = nonNegativeInteger(options.baseDelayMs, DEFAULT_PROVIDER_RETRY_BASE_MS);
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await doRequest(attempt);
      if (response?.ok === false) throw await responseProviderError(response);
      return response;
    } catch (error) {
      const retryable = error instanceof ProviderError
        ? RETRYABLE_PROVIDER_STATUSES.has(error.status)
        : isRetryableNetworkError(error);
      let retryApproved = retryable;
      if (retryable && typeof options.shouldRetry === "function") {
        try {
          retryApproved = options.shouldRetry({ attempt, error }) !== false;
        } catch {
          retryApproved = false;
        }
      }
      if (!retryApproved || attempt >= retries) {
        if (error instanceof ProviderError) throw error;
        if (retryable) throw new ProviderError(error.message ?? "Provider network request failed", { cause: error });
        throw error;
      }

      const jitterCap = Math.min(MAX_PROVIDER_RETRY_DELAY_MS, baseDelayMs * (2 ** attempt));
      const jittered = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * jitterCap);
      const delayMs = error.retryAfterMs === null
        ? jittered
        : Math.min(MAX_PROVIDER_RETRY_DELAY_MS, error.retryAfterMs);
      try { options.onRetry?.({ attempt: attempt + 1, delayMs, error }); } catch { /* advisory */ }
      await wait(delayMs);
    }
  }
}

function resolveStallTimeoutMs(options) {
  if (options.stallTimeoutMs !== undefined) return options.stallTimeoutMs;
  const parsed = Number(process.env.OPENAGI_STALL_TIMEOUT_MS);
  // Explicit 0 disables stall detection; anything else falls back to default.
  if (process.env.OPENAGI_STALL_TIMEOUT_MS?.trim() && Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_STALL_TIMEOUT_MS;
}

function resolveForceAnswerMs(options) {
  if (options.forceAnswerMs !== undefined) return options.forceAnswerMs;
  return positiveInteger(process.env.OPENAGI_FORCE_ANSWER_MS, DEFAULT_FORCE_ANSWER_MS);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveMaxIterations(options) {
  if (options.maxIterations !== undefined) {
    return positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  }
  // Preserve programmatic callers that still pass the former option.
  if (options.maxToolHops !== undefined) {
    return positiveInteger(options.maxToolHops, DEFAULT_MAX_ITERATIONS);
  }
  // The deprecated environment alias is consulted only when the new name is
  // genuinely unset, so a stale service setting cannot override the new knob.
  if (process.env.OPENAGI_MAX_ITERATIONS?.trim()) {
    return positiveInteger(process.env.OPENAGI_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS);
  }
  return positiveInteger(process.env.OPENAGI_MAX_TOOL_HOPS, DEFAULT_MAX_ITERATIONS);
}

function applyIterationSettings(provider, options) {
  provider.maxIterations = resolveMaxIterations(options);
  // Tests and embedders may provide both names while migrating: in that case
  // maxIterations is the outer cap and the old option remains the inner hop
  // boundary. With only maxToolHops present it is the deprecated outer alias.
  const requestHops = options.maxRequestHops
    ?? (options.maxIterations !== undefined ? options.maxToolHops : undefined);
  provider.maxRequestHops = positiveInteger(requestHops, DEFAULT_MAX_REQUEST_HOPS);
  provider.maxTurnSeconds = positiveNumber(
    options.maxTurnSeconds ?? process.env.OPENAGI_MAX_TURN_SECONDS,
    DEFAULT_MAX_TURN_SECONDS
  );
  provider.maxTurnUsd = optionalPositiveNumber(
    options.maxTurnUsd ?? process.env.OPENAGI_MAX_TURN_USD
  );
  provider.stallTimeoutMs = resolveStallTimeoutMs(options);
  provider.forceAnswerMs = resolveForceAnswerMs(options);
  provider.providerMaxRetries = nonNegativeInteger(
    options.providerMaxRetries ?? process.env.OPENAGI_PROVIDER_MAX_RETRIES,
    DEFAULT_PROVIDER_MAX_RETRIES
  );
  provider.providerRetryBaseMs = nonNegativeInteger(
    options.providerRetryBaseMs ?? process.env.OPENAGI_PROVIDER_RETRY_BASE_MS,
    DEFAULT_PROVIDER_RETRY_BASE_MS
  );
  provider.retrySleep = options.retrySleep;
  provider.retryRandom = options.retryRandom;
  provider.maxToolOutputChars = positiveInteger(
    options.maxToolOutputChars ?? process.env.OPENAGI_MAX_TOOL_OUTPUT_CHARS,
    DEFAULT_MAX_TOOL_OUTPUT_CHARS
  );
  provider.contextCompactChars = positiveInteger(
    options.contextCompactChars ?? process.env.OPENAGI_CONTEXT_COMPACT_CHARS,
    DEFAULT_CONTEXT_COMPACT_CHARS
  );
  provider.contextKeepRecentHops = positiveInteger(
    options.contextKeepRecentHops ?? process.env.OPENAGI_CONTEXT_KEEP_RECENT_HOPS,
    DEFAULT_CONTEXT_KEEP_RECENT_HOPS
  );
  const configuredContextWindow = options.contextWindowTokens
    ?? process.env.OPENAGI_CONTEXT_WINDOW_TOKENS;
  provider.contextWindowTokens = typeof configuredContextWindow === "function"
    ? configuredContextWindow
    : optionalPositiveNumber(configuredContextWindow);
  provider.contextDigestChars = Math.min(
    DEFAULT_CONTEXT_DIGEST_CHARS,
    positiveInteger(options.contextDigestChars, DEFAULT_CONTEXT_DIGEST_CHARS),
    provider.contextCompactChars
  );
  provider.contextEstimateCharsPerToken = positiveNumber(
    options.contextEstimateCharsPerToken,
    DEFAULT_CONTEXT_ESTIMATE_CHARS_PER_TOKEN
  );
  provider.cacheWarningLog = typeof options.cacheWarningLog === "function"
    ? options.cacheWarningLog
    : (message) => console.warn(message);
  provider.now = options.now ?? Date.now;
  // Keep this readable for integrations that inspect the old property. The
  // value now represents the whole-turn iteration cap.
  provider.maxToolHops = provider.maxIterations;
}

function providerRetryOptions(provider, context, signal) {
  return {
    retries: provider.providerMaxRetries,
    baseDelayMs: provider.providerRetryBaseMs,
    sleep: provider.retrySleep ?? ((ms) => sleepWithSignal(ms, signal)),
    random: provider.retryRandom,
    onRetry: ({ attempt, delayMs, error }) => {
      try {
        context?.__onToolEvent?.({
          phase: "provider-retry",
          attempt,
          delayMs,
          status: error?.status ?? null
        });
      } catch {
        // Retry progress is advisory and cannot break recovery.
      }
    }
  };
}

const MANAGED_CREDENTIAL_STATUSES = new Set([401, 402, 429]);

function configureProviderCredentialPool(provider, options, {
  providerName,
  envSecretName
}) {
  provider.credentialProviderName = providerName;
  provider.credentialEnvSecretName = envSecretName;
  provider.credentialPool = options.credentialPool ?? null;
  if (!provider.credentialPool && provider.apiKey) {
    provider.credentialPool = createLiveApiKeyPool(provider);
  }
}

function createLiveApiKeyPool(provider) {
  return new CredentialPool({
    provider: provider.credentialProviderName,
    credentials: [{
      id: "env",
      type: "api_key",
      secretName: provider.credentialEnvSecretName,
      resolve: () => provider.apiKey
    }]
  });
}

function syncProviderCredentialPool(provider) {
  if (!provider.credentialPool && provider.apiKey) {
    provider.credentialPool = createLiveApiKeyPool(provider);
  }
  // Registry-created auto pools use the stable "env" id. Keeping that entry
  // synchronized preserves the long-standing behavior where callers may
  // replace provider.apiKey on a live native provider instance.
  try {
    provider.credentialPool?.syncCredential?.("env", provider.apiKey);
  } catch {
    // A configured multi-key pool has no mutable auto entry; it stays primary.
  }
  return provider.credentialPool ?? null;
}

function providerHasCredentials(provider) {
  const pool = syncProviderCredentialPool(provider);
  return Boolean(provider.apiKey) || Boolean(pool?.isConfigured?.());
}

function beginProviderCredentialRequest(provider) {
  const pool = syncProviderCredentialPool(provider);
  if (!pool) throw new CredentialPoolExhaustedError(provider.credentialProviderName);
  const request = pool.beginRequest();
  const lease = request.acquire();
  return { request, lease };
}

function isCredentialPoolExhausted(error) {
  return error instanceof CredentialPoolExhaustedError
    || error?.code === "CREDENTIAL_POOL_EXHAUSTED";
}

function managedCredentialRetry({ error }) {
  return !MANAGED_CREDENTIAL_STATUSES.has(error?.status);
}

function emitCredentialRotation(context, providerName, previousId, nextId, status) {
  if (!previousId || !nextId || previousId === nextId) return;
  try {
    context?.__onToolEvent?.({
      phase: "credential-rotation",
      provider: providerName,
      status: Number.isInteger(status) ? status : null
    });
  } catch {
    // Rotation progress is advisory and never enters model context.
  }
}

async function requestWithProviderCredential(provider, credentialRequest, {
  context,
  signal,
  model,
  request
}) {
  const active = credentialRequest ?? beginProviderCredentialRequest(provider).request;
  let previousId = active.lease?.id ?? null;
  let previousStatus = null;
  return active.execute(async (lease) => {
    emitCredentialRotation(
      context,
      provider.credentialProviderName,
      previousId,
      lease.id,
      previousStatus
    );
    previousId = lease.id;
    trackPromptCacheIdentity(provider, {
      provider: provider.credentialProviderName,
      model,
      baseUrl: provider.baseUrl,
      credential: lease.value,
      context
    });
    try {
      return await requestWithRetry(
        () => request(lease.value, lease),
        {
          ...providerRetryOptions(provider, context, signal),
          shouldRetry: managedCredentialRetry
        }
      );
    } catch (error) {
      previousStatus = Number.isInteger(error?.status) ? error.status : null;
      throw error;
    }
  });
}

function initialCredentialState(provider, { model, context }) {
  const state = beginProviderCredentialRequest(provider);
  trackPromptCacheIdentity(provider, {
    provider: provider.credentialProviderName,
    model,
    baseUrl: provider.baseUrl,
    credential: state.lease.value,
    context
  });
  return state;
}

async function tryFallbackProvider(provider, request, error) {
  const fallback = provider.fallbackProvider;
  if (!isCredentialPoolExhausted(error) || !fallback?.isConfigured?.()) {
    return { used: false, result: null };
  }
  return {
    used: true,
    result: await fallback.generate(request)
  };
}

function emitIteration(context, n, max) {
  try {
    context?.__onToolEvent?.({ phase: "iteration", n, max });
  } catch {
    // Progress observers are advisory and must never break a turn.
  }
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The turn was cancelled.");
  error.name = "AbortError";
  return error;
}

async function withinTurn(provider, deadline, task, context = {}) {
  const remainingMs = deadline - provider.now();
  if (remainingMs <= 0) throw new TurnDeadlineError();
  const signal = context?.__abortSignal;
  if (signal?.aborted) throw abortReason(signal);

  let timer;
  let onAbort;
  try {
    const contenders = [
      Promise.resolve().then(() => task(remainingMs)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new TurnDeadlineError();
          context?.__turnAbortController?.abort?.(error);
          reject(error);
        }, Math.max(1, Math.ceil(remainingMs)));
      })
    ];
    if (signal) {
      contenders.push(new Promise((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }));
    }
    return await Promise.race(contenders);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function deadlineExpired(provider, deadline, error) {
  return error instanceof TurnDeadlineError || provider.now() >= deadline;
}

// A single model request hit its per-request timeout OR stalled (went silent).
// Unlike a hard error this is recoverable: the turn stops gracefully, forces a
// final answer, and returns whatever partial work it already has — instead of
// discarding the entire turn with a raw "This operation was aborted".
function requestTimedOut(error) {
  return error instanceof RequestTimeoutError || error instanceof ModelStallError;
}

function providerUnavailable(error) {
  return isCredentialPoolExhausted(error)
    || (error instanceof ProviderError
      && (error.status === null || RETRYABLE_PROVIDER_STATUSES.has(error.status)));
}

function budgetExceeded(error) {
  return error?.code === "BUDGET_EXCEEDED";
}

function checkRequestBudget(provider, turnBudget) {
  provider.budgetGuard?.check();
  if (turnBudget.limitUsd !== null && turnBudget.spentUsd >= turnBudget.limitUsd) {
    const error = new Error(
      `Turn budget reached: $${turnBudget.spentUsd.toFixed(4)} of $${turnBudget.limitUsd.toFixed(4)}. ` +
      "Raise OPENAGI_MAX_TURN_USD to allow more model requests in one turn."
    );
    error.code = "BUDGET_EXCEEDED";
    throw error;
  }
}

function recordTurnSpend(turnBudget, record) {
  const added = Number(record?.added);
  if (Number.isFinite(added) && added > 0) turnBudget.spentUsd += added;
}

function openAIWantsContinuation(response, calls) {
  return calls.length > 0
    || response?.status === "incomplete"
    || response?.status === "in_progress"
    || Boolean(response?.incomplete_details);
}

function anthropicWantsContinuation(response, toolUses) {
  return toolUses.length > 0
    || ["tool_use", "max_tokens", "pause_turn"].includes(response?.stop_reason);
}

function extractAnthropicText(response) {
  return (response?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Anthropic's SSE stream is a delta protocol, while the existing iteration
// engine consumes complete message objects. Reconstructing that same object
// here keeps tool calls, usage accounting, budgets, and continuation behavior
// on one path. Only user-visible text deltas leave this parser; thinking and
// tool-input JSON remain internal to the agent loop.
export async function readAnthropicEventStream(response, { onDelta, onActivity } = {}) {
  if (!response?.body?.getReader) throw new Error("Anthropic streaming response has no readable body.");

  const message = { type: "message", role: "assistant", content: [], usage: {} };
  const toolJson = new Map();

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "error") {
      throw new Error(event.error?.message ?? "Anthropic stream returned an error event.");
    }
    if (event.type === "message_start") {
      const started = event.message ?? {};
      Object.assign(message, started, { content: [] });
      message.usage = { ...(started.usage ?? {}) };
      return;
    }
    if (event.type === "content_block_start") {
      const index = Number(event.index);
      if (!Number.isInteger(index) || index < 0) return;
      const block = structuredClone(event.content_block ?? {});
      message.content[index] = block;
      if (block.type === "tool_use") toolJson.set(index, "");
      return;
    }
    if (event.type === "content_block_delta") {
      const index = Number(event.index);
      if (!Number.isInteger(index) || index < 0) return;
      const delta = event.delta ?? {};
      const block = message.content[index] ?? (message.content[index] = {});
      if (delta.type === "text_delta") {
        block.type = block.type ?? "text";
        block.text = `${block.text ?? ""}${delta.text ?? ""}`;
        if (delta.text && typeof onDelta === "function") {
          try { onDelta(delta.text); } catch { /* presentation callbacks are advisory */ }
        }
      } else if (delta.type === "thinking_delta") {
        block.type = block.type ?? "thinking";
        block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
      } else if (delta.type === "signature_delta") {
        block.signature = `${block.signature ?? ""}${delta.signature ?? ""}`;
      } else if (delta.type === "input_json_delta") {
        toolJson.set(index, `${toolJson.get(index) ?? ""}${delta.partial_json ?? ""}`);
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const index = Number(event.index);
      const block = message.content[index];
      if (block?.type === "tool_use" && toolJson.has(index)) {
        const raw = toolJson.get(index);
        try {
          block.input = raw ? JSON.parse(raw) : (block.input ?? {});
        } catch {
          throw new Error("Anthropic stream returned malformed tool input JSON.");
        }
      }
      return;
    }
    if (event.type === "message_delta") {
      Object.assign(message, event.delta ?? {});
      message.usage = { ...(message.usage ?? {}), ...(event.usage ?? {}) };
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    handleEvent(JSON.parse(data));
  };

  while (true) {
    const { done, value } = await reader.read();
    // Every chunk (any streamed byte — text, thinking, or tool-input delta) is
    // proof the model is still producing output. Reset the stall watchdog.
    if (typeof onActivity === "function" && (value?.length || !done)) {
      try { onActivity(); } catch { /* watchdog callback is advisory */ }
    }
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (done) break;
  }
  if (pending) consumeLine(pending);

  // A well-formed stream closes every tool block, but finalizing here makes
  // split/stub transports deterministic without weakening malformed JSON.
  for (const [index, raw] of toolJson.entries()) {
    const block = message.content[index];
    if (block?.type !== "tool_use" || block.input !== undefined) continue;
    try {
      block.input = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("Anthropic stream returned malformed tool input JSON.");
    }
  }
  message.content = message.content.filter(Boolean);
  return message;
}

function appendOpenAIAssistantText(conversationInput, response) {
  const hasMessage = (response?.output ?? []).some((item) => item.type === "message" || item.role === "assistant");
  if (hasMessage) {
    for (const item of response.output ?? []) {
      if (item.type === "message" || item.role === "assistant") conversationInput.push(item);
    }
    return;
  }
  const text = extractResponseText(response);
  if (text) conversationInput.push({ role: "assistant", content: text });
}

function appendOpenAIContinue(conversationInput) {
  conversationInput.push(markLiveContextSyntheticTurn({
    role: "user",
    content: [{ type: "input_text", text: SYNTHETIC_CONTINUE }]
  }));
}

function appendAnthropicUserText(convo, text, { synthetic = false } = {}) {
  const last = convo.at(-1);
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text });
  } else if (last?.role === "user" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${text}`;
  } else {
    const message = { role: "user", content: text };
    convo.push(synthetic ? markLiveContextSyntheticTurn(message) : message);
  }
}

export function parseGoalJudgeVerdict(value) {
  const text = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = safeParseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed.satisfied;
  const satisfied = typeof raw === "boolean"
    ? raw
    : typeof raw === "string" && /^(?:yes|true)$/i.test(raw.trim())
      ? true
      : typeof raw === "string" && /^(?:no|false)$/i.test(raw.trim())
        ? false
        : null;
  if (satisfied === null) return null;
  const why = String(parsed.why ?? "No reason supplied.").trim().slice(0, 1000);
  return { satisfied, why: why || "No reason supplied." };
}

function goalJudgePrompt(goal, assistantText) {
  return [
    `Goal: ${goal.objective}`,
    `Goal turn: ${goal.turns}/${goal.maxTurns}`,
    "Latest assistant progress:",
    String(assistantText ?? "").trim().slice(-12000) || "(no visible assistant text)"
  ].join("\n\n");
}

function emitGoalEvent(context, event) {
  try { context?.__onToolEvent?.({ phase: "goal", ...event }); } catch { /* advisory */ }
}

async function evaluateGoalTurn({ provider, context, assistantText, deadline, turnBudget, judge }) {
  const store = context?.runtime?.goals;
  const sessionId = context?.sessionId;
  if (!store || !sessionId) return { handled: false, continue: false, stopReason: "completed" };
  const initial = store.get(sessionId);
  if (!initial || initial.status !== "active") {
    return { handled: false, continue: false, stopReason: "completed" };
  }

  let advanced;
  try {
    advanced = store.incrementTurn(sessionId, initial.revision);
  } catch {
    return { handled: true, continue: false, stopReason: "goal-preempted" };
  }

  let verdict;
  try {
    verdict = await judge(advanced, assistantText, context, deadline, turnBudget);
    if (!verdict) throw new Error("Goal judge returned an invalid verdict.");
  } catch (error) {
    try { store.pause(sessionId, `goal judge error: ${error?.message ?? String(error)}`, advanced.revision); } catch { /* stale state wins */ }
    emitGoalEvent(context, { action: "stopped", reason: "judge-error" });
    return { handled: true, continue: false, stopReason: "goal-judge-error" };
  }

  let judged;
  try {
    store.recordJudge(sessionId, verdict, advanced.revision);
    judged = store.get(sessionId);
  } catch {
    emitGoalEvent(context, { action: "stopped", reason: "preempted" });
    return { handled: true, continue: false, stopReason: "goal-preempted" };
  }

  if (verdict.satisfied) {
    try {
      store.complete(sessionId, verdict.why, judged.revision);
      if (initial.goalId) context.runtime?.tasks?.updateGoal?.(initial.goalId, { status: "completed" });
    } catch {
      return { handled: true, continue: false, stopReason: "goal-preempted" };
    }
    emitGoalEvent(context, { action: "completed", why: verdict.why });
    return { handled: true, continue: false, stopReason: "goal-satisfied" };
  }

  const latest = store.get(sessionId);
  if (!latest || latest.status !== "active" || latest.revision !== judged.revision) {
    emitGoalEvent(context, { action: "stopped", reason: "preempted" });
    return { handled: true, continue: false, stopReason: "goal-preempted" };
  }
  if (latest.turns >= latest.maxTurns) {
    try { store.pause(sessionId, "goal turn budget reached", latest.revision); } catch { /* stale state wins */ }
    emitGoalEvent(context, { action: "stopped", reason: "turn-cap", turns: latest.turns });
    return { handled: true, continue: false, stopReason: "goal-turn-cap" };
  }

  emitGoalEvent(context, { action: "continue", turns: latest.turns, maxTurns: latest.maxTurns, why: verdict.why });
  return { handled: true, continue: true, stopReason: "completed", revision: latest.revision };
}

function pauseGoalForProviderCap(context, expectedRevision) {
  try {
    context?.runtime?.goals?.pause?.(context.sessionId, "provider iteration cap reached", expectedRevision);
  } catch {
    // A real user message or another control action owns the newer state.
  }
}

function goalContinuationIsCurrent(context, expectedRevision) {
  if (expectedRevision === null || expectedRevision === undefined) return true;
  try {
    const current = context?.runtime?.goals?.get?.(context.sessionId);
    return current?.status === "active" && current.revision === expectedRevision;
  } catch {
    return false;
  }
}

function activeGoalRevision(context) {
  try {
    const current = context?.runtime?.goals?.get?.(context.sessionId);
    return current?.status === "active" ? current.revision : null;
  } catch {
    return null;
  }
}

const GOAL_CONTROL_TOOLS = new Set([
  "add_goal",
  "pause_goal",
  "resume_goal",
  "clear_goal"
]);

function revisionAfterGoalControlTool(context, toolName, invocation, previousRevision) {
  if (!GOAL_CONTROL_TOOLS.has(toolName) || !invocation?.ok) return previousRevision;
  const result = invocation.result?.goalMode ?? invocation.result;
  if (Number.isSafeInteger(result?.revision)) return result.revision;
  try {
    const current = context?.runtime?.goals?.get?.(context.sessionId);
    return Number.isSafeInteger(current?.revision) ? current.revision : previousRevision;
  } catch {
    return previousRevision;
  }
}

// Forced-final requests must not contain tool calls without matching results.
// Providers reject that malformed transcript before the model can salvage the
// turn, so synthesize errors only for calls the interrupted batch never closed.
export function reconcileOrphanedToolCalls(conversation, format = "auto") {
  const anthropic = format === "anthropic"
    || (format === "auto" && conversation.some((message) => (
      Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool_use")
    )));

  if (anthropic) {
    const calls = [];
    const completed = new Set();
    for (const message of conversation) {
      if (!Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (block?.type === "tool_use" && block.id) calls.push(block.id);
        if (block?.type === "tool_result" && block.tool_use_id) completed.add(block.tool_use_id);
      }
    }
    const missing = [...new Set(calls)].filter((id) => !completed.has(id));
    if (missing.length > 0) {
      conversation.push({
        role: "user",
        content: missing.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify({ error: "tool aborted: turn ended before completion" }),
          is_error: true
        }))
      });
    }
    return missing.length;
  }

  const calls = [];
  const completed = new Set();
  for (const item of conversation) {
    if (item?.type === "function_call" && item.call_id) calls.push(item.call_id);
    if (item?.type === "function_call_output" && item.call_id) completed.add(item.call_id);
  }
  const missing = [...new Set(calls)].filter((id) => !completed.has(id));
  for (const callId of missing) {
    conversation.push({
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ error: "tool aborted: turn ended before completion" })
    });
  }
  return missing.length;
}

export function capToolOutput(value, { maxChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS, store } = {}) {
  const output = JSON.stringify(value);
  if (typeof output !== "string" || output.length <= maxChars) {
    return { output, ref: null, truncated: false, originalChars: output?.length ?? 0 };
  }

  let ref = null;
  try { ref = (store ?? defaultToolOutputStore()).put(output); } catch { /* preview remains usable */ }
  const target = Math.max(1, Math.trunc(maxChars));
  let retained = Math.max(0, target - 100);
  let marker = "";
  for (let i = 0; i < 3; i += 1) {
    const elided = Math.max(0, output.length - retained);
    marker = `\n[...${elided} chars elided; full output ${ref ? `at ref:${ref}` : "unavailable"}...]\n`;
    retained = Math.max(0, target - marker.length);
  }
  const headChars = Math.ceil(retained / 2);
  const tailChars = Math.floor(retained / 2);
  const preview = `${output.slice(0, headChars)}${marker}${tailChars ? output.slice(-tailChars) : ""}`;
  return {
    output: preview.slice(0, target),
    ref,
    truncated: true,
    originalChars: output.length
  };
}

function transcriptChars(conversation) {
  try { return JSON.stringify(conversation).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

function adjustPairBoundary(conversation, format, boundary) {
  const calls = new Map();
  const results = new Map();
  if (format === "anthropic") {
    conversation.forEach((message, index) => {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === "tool_use" && block.id) calls.set(block.id, index);
        if (block?.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, index);
      }
    });
  } else {
    conversation.forEach((item, index) => {
      if (item?.type === "function_call" && item.call_id) calls.set(item.call_id, index);
      if (item?.type === "function_call_output" && item.call_id) results.set(item.call_id, index);
    });
  }
  for (const [id, callIndex] of calls) {
    const resultIndex = results.get(id);
    if (resultIndex === undefined) continue;
    if ((callIndex < boundary) !== (resultIndex < boundary)) {
      boundary = Math.min(boundary, callIndex, resultIndex);
    }
  }
  return boundary;
}

// Replace only an old, well-formed prefix. Recent hops and the current user
// turn stay byte-for-byte, and paired tool calls/results cross the boundary
// together so compaction can never corrupt the provider transcript.
export function compactConversation(conversation, {
  format = "openai",
  budgetChars = DEFAULT_CONTEXT_COMPACT_CHARS,
  keepRecentHops = DEFAULT_CONTEXT_KEEP_RECENT_HOPS
} = {}) {
  const beforeChars = transcriptChars(conversation);
  if (beforeChars <= budgetChars) return { compacted: false, beforeChars, afterChars: beforeChars };

  reconcileOrphanedToolCalls(conversation, format);
  const keepItems = (keepRecentHops * 2) + 1;
  let boundary = conversation.length - keepItems;
  if (boundary <= 0) return { compacted: false, beforeChars, afterChars: transcriptChars(conversation) };
  boundary = adjustPairBoundary(conversation, format, boundary);
  if (boundary <= 0) return { compacted: false, beforeChars, afterChars: transcriptChars(conversation) };

  const compactedPrefix = conversation.slice(0, boundary);
  const recapLimit = Math.max(500, Math.min(4000, Math.floor(budgetChars * 0.25)));
  const recapText = `[context recap: ${compactedPrefix.length} older transcript items]\n${summarizeText(JSON.stringify(compactedPrefix), recapLimit)}`;
  const recap = { role: "user", content: recapText };
  const candidate = [recap, ...conversation.slice(boundary)];
  const afterChars = transcriptChars(candidate);
  if (afterChars >= transcriptChars(conversation)) {
    return { compacted: false, beforeChars, afterChars: transcriptChars(conversation) };
  }
  conversation.splice(0, conversation.length, ...candidate);
  return { compacted: true, beforeChars, afterChars };
}

function toolOutputStore(context) {
  return context?.__toolOutputStore ?? context?.runtime?.toolOutputs;
}

function modelToolOutput(provider, context, value) {
  return capToolOutput(value, {
    maxChars: provider.maxToolOutputChars,
    store: toolOutputStore(context)
  }).output;
}

export function resolveModelContextWindowTokens(model, { provider = "openai", configured = null } = {}) {
  if (typeof configured === "function") {
    const resolved = Number(configured(model, { provider }));
    if (Number.isFinite(resolved) && resolved > 0) return Math.floor(resolved);
  } else {
    const resolved = Number(configured);
    if (Number.isFinite(resolved) && resolved > 0) return Math.floor(resolved);
  }

  const name = String(model ?? "").toLowerCase();
  // Keep this allowlist narrow: an unknown model returns null and produces an
  // operational override warning instead of silently inventing a denominator.
  if (/^kimi-k3(?:-|$)/.test(name)) return 1_000_000;
  // Kimi Code's k3 defaults to its baseline 256K entitlement;
  // higher plans opt into 1M with OPENAGI_CONTEXT_WINDOW_TOKENS.
  if (["k3", "kimi-for-coding", "kimi-for-coding-highspeed"].includes(name)) return 262_144;
  if (String(provider).toLowerCase() === "anthropic") {
    if (/^claude-(?:sonnet-4-6|sonnet-5|opus-4-[678]|fable-5)(?:-|$)/.test(name)) return 1_000_000;
    if (/^claude-haiku-4-5(?:-|$)/.test(name)) return 200_000;
    if (/^claude-(?:opus|sonnet)-4-(?:[015](?:-|$)|20\d{6}(?:-|$))/.test(name)) return 200_000;
    if (/^claude-3(?:-|$)/.test(name)) return 200_000;
    return null;
  }
  if (/^gpt-5(?:\.[12])?-chat-latest(?:-|$)/.test(name)) return 128_000;
  if (/^gpt-5\.4-(?:mini|nano)(?:-|$)/.test(name)) return 400_000;
  if (/^gpt-5\.(?:4|5|6)(?:-|$)/.test(name)) return 1_050_000;
  if (/^gpt-5(?:\.[12])?(?:-|$)/.test(name)) return 400_000;
  if (/^gpt-4\.1(?:-|$)/.test(name)) return 1_047_576;
  if (/^o[34](?:-|$)/.test(name)) return 200_000;
  if (/^gpt-4o(?:-|$)/.test(name)) return 128_000;
  return null;
}

function cloneProviderValue(value) {
  if (!value || typeof value !== "object") return value;
  const root = Array.isArray(value) ? [] : {};
  const seen = new Map([[value, root]]);
  const pending = [[value, root]];
  while (pending.length > 0) {
    const [source, target] = pending.pop();
    for (const [key, item] of Object.entries(source)) {
      if (!item || typeof item !== "object") {
        target[key] = item;
        continue;
      }
      if (seen.has(item)) {
        target[key] = seen.get(item);
        continue;
      }
      const clone = Array.isArray(item) ? [] : {};
      seen.set(item, clone);
      target[key] = clone;
      pending.push([item, clone]);
    }
  }
  return root;
}

function cloneWithoutCacheControl(value) {
  const cloned = cloneProviderValue(value);
  for (const message of Array.isArray(cloned) ? cloned : []) {
    if (!message || typeof message !== "object") continue;
    delete message.cache_control;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && typeof block === "object") delete block.cache_control;
    }
  }
  return cloned;
}

function cacheableAnthropicBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
  return ["document", "image", "tool_use", "tool_result"].includes(block.type);
}

// Anthropic permits four explicit cache breakpoints. The static system block
// consumes one; rebuild the rolling three-message suffix on a request clone so
// canonical history never accumulates markers between iterations.
export function withAnthropicCacheBreakpoints(messages, { maxMessages = 3 } = {}) {
  const cloned = cloneWithoutCacheControl(Array.isArray(messages) ? messages : []);
  const limit = Math.max(0, Math.min(3, Number.isInteger(maxMessages) ? maxMessages : 3));
  let marked = 0;
  for (let index = cloned.length - 1; index >= 0 && marked < limit; index -= 1) {
    const message = cloned[index];
    if (!message || typeof message !== "object") continue;
    if (typeof message.content === "string") {
      if (!message.content.trim()) continue;
      message.content = [{
        type: "text",
        text: message.content,
        cache_control: { type: "ephemeral" }
      }];
      marked += 1;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (!cacheableAnthropicBlock(block)) continue;
      message.content[blockIndex] = {
        ...block,
        cache_control: { type: "ephemeral" }
      };
      marked += 1;
      break;
    }
  }
  return cloned;
}

function cacheIdentityStore(owner) {
  let store = RUNTIME_CACHE_IDENTITIES.get(owner);
  if (!store) {
    store = new Map();
    RUNTIME_CACHE_IDENTITIES.set(owner, store);
  }
  return store;
}

export function trackPromptCacheIdentity(providerInstance, {
  provider,
  model,
  baseUrl,
  credential,
  context = {}
} = {}) {
  const sessionId = String(context?.sessionId ?? "").trim();
  const runtimeOwner = context?.runtime && typeof context.runtime === "object"
    ? context.runtime
    : providerInstance;
  if (!sessionId || !runtimeOwner || typeof runtimeOwner !== "object") return false;

  const credentialFingerprint = createHash("sha256")
    .update(String(credential ?? ""))
    .digest("hex");
  const identity = JSON.stringify([
    String(provider ?? ""),
    String(baseUrl ?? ""),
    String(model ?? ""),
    credentialFingerprint
  ]);
  const store = cacheIdentityStore(runtimeOwner);
  const previous = store.get(sessionId);
  store.delete(sessionId);
  store.set(sessionId, identity);
  while (store.size > MAX_CACHE_IDENTITY_SESSIONS) {
    store.delete(store.keys().next().value);
  }
  if (previous == null || previous === identity) return false;
  try {
    providerInstance?.cacheWarningLog?.(
      "[model-cache] Prompt cache identity changed mid-session; a provider, model, endpoint, or credential swap makes the next request full-price."
    );
  } catch {
    // Cache warnings are operational only and never enter model context.
  }
  return true;
}

function estimateProviderConversationTokens(providerInstance, conversation, {
  format,
  instructions,
  tools,
  model
}) {
  const requestMessages = format === "anthropic"
    ? withAnthropicCacheBreakpoints(conversation)
    : conversation;
  const request = format === "anthropic"
    ? {
        model,
        max_tokens: providerInstance.maxTokens,
        system: instructions,
        messages: requestMessages,
        stream: true,
        ...(tools.length > 0 ? { tools } : {})
      }
    : {
        model,
        instructions,
        input: requestMessages,
        ...(tools.length > 0 ? { tools } : {})
      };
  return estimateContextTokens(request, {
    charsPerToken: providerInstance.contextEstimateCharsPerToken
  });
}

function warnUnknownContextWindow(providerInstance, model) {
  const key = String(model ?? "unknown");
  if (UNKNOWN_CONTEXT_WINDOW_WARNINGS.has(key)) return;
  UNKNOWN_CONTEXT_WINDOW_WARNINGS.add(key);
  try {
    providerInstance.cacheWarningLog?.(
      `[context-window] No verified context size for model "${key}". Set OPENAGI_CONTEXT_WINDOW_TOKENS; automatic 50%/85% compression is disabled.`
    );
  } catch {
    // Operational warnings never enter the prompt or block a request.
  }
}

function emitContextCompression(context, event) {
  try {
    const pending = context?.__onToolEvent?.({ phase: "context-compression", ...event });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    // Compression telemetry is advisory and never enters the prompt.
  }
}

async function prepareProviderConversation(providerInstance, conversation, {
  format,
  instructions,
  tools,
  model,
  usage = null,
  context = {}
}) {
  const contextWindowTokens = resolveModelContextWindowTokens(model, {
    provider: format,
    configured: providerInstance.contextWindowTokens
  });
  if (!contextWindowTokens) {
    warnUnknownContextWindow(providerInstance, model);
    return {
      triggered: false,
      reason: null,
      compressed: false,
      requestAllowed: true,
      contextWindowTokens: null
    };
  }

  const actualInputTokens = contextInputTokens(usage, { provider: format });
  const estimate = (candidate) => estimateProviderConversationTokens(providerInstance, candidate, {
    format,
    instructions,
    tools,
    model
  });
  const estimatedInputTokens = estimate(conversation);
  const trigger = contextCompressionTrigger({
    actualInputTokens,
    estimatedInputTokens,
    contextWindowTokens
  });
  if (!trigger.triggered) {
    return {
      ...trigger,
      compressed: false,
      requestAllowed: true,
      estimatedInputTokens,
      postCompressionEstimatedTokens: estimatedInputTokens
    };
  }

  const safeTokenLimit = Math.max(0, Math.ceil(contextWindowTokens * CONTEXT_GATEWAY_RATIO) - 1);
  const charsPerToken = providerInstance.contextEstimateCharsPerToken;
  const sourceDigestChars = Math.max(MIN_CONTEXT_DIGEST_CHARS, providerInstance.contextDigestChars);
  const tryCompression = async (maxDigestChars) => {
    const result = await compressLiveContext(conversation, {
      format,
      keepRecentHops: providerInstance.contextKeepRecentHops,
      maxDigestChars
    });
    return {
      result,
      estimatedTokens: result.compressed ? estimate(result.conversation) : estimatedInputTokens
    };
  };

  let attempt = await tryCompression(sourceDigestChars);
  if (attempt.result.compressed && attempt.estimatedTokens > safeTokenLimit) {
    const excessChars = (attempt.estimatedTokens - safeTokenLimit) * charsPerToken;
    const attemptedDigestChars = Math.max(
      MIN_CONTEXT_DIGEST_CHARS,
      String(attempt.result.marker ?? "").length
    );
    const reducedDigestChars = Math.max(
      MIN_CONTEXT_DIGEST_CHARS,
      Math.floor(attemptedDigestChars - excessChars)
    );
    if (reducedDigestChars < attemptedDigestChars && reducedDigestChars > MIN_CONTEXT_DIGEST_CHARS) {
      attempt = await tryCompression(reducedDigestChars);
    }
  }
  if ((!attempt.result.compressed || attempt.estimatedTokens > safeTokenLimit)
    && sourceDigestChars > MIN_CONTEXT_DIGEST_CHARS) {
    attempt = await tryCompression(MIN_CONTEXT_DIGEST_CHARS);
  }

  if (!attempt.result.compressed || attempt.estimatedTokens > safeTokenLimit) {
    const requestAllowed = estimatedInputTokens <= safeTokenLimit;
    if (!requestAllowed) {
      emitContextCompression(context, {
        reason: trigger.reason,
        blocked: true,
        estimatedInputTokens: attempt.estimatedTokens,
        thresholdTokens: safeTokenLimit + 1
      });
    }
    return {
      ...trigger,
      ...attempt.result,
      requestAllowed,
      estimatedInputTokens,
      postCompressionEstimatedTokens: attempt.estimatedTokens
    };
  }

  conversation.splice(0, conversation.length, ...attempt.result.conversation);
  emitContextCompression(context, {
    reason: trigger.reason,
    summarizedItems: attempt.result.summarizedItems,
    keptItems: attempt.result.keptItems,
    estimatedInputTokens: attempt.estimatedTokens,
    thresholdTokens: safeTokenLimit + 1
  });
  return {
    ...trigger,
    ...attempt.result,
    requestAllowed: true,
    estimatedInputTokens,
    postCompressionEstimatedTokens: attempt.estimatedTokens
  };
}

// The system prompt appended to the final "force an answer" call when a turn is
// cut short. Tells the model to stop, not call tools, and answer from work so
// far — the reason tunes the guidance so the reply names the right knob.
function forceAnswerPrompt(reason, iterations, maxIterations) {
  const base = "[system] Stop here and answer the user now. Do NOT call any tools. Using the conversation and any tool results above, give the best complete answer you can with what you have.";
  if (reason === "iteration-cap") {
    return `${base} The turn reached its iteration limit after ${iterations}/${maxIterations} steps; if work remains, say briefly what's left and note OPENAGI_MAX_ITERATIONS can be raised.`;
  }
  if (reason === "stalled") {
    return `${base} The previous step went quiet for too long; summarise progress and give your best current answer.`;
  }
  if (reason === "request-timeout") {
    return `${base} The previous step took too long; summarise progress and give your best current answer (OPENAGI_REQUEST_TIMEOUT_MS can be raised for longer steps).`;
  }
  if (reason === "provider-error") {
    return `${base} The provider stayed unavailable after bounded retries; summarise completed work and give your best current answer.`;
  }
  // turn-timeout
  return `${base} The overall time budget is nearly spent; be concise and note OPENAGI_MAX_TURN_SECONDS can be raised.`;
}

function localPartialSummary({ reason, iterations, maxIterations, toolCalls, lastText }) {
  const completed = toolCalls.length;
  const recent = toolCalls.slice(-5).map((call) => call.name).join(", ");
  const detail = completed > 0
    ? `${completed} tool call${completed === 1 ? "" : "s"} completed${recent ? ` (most recent: ${recent})` : ""}.`
    : "No tool calls completed.";
  const prior = lastText ? `\n\nPartial model output:\n${lastText.slice(0, 1500)}` : "";
  if (reason === "turn-timeout") {
    return `Turn stopped gracefully after ${iterations} iteration${iterations === 1 ? "" : "s"} because the wall-clock guard was reached. ${detail} Raise OPENAGI_MAX_TURN_SECONDS if this task needs more time.${prior}`;
  }
  if (reason === "stalled") {
    return `Turn stopped after ${iterations} iteration${iterations === 1 ? "" : "s"} because the model went silent (no output for the stall window) and could not be revived. ${detail} This usually means a transient provider hiccup — retry the request. OPENAGI_STALL_TIMEOUT_MS tunes how long silence is tolerated.${prior}`;
  }
  if (reason === "request-timeout") {
    return `Turn stopped after ${iterations} iteration${iterations === 1 ? "" : "s"} because a single model request exceeded the per-request timeout (the model took too long on one step). ${detail} Raise OPENAGI_REQUEST_TIMEOUT_MS, or break the task into smaller asks.${prior}`;
  }
  if (reason === "budget-cap") {
    return `Turn stopped gracefully after ${iterations} iteration${iterations === 1 ? "" : "s"} because a budget cap was reached. ${detail} Raise OPENAGI_MAX_TURN_USD for a larger per-turn budget, or OPENAGI_DAILY_USD_LIMIT for the daily budget.${prior}`;
  }
  if (reason === "provider-error") {
    return `Turn stopped gracefully after ${iterations} iteration${iterations === 1 ? "" : "s"} because the model provider remained unavailable after bounded retries. ${detail} Retry the turn when the provider recovers.${prior}`;
  }
  if (reason === "context-too-large") {
    return `Turn stopped before sending an oversized model request because the recent verbatim context could not fit below the safety threshold. ${detail} Start a fresh session, reduce large attachments or tool outputs, or set OPENAGI_CONTEXT_WINDOW_TOKENS to the provider's verified limit.${prior}`;
  }
  return `Turn reached the iteration cap after ${iterations}/${maxIterations} iterations. ${detail} Raise OPENAGI_MAX_ITERATIONS if this task needs more steps.${prior}`;
}

export class DeterministicModelProvider {
  constructor(options = {}) {
    this.name = options.name ?? "deterministic";
  }

  isConfigured() {
    return true;
  }

  async generate({ input, scrutiny, memoryHits = [], agent, messages = [], tools = [], toolRegistry, context = {} }) {
    const text = String(input ?? "").trim();
    const lower = text.toLowerCase();
    const lines = [];

    if (/^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(lower)) {
      lines.push(`Hey — I'm ${agent?.name ?? "OpenAGI"}, running locally. I can remember things, recall them later, schedule prompts, and call MCP tools when configured.`);
    } else if (/\bremember\b|\bsave (this|that)\b|\bdon't forget\b/.test(lower)) {
      const result = await maybeInvoke(toolRegistry, "remember", { content: text, importance: "normal" }, context);
      if (result?.ok) {
        lines.push(`Saved to memory (tier: ${result.result.tier}).`);
      } else {
        lines.push(`I'd save this to memory but the remember tool isn't available right now.`);
      }
    } else if (/\bremind me\b|\bevery (day|monday|week)\b|\bschedule\b|\bdaily\b/.test(lower)) {
      lines.push(`I detected a scheduling request, but without an OPENAI_API_KEY I can't parse the time precisely. Try POST /cron with a {prompt, delaySeconds | intervalSeconds | dailyAt} body, or set OPENAI_API_KEY to let the agent schedule it for you.`);
    } else if (/\bwhat (was|did) (i|you)\b|\blast message\b|\bprevious\b/.test(lower)) {
      const previous = messages.filter((m) => m.role === "user").slice(-2, -1)[0];
      lines.push(previous ? `Your previous message was: "${previous.content}"` : `I don't see a previous message in this session.`);
    } else {
      lines.push(`Heard: "${text}".`);
    }

    if (memoryHits.length > 0) {
      const top = memoryHits.slice(0, 3).map(({ item, score }) => `- [${item.tier} · ${score.toFixed(2)}] ${truncate(item.content, 160)}`).join("\n");
      lines.push(`\nRelated from memory:\n${top}`);
    }

    if (!process.env.OPENAI_API_KEY) {
      lines.push(`\n(Running without OPENAI_API_KEY — set it in .openagi/.env to enable real reasoning and tool use.)`);
    }

    return {
      provider: this.name,
      model: "deterministic",
      text: lines.join("\n"),
      toolCalls: []
    };
  }
}

function resolveRequestTimeoutMs(options) {
  // Per-request (single model hop) timeout. A slow reasoning model on an
  // open-ended task can legitimately exceed the old hard-coded 120s; make it
  // configurable and default higher so a heavy first hop no longer aborts the
  // whole turn. The whole-turn wall-clock guard (OPENAGI_MAX_TURN_SECONDS,
  // default 900s) remains the real ceiling.
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  return positiveInteger(process.env.OPENAGI_REQUEST_TIMEOUT_MS, 300000);
}

export class OpenAIResponsesProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5";
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.timeoutMs = resolveRequestTimeoutMs(options);
    applyIterationSettings(this, options);
    this.budgetGuard = options.budgetGuard ?? null;
    // Per-task model tiering. Defaults to base for everything until tier env
    // vars are set, so this is a no-op until the user opts in.
    this.ownsRouter = !options.router;
    this.router = options.router ?? new ModelRouter({ envPrefix: "OPENAI", baseModel: this.model });
    configureProviderCredentialPool(this, options, {
      providerName: "openai",
      envSecretName: "OPENAI_API_KEY"
    });
  }

  isConfigured() {
    return providerHasCredentials(this);
  }

  // Resolve which model a call should use: explicit `model` wins, then a named
  // `task` (routed via the configured tiers), then a raw `tier`, else the base.
  resolveModel({ model, tier, task } = {}) {
    if (model) return model;
    if (this.ownsRouter && this.router && "baseModel" in this.router) this.router.baseModel = this.model;
    if (task) return this.router.resolve(task);
    if (tier) return this.router.tierModel(tier);
    return this.model;
  }

  async judgeGoal(goal, assistantText, context, deadline, turnBudget, credentialRequest = null) {
    checkRequestBudget(this, turnBudget);
    const response = await withinTurn(this, deadline, (remainingMs) => this.postResponses({
      model: this.resolveModel({ task: "goal" }),
      max_output_tokens: GOAL_JUDGE_MAX_TOKENS,
      instructions: GOAL_JUDGE_INSTRUCTIONS,
      input: [{ role: "user", content: goalJudgePrompt(goal, assistantText) }]
    }, context, { timeoutMs: remainingMs, turnBudget, credentialRequest }), context);
    const verdict = parseGoalJudgeVerdict(extractResponseText(response));
    if (!verdict) throw new Error("Goal judge returned invalid JSON.");
    return verdict;
  }

  async generate({ input, instructions, sessionMemorySnapshot, turnContext, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {}, model: modelOverride, tier, task, images = [], maxIterations: maxIterationsOverride, maxTurnSeconds: maxTurnSecondsOverride }) {
    const generationRequest = arguments[0] ?? {};
    const model = this.resolveModel({ model: modelOverride, tier, task });
    if (!this.isConfigured()) throw new Error("OPENAI_API_KEY is not configured.");
    const maxIterations = positiveInteger(maxIterationsOverride, this.maxIterations);
    const maxTurnSeconds = positiveNumber(maxTurnSecondsOverride, this.maxTurnSeconds);
    let credentialState;
    try {
      credentialState = initialCredentialState(this, { model, context });
    } catch (error) {
      const fallback = await tryFallbackProvider(this, generationRequest, error);
      if (fallback.used) return fallback.result;
      if (!isCredentialPoolExhausted(error)) throw error;
      return {
        provider: "openai",
        model,
        text: localPartialSummary({
          reason: "provider-error",
          iterations: 0,
          maxIterations,
          toolCalls: [],
          lastText: ""
        }),
        toolCalls: [],
        iterations: 0,
        maxIterations,
        stopReason: "provider-error"
      };
    }

    // Stateless tool loop — accumulates the full conversation in `input` each
    // hop instead of chaining via `previous_response_id`. Required for orgs
    // with Zero Data Retention enabled (which reject previous_response_id).
    // Per-turn context (memory hits, scrutiny) rides the latest user turn so
    // `instructions` stays byte-stable across turns (mirrors the Anthropic
    // path; no cache markers here — OpenAI caching is implicit).
    const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
    // Inbound images (e.g. Discord attachments) ride the CURRENT user turn as
    // real input_image blocks so the model can actually see them. Text-only
    // turns keep the plain-string content (byte-stable, cache-friendly).
    const finalText = contextBlock ? `${contextBlock}\n\n${input}` : input;
    const finalUserTurn = Array.isArray(images) && images.length > 0
      ? {
          role: "user",
          content: [
            { type: "input_text", text: finalText },
            ...images.map((im) => ({ type: "input_image", image_url: `data:${im.mediaType};base64,${im.data}` }))
          ]
        }
      : { role: "user", content: finalText };
    const conversationInput = [
      ...messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      })),
      finalUserTurn
    ];

    const baseInstructions = appendSessionMemorySnapshot(
      instructions ?? buildDefaultInstructions({ agent }),
      sessionMemorySnapshot
    );
    const toolList = tools.length > 0
      ? tools
      : Array.isArray(context.__advertisedTools)
        ? []
        : toolRegistry?.toOpenAITools?.() ?? [];
    const toolCalls = [];

    const deadline = this.now() + (maxTurnSeconds * 1000);
    const turnBudget = { limitUsd: this.maxTurnUsd, spentUsd: 0 };
    let response;
    let iterations = 0;
    let stopReason = "completed";
    let lastText = "";
    let previousUsage = null;
    let goalContinuationRevision = activeGoalRevision(context);
    let successfulModelHops = 0;

    iterationLoop: while (iterations < maxIterations) {
      if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
        stopReason = "goal-preempted";
        break;
      }
      if (this.now() >= deadline) {
        stopReason = "turn-timeout";
        break;
      }
      // Iterations can span many paid requests. Re-check immediately before
      // each one so a cap reached by an earlier hop cannot be bypassed.
      try {
        checkRequestBudget(this, turnBudget);
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopReason = "budget-cap";
        break;
      }
      iterations += 1;
      emitIteration(context, iterations, maxIterations);
      const preparation = await prepareProviderConversation(this, conversationInput, {
        format: "openai",
        instructions: baseInstructions,
        tools: toolList,
        model,
        usage: previousUsage,
        context
      });
      previousUsage = null;
      if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
        stopReason = "goal-preempted";
        break;
      }
      if (!preparation.requestAllowed) {
        stopReason = "context-too-large";
        break;
      }
      const body = {
        model,
        instructions: baseInstructions,
        input: conversationInput
      };
      if (toolList.length > 0) body.tools = toolList;

      try {
        response = await withinTurn(this, deadline, (remainingMs) => (
          this.postResponses(body, context, {
            timeoutMs: remainingMs,
            turnBudget,
            credentialRequest: credentialState.request
          })
        ), context);
      } catch (error) {
        if (isCredentialPoolExhausted(error) && successfulModelHops === 0 && toolCalls.length === 0) {
          const fallback = await tryFallbackProvider(this, generationRequest, error);
          if (fallback.used) return fallback.result;
        }
        if (isCredentialPoolExhausted(error)) {
          stopReason = "provider-error";
          break;
        }
        if (requestTimedOut(error)) { stopReason = error instanceof ModelStallError ? "stalled" : "request-timeout"; break; }
        if (providerUnavailable(error)) { stopReason = "provider-error"; break; }
        if (!deadlineExpired(this, deadline, error)) throw error;
        stopReason = "turn-timeout";
        break;
      }

      successfulModelHops += 1;
      previousUsage = response?.usage ?? null;
      const calls = extractFunctionCalls(response);
      const responseText = extractResponseText(response);
      if (responseText) lastText = responseText;
      const wantsContinuation = openAIWantsContinuation(response, calls);
      if (!wantsContinuation) {
        const goalDecision = await evaluateGoalTurn({
          provider: this,
          context,
          assistantText: responseText,
          deadline,
          turnBudget,
          judge: (goal, text, judgeContext, judgeDeadline, judgeBudget) => (
            this.judgeGoal(
              goal,
              text,
              judgeContext,
              judgeDeadline,
              judgeBudget,
              credentialState.request
            )
          )
        });
        if (!goalDecision.continue) {
          stopReason = goalDecision.stopReason;
          break;
        }
        if (iterations >= maxIterations) {
          pauseGoalForProviderCap(context, goalDecision.revision);
          stopReason = "iteration-cap";
          break;
        }
        goalContinuationRevision = goalDecision.revision;
        appendOpenAIAssistantText(conversationInput, response);
        appendOpenAIContinue(conversationInput);
        continue;
      }

      // Preserve any partial assistant prose before asking the model to resume.
      // This matters for Responses API `incomplete` results with no tool call.
      appendOpenAIAssistantText(conversationInput, response);

      // Append the assistant's function_call items so the model can see its own
      // last turn on the next hop (replaces what previous_response_id would've done).
      for (const item of response.output ?? []) {
        if (item.type === "function_call") {
          conversationInput.push({
            type: "function_call",
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments
          });
        }
      }

      for (const call of calls) {
        if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
          stopReason = "goal-preempted";
          break iterationLoop;
        }
        const parsedArgs = safeParseJson(call.arguments) ?? {};
        let invocation;
        try {
          invocation = await withinTurn(this, deadline, () => (
            toolRegistry?.invoke?.(call.name, parsedArgs, context)
              ?? Promise.resolve({ ok: false, error: "no toolRegistry" })
          ), context);
        } catch (error) {
          if (requestTimedOut(error)) { stopReason = "request-timeout"; break iterationLoop; }
          if (!deadlineExpired(this, deadline, error)) throw error;
          stopReason = "turn-timeout";
          break iterationLoop;
        }
        goalContinuationRevision = revisionAfterGoalControlTool(
          context,
          call.name,
          invocation,
          goalContinuationRevision
        );
        toolCalls.push({ name: call.name, arguments: parsedArgs, result: invocation });
        const result = invocation.ok ? invocation.result : { error: invocation.error };
        // A tool that returns a screenshot (computer_screenshot) carries the PNG
        // as base64. function_call_output is text-only, so the model can't see
        // it there — strip the bytes from the JSON output and re-attach them as
        // a real input_image in a following user turn so the model can ground on it.
        const image = invocation.ok && result && typeof result === "object" && result.image && result.format ? result : null;
        if (image) {
          const { image: bytes, ...meta } = result;
          conversationInput.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: modelToolOutput(this, context, { ...meta, image: "[attached as image below]" })
          });
          conversationInput.push({
            role: "user",
            content: [
              { type: "input_text", text: `Screenshot (${meta.width}×${meta.height}, click coordinates are in this image's space):` },
              { type: "input_image", image_url: `data:image/${image.format};base64,${bytes}` }
            ]
          });
        } else {
          conversationInput.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: modelToolOutput(this, context, result)
          });
        }
      }

      if (iterations >= maxIterations) {
        stopReason = "iteration-cap";
        break;
      }

      // The old hop ceiling becomes an internal request boundary. A synthetic
      // user turn gives the model the Hermes-style nudge while retaining every
      // prior response and tool result in this same outer turn.
      if (calls.length === 0 || iterations % this.maxRequestHops === 0) {
        appendOpenAIContinue(conversationInput);
      }
    }

    let text;
    // Force a real answer whenever the turn was cut short (see the Anthropic
    // path for the rationale). No tools, fresh short budget, so the model
    // always gets a chance to reply instead of returning only a canned string.
    const FORCE_ANSWER_REASONS = new Set(["iteration-cap", "stalled", "request-timeout", "turn-timeout", "provider-error"]);
    if (FORCE_ANSWER_REASONS.has(stopReason)) {
      reconcileOrphanedToolCalls(conversationInput, "openai");
      appendOpenAIContinue(conversationInput);
      conversationInput.at(-1).content[0].text = forceAnswerPrompt(stopReason, iterations, maxIterations);
      try {
        checkRequestBudget(this, turnBudget);
        const preparation = await prepareProviderConversation(this, conversationInput, {
          format: "openai",
          instructions: baseInstructions,
          tools: [],
          model,
          usage: previousUsage,
          context
        });
        previousUsage = null;
        if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
          stopReason = "goal-preempted";
        } else if (!preparation.requestAllowed) {
          stopReason = "context-too-large";
        } else {
          response = await this.postResponses({
            model,
            instructions: baseInstructions,
            input: conversationInput
          }, context, {
            timeoutMs: this.forceAnswerMs,
            turnBudget,
            credentialRequest: credentialState.request
          });
          const forced = extractResponseText(response);
          if (forced) text = forced;
        }
      } catch (error) {
        // Best-effort: if the forced answer also fails, fall through to the
        // canned summary below — never rethrow and lose the turn.
        if (!budgetExceeded(error) && !requestTimedOut(error) && !providerUnavailable(error) && !deadlineExpired(this, deadline, error)) throw error;
      }
    }

    if (!text && (stopReason === "turn-timeout" || stopReason === "budget-cap" || stopReason === "request-timeout" || stopReason === "stalled" || stopReason === "provider-error" || stopReason === "context-too-large")) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (stopReason === "iteration-cap" && !text) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (text === undefined) {
      text = extractResponseText(response) || "(no text)";
    }

    return {
      provider: "openai",
      model,
      id: response?.id,
      text,
      toolCalls,
      iterations,
      maxIterations,
      stopReason
    };
  }

  async postResponses(body, context = {}, options = {}) {
    const controller = new AbortController();
    const externalSignal = context?.__abortSignal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const requestedTimeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
    const deadlineLimited = options.timeoutMs !== undefined && requestedTimeoutMs <= this.timeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, requestedTimeoutMs));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await requestWithProviderCredential(
        this,
        options.credentialRequest,
        {
          context,
          signal: controller.signal,
          model: body.model,
          request: (credential) => fetch(`${this.baseUrl}/responses`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${credential}`
            },
            body: JSON.stringify(body)
          })
        }
      );
      const json = await response.json().catch(() => ({}));
      const callTools = (json.output ?? []).filter((item) => item.type === "function_call").map((item) => item.name);
      const budgetRecord = this.budgetGuard?.record(json.usage, body.model, {
        channel: context.channel,
        agentId: context.agentId,
        sessionId: context.sessionId,
        from: context.from,
        tools: callTools
      });
      if (options.turnBudget) recordTurnSpend(options.turnBudget, budgetRecord);
      return json;
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      // The outer deadline and fetch abort timers race. Normalize the fetch
      // winner so deadline expiry still returns a partial summary, while a
      // provider's ordinary shorter request timeout keeps its old error path.
      if (deadlineLimited && error?.name === "AbortError") throw new TurnDeadlineError();
      // Our own per-request timer fired (not the caller's abort): convert the
      // raw undici "This operation was aborted" into a typed RequestTimeoutError
      // so the turn loop can stop gracefully instead of dying with a raw string.
      if (timedOut && error?.name === "AbortError") throw new RequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export class AnthropicProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    this.baseUrl = options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
    this.version = options.version ?? "2023-06-01";
    this.maxTokens = options.maxTokens ?? (Number(process.env.OPENAGI_MAX_TOKENS) || 8192);
    this.timeoutMs = resolveRequestTimeoutMs(options);
    applyIterationSettings(this, options);
    this.budgetGuard = options.budgetGuard ?? null;
    this.ownsRouter = !options.router;
    this.router = options.router ?? new ModelRouter({ envPrefix: "ANTHROPIC", baseModel: this.model });
    configureProviderCredentialPool(this, options, {
      providerName: "anthropic",
      envSecretName: "ANTHROPIC_API_KEY"
    });
  }

  isConfigured() {
    return providerHasCredentials(this);
  }

  resolveModel({ model, tier, task } = {}) {
    if (model) return model;
    if (this.ownsRouter && this.router && "baseModel" in this.router) this.router.baseModel = this.model;
    if (task) return this.router.resolve(task);
    if (tier) return this.router.tierModel(tier);
    return this.model;
  }

  async judgeGoal(goal, assistantText, context, deadline, turnBudget, credentialRequest = null) {
    checkRequestBudget(this, turnBudget);
    const response = await withinTurn(this, deadline, (remainingMs) => this.postMessages({
      model: this.resolveModel({ task: "goal" }),
      max_tokens: GOAL_JUDGE_MAX_TOKENS,
      system: GOAL_JUDGE_INSTRUCTIONS,
      messages: [{ role: "user", content: goalJudgePrompt(goal, assistantText) }]
    }, context, { timeoutMs: remainingMs, turnBudget, credentialRequest }), context);
    const verdict = parseGoalJudgeVerdict(extractAnthropicText(response));
    if (!verdict) throw new Error("Goal judge returned invalid JSON.");
    return verdict;
  }

  async generate({ input, instructions, sessionMemorySnapshot, turnContext, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {}, model: modelOverride, tier, task, images = [], maxIterations: maxIterationsOverride, maxTurnSeconds: maxTurnSecondsOverride, onDelta }) {
    const generationRequest = arguments[0] ?? {};
    if (!this.isConfigured()) throw new Error("ANTHROPIC_API_KEY is not configured.");
    const model = this.resolveModel({ model: modelOverride, tier, task });
    const maxIterations = positiveInteger(maxIterationsOverride, this.maxIterations);
    const maxTurnSeconds = positiveNumber(maxTurnSecondsOverride, this.maxTurnSeconds);
    let credentialState;
    try {
      credentialState = initialCredentialState(this, { model, context });
    } catch (error) {
      const fallback = await tryFallbackProvider(this, generationRequest, error);
      if (fallback.used) return fallback.result;
      if (!isCredentialPoolExhausted(error)) throw error;
      return {
        provider: "anthropic",
        model,
        text: localPartialSummary({
          reason: "provider-error",
          iterations: 0,
          maxIterations,
          toolCalls: [],
          lastText: ""
        }),
        toolCalls: [],
        iterations: 0,
        maxIterations,
        stopReason: "provider-error"
      };
    }

    const advertisedTools = Array.isArray(context.__advertisedTools) ? context.__advertisedTools : null;
    const allowedTools = Array.isArray(context.__allowedTools) ? context.__allowedTools : null;
    const scopedTools = advertisedTools && allowedTools
      ? advertisedTools.filter((name) => allowedTools.includes(name))
      : advertisedTools ?? allowedTools;
    const suppressTools = context.__scrutinyPolicy === "none" && advertisedTools === null;
    let tools = suppressTools
      ? []
      : scopedTools
      ? (toolRegistry?.toAnthropicTools?.({
          only: scopedTools,
          readOnly: context.__scrutinyPolicy === "read-only"
        }) ?? [])
      : (toolRegistry?.toAnthropicTools?.({ readOnly: context.__scrutinyPolicy === "read-only" }) ?? []);
    if (resolveToolSearchMode(toolRegistry?.toolSearchController?.env ?? process.env) === "off") {
      const bridgeNames = new Set(TOOL_SEARCH_BRIDGE_NAMES);
      tools = tools.filter((tool) => !bridgeNames.has(tool.name));
    }
    // The system block is STATIC (persona + standing instructions) so this
    // cache_control prefix is byte-identical every turn and actually hits.
    // Per-turn context (memory hits, scrutiny) rides the latest user turn.
    const system = [
      {
        type: "text",
        text: appendSessionMemorySnapshot(
          instructions ?? buildDefaultInstructions({ agent }),
          sessionMemorySnapshot
        ),
        cache_control: { type: "ephemeral" }
      }
    ];

    const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
    // Inbound images (Discord attachments) attach to the CURRENT user turn as
    // Anthropic image blocks (base64 source) so a vision model can see them.
    const finalText = contextBlock ? `${contextBlock}\n\n${input}` : input;
    const finalUserContent = Array.isArray(images) && images.length > 0
      ? [
          { type: "text", text: finalText },
          ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }))
        ]
      : finalText;
    const convo = [
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      })),
      { role: "user", content: finalUserContent }
    ];

    const toolCalls = [];
    const deadline = this.now() + (maxTurnSeconds * 1000);
    const turnBudget = { limitUsd: this.maxTurnUsd, spentUsd: 0 };
    let response;
    let iterations = 0;
    let stopReason = "completed";
    let lastText = "";
    let previousUsage = null;
    let goalContinuationRevision = activeGoalRevision(context);
    let successfulModelHops = 0;

    iterationLoop: while (iterations < maxIterations) {
      if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
        stopReason = "goal-preempted";
        break;
      }
      if (this.now() >= deadline) {
        stopReason = "turn-timeout";
        break;
      }
      try {
        checkRequestBudget(this, turnBudget);
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopReason = "budget-cap";
        break;
      }
      iterations += 1;
      emitIteration(context, iterations, maxIterations);
      const preparation = await prepareProviderConversation(this, convo, {
        format: "anthropic",
        instructions: system,
        tools,
        model,
        usage: previousUsage,
        context
      });
      previousUsage = null;
      if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
        stopReason = "goal-preempted";
        break;
      }
      if (!preparation.requestAllowed) {
        stopReason = "context-too-large";
        break;
      }
      // Stream internally whenever stall detection is enabled, even if we're not
      // surfacing deltas to the user (onDelta): the token stream is the "is the
      // model still trying?" signal the stall watchdog needs. A slow-but-alive
      // model keeps the turn open; only true silence trips the guard.
      const wantStream = typeof onDelta === "function" || this.stallTimeoutMs > 0;
      try {
        response = await withinTurn(this, deadline, (remainingMs) => this.postMessages({
          model,
          max_tokens: this.maxTokens,
          system,
          messages: withAnthropicCacheBreakpoints(convo),
          ...(wantStream ? { stream: true } : {}),
          ...(tools.length > 0 ? { tools } : {})
        }, context, {
          timeoutMs: remainingMs,
          turnBudget,
          onDelta,
          credentialRequest: credentialState.request
        }), context);
      } catch (error) {
        if (isCredentialPoolExhausted(error) && successfulModelHops === 0 && toolCalls.length === 0) {
          const fallback = await tryFallbackProvider(this, generationRequest, error);
          if (fallback.used) return fallback.result;
        }
        if (isCredentialPoolExhausted(error)) {
          stopReason = "provider-error";
          break;
        }
        if (requestTimedOut(error)) { stopReason = error instanceof ModelStallError ? "stalled" : "request-timeout"; break; }
        if (providerUnavailable(error)) { stopReason = "provider-error"; break; }
        if (!deadlineExpired(this, deadline, error)) throw error;
        stopReason = "turn-timeout";
        break;
      }

      successfulModelHops += 1;
      previousUsage = response?.usage ?? null;
      convo.push({ role: "assistant", content: response.content ?? [] });

      const toolUses = (response.content ?? []).filter((c) => c.type === "tool_use");
      const responseText = extractAnthropicText(response);
      if (responseText) lastText = responseText;
      const wantsContinuation = anthropicWantsContinuation(response, toolUses);
      if (!wantsContinuation) {
        const goalDecision = await evaluateGoalTurn({
          provider: this,
          context,
          assistantText: responseText,
          deadline,
          turnBudget,
          judge: (goal, text, judgeContext, judgeDeadline, judgeBudget) => (
            this.judgeGoal(
              goal,
              text,
              judgeContext,
              judgeDeadline,
              judgeBudget,
              credentialState.request
            )
          )
        });
        if (!goalDecision.continue) {
          stopReason = goalDecision.stopReason;
          break;
        }
        if (iterations >= maxIterations) {
          pauseGoalForProviderCap(context, goalDecision.revision);
          stopReason = "iteration-cap";
          break;
        }
        goalContinuationRevision = goalDecision.revision;
        appendAnthropicUserText(convo, SYNTHETIC_CONTINUE, { synthetic: true });
        continue;
      }

      const toolResults = [];
      // Keep completed results attached even if a later call in this same
      // batch hits the deadline. Reconciliation can then mark only the calls
      // that truly never ran instead of discarding successful tool work.
      if (toolUses.length > 0) convo.push({ role: "user", content: toolResults });
      for (const use of toolUses) {
        if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
          stopReason = "goal-preempted";
          break iterationLoop;
        }
        let invocation;
        try {
          invocation = await withinTurn(this, deadline, () => (
            toolRegistry?.invoke?.(use.name, use.input ?? {}, context)
              ?? Promise.resolve({ ok: false, error: "no toolRegistry" })
          ), context);
        } catch (error) {
          if (requestTimedOut(error)) { stopReason = "request-timeout"; break iterationLoop; }
          if (!deadlineExpired(this, deadline, error)) throw error;
          stopReason = "turn-timeout";
          break iterationLoop;
        }
        goalContinuationRevision = revisionAfterGoalControlTool(
          context,
          use.name,
          invocation,
          goalContinuationRevision
        );
        toolCalls.push({ name: use.name, arguments: use.input, result: invocation });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: modelToolOutput(this, context, invocation.ok ? invocation.result : { error: invocation.error }),
          is_error: !invocation.ok
        });
      }
      if (iterations >= maxIterations) {
        stopReason = "iteration-cap";
        break;
      }

      // A max_tokens/pause response has no tool result to carry the next turn,
      // while the former hop boundary does. Both receive the same resume nudge.
      if (toolUses.length === 0 || iterations % this.maxRequestHops === 0) {
        appendAnthropicUserText(convo, SYNTHETIC_CONTINUE, { synthetic: true });
      }
    }

    let text;
    // Force a real answer whenever the turn was cut short — iteration cap,
    // stall, request timeout, or wall-clock — instead of returning only a canned
    // string. Mirrors Hermes forcing the LLM to answer at the iteration limit.
    // The final call carries NO tools (so it can't loop again), a fresh short
    // budget (forceAnswerMs), and is non-streaming (a clean blocking ask).
    const FORCE_ANSWER_REASONS = new Set(["iteration-cap", "stalled", "request-timeout", "turn-timeout", "provider-error"]);
    if (FORCE_ANSWER_REASONS.has(stopReason)) {
      reconcileOrphanedToolCalls(convo, "anthropic");
      appendAnthropicUserText(convo, forceAnswerPrompt(stopReason, iterations, maxIterations));
      try {
        checkRequestBudget(this, turnBudget);
        const preparation = await prepareProviderConversation(this, convo, {
          format: "anthropic",
          instructions: system,
          tools: [],
          model,
          usage: previousUsage,
          context
        });
        previousUsage = null;
        if (!goalContinuationIsCurrent(context, goalContinuationRevision)) {
          stopReason = "goal-preempted";
        } else if (!preparation.requestAllowed) {
          stopReason = "context-too-large";
        } else {
          response = await this.postMessages({
            model,
            max_tokens: this.maxTokens,
            system,
            messages: withAnthropicCacheBreakpoints(convo)
          }, context, {
            timeoutMs: this.forceAnswerMs,
            turnBudget,
            credentialRequest: credentialState.request
          });
          const forced = extractAnthropicText(response);
          if (forced) text = forced;
        }
      } catch (error) {
        // The forced answer is best-effort. If IT also times out/stalls or the
        // budget is gone, fall through to the canned partial summary below —
        // never rethrow and lose the turn.
        if (!budgetExceeded(error) && !requestTimedOut(error) && !providerUnavailable(error) && !deadlineExpired(this, deadline, error)) throw error;
      }
    }

    if (!text && (stopReason === "turn-timeout" || stopReason === "budget-cap" || stopReason === "request-timeout" || stopReason === "stalled" || stopReason === "provider-error" || stopReason === "context-too-large")) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (stopReason === "iteration-cap" && !text) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (text === undefined) {
      text = extractAnthropicText(response);
    }

    // Last-resort salvage: a reasoning model that hit max_tokens mid-think
    // returns only `thinking` blocks. Surface a trimmed slice of the trace
    // rather than the "(no text)" placeholder.
    const salvage = !text
      ? (response?.content ?? [])
          .filter((c) => c.type === "thinking" && typeof c.thinking === "string")
          .map((c) => c.thinking)
          .join("\n")
          .trim()
          .slice(0, 1500)
      : "";

    return {
      provider: "anthropic",
      model,
      id: response?.id,
      text: text || (salvage ? `⚠ Reply truncated mid-reasoning (max_tokens). Reasoning trace excerpt:\n${salvage}` : "(no text)"),
      toolCalls,
      iterations,
      maxIterations,
      stopReason
    };
  }

  async postMessages(body, context = {}, options = {}) {
    const controller = new AbortController();
    const externalSignal = context?.__abortSignal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const requestedTimeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
    const deadlineLimited = options.timeoutMs !== undefined && requestedTimeoutMs <= this.timeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, requestedTimeoutMs));
    // Stall watchdog: when we stream, the hard per-request timeout is replaced
    // by an IDLE timer that resets on every streamed chunk. A model still
    // producing tokens (even slowly) is never aborted for taking long; only
    // genuine silence past the stall window trips it. Without streaming (or
    // when disabled), the fixed timeout is the sole guard.
    const streaming = body.stream === true;
    const stallMs = streaming && this.stallTimeoutMs > 0
      ? Math.max(1, Math.min(this.stallTimeoutMs, timeoutMs))
      : 0;
    let timedOut = false;
    let stalled = false;
    let timer = null;
    const armHardTimeout = () => setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const armStallTimeout = () => setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
    timer = stallMs > 0 ? armStallTimeout() : armHardTimeout();
    const onActivity = stallMs > 0
      ? () => { clearTimeout(timer); timer = armStallTimeout(); }
      : undefined;
    try {
      const response = await requestWithProviderCredential(
        this,
        options.credentialRequest,
        {
          context,
          signal: controller.signal,
          model: body.model,
          request: (credential, lease) => {
            const headers = {
              "content-type": "application/json",
              "anthropic-version": this.version
            };
            if (lease.type === "oauth") headers.authorization = `Bearer ${credential}`;
            else headers["x-api-key"] = credential;
            return fetch(`${this.baseUrl}/messages`, {
              method: "POST",
              signal: controller.signal,
              headers,
              body: JSON.stringify(body)
            });
          }
        }
      );
      const contentType = response.headers?.get?.("content-type") ?? "";
      const json = streaming && /text\/event-stream/i.test(contentType)
        ? await readAnthropicEventStream(response, { onDelta: options.onDelta, onActivity })
        : await response.json().catch(() => ({}));
      const callTools = (json.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name);
      const budgetRecord = this.budgetGuard?.record(json.usage, body.model, {
        channel: context.channel,
        agentId: context.agentId,
        sessionId: context.sessionId,
        from: context.from,
        tools: callTools
      });
      if (options.turnBudget) recordTurnSpend(options.turnBudget, budgetRecord);
      return json;
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      if (deadlineLimited && error?.name === "AbortError") throw new TurnDeadlineError();
      if (stalled && error?.name === "AbortError") throw new ModelStallError(stallMs);
      if (timedOut && error?.name === "AbortError") throw new RequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function credentialPoolsForOptions(options = {}) {
  return options.credentialPoolRegistry ?? createCredentialPoolRegistry({
    ...(options.credentialPoolConfig === undefined
      ? {}
      : { config: options.credentialPoolConfig }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    env: options.env ?? process.env,
    secretsStore: options.secretsStore ?? options.secrets ?? null,
    ...(options.credentialPoolNow === undefined ? {} : { now: options.credentialPoolNow }),
    ...(options.credentialPoolRandom === undefined ? {} : { random: options.credentialPoolRandom }),
    refreshOAuth: options.refreshOAuth ?? null,
    onEvent: options.onCredentialPoolEvent ?? null
  });
}

function constructDirectProvider(providerName, model, options, credentialPools, budgetGuard) {
  const normalized = String(providerName ?? "").trim().toLowerCase();
  if (normalized === "anthropic") {
    return new AnthropicProvider({
      ...(options.anthropic ?? {}),
      ...(model ? { model } : {}),
      budgetGuard,
      credentialPool: options.anthropic?.credentialPool ?? credentialPools.get("anthropic")
    });
  }
  if (normalized === "openai") {
    return new OpenAIResponsesProvider({
      ...(options.openai ?? {}),
      ...(model ? { model } : {}),
      budgetGuard,
      credentialPool: options.openai?.credentialPool ?? credentialPools.get("openai")
    });
  }
  if (normalized === "moa") {
    throw new Error("MoA model specs cannot recursively select provider moa.");
  }
  throw new Error(`Unsupported direct model provider: ${normalized || "(empty)"}.`);
}

export function createDirectModelProviderFactory(options = {}, shared = {}) {
  const budgetGuard = shared.budgetGuard ?? options.budgetGuard ?? null;
  const credentialPools = shared.credentialPoolRegistry
    ?? credentialPoolsForOptions(options);
  return (spec = {}) => {
    const normalizedSpec = normalizeMoaModelSpec(spec, "MoA direct model");
    const provider = constructDirectProvider(
      normalizedSpec.provider,
      normalizedSpec.model,
      options,
      credentialPools,
      budgetGuard
    );
    if (!provider.isConfigured()) {
      throw new Error(`MoA model provider ${normalizedSpec.provider} is not configured.`);
    }
    return provider;
  };
}

export function createModelProvider(options = {}) {
  if (options.forceDeterministic === true) return new DeterministicModelProvider();
  const budgetGuard = options.budgetGuard ?? null;
  const credentialPools = credentialPoolsForOptions(options);
  const anthropic = constructDirectProvider(
    "anthropic",
    null,
    options,
    credentialPools,
    budgetGuard
  );
  const openai = constructDirectProvider(
    "openai",
    null,
    options,
    credentialPools,
    budgetGuard
  );

  const withFallback = (primary, fallback) => {
    primary.fallbackProvider = fallback?.isConfigured?.() ? fallback : null;
    return primary;
  };

  // MoA is explicit-only. "auto" retains the native-provider order and never
  // starts extra reference-model calls merely because moa.json exists.
  const preference = String(
    options.preferred
      ?? options.env?.OPENAGI_PROVIDER
      ?? process.env.OPENAGI_PROVIDER
      ?? "auto"
  ).trim().toLowerCase();
  if (preference === "moa") {
    const moaOptions = options.moa ?? {};
    const providerFactory = moaOptions.providerFactory
      ?? createDirectModelProviderFactory(options, {
        budgetGuard,
        credentialPoolRegistry: credentialPools
      });
    const preset = moaOptions.preset
      ?? moaOptions.model
      ?? options.env?.OPENAGI_MOA_PRESET
      ?? process.env.OPENAGI_MOA_PRESET;
    const moa = new MoaProvider({
      ...moaOptions,
      ...(options.dataDir === undefined || moaOptions.dataDir !== undefined
        ? {}
        : { dataDir: options.dataDir }),
      ...(preset === undefined ? {} : { preset }),
      providerFactory
    });
    if (!moa.isConfigured()) {
      throw new Error("MoA provider has no configured preset.");
    }
    return moa;
  }

  // Explicit native preference wins. anthropic | openai | auto (default).
  if (preference === "openai" && openai.isConfigured()) return withFallback(openai, anthropic);
  if (preference === "anthropic" && anthropic.isConfigured()) return withFallback(anthropic, openai);

  // auto: anthropic first if configured, then openai, then deterministic.
  if (anthropic.isConfigured()) return withFallback(anthropic, openai);
  if (openai.isConfigured()) return withFallback(openai, anthropic);
  return new DeterministicModelProvider();
}

// STATIC default system prompt. Must be byte-identical across turns for the
// same agent — the Anthropic cache_control marker on the system block only
// produces cache hits when the prefix never changes. Per-turn state (memory
// hits, scrutiny) travels via buildTurnContext on the user turn instead.
export function buildDefaultInstructions({ agent }) {
  return `You are ${agent?.name ?? "an OpenAGI agent"}, an always-on local assistant.

Tools available to you (call them when useful):
- remember(content, tags?, importance?, replaceIds?) - save a durable note and mirror it to the optional external user model; after a capacity error, consolidate overlapping recall results marked replaceable
- recall(query, limit?) - search built-in memory and the optional external user model; identify curated results that are replaceable in the current scope
- correct_memory(correction, query? | id?, tags?) - supersede a wrong memory with the corrected fact and mirror the correction to the optional external user model
- schedule_message(prompt, delaySeconds | intervalSeconds | dailyAt, channel?, target?) — schedule a future prompt that pings the user back
- list_cron_jobs — see every scheduled job and whether it is enabled
- set_cron_job_enabled(id, enabled) — turn a scheduled job OFF (enabled=false, pauses it, reversible) or ON (enabled=true); accepts the job id or its name
- cancel_cron_job(id) — permanently delete a scheduled job (irreversible; prefer set_cron_job_enabled to just pause one)
- add_goal(title, description?, dueDate?, parentGoalId?) - create a tracked goal and activate persistent goal mode for this session
- list_goals / link_task_to_goal - inspect goal rollups and attach tasks to a goal
- goal_status / pause_goal / resume_goal / clear_goal - inspect or control this session's automatic goal loop
- list_checkpoints / rollback - inspect automatic pre-mutation file snapshots and restore a confirmed checkpoint
- kanban_show(taskId) - inspect one local coordination task with blockers, comments, runs, and handoffs
- kanban_list(board?, status?, assignee?, limit?) - list local Kanban boards and work
- kanban_create(title, body?, board?, assignee?, blockedBy?) - create and optionally assign coordinated work
- kanban_complete(taskId, summary?, handoffTo?, metadata?) - complete unblocked work with a structured handoff
- kanban_block(taskId, blockedBy?, reason?) / kanban_unblock(taskId, blockerId?) - control blocking state
- kanban_comment(taskId, body) - add an identity-attributed task comment
- kanban_heartbeat(taskId, runId?, state?, assignee?, detail?) - claim work and update or append run attempts
- kanban_link(parentId, childId) - make a child depend on a parent task
- list_skills / use_skill / run_skill / restore_skill - discover, load, run, or restore named skill prompts
- list_mcp_tools / run_mcp_tool — invoke tools from connected MCP servers
- tool_search(query, limit?) - search deferred MCP and non-core plugin tools without loading their full schemas
- tool_describe(name) - inspect the full schema for one deferred tool before calling it
- tool_call(name, arguments) - invoke a deferred tool by its real name through the normal policy and approval gates
- list_sessions — see recent conversations

Guidelines:
- Be concise and conversational. No preamble like "Decision: act".
- Use tools without asking permission for safe actions (remember, recall, schedule).
- If asked to be reminded of something, call schedule_message.
- If asked to remember something, call remember.
- When the user references past info, call recall before answering.

The latest user message may begin with a [context] block assembled by the runtime (scrutiny decision, memory hits). Treat it as trusted background — the user did not type it.`;
}

// PER-TURN context block, prepended to the latest user message by the
// providers. Everything here may change every turn, which is exactly why it
// must not contaminate the cached system prompt above. Returns "" when there
// is nothing per-turn to say (batch callers pass no scrutiny/memoryHits, so
// their requests are unchanged).
export function buildTurnContext({ scrutiny, memoryHits } = {}) {
  const sections = [];
  if (scrutiny?.action) {
    sections.push(`Current scrutiny action: ${scrutiny.action}.`);
  }
  const memory = (memoryHits ?? [])
    .slice(0, 5)
    .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
    .join("\n");
  if (memory) {
    sections.push(`Top memory hits:\n${memory}`);
  }
  if (sections.length === 0) return "";
  return `[context]\nPer-turn background assembled by the runtime — not typed by the user.\n${sections.join("\n")}\n[/context]`;
}

export function appendSessionMemorySnapshot(instructions, snapshot) {
  const base = String(instructions ?? "");
  const memory = String(snapshot ?? "").trim();
  if (!memory) return base;
  return `${base}\n\n[session-memory]\nFrozen at session start; later memory writes are intentionally absent until a new session.\n${memory}\n[/session-memory]`;
}

export function extractResponseText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type === "message" || item.role === "assistant") {
      for (const content of item.content ?? []) {
        if (typeof content.text === "string") parts.push(content.text);
        if (typeof content.value === "string") parts.push(content.value);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractFunctionCalls(response) {
  if (!response?.output) return [];
  return response.output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments
    }));
}

function safeParseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function maybeInvoke(toolRegistry, name, args, context) {
  if (!toolRegistry?.invoke) return null;
  return toolRegistry.invoke(name, args, context);
}

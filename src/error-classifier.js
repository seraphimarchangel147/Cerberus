// Attribution: adapted from OmniRoute's provider-failure classification concepts
// (MIT, commit ed7db3e). This implementation is original to OpenAGI.

import { types as utilTypes } from "node:util";

export const DEFAULT_QUOTA_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
export const ERROR_CLASSIFIER_KILL_SWITCH = "OPENAGI_ERROR_CLASSIFIER";
export const TOOL_ERROR_CLASSIFIER_KILL_SWITCH = "OPENAGI_TOOL_ERROR_CLASSIFIER";

const TOOL_RESOURCE_CODES = new Set([
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "ENOSPC",
  "OOM"
]);
const TOOL_TRANSIENT_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "MUTATION_LEASE_CONFLICT",
  "RATE_LIMIT",
  "TOO_MANY_REQUESTS"
]);
const TOOL_PERMANENT_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "INVALID_TOOL_RESULT",
  "VALIDATION_FAILED",
  "VERIFICATION_FAILED"
]);
const TOOL_MODEL_CODES = new Set([
  "ARGUMENTS_NOT_FINGERPRINTABLE",
  "BAD_ARGUMENTS",
  "INVALID_ARGUMENT",
  "INVALID_ARGUMENTS",
  "INVALID_INPUT",
  "INVALID_TOOL_ARGUMENTS",
  "SCHEMA_VALIDATION"
]);
const TOOL_RESOURCE_LANGUAGE = /\b(?:heap exhausted|out of memory|no space left|too many open files|resource exhausted)\b/i;
const TOOL_TRANSIENT_LANGUAGE = /\b(?:lease (?:is )?held|mutation conflicts? with another active invocation|temporar(?:y|ily)|timed? ?out|timeout|connection reset|socket reset|rate.?limit|service unavailable|try again)\b/i;
const TOOL_MODEL_LANGUAGE = /\b(?:bad|invalid|malformed|missing|required|unknown)\b.{0,48}\b(?:argument|arguments|input|parameter|parameters)\b|\b(?:argument|arguments|input|parameter|parameters)\b.{0,48}\b(?:bad|invalid|malformed|missing|required|unknown|do not match)\b/i;
const TOOL_PERMANENT_LANGUAGE = /\b(?:access denied|permission denied|no such file|not found|validation fail(?:ed|ure)|unsupported operation)\b/i;

const RESET_HEADERS = Object.freeze([
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "ratelimit-reset",
  "retry-after"
]);
const LEGITIMATE_EMPTY_STOPS = new Set(["max_tokens", "tool_use"]);
const QUOTA_LANGUAGE = /(?:insufficient[_ -]?quota|\bquota\b|\bbilling\b|\bpayment\b|\bcredits?\b|(?:\bplan\b|\busage\b|\bspend(?:ing)?\b|\bmonthly\b|\bdaily\b).{0,48}\b(?:limit|cap|exceed|exhaust|reach)|\b(?:limit|cap|exceed|exhaust|reach).{0,48}(?:\bplan\b|\busage\b|\bspend(?:ing)?\b|\bmonthly\b|\bdaily\b))/i;

export function errorClassifierEnabled(env = process.env) {
  return String(env?.[ERROR_CLASSIFIER_KILL_SWITCH] ?? "").trim() !== "0";
}

export function toolErrorClassifierEnabled(env = process.env) {
  return String(
    toolFailureOwnValue(env, TOOL_ERROR_CLASSIFIER_KILL_SWITCH) ?? ""
  ).trim() !== "0";
}

export function classifyToolFailure(input = {}) {
  try {
    const env = toolFailureOwnValue(input, "env") ?? process.env;
    if (!toolErrorClassifierEnabled(env)) return null;
    const envelope = toolFailureOwnValue(input, "envelope") ?? null;
    const outcome = toolFailureOwnValue(input, "outcome")
      ?? toolFailureOwnValue(envelope, "outcome")
      ?? null;
    const error = toolFailureOwnValue(input, "error")
      ?? toolFailureOwnValue(envelope, "error")
      ?? null;
    const code = toolFailureCode(
      toolFailureOwnValue(input, "code"),
      toolFailureOwnValue(error, "code"),
      toolFailureOwnValue(outcome, "code"),
      toolFailureOwnValue(envelope, "code")
    );
    const message = toolFailureMessage(
      toolFailureOwnValue(input, "message"),
      typeof error === "string"
        ? error
        : toolFailureOwnValue(error, "message"),
      toolFailureOwnValue(envelope, "error"),
      toolFailureOwnValue(outcome, "message")
    );
    const status = toolFailureStatus(
      toolFailureOwnValue(input, "status"),
      toolFailureOwnValue(error, "status"),
      toolFailureOwnValue(error, "statusCode"),
      toolFailureOwnValue(envelope, "status"),
      toolFailureOwnValue(envelope, "statusCode")
    );
    const retryable = toolFailureOwnValue(input, "retryable") === true
      || toolFailureOwnValue(error, "retryable") === true
      || toolFailureOwnValue(outcome, "retryable") === true
      || toolFailureOwnValue(envelope, "retryable") === true;

    if (TOOL_RESOURCE_CODES.has(code) || TOOL_RESOURCE_LANGUAGE.test(message)) {
      return "RESOURCE";
    }
    if (TOOL_MODEL_CODES.has(code) || TOOL_MODEL_LANGUAGE.test(message)) {
      return "MODEL";
    }
    // Existing tool contracts own explicit retryability. Never contradict a
    // handler or normalizer that has already made that bounded declaration.
    if (retryable) return "TRANSIENT";
    if (
      TOOL_TRANSIENT_CODES.has(code)
      || status === 429
      || (status >= 500 && status <= 599)
      || TOOL_TRANSIENT_LANGUAGE.test(message)
      || /\bHTTP\s+(?:429|5\d\d)\b/i.test(message)
    ) {
      return "TRANSIENT";
    }
    if (
      TOOL_PERMANENT_CODES.has(code)
      || (status >= 400 && status <= 499)
      || TOOL_PERMANENT_LANGUAGE.test(message)
      || /\bHTTP\s+4\d\d\b/i.test(message)
    ) {
      return "PERMANENT";
    }
    // Unknown failures are not known-retryable. Defaulting to PERMANENT
    // preserves today's anti-spin behavior if evidence is incomplete.
    return "PERMANENT";
  } catch {
    return null;
  }
}

export function classifyProviderOutcome({
  status,
  body = null,
  headers = null,
  now = Date.now(),
  env = process.env
} = {}) {
  try {
    if (!errorClassifierEnabled(env)) return null;
    const normalizedStatus = Number(status);
    if (normalizedStatus === 429) {
      const quotaExhausted = QUOTA_LANGUAGE.test(bodyText(body));
      return {
        kind: quotaExhausted ? "quota-exhausted" : "rate-limit",
        retryAfterMs: quotaExhausted
          ? resetDelayMs(headers, now) ?? DEFAULT_QUOTA_BACKOFF_MS
          : DEFAULT_RATE_LIMIT_BACKOFF_MS
      };
    }
    if (
      normalizedStatus === 200
      && !LEGITIMATE_EMPTY_STOPS.has(stopReason(body))
      && !providerBodyHasContent(body)
    ) {
      return { kind: "silent-failure", retryAfterMs: null };
    }
    return null;
  } catch {
    return null;
  }
}

export function providerBodyHasContent(body) {
  if (typeof body === "string") return body.trim().length > 0;
  if (!body || typeof body !== "object") return false;
  if (nonBlank(body.output_text) || nonBlank(body.text) || nonBlank(body.refusal)) return true;
  if (contentValue(body.content) || contentValue(body.output)) return true;
  if (!Array.isArray(body.choices)) return false;
  return body.choices.some((choice) => (
    contentValue(choice?.message?.content)
    || contentValue(choice?.message?.tool_calls)
    || nonBlank(choice?.text)
  ));
}

function contentValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(contentValue);
  if (!value || typeof value !== "object") return false;
  if (["function_call", "tool_call", "tool_use"].includes(value.type)) return true;
  if (nonBlank(value.text) || nonBlank(value.output_text) || nonBlank(value.refusal)) return true;
  if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) return true;
  return contentValue(value.content) || contentValue(value.message);
}

function stopReason(body) {
  if (!body || typeof body !== "object") return "";
  return String(
    body.stop_reason
    ?? body.stopReason
    ?? body.choices?.[0]?.finish_reason
    ?? ""
  ).trim().toLowerCase();
}

function bodyText(body) {
  if (typeof body === "string") return body.slice(0, 65_536);
  if (body === null || body === undefined) return "";
  return JSON.stringify(body).slice(0, 65_536);
}

function resetDelayMs(headers, now) {
  for (const name of RESET_HEADERS) {
    const raw = headerValue(headers, name);
    if (!raw) continue;
    const parsed = parseResetValue(raw, Number(now), name === "retry-after");
    if (parsed !== null) return parsed;
  }
  return null;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match ? headers[match] : null;
}

function parseResetValue(value, now, retryAfter) {
  const raw = String(value).trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (retryAfter || numeric < 1_000_000_000) return Math.round(numeric * 1000);
    const epochMs = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    return Math.max(0, Math.round(epochMs - now));
  }
  const duration = durationMs(raw);
  if (duration !== null) return duration;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function durationMs(value) {
  const matches = [...String(value).matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi)];
  if (matches.length === 0 || matches.map((match) => match[0]).join("") !== value.replace(/\s+/g, "")) {
    return null;
  }
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(matches.reduce(
    (total, match) => total + Number(match[1]) * factors[match[2].toLowerCase()],
    0
  ));
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toolFailureCode(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const code = String(value).trim().toUpperCase().replace(/[.-]/g, "_");
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return "";
}

function toolFailureOwnValue(value, key) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function toolFailureMessage(...values) {
  const parts = [];
  let length = 0;
  for (const value of values) {
    if (value === undefined || value === null || length >= 4096) continue;
    const part = String(value).slice(0, 4096 - length);
    if (!part) continue;
    parts.push(part);
    length += part.length;
  }
  return parts.join(" ");
}

function toolFailureStatus(...values) {
  for (const value of values) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return 0;
}

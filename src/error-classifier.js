// Attribution: adapted from OmniRoute's provider-failure classification concepts
// (MIT, commit ed7db3e). This implementation is original to OpenAGI.

export const DEFAULT_QUOTA_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
export const ERROR_CLASSIFIER_KILL_SWITCH = "OPENAGI_ERROR_CLASSIFIER";

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

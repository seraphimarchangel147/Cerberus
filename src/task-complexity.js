// Attribution: adapted from OmniRoute's autoCombo/complexityRouter.ts and
// services/specificityRules.ts (MIT, commit ed7db3e).
// This is a Cerberus-specific Node ESM implementation.

const TIER_ORDER = Object.freeze({
  nano: 0,
  mini: 1,
  base: 2
});

export const MEDIUM_CONTEXT_BYTES = 32_000;
export const HUGE_CONTEXT_BYTES = 128_000;

const CODE_MARKERS = [
  /\b(?:function|class|const|let|var|import|export|async|await)\b/g,
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/g,
  /(?:=>|===|!==|<\/?[a-z][^>]*>)/gi
];

const REASONING_MARKERS = /\b(?:why|explain|design|architect(?:ure)?|trade[- ]?offs?|analy[sz]e|reason|compare|evaluate)\b/gi;
const JARGON_MARKERS = /\b(?:algorithm|concurrency|distributed|idempotent|invariant|latency|throughput|schema|transaction|serialization|authentication|authorization|compiler|runtime|database|vector|embedding|regression|deployment|observability)\b/gi;

export function classifyTaskComplexity(request = {}) {
  try {
    const measurement = measureTaskComplexity(request);
    if (measurement.bytes >= HUGE_CONTEXT_BYTES) return "base";
    let tier = scoreTier(measurement.score);
    if (measurement.bytes >= MEDIUM_CONTEXT_BYTES) {
      tier = escalateTier(tier, "mini");
    }
    if (measurement.toolCount > 0) {
      tier = escalateTier(tier, "mini");
    }
    return tier;
  } catch {
    return null;
  }
}

export function measureTaskComplexity(request = {}) {
  const text = requestText(request);
  const bytes = payloadBytes(request);
  const toolCount = requestToolCount(request);
  const scores = {
    code: codeScore(text),
    context: contextScore(bytes),
    tools: toolsScore(toolCount),
    reasoning: markerScore(text, REASONING_MARKERS, 3, 15),
    math: mathScore(text),
    jargon: markerScore(text, JARGON_MARKERS, 2, 15)
  };
  return {
    score: Math.min(100, Object.values(scores).reduce(
      (total, value) => total + value,
      0
    )),
    bytes,
    toolCount,
    scores
  };
}

export function escalateTier(currentTier, floorTier) {
  const current = Object.hasOwn(TIER_ORDER, currentTier)
    ? currentTier
    : "base";
  if (!Object.hasOwn(TIER_ORDER, floorTier)) return current;
  return TIER_ORDER[floorTier] > TIER_ORDER[current]
    ? floorTier
    : current;
}

function scoreTier(score) {
  if (score >= 50) return "base";
  if (score >= 20) return "mini";
  return "nano";
}

function requestText(request) {
  const parts = [
    request.input,
    request.instructions,
    request.turnContext,
    request.sessionMemorySnapshot,
    ...(Array.isArray(request.messages)
      ? request.messages.map((message) => message?.content)
      : [])
  ];
  return parts.map(flattenText).filter(Boolean).join("\n");
}

function flattenText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.entries(value)
    .filter(([key]) => !/image|data|base64/i.test(key))
    .map(([, item]) => flattenText(item))
    .join(" ");
}

function payloadBytes(request) {
  if (Number.isSafeInteger(request.bytes) && request.bytes >= 0) {
    return request.bytes;
  }
  const serialized = Buffer.byteLength(JSON.stringify({
    input: request.input ?? null,
    instructions: request.instructions ?? null,
    turnContext: request.turnContext ?? null,
    sessionMemorySnapshot: request.sessionMemorySnapshot ?? null,
    messages: request.messages ?? [],
    tools: request.tools ?? []
  }), "utf8");
  const shape = request.requestShape;
  const declared = shape && typeof shape === "object"
    ? [
        shape.historyBytes,
        shape.currentInputBytes,
        shape.instructionBytes,
        shape.visibleSchemaBytes
      ].reduce((total, value) => (
        total + (Number.isSafeInteger(value) && value > 0 ? value : 0)
      ), 0)
    : 0;
  const imageBytes = Array.isArray(request.images)
    ? request.images.reduce((total, image) => (
        total + Buffer.byteLength(String(image?.data ?? ""), "utf8")
      ), 0)
    : 0;
  return Math.max(serialized + imageBytes, declared + imageBytes);
}

function requestToolCount(request) {
  const carried = Array.isArray(request.tools) ? request.tools.length : 0;
  const declared = Number(
    request.toolCount
    ?? request.requestShape?.toolCount
    ?? request.requestShape?.totalToolCount
    ?? request.requestShape?.visibleToolCount
  );
  return Math.max(
    carried,
    Number.isSafeInteger(declared) && declared > 0 ? declared : 0
  );
}

function codeScore(text) {
  let score = /```/.test(text) ? 8 : 0;
  if (/diff --git|^@@\s+-\d/m.test(text)) score += 8;
  for (const marker of CODE_MARKERS) {
    score += Math.min(4, (text.match(marker) ?? []).length * 2);
  }
  return Math.min(20, score);
}

function contextScore(bytes) {
  if (bytes >= 256_000) return 15;
  if (bytes >= 128_000) return 13;
  if (bytes >= 64_000) return 10;
  if (bytes >= 32_000) return 7;
  if (bytes >= 8_000) return 3;
  return 0;
}

function toolsScore(count) {
  if (count >= 10) return 20;
  if (count >= 5) return 15;
  if (count >= 2) return 10;
  if (count >= 1) return 5;
  return 0;
}

function markerScore(text, pattern, points, maximum) {
  pattern.lastIndex = 0;
  return Math.min(maximum, (text.match(pattern) ?? []).length * points);
}

function mathScore(text) {
  if (!text) return 0;
  const formulae = (
    text.match(/(?:[=<>]=?|[+\-*/^])|\b(?:sqrt|log|sin|cos|probability|equation)\b/gi)
    ?? []
  ).length;
  const numericChars = (text.match(/\d/g) ?? []).length;
  const density = numericChars / Math.max(1, text.length);
  return Math.min(
    15,
    Math.min(10, formulae * 2) + (density >= 0.15 ? 5 : density >= 0.05 ? 2 : 0)
  );
}

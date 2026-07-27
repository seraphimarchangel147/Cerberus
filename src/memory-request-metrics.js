const MEMORY_METRICS_KEY = "__memoryRequestMetrics";
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export const MEMORY_REQUEST_COUNTER_NAMES = Object.freeze([
  "memoryBytesInjected",
  "spillCount",
  "mergesRequested",
  "mergesCompleted"
]);

export function initializeMemoryRequestMetrics(context, {
  memoryBytesInjected = 0
} = {}) {
  if (!context || typeof context !== "object") return null;
  const current = readMetricState(context);
  const state = {
    memoryBytesInjected: boundedCounter(memoryBytesInjected),
    spillCount: current?.spillCount ?? 0,
    mergesRequested: current?.mergesRequested ?? 0,
    mergesCompleted: current?.mergesCompleted ?? 0
  };
  context[MEMORY_METRICS_KEY] = state;
  return state;
}

export function setMemoryBytesInjected(context, bytes) {
  const state = ensureMetricState(context);
  if (!state) return 0;
  state.memoryBytesInjected = boundedCounter(bytes);
  return state.memoryBytesInjected;
}

export function incrementMemoryRequestMetric(context, name, amount = 1) {
  if (!MEMORY_REQUEST_COUNTER_NAMES.includes(name)) {
    throw new TypeError(`Unknown memory request counter: ${String(name)}`);
  }
  const state = ensureMetricState(context);
  if (!state) return 0;
  state[name] = safeAdd(state[name], boundedCounter(amount));
  return state[name];
}

export function peekMemoryRequestMetrics(context) {
  const state = readMetricState(context);
  return state ? snapshot(state) : null;
}

export function consumeMemoryRequestMetrics(context) {
  const state = readMetricState(context);
  if (!state) return null;
  const consumed = snapshot(state);
  state.spillCount = 0;
  state.mergesRequested = 0;
  state.mergesCompleted = 0;
  return consumed;
}

function ensureMetricState(context) {
  if (!context || typeof context !== "object") return null;
  return readMetricState(context) ?? initializeMemoryRequestMetrics(context);
}

function readMetricState(context) {
  const value = context?.[MEMORY_METRICS_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const name of MEMORY_REQUEST_COUNTER_NAMES) {
    value[name] = boundedCounter(value[name]);
  }
  return value;
}

function snapshot(state) {
  return {
    memoryBytesInjected: boundedCounter(state.memoryBytesInjected),
    spillCount: boundedCounter(state.spillCount),
    mergesRequested: boundedCounter(state.mergesRequested),
    mergesCompleted: boundedCounter(state.mergesCompleted)
  };
}

function boundedCounter(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_COUNTER, Math.floor(parsed));
}

function safeAdd(left, right) {
  return Math.min(MAX_COUNTER, boundedCounter(left) + boundedCounter(right));
}

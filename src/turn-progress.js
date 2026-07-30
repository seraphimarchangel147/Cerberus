const TURN_PROGRESS_COUNTER = Symbol("openagi-turn-progress-counter");
const TRUSTED_TURN_PROGRESS_COUNTERS = new WeakSet();

export function bindTurnProgressCounter(context) {
  try {
    if (!context || typeof context !== "object") return null;
    const existing = context[TURN_PROGRESS_COUNTER];
    if (isTrustedCounter(existing)) return existing;
    const counter = Object.seal({ count: 0 });
    TRUSTED_TURN_PROGRESS_COUNTERS.add(counter);
    Object.defineProperty(context, TURN_PROGRESS_COUNTER, {
      value: counter,
      enumerable: true,
      configurable: false,
      writable: false
    });
    return counter;
  } catch {
    return null;
  }
}

export function recordTurnProgress(context) {
  try {
    const counter = context?.[TURN_PROGRESS_COUNTER];
    if (!isTrustedCounter(counter)) return false;
    if (counter.count < Number.MAX_SAFE_INTEGER) counter.count += 1;
    return true;
  } catch {
    return false;
  }
}

export function readTurnProgressCount(counter) {
  try {
    return isTrustedCounter(counter) ? counter.count : null;
  } catch {
    return null;
  }
}

function isTrustedCounter(value) {
  return Boolean(
    value
    && typeof value === "object"
    && TRUSTED_TURN_PROGRESS_COUNTERS.has(value)
    && Number.isSafeInteger(value.count)
    && value.count >= 0
  );
}

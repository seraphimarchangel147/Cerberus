const TURN_PROGRESS_COUNTER = Symbol("openagi-turn-progress-counter");
const TRUSTED_TURN_PROGRESS_COUNTERS = new WeakSet();
const TURN_PROGRESS_OUTPUTS = new WeakMap();
const MAX_TURN_PROGRESS_OUTPUTS = 64;

export function bindTurnProgressCounter(context) {
  try {
    if (!context || typeof context !== "object") return null;
    const existing = context[TURN_PROGRESS_COUNTER];
    if (isTrustedCounter(existing)) return existing;
    const counter = Object.seal({ count: 0 });
    TRUSTED_TURN_PROGRESS_COUNTERS.add(counter);
    TURN_PROGRESS_OUTPUTS.set(counter, []);
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

export function recordTurnProgressOutput(
  context,
  outputSignature,
  { progressed = false } = {}
) {
  try {
    const counter = context?.[TURN_PROGRESS_COUNTER];
    if (
      !isTrustedCounter(counter)
      || typeof outputSignature !== "string"
      || !/^[a-f0-9]{64}$/.test(outputSignature)
    ) {
      return false;
    }
    const outputs = TURN_PROGRESS_OUTPUTS.get(counter);
    if (!Array.isArray(outputs)) return false;
    const rawCallId = context?.__providerToolCallId;
    const callId = typeof rawCallId === "string"
      && /^[\x21-\x7e]{1,240}$/.test(rawCallId)
      ? rawCallId
      : null;
    outputs.push(Object.freeze({
      callId,
      outputSignature,
      progressed: progressed === true
    }));
    if (outputs.length > MAX_TURN_PROGRESS_OUTPUTS) {
      outputs.splice(
        0,
        outputs.length - MAX_TURN_PROGRESS_OUTPUTS
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function readTurnProgressOutputs(context) {
  try {
    const counter = context?.[TURN_PROGRESS_COUNTER];
    if (!isTrustedCounter(counter)) return [];
    const outputs = TURN_PROGRESS_OUTPUTS.get(counter);
    return Array.isArray(outputs)
      ? outputs.map((record) => ({ ...record }))
      : [];
  } catch {
    return [];
  }
}

function isTrustedCounter(value) {
  return Boolean(
    value
    && typeof value === "object"
    && TRUSTED_TURN_PROGRESS_COUNTERS.has(value)
    && Array.isArray(TURN_PROGRESS_OUTPUTS.get(value))
    && TURN_PROGRESS_OUTPUTS.get(value).length <= MAX_TURN_PROGRESS_OUTPUTS
    && Number.isSafeInteger(value.count)
    && value.count >= 0
  );
}

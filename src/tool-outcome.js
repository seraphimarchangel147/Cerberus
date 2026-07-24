import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { sanitizeForAudit } from "./redact.js";

const OUTCOME_STATUSES = new Set(["succeeded", "failed", "blocked", "pending"]);
const MAX_REFERENCES = 16;
const MAX_NEXT_STEPS = 6;
const MAX_TEXT = 800;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_FINGERPRINT_NODES = 10000;
const MAX_RESULT_DEPTH = 64;
const MAX_RESULT_NODES = 20000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const REFERENCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._/-]{1,200}$/u;

export async function semanticToolResult(tool, rawResult, args, context, additions = {}) {
  const mandatory = mandatoryOutcomeAdditions(additions);
  let safeResult;
  try {
    safeResult = freezeJson(snapshotToolValue(rawResult));
  } catch (error) {
    return withMandatoryOutcome(tool, failureEnvelope(tool, null, {
      code: "tool_result_not_serializable",
      error: safeErrorText(error, "Tool result could not be safely serialized.")
    }), mandatory);
  }
  let outcome = defaultOutcome(tool, safeResult);
  const baselineFailure = ["failed", "blocked"].includes(outcome.status)
    ? {
        status: outcome.status,
        code: outcome.code,
        retryable: outcome.retryable
      }
    : null;
  outcome = applyOutcomePatch(tool, outcome, {
    artifacts: [
      ...outcome.artifacts,
      ...mandatory.artifacts
    ],
    evidence: [
      ...outcome.evidence,
      ...mandatory.evidence
    ]
  });
  if (typeof tool?.normalizeOutcome === "function") {
    let patch;
    try {
      patch = snapshotToolValue(
        await tool.normalizeOutcome(safeResult, args ?? {}, context ?? {}, outcome)
      );
    } catch (error) {
      return withMandatoryOutcome(tool, failureEnvelope(tool, safeResult, {
        code: "outcome_normalizer_error",
        error: safeErrorText(error, "Tool outcome normalization failed.")
      }), mandatory);
    }
    try {
      // Verification is verifier-owned. A normalizer may classify a result,
      // but it cannot claim that an independent check ran.
      if (patch && typeof patch === "object") delete patch.verification;
      outcome = applyOutcomePatch(tool, outcome, patch);
      if (
        baselineFailure
        && ["succeeded", "pending"].includes(outcome.status)
      ) {
        outcome = applyOutcomePatch(tool, outcome, baselineFailure);
      }
    } catch (error) {
      return withMandatoryOutcome(tool, failureEnvelope(tool, safeResult, {
        code: "outcome_normalizer_error",
        error: safeErrorText(error, "Tool outcome normalization failed.")
      }), mandatory);
    }
  }

  if (outcome.status === "succeeded" && typeof tool?.verifyOutcome === "function") {
    let verification;
    try {
      verification = snapshotToolValue(
        await tool.verifyOutcome(safeResult, args ?? {}, context ?? {}, outcome)
      );
    } catch (error) {
      return withMandatoryOutcome(tool, failureEnvelope(tool, safeResult, {
        code: "verification_error",
        error: safeErrorText(error, "Tool result verification failed."),
        outcome: {
          ...outcome,
          status: "failed",
          code: "verification_error",
          retryable: false,
          verification: {
            status: "failed",
            summary: safeErrorText(error, "Verification failed.")
          }
        }
      }), mandatory);
    }
    try {
      outcome = applyVerification(tool, outcome, verification);
    } catch (error) {
      return withMandatoryOutcome(tool, failureEnvelope(tool, safeResult, {
        code: "verification_error",
        error: safeErrorText(error, "Tool result verification failed.")
      }), mandatory);
    }
  }

  outcome = applyOutcomePatch(tool, outcome, {
    artifacts: [...outcome.artifacts, ...mandatory.artifacts],
    evidence: [...outcome.evidence, ...mandatory.evidence]
  });
  return envelope(safeResult, outcome);
}

export async function ensureSemanticToolEnvelope(
  tool,
  value,
  args,
  context,
  { code = "tool_error", status = "failed" } = {}
) {
  let safeValue;
  try {
    safeValue = snapshotToolValue(value);
  } catch (error) {
    return semanticToolError(tool, error, {
      code: "tool_result_not_serializable"
    });
  }
  if (safeValue?.outcome && typeof safeValue.outcome === "object") {
    let outcome = normalizeOutcome(tool, safeValue.outcome);
    const outerFailed = safeValue.ok === false || Boolean(safeValue.error);
    if (outerFailed && ["succeeded", "pending"].includes(outcome.status)) {
      outcome = applyOutcomePatch(tool, outcome, {
        status: safeValue?.blocked === true ? "blocked" : status,
        code: safeCode(safeValue?.code, code),
        retryable: safeValue?.retryable === true
      });
    }
    const rebuilt = envelope(safeValue.result, outcome);
    const reconciled = {
      ...safeValue,
      ...rebuilt,
      outcome
    };
    if (rebuilt.ok) delete reconciled.error;
    else reconciled.error = boundedText(safeValue?.error ?? rebuilt.error);
    return reconciled;
  }
  if (safeValue?.ok === true) {
    return semanticToolResult(tool, safeValue.result, args, context);
  }
  const semantic = semanticToolError(tool, safeValue?.error, {
    code: safeCode(safeValue?.code, code),
    status: safeValue?.blocked === true ? "blocked" : status,
    retryable: safeValue?.retryable === true,
    changed: safeValue?.changed
  });
  return {
    ...(safeValue && typeof safeValue === "object" ? safeValue : {}),
    ...semantic,
    ...(safeValue && Object.hasOwn(safeValue, "result") ? { result: safeValue.result } : {})
  };
}

export function semanticToolError(tool, error, {
  code = "handler_error",
  status = "failed",
  retryable = false,
  changed = null,
  artifacts = [],
  evidence = [],
  nextSteps = []
} = {}) {
  const message = safeErrorText(error, "Tool execution failed.");
  const outcome = normalizeOutcome(tool, {
    status,
    code,
    retryable,
    changed,
    artifacts,
    evidence,
    verification: { status: "not_requested", summary: null },
    nextSteps
  });
  return {
    ok: false,
    error: message,
    outcome
  };
}

export function toolFailureFingerprint(name, args) {
  const serialized = stableJson(args ?? {}, {
    ancestors: new Set(),
    nodes: 0
  });
  return createHash("sha256")
    .update(String(name ?? ""))
    .update("\0")
    .update(serialized)
    .digest("hex");
}

export function snapshotToolValue(value) {
  return cloneJsonValue(value, {
    ancestors: new Set(),
    nodes: 0,
    bytes: 0
  });
}

export function safeToolErrorMessage(error, fallback = "Tool execution failed.") {
  return safeToolErrorDetails(error, fallback).message;
}

export function safeToolErrorDetails(error, fallback = "Tool execution failed.") {
  const details = {
    message: safeErrorText(error, fallback),
    code: null,
    retryable: false
  };
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) {
    return details;
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const code = descriptors.code;
    if (
      code
      && Object.hasOwn(code, "value")
      && typeof code.value === "string"
      && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(code.value)
    ) {
      details.code = code.value;
    }
    const retryable = descriptors.retryable;
    if (retryable && Object.hasOwn(retryable, "value")) {
      details.retryable = retryable.value === true;
    }
  } catch {
    // Stable defaults represent hostile thrown values.
  }
  return details;
}

export function repeatedFailureEnvelope(previous, attempts) {
  const count = Math.max(2, Math.floor(Number(attempts) || 2));
  const original = boundedText(previous?.error ?? "The tool failed.");
  return {
    ok: false,
    error: `Unchanged retry stopped after ${count} identical failures. ${original}`,
    outcome: {
      status: "failed",
      code: "repeated_failure",
      retryable: false,
      changed: previous?.outcome?.changed ?? null,
      artifacts: [...(previous?.outcome?.artifacts ?? [])],
      evidence: [...(previous?.outcome?.evidence ?? [])],
      verification: previous?.outcome?.verification ?? {
        status: "not_requested",
        summary: null
      },
      nextSteps: [
        "Change the arguments or satisfy the missing prerequisite.",
        "Inspect a different tool or ask the user for the required input."
      ]
    }
  };
}

function defaultOutcome(tool, rawResult) {
  const reported = reportedFailure(tool, rawResult);
  const status = reported?.status ?? reportedStatus(tool, rawResult);
  const succeeded = status === "succeeded" || status === "pending";
  const references = inferredReferences(rawResult);
  return normalizeOutcome(tool, {
    status,
    code: reported?.code ?? (status === "pending" ? "pending" : "ok"),
    retryable: reported?.retryable ?? false,
    changed: inferredChanged(tool, rawResult, succeeded),
    artifacts: references.artifacts,
    evidence: references.evidence,
    verification: { status: "not_requested", summary: null },
    nextSteps: reported?.nextSteps ?? []
  });
}

function reportedStatus(tool, result) {
  const status = String(result?.status ?? "").trim().toLowerCase();
  return (
    (status === "pending" || status === "awaiting_confirmation")
    && executionStatusIsSemantic(tool, result, status)
  )
    ? "pending"
    : "succeeded";
}

function reportedFailure(tool, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const status = String(result.status ?? "").trim().toLowerCase();
  const statusFailure = [
    "error",
    "failed",
    "failure",
    "blocked",
    "denied",
    "cancelled"
  ].includes(status)
    && executionStatusIsSemantic(tool, result, status);
  const failed = result.ok === false
    || result.success === false
    || Boolean(result.error)
    || statusFailure;
  if (!failed) return null;
  const blocked = status === "blocked" || status === "denied";
  return {
    status: blocked ? "blocked" : "failed",
    code: safeCode(result.code, blocked ? "reported_block" : "reported_error"),
    retryable: result.retryable === true,
    nextSteps: normalizeStrings(result.nextSteps ?? result.next, MAX_NEXT_STEPS)
  };
}

function executionStatusIsSemantic(tool, result, status) {
  return !(
    Array.isArray(tool?.domainResultStatuses)
    && tool.domainResultStatuses.includes(status)
  );
}

function applyOutcomePatch(tool, base, patch) {
  if (patch === undefined || patch === null) return base;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Tool outcome normalizer must return an object.");
  }
  return normalizeOutcome(tool, {
    ...base,
    ...patch,
    verification: patch.verification ?? base.verification
  });
}

function applyVerification(tool, base, verification) {
  if (verification === undefined || verification === true) {
    return normalizeOutcome(tool, {
      ...base,
      verification: { status: "passed", summary: null }
    });
  }
  if (verification === false) {
    return normalizeOutcome(tool, {
      ...base,
      status: "failed",
      code: "verification_failed",
      retryable: false,
      verification: { status: "failed", summary: "Verification did not pass." }
    });
  }
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    throw new TypeError("Tool outcome verifier must return a boolean or object.");
  }
  const status = String(verification.status ?? "").trim().toLowerCase();
  const passed = verification.ok === true
    || verification.passed === true
    || ["ok", "passed", "success", "succeeded"].includes(status);
  return normalizeOutcome(tool, {
    ...base,
    status: passed ? base.status : "failed",
    code: passed ? base.code : safeCode(verification.code, "verification_failed"),
    retryable: passed ? base.retryable : false,
    evidence: [
      ...base.evidence,
      ...normalizeReferences(verification.evidence)
    ],
    verification: {
      status: passed ? "passed" : "failed",
      summary: boundedText(verification.summary ?? verification.message ?? "")
    }
  });
}

function mandatoryOutcomeAdditions(additions) {
  return {
    artifacts: normalizeReferences(additions?.artifacts),
    evidence: normalizeReferences(additions?.evidence)
  };
}

function withMandatoryOutcome(tool, value, mandatory) {
  if (!value?.outcome) return value;
  return {
    ...value,
    outcome: applyOutcomePatch(tool, value.outcome, {
      artifacts: [...value.outcome.artifacts, ...mandatory.artifacts],
      evidence: [...value.outcome.evidence, ...mandatory.evidence]
    })
  };
}

function failureEnvelope(tool, rawResult, {
  code,
  error,
  outcome = null
}) {
  const normalized = outcome
    ? normalizeOutcome(tool, outcome)
    : normalizeOutcome(tool, {
        status: "failed",
        code,
        retryable: false,
        changed: null,
        artifacts: [],
        evidence: [],
        verification: { status: "not_requested", summary: null },
        nextSteps: []
      });
  return {
    ok: false,
    result: rawResult,
    error: safeErrorText(error, "Tool execution failed."),
    outcome: normalized
  };
}

function envelope(rawResult, outcome) {
  const ok = outcome.status === "succeeded" || outcome.status === "pending";
  if (ok) return { ok: true, result: rawResult, outcome };
  const error = boundedText(
    rawResult?.error
    ?? rawResult?.message
    ?? (outcome.status === "blocked" ? "Tool action was blocked." : "Tool reported failure.")
  );
  return {
    ok: false,
    result: rawResult,
    error,
    outcome
  };
}

function normalizeOutcome(tool, value) {
  const status = normalizedStatus(value.status);
  const idempotent = tool?.capability?.idempotent === true;
  return Object.freeze({
    status,
    code: safeCode(value.code, status === "succeeded" ? "ok" : status),
    retryable: value.retryable === true && idempotent,
    changed: value.changed === true ? true : value.changed === false ? false : null,
    artifacts: Object.freeze(normalizeReferences(value.artifacts)),
    evidence: Object.freeze(normalizeReferences(value.evidence)),
    verification: Object.freeze(normalizeVerification(value.verification)),
    nextSteps: Object.freeze(normalizeStrings(value.nextSteps, MAX_NEXT_STEPS))
  });
}

function normalizedStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return OUTCOME_STATUSES.has(status) ? status : "failed";
}

function safeCode(value, fallback) {
  const code = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,63}$/u.test(code) ? code : fallback;
}

function inferredChanged(tool, result, succeeded) {
  if (result?.changed === true || result?.changed === false) return result.changed;
  if (result?.modified === true || result?.modified === false) return result.modified;
  if (!tool?.sideEffects) return false;
  return succeeded ? null : null;
}

function inferredReferences(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { artifacts: [], evidence: [] };
  }
  const artifacts = [];
  const evidence = [];
  pushReference(artifacts, "artifact", result.artifactId);
  for (const id of Array.isArray(result.artifactIds) ? result.artifactIds : []) {
    pushReference(artifacts, "artifact", id);
  }
  pushReference(artifacts, "draft", result.draftId);
  pushReference(evidence, "checkpoint", result.checkpointId);
  pushReference(evidence, "tool-output", result.outputRef);
  return {
    artifacts: normalizeReferences(artifacts),
    evidence: normalizeReferences(evidence)
  };
}

function pushReference(target, kind, value) {
  const ref = boundedText(value);
  if (ref) target.push(`${kind}:${ref}`);
}

function normalizeReferences(value) {
  return normalizeStrings(value, MAX_REFERENCES, 240)
    .filter((reference) => REFERENCE_PATTERN.test(reference));
}

function normalizeStrings(value, maximum, maxLength = MAX_TEXT) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = [];
  for (const item of list.slice(0, maximum)) {
    const text = boundedText(item, maxLength);
    if (text && !normalized.includes(text)) normalized.push(text);
  }
  return normalized;
}

function normalizeVerification(value) {
  const status = String(value?.status ?? "not_requested").trim().toLowerCase();
  return {
    status: ["not_requested", "passed", "failed"].includes(status)
      ? status
      : "failed",
    summary: boundedText(value?.summary ?? "") || null
  };
}

function boundedText(value, maximum = MAX_TEXT) {
  const primitive = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : "";
  const redacted = sanitizeForAudit(primitive.trim());
  const text = typeof redacted === "string" ? redacted : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 3)}...`;
}

function safeErrorText(error, fallback) {
  if (typeof error === "string") return boundedText(error) || fallback;
  if (
    typeof error === "number"
    || typeof error === "boolean"
    || typeof error === "bigint"
  ) {
    return boundedText(error) || fallback;
  }
  if (!error || typeof error !== "object" || utilTypes.isProxy(error)) {
    return boundedText(fallback);
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const message = descriptors.message;
    if (message && Object.hasOwn(message, "value")) {
      return boundedText(message.value) || boundedText(fallback);
    }
  } catch {
    // A hostile thrown value is represented by the stable fallback.
  }
  return boundedText(fallback);
}

function cloneJsonValue(value, state, depth = 0) {
  if (depth > MAX_RESULT_DEPTH || state.nodes >= MAX_RESULT_NODES) {
    throw new RangeError("Tool result exceeds the structural bound.");
  }
  state.nodes += 1;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    addResultBytes(state, Buffer.byteLength(value, "utf8"));
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    throw new TypeError("Tool results must not contain BigInt values.");
  }
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (typeof value !== "object") return boundedText(value);
  if (utilTypes.isProxy(value)) {
    throw new TypeError("Tool results must not contain Proxy objects.");
  }
  if (state.ancestors.has(value)) {
    throw new TypeError("Tool results must not contain cycles.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    throw new TypeError("Tool results must contain only plain JSON objects.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  state.ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    const length = Number(descriptors.length?.value ?? 0);
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > MAX_RESULT_NODES - state.nodes
    ) {
      throw new RangeError("Tool result array exceeds the structural bound.");
    }
    clone = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        clone.push(null);
        continue;
      }
      if (!Object.hasOwn(descriptor, "value")) {
        throw new TypeError("Tool results must not contain accessors.");
      }
      clone.push(cloneJsonValue(descriptor.value, state, depth + 1));
    }
  } else {
    clone = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) {
        throw new TypeError("Tool results must not contain accessors.");
      }
      addResultBytes(state, Buffer.byteLength(key, "utf8"));
      defineOwnData(clone, key, cloneJsonValue(descriptor.value, state, depth + 1));
    }
  }
  state.ancestors.delete(value);
  return clone;
}

function addResultBytes(state, amount) {
  state.bytes += Math.max(0, Number(amount) || 0);
  if (state.bytes > MAX_RESULT_BYTES) {
    throw new RangeError("Tool result exceeds the byte bound.");
  }
}

function defineOwnData(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function stableJson(value, state, depth = 0) {
  if (depth > MAX_FINGERPRINT_DEPTH || state.nodes >= MAX_FINGERPRINT_NODES) {
    throw new RangeError("Tool arguments exceed the failure-fingerprint bound.");
  }
  state.nodes += 1;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (utilTypes.isProxy(value)) {
    throw new TypeError("Tool arguments must not contain Proxy objects.");
  }
  if (state.ancestors.has(value)) {
    throw new TypeError("Tool arguments must not contain cycles.");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    throw new TypeError("Tool arguments must contain only plain JSON objects.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  state.ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    const length = Number(descriptors.length?.value ?? 0);
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > MAX_FINGERPRINT_NODES - state.nodes
    ) {
      throw new RangeError("Tool argument array exceeds the failure-fingerprint bound.");
    }
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) {
        values.push("null");
        continue;
      }
      if (!Object.hasOwn(descriptor, "value")) {
        throw new TypeError("Tool arguments must not contain accessors.");
      }
      values.push(stableJson(descriptor.value, state, depth + 1));
    }
    serialized = `[${values.join(",")}]`;
  } else {
    const entries = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) {
        throw new TypeError("Tool arguments must not contain accessors.");
      }
      if (
        descriptor.value === undefined
        || typeof descriptor.value === "function"
        || typeof descriptor.value === "symbol"
      ) {
        continue;
      }
      entries.push(
        `${JSON.stringify(key)}:${stableJson(descriptor.value, state, depth + 1)}`
      );
    }
    serialized = `{${entries.join(",")}}`;
  }
  state.ancestors.delete(value);
  return serialized;
}

function freezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, "value")) freezeJson(descriptor.value);
  }
  return value;
}

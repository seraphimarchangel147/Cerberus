export const MAX_EXECUTION_DECISION_STAGES = 48;

const EXECUTION_DECISION_GATES = new Set([
  "approval",
  "approval_identity",
  "authority_refresh",
  "cancellation",
  "checkpoint",
  "dispatch",
  "dispatch_authority",
  "execution",
  "forwarding",
  "handler",
  "input_contract",
  "input_snapshot",
  "operation_guard",
  "outcome",
  "output_contract",
  "pre_hook",
  "preflight",
  "profile_capability",
  "profile_scope",
  "project_capability",
  "project_scope",
  "resource_lease",
  "scrutiny",
  "semantic_verification",
  "specialist_scope",
  "startup_barrier",
  "tool_lookup"
]);

const EXECUTION_DECISION_STATUSES = new Set([
  "approved",
  "blocked",
  "cancelled",
  "degraded",
  "dispatched",
  "failed",
  "not_available",
  "not_reached",
  "not_required",
  "passed",
  "pending",
  "reused",
  "succeeded"
]);

const MAX_EXECUTION_DECISION_DURATION_MS = 24 * 60 * 60 * 1000;

export function isExecutionDecisionGate(value) {
  return EXECUTION_DECISION_GATES.has(value);
}

export function isExecutionDecisionStatus(value) {
  return EXECUTION_DECISION_STATUSES.has(value);
}

export function normalizeExecutionDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sourceStages = String(value.path ?? "")
    .split(">")
    .filter(Boolean);
  const stages = sourceStages
    .slice(0, MAX_EXECUTION_DECISION_STAGES)
    .filter((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1 || separator !== entry.lastIndexOf(":")) return false;
      return isExecutionDecisionGate(entry.slice(0, separator))
        && isExecutionDecisionStatus(entry.slice(separator + 1));
    });
  if (stages.length === 0) return null;
  const blockedAt = String(value.blockedAt ?? "");
  const slowestGate = String(value.slowestGate ?? "");
  const slowestMs = Number.isSafeInteger(value.slowestMs)
    && value.slowestMs >= 0
    ? Math.min(MAX_EXECUTION_DECISION_DURATION_MS, value.slowestMs)
    : 0;
  return {
    version: 1,
    path: stages.join(">"),
    gateCount: stages.length,
    blockedAt: isExecutionDecisionGate(blockedAt) ? blockedAt : null,
    slowestGate: isExecutionDecisionGate(slowestGate) ? slowestGate : null,
    slowestMs,
    truncated: value.truncated === true
      || sourceStages.length > MAX_EXECUTION_DECISION_STAGES
      || stages.length !== sourceStages.length
  };
}

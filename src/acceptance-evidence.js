import { createHash } from "node:crypto";

const MAX_CRITERIA = 32;
const MAX_CHECK_IDS = 16;
const MAX_STATEMENT = 1_000;
const MAX_TARGET = 500;
const CRITERION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CHECK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_REVISION_RE = /^[a-f0-9]{64}$/;
const QA_RUN_ID_RE = /^qa_[a-f0-9]{16}$/;
const QA_COMPARISON_ID_RE = /^qacmp_[a-f0-9]{16}$/;
const KINDS = new Set([
  "accessibility",
  "behavior",
  "compatibility",
  "performance",
  "security",
  "visual"
]);
const ORACLES = new Set([
  "accessibility",
  "browser",
  "human",
  "keyboard",
  "performance",
  "screenshot",
  "test",
  "visual"
]);

export function normalizeAcceptanceCriteria(value, checks, {
  allowLegacy = false
} = {}) {
  const normalizedChecks = normalizeCheckIdentities(checks);
  if (
    (!Array.isArray(value) || value.length < 1)
    && allowLegacy
  ) {
    return legacyCriteria(normalizedChecks);
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CRITERIA) {
    throw new TypeError(`Acceptance requires 1-${MAX_CRITERIA} criteria.`);
  }

  const availableChecks = new Set(normalizedChecks.map((check) => check.id));
  const seen = new Set();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`Acceptance criterion ${index + 1} must be an object.`);
    }
    const id = String(raw.id ?? "").trim();
    if (!CRITERION_ID_RE.test(id) || seen.has(id)) {
      throw new TypeError(
        `Acceptance criterion ${index + 1} requires a unique ASCII id.`
      );
    }
    seen.add(id);
    const statement = boundedText(
      raw.statement,
      `Acceptance criterion ${id} statement`,
      MAX_STATEMENT
    );
    const kind = String(raw.kind ?? "behavior").trim().toLowerCase();
    if (!KINDS.has(kind)) {
      throw new TypeError(`Acceptance criterion ${id} has an invalid kind.`);
    }
    const oracle = String(raw.oracle ?? "test").trim().toLowerCase();
    if (!ORACLES.has(oracle)) {
      throw new TypeError(`Acceptance criterion ${id} has an invalid oracle.`);
    }
    if (
      !Array.isArray(raw.checkIds)
      || raw.checkIds.length < 1
      || raw.checkIds.length > MAX_CHECK_IDS
    ) {
      throw new TypeError(
        `Acceptance criterion ${id} requires 1-${MAX_CHECK_IDS} checkIds.`
      );
    }
    const checkIds = [...new Set(raw.checkIds.map((checkId) => {
      const normalized = String(checkId ?? "").trim();
      if (!CHECK_ID_RE.test(normalized) || !availableChecks.has(normalized)) {
        throw new TypeError(
          `Acceptance criterion ${id} references an unknown ASCII check id.`
        );
      }
      return normalized;
    }))];
    const target = raw.target == null
      ? null
      : boundedText(raw.target, `Acceptance criterion ${id} target`, MAX_TARGET);
    const threshold = normalizeThreshold(raw.threshold, id);
    return Object.freeze({
      id,
      statement,
      kind,
      oracle,
      required: raw.required !== false,
      checkIds: Object.freeze(checkIds),
      ...(target === null ? {} : { target }),
      ...(threshold === null ? {} : { threshold })
    });
  });
}

export function normalizeCheckIdentities(checks) {
  if (!Array.isArray(checks)) return [];
  const seen = new Set();
  return checks.map((raw, index) => {
    const fallback = `check_${index + 1}`;
    const id = String(raw?.id ?? fallback).trim();
    if (!CHECK_ID_RE.test(id) || seen.has(id)) {
      throw new TypeError(`Coder check ${index + 1} requires a unique ASCII id.`);
    }
    seen.add(id);
    return {
      ...(raw && typeof raw === "object" ? structuredClone(raw) : {}),
      id
    };
  });
}

export function createAcceptanceGraph({
  objective,
  criteria,
  checks,
  allowLegacy = false
}) {
  const normalizedChecks = normalizeCheckIdentities(checks);
  const normalizedCriteria = normalizeAcceptanceCriteria(
    criteria,
    normalizedChecks,
    { allowLegacy }
  );
  return {
    version: 1,
    intentDigest: digestCanonical({
      objective: String(objective ?? ""),
      criteria: normalizedCriteria
    }),
    status: "pending",
    sourceRevision: null,
    criteria: normalizedCriteria,
    evidence: [],
    summary: summarizeCriteria(normalizedCriteria, [])
  };
}

export function sourceRevisionForRun(files, edits) {
  const postTags = new Map(
    (Array.isArray(edits) ? edits : []).map((edit) => [
      String(edit?.path ?? ""),
      String(edit?.postTag ?? "")
    ])
  );
  const entries = (Array.isArray(files) ? files : [])
    .map((file) => ({
      path: String(file?.path ?? ""),
      tag: postTags.get(String(file?.path ?? ""))
        ?? (file?.missing === true ? "missing" : String(file?.tag ?? ""))
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return digestCanonical(entries);
}

export function recordVerificationEvidence({
  graph,
  checks,
  verification,
  sourceRevision,
  at
}) {
  const normalized = normalizeStoredGraph(graph, { checks });
  if (!normalized) throw new TypeError("Acceptance graph is invalid.");
  if (!SOURCE_REVISION_RE.test(String(sourceRevision ?? ""))) {
    throw new TypeError("Acceptance evidence requires an exact source revision.");
  }
  const results = Array.isArray(verification?.results)
    ? verification.results
    : [];
  const checkById = new Map(normalizeCheckIdentities(checks).map((check) => [
    check.id,
    check
  ]));
  const resultById = new Map(results.map((result, index) => [
    String(result?.id ?? checks?.[index]?.id ?? `check_${index + 1}`),
    result
  ]));
  const evidence = [];

  for (const criterion of normalized.criteria) {
    for (const checkId of criterion.checkIds) {
      const check = checkById.get(checkId);
      const result = resultById.get(checkId);
      if (!check || !result) continue;
      const oracleStatus = evidenceStatusForOracle(
        criterion.oracle,
        check,
        result
      );
      if (oracleStatus === null) continue;
      const status = oracleStatus;
      const record = {
        criterionId: criterion.id,
        checkId,
        oracle: criterion.oracle,
        deterministic: criterion.oracle !== "human",
        status,
        sourceRevision,
        at: String(at ?? new Date().toISOString()),
        receiptId: result?.receiptId ?? verification?.receipt?.id
          ? String(
              result?.receiptId
              ?? verification.receipt.id
            ).slice(0, 200)
          : null,
        result: {
          type: String(result.type ?? check.type ?? "").slice(0, 32),
          path: result.path == null ? null : String(result.path).slice(0, 500),
          code: String(result.code ?? "").slice(0, 80),
          durationMs: Number.isSafeInteger(result.durationMs)
            ? result.durationMs
            : 0,
          qaRunId: QA_RUN_ID_RE.test(String(result?.evidence?.qaRunId ?? ""))
            ? result.evidence.qaRunId
            : null,
          comparisonId: QA_COMPARISON_ID_RE.test(
            String(result?.evidence?.comparisonId ?? "")
          )
            ? result.evidence.comparisonId
            : null,
          designPassed: result?.evidence?.designPassed === true,
          artifactRefs: normalizeArtifactRefs(
            result?.evidence?.artifactRefs
          )
        }
      };
      evidence.push(Object.freeze({
        id: `evidence_${digestCanonical(record).slice(0, 16)}`,
        ...record
      }));
    }
  }

  const next = {
    ...normalized,
    sourceRevision,
    evidence,
    summary: summarizeCriteria(normalized.criteria, evidence, sourceRevision)
  };
  next.status = next.summary.failed > 0
    ? "failed"
    : next.summary.requiredPassed === next.summary.required
      ? "passed"
      : "pending";
  return next;
}

function evidenceStatusForOracle(oracle, check, result) {
  if (result.ok !== true) return "failed";
  if (oracle === "test") {
    return ["syntax", "test"].includes(check.type) ? "passed" : null;
  }
  if (check.type !== "qa") return null;
  if (oracle === "browser") {
    return result?.evidence?.browserPassed === true ? "passed" : null;
  }
  if (oracle === "screenshot") {
    return normalizeArtifactRefs(result?.evidence?.screenshotRefs).length > 0
      ? "passed"
      : null;
  }
  if (oracle === "accessibility") {
    return result?.evidence?.accessibilityPassed === true ? "passed" : null;
  }
  if (oracle === "keyboard") {
    return result?.evidence?.keyboardPassed === true ? "passed" : null;
  }
  if (oracle === "performance") {
    return result?.evidence?.performancePassed === true ? "passed" : null;
  }
  if (oracle === "visual") {
    return result?.evidence?.visualPassed === true ? "passed" : null;
  }
  return null;
}

function normalizeArtifactRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((ref) => /^qaart_[a-f0-9]{64}$/.test(String(ref ?? "")))
    .slice(0, 100);
}

export function acceptancePassed(graph, sourceRevision) {
  const normalized = normalizeStoredGraph(graph, {
    checks: checksDeclaredByGraph(graph)
  });
  if (!normalized || normalized.sourceRevision !== sourceRevision) return false;
  if (normalized.status !== "passed") return false;
  const summary = summarizeCriteria(
    normalized.criteria,
    normalized.evidence,
    sourceRevision
  );
  return summary.failed === 0
    && summary.required > 0
    && summary.requiredPassed === summary.required;
}

export function normalizeStoredGraph(value, {
  objective = "",
  criteria = null,
  checks = []
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (criteria || (Array.isArray(checks) && checks.length > 0)) {
      try {
        return createAcceptanceGraph({
          objective,
          criteria,
          checks,
          allowLegacy: true
        });
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    const validationChecks = Array.isArray(checks) && checks.length > 0
      ? checks
      : checksDeclaredByGraph(value);
    const normalizedCriteria = normalizeAcceptanceCriteria(
      value.criteria,
      validationChecks,
      { allowLegacy: false }
    );
    const sourceRevision = value.sourceRevision == null
      ? null
      : String(value.sourceRevision);
    if (sourceRevision !== null && !SOURCE_REVISION_RE.test(sourceRevision)) {
      return null;
    }
    const evidence = normalizeStoredEvidence(
      value.evidence,
      normalizedCriteria,
      sourceRevision
    );
    const summary = summarizeCriteria(
      normalizedCriteria,
      evidence,
      sourceRevision
    );
    const status = summary.failed > 0
      ? "failed"
      : sourceRevision
        && summary.required > 0
        && summary.requiredPassed === summary.required
        ? "passed"
        : "pending";
    const expectedIntentDigest = digestCanonical({
      objective: String(objective ?? ""),
      criteria: normalizedCriteria
    });
    if (
      String(objective ?? "") !== ""
      && value.intentDigest !== expectedIntentDigest
    ) {
      return null;
    }
    return {
      version: 1,
      intentDigest: String(value.intentDigest ?? expectedIntentDigest),
      status,
      sourceRevision,
      criteria: normalizedCriteria,
      evidence,
      summary
    };
  } catch {
    return null;
  }
}

function checksDeclaredByGraph(value) {
  const ids = new Set();
  for (const criterion of value?.criteria ?? []) {
    for (const checkId of criterion?.checkIds ?? []) {
      ids.add(String(checkId ?? ""));
    }
  }
  return [...ids].map((id) => ({ id }));
}

export function criteriaEqual(left, right) {
  return digestCanonical(left ?? []) === digestCanonical(right ?? []);
}

function normalizeStoredEvidence(value, criteria, sourceRevision) {
  if (!Array.isArray(value)) return [];
  const criterionById = new Map(criteria.map((criterion) => [
    criterion.id,
    criterion
  ]));
  const records = [];
  for (const raw of value.slice(0, MAX_CRITERIA * MAX_CHECK_IDS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const criterion = criterionById.get(String(raw.criterionId ?? ""));
    const checkId = String(raw.checkId ?? "");
    const recordRevision = String(raw.sourceRevision ?? "");
    if (
      !criterion
      || !criterion.checkIds.includes(checkId)
      || raw.oracle !== criterion.oracle
      || !["passed", "failed"].includes(raw.status)
      || !SOURCE_REVISION_RE.test(recordRevision)
      || (sourceRevision && recordRevision !== sourceRevision)
    ) {
      continue;
    }
    records.push(structuredClone(raw));
  }
  return records;
}

function summarizeCriteria(criteria, evidence, sourceRevision = null) {
  const current = evidence.filter(
    (record) => sourceRevision === null || record.sourceRevision === sourceRevision
  );
  let passed = 0;
  let failed = 0;
  let required = 0;
  let requiredPassed = 0;
  const items = criteria.map((criterion) => {
    if (criterion.required) required += 1;
    const records = current.filter(
      (record) => record.criterionId === criterion.id
    );
    const hasFailure = records.some(
      (record) => record.deterministic === true && record.status === "failed"
    );
    const passedChecks = new Set(
      records
        .filter((record) => record.status === "passed")
        .map((record) => record.checkId)
    );
    const hasAllEvidence = criterion.checkIds.every((id) => passedChecks.has(id));
    const status = hasFailure ? "failed" : hasAllEvidence ? "passed" : "pending";
    if (status === "passed") {
      passed += 1;
      if (criterion.required) requiredPassed += 1;
    } else if (status === "failed") {
      failed += 1;
    }
    return {
      id: criterion.id,
      required: criterion.required,
      status,
      evidenceCount: records.length
    };
  });
  return {
    total: criteria.length,
    required,
    passed,
    failed,
    pending: criteria.length - passed - failed,
    requiredPassed,
    items
  };
}

function legacyCriteria(checks) {
  return checks.map((check, index) => Object.freeze({
    id: `legacy_check_${index + 1}`,
    statement: `Legacy verification check ${index + 1} must pass.`,
    kind: "compatibility",
    oracle: "test",
    required: true,
    checkIds: Object.freeze([check.id])
  }));
}

function normalizeThreshold(value, id) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    return boundedText(value, `Acceptance criterion ${id} threshold`, MAX_TARGET);
  }
  throw new TypeError(`Acceptance criterion ${id} has an invalid threshold.`);
}

function boundedText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return text;
}

function digestCanonical(value) {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const ACCEPTANCE_EVIDENCE_LIMITS = Object.freeze({
  maxCriteria: MAX_CRITERIA,
  maxCheckIds: MAX_CHECK_IDS,
  maxStatement: MAX_STATEMENT,
  maxTarget: MAX_TARGET
});

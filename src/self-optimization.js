/*
 * Clean-room self-optimization safety primitives.
 *
 * This module was implemented only from the behavioral requirements in
 * docs/plans/upgrade-batch-2026-07.md. No world-model-optimizer source was
 * cloned, fetched, inspected, copied, or vendored.
 */

import { createHash } from "node:crypto";
import { assistantClaimsCompletion } from "./completion-evidence.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const FAILURE_SIGNATURE_RE = /^failure-v1:[a-z0-9_]{1,48}:[a-f0-9]{20}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const SAFE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERIFY_TOOL_RE = /^(?:code_(?:lint|test|verify)|lsp_diagnostics|qa_run)$/;
const REQUIREMENTS_BY_KIND = Object.freeze({
  "code-change": Object.freeze(["mutation", "verification"]),
  "ui-change": Object.freeze(["mutation", "verification", "visual"]),
  "ui-verification": Object.freeze(["verification", "visual"]),
  verification: Object.freeze(["verification"])
});
const REQUIREMENT_NAMES = new Set(["mutation", "verification", "visual"]);
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_DELTAS = 32;

export class SelfOptimizationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SelfOptimizationError";
    this.code = code;
    this.details = details;
  }
}

export function selfOptimizationEnabled(env = process.env) {
  return String(env?.OPENAGI_SELF_OPTIMIZATION ?? "").trim() === "1";
}

export function createOptionalSelfOptimizationController(options = {}) {
  const env = options.env ?? process.env;
  if (!selfOptimizationEnabled(env)) return null;
  return new SelfOptimizationController(options);
}

export class SelfOptimizationController {
  hashSurface(value) {
    return surfaceHash(value);
  }

  snapshot(targets, resolveSurface) {
    return snapshotSurfaces(targets, resolveSurface);
  }

  applyDelta(options) {
    return applyDelta(options);
  }

  judgeCompletion(options) {
    return evidenceBackedReward(options);
  }

  selectCandidate(incumbent, successors) {
    return selectStrictImprovement(incumbent, successors);
  }

  rewardForOutcome(outcome) {
    const reward = outcome?.metadata?.selfOptimization;
    if (
      reward?.version !== 1
      || !Number.isFinite(reward.score)
      || reward.score < 0
      || reward.score > 1
    ) {
      return null;
    }
    return reward.score;
  }

  failureClusters(outcomes, limit = 50) {
    const boundedLimit = boundedInteger(limit, 1, 500, 50);
    const clusters = new Map();
    for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
      const reward = outcome?.metadata?.selfOptimization;
      const signature = String(reward?.failureSignature ?? "");
      if (!FAILURE_SIGNATURE_RE.test(signature)) continue;
      const current = clusters.get(signature) ?? {
        signature,
        count: 0,
        totalReward: 0,
        lastAt: null
      };
      current.count += 1;
      current.totalReward += Number.isFinite(reward.score) ? reward.score : 0;
      const at = typeof outcome?.at === "string" ? outcome.at : null;
      if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
      clusters.set(signature, current);
    }
    return [...clusters.values()]
      .sort((left, right) => (
        right.count - left.count
        || left.signature.localeCompare(right.signature)
      ))
      .slice(0, boundedLimit)
      .map((cluster) => ({
        signature: cluster.signature,
        count: cluster.count,
        averageReward: Number((cluster.totalReward / cluster.count).toFixed(6)),
        lastAt: cluster.lastAt
      }));
  }
}

export function surfaceHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function snapshotSurfaces(targets, resolveSurface) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_DELTAS) {
    throw new SelfOptimizationError(
      `Surface snapshot requires 1-${MAX_DELTAS} targets.`,
      "self_opt_targets_invalid"
    );
  }
  if (typeof resolveSurface !== "function") {
    throw new SelfOptimizationError(
      "Surface snapshot requires a resolver.",
      "self_opt_resolver_missing"
    );
  }
  const snapshots = [];
  const identities = new Set();
  for (const target of targets) {
    const selector = boundedSelector(target);
    const surface = normalizeSurface(resolveSurface(selector));
    if (identities.has(surface.identity.surfaceId)) {
      throw new SelfOptimizationError(
        `Surface '${surface.identity.surfaceId}' was resolved more than once.`,
        "self_opt_target_duplicate",
        { identity: surface.identity }
      );
    }
    identities.add(surface.identity.surfaceId);
    snapshots.push(Object.freeze({
      identity: surface.identity,
      hash: surfaceHash(surface.value),
      value: cloneCanonical(surface.value)
    }));
  }
  return Object.freeze(snapshots);
}

export function applyDelta({
  deltas,
  resolveSurface,
  commit
} = {}) {
  if (!Array.isArray(deltas) || deltas.length === 0 || deltas.length > MAX_DELTAS) {
    throw new SelfOptimizationError(
      `applyDelta requires 1-${MAX_DELTAS} deltas.`,
      "self_opt_deltas_invalid"
    );
  }
  if (typeof resolveSurface !== "function") {
    throw new SelfOptimizationError(
      "applyDelta requires a surface resolver.",
      "self_opt_resolver_missing"
    );
  }
  if (typeof commit !== "function") {
    throw new SelfOptimizationError(
      "applyDelta requires one atomic commit callback.",
      "self_opt_commit_missing"
    );
  }

  const prepared = [];
  const identities = new Set();
  for (const rawDelta of deltas) {
    const delta = normalizeDelta(rawDelta);
    const surface = normalizeSurface(resolveSurface(delta.target));
    const surfaceId = surface.identity.surfaceId;
    if (identities.has(surfaceId)) {
      throw new SelfOptimizationError(
        `Surface '${surfaceId}' cannot appear twice in one delta set.`,
        "self_opt_target_duplicate",
        { identity: surface.identity }
      );
    }
    identities.add(surfaceId);
    const currentHash = surfaceHash(surface.value);
    if (delta.expectedHash !== currentHash) {
      throw new SelfOptimizationError(
        `Surface '${surfaceId}' changed after the proposal was prepared.`,
        "self_opt_hash_mismatch",
        {
          identity: surface.identity,
          expectedHash: delta.expectedHash,
          currentHash
        }
      );
    }
    const nextValue = cloneCanonical(delta.value);
    prepared.push(Object.freeze({
      identity: surface.identity,
      previousHash: currentHash,
      nextHash: surfaceHash(nextValue),
      previousValue: cloneCanonical(surface.value),
      nextValue
    }));
  }

  // No callback is invoked until every target and hash has passed. The caller
  // gets the full prepared set once so its own durable write can be atomic.
  const commitResult = commit(Object.freeze(prepared));
  if (commitResult && typeof commitResult.then === "function") {
    throw new SelfOptimizationError(
      "applyDelta commit callbacks must be synchronous and atomic.",
      "self_opt_async_commit"
    );
  }
  return Object.freeze({
    applied: true,
    surfaces: Object.freeze(prepared.map((entry) => Object.freeze({
      identity: entry.identity,
      previousHash: entry.previousHash,
      nextHash: entry.nextHash
    }))),
    commitResult
  });
}

export function gradedTestScore(summary) {
  const normalized = normalizeGradedTests(summary);
  if (!normalized) return null;
  return normalized.score;
}

export function evidenceBackedReward({
  completionEvidence,
  assistantText = "",
  toolCalls = [],
  gradedTests = null
} = {}) {
  const report = normalizeCompletionEvidence(completionEvidence);
  if (!report) return null;
  const required = REQUIREMENTS_BY_KIND[report.kind];
  const missing = new Set(report.missing);
  const passedRequirements = required.filter((name) => !missing.has(name)).length;
  const evidenceScore = passedRequirements / required.length;
  const tests = normalizeGradedTests(gradedTests) ?? gradedTestsFromToolCalls(toolCalls);
  const claimsCompletion = assistantClaimsCompletion(assistantText);
  const unsupportedClaim = report.status !== "verified" && claimsCompletion;
  const score = unsupportedClaim
    ? 0
    : tests
      ? mean([evidenceScore, tests.score])
      : evidenceScore;
  const verdict = unsupportedClaim
    ? "unsupported_completion_claim"
    : report.status === "verified" && (!tests || tests.score === 1)
      ? "verified"
      : score > 0
        ? "partial"
        : "unverified";
  const failureSignature = score < 1
    ? deterministicFailureSignature({
        category: unsupportedClaim
          ? "unsupported_completion_claim"
          : tests && tests.score < 1
            ? "graded_verification_failure"
            : "missing_completion_evidence",
        status: report.status,
        code: unsupportedClaim ? "claim_without_evidence" : "evidence_incomplete",
        missing: report.missing,
        tests,
        toolFailures: structuredToolFailures(toolCalls)
      })
    : null;
  return Object.freeze({
    version: 1,
    score: Number(score.toFixed(6)),
    verdict,
    claimsCompletion,
    passedRequirements,
    totalRequirements: required.length,
    gradedTests: tests
      ? Object.freeze({
          passed: tests.passed,
          total: tests.total,
          score: tests.score
        })
      : null,
    failureSignature
  });
}

export function deterministicFailureSignature(structured = {}) {
  const category = safeToken(structured.category, "unknown_failure");
  const normalized = {
    category,
    status: safeToken(structured.status, "unknown"),
    code: safeToken(structured.code, "unknown"),
    missing: normalizeMissing(structured.missing),
    tests: normalizeGradedTests(structured.tests),
    toolFailures: normalizeToolFailures(structured.toolFailures)
  };
  const hash = createHash("sha256").update(canonicalJson(normalized)).digest("hex");
  return `failure-v1:${category}:${hash.slice(0, 20)}`;
}

export function selectStrictImprovement(incumbent, successors = []) {
  const incumbentScore = finiteScore(incumbent?.score, "incumbent");
  let best = incumbent;
  let bestScore = incumbentScore;
  for (const candidate of Array.isArray(successors) ? successors : []) {
    const score = Number(candidate?.score);
    if (!Number.isFinite(score)) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function canonicalJson(value) {
  const state = { ancestors: new Set(), nodes: 0 };
  const encoded = encodeCanonical(value, state, 0);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_BYTES) {
    throw new SelfOptimizationError(
      "Self-optimization surface exceeds the canonical byte limit.",
      "self_opt_surface_too_large"
    );
  }
  return encoded;
}

function encodeCanonical(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw new SelfOptimizationError(
      "Self-optimization surface exceeds structural limits.",
      "self_opt_surface_too_complex"
    );
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SelfOptimizationError(
        "Self-optimization surfaces require finite numbers.",
        "self_opt_surface_invalid"
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object") {
    throw new SelfOptimizationError(
      "Self-optimization surfaces must be JSON-compatible.",
      "self_opt_surface_invalid"
    );
  }
  if (state.ancestors.has(value)) {
    throw new SelfOptimizationError(
      "Self-optimization surfaces cannot contain cycles.",
      "self_opt_surface_cycle"
    );
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length
        || keys.some((key, index) => key !== String(index))
      ) {
        throw new SelfOptimizationError(
          "Self-optimization arrays must be dense and unadorned.",
          "self_opt_surface_invalid"
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new SelfOptimizationError(
            "Self-optimization surfaces cannot contain accessors.",
            "self_opt_surface_accessor"
          );
        }
        items.push(encodeCanonical(descriptor.value, state, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SelfOptimizationError(
        "Self-optimization surfaces require plain objects.",
        "self_opt_surface_invalid"
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new SelfOptimizationError(
        "Self-optimization surfaces cannot contain symbol fields.",
        "self_opt_surface_invalid"
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const fields = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new SelfOptimizationError(
          "Self-optimization surfaces require enumerable data fields.",
          "self_opt_surface_accessor"
        );
      }
      fields.push(`${JSON.stringify(key)}:${encodeCanonical(descriptor.value, state, depth + 1)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function cloneCanonical(value) {
  return JSON.parse(canonicalJson(value));
}

function normalizeSurface(value) {
  if (!isPlainRecord(value) || !Object.hasOwn(value, "value")) {
    throw new SelfOptimizationError(
      "A surface resolver must return { id, kind, value }.",
      "self_opt_surface_missing"
    );
  }
  const surfaceId = safeIdentity(value.id, "surface id");
  const surfaceKind = safeIdentity(value.kind, "surface kind");
  return {
    identity: Object.freeze({ surfaceId, surfaceKind }),
    value: cloneCanonical(value.value)
  };
}

function normalizeDelta(value) {
  if (!isPlainRecord(value)) {
    throw new SelfOptimizationError(
      "Each delta must be an object.",
      "self_opt_delta_invalid"
    );
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3
    || keys[0] !== "expectedHash"
    || keys[1] !== "target"
    || keys[2] !== "value"
  ) {
    throw new SelfOptimizationError(
      "Each delta accepts only target, expectedHash, and value; identity comes from the resolver.",
      "self_opt_delta_identity_untrusted"
    );
  }
  const target = boundedSelector(value.target);
  const expectedHash = String(value.expectedHash ?? "");
  if (!HASH_RE.test(expectedHash)) {
    throw new SelfOptimizationError(
      "Each delta must echo an exact lowercase SHA-256 surface hash.",
      "self_opt_hash_invalid"
    );
  }
  return {
    target,
    expectedHash,
    value: cloneCanonical(value.value)
  };
}

function normalizeCompletionEvidence(value) {
  if (!isPlainRecord(value) || value.version !== 1 || value.required !== true) return null;
  const required = REQUIREMENTS_BY_KIND[value.kind];
  if (!required || !["verified", "incomplete"].includes(value.status)) return null;
  for (const field of ["mutationCount", "verificationCount", "visualCount"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
  }
  if (
    !Array.isArray(value.missing)
    || value.missing.some((name) => !REQUIREMENT_NAMES.has(name))
  ) {
    return null;
  }
  const missing = normalizeMissing(value.missing);
  if (missing.some((name) => !required.includes(name))) return null;
  const available = {
    mutation: value.mutationCount > 0,
    verification: value.verificationCount > 0,
    visual: value.visualCount > 0
  };
  const derivedMissing = required.filter((name) => !available[name]).sort();
  if (canonicalJson(missing) !== canonicalJson(derivedMissing)) return null;
  if (value.status === "verified" && missing.length > 0) return null;
  if (value.status === "incomplete" && missing.length === 0) return null;
  return {
    kind: value.kind,
    status: value.status,
    missing
  };
}

function gradedTestsFromToolCalls(toolCalls) {
  let passed = 0;
  let total = 0;
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(call?.name ?? "");
    if (!VERIFY_TOOL_RE.test(name)) continue;
    const payload = call?.result?.result;
    const direct = normalizeGradedTests(payload);
    if (direct) {
      passed += direct.passed;
      total += direct.total;
      continue;
    }
    if (!Array.isArray(payload?.results) || payload.results.length === 0) continue;
    total += payload.results.length;
    passed += payload.results.filter((result) => structuredPass(result)).length;
  }
  return total > 0 ? normalizeGradedTests({ passed, total }) : null;
}

function structuredPass(value) {
  if (!value || typeof value !== "object") return value === true;
  if (value.ok === true || value.passed === true || value.success === true) return true;
  return ["ok", "passed", "success", "succeeded"].includes(
    String(value.status ?? "").trim().toLowerCase()
  );
}

function structuredToolFailures(toolCalls) {
  const failures = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const invocation = call?.result;
    const status = invocation?.outcome?.status
      ?? (invocation?.ok === false ? "failed" : "succeeded");
    if (String(status).toLowerCase() === "succeeded" && invocation?.ok !== false) continue;
    failures.push({
      tool: safeToken(call?.name, "unknown_tool"),
      status: safeToken(status, "failed"),
      code: safeToken(
        invocation?.outcome?.code ?? invocation?.error?.code,
        "unknown"
      )
    });
  }
  return failures;
}

function normalizeToolFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((failure) => ({
    tool: safeToken(failure?.tool, "unknown_tool"),
    status: safeToken(failure?.status, "failed"),
    code: safeToken(failure?.code, "unknown")
  })).sort((left, right) => (
    left.tool.localeCompare(right.tool)
    || left.status.localeCompare(right.status)
    || left.code.localeCompare(right.code)
  ));
}

function normalizeGradedTests(value) {
  if (!value || typeof value !== "object") return null;
  const passed = Number(value.passed);
  const total = Number(value.total);
  if (
    !Number.isSafeInteger(passed)
    || !Number.isSafeInteger(total)
    || total <= 0
    || total > 1_000_000
    || passed < 0
    || passed > total
  ) {
    return null;
  }
  return {
    passed,
    total,
    score: Number((passed / total).toFixed(6))
  };
}

function normalizeMissing(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((name) => REQUIREMENT_NAMES.has(name))
      .sort()
  )];
}

function safeIdentity(value, label) {
  const text = String(value ?? "");
  if (!SAFE_ID_RE.test(text)) {
    throw new SelfOptimizationError(
      `Resolved ${label} is invalid.`,
      "self_opt_identity_invalid"
    );
  }
  return text;
}

function boundedSelector(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new SelfOptimizationError(
      "Delta targets must be bounded printable strings.",
      "self_opt_target_invalid"
    );
  }
  return text;
}

function safeToken(value, fallback) {
  const text = String(value ?? "").trim();
  return SAFE_TOKEN_RE.test(text) ? text.toLowerCase() : fallback;
}

function finiteScore(value, label) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    throw new SelfOptimizationError(
      `${label} requires a finite score.`,
      "self_opt_score_invalid"
    );
  }
  return score;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function isPlainRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

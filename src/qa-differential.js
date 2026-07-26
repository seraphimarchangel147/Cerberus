import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

const COMPARISON_ID_RE = /^qacmp_[a-f0-9]{16}$/;
const RUN_ID_RE = /^qa_[a-f0-9]{16}$/;
const ARTIFACT_REF_RE = /^qaart_[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ASCII_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const EXTENDED_ID_RE = /^[a-z][a-z0-9_-]{0,127}$/;
const ORACLES = new Set([
  "accessibility",
  "behavior",
  "diagnostics",
  "keyboard",
  "state_graph",
  "visual"
]);
const EXPECTATIONS = new Set(["change", "preserve", "review"]);
const CLASSIFICATIONS = new Set([
  "improvement_candidate",
  "intended",
  "regression",
  "review_required"
]);
const STATUSES = new Set(["failed", "passed", "review_required"]);
const VISUAL_FAILURE_CODES = new Set([
  "visual_baseline_missing",
  "visual_regression",
  "visual_size_changed"
]);
const MAX_CRITERIA = 32;
const MAX_COMPARISONS = 1_000;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const COMPACT_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_GRAPH_BYTES = 4 * 1024 * 1024;
const MISSING_SCORE = 1_000_000;

export function normalizeQaIntent(value, { routes, viewports } = {}) {
  if (value == null) {
    return { version: 1, fixtureRevision: null, criteria: [] };
  }
  if (!isRecord(value) || (value.version ?? 1) !== 1) {
    throw new TypeError("QA intent requires version 1.");
  }
  if (
    !Array.isArray(value.criteria)
    || value.criteria.length < 1
    || value.criteria.length > MAX_CRITERIA
  ) {
    throw new TypeError(`QA intent requires 1-${MAX_CRITERIA} criteria.`);
  }
  const fixtureRevision = String(value.fixtureRevision ?? "").trim();
  if (
    !fixtureRevision
    || fixtureRevision.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fixtureRevision)
  ) {
    throw new TypeError(
      "QA intent requires an ASCII fixtureRevision for differential replay."
    );
  }
  const routeMap = new Map((routes ?? []).map((route) => [route.id, route]));
  const viewportIds = new Set((viewports ?? []).map((viewport) => viewport.id));
  const ids = new Set();
  const criteria = value.criteria.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`QA intent criterion ${index + 1} is invalid.`);
    }
    const id = requiredId(raw.id, `intent criterion ${index + 1}`);
    if (ids.has(id)) throw new TypeError(`Duplicate QA intent id: ${id}`);
    ids.add(id);
    const statement = boundedText(
      raw.statement,
      `QA intent criterion '${id}' statement`,
      1_000
    );
    const oracle = String(raw.oracle ?? "").trim().toLowerCase();
    if (!ORACLES.has(oracle)) {
      throw new TypeError(`QA intent criterion '${id}' has an invalid oracle.`);
    }
    const expectation = String(raw.expectation ?? "preserve")
      .trim()
      .toLowerCase();
    if (!EXPECTATIONS.has(expectation)) {
      throw new TypeError(
        `QA intent criterion '${id}' has an invalid expectation.`
      );
    }
    const routeId = requiredId(raw.routeId, `intent criterion '${id}' route`);
    const route = routeMap.get(routeId);
    if (!route) {
      throw new TypeError(
        `QA intent criterion '${id}' references an unknown route.`
      );
    }
    const viewportId = raw.viewportId == null
      ? null
      : requiredId(raw.viewportId, `intent criterion '${id}' viewport`);
    if (viewportId !== null && !viewportIds.has(viewportId)) {
      throw new TypeError(
        `QA intent criterion '${id}' references an unknown viewport.`
      );
    }
    const controlId = raw.controlId == null
      ? null
      : requiredId(raw.controlId, `intent criterion '${id}' control`);
    if (
      controlId !== null
      && !route.controls.some((control) => control.id === controlId)
    ) {
      throw new TypeError(
        `QA intent criterion '${id}' references an unknown route control.`
      );
    }
    return {
      id,
      statement,
      oracle,
      expectation,
      required: raw.required !== false,
      routeId,
      ...(viewportId === null ? {} : { viewportId }),
      ...(controlId === null ? {} : { controlId })
    };
  });
  return { version: 1, fixtureRevision, criteria };
}

export class QaComparisonStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(
        options.dataDir ?? resolveDataDir(),
        "qa-runs",
        "comparisons"
      )
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.rewriteJournal = options.rewriteJournal ?? writeTextAtomic;
    this.now = options.now ?? nowIso;
    this.records = new Map();
    this.journalHealthy = true;
    ensureDir(this.dir);
    this._load();
  }

  create(input) {
    if (!this.journalHealthy) {
      throw new Error(
        "QA comparison journal has a corrupt suffix; refusing to append."
      );
    }
    const record = normalizeComparison({
      version: 1,
      ...structuredClone(input),
      id: input.id ?? createId("qacmp"),
      createdAt: input.createdAt ?? this.now()
    });
    if (!record) throw new TypeError("QA comparison is invalid.");
    if (this.records.has(record.id)) {
      throw new Error(`QA comparison already exists: ${record.id}`);
    }
    const event = {
      version: 1,
      op: "create",
      at: record.createdAt,
      comparison: record
    };
    this.appendEvent(this.eventsPath, event);
    this.records.set(record.id, record);
    this._trim();
    this._compactJournalIfNeeded();
    this._writeSnapshot();
    return structuredClone(record);
  }

  get(id) {
    const record = this.records.get(String(id ?? ""));
    return record ? structuredClone(record) : null;
  }

  list({ projectId, sessionId, limit = 50 } = {}) {
    return [...this.records.values()]
      .filter((record) => (
        projectId == null || record.projectId === String(projectId)
      ))
      .filter((record) => (
        sessionId == null || record.sessionId === String(sessionId)
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedInteger(limit, 1, 100, 50))
      .map((record) => structuredClone(record));
  }

  findByInput({ projectId, sessionId, inputDigest }) {
    const digest = String(inputDigest ?? "");
    if (!SHA256_RE.test(digest)) return null;
    const record = [...this.records.values()]
      .filter((candidate) => (
        candidate.projectId === String(projectId)
        && candidate.sessionId === String(sessionId)
        && candidate.inputDigest === digest
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return record ? structuredClone(record) : null;
  }

  _load() {
    const journal = readJournal(this.eventsPath);
    this.journalHealthy = journal.complete;
    if (journal.exists) {
      for (const event of journal.events) {
        if (event?.version !== 1 || event.op !== "create") continue;
        const record = normalizeComparison(event.comparison);
        if (record) this.records.set(record.id, record);
      }
    } else {
      let snapshot = null;
      try {
        snapshot = readJsonFile(this.snapshotPath, null);
      } catch {
        snapshot = null;
      }
      for (const candidate of snapshot?.comparisons ?? []) {
        const record = normalizeComparison(candidate);
        if (record) this.records.set(record.id, record);
      }
    }
    this._trim();
  }

  _trim() {
    if (this.records.size <= MAX_COMPARISONS) return;
    const retained = [...this.records.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_COMPARISONS);
    this.records = new Map(retained.map((record) => [record.id, record]));
  }

  _writeSnapshot() {
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: this.now(),
        comparisons: [...this.records.values()]
      });
    } catch {
      // The fsynced JSONL create event is authoritative.
    }
  }

  _compactJournalIfNeeded() {
    let size = 0;
    try {
      size = fs.lstatSync(this.eventsPath).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (size <= COMPACT_JOURNAL_BYTES) return;
    const events = [...this.records.values()].map((comparison) => ({
      version: 1,
      op: "create",
      at: comparison.createdAt,
      comparison
    }));
    this.rewriteJournal(
      this.eventsPath,
      events.length > 0
        ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
        : ""
    );
  }
}

export class QaDifferentialAnalyzer {
  constructor({ artifacts, baselines, comparisons } = {}) {
    if (!artifacts || !baselines || !comparisons) {
      throw new TypeError(
        "QA differential analysis requires artifact, baseline, and comparison stores."
      );
    }
    this.artifacts = artifacts;
    this.baselines = baselines;
    this.comparisons = comparisons;
  }

  compare({ reference, candidate }) {
    assertCompatibleRuns(reference, candidate);
    const criteria = candidate.manifest.intent?.criteria ?? [];
    if (criteria.length < 1) {
      throw new Error(
        "QA comparison requires immutable manifest intent criteria."
      );
    }
    const outcomes = criteria.map((criterion) => this._evaluateCriterion(
      criterion,
      reference,
      candidate
    ));
    const implementation = this._implementationAssessment(candidate);
    const hypotheses = outcomes
      .filter((outcome) => outcome.classification !== "intended")
      .map(hypothesisForOutcome);
    if (!implementation.passed) {
      hypotheses.unshift({
        id: "hyp_implementation_evidence",
        code: "candidate_implementation_failed",
        criterionId: null,
        classification: "regression",
        basis: implementation.basis,
        evidenceRefs: implementation.evidenceRefs
      });
    }
    const summary = summarizeOutcomes(outcomes);
    const status = !implementation.passed
      || outcomes.some((outcome) => (
        outcome.required && outcome.classification === "regression"
      ))
      ? "failed"
      : outcomes.some((outcome) => outcome.classification !== "intended")
        ? "review_required"
        : "passed";
    const inputDigest = digestCanonical({
      reference: {
        runId: reference.id,
        sourceRevision: reference.sourceRevision
      },
      candidate: {
        runId: candidate.id,
        sourceRevision: candidate.sourceRevision
      },
      manifestDigest: candidate.manifest.digest,
      mode: candidate.mode,
      implementation,
      criteria: outcomes
    });
    const existing = this.comparisons.findByInput({
      projectId: candidate.projectId,
      sessionId: candidate.sessionId,
      inputDigest
    });
    if (existing) return existing;
    const id = createId("qacmp");
    const report = {
      version: 1,
      id,
      status,
      projectId: candidate.projectId,
      reference: {
        runId: reference.id,
        sourceRevision: reference.sourceRevision
      },
      candidate: {
        runId: candidate.id,
        sourceRevision: candidate.sourceRevision
      },
      manifestDigest: candidate.manifest.digest,
      mode: candidate.mode,
      inputDigest,
      implementation,
      criteria: outcomes,
      summary,
      hypotheses
    };
    const artifact = this.artifacts.put(
      Buffer.from(JSON.stringify(report), "utf8"),
      {
        projectId: candidate.projectId,
        runId: candidate.id,
        kind: "differential_report",
        mediaType: "application/json",
        retention: status === "passed" ? "success" : "failure"
      }
    );
    return this.comparisons.create({
      ...report,
      sessionId: candidate.sessionId,
      workspaceRoot: candidate.workspaceRoot,
      artifactRef: artifact.ref
    });
  }

  _evaluateCriterion(criterion, reference, candidate) {
    const referenceMetric = this._metric(reference, criterion);
    const candidateMetric = this._metric(candidate, criterion);
    const changed = referenceMetric.digest !== candidateMetric.digest;
    const direction = !candidateMetric.available
      ? "worse"
      : !referenceMetric.available
        ? "better"
        : candidateMetric.rows.length < referenceMetric.rows.length
          ? "worse"
          : candidateMetric.score > referenceMetric.score
            ? "worse"
            : candidateMetric.score < referenceMetric.score
              ? "better"
              : changed
                ? "neutral"
                : "same";
    const humanApproved = criterion.oracle === "visual"
      && changed
      && this._visualChangeApproved(
        referenceMetric.rows,
        candidateMetric.rows,
        candidate
      );
    const decision = classifyCriterion({
      criterion,
      changed,
      direction,
      humanApproved,
      candidateAvailable: candidateMetric.available
    });
    return {
      id: criterion.id,
      oracle: criterion.oracle,
      expectation: criterion.expectation,
      required: criterion.required,
      scope: {
        routeId: criterion.routeId,
        viewportId: criterion.viewportId ?? null,
        controlId: criterion.controlId ?? null
      },
      classification: decision.classification,
      basis: decision.basis,
      observed: {
        changed,
        direction,
        humanApproved,
        referenceScore: referenceMetric.score,
        candidateScore: candidateMetric.score,
        referenceDigest: referenceMetric.digest,
        candidateDigest: candidateMetric.digest
      },
      evidenceRefs: uniqueArtifactRefs([
        ...referenceMetric.evidenceRefs,
        ...candidateMetric.evidenceRefs
      ])
    };
  }

  _metric(run, criterion) {
    const results = scopedResults(run, criterion);
    if (criterion.oracle === "state_graph") {
      return this._stateGraphMetric(run, criterion, results);
    }
    if (criterion.oracle === "visual") {
      const rows = results
        .filter((result) => result.kind !== "exploration")
        .map((result) => ({
          key: resultKey(result),
          screenshotRef: artifactRef(result.screenshotRef)
        }))
        .filter((row) => row.screenshotRef);
      return metricFromRows(rows, {
        score: rows.length > 0 ? 0 : MISSING_SCORE,
        evidenceRefs: rows.map((row) => row.screenshotRef)
      });
    }
    if (criterion.oracle === "accessibility") {
      const rows = results.map((result) => ({
        key: resultKey(result),
        supported: result.accessibility?.supported === true,
        violations: safeCount(result.accessibility?.violations),
        incomplete: safeCount(result.accessibility?.incomplete)
      }));
      const score = rows.length < 1
        ? MISSING_SCORE
        : rows.reduce((sum, row) => (
            sum
            + (row.supported ? 0 : 10_000)
            + (row.violations * 100)
            + row.incomplete
          ), 0);
      return metricFromRows(rows, {
        score,
        evidenceRefs: evidenceForResults(results)
      });
    }
    if (criterion.oracle === "keyboard") {
      const rows = results.map((result) => ({
        key: resultKey(result),
        supported: result.keyboard?.supported === true,
        missing: safeCount(result.keyboard?.missing),
        focusVisibleFailures: safeCount(
          result.keyboard?.focusVisibleFailures
        ),
        trapped: result.keyboard?.trapped === true
      }));
      const score = rows.length < 1
        ? MISSING_SCORE
        : rows.reduce((sum, row) => (
            sum
            + (row.supported ? 0 : 10_000)
            + (row.trapped ? 1_000 : 0)
            + (row.missing * 100)
            + (row.focusVisibleFailures * 100)
          ), 0);
      return metricFromRows(rows, {
        score,
        evidenceRefs: evidenceForResults(results)
      });
    }
    if (criterion.oracle === "diagnostics") {
      const rows = results.map((result) => ({
        key: resultKey(result),
        events: safeCount(result.diagnostics?.events),
        errors: safeCount(result.diagnostics?.errors),
        failureCodes: failureCodes(result).filter((code) => (
          code.startsWith("diagnostic_")
        ))
      }));
      const score = rows.length < 1
        ? MISSING_SCORE
        : rows.reduce((sum, row) => (
            sum + (row.errors * 100) + row.events
          ), 0);
      return metricFromRows(rows, {
        score,
        evidenceRefs: evidenceForResults(results)
      });
    }
    const rows = results.map((result) => {
      const codes = behaviorFailureCodes(result);
      return {
        key: resultKey(result),
        status: codes.length === 0 ? "passed" : "failed",
        failureCodes: codes
      };
    });
    const score = rows.length < 1
      ? MISSING_SCORE
      : rows.reduce((sum, row) => (
          sum
          + (row.status === "passed" ? 0 : 10_000)
          + row.failureCodes.length
        ), 0);
    return metricFromRows(rows, {
      score,
      evidenceRefs: evidenceForResults(results)
    });
  }

  _stateGraphMetric(run, criterion, results) {
    const graphResults = results.filter(
      (result) => result.kind === "exploration"
    );
    const rows = [];
    const evidenceRefs = [];
    let score = 0;
    for (const result of graphResults) {
      const graphRef = artifactRef(result.exploration?.graphRef);
      if (!graphRef) continue;
      evidenceRefs.push(graphRef);
      const graph = readGraph(this.artifacts, graphRef, run);
      if (!graph) {
        score += MISSING_SCORE;
        continue;
      }
      const transitions = graph.transitions
        .filter((edge) => (
          criterion.controlId == null
          || edge.controlId === criterion.controlId
        ))
        .map((edge) => {
          evidenceRefs.push(
            artifactRef(edge?.screenshotRef),
            artifactRef(edge?.traceRef),
            artifactRef(edge?.replayRef)
          );
          return {
            controlId: safeId(edge.controlId),
            action: safeId(edge.action),
            depth: safeCount(edge.depth),
            status: edge.status === "passed" ? "passed" : "failed",
            failureCodes: safeCodeList(edge.failureCodes)
          };
        })
        .sort(compareCanonical);
      const states = criterion.controlId == null
        ? graph.states.map((state) => ({
            depth: safeCount(state.depth),
            path: safeIdList(state.path),
            interactiveControls: safeCount(state.interactiveControls),
            busyCount: safeCount(state.busyCount),
            locationChanged: state.locationChanged === true
          })).sort(compareCanonical)
        : [];
      rows.push({
        key: resultKey(result),
        states,
        transitions,
        truncated: graph.truncated === true,
        truncationReason: safeId(graph.truncationReason)
      });
      score += transitions.filter((edge) => edge.status === "failed").length
        * 10_000;
      if (graph.truncated === true) score += 100_000;
    }
    if (rows.length < 1) score = MISSING_SCORE;
    return metricFromRows(rows, { score, evidenceRefs });
  }

  _implementationAssessment(candidate) {
    const resultFailures = [];
    const evidenceRefs = [];
    for (const result of candidate.results ?? []) {
      evidenceRefs.push(...evidenceForResults([result]));
      for (const failure of result.failures ?? []) {
        resultFailures.push({
          code: safeCode(failure?.code),
          approvedVisual: VISUAL_FAILURE_CODES.has(String(failure?.code))
            && this._resultHasCurrentApproval(candidate, result)
        });
      }
    }
    const unapproved = resultFailures.filter((failure) => (
      !failure.approvedVisual
    ));
    const passed = candidate.state === "passed"
      || (
        candidate.state === "failed"
        && resultFailures.length > 0
        && unapproved.length === 0
      );
    return {
      passed,
      candidateState: candidate.state,
      approvedVisualFailures: resultFailures.length - unapproved.length,
      unapprovedFailureCodes: [...new Set(
        unapproved.map((failure) => failure.code)
      )],
      basis: passed
        ? candidate.state === "passed"
          ? ["candidate_qa_passed"]
          : ["candidate_visual_failures_human_approved"]
        : candidate.error?.code
          ? [safeCode(candidate.error.code)]
          : ["candidate_qa_failed"],
      evidenceRefs: uniqueArtifactRefs(evidenceRefs)
    };
  }

  _visualChangeApproved(referenceRows, candidateRows, candidate) {
    const referenceByKey = new Map(referenceRows.map((row) => [
      row.key,
      row.screenshotRef
    ]));
    const changed = candidateRows.filter((row) => (
      row.screenshotRef
      && row.screenshotRef !== referenceByKey.get(row.key)
    ));
    if (changed.length < 1) return false;
    return changed.every((row) => {
      const result = (candidate.results ?? []).find(
        (entry) => resultKey(entry) === row.key
      );
      return result && this._resultHasCurrentApproval(candidate, result);
    });
  }

  _resultHasCurrentApproval(run, result) {
    if (!artifactRef(result?.screenshotRef)) return false;
    try {
      const baseline = this.baselines.get({
        projectId: run.projectId,
        manifestDigest: run.manifest.digest,
        resultId: result.id
      });
      return Boolean(
        baseline
        && baseline.sourceRevision === run.sourceRevision
        && baseline.screenshotRef === result.screenshotRef
      );
    } catch {
      return false;
    }
  }
}

function classifyCriterion({
  criterion,
  changed,
  direction,
  humanApproved,
  candidateAvailable
}) {
  if (!candidateAvailable) {
    return decision(
      "regression",
      "candidate_evidence_missing"
    );
  }
  if (direction === "worse") {
    return decision(
      "regression",
      "candidate_quality_worsened"
    );
  }
  if (criterion.expectation === "preserve") {
    if (!changed) return decision("intended", "preserved");
    if (direction === "better") {
      return decision(
        "improvement_candidate",
        "candidate_quality_improved"
      );
    }
    if (criterion.oracle === "visual") {
      return decision(
        "regression",
        "preserved_visual_changed"
      );
    }
    return decision(
      "review_required",
      "preserved_behavior_changed"
    );
  }
  if (criterion.expectation === "change") {
    if (!changed) {
      return decision(
        "regression",
        "expected_change_missing"
      );
    }
    if (criterion.oracle === "visual" && !humanApproved) {
      return decision(
        "review_required",
        "visual_change_not_human_approved"
      );
    }
    return decision(
      "intended",
      humanApproved ? "human_approved_change" : "deterministic_change_observed"
    );
  }
  if (!changed) return decision("intended", "no_review_delta");
  if (direction === "better") {
    return decision(
      "improvement_candidate",
      "candidate_quality_improved"
    );
  }
  if (criterion.oracle === "visual" && humanApproved) {
    return decision("intended", "human_approved_change");
  }
  return decision("review_required", "declared_review_delta");
}

function decision(classification, basis) {
  return {
    classification,
    basis: [basis]
  };
}

function hypothesisForOutcome(outcome) {
  const code = outcome.classification === "regression"
    ? outcome.basis.includes("expected_change_missing")
      ? "expected_change_missing"
      : `${outcome.oracle}_regression`
    : outcome.classification === "improvement_candidate"
      ? "possible_improvement"
      : outcome.basis.includes("visual_change_not_human_approved")
        ? "unapproved_visual_change"
        : "intent_review_required";
  return {
    id: `hyp_${outcome.id}`,
    code,
    criterionId: outcome.id,
    classification: outcome.classification,
    basis: outcome.basis,
    evidenceRefs: outcome.evidenceRefs
  };
}

function summarizeOutcomes(outcomes) {
  const summary = {
    total: outcomes.length,
    required: outcomes.filter((outcome) => outcome.required).length,
    intended: 0,
    regressions: 0,
    improvementCandidates: 0,
    reviewRequired: 0
  };
  for (const outcome of outcomes) {
    if (outcome.classification === "intended") summary.intended += 1;
    if (outcome.classification === "regression") summary.regressions += 1;
    if (outcome.classification === "improvement_candidate") {
      summary.improvementCandidates += 1;
    }
    if (outcome.classification === "review_required") {
      summary.reviewRequired += 1;
    }
  }
  return summary;
}

function assertCompatibleRuns(reference, candidate) {
  if (!reference || !candidate || reference.id === candidate.id) {
    throw new Error("QA comparison requires two distinct runs.");
  }
  if (reference.state !== "passed") {
    throw new Error("QA comparison reference run must have passed.");
  }
  if (!["passed", "failed"].includes(candidate.state)) {
    throw new Error("QA comparison candidate run is not terminal.");
  }
  if (
    reference.projectId !== candidate.projectId
    || reference.sessionId !== candidate.sessionId
    || path.resolve(reference.workspaceRoot) !== path.resolve(candidate.workspaceRoot)
  ) {
    throw new Error("QA comparison runs do not share one project session.");
  }
  if (
    reference.manifest?.digest !== candidate.manifest?.digest
    || reference.mode !== candidate.mode
  ) {
    throw new Error(
      "QA comparison requires the exact same manifest and run mode."
    );
  }
  if (
    typeof candidate.manifest?.intent?.fixtureRevision !== "string"
    || candidate.manifest.intent.fixtureRevision.length < 1
  ) {
    throw new Error(
      "QA comparison requires a declared immutable fixtureRevision."
    );
  }
  if (
    !SHA256_RE.test(String(reference.manifest?.executionFingerprint ?? ""))
    || reference.manifest.executionFingerprint
      !== candidate.manifest?.executionFingerprint
  ) {
    throw new Error(
      "QA comparison requires runs from the same browser execution epoch."
    );
  }
  if (reference.sourceRevision === candidate.sourceRevision) {
    throw new Error("QA comparison requires distinct source revisions.");
  }
  if (reference.createdAt > candidate.createdAt) {
    throw new Error("QA comparison reference must predate the candidate.");
  }
  if (
    !Array.isArray(reference.results)
    || reference.results.length < 1
    || !Array.isArray(candidate.results)
    || candidate.results.length < 1
  ) {
    throw new Error("QA comparison evidence is incomplete.");
  }
}

function scopedResults(run, criterion) {
  return (run.results ?? []).filter((result) => {
    if (result.routeId !== criterion.routeId) return false;
    if (
      criterion.viewportId != null
      && result.viewport?.id !== criterion.viewportId
    ) {
      return false;
    }
    if (criterion.oracle === "state_graph") {
      return result.kind === "exploration";
    }
    if (criterion.controlId != null) {
      return result.controlId === criterion.controlId;
    }
    return true;
  });
}

function metricFromRows(rows, { score, evidenceRefs }) {
  const normalizedRows = [...rows].sort(compareCanonical);
  return {
    available: normalizedRows.length > 0,
    rows: normalizedRows,
    score,
    digest: digestCanonical(normalizedRows),
    evidenceRefs: uniqueArtifactRefs(evidenceRefs)
  };
}

function readGraph(artifacts, ref, run) {
  try {
    const artifact = artifacts.read(ref, {
      projectId: run.projectId,
      runId: run.id,
      includeData: true,
      maxBytes: MAX_GRAPH_BYTES
    });
    if (
      artifact.mediaType !== "application/json"
      || artifact.encoding !== "utf8"
    ) {
      return null;
    }
    const graph = JSON.parse(artifact.data);
    if (
      !isRecord(graph)
      || graph.version !== 1
      || !Array.isArray(graph.states)
      || !Array.isArray(graph.transitions)
      || graph.states.length > 64
      || graph.transitions.length > 128
    ) {
      return null;
    }
    return graph;
  } catch {
    return null;
  }
}

function evidenceForResults(results) {
  return uniqueArtifactRefs(results.flatMap((result) => [
    result.screenshotRef,
    result.diagnosticsRef,
    result.traceRef,
    result.visual?.actualRef,
    result.visual?.baselineRef,
    result.visual?.diffRef,
    result.exploration?.graphRef,
    ...(result.exploration?.replayRefs ?? [])
  ]));
}

function resultKey(result) {
  return [
    safeId(result?.kind),
    safeId(result?.routeId),
    safeId(result?.viewport?.id),
    safeId(result?.controlId)
  ].join(":");
}

function failureCodes(result) {
  return safeCodeList((result.failures ?? []).map((failure) => failure?.code));
}

function behaviorFailureCodes(result) {
  return failureCodes(result).filter((code) => (
    !VISUAL_FAILURE_CODES.has(code)
    && !code.startsWith("a11y_")
    && !code.startsWith("accessibility_")
    && !code.startsWith("keyboard_")
    && !code.startsWith("diagnostic_")
  ));
}

function normalizeComparison(value) {
  const criteria = Array.isArray(value?.criteria) ? value.criteria : [];
  const expectedSummary = summarizeOutcomes(criteria);
  const expectedStatus = value?.implementation?.passed !== true
    || criteria.some((outcome) => (
      outcome?.required === true
      && outcome?.classification === "regression"
    ))
    ? "failed"
    : criteria.some((outcome) => outcome?.classification !== "intended")
      ? "review_required"
      : "passed";
  if (
    !isRecord(value)
    || value.version !== 1
    || !COMPARISON_ID_RE.test(String(value.id ?? ""))
    || !STATUSES.has(value.status)
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || typeof value.sessionId !== "string"
    || value.sessionId.length < 1
    || value.sessionId.length > 256
    || typeof value.workspaceRoot !== "string"
    || !RUN_ID_RE.test(String(value.reference?.runId ?? ""))
    || !SHA256_RE.test(String(value.reference?.sourceRevision ?? ""))
    || !RUN_ID_RE.test(String(value.candidate?.runId ?? ""))
    || !SHA256_RE.test(String(value.candidate?.sourceRevision ?? ""))
    || !SHA256_RE.test(String(value.manifestDigest ?? ""))
    || !SHA256_RE.test(String(value.inputDigest ?? ""))
    || !["full", "impacted", "explore"].includes(value.mode)
    || !validImplementation(value.implementation)
    || !Array.isArray(value.criteria)
    || value.criteria.length < 1
    || value.criteria.length > MAX_CRITERIA
    || !value.criteria.every(validOutcome)
    || !sameSummary(value.summary, expectedSummary)
    || value.status !== expectedStatus
    || !Array.isArray(value.hypotheses)
    || value.hypotheses.length > MAX_CRITERIA + 1
    || !value.hypotheses.every(validHypothesis)
    || !ARTIFACT_REF_RE.test(String(value.artifactRef ?? ""))
    || !validIso(value.createdAt)
  ) {
    return null;
  }
  return structuredClone(value);
}

function validOutcome(value) {
  return Boolean(
    isRecord(value)
    && ASCII_ID_RE.test(String(value.id ?? ""))
    && ORACLES.has(value.oracle)
    && EXPECTATIONS.has(value.expectation)
    && typeof value.required === "boolean"
    && CLASSIFICATIONS.has(value.classification)
    && isRecord(value.scope)
    && ASCII_ID_RE.test(String(value.scope.routeId ?? ""))
    && (
      value.scope.viewportId == null
      || ASCII_ID_RE.test(String(value.scope.viewportId))
    )
    && (
      value.scope.controlId == null
      || ASCII_ID_RE.test(String(value.scope.controlId))
    )
    && Array.isArray(value.basis)
    && value.basis.length > 0
    && value.basis.every((item) => ASCII_ID_RE.test(String(item ?? "")))
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => ARTIFACT_REF_RE.test(String(ref)))
    && isRecord(value.observed)
    && typeof value.observed.changed === "boolean"
    && ["better", "neutral", "same", "worse"].includes(
      value.observed.direction
    )
    && typeof value.observed.humanApproved === "boolean"
    && Number.isSafeInteger(value.observed.referenceScore)
    && value.observed.referenceScore >= 0
    && Number.isSafeInteger(value.observed.candidateScore)
    && value.observed.candidateScore >= 0
    && SHA256_RE.test(String(value.observed.referenceDigest ?? ""))
    && SHA256_RE.test(String(value.observed.candidateDigest ?? ""))
  );
}

function validImplementation(value) {
  return Boolean(
    isRecord(value)
    && typeof value.passed === "boolean"
    && ["failed", "passed"].includes(value.candidateState)
    && Number.isSafeInteger(value.approvedVisualFailures)
    && value.approvedVisualFailures >= 0
    && Array.isArray(value.unapprovedFailureCodes)
    && value.unapprovedFailureCodes.every((code) => (
      EXTENDED_ID_RE.test(String(code ?? ""))
    ))
    && Array.isArray(value.basis)
    && value.basis.length > 0
    && value.basis.every((basis) => (
      EXTENDED_ID_RE.test(String(basis ?? ""))
    ))
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => ARTIFACT_REF_RE.test(String(ref)))
  );
}

function validHypothesis(value) {
  return Boolean(
    isRecord(value)
    && EXTENDED_ID_RE.test(String(value.id ?? ""))
    && EXTENDED_ID_RE.test(String(value.code ?? ""))
    && (
      value.criterionId == null
      || ASCII_ID_RE.test(String(value.criterionId))
    )
    && CLASSIFICATIONS.has(value.classification)
    && Array.isArray(value.basis)
    && value.basis.length > 0
    && value.basis.every((basis) => (
      EXTENDED_ID_RE.test(String(basis ?? ""))
    ))
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => ARTIFACT_REF_RE.test(String(ref)))
  );
}

function sameSummary(value, expected) {
  return Boolean(
    isRecord(value)
    && Object.entries(expected).every(([key, count]) => (
      value[key] === count
    ))
  );
}

function readJournal(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("QA comparison journal is not a regular file.");
    }
    if (stat.size > MAX_JOURNAL_BYTES) {
      throw new Error("QA comparison journal exceeds its replay bound.");
    }
    const events = [];
    let complete = true;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        complete = false;
        break;
      }
    }
    return { exists: true, events, complete };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, events: [], complete: true };
    }
    throw error;
  }
}

function compareCanonical(left, right) {
  return canonicalStringify(left).localeCompare(canonicalStringify(right));
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
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueArtifactRefs(values) {
  return [...new Set((values ?? []).map(artifactRef).filter(Boolean))]
    .slice(0, 200);
}

function artifactRef(value) {
  const ref = String(value ?? "");
  return ARTIFACT_REF_RE.test(ref) ? ref : null;
}

function safeIdList(values) {
  if (!Array.isArray(values)) return [];
  return values.map(safeId).filter(Boolean).slice(0, 16);
}

function safeCodeList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(safeCode).filter(Boolean))]
    .sort()
    .slice(0, 100);
}

function safeId(value) {
  const id = String(value ?? "");
  return /^[a-z][a-z0-9_-]{0,127}$/.test(id) ? id : null;
}

function safeCode(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function safeCount(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Math.min(Number(value), 1_000_000)
    : 0;
}

function requiredId(value, label) {
  const id = String(value ?? "");
  if (!ASCII_ID_RE.test(id)) {
    throw new TypeError(`QA ${label} requires an ASCII id.`);
  }
  return id;
}

function boundedText(value, label, maximum) {
  const text = String(value ?? "").trim();
  if (
    !text
    || text.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return text;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

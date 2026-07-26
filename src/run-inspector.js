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

const RUN_KINDS = new Set(["coder", "job", "qa", "turn"]);
const TERMINAL_STATUSES = new Set([
  "blocked",
  "cancelled",
  "failed",
  "interrupted",
  "passed",
  "rolled_back",
  "succeeded"
]);
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PHASE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ARTIFACT_REF_RE = /^qaart_[a-f0-9]{64}$/;
const MAX_RUNS = 1_000;
const MAX_EVENTS_PER_RUN = 300;
const MAX_TOTAL_EVENTS = 50_000;
const MAX_EVENT_FILE_BYTES = 64 * 1024 * 1024;
const EVENT_COMPACTION_THRESHOLD_BYTES = 24 * 1024 * 1024;
const COMPACTED_EVENT_FILE_BYTES = 16 * 1024 * 1024;

const STRING_METADATA = new Map([
  ["agentId", 128],
  ["code", 80],
  ["controlId", 64],
  ["errorCode", 80],
  ["evidenceKind", 32],
  ["evidenceStatus", 32],
  ["model", 200],
  ["provider", 80],
  ["receiptId", 200],
  ["resultId", 256],
  ["rollbackState", 32],
  ["routeId", 64],
  ["explorationTruncationReason", 32],
  ["sourceRevision", 64],
  ["stopReason", 80],
  ["toolStrategy", 80],
  ["toolName", 128],
  ["verificationStatus", 32],
  ["viewportId", 64]
]);
const INTEGER_METADATA = new Set([
  "attempt",
  "cachedTokens",
  "completed",
  "controls",
  "criteriaFailed",
  "criteriaPassed",
  "durationMs",
  "editCount",
  "evidenceNudges",
  "explorationActions",
  "exploredStates",
  "exploredTransitions",
  "failed",
  "failedTransitions",
  "inputTokens",
  "iteration",
  "keyboardFailures",
  "maxAttempts",
  "maxExplorationDepth",
  "maxIterations",
  "outputTokens",
  "passed",
  "revision",
  "routes",
  "total",
  "mutationEvidence",
  "observationRevision",
  "verificationEvidence",
  "visualEvidence",
  "visualChanges",
  "warnings"
]);
const NUMBER_METADATA = new Set(["scrutinyScore"]);
const BOOLEAN_METADATA = new Set([
  "changed",
  "dispatched",
  "explorationTruncated",
  "ok",
  "pending"
]);

export class RunInspectorStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "run-inspector")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.rewriteEvents = options.rewriteEvents ?? writeTextAtomic;
    this.now = options.now ?? nowIso;
    this.onChange = typeof options.onChange === "function"
      ? options.onChange
      : null;
    this.runs = new Map();
    ensureDir(this.dir);
    this._load();
  }

  record(input) {
    const projectId = requiredProjectId(input?.projectId);
    const kind = requiredKind(input?.kind);
    const runId = requiredRunId(input?.runId);
    const key = scopedRunKey(projectId, kind, runId);
    const current = this.runs.get(key);
    if (current && current.projectId !== projectId) {
      throw new Error("Run inspector identity cannot cross projects.");
    }
    const at = validIso(input?.at) ? input.at : this.now();
    const event = normalizeEvent({
      version: 1,
      id: createId("runevent"),
      runId,
      kind,
      projectId,
      sessionId: optionalSessionId(input?.sessionId),
      phase: requiredPhase(input?.phase),
      status: normalizeStatus(input?.status, current?.status),
      sequence: (current?.sequence ?? 0) + 1,
      at,
      metadata: normalizeMetadata(input?.metadata)
    });
    if (!event) throw new TypeError("Run inspector event is invalid.");
    this.appendEvent(this.eventsPath, event);
    const run = this._install(event);
    this._trim();
    this._compactJournalIfNeeded();
    this._writeSnapshot();
    try { this.onChange?.(publicRun(run), publicEvent(event)); } catch {
      // Inspector observers are advisory; the fsynced event is authoritative.
    }
    return publicRun(run);
  }

  get(kind, runId, { projectId } = {}) {
    const project = requiredProjectId(projectId);
    const run = this.runs.get(scopedRunKey(
      project,
      requiredKind(kind),
      requiredRunId(runId)
    ));
    if (!run || run.projectId !== project) return null;
    return publicRun(run);
  }

  list({ projectId, kind = null, status = null, limit = 100 } = {}) {
    const project = requiredProjectId(projectId);
    const selectedKind = kind == null ? null : requiredKind(kind);
    const selectedStatus = status == null
      ? null
      : requiredPhase(status);
    return [...this.runs.values()]
      .filter((run) => run.projectId === project)
      .filter((run) => selectedKind === null || run.kind === selectedKind)
      .filter((run) => selectedStatus === null || run.status === selectedStatus)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedInteger(limit, 1, 500, 100))
      .map(publicRun);
  }

  _load() {
    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      snapshot = null;
    }
    let text = "";
    let journalExists = false;
    try {
      const stat = fs.lstatSync(this.eventsPath);
      journalExists = true;
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
      ) {
        throw new Error("Run inspector journal is not a regular file.");
      }
      if (stat.size > MAX_EVENT_FILE_BYTES) {
        throw new Error("Run inspector journal exceeds its replay bound.");
      }
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const events = readEvents(text);
    if (journalExists) {
      for (const event of events) this._install(event);
    } else {
      for (const candidate of snapshot?.runs ?? []) {
        const run = normalizeRun(candidate);
        if (run) {
          this.runs.set(
            scopedRunKey(run.projectId, run.kind, run.runId),
            run
          );
        }
      }
    }
    this._trim();
  }

  _install(value) {
    const event = normalizeEvent(value);
    if (!event) return null;
    const key = scopedRunKey(event.projectId, event.kind, event.runId);
    const current = this.runs.get(key);
    if (
      current
      && (
        current.projectId !== event.projectId
        || event.sequence !== current.sequence + 1
      )
    ) {
      return current;
    }
    const events = [
      ...(current?.events ?? []),
      publicEvent(event)
    ].slice(-MAX_EVENTS_PER_RUN);
    const terminal = TERMINAL_STATUSES.has(event.status);
    const run = normalizeRun({
      version: 1,
      id: runKey(event.kind, event.runId),
      runId: event.runId,
      kind: event.kind,
      projectId: event.projectId,
      sessionId: event.sessionId ?? current?.sessionId ?? null,
      status: event.status,
      sequence: event.sequence,
      eventCount: (current?.eventCount ?? 0) + 1,
      startedAt: current?.startedAt ?? event.at,
      updatedAt: event.at,
      completedAt: terminal ? event.at : null,
      latest: event.metadata,
      events
    });
    if (!run) return current ?? null;
    this.runs.set(key, run);
    return run;
  }

  _trim() {
    const retained = [...this.runs.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RUNS);
    this.runs = new Map(
      retained.map((run) => [
        scopedRunKey(run.projectId, run.kind, run.runId),
        run
      ])
    );
    const originalEvents = new Map(
      retained.map((run) => [
        scopedRunKey(run.projectId, run.kind, run.runId),
        run.events
      ])
    );
    let remainingEvents = MAX_TOTAL_EVENTS;
    for (const run of retained) {
      const events = originalEvents.get(
        scopedRunKey(run.projectId, run.kind, run.runId)
      ) ?? [];
      run.events = events.length > 0 ? [events.at(-1)] : [];
      remainingEvents -= run.events.length;
    }
    for (const run of retained) {
      if (remainingEvents <= 0) break;
      const events = originalEvents.get(
        scopedRunKey(run.projectId, run.kind, run.runId)
      ) ?? [];
      const extra = Math.min(
        Math.max(0, events.length - 1),
        remainingEvents
      );
      if (extra > 0) run.events = events.slice(-(extra + 1));
      remainingEvents -= extra;
    }
  }

  _compactJournalIfNeeded() {
    try {
      const stat = fs.lstatSync(this.eventsPath);
      if (
        stat.isFile()
        && !stat.isSymbolicLink()
        && stat.size >= EVENT_COMPACTION_THRESHOLD_BYTES
      ) {
        this._rewriteJournal();
      }
    } catch {
      // The successful append remains authoritative.
    }
  }

  _rewriteJournal() {
    const selected = [];
    const selectedIds = new Set();
    let bytes = 0;
    let full = false;
    const runs = [...this.runs.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const run of runs) {
      const event = run.events.at(-1);
      if (!event) continue;
      const stored = { version: 1, ...event };
      const lineBytes = Buffer.byteLength(
        `${JSON.stringify(stored)}\n`,
        "utf8"
      );
      if (bytes + lineBytes > COMPACTED_EVENT_FILE_BYTES) {
        throw new Error(
          "Run inspector cannot retain one authoritative event per run."
        );
      }
      selected.push(stored);
      selectedIds.add(storedEventKey(stored));
      bytes += lineBytes;
    }
    for (const run of runs) {
      for (const event of [...run.events].reverse()) {
        if (selectedIds.has(storedEventKey(event))) continue;
        const stored = { version: 1, ...event };
        const line = `${JSON.stringify(stored)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (bytes + lineBytes > COMPACTED_EVENT_FILE_BYTES) {
          full = true;
          break;
        }
        selected.push(stored);
        selectedIds.add(storedEventKey(stored));
        bytes += lineBytes;
      }
      if (full) break;
    }
    selected.sort(compareStoredEvents);
    this.rewriteEvents(
      this.eventsPath,
      selected.length > 0
        ? `${selected.map((event) => JSON.stringify(event)).join("\n")}\n`
        : ""
    );
  }

  _writeSnapshot() {
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: this.now(),
        runs: [...this.runs.values()]
      });
    } catch {
      // The fsynced JSONL event is authoritative.
    }
  }
}

export class RunInspector {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.store = options.store ?? new RunInspectorStore({
      dataDir: options.dataDir,
      dir: options.dir,
      onChange: (run, event) => this._emit(run, event)
    });
  }

  recordTurn({
    runId,
    projectId,
    sessionId,
    phase,
    status = "running",
    metadata = {}
  }) {
    return this.store.record({
      runId,
      kind: "turn",
      projectId,
      sessionId,
      phase,
      status,
      metadata
    });
  }

  recordCoder(run) {
    if (!run) return null;
    const verification = run.verification?.results ?? [];
    return this.store.record({
      runId: run.id,
      kind: "coder",
      projectId: run.projectId,
      sessionId: run.sessionId,
      phase: `coder_${safePhase(run.state)}`,
      status: run.state,
      at: run.updatedAt,
      metadata: {
        revision: run.revision,
        editCount: run.edits?.length ?? 0,
        passed: verification.filter((result) => result?.ok === true).length,
        failed: verification.filter((result) => result?.ok !== true).length,
        criteriaPassed: run.acceptance?.summary?.requiredPassed ?? 0,
        criteriaFailed: run.acceptance?.summary?.failed ?? 0,
        rollbackState: run.rollback?.status ?? (
          run.state === "rolled_back" ? "rolled_back" : null
        ),
        errorCode: run.error?.code ?? null
      }
    });
  }

  recordQa(event) {
    if (!event) return null;
    const summary = event.summary ?? {};
    return this.store.record({
      runId: event.id,
      kind: "qa",
      projectId: event.projectId,
      sessionId: event.sessionId,
      phase: event.result
        ? "qa_result"
        : `qa_${safePhase(event.state)}`,
      status: event.state,
      at: event.updatedAt,
      metadata: {
        revision: event.revision,
        sourceRevision: event.sourceRevision,
        completed: event.completed,
        total: event.total,
        resultId: event.result?.id,
        evidenceKind: event.result?.kind,
        routeId: event.result?.routeId,
        controlId: event.result?.controlId,
        viewportId: event.result?.viewport?.id,
        ok: event.result?.status === "passed",
        routes: summary.routes,
        controls: summary.controls,
        passed: summary.passed,
        failed: summary.failed,
        warnings: summary.warnings,
        visualChanges: summary.visualChanges,
        keyboardFailures: summary.keyboardFailures,
        exploredStates: event.result?.exploration?.states
          ?? summary.exploredStates,
        exploredTransitions: event.result?.exploration?.transitions
          ?? summary.exploredTransitions,
        explorationActions: event.result?.exploration?.actions
          ?? summary.explorationActions,
        failedTransitions: event.result?.exploration?.failedTransitions
          ?? summary.failedTransitions,
        maxExplorationDepth: event.result?.exploration?.maxDepthReached,
        explorationTruncated: event.result?.exploration?.truncated
          ?? summary.explorationTruncated,
        explorationTruncationReason:
          event.result?.exploration?.truncationReason,
        artifactRefs: [event.result?.exploration?.graphRef].filter(Boolean),
        verificationStatus: event.result?.status,
        errorCode: event.error?.code ?? null
      }
    });
  }

  recordJob(event) {
    if (!event?.id || !event?.projectId) return null;
    return this.store.record({
      runId: event.id,
      kind: "job",
      projectId: event.projectId,
      sessionId: event.sessionId,
      phase: `job_${safePhase(event.status ?? "updated")}`,
      status: event.status ?? "running",
      at: event.updatedAt,
      metadata: {
        revision: event.revision,
        toolName: event.target,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorCode: event.error?.code ?? null
      }
    });
  }

  list({ projectId, kind = null, status = null, limit = 100 } = {}) {
    const runs = new Map(
      this.store.list({ projectId, kind, status, limit: 500 })
        .map((run) => [runKey(run.kind, run.runId), run])
    );
    if (kind == null || kind === "coder") {
      for (const run of this.runtime?.coder?.store?.list?.({
        projectId,
        limit: 100
      }) ?? []) {
        const key = runKey("coder", run.id);
        if (!runs.has(key)) runs.set(key, coderSummary(run));
      }
    }
    if (kind == null || kind === "qa") {
      for (const run of this.runtime?.webQa?.store?.list?.({
        projectId,
        limit: 100
      }) ?? []) {
        const key = runKey("qa", run.id);
        if (!runs.has(key)) runs.set(key, qaSummary(run));
      }
    }
    if (kind == null || kind === "job") {
      try {
        for (const run of this.runtime?.jobs?.list?.(
          { limit: 100 },
          { __projectId: projectId }
        ) ?? []) {
          const key = runKey("job", run.id);
          if (!runs.has(key)) runs.set(key, jobSummary(run));
        }
      } catch {
        // The inspector stays available if job authorization changes.
      }
    }
    return [...runs.values()]
      .filter((run) => status == null || run.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedInteger(limit, 1, 500, 100));
  }

  detail({ projectId, kind, runId }) {
    const normalizedKind = requiredKind(kind);
    const normalizedRunId = requiredRunId(runId);
    const inspected = this.store.get(normalizedKind, normalizedRunId, {
      projectId
    });
    if (normalizedKind === "coder") {
      const run = this.runtime?.coder?.store?.get?.(normalizedRunId);
      if (!run || run.projectId !== projectId) return inspected;
      return {
        ...(inspected ?? coderSummary(run)),
        detail: coderDetail(run)
      };
    }
    if (normalizedKind === "qa") {
      const run = this.runtime?.webQa?.store?.get?.(normalizedRunId);
      if (!run || run.projectId !== projectId) return inspected;
      return {
        ...(inspected ?? qaSummary(run)),
        detail: qaDetail(run)
      };
    }
    if (normalizedKind === "job") {
      let run = null;
      try {
        run = this.runtime?.jobs?.status?.(
          normalizedRunId,
          { __projectId: projectId }
        ) ?? null;
      } catch {
        run = null;
      }
      if (!run || run.projectId !== projectId) return inspected;
      return {
        ...(inspected ?? jobSummary(run)),
        detail: jobDetail(run)
      };
    }
    return inspected;
  }

  readQaArtifact({ projectId, runId, ref }) {
    const run = this.runtime?.webQa?.store?.get?.(runId);
    if (!run || run.projectId !== projectId) return null;
    return this.runtime.webQa.artifacts.readBytes(ref, {
      projectId,
      runId
    });
  }

  _emit(run, event) {
    this.runtime?.events?.emit?.("run-inspector", {
      id: run.id,
      runId: run.runId,
      kind: run.kind,
      projectId: run.projectId,
      sessionId: run.sessionId,
      status: run.status,
      phase: event.phase,
      sequence: event.sequence,
      updatedAt: run.updatedAt,
      metadata: event.metadata
    });
  }
}

export function turnInspectorMetadata(event) {
  const phase = String(event?.phase ?? "").trim().toLowerCase();
  const receipt = event?.receipt;
  const outcome = event?.outcome;
  if (phase === "start") {
    return {
      phase: "tool_start",
      status: "running",
      metadata: {
        toolName: event?.name
      }
    };
  }
  if (phase === "end") {
    const computer = computerUseInspectorMetadata(
      event?.name,
      outcome
    );
    return {
      phase: "tool_end",
      status: "running",
      metadata: {
        toolName: event?.name,
        ok: event?.ok === true,
        pending: event?.pending === true,
        receiptId: receipt?.id,
        code: receipt?.code ?? outcome?.code,
        dispatched: receipt?.dispatched,
        changed: receipt?.changed ?? outcome?.changed,
        durationMs: receipt?.durationMs,
        artifactRefs: outcome?.artifacts,
        ...computer
      }
    };
  }
  if (phase === "awaiting-approval") {
    return {
      phase: "awaiting_approval",
      status: "waiting_approval",
      metadata: {
        toolName: event?.toolName
      }
    };
  }
  if (phase === "iteration") {
    return {
      phase: "iteration",
      status: "running",
      metadata: {
        iteration: event?.n,
        maxIterations: event?.max
      }
    };
  }
  if (phase === "provider-retry") {
    return {
      phase: "provider_retry",
      status: "running",
      metadata: {}
    };
  }
  if (phase === "completion-evidence") {
    return {
      phase: "completion_evidence",
      status: "running",
      metadata: {
        evidenceKind: event?.kind,
        evidenceStatus: event?.status,
        mutationEvidence: event?.mutationCount,
        verificationEvidence: event?.verificationCount,
        visualEvidence: event?.visualCount,
        evidenceNudges: event?.nudges
      }
    };
  }
  return {
    phase: safePhase(phase || "progress"),
    status: "running",
    metadata: {}
  };
}

function computerUseInspectorMetadata(name, outcome) {
  if (
    !["computer_observe", "computer_act", "computer_screenshot"].includes(
      String(name ?? "")
    )
  ) {
    return {};
  }
  const evidence = Array.isArray(outcome?.evidence)
    ? outcome.evidence
    : [];
  const observation = evidence.find((item) => (
    /^computer-observation:\d+$/.test(String(item))
  ));
  const strategy = evidence.find((item) => (
    /^computer-strategy:[A-Za-z0-9._-]+$/.test(String(item))
  ));
  return {
    observationRevision: observation
      ? Number(observation.split(":")[1])
      : null,
    toolStrategy: strategy
      ? strategy.slice("computer-strategy:".length)
      : null,
    verificationStatus: String(
      outcome?.verification ?? ""
    ).slice(0, 32) || null
  };
}

function coderSummary(run) {
  return {
    version: 1,
    id: runKey("coder", run.id),
    runId: run.id,
    kind: "coder",
    projectId: run.projectId,
    sessionId: run.sessionId,
    status: run.state,
    sequence: run.revision,
    eventCount: 0,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: TERMINAL_STATUSES.has(run.state) ? run.updatedAt : null,
    latest: normalizeMetadata({
      revision: run.revision,
      editCount: run.edits?.length ?? 0,
      criteriaPassed: run.acceptance?.summary?.requiredPassed ?? 0,
      criteriaFailed: run.acceptance?.summary?.failed ?? 0,
      errorCode: run.error?.code ?? null
    }),
    events: []
  };
}

function qaSummary(run) {
  return {
    version: 1,
    id: runKey("qa", run.id),
    runId: run.id,
    kind: "qa",
    projectId: run.projectId,
    sessionId: run.sessionId,
    status: run.state,
    sequence: run.revision,
    eventCount: 0,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: TERMINAL_STATUSES.has(run.state) ? run.updatedAt : null,
    latest: normalizeMetadata({
      revision: run.revision,
      sourceRevision: run.sourceRevision,
      routes: run.summary?.routes,
      controls: run.summary?.controls,
      passed: run.summary?.passed,
      failed: run.summary?.failed,
      warnings: run.summary?.warnings,
      visualChanges: run.summary?.visualChanges,
      keyboardFailures: run.summary?.keyboardFailures,
      errorCode: run.error?.code ?? null
    }),
    events: []
  };
}

function jobSummary(run) {
  return {
    version: 1,
    id: runKey("job", run.id),
    runId: run.id,
    kind: "job",
    projectId: run.projectId,
    sessionId: run.sessionId ?? null,
    status: run.status,
    sequence: run.revision,
    eventCount: 0,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: TERMINAL_STATUSES.has(run.status)
      ? run.finishedAt ?? run.updatedAt
      : null,
    latest: normalizeMetadata({
      revision: run.revision,
      toolName: run.target,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      errorCode: run.error?.code ?? null
    }),
    events: []
  };
}

function coderDetail(run) {
  return {
    id: run.id,
    revision: run.revision,
    state: run.state,
    files: Array.isArray(run.files)
      ? run.files.slice(0, 16).map((file) => ({
          path: boundedDisplay(file.path, 500),
          missing: file.missing === true
        }))
      : [],
    edits: Array.isArray(run.edits)
      ? run.edits.slice(0, 16).map((edit) => ({
          kind: edit.kind,
          path: boundedDisplay(edit.path, 500),
          postTag: boundedDisplay(edit.postTag, 64),
          receipt: publicReceipt(edit.receipt)
        }))
      : [],
    checks: Array.isArray(run.checks)
      ? run.checks.slice(0, 16).map((check) => ({
          id: check.id,
          type: check.type,
          path: boundedDisplay(check.path ?? check.manifestPath, 500)
        }))
      : [],
    verification: run.verification == null
      ? null
      : {
          status: run.verification.status,
          durationMs: run.verification.durationMs,
          results: (run.verification.results ?? []).slice(0, 16).map(
            (result) => ({
              id: result.id,
              type: result.type,
              ok: result.ok === true,
              code: boundedDisplay(result.code, 80),
              durationMs: result.durationMs,
              evidence: {
                qaRunId: result.evidence?.qaRunId ?? null,
                artifactRefs: normalizeArtifactRefs(
                  result.evidence?.artifactRefs
                )
              }
            })
          )
        },
    acceptance: {
      status: run.acceptance?.status ?? "pending",
      sourceRevision: run.acceptance?.sourceRevision ?? null,
      summary: run.acceptance?.summary ?? null,
      criteria: (run.acceptance?.criteria ?? []).slice(0, 32).map(
        (criterion) => ({
          id: criterion.id,
          statement: boundedDisplay(criterion.statement, 1_000),
          kind: criterion.kind,
          oracle: criterion.oracle,
          required: criterion.required !== false,
          checkIds: [...(criterion.checkIds ?? [])].slice(0, 16)
        })
      )
    },
    rollback: run.rollback == null
      ? null
      : {
          status: run.rollback.status ?? null,
          files: (run.rollback.files ?? []).slice(0, 16).map((file) => ({
            path: boundedDisplay(file.path, 500),
            status: boundedDisplay(file.status, 80)
          }))
        },
    error: run.error == null
      ? null
      : {
          code: boundedDisplay(run.error.code, 80)
        }
  };
}

function qaDetail(run) {
  return {
    id: run.id,
    revision: run.revision,
    state: run.state,
    sourceRevision: run.sourceRevision,
    manifest: {
      path: boundedDisplay(run.manifest?.path, 500),
      digest: run.manifest?.digest ?? null
    },
    summary: run.summary,
    results: (run.results ?? []).slice(0, 500).map((result) => ({
      id: result.id,
      kind: result.kind,
      routeId: result.routeId,
      controlId: result.controlId ?? null,
      viewport: result.viewport,
      status: result.status,
      failures: (result.failures ?? []).slice(0, 100).map((failure) => ({
        code: boundedDisplay(failure.code, 80)
      })),
      warnings: (result.warnings ?? []).slice(0, 100).map((warning) => ({
        code: boundedDisplay(warning.code, 80)
      })),
      coverage: result.coverage,
      diagnostics: result.diagnostics,
      accessibility: result.accessibility,
      keyboard: result.keyboard,
      visual: result.visual,
      screenshotRef: result.screenshotRef,
      diagnosticsRef: result.diagnosticsRef,
      traceRef: result.traceRef,
      artifacts: normalizeArtifactRefs(result.artifacts)
    })),
    artifacts: normalizeArtifactRefs(run.artifacts),
    error: run.error == null
      ? null
      : {
          code: boundedDisplay(run.error.code, 80)
        }
  };
}

function jobDetail(run) {
  return {
    id: run.id,
    revision: run.revision,
    status: run.status,
    kind: boundedDisplay(run.kind, 32),
    target: boundedDisplay(run.target, 128),
    attempt: boundedInteger(run.attempt, 0, 1_000, 0),
    maxAttempts: boundedInteger(run.maxAttempts, 0, 1_000, 0),
    startedAt: validIso(run.startedAt) ? run.startedAt : null,
    finishedAt: validIso(run.finishedAt) ? run.finishedAt : null,
    recoveredAt: validIso(run.recoveredAt) ? run.recoveredAt : null,
    cancel: run.cancel == null
      ? null
      : {
          requested: validIso(run.cancel.requestedAt),
          acknowledged: validIso(run.cancel.acknowledgedAt)
        },
    error: run.error == null
      ? null
      : {
          code: boundedDisplay(run.error.code, 80),
          retryable: run.error.retryable === true
        }
  };
}

function publicReceipt(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: boundedDisplay(value.id, 200),
    status: boundedDisplay(value.status, 32),
    code: boundedDisplay(value.code, 80),
    dispatched: value.dispatched === true,
    changed: value.changed === true
      ? true
      : value.changed === false ? false : null,
    durationMs: boundedInteger(value.durationMs, 0, 86_400_000, 0)
  };
}

function normalizeEvent(value) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== 1
    || !RUN_ID_RE.test(String(value.id ?? ""))
    || !RUN_ID_RE.test(String(value.runId ?? ""))
    || !RUN_KINDS.has(value.kind)
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || !PHASE_RE.test(String(value.phase ?? ""))
    || !PHASE_RE.test(String(value.status ?? ""))
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !validIso(value.at)
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    runId: value.runId,
    kind: value.kind,
    projectId: value.projectId,
    sessionId: optionalSessionId(value.sessionId),
    phase: value.phase,
    status: value.status,
    sequence: value.sequence,
    at: value.at,
    metadata: normalizeMetadata(value.metadata)
  };
}

function normalizeRun(value) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== 1
    || value.id !== runKey(value.kind, value.runId)
    || !RUN_KINDS.has(value.kind)
    || !RUN_ID_RE.test(String(value.runId ?? ""))
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || !PHASE_RE.test(String(value.status ?? ""))
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !Number.isSafeInteger(value.eventCount)
    || value.eventCount < 1
    || !validIso(value.startedAt)
    || !validIso(value.updatedAt)
    || (value.completedAt != null && !validIso(value.completedAt))
    || !Array.isArray(value.events)
    || value.events.length > MAX_EVENTS_PER_RUN
  ) {
    return null;
  }
  const events = [];
  let previousSequence = 0;
  for (const candidate of value.events) {
    const event = normalizeEvent({ ...candidate, version: 1 });
    if (
      !event
      || event.runId !== value.runId
      || event.kind !== value.kind
      || event.projectId !== value.projectId
      || event.sequence <= previousSequence
      || event.sequence > value.sequence
    ) {
      return null;
    }
    previousSequence = event.sequence;
    events.push(publicEvent(event));
  }
  return {
    version: 1,
    id: value.id,
    runId: value.runId,
    kind: value.kind,
    projectId: value.projectId,
    sessionId: optionalSessionId(value.sessionId),
    status: value.status,
    sequence: value.sequence,
    eventCount: value.eventCount,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt ?? null,
    latest: normalizeMetadata(value.latest),
    events
  };
}

function publicRun(run) {
  return structuredClone(run);
}

function publicEvent(event) {
  const { version: _version, ...visible } = event;
  return structuredClone(visible);
}

function normalizeMetadata(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const output = {};
  for (const [key, maxLength] of STRING_METADATA) {
    const normalized = optionalDisplay(source[key], maxLength);
    if (normalized != null) output[key] = normalized;
  }
  for (const key of INTEGER_METADATA) {
    if (Number.isSafeInteger(source[key]) && source[key] >= 0) {
      output[key] = source[key];
    }
  }
  for (const key of NUMBER_METADATA) {
    if (Number.isFinite(source[key]) && source[key] >= 0) {
      output[key] = Math.min(1_000_000, source[key]);
    }
  }
  for (const key of BOOLEAN_METADATA) {
    if (typeof source[key] === "boolean") output[key] = source[key];
  }
  const artifactRefs = normalizeArtifactRefs(source.artifactRefs);
  if (artifactRefs.length > 0) output.artifactRefs = artifactRefs;
  return output;
}

function normalizeArtifactRefs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter(
    (ref) => ARTIFACT_REF_RE.test(ref)
  ))].slice(0, 100);
}

function readEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = normalizeEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // Ignore a partial trailing line.
    }
  }
  return events;
}

function compareStoredEvents(left, right) {
  const byTime = left.at.localeCompare(right.at);
  if (byTime !== 0) return byTime;
  const byProject = left.projectId.localeCompare(right.projectId);
  if (byProject !== 0) return byProject;
  const byKind = left.kind.localeCompare(right.kind);
  if (byKind !== 0) return byKind;
  const byRun = left.runId.localeCompare(right.runId);
  return byRun !== 0 ? byRun : left.sequence - right.sequence;
}

function storedEventKey(event) {
  return `${event.projectId}:${event.kind}:${event.runId}:${event.sequence}`;
}

function normalizeStatus(value, fallback = "running") {
  const status = safePhase(value ?? fallback);
  return status || "running";
}

function requiredKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  if (!RUN_KINDS.has(kind)) throw new TypeError("Invalid run inspector kind.");
  return kind;
}

function requiredRunId(value) {
  const id = String(value ?? "").trim();
  if (!RUN_ID_RE.test(id)) throw new TypeError("Invalid run inspector id.");
  return id;
}

function requiredProjectId(value) {
  const id = String(value ?? "");
  if (!PROJECT_ID_RE.test(id)) {
    throw new TypeError("Invalid run inspector project.");
  }
  return id;
}

function requiredPhase(value) {
  const phase = safePhase(value);
  if (!PHASE_RE.test(phase)) {
    throw new TypeError("Invalid run inspector phase.");
  }
  return phase;
}

function safePhase(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "_")
    .slice(0, 64);
}

function optionalSessionId(value) {
  if (value == null || value === "") return null;
  const id = String(value);
  return /^[\x21-\x7e]{1,512}$/u.test(id) ? id : null;
}

function boundedDisplay(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function optionalDisplay(value, maxLength) {
  if (value == null) return null;
  const text = boundedDisplay(value, maxLength);
  return text || null;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function runKey(kind, runId) {
  return `${kind}:${runId}`;
}

function scopedRunKey(projectId, kind, runId) {
  return `${projectId}:${kind}:${runId}`;
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export const RUN_INSPECTOR_LIMITS = Object.freeze({
  maxRuns: MAX_RUNS,
  maxEventsPerRun: MAX_EVENTS_PER_RUN,
  maxTotalEvents: MAX_TOTAL_EVENTS,
  maxEventFileBytes: MAX_EVENT_FILE_BYTES,
  eventCompactionThresholdBytes: EVENT_COMPACTION_THRESHOLD_BYTES,
  compactedEventFileBytes: COMPACTED_EVENT_FILE_BYTES
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { resolveDataDir } from "./data-dir.js";
import {
  appendJsonLine,
  ensureDir,
  writeJsonAtomic
} from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

export const JOB_KINDS = Object.freeze(["direct-tool", "subagent"]);
export const JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);
export const TERMINAL_JOB_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);

const TERMINAL_STATUSES = new Set(TERMINAL_JOB_STATUSES);
const KIND_SET = new Set(JOB_KINDS);
const STATUS_SET = new Set(JOB_STATUSES);
const EFFECTS = new Set(["read", "write"]);
const LOCK_MODES = new Set(["read", "write"]);
const JOB_ID_RE = /^job_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const PARENT_JOB_ID_RE = /^job_[a-f0-9]{16}$/;
const OUTPUT_REF_RE = /^out_[a-f0-9]{16}$/;
const SAFE_REF_RE = /^[\x21-\x7E]{1,256}$/;
const SESSION_ID_RE = /^[\x21-\x7E]{1,512}$/;
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/\\-]{0,255}$/;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
const EVENT_OPS = new Set([
  "cancel",
  "cancelled",
  "collect",
  "failed",
  "reconcile-interrupted",
  "running",
  "start",
  "succeeded"
]);
const REQUIRED_BOUNDARIES = Object.freeze([
  "abort",
  "approval",
  "budget",
  "checkpoint",
  "policy",
  "redaction"
]);
const START_FIELDS = new Set([
  "boundaries",
  "effect",
  "id",
  "idempotencyKey",
  "idempotent",
  "input",
  "inputRef",
  "kind",
  "maxAttempts",
  "metadata",
  "parentJobId",
  "projectId",
  "replayPayload",
  "resourceLocks",
  "sessionId",
  "target"
]);
const JOB_FIELDS = new Set([
  "attempt",
  "boundaries",
  "cancel",
  "collectedAt",
  "createdAt",
  "effect",
  "error",
  "finishedAt",
  "id",
  "idempotencyKey",
  "idempotent",
  "input",
  "inputRef",
  "kind",
  "maxAttempts",
  "metadata",
  "parentJobId",
  "projectId",
  "recoveredAt",
  "replayPayload",
  "resourceLocks",
  "result",
  "revision",
  "sessionId",
  "startedAt",
  "status",
  "target",
  "toolOutputRef",
  "updatedAt",
  "version"
]);
const EVENT_FIELDS = new Set([
  "at",
  "job",
  "op",
  "sequence",
  "version"
]);
const SNAPSHOT_FIELDS = new Set([
  "jobs",
  "sequence",
  "updatedAt",
  "version"
]);
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_JOBS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 128 * 1024;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS = 16;
const MAX_SEQUENCE = 1_000_000_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 8_192;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const PROCESS_SCHEDULER_LEASES = new Map();
const SENSITIVE_KEY_RE = /(?:^|[_-])(?:api[-_]?key|authorization|bearer|cookie|credential|password|private[-_]?key|access[-_]?token|refresh[-_]?token|secret|token)(?:$|[_-])/i;
const REFERENCE_KEY_RE = /(?:ref|refs|reference|references)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

export class JobStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "JobStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class JobRevisionError extends JobStoreError {
  constructor(jobId, expectedRevision, actualRevision) {
    super(
      "JOB_REVISION_CONFLICT",
      `Job revision conflict for '${jobId}': expected ${expectedRevision}, found ${actualRevision ?? "none"}.`,
      {
        jobId,
        expectedRevision,
        actualRevision: actualRevision ?? null
      }
    );
    this.name = "JobRevisionError";
  }
}

export class JobResourceConflictError extends JobStoreError {
  constructor(jobId, conflictingJobId, resource) {
    super(
      "JOB_RESOURCE_CONFLICT",
      `Job '${jobId}' cannot run while '${conflictingJobId}' holds '${resource}'.`,
      { jobId, conflictingJobId, resource }
    );
    this.name = "JobResourceConflictError";
  }
}

// Durable job state only. Runners remain responsible for executing work,
// holding AbortControllers, and supplying oversized tool-output references.
export class JobStore {
  constructor(options = {}) {
    const source = plainRecord(options, "JobStore options");
    assertOnlyKeys(
      source,
      new Set([
        "appendEvent",
        "dataDir",
        "dir",
        "lockTimeoutMs",
        "maxConcurrency",
        "maxInputBytes",
        "maxJobs",
        "maxMetadataBytes",
        "maxResultBytes",
        "now",
        "staleLockMs",
        "writeSnapshot"
      ]),
      "JobStore options"
    );
    const testDefaultDir = process.env.NODE_TEST_CONTEXT
      && source.dir == null
      && source.dataDir == null
      ? path.join(
          os.tmpdir(),
          "openagi-test-jobs",
          `${process.pid}-${process.ppid}`
        )
      : null;
    this.dir = path.resolve(
      source.dir
      ?? testDefaultDir
      ?? path.join(source.dataDir ?? resolveDataDir(), "jobs")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.schedulerLeasePath = path.join(this.dir, ".scheduler.lease");
    this.maxConcurrency = boundedPositiveInteger(
      source.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      64,
      "maxConcurrency"
    );
    this.maxJobs = boundedPositiveInteger(
      source.maxJobs,
      DEFAULT_MAX_JOBS,
      DEFAULT_MAX_JOBS,
      "maxJobs"
    );
    this.maxResultBytes = boundedPositiveInteger(
      source.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      4 * 1024 * 1024,
      "maxResultBytes"
    );
    this.maxInputBytes = boundedPositiveInteger(
      source.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      4 * 1024 * 1024,
      "maxInputBytes"
    );
    this.maxMetadataBytes = boundedPositiveInteger(
      source.maxMetadataBytes,
      DEFAULT_MAX_METADATA_BYTES,
      1024 * 1024,
      "maxMetadataBytes"
    );
    this.lockTimeoutMs = boundedPositiveInteger(
      source.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      120_000,
      "lockTimeoutMs"
    );
    this.staleLockMs = boundedPositiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      24 * 60 * 60 * 1000,
      "staleLockMs"
    );
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.jobs = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this.lockDepth = 0;
    this.schedulerLease = null;

    ensureDir(this.dir);
    this._withMutationLock(() => {
      this._restoreDurableState();
    });
  }

  // The JobManager must hold this lease for its whole lifetime. Plain
  // JobStore instances intentionally do not reconcile active records: opening
  // a second reader must never make a live scheduler's work look interrupted.
  acquireSchedulerLease(options = {}) {
    const source = plainRecord(options, "scheduler lease options");
    assertOnlyKeys(
      source,
      new Set(["shareProcess"]),
      "scheduler lease options"
    );
    const shareProcess = source.shareProcess === true;
    if (this.schedulerLease) {
      throw new JobStoreError(
        "JOB_SCHEDULER_LEASE_ALREADY_ACQUIRED",
        "This JobStore already owns the scheduler lease."
      );
    }
    return this._withMutationLock(() => {
      this._restoreDurableState();
      if (!this.journalHealthy) {
        throw new JobStoreError(
          "JOB_PERSISTENCE_UNHEALTHY",
          "Job journal is corrupt, missing events, or exceeds its replay bound."
        );
      }
      const record = {
        version: 1,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
      };
      const token = JSON.stringify(record);
      const processLease = shareProcess
        ? PROCESS_SCHEDULER_LEASES.get(this.schedulerLeasePath)
        : null;
      if (processLease) {
        let liveToken = null;
        try {
          liveToken = fs.readFileSync(this.schedulerLeasePath, "utf8");
        } catch {
          // Missing or unreadable ownership is never recreated implicitly.
        }
        if (liveToken !== processLease.token) {
          throw new JobStoreError(
            "JOB_SCHEDULER_LEASE_HELD",
            "The process-shared scheduler lease ownership changed."
          );
        }
        const handle = Object.freeze({
          acquiredAt: processLease.acquiredAt,
          pid: process.pid
        });
        processLease.references += 1;
        this.schedulerLease = { handle, token: processLease.token, shareProcess };
        return handle;
      }
      if (shareProcess && fs.existsSync(this.schedulerLeasePath)) {
        const existing = this._inspectSchedulerLease();
        if (
          existing.ownerPid === process.pid
          && typeof existing.content === "string"
        ) {
          const handle = Object.freeze({
            acquiredAt: existing.acquiredAt,
            pid: process.pid
          });
          PROCESS_SCHEDULER_LEASES.set(this.schedulerLeasePath, {
            acquiredAt: existing.acquiredAt,
            borrowed: true,
            references: 1,
            token: existing.content
          });
          this.schedulerLease = {
            borrowed: true,
            handle,
            token: existing.content,
            shareProcess
          };
          return handle;
        }
      }
      this._claimSchedulerLease(token);
      const handle = Object.freeze({
        acquiredAt: record.acquiredAt,
        pid: record.pid
      });
      this.schedulerLease = { handle, token, shareProcess };
      try {
        this._reconcileInterruptedJobs();
        if (shareProcess) {
          PROCESS_SCHEDULER_LEASES.set(this.schedulerLeasePath, {
            acquiredAt: record.acquiredAt,
            borrowed: false,
            references: 1,
            token
          });
        }
      } catch (error) {
        this.schedulerLease = null;
        this._releaseSchedulerLeaseToken(token);
        throw error;
      }
      return handle;
    });
  }

  releaseSchedulerLease(handle) {
    if (!this.schedulerLease || handle !== this.schedulerLease.handle) {
      throw new JobStoreError(
        "JOB_SCHEDULER_LEASE_NOT_OWNED",
        "The scheduler lease handle is not owned by this JobStore."
      );
    }
    return this._withMutationLock(() => {
      const { shareProcess, token } = this.schedulerLease;
      this.schedulerLease = null;
      if (shareProcess) {
        const processLease = PROCESS_SCHEDULER_LEASES.get(
          this.schedulerLeasePath
        );
        if (!processLease || processLease.token !== token) {
          throw new JobStoreError(
            "JOB_SCHEDULER_LEASE_NOT_OWNED",
            "The process-shared scheduler lease is no longer owned."
          );
        }
        processLease.references -= 1;
        if (processLease.references > 0) return true;
        PROCESS_SCHEDULER_LEASES.delete(this.schedulerLeasePath);
        // Process-shared managers may live in separate worker isolates that
        // cannot share the in-memory reference count. Keep the PID-owned
        // witness until process exit; a later process verifies liveness and
        // performs restart reconciliation.
        return true;
      }
      return this._releaseSchedulerLeaseToken(token);
    });
  }

  start(input = {}, context = {}) {
    const source = plainRecord(input, "job");
    assertOnlyKeys(source, START_FIELDS, "job");
    const control = normalizeMutationContext(context);
    if (control.expectedRevision != null) {
      throw new TypeError("expectedRevision is not valid when starting a job.");
    }
    const normalized = normalizeStartInput({
      ...source,
      projectId: source.projectId ?? control.projectId,
      sessionId: source.sessionId ?? control.sessionId
    }, {
      maxInputBytes: this.maxInputBytes,
      maxMetadataBytes: this.maxMetadataBytes
    });
    if (
      Object.hasOwn(context, "projectId")
      && normalized.projectId !== control.projectId
    ) {
      throw new JobStoreError(
        "PROJECT_BOUNDARY_VIOLATION",
        "Job projectId does not match its mutation context."
      );
    }
    if (
      control.sessionId != null
      && normalized.sessionId !== control.sessionId
    ) {
      throw new JobStoreError(
        "JOB_SESSION_BOUNDARY_VIOLATION",
        "Job sessionId does not match its mutation context."
      );
    }
    return this._runMutation(() => {
      const duplicate = normalized.idempotencyKey
        ? [...this.jobs.values()].find((job) => (
            job.projectId === normalized.projectId
            && job.sessionId === normalized.sessionId
            && job.idempotencyKey === normalized.idempotencyKey
          ))
        : null;
      if (duplicate) {
        if (!startSpecsEqual(duplicate, normalized)) {
          throw new JobStoreError(
            "JOB_IDEMPOTENCY_CONFLICT",
            "The idempotency key is already bound to a different job request.",
            {
              jobId: duplicate.id,
              idempotencyKey: normalized.idempotencyKey
            }
          );
        }
        return clone(duplicate);
      }
      if (this.jobs.size >= this.maxJobs) {
        throw new RangeError(`Job limit reached (${this.maxJobs}).`);
      }
      const id = normalized.id ?? this._uniqueJobId();
      if (this.jobs.has(id)) {
        throw new JobStoreError(
          "JOB_ALREADY_EXISTS",
          `Job '${id}' already exists.`,
          { jobId: id }
        );
      }
      if (normalized.parentJobId && !this.jobs.has(normalized.parentJobId)) {
        throw new JobStoreError(
          "JOB_PARENT_NOT_FOUND",
          `Parent job '${normalized.parentJobId}' does not exist.`,
          { parentJobId: normalized.parentJobId }
        );
      }
      const at = this._now();
      const job = {
        version: 1,
        id,
        revision: 1,
        kind: normalized.kind,
        target: normalized.target,
        projectId: normalized.projectId,
        sessionId: normalized.sessionId,
        parentJobId: normalized.parentJobId,
        effect: normalized.effect,
        idempotencyKey: normalized.idempotencyKey,
        idempotent: normalized.idempotent,
        inputRef: normalized.inputRef,
        input: normalized.input,
        replayPayload: normalized.replayPayload,
        boundaries: normalized.boundaries,
        resourceLocks: normalized.resourceLocks,
        metadata: normalized.metadata,
        status: "queued",
        attempt: 0,
        maxAttempts: normalized.maxAttempts,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        recoveredAt: null,
        collectedAt: null,
        cancel: {
          requestedAt: null,
          reason: null,
          acknowledgedAt: null
        },
        result: null,
        toolOutputRef: null,
        error: null
      };
      this.jobs.set(id, job);
      this._commit("start", job);
      return clone(job);
    }, control);
  }

  get(jobId, scope = {}) {
    const id = normalizeJobId(jobId);
    const normalizedScope = normalizeReadScope(scope);
    return this._readAuthoritative(() => {
      const job = this.jobs.get(id) ?? null;
      if (!job) return null;
      assertJobScope(job, normalizedScope);
      return clone(job);
    });
  }

  status(jobId, scope = {}) {
    const job = this.get(jobId, scope);
    return job ? statusView(job) : null;
  }

  list(options = {}) {
    const source = plainRecord(options, "job list options");
    assertOnlyKeys(
      source,
      new Set(["kind", "limit", "projectId", "sessionId", "status"]),
      "job list options"
    );
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const sessionId = source.sessionId == null
      ? null
      : normalizeSessionId(source.sessionId);
    const kind = source.kind == null ? null : normalizeKind(source.kind);
    const status = source.status == null ? null : normalizeStatus(source.status);
    const limit = boundedPositiveInteger(source.limit, 50, 500, "limit");
    return this._readAuthoritative(() => [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .filter((job) => sessionId == null || job.sessionId === sessionId)
      .filter((job) => kind == null || job.kind === kind)
      .filter((job) => status == null || job.status === status)
      .sort(compareJobs)
      .slice(0, limit)
      .map(clone));
  }

  // Internal scheduler surface. Unlike list(), this deliberately spans
  // projects and must not be exposed directly through an agent or HTTP tool.
  listAll(options = {}) {
    const source = plainRecord(options, "global job list options");
    assertOnlyKeys(
      source,
      new Set(["kind", "limit", "status"]),
      "global job list options"
    );
    const kind = source.kind == null ? null : normalizeKind(source.kind);
    const status = source.status == null ? null : normalizeStatus(source.status);
    const limit = boundedPositiveInteger(source.limit, 500, 2_000, "limit");
    return this._readAuthoritative(() => [...this.jobs.values()]
      .filter((job) => kind == null || job.kind === kind)
      .filter((job) => status == null || job.status === status)
      .sort(compareJobs)
      .slice(0, limit)
      .map(clone));
  }

  queued(options = {}) {
    const source = plainRecord(options, "queued job options");
    assertOnlyKeys(source, new Set(["limit"]), "queued job options");
    return this.listAll({ status: "queued", limit: source.limit ?? 500 });
  }

  capacity(options = {}) {
    const source = plainRecord(options, "capacity options");
    assertOnlyKeys(source, new Set(["projectId"]), "capacity options");
    const projectId = source.projectId == null
      ? null
      : normalizeProjectId(source.projectId);
    return this._readAuthoritative(() => {
      const running = [...this.jobs.values()].filter((job) => (
        executionIsActive(job)
        && (projectId == null || job.projectId === projectId)
      )).length;
      return {
        maxConcurrency: this.maxConcurrency,
        running,
        available: Math.max(0, this.maxConcurrency - running)
      };
    });
  }

  markRunning(jobId, context = {}) {
    return this._transition(jobId, "running", {}, context);
  }

  complete(jobId, outcome = {}, context = {}) {
    const source = plainRecord(outcome, "job outcome");
    assertOnlyKeys(
      source,
      new Set(["result", "toolOutputRef"]),
      "job outcome"
    );
    if (source.result !== undefined && source.toolOutputRef != null) {
      throw new TypeError("A job outcome cannot contain both result and toolOutputRef.");
    }
    const toolOutputRef = source.toolOutputRef == null
      ? null
      : normalizeToolOutputRef(source.toolOutputRef);
    const result = source.result === undefined
      ? null
      : normalizePersistedJson(source.result, "result", {
          maxBytes: this.maxResultBytes
        });
    return this._transition(
      jobId,
      "succeeded",
      { result, toolOutputRef },
      context
    );
  }

  fail(jobId, error, context = {}) {
    return this._transition(
      jobId,
      "failed",
      { error: normalizeJobError(error) },
      context
    );
  }

  cancel(jobId, options = {}, context = {}) {
    const source = plainRecord(options, "job cancellation");
    assertOnlyKeys(source, new Set(["reason"]), "job cancellation");
    const reason = normalizeReason(source.reason, "Cancellation requested.");
    const control = normalizeMutationContext(context);
    const id = normalizeJobId(jobId);
    return this._runMutation(() => {
      const current = this._requireJob(id);
      assertJobScope(current, control);
      assertExpectedRevision(current, control.expectedRevision);
      if (TERMINAL_STATUSES.has(current.status)) return clone(current);
      if (current.status === "cancel_requested") return clone(current);
      return this._applyTransition(
        current,
        "cancel_requested",
        { reason },
        "cancel"
      );
    }, control);
  }

  markCancelled(jobId, options = {}, context = {}) {
    const source = plainRecord(options, "job cancellation acknowledgement");
    assertOnlyKeys(source, new Set(["reason"]), "job cancellation acknowledgement");
    return this._transition(
      jobId,
      "cancelled",
      { reason: normalizeReason(source.reason, "Cancelled.") },
      context
    );
  }

  transition(jobId, nextStatus, patch = {}, context = {}) {
    const status = normalizeStatus(nextStatus);
    if (status === "running") return this.markRunning(jobId, context);
    if (status === "succeeded") return this.complete(jobId, patch, context);
    if (status === "failed") {
      const source = plainRecord(patch, "failed job transition");
      assertOnlyKeys(source, new Set(["error"]), "failed job transition");
      return this.fail(jobId, source.error, context);
    }
    if (status === "cancelled") return this.markCancelled(jobId, patch, context);
    if (status === "cancel_requested") return this.cancel(jobId, patch, context);
    throw new JobStoreError(
      "JOB_TRANSITION_INVALID",
      `External transitions to '${status}' are not allowed.`
    );
  }

  collect(jobId, options = {}) {
    const source = plainRecord(options, "job collection options");
    assertOnlyKeys(
      source,
      new Set(["consume", "expectedRevision", "projectId", "sessionId"]),
      "job collection options"
    );
    const consume = source.consume ?? false;
    if (typeof consume !== "boolean") {
      throw new TypeError("consume must be a boolean.");
    }
    const control = normalizeMutationContext({
      expectedRevision: source.expectedRevision,
      projectId: source.projectId,
      sessionId: source.sessionId
    });
    const id = normalizeJobId(jobId);
    if (!consume) {
      const job = this.get(id, {
        projectId: control.projectId,
        sessionId: control.sessionId
      });
      if (!job) return null;
      assertExpectedRevision(job, control.expectedRevision);
      assertCollectable(job);
      return collectionView(job);
    }
    return this._runMutation(() => {
      const current = this._requireJob(id);
      assertJobScope(current, control);
      assertExpectedRevision(current, control.expectedRevision);
      assertCollectable(current);
      if (current.collectedAt) return collectionView(current);
      const at = this._now();
      const next = {
        ...current,
        revision: nextRevision(current),
        updatedAt: at,
        collectedAt: at
      };
      this.jobs.set(id, next);
      this._commit("collect", next);
      return collectionView(next);
    }, control);
  }

  async wait(jobId, options = {}) {
    const source = plainRecord(options, "job wait options");
    assertOnlyKeys(
      source,
      new Set([
        "pollMs",
        "projectId",
        "sessionId",
        "signal",
        "timeoutMs"
      ]),
      "job wait options"
    );
    const timeoutMs = boundedNonNegativeInteger(
      source.timeoutMs,
      30_000,
      24 * 60 * 60 * 1000,
      "timeoutMs"
    );
    const pollMs = boundedPositiveInteger(source.pollMs, 25, 5_000, "pollMs");
    const signal = normalizeAbortSignal(source.signal);
    const scope = {
      projectId: source.projectId ?? "default",
      sessionId: source.sessionId ?? null
    };
    const started = Date.now();
    for (;;) {
      throwIfAborted(signal);
      const job = this.get(jobId, scope);
      if (!job) return null;
      if (TERMINAL_STATUSES.has(job.status)) return clone(job);
      if (Date.now() - started >= timeoutMs) {
        throw new JobStoreError(
          "JOB_WAIT_TIMEOUT",
          `Timed out waiting for job '${job.id}'.`,
          { jobId: job.id, timeoutMs }
        );
      }
      await abortableDelay(
        Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - started))),
        signal
      );
    }
  }

  health() {
    return this._readAuthoritative(() => ({
      healthy: this.journalHealthy,
      sequence: this.sequence,
      jobs: this.jobs.size
    }));
  }

  _transition(jobId, nextStatus, patch, context) {
    const id = normalizeJobId(jobId);
    const control = normalizeMutationContext(context);
    return this._runMutation(() => {
      const current = this._requireJob(id);
      assertJobScope(current, control);
      assertExpectedRevision(current, control.expectedRevision);
      return this._applyTransition(current, nextStatus, patch, nextStatus);
    }, control);
  }

  _applyTransition(current, nextStatus, patch, op) {
    assertTransitionAllowed(current.status, nextStatus);
    if (nextStatus === "running") {
      this._assertCapacity(current.id);
      this._assertResourceLocksAvailable(current);
      if (current.attempt >= current.maxAttempts) {
        throw new JobStoreError(
          "JOB_ATTEMPTS_EXHAUSTED",
          `Job '${current.id}' has exhausted its attempt limit.`,
          { jobId: current.id }
        );
      }
    }
    const at = this._now();
    const next = {
      ...current,
      revision: nextRevision(current),
      status: nextStatus,
      updatedAt: at
    };
    if (nextStatus === "running") {
      next.attempt = current.attempt + 1;
      next.startedAt = at;
      next.finishedAt = null;
      next.error = null;
    } else if (nextStatus === "cancel_requested") {
      next.cancel = {
        ...current.cancel,
        requestedAt: current.cancel.requestedAt ?? at,
        reason: patch.reason
      };
    } else if (nextStatus === "cancelled") {
      next.finishedAt = at;
      next.cancel = {
        ...current.cancel,
        requestedAt: current.cancel.requestedAt ?? at,
        reason: patch.reason,
        acknowledgedAt: at
      };
      next.error = {
        code: "JOB_CANCELLED",
        message: patch.reason,
        retryable: false
      };
    } else if (nextStatus === "succeeded") {
      next.finishedAt = at;
      next.result = patch.result;
      next.toolOutputRef = patch.toolOutputRef;
      next.error = null;
      if (current.status === "cancel_requested") {
        next.cancel = { ...current.cancel, acknowledgedAt: at };
      }
    } else if (nextStatus === "failed" || nextStatus === "interrupted") {
      next.finishedAt = at;
      next.error = current.idempotent
        ? patch.error
        : { ...patch.error, retryable: false };
      if (current.status === "cancel_requested") {
        next.cancel = { ...current.cancel, acknowledgedAt: at };
      }
    }
    this.jobs.set(current.id, next);
    this._commit(op, next);
    return clone(next);
  }

  _assertCapacity(jobId) {
    const active = [...this.jobs.values()].filter((job) => (
      job.id !== jobId && executionIsActive(job)
    )).length;
    if (active >= this.maxConcurrency) {
      throw new JobStoreError(
        "JOB_CONCURRENCY_LIMIT",
        `Job concurrency limit reached (${this.maxConcurrency}).`,
        { maxConcurrency: this.maxConcurrency }
      );
    }
  }

  _assertResourceLocksAvailable(candidate) {
    if (candidate.effect === "write" && !candidate.resourceLocks.some((lock) => (
      lock.mode === "write"
    ))) {
      throw new JobStoreError(
        "JOB_RESOURCE_LOCK_REQUIRED",
        `Mutating job '${candidate.id}' requires at least one write resource lock.`,
        { jobId: candidate.id }
      );
    }
    for (const other of this.jobs.values()) {
      if (
        other.id === candidate.id
        || (
          other.projectId !== candidate.projectId
          && !candidate.resourceLocks.some((lock) => lock.resource.startsWith("global/"))
          && !other.resourceLocks.some((lock) => lock.resource.startsWith("global/"))
        )
        || !executionIsActive(other)
      ) {
        continue;
      }
      for (const left of candidate.resourceLocks) {
        for (const right of other.resourceLocks) {
          if (
            (left.mode === "write" || right.mode === "write")
            && resourcesOverlap(left.resource, right.resource)
          ) {
            throw new JobResourceConflictError(
              candidate.id,
              other.id,
              left.resource
            );
          }
        }
      }
    }
  }

  _reconcileInterruptedJobs() {
    const interrupted = [...this.jobs.values()]
      .filter((job) => (
        job.status === "running"
        || job.status === "cancel_requested"
        || (job.status === "queued" && job.replayPayload == null)
      ))
      .sort(compareJobs);
    for (const current of interrupted) {
      const at = this._now();
      const wasDispatched = current.status !== "queued";
      const next = {
        ...current,
        revision: nextRevision(current),
        status: "interrupted",
        updatedAt: at,
        finishedAt: at,
        recoveredAt: at,
        cancel: current.status === "cancel_requested"
          ? {
              ...current.cancel,
              acknowledgedAt: at
            }
          : current.cancel,
        error: {
          code: wasDispatched
            ? "JOB_OUTCOME_UNCERTAIN"
            : "JOB_REPLAY_PAYLOAD_MISSING",
          message: wasDispatched
            ? "The runtime restarted after dispatch; the job was not replayed."
            : "The runtime restarted before dispatch, but no durable replay payload is available.",
          retryable: false
        }
      };
      this.jobs.set(current.id, next);
      this._commit("reconcile-interrupted", next);
    }
  }

  _runMutation(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("Job mutation must be a function.");
    }
    return this._withMutationLock(() => {
      this._restoreDurableState();
      if (!this.journalHealthy) {
        throw new JobStoreError(
          "JOB_PERSISTENCE_UNHEALTHY",
          "Job journal is corrupt, missing events, or exceeds its replay bound."
        );
      }
      return operation();
    });
  }

  _readAuthoritative(operation) {
    return this._withMutationLock(() => {
      this._restoreDurableState();
      return operation();
    });
  }

  _commit(op, job) {
    if (this.lockDepth < 1) {
      throw new Error("Job commits require the mutation lock.");
    }
    if (this.sequence >= MAX_SEQUENCE) {
      this._restoreDurableState();
      throw new RangeError("Job event sequence limit reached.");
    }
    const sequence = this.sequence + 1;
    const event = {
      version: 1,
      sequence,
      op,
      at: job.updatedAt,
      job: clone(job)
    };
    if (jsonByteLength(event) > MAX_EVENT_LINE_BYTES) {
      this._restoreDurableState();
      throw new RangeError("Job event exceeds its durable persistence bound.");
    }
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      // appendJsonLine can throw after fsync made the event authoritative.
      this._restoreDurableState();
      const durable = this.jobs.get(job.id);
      if (
        !this.journalHealthy
        || this.sequence !== sequence
        || !jobsEqual(durable, job)
      ) {
        throw error;
      }
      this._writeSnapshotBestEffort();
      return;
    }
    this.sequence = sequence;
    this._writeSnapshotBestEffort();
  }

  _writeSnapshotBestEffort() {
    const snapshot = {
      version: 1,
      sequence: this.sequence,
      updatedAt: this._now(),
      jobs: [...this.jobs.values()]
        .sort(compareJobs)
        .map(clone)
    };
    if (jsonByteLength(snapshot) > MAX_SNAPSHOT_BYTES) return;
    try {
      this.writeSnapshot(this.snapshotPath, snapshot);
    } catch {
      // JSONL is authoritative; the snapshot is a replaceable read cache.
    }
  }

  _restoreDurableState() {
    const snapshot = this._loadSnapshot();
    const replay = this._replayJournal(snapshot);
    this.jobs = replay.jobs;
    this.sequence = replay.sequence;
    this.journalHealthy = replay.healthy;
  }

  _loadSnapshot() {
    let text;
    try {
      text = readBoundedUtf8File(this.snapshotPath, MAX_SNAPSHOT_BYTES);
    } catch {
      return null;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isPlainRecord(raw) || !onlyKeys(raw, SNAPSHOT_FIELDS)) return null;
    if (
      raw.version !== 1
      || !Number.isSafeInteger(raw.sequence)
      || raw.sequence < 0
      || raw.sequence > MAX_SEQUENCE
      || !Array.isArray(raw.jobs)
      || raw.jobs.length > this.maxJobs
      || !validIso(raw.updatedAt)
    ) {
      return null;
    }
    const jobs = new Map();
    try {
      for (const value of raw.jobs) {
        const job = normalizeStoredJob(value, {
          maxInputBytes: this.maxInputBytes,
          maxMetadataBytes: this.maxMetadataBytes,
          maxResultBytes: this.maxResultBytes
        });
        if (jobs.has(job.id)) return null;
        if (hasIdempotencyCollision(jobs, job)) return null;
        jobs.set(job.id, job);
      }
    } catch {
      return null;
    }
    return { jobs, sequence: raw.sequence };
  }

  _replayJournal(snapshot) {
    let text;
    try {
      text = readBoundedUtf8File(this.eventsPath, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (snapshot) {
          return {
            ...snapshot,
            healthy: snapshot.sequence === 0
          };
        }
        return { jobs: new Map(), sequence: 0, healthy: true };
      }
      return snapshot
        ? { ...snapshot, healthy: false }
        : { jobs: new Map(), sequence: 0, healthy: false };
    }
    if (!text.trim()) {
      if (snapshot) {
        return {
          ...snapshot,
          healthy: snapshot.sequence === 0
        };
      }
      return { jobs: new Map(), sequence: 0, healthy: true };
    }

    const jobs = new Map();
    let sequence = 0;
    let healthy = true;
    for (const rawLine of text.split(/\r?\n/u)) {
      if (!rawLine) continue;
      if (Buffer.byteLength(rawLine, "utf8") > MAX_EVENT_LINE_BYTES) {
        healthy = false;
        break;
      }
      let raw;
      try {
        raw = JSON.parse(rawLine);
      } catch {
        healthy = false;
        break;
      }
      const event = normalizeEvent(raw, {
        maxInputBytes: this.maxInputBytes,
        maxMetadataBytes: this.maxMetadataBytes,
        maxResultBytes: this.maxResultBytes
      });
      if (!event || event.sequence !== sequence + 1) {
        healthy = false;
        break;
      }
      const previous = jobs.get(event.job.id) ?? null;
      if (
        (event.op === "start" && (previous || event.job.revision !== 1))
        || (
          event.op !== "start"
          && (
            !previous
            || event.job.revision !== previous.revision + 1
            || !storedTransitionValid(previous, event.job, event.op)
          )
        )
      ) {
        healthy = false;
        break;
      }
      if (!previous && hasIdempotencyCollision(jobs, event.job)) {
        healthy = false;
        break;
      }
      jobs.set(event.job.id, event.job);
      sequence = event.sequence;
      if (jobs.size > this.maxJobs) {
        healthy = false;
        break;
      }
    }
    if (snapshot && snapshot.sequence > sequence) {
      return { ...snapshot, healthy: false };
    }
    if (
      snapshot
      && snapshot.sequence === sequence
      && !jobMapsEqual(snapshot.jobs, jobs)
    ) {
      healthy = false;
    }
    return { jobs, sequence, healthy };
  }

  _requireJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobStoreError(
        "JOB_NOT_FOUND",
        `Job '${jobId}' does not exist.`,
        { jobId }
      );
    }
    return job;
  }

  _uniqueJobId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = createId("job");
      if (JOB_ID_RE.test(id) && !this.jobs.has(id)) return id;
    }
    throw new Error("Could not allocate a unique job id.");
  }

  _withMutationLock(operation) {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return operation();
      } finally {
        this.lockDepth -= 1;
      }
    }
    ensureDir(this.dir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new JobStoreError("JOB_STORE_BUSY", "Job store is busy.");
        }
        waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this._releaseLock(token);
    }
  }

  _claimSchedulerLease(token) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeExclusiveFile(this.schedulerLeasePath, token);
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = this._inspectSchedulerLease();
        if (!existing.recoverable || !this._removeSchedulerLease(existing)) {
          throw new JobStoreError(
            "JOB_SCHEDULER_LEASE_HELD",
            existing.ownerPid == null
              ? "The durable job scheduler lease is already held."
              : `The durable job scheduler lease is held by process ${existing.ownerPid}.`,
            {
              ownerPid: existing.ownerPid,
              acquiredAt: existing.acquiredAt
            }
          );
        }
      }
    }
    throw new JobStoreError(
      "JOB_SCHEDULER_LEASE_HELD",
      "The durable job scheduler lease could not be acquired."
    );
  }

  _inspectSchedulerLease() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.schedulerLeasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return {
          acquiredAt: null,
          content: null,
          ownerPid: null,
          recoverable: false
        };
      }
      content = readBoundedUtf8File(this.schedulerLeasePath, 2048);
    } catch {
      return {
        acquiredAt: null,
        content: null,
        ownerPid: null,
        recoverable: false
      };
    }
    let owner;
    try {
      owner = normalizeSchedulerLeaseRecord(JSON.parse(content));
    } catch {
      owner = null;
    }
    if (owner) {
      return {
        acquiredAt: owner.acquiredAt,
        content,
        ownerPid: owner.pid,
        recoverable: !processIsAlive(owner.pid)
      };
    }
    return {
      acquiredAt: null,
      content,
      ownerPid: null,
      recoverable: Date.now() - stat.mtimeMs >= this.staleLockMs
    };
  }

  _removeSchedulerLease(existing) {
    if (typeof existing?.content !== "string") return false;
    try {
      if (fs.readFileSync(this.schedulerLeasePath, "utf8") !== existing.content) {
        return false;
      }
      fs.unlinkSync(this.schedulerLeasePath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseSchedulerLeaseToken(token) {
    try {
      if (fs.readFileSync(this.schedulerLeasePath, "utf8") !== token) {
        return false;
      }
      fs.unlinkSync(this.schedulerLeasePath);
      return true;
    } catch {
      // Never delete a scheduler lease whose ownership token cannot be verified.
      return false;
    }
  }

  _breakStaleLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = readBoundedUtf8File(this.lockPath, 2048);
    } catch {
      return false;
    }
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Never delete a lock whose ownership token cannot be verified.
    }
  }

  _now() {
    const value = this.now();
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

function normalizeStartInput(source, limits) {
  const kind = normalizeKind(source.kind);
  const target = normalizeTarget(source.target);
  const projectId = normalizeProjectId(source.projectId ?? "default");
  const sessionId = normalizeSessionId(source.sessionId);
  const effect = normalizeEffect(source.effect ?? "read");
  const idempotent = source.idempotent ?? false;
  if (typeof idempotent !== "boolean") {
    throw new TypeError("idempotent must be a boolean.");
  }
  const maxAttempts = boundedPositiveInteger(
    source.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    MAX_ATTEMPTS,
    "maxAttempts"
  );
  if (!idempotent && maxAttempts !== 1 && source.maxAttempts !== undefined) {
    throw new TypeError("Non-idempotent jobs must use maxAttempts 1.");
  }
  const effectiveMaxAttempts = idempotent ? maxAttempts : 1;
  const resourceLocks = normalizeResourceLocks(source.resourceLocks);
  if (effect === "write" && !resourceLocks.some((lock) => lock.mode === "write")) {
    throw new JobStoreError(
      "JOB_RESOURCE_LOCK_REQUIRED",
      "Mutating jobs require at least one write resource lock."
    );
  }
  return {
    id: source.id == null ? null : normalizeJobId(source.id),
    kind,
    target,
    projectId,
    sessionId,
    parentJobId: source.parentJobId == null
      ? null
      : normalizeIdentifier(source.parentJobId, PARENT_JOB_ID_RE, "parentJobId"),
    effect,
    idempotencyKey: source.idempotencyKey == null
      ? null
      : normalizeIdentifier(
          source.idempotencyKey,
          SAFE_REF_RE,
          "idempotencyKey"
        ),
    idempotent,
    inputRef: source.inputRef == null
      ? null
      : normalizeIdentifier(source.inputRef, SAFE_REF_RE, "inputRef"),
    input: source.input === undefined
      ? null
      : normalizePersistedJson(source.input, "input", {
          maxBytes: limits.maxInputBytes
        }),
    replayPayload: source.replayPayload === undefined
      ? null
      : normalizePersistedJson(source.replayPayload, "replayPayload", {
          maxBytes: limits.maxInputBytes
        }),
    boundaries: normalizeBoundaries(source.boundaries, limits.maxMetadataBytes),
    resourceLocks,
    metadata: source.metadata === undefined
      ? {}
      : normalizePersistedJson(source.metadata, "metadata", {
          maxBytes: limits.maxMetadataBytes
        }),
    maxAttempts: effectiveMaxAttempts
  };
}

function normalizeStoredJob(raw, limits) {
  const source = plainRecord(raw, "stored job");
  assertOnlyKeys(source, JOB_FIELDS, "stored job");
  if (source.version !== 1) throw new TypeError("stored job version is invalid.");
  const revision = positiveSafeInteger(source.revision, "revision");
  const attempt = nonNegativeSafeInteger(source.attempt, "attempt");
  const maxAttempts = boundedPositiveInteger(
    source.maxAttempts,
    null,
    MAX_ATTEMPTS,
    "maxAttempts"
  );
  if (attempt > maxAttempts) throw new RangeError("attempt exceeds maxAttempts.");
  const status = normalizeStatus(source.status);
  const createdAt = normalizeIso(source.createdAt, "createdAt");
  const updatedAt = normalizeIso(source.updatedAt, "updatedAt");
  const startedAt = normalizeOptionalIso(source.startedAt, "startedAt");
  const finishedAt = normalizeOptionalIso(source.finishedAt, "finishedAt");
  const recoveredAt = normalizeOptionalIso(source.recoveredAt, "recoveredAt");
  const collectedAt = normalizeOptionalIso(source.collectedAt, "collectedAt");
  const cancel = normalizeCancel(source.cancel);
  const result = source.result == null
    ? null
    : normalizePersistedJson(source.result, "result", {
        maxBytes: limits.maxResultBytes
      });
  const toolOutputRef = source.toolOutputRef == null
    ? null
    : normalizeToolOutputRef(source.toolOutputRef);
  const error = source.error == null ? null : normalizeJobError(source.error);
  if (result != null && toolOutputRef != null) {
    throw new TypeError("stored job has both result and toolOutputRef.");
  }
  if (status === "queued" && (
    attempt !== 0
    || startedAt != null
    || finishedAt != null
    || recoveredAt != null
    || collectedAt != null
    || cancel.requestedAt != null
    || cancel.acknowledgedAt != null
    || result != null
    || toolOutputRef != null
    || error != null
  )) {
    throw new TypeError("queued job timestamps are invalid.");
  }
  if (status === "running" && startedAt == null) {
    throw new TypeError("active job requires startedAt.");
  }
  if (
    status === "cancel_requested"
    && (
      (attempt > 0 && startedAt == null)
      || (attempt === 0 && startedAt != null)
    )
  ) {
    throw new TypeError("cancel_requested job timestamps are invalid.");
  }
  if (
    status === "cancel_requested"
    && (
      cancel.requestedAt == null
      || cancel.acknowledgedAt != null
      || finishedAt != null
      || result != null
      || toolOutputRef != null
      || error != null
    )
  ) {
    throw new TypeError("cancel_requested job state is invalid.");
  }
  if (TERMINAL_STATUSES.has(status) && finishedAt == null) {
    throw new TypeError("terminal job requires finishedAt.");
  }
  if (status === "running" && (
    finishedAt != null
    || recoveredAt != null
    || collectedAt != null
    || cancel.requestedAt != null
    || cancel.acknowledgedAt != null
    || result != null
    || toolOutputRef != null
    || error != null
  )) {
    throw new TypeError("running job state is invalid.");
  }
  if (status === "succeeded" && error != null) {
    throw new TypeError("succeeded job cannot have an error.");
  }
  if (
    ["failed", "cancelled", "interrupted"].includes(status)
    && error == null
  ) {
    throw new TypeError(`${status} job requires an error.`);
  }
  if (
    status !== "succeeded"
    && (result != null || toolOutputRef != null)
  ) {
    throw new TypeError(`${status} job cannot contain a result.`);
  }
  if (
    status === "cancelled"
    && (cancel.requestedAt == null || cancel.acknowledgedAt == null)
  ) {
    throw new TypeError("cancelled job cancellation state is invalid.");
  }
  if (status === "interrupted" && recoveredAt == null) {
    throw new TypeError("interrupted job requires recoveredAt.");
  }
  if (status !== "interrupted" && recoveredAt != null) {
    throw new TypeError(`${status} job cannot contain recoveredAt.`);
  }
  if (collectedAt != null && !TERMINAL_STATUSES.has(status)) {
    throw new TypeError("only terminal jobs can be collected.");
  }
  if (source.idempotent === false && maxAttempts !== 1) {
    throw new TypeError("non-idempotent stored job must use maxAttempts 1.");
  }
  return {
    version: 1,
    id: normalizeJobId(source.id),
    revision,
    kind: normalizeKind(source.kind),
    target: normalizeTarget(source.target),
    projectId: normalizeProjectId(source.projectId),
    sessionId: normalizeSessionId(source.sessionId),
    parentJobId: source.parentJobId == null
      ? null
      : normalizeIdentifier(source.parentJobId, PARENT_JOB_ID_RE, "parentJobId"),
    effect: normalizeEffect(source.effect),
    idempotencyKey: source.idempotencyKey == null
      ? null
      : normalizeIdentifier(
          source.idempotencyKey,
          SAFE_REF_RE,
          "idempotencyKey"
        ),
    idempotent: requireBoolean(source.idempotent, "idempotent"),
    inputRef: source.inputRef == null
      ? null
      : normalizeIdentifier(source.inputRef, SAFE_REF_RE, "inputRef"),
    input: source.input == null
      ? null
      : normalizePersistedJson(source.input, "input", {
          maxBytes: limits.maxInputBytes
        }),
    replayPayload: source.replayPayload == null
      ? null
      : normalizePersistedJson(source.replayPayload, "replayPayload", {
          maxBytes: limits.maxInputBytes
        }),
    boundaries: normalizeBoundaries(source.boundaries, limits.maxMetadataBytes),
    resourceLocks: normalizeResourceLocks(source.resourceLocks),
    metadata: normalizePersistedJson(source.metadata, "metadata", {
      maxBytes: limits.maxMetadataBytes
    }),
    status,
    attempt,
    maxAttempts,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    recoveredAt,
    collectedAt,
    cancel,
    result,
    toolOutputRef,
    error
  };
}

function normalizeEvent(raw, limits) {
  try {
    const source = plainRecord(raw, "job event");
    assertOnlyKeys(source, EVENT_FIELDS, "job event");
    if (
      source.version !== 1
      || !Number.isSafeInteger(source.sequence)
      || source.sequence < 1
      || source.sequence > MAX_SEQUENCE
      || !EVENT_OPS.has(source.op)
      || !validIso(source.at)
    ) {
      return null;
    }
    const job = normalizeStoredJob(source.job, limits);
    if (job.updatedAt !== source.at) return null;
    return {
      version: 1,
      sequence: source.sequence,
      op: source.op,
      at: source.at,
      job
    };
  } catch {
    return null;
  }
}

function storedTransitionValid(previous, next, op) {
  if (
    previous.id !== next.id
    || previous.createdAt !== next.createdAt
    || previous.projectId !== next.projectId
    || previous.sessionId !== next.sessionId
    || previous.kind !== next.kind
    || previous.target !== next.target
    || previous.effect !== next.effect
    || previous.idempotencyKey !== next.idempotencyKey
    || previous.idempotent !== next.idempotent
    || previous.maxAttempts !== next.maxAttempts
    || previous.parentJobId !== next.parentJobId
    || JSON.stringify(previous.input) !== JSON.stringify(next.input)
    || previous.inputRef !== next.inputRef
    || JSON.stringify(previous.replayPayload) !== JSON.stringify(next.replayPayload)
    || JSON.stringify(previous.boundaries) !== JSON.stringify(next.boundaries)
    || JSON.stringify(previous.resourceLocks) !== JSON.stringify(next.resourceLocks)
    || JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata)
  ) {
    return false;
  }
  if (op === "collect") {
    return previous.status === next.status
      && previous.collectedAt == null
      && next.collectedAt != null;
  }
  if (op === "reconcile-interrupted") {
    return (
      previous.status === "running"
      || previous.status === "cancel_requested"
      || (previous.status === "queued" && previous.replayPayload == null)
    ) && next.status === "interrupted";
  }
  return transitionAllowed(previous.status, next.status);
}

function normalizeBoundaries(value, maxBytes) {
  const source = plainRecord(value, "boundaries");
  assertOnlyKeys(source, new Set(REQUIRED_BOUNDARIES), "boundaries");
  for (const field of REQUIRED_BOUNDARIES) {
    if (!(field in source) || source[field] == null) {
      throw new TypeError(`boundaries.${field} is required.`);
    }
  }
  return normalizePersistedJson(source, "boundaries", { maxBytes });
}

function normalizeResourceLocks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError("resourceLocks must be an array.");
  }
  if (value.length > 64) {
    throw new RangeError("resourceLocks must contain at most 64 entries.");
  }
  const byResource = new Map();
  for (const raw of value) {
    let resource;
    let mode;
    if (typeof raw === "string") {
      resource = normalizeResource(raw);
      mode = "write";
    } else {
      const entry = plainRecord(raw, "resource lock");
      assertOnlyKeys(entry, new Set(["mode", "resource"]), "resource lock");
      resource = normalizeResource(entry.resource);
      mode = entry.mode ?? "write";
      if (!LOCK_MODES.has(mode)) {
        throw new TypeError("resource lock mode must be read or write.");
      }
    }
    const existing = byResource.get(resource);
    if (!existing || mode === "write") byResource.set(resource, mode);
  }
  const ordered = [...byResource.entries()]
    .map(([resource, mode]) => ({ resource, mode }))
    .sort((left, right) => left.resource.localeCompare(right.resource));
  const collapsed = [];
  for (const lock of ordered) {
    const parent = collapsed.find((candidate) => resourcesOverlap(
      candidate.resource,
      lock.resource
    ));
    if (!parent) {
      collapsed.push(lock);
    } else if (lock.mode === "write") {
      parent.mode = "write";
    }
  }
  return collapsed;
}

function normalizeResource(value) {
  const resource = String(value ?? "").trim();
  if (!RESOURCE_RE.test(resource)) {
    throw new TypeError(
      "resource lock names must be 1-256 printable ASCII namespace characters."
    );
  }
  const normalized = resource
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/u, "")
    .toLowerCase();
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("resource lock names must not contain dot segments.");
  }
  return normalized;
}

function resourcesOverlap(left, right) {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function normalizeJobError(value) {
  if (value instanceof Error) {
    return {
      code: normalizeErrorCode(value.code),
      message: normalizeReason(value.message, "Job failed."),
      retryable: value.retryable === true
    };
  }
  if (typeof value === "string") {
    return {
      code: "JOB_FAILED",
      message: normalizeReason(value, "Job failed."),
      retryable: false
    };
  }
  const source = plainRecord(value ?? {}, "job error");
  assertOnlyKeys(
    source,
    new Set(["code", "message", "retryable"]),
    "job error"
  );
  return {
    code: normalizeErrorCode(source.code),
    message: normalizeReason(source.message, "Job failed."),
    retryable: source.retryable === true
  };
}

function normalizeErrorCode(value) {
  const code = String(value ?? "JOB_FAILED").trim().toUpperCase();
  return ERROR_CODE_RE.test(code) ? code : "JOB_FAILED";
}

function normalizeCancel(value) {
  const source = plainRecord(value, "cancel state");
  assertOnlyKeys(
    source,
    new Set(["acknowledgedAt", "reason", "requestedAt"]),
    "cancel state"
  );
  return {
    requestedAt: normalizeOptionalIso(source.requestedAt, "cancel.requestedAt"),
    reason: source.reason == null
      ? null
      : normalizeReason(source.reason, "Cancellation requested."),
    acknowledgedAt: normalizeOptionalIso(
      source.acknowledgedAt,
      "cancel.acknowledgedAt"
    )
  };
}

function normalizePersistedJson(value, label, { maxBytes }) {
  const counters = { nodes: 0 };
  const cloneValue = cloneJson(value, label, counters, 0, null);
  if (jsonByteLength(cloneValue) > maxBytes) {
    throw new RangeError(`${label} exceeds its durable persistence bound.`);
  }
  return cloneValue;
}

function cloneJson(value, label, counters, depth, key) {
  counters.nodes += 1;
  if (counters.nodes > MAX_JSON_NODES) {
    throw new RangeError(`${label} contains too many values.`);
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new RangeError(`${label} exceeds the maximum nesting depth.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 32_000) {
      throw new RangeError(`${label} contains an oversized string.`);
    }
    if (value.includes("\u0000")) {
      throw new TypeError(`${label} contains a NUL character.`);
    }
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new JobStoreError(
        "JOB_SECRET_VALUE_REJECTED",
        `${label} contains credential-like material; persist a secret reference instead.`
      );
    }
    if (key && SENSITIVE_KEY_RE.test(key) && !REFERENCE_KEY_RE.test(key)) {
      if (!/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) {
        throw new JobStoreError(
          "JOB_SECRET_VALUE_REJECTED",
          `${label}.${key} must contain a reference, not a credential value.`
        );
      }
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} must contain JSON data only.`);
  }
  if (utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must not contain proxies.`);
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) {
      throw new RangeError(`${label} contains an oversized array.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(
          `${label} must not contain sparse or accessor arrays.`
        );
      }
      output.push(cloneJson(
        descriptor.value,
        label,
        counters,
        depth + 1,
        key
      ));
    }
    return output;
  }
  const source = plainRecord(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const keys = Object.keys(descriptors);
  if (keys.length > 256) {
    throw new RangeError(`${label} contains too many object fields.`);
  }
  const output = {};
  for (const field of keys) {
    if (
      !/^[\x20-\x7E]{1,128}$/.test(field)
      || FORBIDDEN_OBJECT_KEYS.has(field)
    ) {
      throw new TypeError(`${label} contains an invalid object key.`);
    }
    const item = descriptors[field].value;
    if (
      SENSITIVE_KEY_RE.test(field)
      && !REFERENCE_KEY_RE.test(field)
      && item != null
      && typeof item !== "string"
    ) {
      throw new JobStoreError(
        "JOB_SECRET_VALUE_REJECTED",
        `${label}.${field} must contain a reference, not credential material.`
      );
    }
    output[field] = cloneJson(
      item,
      label,
      counters,
      depth + 1,
      field
    );
  }
  return output;
}

function normalizeMutationContext(value) {
  const source = plainRecord(value, "job mutation context");
  assertOnlyKeys(
    source,
    new Set(["expectedRevision", "projectId", "sessionId"]),
    "job mutation context"
  );
  return {
    expectedRevision: source.expectedRevision == null
      ? null
      : positiveSafeInteger(source.expectedRevision, "expectedRevision"),
    projectId: normalizeProjectId(source.projectId ?? "default"),
    sessionId: source.sessionId == null
      ? null
      : normalizeSessionId(source.sessionId)
  };
}

function normalizeReadScope(value) {
  const source = plainRecord(value, "job read scope");
  assertOnlyKeys(source, new Set(["projectId", "sessionId"]), "job read scope");
  return {
    projectId: normalizeProjectId(source.projectId ?? "default"),
    sessionId: source.sessionId == null
      ? null
      : normalizeSessionId(source.sessionId)
  };
}

function assertJobScope(job, scope) {
  if (job.projectId !== scope.projectId) {
    throw new JobStoreError(
      "PROJECT_BOUNDARY_VIOLATION",
      `Job '${job.id}' is outside project '${scope.projectId}'.`,
      { jobId: job.id, projectId: scope.projectId }
    );
  }
  if (scope.sessionId != null && job.sessionId !== scope.sessionId) {
    throw new JobStoreError(
      "JOB_SESSION_BOUNDARY_VIOLATION",
      `Job '${job.id}' is outside session '${scope.sessionId}'.`,
      { jobId: job.id, sessionId: scope.sessionId }
    );
  }
}

function assertExpectedRevision(job, expectedRevision) {
  if (expectedRevision != null && job.revision !== expectedRevision) {
    throw new JobRevisionError(job.id, expectedRevision, job.revision);
  }
}

function transitionAllowed(current, next) {
  if (current === "queued") {
    return next === "running"
      || next === "cancel_requested"
      || next === "failed";
  }
  if (current === "running") {
    return [
      "cancel_requested",
      "cancelled",
      "succeeded",
      "failed",
      "interrupted"
    ].includes(next);
  }
  if (current === "cancel_requested") {
    return ["cancelled", "succeeded", "failed", "interrupted"].includes(next);
  }
  return false;
}

function assertTransitionAllowed(current, next) {
  if (!transitionAllowed(current, next)) {
    throw new JobStoreError(
      "JOB_TRANSITION_INVALID",
      `Job cannot transition from '${current}' to '${next}'.`,
      { currentStatus: current, nextStatus: next }
    );
  }
}

function assertCollectable(job) {
  if (!TERMINAL_STATUSES.has(job.status)) {
    throw new JobStoreError(
      "JOB_NOT_READY",
      `Job '${job.id}' has not reached a terminal state.`,
      { jobId: job.id, status: job.status }
    );
  }
}

function collectionView(job) {
  return clone({
    id: job.id,
    revision: job.revision,
    status: job.status,
    result: job.result,
    toolOutputRef: job.toolOutputRef,
    error: job.error,
    finishedAt: job.finishedAt,
    collectedAt: job.collectedAt
  });
}

function statusView(job) {
  return clone({
    id: job.id,
    revision: job.revision,
    kind: job.kind,
    target: job.target,
    projectId: job.projectId,
    sessionId: job.sessionId,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    recoveredAt: job.recoveredAt,
    cancel: job.cancel,
    toolOutputRef: job.toolOutputRef,
    error: job.error
  });
}

function executionIsActive(job) {
  return job.status === "running"
    || (job.status === "cancel_requested" && job.startedAt != null);
}

function startSpecsEqual(job, normalized) {
  return (
    job.kind === normalized.kind
    && job.target === normalized.target
    && job.projectId === normalized.projectId
    && job.sessionId === normalized.sessionId
    && job.parentJobId === normalized.parentJobId
    && job.effect === normalized.effect
    && job.idempotencyKey === normalized.idempotencyKey
    && job.idempotent === normalized.idempotent
    && job.inputRef === normalized.inputRef
    && JSON.stringify(job.input) === JSON.stringify(normalized.input)
    && JSON.stringify(job.replayPayload) === JSON.stringify(normalized.replayPayload)
    && JSON.stringify(job.boundaries) === JSON.stringify(normalized.boundaries)
    && JSON.stringify(job.resourceLocks) === JSON.stringify(normalized.resourceLocks)
    && JSON.stringify(job.metadata) === JSON.stringify(normalized.metadata)
    && job.maxAttempts === normalized.maxAttempts
  );
}

function hasIdempotencyCollision(jobs, candidate) {
  if (!candidate.idempotencyKey) return false;
  for (const job of jobs.values()) {
    if (
      job.id !== candidate.id
      && job.projectId === candidate.projectId
      && job.sessionId === candidate.sessionId
      && job.idempotencyKey === candidate.idempotencyKey
    ) {
      return true;
    }
  }
  return false;
}

function normalizeJobId(value) {
  return normalizeIdentifier(value, JOB_ID_RE, "jobId");
}

function normalizeToolOutputRef(value) {
  return normalizeIdentifier(value, OUTPUT_REF_RE, "toolOutputRef");
}

function normalizeIdentifier(value, pattern, label) {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) throw new TypeError(`${label} is invalid.`);
  return normalized;
}

function normalizeProjectId(value) {
  return normalizeIdentifier(value, PROJECT_ID_RE, "projectId");
}

function normalizeSessionId(value) {
  return normalizeIdentifier(value, SESSION_ID_RE, "sessionId");
}

function normalizeTarget(value) {
  return normalizeIdentifier(value, TARGET_RE, "target");
}

function normalizeKind(value) {
  if (!KIND_SET.has(value)) {
    throw new TypeError(`kind must be one of: ${JOB_KINDS.join(", ")}.`);
  }
  return value;
}

function normalizeStatus(value) {
  if (!STATUS_SET.has(value)) {
    throw new TypeError(`status must be one of: ${JOB_STATUSES.join(", ")}.`);
  }
  return value;
}

function normalizeEffect(value) {
  if (!EFFECTS.has(value)) {
    throw new TypeError("effect must be read or write.");
  }
  return value;
}

function normalizeReason(value, fallback) {
  const normalized = String(value ?? fallback)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!normalized) return fallback;
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "Sensitive error or cancellation detail was withheld.";
  }
  return normalized.slice(0, 500);
}

function normalizeIso(value, label) {
  if (!validIso(value)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function normalizeOptionalIso(value, label) {
  return value == null ? null : normalizeIso(value, label);
}

function validIso(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function plainRecord(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string"
      || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        `${label} must contain enumerable data properties only.`
      );
    }
  }
  return value;
}

function isPlainRecord(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
  }
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function boundedPositiveInteger(value, fallback, maximum, label) {
  const candidate = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(candidate)
    || candidate < 1
    || candidate > maximum
  ) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return candidate;
}

function boundedNonNegativeInteger(value, fallback, maximum, label) {
  const candidate = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(candidate)
    || candidate < 0
    || candidate > maximum
  ) {
    throw new RangeError(`${label} must be an integer from 0 to ${maximum}.`);
  }
  return candidate;
}

function nextRevision(job) {
  if (job.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Job revision limit reached.");
  }
  return job.revision + 1;
}

function compareJobs(left, right) {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function jobsEqual(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function jobMapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [id, job] of left) {
    if (!jobsEqual(job, right.get(id))) return false;
  }
  return true;
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readBoundedUtf8File(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    throw new Error("Durable job path is not a regular file.");
  }
  if (stat.size > maxBytes) {
    throw new RangeError("Durable job file exceeds its read bound.");
  }
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSchedulerLeaseRecord(value) {
  const source = plainRecord(value, "scheduler lease");
  assertOnlyKeys(
    source,
    new Set(["acquiredAt", "nonce", "pid", "version"]),
    "scheduler lease"
  );
  if (source.version !== 1) {
    throw new TypeError("scheduler lease version must be 1.");
  }
  if (!Number.isSafeInteger(source.pid) || source.pid <= 0) {
    throw new TypeError("scheduler lease pid must be a positive integer.");
  }
  if (
    typeof source.acquiredAt !== "string"
    || source.acquiredAt.length > 64
    || Number.isNaN(new Date(source.acquiredAt).getTime())
  ) {
    throw new TypeError("scheduler lease acquiredAt must be an ISO timestamp.");
  }
  if (
    typeof source.nonce !== "string"
    || !/^[A-Za-z0-9.-]{8,192}$/.test(source.nonce)
  ) {
    throw new TypeError("scheduler lease nonce is invalid.");
  }
  return source;
}

function writeExclusiveFile(filePath, content) {
  let fd;
  let created = false;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
    fd = undefined;
    if (created) {
      try {
        if (fs.readFileSync(filePath, "utf8") === content) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Leave uncertain ownership in place for fail-closed recovery.
      }
    }
    throw error;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitSynchronously(milliseconds) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
}

function normalizeAbortSignal(value) {
  if (value == null) return null;
  if (
    typeof value !== "object"
    || typeof value.aborted !== "boolean"
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function"
  ) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Job wait was aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function abortableDelay(milliseconds, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const error = new Error("Job wait was aborted.");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function clone(value) {
  return structuredClone(value);
}

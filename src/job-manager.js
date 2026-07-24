import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  redactKnownValues,
  sanitizeForAudit
} from "./redact.js";
import { secretsStoreRedactionSnapshot } from "./secrets-store.js";

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_INLINE_RESULT_BYTES = 12_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_ABORT_GRACE_MS = 1_000;
const DEFAULT_AUTHORIZATION_POLL_MS = 250;
const DEFAULT_MAX_QUARANTINED = 3;
const DEFAULT_REPLAY_BATCH_SIZE = 500;
const MAX_WAIT_MS = 30_000;
const MAX_ARGUMENT_BYTES = 2 * 1024 * 1024;
const MAX_WAITERS = 128;
const MAX_GOAL_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 64_000;
const MAX_DURABLE_RESULT_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
const JOB_TOOL_NAMES = new Set([
  "job_start",
  "job_status",
  "job_wait",
  "job_collect",
  "job_cancel"
]);
const JOB_WRAPPER_TARGETS = new Set([
  "delegate_task",
  "execute_code"
]);
const LIVE_STATE = new WeakMap();
const PROCESS_JOB_COORDINATORS = new Map();

export class JobManager {
  constructor({
    runtime,
    store,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    maxInlineResultBytes = DEFAULT_MAX_INLINE_RESULT_BYTES,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
    authorizationPollMs = DEFAULT_AUTHORIZATION_POLL_MS,
    maxQuarantined = DEFAULT_MAX_QUARANTINED,
    replayBatchSize = DEFAULT_REPLAY_BATCH_SIZE
  } = {}) {
    if (!runtime) throw new Error("JobManager requires a runtime.");
    if (!store) throw new Error("JobManager requires a JobStore.");
    this.runtime = runtime;
    this.store = store;
    this.maxConcurrency = positiveInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    this.maxInlineResultBytes = positiveInteger(
      maxInlineResultBytes,
      DEFAULT_MAX_INLINE_RESULT_BYTES
    );
    this.closeTimeoutMs = positiveInteger(
      closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS
    );
    this.maxRuntimeMs = positiveInteger(maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);
    this.abortGraceMs = positiveInteger(abortGraceMs, DEFAULT_ABORT_GRACE_MS);
    this.authorizationPollMs = positiveInteger(
      authorizationPollMs,
      DEFAULT_AUTHORIZATION_POLL_MS
    );
    this.maxQuarantined = positiveInteger(
      maxQuarantined,
      DEFAULT_MAX_QUARANTINED
    );
    this.replayBatchSize = positiveInteger(
      replayBatchSize,
      DEFAULT_REPLAY_BATCH_SIZE
    );
    this.emitsEvents = true;
    this.schedulerLease = this.store.acquireSchedulerLease?.({
      shareProcess: true
    }) ?? null;
    this.coordinatorKey = String(
      this.store.schedulerLeasePath ?? this.store.dir ?? "default"
    );
    const coordinator = PROCESS_JOB_COORDINATORS.get(this.coordinatorKey)
      ?? {
        foreground: new Map(),
        quarantined: new Map(),
        references: 0
      };
    coordinator.references += 1;
    PROCESS_JOB_COORDINATORS.set(this.coordinatorKey, coordinator);
    LIVE_STATE.set(this, {
      active: new Map(),
      payloads: new Map(),
      draining: false,
      scheduled: false,
      retryTimer: null,
      waiters: 0,
      events: null,
      foreground: coordinator.foreground,
      quarantined: coordinator.quarantined,
      closed: false
    });
    this.runtime.tools?.bindJobCoordinator?.(this);
  }

  start(input, context = {}) {
    const normalized = normalizeJobStart(this.runtime, input, context);
    const payload = {
      args: normalized.args,
      parentContext: normalized.parentContext,
      projectId: normalized.projectId,
      sessionId: normalized.sessionId,
      targetApprovalRevision: normalized.targetApprovalRevision,
      unlinkAbort: null
    };
    const record = this.store.start({
      kind: normalized.kind,
      target: normalized.target,
      projectId: normalized.projectId,
      sessionId: normalized.sessionId,
      effect: normalized.effect,
      idempotencyKey: normalized.idempotencyKey,
      idempotent: normalized.idempotent,
      resourceLocks: normalized.resourceLocks,
      input: normalized.request,
      replayPayload: normalized.replayPayload,
      boundaries: normalized.boundaries,
      metadata: normalized.metadata,
      maxAttempts: 1
    }, {
      projectId: normalized.projectId,
      sessionId: normalized.sessionId
    });
    const state = privateState(this);
    if (record.status === "queued") {
      state.payloads.set(record.id, payload);
      this._linkParentAbort(record, context.__abortSignal);
      this._scheduleDrain();
    }
    const visible = this.store.get(record.id, {
      projectId: normalized.projectId,
      sessionId: normalized.sessionId
    });
    if (visible?.status === "queued") this._emit(visible);
    return this.store.status(record.id, {
      projectId: normalized.projectId,
      sessionId: normalized.sessionId
    });
  }

  status(jobId, context = {}) {
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: true
    });
    const scope = jobReadScope(project, context);
    const status = this.store.status(jobId, scope);
    return status;
  }

  list(filters = {}, context = {}) {
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: true
    });
    const scope = jobReadScope(project, context);
    const rows = this.store.list({
      ...filters,
      ...scope
    });
    return rows.map((row) => this.store.status(row.id, scope));
  }

  async wait(jobId, { timeoutMs = MAX_WAIT_MS } = {}, context = {}) {
    const boundedTimeout = Math.min(
      MAX_WAIT_MS,
      positiveInteger(timeoutMs, MAX_WAIT_MS)
    );
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: true
    });
    const scope = jobReadScope(project, context);
    const state = privateState(this);
    if (state.waiters >= MAX_WAITERS) {
      throw new Error(`Durable job waiter limit reached (${MAX_WAITERS}).`);
    }
    state.waiters += 1;
    try {
      const record = await this.store.wait(jobId, {
        timeoutMs: boundedTimeout,
        ...scope,
        signal: context.__abortSignal
      });
      return record
        ? { ...this.store.status(record.id, scope), timedOut: false }
        : null;
    } catch (error) {
      if (error?.code !== "JOB_WAIT_TIMEOUT") throw error;
      const status = this.status(jobId, context);
      return status ? { ...status, timedOut: true } : null;
    } finally {
      state.waiters -= 1;
    }
  }

  collect(jobId, {
    offset = 0,
    maxChars = 12_000
  } = {}, context = {}) {
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: true
    });
    const scope = jobReadScope(project, context);
    const collected = this.store.collect(jobId, scope);
    if (!collected) return null;
    const job = this.status(jobId, context);
    if (collected.toolOutputRef) {
      return {
        job,
        output: this.runtime.toolOutputs.read(collected.toolOutputRef, {
          offset,
          maxChars,
          projectId: project.id
        })
      };
    }
    return {
      job,
      output: collected.result ?? null
    };
  }

  cancel(jobId, context = {}) {
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: true
    });
    const scope = jobReadScope(project, context);
    const current = this.store.get(jobId, scope);
    if (!current) throw new Error(`Job '${String(jobId ?? "")}' was not found.`);
    const state = privateState(this);
    const active = state.active.get(current.id);
    const requested = this.store.cancel(current.id, {
      reason: `Cancellation requested by ${jobActor(context)}.`
    }, {
      expectedRevision: current.revision,
      projectId: current.projectId,
      sessionId: current.sessionId
    });
    if (active) {
      active.controller.abort(new Error("durable job cancelled"));
    }
    let cancelled = requested;
    if (
      !active
      && current.status === "queued"
      && requested.status === "cancel_requested"
    ) {
      cancelled = this.store.markCancelled(current.id, {
        reason: "Cancelled before dispatch."
      }, {
        expectedRevision: requested.revision,
        projectId: current.projectId,
        sessionId: current.sessionId
      });
      this._forgetPayload(current.id);
    }
    this._emit(cancelled);
    this._scheduleDrain();
    return this.store.status(cancelled.id, scope);
  }

  resume() {
    const state = privateState(this);
    if (state.closed) return;
    for (const record of this.store.queued({
      limit: this.replayBatchSize
    })) {
      if (state.payloads.has(record.id)) continue;
      const replay = record.replayPayload;
      if (!replay?.args || !replay?.parentContext) continue;
      state.payloads.set(record.id, {
        args: replay.args,
        parentContext: replay.parentContext,
        projectId: record.projectId,
        sessionId: record.sessionId,
        targetApprovalRevision: null,
        unlinkAbort: null
      });
    }
    this._scheduleDrain();
  }

  bindEvents(events) {
    privateState(this).events = events ?? null;
  }

  async close() {
    const state = privateState(this);
    if (state.closed) return;
    state.closed = true;
    for (const { controller } of state.active.values()) {
      controller.abort(new Error("job manager closed"));
    }
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    const settlement = Promise.allSettled(
      [
        ...[...state.active.values()].map((entry) => entry.promise),
        ...[...state.quarantined.values()]
          .filter((entry) => entry.owner === this)
          .map((entry) => entry.promise)
      ]
    );
    let fullySettled = false;
    void settlement.then(() => {
      fullySettled = true;
    });
    let timer;
    await Promise.race([
      settlement,
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.closeTimeoutMs);
      })
    ]);
    if (timer) clearTimeout(timer);
    if (fullySettled) {
      state.active.clear();
    }
    for (const jobId of [...state.payloads.keys()]) this._forgetPayload(jobId);
    if (fullySettled) this._releaseSchedulerLeaseIfIdle();
  }

  acquireToolInvocation(tool, args, context = {}) {
    if (tool?.sideEffects === false) return () => {};
    const project = authorizeContextProject(this.runtime, context, {
      includeArchived: false
    });
    const required = resolveTrustedJobResources({
      args,
      project,
      projectId: project.id,
      tool
    });
    const jobId = String(context.__jobId ?? "").trim();
    if (jobId) {
      const record = this.store.get(jobId, {
        projectId: project.id,
        sessionId: String(context.sessionId ?? "").trim() || null
      });
      if (!record || record.status !== "running") {
        throw new Error("Durable job no longer owns an active mutation lease.");
      }
      assertLocksCover(record.resourceLocks, required);
      assertToolIdentity(record, tool);
      return () => {};
    }

    for (const record of this.store.listAll({ limit: 2_000 })) {
      if (
        (record.status === "running" || record.status === "cancel_requested")
        && lockSetsConflict(record.resourceLocks, required)
      ) {
        throw new Error(
          `Mutation conflicts with active durable job '${record.id}'.`
        );
      }
    }
    const state = privateState(this);
    for (const lease of state.quarantined.values()) {
      if (lockSetsConflict(lease.resourceLocks, required)) {
        throw new Error(
          "Mutation conflicts with a quarantined durable invocation."
        );
      }
    }
    for (const lease of state.foreground.values()) {
      if (lockSetsConflict(lease.resourceLocks, required)) {
        throw new Error("Mutation conflicts with another active invocation.");
      }
    }
    const leaseId = crypto.randomUUID();
    state.foreground.set(leaseId, {
      owner: this,
      resourceLocks: required
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.foreground.delete(leaseId);
      this._scheduleDrain();
      this._releaseSchedulerLeaseIfIdle();
    };
  }

  _linkParentAbort(record, signal) {
    if (!signal?.addEventListener) return;
    const jobId = record.id;
    const abort = () => {
      const state = privateState(this);
      const payload = state.payloads.get(jobId);
      if (!payload) return;
      const active = state.active.get(jobId);
      let forgetPayload = false;
      let emitted = null;
      try {
        const current = this.store.get(jobId, {
          projectId: record.projectId,
          sessionId: record.sessionId
        });
        if (
          current.status === "queued"
          || current.status === "running"
        ) {
          const requested = this.store.cancel(jobId, {
            reason: "Parent execution was aborted."
          }, {
            expectedRevision: current.revision,
            projectId: current.projectId,
            sessionId: current.sessionId
          });
          emitted = requested;
          if (active) {
            active.controller.abort(signal.reason);
          } else if (requested.status === "cancel_requested") {
            emitted = this.store.markCancelled(jobId, {
              reason: "Parent aborted before dispatch."
            }, {
              expectedRevision: requested.revision,
              projectId: current.projectId,
              sessionId: current.sessionId
            });
            forgetPayload = true;
          }
        }
      } catch {
        // Cancellation is best effort after a competing terminal transition.
      } finally {
        if (emitted) this._emit(emitted);
        if (forgetPayload) this._forgetPayload(jobId);
      }
    };
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      const payload = privateState(this).payloads.get(jobId);
      if (payload) {
        payload.unlinkAbort = () => signal.removeEventListener("abort", abort);
      }
    }
  }

  _scheduleDrain() {
    const state = privateState(this);
    if (state.closed || state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      void this._drain();
    });
  }

  async _drain() {
    const state = privateState(this);
    if (state.closed || state.draining) return;
    state.draining = true;
    try {
      const skipped = new Set();
      while (
        state.active.size < this.maxConcurrency
        && state.quarantined.size < this.maxQuarantined
      ) {
        const candidate = this._nextRunnable(skipped);
        if (!candidate) break;
        const payload = state.payloads.get(candidate.id)
          ?? this._hydrateReplayPayload(candidate);
        if (!payload) {
          skipped.add(candidate.id);
          continue;
        }
        if ([...state.foreground.values()].some((locks) => (
          lockSetsConflict(candidate.resourceLocks, locks.resourceLocks)
        ))) {
          skipped.add(candidate.id);
          continue;
        }
        if ([...state.quarantined.values()].some((lease) => (
          lockSetsConflict(candidate.resourceLocks, lease.resourceLocks)
        ))) {
          skipped.add(candidate.id);
          continue;
        }
        try {
          validateDispatch(this.runtime, candidate, payload);
        } catch (error) {
          const failed = this.store.fail(candidate.id, {
            code: "JOB_DISPATCH_BOUNDARY_CHANGED",
            message: safeError(error),
            retryable: false
          }, {
            expectedRevision: candidate.revision,
            projectId: candidate.projectId,
            sessionId: candidate.sessionId
          });
          this._emit(failed);
          this._forgetPayload(candidate.id);
          continue;
        }
        let running;
        try {
          running = this.store.markRunning(candidate.id, {
            expectedRevision: candidate.revision,
            projectId: candidate.projectId,
            sessionId: candidate.sessionId
          });
        } catch {
          skipped.add(candidate.id);
          continue;
        }
        this._emit(running);
        const controller = new AbortController();
        const promise = this._execute(running, payload, controller)
          .catch((error) => this._settleUnexpected(running, error))
          .finally(() => {
            const live = privateState(this);
            live.active.delete(running.id);
            this._forgetPayload(running.id);
            this._scheduleDrain();
            this._releaseSchedulerLeaseIfIdle();
          });
        state.active.set(running.id, {
          controller,
          promise,
          resourceLocks: running.resourceLocks ?? []
        });
      }
    } finally {
      state.draining = false;
      if (
        !state.closed
        && state.active.size < this.maxConcurrency
        && state.quarantined.size < this.maxQuarantined
        && this.store.queued({ limit: this.replayBatchSize })
          .some((job) => state.payloads.has(job.id))
      ) {
        this._scheduleRetry();
      }
    }
  }

  _nextRunnable(skipped = new Set()) {
    const queued = this.store.queued({ limit: this.replayBatchSize });
    for (const job of queued) {
      if (!skipped.has(job.id)) return job;
    }
    return null;
  }

  async _execute(record, payload, controller) {
    let project;
    try {
      project = authorizeJobProject(this.runtime, record);
    } catch (error) {
      this.store.fail(record.id, {
        code: "PROJECT_AUTHORIZATION_FAILED",
        message: safeError(error),
        retryable: false
      }, {
        expectedRevision: record.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(this.store.get(record.id, {
        projectId: record.projectId,
        sessionId: record.sessionId
      }));
      return;
    }
    const onToolEvent = (event) => {
      try { payload.parentContext.__onToolEvent?.(event); } catch { /* advisory */ }
      this._emit({
        id: record.id,
        projectId: record.projectId,
        sessionId: record.sessionId,
        status: event?.phase === "awaiting-approval"
          ? "waiting_approval"
          : "running",
        pendingActionId: event?.actionId ?? null
      });
    };
    const context = {
      from: payload.parentContext.from,
      target: payload.parentContext.target,
      agentId: payload.parentContext.agentId,
      sessionId: record.sessionId,
      channel: "job",
      runtime: this.runtime,
      __projectId: record.projectId,
      __projectRevision: project.revision,
      __allowedTools: payload.parentContext.__allowedTools,
      __scrutinyPolicy: payload.parentContext.__scrutinyPolicy,
      __reason: payload.parentContext.__reason,
      __memoryScope: payload.parentContext.__memoryScope,
      __spawnDepth: payload.parentContext.__spawnDepth,
      __budgetEnvelope: payload.parentContext.__budgetEnvelope,
      __turnDeadline: payload.parentContext.__turnDeadline,
      __remainingIterations: payload.parentContext.__remainingIterations,
      __jobId: record.id,
      __jobResourceLocks: record.resourceLocks,
      __turnId: `job:${record.id}`,
      __abortSignal: controller.signal,
      __idempotencyKey: `job:${record.id}:dispatch`,
      __onToolEvent: onToolEvent
    };
    let outcome;
    try {
      outcome = await this._invokeWithGuards(
        record,
        controller,
        () => this.runtime.tools.invoke(
          record.kind === "subagent" ? "delegate_task" : record.target,
          payload.args,
          context
        )
      );
    } catch (error) {
      outcome = {
        ok: false,
        error: safeError(error),
        outcome: {
          status: controller.signal.aborted ? "cancelled" : "failure",
          code: controller.signal.aborted ? "job_cancelled" : "job_execution_error"
        }
      };
    }

    let latest;
    try {
      latest = this.store.get(record.id, {
        projectId: record.projectId,
        sessionId: record.sessionId
      });
    } catch {
      return;
    }
    if (latest.status === "cancelled" || latest.status === "interrupted") return;

    const safeOutcome = redactJobValue(this.runtime, outcome);
    if (latest.status === "cancel_requested") {
      const cancelled = this.store.markCancelled(record.id, {
        reason: latest.cancel?.reason
          ?? "Cancellation completed after target settlement."
      }, {
        expectedRevision: latest.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(cancelled);
      return;
    }
    if (!outcome?.ok) {
      const failed = this.store.fail(record.id, {
        code: safeErrorCode(safeOutcome?.outcome?.code),
        message: safeOutcome?.error ?? "Job target failed.",
        retryable: safeOutcome?.outcome?.retryable === true
      }, {
        expectedRevision: latest.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(failed);
      return;
    }

    const serialized = safeJson(safeOutcome);
    if (Buffer.byteLength(serialized, "utf8") > MAX_DURABLE_RESULT_BYTES) {
      const failed = this.store.fail(record.id, {
        code: "JOB_RESULT_TOO_LARGE",
        message: "Job result exceeded the durable output bound.",
        retryable: false
      }, {
        expectedRevision: latest.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(failed);
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxInlineResultBytes) {
      const ref = this.runtime.toolOutputs.put(serialized, {
        projectId: record.projectId,
        ownerType: "durable-job",
        ownerId: record.id
      });
      const completed = this.store.complete(record.id, {
        toolOutputRef: ref
      }, {
        expectedRevision: latest.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(completed);
      return;
    }
    const completed = this.store.complete(record.id, {
      result: safeOutcome
    }, {
      expectedRevision: latest.revision,
      projectId: record.projectId,
      sessionId: record.sessionId
    });
    this._emit(completed);
  }

  async _invokeWithGuards(record, controller, invoke) {
    const state = privateState(this);
    let settled = false;
    let triggered = false;
    let runtimeTimer = null;
    let graceTimer = null;
    let authorizationTimer = null;
    let resolveGuard;
    const guard = new Promise((resolve) => {
      resolveGuard = resolve;
    });
    const invocation = Promise.resolve()
      .then(invoke);
    void invocation.then(
      () => { settled = true; },
      () => { settled = true; }
    );

    const quarantine = (reason, code) => {
      if (settled || triggered) return;
      if (!this._requestExecutionCancellation(record, reason)) return;
      triggered = true;
      if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        const cleanup = () => {
          const live = privateState(this);
          live.quarantined.delete(record.id);
          this._scheduleDrain();
          this._releaseSchedulerLeaseIfIdle();
        };
        const completion = invocation.then(cleanup, cleanup);
        state.quarantined.set(record.id, {
          owner: this,
          promise: completion,
          resourceLocks: record.resourceLocks ?? []
        });
        resolveGuard({
          ok: false,
          error: reason,
          outcome: {
            status: "cancelled",
            code,
            retryable: false
          }
        });
      }, this.abortGraceMs);
      graceTimer.unref?.();
    };
    const onAbort = () => quarantine(
      "Durable job cancellation did not settle within its grace period.",
      "job_cancelled"
    );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    runtimeTimer = setTimeout(() => quarantine(
      `Durable job exceeded its ${this.maxRuntimeMs}ms runtime bound.`,
      "job_runtime_exceeded"
    ), this.maxRuntimeMs);
    runtimeTimer.unref?.();
    authorizationTimer = setInterval(() => {
      try {
        authorizeJobProject(this.runtime, record);
      } catch {
        quarantine(
          "Durable job project authorization changed during execution.",
          "project_authorization_changed"
        );
      }
    }, this.authorizationPollMs);
    authorizationTimer.unref?.();

    try {
      return await Promise.race([invocation, guard]);
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (authorizationTimer) clearInterval(authorizationTimer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  _requestExecutionCancellation(record, reason) {
    try {
      const current = this.store.get(record.id, {
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      if (!current) return false;
      if (current.status === "cancel_requested") return true;
      if (current.status !== "running") return false;
      const requested = this.store.cancel(record.id, { reason }, {
        expectedRevision: current.revision,
        projectId: record.projectId,
        sessionId: record.sessionId
      });
      this._emit(requested);
      return requested.status === "cancel_requested";
    } catch {
      return false;
    }
  }

  _releaseSchedulerLeaseIfIdle() {
    const state = privateState(this);
    if (
      !state.closed
      || state.active.size > 0
      || [...state.foreground.values()].some((entry) => entry.owner === this)
      || [...state.quarantined.values()].some((entry) => entry.owner === this)
      || !this.schedulerLease
    ) {
      return false;
    }
    this.store.releaseSchedulerLease?.(this.schedulerLease);
    this.schedulerLease = null;
    const coordinator = PROCESS_JOB_COORDINATORS.get(this.coordinatorKey);
    if (coordinator) {
      coordinator.references = Math.max(0, coordinator.references - 1);
      if (
        coordinator.references === 0
        && coordinator.foreground.size === 0
        && coordinator.quarantined.size === 0
      ) {
        PROCESS_JOB_COORDINATORS.delete(this.coordinatorKey);
      }
    }
    return true;
  }

  _settleUnexpected(record, error) {
    let current;
    try {
      current = this.store.get(record.id, {
        projectId: record.projectId,
        sessionId: record.sessionId
      });
    } catch {
      return;
    }
    if (!current || ["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)) {
      return;
    }
    try {
      const settled = current.status === "cancel_requested"
        ? this.store.markCancelled(record.id, {
            reason: "Cancellation completed after runner failure."
          }, {
            expectedRevision: current.revision,
            projectId: record.projectId,
            sessionId: record.sessionId
          })
        : this.store.fail(record.id, {
            code: "JOB_RUNNER_FAILED",
            message: safeError(error),
            retryable: false
          }, {
            expectedRevision: current.revision,
            projectId: record.projectId,
            sessionId: record.sessionId
          });
      this._emit(settled);
    } catch {
      // A concurrent terminal transition won.
    }
  }

  _scheduleRetry() {
    const state = privateState(this);
    if (state.closed || state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      this._scheduleDrain();
    }, 50);
    state.retryTimer.unref?.();
  }

  _forgetPayload(jobId) {
    const payload = privateState(this).payloads.get(jobId);
    try { payload?.unlinkAbort?.(); } catch { /* advisory */ }
    privateState(this).payloads.delete(jobId);
  }

  _hydrateReplayPayload(record) {
    const replay = record?.replayPayload;
    if (!replay?.args || !replay?.parentContext) return null;
    const payload = {
      args: replay.args,
      parentContext: replay.parentContext,
      projectId: record.projectId,
      sessionId: record.sessionId,
      targetApprovalRevision: null,
      unlinkAbort: null
    };
    privateState(this).payloads.set(record.id, payload);
    return payload;
  }

  _emit(record) {
    if (!record?.id) return;
    const event = sanitizeForAudit({
      id: record.id,
      projectId: record.projectId,
      sessionId: record.sessionId ?? null,
      status: record.status,
      revision: record.revision ?? null,
      updatedAt: record.updatedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      pendingActionId: record.pendingActionId ?? null
    });
    const bus = privateState(this).events ?? this.runtime.events;
    try { bus?.emit?.("job", event); } catch { /* advisory */ }
  }
}

export function registerJobTools(registry, runtime) {
  registry.register({
    name: "job_start",
    sideEffects: true,
    description: "Start one durable bounded background job for a direct tool or an isolated subagent. Mutating work must declare disjoint resource locks.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["tool", "subagent"] },
        tool: { type: "string" },
        arguments: { type: "object" },
        goal: { type: "string" },
        context: { type: "string" },
        role: { type: "string", enum: ["leaf", "orchestrator"] },
        resourceLocks: {
          type: "array",
          items: { type: "string" },
          maxItems: 32
        }
      },
      required: ["kind"],
      additionalProperties: false
    },
    summarize: (args) => `Start ${args.kind === "subagent" ? "subagent" : String(args.tool ?? "tool")} job`,
    handler: async (args, context) => runtime.jobs.start(args, context)
  });

  registry.register({
    name: "job_status",
    sideEffects: false,
    description: "Read the current durable status and bounded receipt for one background job.",
    parameters: jobIdSchema(),
    handler: async ({ jobId }, context) => runtime.jobs.status(jobId, context)
  });

  registry.register({
    name: "job_wait",
    sideEffects: false,
    description: "Wait up to 30 seconds for one durable job to change or reach a terminal state.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_WAIT_MS }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    handler: async ({ jobId, timeoutMs }, context) => runtime.jobs.wait(
      jobId,
      { timeoutMs },
      context
    )
  });

  registry.register({
    name: "job_collect",
    sideEffects: false,
    description: "Collect a completed job result or read a bounded chunk through its durable tool-output reference.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 50_000 }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    handler: async ({ jobId, offset, maxChars }, context) => runtime.jobs.collect(
      jobId,
      { offset, maxChars },
      context
    )
  });

  registry.register({
    name: "job_cancel",
    sideEffects: true,
    description: "Cancel one queued or running durable job in the current project.",
    parameters: jobIdSchema(),
    summarize: ({ jobId }) => `Cancel durable job ${String(jobId ?? "").slice(0, 80)}`,
    handler: async ({ jobId }, context) => runtime.jobs.cancel(jobId, context)
  });
}

function normalizeJobStart(runtime, input, context) {
  const source = clonePlainJsonObject(input, "job input");
  const requestedKind = source.kind === "subagent"
    ? "subagent"
    : source.kind === "tool"
      ? "tool"
      : null;
  if (!requestedKind) throw new Error("Job kind must be tool or subagent.");
  const sessionId = String(context.sessionId ?? "").trim();
  if (!sessionId) throw new Error("Durable jobs require a parent session.");
  const project = authorizeContextProject(runtime, context, { requireSession: true });
  const projectId = project.id;

  let target;
  let args;
  let effect;
  let idempotent;
  let directTool = null;
  if (requestedKind === "tool") {
    target = String(source.tool ?? "").trim();
    if (!target) throw new Error("A direct-tool job requires tool.");
    if (JOB_TOOL_NAMES.has(target) || JOB_WRAPPER_TARGETS.has(target)) {
      throw new Error("Durable job control and execution wrappers cannot be direct job targets.");
    }
    const tool = runtime.tools.get(target);
    if (!tool || typeof tool.forwardInvocation === "function") {
      throw new Error(`Direct job target '${target}' is unavailable.`);
    }
    directTool = tool;
    args = clonePlainJsonObject(source.arguments ?? {}, "job arguments");
    effect = tool.sideEffects === false ? "read" : "write";
    idempotent = tool.capability?.idempotent === true;
  } else {
    target = "delegate_task";
    const goal = String(source.goal ?? "").trim();
    if (!goal) throw new Error("A subagent job requires goal.");
    if (goal.length > MAX_GOAL_CHARS) {
      throw new RangeError(`Subagent goal exceeds ${MAX_GOAL_CHARS} characters.`);
    }
    const background = String(source.context ?? "").trim();
    if (background.length > MAX_CONTEXT_CHARS) {
      throw new RangeError(`Subagent context exceeds ${MAX_CONTEXT_CHARS} characters.`);
    }
    args = {
      goal,
      context: background,
      role: source.role === "orchestrator" ? "orchestrator" : "leaf"
    };
    effect = "write";
    idempotent = false;
  }
  const argsJson = safeJson(args);
  if (Buffer.byteLength(argsJson, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new RangeError("Job arguments exceed the bounded live payload size.");
  }
  const declaredResourceLocks = normalizeResourceLocks(
    source.resourceLocks,
    projectId,
    effect
  );
  if (effect === "write" && declaredResourceLocks.length === 0) {
    throw new Error("Mutating jobs require at least one declared resource lock.");
  }
  const trustedResourceLocks = effect === "write"
    ? resolveTrustedJobResources({
        args,
        project,
        projectId,
        tool: directTool
      })
    : [];
  const resourceLocks = normalizeResourceLocks(
    [...declaredResourceLocks, ...trustedResourceLocks],
    projectId,
    effect
  );
  const parentContext = executionContextSnapshot(context);
  const persistedParentContext = {
    ...parentContext,
    __onToolEvent: undefined
  };
  delete persistedParentContext.__onToolEvent;
  const replayPayload = safeReplayPayload(runtime, {
    args,
    parentContext: persistedParentContext
  });
  const idempotencyKey = normalizeIdempotencyKey(context.__idempotencyKey);
  return {
    kind: requestedKind === "tool" ? "direct-tool" : "subagent",
    target,
    args,
    parentContext,
    effect,
    idempotent,
    idempotencyKey,
    projectId,
    sessionId,
    resourceLocks,
    replayPayload,
    request: {
      argsBytes: Buffer.byteLength(argsJson, "utf8"),
      argsSha256: crypto.createHash("sha256").update(argsJson).digest("hex"),
      goalChars: requestedKind === "subagent" ? args.goal.length : 0,
      contextChars: requestedKind === "subagent" ? args.context.length : 0,
      replayable: replayPayload != null
    },
    boundaries: {
      approval: true,
      budget: true,
      abort: true,
      checkpoint: true,
      policy: true,
      redaction: true
    },
    metadata: {
      projectRevision: project.revision,
      targetIdentity: directTool ? stableToolIdentity(directTool) : null,
      scrutinyPolicy: context.__scrutinyPolicy ?? null,
      allowedTools: Array.isArray(context.__allowedTools)
        ? [...context.__allowedTools].map(String).sort()
        : null,
      submittedBy: jobActor(context)
    },
    targetApprovalRevision: directTool?.approvalRevision ?? null
  };
}

function executionContextSnapshot(context) {
  return {
    from: context.from ?? "job-parent",
    target: context.target ?? context.from ?? "job-parent",
    agentId: context.agentId ?? "main",
    sessionId: context.sessionId,
    __scrutinyPolicy: context.__scrutinyPolicy ?? null,
    __reason: context.__reason ?? null,
    __allowedTools: Array.isArray(context.__allowedTools)
      ? [...context.__allowedTools]
      : null,
    __memoryScope: context.__memoryScope ?? null,
    __spawnDepth: Number.isInteger(context.__spawnDepth)
      ? context.__spawnDepth
      : 0,
    __budgetEnvelope: context.__budgetEnvelope ?? null,
    __turnDeadline: Number.isFinite(context.__turnDeadline)
      ? context.__turnDeadline
      : null,
    __remainingIterations: Number.isSafeInteger(context.__remainingIterations)
      ? Math.max(0, context.__remainingIterations)
      : null,
    __onToolEvent: typeof context.__onToolEvent === "function"
      ? context.__onToolEvent
      : null
  };
}

function normalizeResourceLocks(value, projectId, effect) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError("resourceLocks must be an array.");
  if (value.length > 32) throw new RangeError("resourceLocks exceeds 32 entries.");
  const locks = value.map((item, index) => {
    const raw = typeof item === "string" ? item : item?.resource;
    const lock = String(raw ?? "").trim().toLowerCase()
      .replaceAll("\\", "/")
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");
    if (!/^[a-z0-9][a-z0-9._:/-]{0,191}$/.test(lock)) {
      throw new Error(`resourceLocks[${index}] is invalid.`);
    }
    if (lock.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error(`resourceLocks[${index}] contains a dot segment.`);
    }
    if (
      lock.startsWith("project/")
      && lock !== `project/${projectId}`
      && !lock.startsWith(`project/${projectId}/`)
    ) {
      throw new Error(`resourceLocks[${index}] is outside the current project.`);
    }
    const resource = lock.startsWith("global/")
      ? lock
      : lock.startsWith(`project/${projectId}/`)
        ? lock
        : `project/${projectId}/${lock}`;
    const requestedMode = typeof item === "object" && item !== null
      ? item.mode
      : null;
    const mode = effect === "write"
      ? "write"
      : requestedMode === "write"
        ? "write"
        : "read";
    return { resource, mode };
  });
  const deduped = new Map();
  for (const lock of locks) {
    const existing = deduped.get(lock.resource);
    if (!existing || lock.mode === "write") deduped.set(lock.resource, lock);
  }
  return [...deduped.values()].sort((left, right) => (
    left.resource.localeCompare(right.resource)
  ));
}

function resolveTrustedJobResources({ args, project, projectId, tool }) {
  if (typeof tool?.jobResources !== "function") {
    return [{ resource: `project/${projectId}`, mode: "write" }];
  }
  const resolved = tool.jobResources(args, {
    __projectId: projectId,
    __projectRevision: project.revision,
    __projectWorkspaceDir: project.workspaceRoot ?? null
  });
  if (resolved && typeof resolved.then === "function") {
    throw new TypeError("Tool jobResources must be synchronous.");
  }
  const locks = normalizeResourceLocks(resolved, projectId, "write");
  if (locks.length === 0) {
    throw new Error("Tool jobResources must resolve at least one resource.");
  }
  return locks;
}

function validateDispatch(runtime, record, payload) {
  const project = authorizeJobProject(runtime, record);
  if (record.kind !== "direct-tool") return project;
  const tool = runtime.tools.get(record.target);
  if (!tool || typeof tool.forwardInvocation === "function") {
    throw new Error(`Direct job target '${record.target}' is unavailable.`);
  }
  assertToolIdentity(record, tool);
  if (
    payload.targetApprovalRevision
    && payload.targetApprovalRevision !== tool.approvalRevision
  ) {
    throw new Error("Direct job target was re-registered after submission.");
  }
  if (record.effect === "write") {
    const required = resolveTrustedJobResources({
      args: payload.args,
      project,
      projectId: record.projectId,
      tool
    });
    assertLocksCover(record.resourceLocks, required);
  }
  return project;
}

function stableToolIdentity(tool) {
  const value = {
    capability: tool.capability ?? null,
    jobResourceRevision: tool.jobResourceRevision ?? null,
    name: tool.name,
    needsConfirmation: tool.needsConfirmation === true,
    parameters: tool.parameters ?? null,
    sideEffects: tool.sideEffects !== false,
    source: tool.source ?? "core"
  };
  return crypto.createHash("sha256").update(safeJson(value)).digest("hex");
}

function assertToolIdentity(record, tool) {
  if (record.kind !== "direct-tool") return;
  if (
    !record.metadata?.targetIdentity
    || record.metadata.targetIdentity !== stableToolIdentity(tool)
  ) {
    throw new Error("Direct job target identity changed after submission.");
  }
}

function assertLocksCover(heldLocks, requiredLocks) {
  const covered = requiredLocks.every((required) => (
    heldLocks.some((held) => (
      held.mode === "write"
      && resourcesOverlap(held.resource, required.resource)
    ))
  ));
  if (!covered) {
    throw new Error(
      "Durable job resource identity changed after submission."
    );
  }
}

function lockSetsConflict(left, right) {
  return left.some((leftLock) => right.some((rightLock) => (
    (leftLock.mode === "write" || rightLock.mode === "write")
    && resourcesOverlap(leftLock.resource, rightLock.resource)
  )));
}

function resourcesOverlap(left, right) {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function clonePlainJsonObject(value, field) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const counters = { nodes: 0 };
  return clonePlainJson(value, field, counters, 0);
}

function clonePlainJson(value, field, counters, depth) {
  counters.nodes += 1;
  if (counters.nodes > 8_192) {
    throw new RangeError(`${field} contains too many values.`);
  }
  if (depth > 8) throw new RangeError(`${field} is nested too deeply.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new TypeError(`${field} contains NUL.`);
    if (value.length > MAX_CONTEXT_CHARS) {
      throw new RangeError(`${field} contains an oversized string.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must contain plain JSON values.`);
  }
  if (Array.isArray(value)) {
    if (value.length > 2_048) throw new RangeError(`${field} array is too large.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${field} must not contain sparse or accessor arrays.`);
      }
      clone.push(clonePlainJson(
        descriptor.value,
        `${field}[${index}]`,
        counters,
        depth + 1
      ));
    }
    return clone;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(`${field} must contain plain JSON objects.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 256) throw new RangeError(`${field} has too many fields.`);
  const clone = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new TypeError(`${field}.${key} is not a safe JSON field.`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field}.${key} must not be an accessor.`);
    }
    clone[key] = clonePlainJson(
      descriptor.value,
      `${field}.${key}`,
      counters,
      depth + 1
    );
  }
  return clone;
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

function authorizeContextProject(
  runtime,
  context,
  { includeArchived = false, requireSession = false } = {}
) {
  const projectId = projectIdFromContext(context);
  const sessionId = String(context?.sessionId ?? "").trim();
  if (requireSession && !sessionId) {
    throw new Error("Durable jobs require a parent session.");
  }
  if (!runtime.projects?.authorize) {
    if (projectId !== "default") {
      throw new Error(`Project '${projectId}' cannot be authorized.`);
    }
    return {
      id: "default",
      revision: Number.isSafeInteger(context?.__projectRevision)
        ? context.__projectRevision
        : 1,
      status: "active"
    };
  }
  const project = runtime.projects.authorize(projectId, {
    includeArchived,
    sessionId: sessionId || null
  });
  if (!project || (!includeArchived && project.status !== "active")) {
    throw new Error(`Project '${projectId}' is unavailable or archived.`);
  }
  const expectedRevision = context?.__projectRevision;
  if (
    !includeArchived
    &&
    expectedRevision != null
    && (
      !Number.isSafeInteger(expectedRevision)
      || expectedRevision !== project.revision
    )
  ) {
    throw new Error(`Project '${projectId}' revision is stale.`);
  }
  return project;
}

function jobReadScope(project, context) {
  const sessionId = String(context?.sessionId ?? "").trim();
  return {
    projectId: project.id,
    ...(sessionId ? { sessionId } : {})
  };
}

function authorizeJobProject(runtime, record) {
  if (!runtime.projects?.authorize) {
    if (record.projectId !== "default") {
      throw new Error(`Project '${record.projectId}' cannot be authorized.`);
    }
    return { id: "default", revision: 1, status: "active" };
  }
  const project = runtime.projects.authorize(record.projectId, {
    sessionId: record.sessionId
  });
  if (!project || project.status !== "active") {
    throw new Error(`Project '${record.projectId}' is unavailable or archived.`);
  }
  if (
    Number.isSafeInteger(record.metadata?.projectRevision)
    && project.revision !== record.metadata.projectRevision
  ) {
    throw new Error(`Project '${record.projectId}' revision changed after submission.`);
  }
  return project;
}

function safeReplayPayload(runtime, payload) {
  // A live provider budget envelope is process-private authority. Replaying
  // it after restart would either reset spent credit or trust forged state,
  // so such queued work is intentionally reconciled as interrupted.
  if (payload?.parentContext?.__budgetEnvelope) return null;
  const audit = sanitizeForAudit(payload);
  const snapshot = secretsStoreRedactionSnapshot(runtime.secrets);
  if (snapshot?.overflow) return null;
  const values = snapshot?.records?.map((record) => record.value) ?? [];
  const redacted = redactKnownValues(audit, values);
  const originalJson = safeJson(payload);
  const redactedJson = safeJson(redacted);
  return originalJson === redactedJson ? redacted : null;
}

function redactJobValue(runtime, value) {
  const audit = sanitizeForAudit(value);
  const snapshot = secretsStoreRedactionSnapshot(runtime.secrets);
  if (snapshot?.overflow) {
    return {
      ...boundedSemanticReceipt(audit),
      redactionOverflow: true
    };
  }
  return redactKnownValues(
    audit,
    snapshot?.records?.map((record) => record.value) ?? []
  );
}

function normalizeIdempotencyKey(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return `job_submit_${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function projectIdFromContext(context) {
  return String(context?.__projectId ?? "default").trim().toLowerCase() || "default";
}

function jobActor(context) {
  return `${String(context?.channel ?? "unknown")}:${String(context?.from ?? "unknown")}`.slice(0, 160);
}

function jobIdSchema() {
  return {
    type: "object",
    properties: {
      jobId: { type: "string" }
    },
    required: ["jobId"],
    additionalProperties: false
  };
}

function boundedSemanticReceipt(value) {
  return sanitizeForAudit({
    ok: value?.ok === true,
    outcome: value?.outcome
      ? {
          status: value.outcome.status ?? null,
          code: value.outcome.code ?? null,
          changed: value.outcome.changed ?? null,
          artifacts: Array.isArray(value.outcome.artifacts)
            ? value.outcome.artifacts.slice(0, 16)
            : [],
          evidence: Array.isArray(value.outcome.evidence)
            ? value.outcome.evidence.slice(0, 16)
            : []
        }
      : null
  });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError("Job payload must be JSON serializable.");
  }
}

function safeError(error) {
  return String(sanitizeForAudit(error?.message ?? error ?? "Job execution failed.")).slice(0, 2_000);
}

function safeErrorCode(value) {
  const code = String(value ?? "TOOL_FAILED")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "TOOL_FAILED";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function privateState(manager) {
  const state = LIVE_STATE.get(manager);
  if (!state) throw new Error("JobManager state is unavailable.");
  return state;
}

export const JOB_DEFAULTS = Object.freeze({
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  maxInlineResultBytes: DEFAULT_MAX_INLINE_RESULT_BYTES,
  closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
  maxWaitMs: MAX_WAIT_MS
});

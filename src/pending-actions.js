import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, appendJsonLine } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
import { sanitizeForAudit } from "./redact.js";
import { safeToolErrorMessage, snapshotToolValue } from "./tool-outcome.js";

const DEFAULT_SNAPSHOT_EVERY = 256;
const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_EVENTS = 1024;
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ACTION_BYTES = 512 * 1024;
const DEFAULT_MAX_TERMINAL_ACTIONS = 500;
const ACTION_ID_RE = /^act_[a-f0-9]{16}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,256}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CAPABILITY_NAME_RE = /^(?:\*|[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})$/;
const SECRET_REFERENCE_RE = /^(?:\*|[A-Z_][A-Z0-9_]{0,127})$/;
const MAX_CONTEXT_LIST_ITEMS = 256;
const RUNTIME_STATE_KEYS = Object.freeze([
  "_decisionPromise",
  "_resolveDecision",
  "_completionPromise",
  "_resolveCompletion",
  "_waiting"
]);
const CONTEXT_SCALAR_LIMITS = Object.freeze({
  sessionId: 1024,
  agentId: 256,
  channel: 128,
  from: 1024,
  target: 1024,
  __projectWorkspaceDir: 4096,
  __memoryScope: 256,
  __profileMemoryScope: 256,
  __projectKanbanBoardId: 128,
  __jobId: 128,
  __turnId: 128
});
const CONTEXT_LIST_FIELDS = Object.freeze([
  "__allowedTools",
  "__projectSecretRefs",
  "__projectActiveSkills",
  "__projectMcpGrants",
  "__projectHookIds"
]);
const CONTEXT_FIELDS = new Set([
  ...Object.keys(CONTEXT_SCALAR_LIMITS),
  ...CONTEXT_LIST_FIELDS,
  "projectId",
  "__projectId",
  "__projectRevision",
  "__scrutinyPolicy"
]);

// File-backed queue of agent-initiated actions awaiting human approval.
// When the agent invokes a tool flagged `needsConfirmation: true`, the
// tool registry intercepts and persists a record here instead of running
// the handler. The dashboard's Suggestions tab surfaces these so the user
// can approve / deny; on approve, the tool registry re-invokes the
// original handler with __confirmed=true to bypass the gate.
//
// Persistence: same JSONL+snapshot pattern as TaskStore so a daemon crash
// mid-action-queue doesn't lose anything.

export class PendingActionStore {
  constructor({
    dir,
    snapshotEvery = DEFAULT_SNAPSHOT_EVERY,
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
    maxJournalBytes = DEFAULT_MAX_JOURNAL_BYTES,
    maxJournalEvents = DEFAULT_MAX_JOURNAL_EVENTS,
    maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
    maxActionBytes = DEFAULT_MAX_ACTION_BYTES,
    maxTerminalActions = DEFAULT_MAX_TERMINAL_ACTIONS,
    appendJournal = appendJsonLine,
    writeSnapshot = writeJsonAtomic
  } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "pending-actions");
    ensureDir(this.dir);
    this.actions = new Map();
    this.events = null;
    this.snapshotEvery = positiveInteger(snapshotEvery, DEFAULT_SNAPSHOT_EVERY);
    this.maxSnapshotBytes = positiveInteger(maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES);
    this.maxJournalBytes = positiveInteger(maxJournalBytes, DEFAULT_MAX_JOURNAL_BYTES);
    this.maxJournalEvents = positiveInteger(maxJournalEvents, DEFAULT_MAX_JOURNAL_EVENTS);
    this.maxEventBytes = positiveInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
    this.maxActionBytes = positiveInteger(maxActionBytes, DEFAULT_MAX_ACTION_BYTES);
    this.maxTerminalActions = nonNegativeInteger(
      maxTerminalActions,
      DEFAULT_MAX_TERMINAL_ACTIONS
    );
    this.appendJournal = typeof appendJournal === "function"
      ? appendJournal
      : appendJsonLine;
    this.writeSnapshot = typeof writeSnapshot === "function"
      ? writeSnapshot
      : writeJsonAtomic;
    this._journalEventCount = 0;
    this._snapshotting = false;
    this._loadSnapshot();
    this._replayJournal();
    this._reconcileInterruptedApprovals();
    if (this._pruneTerminalActions()) this.snapshot();
  }

  /// Late-bound: hosted-interface creates the event bus, then calls this
  /// so subsequent enqueue/decide calls broadcast over SSE → Mac app.
  bindEvents(events) {
    this.events = events;
  }

  list({ status, projectId } = {}) {
    const all = [...this.actions.values()];
    const filtered = all.filter((action) => (
      (!status || action.status === status)
      && (
        projectId === undefined
        || projectId === null
        || actionProjectId(action) === String(projectId)
      )
    ));
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id, { projectId } = {}) {
    const action = this.actions.get(id) ?? null;
    if (
      action
      && projectId !== undefined
      && projectId !== null
      && actionProjectId(action) !== String(projectId)
    ) {
      return null;
    }
    return action;
  }

  enqueue({
    toolName,
    args,
    context,
    summary,
    reason,
    severity,
    approvalIdentity,
    privateInput = false
  }) {
    if (!validToolName(toolName)) {
      throw new TypeError("Pending action toolName must be an ASCII tool name.");
    }
    const persistedContext = normalizeActionContext(serializableContext(context));
    const argsReplayable = privateInput === true
      ? false
      : persistedArgumentsRemainExecutable(args);
    const action = {
      id: createId("act"),
      toolName,
      args: args ?? {},
      context: persistedContext,
      summary: summary ?? `Run ${toolName}`,
      reason: reason ?? null,
      severity: severity ?? null,
      approvalIdentity: approvalIdentity ?? null,
      ...(privateInput === true ? { privateInput: true } : {}),
      argsReplayable,
      status: "pending",
      createdAt: nowIso(),
      decidedAt: null,
      completedAt: null,
      decidedBy: null,
      approvedVia: null,
      decider: null,
      deciderDisplayName: null,
      result: null,
      error: null,
      outcome: null
    };
    this._assertActiveCapacity(action);
    attachRuntimeState(action);
    this._commitActionTransition(action.id, action, {
      op: "enqueue",
      action
    });
    this.events?.emit?.("pending-action", {
      id: action.id,
      toolName: action.toolName,
      summary: action.summary,
      reason: action.reason,
      severity: action.severity,
      createdAt: action.createdAt,
      projectId: action.context?.__projectId ?? "default",
      projectRevision: action.context?.__projectRevision ?? null,
      // Session the triggering turn ran in (e.g. "discord:<guild>:<channel>")
      // so the activity feed can post into the channel the agent is actually
      // working in, Hermes-style, instead of only the static home channel.
      sessionId: action.context?.sessionId ?? null
    });
    return action;
  }

  decide(id, {
    decision,
    decidedBy,
    approvedVia,
    decider,
    deciderDisplayName,
    result,
    error,
    outcome,
    receipt
  }) {
    const action = this.actions.get(id);
    if (!action) return null;
    if (action.status !== "pending") return action;
    if (!["approve", "deny"].includes(decision)) {
      throw new TypeError("Pending action decision must be 'approve' or 'deny'.");
    }
    const next = inheritRuntimeState(action, {
      ...action,
      status: decision === "approve" ? "approved" : "denied",
      decidedAt: nowIso(),
      decidedBy: decidedBy ?? "user"
    });
    if (approvedVia !== undefined) next.approvedVia = approvedVia;
    if (decider !== undefined) next.decider = decider;
    if (deciderDisplayName !== undefined) next.deciderDisplayName = deciderDisplayName;
    if (result !== undefined) next.result = result;
    if (error !== undefined) next.error = error;
    if (outcome !== undefined) next.outcome = outcome;
    if (receipt !== undefined) next.receipt = receipt;
    if (decision === "deny" || result !== undefined || error !== undefined) {
      next.completedAt = nowIso();
    }
    // The full result always flows to live waiters below; only the durable
    // record is bounded, so an oversized tool result cannot fail the decision
    // after the side effect already ran.
    const persistedDecision = withBoundedResultForPersistence(next, this.maxActionBytes);
    if (persistedDecision.truncated) {
      console.warn(
        `[pending-actions] ${id}: decision result exceeded the ` +
        `${this.maxActionBytes}-byte persistence cap; the durable record was ` +
        "truncated after the full result was delivered to the live caller."
      );
    }
    this._assertTransitionCapacity(persistedDecision.action);
    this._commitActionTransition(id, persistedDecision.action, {
      op: "decide",
      id,
      status: persistedDecision.action.status,
      decidedAt: persistedDecision.action.decidedAt,
      completedAt: persistedDecision.action.completedAt,
      decidedBy: persistedDecision.action.decidedBy,
      approvedVia: persistedDecision.action.approvedVia,
      decider: persistedDecision.action.decider,
      deciderDisplayName: persistedDecision.action.deciderDisplayName,
      result: persistedDecision.action.result,
      error: persistedDecision.action.error,
      outcome: persistedDecision.action.outcome,
      receipt: persistedDecision.action.receipt
    });
    next._resolveDecision?.({
      decision: next.status === "approved" ? "approve" : "deny",
      decidedBy: next.decidedBy,
      approvedVia: next.approvedVia,
      decider: next.decider,
      completed: Boolean(next.completedAt),
      result: next.result,
      error: next.error,
      ...(next.outcome ? { outcome: next.outcome } : {}),
      ...(next.receipt ? { receipt: next.receipt } : {})
    });
    if (next.completedAt) {
      next._resolveCompletion?.(next.status === "approved" && !next.error
        ? semanticCompletion(true, next)
        : semanticCompletion(false, next));
    }
    // Broadcast the decision so the Discord activity feed (and SSE dashboard)
    // can show approvals/denials/auto-approvals — not just enqueues.
    this.events?.emit?.("pending-action-decided", {
      id: next.id,
      toolName: next.toolName,
      summary: next.summary,
      status: next.status,
      decidedBy: next.decidedBy,
      approvedVia: next.approvedVia,
      error: next.error ?? null,
      sessionId: next.context?.sessionId ?? null,
      projectId: next.context?.__projectId ?? "default",
      projectRevision: next.context?.__projectRevision ?? null
    });
    return next;
  }

  waitForDecision(id, { timeoutMs = 300000, signal, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const action = this.actions.get(id);
    if (!action) return Promise.resolve({ decision: "deny", error: "unknown action" });
    if (action.status !== "pending") {
      return Promise.resolve({
        decision: action.status === "approved" ? "approve" : "deny",
        decidedBy: action.decidedBy,
        completed: Boolean(action.completedAt),
        result: action.result,
        error: action.error,
        ...(action.outcome ? { outcome: action.outcome } : {}),
        ...(action.receipt ? { receipt: action.receipt } : {})
      });
    }
    attachRuntimeState(action);
    action._waiting = true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutFn(() => {
        const current = this.actions.get(id);
        if (!current || current.status !== "pending") {
          resolve(current ? decisionSnapshot(current) : { decision: "deny", error: "unknown action" });
          return;
        }

        // Resolve the timeout contender first, then synchronously make the
        // durable state terminal. Promise callbacks cannot interleave with
        // this callback, so a later approval observes "denied" and cannot
        // win after the timeout has already fired.
        resolve({ decision: "timeout" });
        this.decide(id, {
          decision: "deny",
          decidedBy: "timeout",
          error: "approval timed out"
        });
      }, Math.max(0, Number(timeoutMs) || 0));
    });
    let onAbort;
    const contenders = [action._decisionPromise, timeout];
    if (signal) {
      contenders.push(new Promise((resolve) => {
        onAbort = () => resolve({ decision: "cancelled" });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }));
    }
    return Promise.race(contenders).finally(() => {
      action._waiting = false;
      if (timer !== undefined) clearTimeoutFn(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });
  }

  hasDecisionWaiter(id) {
    return this.actions.get(id)?._waiting === true;
  }

  complete(id, { result, error, outcome, receipt } = {}) {
    const action = this.actions.get(id);
    if (!action || action.status !== "approved" || action.completedAt) return action ?? null;
    const next = inheritRuntimeState(action, {
      ...action,
      result: result ?? null,
      error: error ?? null,
      outcome: outcome ?? null,
      ...(receipt ? { receipt } : {}),
      completedAt: nowIso()
    });
    const persistedCompletion = withBoundedResultForPersistence(next, this.maxActionBytes);
    if (persistedCompletion.truncated) {
      console.warn(
        `[pending-actions] ${id}: completion result exceeded the ` +
        `${this.maxActionBytes}-byte persistence cap; the durable record was ` +
        "truncated after the full result was delivered to the live caller."
      );
    }
    this._assertTransitionCapacity(persistedCompletion.action);
    this._commitActionTransition(id, persistedCompletion.action, {
      op: "complete",
      id,
      completedAt: persistedCompletion.action.completedAt,
      result: persistedCompletion.action.result,
      error: persistedCompletion.action.error,
      outcome: persistedCompletion.action.outcome,
      receipt: persistedCompletion.action.receipt ?? null
    });
    next._resolveCompletion?.(semanticCompletion(!next.error, next));
    return next;
  }

  waitForCompletion(id) {
    const action = this.actions.get(id);
    if (!action) return Promise.resolve({ ok: false, error: "unknown action" });
    if (action.status === "denied") return Promise.resolve({ ok: false, error: action.error ?? "denied" });
    if (action.completedAt || action.result !== null || action.error !== null) {
      return Promise.resolve(semanticCompletion(!action.error, action));
    }
    attachRuntimeState(action);
    return action._completionPromise;
  }

  // Persist a snapshot once the journal grows past N entries — keeps
  // replay cost bounded across long uptime.
  snapshot() {
    if (this._snapshotting) return false;
    this._snapshotting = true;
    try {
      const retained = this._retainedActions();
      let payload = {
        version: 1,
        writtenAt: nowIso(),
        actions: retained.map((action) => sanitizePendingPersistence(action))
      };
      while (
        snapshotBytes(payload) > this.maxSnapshotBytes
        && retained.length > 0
        && isTerminalAction(retained.at(-1))
      ) {
        retained.pop();
        payload = {
          ...payload,
          actions: retained.map((action) => sanitizePendingPersistence(action))
        };
      }
      if (snapshotBytes(payload) > this.maxSnapshotBytes) return false;
      this.writeSnapshot(path.join(this.dir, "snapshot.json"), payload);
      this.actions = new Map(retained.map((action) => [action.id, action]));
      truncateFileDurably(this._journalPath());
      this._journalEventCount = 0;
      return true;
    } finally {
      this._snapshotting = false;
    }
  }

  _journalPath() {
    return path.join(this.dir, "journal.jsonl");
  }

  _loadSnapshot() {
    const snap = readBoundedJson(
      path.join(this.dir, "snapshot.json"),
      this.maxSnapshotBytes
    );
    if (
      !isPlainObject(snap)
      || snap.version !== 1
      || !Array.isArray(snap.actions)
    ) {
      return;
    }
    for (const candidate of snap.actions) {
      const action = normalizePersistedAction(candidate, this.maxActionBytes);
      if (action) this.actions.set(action.id, action);
    }
  }

  _replayJournal() {
    const text = readBoundedJournalTail(
      this._journalPath(),
      this.maxJournalBytes
    );
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const boundedLines = lines.slice(-this.maxJournalEvents);
    this._journalEventCount = boundedLines.length;
    for (const line of boundedLines) {
      if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      this._applyJournalEvent(event);
    }
  }

  _applyJournalEvent(event) {
    if (!isPlainObject(event)) return;
    if (event.op === "enqueue") {
      const action = normalizePersistedAction(event.action, this.maxActionBytes);
      if (action && !this.actions.has(action.id)) {
        this.actions.set(action.id, action);
      }
      return;
    }
    if (!validActionId(event.id)) return;
    const action = this.actions.get(event.id);
    if (!action) return;
    if (event.op === "decide") {
      if (
        action.status !== "pending"
        || !["approved", "denied"].includes(event.status)
      ) {
        return;
      }
      const next = normalizePersistedAction({
        ...action,
        status: event.status,
        decidedAt: event.decidedAt,
        completedAt: event.completedAt ?? null,
        decidedBy: event.decidedBy,
        approvedVia: event.approvedVia ?? null,
        decider: event.decider ?? null,
        deciderDisplayName: event.deciderDisplayName ?? null,
        result: event.result !== undefined ? event.result : action.result,
        error: event.error !== undefined ? event.error : action.error,
        outcome: event.outcome !== undefined ? event.outcome : action.outcome,
        receipt: event.receipt !== undefined ? event.receipt : action.receipt
      }, this.maxActionBytes);
      if (next) this.actions.set(event.id, next);
      return;
    }
    if (
      event.op === "complete"
      && action.status === "approved"
      && !action.completedAt
      && validTimestamp(event.completedAt)
    ) {
      const next = normalizePersistedAction({
        ...action,
        completedAt: event.completedAt,
        result: event.result ?? null,
        error: event.error ?? null,
        outcome: event.outcome ?? null,
        receipt: event.receipt ?? null
      }, this.maxActionBytes);
      if (next) this.actions.set(event.id, next);
    }
  }

  _reconcileInterruptedApprovals() {
    for (const action of [...this.actions.values()]) {
      if (action.status !== "approved" || action.completedAt) continue;

      // Approval is durable, but execution completion is not. Replaying a
      // possibly non-idempotent tool would risk applying the side effect
      // twice, so recovery records an explicit terminal uncertainty instead.
      const next = inheritRuntimeState(action, {
        ...action,
        result: null,
        error: interruptedApprovalError(),
        outcome: interruptedApprovalOutcome(),
        receipt: null,
        completedAt: nowIso()
      });
      this._assertTransitionCapacity(next);
      this._commitActionTransition(action.id, next, {
        op: "complete",
        id: action.id,
        completedAt: next.completedAt,
        result: next.result,
        error: next.error,
        outcome: next.outcome,
        receipt: next.receipt
      });
    }
  }

  _appendJournal(event) {
    const persisted = sanitizePendingPersistence(event);
    if (serializedBytes(persisted) > this.maxEventBytes) {
      throw pendingCapacityError("Pending action event exceeds the persistence size limit.");
    }
    this.appendJournal(this._journalPath(), persisted);
    this._journalEventCount += 1;
    if (
      !this._snapshotting
      && this._journalEventCount >= this.snapshotEvery
    ) {
      this.snapshot();
    }
  }

  _commitActionTransition(id, next, event) {
    const expected = this._assertTransitionCapacity(next);
    const previousActions = this.actions;
    const previousEventCount = this._journalEventCount;
    const staged = new Map(previousActions);
    staged.set(id, next);
    this.actions = staged;
    try {
      this._appendJournal(event);
    } catch (error) {
      const durable = this._probeDurableState();
      if (!actionsEquivalent(durable.actions.get(id), expected)) {
        this.actions = previousActions;
        this._journalEventCount = previousEventCount;
        throw error;
      }
      // An append can report failure after the write reached disk. In that
      // case the durable transition wins, while the staged object retains any
      // live waiters that must still be resolved by the caller.
      this._journalEventCount = durable.journalEventCount;
    }
    return next;
  }

  _probeDurableState() {
    const liveActions = this.actions;
    const liveEventCount = this._journalEventCount;
    this.actions = new Map();
    this._journalEventCount = 0;
    try {
      this._loadSnapshot();
      this._replayJournal();
      return {
        actions: this.actions,
        journalEventCount: this._journalEventCount
      };
    } finally {
      this.actions = liveActions;
      this._journalEventCount = liveEventCount;
    }
  }

  _retainedActions() {
    const active = [];
    const terminal = [];
    let index = 0;
    for (const action of this.actions.values()) {
      const entry = { action, index: index++ };
      if (isTerminalAction(action)) terminal.push(entry);
      else active.push(action);
    }
    terminal.sort((left, right) => {
      const byTime = terminalTime(right.action).localeCompare(
        terminalTime(left.action)
      );
      return byTime || right.index - left.index;
    });
    return [
      ...active,
      ...terminal.slice(0, this.maxTerminalActions).map((entry) => entry.action)
    ];
  }

  _pruneTerminalActions() {
    const retained = this._retainedActions();
    if (retained.length === this.actions.size) return false;
    this.actions = new Map(retained.map((action) => [action.id, action]));
    return true;
  }

  _assertActiveCapacity(action) {
    this._assertTransitionCapacity(action);
    const active = [...this.actions.values()]
      .filter((candidate) => !isTerminalAction(candidate));
    const payload = {
      version: 1,
      writtenAt: nowIso(),
      actions: [...active, action].map((candidate) => (
        sanitizePendingPersistence(candidate)
      ))
    };
    if (snapshotBytes(payload) > this.maxSnapshotBytes) {
      throw pendingCapacityError("Pending action capacity is full.");
    }
  }

  _assertTransitionCapacity(action) {
    const sanitized = sanitizePendingPersistence(action);
    const persisted = normalizePersistedAction(sanitized, this.maxActionBytes);
    if (!persisted) {
      const bytes = serializedBytes(sanitized);
      if (bytes > this.maxActionBytes) {
        throw pendingCapacityError(
          `Pending action exceeds the persistence size limit (${bytes} serialized bytes > ${this.maxActionBytes}-byte cap).`
        );
      }
      console.warn(
        `[pending-actions] action ${action?.id ?? "unknown"} ` +
        `(${action?.toolName ?? "unknown tool"}) failed persistence validation.`
      );
      throw pendingCapacityError(
        "Pending action failed persistence validation; the rejected field is logged above."
      );
    }
    return persisted;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// A successful tool can return a payload larger than the durable action cap.
// The full result always flows to live waiters/callers; only the persisted
// record degrades to a bounded marker, so a state transition cannot fail
// after the side effect already ran.
function withBoundedResultForPersistence(action, maxActionBytes) {
  if (action.result === null || action.result === undefined) {
    return { action, truncated: false };
  }
  if (serializedBytes(sanitizePendingPersistence(action)) <= maxActionBytes) {
    return { action, truncated: false };
  }
  const originalBytes = serializedBytes(action.result);
  const bounded = {
    ...action,
    result:
      "[pending-action result truncated at persistence: the original result " +
      `serialized to ~${originalBytes} bytes, over the ${maxActionBytes}-byte ` +
      "action cap. The full result was delivered to the live caller; only " +
      "this marker is retained in the approval store.]"
  };
  if (serializedBytes(sanitizePendingPersistence(bounded)) > maxActionBytes) {
    // The result was not the overflow source; let the caller surface the
    // original capacity error unchanged.
    return { action, truncated: false };
  }
  return { action: bounded, truncated: true };
}

function snapshotBytes(value) {
  try {
    return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizePendingPersistence(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePendingPersistence(item));
  }
  let source = value;
  if (isPlainObject(value) && value.privateInput === true) {
    source = {
      ...value,
      args: { privateInput: "[OMITTED]" },
      argsReplayable: false
    };
  } else if (isPlainObject(value?.action) && value.action.privateInput === true) {
    source = {
      ...value,
      action: {
        ...value.action,
        args: { privateInput: "[OMITTED]" },
        argsReplayable: false
      }
    };
  }
  const sanitized = sanitizeForAudit(source);
  if (!isPlainObject(value) || !isPlainObject(sanitized)) return sanitized;
  restoreSecretReferences(value.context, sanitized.context);
  restoreSecretReferences(value.action?.context, sanitized.action?.context);
  return sanitized;
}

function restoreSecretReferences(source, target) {
  if (
    !isPlainObject(source)
    || !isPlainObject(target)
    || !Array.isArray(source.__projectSecretRefs)
    || source.__projectSecretRefs.length > MAX_CONTEXT_LIST_ITEMS
    || source.__projectSecretRefs.some((item) => (
      typeof item !== "string" || !SECRET_REFERENCE_RE.test(item)
    ))
  ) {
    return;
  }
  // These are allowlisted secret identifiers, not credential values. Keeping
  // them is required to revalidate the exact project approval identity.
  target.__projectSecretRefs = [...source.__projectSecretRefs];
}

function pendingCapacityError(message) {
  const error = new RangeError(message);
  error.code = "PENDING_ACTION_CAPACITY";
  return error;
}

function readBoundedJson(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readBoundedJournalTail(file, maxBytes) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return "";
    const length = Math.min(stat.size, maxBytes);
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    fd = fs.openSync(file, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return "";
      text = text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function truncateFileDurably(file) {
  if (!fs.existsSync(file)) return;
  let fd;
  try {
    fd = fs.openSync(file, "r+");
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  } catch {
    // A durable snapshot already exists. Leaving a duplicate journal is safe
    // because replay transitions are idempotent and transition-validated.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function normalizePersistedAction(value, maxBytes) {
  if (
    !isPlainObject(value)
    || serializedBytes(value) > maxBytes
    || !validActionId(value.id)
    || !validToolName(value.toolName)
    || !isPlainObject(value.args)
    || typeof value.argsReplayable !== "boolean"
    || (value.privateInput !== undefined && typeof value.privateInput !== "boolean")
    || !["pending", "approved", "denied"].includes(value.status)
    || !validTimestamp(value.createdAt)
    || !validBoundedString(value.summary, 1000, { allowEmpty: false })
    || !validNullableBoundedString(value.reason, 4000)
    || !validNullableBoundedString(value.severity, 128)
    || !validNullableBoundedString(value.approvalIdentity, 1000)
    || !validNullableBoundedString(value.decidedBy, 256)
    || !validNullableBoundedString(value.approvedVia, 256)
    || !validNullableBoundedString(value.decider, 256)
    || !validNullableBoundedString(value.deciderDisplayName, 256)
  ) {
    return null;
  }
  const decidedAt = value.decidedAt ?? null;
  const completedAt = value.completedAt ?? null;
  let context;
  try {
    context = normalizeActionContext(value.context);
  } catch (error) {
    console.warn(
      `[pending-actions] action context rejected during normalization: ${error?.message ?? error}`
    );
    return null;
  }
  const receiptValue = value.receipt ?? null;
  const receipt = normalizeExecutionReceipt(receiptValue, value.toolName);
  if (
    (receiptValue !== null && receipt === null)
    ||
    !validNullableTimestamp(decidedAt)
    || !validNullableTimestamp(completedAt)
    || !timestampsInOrder(value.createdAt, decidedAt, completedAt)
    || (
      value.status === "pending"
      && (
        decidedAt !== null
        || completedAt !== null
        || value.decidedBy !== null
        || value.approvedVia !== null
        || value.decider !== null
        || value.deciderDisplayName !== null
        || value.result !== null
        || value.error !== null
        || value.outcome !== null
        || receiptValue !== null
      )
    )
    || (
      value.status === "approved"
      && (
        !validTimestamp(decidedAt)
        || !validBoundedString(value.decidedBy, 256, { allowEmpty: false })
        || (
          completedAt === null
          && (
            value.result !== null
            || value.error !== null
            || value.outcome !== null
            || receiptValue !== null
          )
        )
      )
    )
    || (
      value.status === "denied"
      && (
        !validTimestamp(decidedAt)
        || !validTimestamp(completedAt)
        || !validBoundedString(value.decidedBy, 256, { allowEmpty: false })
      )
    )
  ) {
    return null;
  }
  return {
    id: value.id,
    toolName: value.toolName,
    args: value.args,
    context,
    summary: value.summary,
    reason: value.reason,
    severity: value.severity,
    approvalIdentity: value.approvalIdentity,
    ...(value.privateInput === true ? { privateInput: true } : {}),
    argsReplayable: value.argsReplayable,
    status: value.status,
    createdAt: value.createdAt,
    decidedAt,
    completedAt,
    decidedBy: value.decidedBy,
    approvedVia: value.approvedVia,
    decider: value.decider,
    deciderDisplayName: value.deciderDisplayName,
    result: value.result,
    error: value.error,
    outcome: value.outcome,
    ...(receipt ? { receipt } : {})
  };
}

function normalizeExecutionReceipt(value, toolName) {
  if (value === null || value === undefined) return null;
  if (
    !isPlainObject(value)
    || !validBoundedString(value.id, 200, { allowEmpty: false })
    || !/^[A-Za-z0-9._:-]+$/.test(value.id)
    || value.tool !== toolName
    || !validBoundedString(value.status, 32, { allowEmpty: false })
    || !/^[a-z][a-z0-9_-]*$/.test(value.status)
    || !validBoundedString(value.code, 80, { allowEmpty: false })
    || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value.code)
    || typeof value.dispatched !== "boolean"
    || ![true, false, null].includes(value.changed)
    || !validTimestamp(value.startedAt)
    || !validTimestamp(value.finishedAt)
    || !Number.isSafeInteger(value.durationMs)
    || value.durationMs < 0
    || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    tool: value.tool,
    status: value.status,
    code: value.code,
    dispatched: value.dispatched,
    changed: value.changed,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: value.durationMs
  };
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
  );
}

function validActionId(value) {
  return typeof value === "string" && ACTION_ID_RE.test(value);
}

function validToolName(value) {
  return typeof value === "string" && TOOL_NAME_RE.test(value);
}

function validTimestamp(value) {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validNullableTimestamp(value) {
  return value === null || validTimestamp(value);
}

function timestampsInOrder(createdAt, decidedAt, completedAt) {
  const created = Date.parse(createdAt);
  const decided = decidedAt === null ? null : Date.parse(decidedAt);
  const completed = completedAt === null ? null : Date.parse(completedAt);
  return (
    (decided === null || decided >= created)
    && (completed === null || (decided !== null && completed >= decided))
  );
}

function normalizeActionContext(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw new TypeError("Pending action context must be a plain object.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !CONTEXT_FIELDS.has(key))) {
    throw new TypeError("Pending action context contains an unsupported field.");
  }
  const normalized = {};
  for (const [field, maxLength] of Object.entries(CONTEXT_SCALAR_LIMITS)) {
    if (value[field] === undefined || value[field] === null) {
      if (value[field] === null) normalized[field] = null;
      continue;
    }
    if (!validBoundedString(value[field], maxLength)) {
      throw new TypeError(`Pending action context ${field} is invalid.`);
    }
    normalized[field] = value[field];
  }
  const publicProjectId = value.projectId ?? null;
  const privateProjectId = value.__projectId ?? null;
  if (
    (publicProjectId !== null && !validProjectId(publicProjectId))
    || (privateProjectId !== null && !validProjectId(privateProjectId))
    || (
      publicProjectId !== null
      && privateProjectId !== null
      && publicProjectId !== privateProjectId
    )
  ) {
    throw new TypeError("Pending action context project id is invalid.");
  }
  const effectiveProjectId = privateProjectId ?? publicProjectId;
  if (publicProjectId !== null) normalized.projectId = publicProjectId;
  if (effectiveProjectId !== null) normalized.__projectId = effectiveProjectId;
  if (effectiveProjectId !== null) {
    if (
      !Number.isSafeInteger(value.__projectRevision)
      || value.__projectRevision < 1
    ) {
      throw new TypeError(
        "Pending action project context requires a positive project revision."
      );
    }
    normalized.__projectRevision = value.__projectRevision;
  } else if (value.__projectRevision !== undefined) {
    throw new TypeError(
      "Pending action project revision requires a project id."
    );
  }
  if (value.__scrutinyPolicy !== undefined) {
    if (
      typeof value.__scrutinyPolicy !== "string"
      || !["full", "confirm", "read-only", "none"].includes(
        value.__scrutinyPolicy
      )
    ) {
      throw new TypeError("Pending action scrutiny policy is invalid.");
    }
    normalized.__scrutinyPolicy = value.__scrutinyPolicy;
  }
  for (const field of CONTEXT_LIST_FIELDS) {
    if (value[field] === undefined) continue;
    if (
      !Array.isArray(value[field])
      || value[field].length > MAX_CONTEXT_LIST_ITEMS
      || value[field].some((item) => (
        typeof item !== "string" || !validContextGrant(field, item)
      ))
    ) {
      throw new TypeError(`Pending action context ${field} is invalid.`);
    }
    normalized[field] = [...new Set(value[field])];
  }
  return normalized;
}

function validProjectId(value) {
  return typeof value === "string" && PROJECT_ID_RE.test(value);
}

function validContextGrant(field, value) {
  if (field === "__projectSecretRefs") {
    return SECRET_REFERENCE_RE.test(value);
  }
  if (field === "__allowedTools") {
    return value === "*" || TOOL_NAME_RE.test(value);
  }
  return CAPABILITY_NAME_RE.test(value);
}

function validBoundedString(value, maxLength, { allowEmpty = true } = {}) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validNullableBoundedString(value, maxLength) {
  return value === null || validBoundedString(value, maxLength);
}

function isTerminalAction(action) {
  return action.status === "denied" || Boolean(action.completedAt);
}

function terminalTime(action) {
  return action.completedAt ?? action.decidedAt ?? action.createdAt ?? "";
}

function actionProjectId(action) {
  return String(
    action?.context?.__projectId
    ?? action?.context?.projectId
    ?? "default"
  );
}

function decisionSnapshot(action) {
  return {
    decision: action.status === "approved" ? "approve" : "deny",
    decidedBy: action.decidedBy,
    approvedVia: action.approvedVia,
    decider: action.decider,
    completed: Boolean(action.completedAt),
    result: action.result,
    error: action.error,
    ...(action.outcome ? { outcome: action.outcome } : {}),
    ...(action.receipt ? { receipt: action.receipt } : {})
  };
}

function interruptedApprovalError() {
  return "Approved action was recovered without a completion record; execution was not replayed because its side effects are unknown.";
}

function interruptedApprovalOutcome() {
  return {
    status: "blocked",
    code: "approval_completion_interrupted",
    retryable: false,
    changed: null,
    artifacts: [],
    evidence: [],
    verification: {
      status: "failed",
      summary: "Approval was recorded, but tool completion was not."
    },
    nextSteps: [
      "Inspect the target system before creating a new action."
    ]
  };
}

function semanticCompletion(ok, action) {
  const completion = ok
    ? { ok: true, result: action.result }
    : { ok: false, error: action.error ?? "denied" };
  if (action.outcome && typeof action.outcome === "object") {
    completion.outcome = action.outcome;
  }
  if (action.receipt && typeof action.receipt === "object") {
    completion.receipt = action.receipt;
  }
  return completion;
}

function attachRuntimeState(action) {
  if (Object.hasOwn(action, "_decisionPromise")) return action;
  let resolveDecision;
  let resolveCompletion;
  const decisionPromise = new Promise((resolve) => { resolveDecision = resolve; });
  const completionPromise = new Promise((resolve) => { resolveCompletion = resolve; });
  for (const [key, value] of [
    ["_decisionPromise", decisionPromise],
    ["_resolveDecision", resolveDecision],
    ["_completionPromise", completionPromise],
    ["_resolveCompletion", resolveCompletion],
    ["_waiting", false]
  ]) {
    Object.defineProperty(action, key, { value, writable: true, enumerable: false, configurable: true });
  }
  return action;
}

function inheritRuntimeState(source, target) {
  attachRuntimeState(source);
  for (const key of RUNTIME_STATE_KEYS) {
    if (key === "_waiting") {
      Object.defineProperty(target, key, {
        get: () => source._waiting,
        set: (value) => { source._waiting = value; },
        enumerable: false,
        configurable: true
      });
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(target, key, descriptor);
  }
  return target;
}

function actionsEquivalent(left, right) {
  if (!left || !right) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

// Every approval surface uses this first-click-wins path. A live suspended
// invocation resumes itself after decide(); a persisted action with no waiter
// is executed here so restart-era approvals retain their historical behavior.
export async function approvePendingAction(runtime, id, decision = {}) {
  const store = runtime?.pendingActions;
  const action = store?.get?.(
    id,
    decision.projectId === undefined
      ? {}
      : { projectId: decision.projectId }
  );
  if (!action) return { ok: false, error: "unknown pending action", status: 404 };
  if (action.status !== "pending") {
    return { ok: false, error: `action already ${action.status}`, status: 409 };
  }

  const suspended = store.hasDecisionWaiter?.(id) === true;
  if (!suspended) {
    const replayBlock = approvalReplayBlock(runtime, action);
    if (replayBlock) {
      store.decide(id, {
        decision: "deny",
        decidedBy: "approval-reconciliation",
        error: replayBlock.error,
        outcome: replayBlock.outcome
      });
      return {
        ok: false,
        error: replayBlock.error,
        outcome: replayBlock.outcome,
        status: 409
      };
    }
  }
  store.decide(id, {
    decision: "approve",
    decidedBy: decision.decidedBy ?? "user",
    approvedVia: decision.approvedVia,
    decider: decision.decider,
    deciderDisplayName: decision.deciderDisplayName
  });

  if (suspended) return store.waitForCompletion(id);

  let invokeResult;
  try {
    invokeResult = await runtime.tools.invoke(action.toolName, action.args, {
      ...(action.context ?? {}),
      __confirmed: true,
      // A replay-only handler may need to bind its side effect to this exact
      // durable action. This context field is runtime-created, never model
      // supplied, and is intentionally not persisted as a general argument.
      __pendingActionId: action.id,
      __approval: {
        description: action.reason ?? "flagged as dangerous",
        via: decision.approvedVia ?? "manual-approval",
        decider: decision.decider ?? decision.decidedBy ?? "user"
      }
    });
  } catch (error) {
    invokeResult = {
      ok: false,
      error: safeToolErrorMessage(error, "Approved tool execution failed.")
    };
  }
  store.complete?.(id, {
    result: invokeResult.ok ? invokeResult.result : null,
    error: invokeResult.ok ? null : invokeResult.error,
    outcome: invokeResult.outcome ?? null,
    receipt: invokeResult.receipt ?? null
  });
  return invokeResult;
}

// Strip non-serializable bits from the tool-invocation context. We keep
// only fields we know are safe + useful for replaying the action later.
function serializableContext(ctx) {
  if (!ctx) return null;
  return {
    sessionId: ctx.sessionId ?? null,
    agentId: ctx.agentId ?? null,
    channel: ctx.channel ?? null,
    from: ctx.from ?? null,
    target: ctx.target ?? null,
    ...(ctx.projectId ? { projectId: String(ctx.projectId) } : {}),
    ...(ctx.__projectId ? { __projectId: String(ctx.__projectId) } : {}),
    ...(Number.isSafeInteger(ctx.__projectRevision)
      ? { __projectRevision: ctx.__projectRevision }
      : {}),
    ...(ctx.__projectWorkspaceDir
      ? { __projectWorkspaceDir: String(ctx.__projectWorkspaceDir) }
      : {}),
    ...(ctx.__memoryScope ? { __memoryScope: String(ctx.__memoryScope) } : {}),
    ...(ctx.__profileMemoryScope ? { __profileMemoryScope: String(ctx.__profileMemoryScope) } : {}),
    ...(ctx.__projectKanbanBoardId
      ? { __projectKanbanBoardId: String(ctx.__projectKanbanBoardId) }
      : {}),
    ...(ctx.__jobId ? { __jobId: String(ctx.__jobId) } : {}),
    ...(ctx.__turnId ? { __turnId: String(ctx.__turnId) } : {}),
    ...(ctx.__scrutinyPolicy
      ? { __scrutinyPolicy: String(ctx.__scrutinyPolicy) }
      : {}),
    ...(Array.isArray(ctx.__allowedTools)
      ? { __allowedTools: ctx.__allowedTools.map(String) }
      : {}),
    ...(Array.isArray(ctx.__projectSecretRefs)
      ? { __projectSecretRefs: ctx.__projectSecretRefs.map(String) }
      : {}),
    ...(Array.isArray(ctx.__projectActiveSkills)
      ? { __projectActiveSkills: ctx.__projectActiveSkills.map(String) }
      : {}),
    ...(Array.isArray(ctx.__projectMcpGrants)
      ? { __projectMcpGrants: ctx.__projectMcpGrants.map(String) }
      : {}),
    ...(Array.isArray(ctx.__projectHookIds)
      ? { __projectHookIds: ctx.__projectHookIds.map(String) }
      : {})
  };
}

function persistedArgumentsRemainExecutable(args) {
  try {
    const snapshot = snapshotToolValue(args ?? {});
    const sanitized = sanitizeForAudit(snapshot);
    return JSON.stringify(snapshot) === JSON.stringify(sanitized);
  } catch {
    return false;
  }
}

function approvalReplayBlock(runtime, action) {
  if (action.context?.__jobId) {
    return replayBlockedOutcome(
      "The durable job approval owner is no longer live; the target was not replayed outside its scheduler.",
      "job_approval_owner_unavailable"
    );
  }
  if (runtime?.tools?.get?.(action.toolName)?.manualApproval === true) {
    return replayBlockedOutcome(
      "This manual-only approval lost its live invocation owner; create a new request for a human to approve.",
      "manual_approval_owner_unavailable"
    );
  }
  if (action.severity === "catastrophic") {
    return replayBlockedOutcome(
      "This catastrophic approval lost its live invocation owner; create a new exact request for a human to approve.",
      "catastrophic_approval_owner_unavailable"
    );
  }
  if (action.argsReplayable === false) {
    return replayBlockedOutcome(
      "Pending action arguments were redacted at rest and cannot be replayed safely.",
      "approval_arguments_redacted"
    );
  }
  if (typeof runtime?.tools?.approvalIdentity === "function") {
    const currentIdentity = runtime.tools.approvalIdentity(
      action.toolName,
      action.context ?? {}
    );
    if (
      !action.approvalIdentity
      || !currentIdentity
      || currentIdentity !== action.approvalIdentity
    ) {
      return replayBlockedOutcome(
        "The approved tool or policy identity changed; create a new action under the current runtime.",
        "approval_identity_changed"
      );
    }
  }
  return null;
}

function replayBlockedOutcome(error, code) {
  return {
    error,
    outcome: {
      status: "blocked",
      code,
      retryable: false,
      changed: null,
      artifacts: [],
      evidence: [],
      verification: {
        status: "not_requested",
        summary: null
      },
      nextSteps: [
        "Inspect the target state and create a new approval request."
      ]
    }
  };
}

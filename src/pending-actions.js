import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile, appendJsonLine } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
import { sanitizeForAudit } from "./redact.js";

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
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "pending-actions");
    ensureDir(this.dir);
    this.actions = new Map();
    this.events = null;
    this._loadSnapshot();
    this._replayJournal();
  }

  /// Late-bound: hosted-interface creates the event bus, then calls this
  /// so subsequent enqueue/decide calls broadcast over SSE → Mac app.
  bindEvents(events) {
    this.events = events;
  }

  list({ status } = {}) {
    const all = [...this.actions.values()];
    const filtered = status ? all.filter((a) => a.status === status) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id) {
    return this.actions.get(id) ?? null;
  }

  enqueue({ toolName, args, context, summary, reason, severity }) {
    const action = {
      id: createId("act"),
      toolName,
      args: args ?? {},
      context: serializableContext(context),
      summary: summary ?? `Run ${toolName}`,
      reason: reason ?? null,
      severity: severity ?? null,
      status: "pending",
      createdAt: nowIso(),
      decidedAt: null,
      completedAt: null,
      decidedBy: null,
      approvedVia: null,
      decider: null,
      deciderDisplayName: null,
      result: null,
      error: null
    };
    attachRuntimeState(action);
    this.actions.set(action.id, action);
    this._appendJournal({ op: "enqueue", action });
    this.events?.emit?.("pending-action", {
      id: action.id,
      toolName: action.toolName,
      summary: action.summary,
      reason: action.reason,
      severity: action.severity,
      createdAt: action.createdAt,
      // Session the triggering turn ran in (e.g. "discord:<guild>:<channel>")
      // so the activity feed can post into the channel the agent is actually
      // working in, Hermes-style, instead of only the static home channel.
      sessionId: action.context?.sessionId ?? null
    });
    return action;
  }

  decide(id, { decision, decidedBy, approvedVia, decider, deciderDisplayName, result, error }) {
    const action = this.actions.get(id);
    if (!action) return null;
    if (action.status !== "pending") return action;
    action.status = decision === "approve" ? "approved" : "denied";
    action.decidedAt = nowIso();
    action.decidedBy = decidedBy ?? "user";
    if (approvedVia !== undefined) action.approvedVia = approvedVia;
    if (decider !== undefined) action.decider = decider;
    if (deciderDisplayName !== undefined) action.deciderDisplayName = deciderDisplayName;
    if (result !== undefined) action.result = result;
    if (error !== undefined) action.error = error;
    if (decision === "deny" || result !== undefined || error !== undefined) {
      action.completedAt = nowIso();
    }
    this.actions.set(id, action);
    this._appendJournal({
      op: "decide",
      id,
      status: action.status,
      decidedAt: action.decidedAt,
      completedAt: action.completedAt,
      decidedBy: action.decidedBy,
      approvedVia: action.approvedVia,
      decider: action.decider,
      deciderDisplayName: action.deciderDisplayName,
      result,
      error
    });
    action._resolveDecision?.({
      decision: action.status === "approved" ? "approve" : "deny",
      decidedBy: action.decidedBy,
      approvedVia: action.approvedVia,
      decider: action.decider,
      completed: Boolean(action.completedAt),
      result: action.result,
      error: action.error
    });
    if (action.completedAt) {
      action._resolveCompletion?.(action.status === "approved" && !action.error
        ? { ok: true, result: action.result }
        : { ok: false, error: action.error ?? "denied" });
    }
    // Broadcast the decision so the Discord activity feed (and SSE dashboard)
    // can show approvals/denials/auto-approvals — not just enqueues.
    this.events?.emit?.("pending-action-decided", {
      id: action.id,
      toolName: action.toolName,
      summary: action.summary,
      status: action.status,
      decidedBy: action.decidedBy,
      approvedVia: action.approvedVia,
      error: action.error ?? null,
      sessionId: action.context?.sessionId ?? null
    });
    return action;
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
        error: action.error
      });
    }
    attachRuntimeState(action);
    action._waiting = true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutFn(() => resolve({ decision: "timeout" }), Math.max(0, Number(timeoutMs) || 0));
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

  complete(id, { result, error } = {}) {
    const action = this.actions.get(id);
    if (!action || action.status !== "approved" || action.completedAt) return action ?? null;
    action.result = result ?? null;
    action.error = error ?? null;
    action.completedAt = nowIso();
    this._appendJournal({
      op: "complete",
      id,
      completedAt: action.completedAt,
      result: action.result,
      error: action.error
    });
    action._resolveCompletion?.(action.error
      ? { ok: false, error: action.error }
      : { ok: true, result: action.result });
    return action;
  }

  waitForCompletion(id) {
    const action = this.actions.get(id);
    if (!action) return Promise.resolve({ ok: false, error: "unknown action" });
    if (action.status === "denied") return Promise.resolve({ ok: false, error: action.error ?? "denied" });
    if (action.completedAt || action.result !== null || action.error !== null) {
      return Promise.resolve(action.error
        ? { ok: false, error: action.error }
        : { ok: true, result: action.result });
    }
    attachRuntimeState(action);
    return action._completionPromise;
  }

  // Persist a snapshot once the journal grows past N entries — keeps
  // replay cost bounded across long uptime.
  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      actions: sanitizeForAudit([...this.actions.values()])
    });
    // Truncate journal: rename current to .archived-<ts> then start fresh.
    const journalPath = this._journalPath();
    if (fs.existsSync(journalPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        fs.renameSync(journalPath, path.join(this.dir, `journal.${ts}.archived`));
      } catch { /* ignore */ }
    }
  }

  _journalPath() {
    return path.join(this.dir, "journal.jsonl");
  }

  _loadSnapshot() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap?.actions) return;
    for (const action of snap.actions) {
      this.actions.set(action.id, action);
    }
  }

  _replayJournal() {
    const file = this._journalPath();
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.op === "enqueue" && event.action) {
        this.actions.set(event.action.id, event.action);
      } else if (event.op === "decide" && event.id) {
        const a = this.actions.get(event.id);
        if (a) {
          a.status = event.status;
          a.decidedAt = event.decidedAt;
          if (event.completedAt !== undefined) a.completedAt = event.completedAt;
          a.decidedBy = event.decidedBy;
          if (event.approvedVia !== undefined) a.approvedVia = event.approvedVia;
          if (event.decider !== undefined) a.decider = event.decider;
          if (event.deciderDisplayName !== undefined) a.deciderDisplayName = event.deciderDisplayName;
          if (event.result !== undefined) a.result = event.result;
          if (event.error !== undefined) a.error = event.error;
        }
      } else if (event.op === "complete" && event.id) {
        const a = this.actions.get(event.id);
        if (a) {
          a.completedAt = event.completedAt;
          a.result = event.result ?? null;
          a.error = event.error ?? null;
        }
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), sanitizeForAudit(event));
  }
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

// Every approval surface uses this first-click-wins path. A live suspended
// invocation resumes itself after decide(); a persisted action with no waiter
// is executed here so restart-era approvals retain their historical behavior.
export async function approvePendingAction(runtime, id, decision = {}) {
  const store = runtime?.pendingActions;
  const action = store?.get?.(id);
  if (!action) return { ok: false, error: "unknown pending action", status: 404 };
  if (action.status !== "pending") {
    return { ok: false, error: `action already ${action.status}`, status: 409 };
  }

  const suspended = store.hasDecisionWaiter?.(id) === true;
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
      __approval: {
        description: action.reason ?? "flagged as dangerous",
        via: decision.approvedVia ?? "manual-approval",
        decider: decision.decider ?? decision.decidedBy ?? "user"
      }
    });
  } catch (error) {
    invokeResult = { ok: false, error: error.message ?? String(error) };
  }
  store.complete?.(id, {
    result: invokeResult.ok ? invokeResult.result : null,
    error: invokeResult.ok ? null : invokeResult.error
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
    ...(ctx.__turnId ? { __turnId: String(ctx.__turnId) } : {})
  };
}

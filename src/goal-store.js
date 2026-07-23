import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";

// Durable, session-scoped goal-loop state.
//
// Every mutation is appended to events.jsonl before an atomic snapshot is
// written. Journal records contain the complete post-mutation state, so an
// interrupted snapshot can be rebuilt by replaying the journal. Revisions are
// monotonic per session, including when one goal replaces another. Callers
// should pass the revision observed before an asynchronous judge request back
// to recordJudge; a user preemption or replacement then makes the stale judge
// fail closed instead of starting another continuation.

export const DEFAULT_GOAL_MAX_TURNS = 20;

export const GOAL_STATUSES = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  CLEARED: "cleared"
});

const VALID_STATUSES = new Set(Object.values(GOAL_STATUSES));

export class GoalRevisionError extends Error {
  constructor(sessionId, expectedRevision, actualRevision) {
    super(`Goal revision conflict for session '${sessionId}': expected ${expectedRevision}, found ${actualRevision ?? "none"}.`);
    this.name = "GoalRevisionError";
    this.code = "GOAL_REVISION_CONFLICT";
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision ?? null;
  }
}

export class GoalStore {
  constructor(options = {}) {
    const dataDir = options.dataDir ?? resolveDataDir();
    this.dir = options.dir ?? path.join(dataDir, "goals");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.maxTurns = resolveGoalMaxTurns(options.maxTurns ?? process.env.OPENAGI_GOAL_MAX_TURNS);
    this.now = typeof options.now === "function" ? options.now : nowIso;
    this.sessions = new Map();
    ensureDir(this.dir);
    this._loadSnapshot();
    this._replayEvents();
  }

  activate(sessionId, { goalId, objective, maxTurns } = {}) {
    const id = requireText(sessionId, "sessionId");
    const resolvedGoalId = requireText(goalId, "goalId");
    const resolvedObjective = requireText(objective, "objective");
    const previous = this.sessions.get(id) ?? null;
    const at = this._now();
    const revision = (previous?.revision ?? 0) + 1;
    const limit = maxTurns === undefined
      ? this.maxTurns
      : resolveGoalMaxTurns(maxTurns, { fallback: null });
    const audit = previous?.audit ? clone(previous.audit) : [];
    const state = {
      sessionId: id,
      goalId: resolvedGoalId,
      objective: resolvedObjective,
      status: GOAL_STATUSES.ACTIVE,
      revision,
      turns: 0,
      maxTurns: limit,
      activatedAt: at,
      updatedAt: at,
      pausedAt: null,
      resumedAt: null,
      preemptedAt: null,
      completedAt: null,
      clearedAt: null,
      reason: null,
      lastJudge: null,
      audit
    };
    state.audit.push(auditEntry(state, "activate", at, {
      replacedGoalId: previous?.goalId ?? null
    }));
    return this._commit("activate", previous, state, {
      replacedGoalId: previous?.goalId ?? null
    });
  }

  get(sessionId) {
    const id = normalizeText(sessionId);
    if (!id) return null;
    return this._view(this.sessions.get(id) ?? null);
  }

  pause(sessionId, reason = null, expectedRevision = undefined) {
    const options = transitionOptions(reason, expectedRevision);
    const current = this._current(sessionId, options.expectedRevision);
    if (!current) return null;
    if (current.status !== GOAL_STATUSES.ACTIVE) return this._view(current);
    const at = this._now();
    const next = this._next(current, "pause", at, {
      status: GOAL_STATUSES.PAUSED,
      pausedAt: at,
      reason: options.reason
    }, { reason: options.reason });
    return this._commit("pause", current, next, { reason: options.reason });
  }

  resume(sessionId, reason = null, expectedRevision = undefined) {
    const options = transitionOptions(reason, expectedRevision);
    const current = this._current(sessionId, options.expectedRevision);
    if (!current) return null;
    if (current.status !== GOAL_STATUSES.PAUSED) return this._view(current);
    if (current.turns >= current.maxTurns) return this._view(current);
    const at = this._now();
    const next = this._next(current, "resume", at, {
      status: GOAL_STATUSES.ACTIVE,
      resumedAt: at,
      reason: options.reason
    }, { reason: options.reason });
    return this._commit("resume", current, next, { reason: options.reason });
  }

  clear(sessionId, reason = null, expectedRevision = undefined) {
    const options = transitionOptions(reason, expectedRevision);
    const current = this._current(sessionId, options.expectedRevision);
    if (!current) return null;
    if (current.status === GOAL_STATUSES.CLEARED) return this._view(current);
    const at = this._now();
    const next = this._next(current, "clear", at, {
      status: GOAL_STATUSES.CLEARED,
      clearedAt: at,
      reason: options.reason
    }, { reason: options.reason });
    return this._commit("clear", current, next, { reason: options.reason });
  }

  preempt(sessionId, reason = "user-message", expectedRevision = undefined) {
    const options = transitionOptions(reason, expectedRevision, "user-message");
    const current = this._current(sessionId, options.expectedRevision);
    if (!current) return null;
    if (current.status !== GOAL_STATUSES.ACTIVE) return this._view(current);
    const at = this._now();
    const next = this._next(current, "preempt", at, {
      status: GOAL_STATUSES.PAUSED,
      pausedAt: at,
      preemptedAt: at,
      reason: options.reason
    }, { reason: options.reason });
    return this._commit("preempt", current, next, { reason: options.reason });
  }

  incrementTurn(sessionId, expectedRevision = undefined) {
    const current = this._current(sessionId, expectedRevision);
    if (!current) return null;
    if (current.status !== GOAL_STATUSES.ACTIVE || current.turns >= current.maxTurns) {
      return this._view(current);
    }
    const at = this._now();
    const next = this._next(current, "turn", at, {
      turns: current.turns + 1
    }, { turns: current.turns + 1 });
    return this._commit("turn", current, next, { turns: next.turns });
  }

  recordJudge(sessionId, { satisfied, why } = {}, expectedRevision = undefined) {
    if (typeof satisfied !== "boolean") {
      throw new TypeError("goal judge result requires a boolean satisfied value");
    }
    const current = this._current(sessionId, expectedRevision);
    if (!current) return null;
    if (current.status !== GOAL_STATUSES.ACTIVE) return this._view(current);
    const at = this._now();
    const judge = {
      satisfied,
      why: normalizeOptionalText(why, 4000),
      at,
      turn: current.turns
    };
    const next = this._next(current, "judge", at, { lastJudge: judge }, {
      satisfied,
      why: judge.why
    });
    return this._commit("judge", current, next, { judge });
  }

  complete(sessionId, reason = "satisfied", expectedRevision = undefined) {
    const options = transitionOptions(reason, expectedRevision, "satisfied");
    const current = this._current(sessionId, options.expectedRevision);
    if (!current) return null;
    if (current.status === GOAL_STATUSES.COMPLETED || current.status === GOAL_STATUSES.CLEARED) {
      return this._view(current);
    }
    const at = this._now();
    const next = this._next(current, "complete", at, {
      status: GOAL_STATUSES.COMPLETED,
      completedAt: at,
      reason: options.reason
    }, { reason: options.reason });
    return this._commit("complete", current, next, { reason: options.reason });
  }

  _current(sessionId, expectedRevision = undefined) {
    const id = requireText(sessionId, "sessionId");
    const current = this.sessions.get(id) ?? null;
    assertRevision(id, current, expectedRevision);
    return current;
  }

  _next(current, action, at, changes, auditDetails = {}) {
    const next = {
      ...clone(current),
      ...changes,
      revision: current.revision + 1,
      updatedAt: at
    };
    next.audit.push(auditEntry(next, action, at, auditDetails));
    return next;
  }

  _commit(op, previous, state, details = {}) {
    const event = {
      version: 1,
      op,
      at: state.updatedAt,
      sessionId: state.sessionId,
      goalId: state.goalId,
      previousRevision: previous?.revision ?? null,
      revision: state.revision,
      details,
      state
    };
    appendJsonLine(this.eventsPath, event);
    this.sessions.set(state.sessionId, state);
    this._writeSnapshot();
    return this._view(state);
  }

  _writeSnapshot() {
    writeJsonAtomic(this.snapshotPath, {
      version: 1,
      updatedAt: this._now(),
      sessions: [...this.sessions.values()]
    });
  }

  _loadSnapshot() {
    let snapshot;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      return;
    }
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    for (const state of sessions) {
      if (!isStoredState(state)) continue;
      const current = this.sessions.get(state.sessionId);
      if (!current || state.revision >= current.revision) {
        this.sessions.set(state.sessionId, clone(state));
      }
    }
  }

  _replayEvents() {
    let text;
    try {
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isStoredState(event?.state)) continue;
      if (event.sessionId !== event.state.sessionId || event.revision !== event.state.revision) continue;
      const current = this.sessions.get(event.sessionId);
      if (!current || event.revision >= current.revision) {
        this.sessions.set(event.sessionId, clone(event.state));
      }
    }
  }

  _view(state) {
    if (!state) return null;
    const view = clone(state);
    view.remainingTurns = Math.max(0, view.maxTurns - view.turns);
    view.canContinue = view.status === GOAL_STATUSES.ACTIVE && view.turns < view.maxTurns;
    return view;
  }

  _now() {
    const value = this.now();
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

export function resolveGoalMaxTurns(value, { fallback = DEFAULT_GOAL_MAX_TURNS } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) throw new TypeError("maxTurns must be a positive integer");
    return fallback;
  }
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    if (fallback === null) throw new TypeError("maxTurns must be a positive integer");
    return fallback;
  }
  return numeric;
}

function assertRevision(sessionId, current, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError("expectedRevision must be a positive integer");
  }
  const actual = current?.revision ?? null;
  if (actual !== expectedRevision) {
    throw new GoalRevisionError(sessionId, expectedRevision, actual);
  }
}

function auditEntry(state, action, at, details = {}) {
  return {
    action,
    at,
    revision: state.revision,
    goalId: state.goalId,
    status: state.status,
    ...details
  };
}

function transitionOptions(reason, expectedRevision, fallbackReason = null) {
  if (reason && typeof reason === "object" && !Array.isArray(reason)) {
    return {
      reason: normalizeOptionalText(reason.reason ?? reason.why ?? fallbackReason),
      expectedRevision: reason.expectedRevision ?? expectedRevision
    };
  }
  return {
    reason: normalizeOptionalText(reason ?? fallbackReason),
    expectedRevision
  };
}

function normalizeOptionalText(value, maxLength = 1000) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function requireText(value, field) {
  const text = normalizeText(value);
  if (!text) throw new TypeError(`${field} is required`);
  return text;
}

function isStoredState(state) {
  return Boolean(
    state
    && typeof state === "object"
    && normalizeText(state.sessionId)
    && normalizeText(state.goalId)
    && normalizeText(state.objective)
    && VALID_STATUSES.has(state.status)
    && Number.isSafeInteger(state.revision)
    && state.revision >= 1
    && Number.isSafeInteger(state.turns)
    && state.turns >= 0
    && Number.isSafeInteger(state.maxTurns)
    && state.maxTurns >= 1
    && Array.isArray(state.audit)
  );
}

function clone(value) {
  return structuredClone(value);
}

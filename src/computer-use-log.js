import fs from "node:fs";
import path from "node:path";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { createId, nowIso } from "./utils.js";

// Durable, content-minimized audit state for governed computer use.
// Sessions and actions are journaled before execution. Observations persist
// only structural evidence (generation, dimensions, hashes, and counts), not
// screenshots, OCR text, page text, or typed values.
export class ComputerUseLog {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "computer-use");
    ensureDir(this.dir);
    this.sessions = new Map();
    this.actions = new Map();
    this.events = null;
    this._loadSnapshot();
    this._replayJournal();
  }

  bindEvents(events) {
    this.events = events;
  }

  listSessions({
    status,
    projectId,
    agentSessionId
  } = {}) {
    return [...this.sessions.values()]
      .filter((session) => (
        (!status || session.status === status)
        && (projectId == null || session.projectId === projectId)
        && (
          agentSessionId == null
          || session.agentSessionId === agentSessionId
        )
      ))
      .sort((left, right) => (
        right.startedAt > left.startedAt ? 1 : -1
      ));
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  getActiveSession({
    projectId = null,
    agentSessionId = null
  } = {}) {
    const scoped = projectId != null || agentSessionId != null;
    return this.listSessions({
      status: "active",
      ...(scoped ? { projectId, agentSessionId } : {})
    })[0] ?? null;
  }

  listActions({ sessionId, limit = 200 } = {}) {
    return [...this.actions.values()]
      .filter((action) => !sessionId || action.sessionId === sessionId)
      .sort((left, right) => (
        right.createdAt > left.createdAt ? 1 : -1
      ))
      .slice(0, boundedInteger(limit, 1, 2_000, 200));
  }

  startSession({
    goal,
    approvedBy,
    projectId = null,
    agentSessionId = null,
    surface = "desktop",
    maxActions = 40
  }) {
    const session = {
      id: createId("cus"),
      goal: String(goal ?? "").slice(0, 500),
      approvedBy: approvedBy ?? "user",
      projectId: optionalIdentifier(projectId),
      agentSessionId: optionalSessionId(agentSessionId),
      surface: ["browser", "desktop"].includes(surface)
        ? surface
        : "desktop",
      maxActions: boundedInteger(maxActions, 1, 200, 40),
      mutationCount: 0,
      observationRevision: 0,
      lastObservation: null,
      status: "active",
      startedAt: nowIso(),
      endedAt: null,
      actionIds: []
    };
    this.sessions.set(session.id, session);
    this._appendJournal({ op: "session-start", session });
    this.events?.emit?.("computer-use", {
      kind: "session-start",
      session: structuredClone(session)
    });
    return session;
  }

  endSession(id, { reason, status = "ended" } = {}) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.status !== "active") return session;
    session.status = ["ended", "aborted"].includes(status)
      ? status
      : "ended";
    session.endedAt = nowIso();
    session.endReason = boundedText(reason, 500);
    this._appendJournal({
      op: "session-end",
      id,
      status: session.status,
      endedAt: session.endedAt,
      reason: session.endReason
    });
    this.events?.emit?.("computer-use", {
      kind: "session-end",
      session: structuredClone(session)
    });
    return session;
  }

  recordObservation(sessionId, observation = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new Error(
        `Cannot record observation: session '${sessionId}' is not active.`
      );
    }
    const revision = boundedInteger(
      session.observationRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      0
    ) + 1;
    const record = {
      revision,
      source: boundedText(observation.source, 100) ?? "unknown",
      generation: boundedText(observation.generation, 128),
      screenshotSha256: sha256OrNull(observation.screenshotSha256),
      contentSha256: sha256OrNull(observation.contentSha256),
      urlOrigin: safeOrigin(observation.urlOrigin),
      app: boundedText(observation.app, 200),
      nodeCount: nonNegativeIntegerOrNull(observation.nodeCount),
      width: positiveIntegerOrNull(observation.width),
      height: positiveIntegerOrNull(observation.height),
      capturedAt: nowIso()
    };
    if (!record.generation) {
      throw new TypeError("Computer-use observation requires a generation.");
    }
    session.observationRevision = revision;
    session.lastObservation = record;
    this._appendJournal({
      op: "session-observation",
      id: session.id,
      observationRevision: revision,
      observation: record
    });
    this.events?.emit?.("computer-use", {
      kind: "session-observation",
      sessionId: session.id,
      observation: structuredClone(record)
    });
    return record;
  }

  // Record intent before execution. Raw typed text and secret-like values are
  // irreversibly minimized here even if a caller forgets to sanitize them.
  recordAction({
    sessionId,
    kind,
    args,
    reasoning,
    mutating = true,
    beforeObservationRevision = null,
    beforeGeneration = null
  }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new Error(
        `Cannot record action: session '${sessionId}' is not active.`
      );
    }
    if (mutating && session.mutationCount >= session.maxActions) {
      throw new Error(
        `Computer-use action budget exhausted (${session.maxActions}). End the session or start a newly approved one.`
      );
    }
    if (mutating) session.mutationCount += 1;
    const action = {
      id: createId("act"),
      sessionId,
      kind: boundedText(kind, 100) ?? "unknown",
      args: sanitizeActionArgs(kind, args),
      reasoning: boundedText(reasoning, 500),
      mutating: mutating === true,
      beforeObservationRevision: Number.isSafeInteger(
        beforeObservationRevision
      ) ? beforeObservationRevision : null,
      beforeGeneration: boundedText(beforeGeneration, 128),
      status: "pending",
      createdAt: nowIso(),
      executedAt: null,
      result: null,
      error: null
    };
    this.actions.set(action.id, action);
    session.actionIds.push(action.id);
    this._appendJournal({ op: "action-record", action });
    this.events?.emit?.("computer-use", {
      kind: "action-record",
      action: structuredClone(action)
    });
    return action;
  }

  markActionResult(id, {
    result,
    error,
    status = "executed"
  }) {
    const action = this.actions.get(id);
    if (!action) return null;
    action.status = error ? "failed" : boundedText(status, 100) ?? "executed";
    action.executedAt = nowIso();
    if (result !== undefined) {
      action.result = sanitizeValue(result, 0);
    }
    if (error !== undefined) {
      action.error = boundedText(error, 2_000);
    }
    this._appendJournal({
      op: "action-result",
      id,
      status: action.status,
      executedAt: action.executedAt,
      result: action.result,
      error: action.error
    });
    this.events?.emit?.("computer-use", {
      kind: "action-result",
      action: structuredClone(action)
    });
    return action;
  }

  stats() {
    const sessions = [...this.sessions.values()];
    return {
      sessions: sessions.length,
      active: sessions.filter((session) => (
        session.status === "active"
      )).length,
      ended: sessions.filter((session) => (
        session.status === "ended"
      )).length,
      aborted: sessions.filter((session) => (
        session.status === "aborted"
      )).length,
      actions: this.actions.size
    };
  }

  _journalPath() {
    return path.join(this.dir, "journal.jsonl");
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 2,
      writtenAt: nowIso(),
      sessions: [...this.sessions.values()],
      actions: [...this.actions.values()]
    });
  }

  _loadSnapshot() {
    const snapshot = readJsonFile(
      path.join(this.dir, "snapshot.json"),
      null
    );
    if (!snapshot) return;
    for (const session of snapshot.sessions ?? []) {
      hydrateSession(session);
      this.sessions.set(session.id, session);
    }
    for (const action of snapshot.actions ?? []) {
      this.actions.set(action.id, action);
    }
  }

  _replayJournal() {
    let text;
    try {
      text = fs.readFileSync(this._journalPath(), "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.op === "session-start" && event.session) {
        hydrateSession(event.session);
        this.sessions.set(event.session.id, event.session);
      } else if (event.op === "session-end" && event.id) {
        const session = this.sessions.get(event.id);
        if (session) {
          session.status = event.status;
          session.endedAt = event.endedAt;
          session.endReason = event.reason;
        }
      } else if (event.op === "session-observation" && event.id) {
        const session = this.sessions.get(event.id);
        if (session) {
          session.observationRevision = event.observationRevision;
          session.lastObservation = event.observation;
        }
      } else if (event.op === "action-record" && event.action) {
        const previous = this.actions.get(event.action.id);
        this.actions.set(event.action.id, event.action);
        const session = this.sessions.get(event.action.sessionId);
        if (
          session
          && !session.actionIds.includes(event.action.id)
        ) {
          session.actionIds.push(event.action.id);
          if (event.action.mutating === true && !previous) {
            session.mutationCount += 1;
          }
        }
      } else if (event.op === "action-result" && event.id) {
        const action = this.actions.get(event.id);
        if (action) {
          action.status = event.status;
          action.executedAt = event.executedAt;
          if (event.result !== undefined) action.result = event.result;
          if (event.error !== undefined) action.error = event.error;
        }
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), event);
  }
}

function hydrateSession(session) {
  session.projectId ??= null;
  session.agentSessionId ??= null;
  session.surface ??= "desktop";
  session.maxActions = boundedInteger(session.maxActions, 1, 200, 40);
  session.mutationCount = boundedInteger(
    session.mutationCount,
    0,
    Number.MAX_SAFE_INTEGER,
    0
  );
  session.observationRevision = boundedInteger(
    session.observationRevision,
    0,
    Number.MAX_SAFE_INTEGER,
    0
  );
  session.lastObservation ??= null;
  session.actionIds = Array.isArray(session.actionIds)
    ? session.actionIds
    : [];
  return session;
}

function sanitizeActionArgs(kind, value) {
  const source = value
    && typeof value === "object"
    && !Array.isArray(value)
    ? value
    : {};
  const output = {};
  for (const [key, item] of Object.entries(source)) {
    if (item === undefined) continue;
    if (/password|token|secret/i.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    if (key === "text") {
      const text = String(item);
      output.text = "[REDACTED]";
      if (text !== "[REDACTED]") {
        output.textLength = text.length;
      }
      continue;
    }
    if (
      String(kind) === "select"
      && (key === "value" || key === "values")
    ) {
      output.selection = "[OMITTED]";
      output.selectionCount = Array.isArray(item) ? item.length : 1;
      continue;
    }
    output[key] = sanitizeValue(item, 0);
  }
  if (["input", "type"].includes(String(kind)) && !("text" in output)) {
    output.text = "[REDACTED]";
  }
  return output;
}

function sanitizeValue(value, depth) {
  if (depth > 4) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => (
      sanitizeValue(item, depth + 1)
    ));
  }
  if (typeof value !== "object") {
    return String(value).slice(0, 2_000);
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    output[key] = /password|token|secret/i.test(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1);
  }
  return output;
}

function optionalIdentifier(value) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(text)) {
    throw new TypeError("Computer-use projectId is invalid.");
  }
  return text;
}

function optionalSessionId(value) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text)) {
    throw new TypeError("Computer-use agentSessionId is invalid.");
  }
  return text;
}

function boundedText(value, maxLength) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    && number >= minimum
    && number <= maximum
    ? number
    : fallback;
}

function sha256OrNull(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function safeOrigin(value) {
  if (value == null) return null;
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

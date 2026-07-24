import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { ensureDir, readJsonFile, safeFilename, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const MAX_SESSION_ID_CHARS = 2048;
const MAX_BRANCH_MESSAGE_ID_CHARS = 512;
const MAX_PROJECT_ID_CHARS = 64;

export class AgentSessionStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentSessionStoreError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class InMemoryAgentStore {
  constructor(options = {}) {
    this.agents = new Map();
    this.sessions = new Map();
    if (options.ensureDefault !== false) this.ensureAgent({ id: "main", name: "Main Agent", role: "root" });
  }

  ensureAgent(agent) {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const created = normalizeAgent(agent);
    this.agents.set(created.id, created);
    return created;
  }

  // Overwrite fields on an agent (unlike ensureAgent, which no-ops if it
  // exists). Used to apply persona.md to the main agent on every boot.
  setAgent(id, fields) {
    const merged = normalizeAgent({ ...(this.agents.get(id) ?? { id }), ...fields, id });
    this.agents.set(id, merged);
    return merged;
  }

  createAgent(agent = {}) {
    const id = agent.id ?? createId("agent");
    return this.ensureAgent({ ...agent, id });
  }

  getAgent(id = "main") {
    return this.agents.get(id) ?? this.ensureAgent({ id, name: id });
  }

  listAgents() {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  sessionKey({ channel = "local", from = "user", agentId = "main", sessionId }) {
    return sessionId ?? `${channel}:${from}:${agentId}`;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? emptySession(sessionId);
  }

  hasSession(sessionId) {
    return this.sessions.has(normalizeSessionId(sessionId));
  }

  saveSession(session) {
    this.sessions.set(session.id, {
      ...session,
      updatedAt: nowIso()
    });
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    session.messages.push(normalizeMessage(message));
    this.saveSession(session);
    return this.getSession(sessionId);
  }

  async createSessionBranch(sourceSessionId, options = {}) {
    const sourceId = normalizeSessionId(sourceSessionId);
    const normalized = normalizeBranchOptions(options);
    const source = this.sessions.get(sourceId);
    if (!source) throw sessionNotFound(sourceId);
    if (this.sessions.has(normalized.targetSessionId)) {
      throw branchTargetExists(normalized.targetSessionId);
    }
    const branch = buildSessionBranch(source, normalized);
    this.sessions.set(branch.id, structuredClone(branch));
    return structuredClone(branch);
  }

  branchSession(sourceSessionId, options = {}) {
    return this.createSessionBranch(sourceSessionId, options);
  }

  async ensureSessionMetadata(sessionId, key, createValue) {
    const session = this.getSession(sessionId);
    session.metadata = session.metadata ?? {};
    if (!Object.hasOwn(session.metadata, key)) {
      session.metadata[key] = typeof createValue === "function" ? createValue() : createValue;
      await this.saveSession(session);
    }
    return session.metadata[key];
  }

  async updateSessionMetadata(sessionId, key, updateValue) {
    const session = this.getSession(sessionId);
    session.metadata = session.metadata ?? {};
    const current = session.metadata[key];
    const next = typeof updateValue === "function" ? updateValue(current) : updateValue;
    if (next !== current) {
      session.metadata[key] = next;
      await this.saveSession(session);
    }
    return next;
  }

  listSessions() {
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
        lastMessage: session.messages?.at(-1)?.content ?? ""
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class FileBackedAgentStore extends InMemoryAgentStore {
  constructor(options = {}) {
    super({ ensureDefault: false });
    this.dir = options.dir ?? path.join(resolveDataDir(), "agent-host");
    this.agentsPath = path.join(this.dir, "agents.json");
    this.sessionsDir = path.join(this.dir, "sessions");
    this.sessionWriteChains = new Map();
    ensureDir(this.sessionsDir);
    this.load();
    if (options.ensureDefault !== false) this.ensureAgent({ id: "main", name: "Main Agent", role: "root" });
  }

  load() {
    const store = readJsonFile(this.agentsPath, { version: 1, agents: [] });
    this.agents = new Map();
    for (const agent of store.agents ?? []) {
      if (agent.id) this.agents.set(agent.id, agent);
    }
    return this.listAgents();
  }

  saveAgents() {
    writeJsonAtomic(this.agentsPath, {
      version: 1,
      updatedAt: nowIso(),
      agents: this.listAgents()
    });
  }

  ensureAgent(agent) {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const created = normalizeAgent(agent);
    this.agents.set(created.id, created);
    this.saveAgents();
    return created;
  }

  // Overwrite fields on an agent (unlike ensureAgent). Used to apply
  // persona.md to the main agent on every boot. Skips the disk write when
  // nothing actually changed (avoids needless churn on every restart).
  setAgent(id, fields) {
    const before = this.agents.get(id);
    const merged = normalizeAgent({ ...(before ?? { id }), ...fields, id });
    if (before && before.name === merged.name && before.systemPrompt === merged.systemPrompt) return before;
    this.agents.set(id, merged);
    this.saveAgents();
    return merged;
  }

  createAgent(agent = {}) {
    const id = agent.id ?? createId("agent");
    return this.ensureAgent({ ...agent, id });
  }

  getAgent(id = "main") {
    return this.agents.get(id) ?? this.ensureAgent({ id, name: id });
  }

  listAgents() {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  sessionKey({ channel = "local", from = "user", agentId = "main", sessionId }) {
    return sessionId ?? `${channel}:${from}:${agentId}`;
  }

  sessionPath(sessionId) {
    const id = normalizeSessionId(sessionId);
    const digest = createHash("sha256").update(id, "utf8").digest("hex");
    return path.join(this.sessionsDir, `session-${digest}.json`);
  }

  legacySessionPath(sessionId) {
    return path.join(
      this.sessionsDir,
      `${safeFilename(normalizeSessionId(sessionId))}.json`
    );
  }

  hasSession(sessionId) {
    return this._readStoredSession(sessionId, { migrate: false }) !== null;
  }

  getSession(sessionId) {
    const id = normalizeSessionId(sessionId);
    return this._readStoredSession(id, { migrate: true }) ?? emptySession(id);
  }

  saveSession(session) {
    const id = normalizeSessionId(session?.id);
    const sessionPath = this.sessionPath(id);
    const existing = readJsonFile(sessionPath, null);
    if (existing && existing.id !== id) {
      throw transcriptIdMismatch(id, existing.id, sessionPath);
    }
    writeJsonAtomic(sessionPath, {
      ...session,
      id,
      updatedAt: nowIso()
    });
  }

  appendMessage(sessionId, message) {
    const id = normalizeSessionId(sessionId);
    return this._enqueueSessionMutation(id, async () => {
      const session = this.getSession(id);
      session.messages.push({
        ...normalizeMessage(message)
      });
      await this.saveSession(session);
      return session;
    });
  }

  async createSessionBranch(sourceSessionId, options = {}) {
    const sourceId = normalizeSessionId(sourceSessionId);
    const normalized = normalizeBranchOptions(options);
    if (sourceId === normalized.targetSessionId) {
      throw branchTargetExists(normalized.targetSessionId);
    }

    // Capture the source queue synchronously so every write already queued
    // when branching began is durable before the prefix is selected.
    const sourceBarrier = this.sessionWriteChains.get(sourceId)
      ?? Promise.resolve();
    await sourceBarrier.catch(() => {});

    return this._enqueueSessionMutation(
      normalized.targetSessionId,
      async () => {
        const source = this._readStoredSession(sourceId, { migrate: true });
        if (!source) throw sessionNotFound(sourceId);
        if (this._readStoredSession(normalized.targetSessionId, {
          migrate: false
        })) {
          throw branchTargetExists(normalized.targetSessionId);
        }
        const branch = buildSessionBranch(source, normalized);
        await this.saveSession(branch);
        return structuredClone(branch);
      }
    );
  }

  branchSession(sourceSessionId, options = {}) {
    return this.createSessionBranch(sourceSessionId, options);
  }

  ensureSessionMetadata(sessionId, key, createValue) {
    const id = normalizeSessionId(sessionId);
    return this._enqueueSessionMutation(id, async () => {
      const session = this.getSession(id);
      session.metadata = session.metadata ?? {};
      if (!Object.hasOwn(session.metadata, key)) {
        session.metadata[key] = typeof createValue === "function" ? createValue() : createValue;
        await this.saveSession(session);
      }
      return session.metadata[key];
    });
  }

  updateSessionMetadata(sessionId, key, updateValue) {
    const id = normalizeSessionId(sessionId);
    return this._enqueueSessionMutation(id, async () => {
      const session = this.getSession(id);
      session.metadata = session.metadata ?? {};
      const current = session.metadata[key];
      const next = typeof updateValue === "function" ? updateValue(current) : updateValue;
      if (next !== current) {
        session.metadata[key] = next;
        await this.saveSession(session);
      }
      return next;
    });
  }

  listSessions() {
    const sessions = new Map();
    for (const entry of readDirSafe(this.sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.sessionsDir, entry);
      const session = readJsonFile(filePath, null);
      if (!validStoredSessionForPath(this, session, filePath)) continue;
      const current = sessions.get(session.id);
      const hashed = filePath === this.sessionPath(session.id);
      if (!current || (hashed && !current.hashed)) {
        sessions.set(session.id, { hashed, session });
      }
    }
    return [...sessions.values()]
      .map(({ session }) => ({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
        lastMessage: session.messages?.at(-1)?.content ?? ""
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  _enqueueSessionMutation(sessionId, operation) {
    const id = normalizeSessionId(sessionId);
    const previous = this.sessionWriteChains.get(id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(operation);
    this.sessionWriteChains.set(id, write);
    return write.finally(() => {
      // A later mutation may already have extended the chain. Only its final
      // link may remove the key, or another writer could slip past the mutex.
      if (this.sessionWriteChains.get(id) === write) {
        this.sessionWriteChains.delete(id);
      }
    });
  }

  _readStoredSession(sessionId, { migrate }) {
    const id = normalizeSessionId(sessionId);
    const hashedPath = this.sessionPath(id);
    const stored = readJsonFile(hashedPath, null);
    if (stored) {
      if (stored.id !== id) {
        throw transcriptIdMismatch(id, stored.id, hashedPath);
      }
      return stored;
    }

    const legacyPath = this.legacySessionPath(id);
    const legacy = readJsonFile(legacyPath, null);
    if (!legacy || legacy.id !== id) return null;
    if (migrate) {
      // Keep the legacy file as a recoverable compatibility copy. All future
      // writes use the injective path and listSessions prefers that copy.
      writeJsonAtomic(hashedPath, legacy);
    }
    return legacy;
  }
}

function normalizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    role: agent.role ?? "agent",
    parentId: agent.parentId ?? null,
    scope: agent.scope ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    createdAt: agent.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    metadata: agent.metadata ?? {}
  };
}

function normalizeMessage(message) {
  return {
    id: message.id ?? createId("msg"),
    role: message.role,
    content: message.content,
    agentId: message.agentId,
    channel: message.channel,
    from: message.from,
    createdAt: message.createdAt ?? nowIso(),
    metadata: message.metadata ?? {}
  };
}

function emptySession(sessionId) {
  return {
    id: sessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
    metadata: {}
  };
}

function normalizeSessionId(value, label = "session id") {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (
    value.length < 1
    || value.length > MAX_SESSION_ID_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(
      `${label} must be 1-${MAX_SESSION_ID_CHARS} characters without controls`
    );
  }
  return value;
}

function normalizeBranchOptions(options) {
  const source = plainRecord(options, "branch options");
  assertOnlyKeys(
    source,
    new Set([
      "createdAt",
      "messageId",
      "metadata",
      "projectId",
      "targetSessionId"
    ]),
    "branch options"
  );
  const messageId = requiredBoundedText(
    source.messageId,
    "branch messageId",
    MAX_BRANCH_MESSAGE_ID_CHARS
  );
  const targetSessionId = normalizeSessionId(
    source.targetSessionId,
    "target session id"
  );
  const metadata = source.metadata == null
    ? {}
    : plainRecord(source.metadata, "branch metadata");
  assertOnlyKeys(metadata, new Set(["projectId"]), "branch metadata");
  const projectId = source.projectId ?? metadata.projectId ?? null;
  return {
    targetSessionId,
    messageId,
    projectId: projectId == null
      ? null
      : normalizeProjectId(projectId),
    createdAt: source.createdAt == null
      ? null
      : normalizeTimestamp(source.createdAt, "branch createdAt")
  };
}

function buildSessionBranch(source, options) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("source session is invalid");
  }
  if (!Array.isArray(source.messages)) {
    throw new TypeError("source session messages must be an array");
  }
  const matches = [];
  for (let index = 0; index < source.messages.length; index += 1) {
    if (source.messages[index]?.id === options.messageId) matches.push(index);
  }
  if (matches.length === 0) {
    throw new AgentSessionStoreError(
      "SESSION_BRANCH_MESSAGE_NOT_FOUND",
      `Message '${options.messageId}' was not found in session '${source.id}'.`,
      { sessionId: source.id, messageId: options.messageId }
    );
  }
  if (matches.length !== 1) {
    throw new AgentSessionStoreError(
      "SESSION_BRANCH_MESSAGE_AMBIGUOUS",
      `Message '${options.messageId}' is not unique in session '${source.id}'.`,
      { sessionId: source.id, messageId: options.messageId }
    );
  }

  const sourceProjectId = sessionProjectId(source);
  const projectId = options.projectId ?? sourceProjectId;
  if (projectId !== sourceProjectId) {
    throw new AgentSessionStoreError(
      "PROJECT_BOUNDARY_VIOLATION",
      `Session '${source.id}' belongs to project '${sourceProjectId}', not '${projectId}'.`,
      {
        sessionId: source.id,
        projectId: sourceProjectId,
        requestedProjectId: projectId
      }
    );
  }
  const createdAt = options.createdAt ?? nowIso();
  const messages = structuredClone(source.messages.slice(0, matches[0] + 1));
  return {
    id: options.targetSessionId,
    projectId,
    createdAt,
    updatedAt: createdAt,
    messages,
    metadata: {
      projectId,
      branchV1: {
        sourceSessionId: source.id,
        messageId: options.messageId,
        messageCount: messages.length,
        createdAt
      }
    }
  };
}

function sessionProjectId(session) {
  const candidates = [
    session?.projectId,
    session?.metadata?.projectId,
    ...(Array.isArray(session?.messages)
      ? session.messages.map((message) => message?.metadata?.projectId)
      : [])
  ];
  const projectIds = new Set();
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    projectIds.add(normalizeProjectId(candidate));
  }
  if (projectIds.size > 1) {
    throw new AgentSessionStoreError(
      "PROJECT_BOUNDARY_VIOLATION",
      `Session '${String(session?.id ?? "")}' has conflicting project bindings.`,
      { sessionId: session?.id ?? null }
    );
  }
  return projectIds.values().next().value ?? "default";
}

function normalizeProjectId(value) {
  const projectId = requiredBoundedText(
    value,
    "projectId",
    MAX_PROJECT_ID_CHARS
  ).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(projectId)) {
    throw new TypeError("projectId is invalid");
  }
  return projectId;
}

function normalizeTimestamp(value, label) {
  const text = requiredBoundedText(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function requiredBoundedText(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  return value;
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string"
      || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label} must contain enumerable data properties only`);
    }
  }
  return value;
}

function assertOnlyKeys(source, allowed, label) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}.${key} is not supported`);
    }
  }
}

function validStoredSessionForPath(store, session, filePath) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }
  let id;
  try {
    id = normalizeSessionId(session.id);
  } catch {
    return false;
  }
  const resolved = path.resolve(filePath);
  return resolved === path.resolve(store.sessionPath(id))
    || resolved === path.resolve(store.legacySessionPath(id));
}

function sessionNotFound(sessionId) {
  return new AgentSessionStoreError(
    "SESSION_NOT_FOUND",
    `Session '${sessionId}' does not exist.`,
    { sessionId }
  );
}

function branchTargetExists(sessionId) {
  return new AgentSessionStoreError(
    "SESSION_BRANCH_TARGET_EXISTS",
    `Session '${sessionId}' already exists.`,
    { sessionId }
  );
}

function transcriptIdMismatch(expectedSessionId, actualSessionId, filePath) {
  return new AgentSessionStoreError(
    "SESSION_TRANSCRIPT_ID_MISMATCH",
    "Stored transcript identity does not match its requested session.",
    {
      sessionId: expectedSessionId,
      storedSessionId: actualSessionId ?? null,
      path: filePath
    }
  );
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

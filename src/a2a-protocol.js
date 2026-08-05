// A2A (Agent-to-Agent) protocol v1.0 — pure protocol layer, no HTTP.
//
// This module is deliberately transport-free so the state machine and the
// JSON-RPC framing can be unit-tested without standing up a server. The HTTP
// binding lives in hosted-interface.js and calls into here.
//
// We port the SERVER half only: another agent can discover us and send us
// tasks. The outbound client half (discover/call/orchestrate peers) is not in
// this wave -- it is a separate trust surface with its own review.
//
// Wire-format notes that are easy to get wrong:
//   * Task states are SCREAMING_SNAKE_CASE strings (TASK_STATE_*), not enums
//     or lowercase. A peer matching on "completed" is matching the wrong spec.
//   * -32001/-32002/-32003 are A2A-RESERVED codes and are used ONLY with their
//     spec semantics (TaskNotFound / TaskNotCancelable / PushNotificationNot
//     Supported). Custom errors live at -32050+, clear of the reserved block.
//   * Timestamps are ISO 8601 with millisecond precision.
//
// What is and is not a secret: the agent card is PUBLIC and unauthenticated by
// contract -- it is the discovery document. Nothing derived from config,
// session state, project names, or filesystem paths may appear in it. The
// skills list is a curated allowlist, never the live tool registry: publishing
// `code_shell` as a discoverable capability to any agent on the network is not
// a feature.

export const A2A_PROTOCOL_VERSION = "1.0";

export const TASK_STATE_SUBMITTED = "TASK_STATE_SUBMITTED";
export const TASK_STATE_WORKING = "TASK_STATE_WORKING";
export const TASK_STATE_INPUT_REQUIRED = "TASK_STATE_INPUT_REQUIRED";
export const TASK_STATE_AUTH_REQUIRED = "TASK_STATE_AUTH_REQUIRED";
export const TASK_STATE_COMPLETED = "TASK_STATE_COMPLETED";
export const TASK_STATE_FAILED = "TASK_STATE_FAILED";
export const TASK_STATE_CANCELED = "TASK_STATE_CANCELED";
export const TASK_STATE_REJECTED = "TASK_STATE_REJECTED";

export const TASK_STATES = Object.freeze([
  TASK_STATE_SUBMITTED,
  TASK_STATE_WORKING,
  TASK_STATE_INPUT_REQUIRED,
  TASK_STATE_AUTH_REQUIRED,
  TASK_STATE_COMPLETED,
  TASK_STATE_FAILED,
  TASK_STATE_CANCELED,
  TASK_STATE_REJECTED
]);

export const TERMINAL_TASK_STATES = Object.freeze(new Set([
  TASK_STATE_COMPLETED,
  TASK_STATE_FAILED,
  TASK_STATE_CANCELED,
  TASK_STATE_REJECTED
]));

export const ROLE_USER = "ROLE_USER";
export const ROLE_AGENT = "ROLE_AGENT";

// Legal transitions. Terminal states have NO outgoing edges -- a completed task
// can never go back to working, which is what makes tasks/get idempotent and
// stops a late worker callback from resurrecting a canceled task.
const TRANSITIONS = Object.freeze({
  [TASK_STATE_SUBMITTED]: Object.freeze([
    TASK_STATE_WORKING,
    TASK_STATE_INPUT_REQUIRED,
    TASK_STATE_AUTH_REQUIRED,
    TASK_STATE_COMPLETED,
    TASK_STATE_FAILED,
    TASK_STATE_CANCELED,
    TASK_STATE_REJECTED
  ]),
  [TASK_STATE_WORKING]: Object.freeze([
    TASK_STATE_INPUT_REQUIRED,
    TASK_STATE_AUTH_REQUIRED,
    TASK_STATE_COMPLETED,
    TASK_STATE_FAILED,
    TASK_STATE_CANCELED,
    TASK_STATE_REJECTED
  ]),
  [TASK_STATE_INPUT_REQUIRED]: Object.freeze([
    TASK_STATE_WORKING,
    TASK_STATE_COMPLETED,
    TASK_STATE_FAILED,
    TASK_STATE_CANCELED,
    TASK_STATE_REJECTED
  ]),
  [TASK_STATE_AUTH_REQUIRED]: Object.freeze([
    TASK_STATE_WORKING,
    TASK_STATE_COMPLETED,
    TASK_STATE_FAILED,
    TASK_STATE_CANCELED,
    TASK_STATE_REJECTED
  ]),
  [TASK_STATE_COMPLETED]: Object.freeze([]),
  [TASK_STATE_FAILED]: Object.freeze([]),
  [TASK_STATE_CANCELED]: Object.freeze([]),
  [TASK_STATE_REJECTED]: Object.freeze([])
});

export function isTaskState(value) {
  return TASK_STATES.includes(value);
}

export function isTerminalState(state) {
  return TERMINAL_TASK_STATES.has(state);
}

/** Legal-transition guard. Unknown states and self-transitions are illegal. */
export function canTransition(from, to) {
  if (!isTaskState(from) || !isTaskState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from) {
  return isTaskState(from) ? [...TRANSITIONS[from]] : [];
}

// --- JSON-RPC 2.0 error codes -------------------------------------------

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
// A2A-reserved. Use ONLY with these exact semantics.
export const ERR_TASK_NOT_FOUND = -32001;
export const ERR_TASK_NOT_CANCELABLE = -32002;
export const ERR_PUSH_NOT_SUPPORTED = -32003;
// Implementation-defined server error space, clear of the A2A-reserved block.
export const ERR_UNAUTHORIZED = -32050;
export const ERR_RATE_LIMITED = -32051;

export function nowIso() {
  return `${new Date().toISOString().slice(0, 23)}Z`;
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonRpcError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

/**
 * Validate JSON-RPC 2.0 envelope shape. Returns {ok, id, method, params} or
 * {ok:false, response} carrying the spec-correct error object.
 */
export function parseJsonRpcRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: jsonRpcError(null, ERR_INVALID_REQUEST, "Request must be a JSON-RPC 2.0 object") };
  }
  const id = body.id ?? null;
  if (body.jsonrpc !== "2.0") {
    return { ok: false, response: jsonRpcError(id, ERR_INVALID_REQUEST, "jsonrpc must be exactly \"2.0\"") };
  }
  if (typeof body.method !== "string" || !body.method) {
    return { ok: false, response: jsonRpcError(id, ERR_INVALID_REQUEST, "method must be a non-empty string") };
  }
  const params = body.params ?? {};
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, response: jsonRpcError(id, ERR_INVALID_PARAMS, "params must be an object") };
  }
  return { ok: true, id, method: body.method, params };
}

/**
 * Render inbound A2A Parts to plain text.
 *
 * v1.0 Parts are member-presence discriminated (no `kind` field); v0.3 used
 * `kind` and pre-0.3 used `type`. Accept all three inbound so an older peer
 * still works, and render file/data parts so the agent actually sees them.
 */
export function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text.trim();
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") { chunks.push(part.text); continue; }
    if (part.file && typeof part.file === "object") {
      const name = part.file.filename ?? "file";
      const ref = part.file.url ?? "(inline)";
      chunks.push(`[file: ${name} ${ref}]`);
      continue;
    }
    if (part.data !== undefined) {
      try { chunks.push(`[data: ${JSON.stringify(part.data)}]`); }
      catch { chunks.push("[data: unserializable]"); }
    }
  }
  return chunks.join("\n").trim();
}

export function buildMessage(role, text, { messageId = null, contextId = null, taskId = null } = {}) {
  const message = { role, parts: [{ text: String(text ?? "") }] };
  if (messageId) message.messageId = messageId;
  if (contextId) message.contextId = contextId;
  if (taskId) message.taskId = taskId;
  return message;
}

/**
 * Build the PUBLIC agent card.
 *
 * Every field here is visible to any unauthenticated caller that can reach the
 * port. `skills` MUST be a curated allowlist supplied by the caller -- this
 * function will not derive them from a live tool registry, because that is
 * precisely how `code_shell` ends up advertised to the network.
 */
export function buildAgentCard({
  name = "cerberus",
  description = "An openAGI agent.",
  url = "",
  skills = [],
  streaming = true,
  authRequired = true,
  version = "1.0.0"
} = {}) {
  const card = {
    name: String(name),
    description: String(description),
    url: String(url),
    version: String(version),
    protocolVersion: A2A_PROTOCOL_VERSION,
    supportedInterfaces: [{
      url: String(url),
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION
    }],
    capabilities: {
      streaming: Boolean(streaming),
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: false
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: (Array.isArray(skills) ? skills : []).map((skill) => ({
      id: String(skill?.id ?? ""),
      name: String(skill?.name ?? ""),
      description: String(skill?.description ?? ""),
      tags: Array.isArray(skill?.tags) ? skill.tags.map(String) : []
    }))
  };
  if (authRequired) {
    card.securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
    card.security = [{ bearer: [] }];
  }
  return card;
}

/**
 * The curated capability allowlist. Deliberately coarse and hand-written:
 * these describe what a peer may ASK FOR, not what tools exist. Adding an
 * entry here is a security decision, which is exactly why it is not derived.
 */
export const DEFAULT_ADVERTISED_SKILLS = Object.freeze([
  Object.freeze({
    id: "general",
    name: "general",
    description: "General-purpose conversational assistance: questions, summarization, and analysis.",
    tags: Object.freeze(["general", "chat", "qa"])
  }),
  Object.freeze({
    id: "research",
    name: "research",
    description: "Read-only research and information synthesis from already-available context.",
    tags: Object.freeze(["research", "summarize"])
  })
]);

/** In-memory A2A task record. */
export function createTask({ taskId, contextId, text, createdAt = nowIso() }) {
  return {
    id: taskId,
    contextId: contextId ?? null,
    state: TASK_STATE_SUBMITTED,
    createdAt,
    lastModified: createdAt,
    request: String(text ?? ""),
    history: [],
    result: null,
    error: null
  };
}

/**
 * Bounded task store. Terminal tasks stay queryable (that is the point of
 * tasks/get) but are pruned on a TTL and by count, so an exposed endpoint
 * cannot grow memory without bound.
 */
export class A2ATaskStore {
  #tasks = new Map();

  constructor({ maxTasks = 500, terminalTtlMs = 3_600_000, now = () => Date.now() } = {}) {
    this.maxTasks = Math.max(1, Number.parseInt(maxTasks, 10) || 500);
    this.terminalTtlMs = Math.max(1_000, Number.parseInt(terminalTtlMs, 10) || 3_600_000);
    this.now = now;
  }

  create(task) {
    this.#tasks.delete(task.id);
    this.#tasks.set(task.id, { ...task, updatedAtMs: this.now() });
    this.prune();
    return this.get(task.id);
  }

  get(taskId) {
    const task = this.#tasks.get(String(taskId ?? ""));
    return task ? { ...task } : null;
  }

  has(taskId) {
    return this.#tasks.has(String(taskId ?? ""));
  }

  /**
   * Apply a state transition. Returns {ok:true, task} or {ok:false, code}
   * with an A2A-correct error code so the caller can frame it directly.
   */
  transition(taskId, nextState, { result = undefined, error = undefined } = {}) {
    const task = this.#tasks.get(String(taskId ?? ""));
    if (!task) return { ok: false, code: ERR_TASK_NOT_FOUND, message: `Task ${taskId} not found` };
    if (!canTransition(task.state, nextState)) {
      const code = isTerminalState(task.state) && nextState === TASK_STATE_CANCELED
        ? ERR_TASK_NOT_CANCELABLE
        : ERR_INVALID_PARAMS;
      return {
        ok: false,
        code,
        message: `Task ${taskId} cannot move from ${task.state} to ${nextState}`
      };
    }
    task.state = nextState;
    task.lastModified = nowIso();
    task.updatedAtMs = this.now();
    if (result !== undefined) task.result = result;
    if (error !== undefined) task.error = error;
    return { ok: true, task: { ...task } };
  }

  list({ limit = 50 } = {}) {
    const all = [...this.#tasks.values()].map((task) => ({ ...task }));
    return all.slice(-Math.max(1, limit)).reverse();
  }

  prune() {
    const cutoff = this.now() - this.terminalTtlMs;
    for (const [id, task] of [...this.#tasks]) {
      if (isTerminalState(task.state) && task.updatedAtMs < cutoff) this.#tasks.delete(id);
    }
    while (this.#tasks.size > this.maxTasks) {
      const oldest = this.#tasks.keys().next().value;
      this.#tasks.delete(oldest);
    }
  }

  get size() {
    return this.#tasks.size;
  }

  /** Wire shape returned to a peer. Internal bookkeeping is not published. */
  static toWire(task) {
    if (!task) return null;
    return {
      id: task.id,
      contextId: task.contextId,
      status: {
        state: task.state,
        timestamp: task.lastModified,
        ...(task.error ? { message: buildMessage(ROLE_AGENT, task.error) } : {})
      },
      createdAt: task.createdAt,
      lastModified: task.lastModified,
      ...(task.result ? { artifacts: [{ parts: [{ text: task.result }] }] } : {}),
      history: Array.isArray(task.history) ? task.history : []
    };
  }
}

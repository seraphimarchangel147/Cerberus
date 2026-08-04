// A2A v1.0 server -- JSON-RPC binding, agent card, and task execution.
//
// The protocol layer (src/a2a-protocol.js) is transport-free; this module owns
// the runtime side: turning an inbound `message/send` into a real agent turn,
// tracking its task state, and streaming updates. The HTTP routes themselves
// live in hosted-interface.js and delegate here, so route dispatch stays a flat
// readable chain and this logic stays testable without a socket.
//
// SECURITY POSTURE -- this is a PUBLIC protocol surface, so the defaults are
// deliberately hostile to exposure:
//
//   * Disabled by default. OPENAGI_A2A_ENABLED=1 turns it on; otherwise every
//     route 404s as if it did not exist.
//   * Loopback bind by default. Serving A2A on a non-loopback interface
//     requires OPENAGI_A2A_ALLOW_REMOTE=1 as a separate, explicit decision --
//     enabling the protocol and exposing it to the network are two different
//     choices and must not be one flag.
//   * Bearer auth on everything except the agent card, reusing src/auth.js
//     rather than inventing a second scheme.
//   * An A2A task NEVER inherits the operator's auto-approve. It runs on the
//     `subagent` channel with a read-only scrutiny ceiling, which the existing
//     stricterToolPolicy() rail can only tighten further, never loosen. An
//     external agent must not be able to trigger a catastrophic tool call.
//   * The agent card publishes a curated allowlist of coarse capabilities, not
//     the live tool registry.
//
// What is and is not a secret: task ids and context ids are opaque routing
// handles and appear in logs. Task REQUEST and RESULT text is peer
// conversation content and is never logged at info level. The bearer token
// never appears anywhere except a constant-time comparison in src/auth.js.

import { randomUUID } from "node:crypto";
import {
  A2ATaskStore,
  DEFAULT_ADVERTISED_SKILLS,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ROLE_AGENT,
  ROLE_USER,
  TASK_STATE_CANCELED,
  TASK_STATE_COMPLETED,
  TASK_STATE_FAILED,
  TASK_STATE_WORKING,
  buildAgentCard,
  buildMessage,
  createTask,
  extractMessageText,
  isTerminalState,
  jsonRpcError,
  jsonRpcResult,
  nowIso,
  parseJsonRpcRequest
} from "./a2a-protocol.js";

export const A2A_RPC_PATH = "/a2a";
export const A2A_CARD_PATH = "/.well-known/agent-card.json";

export function a2aEnabled(env = process.env) {
  return String(env.OPENAGI_A2A_ENABLED ?? "").trim() === "1";
}

export function a2aAllowRemote(env = process.env) {
  return String(env.OPENAGI_A2A_ALLOW_REMOTE ?? "").trim() === "1";
}

/**
 * Whether this request may be served given the bind policy. Enabling the
 * protocol does NOT imply exposing it off-box.
 */
export function a2aBindAllowed(remoteAddress, env = process.env) {
  if (a2aAllowRemote(env)) return true;
  const address = String(remoteAddress ?? "");
  return (
    address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address.startsWith("127.")
  );
}

const MAX_MESSAGE_CHARS = 16_000;

export class A2AServer {
  constructor({
    agentHost = null,
    env = process.env,
    now = () => Date.now(),
    log = null,
    skills = DEFAULT_ADVERTISED_SKILLS,
    maxTasks = 500
  } = {}) {
    this.agentHost = agentHost;
    this.env = env;
    this.log = typeof log === "function" ? log : () => {};
    this.skills = skills;
    this.tasks = new A2ATaskStore({ maxTasks, now });
    this.streams = new Map();
    this.counters = { received: 0, completed: 0, failed: 0, canceled: 0, rejected: 0 };
  }

  get enabled() {
    return a2aEnabled(this.env);
  }

  agentCard({ url = "" } = {}) {
    return buildAgentCard({
      name: String(this.env.OPENAGI_A2A_AGENT_NAME ?? "cerberus"),
      description: "An openAGI agent exposing A2A v1.0 over JSON-RPC.",
      url,
      skills: this.skills,
      streaming: true,
      authRequired: true
    });
  }

  /** Dispatch a parsed JSON-RPC body. Returns a JSON-RPC response object. */
  async handleRpc(body, { onEvent = null } = {}) {
    const parsed = parseJsonRpcRequest(body);
    if (!parsed.ok) return parsed.response;
    const { id, method, params } = parsed;

    switch (method) {
      case "message/send":
        return this.#messageSend(id, params, { onEvent: null });
      case "message/stream":
        return this.#messageSend(id, params, { onEvent });
      case "tasks/get":
        return this.#tasksGet(id, params);
      case "tasks/cancel":
        return this.#tasksCancel(id, params);
      default:
        return jsonRpcError(id, ERR_METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  }

  #readInbound(params) {
    const message = params?.message ?? params;
    const text = extractMessageText(message);
    if (!text) return { error: "message must carry non-empty text content" };
    if (text.length > MAX_MESSAGE_CHARS) {
      return { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` };
    }
    const contextId = String(message?.contextId ?? params?.contextId ?? "").trim() || randomUUID();
    return { text, contextId };
  }

  async #messageSend(id, params, { onEvent }) {
    const inbound = this.#readInbound(params);
    if (inbound.error) return jsonRpcError(id, ERR_INVALID_PARAMS, inbound.error);

    const taskId = randomUUID();
    const task = createTask({ taskId, contextId: inbound.contextId, text: inbound.text, createdAt: nowIso() });
    task.history.push(buildMessage(ROLE_USER, inbound.text, { contextId: inbound.contextId, taskId }));
    this.tasks.create(task);
    this.counters.received += 1;

    const working = this.tasks.transition(taskId, TASK_STATE_WORKING);
    if (working.ok) onEvent?.({ statusUpdate: A2ATaskStore.toWire(working.task) });

    let replyText = "";
    let failure = null;
    try {
      replyText = await this.#runTurn(inbound.text, inbound.contextId);
    } catch (error) {
      failure = error?.message ?? String(error);
    }

    if (failure) {
      this.counters.failed += 1;
      const failed = this.tasks.transition(taskId, TASK_STATE_FAILED, { error: failure });
      const wire = A2ATaskStore.toWire(failed.ok ? failed.task : this.tasks.get(taskId));
      onEvent?.({ statusUpdate: wire });
      return jsonRpcResult(id, { task: wire });
    }

    // A cancel may have landed while the turn was running. Terminal states have
    // no outgoing transitions, so the store rejects the completion and the
    // cancel stands -- the peer is never told a canceled task completed.
    const current = this.tasks.get(taskId);
    if (current && isTerminalState(current.state)) {
      const wire = A2ATaskStore.toWire(current);
      onEvent?.({ statusUpdate: wire });
      return jsonRpcResult(id, { task: wire });
    }

    const done = this.tasks.transition(taskId, TASK_STATE_COMPLETED, { result: replyText });
    if (done.ok) {
      this.counters.completed += 1;
      done.task.history.push(buildMessage(ROLE_AGENT, replyText, { contextId: inbound.contextId, taskId }));
    }
    const wire = A2ATaskStore.toWire(done.ok ? done.task : this.tasks.get(taskId));
    onEvent?.({ statusUpdate: wire });
    return jsonRpcResult(id, { task: wire });
  }

  /**
   * Run the inbound text as a real agent turn under a restricted policy.
   *
   * `channel: "subagent"` plus `scrutinyPolicyCeiling: "read-only"` routes the
   * turn through the existing delegation rails: stricterToolPolicy() takes the
   * stricter of the local verdict and this ceiling, so the turn can become MORE
   * cautious but can never escalate to full tool access, regardless of the
   * operator's auto-approve setting.
   */
  async #runTurn(text, contextId) {
    if (!this.agentHost?.handleMessage) {
      throw new Error("no agent host is bound to the A2A server");
    }
    const result = await this.agentHost.handleMessage({
      text,
      channel: "subagent",
      from: "a2a-peer",
      sessionId: `a2a:${contextId}`,
      origin: "a2a",
      routeTo: false,
      backgroundReview: false,
      scrutinyPolicyCeiling: "read-only",
      metadata: { authorBot: true, a2a: true }
    });
    return String(result?.reply ?? "");
  }

  #tasksGet(id, params) {
    const taskId = String(params?.id ?? params?.taskId ?? "").trim();
    if (!taskId) return jsonRpcError(id, ERR_INVALID_PARAMS, "params.id is required");
    const task = this.tasks.get(taskId);
    if (!task) return jsonRpcError(id, ERR_TASK_NOT_FOUND, `Task ${taskId} not found`);
    return jsonRpcResult(id, { task: A2ATaskStore.toWire(task) });
  }

  #tasksCancel(id, params) {
    const taskId = String(params?.id ?? params?.taskId ?? "").trim();
    if (!taskId) return jsonRpcError(id, ERR_INVALID_PARAMS, "params.id is required");
    const existing = this.tasks.get(taskId);
    if (!existing) return jsonRpcError(id, ERR_TASK_NOT_FOUND, `Task ${taskId} not found`);
    // A terminal task is not cancelable -- that is the exact semantic of the
    // A2A-reserved -32002, and using it for anything else breaks peers.
    if (isTerminalState(existing.state)) {
      return jsonRpcError(id, ERR_TASK_NOT_CANCELABLE, `Task ${taskId} is already ${existing.state}`);
    }
    const canceled = this.tasks.transition(taskId, TASK_STATE_CANCELED);
    if (!canceled.ok) return jsonRpcError(id, canceled.code, canceled.message);
    this.counters.canceled += 1;
    return jsonRpcResult(id, { task: A2ATaskStore.toWire(canceled.task) });
  }

  stats() {
    return { enabled: this.enabled, tasks: this.tasks.size, ...this.counters };
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  A2ATaskStore,
  TASK_STATES,
  TASK_STATE_SUBMITTED,
  TASK_STATE_WORKING,
  TASK_STATE_INPUT_REQUIRED,
  TASK_STATE_AUTH_REQUIRED,
  TASK_STATE_COMPLETED,
  TASK_STATE_FAILED,
  TASK_STATE_CANCELED,
  TASK_STATE_REJECTED,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_TASK_NOT_FOUND,
  ERR_TASK_NOT_CANCELABLE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_INTERNAL,
  buildAgentCard,
  canTransition,
  createTask,
  extractMessageText,
  isTerminalState,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcRequest,
  DEFAULT_ADVERTISED_SKILLS
} from "../src/a2a-protocol.js";

test("the eight A2A v1.0 task states are present and verbatim", () => {
  assert.deepEqual(TASK_STATES, [
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_INPUT_REQUIRED",
    "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED"
  ]);
});

test("terminal states accept no outgoing transitions", () => {
  for (const terminal of [TASK_STATE_COMPLETED, TASK_STATE_FAILED, TASK_STATE_CANCELED, TASK_STATE_REJECTED]) {
    assert.equal(isTerminalState(terminal), true, `${terminal} must be terminal`);
    for (const target of TASK_STATES) {
      assert.equal(
        canTransition(terminal, target),
        false,
        `${terminal} -> ${target} must be illegal`
      );
    }
  }
});

test("legal transitions are allowed", () => {
  assert.equal(canTransition(TASK_STATE_SUBMITTED, TASK_STATE_WORKING), true);
  assert.equal(canTransition(TASK_STATE_SUBMITTED, TASK_STATE_REJECTED), true);
  assert.equal(canTransition(TASK_STATE_WORKING, TASK_STATE_COMPLETED), true);
  assert.equal(canTransition(TASK_STATE_WORKING, TASK_STATE_INPUT_REQUIRED), true);
  assert.equal(canTransition(TASK_STATE_INPUT_REQUIRED, TASK_STATE_WORKING), true);
  assert.equal(canTransition(TASK_STATE_AUTH_REQUIRED, TASK_STATE_WORKING), true);
});

test("illegal transitions are rejected, including self and unknown states", () => {
  assert.equal(canTransition(TASK_STATE_WORKING, TASK_STATE_SUBMITTED), false, "no going back to submitted");
  assert.equal(canTransition(TASK_STATE_WORKING, TASK_STATE_WORKING), false, "self-transition is illegal");
  assert.equal(canTransition("TASK_STATE_BOGUS", TASK_STATE_WORKING), false);
  assert.equal(canTransition(TASK_STATE_WORKING, "nonsense"), false);
  assert.equal(canTransition(null, undefined), false);
});

test("spec error codes carry their exact reserved values", () => {
  assert.equal(ERR_TASK_NOT_FOUND, -32001);
  assert.equal(ERR_TASK_NOT_CANCELABLE, -32002);
  assert.equal(ERR_PUSH_NOT_SUPPORTED, -32003);
  assert.equal(ERR_PARSE, -32700);
  assert.equal(ERR_INVALID_REQUEST, -32600);
  assert.equal(ERR_METHOD_NOT_FOUND, -32601);
  assert.equal(ERR_INVALID_PARAMS, -32602);
  assert.equal(ERR_INTERNAL, -32603);
});

test("JSON-RPC framing matches the 2.0 envelope", () => {
  assert.deepEqual(jsonRpcResult("abc", { ok: true }), { jsonrpc: "2.0", id: "abc", result: { ok: true } });
  assert.deepEqual(jsonRpcError(7, -32001, "nope"), { jsonrpc: "2.0", id: 7, error: { code: -32001, message: "nope" } });
  assert.equal(jsonRpcResult(undefined, {}).id, null, "a missing id serializes as null");
});

test("request validation rejects malformed envelopes with the right codes", () => {
  assert.equal(parseJsonRpcRequest(null).response.error.code, ERR_INVALID_REQUEST);
  assert.equal(parseJsonRpcRequest([]).response.error.code, ERR_INVALID_REQUEST);
  assert.equal(parseJsonRpcRequest({ method: "x" }).response.error.code, ERR_INVALID_REQUEST, "jsonrpc field required");
  assert.equal(parseJsonRpcRequest({ jsonrpc: "1.0", method: "x" }).response.error.code, ERR_INVALID_REQUEST);
  assert.equal(parseJsonRpcRequest({ jsonrpc: "2.0" }).response.error.code, ERR_INVALID_REQUEST, "method required");
  assert.equal(parseJsonRpcRequest({ jsonrpc: "2.0", method: "x", params: [] }).response.error.code, ERR_INVALID_PARAMS);

  const ok = parseJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, "tasks/get");
  assert.deepEqual(ok.params, { id: "t" });
});

test("extractMessageText handles v1.0 parts plus v0.3 and pre-0.3 shapes", () => {
  assert.equal(extractMessageText({ parts: [{ text: "hello" }, { text: "world" }] }), "hello\nworld");
  assert.equal(extractMessageText({ text: "direct" }), "direct");
  assert.match(extractMessageText({ parts: [{ file: { filename: "a.pdf", url: "http://x/a.pdf" } }] }), /a\.pdf/);
  assert.match(extractMessageText({ parts: [{ data: { k: 1 } }] }), /"k":1/);
  assert.equal(extractMessageText({ parts: [] }), "");
  assert.equal(extractMessageText(null), "");
});

test("the agent card advertises JSONRPC v1.0 and bearer security", () => {
  const card = buildAgentCard({ name: "cerberus", url: "http://127.0.0.1:43210/a2a" });
  assert.equal(card.protocolVersion, "1.0");
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false, "push notifications are not implemented");
  assert.deepEqual(card.security, [{ bearer: [] }]);
  assert.equal(card.securitySchemes.bearer.scheme, "bearer");
});

test("the curated skill allowlist never advertises dangerous tools", () => {
  const card = buildAgentCard({ url: "http://x/a2a", skills: DEFAULT_ADVERTISED_SKILLS });
  const blob = JSON.stringify(card).toLowerCase();
  for (const forbidden of ["code_shell", "terminal", "write_file", "patch", "computer_use", "delegate_task"]) {
    assert.ok(!blob.includes(forbidden), `card must not advertise ${forbidden}`);
  }
  assert.ok(card.skills.length > 0, "the card still advertises something usable");
});

// --- task store ----------------------------------------------------------

function seed(store, id = "t1") {
  return store.create(createTask({ taskId: id, contextId: "c1", text: "do a thing" }));
}

test("the task store enforces the transition table", () => {
  const store = new A2ATaskStore();
  seed(store);
  assert.equal(store.get("t1").state, TASK_STATE_SUBMITTED);

  assert.equal(store.transition("t1", TASK_STATE_WORKING).ok, true);
  const illegal = store.transition("t1", TASK_STATE_SUBMITTED);
  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, ERR_INVALID_PARAMS);

  assert.equal(store.transition("t1", TASK_STATE_COMPLETED, { result: "done" }).ok, true);
  assert.equal(store.get("t1").result, "done");
});

test("cancelling a terminal task returns the reserved -32002", () => {
  const store = new A2ATaskStore();
  seed(store);
  store.transition("t1", TASK_STATE_WORKING);
  store.transition("t1", TASK_STATE_COMPLETED);
  const result = store.transition("t1", TASK_STATE_CANCELED);
  assert.equal(result.ok, false);
  assert.equal(result.code, ERR_TASK_NOT_CANCELABLE, "must use the A2A-reserved code, not a generic one");
});

test("an unknown task id returns the reserved -32001", () => {
  const store = new A2ATaskStore();
  const result = store.transition("missing", TASK_STATE_WORKING);
  assert.equal(result.ok, false);
  assert.equal(result.code, ERR_TASK_NOT_FOUND);
  assert.equal(store.get("missing"), null);
});

test("the store is bounded by count and prunes terminal tasks on TTL", () => {
  let clock = 1_000_000;
  const store = new A2ATaskStore({ maxTasks: 10, terminalTtlMs: 5_000, now: () => clock });
  for (let i = 0; i < 25; i += 1) {
    store.create(createTask({ taskId: `t${i}`, contextId: "c", text: "x" }));
  }
  assert.ok(store.size <= 10, `store grew to ${store.size}`);

  store.transition("t24", TASK_STATE_WORKING);
  store.transition("t24", TASK_STATE_COMPLETED);
  assert.ok(store.get("t24"), "a terminal task stays queryable inside its TTL");
  clock += 10_000;
  store.prune();
  assert.equal(store.get("t24"), null, "a terminal task is pruned past its TTL");
});

test("the wire shape exposes status and artifacts but no internal bookkeeping", () => {
  const store = new A2ATaskStore();
  seed(store);
  store.transition("t1", TASK_STATE_WORKING);
  store.transition("t1", TASK_STATE_COMPLETED, { result: "the answer" });
  const wire = A2ATaskStore.toWire(store.get("t1"));

  assert.equal(wire.id, "t1");
  assert.equal(wire.contextId, "c1");
  assert.equal(wire.status.state, TASK_STATE_COMPLETED);
  assert.equal(wire.artifacts[0].parts[0].text, "the answer");
  assert.equal(wire.updatedAtMs, undefined, "internal clock bookkeeping must not leak");
  assert.equal(wire.request, undefined, "the raw request is not echoed back in the wire task");
  assert.ok(wire.createdAt && wire.lastModified);
});

test("a failed task carries its error in status.message", () => {
  const store = new A2ATaskStore();
  seed(store);
  store.transition("t1", TASK_STATE_WORKING);
  store.transition("t1", TASK_STATE_FAILED, { error: "provider exploded" });
  const wire = A2ATaskStore.toWire(store.get("t1"));
  assert.equal(wire.status.state, TASK_STATE_FAILED);
  assert.match(wire.status.message.parts[0].text, /provider exploded/);
});

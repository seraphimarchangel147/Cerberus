// Human approval is a pause in the same tool invocation, not a detached
// dashboard chore. These tests prove the decision rail resumes exactly once
// and returns a result the model can reason about.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnthropicProvider } from "../src/model-provider.js";
import { PendingActionStore, approvePendingAction } from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-approval-suspend-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new PendingActionStore({ dir });
}

function setAutoApprove(t, value) {
  const previous = process.env.OPENAGI_AUTO_APPROVE;
  process.env.OPENAGI_AUTO_APPROVE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previous;
  });
}

function registerGatedTool(store, handler) {
  const tools = new ToolRegistry();
  tools.bindPendingActions(store);
  tools.register({
    name: "send_thing",
    needsConfirmation: true,
    summarize: ({ value }) => `Send ${value}`,
    handler
  });
  return tools;
}

test("PendingActionStore decisions are awaitable but runtime promises never serialize", async (t) => {
  const store = makeStore(t);
  const action = store.enqueue({ toolName: "send_thing", args: { value: 1 } });
  const waiting = store.waitForDecision(action.id, { timeoutMs: 1000 });

  assert.equal(store.hasDecisionWaiter(action.id), true);
  assert.equal(JSON.stringify(action).includes("_decision"), false);
  store.decide(action.id, { decision: "approve", decidedBy: "creator" });

  assert.deepEqual(await waiting, {
    decision: "approve",
    decidedBy: "creator",
    approvedVia: null,
    decider: null,
    completed: false,
    result: null,
    error: null
  });
  assert.equal(store.hasDecisionWaiter(action.id), false);
});

test("waitForDecision reports deny and supports a deterministic timeout", async (t) => {
  const store = makeStore(t);
  const denied = store.enqueue({ toolName: "send_thing" });
  const denial = store.waitForDecision(denied.id, { timeoutMs: 1000 });
  store.decide(denied.id, { decision: "deny", decidedBy: "creator", error: "not now" });
  assert.equal((await denial).decision, "deny");

  const timed = store.enqueue({ toolName: "send_thing" });
  let fire;
  const timeout = store.waitForDecision(timed.id, {
    timeoutMs: 123,
    setTimeoutFn(callback) {
      fire = callback;
      return { unref() {} };
    },
    clearTimeoutFn() {}
  });
  fire();
  assert.deepEqual(await timeout, { decision: "timeout" });
});

test("a gated invoke stays pending, then approval resumes with the real result", async (t) => {
  setAutoApprove(t, "0");
  const store = makeStore(t);
  let calls = 0;
  const tools = registerGatedTool(store, async ({ value }) => {
    calls += 1;
    return { sent: value };
  });
  const events = [];
  let settled = false;
  const invocation = tools.invoke("send_thing", { value: 7 }, {
    sessionId: "session-1",
    __onToolEvent: (event) => events.push(event)
  }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));

  const action = store.list({ status: "pending" })[0];
  assert.ok(action);
  assert.equal(settled, false);
  assert.equal(calls, 0);
  assert.equal(events.some((event) => event.phase === "awaiting-approval"), true);

  const approval = approvePendingAction({ pendingActions: store, tools }, action.id, {
    decidedBy: "creator",
    approvedVia: "test"
  });
  const result = await invocation;
  const approverResult = await approval;

  assert.equal(result.ok, true);
  assert.equal(result.result.sent, 7);
  assert.match(result.result.approvalNote, /approved by the user/i);
  assert.deepEqual(approverResult, result);
  assert.equal(calls, 1);
  assert.equal(store.get(action.id).status, "approved");
  assert.equal(store.get(action.id).completedAt !== null, true);
});

test("denial returns a model-visible error without executing the tool", async (t) => {
  setAutoApprove(t, "0");
  const store = makeStore(t);
  let calls = 0;
  const tools = registerGatedTool(store, async () => { calls += 1; return { sent: true }; });
  const invocation = tools.invoke("send_thing", { value: 2 }, {});
  await new Promise((resolve) => setImmediate(resolve));
  const action = store.list({ status: "pending" })[0];

  store.decide(action.id, { decision: "deny", decidedBy: "creator", error: "unsafe today" });
  const result = await invocation;
  assert.equal(result.ok, false);
  assert.match(result.error, /denied by creator: unsafe today/i);
  assert.equal(calls, 0);
});

test("approval timeout denies the action and returns a bounded error", async (t) => {
  setAutoApprove(t, "0");
  const previous = process.env.OPENAGI_APPROVAL_TIMEOUT_MS;
  process.env.OPENAGI_APPROVAL_TIMEOUT_MS = "5";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_APPROVAL_TIMEOUT_MS;
    else process.env.OPENAGI_APPROVAL_TIMEOUT_MS = previous;
  });
  const store = makeStore(t);
  const tools = registerGatedTool(store, async () => ({ sent: true }));

  const result = await tools.invoke("send_thing", {}, {});
  const action = store.list()[0];
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out awaiting approval/i);
  assert.equal(action.status, "denied");
  assert.equal(action.decidedBy, "timeout");
});

test("double approval is a no-op and cannot execute twice", async (t) => {
  setAutoApprove(t, "0");
  const store = makeStore(t);
  let calls = 0;
  const tools = registerGatedTool(store, async () => { calls += 1; return { sent: true }; });
  const invocation = tools.invoke("send_thing", {}, {});
  await new Promise((resolve) => setImmediate(resolve));
  const action = store.list({ status: "pending" })[0];

  const first = approvePendingAction({ pendingActions: store, tools }, action.id, { decidedBy: "first" });
  const second = await approvePendingAction({ pendingActions: store, tools }, action.id, { decidedBy: "second" });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  await first;
  await invocation;
  assert.equal(calls, 1);
  assert.equal(store.get(action.id).decidedBy, "first");
});

test("auto-approve remains immediate and byte-compatible", async (t) => {
  setAutoApprove(t, "1");
  const store = makeStore(t);
  let calls = 0;
  const tools = registerGatedTool(store, async () => { calls += 1; return { sent: true }; });

  const result = await tools.invoke("send_thing", {}, {});
  assert.deepEqual(result, { ok: true, result: { sent: true } });
  assert.equal(calls, 1);
  assert.equal(store.list()[0].decidedBy, "auto-approve");
});

test("Anthropic stall detection stays inactive during the human approval wait", async (t) => {
  setAutoApprove(t, "0");
  const store = makeStore(t);
  const tools = registerGatedTool(store, async () => ({ sent: true }));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    const body = requests === 1
      ? {
          id: "tool-turn",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "use-1", name: "send_thing", input: { value: 9 } }],
          usage: {}
        }
      : {
          id: "final-turn",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Approval completed." }],
          usage: {}
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "test-model",
    stallTimeoutMs: 5,
    maxIterations: 3
  });
  const turn = provider.generate({
    input: "send it",
    instructions: "test",
    toolRegistry: tools
  });

  let action;
  for (let i = 0; i < 50 && !action; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    action = store.list({ status: "pending" })[0];
  }
  assert.ok(action);
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.decide(action.id, { decision: "approve", decidedBy: "creator" });

  const result = await turn;
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "Approval completed.");
  assert.equal(requests, 2);
});

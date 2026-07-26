import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PendingActionStore } from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

function assertReceipt(receipt, {
  tool,
  status,
  code,
  dispatched,
  changed
}) {
  assert.match(receipt.id, /^(?:operation|receipt)_/);
  assert.equal(receipt.tool, tool);
  assert.equal(receipt.status, status);
  assert.equal(receipt.code, code);
  assert.equal(receipt.dispatched, dispatched);
  assert.equal(receipt.changed, changed);
  assert.ok(Number.isFinite(Date.parse(receipt.startedAt)));
  assert.ok(Number.isFinite(Date.parse(receipt.finishedAt)));
  assert.ok(Number.isInteger(receipt.durationMs));
  assert.ok(receipt.durationMs >= 0);
  assert.equal(receipt.decision.version, 1);
  assert.equal(typeof receipt.decision.path, "string");
  assert.ok(Number.isInteger(receipt.decision.gateCount));
  assert.ok(receipt.decision.gateCount <= 48);
  assert.equal(
    receipt.decision.path.split(">").filter(Boolean).length,
    receipt.decision.gateCount
  );
  assert.match(receipt.decision.slowestGate, /^[a-z][a-z0-9_]{0,39}$/);
  assert.ok(Number.isInteger(receipt.decision.slowestMs));
  assert.ok(receipt.decision.slowestMs >= 0);
  assert.equal(typeof receipt.decision.truncated, "boolean");
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.decision), true);
  for (const stage of receipt.decision.path.split(">")) {
    assert.match(
      stage,
      /^[a-z][a-z0-9_]{0,39}:[a-z][a-z0-9_]{0,23}$/
    );
  }
}

function decisionPath(receipt) {
  return receipt.decision.path.split(">").filter(Boolean);
}

test("terminal tool envelopes carry bounded canonical execution receipts", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "receipt_read",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { secret: { type: "string" } },
      required: ["secret"],
      additionalProperties: false
    },
    handler: async () => ({ value: "visible" })
  });
  registry.register({
    name: "receipt_write",
    sideEffects: true,
    handler: async () => {
      throw new Error("write failed");
    }
  });

  const read = await registry.invoke(
    "receipt_read",
    { secret: "must-not-appear-in-receipt" },
    { sessionId: "receipt-session", __turnId: "receipt-turn" }
  );
  assertReceipt(read.receipt, {
    tool: "receipt_read",
    status: "succeeded",
    code: "ok",
    dispatched: true,
    changed: false
  });
  assert.doesNotMatch(JSON.stringify(read.receipt), /must-not-appear/);
  assert.equal(read.receipt.decision.blockedAt, null);
  assert.deepEqual(decisionPath(read.receipt).slice(0, 2), [
    "input_snapshot:passed",
    "input_contract:passed"
  ]);
  assert.ok(decisionPath(read.receipt).includes("dispatch:dispatched"));
  assert.ok(decisionPath(read.receipt).includes("semantic_verification:passed"));
  assert.equal(decisionPath(read.receipt).at(-1), "outcome:succeeded");

  const failed = await registry.invoke("receipt_write", {}, {});
  assertReceipt(failed.receipt, {
    tool: "receipt_write",
    status: "failed",
    code: "handler_error",
    dispatched: true,
    changed: null
  });
  assert.equal(failed.receipt.decision.blockedAt, "handler");
  assert.ok(decisionPath(failed.receipt).includes("handler:failed"));
  assert.equal(decisionPath(failed.receipt).at(-1), "outcome:failed");

  const invalid = await registry.invoke("receipt_read", {}, {});
  assertReceipt(invalid.receipt, {
    tool: "receipt_read",
    status: "failed",
    code: "invalid_tool_arguments",
    dispatched: false,
    changed: null
  });
  assert.equal(invalid.receipt.decision.blockedAt, "input_contract");
  assert.deepEqual(decisionPath(invalid.receipt), [
    "input_snapshot:passed",
    "input_contract:failed",
    "outcome:failed"
  ]);
});

test("pre-dispatch veto receipts cannot claim that work ran", async () => {
  const hooks = {
    beforeToolCall: async () => ({
      action: "block",
      message: "blocked by test",
      blockedBy: "test-policy"
    })
  };
  const registry = new ToolRegistry({ hooks });
  registry.register({
    name: "receipt_blocked",
    sideEffects: true,
    handler: async () => ({ changed: true })
  });

  const blocked = await registry.invoke("receipt_blocked", {}, {});
  assertReceipt(blocked.receipt, {
    tool: "receipt_blocked",
    status: "blocked",
    code: "hook_blocked",
    dispatched: false,
    changed: null
  });
  assert.equal(blocked.receipt.decision.blockedAt, "pre_hook");
  assert.ok(decisionPath(blocked.receipt).includes("pre_hook:blocked"));
  assert.doesNotMatch(JSON.stringify(blocked.receipt), /blocked by test|test-policy/);
});

test("output-contract failures identify the decisive post-dispatch gate", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "receipt_bad_output",
    sideEffects: false,
    outputSchema: {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false
    },
    handler: async () => ({ count: "not-an-integer" })
  });

  const result = await registry.invoke("receipt_bad_output", {}, {});
  assert.equal(result.ok, false);
  assertReceipt(result.receipt, {
    tool: "receipt_bad_output",
    status: "failed",
    code: "invalid_tool_result",
    dispatched: true,
    changed: false
  });
  assert.equal(result.receipt.decision.blockedAt, "output_contract");
  assert.ok(decisionPath(result.receipt).includes("output_contract:failed"));
});

test("pre-dispatch receipts explain rejection without crossing observer isolation", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "receipt_validated",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { secret: { type: "string" } },
      required: ["secret"],
      additionalProperties: false
    },
    handler: async () => ({ ok: true })
  });
  const events = [];
  const result = await registry.invoke(
    "receipt_validated",
    {},
    { __onToolEvent: (event) => events.push(event) }
  );

  assert.equal(result.ok, false);
  assert.deepEqual(events, []);
  assert.equal(result.receipt.decision.blockedAt, "input_contract");
  assert.equal(JSON.stringify(result.receipt).includes("secret"), false);
});

test("tool forwarding preserves one bounded real-target decision trace", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "receipt_target",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    handler: async ({ value }) => ({ value })
  });
  registry.register({
    name: "receipt_bridge",
    sideEffects: false,
    forwardInvocation: ({ value }) => ({
      name: "receipt_target",
      args: { value }
    }),
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    },
    handler: async () => {
      throw new Error("bridge handlers must not dispatch");
    }
  });

  const result = await registry.invoke(
    "receipt_bridge",
    { value: "private-forwarded-value" },
    {}
  );
  assert.equal(result.ok, true);
  assert.equal(result.receipt.tool, "receipt_target");
  assert.ok(decisionPath(result.receipt).includes("forwarding:passed"));
  assert.equal(
    decisionPath(result.receipt).filter((stage) => stage === "dispatch:dispatched").length,
    1
  );
  assert.doesNotMatch(JSON.stringify(result.receipt), /private-forwarded-value/);
});

test("explicit approval resumes one explainable receipt in either policy lane", async () => {
  const registry = new ToolRegistry();
  const completed = [];
  registry.bindPendingActions({
    enqueue(value) {
      return { id: "approval_decision_1", ...value };
    },
    async waitForDecision() {
      return {
        decision: "approve",
        decider: "human-test",
        approvedVia: "test"
      };
    },
    complete(id, value) {
      completed.push({ id, value });
    }
  });
  registry.register({
    name: "receipt_manual",
    sideEffects: true,
    needsConfirmation: true,
    manualApproval: true,
    handler: async () => ({ changed: true })
  });

  const result = await registry.invoke("receipt_manual", {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.receipt.decision.truncated, false);
  assert.equal(result.receipt.decision.blockedAt, null);
  assert.ok(decisionPath(result.receipt).includes("approval:pending"));
  assert.ok(decisionPath(result.receipt).includes("approval:approved"));
  assert.ok(decisionPath(result.receipt).includes("dispatch:dispatched"));
  assert.equal(decisionPath(result.receipt).at(-1), "outcome:succeeded");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].value.receipt.id, result.receipt.id);
});

test("approval completion persists its canonical execution receipt", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-receipt-pending-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PendingActionStore({ dir });
  const action = store.enqueue({
    toolName: "receipt_write",
    args: {},
    context: null,
    summary: "write once"
  });
  store.decide(action.id, {
    decision: "approve",
    decidedBy: "receipt-test"
  });
  const receipt = {
    id: "operation_0123456789abcdef_0123456789abcdef01234567",
    tool: "receipt_write",
    status: "succeeded",
    code: "ok",
    dispatched: true,
    changed: true,
    startedAt: "2026-07-25T00:00:00.000Z",
    finishedAt: "2026-07-25T00:00:00.100Z",
    durationMs: 100
  };
  store.complete(action.id, {
    result: { saved: true },
    outcome: {
      status: "succeeded",
      code: "ok",
      changed: true
    },
    receipt
  });

  const recovered = new PendingActionStore({ dir });
  assert.deepEqual(recovered.get(action.id).receipt, receipt);
});

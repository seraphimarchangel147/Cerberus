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

  const failed = await registry.invoke("receipt_write", {}, {});
  assertReceipt(failed.receipt, {
    tool: "receipt_write",
    status: "failed",
    code: "handler_error",
    dispatched: true,
    changed: null
  });

  const invalid = await registry.invoke("receipt_read", {}, {});
  assertReceipt(invalid.receipt, {
    tool: "receipt_read",
    status: "failed",
    code: "invalid_tool_arguments",
    dispatched: false,
    changed: null
  });
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

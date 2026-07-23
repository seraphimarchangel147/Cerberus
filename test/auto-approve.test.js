// Auto-approve mode: when OPENAGI_AUTO_APPROVE is on (the default), gated
// tools (needsConfirmation / scrutiny-confirm) run immediately instead of
// parking in the approval queue — but the action is still enqueued and
// resolved with decidedBy:"auto-approve" so the audit trail survives.
// The full suite pins OPENAGI_AUTO_APPROVE=0 (package.json test script) to
// keep legacy queue-semantics tests valid; this file flips the env per-test.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, autoApproveEnabled } from "../src/tool-registry.js";

function makeGatedRegistry() {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "send_thing",
    needsConfirmation: true,
    handler: async () => { calls.push("send_thing"); return { sent: true }; }
  });
  const store = { enqueued: [], decided: [] };
  registry.bindPendingActions({
    enqueue: (a) => { const rec = { id: "act_test", summary: a.summary }; store.enqueued.push(a); return rec; },
    decide: (id, d) => { store.decided.push({ id, ...d }); }
  });
  return { registry, calls, store };
}

test("autoApproveEnabled: default on, explicit 0/false/off disables", () => {
  const saved = process.env.OPENAGI_AUTO_APPROVE;
  try {
    delete process.env.OPENAGI_AUTO_APPROVE;
    assert.equal(autoApproveEnabled(), true, "unset means enabled");
    for (const off of ["0", "false", "off", " OFF "]) {
      process.env.OPENAGI_AUTO_APPROVE = off;
      assert.equal(autoApproveEnabled(), false, `'${off}' disables`);
    }
    process.env.OPENAGI_AUTO_APPROVE = "1";
    assert.equal(autoApproveEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = saved;
  }
});

test("auto-approve on: gated tool runs immediately and audit record is decided", async () => {
  const saved = process.env.OPENAGI_AUTO_APPROVE;
  try {
    process.env.OPENAGI_AUTO_APPROVE = "1";
    const { registry, calls, store } = makeGatedRegistry();
    const res = await registry.invoke("send_thing", { x: 1 }, {});
    assert.equal(res.ok, true);
    assert.deepEqual(res.result, { sent: true }, "handler result returned directly, no awaiting_confirmation");
    assert.deepEqual(calls, ["send_thing"], "handler actually ran");
    assert.equal(store.enqueued.length, 1, "audit record enqueued");
    assert.equal(store.decided.length, 1, "audit record resolved");
    assert.equal(store.decided[0].decidedBy, "auto-approve");
    assert.equal(store.decided[0].decision, "approve");
  } finally {
    if (saved === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = saved;
  }
});

test("auto-approve off: gated tool still queues as awaiting_confirmation", async () => {
  const saved = process.env.OPENAGI_AUTO_APPROVE;
  try {
    process.env.OPENAGI_AUTO_APPROVE = "0";
    const { registry, calls } = makeGatedRegistry();
    const res = await registry.invoke("send_thing", {}, {});
    assert.equal(res.ok, true);
    assert.equal(res.result.status, "awaiting_confirmation");
    assert.deepEqual(calls, [], "handler did not run");
  } finally {
    if (saved === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = saved;
  }
});

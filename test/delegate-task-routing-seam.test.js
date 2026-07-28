// delegate_task -> agent-host routing seam.
//
// The router tests prove the MAP is right. These prove the map is actually
// REACHED: that delegate_task validates `kind`, threads a routing task into
// handleMessage, and reports the resolved model back. A correct router that
// nothing calls is the dominant bug class in this harness, so the assertion
// that matters is on what handleMessage actually received.

import assert from "node:assert/strict";
import test from "node:test";
import { registerDelegateTaskTool } from "../src/integrations/delegate-task.js";
import { delegateTaskForKind } from "../src/model-router.js";

function harness({ model = "kimi-for-coding" } = {}) {
  const calls = [];
  const tools = new Map();
  const runtime = {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      list: () => [{ name: "code_read" }, { name: "shell_exec" }]
    },
    agentHost: {
      handleMessage: async (input) => {
        calls.push(input);
        return {
          reply: "done",
          model: { model, iterations: 1, stopReason: "completed" }
        };
      }
    }
  };
  registerDelegateTaskTool(runtime);
  return { calls, tool: tools.get("delegate_task") };
}

test("delegate_task threads the routing task for each kind", async () => {
  for (const kind of ["reason", "code", "debug", "research", "extract"]) {
    const h = harness();
    const result = await h.tool.handler({ goal: "do the thing", kind }, {});
    assert.equal(result.error, undefined, `kind ${kind} errored: ${result.error}`);
    assert.equal(h.calls.length, 1);
    assert.equal(
      h.calls[0].routingTask,
      delegateTaskForKind(kind),
      `kind '${kind}' did not reach handleMessage as a routing task`
    );
  }
});

test("an omitted kind still routes explicitly, at base capability", async () => {
  const h = harness();
  await h.tool.handler({ goal: "unclassified work" }, {});
  // It must send the conservative `delegate` task rather than nothing at all —
  // "nothing" would silently fall back to the chat default and make the
  // delegation invisible in the audit trail.
  assert.equal(h.calls[0].routingTask, "delegate");
});

test("an unknown kind is refused instead of silently downgraded", async () => {
  const h = harness();
  const result = await h.tool.handler({ goal: "x", kind: "reserch" }, {});
  assert.match(String(result.error), /kind must be one of/);
  assert.equal(h.calls.length, 0, "a rejected delegation must not spawn a child");
});

test("batch tasks route per-task, not per-call", async () => {
  const h = harness();
  const result = await h.tool.handler({
    tasks: [
      { goal: "design the schema", kind: "reason" },
      { goal: "list the files", kind: "extract" }
    ]
  }, {});
  assert.equal(result.error, undefined);
  assert.equal(h.calls.length, 2);
  const routed = h.calls.map((call) => call.routingTask).sort();
  assert.deepEqual(routed, ["delegate_extract", "delegate_reason"]);
});

test("the result reports the model that actually served the child", async () => {
  // A sentinel id proves the value is PROPAGATED rather than coincidentally
  // matching whatever the router would have produced anyway.
  const h = harness({ model: "SENTINEL-MODEL-ID" });
  const result = await h.tool.handler({ goal: "find the value", kind: "extract" }, {});
  assert.ok(Array.isArray(result.results), "expected a results array");
  const entry = result.results[0];
  assert.equal(entry.kind, "extract");
  assert.equal(entry.routedTask, "delegate_extract");
  assert.equal(
    entry.model,
    "SENTINEL-MODEL-ID",
    "the resolved model must be reported or a silent base-model fallback is invisible"
  );
});

test("an invalid kind inside a batch names the offending index", async () => {
  const h = harness();
  const result = await h.tool.handler({
    tasks: [{ goal: "ok", kind: "reason" }, { goal: "bad", kind: "nope" }]
  }, {});
  assert.match(String(result.error), /tasks\[1\]\.kind/);
  assert.equal(h.calls.length, 0);
});

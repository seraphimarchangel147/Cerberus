// F3 from the 2026-07-29 QA battery: execute_code collapsed every inner tool
// failure into a bare error string. An advisory-shaped envelope (status:
// "blocked", code: "repeated_no_progress", nextSteps) was therefore
// indistinguishable from a hard crash, and unobservable from the model seat —
// Azazel could not confirm the advisory was spec-shaped without reading source.
// These tests pin BOTH halves of the crossing: the structured outcome must
// reach user code inside the script, and it must also survive to the wrapper's
// own result when the script swallows the rejection.
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerExecuteCodeTool
} from "../src/integrations/execute-code.js";
import { ToolRegistry } from "../src/tool-registry.js";

function harness() {
  const tools = new ToolRegistry();
  const runtime = { tools };
  registerExecuteCodeTool(runtime);
  return { runtime, tools };
}

// A handler-reported advisory failure. tool-outcome.js `reportedFailure` derives
// the semantic outcome from TOP-LEVEL status/code/retryable/nextSteps (a nested
// `outcome` object on a handler result is not what it reads), so this mirrors
// how a real advisory reaches the registry — same status/code pair the live
// repeatedNoProgressEnvelope carries.
function advisoryEnvelope() {
  return {
    ok: false,
    error: "No progress detected after 8 identical successful tool outputs.",
    status: "blocked",
    code: "repeated_no_progress",
    retryable: false,
    nextSteps: [
      "The output has not changed; try a different approach.",
      "If the operation needs time, wait differently before checking again."
    ]
  };
}

function registerAdvisoryTool(tools, name = "advisory_tool") {
  tools.register({
    name,
    sideEffects: false,
    description: "Returns an advisory-shaped blocked envelope.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    handler: async () => advisoryEnvelope()
  });
}

async function run(tools, code, context = {}) {
  const outcome = await tools.invoke("execute_code", { code }, {
    sessionId: "f3",
    ...context
  });
  return outcome;
}

test("an advisory-shaped inner failure keeps its status and code inside the script", async () => {
  const { tools } = harness();
  registerAdvisoryTool(tools);

  const outcome = await run(tools, `
    try {
      await callTool("advisory_tool", {});
      console.log("UNEXPECTED_SUCCESS");
    } catch (error) {
      console.log(JSON.stringify({
        status: error.status ?? null,
        code: error.code ?? null,
        retryable: error.retryable ?? null,
        steps: (error.nextSteps ?? []).length,
        message: error.message
      }));
    }
  `);

  assert.equal(outcome.ok, true, outcome.error);
  const seen = JSON.parse(outcome.result.stdout.trim());
  assert.equal(seen.status, "blocked", "advisory status must survive the boundary");
  assert.equal(seen.code, "repeated_no_progress");
  assert.equal(seen.retryable, false);
  assert.equal(seen.steps, 2, "nextSteps must cross so the script can act on them");
  assert.match(seen.message, /No progress detected/);
});

test("a swallowed inner failure is still reported on the wrapper result", async () => {
  const { tools } = harness();
  registerAdvisoryTool(tools);

  // The pre-fix hazard: a script that catches and continues left no trace at
  // all of why the inner call failed.
  const outcome = await run(tools, `
    try { await callTool("advisory_tool", {}); } catch { /* swallowed */ }
    console.log("done");
  `);

  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result.stdout.trim(), "done");
  assert.ok(
    Array.isArray(outcome.result.innerFailures),
    "a swallowed inner failure must still be reported to the caller"
  );
  assert.equal(outcome.result.innerFailures.length, 1);
  const failure = outcome.result.innerFailures[0];
  assert.equal(failure.tool, "advisory_tool");
  assert.equal(failure.status, "blocked");
  assert.equal(failure.code, "repeated_no_progress");
  assert.equal(failure.retryable, false);
  assert.deepEqual(failure.nextSteps.length, 2);
});

test("the happy path adds no innerFailures noise", async () => {
  const { tools } = harness();
  tools.register({
    name: "fine_tool",
    sideEffects: false,
    description: "Succeeds.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    handler: async () => ({ value: 7 })
  });

  const outcome = await run(tools, `
    const r = await callTool("fine_tool", {});
    console.log(r.value);
  `);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result.stdout.trim(), "7");
  assert.equal(
    outcome.result.innerFailures,
    undefined,
    "innerFailures must be absent when nothing failed"
  );
});

test("a plain (non-advisory) inner failure still crosses with its tool name", async () => {
  const { tools } = harness();
  tools.register({
    name: "plain_fail",
    sideEffects: false,
    description: "Fails without advisory shape.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    handler: async () => { throw new Error("boom"); }
  });

  const outcome = await run(tools, `
    try { await callTool("plain_fail", {}); } catch (e) {
      console.log(JSON.stringify({ tool: e.tool ?? null, msg: e.message }));
    }
  `);
  assert.equal(outcome.ok, true, outcome.error);
  const seen = JSON.parse(outcome.result.stdout.trim());
  assert.match(seen.msg, /boom/);
  assert.equal(outcome.result.innerFailures.length, 1);
  assert.equal(outcome.result.innerFailures[0].tool, "plain_fail");
  assert.equal(outcome.result.innerFailures[0].status, "failed");
});

test("inner failure reporting survives many failures without unbounded growth", async () => {
  const { tools } = harness();
  registerAdvisoryTool(tools);
  const outcome = await run(tools, `
    for (let i = 0; i < 5; i++) {
      try { await callTool("advisory_tool", {}); } catch { /* keep going */ }
    }
    console.log("looped");
  `);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result.innerFailures.length, 5);
  for (const failure of outcome.result.innerFailures) {
    assert.equal(failure.code, "repeated_no_progress");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tool-registry.js";

function register(registry, overrides = {}) {
  return registry.register({
    name: overrides.name ?? "fixture_tool",
    description: "Fixture tool.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" }
      },
      additionalProperties: false
    },
    sideEffects: overrides.sideEffects ?? true,
    capability: {
      idempotent: overrides.idempotent ?? false
    },
    handler: overrides.handler ?? (() => ({ value: "ok" })),
    ...(overrides.normalizeOutcome ? { normalizeOutcome: overrides.normalizeOutcome } : {}),
    ...(overrides.verifyOutcome ? { verifyOutcome: overrides.verifyOutcome } : {})
  });
}

test("registry outcomes normalize, verify, and keep callbacks private", async () => {
  const registry = new ToolRegistry();
  register(registry, {
    idempotent: true,
    handler: () => ({ artifactId: "report_9" }),
    normalizeOutcome: () => ({
      changed: true,
      code: "report_written"
    }),
    verifyOutcome: () => ({
      passed: true,
      summary: "Revision exists.",
      evidence: ["revision:9"]
    })
  });

  const result = await registry.invoke("fixture_tool", {}, {
    sessionId: "session-a",
    __turnId: "turn-a"
  });
  const listed = registry.list().find((tool) => tool.name === "fixture_tool");

  assert.equal(result.ok, true);
  assert.equal(result.result.artifactId, "report_9");
  assert.equal(result.outcome.code, "report_written");
  assert.equal(result.outcome.changed, true);
  assert.deepEqual(result.outcome.artifacts, ["artifact:report_9"]);
  assert.deepEqual(result.outcome.evidence, ["revision:9"]);
  assert.equal(result.outcome.verification.status, "passed");
  assert.equal("normalizeOutcome" in listed, false);
  assert.equal("verifyOutcome" in listed, false);
});

test("reported semantic failures cannot remain outer successes", async () => {
  const registry = new ToolRegistry();
  register(registry, {
    handler: () => ({
      ok: false,
      error: "remote mutation rejected",
      code: "remote_rejected",
      changed: false
    })
  });

  const result = await registry.invoke("fixture_tool", {}, {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "remote mutation rejected");
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.code, "remote_rejected");
  assert.equal(result.outcome.changed, false);
});

test("non-idempotent unchanged failures dispatch once then return repair guidance", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  register(registry, {
    idempotent: false,
    handler: () => {
      calls += 1;
      return {
        error: "write conflict",
        code: "write_conflict",
        retryable: true
      };
    }
  });
  const context = { sessionId: "session-a", __turnId: "turn-repeat" };

  const first = await registry.invoke("fixture_tool", { value: "same" }, context);
  const second = await registry.invoke("fixture_tool", { value: "same" }, context);

  assert.equal(calls, 1);
  assert.equal(first.outcome.retryable, false);
  assert.equal(second.ok, false);
  assert.equal(second.outcome.code, "repeated_failure");
  assert.match(second.outcome.nextSteps[0], /Change the arguments/u);
});

test("explicitly retryable idempotent failures allow one retry only", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  register(registry, {
    idempotent: true,
    handler: () => {
      calls += 1;
      return { error: "temporary outage" };
    },
    normalizeOutcome: () => ({
      status: "failed",
      code: "temporary_outage",
      retryable: true
    })
  });
  const context = { sessionId: "session-a", __turnId: "turn-retry" };

  const first = await registry.invoke("fixture_tool", { value: "same" }, context);
  const second = await registry.invoke("fixture_tool", { value: "same" }, context);
  const third = await registry.invoke("fixture_tool", { value: "same" }, context);

  assert.equal(first.outcome.retryable, true);
  assert.equal(second.outcome.retryable, true);
  assert.equal(third.outcome.code, "repeated_failure");
  assert.equal(calls, 2);
});

test("changed arguments and a later success repair the failure loop", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  register(registry, {
    idempotent: false,
    handler: ({ value }) => {
      calls += 1;
      return value === "good" ? { value } : { error: "bad input" };
    }
  });
  const context = { sessionId: "session-a", __turnId: "turn-repair" };

  await registry.invoke("fixture_tool", { value: "bad" }, context);
  const repaired = await registry.invoke("fixture_tool", { value: "good" }, context);
  const retriedOriginal = await registry.invoke("fixture_tool", { value: "bad" }, context);

  assert.equal(repaired.ok, true);
  assert.equal(retriedOriginal.outcome.code, "repeated_failure");
  assert.equal(calls, 2);
});

test("checkpoint receipts and bounded outcome facts reach lifecycle observers", async () => {
  const events = [];
  const registry = new ToolRegistry();
  registry.bindCheckpoints({
    beforeToolCall: async () => ({
      checkpoints: [{ id: "cp_receipt_1" }]
    })
  });
  register(registry, {
    handler: () => ({ changed: true, outputRef: "tool_output_1" })
  });

  const result = await registry.invoke("fixture_tool", {}, {
    sessionId: "session-a",
    __turnId: "turn-receipt",
    __onToolEvent: (event) => events.push(event)
  });

  assert.deepEqual(result.outcome.evidence, [
    "tool-output:tool_output_1",
    "checkpoint:cp_receipt_1"
  ]);
  assert.deepEqual(events.at(-1).outcome, {
    status: "succeeded",
    code: "ok",
    changed: true,
    artifacts: [],
    evidence: ["tool-output:tool_output_1", "checkpoint:cp_receipt_1"],
    verification: "not_requested"
  });
});

test("scope and unknown-tool failures receive stable semantic codes", async () => {
  const registry = new ToolRegistry();
  register(registry, { name: "bounded_tool", sideEffects: false });

  const scoped = await registry.invoke("bounded_tool", {}, {
    __allowedTools: ["another_tool"]
  });
  const unknown = await registry.invoke("missing_tool", {}, {});

  assert.equal(scoped.outcome.status, "blocked");
  assert.equal(scoped.outcome.code, "specialist_scope_blocked");
  assert.equal(unknown.outcome.status, "failed");
  assert.equal(unknown.outcome.code, "unknown_tool");
});

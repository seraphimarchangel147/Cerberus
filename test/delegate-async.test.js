// Async delegation: waves auto-chunking, verify hints, per-child metrics, and
// the delegate_status/_steer/_cancel control lane. Uses the lightweight mock
// runtime (same pattern as delegate-task.test.js's direct-handler tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerDelegateTaskTool } from "../src/integrations/delegate-task.js";
import { ToolRegistry } from "../src/tool-registry.js";

const SUBAGENT_ENV_KEYS = [
  "OPENAGI_MAX_CHILDREN",
  "OPENAGI_MAX_SPAWN_DEPTH",
  "OPENAGI_SUBAGENT_MAX_ITERATIONS",
  "OPENAGI_SUBAGENT_MAX_TURN_SECONDS"
];
const savedEnv = new Map(SUBAGENT_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of SUBAGENT_ENV_KEYS) delete process.env[key];
process.on("exit", () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeRuntime(handleMessage, options = {}) {
  const tools = new ToolRegistry();
  const runtime = {
    tools,
    dataDir: options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "delegate-async-")),
    agentHost: { handleMessage }
  };
  registerDelegateTaskTool(runtime);
  options.captureRuntime?.(runtime);
  return tools;
}

function okResult(text = "child summary") {
  return { reply: text, model: { iterations: 1, stopReason: "completed", model: "stub-model" } };
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

test("batches larger than maxChildren run in sequential waves instead of erroring", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const tools = makeRuntime(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return okResult();
  });
  const handler = tools.get("delegate_task").handler;
  const result = await handler({
    tasks: [1, 2, 3, 4, 5].map((n) => ({ goal: `task ${n}` }))
  });
  assert.equal(result.results.length, 5);
  assert.equal(result.waves, 2);
  assert.ok(result.results.every((child) => child.ok));
  assert.ok(maxInFlight <= 3, `concurrency ${maxInFlight} exceeded maxChildren 3`);
});

test("verify hint is injected into the child prompt and echoed in the result", async () => {
  const prompts = [];
  const tools = makeRuntime(async (input) => {
    prompts.push(input.text);
    return okResult();
  });
  const handler = tools.get("delegate_task").handler;
  const result = await handler({
    goal: "list the test files",
    verify: "summary must name exactly 3 files"
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /<verification>/);
  assert.match(prompts[0], /summary must name exactly 3 files/);
  assert.equal(result.results[0].verify, "summary must name exactly 3 files");
  assert.equal(typeof result.results[0].durationMs, "number");
});

test("async mode detaches, status tracks completion with summaries and metrics", async () => {
  const tools = makeRuntime(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return okResult("async child done");
  });
  const spawn = await tools.get("delegate_task").handler({
    async: true,
    tasks: [{ goal: "alpha" }, { goal: "beta", kind: "extract" }]
  });
  assert.ok(spawn.delegationId);
  assert.equal(spawn.status, "running");
  const statusHandler = tools.get("delegate_status").handler;
  const done = await waitFor(async () => {
    const snapshot = await statusHandler({ id: spawn.delegationId });
    return snapshot.status === "done" ? snapshot : null;
  });
  assert.equal(done.tasks.length, 2);
  assert.ok(done.tasks.every((task) => task.state === "completed"));
  assert.equal(done.tasks[0].summary, "async child done");
  assert.equal(typeof done.tasks[0].durationMs, "number");
  assert.equal(done.tasks[1].kind, "extract");
  assert.deepEqual(done.lifecycle, {
    childExecutionComplete: true,
    resultsRecorded: 2,
    totalChildren: 2,
    parentConsumed: false,
    consumedAt: null,
    consumedBySessionId: null,
    parentSynthesisDelivered: false,
    synthesisDeliveredAt: null,
    synthesisMessageId: null
  });

  const collected = await tools.get("delegate_collect").handler(
    { id: spawn.delegationId },
    { sessionId: "parent-a" }
  );
  assert.equal(collected.parentConsumed, true);
  assert.equal(collected.results.length, 2);
  const consumed = await statusHandler({ id: spawn.delegationId });
  assert.equal(consumed.lifecycle.parentConsumed, true);
  assert.equal(consumed.lifecycle.consumedBySessionId, "parent-a");
  assert.equal(consumed.lifecycle.parentSynthesisDelivered, false);
});

test("async records survive registry reload and remain project scoped", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-async-reload-"));
  const first = makeRuntime(async () => okResult("durable child result"), { dataDir });
  const spawn = await first.get("delegate_task").handler(
    { async: true, goal: "persist me" },
    { sessionId: "parent-persist", __projectId: "alpha" }
  );
  await waitFor(async () => {
    const snapshot = await first.get("delegate_status").handler(
      { id: spawn.delegationId },
      { __projectId: "alpha" }
    );
    return snapshot.status === "done" ? snapshot : null;
  });

  const second = makeRuntime(async () => okResult("unused"), { dataDir });
  const restored = await second.get("delegate_status").handler(
    { id: spawn.delegationId },
    { __projectId: "alpha" }
  );
  assert.equal(restored.tasks[0].summary, "durable child result");
  assert.equal(restored.parentSessionId, "parent-persist");
  assert.equal(restored.lifecycle.resultsRecorded, 1);
  const denied = await second.get("delegate_status").handler(
    { id: spawn.delegationId },
    { __projectId: "beta" }
  );
  assert.match(denied.error, /unknown delegation id|outside this project/);
});

test("collect is idempotent for one parent and fails closed across parents", async () => {
  const tools = makeRuntime(async () => okResult("collectable"));
  const spawn = await tools.get("delegate_task").handler(
    { async: true, goal: "collect me" },
    { sessionId: "owner", __projectId: "alpha" }
  );
  await waitFor(async () => {
    const snapshot = await tools.get("delegate_status").handler(
      { id: spawn.delegationId },
      { __projectId: "alpha" }
    );
    return snapshot.status === "done";
  });
  const collect = tools.get("delegate_collect").handler;
  const first = await collect(
    { id: spawn.delegationId },
    { sessionId: "parent-one", __projectId: "alpha" }
  );
  const replay = await collect(
    { id: spawn.delegationId },
    { sessionId: "parent-one", __projectId: "alpha" }
  );
  assert.equal(first.consumedAt, replay.consumedAt);
  const stolen = await collect(
    { id: spawn.delegationId },
    { sessionId: "parent-two", __projectId: "alpha" }
  );
  assert.match(stolen.error, /already consumed/);
  const crossProject = await collect(
    { id: spawn.delegationId },
    { sessionId: "parent-one", __projectId: "beta" }
  );
  assert.match(crossProject.error, /unknown delegation id|outside this project/);
});

test("final synthesis delivery is a distinct durable lifecycle transition", async () => {
  let runtime;
  const tools = makeRuntime(async () => okResult("ready for synthesis"), {
    captureRuntime(value) { runtime = value; }
  });
  const project = { __projectId: "alpha" };
  const spawn = await tools.get("delegate_task").handler(
    { async: true, goal: "produce evidence" },
    { ...project, sessionId: "origin" }
  );
  await waitFor(async () => {
    const status = await tools.get("delegate_status").handler({ id: spawn.delegationId }, project);
    return status.status === "done";
  });
  const collectContext = { ...project, sessionId: "parent-final" };
  await tools.get("delegate_collect").handler({ id: spawn.delegationId }, collectContext);
  assert.deepEqual(collectContext.__collectedDelegationIds, [spawn.delegationId]);
  runtime.markDelegationSynthesisDelivered({
    ids: collectContext.__collectedDelegationIds,
    sessionId: "parent-final",
    messageId: "assistant-message-1"
  });
  const delivered = await tools.get("delegate_status").handler({ id: spawn.delegationId }, project);
  assert.equal(delivered.lifecycle.parentSynthesisDelivered, true);
  assert.equal(delivered.lifecycle.synthesisMessageId, "assistant-message-1");
  assert.ok(delivered.lifecycle.synthesisDeliveredAt);
});

test("delegate_steer interrupts a running child and respawns it with the note", async () => {
  const prompts = [];
  let releaseFirst;
  const firstAttempt = new Promise((_, reject) => { releaseFirst = reject; });
  let call = 0;
  const tools = makeRuntime(async (input) => {
    call += 1;
    prompts.push(input.text);
    if (call === 1) {
      input.abortSignal?.addEventListener("abort", () => releaseFirst(new Error("steered")), { once: true });
      return firstAttempt;
    }
    return okResult("steered child done");
  });
  const spawn = await tools.get("delegate_task").handler({
    async: true,
    tasks: [{ goal: "research everything" }]
  });
  await waitFor(() => call === 1);
  const steer = await tools.get("delegate_steer").handler({
    id: spawn.delegationId,
    taskIndex: 0,
    note: "stop researching, summarize what you have"
  });
  assert.equal(steer.steered[0].action, "interrupted; respawning with steering note");
  const statusHandler = tools.get("delegate_status").handler;
  const done = await waitFor(async () => {
    const snapshot = await statusHandler({ id: spawn.delegationId });
    return snapshot.status === "done" ? snapshot : null;
  });
  assert.equal(call, 2);
  assert.match(prompts[1], /<steering>/);
  assert.match(prompts[1], /stop researching, summarize what you have/);
  assert.equal(done.tasks[0].state, "completed");
  assert.equal(done.tasks[0].steerCount, 1);
  assert.equal(done.tasks[0].summary, "steered child done");
});

test("delegate_cancel aborts a running child and skips a queued one", async () => {
  process.env.OPENAGI_MAX_CHILDREN = "1";
  try {
    let releaseFirst;
    const blocked = new Promise((_, reject) => { releaseFirst = reject; });
    const tools = makeRuntime(async (input) => {
      input.abortSignal?.addEventListener("abort", () => releaseFirst(new Error("cancelled")), { once: true });
      return blocked;
    });
    const spawn = await tools.get("delegate_task").handler({
      async: true,
      tasks: [{ goal: "slow task" }, { goal: "queued task" }]
    });
    const statusHandler = tools.get("delegate_status").handler;
    await waitFor(async () => {
      const snapshot = await statusHandler({ id: spawn.delegationId });
      return snapshot.tasks[0].state === "running";
    });
    const cancel = await tools.get("delegate_cancel").handler({ id: spawn.delegationId });
    assert.equal(cancel.cancelled.length, 2);
    const done = await waitFor(async () => {
      const snapshot = await statusHandler({ id: spawn.delegationId });
      return snapshot.status === "done" ? snapshot : null;
    });
    assert.equal(done.tasks[0].state, "cancelled");
    assert.equal(done.tasks[1].state, "cancelled");
    assert.equal(done.tasks[1].error, "cancelled before start");
  } finally {
    delete process.env.OPENAGI_MAX_CHILDREN;
  }
});

test("steering a finished task re-runs it as a refinement", async () => {
  const prompts = [];
  let call = 0;
  const tools = makeRuntime(async (input) => {
    call += 1;
    prompts.push(input.text);
    return okResult(call === 1 ? "first pass" : "refined pass");
  });
  const spawn = await tools.get("delegate_task").handler({
    async: true,
    tasks: [{ goal: "draft a summary" }]
  });
  const statusHandler = tools.get("delegate_status").handler;
  await waitFor(async () => {
    const snapshot = await statusHandler({ id: spawn.delegationId });
    return snapshot.status === "done";
  });
  const steer = await tools.get("delegate_steer").handler({
    id: spawn.delegationId,
    taskIndex: 0,
    note: "make it half as long"
  });
  assert.equal(steer.steered[0].action, "re-running as refinement with steering note");
  const done = await waitFor(async () => {
    const snapshot = await statusHandler({ id: spawn.delegationId });
    return snapshot.status === "done" && snapshot.tasks[0].summary === "refined pass" ? snapshot : null;
  });
  assert.equal(call, 2);
  assert.match(prompts[1], /make it half as long/);
  assert.equal(done.tasks[0].steerCount, 1);
});

test("unknown ids and empty notes fail closed", async () => {
  const tools = makeRuntime(async () => okResult());
  assert.match((await tools.get("delegate_status").handler({ id: "nope" })).error, /unknown delegation id/);
  assert.match((await tools.get("delegate_steer").handler({ id: "nope", note: "x" })).error, /unknown delegation id/);
  assert.match((await tools.get("delegate_cancel").handler({ id: "nope" })).error, /unknown delegation id/);
  const spawn = await tools.get("delegate_task").handler({ async: true, goal: "real" });
  assert.match((await tools.get("delegate_steer").handler({ id: spawn.delegationId, note: "  " })).error, /note is required/);
});

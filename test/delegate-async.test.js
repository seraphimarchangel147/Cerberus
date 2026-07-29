// Async delegation: waves auto-chunking, verify hints, per-child metrics, and
// the delegate_status/_steer/_cancel control lane. Uses the lightweight mock
// runtime (same pattern as delegate-task.test.js's direct-handler tests).
import { test } from "node:test";
import assert from "node:assert/strict";
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

function makeRuntime(handleMessage) {
  const tools = new ToolRegistry();
  const runtime = {
    tools,
    agentHost: { handleMessage }
  };
  registerDelegateTaskTool(runtime);
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

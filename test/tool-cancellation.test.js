import assert from "node:assert/strict";
import test from "node:test";
import { runExecuteCode } from "../src/integrations/execute-code.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("a pre-aborted invocation never reaches preflight, hooks, or dispatch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  let preflights = 0;
  let hooks = 0;
  let dispatches = 0;
  const registry = new ToolRegistry({
    hooks: {
      beforeToolCall: async () => {
        hooks += 1;
        return { action: "allow" };
      }
    }
  });
  registry.register({
    name: "cancel_before",
    sideEffects: true,
    preflight: () => { preflights += 1; },
    handler: async () => { dispatches += 1; return { changed: true }; }
  });

  const result = await registry.invoke("cancel_before", {}, {
    __abortSignal: controller.signal
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "blocked");
  assert.equal(result.outcome.code, "tool_dispatch_cancelled");
  assert.equal(result.outcome.changed, false);
  assert.equal(result.receipt.dispatched, false);
  assert.deepEqual({ preflights, hooks, dispatches }, {
    preflights: 0,
    hooks: 0,
    dispatches: 0
  });
});

test("an abort during a pre-tool hook prevents later dispatch", async () => {
  const controller = new AbortController();
  let releaseHook;
  const hookPaused = new Promise((resolve) => { releaseHook = resolve; });
  let dispatches = 0;
  const registry = new ToolRegistry({
    hooks: {
      beforeToolCall: async () => {
        await hookPaused;
        return { action: "allow" };
      }
    }
  });
  registry.register({
    name: "cancel_during_hook",
    sideEffects: true,
    handler: async () => { dispatches += 1; return { changed: true }; }
  });

  const invocation = registry.invoke("cancel_during_hook", {}, {
    __abortSignal: controller.signal
  });
  controller.abort();
  releaseHook();
  const result = await invocation;

  assert.equal(result.outcome.code, "tool_dispatch_cancelled");
  assert.equal(result.receipt.dispatched, false);
  assert.equal(dispatches, 0);
});

test("an abort during mutation reports uncertain state and schedules inspection", async () => {
  const controller = new AbortController();
  let releaseHandler;
  let enteredHandler;
  const entered = new Promise((resolve) => { enteredHandler = resolve; });
  const paused = new Promise((resolve) => { releaseHandler = resolve; });
  const captures = [];
  const registry = new ToolRegistry({
    timeline: {
      schedulePostMutation: (details) => captures.push(details)
    }
  });
  registry.register({
    name: "cancel_during_write",
    sideEffects: true,
    handler: async () => {
      enteredHandler();
      await paused;
      return { changed: true };
    }
  });

  const invocation = registry.invoke("cancel_during_write", {}, {
    __abortSignal: controller.signal
  });
  await entered;
  controller.abort();
  releaseHandler();
  const result = await invocation;

  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.code, "tool_execution_cancelled");
  assert.equal(result.outcome.changed, null);
  assert.match(result.outcome.nextSteps[0], /Inspect the target state/);
  assert.equal(result.receipt.dispatched, true);
  assert.equal(result.receipt.changed, null);
  assert.equal(captures.length, 1);
});

test("a completed read may return after abort but never claims a mutation", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry();
  registry.register({
    name: "cancel_during_read",
    sideEffects: false,
    handler: async () => {
      controller.abort();
      return { value: "late" };
    }
  });

  const result = await registry.invoke("cancel_during_read", {}, {
    __abortSignal: controller.signal
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.code, "ok");
  assert.equal(result.outcome.changed, false);
  assert.equal(result.receipt.dispatched, true);
});

test("execute_code terminates its worker on turn cancellation", async () => {
  const controller = new AbortController();
  const execution = runExecuteCode(
    { tools: new ToolRegistry() },
    { code: "while (true) {}", timeoutMs: 5_000 },
    { __abortSignal: controller.signal }
  );
  controller.abort();
  const result = await execution;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /cancelled/);
  assert.deepEqual(result.receipts, []);
});

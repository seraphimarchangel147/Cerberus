// test/cron-overlap-guard.test.js
// D1 part 1: the hosted-interface ticker fires runtime.tick() every 10s
// without awaiting it. A slow tick (LLM call inside a cron job) must not
// stack a second concurrent run — the runtime carries an in-flight flag
// and skipped ticks log once per streak, not once per skip.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRuntime } from "../src/index.js";

test("second tick returns immediately while the first is still running", async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let running = 0;
  let maxConcurrent = 0;
  runtime.cron.runDue = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    running -= 1;
    return [{ job: { id: "slow" }, result: { ok: true } }];
  };
  const [first, second] = await Promise.all([runtime.tick(), runtime.tick()]);
  assert.equal(maxConcurrent, 1, "ticks must never overlap");
  assert.equal(first.length, 1, "first tick ran the due jobs");
  assert.deepEqual(second, [], "overlapping tick returns [] without running jobs");
});

test("tick runs again normally after the in-flight tick finishes", async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let calls = 0;
  runtime.cron.runDue = async () => {
    calls += 1;
    return [];
  };
  await runtime.tick();
  await runtime.tick();
  assert.equal(calls, 2, "sequential ticks both run");
});

test("skipped ticks log once per streak, not once per skip", { timeout: 5000 }, async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let release = null;
  runtime.cron.runDue = () => new Promise((resolve) => { release = () => resolve([]); });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const inFlight = runtime.tick();
    await runtime.tick(); // skip 1 — logs
    await runtime.tick(); // skip 2 — silent
    await runtime.tick(); // skip 3 — silent
    release();
    await inFlight;
  } finally {
    console.warn = originalWarn;
  }
  const skipLogs = warnings.filter((w) => w.includes("skipping overlapping tick"));
  assert.equal(skipLogs.length, 1, "one log line for the whole skip streak");
});

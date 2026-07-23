import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { HookRegistry } from "../src/hook-registry.js";
import { createHostedInterface } from "../src/hosted-interface.js";

function tempFixture(t, prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("AgentHost emits non-blocking session and per-turn lifecycle hooks", async (t) => {
  const dataDir = tempFixture(t, "openagi-hook-lifecycle-");
  const hooks = new HookRegistry({
    dataDir,
    loadConfig: false,
    timeoutMs: 5_000,
    perHookTimeoutMs: 5_000,
    log: () => {}
  });
  const events = [];
  let releaseFirstAgentStart;
  const firstAgentStart = new Promise((resolve) => { releaseFirstAgentStart = resolve; });
  let held = false;
  hooks.register({
    name: "lifecycle-collector",
    event: "*",
    handler: async (payload, control) => {
      events.push({ event: control.event, payload });
      if (control.event === "agent:start" && !held) {
        held = true;
        await firstAgentStart;
      }
    }
  });

  let failModel = false;
  const modelProvider = {
    isConfigured: () => true,
    async generate({ context }) {
      context.__onToolEvent?.({ phase: "iteration", n: 1, max: 4 });
      if (failModel) throw new Error("provider exploded");
      return {
        id: "hook-model-response",
        text: "hook reply",
        provider: "stub",
        model: "stub-model",
        iterations: 1,
        maxIterations: 4,
        stopReason: "completed",
        toolCalls: []
      };
    }
  };
  const runtime = createDurableRuntime({
    dataDir,
    hooks,
    modelProvider,
    autoConnectMcp: false
  });
  assert.equal(runtime.hooks, hooks);
  assert.equal(runtime.tools.hooks, hooks);

  const firstTurn = runtime.agentHost.handleMessage({
    text: "hello lifecycle",
    channel: "local",
    from: "hook-user",
    sessionId: "hook-session",
    routeTo: false,
    backgroundReview: false
  });
  let raceTimer;
  const race = await Promise.race([
    firstTurn.then(() => "turn-complete"),
    new Promise((resolve) => {
      raceTimer = setTimeout(() => resolve("observer-blocked-turn"), 2_000);
    })
  ]);
  clearTimeout(raceTimer);
  releaseFirstAgentStart();
  assert.equal(race, "turn-complete", "observer hooks do not delay the agent turn");
  await firstTurn;
  await hooks.flush();

  await runtime.agentHost.handleMessage({
    text: "second lifecycle turn",
    channel: "local",
    from: "hook-user",
    sessionId: "hook-session",
    routeTo: false,
    backgroundReview: false
  });
  await hooks.flush();

  const names = events.map((entry) => entry.event);
  assert.equal(names.filter((event) => event === "session:start").length, 1);
  assert.equal(names.filter((event) => event === "session:message").length, 4);
  assert.equal(names.filter((event) => event === "agent:start").length, 2);
  assert.equal(names.filter((event) => event === "agent:step").length, 2);
  assert.equal(names.filter((event) => event === "agent:end").length, 2);
  assert.equal(
    events.filter((entry) => entry.event === "agent:end").every((entry) => entry.payload.completed === true),
    true
  );

  events.length = 0;
  failModel = true;
  await assert.rejects(
    runtime.agentHost.handleMessage({
      text: "fail this lifecycle turn",
      channel: "local",
      from: "hook-user",
      sessionId: "hook-error-session",
      routeTo: false,
      backgroundReview: false
    }),
    /provider exploded/
  );
  await hooks.flush();
  const failedEnd = events.find((entry) => entry.event === "agent:end");
  assert.ok(failedEnd);
  assert.equal(failedEnd.payload.completed, false);
  assert.equal(failedEnd.payload.error, "provider exploded");

  events.length = 0;
  failModel = false;
  await runtime.agentHost.handleMessage({
    text: "ephemeral probe",
    channel: "local",
    from: "hook-user",
    ephemeral: true,
    routeTo: false,
    backgroundReview: false
  });
  await hooks.flush();
  assert.deepEqual(events, [], "ephemeral connectivity turns emit no lifecycle hooks");

  runtime.agentHost.resetSession({
    sessionId: "hook-session",
    nextSessionId: "hook-session-reset",
    channel: "local",
    from: "hook-user"
  });
  await runtime.agentHost.handleMessage({
    text: "first reset turn",
    channel: "local",
    from: "hook-user",
    sessionId: "hook-session-reset",
    routeTo: false,
    backgroundReview: false
  });
  await hooks.flush();
  const resetEvents = events.map((entry) => entry.event);
  assert.ok(resetEvents.indexOf("session:end") < resetEvents.indexOf("session:reset"));
  assert.ok(resetEvents.indexOf("session:reset") < resetEvents.indexOf("session:start"));
});

test("hosted gateway emits startup only after listen and flushes shutdown", async (t) => {
  const dataDir = tempFixture(t, "openagi-hook-gateway-");
  const hooks = new HookRegistry({ dataDir, loadConfig: false, log: () => {} });
  const events = [];
  hooks.register({
    name: "gateway-events",
    event: "gateway:*",
    handler: (payload, control) => { events.push({ event: control.event, payload }); }
  });
  const runtime = {
    hooks,
    tick: async () => ({}),
    outcomes: null,
    cron: null,
    tunnelWatcher: null,
    mcp: null,
    agentHost: null
  };
  const channels = {
    start() {},
    stop() {},
    status: () => ({
      local: { enabled: true },
      discord: { configured: true },
      telegram: { configured: false }
    })
  };
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    channels
  });

  await hooks.flush();
  assert.deepEqual(events, [], "constructing an interface is not a gateway startup");
  const address = await app.listen();
  await hooks.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "gateway:startup");
  assert.equal(events[0].payload.port, address.port);
  assert.deepEqual(events[0].payload.platforms, ["local", "discord"]);

  await app.close();
  assert.equal(events.at(-1).event, "gateway:shutdown");
});

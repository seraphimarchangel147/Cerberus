import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import {
  isSystemOriginatedTurn,
  shouldWriteTurnMemory
} from "../src/memory-intake-policy.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeHarness() {
  const writes = [];
  const counters = [];
  const logs = [];
  const runtime = {
    tools: new ToolRegistry(),
    memory: {
      renderSessionMemorySnapshot: () => "",
      remember(item, options) {
        writes.push({ item, options });
        return { id: `memory_${writes.length}` };
      }
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_memory_suppression",
      scrutiny: {
        action: "act",
        score: 0.4,
        reasons: ["memory suppression fixture"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  const modelProvider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate() {
      return {
        provider: "fixture",
        model: "fixture-model",
        id: "response_memory_suppression",
        text: "Fixture reply.",
        toolCalls: [],
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      };
    }
  };
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider,
    log: (event) => logs.push(event),
    recordHarnessCounter: (kind, meta) => counters.push({ kind, ...meta })
  });
  return { host, writes, counters, logs };
}

async function runTurn(harness, channel, overrides = {}) {
  const input = {
    from: "fixture-user",
    sessionId: `memory-${channel ?? "undefined"}`,
    text: "Report the scheduled status.",
    ...overrides
  };
  if (channel !== undefined) input.channel = channel;
  return harness.host.handleMessage(input);
}

test("a cron turn does not write turn memory", async () => {
  const harness = makeHarness();
  await runTurn(harness, "cron");
  assert.equal(harness.writes.length, 0);
  assert.equal(isSystemOriginatedTurn("cron"), true);
});

test("a job turn does not write turn memory", async () => {
  const harness = makeHarness();
  await runTurn(harness, "job");
  assert.equal(harness.writes.length, 0);
});

test("an autopilot turn does not write turn memory", async () => {
  const harness = makeHarness();
  await runTurn(harness, "autopilot");
  assert.equal(harness.writes.length, 0);
});

test("a discord turn still writes turn memory", async () => {
  const harness = makeHarness();
  await runTurn(harness, "discord");
  assert.equal(harness.writes.length, 1);
});

test("a local turn still writes turn memory", async () => {
  const harness = makeHarness();
  await runTurn(harness, "local");
  assert.equal(harness.writes.length, 1);
});

test("explicit memory opt-in writes on a cron turn", async () => {
  const harness = makeHarness();
  await runTurn(harness, "cron", { memory: true });
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.counters.length, 0);
});

test("the suppression kill switch restores cron memory writes", async (t) => {
  const previous = process.env.OPENAGI_SYSTEM_MEMORY_SUPPRESSION;
  process.env.OPENAGI_SYSTEM_MEMORY_SUPPRESSION = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_SYSTEM_MEMORY_SUPPRESSION;
    else process.env.OPENAGI_SYSTEM_MEMORY_SUPPRESSION = previous;
  });

  const harness = makeHarness();
  await runTurn(harness, "cron");
  assert.equal(harness.writes.length, 1);
  assert.equal(shouldWriteTurnMemory({ channel: "cron" }), true);
  assert.equal(SETUP_FIELDS.includes("OPENAGI_SYSTEM_MEMORY_SUPPRESSION"), true);
});

test("a suppressed turn emits exactly one observable counter event", async () => {
  const harness = makeHarness();
  await runTurn(harness, "cron");
  assert.deepEqual(harness.counters, [{
    kind: "memory-write-suppressed",
    channel: "cron",
    sessionId: "memory-cron",
    agentId: "main",
    projectId: "default"
  }]);
  assert.equal(
    harness.logs.filter((event) => event.op === "memory-write-suppressed").length,
    1
  );
});

test("unknown and undefined channels default to writing", async () => {
  assert.equal(shouldWriteTurnMemory({ channel: "future-human-channel" }), true);
  assert.equal(shouldWriteTurnMemory({ channel: undefined }), true);

  const unknown = makeHarness();
  await runTurn(unknown, "future-human-channel");
  assert.equal(unknown.writes.length, 1);

  const omitted = makeHarness();
  await runTurn(omitted, undefined);
  assert.equal(omitted.writes.length, 1);
});

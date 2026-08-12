import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import {
  aggregateCounters,
  HarnessCounterJournal
} from "../src/harness-counters.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { TurnSteering } from "../src/turn-steering.js";

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-harness-counters-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
}

function makeSteeringHarness({
  steering = new TurnSteering(),
  onGenerate = null,
  dataDir = null,
  injectRecorder = true
} = {}) {
  const counters = [];
  const logs = [];
  const runtime = {
    steering,
    tools: new ToolRegistry(),
    memory: {
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory_steering_counter" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_steering_counter",
      scrutiny: {
        action: "act",
        score: 0.4,
        reasons: ["steering counter fixture"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  if (dataDir) runtime.dataDir = dataDir;
  const hostOptions = {
    runtime,
    store: new InMemoryAgentStore(),
    log: (event) => logs.push(event),
    modelProvider: {
      provider: "fixture",
      model: "fixture-model",
      isConfigured: () => true,
      async generate() {
        onGenerate?.();
        return {
          provider: "fixture",
          model: "fixture-model",
          text: "Fixture reply.",
          toolCalls: [],
          stopReason: "completed"
        };
      }
    }
  };
  if (injectRecorder) {
    hostOptions.recordHarnessCounter = (kind, meta) => counters.push({ kind, ...meta });
  }
  const host = new AgentHost(hostOptions);
  return { host, counters, logs };
}

test("append writes one parseable JSON line per counter event", (t) => {
  const dataDir = tempDataDir(t);
  const journal = new HarnessCounterJournal({
    dataDir,
    clock: () => "2026-08-12T12:00:00.000Z"
  });

  assert.equal(journal.record("steer-carried", { sessionId: "session-a" }), true);
  assert.equal(journal.record("steer-undelivered", { sessionId: "session-b" }), true);

  const lines = readLines(journal.filePath);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    {
      ts: "2026-08-12T12:00:00.000Z",
      kind: "steer-carried",
      sessionId: "session-a"
    },
    {
      ts: "2026-08-12T12:00:00.000Z",
      kind: "steer-undelivered",
      sessionId: "session-b"
    }
  ]);
});

test("appends survive a fresh journal instance", (t) => {
  const dataDir = tempDataDir(t);
  const first = new HarnessCounterJournal({ dataDir });
  assert.equal(first.record("steer-carried"), true);

  const restarted = new HarnessCounterJournal({ dataDir });
  assert.equal(restarted.record("steer-undelivered"), true);

  assert.equal(readLines(restarted.filePath).length, 2);
});

test("aggregateCounters totals events by kind", (t) => {
  const dataDir = tempDataDir(t);
  const journal = new HarnessCounterJournal({ dataDir });
  journal.record("steer-carried");
  journal.record("steer-carried");
  journal.record("memory-write-suppressed");

  assert.deepEqual(aggregateCounters({ dataDir }), {
    "memory-write-suppressed": 1,
    "steer-carried": 2
  });
});

test("aggregateCounters filters events by since", (t) => {
  const dataDir = tempDataDir(t);
  let now = "2026-08-12T12:00:00.000Z";
  const journal = new HarnessCounterJournal({ dataDir, clock: () => now });
  journal.record("steer-carried");
  now = "2026-08-12T12:02:00.000Z";
  journal.record("steer-undelivered");

  assert.deepEqual(aggregateCounters({
    dataDir,
    since: "2026-08-12T12:01:00.000Z"
  }), { "steer-undelivered": 1 });
});

test("aggregateCounters skips malformed journal lines", (t) => {
  const dataDir = tempDataDir(t);
  const journal = new HarnessCounterJournal({ dataDir });
  journal.record("steer-carried");
  fs.appendFileSync(journal.filePath, "{not-json}\n", "utf8");
  journal.record("steer-undelivered");

  assert.deepEqual(aggregateCounters({ dataDir }), {
    "steer-carried": 1,
    "steer-undelivered": 1
  });
});

test("the kill switch disables writes", (t) => {
  const dataDir = tempDataDir(t);
  const journal = new HarnessCounterJournal({
    dataDir,
    env: { OPENAGI_HARNESS_COUNTERS: "0" }
  });

  assert.equal(journal.record("steer-carried"), false);
  assert.equal(fs.existsSync(journal.filePath), false);
  assert.equal(SETUP_FIELDS.includes("OPENAGI_HARNESS_COUNTERS"), true);
});

test("a journal write failure never throws into the caller", (t) => {
  const root = tempDataDir(t);
  const blockedDataDir = path.join(root, "not-a-directory");
  fs.writeFileSync(blockedDataDir, "blocking file", "utf8");
  const journal = new HarnessCounterJournal({ dataDir: blockedDataDir });

  let result = null;
  assert.doesNotThrow(() => {
    result = journal.record("steer-carried");
  });
  assert.equal(result, false);
});

test("the journal rotates past its byte threshold", (t) => {
  const dataDir = tempDataDir(t);
  const journal = new HarnessCounterJournal({ dataDir, maxBytes: 256 });
  assert.equal(journal.record("first", { padding: "x".repeat(512) }), true);
  assert.equal(journal.record("second"), true);

  assert.equal(fs.existsSync(journal.rotatedPath), true);
  assert.deepEqual(readLines(journal.rotatedPath).map((line) => JSON.parse(line).kind), ["first"]);
  assert.deepEqual(readLines(journal.filePath).map((line) => JSON.parse(line).kind), ["second"]);
  assert.deepEqual(aggregateCounters({ dataDir }), { first: 1, second: 1 });
});

test("AgentHost journals carried and undelivered steering without replacing logs", async () => {
  const sessionId = "steering-counter-session";

  const undeliveredSteering = new TurnSteering();
  const undelivered = makeSteeringHarness({
    steering: undeliveredSteering,
    onGenerate: () => undeliveredSteering.steer(sessionId, "late correction")
  });
  await undelivered.host.handleMessage({
    channel: "discord",
    from: "fixture-user",
    sessionId,
    text: "Start the task."
  });
  assert.equal(undelivered.counters.filter((event) => event.kind === "steer-undelivered").length, 1);
  assert.equal(undelivered.logs.filter((event) => event.op === "steer-undelivered").length, 1);

  const carriedSteering = new TurnSteering();
  carriedSteering.beginTurn(sessionId, { turnId: "aborted-turn" });
  carriedSteering.steer(sessionId, "carried correction");
  carriedSteering.endTurn(sessionId, { turnId: "aborted-turn", cause: "stalled" });
  const carried = makeSteeringHarness({
    steering: carriedSteering,
    onGenerate: () => carriedSteering.drain(sessionId)
  });
  await carried.host.handleMessage({
    channel: "discord",
    from: "fixture-user",
    sessionId,
    text: "Resume the task."
  });
  assert.equal(carried.counters.filter((event) => event.kind === "steer-carried").length, 1);
  assert.equal(carried.logs.filter((event) => event.op === "steer-carried").length, 1);
});

test("AgentHost defaults suppression counters to the runtime data directory", async (t) => {
  const dataDir = tempDataDir(t);
  const previous = process.env.OPENAGI_HARNESS_COUNTERS;
  delete process.env.OPENAGI_HARNESS_COUNTERS;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_HARNESS_COUNTERS;
    else process.env.OPENAGI_HARNESS_COUNTERS = previous;
  });
  const harness = makeSteeringHarness({ dataDir, injectRecorder: false });

  await harness.host.handleMessage({
    channel: "cron",
    from: "scheduler",
    sessionId: "durable-suppression-counter",
    text: "Run the scheduled status check."
  });

  assert.deepEqual(aggregateCounters({ dataDir }), {
    "memory-write-suppressed": 1
  });
});

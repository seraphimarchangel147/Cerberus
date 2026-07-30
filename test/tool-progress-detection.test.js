import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolRegistry,
  evaluateRepeatedOutcome
} from "../src/tool-registry.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function registerPollTool(registry, handler) {
  registry.register({
    name: "poll_status",
    description: "Read the current fixture status.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" }
      },
      required: ["target"],
      additionalProperties: false
    },
    sideEffects: false,
    capability: { idempotent: true },
    handler
  });
}

test("repeated-outcome comparison reports progress and exact threshold", () => {
  assert.deepEqual(evaluateRepeatedOutcome({
    priorSignature: null,
    nextSignature: "sig-a",
    count: 0,
    limit: 3
  }), {
    comparable: true,
    progressed: false,
    repeatedSuccessCount: 1,
    thresholdReached: false
  });
  assert.deepEqual(evaluateRepeatedOutcome({
    priorSignature: "sig-a",
    nextSignature: "sig-b",
    count: 2,
    limit: 3
  }), {
    comparable: true,
    progressed: true,
    repeatedSuccessCount: 1,
    thresholdReached: false
  });
  assert.deepEqual(evaluateRepeatedOutcome({
    priorSignature: "sig-a",
    nextSignature: "sig-a",
    count: 2,
    limit: 3
  }), {
    comparable: true,
    progressed: false,
    repeatedSuccessCount: 3,
    thresholdReached: true
  });
});

test("same polling call with changing output never blocks", async () => {
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "3" }
  });
  const events = [];
  let revision = 0;
  registerPollTool(registry, () => ({
    state: "running",
    revision: revision += 1
  }));
  const context = {
    sessionId: "progress-changing",
    __turnId: "turn-changing",
    __onToolEvent: (event) => events.push(event)
  };

  const results = [];
  for (let index = 0; index < 20; index += 1) {
    results.push(await registry.invoke(
      "poll_status",
      { target: "job-a" },
      context
    ));
  }

  assert.ok(results.every((result) => result.ok === true));
  const endEvents = events.filter((event) => event.phase === "end");
  assert.equal(endEvents.length, 20);
  assert.equal(endEvents.filter((event) => event.progress === true).length, 19);
});

test("identical call and output returns one advisory at the threshold", async () => {
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "3" }
  });
  let calls = 0;
  registerPollTool(registry, () => {
    calls += 1;
    return { state: "idle", revision: 7 };
  });
  const context = {
    sessionId: "progress-identical",
    __turnId: "turn-identical"
  };

  const results = [];
  for (let index = 0; index < 6; index += 1) {
    results.push(await registry.invoke(
      "poll_status",
      { target: "job-a" },
      context
    ));
  }

  assert.equal(calls, 6, "the advisory does not abort or suppress dispatch");
  assert.equal(results[2].ok, false);
  assert.equal(results[2].outcome.status, "blocked");
  assert.equal(results[2].outcome.code, "repeated_no_progress");
  assert.match(results[2].outcome.nextSteps.join(" "), /different approach/u);
  assert.equal(
    results.filter((result) => result.outcome.code === "repeated_no_progress").length,
    1
  );
});

test("repeated-success advisory defaults to eight matching outputs", async () => {
  const registry = new ToolRegistry({ env: {} });
  registerPollTool(registry, () => ({ state: "idle" }));
  const context = {
    sessionId: "progress-default",
    __turnId: "turn-default"
  };
  const results = [];

  for (let index = 0; index < 8; index += 1) {
    results.push(await registry.invoke(
      "poll_status",
      { target: "job-a" },
      context
    ));
  }

  assert.ok(results.slice(0, 7).every((result) => result.ok === true));
  assert.equal(results[7].outcome.code, "repeated_no_progress");
});

test("interleaved tool-call fingerprints keep independent counters", async () => {
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "3" }
  });
  registerPollTool(registry, () => ({ state: "idle" }));
  const context = {
    sessionId: "progress-independent",
    __turnId: "turn-independent"
  };
  const results = [];

  for (let index = 0; index < 3; index += 1) {
    results.push(await registry.invoke(
      "poll_status",
      { target: "job-a" },
      context
    ));
    results.push(await registry.invoke(
      "poll_status",
      { target: "job-b" },
      context
    ));
  }

  assert.deepEqual(
    results.map((result) => result.outcome.code),
    ["ok", "ok", "ok", "ok", "repeated_no_progress", "repeated_no_progress"]
  );
});

test("failure damping remains failure-only and unchanged", async () => {
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "2" }
  });
  let calls = 0;
  registerPollTool(registry, () => {
    calls += 1;
    return { error: "fixture failure" };
  });
  const context = {
    sessionId: "progress-failure",
    __turnId: "turn-failure"
  };

  const first = await registry.invoke(
    "poll_status",
    { target: "job-a" },
    context
  );
  const second = await registry.invoke(
    "poll_status",
    { target: "job-a" },
    context
  );

  assert.equal(first.ok, false);
  assert.equal(second.outcome.code, "repeated_failure");
  assert.equal(calls, 1);
});

test("unfingerprintable successful output fails open to prior behavior", async () => {
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "2" }
  });
  registerPollTool(registry, () => Array.from({ length: 10_050 }, () => 0));
  const context = {
    sessionId: "progress-hostile",
    __turnId: "turn-hostile"
  };

  const first = await registry.invoke(
    "poll_status",
    { target: "job-a" },
    context
  );
  const second = await registry.invoke(
    "poll_status",
    { target: "job-a" },
    context
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.result.length, 10_050);
  assert.equal(second.outcome.code, "ok");
});

test("repeated-success threshold is setup-wizard persistable", () => {
  assert.equal(
    SETUP_FIELDS.includes("OPENAGI_REPEATED_SUCCESS_LIMIT"),
    true
  );
});

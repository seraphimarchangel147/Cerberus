import assert from "node:assert/strict";
import test from "node:test";
import { formatWallClockCheckpointActivity } from "../src/discord-channel.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

const agent = { id: "main", name: "Main Agent" };

function registerProgressTool(registry, handler) {
  registry.register({
    name: "poll_progress",
    description: "Read changing fixture progress.",
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

function toolResponse(index) {
  return {
    id: `response-${index}`,
    output: [{
      type: "function_call",
      call_id: `call-${index}`,
      name: "poll_progress",
      arguments: "{\"target\":\"job-a\"}"
    }]
  };
}

test("idle-strike defaults, legacy aliases, and setup persistence are explicit", () => {
  const defaults = new OpenAIResponsesProvider({
    apiKey: "test",
    env: {}
  });
  const envOverride = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_WALL_CLOCK_IDLE_STRIKES: "5" }
  });
  // Existing .env files predate the rename; both legacy names still resolve so
  // an upgrade never silently changes a deployed agent's tolerance.
  const legacyFreeEnv = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_WALL_CLOCK_FREE_EXTENSIONS: "7" }
  });
  const legacyCheckpointEnv = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_WALL_CLOCK_CHECKPOINTS: "2" }
  });
  const optionOverride = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_WALL_CLOCK_IDLE_STRIKES: "5" },
    wallClockIdleStrikes: 0
  });
  const invalid = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_WALL_CLOCK_IDLE_STRIKES: "unsafe" }
  });

  assert.equal(defaults.wallClockIdleStrikes, 3);
  assert.equal(envOverride.wallClockIdleStrikes, 5);
  assert.equal(legacyFreeEnv.wallClockIdleStrikes, 7);
  assert.equal(legacyCheckpointEnv.wallClockIdleStrikes, 2);
  assert.equal(optionOverride.wallClockIdleStrikes, 0);
  assert.equal(invalid.wallClockIdleStrikes, 3);
  assert.equal(
    SETUP_FIELDS.includes("OPENAGI_WALL_CLOCK_IDLE_STRIKES"),
    true
  );
  assert.match(
    formatWallClockCheckpointActivity({
      idleStrikesLeft: 3,
      progressExtensions: 4,
      progressSinceLastCheckpoint: true,
      extensionKind: "progress"
    }),
    /still producing output, extended free \(4 progress extensions granted/u
  );
  assert.match(
    formatWallClockCheckpointActivity({
      idleStrikesLeft: 1,
      progressExtensions: 0,
      progressSinceLastCheckpoint: false,
      extensionKind: "idle"
    }),
    /Idle checkpoint - no new output \(1 idle allowance left/u
  );
});

test("no progress spends bounded idle strikes then stops as stalled", async () => {
  let now = 0;
  let requests = 0;
  let dispatches = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockIdleStrikes: 2,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry();
  registerProgressTool(registry, () => {
    dispatches += 1;
    return { revision: dispatches };
  });
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    now += 1000;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "run until the idle guard stops it",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-no-progress",
      __turnId: "turn-no-progress",
      __onToolEvent: (event) => events.push(event)
    }
  });

  const checkpoints = events.filter(
    (event) => event.phase === "wall-clock-checkpoint"
  );
  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(result.iterations, 3);
  assert.equal(dispatches, 0);
  assert.equal(now, 3000, "base window plus two idle allowances");
  assert.equal(checkpoints.length, 2);
  assert.ok(checkpoints.every((event) => event.extensionKind === "idle"));
  assert.ok(checkpoints.every(
    (event) => event.progressSinceLastCheckpoint === false
  ));
  assert.match(result.text, /went idle/i);
  assert.match(result.text, /stopped as STALLED/i);
});

test("unavailable progress accounting fails closed onto bounded idle strikes", async () => {
  let now = 0;
  let requests = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockIdleStrikes: 1,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry();
  registerProgressTool(registry, () => ({ revision: 1 }));
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    now += 1000;
    return toolResponse(requests);
  };
  const context = Object.freeze({
    sessionId: "wall-progress-unavailable",
    __turnId: "turn-progress-unavailable",
    __onToolEvent: (event) => events.push(event)
  });

  const result = await provider.generate({
    input: "use the bounded idle fail-safe",
    agent,
    toolRegistry: registry,
    context
  });

  const checkpoints = events.filter(
    (event) => event.phase === "wall-clock-checkpoint"
  );
  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(now, 2000);
  assert.deepEqual(
    checkpoints.map((event) => ({
      kind: event.extensionKind,
      progress: event.progressSinceLastCheckpoint
    })),
    [{ kind: "idle", progress: null }]
  );
});

// The behaviour the Creator asked for: a turn that keeps producing output is
// never stopped by elapsed time. The old design capped free extensions, so a
// productive turn eventually died on the clock; now only idle checks bound it.
test("changing output earns UNLIMITED free extensions - the clock never stops a productive turn", async () => {
  let now = 0;
  let requests = 0;
  let revision = 0;
  const events = [];
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 12,
    maxTurnSeconds: 1,
    wallClockIdleStrikes: 2,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  // Every dispatch both advances the clock past a checkpoint AND produces new
  // output, so under the old rules this turn would have been killed after the
  // free cap; under the new rules it runs until the ITERATION cap instead.
  registerProgressTool(registry, () => {
    revision += 1;
    now += 1000;
    return { state: "running", revision };
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "keep working while output changes",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-progress",
      __turnId: "turn-progress",
      __onToolEvent: (event) => events.push(event)
    }
  });

  const checkpoints = events.filter(
    (event) => event.phase === "wall-clock-checkpoint"
  );
  assert.equal(
    result.stopReason,
    "iteration-cap",
    "a productive turn ends on work-based limits, never on the clock"
  );
  assert.ok(
    checkpoints.length > 3,
    `expected more extensions than the old free cap allowed, got ${checkpoints.length}`
  );
  // The very first checkpoint can land before the first tool result registers
  // as progress, so it may legitimately spend one idle allowance. Every
  // checkpoint after output starts landing must be a free progress extension.
  assert.ok(
    checkpoints.slice(1).every((event) => event.extensionKind === "progress"),
    "every extension of a productive turn is free"
  );
  assert.ok(checkpoints.slice(1).every(
    (event) => event.progressSinceLastCheckpoint === true
  ));
  assert.ok(
    now > 6000,
    `elapsed time exceeded the old hard bound without stopping the turn (${now}ms)`
  );

  const requestsText = JSON.stringify(bodies);
  assert.match(requestsText, /extended by ~1s at no cost/i);
  assert.match(requestsText, /not stopped by elapsed time/i);
});

test("intermittent idleness is forgiven once output resumes", async () => {
  let now = 0;
  let requests = 0;
  let revision = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 12,
    maxTurnSeconds: 1,
    wallClockIdleStrikes: 2,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  // Dispatches 1-2 return an unchanged payload (idle), then output resumes.
  registerProgressTool(registry, () => {
    revision += 1;
    now += 1000;
    return revision <= 2 ? { state: "same" } : { state: "running", revision };
  });
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "go quiet, then resume producing output",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-progress-recovery",
      __turnId: "turn-progress-recovery",
      __onToolEvent: (event) => events.push(event)
    }
  });

  const checkpoints = events.filter(
    (event) => event.phase === "wall-clock-checkpoint"
  );
  const kinds = checkpoints.map((event) => event.extensionKind);
  assert.ok(kinds.includes("idle"), "a quiet stretch spends an idle allowance");
  assert.ok(kinds.includes("progress"), "resumed output earns free extensions");
  const firstProgressIndex = kinds.indexOf("progress");
  assert.equal(
    checkpoints[firstProgressIndex].idleStrikesLeft,
    2,
    "resumed output restores the full idle budget"
  );
  assert.notEqual(result.stopReason, "turn-timeout");
});

test("Anthropic consumes the same bounded idle signal", async () => {
  let now = 0;
  let requests = 0;
  const events = [];
  const provider = new AnthropicProvider({
    apiKey: "test",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockIdleStrikes: 2,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  // Constant payload: no output-aware progress, so only idle strikes are spent.
  registerProgressTool(registry, () => ({ state: "same" }));
  provider.postMessages = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", stop_reason: "end_turn", content: [] };
    }
    requests += 1;
    now += 1000;
    return {
      id: `message-${requests}`,
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: `use-${requests}`,
        name: "poll_progress",
        input: { target: "job-a" }
      }]
    };
  };

  const result = await provider.generate({
    input: "stay idle and hit the bounded guard",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-progress-anthropic",
      __turnId: "turn-progress-anthropic",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  assert.deepEqual(
    events
      .filter((event) => event.phase === "wall-clock-checkpoint")
      .map((event) => event.extensionKind),
    ["idle", "idle"]
  );
  assert.match(result.text, /stopped as STALLED/i);
  assert.match(result.text, /stopped as STALLED/i);
});

test("hard-turn-ceiling knob resolution and setup persistence", () => {
  const defaults = new OpenAIResponsesProvider({
    apiKey: "test",
    env: {}
  });
  const envOverride = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_MAX_TURN_HARD_SECONDS: "3600" }
  });
  const optionOverride = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_MAX_TURN_HARD_SECONDS: "3600" },
    maxTurnHardSeconds: 100
  });
  const invalid = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_MAX_TURN_HARD_SECONDS: "unsafe" }
  });
  // The backstop cannot be silently disabled: 0 falls back to the default.
  const zero = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_MAX_TURN_HARD_SECONDS: "0" }
  });

  assert.equal(defaults.maxTurnHardSeconds, 28800);
  assert.equal(envOverride.maxTurnHardSeconds, 3600);
  assert.equal(optionOverride.maxTurnHardSeconds, 100);
  assert.equal(invalid.maxTurnHardSeconds, 28800);
  assert.equal(zero.maxTurnHardSeconds, 28800);
  assert.equal(
    SETUP_FIELDS.includes("OPENAGI_MAX_TURN_HARD_SECONDS"),
    true
  );
});

test("a productive turn still stops at the absolute hard-time ceiling", async () => {
  let now = 0;
  let requests = 0;
  let revision = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 30,
    maxTurnSeconds: 1,
    maxTurnHardSeconds: 3,
    wallClockIdleStrikes: 1,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  // Every call returns NEW output: progress at every checkpoint. Only the
  // absolute ceiling may stop this turn -- the idle detector never may.
  registerProgressTool(registry, () => {
    revision += 1;
    now += 1000;
    return { state: "running", revision };
  });
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "keep producing new output until the backstop fires",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-hard-ceiling",
      __turnId: "turn-hard-ceiling",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  const stops = events.filter((event) => event.phase === "wall-clock-stopped");
  assert.equal(stops.length, 1, "exactly one watchdog stop event");
  assert.equal(stops[0].reason, "hard-ceiling");
  // Progress extensions were granted along the way -- the turn was working.
  assert.ok(stops[0].progressExtensions >= 1);
  assert.match(result.text, /hard-time ceiling/i);
});

test("a stalled stop emits an auditable non-progress receipt", async () => {
  let now = 0;
  let requests = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 30,
    maxTurnSeconds: 1,
    maxTurnHardSeconds: 100,
    wallClockIdleStrikes: 1,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  // Constant payload after the first call: first-time progress, then
  // identical-output repeats -- the genuine stall signature.
  registerProgressTool(registry, () => {
    now += 1000;
    return { state: "same" };
  });
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "stall against identical output",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-stall-receipt",
      __turnId: "turn-stall-receipt",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  const stops = events.filter((event) => event.phase === "wall-clock-stopped");
  assert.equal(stops.length, 1, "exactly one watchdog stop event");
  assert.equal(stops[0].reason, "stalled");
  // The receipt names what was judged non-progressive -- the verdict is
  // auditable instead of "progress unreadable".
  assert.ok(stops[0].trackedOutputs >= 1);
  assert.ok(stops[0].nonProgressiveOutputs >= 1);
  assert.equal(Array.isArray(stops[0].lastNonProgressiveCallIds), true);
  assert.match(result.text, /stopped as STALLED/i);
  assert.match(result.text, /stopped as STALLED/i);
});

test("a generous idle budget lets a quiet-but-alive turn finish (Creator tuning)", async () => {
  // The production failure this guards: long agentic turns with stretches of
  // identical-output calls (polling a lease, re-reading a status) were stopped
  // as STALLED after only 3 idle allowances. With the deployment budget of 12,
  // the same output pattern must survive far longer than the turn needs -- the
  // turn ends on its iteration cap, with idle allowances still in the bank.
  // Anti-spin is preserved: the strikes are still SPENT, just not exhausted.
  let now = 0;
  let requests = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    maxIterations: 8,
    maxTurnSeconds: 1,
    maxTurnHardSeconds: 100,
    wallClockIdleStrikes: 12,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  registerProgressTool(registry, () => {
    now += 1000;
    return { state: "same" };
  });
  provider.postResponses = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", output: [] };
    }
    requests += 1;
    return toolResponse(requests);
  };

  const result = await provider.generate({
    input: "poll an unchanged status until the work is done",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-generous-budget",
      __turnId: "turn-generous-budget",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(
    result.stopReason,
    "iteration-cap",
    "a quiet turn with a generous idle budget ends on work limits, not the watchdog"
  );
  const stops = events.filter((event) => event.phase === "wall-clock-stopped");
  assert.equal(stops.length, 0, "the watchdog never fired");
  const checkpoints = events.filter(
    (event) => event.phase === "wall-clock-checkpoint"
  );
  assert.ok(checkpoints.length >= 4, "several idle checkpoints were spent");
  assert.ok(
    checkpoints.every((event) => event.extensionKind === "idle"),
    "identical output still spends allowances -- anti-spin bookkeeping intact"
  );
  assert.ok(
    checkpoints[checkpoints.length - 1].idleStrikesLeft > 0,
    "allowances remained at the end of the turn"
  );
});
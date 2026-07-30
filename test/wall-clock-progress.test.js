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

test("wall-clock free-extension defaults and setup persistence are explicit", () => {
  const defaults = new OpenAIResponsesProvider({
    apiKey: "test-key",
    env: {}
  });
  const envOverride = new OpenAIResponsesProvider({
    apiKey: "test-key",
    env: { OPENAGI_WALL_CLOCK_FREE_EXTENSIONS: "5" }
  });
  const optionOverride = new OpenAIResponsesProvider({
    apiKey: "test-key",
    env: { OPENAGI_WALL_CLOCK_FREE_EXTENSIONS: "5" },
    wallClockFreeExtensions: 0
  });
  const invalid = new OpenAIResponsesProvider({
    apiKey: "test-key",
    env: { OPENAGI_WALL_CLOCK_FREE_EXTENSIONS: "unsafe" }
  });

  assert.equal(defaults.wallClockFreeExtensions, 3);
  assert.equal(envOverride.wallClockFreeExtensions, 5);
  assert.equal(optionOverride.wallClockFreeExtensions, 0);
  assert.equal(invalid.wallClockFreeExtensions, 3);
  assert.equal(
    SETUP_FIELDS.includes("OPENAGI_WALL_CLOCK_FREE_EXTENSIONS"),
    true
  );
  assert.match(
    formatWallClockCheckpointActivity({
      extensionsLeft: 2,
      freeExtensionsLeft: 1,
      progressSinceLastCheckpoint: true,
      extensionKind: "free"
    }),
    /2 charged, 1 progress extensions left; progress detected; free extension granted/u
  );
});

test("no progress preserves charged checkpoint timing exactly", async () => {
  let now = 0;
  let requests = 0;
  let dispatches = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockCheckpoints: 2,
    wallClockFreeExtensions: 3,
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
    input: "run until the bounded wall guard stops",
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
  assert.equal(now, 3000, "base window plus two charged extensions");
  assert.equal(checkpoints.length, 2);
  assert.ok(checkpoints.every((event) => event.extensionKind === "charged"));
  assert.ok(checkpoints.every(
    (event) => event.progressSinceLastCheckpoint === false
  ));
  assert.match(result.text, /stopped without new output-aware progress/i);
});

test("unavailable progress accounting fails open to charged checkpoints", async () => {
  let now = 0;
  let requests = 0;
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockCheckpoints: 1,
    wallClockFreeExtensions: 3,
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
    input: "use the legacy charged guard",
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
    [{ kind: "charged", progress: null }]
  );
});

test("changing output earns bounded free extensions then charged extensions", async () => {
  let now = 0;
  let requests = 0;
  let revision = 0;
  const events = [];
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockCheckpoints: 2,
    wallClockFreeExtensions: 3,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  registerProgressTool(registry, () => {
    revision += 1;
    if (revision >= 2) now += 1000;
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
    input: "keep polling while output changes",
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
  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(revision, 7);
  assert.equal(
    now,
    6000,
    "bounded by maxTurnSeconds * (1 + checkpoints + freeExtensions)"
  );
  assert.deepEqual(
    checkpoints.map((event) => event.extensionKind),
    ["free", "free", "free", "charged", "charged"]
  );
  assert.ok(checkpoints.every(
    (event) => event.progressSinceLastCheckpoint === true
  ));
  assert.match(result.text, /stopped while making progress/i);

  const requestsText = JSON.stringify(bodies);
  assert.match(requestsText, /did not consume a charged checkpoint/i);
  assert.match(
    requestsText,
    /free-extension cap is exhausted.*consumed a charged checkpoint/i
  );
});

test("Anthropic consumes the same bounded output-progress signal", async () => {
  let now = 0;
  let requests = 0;
  let revision = 0;
  const events = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 20,
    maxTurnSeconds: 1,
    wallClockCheckpoints: 1,
    wallClockFreeExtensions: 2,
    now: () => now,
    stallTimeoutMs: 0
  });
  const registry = new ToolRegistry({
    env: { OPENAGI_REPEATED_SUCCESS_LIMIT: "100" }
  });
  registerProgressTool(registry, () => {
    revision += 1;
    if (revision >= 2) now += 1000;
    return { state: "running", revision };
  });
  provider.postMessages = async (body) => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { id: "forced", stop_reason: "end_turn", content: [] };
    }
    requests += 1;
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
    input: "keep polling while output changes",
    agent,
    toolRegistry: registry,
    context: {
      sessionId: "wall-progress-anthropic",
      __turnId: "turn-progress-anthropic",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(now, 4000);
  assert.deepEqual(
    events
      .filter((event) => event.phase === "wall-clock-checkpoint")
      .map((event) => event.extensionKind),
    ["free", "free", "charged"]
  );
  assert.match(result.text, /stopped while making progress/i);
});

// Hermes-style iteration engine coverage. These tests keep both provider
// protocols honest: the outer turn continues across the old six-hop boundary,
// but still has a deterministic iteration cap and wall-clock escape hatch.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  DeterministicModelProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import { LiveStatus, formatEmptyTurnFallback } from "../src/discord-channel.js";

const agent = { id: "main", name: "Main Agent" };
const ITERATION_ENV = [
  "OPENAGI_MAX_ITERATIONS",
  "OPENAGI_MAX_TOOL_HOPS",
  "OPENAGI_MAX_TURN_SECONDS"
];

function isolateIterationEnv(t) {
  const saved = Object.fromEntries(ITERATION_ENV.map((key) => [key, process.env[key]]));
  for (const key of ITERATION_ENV) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function openAIToolRegistry() {
  return {
    invoke: async (name, args) => ({ ok: true, result: { name, args, done: true } }),
    toOpenAITools: () => [{ type: "function", name: "step", description: "one step", parameters: {} }]
  };
}

function anthropicToolRegistry() {
  return {
    invoke: async (name, args) => ({ ok: true, result: { name, args, done: true } }),
    toAnthropicTools: () => [{ name: "step", description: "one step", input_schema: { type: "object" } }]
  };
}

test("providers default to 25 iterations and a 900-second turn guard", (t) => {
  isolateIterationEnv(t);
  for (const provider of [
    new OpenAIResponsesProvider({ apiKey: "test-key" }),
    new AnthropicProvider({ apiKey: "test-key" })
  ]) {
    assert.equal(provider.maxIterations, 25);
    assert.equal(provider.maxTurnSeconds, 900);
  }
});

test("OPENAGI_MAX_ITERATIONS overrides the deprecated tool-hop alias", (t) => {
  isolateIterationEnv(t);
  process.env.OPENAGI_MAX_ITERATIONS = "9";
  process.env.OPENAGI_MAX_TOOL_HOPS = "3";
  process.env.OPENAGI_MAX_TURN_SECONDS = "45";
  for (const provider of [
    new OpenAIResponsesProvider({ apiKey: "test-key" }),
    new AnthropicProvider({ apiKey: "test-key" })
  ]) {
    assert.equal(provider.maxIterations, 9);
    assert.equal(provider.maxTurnSeconds, 45);
  }
});

test("OPENAGI_MAX_TOOL_HOPS remains a fallback when iterations is unset or blank", (t) => {
  isolateIterationEnv(t);
  process.env.OPENAGI_MAX_ITERATIONS = " ";
  process.env.OPENAGI_MAX_TOOL_HOPS = "4";
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test-key" }).maxIterations, 4);
  assert.equal(new AnthropicProvider({ apiKey: "test-key" }).maxIterations, 4);
});

test("the default engine executes at most 25 tool iterations", async (t) => {
  isolateIterationEnv(t);
  const provider = new OpenAIResponsesProvider({ apiKey: "test-key" });
  const events = [];
  let requests = 0;
  provider.postResponses = async (body) => {
    requests += 1;
    if (!body.tools) return { id: "summary", output_text: "Partial summary after the cap.", output: [] };
    return {
      id: `resp_${requests}`,
      output: [{
        type: "function_call",
        call_id: `call_${requests}`,
        name: "step",
        arguments: JSON.stringify({ n: requests })
      }]
    };
  };

  const result = await provider.generate({
    input: "keep working",
    agent,
    toolRegistry: openAIToolRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });

  assert.equal(result.iterations, 25);
  assert.equal(result.maxIterations, 25);
  assert.equal(result.stopReason, "iteration-cap");
  assert.equal(result.toolCalls.length, 25);
  assert.equal(requests, 26, "25 tool iterations plus one no-tools partial-summary request");
  assert.deepEqual(
    events,
    Array.from({ length: 25 }, (_, index) => ({ phase: "iteration", n: index + 1, max: 25 }))
  );
});

test("OpenAI auto-continues after the per-request hop ceiling in the same turn", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 4,
    maxToolHops: 1
  });
  const sent = [];
  const events = [];
  provider.postResponses = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "resp_tool",
        output: [{ type: "function_call", call_id: "call_1", name: "step", arguments: '{"part":1}' }]
      };
    }
    return { id: "resp_final", output_text: "Finished transparently.", output: [] };
  };

  const result = await provider.generate({
    input: "multi-step task",
    agent,
    toolRegistry: openAIToolRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });

  assert.equal(result.text, "Finished transparently.");
  assert.equal(result.iterations, 2);
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(events, [
    { phase: "iteration", n: 1, max: 4 },
    { phase: "iteration", n: 2, max: 4 }
  ]);
  assert.ok(sent[1].input.some((item) => item.type === "function_call_output"));
  assert.match(JSON.stringify(sent[1].input), /continue/i, "the same accumulated input carries a synthetic continue turn");
});

test("Anthropic auto-continues after the per-request hop ceiling in the same turn", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 4,
    maxToolHops: 1
  });
  const sent = [];
  const events = [];
  provider.postMessages = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "msg_tool",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool_1", name: "step", input: { part: 1 } }]
      };
    }
    return {
      id: "msg_final",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Finished transparently." }]
    };
  };

  const result = await provider.generate({
    input: "multi-step task",
    agent,
    toolRegistry: anthropicToolRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });

  assert.equal(result.text, "Finished transparently.");
  assert.equal(result.iterations, 2);
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(events, [
    { phase: "iteration", n: 1, max: 4 },
    { phase: "iteration", n: 2, max: 4 }
  ]);
  assert.match(JSON.stringify(sent[1].messages), /continue/i);
  assert.match(JSON.stringify(sent[1].messages), /tool_result/);
});

test("OpenAI resumes an incomplete response even when it contains no tool call", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 3 });
  const sent = [];
  provider.postResponses = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return { id: "partial", status: "incomplete", output_text: "Work in progress.", output: [] };
    }
    return { id: "done", status: "completed", output_text: "Now complete.", output: [] };
  };

  const result = await provider.generate({ input: "finish this", agent });
  assert.equal(result.text, "Now complete.");
  assert.equal(result.iterations, 2);
  assert.match(JSON.stringify(sent[1].input), /Work in progress/);
  assert.match(JSON.stringify(sent[1].input), /continue/i);
});

test("Anthropic resumes a max_tokens response with its partial text intact", async () => {
  const provider = new AnthropicProvider({ apiKey: "test-key", maxIterations: 3 });
  const sent = [];
  provider.postMessages = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "partial",
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "Work in progress." }]
      };
    }
    return {
      id: "done",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Now complete." }]
    };
  };

  const result = await provider.generate({ input: "finish this", agent });
  assert.equal(result.text, "Now complete.");
  assert.equal(result.iterations, 2);
  assert.match(JSON.stringify(sent[1].messages), /Work in progress/);
  assert.match(JSON.stringify(sent[1].messages), /continue/i);
});

for (const spec of [
  {
    name: "OpenAI",
    make: () => new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 5, maxTurnSeconds: 0.01 }),
    stub(provider) {
      provider.postResponses = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ id: "late", output_text: "too late", output: [] }), 50);
      });
    }
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({ apiKey: "test-key", maxIterations: 5, maxTurnSeconds: 0.01 }),
    stub(provider) {
      provider.postMessages = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ id: "late", stop_reason: "end_turn", content: [{ type: "text", text: "too late" }] }), 50);
      });
    }
  }
]) {
  test(`${spec.name} wall-clock guard returns a graceful partial summary`, async () => {
    const provider = spec.make();
    spec.stub(provider);
    const events = [];
    const result = await provider.generate({
      input: "do not hang",
      agent,
      context: { __onToolEvent: (event) => events.push(event) }
    });
    assert.equal(result.stopReason, "turn-timeout");
    assert.equal(result.iterations, 1);
    assert.match(result.text, /OPENAGI_MAX_TURN_SECONDS|wall-clock/i);
    assert.deepEqual(events, [{ phase: "iteration", n: 1, max: 5 }]);
  });
}

test("the wall-clock guard also bounds a tool invocation that never settles", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxTurnSeconds: 0.01
  });
  provider.postResponses = async () => ({
    id: "tool",
    output: [{ type: "function_call", call_id: "stuck", name: "step", arguments: "{}" }]
  });
  const toolRegistry = {
    toOpenAITools: openAIToolRegistry().toOpenAITools,
    invoke: async () => new Promise(() => {})
  };

  const result = await provider.generate({ input: "bounded tool", agent, toolRegistry });
  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(result.iterations, 1);
  assert.equal(result.toolCalls.length, 0, "a timed-out invocation is not reported as completed");
  assert.match(result.text, /OPENAGI_MAX_TURN_SECONDS/);
});

test("Discord live status renders iteration progress and the true-cap fallback is actionable", () => {
  const channel = {
    rest: async () => ({}),
    setPresence() {},
    createThread: async () => null
  };
  const status = new LiveStatus(channel, "channel", true);
  status.messageId = "status";
  status.onEvent({ phase: "iteration", n: 3, max: 25 });
  if (status.editTimer) clearTimeout(status.editTimer);
  status.editTimer = null;
  assert.match(status.renderEmbed().description, /iteration 3\/25/i);

  const fallback = formatEmptyTurnFallback({
    toolCalls: Array.from({ length: 25 }, () => ({ name: "step" })),
    model: { iterations: 25, maxIterations: 25, stopReason: "iteration-cap" }
  });
  assert.match(fallback, /25 iterations/i);
  assert.match(fallback, /OPENAGI_MAX_ITERATIONS/);
  assert.doesNotMatch(fallback, /ask me to continue/i);
});

test("the deterministic provider remains compatible with iteration-aware callers", async () => {
  const provider = new DeterministicModelProvider();
  const result = await provider.generate({ input: "hello", agent, context: { __onToolEvent() {} } });
  assert.equal(result.provider, "deterministic");
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /Hey/);
});

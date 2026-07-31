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
  "OPENAGI_MAX_TURN_SECONDS",
  "OPENAGI_MAX_TURN_USD",
  "OPENAGI_WALL_CLOCK_CHECKPOINTS"
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
    assert.equal(provider.maxTurnUsd, null);
    assert.equal(provider.wallClockIdleStrikes, 3);
  }
});

for (const spec of [
  {
    name: "OpenAI",
    make: (env) => new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "openai-base",
      env,
      maxIterations: 1,
      contextCompactChars: 1_000_000
    }),
    stub(provider, models) {
      provider.postResponses = async (body) => {
        models.push(body.model);
        return {
          id: "routing-openai",
          status: "completed",
          output_text: "done",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      };
    }
  },
  {
    name: "Anthropic",
    make: (env) => new AnthropicProvider({
      apiKey: "test-key",
      model: "anthropic-base",
      env,
      maxIterations: 1,
      contextCompactChars: 1_000_000,
      stallTimeoutMs: 0
    }),
    stub(provider, models) {
      provider.postMessages = async (body) => {
        models.push(body.model);
        return {
          id: "routing-anthropic",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      };
    }
  }
]) {
  test(`${spec.name} generate routes a huge request through the base floor`, async () => {
    const env = {
      AGENT_ROUTING: "auto",
      OPENAI_MODEL_NANO: "openai-nano",
      OPENAI_MODEL_MINI: "openai-mini",
      ANTHROPIC_MODEL_NANO: "anthropic-nano",
      ANTHROPIC_MODEL_MINI: "anthropic-mini"
    };
    const provider = spec.make(env);
    const models = [];
    spec.stub(provider, models);
    const result = await provider.generate({
      input: "plain ".repeat(50_000),
      agent,
      task: "observer",
      tools: []
    });
    assert.deepEqual(models, [
      spec.name === "OpenAI" ? "openai-base" : "anthropic-base"
    ]);
    assert.equal(result.model, models[0]);
  });
}

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

test("OPENAGI_WALL_CLOCK_CHECKPOINTS remains a legacy alias for the idle-strike budget", (t) => {
  isolateIterationEnv(t);
  process.env.OPENAGI_WALL_CLOCK_CHECKPOINTS = "1";
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test" }).wallClockIdleStrikes, 1);
  assert.equal(new AnthropicProvider({ apiKey: "test" }).wallClockIdleStrikes, 1);
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test", wallClockCheckpoints: 0 }).wallClockIdleStrikes, 0);
});

test("OPENAGI_MAX_TOOL_HOPS remains a fallback when iterations is unset or blank", (t) => {
  isolateIterationEnv(t);
  process.env.OPENAGI_MAX_ITERATIONS = " ";
  process.env.OPENAGI_MAX_TOOL_HOPS = "4";
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test-key" }).maxIterations, 4);
  assert.equal(new AnthropicProvider({ apiKey: "test-key" }).maxIterations, 4);
});

test("OPENAGI_MAX_TURN_USD is optional and parsed for both paid providers", (t) => {
  isolateIterationEnv(t);
  process.env.OPENAGI_MAX_TURN_USD = "0.75";
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test-key" }).maxTurnUsd, 0.75);
  assert.equal(new AnthropicProvider({ apiKey: "test-key" }).maxTurnUsd, 0.75);
});

test("per-call subagent limits bound both providers without mutating their shared defaults", async () => {
  const openai = new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 9 });
  openai.postResponses = async (body) => body.tools
    ? {
        id: "openai-step",
        output: [{ type: "function_call", call_id: "call", name: "step", arguments: "{}" }]
      }
    : { id: "openai-summary", output_text: "openai partial", output: [] };
  const anthropic = new AnthropicProvider({ apiKey: "test-key", maxIterations: 9 });
  anthropic.postMessages = async (body) => body.tools
    ? {
        id: "anthropic-step",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool", name: "step", input: {} }]
      }
    : {
        id: "anthropic-summary",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "anthropic partial" }]
      };

  const openaiResult = await openai.generate({
    input: "bounded child",
    agent,
    toolRegistry: openAIToolRegistry(),
    maxIterations: 2,
    maxTurnSeconds: 5
  });
  const anthropicResult = await anthropic.generate({
    input: "bounded child",
    agent,
    toolRegistry: anthropicToolRegistry(),
    maxIterations: 2,
    maxTurnSeconds: 5
  });

  assert.equal(openaiResult.iterations, 2);
  assert.equal(openaiResult.maxIterations, 2);
  assert.equal(anthropicResult.iterations, 2);
  assert.equal(anthropicResult.maxIterations, 2);
  assert.equal(openai.maxIterations, 9);
  assert.equal(anthropic.maxIterations, 9);
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
    make: () => new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 1 }),
    registry: openAIToolRegistry,
    stub(provider, sent) {
      provider.postResponses = async (body) => {
        sent.push(structuredClone(body));
        if (body.tools) {
          return {
            id: "openai-tool",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
              input_tokens_details: { cached_tokens: 4 }
            },
            output: [{ type: "function_call", call_id: "call-1", name: "step", arguments: "{}" }]
          };
        }
        return {
          id: "openai-force",
          usage: {
            input_tokens: 6,
            output_tokens: 3,
            total_tokens: 9,
            input_tokens_details: { cached_tokens: 1 }
          },
          output_text: "OpenAI forced answer.",
          output: []
        };
      };
    },
    expectedUsage: {
      input_tokens: 16,
      output_tokens: 5,
      total_tokens: 21,
      input_tokens_details: { cached_tokens: 5 }
    }
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({ apiKey: "test-key", maxIterations: 1 }),
    registry: anthropicToolRegistry,
    stub(provider, sent) {
      provider.postMessages = async (body) => {
        sent.push(structuredClone(body));
        if (body.tools) {
          return {
            id: "anthropic-tool",
            stop_reason: "tool_use",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_read_input_tokens: 4,
              cache_creation: { ephemeral_5m_input_tokens: 1 }
            },
            content: [{ type: "tool_use", id: "tool-1", name: "step", input: {} }]
          };
        }
        return {
          id: "anthropic-force",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 6,
            output_tokens: 3,
            cache_read_input_tokens: 1,
            cache_creation: { ephemeral_5m_input_tokens: 2 }
          },
          content: [{ type: "text", text: "Anthropic forced answer." }]
        };
      };
    },
    expectedUsage: {
      input_tokens: 16,
      output_tokens: 5,
      cache_read_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 3 }
    }
  }
]) {
  test(`${spec.name} aggregates main-hop and force-answer usage exactly once`, async () => {
    const provider = spec.make();
    const sent = [];
    spec.stub(provider, sent);

    const result = await provider.generate({
      input: "run one tool then answer",
      agent,
      toolRegistry: spec.registry()
    });

    assert.equal(result.stopReason, "iteration-cap");
    assert.equal(sent.length, 2);
    assert.deepEqual(result.usage, spec.expectedUsage);
    if (spec.name === "OpenAI") {
      assert.ok(sent.every((body) => body.store === false), "main and force-answer requests are explicitly stateless");
    }
  });
}

test("Anthropic never exposes thinking-only content in its fallback reply", async () => {
  const secretThinking = "private chain of thought sentinel";
  const provider = new AnthropicProvider({ apiKey: "test-key", maxIterations: 1 });
  provider.postMessages = async () => ({
    id: "thinking-only",
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 7 },
    content: [{ type: "thinking", thinking: secretThinking }]
  });

  const result = await provider.generate({ input: "answer safely", agent });

  assert.match(result.text, /truncated before the model produced user-facing text/i);
  assert.doesNotMatch(result.text, new RegExp(secretThinking, "i"));
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 7 });
});

test("provider budget records receive content-free request efficiency metrics", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const shape = {
    toolCount: 7,
    deferredToolCount: 6,
    deferredSchemaBytes: 321
  };

  for (const spec of [
    {
      make: (budgetGuard, now) => new OpenAIResponsesProvider({
        apiKey: "test-key",
        budgetGuard,
        now
      }),
      body: {
        model: "gpt-5",
        store: false,
        input: [
          { type: "function_call_output", call_id: "prior-ok", output: '{"ok":true}' },
          { type: "function_call_output", call_id: "prior-failed", output: '{"error":"failed"}' },
          { role: "user", content: "hello" }
        ],
        tools: [{ type: "function", name: "step", parameters: { type: "object" } }]
      },
      post: (provider, body, context, options) => provider.postResponses(body, context, options),
      response: {
        status: "completed",
        usage: { input_tokens: 4, output_tokens: 2 },
        output: [{ type: "function_call", name: "step", call_id: "call-1", arguments: "{}" }]
      }
    },
    {
      make: (budgetGuard, now) => new AnthropicProvider({
        apiKey: "test-key",
        budgetGuard,
        now,
        stallTimeoutMs: 0
      }),
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "prior-ok", content: "ok", is_error: false },
            { type: "tool_result", tool_use_id: "prior-failed", content: "failed", is_error: true },
            { type: "text", text: "hello" }
          ]
        }],
        tools: [{ name: "step", input_schema: { type: "object" } }]
      },
      post: (provider, body, context, options) => provider.postMessages(body, context, options),
      response: {
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 2 },
        content: [{ type: "tool_use", name: "step", id: "tool-1", input: {} }]
      }
    }
  ]) {
    let clock = 100;
    const recorded = [];
    const budgetGuard = {
      record(_usage, _model, meta) {
        recorded.push(meta);
        return { added: 0 };
      }
    };
    const provider = spec.make(budgetGuard, () => clock);
    globalThis.fetch = async () => {
      clock += 37;
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => structuredClone(spec.response)
      };
    };
    const requestContext = {
      channel: "test",
      __requestShape: shape
    };

    await spec.post(provider, spec.body, requestContext, {
      compression: { compressed: true },
      task: "condense",
      attempt: 2
    });
    await spec.post(provider, spec.body, requestContext, {
      compression: { compressed: true },
      task: "condense",
      attempt: 3
    });

    const firstRecord = recorded[0];
    assert.deepEqual(firstRecord.tools, ["step"]);
    assert.equal(firstRecord.provider, spec.body.model.startsWith("claude") ? "anthropic" : "openai");
    assert.equal(firstRecord.toolSuccessCount, 1);
    assert.equal(firstRecord.toolFailureCount, 1);
    assert.equal(firstRecord.efficiency.requestBytes, Buffer.byteLength(JSON.stringify(spec.body), "utf8"));
    assert.equal(firstRecord.efficiency.provider, firstRecord.provider);
    assert.equal(firstRecord.efficiency.toolCount, 7);
    assert.equal(firstRecord.efficiency.visibleToolCount, 1);
    assert.equal(firstRecord.efficiency.deferredToolCount, 6);
    assert.equal(firstRecord.efficiency.deferredSchemaBytes, 321);
    assert.equal(firstRecord.efficiency.compression, true);
    assert.equal(firstRecord.efficiency.latencyMs, 37);
    assert.equal(firstRecord.efficiency.stopReason, "completed");
    assert.equal(firstRecord.task, "condense");
    assert.equal(firstRecord.attempt, 2);
    assert.equal(firstRecord.efficiency.toolSuccessCount, 1);
    assert.equal(firstRecord.efficiency.toolFailureCount, 1);
    assert.ok(firstRecord.efficiency.toolSchemaBytes > 0);
    assert.equal(recorded[1].toolSuccessCount, 0, "replayed full-history tool results are not double-counted");
    assert.equal(recorded[1].toolFailureCount, 0, "replayed full-history tool errors are not double-counted");
  }
});

for (const spec of [
  {
    name: "OpenAI",
    make: (budgetGuard) => new OpenAIResponsesProvider({
      apiKey: "test-key",
      maxIterations: 6,
      budgetGuard
    }),
    stub(provider, onRequest) {
      provider.postResponses = async (_body, _context, options) => {
        const n = onRequest(options);
        return {
          id: `resp_${n}`,
          output: [{ type: "function_call", call_id: `call_${n}`, name: "step", arguments: "{}" }]
        };
      };
    },
    registry: openAIToolRegistry
  },
  {
    name: "Anthropic",
    make: (budgetGuard) => new AnthropicProvider({
      apiKey: "test-key",
      maxIterations: 6,
      budgetGuard
    }),
    stub(provider, onRequest) {
      provider.postMessages = async (_body, _context, options) => {
        const n = onRequest(options);
        return {
          id: `msg_${n}`,
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `tool_${n}`, name: "step", input: {} }]
        };
      };
    },
    registry: anthropicToolRegistry
  }
]) {
  test(`${spec.name} re-checks the budget before every iteration and stops locally`, async () => {
    let checks = 0;
    let requests = 0;
    const requestMeta = [];
    const budgetGuard = {
      check() {
        checks += 1;
        if (checks === 3) {
          const error = new Error("test budget reached");
          error.code = "BUDGET_EXCEEDED";
          throw error;
        }
      }
    };
    const provider = spec.make(budgetGuard);
    spec.stub(provider, (options) => {
      requestMeta.push({ task: options.task, attempt: options.attempt });
      return ++requests;
    });
    const events = [];

    const result = await provider.generate({
      input: "keep spending until stopped",
      agent,
      task: "autopilot",
      toolRegistry: spec.registry(),
      context: { __onToolEvent: (event) => events.push(event) }
    });

    assert.equal(result.stopReason, "budget-cap");
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(requests, 2, "the request whose preflight check failed never reaches the provider");
    assert.equal(checks, 3);
    assert.deepEqual(requestMeta, [
      { task: "autopilot", attempt: 1 },
      { task: "autopilot", attempt: 2 }
    ]);
    assert.match(result.text, /OPENAGI_MAX_TURN_USD|budget cap/i);
    assert.deepEqual(events, [
      { phase: "iteration", n: 1, max: 6 },
      { phase: "iteration", n: 2, max: 6 }
    ]);
  });
}

for (const spec of [
  {
    name: "OpenAI",
    make: () => new OpenAIResponsesProvider({
      apiKey: "test-key",
      maxIterations: 4
    }),
    stub(provider, state) {
      provider.postResponses = async (body) => {
        if (state.seeding) {
          return { id: "iteration_seed_openai", output_text: "seed", output: [] };
        }
        if (!body.tools) {
          state.forcedRequests += 1;
          return { id: "iteration_summary_openai", output_text: "bounded", output: [] };
        }
        state.iterationRequests += 1;
        const n = state.iterationRequests;
        await Promise.resolve();
        return {
          id: `iteration_openai_${n}`,
          output: [{
            type: "function_call",
            call_id: `iteration_call_${n}`,
            name: "step",
            arguments: "{}"
          }]
        };
      };
    },
    registry: openAIToolRegistry
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({
      apiKey: "test-key",
      maxIterations: 4
    }),
    stub(provider, state) {
      provider.postMessages = async (body) => {
        if (state.seeding) {
          return {
            id: "iteration_seed_anthropic",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "seed" }]
          };
        }
        if (!body.tools) {
          state.forcedRequests += 1;
          return {
            id: "iteration_summary_anthropic",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "bounded" }]
          };
        }
        state.iterationRequests += 1;
        const n = state.iterationRequests;
        await Promise.resolve();
        return {
          id: `iteration_anthropic_${n}`,
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: `iteration_tool_${n}`,
            name: "step",
            input: {}
          }]
        };
      };
    },
    registry: anthropicToolRegistry
  }
]) {
  test(`${spec.name} shares one aggregate iteration allowance across concurrent children`, async () => {
    const provider = spec.make();
    const state = {
      seeding: true,
      iterationRequests: 0,
      forcedRequests: 0
    };
    spec.stub(provider, state);
    const parentContext = {};

    await provider.generate({
      input: "establish the trusted parent turn",
      agent,
      toolRegistry: spec.registry(),
      context: parentContext
    });
    assert.equal(parentContext.__remainingIterations, 3);
    state.seeding = false;

    const childContexts = Array.from({ length: 3 }, () => ({
      __budgetEnvelope: parentContext.__budgetEnvelope,
      __remainingIterations: parentContext.__remainingIterations
    }));
    const results = await Promise.all(childContexts.map((context, index) => (
      provider.generate({
        input: `parallel child ${index + 1}`,
        agent,
        toolRegistry: spec.registry(),
        context,
        maxIterations: 3
      })
    )));

    assert.equal(
      results.reduce((sum, result) => sum + result.iterations, 0),
      3,
      "three children may consume only the parent's three remaining iterations"
    );
    assert.equal(state.iterationRequests, 3);
    assert.equal(state.forcedRequests, 1, "the shared turn permits one final-answer request");
    assert.deepEqual(
      childContexts
        .map((context) => context.__remainingIterations)
        .sort((left, right) => left - right),
      [0, 1, 2],
      "each child publishes the shared remainder observed at its atomic claim"
    );
  });
}

for (const spec of [
  {
    name: "OpenAI",
    make: (budgetGuard) => new OpenAIResponsesProvider({
      apiKey: "test-key",
      maxIterations: 4,
      maxTurnUsd: 0.5,
      budgetGuard
    }),
    seed: {
      id: "budget_seed_openai",
      usage: { input_tokens: 1, output_tokens: 1 },
      output_text: "seed",
      output: []
    },
    child: {
      id: "budget_child_openai",
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [{
        type: "function_call",
        call_id: "budget_child_call",
        name: "step",
        arguments: "{}"
      }]
    },
    registry: openAIToolRegistry
  },
  {
    name: "Anthropic",
    make: (budgetGuard) => new AnthropicProvider({
      apiKey: "test-key",
      maxIterations: 4,
      maxTurnUsd: 0.5,
      stallTimeoutMs: 0,
      budgetGuard
    }),
    seed: {
      id: "budget_seed_anthropic",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      content: [{ type: "text", text: "seed" }]
    },
    child: {
      id: "budget_child_anthropic",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "budget_child_tool",
        name: "step",
        input: {}
      }]
    },
    registry: anthropicToolRegistry
  }
]) {
  test(`${spec.name} serializes concurrent charges against one trusted turn budget`, async (t) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let releaseFirstChild;
    const firstChildBlocked = new Promise((resolve) => {
      releaseFirstChild = resolve;
    });
    t.after(() => {
      releaseFirstChild();
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 2) await firstChildBlocked;
      const response = fetchCalls === 1 ? spec.seed : spec.child;
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => structuredClone(response)
      };
    };
    let records = 0;
    const budgetGuard = {
      check() {},
      record() {
        records += 1;
        return { added: records === 1 ? 0 : 0.6 };
      }
    };
    const provider = spec.make(budgetGuard);
    const parentContext = {};

    await provider.generate({
      input: "establish the trusted parent budget",
      agent,
      toolRegistry: spec.registry(),
      context: parentContext
    });
    const childContexts = Array.from({ length: 3 }, () => ({
      __budgetEnvelope: parentContext.__budgetEnvelope,
      __remainingIterations: parentContext.__remainingIterations
    }));
    const running = childContexts.map((context, index) => provider.generate({
      input: `budget child ${index + 1}`,
      agent,
      toolRegistry: spec.registry(),
      context,
      maxIterations: 3
    }));

    await waitFor(() => fetchCalls >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      fetchCalls,
      2,
      "only the first child reaches HTTP while its charge is unresolved"
    );
    releaseFirstChild();
    const results = await Promise.all(running);

    assert.equal(fetchCalls, 2, "the recorded first-child spend blocks both queued requests");
    assert.equal(records, 2);
    assert.deepEqual(results.map((result) => result.stopReason), [
      "budget-cap",
      "budget-cap",
      "budget-cap"
    ]);
  });
}

for (const spec of [
  {
    name: "OpenAI",
    make: (budgetGuard) => new OpenAIResponsesProvider({
      apiKey: "test-key",
      maxIterations: 3,
      maxTurnUsd: 0.5,
      budgetGuard
    }),
    stub(provider, onRequest) {
      provider.postResponses = async (_body, _context, options) => {
        const n = onRequest();
        options.turnBudget.spentUsd += 0.6;
        return {
          id: `shared_openai_${n}`,
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [{
            type: "function_call",
            call_id: `shared_call_${n}`,
            name: "step",
            arguments: "{}"
          }]
        };
      };
    },
    registry: openAIToolRegistry
  },
  {
    name: "Anthropic",
    make: (budgetGuard) => new AnthropicProvider({
      apiKey: "test-key",
      maxIterations: 3,
      maxTurnUsd: 0.5,
      budgetGuard
    }),
    stub(provider, onRequest) {
      provider.postMessages = async (_body, _context, options) => {
        const n = onRequest();
        options.turnBudget.spentUsd += 0.6;
        return {
          id: `shared_anthropic_${n}`,
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: `shared_tool_${n}`,
            name: "step",
            input: {}
          }]
        };
      };
    },
    registry: anthropicToolRegistry
  }
]) {
  test(`${spec.name} carries one trusted spend envelope into child provider turns`, async () => {
    let requests = 0;
    const budgetGuard = {
      check() {},
      record() {
        return { added: 0.6 };
      }
    };
    const provider = spec.make(budgetGuard);
    spec.stub(provider, () => ++requests);
    const context = {};

    const parent = await provider.generate({
      input: "parent work",
      agent,
      toolRegistry: spec.registry(),
      context
    });
    assert.equal(parent.stopReason, "budget-cap");
    assert.equal(requests, 1);
    assert.ok(context.__budgetEnvelope);

    const child = await provider.generate({
      input: "child work",
      agent,
      toolRegistry: spec.registry(),
      context
    });
    assert.equal(child.stopReason, "budget-cap");
    assert.equal(requests, 1, "the inherited spend blocks a child request");
  });
}

for (const spec of [
  {
    name: "OpenAI",
    make: (budgetGuard) => new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 4, budgetGuard }),
    response: {
      id: "openai_spend",
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ type: "function_call", call_id: "call_1", name: "step", arguments: "{}" }]
    },
    registry: openAIToolRegistry
  },
  {
    name: "Anthropic",
    make: (budgetGuard) => new AnthropicProvider({ apiKey: "test-key", maxIterations: 4, budgetGuard }),
    response: {
      id: "anthropic_spend",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool_1", name: "step", input: {} }]
    },
    registry: anthropicToolRegistry
  }
]) {
  test(`${spec.name} enforces OPENAGI_MAX_TURN_USD using recorded request cost`, async (t) => {
    isolateIterationEnv(t);
    process.env.OPENAGI_MAX_TURN_USD = "0.50";
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      return { ok: true, json: async () => structuredClone(spec.response) };
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const budgetGuard = {
      check() {},
      record() { return { added: 0.60 }; }
    };

    const result = await spec.make(budgetGuard).generate({
      input: "bounded paid task",
      agent,
      toolRegistry: spec.registry()
    });

    assert.equal(result.stopReason, "budget-cap");
    assert.equal(result.iterations, 1);
    assert.equal(requests, 1, "recorded spend blocks the next paid request");
  });
}

for (const spec of [
  {
    name: "OpenAI",
    make: () => new OpenAIResponsesProvider({ apiKey: "test-key", maxIterations: 5, maxTurnSeconds: 0.01, wallClockCheckpoints: 0 }),
    stub(provider) {
      provider.postResponses = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ id: "late", output_text: "too late", output: [] }), 50);
      });
    }
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({ apiKey: "test-key", maxIterations: 5, maxTurnSeconds: 0.01, wallClockCheckpoints: 0 }),
    stub(provider) {
      provider.postMessages = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ id: "late", stop_reason: "end_turn", content: [{ type: "text", text: "too late" }] }), 50);
      });
    }
  }
]) {
  test(`${spec.name} wall-clock guard forces an answer or a graceful summary`, async () => {
    // wallClockCheckpoints: 0 pins the legacy hard-stop path: the first
    // deadline breach cuts the turn and forces a final answer.
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
    // The turn was cut short by the wall-clock guard; the harness then forces a
    // final answer (no tools). With these stubs that forced call returns model
    // text ("too late"); if it could not, a canned wall-clock summary is used.
    // Either way the user gets a real reply, never a raw abort.
    assert.ok(
      /too late/.test(result.text) || /OPENAGI_MAX_TURN_SECONDS|wall-clock/i.test(result.text),
      `expected a forced answer or a wall-clock summary, got: ${result.text}`
    );
    assert.deepEqual(events, [{ phase: "iteration", n: 1, max: 5 }]);
  });
}

// Soft wall-clock checkpoints: when the turn budget is reached the guard pings
// the model with a status check and EXTENDS the deadline instead of stopping.
// A model that still has work keeps working; the turn ends normally.
test("a wall-clock checkpoint pings, extends, and the turn finishes normally", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxTurnSeconds: 0.01,
    wallClockCheckpoints: 1
  });
  let calls = 0;
  provider.postResponses = async () => {
    calls += 1;
    if (calls === 1) {
      // Slow first hop: blows past the 10ms deadline and trips the guard.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: "tool", output: [{ type: "function_call", call_id: "c1", name: "step", arguments: "{}" }] };
    }
    return { id: "done", output_text: "finished after checkpoint", output: [] };
  };
  const events = [];
  const result = await provider.generate({
    input: "slow then fast",
    agent,
    toolRegistry: openAIToolRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });
  assert.notEqual(result.stopReason, "turn-timeout");
  assert.match(result.text, /finished after checkpoint/);
  assert.ok(
    events.some((e) => e.phase === "wall-clock-checkpoint" && e.idleStrikesLeft === 0),
    `expected a wall-clock-checkpoint event, got: ${JSON.stringify(events)}`
  );
});

test("checkpoint budget exhaustion still hard-stops with turn-timeout", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxTurnSeconds: 0.01,
    wallClockCheckpoints: 1
  });
  provider.postResponses = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { id: "late", output_text: "too late", output: [] };
  };
  const result = await provider.generate({ input: "always slow", agent });
  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(result.iterations, 2, "one checkpoint extension, then the hard stop");
  assert.ok(
    /too late/.test(result.text) || /OPENAGI_MAX_TURN_SECONDS|wall-clock/i.test(result.text),
    `expected a forced answer or a wall-clock summary, got: ${result.text}`
  );
});

test("idle exhaustion summary names the consumed allowances and blames idleness, not time", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxTurnSeconds: 0.01,
    wallClockCheckpoints: 1
  });
  let calls = 0;
  provider.postResponses = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The forced final answer yields no text, so the turn must fall back to
    // the canned summary — which now reports idle-allowance usage.
    if (calls >= 3) return { id: "forced", output: [] };
    return { id: "late", output_text: "still working", output: [] };
  };
  const result = await provider.generate({ input: "always slow", agent });
  assert.equal(result.stopReason, "turn-timeout");
  assert.match(
    result.text,
    /All 1 idle allowance were consumed without new output/,
    `expected the summary to name the consumed allowance, got: ${result.text}`
  );
  // The stop must be attributed to going idle, never to running long.
  assert.match(result.text, /stopped as STALLED/);
  assert.match(result.text, /NOT stopped for elapsed time/);
});

// REGRESSION: a single slow model request (fetch exceeds the per-request
// timeout) must NOT kill the whole turn with a raw undici "This operation was
// aborted". It must be normalized and surface a graceful reply. This is the
// root cause of the live "operation was aborted" turn-errors that gave no reply.
// With stall detection DISABLED (OPENAGI_STALL_TIMEOUT_MS=0) the fixed
// per-request timeout is the sole guard and the classification is request-timeout.
for (const spec of [
  {
    name: "OpenAI",
    make: () => new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 30, stallTimeoutMs: 0 })
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 30, stallTimeoutMs: 0 })
  }
]) {
  test(`${spec.name} a per-request timeout stops gracefully, never leaking a raw abort`, async (t) => {
    const provider = spec.make();
    // fetch hangs forever; the provider's own 30ms request timer must abort it,
    // and that abort must be classified as a recoverable request-timeout.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    let result;
    await assert.doesNotReject(async () => {
      result = await provider.generate({ input: "slow first hop", agent });
    }, "a per-request timeout must not throw out of generate()");
    assert.equal(result.stopReason, "request-timeout");
    assert.equal(result.iterations, 1);
    assert.doesNotMatch(result.text, /This operation was aborted/, "the raw undici abort string must never reach the user");
    assert.match(result.text, /request timeout|OPENAGI_REQUEST_TIMEOUT_MS/i);
  });
}

// A model that goes SILENT mid-stream (no tokens for the stall window) must be
// classified as a recoverable stall — never a raw abort — and still produce a
// reply. This is the "check if the LLM is still trying" behaviour: total silence
// past the window trips it; a model still emitting tokens would not (covered by
// the "slow but alive" test below).
test("Anthropic classifies a silent stream as a stall and still replies", async (t) => {
  const provider = new AnthropicProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 5000, stallTimeoutMs: 30, forceAnswerMs: 30 });
  const originalFetch = globalThis.fetch;
  let call = 0;
  // First call: streaming body that never yields a chunk → pure silence (stall).
  // Second call: the forced "answer now" call (non-streaming) also goes silent
  // here, so the harness must fall back to the canned stall summary. Proves the
  // whole path survives even when the force-answer itself can't complete.
  globalThis.fetch = async (_url, opts) => {
    call += 1;
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      json: async () => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      }),
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            }, { once: true });
          })
        })
      }
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  let result;
  await assert.doesNotReject(async () => {
    result = await provider.generate({ input: "model goes quiet", agent });
  });
  assert.equal(result.stopReason, "stalled");
  assert.doesNotMatch(result.text, /This operation was aborted/);
  assert.match(result.text, /stall|silent|OPENAGI_STALL_TIMEOUT_MS/i);
});

// A model that keeps emitting tokens — even slowly, past the stall window in
// TOTAL but never idle for the window — must NOT be aborted. The stall timer
// resets on every streamed chunk (the "is it still trying?" signal).
test("Anthropic does NOT abort a slow-but-alive stream that keeps emitting tokens", async (t) => {
  const provider = new AnthropicProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 5000, stallTimeoutMs: 40 });
  const originalFetch = globalThis.fetch;
  const enc = new TextEncoder();
  // Emit 6 text deltas 20ms apart (120ms total > 40ms stall window), then end.
  // No single gap exceeds the window, so the turn must complete normally.
  const chunks = [];
  chunks.push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", role: "assistant", content: [], usage: {} } })}\n\n`);
  chunks.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  for (let i = 0; i < 6; i += 1) {
    chunks.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `tok${i} ` } })}\n\n`);
  }
  chunks.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  chunks.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
  globalThis.fetch = async () => {
    let i = 0;
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          read: () => new Promise((resolve) => {
            if (i >= chunks.length) { resolve({ done: true, value: undefined }); return; }
            const value = enc.encode(chunks[i]); i += 1;
            setTimeout(() => resolve({ done: false, value }), 20);
          })
        })
      }
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await provider.generate({ input: "slow but alive", agent });
  assert.equal(result.stopReason, "completed", "a still-emitting model must not be stalled");
  assert.match(result.text, /tok0.*tok5/s);
});

test("OPENAGI_REQUEST_TIMEOUT_MS overrides the default per-request timeout on both providers", (t) => {
  const saved = process.env.OPENAGI_REQUEST_TIMEOUT_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.OPENAGI_REQUEST_TIMEOUT_MS;
    else process.env.OPENAGI_REQUEST_TIMEOUT_MS = saved;
  });
  // Default is 300s (raised from the old hard-coded 120s so a heavy reasoning
  // hop no longer aborts the turn).
  delete process.env.OPENAGI_REQUEST_TIMEOUT_MS;
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test" }).timeoutMs, 300000);
  assert.equal(new AnthropicProvider({ apiKey: "test" }).timeoutMs, 300000);
  process.env.OPENAGI_REQUEST_TIMEOUT_MS = "60000";
  assert.equal(new OpenAIResponsesProvider({ apiKey: "test" }).timeoutMs, 60000);
  assert.equal(new AnthropicProvider({ apiKey: "test" }).timeoutMs, 60000);
  // An explicit constructor option still wins over the env var.
  assert.equal(new AnthropicProvider({ apiKey: "test", timeoutMs: 5000 }).timeoutMs, 5000);
});

test("the wall-clock guard also bounds a tool invocation that never settles", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 5,
    maxTurnSeconds: 0.01,
    wallClockCheckpoints: 0
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

test("Discord live status preserves and labels a budget-capped turn", async () => {
  const edits = [];
  let deletes = 0;
  const channel = {
    rest: async (_path, options) => { edits.push(options.body); },
    deleteMessage: async () => { deletes += 1; },
    refreshIdlePresence() {}
  };
  const status = new LiveStatus(channel, "channel", true);
  status.messageId = "status";
  status.onEvent({ phase: "iteration", n: 2, max: 25 });
  if (status.editTimer) clearTimeout(status.editTimer);
  status.editTimer = null;

  await status.finish({ model: { stopReason: "budget-cap", iterations: 2 } });

  assert.equal(deletes, 0, "a capped no-tool turn keeps its status instead of disappearing");
  assert.match(edits.at(-1).embeds[0].description, /budget-cap/);
  const fallback = formatEmptyTurnFallback({
    model: { stopReason: "budget-cap", iterations: 2 }
  });
  assert.match(fallback, /OPENAGI_MAX_TURN_USD/);
});

test("the deterministic provider remains compatible with iteration-aware callers", async () => {
  const provider = new DeterministicModelProvider();
  const result = await provider.generate({ input: "hello", agent, context: { __onToolEvent() {} } });
  assert.equal(result.provider, "deterministic");
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /Hey/);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached before timeout");
}

// ── Vision plumbing: inbound images attach to the current user turn ──────
const PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("Anthropic attaches inbound images as base64 image blocks on the user turn", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", maxIterations: 2 });
  let sent = null;
  provider.postMessages = async (body) => {
    sent = structuredClone(body);
    return { id: "m1", role: "assistant", content: [{ type: "text", text: "I see a red pixel." }], stop_reason: "end_turn" };
  };
  const result = await provider.generate({
    input: "what is this?",
    agent,
    toolRegistry: anthropicToolRegistry(),
    images: [{ mediaType: "image/png", data: PX }]
  });
  assert.match(result.text, /red pixel/);
  const userTurn = sent.messages.at(-1);
  assert.equal(userTurn.role, "user");
  assert.ok(Array.isArray(userTurn.content), "image turn uses a content block array");
  const imgBlock = userTurn.content.find((b) => b.type === "image");
  assert.ok(imgBlock, "an image block is present");
  assert.equal(imgBlock.source.type, "base64");
  assert.equal(imgBlock.source.media_type, "image/png");
  assert.equal(imgBlock.source.data, PX);
  assert.ok(userTurn.content.some((b) => b.type === "text" && /what is this/.test(b.text)), "the caption text rides along");
});

test("Anthropic marks text-only turns with a rolling cache breakpoint", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", maxIterations: 2 });
  let sent = null;
  provider.postMessages = async (body) => {
    sent = structuredClone(body);
    return { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
  };
  await provider.generate({ input: "no image here", agent, toolRegistry: anthropicToolRegistry() });
  const content = sent.messages.at(-1).content;
  assert.deepEqual(content, [{
    type: "text",
    text: "no image here",
    cache_control: { type: "ephemeral" }
  }]);
});

test("OpenAI attaches inbound images as input_image blocks on the user turn", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 2 });
  let sent = null;
  provider.postResponses = async (body) => {
    sent = structuredClone(body);
    return { id: "r1", status: "completed", output_text: "I see it.", output: [] };
  };
  await provider.generate({
    input: "describe",
    agent,
    toolRegistry: openAIToolRegistry(),
    images: [{ mediaType: "image/png", data: PX }]
  });
  const userTurn = sent.input.at(-1);
  assert.equal(userTurn.role, "user");
  assert.ok(Array.isArray(userTurn.content));
  const imgBlock = userTurn.content.find((b) => b.type === "input_image");
  assert.ok(imgBlock, "an input_image block is present");
  assert.match(imgBlock.image_url, /^data:image\/png;base64,/);
});

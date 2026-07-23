import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  resolveModelContextWindowTokens,
  withAnthropicCacheBreakpoints
} from "../src/model-provider.js";
import { estimateContextTokens } from "../src/memory-condenser.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function history(count, width = 24) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `history-${index}-${"x".repeat(width)}`
  }));
}

function openAITools() {
  return [{ type: "function", name: "step", description: "one step", parameters: { type: "object" } }];
}

function openAIRegistry() {
  return { invoke: async () => ({ ok: true, result: { stepped: true } }) };
}

function anthropicRegistry() {
  return {
    toAnthropicTools: () => [{ name: "step", description: "one step", input_schema: { type: "object" } }],
    invoke: async () => ({ ok: true, result: { stepped: true } })
  };
}

function countCacheMarkers(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheMarkers(item), 0);
  if (!value || typeof value !== "object") return 0;
  return (Object.hasOwn(value, "cache_control") ? 1 : 0)
    + Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .reduce((sum, [, item]) => sum + countCacheMarkers(item), 0);
}

test("histories longer than twelve messages survive below both thresholds", async () => {
  const messages = history(14, 4);
  const original = structuredClone(messages);

  const openai = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 1_000_000,
    contextEstimateCharsPerToken: 16
  });
  let openAIBody;
  openai.postResponses = async (body) => {
    openAIBody = structuredClone(body);
    return { id: "openai-done", output_text: "done", output: [] };
  };
  await openai.generate({ input: "current", instructions: "static", messages });
  assert.equal(openAIBody.input.length, 15);
  assert.equal(JSON.stringify(openAIBody).includes("[context summary]"), false);

  const anthropic = new AnthropicProvider({
    apiKey: "anthropic-test-key",
    contextWindowTokens: 1_000_000,
    contextEstimateCharsPerToken: 16,
    stallTimeoutMs: 0
  });
  let anthropicBody;
  anthropic.postMessages = async (body) => {
    anthropicBody = structuredClone(body);
    return { id: "anthropic-done", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  };
  await anthropic.generate({ input: "current", instructions: "static", messages });
  assert.equal(anthropicBody.messages.length, 15);
  assert.equal(JSON.stringify(anthropicBody).includes("[context summary]"), false);
  assert.deepEqual(messages, original, "provider working copies never mutate durable history");
});

test("context windows resolve from the request model with a safe override", () => {
  assert.equal(resolveModelContextWindowTokens("gpt-5", { provider: "openai" }), 400_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.1-2025-11-13", { provider: "openai" }), 400_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.2", { provider: "openai" }), 400_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.4", { provider: "openai" }), 1_050_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.4-mini", { provider: "openai" }), 400_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.5", { provider: "openai" }), 1_050_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.6-terra", { provider: "openai" }), 1_050_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5-chat-latest", { provider: "openai" }), 128_000);
  assert.equal(resolveModelContextWindowTokens("gpt-5.2-chat-latest", { provider: "openai" }), 128_000);
  assert.equal(resolveModelContextWindowTokens("o3", { provider: "openai" }), 200_000);
  assert.equal(resolveModelContextWindowTokens("o4-mini", { provider: "openai" }), 200_000);
  assert.equal(resolveModelContextWindowTokens("claude-sonnet-4-6", { provider: "anthropic" }), 1_000_000);
  assert.equal(resolveModelContextWindowTokens("claude-haiku-4-5", { provider: "anthropic" }), 200_000);
  assert.equal(resolveModelContextWindowTokens("claude-sonnet-4-5-20250929", { provider: "anthropic" }), 200_000);
  assert.equal(resolveModelContextWindowTokens("claude-custom-future", { provider: "anthropic" }), null);
  assert.equal(resolveModelContextWindowTokens("kimi-k3", { provider: "anthropic" }), 1_000_000);
  assert.equal(resolveModelContextWindowTokens("k3", { provider: "anthropic" }), 262_144);
  assert.equal(resolveModelContextWindowTokens("kimi-for-coding", { provider: "anthropic" }), 262_144);
  assert.equal(resolveModelContextWindowTokens("kimi-for-coding-highspeed", { provider: "anthropic" }), 262_144);
  assert.equal(resolveModelContextWindowTokens("k3", { provider: "anthropic", configured: 1_048_576 }), 1_048_576);
  assert.equal(resolveModelContextWindowTokens("custom-openai-model", { provider: "openai" }), null);
  assert.equal(resolveModelContextWindowTokens("custom", { provider: "anthropic", configured: 777 }), 777);
  assert.equal(resolveModelContextWindowTokens("dynamic", {
    provider: "openai",
    configured: (model) => model === "dynamic" ? 321 : null
  }), 321);
});

test("OpenAI actual usage at fifty percent compresses before the next request", async () => {
  const messages = history(10, 40);
  const recent = structuredClone(messages.slice(-4));
  const bodies = [];
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 100_000,
    contextEstimateCharsPerToken: 16,
    contextKeepRecentHops: 2,
    maxIterations: 3
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? {
          id: "openai-tool",
          usage: { input_tokens: 50_000 },
          output: [{ type: "function_call", call_id: "call-1", name: "step", arguments: "{}" }]
        }
      : { id: "openai-done", usage: { input_tokens: 20 }, output_text: "done", output: [] };
  };

  await provider.generate({
    input: "current",
    instructions: "static",
    messages,
    tools: openAITools(),
    toolRegistry: openAIRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });

  assert.equal(bodies.length, 2);
  assert.equal(JSON.stringify(bodies[0]).includes("[context summary]"), false);
  assert.equal(JSON.stringify(bodies[1]).includes("[context summary]"), true);
  assert.deepEqual(bodies[1].input.slice(1, 1 + recent.length), recent);
  assert.ok(events.some((event) => event.phase === "context-compression" && event.reason === "actual-50"));
  assert.equal(JSON.stringify(bodies).includes("cache_control"), false);
});

test("OpenAI actual usage below fifty percent does not trigger compression", async () => {
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 100_000,
    contextEstimateCharsPerToken: 16,
    contextKeepRecentHops: 2,
    maxIterations: 3
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? {
          id: "openai-tool",
          usage: { input_tokens: 49_999 },
          output: [{ type: "function_call", call_id: "call-1", name: "step", arguments: "{}" }]
        }
      : { id: "openai-done", output_text: "done", output: [] };
  };
  await provider.generate({
    input: "current",
    instructions: "static",
    messages: history(10, 40),
    tools: openAITools(),
    toolRegistry: openAIRegistry()
  });
  assert.equal(JSON.stringify(bodies[1]).includes("[context summary]"), false);
});

test("the actual threshold also protects the OpenAI force-answer request", async () => {
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 100_000,
    contextEstimateCharsPerToken: 16,
    contextKeepRecentHops: 2,
    maxIterations: 1
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? {
          id: "openai-tool",
          usage: { input_tokens: 50_000 },
          output: [{ type: "function_call", call_id: "call-1", name: "step", arguments: "{}" }]
        }
      : { id: "forced", output_text: "forced answer", output: [] };
  };
  const result = await provider.generate({
    input: "current",
    instructions: "static",
    messages: history(10, 40),
    tools: openAITools(),
    toolRegistry: openAIRegistry()
  });
  assert.equal(result.text, "forced answer");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(JSON.stringify(bodies[1]).includes("[context summary]"), true);
});

test("Anthropic cached usage contributes to the exact fifty-percent trigger", async () => {
  const bodies = [];
  const events = [];
  const provider = new AnthropicProvider({
    apiKey: "anthropic-test-key",
    contextWindowTokens: 100,
    contextEstimateCharsPerToken: 16,
    contextKeepRecentHops: 2,
    maxIterations: 3,
    stallTimeoutMs: 0
  });
  provider.postMessages = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? {
          id: "anthropic-tool",
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 25
          },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "use-1", name: "step", input: {} }]
        }
      : {
          id: "anthropic-done",
          usage: { input_tokens: 10 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
  };
  await provider.generate({
    input: "current",
    instructions: "s",
    messages: history(8, 2),
    toolRegistry: anthropicRegistry(),
    context: { __onToolEvent: (event) => events.push(event) }
  });
  assert.equal(JSON.stringify(bodies[1]).includes("[context summary]"), true);
  assert.ok(events.some((event) => event.phase === "context-compression" && event.reason === "actual-50"));
});

test("the eighty-five-percent estimate compresses before the first request", async () => {
  const messages = history(30, 200);
  const original = structuredClone(messages);
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 1000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2
  });
  let body;
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return { id: "done", output_text: "done", output: [] };
  };
  await provider.generate({
    input: "current",
    instructions: "static",
    messages,
    context: { __onToolEvent: (event) => events.push(event) }
  });
  assert.equal(JSON.stringify(body).includes("[context summary]"), true);
  assert.ok(events.some((event) => (
    event.phase === "context-compression"
    && event.reason === "estimated-85"
    && event.estimatedInputTokens < 850
  )));
  assert.ok(estimateContextTokens(body, { charsPerToken: 4 }) < 850);
  assert.deepEqual(messages, original);
});

test("adaptive compression shrinks from the emitted marker instead of the configured cap", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 168,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 4000
  });
  let body;
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return { id: "done", output_text: "done", output: [] };
  };

  await provider.generate({
    input: "current",
    instructions: "static",
    messages: history(10, 20)
  });

  const marker = body.input.find((item) => (
    typeof item?.content === "string" && item.content.startsWith("[context summary]")
  ));
  assert.ok(marker);
  assert.ok(marker.content.length > 40, "the fitting digest should not collapse to the minimum");
  assert.ok(estimateContextTokens(body, { charsPerToken: 4 }) < 168 * 0.85);
});

test("repeated OpenAI compression replaces its prior summary and keeps the loop live", async () => {
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 1000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 1,
    contextDigestChars: 120,
    maxIterations: 12
  });
  provider.postResponses = async (request) => {
    bodies.push(structuredClone(request));
    const hop = bodies.length;
    return hop < 9
      ? {
          id: `tool-${hop}`,
          usage: { input_tokens: 500 },
          output: [{ type: "function_call", call_id: `call-${hop}`, name: "step", arguments: "{}" }]
        }
      : { id: "done", usage: { input_tokens: 500 }, output_text: "done", output: [] };
  };

  const result = await provider.generate({
    input: "current",
    instructions: "static",
    messages: [],
    tools: openAITools(),
    toolRegistry: {
      invoke: async () => ({ ok: true, result: { output: "x".repeat(380) } })
    }
  });

  assert.equal(result.text, "done");
  assert.equal(bodies.length, 9, "compressible old hops must not block later paid requests");
  const markerCounts = [];
  for (const body of bodies.slice(1)) {
    const markers = body.input.filter((item) => (
        typeof item?.content === "string" && item.content.startsWith("[context summary]")
      )).length;
    markerCounts.push(markers);
    assert.ok(markers <= 1, "each request should replace rather than accumulate synthetic summaries");
    assert.deepEqual(body.input[0], { role: "user", content: "current" });
    assert.ok(estimateContextTokens(body, { charsPerToken: 4 }) < 850);
  }
  assert.ok(markerCounts.includes(1));
  assert.equal(markerCounts.at(-1), 1);
});

test("the gateway gate refuses a request when the recent verbatim suffix cannot fit", async () => {
  let requests = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 100,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2
  });
  provider.postResponses = async () => {
    requests += 1;
    return { id: "unexpected", output_text: "unexpected", output: [] };
  };

  const result = await provider.generate({
    input: "current",
    instructions: "static",
    messages: history(10, 220)
  });

  assert.equal(requests, 0);
  assert.equal(result.stopReason, "context-too-large");
  assert.match(result.text, /oversized model request/);
});

test("goal preemption during compression prevents the paid request for both providers", async (t) => {
  const cases = [
    {
      name: "openai",
      create: () => new OpenAIResponsesProvider({
        apiKey: "openai-test-key",
        contextWindowTokens: 1000,
        contextEstimateCharsPerToken: 4,
        contextKeepRecentHops: 2
      }),
      run: (provider, context) => provider.generate({
        input: "current",
        instructions: "static",
        messages: history(30, 200),
        context
      }),
      stub: (provider, onRequest) => { provider.postResponses = onRequest; }
    },
    {
      name: "anthropic",
      create: () => new AnthropicProvider({
        apiKey: "anthropic-test-key",
        contextWindowTokens: 1000,
        contextEstimateCharsPerToken: 4,
        contextKeepRecentHops: 2,
        stallTimeoutMs: 0
      }),
      run: (provider, context) => provider.generate({
        input: "current",
        instructions: "static",
        messages: history(30, 200),
        context
      }),
      stub: (provider, onRequest) => { provider.postMessages = onRequest; }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let requests = 0;
      let goal = { status: "active", revision: 1 };
      const runtime = { goals: { get: () => goal } };
      const context = {
        runtime,
        sessionId: `preempt-${entry.name}`,
        __onToolEvent: (event) => {
          if (event.phase === "context-compression") goal = { status: "paused", revision: 2 };
        }
      };
      const provider = entry.create();
      entry.stub(provider, async () => {
        requests += 1;
        throw new Error("provider request must not run after preemption");
      });

      const result = await entry.run(provider, context);
      assert.equal(requests, 0);
      assert.equal(result.stopReason, "goal-preempted");
      assert.equal(goal.revision, 2);
    });
  }
});

test("goal preemption during force-answer compression skips the forced request", async (t) => {
  const cases = [
    {
      name: "openai",
      create: () => new OpenAIResponsesProvider({
        apiKey: "openai-test-key",
        contextWindowTokens: 1000,
        contextEstimateCharsPerToken: 4,
        contextKeepRecentHops: 1,
        maxIterations: 1
      }),
      run: (provider, context) => provider.generate({
        input: "current",
        instructions: "static",
        messages: history(10, 40),
        tools: openAITools(),
        toolRegistry: openAIRegistry(),
        context
      }),
      stub: (provider, onRequest) => {
        provider.postResponses = async () => onRequest({
          id: "tool",
          usage: { input_tokens: 500 },
          output: [{ type: "function_call", call_id: "call-1", name: "step", arguments: "{}" }]
        });
      }
    },
    {
      name: "anthropic",
      create: () => new AnthropicProvider({
        apiKey: "anthropic-test-key",
        contextWindowTokens: 1000,
        contextEstimateCharsPerToken: 4,
        contextKeepRecentHops: 1,
        maxIterations: 1,
        stallTimeoutMs: 0
      }),
      run: (provider, context) => provider.generate({
        input: "current",
        instructions: "static",
        messages: history(10, 40),
        toolRegistry: anthropicRegistry(),
        context
      }),
      stub: (provider, onRequest) => {
        provider.postMessages = async () => onRequest({
          id: "tool",
          usage: { input_tokens: 500 },
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "use-1", name: "step", input: {} }]
        });
      }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let requests = 0;
      let goal = { status: "active", revision: 1 };
      const context = {
        runtime: { goals: { get: () => goal } },
        sessionId: `force-preempt-${entry.name}`,
        __onToolEvent: (event) => {
          if (event.phase === "context-compression") goal = { status: "paused", revision: 2 };
        }
      };
      const provider = entry.create();
      entry.stub(provider, (firstResponse) => {
        requests += 1;
        if (requests > 1) throw new Error("forced provider request must not run after preemption");
        return firstResponse;
      });

      const result = await entry.run(provider, context);
      assert.equal(requests, 1);
      assert.equal(result.stopReason, "goal-preempted");
    });
  }
});

test("Anthropic cache breakpoints roll over the last three eligible messages", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }]
    },
    { role: "assistant", content: [{ type: "text", text: "answer-one" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "use-1", content: "result" }] },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer-two" }]
    },
    { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }, { type: "text", text: "" }] }
  ];
  const original = structuredClone(messages);
  const first = withAnthropicCacheBreakpoints(messages);
  assert.equal(countCacheMarkers(first), 3);
  assert.equal(countCacheMarkers(first[0]), 0, "a stale prefix marker is removed from the request clone");
  assert.equal(countCacheMarkers(first.at(-1)), 0, "thinking and empty text are never marked");

  const second = withAnthropicCacheBreakpoints([...messages, { role: "user", content: "newest" }]);
  assert.equal(countCacheMarkers(second), 3);
  assert.equal(countCacheMarkers(second[1]), 0, "the three-message window rolls forward");
  assert.equal(countCacheMarkers(second.at(-1)), 1);
  assert.equal(
    countCacheMarkers(withAnthropicCacheBreakpoints([...messages, { role: "user", content: "newest" }], { maxMessages: 99 })),
    3,
    "the public helper cannot exceed the provider breakpoint limit"
  );
  assert.deepEqual(messages, original, "rolling markers never mutate canonical messages");
});

test("Anthropic marker cleanup preserves semantic cache_control tool data", () => {
  const messages = [
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "use-1",
        name: "configure",
        input: { cache_control: "semantic-user-value", nested: { cache_control: 7 } },
        cache_control: { type: "ephemeral" }
      }]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "use-1",
        content: { cache_control: "result-value", nested: { cache_control: 9 } }
      }]
    }
  ];
  const original = structuredClone(messages);
  const marked = withAnthropicCacheBreakpoints(messages);

  assert.deepEqual(marked[0].content[0].input, original[0].content[0].input);
  assert.deepEqual(marked[1].content[0].content, original[1].content[0].content);
  assert.deepEqual(marked[0].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(marked[1].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(messages, original);
});

test("Anthropic image-only messages are eligible rolling breakpoints", () => {
  const marked = withAnthropicCacheBreakpoints([{
    role: "user",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]
  }], { maxMessages: 1 });
  assert.deepEqual(marked[0].content[0].cache_control, { type: "ephemeral" });
});

test("system plus rolling Anthropic messages uses exactly four cache breakpoints", async () => {
  const provider = new AnthropicProvider({
    apiKey: "anthropic-test-key",
    contextWindowTokens: 1_000_000,
    stallTimeoutMs: 0
  });
  let body;
  provider.postMessages = async (request) => {
    body = structuredClone(request);
    return { id: "done", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  };
  await provider.generate({ input: "current", instructions: "static", messages: history(6, 3) });
  assert.equal(countCacheMarkers(body.system), 1);
  assert.equal(countCacheMarkers(body.messages), 3);
  assert.equal(countCacheMarkers(body), 4);
});

test("mid-session cache identity changes warn without exposing credentials", async () => {
  const runtime = {};
  const warnings = [];
  const models = [];
  const requests = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "first-secret-key",
    model: "gpt-5",
    cacheWarningLog: (message) => warnings.push(message)
  });
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    models.push(body.model);
    return { id: "done", output_text: "done", output: [] };
  };
  const base = { input: "hello", instructions: "static", task: "chat", context: { runtime, sessionId: "same" } };
  await provider.generate(base);
  await provider.generate(base);
  assert.deepEqual(warnings, []);

  provider.model = "gpt-5-mini";
  await provider.generate(base);
  assert.equal(models.at(-1), "gpt-5-mini", "a live model change updates routed chat requests");
  assert.equal(warnings.length, 1);

  provider.apiKey = "second-secret-key";
  await provider.generate(base);
  assert.equal(warnings.length, 2);
  await provider.generate({ ...base, context: { runtime, sessionId: "different" } });
  assert.equal(warnings.length, 2, "a different session establishes its own cache identity");

  const replacementWarnings = [];
  const replacement = new OpenAIResponsesProvider({
    apiKey: "replacement-secret-key",
    model: "gpt-5-mini",
    cacheWarningLog: (message) => replacementWarnings.push(message)
  });
  replacement.postResponses = async () => ({ id: "done", output_text: "done", output: [] });
  await replacement.generate(base);
  assert.equal(replacementWarnings.length, 1, "provider replacement is detected through the runtime scope");

  const warningText = [...warnings, ...replacementWarnings].join("\n");
  assert.doesNotMatch(warningText, /first-secret|second-secret|replacement-secret|[a-f0-9]{32}/i);
  assert.doesNotMatch(JSON.stringify(requests), /cache identity|full-price|first-secret|second-secret/i);
});

test("live model changes update owned routers without overwriting injected routers", () => {
  const owned = new OpenAIResponsesProvider({ apiKey: "test", model: "gpt-5" });
  owned.model = "gpt-5-mini";
  assert.equal(owned.resolveModel({ task: "chat" }), "gpt-5-mini");

  const injected = {
    baseModel: "caller-base",
    resolve: () => "caller-base",
    tierModel: () => "caller-tier"
  };
  const openai = new OpenAIResponsesProvider({ apiKey: "test", model: "provider-base", router: injected });
  const anthropic = new AnthropicProvider({ apiKey: "test", model: "provider-base", router: injected });
  assert.equal(openai.resolveModel({ task: "chat" }), "caller-base");
  assert.equal(anthropic.resolveModel({ tier: "mini" }), "caller-tier");
  assert.equal(injected.baseModel, "caller-base");
});

test("unknown model context windows warn once and never enter the request", async () => {
  const warnings = [];
  const bodies = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "custom-unmapped-model",
    cacheWarningLog: (message) => warnings.push(message)
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return { id: "done", output_text: "done", output: [] };
  };
  await provider.generate({ input: "one", instructions: "static" });
  await provider.generate({ input: "two", instructions: "static" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OPENAGI_CONTEXT_WINDOW_TOKENS/);
  assert.doesNotMatch(JSON.stringify(bodies), /context-window|50%\/85%|OPENAGI_CONTEXT_WINDOW_TOKENS/);
});

test("the context-window override is wizard allowlisted", () => {
  assert.ok(SETUP_FIELDS.includes("OPENAGI_CONTEXT_WINDOW_TOKENS"));
});

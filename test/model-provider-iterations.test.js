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
  "OPENAGI_MAX_TURN_USD"
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
    make: (budgetGuard) => new OpenAIResponsesProvider({
      apiKey: "test-key",
      maxIterations: 6,
      budgetGuard
    }),
    stub(provider, onRequest) {
      provider.postResponses = async () => {
        const n = onRequest();
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
      provider.postMessages = async () => {
        const n = onRequest();
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
    spec.stub(provider, () => ++requests);
    const events = [];

    const result = await provider.generate({
      input: "keep spending until stopped",
      agent,
      toolRegistry: spec.registry(),
      context: { __onToolEvent: (event) => events.push(event) }
    });

    assert.equal(result.stopReason, "budget-cap");
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(requests, 2, "the request whose preflight check failed never reaches the provider");
    assert.equal(checks, 3);
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

// REGRESSION: a single slow model request (fetch exceeds the per-request
// timeout) must NOT kill the whole turn with a raw undici "This operation was
// aborted". It must be normalized to a RequestTimeoutError and surface a
// graceful partial summary. This is the root cause of the live "operation was
// aborted" turn-errors that produced no reply.
for (const spec of [
  {
    name: "OpenAI",
    make: () => new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 30 })
  },
  {
    name: "Anthropic",
    make: () => new AnthropicProvider({ apiKey: "test", maxIterations: 5, maxTurnSeconds: 900, timeoutMs: 30 })
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

test("Anthropic keeps plain-string content when no images are attached", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", maxIterations: 2 });
  let sent = null;
  provider.postMessages = async (body) => {
    sent = structuredClone(body);
    return { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
  };
  await provider.generate({ input: "no image here", agent, toolRegistry: anthropicToolRegistry() });
  assert.equal(typeof sent.messages.at(-1).content, "string");
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

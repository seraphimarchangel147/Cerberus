// Provider retries happen below the tool loop, so transient model failures
// recover without replaying side effects. Transcript tests cover the separate
// corruption case where a turn ends halfway through a tool batch.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  ProviderError,
  reconcileOrphanedToolCalls,
  requestWithRetry
} from "../src/model-provider.js";

function fakeResponse(status, body = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      }
    },
    async json() { return structuredClone(body); }
  };
}

test("requestWithRetry recovers from a retryable 429", async () => {
  const scripted = [
    fakeResponse(429, { error: { message: "slow down" } }),
    fakeResponse(200, { ok: true })
  ];
  const waits = [];
  let attempts = 0;

  const response = await requestWithRetry(async () => scripted[attempts++], {
    retries: 3,
    baseDelayMs: 100,
    random: () => 0.5,
    sleep: async (ms) => { waits.push(ms); }
  });

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [50]);
});

test("requestWithRetry throws typed ProviderError after bounded 5xx retries", async () => {
  let attempts = 0;
  const waits = [];

  await assert.rejects(
    requestWithRetry(async () => {
      attempts += 1;
      return fakeResponse(500, { error: { message: `failure ${attempts}` } });
    }, {
      retries: 2,
      baseDelayMs: 10,
      random: () => 0.5,
      sleep: async (ms) => { waits.push(ms); }
    }),
    (error) => error instanceof ProviderError
      && error.status === 500
      && error.message === "failure 3"
  );

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5, 10]);
});

test("requestWithRetry never retries a non-retryable 400", async () => {
  let attempts = 0;
  await assert.rejects(
    requestWithRetry(async () => {
      attempts += 1;
      return fakeResponse(400, { error: { message: "bad body" } });
    }, { retries: 3, sleep: async () => assert.fail("400 must not sleep") }),
    (error) => error instanceof ProviderError && error.status === 400
  );
  assert.equal(attempts, 1);
});

test("requestWithRetry honors Retry-After ahead of jitter", async () => {
  const waits = [];
  let attempts = 0;
  await requestWithRetry(async () => {
    attempts += 1;
    return attempts === 1
      ? fakeResponse(529, { error: { message: "overloaded" } }, { "retry-after": "2" })
      : fakeResponse(200);
  }, {
    retries: 1,
    baseDelayMs: 10,
    random: () => 0,
    sleep: async (ms) => { waits.push(ms); }
  });
  assert.deepEqual(waits, [2000]);
});

test("orphan reconciliation closes OpenAI and Anthropic tool transcripts", () => {
  const openai = [
    { type: "function_call", call_id: "call-done", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call-done", output: "{}" },
    { type: "function_call", call_id: "call-missing", name: "write", arguments: "{}" }
  ];
  assert.equal(reconcileOrphanedToolCalls(openai, "openai"), 1);
  assert.deepEqual(openai.at(-1), {
    type: "function_call_output",
    call_id: "call-missing",
    output: JSON.stringify({ error: "tool aborted: turn ended before completion" })
  });

  const anthropic = [
    { role: "assistant", content: [
      { type: "tool_use", id: "use-done", name: "read", input: {} },
      { type: "tool_use", id: "use-missing", name: "write", input: {} }
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "use-done", content: "{}", is_error: false }
    ] }
  ];
  assert.equal(reconcileOrphanedToolCalls(anthropic, "anthropic"), 1);
  assert.deepEqual(anthropic.at(-1), {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "use-missing",
      content: JSON.stringify({ error: "tool aborted: turn ended before completion" }),
      is_error: true
    }]
  });
});

test("well-formed transcripts remain byte-identical", () => {
  const openai = [
    { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "{}" }
  ];
  const before = JSON.stringify(openai);
  assert.equal(reconcileOrphanedToolCalls(openai, "openai"), 0);
  assert.equal(JSON.stringify(openai), before);
});

test("an interrupted OpenAI tool batch reaches a real forced answer", async () => {
  let now = 0;
  const requests = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxIterations: 3,
    maxTurnSeconds: 1,
    forceAnswerMs: 100,
    now: () => now
  });
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "first",
        output: [
          { type: "function_call", call_id: "call-1", name: "first_tool", arguments: "{}" },
          { type: "function_call", call_id: "call-2", name: "second_tool", arguments: "{}" }
        ]
      };
    }
    return { id: "forced", output_text: "Recovered from the interrupted batch." };
  };

  const result = await provider.generate({
    input: "do the work",
    instructions: "test",
    tools: [{ type: "function", name: "first_tool" }],
    toolRegistry: {
      async invoke() {
        now = 2000;
        return { ok: true, result: { value: 1 } };
      }
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(result.text, "Recovered from the interrupted batch.");
  assert.equal(requests.length, 2);
  const outputs = requests[1].input.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, 2);
  assert.deepEqual(JSON.parse(outputs[0].output), { value: 1 });
  assert.deepEqual(JSON.parse(outputs[1].output), { error: "tool aborted: turn ended before completion" });
});

test("an interrupted Anthropic tool batch preserves completed results before salvage", async () => {
  let now = 0;
  const requests = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "test-model",
    maxIterations: 3,
    maxTurnSeconds: 1,
    forceAnswerMs: 100,
    stallTimeoutMs: 0,
    now: () => now
  });
  provider.postMessages = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "first",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "use-1", name: "first_tool", input: {} },
          { type: "tool_use", id: "use-2", name: "second_tool", input: {} }
        ]
      };
    }
    return { id: "forced", stop_reason: "end_turn", content: [{ type: "text", text: "Anthropic recovered." }] };
  };

  const result = await provider.generate({
    input: "do the work",
    instructions: "test",
    toolRegistry: {
      toAnthropicTools: () => [{ name: "first_tool", input_schema: { type: "object" } }],
      async invoke() {
        now = 2000;
        return { ok: true, result: { value: 1 } };
      }
    }
  });

  assert.equal(result.stopReason, "turn-timeout");
  assert.equal(result.text, "Anthropic recovered.");
  const results = requests[1].messages.flatMap((message) => (
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "tool_result")
      : []
  ));
  assert.deepEqual(results.map((block) => block.tool_use_id), ["use-1", "use-2"]);
  assert.deepEqual(JSON.parse(results[0].content), { value: 1 });
  assert.equal(results[1].is_error, true);
});

test("exhausted retryable provider errors degrade to a partial answer", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxIterations: 2
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    throw new ProviderError("still unavailable", { status: 503 });
  };

  const result = await provider.generate({ input: "continue", instructions: "test" });
  assert.equal(requests, 2);
  assert.equal(result.stopReason, "provider-error");
  assert.match(result.text, /remained unavailable after bounded retries/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUOTA_BACKOFF_MS,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  classifyProviderOutcome,
  providerBodyHasContent
} from "../src/error-classifier.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function useFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = previous;
  });
}

test("429 quota and billing bodies receive the long backoff or reset delay", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  assert.deepEqual(
    classifyProviderOutcome({
      status: 429,
      body: { error: { code: "insufficient_quota", message: "Billing quota exhausted" } },
      now,
      env: {}
    }),
    { kind: "quota-exhausted", retryAfterMs: DEFAULT_QUOTA_BACKOFF_MS }
  );

  const resetAt = now + 90 * 60 * 1000;
  assert.deepEqual(
    classifyProviderOutcome({
      status: 429,
      body: { error: { message: "Monthly usage limit reached" } },
      headers: { "x-ratelimit-reset": String(resetAt / 1000) },
      now,
      env: {}
    }),
    { kind: "quota-exhausted", retryAfterMs: 90 * 60 * 1000 }
  );
});

test("generic 429 uses a 60-second rate-limit backoff and the kill switch fails open", () => {
  const input = {
    status: 429,
    body: { error: { message: "Too many requests; slow down" } }
  };
  assert.deepEqual(
    classifyProviderOutcome({ ...input, env: {} }),
    { kind: "rate-limit", retryAfterMs: DEFAULT_RATE_LIMIT_BACKOFF_MS }
  );
  assert.equal(
    classifyProviderOutcome({
      ...input,
      env: { OPENAGI_ERROR_CLASSIFIER: "0" }
    }),
    null
  );
});

test("empty HTTP 200 model bodies are silent failures except legitimate stops", () => {
  assert.deepEqual(
    classifyProviderOutcome({
      status: 200,
      body: { stop_reason: "end_turn", content: [] },
      env: {}
    }),
    { kind: "silent-failure", retryAfterMs: null }
  );
  for (const stopReason of ["max_tokens", "tool_use"]) {
    assert.equal(
      classifyProviderOutcome({
        status: 200,
        body: { stop_reason: stopReason, content: [] },
        env: {}
      }),
      null
    );
  }
  assert.equal(providerBodyHasContent({
    output: [{ type: "function_call", name: "read_file", arguments: "{}" }]
  }), true);
  assert.equal(providerBodyHasContent({
    content: [{ type: "text", text: "done" }]
  }), true);
});

test("OpenAI retries an HTTP 200 silent response below the tool loop", async (t) => {
  let calls = 0;
  const waits = [];
  useFetch(t, async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { id: "empty", output: [] })
      : jsonResponse(200, { id: "done", output_text: "recovered", output: [] });
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "test-model",
    providerMaxRetries: 1,
    retryRandom: () => 0,
    retrySleep: async (ms) => waits.push(ms),
    env: {}
  });

  const result = await provider.postResponses({ model: "test-model", input: [] });
  assert.equal(result.output_text, "recovered");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test("Anthropic retries silent content but accepts max_tokens with no text", async (t) => {
  let calls = 0;
  useFetch(t, async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { id: "empty", stop_reason: "end_turn", content: [] })
      : jsonResponse(200, {
          id: "done",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "recovered" }]
        });
  });
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "test-model",
    stallTimeoutMs: 0,
    providerMaxRetries: 1,
    retryRandom: () => 0,
    retrySleep: async () => {},
    env: {}
  });

  const result = await provider.postMessages({
    model: "test-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(result.content[0].text, "recovered");
  assert.equal(calls, 2);

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { id: "bounded", stop_reason: "max_tokens", content: [] });
  };
  const bounded = await provider.postMessages({
    model: "test-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(bounded.stop_reason, "max_tokens");
  assert.equal(calls, 3);
});

test("the error-classifier kill switch preserves the former empty response", async (t) => {
  let calls = 0;
  useFetch(t, async () => {
    calls += 1;
    return jsonResponse(200, { id: "empty", output: [] });
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "test-model",
    providerMaxRetries: 2,
    env: { OPENAGI_ERROR_CLASSIFIER: "0" }
  });

  const result = await provider.postResponses({ model: "test-model", input: [] });
  assert.deepEqual(result.output, []);
  assert.equal(calls, 1);
});

test("the classifier kill switch is setup-wizard persistable", () => {
  assert.equal(SETUP_FIELDS.includes("OPENAGI_ERROR_CLASSIFIER"), true);
});

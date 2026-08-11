// A whole SSE event line that will not parse means the stream was cut
// mid-line or damaged by a proxy — transport truncation, not a model decision.
// It must classify as retryable (failureKind "malformed-stream-event") on both
// provider lanes, while structural protocol violations stay non-retryable.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  readAnthropicEventStream,
  readOpenAIEventStream,
  requestWithRetry
} from "../src/model-provider.js";

function sseResponseFromText(text) {
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes }))
        };
      }
    }
  };
}

function sseResponse(events, { done = true } = {}) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
  return sseResponseFromText(text);
}

const ANTHROPIC_TOOL_STREAM = [
  { type: "message_start", message: { role: "assistant", usage: {} } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "code_edit" } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"src/a.js"}' } },
  { type: "content_block_stop", index: 0 }
];

// A stream cut mid-line: one complete event, then a partial line with no
// trailing newline. The tail flush tries to parse the fragment.
const ANTHROPIC_CUT_LINE = `data: ${JSON.stringify(ANTHROPIC_TOOL_STREAM[0])}\n\ndata: {"type":"content_block_sta`;

const OPENAI_MINIMAL = [
  { type: "response.created", response: { id: "resp-1", object: "response", status: "in_progress", output: [], usage: null } },
  { type: "response.completed", response: { id: "resp-1", object: "response", status: "completed", output: [], usage: null } }
];

test("anthropic: a stream cut mid-line classifies as retryable stream truncation", async () => {
  const error = await readAnthropicEventStream(sseResponseFromText(ANTHROPIC_CUT_LINE)).then(
    () => null,
    (thrown) => thrown
  );
  assert.ok(error instanceof ProviderError, "must not escape as a raw SyntaxError the retry loop ignores");
  assert.equal(error.failureKind, "malformed-stream-event");
  assert.equal(error.providerCode, "malformed_stream_event");
  assert.ok(error.cause, "the underlying parse failure is preserved for diagnostics");
});

test("anthropic: the retry loop recovers a turn whose event line was truncated", async () => {
  let attempts = 0;
  const message = await requestWithRetry(
    () => {
      attempts += 1;
      return attempts === 1
        ? readAnthropicEventStream(sseResponseFromText(ANTHROPIC_CUT_LINE))
        : readAnthropicEventStream(sseResponse(ANTHROPIC_TOOL_STREAM, { done: false }));
    },
    { retries: 3, baseDelayMs: 0, sleep: async () => {} }
  );
  assert.equal(attempts, 2, "the truncated stream is retried rather than fatal");
  assert.deepEqual(message.content[0].input, { path: "src/a.js" });
});

test("openai: malformed event JSON classifies as retryable stream truncation", async () => {
  const error = await readOpenAIEventStream(sseResponseFromText("data: {not-json\n\n")).then(
    () => null,
    (thrown) => thrown
  );
  assert.ok(error instanceof ProviderError);
  assert.equal(error.failureKind, "malformed-stream-event");
  assert.equal(error.providerCode, "invalid_stream_json");
  assert.ok(error.cause);
});

test("openai: the retry loop recovers a turn whose event JSON was truncated", async () => {
  let attempts = 0;
  await requestWithRetry(
    () => {
      attempts += 1;
      return attempts === 1
        ? readOpenAIEventStream(sseResponseFromText("data: {not-json\n\n"))
        : readOpenAIEventStream(sseResponse(OPENAI_MINIMAL));
    },
    { retries: 3, baseDelayMs: 0, sleep: async () => {} }
  );
  assert.equal(attempts, 2, "the truncated stream is retried rather than fatal");
});

test("openai: structural protocol violations stay non-retryable", async () => {
  let attempts = 0;
  await assert.rejects(
    () => requestWithRetry(
      () => {
        attempts += 1;
        return readOpenAIEventStream(
          sseResponseFromText("data: [DONE]\n\ndata: {\"type\":\"response.completed\"}\n\n")
        );
      },
      { retries: 3, baseDelayMs: 0, sleep: async () => {} }
    ),
    (error) => error instanceof ProviderError && error.providerCode === "invalid_stream_protocol"
  );
  assert.equal(attempts, 1, "a deterministic protocol violation must not burn retries");
});

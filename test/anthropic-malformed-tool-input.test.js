// A tool-input body that will not parse means the SSE stream was cut mid
// `input_json_delta`. That is transport truncation, not a model decision, so it
// must classify as retryable rather than killing the turn — while never
// invoking a tool with partial arguments.
import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError, readAnthropicEventStream, requestWithRetry } from "../src/model-provider.js";

function sseResponse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
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

function toolStream(partialJson) {
  return [
    { type: "message_start", message: { role: "assistant", usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "code_edit" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partialJson } },
    { type: "content_block_stop", index: 0 }
  ];
}

const TRUNCATED = toolStream('{"path":"src/a.js","cont');
const COMPLETE = toolStream('{"path":"src/a.js"}');

test("truncated tool input surfaces as a retryable ProviderError", async () => {
  const error = await readAnthropicEventStream(sseResponse(TRUNCATED)).then(
    () => null,
    (thrown) => thrown
  );
  assert.ok(error instanceof ProviderError, "must not be a bare Error the retry loop ignores");
  assert.equal(error.failureKind, "malformed-tool-input");
  assert.equal(error.providerCode, "malformed_tool_input");
  assert.ok(error.cause, "the underlying parse failure is preserved for diagnostics");
});

test("the retry loop recovers a turn whose tool input arrived truncated", async () => {
  let attempts = 0;
  const message = await requestWithRetry(
    () => {
      attempts += 1;
      return readAnthropicEventStream(sseResponse(attempts === 1 ? TRUNCATED : COMPLETE));
    },
    { retries: 3, baseDelayMs: 0, sleep: async () => {} }
  );
  assert.equal(attempts, 2, "the truncated stream is retried rather than fatal");
  assert.deepEqual(message.content[0].input, { path: "src/a.js" });
});

test("a tool is never invoked with partially parsed arguments", async () => {
  await assert.rejects(
    () => readAnthropicEventStream(sseResponse(TRUNCATED)),
    (error) => error instanceof ProviderError && error.failureKind === "malformed-tool-input"
  );
});

test("retries are bounded when every attempt truncates", async () => {
  let attempts = 0;
  await assert.rejects(
    () => requestWithRetry(
      () => {
        attempts += 1;
        return readAnthropicEventStream(sseResponse(TRUNCATED));
      },
      { retries: 2, baseDelayMs: 0, sleep: async () => {} }
    ),
    (error) => error instanceof ProviderError && error.failureKind === "malformed-tool-input"
  );
  assert.equal(attempts, 3, "initial attempt plus the configured retries, then surface");
});

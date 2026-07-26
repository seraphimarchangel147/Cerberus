import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIResponsesProvider,
  ProviderError,
  extractFunctionCalls,
  extractResponseText,
  readOpenAIEventStream
} from "../src/model-provider.js";

function encodeSse(events, { done = true } = {}) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
  return new TextEncoder().encode(text);
}

function splitBytes(bytes, sizes = [1, 2, 5, 3, 8]) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes[index % sizes.length];
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)));
    offset += size;
    index += 1;
  }
  return chunks;
}

function streamResponse(chunks, { delayMs = 0, contentType = "text/event-stream" } = {}) {
  let index = 0;
  return {
    ok: true,
    headers: { get: () => contentType },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return { done: false, value };
          },
          releaseLock() {}
        };
      }
    }
  };
}

test("OpenAI SSE reconstructs fragmented UTF-8 while exposing only visible text deltas", async () => {
  const visible = [];
  let activity = 0;
  const finalText = "Go \uD83D\uDE80";
  const finalCall = {
    id: "fc-1",
    type: "function_call",
    status: "completed",
    call_id: "call-1",
    name: "lookup",
    arguments: "{\"secret\":\"tool-argument\"}"
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp-stream", object: "response", status: "in_progress", output: [], usage: null }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", status: "in_progress", content: [] }
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: "reasoning-1",
      delta: "private-reasoning"
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-1",
      delta: "Go "
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-1",
      delta: "\uD83D\uDE80"
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: finalText, annotations: [] }]
      }
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "fc-1",
        type: "function_call",
        status: "in_progress",
        call_id: "call-1",
        name: "lookup",
        arguments: ""
      }
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc-1",
      delta: "{\"secret\":"
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc-1",
      delta: "\"tool-argument\"}"
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: "fc-1",
      name: "lookup",
      arguments: finalCall.arguments
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: finalCall
    },
    {
      type: "response.completed",
      response: {
        id: "resp-stream",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg-1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: finalText, annotations: [] }]
          },
          finalCall
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 3 }
        }
      }
    }
  ];
  const response = streamResponse(splitBytes(encodeSse(events)));

  const parsed = await readOpenAIEventStream(response, {
    onDelta: (delta) => visible.push(delta),
    onActivity: () => { activity += 1; }
  });

  assert.equal(parsed.id, "resp-stream");
  assert.equal(extractResponseText(parsed), finalText);
  assert.deepEqual(visible, ["Go ", "\uD83D\uDE80"]);
  assert.doesNotMatch(visible.join(""), /private-reasoning|tool-argument/u);
  assert.deepEqual(extractFunctionCalls(parsed), [{
    call_id: "call-1",
    name: "lookup",
    arguments: finalCall.arguments
  }]);
  assert.deepEqual(parsed.usage, {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16,
    input_tokens_details: { cached_tokens: 3 }
  });
  assert.equal(activity, events.length, "validated protocol events count as stream activity");
});

test("OpenAI SSE deterministic fallback dispatches only output-item-complete function calls", async () => {
  const events = [
    {
      type: "response.created",
      response: { id: "resp-partial", object: "response", status: "in_progress", output: [] }
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-1",
      delta: "Visible fallback"
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "fc-partial",
        type: "function_call",
        status: "in_progress",
        call_id: "call-partial",
        name: "never_dispatch",
        arguments: ""
      }
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: "fc-partial",
      name: "never_dispatch",
      arguments: "{\"partial\":true}"
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        id: "fc-complete",
        type: "function_call",
        status: "in_progress",
        call_id: "call-complete",
        name: "dispatch",
        arguments: ""
      }
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc-complete",
      delta: "{\"ok\":true}"
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        id: "fc-complete",
        type: "function_call",
        status: "completed",
        call_id: "call-complete",
        name: "dispatch"
      }
    },
    {
      type: "response.incomplete",
      response: {
        id: "resp-partial",
        object: "response",
        status: "incomplete",
        output: [
          {
            id: "msg-1",
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "Visible fallback", annotations: [] }]
          },
          {
            id: "fc-partial",
            type: "function_call",
            status: "in_progress",
            call_id: "call-partial",
            name: "never_dispatch",
            arguments: "{\"partial\":true}"
          },
          {
            id: "fc-complete",
            type: "function_call",
            status: "completed",
            call_id: "call-complete",
            name: "dispatch",
            arguments: "{\"ok\":true}"
          }
        ]
      }
    }
  ];

  const parsed = await readOpenAIEventStream(
    streamResponse(splitBytes(encodeSse(events), [7, 11, 2]))
  );

  assert.equal(parsed.status, "incomplete");
  assert.equal(extractResponseText(parsed), "Visible fallback");
  assert.deepEqual(extractFunctionCalls(parsed), [{
    call_id: "call-complete",
    name: "dispatch",
    arguments: "{\"ok\":true}"
  }]);
  assert.doesNotMatch(JSON.stringify(parsed.output), /never_dispatch/u);
});

test("OpenAI SSE reconstructs sparse completion events and keeps usage snapshots", async () => {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp-sparse",
        object: "response",
        status: "in_progress",
        usage: { input_tokens: 3 }
      }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg-sparse",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-sparse",
      delta: "Reconstructed"
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg-sparse", type: "message", status: "completed" }
    },
    { type: "response.completed" }
  ];

  const parsed = await readOpenAIEventStream(streamResponse([encodeSse(events)]));

  assert.equal(parsed.id, "resp-sparse");
  assert.equal(parsed.status, "completed");
  assert.equal(extractResponseText(parsed), "Reconstructed");
  assert.deepEqual(parsed.usage, { input_tokens: 3 });
});

test("completed OpenAI calls with malformed JSON fail closed before registry invocation", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2
  });
  const requests = [];
  let registryInvocations = 0;
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "resp-malformed",
        status: "completed",
        output: [{
          id: "fc-malformed",
          type: "function_call",
          status: "completed",
          call_id: "call-malformed",
          name: "dangerous_tool",
          arguments: "{\"unterminated\":"
        }]
      };
    }
    return {
      id: "resp-after-error",
      status: "completed",
      output_text: "Recovered without invoking the tool.",
      output: []
    };
  };

  const result = await provider.generate({
    input: "Use the tool.",
    agent: { id: "main", name: "Main Agent" },
    toolRegistry: {
      async invoke() {
        registryInvocations += 1;
        return { ok: true, result: "must not happen" };
      }
    }
  });

  assert.equal(registryInvocations, 0);
  assert.equal(result.text, "Recovered without invoking the tool.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].result.ok, false);
  const toolOutput = requests[1].input.find((item) => (
    item.type === "function_call_output" && item.call_id === "call-malformed"
  ));
  assert.ok(toolOutput);
  assert.match(toolOutput.output, /valid JSON object/u);
});

test("OpenAI provider streams normal turns and keeps a slow active stream alive", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const sentBodies = [];
  const visible = [];
  let budgetRecords = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    timeoutMs: 5000,
    // The total stream lasts longer than the stall window, while every active
    // gap has enough headroom to remain deterministic under full-suite load.
    stallTimeoutMs: 250,
    budgetGuard: {
      check() {},
      record() {
        budgetRecords += 1;
        return { added: 0 };
      }
    }
  });
  const events = [
    {
      type: "response.created",
      response: { id: "resp-live", object: "response", status: "in_progress", output: [] }
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-live",
      delta: "still "
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-live",
      delta: "working"
    },
    {
      type: "response.completed",
      response: {
        id: "resp-live",
        object: "response",
        status: "completed",
        output: [{
          id: "msg-live",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "still working", annotations: [] }]
        }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
      }
    }
  ];
  const chunks = events.map((event) => encodeSse([event], { done: false }));
  chunks.push(new TextEncoder().encode("data: [DONE]\n\n"));
  globalThis.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return streamResponse(chunks, { delayMs: 80 });
  };

  const result = await provider.generate({
    input: "stream this",
    agent: { id: "main", name: "Main Agent" },
    onDelta: (delta) => visible.push(delta)
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "still working");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  assert.deepEqual(visible, ["still ", "working"]);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].stream, true);
  assert.equal(sentBodies[0].store, false);
  assert.equal(budgetRecords, 1);
});

test("OpenAI stream cancellation propagates the caller reason and cancels the reader", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const caller = new AbortController();
  const reason = new Error("caller stopped the stream");
  let fetchSignal = null;
  let cancelled = false;
  let finishRead;
  globalThis.fetch = async (_url, options) => {
    fetchSignal = options.signal;
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader() {
          return {
            read: () => new Promise((resolve) => { finishRead = resolve; }),
            cancel() {
              cancelled = true;
              finishRead?.({ done: true, value: undefined });
              return Promise.resolve();
            },
            releaseLock() {}
          };
        }
      }
    };
  };
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    timeoutMs: 5000,
    stallTimeoutMs: 1000
  });
  const pending = provider.postResponses(
    { model: "gpt-5", store: false, stream: true, input: [] },
    { __abortSignal: caller.signal }
  );
  setTimeout(() => caller.abort(reason), 10);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(cancelled, true);
});

test("OpenAI SSE provider failures reject without surfacing event payloads", async () => {
  const response = streamResponse([encodeSse([{
    type: "response.failed",
    response: {
      id: "resp-failed",
      status: "failed",
      error: {
        code: "server_error",
        message: "The model failed safely.",
        private_detail: "do-not-surface"
      }
    }
  }])]);

  await assert.rejects(
    readOpenAIEventStream(response),
    (error) => (
      error instanceof ProviderError
      && /failed safely/u.test(error.message)
      && !/do-not-surface/u.test(error.message)
    )
  );

  await assert.rejects(
    readOpenAIEventStream(streamResponse([encodeSse([{
      type: "error",
      code: "server_error",
      message: "Top-level stream failure.",
      private_detail: "do-not-surface"
    }])])),
    (error) => (
      error instanceof ProviderError
      && error.providerCode === "server_error"
      && error.message === "Top-level stream failure."
      && !/do-not-surface/u.test(error.message)
    )
  );
});

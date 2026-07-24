import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIResponsesProvider,
  ProviderError,
  extractResponseText,
  readOpenAIEventStream
} from "../src/model-provider.js";

const encoder = new TextEncoder();

function eventFrame(event, newline = "\n") {
  return `data: ${JSON.stringify(event)}${newline}${newline}`;
}

function eventStream(events, {
  done = true,
  newline = "\n",
  finalNewline = true
} = {}) {
  let text = events.map((event) => eventFrame(event, newline)).join("");
  if (done) text += `data: [DONE]${finalNewline ? `${newline}${newline}` : ""}`;
  return encoder.encode(text);
}

function chunkBytes(bytes, sizes = [1, 3, 2, 7, 4]) {
  const chunks = [];
  let offset = 0;
  let cursor = 0;
  while (offset < bytes.length) {
    const size = sizes[cursor % sizes.length];
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)));
    offset += size;
    cursor += 1;
  }
  return chunks;
}

function streamResponse(chunks, {
  contentType = "text/event-stream",
  onCancel,
  onRelease
} = {}) {
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
            return { done: false, value };
          },
          cancel(reason) {
            return onCancel?.(reason);
          },
          releaseLock() {
            onRelease?.();
          }
        };
      }
    }
  };
}

function hangingStreamResponse({ onCancel, onRelease } = {}) {
  return {
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader() {
        return {
          read() {
            return new Promise(() => {});
          },
          cancel(reason) {
            onCancel?.(reason);
            return new Promise(() => {});
          },
          releaseLock() {
            onRelease?.();
          }
        };
      }
    }
  };
}

function completedResponse({
  id = "resp-complete",
  output = [],
  usage
} = {}) {
  return {
    type: "response.completed",
    response: {
      id,
      object: "response",
      status: "completed",
      output,
      ...(usage === undefined ? {} : { usage })
    }
  };
}

async function expectProtocolFailure(response, {
  code = "invalid_stream_protocol",
  pattern,
  limits
} = {}) {
  await assert.rejects(
    readOpenAIEventStream(response, { limits }),
    (error) => (
      error instanceof ProviderError
      && error.providerCode === code
      && (!pattern || pattern.test(error.message))
    )
  );
}

test("OpenAI SSE requires an explicit terminal response before EOF or [DONE]", async (t) => {
  const created = {
    type: "response.created",
    response: {
      id: "resp-no-terminal",
      object: "response",
      status: "in_progress",
      output: []
    }
  };

  await t.test("EOF is not a terminal response", async () => {
    await expectProtocolFailure(streamResponse([eventStream([created], { done: false })]), {
      pattern: /without a terminal response/u
    });
  });

  await t.test("[DONE] is only a framing sentinel", async () => {
    await expectProtocolFailure(streamResponse([eventStream([created])]), {
      pattern: /without a terminal response/u
    });
  });
});

test("OpenAI SSE rejects protocol data after either terminal boundary", async (t) => {
  const terminal = completedResponse();
  const lateDelta = {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "late-message",
    content_index: 0,
    delta: "must not surface"
  };

  await t.test("JSON events cannot follow response.completed", async () => {
    const visible = [];
    await assert.rejects(
      readOpenAIEventStream(
        streamResponse([eventStream([terminal, lateDelta])]),
        { onDelta: (delta) => visible.push(delta) }
      ),
      (error) => error instanceof ProviderError && /after its terminal response/u.test(error.message)
    );
    assert.deepEqual(visible, []);
  });

  await t.test("JSON events cannot follow [DONE]", async () => {
    const raw = `${eventFrame(terminal)}data: [DONE]\n\ndata: ${JSON.stringify(lateDelta)}\n\n`;
    await expectProtocolFailure(streamResponse([encoder.encode(raw)]), {
      pattern: /after the done sentinel/u
    });
  });
});

test("OpenAI SSE sequence numbers are strictly monotonic before state mutation", async () => {
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp-sequence",
        object: "response",
        status: "in_progress",
        output: []
      }
    },
    {
      type: "response.output_item.added",
      sequence_number: 3,
      output_index: 0,
      item: {
        id: "msg-sequence",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "msg-sequence",
      content_index: 0,
      delta: "regressed"
    }
  ];
  const visible = [];

  await assert.rejects(
    readOpenAIEventStream(
      streamResponse([eventStream(events)]),
      { onDelta: (delta) => visible.push(delta) }
    ),
    (error) => error instanceof ProviderError && /strictly increasing/u.test(error.message)
  );
  assert.deepEqual(visible, [], "a regressed event must be rejected before its delta is surfaced");
});

test("OpenAI SSE enforces function-call lifecycle transitions", async (t) => {
  await t.test("argument events require an active function item", async () => {
    const events = [
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc-missing",
        delta: "{}"
      }
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      pattern: /unknown function call/u
    });
  });

  await t.test("arguments cannot mutate after arguments.done", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc-args-done",
          type: "function_call",
          status: "in_progress",
          call_id: "call-args-done",
          name: "lookup",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc-args-done",
        arguments: "{}"
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc-args-done",
        delta: "{\"late\":true}"
      }
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      pattern: /after arguments completion/u
    });
  });

  await t.test("completed terminal snapshots cannot promote a partial call", async () => {
    const call = {
      id: "fc-partial",
      type: "function_call",
      status: "completed",
      call_id: "call-partial",
      name: "dangerous_tool",
      arguments: "{\"unsafe\":true}"
    };
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, status: "in_progress", arguments: "" }
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: call.id,
        arguments: call.arguments
      },
      completedResponse({ id: "resp-partial-call", output: [call] })
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      pattern: /without output_item\.done/u
    });
  });

  await t.test("events cannot substitute a different item identity at the same index", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg-original",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: []
        }
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg-substitute",
        content_index: 0,
        delta: "identity confusion"
      },
      completedResponse()
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      pattern: /identity|item_id|different item/u
    });
  });
});

test("OpenAI SSE rejects mutations after content or item completion", async (t) => {
  const messageAdded = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "msg-lifecycle",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: []
    }
  };
  const textDone = {
    type: "response.output_text.done",
    output_index: 0,
    item_id: "msg-lifecycle",
    content_index: 0,
    text: "finished"
  };
  const lateDelta = {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "msg-lifecycle",
    content_index: 0,
    delta: "late"
  };

  await t.test("text cannot change after output_text.done", async () => {
    await expectProtocolFailure(
      streamResponse([eventStream([messageAdded, textDone, lateDelta])]),
      { pattern: /after completion/u }
    );
  });

  await t.test("items cannot change after output_item.done", async () => {
    const itemDone = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg-lifecycle",
        type: "message",
        role: "assistant",
        status: "completed"
      }
    };
    await expectProtocolFailure(
      streamResponse([eventStream([messageAdded, textDone, itemDone, lateDelta])]),
      { pattern: /after item completion/u }
    );
  });

  await t.test("output_item.done cannot carry an in-progress item", async () => {
    await expectProtocolFailure(
      streamResponse([eventStream([messageAdded, {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg-lifecycle",
          type: "message",
          role: "assistant",
          status: "in_progress"
        }
      }])]),
      { pattern: /non-completed status/u }
    );
  });
});

test("OpenAI SSE reconstructs visible refusals without leaking reasoning", async () => {
  const visible = [];
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg-refusal",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: "reasoning-private",
      delta: "private chain of thought"
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      item_id: "msg-refusal",
      content_index: 0,
      delta: "I cannot "
    },
    {
      type: "response.refusal.delta",
      output_index: 0,
      item_id: "msg-refusal",
      content_index: 0,
      delta: "help with that."
    },
    {
      type: "response.refusal.done",
      output_index: 0,
      item_id: "msg-refusal",
      content_index: 0,
      refusal: "I cannot help with that."
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg-refusal",
        type: "message",
        role: "assistant",
        status: "completed"
      }
    },
    completedResponse()
  ];

  const result = await readOpenAIEventStream(
    streamResponse(chunkBytes(eventStream(events))),
    { onDelta: (delta) => visible.push(delta) }
  );

  assert.equal(extractResponseText(result), "I cannot help with that.");
  assert.deepEqual(visible, ["I cannot ", "help with that."]);
  assert.doesNotMatch(JSON.stringify(result), /private chain of thought/u);
});

test("OpenAI SSE supports CR framing and fragmented UTF-8 at byte boundaries", async () => {
  const finalText = "Ready \u{1F680}";
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp-cr-utf8",
        object: "response",
        status: "in_progress",
        output: []
      }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg-cr-utf8",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg-cr-utf8",
      content_index: 0,
      delta: finalText
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg-cr-utf8",
        type: "message",
        role: "assistant",
        status: "completed"
      }
    },
    completedResponse({ id: "resp-cr-utf8" })
  ];
  const sequencedEvents = events.map((event, sequence_number) => ({
    ...event,
    sequence_number
  }));
  const bytes = eventStream(sequencedEvents, { newline: "\r", finalNewline: false });

  const parsed = await readOpenAIEventStream(streamResponse(chunkBytes(bytes, [1])));
  assert.equal(extractResponseText(parsed), finalText);

  const crlfBytes = eventStream(sequencedEvents, { newline: "\r\n" });
  const crlfParsed = await readOpenAIEventStream(streamResponse(chunkBytes(crlfBytes, [1])));
  assert.equal(extractResponseText(crlfParsed), finalText);
});

test("OpenAI SSE rejects malformed or incomplete UTF-8", async (t) => {
  await t.test("invalid continuation bytes", async () => {
    await expectProtocolFailure(
      streamResponse([Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28])]),
      {
        code: "invalid_stream_encoding",
        pattern: /invalid UTF-8/u
      }
    );
  });

  await t.test("truncated code points at EOF", async () => {
    await expectProtocolFailure(
      streamResponse([Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2, 0x82])]),
      {
        code: "invalid_stream_encoding",
        pattern: /incomplete UTF-8/u
      }
    );
  });
});

test("OpenAI SSE injectable limits bound every accumulating parser dimension", async (t) => {
  const created = {
    type: "response.created",
    response: {
      id: "resp-bounds",
      object: "response",
      status: "in_progress",
      output: []
    }
  };

  await t.test("wire bytes", async () => {
    await expectProtocolFailure(streamResponse([eventStream([created])]), {
      code: "stream_limit_exceeded",
      pattern: /wire byte/u,
      limits: { maxWireBytes: 8 }
    });
  });

  await t.test("event count", async () => {
    await expectProtocolFailure(
      streamResponse([eventStream([created, completedResponse({ id: "resp-bounds" })])]),
      {
        code: "stream_limit_exceeded",
        pattern: /event count/u,
        limits: { maxEvents: 1 }
      }
    );
  });

  await t.test("visible output", async () => {
    const events = [
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg-bounds",
        content_index: 0,
        delta: "1234"
      }
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      code: "stream_limit_exceeded",
      pattern: /visible output/u,
      limits: { maxVisibleChars: 3 }
    });
  });

  await t.test("per-call arguments", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc-argument-bound",
          type: "function_call",
          status: "in_progress",
          call_id: "call-argument-bound",
          name: "lookup",
          arguments: ""
        }
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc-argument-bound",
        delta: "1234"
      }
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      code: "stream_limit_exceeded",
      pattern: /function argument/u,
      limits: { maxArgumentChars: 3 }
    });
  });

  await t.test("aggregate arguments", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc-total-a",
          type: "function_call",
          status: "in_progress",
          call_id: "call-total-a",
          name: "lookup",
          arguments: "123"
        }
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc-total-b",
          type: "function_call",
          status: "in_progress",
          call_id: "call-total-b",
          name: "lookup",
          arguments: "456"
        }
      }
    ];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      code: "stream_limit_exceeded",
      pattern: /total function arguments/u,
      limits: { maxArgumentChars: 4, maxTotalArgumentChars: 5 }
    });
  });

  await t.test("output item count and sparse indices", async () => {
    const events = [{
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "msg-out-of-bounds",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: []
      }
    }];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      pattern: /invalid output index/u,
      limits: { maxItems: 1 }
    });
  });

  await t.test("usage key count", async () => {
    const events = [completedResponse({
      usage: { input_tokens: 1, output_tokens: 1 }
    })];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      code: "invalid_usage_payload",
      pattern: /key limit/u,
      limits: { maxUsageKeys: 1 }
    });
  });

  await t.test("usage nesting depth", async () => {
    const events = [completedResponse({
      usage: { input_tokens_details: { cached_tokens: 1 } }
    })];
    await expectProtocolFailure(streamResponse([eventStream(events)]), {
      code: "invalid_usage_payload",
      pattern: /nesting limit/u,
      limits: { maxUsageDepth: 1 }
    });
  });
});

test("OpenAI SSE usage snapshots cannot modify object prototypes", async () => {
  delete Object.prototype.openAIPolluted;
  const hostileUsage = JSON.parse(
    "{\"input_tokens\":3,\"__proto__\":{\"openAIPolluted\":1},"
      + "\"constructor\":{\"prototype\":{\"openAIPolluted\":2}},"
      + "\"prototype\":{\"openAIPolluted\":3}}"
  );
  const events = [completedResponse({ usage: hostileUsage })];

  const parsed = await readOpenAIEventStream(streamResponse([eventStream(events)]));

  assert.deepEqual(parsed.usage, { input_tokens: 3 });
  assert.equal(Object.prototype.openAIPolluted, undefined);
  assert.equal(({}).openAIPolluted, undefined);
});

test("blocking provider usage uses the same prototype-safe bounded accumulator", async () => {
  delete Object.prototype.openAIBlockingPolluted;
  const hostileUsage = JSON.parse(
    "{\"input_tokens\":4,\"output_tokens\":2,"
      + "\"__proto__\":{\"openAIBlockingPolluted\":1},"
      + "\"constructor\":{\"prototype\":{\"openAIBlockingPolluted\":2}}}"
  );
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 1,
    stallTimeoutMs: 0
  });
  provider.postResponses = async () => ({
    id: "resp-blocking-usage",
    status: "completed",
    output_text: "Safe usage.",
    output: [],
    usage: hostileUsage
  });

  const result = await provider.generate({
    input: "Return safely.",
    agent: { id: "main", name: "Main Agent" }
  });

  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
  assert.equal(Object.prototype.openAIBlockingPolluted, undefined);
  assert.equal(({}).openAIBlockingPolluted, undefined);
});

test("OpenAI SSE abort settles when reader cancellation is non-cooperative", async () => {
  const controller = new AbortController();
  const reason = new Error("caller ended the stream");
  let cancelReason;
  let released = false;
  const startedAt = Date.now();
  const pending = readOpenAIEventStream(
    hangingStreamResponse({
      onCancel: (value) => { cancelReason = value; },
      onRelease: () => { released = true; }
    }),
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(reason), 10);

  await assert.rejects(pending, (error) => error === reason);
  assert.ok(Date.now() - startedAt < 250, "abort must not await a non-cooperative reader.cancel()");
  assert.equal(cancelReason, reason);
  assert.equal(released, true);
});

test("OpenAI provider classifies silent non-cooperative streams as stalls", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = 0;
  globalThis.fetch = async () => hangingStreamResponse({
    onCancel: () => { cancelled += 1; }
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    timeoutMs: 1000,
    stallTimeoutMs: 15
  });
  const startedAt = Date.now();

  await assert.rejects(
    provider.postResponses({
      model: "gpt-5",
      store: false,
      stream: true,
      input: []
    }),
    (error) => (
      error?.name === "ModelStallError"
      && /stalled/u.test(error.message)
      && !/request timeout/u.test(error.message)
    )
  );
  assert.ok(Date.now() - startedAt < 300, "stall classification must not await transport cancellation");
  assert.equal(cancelled, 1);
});

test("OpenAI provider never invokes the registry for stream-only partial calls", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCount = 0;
  let registryInvocations = 0;
  const partialCall = {
    id: "fc-provider-partial",
    type: "function_call",
    status: "completed",
    call_id: "call-provider-partial",
    name: "dangerous_tool",
    arguments: "{\"unsafe\":true}"
  };
  const maliciousEvents = [
    {
      type: "response.created",
      response: {
        id: "resp-provider-partial",
        object: "response",
        status: "in_progress",
        output: []
      }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...partialCall, status: "in_progress", arguments: "" }
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: partialCall.id,
      arguments: partialCall.arguments
    },
    completedResponse({
      id: "resp-provider-partial",
      output: [partialCall]
    })
  ];

  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const body = JSON.parse(options.body);
    if (body.stream === true) {
      return streamResponse(chunkBytes(eventStream(maliciousEvents)));
    }
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async json() {
        return {
          id: "resp-forced-safe",
          status: "completed",
          output_text: "Recovered without dispatching the partial call.",
          output: []
        };
      }
    };
  };

  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 1,
    timeoutMs: 1000,
    stallTimeoutMs: 100,
    forceAnswerMs: 200
  });
  const result = await provider.generate({
    input: "Use the tool.",
    agent: { id: "main", name: "Main Agent" },
    tools: [{
      type: "function",
      name: "dangerous_tool",
      description: "Must not run from a partial stream item.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { unsafe: { type: "boolean" } }
      }
    }],
    toolRegistry: {
      async invoke() {
        registryInvocations += 1;
        return { ok: true, result: "must not happen" };
      }
    },
    onDelta() {}
  });

  assert.equal(registryInvocations, 0);
  assert.equal(fetchCount, 2, "the second request is the provider-error forced-answer recovery");
  assert.equal(result.stopReason, "provider-error");
  assert.equal(result.text, "Recovered without dispatching the partial call.");
  assert.deepEqual(result.toolCalls, []);
});

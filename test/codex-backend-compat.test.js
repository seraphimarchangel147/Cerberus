import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIResponsesProvider,
  extractResponseText,
  readOpenAIEventStream
} from "../src/model-provider.js";
import {
  createConversationContentIdentity,
  createConversationLineageIdentity
} from "../src/responses-continuation.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function provider(baseUrl, overrides = {}) {
  return new OpenAIResponsesProvider({
    apiKey: "test-credential-not-real",
    baseUrl,
    model: "gpt-test",
    timeoutMs: 5_000,
    stallTimeoutMs: 0,
    providerMaxRetries: 0,
    ...overrides
  });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function encodeSse(events) {
  return new TextEncoder().encode(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
  );
}

function streamResponse(events, { contentType = null } = {}) {
  const bytes = encodeSse(events);
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function completedResponse(id = "resp-test", text = "ok") {
  return {
    id,
    object: "response",
    status: "completed",
    output_text: text,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("Codex postResponses sanitizes incompatible fields while api.openai.com stays unchanged", { concurrency: false }, async () => {
  const original = {
    model: "gpt-test",
    store: true,
    stream: false,
    max_output_tokens: 321,
    previous_response_id: "resp-prior",
    input: [{ role: "user", content: "probe" }]
  };
  const captured = [];

  await withMockFetch(async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return captured.length === 1
      ? streamResponse([{
          type: "response.completed",
          response: completedResponse("resp-codex")
        }])
      : jsonResponse(completedResponse("resp-openai"));
  }, async () => {
    await provider(CODEX_BASE_URL).postResponses(structuredClone(original));
    await provider("https://api.openai.com/v1").postResponses(structuredClone(original));
  });

  assert.deepEqual(captured[0], {
    model: "gpt-test",
    store: false,
    stream: true,
    input: original.input
  });
  assert.deepEqual(captured[1], original, "non-Codex request bodies must remain byte-semantically unchanged");
});

test("Codex-shaped headerless SSE tolerates done ordering and drops unbounded usage attribution", async () => {
  const attribution = Object.fromEntries(
    Array.from({ length: 220 }, (_, index) => [`msg-${index}`, { input_tokens: 1 }])
  );
  const text = "Codex lane alive";
  const message = {
    id: "msg-output",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp-codex-stream", object: "response", status: "in_progress", output: [] }
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] }
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      text
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      part: message.content[0]
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: message
    },
    {
      type: "response.completed",
      response: {
        id: "resp-codex-stream",
        object: "response",
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          attribution
        }
      }
    }
  ];

  const parsed = await readOpenAIEventStream(streamResponse(events, { contentType: null }));
  assert.equal(extractResponseText(parsed), text);
  assert.deepEqual(parsed.usage, {
    input_tokens: 12,
    output_tokens: 4,
    total_tokens: 16
  });
  assert.equal(Object.hasOwn(parsed.usage, "attribution"), false);
});

test("Codex backend disables response continuation even when continuation mode is auto", async () => {
  const codex = provider(CODEX_BASE_URL, { responsesContinuationMode: "auto" });
  const bodies = [];
  codex.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return completedResponse("resp-no-continuation", "stateless answer");
  };
  const input = "Do not continue server-side.";
  const result = await codex.generate({
    input,
    instructions: "Stable instructions.",
    messages: [],
    tools: [],
    context: {
      sessionId: "codex-continuation-probe",
      __memoryScope: "main",
      __continuationEligible: true,
      __continuationHistoryIdentity: createConversationLineageIdentity([]),
      __continuationCurrentContentIdentity: createConversationContentIdentity(input),
      __continuationContextEpoch: 0,
      __continuationSessionIncarnation: "codex-probe-incarnation"
    },
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].store, false);
  assert.equal(Object.hasOwn(bodies[0], "previous_response_id"), false);
  assert.equal(result.__responsesContinuationCandidate ?? null, null);
  assert.equal(codex.responsesContinuationStore.stats().entries, 0);
  assert.equal(codex.responsesContinuationStore.stats().reservations, 0);
});

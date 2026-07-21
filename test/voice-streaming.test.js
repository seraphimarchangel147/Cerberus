// Streaming is presentation-only: the provider still reconstructs the same
// complete Anthropic message consumed by the iteration engine, while Discord
// receives ordered text deltas through a throttled edit queue.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AnthropicProvider,
  readAnthropicEventStream
} from "../src/model-provider.js";
import {
  DiscordChannel,
  DiscordReplyStream,
  discordStreamingEnabled
} from "../src/discord-channel.js";
import { saveEnv } from "../src/setup-wizard.js";

const agent = { id: "main", name: "Main Agent" };

function sseResponse(events, splitEvery = 11) {
  const body = events.map((event) => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join("");
  const encoded = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += splitEvery) {
        controller.enqueue(encoded.slice(offset, offset + splitEvery));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream;charset=utf-8" }
  });
}

function textEvents(chunks, { id = "msg_stream", stopReason = "end_turn" } = {}) {
  return [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "kimi-k3",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 3 }
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...chunks.map((text) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
    { type: "message_stop" }
  ];
}

function toolEvents() {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "kimi-k3",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 4 }
      }
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_1", name: "lookup", input: {} }
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"desert"}' }
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" }
  ];
}

function isolateStreamingEnv(t) {
  const previous = process.env.DISCORD_STREAMING;
  delete process.env.DISCORD_STREAMING;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_STREAMING;
    else process.env.DISCORD_STREAMING = previous;
  });
}

test("Anthropic SSE deltas arrive in order and assemble the final message", async (t) => {
  const originalFetch = globalThis.fetch;
  const sentBodies = [];
  let recordedUsage = null;
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return sseResponse(textEvents(["Hel", "lo", " world"]), 7);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const deltas = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 2,
    budgetGuard: {
      check() {},
      record(usage) { recordedUsage = usage; return { added: 0 }; }
    }
  });
  const result = await provider.generate({
    input: "greet",
    agent,
    context: { __scrutinyPolicy: "none" },
    onDelta: (chunk) => deltas.push(chunk)
  });

  assert.equal(sentBodies[0].stream, true);
  assert.deepEqual(deltas, ["Hel", "lo", " world"]);
  assert.equal(result.text, "Hello world");
  assert.equal(result.id, "msg_stream");
  assert.deepEqual(recordedUsage, { input_tokens: 3, output_tokens: 2 });
});

test("Anthropic tool-use SSE stays internal and only final prose reaches onDelta", async (t) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return requests === 1
      ? sseResponse(toolEvents(), 5)
      : sseResponse(textEvents(["Final ", "answer."], { id: "msg_final" }), 9);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const invoked = [];
  const registry = {
    toAnthropicTools: () => [{ name: "lookup", description: "lookup", input_schema: { type: "object" } }],
    async invoke(name, args) {
      invoked.push({ name, args });
      return { ok: true, result: { found: true } };
    }
  };
  const deltas = [];
  const result = await new AnthropicProvider({ apiKey: "test-key", maxIterations: 3 }).generate({
    input: "research",
    agent,
    toolRegistry: registry,
    onDelta: (chunk) => deltas.push(chunk)
  });

  assert.equal(requests, 2);
  assert.deepEqual(invoked, [{ name: "lookup", args: { query: "desert" } }]);
  assert.deepEqual(deltas, ["Final ", "answer."]);
  assert.equal(result.text, "Final answer.");
});

test("Anthropic streams internally for stall detection even when onDelta is absent, but surfaces no deltas", async (t) => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    // Server may still answer with a plain JSON body; the provider handles both.
    return new Response(JSON.stringify({
      id: "msg_json",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ordinary response" }],
      usage: { input_tokens: 1, output_tokens: 2 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // Default: stall detection is on, so the loop streams internally (stream:true)
  // to get the "is the model still trying?" signal — regardless of onDelta.
  const streamed = await new AnthropicProvider({ apiKey: "test" }).generate({
    input: "ordinary",
    agent,
    context: { __scrutinyPolicy: "none" }
  });
  assert.equal(sentBody.stream, true, "internal streaming enables the stall watchdog");
  assert.equal(streamed.text, "ordinary response");

  // Disabling stall detection restores the pure non-streaming JSON path.
  sentBody = null;
  const plain = await new AnthropicProvider({ apiKey: "test", stallTimeoutMs: 0 }).generate({
    input: "ordinary",
    agent,
    context: { __scrutinyPolicy: "none" }
  });
  assert.equal(Object.hasOwn(sentBody, "stream"), false, "no stall detection and no onDelta → no streaming");
  assert.equal(plain.text, "ordinary response");
});

test("the SSE parser rejects malformed tool JSON instead of invoking with partial input", async () => {
  const events = toolEvents();
  events[2].delta.partial_json = '{"query":';
  await assert.rejects(
    readAnthropicEventStream(sseResponse(events)),
    /malformed tool input JSON/
  );
});

test("Discord streaming defaults on and reads explicit disable/enable values live", (t) => {
  isolateStreamingEnv(t);
  assert.equal(discordStreamingEnabled(), true);
  process.env.DISCORD_STREAMING = "on";
  assert.equal(discordStreamingEnabled(), true);
  process.env.DISCORD_STREAMING = "0";
  assert.equal(discordStreamingEnabled(), false);
  process.env.DISCORD_STREAMING = "false";
  assert.equal(discordStreamingEnabled(), false);
});

test("setup wizard allowlists DISCORD_STREAMING", (t) => {
  isolateStreamingEnv(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-stream-env-"));
  const saved = saveEnv({ dataDir, values: { DISCORD_STREAMING: "1" } });
  assert.deepEqual(saved.keys, ["DISCORD_STREAMING"]);
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /^DISCORD_STREAMING=1$/m);
});

test("Discord reply streaming rolls overflow into a second message", async () => {
  const posts = [];
  const edits = [];
  const deletes = [];
  const channel = {
    async sendMessage(channelId, content, replyToId) {
      const result = { id: `message-${posts.length + 1}` };
      posts.push({ channelId, content, replyToId, id: result.id });
      return result;
    },
    async editMessage(channelId, messageId, content) {
      edits.push({ channelId, messageId, content });
    },
    async deleteMessage(channelId, messageId) {
      deletes.push({ channelId, messageId });
    }
  };
  const stream = new DiscordReplyStream(channel, "channel-1", "source-1", true, { editMinMs: 0 });
  const text = `${"a".repeat(1990)}${"b".repeat(25)}`;
  stream.onDelta(text.slice(0, 1000));
  stream.onDelta(text.slice(1000));
  const delivered = await stream.finish(text);

  assert.equal(delivered, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].replyToId, "source-1");
  assert.equal(posts[1].replyToId, null);
  assert.equal(posts[0].content.length, 1990);
  assert.equal(posts[1].content.length, 25);
  assert.equal(posts.map((post) => post.content).join(""), text);
  assert.deepEqual(edits, []);
  assert.deepEqual(deletes, []);
});

test("Discord runTurn edits one streamed reply instead of posting the final twice", async (t) => {
  isolateStreamingEnv(t);
  process.env.DISCORD_STREAMING = "1";
  const requests = [];
  let capturedDelta = null;
  const channel = Object.create(DiscordChannel.prototype);
  channel.liveStatus = false;
  channel.rest = async (route, options = {}) => {
    requests.push({ route, options: structuredClone(options) });
    return { id: `message-${requests.length}` };
  };
  channel.agentHost = {
    async handleMessage(input) {
      capturedDelta = input.onDelta;
      input.onDelta("Hello ");
      await new Promise((resolve) => setImmediate(resolve));
      input.onDelta("world");
      return { reply: "Hello world", model: { stopReason: "completed" }, toolCalls: [] };
    }
  };

  await channel.runTurn({
    id: "source-2",
    channel_id: "channel-2",
    guild_id: null,
    author: { id: "user-2", username: "creator" },
    attachments: []
  }, "hello");

  const posts = requests.filter((request) => (
    request.route === "/channels/channel-2/messages" && request.options.method === "POST"
  ));
  const patches = requests.filter((request) => request.options.method === "PATCH");
  assert.equal(typeof capturedDelta, "function");
  assert.equal(posts.length, 1, "final delivery reuses the streamed message");
  assert.equal(posts[0].options.body.content, "Hello ");
  assert.equal(patches.at(-1).options.body.content, "Hello world");
});

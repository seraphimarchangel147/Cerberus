// Discord delivery has a hard character ceiling. These tests protect code
// fences and rate-limit recovery without exercising the live API.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DiscordChannel,
  DiscordReplyStream,
  chunkText
} from "../src/discord-channel.js";

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

function fenceCount(text) {
  return [...String(text).matchAll(/^```/gmu)].length;
}

test("short Discord messages remain byte-identical", () => {
  const source = "A short message with `inline code` and spacing.\n";
  assert.deepEqual(chunkText(source, 1990), [source]);
});

test("plain long messages prefer line boundaries and preserve all text", () => {
  const source = `${"a".repeat(24)}\n${"b".repeat(24)}\n${"c".repeat(24)}`;
  const chunks = chunkText(source, 32);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 32));
  assert.equal(chunks[0], `${"a".repeat(24)}\n`);
  assert.equal(chunks.join(""), source);
});

test("a code fence spanning the limit is closed and reopened in balanced chunks", () => {
  const code = Array.from({ length: 18 }, (_, i) => `const value${i} = ${i};`).join("\n");
  const source = `Before\n\`\`\`js\n${code}\n\`\`\`\nAfter`;
  const chunks = chunkText(source, 96);

  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 96));
  assert.ok(chunks.every((chunk) => fenceCount(chunk) % 2 === 0), "each Discord part renders balanced fences");
  assert.ok(chunks.slice(1, -1).some((chunk) => chunk.startsWith("```js\n")), "continued code keeps its language hint");
  assert.match(chunks.at(-1), /```\nAfter$/u);
});

test("streaming rollover uses the same fence-aware chunks", async () => {
  const posts = [];
  const channel = {
    async sendMessage(channelId, content, replyToId) {
      const sent = { id: `stream-${posts.length + 1}` };
      posts.push({ channelId, content, replyToId, id: sent.id });
      return sent;
    },
    async editMessage() {},
    async deleteMessage() {}
  };
  const body = Array.from({ length: 180 }, (_, i) => `console.log(${i});`).join("\n");
  const source = `\`\`\`js\n${body}\n\`\`\``;
  const stream = new DiscordReplyStream(channel, "channel", "source", true, { editMinMs: 0 });
  stream.onDelta(source);
  assert.equal(await stream.finish(source), true);
  assert.ok(posts.length > 1);
  assert.ok(posts.every((post) => post.content.length <= 1990));
  assert.ok(posts.every((post) => fenceCount(post.content) % 2 === 0));
});

test("Discord REST retries one 429 before one successful send", async () => {
  const calls = [];
  const sleeps = [];
  const scripted = [
    jsonResponse(429, { retry_after: 0 }),
    jsonResponse(200, { id: "sent-once" })
  ];
  const channel = Object.create(DiscordChannel.prototype);
  channel.token = "test-token";
  channel.restFetch = async (url, options) => {
    calls.push({ url, options });
    return scripted.shift();
  };
  channel.restSleep = async (ms) => { sleeps.push(ms); };

  const sent = await channel.sendMessage("channel", "hello");
  assert.equal(sent.id, "sent-once");
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(calls[0].options.body, calls[1].options.body, "the retry reuses the same unsent POST body");
});

test("Discord REST gives up after three consecutive 429 responses", async () => {
  let calls = 0;
  let sleeps = 0;
  const channel = Object.create(DiscordChannel.prototype);
  channel.token = "test-token";
  channel.restFetch = async () => {
    calls += 1;
    return jsonResponse(429, { retry_after: 0 });
  };
  channel.restSleep = async () => { sleeps += 1; };

  await assert.rejects(
    channel.sendMessage("channel", "hello"),
    (error) => error.status === 429 && /after 3 attempts/u.test(error.message)
  );
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});


// ── Regression: boundary-separator infinite loop (2026-07-25) ─────────
// A reply whose paragraph/line/word break landed at EXACTLY the chunk limit
// made preferredChunkCut() return a cut > limit (lastIndexOf matches AT the
// limit, then +1/+2 pushes it over). chunkText()'s re-fit loop asked for
// min(limit, cut-1), got the same oversized cut back, and spun forever —
// pegging the event loop at 100% CPU and wedging the whole daemon: the HTTP
// port stayed open, so systemd Restart=always never fired. Azazel went
// silent on Discord while systemd still reported the unit healthy.
test("chunkText terminates when a separator sits exactly at the chunk limit", () => {
  const size = 1990;
  for (const sep of ["\n\n", "\n", " ", "\t"]) {
    for (let off = size - 4; off <= size + 4; off += 1) {
      const text = "a".repeat(off) + sep + "b".repeat(2500);
      const started = Date.now();
      const chunks = chunkText(text, size);
      assert.ok(
        Date.now() - started < 2000,
        `chunkText hung for separator ${JSON.stringify(sep)} at offset ${off}`
      );
      for (const chunk of chunks) {
        assert.ok(
          chunk.length <= size,
          `oversized chunk (${chunk.length}) for ${JSON.stringify(sep)} at offset ${off}`
        );
      }
    }
  }
});

test("chunkText preserves content when the break lands on the limit", () => {
  const size = 1990;
  const text = "a".repeat(size) + "\n\n" + "b".repeat(3000);
  assert.equal(chunkText(text, size).join(""), text);
});

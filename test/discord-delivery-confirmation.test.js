// F4 + the headline meta-bug from the 2026-07-29 QA battery: the send lane
// reported `delivered: true` for messages that never rendered, because the tool
// defaulted an ABSENT delivery signal to success (`raw?.delivered !== false`)
// and the Discord transport never set that field. That converts message loss
// into SILENT message loss, which is worse than a hard failure. There was also
// no read-only history tool, so nothing could close the loop on a send.
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_CORE_TOOLS } from "../src/agent-host.js";
import { DiscordChannel } from "../src/discord-channel.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function registryWith(channels) {
  const tools = new ToolRegistry();
  const runtime = { channels, dataDir: null, tools };
  registerCoreTools(tools, runtime);
  return { runtime, tools };
}

test("an absent transport delivery signal is reported UNCONFIRMED, not delivered", async () => {
  // Exactly the pre-fix shape: the transport returns text/candidates and no
  // delivery field at all.
  const { tools } = registryWith({
    deliver: async () => ({ text: "hi", candidates: [], successfulCandidates: [] })
  });
  const outcome = await tools.invoke(
    "send_message",
    { channel: "discord", target: "123456789", text: "hi" },
    { sessionId: "f4" }
  );
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(
    outcome.result.delivered,
    false,
    "a transport that never confirms delivery must not be reported as delivered"
  );
  assert.equal(outcome.result.confirmation, "unverified");
  assert.match(outcome.result.status, /UNCONFIRMED/);
});

test("a transport that returns a message id is reported delivered with that id", async () => {
  const { tools } = registryWith({
    deliver: async () => ({
      text: "hi",
      delivered: true,
      messageId: "999000111",
      candidates: [],
      successfulCandidates: []
    })
  });
  const outcome = await tools.invoke(
    "send_message",
    { channel: "discord", target: "123456789", text: "hi" },
    { sessionId: "f4" }
  );
  assert.equal(outcome.result.delivered, true);
  assert.equal(outcome.result.messageId, "999000111");
  assert.equal(outcome.result.confirmation, undefined);
});

test("an explicit transport failure still reports its own reason", async () => {
  const { tools } = registryWith({
    deliver: async () => ({ delivered: false, reason: "channel local has no outbound transport" })
  });
  const outcome = await tools.invoke(
    "send_message",
    { channel: "local", target: "x", text: "hi" },
    { sessionId: "f4" }
  );
  assert.equal(outcome.result.delivered, false);
  assert.match(outcome.result.status, /no outbound transport/);
});

test("deliverAgentReply reports delivered only when Discord echoes a message id", async () => {
  const calls = [];
  const channel = new DiscordChannel({
    token: "tok",
    channelId: "123",
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "777888999" }),
        text: async () => "{}"
      };
    }
  });
  const result = await channel.deliverAgentReply("123", "hello");
  assert.equal(result.delivered, true, "a REST echo with an id confirms delivery");
  assert.equal(result.messageId, "777888999");
  assert.equal(result.channelId, "123");

  // And when Discord accepts but echoes no id, delivery must NOT be claimed.
  const silent = new DiscordChannel({
    token: "tok",
    channelId: "123",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}"
    })
  });
  const unconfirmed = await silent.deliverAgentReply("123", "hello");
  assert.equal(
    unconfirmed.delivered,
    false,
    "no message id means delivery is unconfirmed"
  );
  assert.match(String(unconfirmed.reason), /unconfirmed/i);
});

test("fetchMessages reads history read-only, bounded, and normalized", async () => {
  const seen = [];
  const channel = new DiscordChannel({
    token: "tok",
    channelId: "123",
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        json: async () => ([
          {
            id: "2",
            author: { id: "a1", username: "azazel", bot: true },
            content: "probe B",
            timestamp: "2026-07-30T00:00:00Z",
            mentions: [{ id: "seraph1" }],
            attachments: [],
            embeds: [],
            message_reference: { message_id: "1" }
          }
        ]),
        text: async () => "[]"
      };
    }
  });

  const rows = await channel.fetchMessages("123", { limit: 500, after: "1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET", "history must be a read, never a write");
  assert.match(seen[0].url, /limit=100/, "limit must be clamped to Discord's max of 100");
  assert.match(seen[0].url, /after=1/);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "2",
    authorId: "a1",
    authorName: "azazel",
    bot: true,
    content: "probe B",
    timestamp: "2026-07-30T00:00:00Z",
    hasEmbeds: false,
    attachmentCount: 0,
    mentionIds: ["seraph1"],
    replyToId: "1"
  });
});

test("channel_history is read-only, resolves ids, and closes the send loop", async () => {
  const fetched = [];
  const { tools } = registryWith({
    deliver: async () => ({ delivered: true, messageId: "555" }),
    discord: {
      fetchMessages: async (channelId, opts) => {
        fetched.push({ channelId, opts });
        return [{ id: "555", authorId: "me", content: "sent text", bot: true }];
      }
    }
  });

  const tool = tools.get("channel_history");
  assert.equal(tool.sideEffects, false, "history reads must never be side-effecting");

  const sent = await tools.invoke(
    "send_message",
    { channel: "discord", target: "42424242", text: "sent text" },
    { sessionId: "f4" }
  );
  assert.equal(sent.result.messageId, "555");

  // The loop that was impossible before: verify the claimed send actually landed.
  const history = await tools.invoke(
    "channel_history",
    { target: "42424242", limit: 5 },
    { sessionId: "f4" }
  );
  assert.equal(history.ok, true, history.error);
  assert.equal(history.result.channelId, "42424242");
  assert.ok(
    history.result.messages.some((m) => m.id === sent.result.messageId),
    "the read-back must be able to confirm the id the send lane claimed"
  );
  assert.equal(fetched[0].opts.limit, 5);
});

test("channel_history rejects an unknown target instead of guessing", async () => {
  const { tools } = registryWith({
    deliver: async () => ({ delivered: true }),
    discord: { fetchMessages: async () => [] }
  });
  const outcome = await tools.invoke(
    "channel_history",
    { target: "not-a-sibling-or-id" },
    { sessionId: "f4" }
  );
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /Unknown channel target/);
});

test("channel_history is reachable on the chat lane alongside send_message", () => {
  assert.ok(
    CHAT_CORE_TOOLS.includes("send_message"),
    "precondition: send lane is core"
  );
  assert.ok(
    CHAT_CORE_TOOLS.includes("channel_history"),
    "a send lane without a read-back lane is how silent message loss hides"
  );
});

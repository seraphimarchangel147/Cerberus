// Discord callers always retain their replyToId. These tests exercise the
// final REST bodies because the toggle's purpose is to change Discord's
// presentation without changing turn, approval, or live-status call sites.
import assert from "node:assert/strict";
import test from "node:test";
import { DiscordChannel, discordReplyEnabled, extractDiscordUserMentionIds } from "../src/discord-channel.js";

function isolateReplyEnv(t) {
  const previous = process.env.DISCORD_REPLY;
  delete process.env.DISCORD_REPLY;
  t.after(() => {
    if (previous === undefined) delete process.env.DISCORD_REPLY;
    else process.env.DISCORD_REPLY = previous;
  });
}

function makeChannelHarness() {
  const requests = [];
  const channel = Object.create(DiscordChannel.prototype);
  channel.rest = async (route, options) => {
    requests.push({ route, options: structuredClone(options) });
    return { id: `message_${requests.length}` };
  };
  return { channel, requests };
}

test("explicit raw user mentions are allowlisted without enabling mass or role pings", async () => {
  const { channel, requests } = makeChannelHarness();
  await channel.sendMessage(
    "channel-1",
    "<@1487563271753040063> hello @everyone <@&999999999999999999> <@!1487563271753040063> <@1493089655531241634>"
  );
  assert.deepEqual(extractDiscordUserMentionIds(requests[0].options.body.content), [
    "1487563271753040063",
    "1493089655531241634"
  ]);
  assert.deepEqual(requests[0].options.body.allowed_mentions, {
    parse: [],
    users: ["1487563271753040063", "1493089655531241634"]
  });
});

test("Discord reply quoting defaults off for messages and embeds", async (t) => {
  isolateReplyEnv(t);
  const { channel, requests } = makeChannelHarness();

  await channel.sendMessage("channel", "plain reply", "source_message");
  await channel.sendEmbed("channel", { description: "live status" }, "source_message");

  assert.equal(discordReplyEnabled(), false);
  assert.equal(Object.hasOwn(requests[0].options.body, "message_reference"), false);
  assert.equal(Object.hasOwn(requests[1].options.body, "message_reference"), false);

  // Thread anchoring is a different Discord endpoint and must not depend on
  // whether ordinary bot posts quote the user's original message.
  await channel.createThread("channel", "status_message", "long task");
  assert.equal(requests[2].route, "/channels/channel/messages/status_message/threads");
  assert.deepEqual(requests[2].options.body, { name: "long task", auto_archive_duration: 60 });
});

test("DISCORD_REPLY=1 restores message references", async (t) => {
  isolateReplyEnv(t);
  process.env.DISCORD_REPLY = "1";
  const { channel, requests } = makeChannelHarness();

  await channel.sendMessage("channel", "quoted reply", "source_message");
  await channel.sendEmbed("channel", { description: "quoted status" }, "source_message");

  const expected = { message_id: "source_message", fail_if_not_exists: false };
  assert.equal(discordReplyEnabled(), true);
  assert.deepEqual(requests[0].options.body.message_reference, expected);
  assert.deepEqual(requests[1].options.body.message_reference, expected);
});

test("DISCORD_REPLY is read live without reconstructing the channel", async (t) => {
  isolateReplyEnv(t);
  const { channel, requests } = makeChannelHarness();

  await channel.sendMessage("channel", "first", "source_message");
  process.env.DISCORD_REPLY = "true";
  await channel.sendMessage("channel", "second", "source_message");
  process.env.DISCORD_REPLY = "off";
  await channel.sendMessage("channel", "third", "source_message");

  assert.equal(Object.hasOwn(requests[0].options.body, "message_reference"), false);
  assert.deepEqual(requests[1].options.body.message_reference, {
    message_id: "source_message",
    fail_if_not_exists: false
  });
  assert.equal(Object.hasOwn(requests[2].options.body, "message_reference"), false);
});

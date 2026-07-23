// Discord delivery is concurrent across conversations but remains ordered
// within one session. These tests use deferred turns so overlap is observed
// directly instead of inferred from timing.
import assert from "node:assert/strict";
import test from "node:test";
import { DiscordChannel } from "../src/discord-channel.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function message({ id, guild = "guild-1", channel = "channel-1", user = "user-1" }) {
  return {
    id,
    guild_id: guild,
    channel_id: channel,
    author: { id: user }
  };
}

function makeHarness(runTurn) {
  const channel = Object.create(DiscordChannel.prototype);
  channel.turnLocks = new Map();
  channel.runTurn = runTurn;
  channel.log = () => {};
  channel.sendMessage = async () => null;
  return channel;
}

test("sessionKeyFor isolates guild users while preserving DM continuity", () => {
  const channel = Object.create(DiscordChannel.prototype);

  assert.equal(
    channel.sessionKeyFor(message({ id: "1", user: "author-7" })),
    "discord:guild-1:channel-1:author-7"
  );
  assert.equal(
    channel.sessionKeyFor(message({ id: "2", guild: null, channel: "dm-9", user: "author-7" })),
    "discord:dm:dm-9"
  );
});

test("different Discord session keys run concurrently", async () => {
  const gates = new Map();
  const started = [];
  const channel = makeHarness(async (input) => {
    started.push(input.id);
    const gate = deferred();
    gates.set(input.id, gate);
    await gate.promise;
  });

  const first = channel.enqueueTurn(message({ id: "first", user: "user-a" }), "one");
  const second = channel.enqueueTurn(message({ id: "second", user: "user-b" }), "two");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ["first", "second"]);
  gates.get("first").resolve();
  gates.get("second").resolve();
  await Promise.all([first, second]);
  assert.equal(channel.turnLocks.size, 0);
});

test("the same Discord session key remains serialized and its lock is collected", async () => {
  const gates = [];
  const started = [];
  const channel = makeHarness(async (input) => {
    started.push(input.id);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
  });

  const first = channel.enqueueTurn(message({ id: "first" }), "one");
  const second = channel.enqueueTurn(message({ id: "second" }), "two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);

  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  gates[1].resolve();
  await Promise.all([first, second]);
  assert.equal(channel.turnLocks.size, 0);
});

test("activity routing extracts the channel from per-user session keys", () => {
  const channel = Object.create(DiscordChannel.prototype);
  channel.lastActiveChannel = "fallback";

  assert.equal(channel.activityChannelFor("discord:9876:123456:555"), "123456");
  assert.equal(channel.activityChannelFor("discord:9876:123456"), "123456");
});

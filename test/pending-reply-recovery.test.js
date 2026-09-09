import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { AbiRuntime } from "../src/abi-runtime.js";
import { ChannelManager, TelegramChannel } from "../src/channels.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { DiscordChannel } from "../src/discord-channel.js";
import { ToolRegistry } from "../src/tool-registry.js";

const NOW = Date.parse("2026-09-09T12:00:00.000Z");

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pending-reply-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = {
    dataDir,
    tools: new ToolRegistry(),
    memory: { retrieve: () => [], renderSessionMemorySnapshot: () => "", remember: () => ({ id: "memory" }) },
    processSignal: () => ({
      id: "output",
      scrutiny: { action: "act", score: 0.7, reasons: [], dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 } },
      customContext: [],
      propagation: null
    })
  };
  const makeHost = () => new AgentHost({
    runtime,
    now: () => NOW,
    modelProvider: {
      provider: "fixture", model: "fixture-model",
      generate: async () => ({ text: "Work completed.", toolCalls: [], stopReason: "completed" })
    }
  });
  const host = makeHost();
  const dir = host.pendingRepliesDir;
  const files = () => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const marker = (overrides = {}) => ({
    sessionId: "session-1", channel: "discord", replyText: "Work completed.",
    createdAt: new Date(NOW - 1000).toISOString(), deliveryTarget: "channel-1", ...overrides
  });
  const write = (value, name = "session-1-turn-1.json") => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  return { runtime, host, makeHost, dir, files, marker, write, dataDir };
}

test("Discord persists the final reply before delivery and clears it after confirmation", async (t) => {
  const f = fixture(t);
  const channel = new DiscordChannel({ agentHost: f.host, dir: path.join(f.dataDir, "discord"), liveStatus: "0" });
  channel.rest = async () => ({});
  let sends = 0;
  channel.deliverAgentReply = async (target, text) => {
    sends += 1;
    assert.equal(f.files().length, 1);
    const marker = JSON.parse(fs.readFileSync(path.join(f.dir, f.files()[0]), "utf8"));
    assert.equal(marker.channel, "discord");
    assert.equal(marker.deliveryTarget, target);
    assert.equal(marker.replyText, text);
    assert.equal(marker.createdAt, new Date(NOW).toISOString());
    return { delivered: true, messageId: "sent-1" };
  };
  await channel.runTurn({ id: "message-1", channel_id: "channel-1", author: { id: "user-1" } }, "hello");
  assert.equal(sends, 1);
  assert.deepEqual(f.files(), []);
});

for (const confirmed of [true, false]) {
  test(`Telegram ${confirmed ? "clears confirmed" : "retains unconfirmed"} pending replies`, async (t) => {
    const f = fixture(t);
    const channel = new TelegramChannel({
      agentHost: f.host, token: "fixture-token", dir: path.join(f.dataDir, "telegram"),
      pairing: { isAllowed: () => true }
    });
    channel.sendMessage = async () => {
      assert.equal(f.files().length, 1, "marker exists before the transport is called");
      return { ok: true, result: confirmed ? { message_id: 1 } : {} };
    };
    await channel.handleUpdate({ message: { text: "hello", chat: { id: 42 }, from: {} } });
    assert.equal(f.files().length, confirmed ? 0 : 1);
  });
}

test("a failed live delivery leaves a recoverable reply", async (t) => {
  const f = fixture(t);
  const channel = new TelegramChannel({
    agentHost: f.host, token: "fixture-token", dir: path.join(f.dataDir, "telegram"),
    pairing: { isAllowed: () => true }
  });
  channel.sendMessage = async () => { throw new Error("offline"); };
  await assert.rejects(channel.handleUpdate({ message: { text: "hello", chat: { id: 42 }, from: {} } }), /offline/);
  assert.equal(f.files().length, 1);
});

test("channel boot recovers once and a second boot has nothing to replay", async (t) => {
  const f = fixture(t);
  f.write(f.marker());
  const deliveries = [];
  for (let boot = 0; boot < 2; boot += 1) {
    const channels = new ChannelManager({ agentHost: f.makeHost(), dir: path.join(f.dataDir, "channels") });
    channels.discord.start = () => {};
    channels.telegram.startPolling = () => {};
    channels.deliver = async (payload) => { deliveries.push(payload); return { delivered: true }; };
    await channels.start();
  }
  assert.deepEqual(deliveries, [{ sessionId: "session-1", channel: "discord", target: "channel-1", text: "(recovered after restart)\nWork completed." }]);
  assert.deepEqual(f.files(), []);
});

test("concurrent recovery scans claim a reply only once", async (t) => {
  const f = fixture(t);
  f.write(f.marker());
  let deliveries = 0;
  const channels = { deliver: async () => { deliveries += 1; await new Promise((resolve) => setImmediate(resolve)); } };
  await Promise.all([f.host.recoverPendingReplies(channels), f.makeHost().recoverPendingReplies(channels)]);
  assert.equal(deliveries, 1);
  assert.deepEqual(f.files(), []);
});

for (const value of ["{ broken json", "null", JSON.stringify({ sessionId: "missing-fields" })]) {
  test(`corrupt marker is quarantined: ${value}`, async (t) => {
    const f = fixture(t);
    f.write(value);
    f.write(f.marker(), "valid.json");
    let deliveries = 0;
    await f.host.recoverPendingReplies({ deliver: async () => { deliveries += 1; } });
    assert.equal(deliveries, 1, "valid markers survive a corrupt neighbor");
    assert.deepEqual(f.files(), ["session-1-turn-1.json.bad"]);
    assert.equal(fs.readFileSync(path.join(f.dir, f.files()[0]), "utf8"), value);
  });
}

for (const age of [24 * 60 * 60 * 1000, 25 * 60 * 60 * 1000, -1000]) {
  test(`expired or future marker is dropped unsent (age ${age})`, async (t) => {
    const f = fixture(t);
    f.write(f.marker({ createdAt: new Date(NOW - age).toISOString() }));
    let sends = 0;
    await f.host.recoverPendingReplies({ deliver: async () => { sends += 1; } });
    assert.equal(sends, 0);
    assert.deepEqual(f.files(), []);
  });
}

test("a failed recovery is attempted once across boots", async (t) => {
  const f = fixture(t);
  f.write(f.marker());
  let sends = 0;
  const channels = { deliver: async () => { sends += 1; throw new Error("offline"); } };
  await f.host.recoverPendingReplies(channels);
  await f.makeHost().recoverPendingReplies(channels);
  assert.equal(sends, 1);
  assert.deepEqual(f.files(), []);
});

test("leftover recovery claims and confirmed receipts are cleaned without replay", async (t) => {
  const f = fixture(t);
  f.write(f.marker(), "interrupted.json.recovering");
  f.write(f.marker(), "confirmed.json.delivered");
  let sends = 0;
  await f.host.recoverPendingReplies({ deliver: async () => { sends += 1; } });
  assert.equal(sends, 0);
  assert.deepEqual(f.files(), []);
});

test("reply text is capped at 64KB without splitting a UTF-8 character", (t) => {
  const f = fixture(t);
  const replyText = "a".repeat(65535) + "😀";
  f.host.persistPendingReply({ ...f.marker({ replyText }), turnId: "turn-1" });
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, f.files()[0]), "utf8"));
  assert.equal(saved.replyText, "a".repeat(65535));
  assert.ok(Buffer.byteLength(saved.replyText) <= 65536);
});

test("marker filenames contain session and turn identifiers without path traversal", (t) => {
  const f = fixture(t);
  f.host.persistPendingReply({ ...f.marker({ sessionId: "../session" }), turnId: "../turn" });
  assert.deepEqual(f.files(), ["..%2Fsession-..%2Fturn.json"]);
  f.host.confirmReplyDelivery({ session: { id: "../session" }, id: "../turn" }, { delivered: true });
  assert.deepEqual(f.files(), []);
});

test("marker write and read failures never break a live turn or boot", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.dir), { recursive: true });
  fs.writeFileSync(f.dir, "not a directory");
  const result = await f.host.handleMessage({ channel: "telegram", from: "42", text: "hello" });
  assert.equal(result.reply, "Work completed.");
  await assert.doesNotReject(f.host.recoverPendingReplies({ deliver: async () => assert.fail("must not send") }));
  assert.doesNotThrow(() => f.host.confirmReplyDelivery(result, { delivered: true }));
});

test("ephemeral turns and channels without outbound delivery leave no pending reply", async (t) => {
  const f = fixture(t);
  await f.host.handleMessage({ channel: "telegram", from: "42", text: "hello", ephemeral: true });
  await f.host.handleMessage({ channel: "local", text: "hello" });
  assert.deepEqual(f.files(), []);
});

for (const silent of [false, true]) {
  test(`scheduled replies ${silent ? "suppress silent output without a marker" : "persist before delivery and clear on confirmation"}`, async (t) => {
    const f = fixture(t);
    if (silent) f.host.modelProvider.generate = async () => ({ text: "[SILENT]", toolCalls: [] });
    const cron = new CronScheduler({ modelResolver: () => ({ provider: "fixture", model: "fixture-model" }) });
    let sends = 0;
    const runtime = Object.assign(Object.create(AbiRuntime.prototype), {
      agentHost: f.host,
      cron,
      channels: { deliver: async () => {
        sends += 1;
        assert.equal(f.files().length, 1);
        return { delivered: true };
      } }
    });
    const job = cron.addJob({
      id: "scheduled-reply", task: "prompt", intervalMs: 60000,
      input: { prompt: "hello", channel: "discord", target: "channel-1", sessionId: "scheduled-session" }
    });
    await runtime.runScheduledPrompt(job);
    assert.equal(sends, silent ? 0 : 1);
    assert.deepEqual(f.files(), []);
  });
}

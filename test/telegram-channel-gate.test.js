// test/telegram-channel-gate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TelegramChannel } from "../src/channels.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function makeChannel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-chan-"));
  const handled = [];
  const sends = [];
  const channel = new TelegramChannel({
    token: "123:ABC",
    dir,
    agentHost: {
      handleMessage: async (input) => {
        handled.push(input);
        return { reply: "agent reply", session: { id: "s1" } };
      }
    }
  });
  channel.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { ok: true };
  };
  return { channel, handled, sends, dir };
}

function update(chatId, text) {
  return {
    update_id: 1,
    message: { message_id: 10, chat: { id: chatId }, from: { username: "u", first_name: "U" }, text }
  };
}

test("messages from non-allowlisted chats are ignored with no reply and no agent turn", async () => {
  const { channel, handled, sends } = makeChannel();
  const result = await channel.handleUpdate(update(555, "hello"));
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "not-allowlisted");
  assert.equal(handled.length, 0);
  assert.equal(sends.length, 0);
});

test("a failed /pair gets no reply (unknown senders learn nothing)", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const wrong = code === "000000" ? "111111" : "000000";
  const r = await channel.handleUpdate(update(555, "/pair " + wrong));
  assert.equal(r.paired, false);
  assert.equal(sends.length, 0);
  assert.equal(handled.length, 0);
  assert.equal(channel.pairing.isAllowed("555"), false);
});

test("/pair with a valid code allowlists the chat, confirms, and opens the channel", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const r = await channel.handleUpdate(update(555, "/pair " + code));
  assert.equal(r.paired, true);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Paired/);
  assert.equal(channel.pairing.isAllowed("555"), true);
  // now a normal message flows to the agent and the reply is sent back
  const r2 = await channel.handleUpdate(update(555, "hello"));
  assert.equal(r2.reply, "agent reply");
  assert.equal(handled.length, 1);
  assert.equal(handled[0].channel, "telegram");
  assert.equal(handled[0].from, "555");
  assert.equal(sends.length, 2);
});

test("GET /channels/telegram/pairing-code is auth-gated and issues a 6-digit code", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-route-"));
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "test-token-abc";
  try {
    const runtime = createDurableRuntime({ dataDir });
    const app = createHostedInterface(runtime, {
      host: "127.0.0.1",
      port: 0,
      channelsDir: path.join(dataDir, "channels")
    });
    const { url } = await app.listen();
    const denied = await fetch(`${url}/channels/telegram/pairing-code`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${url}/channels/telegram/pairing-code`, {
      headers: { authorization: "Bearer test-token-abc" }
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.match(json.code, /^\d{6}$/);
    assert.ok(json.expiresAt);
    await app.close();
  } finally {
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = prevToken;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelManager, TelegramChannel } from "../src/channels.js";

function makeTempDir(t, prefix = "openagi-telegram-deliverable") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
}

function telegramFetch({ fail = new Set(), errorDescription = null } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    calls.push({ url: String(url), method, options });
    if (fail.has(method)) {
      return {
        ok: false,
        status: 400,
        async json() {
          return { ok: false, description: errorDescription ?? `${method} rejected` };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: calls.length } };
      }
    };
  };
  return { fetch, calls };
}

function makeChannel(t, options = {}) {
  const dir = makeTempDir(t);
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(homeDir);
  const transport = telegramFetch(options);
  const channel = new TelegramChannel({
    token: "123:test",
    dir: path.join(dir, "channel"),
    fetch: transport.fetch,
    deliverableOptions: { homeDir },
    pairing: options.pairing,
    agentHost: options.agentHost ?? {
      async handleMessage() {
        return { reply: "ok" };
      }
    }
  });
  return { channel, homeDir, ...transport };
}

function messageText(calls) {
  const call = calls.findLast((entry) => entry.method === "sendMessage");
  assert.ok(call, "Telegram text fallback was not sent");
  return JSON.parse(call.options.body).text;
}

test("Telegram routes deliverable categories through native attachment methods", async (t) => {
  const { channel, homeDir, calls } = makeChannel(t);
  writeFiles(homeDir, {
    "chart.png": Buffer.from("image"),
    "clip.mp4": Buffer.from("video"),
    "voice.mp3": Buffer.from("audio"),
    "report.pdf": Buffer.from("document")
  });

  const result = await channel.deliverAgentReply(
    "42",
    "Files: ~/chart.png ~/clip.mp4 ~/voice.mp3 ~/report.pdf"
  );

  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendPhoto", "sendVideo", "sendAudio", "sendDocument", "sendMessage"]
  );
  const fields = [
    ["photo", "chart.png"],
    ["video", "clip.mp4"],
    ["audio", "voice.mp3"],
    ["document", "report.pdf"]
  ];
  for (const [index, [field, filename]] of fields.entries()) {
    const form = calls[index].options.body;
    assert.equal(form.get("chat_id"), "42");
    assert.equal(form.get(field).name, filename);
  }
  assert.equal(result.successfulCandidates.length, 4);
  assert.doesNotMatch(messageText(calls), /~\//);
});

test("Telegram strips only paths whose uploads succeeded", async (t) => {
  const { channel, homeDir, calls } = makeChannel(t, {
    fail: new Set(["sendPhoto"]),
    errorDescription: "sendPhoto rejected token 123:test"
  });
  writeFiles(homeDir, {
    "failed.png": Buffer.from("image"),
    "sent.pdf": Buffer.from("document")
  });

  const result = await channel.deliverAgentReply(
    "42",
    "Image ~/failed.png and document ~/sent.pdf"
  );

  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendPhoto", "sendDocument", "sendMessage"]
  );
  assert.equal(result.successfulCandidates.length, 1);
  assert.match(messageText(calls), /~\/failed\.png/);
  assert.doesNotMatch(messageText(calls), /~\/sent\.pdf/);
  const events = fs.readFileSync(channel.eventsPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map(JSON.parse);
  assert.equal(events.at(-1).op, "deliverable-error");
  assert.equal(events.at(-1).category, "image");
  assert.doesNotMatch(events.at(-1).error, /123:test/);
  assert.match(events.at(-1).error, /\[REDACTED\]/);
});

test("Telegram webhook replies use deliverable mode after the pairing gate", async (t) => {
  const pairing = {
    isAllowed: () => true,
    status: () => ({ paired: 1 }),
    attempt: () => ({ ok: false, reason: "unused" })
  };
  const handled = [];
  const { channel, homeDir, calls } = makeChannel(t, {
    pairing,
    agentHost: {
      async handleMessage(input) {
        handled.push(input);
        return { reply: "Generated ~/chart.png" };
      }
    }
  });
  writeFiles(homeDir, { "chart.png": Buffer.from("image") });

  const result = await channel.handleUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: 42 },
      from: { username: "tester" },
      text: "make a chart"
    }
  });

  assert.equal(result.reply, "Generated ~/chart.png");
  assert.equal(handled.length, 1);
  assert.deepEqual(calls.map((call) => call.method), ["sendPhoto", "sendMessage"]);
  assert.doesNotMatch(messageText(calls), /chart\.png/);
});

test("ChannelManager uses channel deliverable entry points for outbound text", async (t) => {
  const dir = makeTempDir(t, "openagi-channel-manager-deliverable");
  const outcomes = [];
  const manager = new ChannelManager({
    dir,
    telegramToken: "",
    discordToken: "",
    agentHost: {
      runtime: {
        outcomes: {
          record(value) {
            outcomes.push(value);
          }
        }
      },
      async handleMessage() {
        return { reply: "unused" };
      }
    }
  });
  const calls = [];
  manager.telegram.deliverAgentReply = async (target, text) => {
    calls.push({ channel: "telegram", target, text });
    return { text };
  };
  manager.discord.deliverAgentReply = async (target, text) => {
    calls.push({ channel: "discord", target, text });
    return { text };
  };
  manager.telegram.sendMessage = async () => {
    throw new Error("legacy Telegram sendMessage path used");
  };
  manager.discord.sendMessage = async () => {
    throw new Error("legacy Discord sendMessage path used");
  };

  await manager.deliver({ channel: "telegram", target: "t", text: "one" });
  await manager.deliver({ channel: "discord", target: "d", text: "two" });

  assert.deepEqual(calls, [
    { channel: "telegram", target: "t", text: "one" },
    { channel: "discord", target: "d", text: "two" }
  ]);
  assert.equal(outcomes.length, 2);
});

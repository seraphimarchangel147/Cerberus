// test/outreach-digest-telegram.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { deliverDigest } from "../src/outreach-digest.js";
import { createDurableRuntime } from "../src/index.js";

function stubTelegram({ chats = ["111", "222"], failFor = [] } = {}) {
  const sent = [];
  return {
    sent,
    token: "123:ABC",
    pairing: { allowlist: () => chats },
    async sendMessage(chatId, text) {
      if (failFor.includes(chatId)) throw new Error("boom");
      sent.push({ chatId, text });
      return { ok: true };
    }
  };
}

const item = { id: "out_1", title: "Your queue: 2 drafts", summary: "• d1\n• d2" };

test("destination telegram sends the digest to every allowlisted chat", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: () => {} });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ["111", "222"]);
  assert.match(tg.sent[0].text, /Your queue: 2 drafts/);
  assert.match(tg.sent[0].text, /• d1/);
  assert.equal(result.telegram.attempted, true);
  assert.deepEqual(result.telegram.sent, ["111", "222"]);
});

test("destination both also sends via telegram", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "both", telegram: tg, log: () => {} });
  assert.equal(result.telegram.attempted, true);
  assert.equal(tg.sent.length, 2);
});

test("destination mac never touches telegram", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "mac", telegram: tg, log: () => {} });
  assert.equal(tg.sent.length, 0);
  assert.equal(result.telegram.attempted, false);
});

test("falls back to mac-only with a warning when TELEGRAM_BOT_TOKEN is unset", async () => {
  const warnings = [];
  const result = await deliverDigest(item, {
    destination: "telegram",
    telegram: { token: undefined },
    log: (m) => warnings.push(m)
  });
  assert.equal(result.telegram.attempted, false);
  assert.equal(result.telegram.fallback, "mac");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TELEGRAM_BOT_TOKEN/);
});

test("falls back to mac-only with a warning when no telegram channel exists at all", async () => {
  const warnings = [];
  const result = await deliverDigest(item, { destination: "telegram", telegram: null, log: (m) => warnings.push(m) });
  assert.equal(result.telegram.attempted, false);
  assert.equal(warnings.length, 1);
});

test("falls back to mac-only with a warning when the allowlist is empty", async () => {
  const warnings = [];
  const tg = stubTelegram({ chats: [] });
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: (m) => warnings.push(m) });
  assert.equal(result.telegram.attempted, false);
  assert.equal(result.telegram.fallback, "mac");
  assert.match(warnings[0], /allowlist/);
});

test("a failed send to one chat does not stop the others", async () => {
  const tg = stubTelegram({ chats: ["111", "222"], failFor: ["111"] });
  const warnings = [];
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: (m) => warnings.push(m) });
  assert.deepEqual(result.telegram.sent, ["222"]);
  assert.equal(result.telegram.failed.length, 1);
  assert.equal(result.telegram.failed[0].chatId, "111");
});

test("runOutreachDigest routes to telegram end-to-end from outreach.json destination", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-tg-"));
  fs.writeFileSync(path.join(dataDir, "outreach.json"), JSON.stringify({ destination: "telegram" }));
  const runtime = createDurableRuntime({ dataDir });
  runtime.outreach.append({ type: "draft", title: "d1" });
  const tg = stubTelegram({ chats: ["999"] });
  runtime.channels = { telegram: tg };
  const result = await runtime.runOutreachDigest({ now: new Date("2026-07-06T12:00:00") });
  assert.equal(result.ok, true);
  assert.ok(result.digestId);
  assert.deepEqual(result.delivery.telegram.sent, ["999"]);
  assert.match(tg.sent[0].text, /1 draft/);
});

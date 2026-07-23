import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { deliverLegionMailbox, legionMailboxPath, readLegionMailbox } from "../src/legion-mailbox.js";

function runtimeWithDeliver(deliver) {
  return {
    dataDir: "/nonexistent",
    channels: { deliver },
    toolOutputs: { read() {} }
  };
}

test("sibling send prefixes Ziz's raw Discord mention and resolves his channel", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtimeWithDeliver(async (input) => {
    calls.push(input);
    return { message: { id: "discord-message-1" } };
  }));

  const result = await registry.get("send_message").handler({
    channel: "sibling",
    target: "ZIZ",
    text: "routing check"
  });

  assert.deepEqual(calls, [{
    channel: "discord",
    target: "1488300124395540501",
    text: "<@1487563271753040063> routing check"
  }]);
  assert.equal(result.delivered, true);
  assert.equal(result.mention, "<@1487563271753040063>");
  assert.equal(result.messageId, "discord-message-1");
});

test("sibling send does not duplicate an existing raw mention", async () => {
  let sent = null;
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtimeWithDeliver(async (input) => {
    sent = input;
    return { id: "discord-message-2" };
  }));

  await registry.get("send_message").handler({
    channel: "sibling",
    target: "ziz",
    text: "<@1487563271753040063> already addressed"
  });
  assert.equal(sent.text, "<@1487563271753040063> already addressed");
});

test("mailbox transport writes structured unique records and skips malformed duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  const first = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "local ping", correlationId: "corr-1" }, env);
  const second = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "second" }, env);

  assert.equal(first.delivered, true);
  assert.equal(first.transport, "mailbox");
  assert.notEqual(first.messageId, second.messageId);
  assert.equal(first.destination, legionMailboxPath("ziz", env));
  const source = legionMailboxPath("ziz", env);
  fs.appendFileSync(source, "not-json\n");
  fs.appendFileSync(source, `${JSON.stringify(first.record)}\n`);

  const records = readLegionMailbox("ziz", {}, env);
  assert.deepEqual(records.map((record) => record.id), [first.messageId, second.messageId]);
  assert.equal(records[0].correlationId, "corr-1");
  assert.equal(records[0].transport, "mailbox");
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(source).mode & 0o777, 0o600);
});

test("mailbox tool returns a verifiable delivery envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-tool-mailbox-"));
  const oldRoot = process.env.LEGION_HOME;
  const oldName = process.env.OPENAGI_AGENT_NAME;
  process.env.LEGION_HOME = root;
  process.env.OPENAGI_AGENT_NAME = "azazel";
  try {
    const registry = new ToolRegistry();
    registerCoreTools(registry, runtimeWithDeliver(async () => { throw new Error("Discord should not be used"); }));
    const result = await registry.get("send_message").handler({ channel: "mailbox", target: "ziz", text: "fallback" });
    assert.equal(result.delivered, true);
    assert.equal(result.recipient, "ziz");
    assert.match(result.messageId, /^legion_/u);
    assert.equal(readLegionMailbox("ziz", {}, process.env)[0].text, "fallback");
  } finally {
    if (oldRoot == null) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = oldRoot;
    if (oldName == null) delete process.env.OPENAGI_AGENT_NAME; else process.env.OPENAGI_AGENT_NAME = oldName;
  }
});

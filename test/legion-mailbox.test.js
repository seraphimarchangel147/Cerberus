import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import {
  deliverLegionMailbox,
  legionInboxPathV2,
  legionMailboxPath,
  readLegionMailbox
} from "../src/legion-mailbox.js";
import { LINK_ENVELOPE_V2_SCHEMA, parseLinkEnvelope } from "../src/legion-link-v2.js";

const TEST_KEY_HEX = "0123456789abcdef".repeat(4); // 32 bytes, hex-encoded
const TEST_KEY_ID = "test-key.v1";

function runtimeWithDeliver(deliver) {
  return {
    dataDir: "/nonexistent",
    channels: { deliver },
    toolOutputs: { read() {} }
  };
}

// Provision a mailbox-v2 key in the zerohermes wire format: "<key_id> <hex>".
function provisionKey(root, name, { keyId = TEST_KEY_ID, hex = TEST_KEY_HEX, mode = 0o600 } = {}) {
  const dir = path.join(root, "keys");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const keyPath = path.join(dir, `${name}.key`);
  fs.writeFileSync(keyPath, `${keyId} ${hex}\n`, { mode: 0o600 });
  if (mode !== 0o600) fs.chmodSync(keyPath, mode);
  return keyPath;
}

function readInboxLines(root, name) {
  const inbox = path.join(root, "inbox", `agent--${name}.jsonl`);
  return fs.readFileSync(inbox, "utf8").trim().split("\n");
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

  // The sibling lane now also carries project/session provenance so a
  // cross-agent send is attributable and project-scoped like every other
  // channel delivery (merged with the project-composition-root work).
  assert.deepEqual(calls, [{
    channel: "discord",
    target: "1488300124395540501",
    text: "<@1487563271753040063> routing check",
    sessionId: null,
    projectId: "default"
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

test("mailbox v2 deliver writes spec-conformant signed envelopes with durable seq", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  provisionKey(root, "azazel");

  const first = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "local ping" }, env);
  const second = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "second" }, env);

  assert.equal(first.delivered, true);
  assert.equal(first.transport, "mailbox");
  assert.notEqual(first.messageId, second.messageId);
  assert.match(first.messageId, /^legion_[A-Za-z0-9_-]{16,64}$/u);
  assert.equal(first.destination, legionInboxPathV2("ziz", env));
  // Initiating envelope: correlation_id and causation_id default to the id.
  assert.equal(first.correlationId, first.messageId);

  const lines = readInboxLines(root, "ziz");
  assert.equal(lines.length, 2);
  const e1 = parseLinkEnvelope(lines[0]);
  const e2 = parseLinkEnvelope(lines[1]);
  assert.equal(e1.schema, LINK_ENVELOPE_V2_SCHEMA);
  assert.equal(Object.keys(e1).length, 16);
  assert.equal(e1.from, "agent:azazel");
  assert.equal(e1.to, "agent:ziz");
  assert.equal(e1.kind, "message");
  assert.equal(e1.content_type, "text/plain; charset=utf-8");
  assert.equal(e1.body, "local ping");
  assert.equal(e1.ttl_ms, 86_400_000); // zerohermes DEFAULT_TTL_MS parity
  assert.equal(e1.max_hops, 4);        // zerohermes DEFAULT_MAX_HOPS parity
  assert.equal(e1.hop_count, 0);
  assert.equal(e1.causation_id, e1.id);
  assert.equal(e1.auth.key_id, TEST_KEY_ID);
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);

  // Sequence is durably persisted in the shared layout zerohermes owns.
  const seqFile = path.join(root, "state", `outbound--azazel--${TEST_KEY_ID}.seq`);
  assert.equal(fs.readFileSync(seqFile, "utf8").trim(), "2");

  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(legionInboxPathV2("ziz", env)).mode & 0o777, 0o600);
});

test("mailbox v2 read verifies, accepts, maps, and re-reads idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  provisionKey(root, "azazel");

  const first = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "local ping" }, env);
  const second = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "second" }, env);

  const records = readLegionMailbox("ziz", {}, env);
  assert.deepEqual(records.map((record) => record.id), [first.messageId, second.messageId]);
  assert.equal(records[0].text, "local ping");
  assert.equal(records[0].from, "azazel");
  assert.equal(records[0].to, "ziz");
  assert.equal(records[0].transport, "mailbox");
  assert.equal(records[0].correlationId, first.messageId);
  assert.equal(records[0].replyTo, null);
  assert.equal(records[0].kind, "message");
  assert.equal(records[0].seq, 1);
  assert.ok(Number.isSafeInteger(records[0].sent_at_ms));
  assert.ok(!Number.isNaN(Date.parse(records[0].ts)));

  // Acceptance is durable: receipts prove the exact authenticated identity.
  const state = JSON.parse(fs.readFileSync(path.join(root, "state", "accepted.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.deepEqual(state.ids, [first.messageId, second.messageId]);
  assert.equal(state.high_water[`agent:azazel\n${TEST_KEY_ID}`], 2);
  assert.equal(state.receipts[first.messageId].from, "agent:azazel");
  assert.equal(state.receipts[first.messageId].key_id, TEST_KEY_ID);
  assert.equal(state.receipts[first.messageId].seq, 1);
  assert.match(state.receipts[first.messageId].envelope_sha256, /^[a-f0-9]{64}$/u);

  // Idempotent re-read: no Replay/DuplicateId, same mapped records.
  const reread = readLegionMailbox("ziz", {}, env);
  assert.deepEqual(reread.map((record) => record.id), [first.messageId, second.messageId]);

  // afterId still pages from a known record.
  const paged = readLegionMailbox("ziz", { afterId: first.messageId }, env);
  assert.deepEqual(paged.map((record) => record.id), [second.messageId]);
});

test("mailbox v2 read rejects malformed, tampered, and replayed lines without exposing bodies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  provisionKey(root, "azazel");

  const good = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "authentic" }, env);
  const inbox = legionInboxPathV2("ziz", env);
  const [validLine] = readInboxLines(root, "ziz");

  // First read accepts the authentic envelope.
  assert.deepEqual(readLegionMailbox("ziz", {}, env).map((record) => record.id), [good.messageId]);

  // Body-tampered envelope: valid MAC over the original body, altered body.
  const forged = { ...parseLinkEnvelope(validLine), body: "forged body" };
  fs.appendFileSync(inbox, "not-json\n");
  fs.appendFileSync(inbox, `${JSON.stringify(forged)}\n`);
  fs.appendFileSync(inbox, `${validLine}\n`); // exact duplicate line

  const records = readLegionMailbox("ziz", {}, env);
  assert.deepEqual(records.map((record) => record.id), [good.messageId]);
  assert.equal(records[0].text, "authentic");
  // not-json (parse failure) + forged (InvalidMac) are rejected; the exact
  // duplicate re-verifies against its receipt and is deduped silently.
  assert.equal(records.rejected, 2);
});

test("mailbox v2 read rejects envelopes from senders with no provisioned key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  provisionKey(root, "azazel");
  const sent = deliverLegionMailbox({ from: "azazel", to: "ziz", text: "keyed" }, env);

  // Reader cannot resolve any sender key: fail closed per line, body hidden.
  const keyPath = path.join(root, "keys", "azazel.key");
  fs.renameSync(keyPath, path.join(root, "keys", "azazel.key.withdrawn"));
  const records = readLegionMailbox("ziz", {}, env);
  assert.deepEqual(records, []);
  assert.equal(records.rejected, 1);
  assert.ok(sent.messageId);
});

test("mailbox v2 delivery fails closed without a provisioned sender key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  assert.throws(
    () => deliverLegionMailbox({ from: "azazel", to: "ziz", text: "no key" }, env),
    /not provisioned/u
  );
  assert.equal(fs.existsSync(path.join(root, "inbox")), false);
});

test("mailbox v2 rejects sender key files with permissive modes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  provisionKey(root, "azazel", { mode: 0o644 });
  assert.throws(
    () => deliverLegionMailbox({ from: "azazel", to: "ziz", text: "bad perms" }, env),
    /owner-only permissions/u
  );
});

test("v1 legacy records are unreadable by default and untrusted under explicit compat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-mailbox-"));
  const env = { LEGION_HOME: root };
  const legacyPath = legionMailboxPath("ziz", env);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 });
  const legacy = {
    id: `legion_${"a".repeat(16)}`,
    ts: new Date().toISOString(),
    from: "azazel",
    to: "ziz",
    text: "legacy v1",
    transport: "mailbox",
    replyTo: null,
    correlationId: null
  };
  fs.writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  // Default: v1 records are invisible — no compat, no key requirement.
  assert.deepEqual(readLegionMailbox("ziz", {}, env), []);

  // Explicit compat: readable but marked untrusted and never tool-capable.
  const compat = readLegionMailbox("ziz", {}, { ...env, LEGION_MAILBOX_V1_COMPAT: "1" });
  assert.equal(compat.length, 1);
  assert.equal(compat[0].text, "legacy v1");
  assert.equal(compat[0].transport, "mailbox-v1");
  assert.equal(compat[0].untrusted, true);
});

test("mailbox tool returns a verifiable v2 delivery envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-tool-mailbox-"));
  provisionKey(root, "azazel");
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
    assert.equal(result.record.schema, LINK_ENVELOPE_V2_SCHEMA);
    assert.equal(result.record.from, "agent:azazel");
    assert.equal(readLegionMailbox("ziz", {}, process.env)[0].text, "fallback");
  } finally {
    if (oldRoot == null) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = oldRoot;
    if (oldName == null) delete process.env.OPENAGI_AGENT_NAME; else process.env.OPENAGI_AGENT_NAME = oldName;
  }
});

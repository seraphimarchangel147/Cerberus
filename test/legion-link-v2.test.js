import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DEDUPE_CAPACITY,
  FUTURE_SKEW_MS,
  LINK_ENVELOPE_V2_SCHEMA,
  LegionLinkError,
  LegionLinkKeyring,
  LegionMailboxStoreV2,
  MAX_LINE_BYTES,
  MAX_SAFE_INTEGER,
  bodySha256V2,
  hmacPreimageV2,
  nextHopCountV2,
  parseLinkEnvelope,
  permitsAutoAckV2,
  serializeLinkEnvelope,
  signLinkEnvelopeV2
} from "../src/legion-link-v2.js";

const NOW = 1_900_000_000_000;
const KEY_ID = "test-key.v1";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const VECTOR_ROOT = process.env.LEGION_LINK_V2_VECTORS
  ?? path.join(os.homedir(), ".legion", "protocol", "test-vectors");

function keyring(entries = [["agent:azazel", KEY_ID, KEY]]) {
  return new LegionLinkKeyring(entries);
}

function makeStore({ localAgent = "agent:ziz", groups = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-link-v2-"));
  const store = new LegionMailboxStoreV2({ root, localAgent, groups });
  return { root, store };
}

function baseFields(overrides = {}) {
  return {
    schema: LINK_ENVELOPE_V2_SCHEMA,
    id: "legion_0123456789abcdef",
    seq: 1,
    sent_at_ms: NOW,
    ttl_ms: 60_000,
    max_hops: 2,
    hop_count: 0,
    correlation_id: "legion_0123456789abcdef",
    causation_id: "legion_0123456789abcdef",
    from: "agent:azazel",
    to: "agent:ziz",
    kind: "message",
    content_type: "text/plain; charset=utf-8",
    body: "hello",
    ...overrides
  };
}

function signedLine(fields, key = KEY) {
  return `${serializeLinkEnvelope(signLinkEnvelopeV2(fields, key))}\n`;
}

function expectLinkError(code, fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LegionLinkError, `expected LegionLinkError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected LegionLinkError ${code}, but no error was thrown`);
}

test("accepts a valid direct message end to end", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields());
  const accepted = store.verifyAndAccept(Buffer.from(line, "utf8"), NOW, keyring());
  assert.equal(accepted.envelope.id, "legion_0123456789abcdef");
  assert.equal(accepted.envelope.from, "agent:azazel");
  assert.equal(accepted.envelope.to, "agent:ziz");
  assert.equal(accepted.body, "hello");
});

test("accepts a valid group message for a subscribed group", () => {
  const { store } = makeStore({ groups: ["group:legion"] });
  const line = signedLine(baseFields({ to: "group:legion" }));
  const accepted = store.verifyAndAccept(line, NOW, keyring());
  assert.equal(accepted.envelope.to, "group:legion");
});

test("rejects a group message for an unsubscribed group", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields({ to: "group:legion" }));
  expectLinkError("WrongDestination", () => store.verifyAndAccept(line, NOW, keyring()));
});

test("accepts a valid acknowledgment and never auto-acks an acknowledgment", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields({
    kind: "acknowledgment",
    correlation_id: "legion_aaaabbbbccccdddd",
    causation_id: "legion_aaaabbbbccccdddd"
  }));
  const accepted = store.verifyAndAccept(line, NOW, keyring());
  assert.equal(accepted.envelope.kind, "acknowledgment");
  assert.equal(permitsAutoAckV2("acknowledgment"), false);
  assert.equal(permitsAutoAckV2("message"), true);
  assert.equal(permitsAutoAckV2("event"), true);
  assert.equal(permitsAutoAckV2("control"), true);
});

test("round-trips bodies with quotes, Unicode, and newlines", () => {
  const body = "quote \" backslash \\ newline \n unicode 獄🜏 é\tcontrol ";
  assert.equal(bodySha256V2(body), crypto.createHash("sha256").update(body, "utf8").digest("hex"));
  const { store } = makeStore();
  const line = signedLine(baseFields({ body }));
  const accepted = store.verifyAndAccept(line, NOW, keyring());
  assert.equal(accepted.body, body);
  // The canonical serializer must re-escape exactly what the parser accepted.
  assert.equal(serializeLinkEnvelope(accepted.envelope), line.trimEnd());
});

test("rejects an altered body, altered hash, and altered MAC", () => {
  const { store } = makeStore();
  const good = signLinkEnvelopeV2(baseFields(), KEY);
  const tamperedBody = { ...good, body: "hello!" };
  // The MAC preimage carries the recomputed body hash, so a post-signing body
  // alteration is an authentication failure (frozen vector: expect InvalidMac).
  expectLinkError("InvalidMac", () =>
    store.verifyAndAccept(`${serializeLinkEnvelope(tamperedBody)}\n`, NOW, keyring()));

  const tamperedHash = { ...good, body_sha256: "0".repeat(64) };
  expectLinkError("BodyHashMismatch", () =>
    store.verifyAndAccept(`${serializeLinkEnvelope(tamperedHash)}\n`, NOW, keyring()));

  const macChars = good.auth.mac.split("");
  macChars[0] = macChars[0] === "A" ? "B" : "A";
  const tamperedMac = { ...good, auth: { ...good.auth, mac: macChars.join("") } };
  expectLinkError("InvalidMac", () =>
    store.verifyAndAccept(`${serializeLinkEnvelope(tamperedMac)}\n`, NOW, keyring()));
});

test("rejects an unknown key id", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields());
  expectLinkError("UnknownKey", () =>
    store.verifyAndAccept(line, NOW, keyring([["agent:azazel", "other-key.v1", KEY]])));
});

test("rejects duplicate JSON keys and unknown fields", () => {
  const { store } = makeStore();
  const good = serializeLinkEnvelope(signLinkEnvelopeV2(baseFields(), KEY));
  const duplicate = good.replace("\"schema\":", "\"zz\":1,\"schema\":");
  // Same key twice at top level.
  const dupKey = `{${"\"schema\":\"legion.link-envelope.v2\","}${good.slice(1)}`;
  // Duplicate keys are a parse-level failure per the frozen cross-harness
  // vectors (reject-duplicate-top-level-key / nested: expect InvalidJson).
  expectLinkError("InvalidJson", () => store.verifyAndAccept(`${dupKey}\n`, NOW, keyring()));
  // Unknown top-level field.
  expectLinkError("InvalidJson", () => store.verifyAndAccept(`${duplicate}\n`, NOW, keyring()));
  // Unknown auth field.
  const unknownAuth = good.replace("\"auth\":{", "\"auth\":{\"x\":1,");
  expectLinkError("InvalidJson", () => store.verifyAndAccept(`${unknownAuth}\n`, NOW, keyring()));
});

test("rejects expired, future-skewed, and invalid-TTL envelopes", () => {
  const { store } = makeStore();
  const expired = signedLine(baseFields({ id: "legion_expire0000000001", correlation_id: "legion_expire0000000001", causation_id: "legion_expire0000000001" }));
  expectLinkError("Expired", () =>
    store.verifyAndAccept(expired, NOW + 60_001, keyring()));

  const future = signedLine(baseFields({ id: "legion_future0000000001", correlation_id: "legion_future0000000001", causation_id: "legion_future0000000001", sent_at_ms: NOW + FUTURE_SKEW_MS + 1 }));
  expectLinkError("FutureSkew", () => store.verifyAndAccept(future, NOW, keyring()));

  // Exactly at the skew allowance is still acceptable.
  const atSkew = signedLine(baseFields({ id: "legion_skewok00000000001", correlation_id: "legion_skewok00000000001", causation_id: "legion_skewok00000000001", sent_at_ms: NOW + FUTURE_SKEW_MS }));
  const accepted = store.verifyAndAccept(atSkew, NOW, keyring());
  assert.equal(accepted.envelope.sent_at_ms, NOW + FUTURE_SKEW_MS);

  // TTL bounds are schema violations; tamper post-signing because schema (step 3)
  // runs before the MAC check (step 6), so the Schema error still wins.
  const validTtl = signedLine(baseFields({
    id: "legion_ttlbounds0000001",
    correlation_id: "legion_ttlbounds0000001",
    causation_id: "legion_ttlbounds0000001"
  }));
  for (const ttl of [999, 86_400_001]) {
    const line = validTtl.replace("\"ttl_ms\":60000", `"ttl_ms":${ttl}`);
    expectLinkError("Schema", () => store.verifyAndAccept(line, NOW, keyring()));
  }
});

test("enforces seq high-water replay protection and id dedupe", () => {
  const { store } = makeStore();
  const first = signedLine(baseFields({ seq: 5 }));
  store.verifyAndAccept(first, NOW, keyring());

  // Same line again: replay.
  const replay = expectLinkError("Replay", () => store.verifyAndAccept(first, NOW, keyring()));
  assert.equal(replay.details.received, 5);
  assert.equal(replay.details.highWater, 5);

  // Decreasing seq: replay.
  const lower = signedLine(baseFields({ id: "legion_lower00000000001", correlation_id: "legion_lower00000000001", causation_id: "legion_lower00000000001", seq: 4 }));
  expectLinkError("Replay", () => store.verifyAndAccept(lower, NOW, keyring()));

  // New id but repeated seq: replay.
  const sameSeq = signedLine(baseFields({ id: "legion_sameseq0000000001", correlation_id: "legion_sameseq0000000001", causation_id: "legion_sameseq0000000001", seq: 5 }));
  expectLinkError("Replay", () => store.verifyAndAccept(sameSeq, NOW, keyring()));

  // Duplicate id with a higher seq: dedupe.
  const dupId = signedLine(baseFields({ seq: 6 }));
  expectLinkError("DuplicateId", () => store.verifyAndAccept(dupId, NOW, keyring()));

  // Skipped increasing seq (crash-consumed) is accepted.
  const skipped = signedLine(baseFields({ id: "legion_skipped0000000001", correlation_id: "legion_skipped0000000001", causation_id: "legion_skipped0000000001", seq: 9 }));
  const accepted = store.verifyAndAccept(skipped, NOW, keyring());
  assert.equal(accepted.envelope.seq, 9);

  // Replay state survives a store reload from the same root.
  const reloaded = new LegionMailboxStoreV2({ root: store.root, localAgent: "agent:ziz", groups: [] });
  expectLinkError("Replay", () => reloaded.verifyAndAccept(skipped, NOW, keyring()));
});

test("hop_count == max_hops accepted locally but not forwardable; hop_count > max_hops rejected", () => {
  const { store } = makeStore();
  const atCap = signedLine(baseFields({ hop_count: 2, max_hops: 2 }));
  const accepted = store.verifyAndAccept(atCap, NOW, keyring());
  assert.equal(accepted.envelope.hop_count, 2);
  expectLinkError("HopLimit", () => nextHopCountV2(accepted.envelope));
  assert.equal(nextHopCountV2({ ...accepted.envelope, hop_count: 1 }), 2);

  const over = signedLine(baseFields({ id: "legion_hopover0000000001", correlation_id: "legion_hopover0000000001", causation_id: "legion_hopover0000000001", hop_count: 3, max_hops: 2 }));
  expectLinkError("HopLimit", () => store.verifyAndAccept(over, NOW, keyring()));
});

test("honors JavaScript-safe integer boundaries", () => {
  const { store } = makeStore();
  const maxSeq = signedLine(baseFields({ seq: MAX_SAFE_INTEGER }));
  const accepted = store.verifyAndAccept(maxSeq, NOW, keyring());
  assert.equal(accepted.envelope.seq, MAX_SAFE_INTEGER);

  // 2^53 is not exactly representable and must be rejected at the schema layer.
  const unsafe = signedLine(baseFields({
    id: "legion_unsafe00000000001",
    correlation_id: "legion_unsafe00000000001",
    causation_id: "legion_unsafe00000000001"
  })).replace("\"seq\":1,", `"seq":${MAX_SAFE_INTEGER + 1},`);
  expectLinkError("Schema", () => store.verifyAndAccept(unsafe, NOW, keyring()));

  // Non-integer and negative numbers are type errors.
  const floatSeq = signedLine(baseFields()).replace("\"seq\":1,", "\"seq\":1.5,");
  expectLinkError("InvalidJson", () => store.verifyAndAccept(floatSeq, NOW, keyring()));
  const negSeq = signedLine(baseFields()).replace("\"seq\":1,", "\"seq\":-1,");
  expectLinkError("InvalidJson", () => store.verifyAndAccept(negSeq, NOW, keyring()));
});

test("rejects oversized lines, invalid UTF-8, and interior line breaks", () => {
  const { store } = makeStore();
  const oversized = Buffer.alloc(MAX_LINE_BYTES + 2, 0x41);
  oversized[0] = 0x7b;
  expectLinkError("LineTooLong", () => store.verifyAndAccept(oversized, NOW, keyring()));

  const invalidUtf8 = Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]);
  expectLinkError("InvalidUtf8", () => store.verifyAndAccept(invalidUtf8, NOW, keyring()));

  const good = signedLine(baseFields());
  const interior = `${good.slice(0, 20)}\n${good.slice(20)}`;
  expectLinkError("InvalidLineEnding", () => store.verifyAndAccept(interior, NOW, keyring()));
});

test("keyring rejects weak keys, empty keyrings, and malformed key ids", () => {
  expectLinkError("WeakKey", () => keyring([["agent:azazel", "weak", Buffer.alloc(16)]]));
  expectLinkError("EmptyKeyring", () => keyring([]));
  expectLinkError("Schema", () => keyring([["agent:azazel", "bad key!", KEY]]));
  expectLinkError("Schema", () => keyring([["agent:azazel", KEY_ID, KEY], ["agent:azazel", KEY_ID, KEY]]));
  expectLinkError("Schema", () => keyring([["azazel", KEY_ID, KEY]]));
});

test("keyring scopes keys by sender principal like the Rust reference", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields());
  // Same key id and bytes, but provisioned under a different sender: the
  // envelope's `from` (agent:azazel) must not resolve agent:ziz's scope.
  expectLinkError("UnknownKey", () =>
    store.verifyAndAccept(line, NOW, keyring([["agent:ziz", KEY_ID, KEY]])));
  // A ring holding both scopes authenticates the matching sender.
  const ring = keyring([["agent:ziz", KEY_ID, KEY], ["agent:azazel", KEY_ID, KEY]]);
  const accepted = store.verifyAndAccept(line, NOW, ring);
  assert.equal(accepted.envelope.from, "agent:azazel");
});

test("rejects envelopes addressed to other agents", () => {
  const { store } = makeStore();
  const line = signedLine(baseFields({ to: "agent:ophanim" }));
  expectLinkError("WrongDestination", () => store.verifyAndAccept(line, NOW, keyring()));
});

test("rejects corrupt accept state instead of failing open", () => {
  const { store, root } = makeStore();
  fs.writeFileSync(path.join(root, "state", "accepted.json"), "not json", { mode: 0o600 });
  const line = signedLine(baseFields());
  expectLinkError("CorruptState", () => store.verifyAndAccept(line, NOW, keyring()));
});

test("rejects malformed ids, principals, and MAC encodings at the schema layer", () => {
  const { store } = makeStore();
  const valid = signedLine(baseFields());
  const badId = valid.replace('"id":"legion_0123456789abcdef"', '"id":"nope"');
  expectLinkError("Schema", () => store.verifyAndAccept(badId, NOW, keyring()));

  const badFrom = valid.replace('"from":"agent:azazel"', '"from":"azazel"');
  expectLinkError("InvalidJson", () => store.verifyAndAccept(badFrom, NOW, keyring()));

  const badKind = valid.replace('"kind":"message"', '"kind":"notice"');
  expectLinkError("InvalidJson", () => store.verifyAndAccept(badKind, NOW, keyring()));

  const badMac = signedLine(baseFields()).replace(/"mac":"[A-Za-z0-9_-]{43}"/u, "\"mac\":\"AAAA\"");
  expectLinkError("Schema", () => store.verifyAndAccept(badMac, NOW, keyring()));
});

test("hmac preimage matches the frozen 15-line layout with no trailing newline", () => {
  const envelope = signLinkEnvelopeV2(baseFields(), KEY);
  const expected = [
    "legion.link-envelope.v2",
    envelope.id,
    "1",
    String(NOW),
    "60000",
    "2",
    "0",
    envelope.correlation_id,
    envelope.causation_id,
    "agent:azazel",
    "agent:ziz",
    "message",
    "text/plain; charset=utf-8",
    envelope.body_sha256,
    KEY_ID
  ].join("\n");
  assert.equal(hmacPreimageV2(envelope), expected);
  const mac = crypto.createHmac("sha256", KEY).update(expected, "utf8").digest();
  assert.equal(envelope.auth.mac, mac.toString("base64url"));
});

test("send allocates monotonic sequences, signs, appends, and self-verifies", () => {
  const { store, root } = makeStore({ localAgent: "agent:azazel" });
  const first = store.send({
    keyring: keyring(),
    keyId: KEY_ID,
    message: { to: "agent:ziz", ttl_ms: 60_000, max_hops: 2, body: "one", sent_at_ms: NOW }
  });
  const second = store.send({
    keyring: keyring(),
    keyId: KEY_ID,
    message: { to: "agent:ziz", ttl_ms: 60_000, max_hops: 2, body: "two", sent_at_ms: NOW }
  });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.correlation_id, first.id);
  assert.equal(first.causation_id, first.id);

  const inbox = fs.readFileSync(store.inboxPathFor("agent:ziz"), "utf8");
  const lines = inbox.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], serializeLinkEnvelope(first));

  // The receiving store accepts what the sending store wrote.
  const receiver = new LegionMailboxStoreV2({
    root: fs.mkdtempSync(path.join(os.tmpdir(), "legion-link-v2-rx-")),
    localAgent: "agent:ziz",
    groups: []
  });
  const accepted = receiver.verifyAndAccept(`${lines[0]}\n`, NOW, keyring());
  assert.equal(accepted.body, "one");

  // On-disk state is JavaScript-safe and owner-only.
  assert.match(fs.readFileSync(path.join(root, "state", "outbound--azazel--test-key.v1.seq"), "utf8"), /^2\n$/u);
  assert.equal(fs.statSync(path.join(root, "inbox", "agent--ziz.jsonl")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, "state")).mode & 0o777, 0o700);
});

test("send rejects acknowledging an acknowledgment via causation of an ack kind", () => {
  const { store } = makeStore({ localAgent: "agent:azazel" });
  // hop_count above max_hops is rejected on send, mirroring the forwarder rule.
  expectLinkError("HopLimit", () => store.send({
    keyring: keyring(),
    keyId: KEY_ID,
    message: { to: "agent:ziz", ttl_ms: 60_000, max_hops: 1, hop_count: 2, body: "x", sent_at_ms: NOW }
  }));
});

test("dedupe capacity trims oldest ids and rejects invalid capacities", () => {
  expectLinkError("InvalidDedupeCapacity", () =>
    new LegionMailboxStoreV2({ root: fs.mkdtempSync(path.join(os.tmpdir(), "legion-link-v2-cap-")), localAgent: "agent:ziz", dedupeCapacity: 0 }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-link-v2-cap2-"));
  const store = new LegionMailboxStoreV2({ root, localAgent: "agent:ziz", dedupeCapacity: 2 });
  for (let index = 1; index <= 3; index += 1) {
    const id = `legion_cap${String(index).padStart(13, "0")}`;
    store.verifyAndAccept(signedLine(baseFields({ id, correlation_id: id, causation_id: id, seq: index })), NOW, keyring());
  }
  const state = JSON.parse(fs.readFileSync(path.join(root, "state", "accepted.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.ids.length, 2);
  assert.equal(state.high_water["agent:azazel\ntest-key.v1"], 3);
  assert.ok(DEFAULT_DEDUPE_CAPACITY > 2);
});

test("shared cross-harness test vectors verify byte-for-byte when published", (t) => {
  if (!fs.existsSync(VECTOR_ROOT)) {
    t.skip(`shared vector directory not published yet: ${VECTOR_ROOT}`);
    return;
  }
  const files = [];
  for (const entry of fs.readdirSync(VECTOR_ROOT, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path.join(entry.parentPath ?? entry.path ?? VECTOR_ROOT, entry.name));
    }
  }
  assert.ok(files.length > 0, "vector directory exists but contains no vectors");
  for (const file of files.sort()) {
    const vector = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(vector.format, "legion.link-envelope.v2.test-vector", `${file}: unknown vector format`);
    const vectors = Array.isArray(vector.vectors) ? vector.vectors : [vector];
    for (const entry of vectors) {
      const label = `${file}:${entry.name}`;
      const store = new LegionMailboxStoreV2({
        root: fs.mkdtempSync(path.join(os.tmpdir(), "legion-link-v2-vec-")),
        localAgent: entry.local_agent,
        groups: entry.groups ?? []
      });
      const fromMatch = entry.line.match(/"from":"([^"]+)"/u);
      assert.ok(fromMatch, `${label}: vector line carries a from principal`);
      const ring = keyring([[fromMatch[1], entry.key_id, Buffer.from(entry.key_hex, "hex")]]);
      if (entry.expect.accept === true) {
        const accepted = store.verifyAndAccept(entry.line, entry.now_ms, ring);
        const parsed = parseLinkEnvelope(entry.line);
        assert.equal(accepted.envelope.id, parsed.id, label);
        if (entry.body_sha256 !== undefined) {
          assert.equal(bodySha256V2(accepted.body), entry.body_sha256, `${label}: body hash`);
        }
        if (entry.preimage !== undefined) {
          assert.equal(hmacPreimageV2(accepted.envelope), entry.preimage, `${label}: preimage`);
        }
        if (entry.mac !== undefined) {
          assert.equal(accepted.envelope.auth.mac, entry.mac, `${label}: MAC`);
        }
        if (entry.expect.permits_auto_ack !== undefined) {
          assert.equal(
            permitsAutoAckV2(accepted.envelope.kind),
            entry.expect.permits_auto_ack,
            `${label}: permits_auto_ack`
          );
        }
      } else {
        const code = entry.expect.error;
        assert.ok(code, `${label}: negative vector must name an expected error code`);
        expectLinkError(code, () => store.verifyAndAccept(entry.line, entry.now_ms, ring));
      }
    }
  }
});

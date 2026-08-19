// Generate Azazel-side (Node) cross-harness test vectors for Legion Link v2.
//
// Reverse direction of ziz-cross-harness-vectors.json: every accept MAC here is
// produced by THIS Node implementation (src/legion-link-v2.js) and must verify
// byte-for-byte in Ziz's Rust implementation. Reject vectors use only error
// codes attested in the Rust-generated corpus (InvalidMac / InvalidJson /
// Schema) so both sides agree on the taxonomy.
//
// Usage: node scripts/generate-link-v2-vectors.mjs
// Output: /home/usapcool/.legion/protocol/test-vectors/azazel-cross-harness-vectors.json
//
// The fixture key is test-only and must never be provisioned in runtime state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LegionLinkKeyring,
  LegionMailboxStoreV2,
  bodySha256V2,
  hmacPreimageV2,
  signLinkEnvelopeV2
} from "../src/legion-link-v2.js";

const OUT_PATH = "/home/usapcool/.legion/protocol/test-vectors/azazel-cross-harness-vectors.json";
const KEY_ID = "interop-test-2026";
const KEY_HEX = "3031323334353637383961626364656630313233343536373839616263646566";
const KEY = Buffer.from(KEY_HEX, "hex");
const NOW_MS = 1_700_000_000_000;

// Envelope field order is part of the wire format: it must match the frozen
// spec's canonical layout byte-for-byte (same order the Rust side emits).
function envelopeFields(overrides) {
  return {
    schema: "legion.link-envelope.v2",
    id: overrides.id,
    seq: overrides.seq,
    sent_at_ms: overrides.sent_at_ms ?? NOW_MS,
    ttl_ms: overrides.ttl_ms ?? 60_000,
    max_hops: overrides.max_hops ?? 4,
    hop_count: overrides.hop_count ?? 0,
    correlation_id: overrides.correlation_id ?? "legion_cccccccccccccccc",
    causation_id: overrides.causation_id ?? "legion_dddddddddddddddd",
    from: overrides.from ?? "agent:azazel",
    to: overrides.to ?? "agent:ziz",
    kind: overrides.kind ?? "message",
    content_type: overrides.content_type ?? "text/plain; charset=utf-8",
    body: overrides.body ?? ""
  };
}

function lineOf(envelope) {
  return `${JSON.stringify(envelope)}\n`;
}

function acceptVector({ name, localAgent, groups = [], overrides, permitsAutoAck }) {
  const fields = envelopeFields(overrides);
  const signed = signLinkEnvelopeV2(fields, KEY, KEY_ID);
  const vector = {
    name,
    local_agent: localAgent,
    groups,
    key_id: KEY_ID,
    key_hex: KEY_HEX,
    now_ms: fields.sent_at_ms,
    body_sha256: signed.body_sha256,
    preimage: hmacPreimageV2(signed),
    mac: signed.auth.mac,
    line: lineOf(signed)
  };
  vector.expect = { accept: true };
  if (permitsAutoAck === false) vector.expect.permits_auto_ack = false;
  return vector;
}

const vectors = [];

// 1. Plain text message, azazel -> ziz, unicode + interior newline in body.
vectors.push(acceptVector({
  name: "vector-node-a-unicode-message",
  localAgent: "agent:ziz",
  overrides: {
    id: "legion_2222222222222222",
    seq: 1,
    body: "🜏 node line one\nnode line two"
  }
}));

// 2. JSON message to a group destination; exercises group-membership routing.
vectors.push(acceptVector({
  name: "vector-node-b-group-json",
  localAgent: "agent:ziz",
  groups: ["group:legion"],
  overrides: {
    id: "legion_3333333333333333",
    seq: 2,
    sent_at_ms: NOW_MS + 500,
    to: "group:legion",
    content_type: "application/json",
    body: "{\"op\":\"ping\",\"v\":2}"
  }
}));

// 3. Acknowledgment; consumers must never auto-ack an ack.
vectors.push(acceptVector({
  name: "vector-node-c-acknowledgment",
  localAgent: "agent:ziz",
  permitsAutoAck: false,
  overrides: {
    id: "legion_4444444444444444",
    seq: 3,
    sent_at_ms: NOW_MS + 1_000,
    kind: "acknowledgment",
    causation_id: "legion_2222222222222222",
    body: "ack"
  }
}));

// 4. Reject: valid envelope, one MAC character flipped (mid-string, so the
// canonical pad bits stay valid and the failure is purely authentication).
{
  const base = vectors[0];
  const tamperedMac = `${base.mac.slice(0, 10)}${base.mac[10] === "A" ? "B" : "A"}${base.mac.slice(11)}`;
  vectors.push({
    name: "reject-node-mac-tamper",
    local_agent: base.local_agent,
    groups: [],
    key_id: KEY_ID,
    key_hex: KEY_HEX,
    now_ms: base.now_ms,
    line: base.line.replace(`"mac":"${base.mac}"`, `"mac":"${tamperedMac}"`),
    expect: { error: "InvalidMac" }
  });
}

// 5. Reject: duplicate top-level key (attested InvalidJson in the Rust corpus).
{
  const base = vectors[0];
  vectors.push({
    name: "reject-node-duplicate-top-level-key",
    local_agent: base.local_agent,
    groups: [],
    key_id: KEY_ID,
    key_hex: KEY_HEX,
    now_ms: base.now_ms,
    line: base.line.replace(
      '"seq":1,',
      '"seq":1,"seq":2,'
    ),
    expect: { error: "InvalidJson" }
  });
}

// 6. Reject: schema bound violation (seq = 0; attested Schema in Rust corpus).
{
  const base = vectors[0];
  vectors.push({
    name: "reject-node-schema-bound",
    local_agent: base.local_agent,
    groups: [],
    key_id: KEY_ID,
    key_hex: KEY_HEX,
    now_ms: base.now_ms,
    line: base.line.replace('"seq":1,', '"seq":0,'),
    expect: { error: "Schema" }
  });
}

// --- Self-verification: every vector must behave as expected under THIS ---
// --- implementation before it is published for the Rust side.           ---
const keyring = new LegionLinkKeyring([["agent:azazel", KEY_ID, KEY]]);
const failures = [];
for (const vector of vectors) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-v2-vecgen-"));
  try {
    const store = new LegionMailboxStoreV2({
      root,
      localAgent: vector.local_agent,
      groups: vector.groups
    });
    if (vector.expect.accept) {
      try {
        store.verifyAndAccept(vector.line, vector.now_ms, keyring);
      } catch (error) {
        failures.push(`${vector.name}: expected accept, got ${error?.code ?? error}`);
      }
    } else {
      try {
        store.verifyAndAccept(vector.line, vector.now_ms, keyring);
        failures.push(`${vector.name}: expected ${vector.expect.error}, got ACCEPT`);
      } catch (error) {
        if (error?.code !== vector.expect.error) {
          failures.push(`${vector.name}: expected ${vector.expect.error}, got ${error?.code ?? error}`);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (failures.length > 0) {
  console.error("SELF-VERIFICATION FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const document = {
  format: "legion.link-envelope.v2.test-vector",
  description:
    "Node-generated (Azazel/OpenAGI) cross-harness interoperability fixtures for frozen Legion Link v2. " +
    "Reverse direction of ziz-cross-harness-vectors.json: accept MACs here are produced by the Node " +
    "implementation and must verify byte-for-byte in the Rust implementation. " +
    "The fixture key is test-only and must never be provisioned in runtime state.",
  protocol: {
    schema_path: "/home/usapcool/.legion/protocol/link-envelope-v2.schema.json",
    schema_sha256: "674111c0ee3459c430df9e716cdf2338609f3ab1c36b84de8a0cae4f7eed2490",
    semantics_path: "/home/usapcool/.legion/protocol/link-envelope-v2.md",
    semantics_sha256: "d8f5aa51860cf29e55e48c98694177cbb0550c2444abcd8d513f276488c19b5c"
  },
  vectors
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
console.log(`self-verified ${vectors.length} vectors; wrote ${OUT_PATH}`);

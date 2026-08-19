// Legion Link Envelope v2 — bounded, authenticated, replay-resistant mailbox records.
//
// Frozen spec: /home/usapcool/.legion/protocol/link-envelope-v2.md (+ .schema.json)
// Cross-harness vectors: /home/usapcool/.legion/protocol/test-vectors/
//
// Error taxonomy (aligned to the frozen cross-harness vector corpus):
//   LineTooLong / InvalidUtf8 / InvalidLineEnding  — transport framing
//   InvalidJson   — JSON structure: duplicate keys, unknown/missing fields, type
//                   mismatches, enum/const violations, non-integer or negative
//                   integer lexemes, principal/destination pattern failures
//   Schema        — value constraints: id/correlation/causation pattern, integer
//                   bounds, body length, body_sha256 pattern, key_id pattern,
//                   MAC alphabet/length/canonical pad bits
//   UnknownKey / WeakKey / EmptyKeyring            — keyring failures (fail closed)
//   InvalidMac    — HMAC over the actual body does not match auth.mac. The MAC
//                   preimage carries the RECOMPUTED body hash, so any post-signing
//                   body alteration is an authentication failure (vector:
//                   reject-valid-mac-with-body-tamper expects InvalidMac).
//   BodyHashMismatch — the declared body_sha256 field disagrees with the actual
//                   body while the MAC is otherwise valid (field-only tamper).
//   FutureSkew / Expired / HopLimit / Replay / DuplicateId / WrongDestination
//   CorruptState / InvalidDedupeCapacity / LockTimeout / SeqExhausted

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LINK_ENVELOPE_V2_SCHEMA = "legion.link-envelope.v2";
export const MAX_LINE_BYTES = 131_072;
export const FUTURE_SKEW_MS = 300_000;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const DEFAULT_DEDUPE_CAPACITY = 4_096;

const ENVELOPE_FIELDS = [
  "schema", "id", "seq", "sent_at_ms", "ttl_ms", "max_hops", "hop_count",
  "correlation_id", "causation_id", "from", "to", "kind", "content_type",
  "body", "body_sha256", "auth"
];
const AUTH_FIELDS = ["alg", "key_id", "mac"];
const MESSAGE_ID_RE = /^legion_[A-Za-z0-9_-]{16,64}$/u;
const PRINCIPAL_RE = /^agent:[a-z0-9][a-z0-9_-]{0,63}$/u;
const DESTINATION_RE = /^(?:agent|group):[a-z0-9][a-z0-9_-]{0,63}$/u;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;
const BODY_SHA256_RE = /^[a-f0-9]{64}$/u;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/u;
const KINDS = new Set(["message", "acknowledgment", "event", "control"]);
const CONTENT_TYPES = new Set(["text/plain; charset=utf-8", "application/json"]);
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INTEGER_LEXEME_RE = /^(?:0|[1-9][0-9]*)$/u;
const INTEGER_BOUNDS = new Map([
  ["seq", [1, MAX_SAFE_INTEGER]],
  ["sent_at_ms", [0, MAX_SAFE_INTEGER]],
  ["ttl_ms", [1_000, 86_400_000]],
  ["max_hops", [0, 8]],
  ["hop_count", [0, 8]]
]);
const MAX_BODY_CHARS = 65_536;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;

// Fixture default so signLinkEnvelopeV2(fields, key) matches the frozen test
// corpus; LegionMailboxStoreV2.send always passes an explicit key id.
const DEFAULT_SIGNING_KEY_ID = "test-key.v1";

export class LegionLinkError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LegionLinkError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new LegionLinkError(code, message, details);
}

// ---------------------------------------------------------------------------
// Strict JSON: duplicate-key rejection + integer lexeme capture.
// ---------------------------------------------------------------------------

function parseJsonStrict(text) {
  const length = text.length;
  let index = 0;
  const lexemes = new Map();

  function error(message) {
    fail("InvalidJson", `${message} at offset ${index}`);
  }

  function skipWs() {
    while (index < length) {
      const ch = text[index];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") index += 1;
      else break;
    }
  }

  function parseString() {
    // text[index] === '"'
    index += 1;
    let out = "";
    while (index < length) {
      const ch = text[index];
      if (ch === '"') {
        index += 1;
        return out;
      }
      if (ch === "\\") {
        index += 1;
        if (index >= length) error("unterminated escape");
        const esc = text[index];
        index += 1;
        switch (esc) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/u.test(hex)) error("invalid unicode escape");
            index += 4;
            const unit = Number.parseInt(hex, 16);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              // Possible surrogate pair.
              if (text[index] === "\\" && text[index + 1] === "u") {
                const hex2 = text.slice(index + 2, index + 6);
                if (/^[0-9a-fA-F]{4}$/u.test(hex2)) {
                  const unit2 = Number.parseInt(hex2, 16);
                  if (unit2 >= 0xdc00 && unit2 <= 0xdfff) {
                    index += 6;
                    out += String.fromCharCode(unit, unit2);
                    break;
                  }
                }
              }
            }
            out += String.fromCharCode(unit);
            break;
          }
          default:
            error(`invalid escape \\\${esc}`);
        }
        continue;
      }
      const code = text.codePointAt(index);
      if (code < 0x20) error("unescaped control character in string");
      out += String.fromCodePoint(code);
      index += code > 0xffff ? 2 : 1;
    }
    error("unterminated string");
    return ""; // unreachable
  }

  function parseNumber(pathKey) {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index, index + 64));
    if (!match) error("invalid number");
    lexemes.set(pathKey, match[0]);
    index += match[0].length;
    return Number(match[0]);
  }

  function parseArray(pathKey) {
    index += 1; // [
    const out = [];
    skipWs();
    if (text[index] === "]") {
      index += 1;
      return out;
    }
    for (let item = 0; ; item += 1) {
      skipWs();
      out.push(parseValue(`${pathKey}[${item}]`));
      skipWs();
      const ch = text[index];
      index += 1;
      if (ch === "]") return out;
      if (ch !== ",") error("expected ',' or ']' in array");
    }
  }

  function parseObject(pathKey) {
    index += 1; // {
    const out = {};
    const seen = new Set();
    skipWs();
    if (text[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skipWs();
      if (text[index] !== '"') error("expected object key");
      const key = parseString();
      if (seen.has(key)) {
        fail("InvalidJson", `duplicate key "${key}"`, { duplicateKey: pathKey ? `${pathKey}.${key}` : key });
      }
      seen.add(key);
      skipWs();
      if (text[index] !== ":") error("expected ':' after object key");
      index += 1;
      skipWs();
      out[key] = parseValue(pathKey ? `${pathKey}.${key}` : key);
      skipWs();
      const ch = text[index];
      index += 1;
      if (ch === "}") return out;
      if (ch !== ",") error("expected ',' or '}' in object");
    }
  }

  function parseValue(pathKey) {
    const ch = text[index];
    if (ch === '"') return parseString();
    if (ch === "{") return parseObject(pathKey);
    if (ch === "[") return parseArray(pathKey);
    if (ch === "-") return parseNumber(pathKey);
    if (ch >= "0" && ch <= "9") return parseNumber(pathKey);
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    error("unexpected token");
    return null; // unreachable
  }

  skipWs();
  const value = parseValue("");
  skipWs();
  if (index !== length) error("trailing content after JSON value");
  return { value, lexemes };
}

// ---------------------------------------------------------------------------
// Schema validation.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEnvelope(value, lexemes) {
  if (!isPlainObject(value)) fail("InvalidJson", "envelope must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_FIELDS.includes(key)) fail("InvalidJson", `unknown field "${key}"`);
  }
  for (const key of ENVELOPE_FIELDS) {
    if (!(key in value)) fail("InvalidJson", `missing field "${key}"`);
  }
  for (const key of ["schema", "id", "correlation_id", "causation_id", "from", "to", "kind", "content_type", "body", "body_sha256"]) {
    if (typeof value[key] !== "string") fail("InvalidJson", `"${key}" must be a string`);
  }
  if (value.schema !== LINK_ENVELOPE_V2_SCHEMA) fail("InvalidJson", `"schema" must be "${LINK_ENVELOPE_V2_SCHEMA}"`);

  for (const [key, [min, max]] of INTEGER_BOUNDS) {
    const fieldValue = value[key];
    const lexeme = lexemes.get(key);
    if (typeof fieldValue !== "number" || lexeme === undefined) {
      fail("InvalidJson", `"${key}" must be a JSON integer`);
    }
    if (!INTEGER_LEXEME_RE.test(lexeme)) {
      fail("InvalidJson", `"${key}" must be a non-negative integer literal, got ${JSON.stringify(lexeme)}`);
    }
    if (!Number.isSafeInteger(fieldValue) || fieldValue < min || fieldValue > max) {
      fail("Schema", `"${key}" ${fieldValue} outside [${min}, ${max}]`);
    }
  }

  if (!MESSAGE_ID_RE.test(value.id)) fail("Schema", `"id" fails ${MESSAGE_ID_RE}`);
  if (!MESSAGE_ID_RE.test(value.correlation_id)) fail("Schema", `"correlation_id" fails message-id pattern`);
  if (!MESSAGE_ID_RE.test(value.causation_id)) fail("Schema", `"causation_id" fails message-id pattern`);
  if (!PRINCIPAL_RE.test(value.from)) fail("InvalidJson", `"from" must be an agent:<name> principal`);
  if (!DESTINATION_RE.test(value.to)) fail("InvalidJson", `"to" must be an agent:<name> or group:<name> destination`);
  if (!KINDS.has(value.kind)) fail("InvalidJson", `"kind" must be one of ${[...KINDS].join(", ")}`);
  if (!CONTENT_TYPES.has(value.content_type)) fail("InvalidJson", `"content_type" must be one of ${[...CONTENT_TYPES].join(", ")}`);
  if (value.body.length > MAX_BODY_CHARS) fail("Schema", `"body" exceeds ${MAX_BODY_CHARS} characters`);
  if (!BODY_SHA256_RE.test(value.body_sha256)) fail("Schema", `"body_sha256" must be 64 lowercase hex chars`);

  const auth = value.auth;
  if (!isPlainObject(auth)) fail("InvalidJson", `"auth" must be an object`);
  for (const key of Object.keys(auth)) {
    if (!AUTH_FIELDS.includes(key)) fail("InvalidJson", `unknown auth field "${key}"`);
  }
  for (const key of AUTH_FIELDS) {
    if (!(key in auth)) fail("InvalidJson", `missing auth field "${key}"`);
    if (typeof auth[key] !== "string") fail("InvalidJson", `auth."${key}" must be a string`);
  }
  if (auth.alg !== "HMAC-SHA256") fail("InvalidJson", `auth.alg must be "HMAC-SHA256"`);
  if (!KEY_ID_RE.test(auth.key_id)) fail("Schema", `auth.key_id fails ${KEY_ID_RE}`);
  if (!MAC_RE.test(auth.mac)) fail("Schema", "auth.mac must be 43 base64url chars");
  // 32 bytes = 258 base64 bits; the final char carries 4 significant bits, so
  // its 2 low pad bits must be zero (alphabet index divisible by 4).
  if (B64URL_ALPHABET.indexOf(auth.mac[42]) % 4 !== 0) {
    fail("Schema", "auth.mac has noncanonical base64url pad bits");
  }
}

// ---------------------------------------------------------------------------
// Line framing.
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function normalizeLine(line) {
  const buffer = Buffer.isBuffer(line) ? line : Buffer.from(String(line), "utf8");
  if (buffer.length > MAX_LINE_BYTES) {
    fail("LineTooLong", `line is ${buffer.length} bytes, max ${MAX_LINE_BYTES}`);
  }
  let text;
  try {
    text = utf8Decoder.decode(buffer);
  } catch {
    fail("InvalidUtf8", "line is not well-formed UTF-8");
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.includes("\n") || text.includes("\r")) {
    fail("InvalidLineEnding", "line contains an interior line break");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Crypto.
// ---------------------------------------------------------------------------

export function bodySha256V2(body) {
  return crypto.createHash("sha256").update(String(body), "utf8").digest("hex");
}

export function hmacPreimageV2(envelope) {
  const keyId = envelope?.auth?.key_id ?? envelope?.key_id;
  return [
    LINK_ENVELOPE_V2_SCHEMA,
    envelope.id,
    String(envelope.seq),
    String(envelope.sent_at_ms),
    String(envelope.ttl_ms),
    String(envelope.max_hops),
    String(envelope.hop_count),
    envelope.correlation_id,
    envelope.causation_id,
    envelope.from,
    envelope.to,
    envelope.kind,
    envelope.content_type,
    envelope.body_sha256,
    keyId
  ].join("\n");
}

// MAC over the preimage carrying the RECOMPUTED body hash: the signature
// authenticates the actual body, so body tampering surfaces as InvalidMac.
function expectedMacV2(envelope, key) {
  const recomputed = bodySha256V2(envelope.body);
  const preimage = hmacPreimageV2({ ...envelope, body_sha256: recomputed });
  const mac = crypto.createHmac("sha256", key).update(preimage, "utf8").digest();
  return { mac, recomputed };
}

// Acceptance-receipt commitment: sha256 over the canonical compact
// serialization. Matches zerohermes envelope_commitment byte-for-byte —
// serde_json::to_vec emits the same frozen field order this module
// serializes, a property the cross-harness vector corpus already proves.
function envelopeCommitmentV2(envelope) {
  return crypto.createHash("sha256").update(serializeLinkEnvelope(envelope), "utf8").digest("hex");
}

export function signLinkEnvelopeV2(fields, key, keyId = DEFAULT_SIGNING_KEY_ID) {
  const bodyHash = bodySha256V2(fields.body ?? "");
  const unsigned = { ...fields, body_sha256: bodyHash, auth: { alg: "HMAC-SHA256", key_id: keyId, mac: "" } };
  const preimage = hmacPreimageV2(unsigned);
  const mac = crypto.createHmac("sha256", key).update(preimage, "utf8").digest();
  return {
    ...fields,
    body_sha256: bodyHash,
    auth: { alg: "HMAC-SHA256", key_id: keyId, mac: mac.toString("base64url") }
  };
}

export function serializeLinkEnvelope(envelope) {
  return JSON.stringify(envelope);
}

export function parseLinkEnvelope(line) {
  const text = normalizeLine(line);
  const { value, lexemes } = parseJsonStrict(text);
  validateEnvelope(value, lexemes);
  return value;
}

export function nextHopCountV2(envelope) {
  if (envelope.hop_count >= envelope.max_hops) {
    fail("HopLimit", `hop_count ${envelope.hop_count} already at max_hops ${envelope.max_hops}; cannot forward`);
  }
  return envelope.hop_count + 1;
}

// Acknowledgments must never be auto-acknowledged (loop prevention).
export function permitsAutoAckV2(kind) {
  return kind !== "acknowledgment";
}

// ---------------------------------------------------------------------------
// Keyring. Keys are provisioned locally and never accepted from envelopes,
// tool arguments, or model-facing configuration.
// ---------------------------------------------------------------------------

export class LegionLinkKeyring {
  // Keys are scoped by (sender principal, key id), mirroring the Rust
  // reference keyring: a key provisioned for one sender must never
  // authenticate envelopes claiming a different `from`.
  #keys = new Map();

  constructor(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      fail("EmptyKeyring", "keyring requires at least one [from, keyId, key] entry");
    }
    for (const [from, keyId, key] of entries) {
      const scope = String(from);
      if (!PRINCIPAL_RE.test(scope)) fail("Schema", `malformed key scope ${JSON.stringify(scope)}`);
      if (!KEY_ID_RE.test(String(keyId))) fail("Schema", `malformed key id ${JSON.stringify(String(keyId))}`);
      const compound = `${scope}\n${String(keyId)}`;
      if (this.#keys.has(compound)) {
        fail("Schema", `duplicate key id ${JSON.stringify(String(keyId))} for scope ${JSON.stringify(scope)}`);
      }
      const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key ?? "");
      if (buffer.length < 32) fail("WeakKey", `key ${JSON.stringify(String(keyId))} is ${buffer.length} bytes, minimum 32`);
      this.#keys.set(compound, buffer);
    }
  }

  has(from, keyId) {
    return this.#keys.has(`${String(from)}\n${String(keyId)}`);
  }

  lookup(from, keyId) {
    const key = this.#keys.get(`${String(from)}\n${String(keyId)}`);
    if (!key) {
      fail("UnknownKey", `unknown key id ${JSON.stringify(String(keyId))} for sender ${JSON.stringify(String(from))}`);
    }
    return key;
  }
}

// ---------------------------------------------------------------------------
// Mailbox store.
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

export class LegionMailboxStoreV2 {
  constructor({ root, localAgent, groups = [], dedupeCapacity = DEFAULT_DEDUPE_CAPACITY } = {}) {
    if (!root || typeof root !== "string") fail("InvalidState", "LegionMailboxStoreV2 requires a root directory");
    if (!PRINCIPAL_RE.test(String(localAgent))) fail("Schema", `localAgent must be an agent:<name> principal, got ${JSON.stringify(String(localAgent))}`);
    if (!Number.isSafeInteger(dedupeCapacity) || dedupeCapacity < 1) {
      fail("InvalidDedupeCapacity", `dedupeCapacity must be a positive safe integer, got ${String(dedupeCapacity)}`);
    }
    this.root = root;
    this.localAgent = String(localAgent);
    this.groups = [...groups];
    this.dedupeCapacity = dedupeCapacity;
    this.stateDir = path.join(root, "state");
    this.inboxDir = path.join(root, "inbox");
    this.acceptPath = path.join(this.stateDir, "accepted.json");
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.stateDir, 0o700); } catch { /* best effort */ }
    try { fs.chmodSync(this.inboxDir, 0o700); } catch { /* best effort */ }
  }

  inboxPathFor(destination) {
    return path.join(this.inboxDir, `${String(destination).replace(":", "--")}.jsonl`);
  }

  // -- locking ---------------------------------------------------------------

  #acquireLock(name) {
    const lockPath = path.join(this.stateDir, `${name}.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return lockPath;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch { /* lock vanished; retry */ continue; }
        if (Date.now() > deadline) fail("LockTimeout", `timed out acquiring ${name} lock`);
        sleepSync(10);
      }
    }
  }

  #releaseLock(lockPath) {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }

  #withLock(name, fn) {
    const lockPath = this.#acquireLock(name);
    try {
      return fn();
    } finally {
      this.#releaseLock(lockPath);
    }
  }

  // -- durable state ----------------------------------------------------------

  #writeAtomic(filePath, content, mode = 0o600) {
    const tmp = `${filePath}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
  }

  #loadAcceptState() {
    let raw;
    try {
      raw = fs.readFileSync(this.acceptPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, ids: [], high_water: {}, receipts: {} };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("CorruptState", `${this.acceptPath} is not valid JSON; refusing to fail open`);
    }
    if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.ids) || !isPlainObject(parsed.high_water)) {
      fail("CorruptState", `${this.acceptPath} has an unexpected shape; refusing to fail open`);
    }
    // Receipts are optional on read (zerohermes serde default parity) but
    // validated when present; every write carries them.
    if (parsed.receipts === undefined) parsed.receipts = {};
    if (!isPlainObject(parsed.receipts)) {
      fail("CorruptState", `${this.acceptPath} has malformed receipts; refusing to fail open`);
    }
    // zerohermes AcceptState::validate parity: bounded, unique, well-formed.
    if (parsed.ids.length > this.dedupeCapacity) {
      fail("CorruptState", `${this.acceptPath} dedupe state exceeds configured capacity`);
    }
    if (new Set(parsed.ids).size !== parsed.ids.length) {
      fail("CorruptState", `${this.acceptPath} dedupe state contains duplicate ids`);
    }
    if (Object.keys(parsed.receipts).length > this.dedupeCapacity) {
      fail("CorruptState", `${this.acceptPath} acceptance receipt state exceeds configured capacity`);
    }
    for (const [id, receipt] of Object.entries(parsed.receipts)) {
      if (!MESSAGE_ID_RE.test(id) || !isPlainObject(receipt) ||
          !PRINCIPAL_RE.test(String(receipt.from)) || !KEY_ID_RE.test(String(receipt.key_id)) ||
          !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 ||
          !BODY_SHA256_RE.test(String(receipt.envelope_sha256))) {
        fail("CorruptState", `${this.acceptPath} contains a malformed acceptance receipt`);
      }
    }
    return parsed;
  }

  #persistAcceptState(state) {
    this.#writeAtomic(this.acceptPath, `${JSON.stringify(state)}\n`);
  }

  #seqPathFor(keyId) {
    const name = this.localAgent.replace(/^agent:/u, "");
    return path.join(this.stateDir, `outbound--${name}--${keyId}.seq`);
  }

  // Allocate and durably persist the next sequence BEFORE signing; a consumed
  // seq may be skipped after a crash but must never be reused.
  #allocateSeq(keyId) {
    const seqPath = this.#seqPathFor(keyId);
    let current = 0;
    try {
      const raw = fs.readFileSync(seqPath, "utf8");
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) current = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const next = current + 1;
    if (next > MAX_SAFE_INTEGER) fail("SeqExhausted", `sequence space exhausted for ${this.localAgent}/${keyId}`);
    this.#writeAtomic(seqPath, `${next}\n`);
    return next;
  }

  // -- receive path -----------------------------------------------------------

  // Steps 1-8 of the frozen verification order: framing, strict parse,
  // schema, key resolution, body/MAC authentication, time window, hop bound.
  #authenticateEnvelope(line, nowMs, keyring) {
    // Steps 1-3: framing, strict parse, schema.
    const envelope = parseLinkEnvelope(line);
    if (!keyring || typeof keyring.lookup !== "function") {
      fail("EmptyKeyring", "verifyAndAccept requires a LegionLinkKeyring");
    }
    // Step 4: key resolution (fail closed on unknown ids).
    const key = keyring.lookup(envelope.from, envelope.auth.key_id);
    // Steps 5-6: recompute the body hash and authenticate the ACTUAL body.
    const { mac, recomputed } = expectedMacV2(envelope, key);
    const claimed = Buffer.from(envelope.auth.mac, "base64url");
    if (claimed.length !== mac.length || !crypto.timingSafeEqual(claimed, mac)) {
      fail("InvalidMac", "auth.mac does not match the signed fields and body");
    }
    if (envelope.body_sha256 !== recomputed) {
      fail("BodyHashMismatch", `declared body_sha256 disagrees with the authenticated body`);
    }
    // Step 7: time window. The future-skew allowance does not extend expiry.
    const now = Number(nowMs);
    if (now < envelope.sent_at_ms - FUTURE_SKEW_MS) {
      fail("FutureSkew", `sent_at_ms ${envelope.sent_at_ms} is more than ${FUTURE_SKEW_MS}ms ahead of now ${now}`);
    }
    if (now > envelope.sent_at_ms + envelope.ttl_ms) {
      fail("Expired", `envelope expired at ${envelope.sent_at_ms + envelope.ttl_ms}, now ${now}`);
    }
    // Step 8: hop bound.
    if (envelope.hop_count > envelope.max_hops) {
      fail("HopLimit", `hop_count ${envelope.hop_count} exceeds max_hops ${envelope.max_hops}`);
    }
    return envelope;
  }

  // Step 11: destination membership (shared by both verification paths).
  #checkLocalDestination(envelope) {
    if (envelope.to.startsWith("agent:")) {
      if (envelope.to !== this.localAgent) {
        fail("WrongDestination", `envelope addressed to ${envelope.to}, local agent is ${this.localAgent}`);
      }
    } else if (!this.groups.includes(envelope.to)) {
      fail("WrongDestination", `envelope addressed to unsubscribed group ${envelope.to}`);
    }
  }

  verifyAndAccept(line, nowMs, keyring) {
    const envelope = this.#authenticateEnvelope(line, nowMs, keyring);
    // Steps 9-10: replay + dedupe state, persisted before the body is exposed.
    return this.#withLock("accepted", () => {
      const state = this.#loadAcceptState();
      const waterKey = `${envelope.from}\n${envelope.auth.key_id}`;
      const highWater = Number(state.high_water[waterKey] ?? 0);
      if (envelope.seq <= highWater) {
        fail("Replay", `seq ${envelope.seq} not above high-water ${highWater} for ${waterKey.replace("\n", "/")}`, {
          received: envelope.seq,
          highWater
        });
      }
      if (state.ids.includes(envelope.id)) {
        fail("DuplicateId", `id ${envelope.id} already processed`);
      }
      // Step 11: destination membership.
      this.#checkLocalDestination(envelope);
      state.high_water[waterKey] = envelope.seq;
      state.ids.push(envelope.id);
      // Durable acceptance receipt (zerohermes parity): proves the exact
      // authenticated identity on later idempotent reads; evicted with its id.
      state.receipts[envelope.id] = {
        from: envelope.from,
        key_id: envelope.auth.key_id,
        seq: envelope.seq,
        envelope_sha256: envelopeCommitmentV2(envelope)
      };
      while (state.ids.length > this.dedupeCapacity) {
        const evicted = state.ids.shift();
        delete state.receipts[evicted];
      }
      this.#persistAcceptState(state);
      return { envelope, body: envelope.body };
    });
  }

  // Idempotent read path for an immutable inbox record: re-authenticate and
  // prove the exact identity was already durably accepted, WITHOUT mutating
  // replay state. Fresh ingress must use verifyAndAccept. Port of zerohermes
  // verify_previously_accepted.
  verifyPreviouslyAccepted(line, nowMs, keyring) {
    const envelope = this.#authenticateEnvelope(line, nowMs, keyring);
    this.#checkLocalDestination(envelope);
    return this.#withLock("accepted", () => {
      const state = this.#loadAcceptState();
      const waterKey = `${envelope.from}\n${envelope.auth.key_id}`;
      const highWater = Number(state.high_water[waterKey] ?? 0);
      const receipt = state.receipts[envelope.id];
      if (!receipt) {
        fail("CorruptState", `record ${envelope.id} is authenticated but has no durable acceptance receipt`);
      }
      if (
        envelope.seq > highWater ||
        receipt.from !== envelope.from ||
        receipt.key_id !== envelope.auth.key_id ||
        receipt.seq !== envelope.seq ||
        receipt.envelope_sha256 !== envelopeCommitmentV2(envelope)
      ) {
        fail("CorruptState", `record ${envelope.id} does not match its durable acceptance receipt`);
      }
      return { envelope, body: envelope.body };
    });
  }

  // -- send path --------------------------------------------------------------

  send({ keyring, keyId, message } = {}) {
    if (!isPlainObject(message)) fail("InvalidJson", "send requires a message object");
    const hopCount = message.hop_count ?? 0;
    const maxHops = message.max_hops;
    if (!Number.isSafeInteger(hopCount) || hopCount < 0 || hopCount > 8) fail("Schema", `hop_count must be an integer in [0, 8], got ${String(message.hop_count)}`);
    if (!Number.isSafeInteger(maxHops) || maxHops < 0 || maxHops > 8) fail("Schema", `max_hops must be an integer in [0, 8], got ${String(message.max_hops)}`);
    if (hopCount > maxHops) {
      fail("HopLimit", `refusing to send: hop_count ${hopCount} exceeds max_hops ${maxHops}`);
    }
    if (!keyring || typeof keyring.lookup !== "function") fail("EmptyKeyring", "send requires a LegionLinkKeyring");
    const key = keyring.lookup(this.localAgent, keyId);

    return this.#withLock("accepted", () => {
      const seq = this.#allocateSeq(keyId);
      const id = message.id ?? `legion_${crypto.randomBytes(12).toString("base64url")}`;
      const fields = {
        schema: LINK_ENVELOPE_V2_SCHEMA,
        id,
        seq,
        sent_at_ms: message.sent_at_ms ?? Date.now(),
        ttl_ms: message.ttl_ms,
        max_hops: maxHops,
        hop_count: hopCount,
        correlation_id: message.correlation_id ?? id,
        causation_id: message.causation_id ?? id,
        from: this.localAgent,
        to: message.to,
        kind: message.kind ?? "message",
        content_type: message.content_type ?? "text/plain; charset=utf-8",
        body: String(message.body ?? "")
      };
      // Validate the outbound envelope before it is signed. Integer fields are
      // synthesized here, so their lexemes are canonical by construction.
      const lexemes = new Map();
      for (const name of INTEGER_BOUNDS.keys()) lexemes.set(name, String(fields[name]));
      validateEnvelope({ ...fields, body_sha256: bodySha256V2(fields.body), auth: { alg: "HMAC-SHA256", key_id: String(keyId), mac: "A".repeat(43) } }, lexemes);

      const envelope = signLinkEnvelopeV2(fields, key, String(keyId));
      const line = `${serializeLinkEnvelope(envelope)}\n`;

      // Self-verify the exact bytes before they touch the inbox.
      const parsed = parseLinkEnvelope(line);
      const check = expectedMacV2(parsed, key);
      const claimed = Buffer.from(parsed.auth.mac, "base64url");
      if (claimed.length !== check.mac.length || !crypto.timingSafeEqual(claimed, check.mac)) {
        fail("InvalidMac", "self-verification failed; refusing to append");
      }

      const inboxPath = this.inboxPathFor(fields.to);
      const fd = fs.openSync(inboxPath, "a", 0o600);
      try {
        fs.writeSync(fd, line, null, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.chmodSync(inboxPath, 0o600); } catch { /* best effort */ }
      return envelope;
    });
  }
}

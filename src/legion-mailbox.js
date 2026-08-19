import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LegionLinkKeyring, LegionMailboxStoreV2 } from "./legion-link-v2.js";

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
const LINK_V2_MESSAGE_ID_RE = /^legion_[A-Za-z0-9_-]{16,64}$/u;

// Outbound defaults mirror zerohermes (DEFAULT_TTL_MS / DEFAULT_MAX_HOPS) so
// either harness accepts the other's envelopes without negotiation.
const DEFAULT_TTL_MS = 86_400_000;
const DEFAULT_MAX_HOPS = 4;

export function legionRoot(env = process.env) {
  const configured = String(env.LEGION_HOME ?? "").trim();
  return path.resolve(configured || path.join(os.homedir(), ".legion"));
}

export function normalizeLegionAgentName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return AGENT_NAME_RE.test(name) ? name : null;
}

// v1 legacy flat-record path. Retained for the explicit compat read lane only;
// nothing writes this format anymore.
export function legionMailboxPath(agent, env = process.env) {
  const name = normalizeLegionAgentName(agent);
  if (!name) throw new Error(`Invalid Legion mailbox agent name: ${String(agent ?? "")}`);
  return path.join(legionRoot(env), "mailbox", `${name}.jsonl`);
}

// v2 signed-envelope inbox path (shared on-disk layout with zerohermes).
export function legionInboxPathV2(agent, env = process.env) {
  const name = normalizeLegionAgentName(agent);
  if (!name) throw new Error(`Invalid Legion mailbox agent name: ${String(agent ?? "")}`);
  return path.join(legionRoot(env), "inbox", `agent--${name}.jsonl`);
}

// ---------------------------------------------------------------------------
// Provisioning. Keys live at <legionRoot>/keys/<sender>.key in the zerohermes
// wire format "<key_id> <hex>\n", placed by the overseer-run key ceremony
// (G4). Files must be owner-only (0600); anything else fails closed.
// ---------------------------------------------------------------------------

function loadLegionKeyFile(root, name) {
  const keyPath = path.join(root, "keys", `${name}.key`);
  let stat;
  try {
    stat = fs.statSync(keyPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`Legion mailbox key ${keyPath} must have owner-only permissions (0600), found 0${mode.toString(8)}`);
  }
  const raw = fs.readFileSync(keyPath, "utf8");
  const match = raw.trim().match(/^([A-Za-z0-9._-]{1,64}) ([0-9a-fA-F]{64,})$/u);
  if (!match) {
    throw new Error(`Legion mailbox key ${keyPath} is malformed; expected "<key_id> <hex>"`);
  }
  return { keyId: match[1], key: Buffer.from(match[2], "hex") };
}

// Every provisioned sender key, scoped to its `agent:<name>` principal — the
// receiver-side ring used to authenticate inbound envelopes.
function loadLegionKeyring(env) {
  const root = legionRoot(env);
  let files;
  try {
    files = fs.readdirSync(path.join(root, "keys"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const entries = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".key")) continue;
    const name = normalizeLegionAgentName(file.slice(0, -".key".length));
    if (!name) continue;
    const { keyId, key } = loadLegionKeyFile(root, name);
    entries.push([`agent:${name}`, keyId, key]);
  }
  return entries.length > 0 ? new LegionLinkKeyring(entries) : null;
}

// ---------------------------------------------------------------------------
// Delivery (v2 signed envelopes; fail-closed without a provisioned sender key).
// ---------------------------------------------------------------------------

export function deliverLegionMailbox({ from, to, text, correlationId = null } = {}, env = process.env) {
  const sender = normalizeLegionAgentName(from);
  const recipient = normalizeLegionAgentName(to);
  const payload = String(text ?? "").trim();
  if (!sender) throw new Error("Local Legion delivery requires a valid sender name.");
  if (!recipient) throw new Error("Local Legion delivery requires a valid recipient name.");
  if (!payload) throw new Error("Local Legion delivery requires non-empty text.");

  const root = legionRoot(env);
  // Resolve the sender key BEFORE constructing the store so a missing key
  // leaves no state/inbox directories behind.
  const provisioned = loadLegionKeyFile(root, sender);
  if (!provisioned) {
    throw new Error(`Legion mailbox v2 sender key is not provisioned: ${path.join(root, "keys", `${sender}.key`)}`);
  }

  const fromPrincipal = `agent:${sender}`;
  const toPrincipal = `agent:${recipient}`;
  const keyring = new LegionLinkKeyring([[fromPrincipal, provisioned.keyId, provisioned.key]]);
  const store = new LegionMailboxStoreV2({ root, localAgent: fromPrincipal });
  const correlation = correlationId && LINK_V2_MESSAGE_ID_RE.test(String(correlationId)) ? String(correlationId) : null;
  const envelope = store.send({
    keyring,
    keyId: provisioned.keyId,
    message: {
      to: toPrincipal,
      body: payload,
      ttl_ms: DEFAULT_TTL_MS,
      max_hops: DEFAULT_MAX_HOPS,
      correlation_id: correlation ?? undefined,
      causation_id: correlation ?? undefined
    }
  });

  return {
    delivered: true,
    transport: "mailbox",
    recipient,
    destination: store.inboxPathFor(toPrincipal),
    messageId: envelope.id,
    correlationId: envelope.correlation_id,
    record: envelope
  };
}

// ---------------------------------------------------------------------------
// Reading. v2 envelopes are verified and accepted through the mailbox store
// (receipts make re-reads idempotent); malformed, tampered, or unkeyed lines
// never expose their bodies. v1 legacy records are invisible unless
// LEGION_MAILBOX_V1_COMPAT is set, and then they are marked untrusted.
// ---------------------------------------------------------------------------

function legionMailboxV1CompatEnabled(env) {
  const value = String(env.LEGION_MAILBOX_V1_COMPAT ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readLegionMailboxV2Records(name, env) {
  const root = legionRoot(env);
  const inbox = legionInboxPathV2(name, env);
  let raw;
  try {
    raw = fs.readFileSync(inbox, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], rejected: 0 };
    throw error;
  }
  const keyring = loadLegionKeyring(env);
  const store = new LegionMailboxStoreV2({ root, localAgent: `agent:${name}` });
  const now = Date.now();
  const records = [];
  const seen = new Set();
  let rejected = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let accepted;
    try {
      if (!keyring) throw new Error("no provisioned sender keys");
      try {
        // Idempotent path first: re-authenticate and match the durable
        // acceptance receipt without mutating replay state.
        accepted = store.verifyPreviouslyAccepted(`${line}\n`, now, keyring);
      } catch (priorError) {
        if (priorError?.code !== "CorruptState") throw priorError;
        // No durable receipt — fresh ingress through the full accept path.
        accepted = store.verifyAndAccept(`${line}\n`, now, keyring);
      }
    } catch {
      rejected += 1;
      continue;
    }
    if (seen.has(accepted.envelope.id)) continue; // exact duplicate re-verified against its receipt
    seen.add(accepted.envelope.id);
    const envelope = accepted.envelope;
    records.push({
      id: envelope.id,
      ts: new Date(envelope.sent_at_ms).toISOString(),
      from: envelope.from.replace(/^agent:/u, ""),
      to: envelope.to.replace(/^agent:/u, ""),
      text: accepted.body,
      transport: "mailbox",
      replyTo: null,
      correlationId: envelope.correlation_id,
      kind: envelope.kind,
      seq: envelope.seq,
      sent_at_ms: envelope.sent_at_ms
    });
  }
  return { records, rejected };
}

function readLegionMailboxV1CompatRecords(name, env) {
  const source = legionMailboxPath(name, env);
  let raw;
  try {
    raw = fs.readFileSync(source, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== "object" || !value.id) continue;
    records.push({ ...value, transport: "mailbox-v1", untrusted: true });
  }
  return records;
}

export function readLegionMailbox(agent, { afterId = null, limit = 100 } = {}, env = process.env) {
  const name = normalizeLegionAgentName(agent);
  if (!name) throw new Error(`Invalid Legion mailbox agent name: ${String(agent ?? "")}`);
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));

  const { records, rejected } = readLegionMailboxV2Records(name, env);
  if (legionMailboxV1CompatEnabled(env)) {
    records.push(...readLegionMailboxV1CompatRecords(name, env));
  }

  let afterSeen = afterId == null;
  const paged = [];
  for (const record of records) {
    if (!afterSeen) {
      if (record.id === String(afterId)) afterSeen = true;
      continue;
    }
    paged.push(record);
  }
  const result = paged.slice(-cap);
  // Non-enumerable: `deepEqual(records, [])` comparisons stay meaningful while
  // callers can still inspect the per-line rejection count.
  Object.defineProperty(result, "rejected", { value: rejected, enumerable: false, configurable: true });
  return result;
}

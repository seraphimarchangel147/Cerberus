import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendJsonLine, ensureDir } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/u;

export function legionRoot(env = process.env) {
  const configured = String(env.LEGION_HOME ?? "").trim();
  return path.resolve(configured || path.join(os.homedir(), ".legion"));
}

export function normalizeLegionAgentName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return AGENT_NAME_RE.test(name) ? name : null;
}

export function legionMailboxPath(agent, env = process.env) {
  const name = normalizeLegionAgentName(agent);
  if (!name) throw new Error(`Invalid Legion mailbox agent name: ${String(agent ?? "")}`);
  return path.join(legionRoot(env), "mailbox", `${name}.jsonl`);
}

export function deliverLegionMailbox({ from, to, text, replyTo = null, correlationId = null } = {}, env = process.env) {
  const sender = normalizeLegionAgentName(from);
  const recipient = normalizeLegionAgentName(to);
  const payload = String(text ?? "").trim();
  if (!sender) throw new Error("Local Legion delivery requires a valid sender name.");
  if (!recipient) throw new Error("Local Legion delivery requires a valid recipient name.");
  if (!payload) throw new Error("Local Legion delivery requires non-empty text.");

  const destination = legionMailboxPath(recipient, env);
  ensureDir(path.dirname(destination));
  try { fs.chmodSync(legionRoot(env), 0o700); } catch { /* best effort for an existing shared root */ }
  try { fs.chmodSync(path.dirname(destination), 0o700); } catch { /* best effort */ }

  const record = {
    id: createId("legion"),
    ts: nowIso(),
    from: sender,
    to: recipient,
    text: payload,
    transport: "mailbox",
    replyTo: replyTo ? String(replyTo) : null,
    correlationId: correlationId ? String(correlationId) : null
  };
  appendJsonLine(destination, record, 0o600);
  try { fs.chmodSync(destination, 0o600); } catch { /* best effort */ }

  return {
    delivered: true,
    transport: "mailbox",
    recipient,
    destination,
    messageId: record.id,
    correlationId: record.correlationId,
    record
  };
}

export function readLegionMailbox(agent, { afterId = null, limit = 100 } = {}, env = process.env) {
  const source = legionMailboxPath(agent, env);
  let raw;
  try {
    raw = fs.readFileSync(source, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  const seen = new Set();
  const records = [];
  let afterSeen = afterId == null;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    const id = String(value?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!afterSeen) {
      if (id === String(afterId)) afterSeen = true;
      continue;
    }
    records.push(value);
  }
  return records.slice(-cap);
}

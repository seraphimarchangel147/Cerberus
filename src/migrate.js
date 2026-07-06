import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Migrator: import an existing OpenClaw or Hermes Agent install into OpenAGI —
// persona/identity, memory, and the Telegram bot — so the agent moves over as
// ITSELF, not a fresh one. Generalizes the manual OpenClaw→OpenAGI migration.
//
// Each source adapter reads that agent's files and returns a normalized shape:
//   { source, agentName, persona, memories: [{name, content}], telegram: {token, label}[], notes: [] }
// The applier writes persona.md + Telegram env into OpenAGI's data dir and
// POSTs each memory through /memory/remember. Non-destructive: the source
// install is only read.

const HOME = os.homedir();

// ─── source detection ────────────────────────────────────────────────────

export function defaultSourceDir(source) {
  if (source === "openclaw") return path.join(HOME, ".openclaw");
  if (source === "hermes") {
    // Hermes keeps its workspace under a few known spots depending on version.
    for (const d of [path.join(HOME, ".hermes"), path.join(HOME, ".hermes-agent"), path.join(HOME, "hermes", "workspace")]) {
      if (fs.existsSync(d)) return d;
    }
    return path.join(HOME, ".hermes");
  }
  return null;
}

export function detectSource(dir = HOME) {
  if (fs.existsSync(path.join(dir, ".openclaw", "openclaw.json")) || fs.existsSync(path.join(dir, "openclaw.json"))) return "openclaw";
  if (fs.existsSync(path.join(dir, ".hermes")) || fs.existsSync(path.join(dir, "USER.md")) && fs.existsSync(path.join(dir, "MEMORY.md"))) return "hermes";
  return null;
}

const readFile = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const readMemoryDir = (dir) => {
  let out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const content = readFile(path.join(dir, f))?.trim();
      if (content) out.push({ name: f.replace(/\.md$/, ""), content });
    }
  } catch { /* no dir */ }
  return out;
};

// ─── OpenClaw adapter ──────────────────────────────────────────────────────

export function extractOpenClaw(dir) {
  // dir is the .openclaw root (workspace/, openclaw.json, memory/).
  const ws = path.join(dir, "workspace");
  const identity = readFile(path.join(ws, "IDENTITY.md"));
  const soul = readFile(path.join(ws, "SOUL.md"));
  const user = readFile(path.join(ws, "USER.md"));
  const personaParts = [identity, soul, user].filter(Boolean);

  const agentName = identity?.match(/Name:?\**\s*[:|-]?\s*([^\n*]+)/i)?.[1]?.trim() || null;
  const persona = personaParts.length
    ? `# ${agentName ?? "Agent"} — persona\n\n${personaParts.join("\n\n")}`
    : null;

  const memories = readMemoryDir(path.join(ws, "memory"));

  const cfg = readJson(path.join(dir, "openclaw.json"));
  const telegram = [];
  const accounts = cfg?.channels?.telegram?.accounts ?? {};
  for (const [label, acct] of Object.entries(accounts)) {
    if (acct?.botToken) telegram.push({ token: acct.botToken, label });
  }

  const notes = [];
  const jobs = readJson(path.join(dir, "cron", "jobs.json"));
  const jobList = Array.isArray(jobs) ? jobs : jobs?.jobs ?? [];
  if (jobList.length) notes.push(`${jobList.length} cron job(s) found (recreate manually): ${jobList.map((j) => j.name).filter(Boolean).join(", ")}`);

  return { source: "openclaw", agentName, persona, memories, telegram, notes };
}

// ─── Hermes adapter ────────────────────────────────────────────────────────

export function extractHermes(dir) {
  // Hermes' Tier-1 curated state: USER.md (about the human) + MEMORY.md
  // (durable memory), at the workspace root. Plus any *.md under memory/.
  const root = fs.existsSync(path.join(dir, "USER.md")) ? dir : path.join(dir, "workspace");
  const user = readFile(path.join(root, "USER.md"));
  const memoryMd = readFile(path.join(root, "MEMORY.md"));
  const identity = readFile(path.join(root, "IDENTITY.md")) ?? readFile(path.join(root, "AGENT.md"));

  const agentName = identity?.match(/Name:?\**\s*[:|-]?\s*([^\n*]+)/i)?.[1]?.trim() || null;
  const personaParts = [identity, user].filter(Boolean);
  const persona = personaParts.length ? `# ${agentName ?? "Agent"} — persona\n\n${personaParts.join("\n\n")}` : null;

  const memories = [];
  if (memoryMd) memories.push({ name: "MEMORY", content: memoryMd.trim() });
  memories.push(...readMemoryDir(path.join(root, "memory")));

  const telegram = [];
  const cfg = readJson(path.join(dir, "config.json")) ?? readJson(path.join(dir, "hermes.json"));
  const tok = cfg?.channels?.telegram?.botToken ?? cfg?.telegram?.botToken ?? cfg?.TELEGRAM_BOT_TOKEN;
  if (tok) telegram.push({ token: tok, label: "default" });

  const notes = [];
  notes.push("Hermes SQLite/FTS memory and external memory plugins are not imported — only the curated USER.md/MEMORY.md state files.");

  return { source: "hermes", agentName, persona, memories, telegram, notes };
}

export function extract(source, dir) {
  if (source === "openclaw") return extractOpenClaw(dir);
  if (source === "hermes") return extractHermes(dir);
  throw new Error(`unknown source: ${source} (expected openclaw|hermes)`);
}

// ─── apply to OpenAGI ──────────────────────────────────────────────────────

// Write persona.md + Telegram env to the data dir, POST memories through the
// daemon. `client` is a CliClient pointed at the target (local or remote main).
// dryRun → returns the plan without changing anything.
export async function applyMigration({ extracted, dataDir, client, dryRun = false, env = {} }) {
  const plan = { persona: Boolean(extracted.persona), memories: extracted.memories.length, telegram: extracted.telegram.length, agentName: extracted.agentName, applied: !dryRun };
  if (dryRun) return { ...plan, notes: extracted.notes };

  // 1. persona.md
  if (extracted.persona) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "persona.md"), extracted.persona + "\n", { mode: 0o600 });
  }

  // 2. Telegram → <dataDir>/.env (first account only; long-poll for headless).
  if (extracted.telegram[0]?.token) {
    const envPath = path.join(dataDir, ".env");
    let text = "";
    try { text = fs.readFileSync(envPath, "utf8"); } catch { /* fresh */ }
    if (!/^TELEGRAM_BOT_TOKEN=/m.test(text)) text += `${text.endsWith("\n") || !text ? "" : "\n"}TELEGRAM_BOT_TOKEN=${extracted.telegram[0].token}\n`;
    if (!/^TELEGRAM_POLLING=/m.test(text)) text += "TELEGRAM_POLLING=1\n";
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(envPath, text, { mode: 0o600 });
  }

  // 3. memories → /memory/remember
  let importedMemories = 0;
  for (const m of extracted.memories) {
    const res = await client.request("POST", "/memory/remember", {
      content: m.content, tags: [`${extracted.source}-import`, m.name], importance: "high"
    });
    if (res.ok) importedMemories++;
  }

  return { ...plan, importedMemories, notes: extracted.notes };
}

const PURGE_WINDOW_START = "2026-06-07";
const PURGE_WINDOW_END_EXCLUSIVE = "2026-06-17";
const CURRENT_DIMENSION_KEYS = ["risk", "novelty", "repetition"];

export function isPoisonedOutcome(outcome) {
  if (!outcome || outcome.resolved !== true) return false;
  const dims = outcome.scrutinyDimensions;
  if (!dims || typeof dims !== "object") return false;
  const missingCurrentKey = CURRENT_DIMENSION_KEYS.some((key) => typeof dims[key] !== "number");
  if (!missingCurrentKey) return false;
  if (typeof outcome.resolvedAt !== "string") return false;
  return outcome.resolvedAt >= PURGE_WINDOW_START && outcome.resolvedAt < PURGE_WINDOW_END_EXCLUSIVE;
}

export function purgePoisonedOutcomes({
  dataDir = resolveDataDir(),
  dryRun = process.env.OPENAGI_MIGRATE_DRY_RUN === "1",
  log = console.log
} = {}) {
  const snapshotPath = path.join(dataDir, "outcomes", "snapshot.json");
  const snap = readJsonFile(snapshotPath, null);
  if (!snap || !Array.isArray(snap.outcomes)) {
    log(`purge-outcomes: no snapshot at ${snapshotPath} - nothing to do.`);
    return { dryRun, snapshotPath, total: 0, removed: 0, kept: 0, backupPath: null };
  }

  const kept = [];
  const removed = [];
  for (const outcome of snap.outcomes) {
    if (isPoisonedOutcome(outcome)) removed.push(outcome);
    else kept.push(outcome);
  }

  const label = dryRun ? "purge-outcomes (dry run)" : "purge-outcomes";
  log(`${label}: ${snap.outcomes.length} outcomes in ${snapshotPath}`);
  log(`${label}: removed=${removed.length} (old dims format, resolved 2026-06-07..2026-06-16 UTC), kept=${kept.length}${dryRun ? " - no changes written" : ""}`);

  let backupPath = null;
  if (!dryRun && removed.length > 0) {
    backupPath = path.join(dataDir, "outcomes", `snapshot.backup-${nowIso().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(snapshotPath, backupPath);
    writeJsonAtomic(snapshotPath, { version: snap.version ?? 1, updatedAt: nowIso(), outcomes: kept });
    log(`${label}: backup written to ${backupPath}`);
  }

  return { dryRun, snapshotPath, total: snap.outcomes.length, removed: removed.length, kept: kept.length, backupPath };
}

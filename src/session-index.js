// SQLite FTS5 index over the agent's own chat transcripts so the agent can
// search its past conversations on demand (the search_sessions tool). Memory
// distillation is lossy by design; the raw transcript is ground truth for
// "what did we decide about X three weeks ago?".
//
// File-backed at <dataDir>/agent-host/session-index.db — next to the per-
// session transcript JSON files it indexes (agent-store.js). Same node:sqlite
// + FTS5 pattern (and JSONL fallback) as observation-store.js. Schema:
//   messages(FTS5) — one row per persisted chat message
//
// Rows are append-only here; the transcripts on disk remain the source of
// truth. Deleting the DB is always safe — boot detects an empty index and
// backfills from transcripts (see rebuildFromTranscripts + createDefaultRuntime).

import path from "node:path";
import fs from "node:fs";
import { ensureDir } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

let sqlite3Module = null;
async function loadSqlite() {
  if (sqlite3Module) return sqlite3Module;
  try {
    sqlite3Module = await import("node:sqlite");
    return sqlite3Module;
  } catch {
    sqlite3Module = null;
    return null;
  }
}

export class SessionIndex {
  constructor(options = {}) {
    this.dir = options.dir ?? path.join(resolveDataDir(), "agent-host");
    this.dbPath = path.join(this.dir, "session-index.db");
    ensureDir(this.dir);
    // Recorded BEFORE the DB file is created, so callers can tell a first
    // boot (no index yet) from a normal one. Boot backfill itself gates on
    // "index is empty" (createDefaultRuntime), which also covers a DB file
    // that exists but was created empty.
    this.wasMissing = !fs.existsSync(this.dbPath) && !fs.existsSync(path.join(this.dir, "session-index.jsonl"));
    this.db = null;
    this.fallback = null; // JSONL fallback when node:sqlite isn't available
    this.fallbackPath = path.join(this.dir, "session-index.jsonl");
    this.ready = this.init();
  }

  async init() {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      // node:sqlite is available in Node 22.5+. If it's missing we degrade to
      // a JSONL append log so search still works (slower, no FTS ranking).
      this.fallback = true;
      return;
    }
    this.db = new sqlite.DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        msg_id UNINDEXED,
        session_id UNINDEXED,
        agent_id UNINDEXED,
        ts UNINDEXED,
        role UNINDEXED,
        text,
        tokenize='porter unicode61'
      );
    `);
  }

  async indexMessage(sessionId, agentId, msg) {
    await this.ready;
    if (!msg || typeof msg.content !== "string" || !msg.content.trim()) return { indexed: 0 };
    const row = {
      msgId: msg.id ?? null,
      sessionId: String(sessionId ?? ""),
      agentId: String(agentId ?? ""),
      ts: msg.createdAt ?? nowIso(),
      role: msg.role ?? "user",
      text: msg.content
    };
    if (this.fallback) {
      fs.appendFileSync(this.fallbackPath, JSON.stringify(row) + "\n");
      return { indexed: 1, mode: "fallback-jsonl" };
    }
    // Dedupe by message id so a boot-time backfill racing live appends can't
    // double-index a row. msg_id is UNINDEXED in the FTS5 table so this is a
    // scan — the same trade-off observation-store makes for transcript refs.
    if (row.msgId) {
      const existing = this.db.prepare(`SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1`).get(row.msgId);
      if (existing) return { indexed: 0, deduped: true };
    }
    this.db.prepare(
      `INSERT INTO messages (msg_id, session_id, agent_id, ts, role, text) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.msgId, row.sessionId, row.agentId, row.ts, row.role, row.text);
    return { indexed: 1, mode: "sqlite" };
  }

  async search(query, { limit = 8 } = {}) {
    await this.ready;
    const q = String(query ?? "").trim();
    if (!q) return [];
    if (this.fallback) {
      // Naive fallback search through the JSONL log.
      let rows = [];
      try { rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
      const needle = q.toLowerCase();
      return rows
        .filter((r) => (r.text || "").toLowerCase().includes(needle))
        .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))
        .slice(0, limit)
        .map((r) => ({ sessionId: r.sessionId, ts: r.ts, role: r.role, snippet: r.text }));
    }
    // FTS5 query — escape doubled-quotes for the MATCH expression
    const escaped = q.replace(/"/g, '""');
    const matchExpr = `"${escaped}"`;
    const rows = this.db.prepare(
      `SELECT session_id, ts, role, snippet(messages, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM messages WHERE messages MATCH ?
       ORDER BY ts DESC LIMIT ?`
    ).all(matchExpr, limit);
    return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, role: r.role, snippet: r.snippet }));
  }

  async stats() {
    await this.ready;
    if (this.fallback) {
      let lines = 0;
      try { lines = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).length; } catch { /* none */ }
      return { mode: "fallback-jsonl", messages: lines };
    }
    const m = this.db.prepare("SELECT COUNT(*) AS n FROM messages").get();
    return { mode: "sqlite", messages: m.n };
  }
}

// SessionIndex: FTS5 search over the agent's own chat transcripts, feeding
// the search_sessions tool. All transcripts in this file are SYNTHETIC —
// these tests must never read the live ~/.openagi data dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultRuntime,
  DeterministicModelProvider,
  FileBackedAgentStore,
  SessionIndex
} from "../src/index.js";

test("session index round-trips: indexMessage then search finds the message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-"));
  const index = new SessionIndex({ dir });
  await index.ready;
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_0001",
    role: "user",
    content: "we decided to use postgres for the billing service",
    createdAt: "2026-06-01T10:00:00.000Z"
  });
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_0002",
    role: "assistant",
    content: "Noted, postgres it is for billing.",
    createdAt: "2026-06-01T10:00:05.000Z"
  });
  const hits = await index.search("postgres", { limit: 5 });
  assert.ok(hits.length >= 2, `expected two hits, got ${hits.length}`);
  assert.equal(hits[0].sessionId, "local:user:main");
  assert.ok(["user", "assistant"].includes(hits[0].role));
  assert.match(hits[0].snippet, /postgres/i);
  assert.ok(hits[0].ts, "hit carries a timestamp");
  assert.equal(hits[0].ts, "2026-06-01T10:00:05.000Z", "results are newest-first");
});

test("search snippets are capped at 160 chars", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-cap-"));
  const index = new SessionIndex({ dir });
  await index.ready;
  // Long tokens so even the 12-token FTS snippet window exceeds 160 chars.
  const filler = Array(40).fill("abcdefghijklmnopqrstuvwxyzabcd").join(" ");
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_cap",
    role: "user",
    content: `zanzibarmigration ${filler}`,
    createdAt: "2026-06-02T09:00:00.000Z"
  });
  const hits = await index.search("zanzibarmigration", { limit: 3 });
  assert.ok(hits.length >= 1, "expected a hit");
  assert.ok(hits[0].snippet.length <= 160, `snippet must be capped at 160 chars, got ${hits[0].snippet.length}`);
});

test("rebuildFromTranscripts backfills a fresh index from seeded transcripts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-rebuild-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  store.appendMessage("local:user:main", {
    role: "user",
    content: "let's standardize on the kumquat naming convention",
    agentId: "main",
    channel: "local",
    from: "user",
    createdAt: "2026-06-03T08:00:00.000Z"
  });
  store.appendMessage("telegram:42:main", {
    role: "assistant",
    content: "Reminder: kumquat convention applies to new modules only.",
    agentId: "main",
    channel: "telegram",
    from: "openagi",
    createdAt: "2026-06-04T08:00:00.000Z"
  });

  const index = new SessionIndex({ dir: path.join(dir, "agent-host") });
  assert.equal(index.wasMissing, true, "fresh dir means the DB is reported missing");
  const result = await index.rebuildFromTranscripts(store);
  assert.equal(result.sessions, 2);
  assert.equal(result.indexed, 2);
  const hits = await index.search("kumquat", { limit: 5 });
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.sessionId === "telegram:42:main"));
  assert.ok(hits.some((h) => h.sessionId === "local:user:main"));
});

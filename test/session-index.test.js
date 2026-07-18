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
});

// Code-review finding: search() wrapped the whole query in one FTS5 phrase
// match, so a multi-word query only matched an exact contiguous phrase
// instead of an AND of terms — undermining search_sessions for any query
// longer than one distinctive word (every prior test here used single words).
test("session index search: multi-word query matches terms in any order (AND, not exact phrase)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-multi-"));
  const index = new SessionIndex({ dir });
  await index.ready;
  await index.indexMessage("local:user:main", "main", {
    id: "msg_multi_0001",
    role: "user",
    content: "the topology decision is that the distiller stays the main brain",
    createdAt: "2026-07-06T10:00:00.000Z"
  });
  // Same two distinctive words, different order/spacing — an exact-phrase
  // match on "topology decision" would miss this, but an AND-of-terms match
  // must find it.
  const hits = await index.search("decision topology", { limit: 5 });
  assert.ok(hits.length >= 1, "AND-of-terms query must find a message where the words appear out of order");
  assert.match(hits[0].snippet, /topology/i);
  assert.match(hits[0].snippet, /decision/i);
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
  await store.appendMessage("local:user:main", {
    role: "user",
    content: "let's standardize on the kumquat naming convention",
    agentId: "main",
    channel: "local",
    from: "user",
    createdAt: "2026-06-03T08:00:00.000Z"
  });
  await store.appendMessage("telegram:42:main", {
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

// Discovered live: a production install with 114k+ messages of transcript
// history turned a first-boot backfill into one fsync-per-message commit on
// slow storage — minutes of daemon downtime instead of a couple of seconds.
// rebuildFromTranscripts must wrap the whole backfill in a single
// transaction, not auto-commit each indexMessage() call individually.
test("rebuildFromTranscripts wraps the whole backfill in a single transaction, not one per message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-txn-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  for (let i = 0; i < 5; i++) {
    await store.appendMessage(`local:user:main-${i}`, {
      role: "user", content: `message number ${i} about widgets`, agentId: "main",
      channel: "local", from: "user", createdAt: `2026-06-0${(i % 9) + 1}T08:00:00.000Z`
    });
  }
  const index = new SessionIndex({ dir: path.join(dir, "agent-host") });
  await index.ready;
  const execCalls = [];
  const originalExec = index.db.exec.bind(index.db);
  index.db.exec = (sql) => { execCalls.push(sql); return originalExec(sql); };
  const result = await index.rebuildFromTranscripts(store);
  assert.equal(result.indexed, 5);
  const beginCount = execCalls.filter((sql) => sql.trim().toUpperCase().startsWith("BEGIN")).length;
  const commitCount = execCalls.filter((sql) => sql.trim().toUpperCase().startsWith("COMMIT")).length;
  assert.equal(beginCount, 1, "exactly one BEGIN for the whole backfill, not one per message");
  assert.equal(commitCount, 1, "exactly one COMMIT for the whole backfill, not one per message");
});

test("agent host indexes persisted chat turns; ephemeral turns are excluded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-host-"));
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    sessionIndexOptions: { dir: path.join(dir, "agent-host") },
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  assert.ok(runtime.sessionIndex, "runtime should construct a SessionIndex");

  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "please review the xylophone budget line" });
  await runtime.agentHost.handleMessage({ channel: "local", from: "setup", text: "ephemeral xylograph check", ephemeral: true });

  const hits = await runtime.sessionIndex.search("xylophone", { limit: 5 });
  assert.ok(hits.length >= 1, "persisted user turn should be indexed");
  assert.ok(hits.some((h) => h.role === "user"));

  const ghost = await runtime.sessionIndex.search("xylograph", { limit: 5 });
  assert.equal(ghost.length, 0, "ephemeral turns must not be indexed");
});

test("boot backfills an empty index from existing transcripts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-boot-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  await store.appendMessage("local:user:main", {
    role: "user",
    content: "archive the pelican dashboard next sprint",
    agentId: "main",
    channel: "local",
    from: "user",
    createdAt: "2026-06-06T08:00:00.000Z"
  });

  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    agentStore: store,
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  assert.ok(runtime.sessionIndex.rebuildPromise, "boot should schedule a backfill");
  await runtime.sessionIndex.rebuildPromise;
  const hits = await runtime.sessionIndex.search("pelican", { limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "local:user:main");
});

test("search_sessions tool is registered read-only and returns formatted results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-tool-"));
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  const tool = runtime.tools.get("search_sessions");
  assert.ok(tool, "search_sessions tool should be registered");
  assert.equal(tool.sideEffects, false, "search_sessions must be read-only");
  assert.equal(tool.needsConfirmation, false);

  await runtime.sessionIndex.indexMessage("local:user:main", "main", {
    id: "msg_tool_0001",
    role: "user",
    content: "the quarterly flamingo report is due friday",
    createdAt: "2026-06-05T09:30:00.000Z"
  });

  const result = await runtime.tools.invoke("search_sessions", { query: "flamingo", limit: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.result.count >= 1);
  const hit = result.result.results[0];
  assert.equal(hit.sessionId, "local:user:main");
  assert.match(hit.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "human-readable timestamp");
  assert.equal(hit.role, "user");
  assert.ok(hit.snippet.length <= 160);
});

// Code-review finding: init() had no attached rejection handler anywhere
// unconditional (createDefaultRuntime only wires one inside an
// agentHost-gated block), so any DB-open/exec failure (e.g. a transient
// sqlite lock) became an unhandled rejection that permanently disabled
// session search for the process's lifetime with no fallback and no retry.
test("init() never rejects: a DB-open failure degrades to the JSONL fallback instead of an unhandled rejection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-fail-"));
  // Force DatabaseSync's open to throw: session-index.db is a directory, not
  // a file, so opening it as a sqlite database fails deterministically.
  fs.mkdirSync(path.join(dir, "session-index.db"));

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const index = new SessionIndex({ dir });
    await index.ready; // must resolve, not reject
    // Give any stray unhandled-rejection microtask a turn to fire before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, null, "init() failure must not produce an unhandled rejection");
    assert.equal(index.fallback, true, "degrades to the JSONL fallback mode");
    // The instance must still be fully usable in fallback mode.
    await index.indexMessage("local:user:main", "main", {
      id: "msg_fail_0001", role: "user", content: "still searchable via fallback",
      createdAt: "2026-07-07T00:00:00.000Z"
    });
    const hits = await index.search("fallback", { limit: 5 });
    assert.ok(hits.length >= 1, "fallback-mode search must still find the indexed message");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// Discovered live on a production install: msg_id is UNINDEXED in the FTS5
// schema (search comment at src/session-index.js:113-114), so indexMessage's
// per-row dedup lookup ("SELECT 1 FROM messages WHERE msg_id = ?") is a full
// table scan — O(N) per insert, O(N^2) for a full backfill. Even wrapped in
// one transaction (the earlier fix), a real history of 100k+ messages turned
// this into a many-minutes-long stall that blocked the HTTP server entirely
// (Node's single JS thread has no I/O wait to yield on anymore once
// everything is one transaction). rebuildFromTranscripts only ever runs
// against a freshly empty index (gated by stats().messages > 0 in
// abi-runtime.js), so no duplicate can exist within its own walk — dedup is
// providing zero protection there and can be skipped entirely for that path.
test("rebuildFromTranscripts completes quickly on a large history (dedup skipped on the empty-index bulk path)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-scale-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  const MESSAGE_COUNT = 3000;
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    await store.appendMessage(`local:user:session-${i % 20}`, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message number ${i} discussing topic ${i % 50} and widgets`,
      agentId: "main", channel: "local", from: "user",
      createdAt: new Date(Date.UTC(2026, 5, 1) + i * 1000).toISOString()
    });
  }
  const index = new SessionIndex({ dir: path.join(dir, "agent-host") });
  const startedAt = Date.now();
  const result = await index.rebuildFromTranscripts(store);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.indexed, MESSAGE_COUNT);
  assert.ok(elapsedMs < 3000, `expected the ${MESSAGE_COUNT}-message backfill to finish in under 3s, took ${elapsedMs}ms (O(N^2) dedup regression?)`);
  const stats = await index.stats();
  assert.equal(stats.messages, MESSAGE_COUNT);
});

test("rebuildFromTranscripts never runs the O(N) dedup lookup; indexMessage still dedupes by default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-dedupe-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  await store.appendMessage("local:user:main", {
    id: "msg_dedupe_check", role: "user", content: "checking dedupe behavior",
    agentId: "main", channel: "local", from: "user", createdAt: "2026-06-01T10:00:00.000Z"
  });
  const index = new SessionIndex({ dir: path.join(dir, "agent-host") });
  await index.ready;
  const originalPrepare = index.db.prepare.bind(index.db);
  const preparedSql = [];
  index.db.prepare = (sql) => { preparedSql.push(sql); return originalPrepare(sql); };

  await index.rebuildFromTranscripts(store);
  assert.ok(
    !preparedSql.some((sql) => sql.includes("WHERE msg_id")),
    "rebuildFromTranscripts must never prepare the dedup lookup (skipDedupe: true)"
  );

  // The live incremental path (no skipDedupe) must still dedupe correctly.
  preparedSql.length = 0;
  const first = await index.indexMessage("local:user:live", "main", {
    id: "msg_live_0001", role: "user", content: "live message", createdAt: "2026-07-07T00:00:00.000Z"
  });
  const second = await index.indexMessage("local:user:live", "main", {
    id: "msg_live_0001", role: "user", content: "live message", createdAt: "2026-07-07T00:00:00.000Z"
  });
  assert.equal(first.indexed, 1);
  assert.equal(second.indexed, 0, "duplicate id on the live path is still deduped");
  assert.equal(second.deduped, true);
  assert.ok(preparedSql.some((sql) => sql.includes("WHERE msg_id")), "live path still runs the dedup lookup");
});

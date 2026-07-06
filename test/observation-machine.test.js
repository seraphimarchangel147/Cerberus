// test/observation-machine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// These tests exercise the SQLite path (columns, FTS joins); skip cleanly on
// a Node without node:sqlite (< 22.5), matching the store's own fallback.
let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

test("record() stores a batch sourceMachineId and search({machine}) filters recent activity", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mach-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "activity", at: "2026-07-01T11:00:00.000Z", app: "Terminal", window: "htop", event: "focus" }
  ], { sourceMachineId: "mac-B" });

  const a = await store.search({ machine: "mac-A", limit: 10 });
  assert.equal(a.length, 1);
  assert.equal(a[0].app, "Safari");
  assert.equal(a[0].sourceMachineId, "mac-A");

  const none = await store.search({ machine: "mac-C", limit: 10 });
  assert.equal(none.length, 0);

  const all = await store.search({ limit: 10 });
  assert.equal(all.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("search({query, machine}) filters FTS hits (frames and activity) by machine", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-fts-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "frame", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Roadmap", frameId: "f-A", ocrText: "quarterly roadmap review" },
    { kind: "activity", at: "2026-07-01T10:00:01.000Z", app: "Safari", window: "quarterly roadmap tab", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "frame", at: "2026-07-01T11:00:00.000Z", app: "Safari", window: "Roadmap", frameId: "f-B", ocrText: "quarterly roadmap review" }
  ], { sourceMachineId: "mac-B" });

  const hits = await store.search({ query: "roadmap", machine: "mac-A", limit: 10 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.kind === "frame" ? h.ref === "f-A" : h.kind === "activity"));

  const unfiltered = await store.search({ query: "roadmap", limit: 10 });
  assert.equal(unfiltered.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("opening a pre-migration DB adds source_machine_id columns without losing rows", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mig-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "index.db"));
  db.exec(`
    CREATE TABLE activity (id INTEGER PRIMARY KEY, at TEXT NOT NULL, app TEXT, window TEXT, event TEXT, metadata TEXT);
    CREATE TABLE frames (id INTEGER PRIMARY KEY, frame_uid TEXT UNIQUE, captured_at TEXT NOT NULL, app TEXT, window TEXT, thumbnail_path TEXT, confidence REAL);
    CREATE VIRTUAL TABLE texts USING fts5(kind UNINDEXED, ref UNINDEXED, at UNINDEXED, app, window, text, tokenize='porter unicode61');
  `);
  db.exec(`INSERT INTO activity (at, app, window, event) VALUES ('2026-06-30T09:00:00.000Z', 'Xcode', 'legacy row', 'focus')`);
  db.close();

  const store = new ObservationStore({ dir });
  await store.record(
    { kind: "activity", at: "2026-07-01T09:00:00.000Z", app: "Safari", window: "new row", event: "focus" },
    { sourceMachineId: "mac-A" }
  );
  const filtered = await store.search({ machine: "mac-A", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].window, "new row");
  const all = await store.search({ limit: 10 });
  assert.equal(all.length, 2, "legacy row must survive the migration");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /observations passes the envelope sourceMachineId through to the store", { skip: !hasSqlite }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const res = await fetch(`${base}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceMachineId: "mac-A",
      observations: [{ kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }]
    })
  });
  assert.equal(res.status, 200);
  const filtered = await runtime.observations.search({ machine: "mac-A", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sourceMachineId, "mac-A");
  await app.close?.();
});

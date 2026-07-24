import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutreachStore } from "../src/outreach-store.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outreach-hard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function legacyItem(overrides = {}) {
  return {
    id: "out_0123456789abcdef",
    seq: 1,
    type: "draft",
    sourceRef: null,
    outcomeId: null,
    title: "Legacy default item",
    summary: "",
    needsDecision: false,
    actions: ["approve"],
    status: "unseen",
    decision: null,
    error: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    resolvedAt: null,
    ...overrides
  };
}

test("outreach JSONL remains authoritative when the snapshot is lost", (t) => {
  const dir = tempDir(t);
  const store = new OutreachStore({ dir });
  const first = store.append({
    projectId: "alpha",
    type: "draft",
    title: "Alpha durable item",
    actions: ["approve"]
  });
  const second = store.append({
    projectId: "alpha",
    type: "suggestion",
    title: "Alpha durable suggestion",
    actions: ["accept"]
  });
  store.markSeen([first.id], { projectId: "alpha" });
  store.resolve(
    second.id,
    { action: "accept", by: "user" },
    { projectId: "alpha" }
  );

  const journalPath = path.join(dir, "events.jsonl");
  assert.ok(fs.statSync(journalPath).size > 0);
  fs.rmSync(path.join(dir, "snapshot.json"));

  const reloaded = new OutreachStore({ dir });
  assert.equal(reloaded.get(first.id, { projectId: "alpha" }).status, "seen");
  assert.equal(reloaded.get(second.id, { projectId: "alpha" }).status, "acted");
  assert.equal(reloaded.nextSeq, 3);
});

test("legacy v1 snapshots default-scope old items and seed a journal baseline", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
    version: 1,
    writtenAt: "2026-07-24T00:00:00.000Z",
    nextSeq: 2,
    items: [legacyItem()]
  }));

  const store = new OutreachStore({ dir });
  assert.ok(store.get("out_0123456789abcdef", { projectId: "default" }));
  assert.equal(
    store.get("out_0123456789abcdef", { projectId: "alpha" }),
    null
  );
  const alpha = store.append({
    projectId: "alpha",
    type: "draft",
    title: "New alpha item"
  });
  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(events[0].op, "replace");

  fs.rmSync(path.join(dir, "snapshot.json"));
  const journalOnly = new OutreachStore({ dir });
  assert.ok(journalOnly.get("out_0123456789abcdef", { projectId: "default" }));
  assert.ok(journalOnly.get(alpha.id, { projectId: "alpha" }));
});

test("outreach load and append reject hostile count, schema, and string sizes", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
    version: 1,
    nextSeq: 2,
    items: [legacyItem({ unexpected: "field" })]
  }));
  assert.deepEqual(new OutreachStore({ dir }).list(), []);

  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
    version: 1,
    nextSeq: 1_000,
    items: [legacyItem({ seq: 999 })]
  }));
  assert.deepEqual(new OutreachStore({ dir }).list(), []);

  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
    version: 1,
    nextSeq: 1,
    items: Array.from({ length: 10_001 }, () => null)
  }));
  assert.deepEqual(new OutreachStore({ dir }).list(), []);

  const store = new OutreachStore({ dir: path.join(dir, "fresh") });
  assert.throws(
    () => store.append({
      type: "draft",
      title: "x".repeat(2_001)
    }),
    /title/u
  );
  assert.equal(store.list().length, 0);
  assert.equal(fs.existsSync(path.join(dir, "fresh", "events.jsonl")), false);
});

test("oversized outreach files are never parsed and fall back deterministically", (t) => {
  const dir = tempDir(t);
  const store = new OutreachStore({ dir });
  const item = store.append({ type: "draft", title: "Snapshot survivor" });

  fs.truncateSync(path.join(dir, "events.jsonl"), 31 * 1024 * 1024);
  const fromSnapshot = new OutreachStore({ dir });
  assert.equal(fromSnapshot.get(item.id).title, "Snapshot survivor");

  fs.truncateSync(path.join(dir, "snapshot.json"), 17 * 1024 * 1024);
  fs.rmSync(path.join(dir, "events.jsonl"));
  assert.deepEqual(new OutreachStore({ dir }).list(), []);
});

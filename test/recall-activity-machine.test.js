// test/recall-activity-machine.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { ObservationStore } from "../src/observation-store.js";

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

async function seededStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-mach-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "activity", at: "2026-07-01T10:00:00.000Z", app: "Safari", window: "Docs", event: "focus" }
  ], { sourceMachineId: "mac-A" });
  await store.record([
    { kind: "activity", at: "2026-07-01T11:00:00.000Z", app: "Terminal", window: "htop", event: "focus" }
  ], { sourceMachineId: "mac-B" });
  return { dir, store };
}

test("recall_activity forwards the machine filter to the observation store", { skip: !hasSqlite }, async () => {
  const { dir, store } = await seededStore();
  const registry = new ToolRegistry();
  registerCoreTools(registry, { observations: store });
  const { ok, result } = await registry.invoke("recall_activity", { machine: "mac-A", limit: 10 });
  assert.equal(ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].app, "Safari");
  const schema = registry.get("recall_activity").parameters;
  assert.ok(schema.properties.machine, "machine must be an advertised parameter");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recall_activity without machine returns rows from all machines", { skip: !hasSqlite }, async () => {
  const { dir, store } = await seededStore();
  const registry = new ToolRegistry();
  registerCoreTools(registry, { observations: store });
  const { ok, result } = await registry.invoke("recall_activity", { limit: 10 });
  assert.equal(ok, true);
  assert.equal(result.count, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Code-review finding: the activity text-index ref moved from a stable
// "App:Window" composite key to the numeric rowid, but nothing back-fills
// refs for activity rows already on disk from before this migration — a
// machine-filtered text search over pre-upgrade capture history silently
// returned zero hits even though the content is present in `texts`.
test("machine-filtered text search still finds legacy-format ('App:Window') activity refs", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-mach-legacy-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  // Seed one row the OLD way: activity row + a texts row whose ref is the
  // pre-migration composite key, not the activity row's numeric id.
  const inserted = store.db.prepare(
    "INSERT INTO activity (at, app, window, event, source_machine_id) VALUES (?, ?, ?, ?, ?)"
  ).run("2026-05-01T10:00:00.000Z", "Slack", "general", "focus", "mac-old");
  store.db.prepare(
    "INSERT INTO texts (kind, ref, at, app, window, text) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("activity", "Slack:general", "2026-05-01T10:00:00.000Z", "Slack", "general", "general");
  assert.notEqual(String(inserted.lastInsertRowid), "Slack:general", "sanity: legacy ref must not equal the numeric rowid");

  const hits = await store.search({ query: "general", machine: "mac-old" });
  assert.ok(hits.length >= 1, "pre-migration composite-key ref must still be found under a machine filter");
  fs.rmSync(dir, { recursive: true, force: true });
});

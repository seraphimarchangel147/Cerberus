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

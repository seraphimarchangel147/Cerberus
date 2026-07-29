import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";

function makeStore(events = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-claim-"));
  const store = new TaskStore({
    dataDir,
    runtime: { events: { emit: (name, data) => events.push({ name, data }) } }
  });
  return { store, dataDir };
}

test("agentPickNext stays a pure read; claimNextAgentTask marks in_progress + startedAt", () => {
  const events = [];
  const { store } = makeStore(events);
  const task = store.add({ title: "render pet gif" }, { queue: "agent" });

  const peeked = store.agentPickNext();
  assert.equal(peeked.id, task.id);
  assert.equal(store.get(task.id).status, "pending", "peek must not mutate");
  assert.equal(store.get(task.id).startedAt ?? null, null);

  const claimed = store.claimNextAgentTask();
  assert.equal(claimed.id, task.id);
  const after = store.get(task.id);
  assert.equal(after.status, "in_progress");
  assert.ok(after.startedAt, "claim records startedAt for duration metrics");
  assert.ok(
    events.some((e) => e.name === "task-updated" && e.data.op === "update" && e.data.task.status === "in_progress"),
    "claim emits a task-updated event the Discord feed can report"
  );
});

test("a stranded in_progress claim becomes pickable again after 2h", () => {
  const { store } = makeStore();
  const task = store.add({ title: "died mid-turn" }, { queue: "agent" });
  store.claimNextAgentTask();
  assert.equal(store.agentPickNext(), null, "freshly claimed task is not re-pickable");

  // Age the claim past the 2h stranded-claim horizon.
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  store.tasks.get(task.id).startedAt = stale;

  const reclaimable = store.agentPickNext();
  assert.equal(reclaimable?.id, task.id, "stale claim is reclaimable instead of stranded forever");
});

test("claimed-then-completed task yields queue + work durations", () => {
  const { store } = makeStore();
  const task = store.add({ title: "measure me" }, { queue: "agent" });
  store.claimNextAgentTask();
  store.complete(task.id, "autopilot");

  const done = store.get(task.id);
  assert.equal(done.status, "completed");
  assert.equal(done.bucket, "done");
  assert.equal(done.completedVia, "autopilot");
  assert.ok(Date.parse(done.completedAt) >= Date.parse(done.startedAt), "work duration is computable");
  assert.ok(Date.parse(done.startedAt) >= Date.parse(done.createdAt), "queue wait is computable");
});

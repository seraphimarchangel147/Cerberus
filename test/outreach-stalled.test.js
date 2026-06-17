// test/outreach-stalled.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";
import { surfaceStalledTasks } from "../src/outreach-stalled.js";

function store() {
  return new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "out-stall-")) });
}

test("flagged tasks become stalled-task decision items", () => {
  const s = store();
  const flagged = [{ id: "task_1", title: "Lock the Hyundai" }, { id: "task_2", title: "Reply to Sam" }];
  const created = surfaceStalledTasks(s, flagged);
  assert.equal(created, 2);
  const item = s.list()[0];
  assert.equal(item.type, "stalled-task");
  assert.equal(item.needsDecision, true);
  assert.ok(item.actions.includes("close") && item.actions.includes("keep") && item.actions.includes("snooze"));
});

test("a task already surfaced and still open is not duplicated", () => {
  const s = store();
  surfaceStalledTasks(s, [{ id: "task_1", title: "X" }]);
  const again = surfaceStalledTasks(s, [{ id: "task_1", title: "X" }]);
  assert.equal(again, 0);
  assert.equal(s.list().length, 1);
});

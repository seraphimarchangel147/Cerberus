import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOG_RECORD_BYTES,
  MemTree,
  readableMemoryScopes,
  ScopedMemTree,
  TREE_RECORD_BYTES
} from "../lib/memtree.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("MemTree uses fixed records, exact reads, and cached range summaries", () => {
  const dir = tempDir("memtree-");
  const tree = new MemTree({ dir, wakeBudget: 8 });
  for (let index = 0; index < 20; index += 1) {
    tree.note(`memory ${index}`);
  }

  assert.equal(tree.logLen(), 20);
  assert.equal(fs.statSync(path.join(dir, "LOG.txt")).size, 20 * LOG_RECORD_BYTES);
  assert.deepEqual(tree.recall("memory 1$", { limit: 5 }), [
    { index: 1, text: "memory 1" }
  ]);

  const before = tree.wake(8);
  assert.ok(before.blocks.length <= 8);
  assert.ok(before.merges.length > 0);
  assert.match(before.text, /summary pending/u);
  const requested = before.merges[0];
  const zoomed = tree.zoom(requested.lo, requested.hi, 8);
  assert.equal(zoomed.lo, requested.lo);
  assert.equal(zoomed.hi, requested.hi);

  tree.merge(requested.lo, requested.hi, "older memory summary");
  const after = tree.wake(8);
  assert.ok(after.merges.length < before.merges.length);
  assert.match(after.text, /older memory summary/u);
  const levelPath = path.join(dir, "TREE", String(requested.level));
  assert.ok(fs.statSync(levelPath).size >= (requested.lo + 1) * TREE_RECORD_BYTES);

  const restored = new MemTree({ dir, wakeBudget: 8 });
  assert.match(restored.wake(8).text, /older memory summary/u);
});

test("MemTree migration is oldest-first and never duplicates an existing log", () => {
  const tree = new MemTree({ dir: tempDir("memtree-migrate-"), wakeBudget: 8 });
  const migrated = tree.migrate([
    { id: "new", content: "newer", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "old", content: "older", createdAt: "2026-01-01T00:00:00.000Z" }
  ]);
  assert.equal(migrated.imported, 2);
  assert.deepEqual(tree.recall("older|newer", { limit: 5 }), [
    { index: 0, text: "older" },
    { index: 1, text: "newer" }
  ]);
  assert.equal(tree.migrate([{ content: "duplicate" }]).skipped, 1);
  assert.equal(tree.logLen(), 2);
});

test("ScopedMemTree preserves project and profile boundaries", () => {
  const store = new ScopedMemTree({ dir: tempDir("scoped-memtree-"), wakeBudget: 8 });
  store.note("global fact", { scope: "main" });
  store.note("project fact", { scope: "project:alpha" });
  store.note("nested fact", { scope: "project:alpha:specialist" });
  store.note("private preference", { scope: "profile:abc" });

  const project = store.wake({ scope: "project:alpha:specialist", budget: 8 });
  assert.match(project.text, /project fact/u);
  assert.match(project.text, /nested fact/u);
  assert.doesNotMatch(project.text, /global fact|private preference/u);

  const main = store.wake({
    scope: "main",
    profileScope: "profile:abc",
    budget: 8
  });
  assert.match(main.text, /global fact/u);
  assert.match(main.text, /private preference/u);
  assert.doesNotMatch(main.text, /project fact/u);
  assert.deepEqual(
    readableMemoryScopes("project:alpha:specialist", "profile:abc"),
    ["project:alpha", "project:alpha:specialist", "profile:abc"]
  );
});

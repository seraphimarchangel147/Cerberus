// The event journal embeds full state per event, so it reaches the replay
// ceiling in days. Auto-compaction must heal the store without ever trading
// away durability: the snapshot has to land before superseded events are cut.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-auto-compaction-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function journalSize(dir) {
  return fs.statSync(path.join(dir, "memory-events.jsonl")).size;
}

test("the journal auto-compacts once it crosses its threshold", () => {
  const dir = tempDir();
  const memory = new FileBackedMemorySystem({ dir, autoCompactBytes: 4096 });
  for (let index = 0; index < 40; index += 1) {
    memory.remember(`observation ${index} padded so the embedded state grows`, { tier: "short" });
  }
  assert.ok(journalSize(dir) < 4096, "journal should be reclaimed below the threshold");
  assert.equal(memory.items.size, 40);
  assert.equal(memory.sequence, 40);
});

test("a compacted store recovers every item and its sequence after restart", () => {
  const dir = tempDir();
  const memory = new FileBackedMemorySystem({ dir, autoCompactBytes: 4096 });
  const ids = [];
  for (let index = 0; index < 40; index += 1) {
    ids.push(memory.remember(`durable observation ${index} with padding text`, { tier: "short" }).id);
  }

  const reopened = new FileBackedMemorySystem({ dir, autoCompactBytes: 4096 });
  assert.equal(reopened.journalHealthy, true);
  assert.equal(reopened.journalError, null);
  assert.equal(reopened.items.size, 40);
  assert.equal(reopened.sequence, memory.sequence);
  for (const id of ids) assert.ok(reopened.items.has(id), `item ${id} survived compaction`);

  // Writes continue on the same monotonic sequence after the journal is cut.
  const next = reopened.remember("written after compaction", { tier: "short" });
  assert.ok(next.id);
  assert.equal(reopened.items.size, 41);
});

test("compaction is skipped when the snapshot that supersedes the journal fails", () => {
  const dir = tempDir();
  const memory = new FileBackedMemorySystem({
    dir,
    autoCompactBytes: 1024,
    writeSnapshot: () => { throw new Error("snapshot unavailable"); }
  });
  for (let index = 0; index < 20; index += 1) {
    memory.remember(`fail-closed observation ${index}`, { tier: "short" });
  }
  // Truncating here would leave neither a current snapshot nor the events that
  // rebuild it, so the oversized journal must be preserved instead.
  assert.ok(journalSize(dir) > 1024, "journal must survive a failed snapshot write");
  assert.equal(memory.items.size, 20);
});

test("auto-compaction can be disabled and never exceeds the replay ceiling", () => {
  const dir = tempDir();
  const disabled = new FileBackedMemorySystem({ dir, autoCompact: false, autoCompactBytes: 1024 });
  for (let index = 0; index < 20; index += 1) {
    disabled.remember(`opt-out observation ${index}`, { tier: "short" });
  }
  assert.ok(journalSize(dir) > 1024, "opting out leaves the journal untouched");

  const clamped = new FileBackedMemorySystem({
    dir: tempDir(),
    autoCompactBytes: Number.MAX_SAFE_INTEGER
  });
  assert.ok(
    clamped.autoCompactBytes <= 8 * 1024 * 1024 * 8,
    "threshold is clamped to the journal replay ceiling"
  );
});

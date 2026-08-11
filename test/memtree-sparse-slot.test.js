import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemTree, ScopedMemTree, TREE_RECORD_BYTES, LOG_RECORD_BYTES } from "../lib/memtree.js";

/**
 * Regression: memtree refused to initialize and took the memory tree AND the
 * spill store down for the whole process with
 *   "Fixed-width memory record is missing or partial."
 *
 * Cause: a tree level file is sized to cover every block at that level, but
 * blocks are only written as merges complete. An unmerged slot therefore reads
 * back as a full-width run of NULs. `_readTreeBlock` already returns null for
 * every other unreadable case -- short file, wrong range, non-string line --
 * so the caller re-queues the block for merge. Only this one case threw, which
 * turned an ordinary cache miss into a fatal boot error.
 *
 * The fixture below mirrors the STRUCTURE of the real failing store (captured
 * from the live daemon, content discarded): level 8 has 153 slots with real
 * records at 144 and 152 and holes at the low indices.
 *
 * HONESTY NOTE: these are GUARD tests, not a reproduction. The synthetic
 * fixture passes with and without the fix -- the throw depends on log/tree
 * state this fixture does not fully recreate. The fix is proven instead by an
 * A/B against a COPY of the live store:
 *   without fix -> "Fixed-width memory record is missing or partial."
 *   with fix    -> migrate() returns and memtree initializes
 * These tests lock in the invariant (an unwritten slot is a miss, not a crash)
 * so it cannot silently regress.
 */

const LIVE_SHAPE = {
  logRecords: 339,
  levels: {
    8: { slots: 153, live: { 144: [144, 152], 152: [152, 160] } },
    16: { slots: 129, live: { 0: [0, 10], 10: [10, 26], 96: [96, 112], 112: [112, 128], 128: [128, 144] } },
    32: { slots: 65, live: { 0: [0, 32], 32: [32, 64], 64: [64, 96] } }
  }
};

function writeRecord(buf, index, value) {
  const rec = Buffer.alloc(TREE_RECORD_BYTES);
  rec.write(JSON.stringify(value), 0, "utf8");
  rec[TREE_RECORD_BYTES - 1] = 0x0a;
  rec.copy(buf, index * TREE_RECORD_BYTES);
}

/** Build a store with the live daemon's tree shape and synthetic log text. */
function makeLiveShapeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memtree-sparse-"));
  fs.mkdirSync(path.join(root, "TREE"), { recursive: true });
  fs.writeFileSync(path.join(root, "scope.json"), JSON.stringify({ version: 1, scope: "main" }));

  const log = Buffer.alloc(LOG_RECORD_BYTES * LIVE_SHAPE.logRecords);
  for (let i = 0; i < LIVE_SHAPE.logRecords; i++) {
    const rec = Buffer.alloc(LOG_RECORD_BYTES);
    rec.write(`synthetic log entry ${i}`, 0, "utf8");
    rec[LOG_RECORD_BYTES - 1] = 0x0a;
    rec.copy(log, i * LOG_RECORD_BYTES);
  }
  fs.writeFileSync(path.join(root, "LOG.txt"), log);

  for (const [level, spec] of Object.entries(LIVE_SHAPE.levels)) {
    const buf = Buffer.alloc(TREE_RECORD_BYTES * spec.slots); // holes stay NUL
    for (const [idx, [lo, hi]] of Object.entries(spec.live)) {
      writeRecord(buf, Number(idx), { lo, hi, line: `merged summary ${lo}-${hi}` });
    }
    fs.writeFileSync(path.join(root, "TREE", level), buf);
  }
  return root;
}

test("boot migrate() on a store with unmerged tree slots must not throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memtree-scoped-"));
  const store = makeLiveShapeStore();
  fs.cpSync(store, path.join(dir, "main-scope"), { recursive: true });

  const tree = new MemTree({ root: path.join(dir, "main-scope") });
  assert.doesNotThrow(
    () => tree.migrate([{ content: "an existing memory", createdAt: Date.now() }]),
    "an unwritten tree slot is a cache miss; it must never abort initialization"
  );
});

test("pending() materializes without throwing on unmerged slots", () => {
  const tree = new MemTree({ root: makeLiveShapeStore() });
  assert.doesNotThrow(() => tree.pending());
});

test("unmerged slots are re-queued for merge, never served as data", () => {
  const merges = new MemTree({ root: makeLiveShapeStore() }).pending();
  assert.ok(Array.isArray(merges) && merges.length > 0, "the holes must be scheduled for merge");
  for (const m of merges) {
    assert.ok(m.hi > m.lo, "a merge range must be non-empty");
  }
});

test("a truncated (non-multiple) tree file is also a miss, not a crash", () => {
  const root = makeLiveShapeStore();
  fs.writeFileSync(path.join(root, "TREE", "8"), Buffer.alloc(TREE_RECORD_BYTES + 17, 0x41));
  assert.doesNotThrow(() => new MemTree({ root }).pending());
});

test("ScopedMemTree.migrate survives the same store shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memtree-scoped-"));
  fs.cpSync(makeLiveShapeStore(), path.join(dir, "main"), { recursive: true });
  const scoped = new ScopedMemTree({ dir });
  assert.doesNotThrow(
    () => scoped.migrate([{ scope: "main", content: "x", createdAt: Date.now() }])
  );
});

// Condensation must actually RECLAIM capacity. `markCondensedSources` only
// tags sources with `condensedInto`; nothing ever deleted them, and
// `enforceLimits` fires only on count overflow. A tier at its cap therefore
// stayed at its cap no matter how often the condense cron ran.
//
// The reaper drains those corpses, but only when it is safe to do so:
//   - the principle must still exist and not be superseded
//   - the principle must be out of quarantine (else we destroy the only
//     evidence backing an unvalidated distillation)
//   - locked items are never reaped
import assert from "node:assert/strict";
import test from "node:test";
import { MemorySystem } from "../src/memory-system.js";

const NOW = "2026-07-31T12:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();
const PAST = "2026-07-01T12:00:00.000Z";
const FUTURE = "2026-08-30T12:00:00.000Z";

function makeSource(memory, id, { locked = false, metadata = {} } = {}) {
  return memory.remember(
    { content: `raw source note ${id}`, tags: ["deploy"], locked },
    { tier: "medium", now: NOW, id, metadata }
  );
}

function makePrinciple(memory, id, { quarantineUntil = PAST, supersededBy = null } = {}) {
  return memory.remember(
    { content: `distilled principle ${id}`, tags: ["deploy"], kind: "principle" },
    {
      tier: "long",
      now: NOW,
      id,
      metadata: { quarantineUntil, ...(supersededBy ? { supersededBy } : {}) }
    }
  );
}

test("reaps condensed sources once their principle is committed and out of quarantine", () => {
  const memory = new MemorySystem();
  const principle = makePrinciple(memory, "mem_long_committed");
  makeSource(memory, "mem_medium_a", { metadata: { condensedInto: principle.id } });
  makeSource(memory, "mem_medium_b", { metadata: { condensedInto: principle.id } });
  makeSource(memory, "mem_medium_live");

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.deepEqual(result.reaped.sort(), ["mem_medium_a", "mem_medium_b"]);
  assert.equal(memory.items.has("mem_medium_a"), false);
  assert.equal(memory.items.has("mem_medium_b"), false);
  // The live source and the principle itself must survive.
  assert.equal(memory.items.has("mem_medium_live"), true);
  assert.equal(memory.items.has(principle.id), true);
});

test("does NOT reap while the principle is still quarantined", () => {
  const memory = new MemorySystem();
  const principle = makePrinciple(memory, "mem_long_quarantined", { quarantineUntil: FUTURE });
  makeSource(memory, "mem_medium_evidence", { metadata: { condensedInto: principle.id } });

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.quarantined, ["mem_medium_evidence"]);
  assert.equal(
    memory.items.has("mem_medium_evidence"),
    true,
    "evidence for an unvalidated principle must survive quarantine"
  );
});

test("releases sources back to the candidate pool when the principle vanished", () => {
  const memory = new MemorySystem();
  makeSource(memory, "mem_medium_orphan", { metadata: { condensedInto: "mem_long_gone" } });

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.deepEqual(result.released, ["mem_medium_orphan"]);
  assert.deepEqual(result.reaped, []);
  const orphan = memory.items.get("mem_medium_orphan");
  assert.equal(orphan.metadata.condensedInto, undefined, "tag cleared so it can be re-condensed");
  assert.equal(memory.items.has("mem_medium_orphan"), true, "orphan is released, never deleted");
});

test("releases sources whose principle was superseded rather than deleting them", () => {
  const memory = new MemorySystem();
  const principle = makePrinciple(memory, "mem_long_dead", { supersededBy: "mem_long_newer" });
  makeSource(memory, "mem_medium_stranded", { metadata: { condensedInto: principle.id } });

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.deepEqual(result.released, ["mem_medium_stranded"]);
  assert.equal(memory.items.has("mem_medium_stranded"), true);
  assert.equal(memory.items.get("mem_medium_stranded").metadata.condensedInto, undefined);
});

test("never reaps a locked source", () => {
  const memory = new MemorySystem();
  const principle = makePrinciple(memory, "mem_long_ok");
  makeSource(memory, "mem_medium_locked", {
    locked: true,
    metadata: { condensedInto: principle.id }
  });

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.deepEqual(result.reaped, []);
  assert.equal(memory.items.has("mem_medium_locked"), true);
});

test("dryRun reports what would be reaped without mutating the store", () => {
  const memory = new MemorySystem();
  const principle = makePrinciple(memory, "mem_long_ok");
  makeSource(memory, "mem_medium_a", { metadata: { condensedInto: principle.id } });
  makeSource(memory, "mem_medium_orphan", { metadata: { condensedInto: "mem_long_gone" } });

  const result = memory.reapCondensedSources({ now: NOW_MS, dryRun: true });

  assert.deepEqual(result.reaped, ["mem_medium_a"]);
  assert.deepEqual(result.released, ["mem_medium_orphan"]);
  assert.equal(memory.items.has("mem_medium_a"), true, "dryRun must not delete");
  assert.equal(
    memory.items.get("mem_medium_orphan").metadata.condensedInto,
    "mem_long_gone",
    "dryRun must not clear tags"
  );
});

test("a saturated tier of condensed corpses actually drains", () => {
  // The live-store failure mode: medium tier pinned at its cap, every slot
  // held by an already-distilled source. Before the reaper this could never
  // recover.
  const memory = new MemorySystem({ limits: { short: 50, medium: 20, long: 50 } });
  const principle = makePrinciple(memory, "mem_long_committed");
  for (let i = 0; i < 20; i += 1) {
    makeSource(memory, `mem_medium_corpse_${i}`, { metadata: { condensedInto: principle.id } });
  }
  assert.equal(memory.byTier("medium").length, 20, "tier starts at cap");

  const result = memory.reapCondensedSources({ now: NOW_MS });

  assert.equal(result.reaped.length, 20);
  assert.equal(memory.byTier("medium").length, 0, "tier drained — capacity reclaimed");
});

test("enforceLimits evicts condensed corpses before live items", () => {
  const memory = new MemorySystem({ limits: { short: 50, medium: 3, long: 50 } });
  const principle = makePrinciple(memory, "mem_long_committed");
  // Corpse is STRONG, live items are weak — under the old strength-only sort
  // the corpse would survive and evict real knowledge.
  memory.remember(
    { content: "already distilled corpse", tags: ["deploy"] },
    {
      tier: "medium",
      now: NOW,
      id: "mem_medium_corpse",
      strength: 1,
      metadata: { condensedInto: principle.id }
    }
  );
  for (let i = 0; i < 3; i += 1) {
    memory.remember(
      { content: `live note ${i}`, tags: ["deploy"] },
      { tier: "medium", now: NOW, id: `mem_medium_live_${i}`, strength: 0.1 }
    );
  }

  assert.equal(
    memory.items.has("mem_medium_corpse"),
    false,
    "the strong corpse is evicted first, not the weak live notes"
  );
  for (let i = 0; i < 3; i += 1) {
    assert.equal(memory.items.has(`mem_medium_live_${i}`), true, `live note ${i} survived`);
  }
});

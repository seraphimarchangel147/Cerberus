// B3: purge poisoned fitter training data. Resolved outcomes from the
// 2026-06-07..2026-06-16 UTC window whose scrutinyDimensions lack the current
// keys are removed from the outcomes snapshot.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPoisonedOutcome, purgePoisonedOutcomes } from "../src/migrate.js";

const OLD_DIMS = { environment: 0.4, company: 0.5, evidence: 0.6, memory: 0.3, uncertainty: 0.2 };
const NEW_DIMS = { ...OLD_DIMS, risk: 0.35, novelty: 0.4, repetition: 0.35 };

function makeOutcome(id, { resolved = true, dims = OLD_DIMS, resolvedAt = "2026-06-10T12:00:00.000Z" } = {}) {
  return {
    id,
    kind: "agent-reply",
    resolved,
    qualityScore: resolved ? 0.7 : null,
    scrutinyDimensions: dims,
    at: "2026-06-10T11:00:00.000Z",
    resolvedAt: resolved ? resolvedAt : null,
    source: resolved ? "system-inferred" : null,
    metadata: {}
  };
}

function writeSnapshot(dataDir, outcomes) {
  const dir = path.join(dataDir, "outcomes");
  fs.mkdirSync(dir, { recursive: true });
  const snapshotPath = path.join(dir, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, updatedAt: "2026-07-01T00:00:00.000Z", outcomes }, null, 2));
  return snapshotPath;
}

const FIXTURE = [
  makeOutcome("poisoned-1"),
  makeOutcome("poisoned-2", { resolvedAt: "2026-06-07T00:00:00.000Z" }),
  makeOutcome("poisoned-3", { resolvedAt: "2026-06-16T23:59:59.000Z" }),
  makeOutcome("keep-new-dims", { dims: NEW_DIMS }),
  makeOutcome("keep-after-window", { resolvedAt: "2026-06-17T00:00:00.000Z" }),
  makeOutcome("keep-before-window", { resolvedAt: "2026-06-06T23:59:59.000Z" }),
  makeOutcome("keep-pending", { resolved: false }),
  makeOutcome("keep-null-dims", { dims: null })
];

test("isPoisonedOutcome matches only old-format resolved rows inside the window", () => {
  assert.equal(isPoisonedOutcome(FIXTURE[0]), true);
  assert.equal(isPoisonedOutcome(FIXTURE[1]), true);
  assert.equal(isPoisonedOutcome(FIXTURE[2]), true);
  for (const keeper of FIXTURE.slice(3)) assert.equal(isPoisonedOutcome(keeper), false, keeper.id);
});

test("dry run reports counts and changes nothing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-dry-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");
  const lines = [];

  const result = purgePoisonedOutcomes({ dataDir, dryRun: true, log: (m) => lines.push(m) });

  assert.equal(result.dryRun, true);
  assert.equal(result.total, 8);
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 5);
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), original, "snapshot untouched");
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "outcomes")), ["snapshot.json"], "no backup on dry run");
  assert.ok(lines.some((l) => l.includes("removed=3") && l.includes("kept=5")), lines.join("\n"));
  fs.rmSync(dataDir, { recursive: true });
});

test("real run backs up first, removes exactly the seeded old-format rows", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-real-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");

  const result = purgePoisonedOutcomes({ dataDir, dryRun: false, log: () => {} });

  assert.equal(result.removed, 3);
  assert.equal(result.kept, 5);
  assert.ok(result.backupPath, "backup path reported");
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), original, "backup is the byte-exact pre-purge snapshot");

  const after = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(
    after.outcomes.map((o) => o.id).sort(),
    ["keep-after-window", "keep-before-window", "keep-new-dims", "keep-null-dims", "keep-pending"]
  );
  assert.equal(after.version, 1);
  fs.rmSync(dataDir, { recursive: true });
});

test("OPENAGI_MIGRATE_DRY_RUN=1 defaults to dry run", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-env-"));
  const snapshotPath = writeSnapshot(dataDir, FIXTURE);
  const original = fs.readFileSync(snapshotPath, "utf8");
  process.env.OPENAGI_MIGRATE_DRY_RUN = "1";
  try {
    const result = purgePoisonedOutcomes({ dataDir, log: () => {} });
    assert.equal(result.dryRun, true);
    assert.equal(fs.readFileSync(snapshotPath, "utf8"), original);
  } finally {
    delete process.env.OPENAGI_MIGRATE_DRY_RUN;
  }
  fs.rmSync(dataDir, { recursive: true });
});

test("missing snapshot is a safe no-op", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-purge-none-"));
  const result = purgePoisonedOutcomes({ dataDir, dryRun: false, log: () => {} });
  assert.equal(result.total, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.kept, 0);
  assert.equal(result.backupPath, null);
  fs.rmSync(dataDir, { recursive: true });
});

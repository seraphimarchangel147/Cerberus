import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { segmentSpill, SpillStore } from "../src/spill-store.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("SpillStore persists structured metadata and returns exact line slices", () => {
  const dir = tempDir("spill-");
  const store = new SpillStore({ dir, spillBytes: 64 });
  const content = [
    "# First",
    "alpha",
    "```md",
    "# Not a heading",
    "```",
    "## Second",
    "beta",
    "gamma",
    "delta"
  ].join("\n");
  const spill = store.put(content, { projectId: "alpha" });

  assert.equal(spill.spilled, true);
  assert.equal(spill.segments.length, 2);
  assert.equal(spill.segments[0].lines, "1-5");
  assert.equal(spill.segments[1].lines, "6-9");
  assert.equal(fs.readFileSync(path.join(dir, spill.id), "utf8"), content);
  assert.equal(store.read(spill.id, "6-8", { projectId: "alpha" }).content, [
    "## Second",
    "beta",
    "gamma"
  ].join("\n"));

  const restored = new SpillStore({ dir, spillBytes: 64 });
  assert.equal(restored.read(spill.id, "1-2", { projectId: "alpha" }).content, [
    "# First",
    "alpha"
  ].join("\n"));
  assert.throws(
    () => restored.read(spill.id, "1-2", { projectId: "beta" }),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION"
  );
});

test("segmentSpill applies diff, paragraph, then bounded fixed windows", () => {
  const diff = segmentSpill([
    "diff --git a/a b/a",
    "one",
    "diff --git a/b b/b",
    "two"
  ].join("\n"), "spill_0000000000000000");
  assert.deepEqual(diff.map((item) => item.lines), ["1-2", "3-4"]);

  const paragraphs = segmentSpill("one\n\nTwo\nlines", "spill_0000000000000000");
  assert.deepEqual(paragraphs.map((item) => item.lines), ["1-1", "3-4"]);

  const lines = Array.from({ length: 7_000 }, (_, index) => `line ${index + 1}`).join("\n");
  const fixed = segmentSpill(lines, "spill_0000000000000000");
  assert.ok(fixed.length <= 32);
  assert.equal(fixed[0].lines.split("-")[0], "1");
  assert.equal(fixed.at(-1).lines.split("-")[1], "7000");
});

test("SpillStore leaves below-threshold values inline", () => {
  const store = new SpillStore({ dir: tempDir("spill-small-"), spillBytes: 1024 });
  assert.equal(store.shouldSpill("small"), false);
  assert.equal(store.put("small"), null);
});

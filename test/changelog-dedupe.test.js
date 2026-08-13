import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendChangelog } from "../src/code-tools.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-changelog-"));
  fs.writeFileSync(path.join(root, "CHANGES.md"), "# Changelog\n", "utf8");
  return root;
}

test("appendChangelog appends once and refuses a same-day identical duplicate", () => {
  const root = makeRoot();
  const file = path.join(root, "src", "x.js");
  const first = appendChangelog("edit", file, "first append", root);
  assert.equal(first, true);
  const second = appendChangelog("edit", file, "first append", root);
  assert.equal(second, false, "identical same-day entry must be refused");
  const body = fs.readFileSync(path.join(root, "CHANGES.md"), "utf8");
  const occurrences = body.split("first append").length - 1;
  assert.equal(occurrences, 1, "entry appears exactly once");
});

test("appendChangelog allows same-day entries for different files and summaries", () => {
  const root = makeRoot();
  const a = path.join(root, "src", "a.js");
  const b = path.join(root, "src", "b.js");
  assert.equal(appendChangelog("edit", a, "change a", root), true);
  assert.equal(appendChangelog("edit", b, "change b", root), true, "different file must not be blocked");
  assert.equal(appendChangelog("edit", a, "change a v2", root), true, "different summary must not be blocked");
});

test("appendChangelog allows an empty-summary append alongside an existing dated entry", () => {
  const root = makeRoot();
  const file = path.join(root, "src", "x.js");
  assert.equal(appendChangelog("edit", file, "seed entry", root), true);
  assert.equal(appendChangelog("write", file, "", root), true, "distinct action with empty summary appends cleanly");
  const body = fs.readFileSync(path.join(root, "CHANGES.md"), "utf8");
  assert.ok(body.includes("seed entry"));
});

test("appendChangelog refuses paths outside the repo root", () => {
  const root = makeRoot();
  const outside = path.join(os.tmpdir(), "definitely-outside-openagi.js");
  assert.equal(appendChangelog("edit", outside, "nope", root), false);
});

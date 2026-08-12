import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootProvenance, formatBootProvenance, logBootProvenance } from "../src/boot-provenance.js";

/**
 * Boot provenance answers "which code is actually running?".
 *
 * Real incident (2026-08-11): a fix was pushed to origin/main and the daemon
 * restarted, but the daemon's checkout sat on a feature branch that did not
 * contain the commit. The restart deployed nothing while the report said the
 * fix was live. `ancestor_of_origin_main=no` makes that visible in one line.
 */

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
}

/** A throwaway repo with a real origin/main so ancestry is genuinely testable. */
function makeRepoPair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootprov-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, work]);
  for (const [k, v] of [["user.email", "t@t.t"], ["user.name", "t"]]) git(["config", k, v], work);

  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  git(["add", "."], work);
  git(["commit", "--quiet", "-m", "first"], work);
  git(["push", "--quiet", "origin", "main"], work);
  git(["fetch", "--quiet", "origin"], work);
  return { root, work };
}

test("reports sha, branch and a clean dirty count", () => {
  const { work } = makeRepoPair();
  const info = bootProvenance({ cwd: work });
  assert.equal(info.available, true);
  assert.match(info.sha, /^[0-9a-f]{7,}$/);
  assert.equal(info.branch, "main");
  assert.equal(info.dirty, 0);
});

test("counts dirty files", () => {
  const { work } = makeRepoPair();
  fs.writeFileSync(path.join(work, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(work, "b.txt"), "new\n");
  assert.equal(bootProvenance({ cwd: work }).dirty, 2);
});

test("HEAD containing origin/main reports ancestor_of_origin_main=yes", () => {
  const { work } = makeRepoPair();
  const info = bootProvenance({ cwd: work });
  assert.equal(info.ancestorOfOriginMain, true);
  assert.match(formatBootProvenance(info), /ancestor_of_origin_main=yes/);
});

test("THE REAL BUG: a branch missing origin/main's commits reports no", () => {
  const { work } = makeRepoPair();
  // main moves forward; the deployed checkout stays behind on a feature branch.
  git(["checkout", "--quiet", "-b", "feature"], work);
  git(["checkout", "--quiet", "main"], work);
  fs.writeFileSync(path.join(work, "c.txt"), "main only\n");
  git(["add", "."], work);
  git(["commit", "--quiet", "-m", "main moves on"], work);
  git(["push", "--quiet", "origin", "main"], work);
  git(["fetch", "--quiet", "origin"], work);
  git(["checkout", "--quiet", "feature"], work);

  const info = bootProvenance({ cwd: work });
  assert.equal(info.branch, "feature");
  assert.equal(
    info.ancestorOfOriginMain,
    false,
    "a checkout missing origin/main's commits must be flagged — this is the deploy-drift tell"
  );
  assert.match(formatBootProvenance(info), /ancestor_of_origin_main=no/);
});

test("a non-git directory degrades to unavailable, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notgit-"));
  const info = bootProvenance({ cwd: dir });
  assert.equal(info.available, false);
  assert.equal(info.sha, null);
  assert.match(formatBootProvenance(info), /provenance=unavailable/);
});

test("a repo with no origin/main reports unknown, not false", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noremote-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", root]);
  for (const [k, v] of [["user.email", "t@t.t"], ["user.name", "t"]]) git(["config", k, v], root);
  fs.writeFileSync(path.join(root, "a.txt"), "x\n");
  git(["add", "."], root);
  git(["commit", "--quiet", "-m", "only"], root);

  const info = bootProvenance({ cwd: root });
  assert.equal(info.available, true);
  assert.equal(info.ancestorOfOriginMain, null, "absent ref is unknown, not a failed ancestry check");
  assert.match(formatBootProvenance(info), /ancestor_of_origin_main=unknown/);
});

test("logBootProvenance emits one line and never throws", () => {
  const { work } = makeRepoPair();
  const lines = [];
  const out = logBootProvenance({ logger: (l) => lines.push(l), cwd: work });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], out);
  assert.match(out, /^\[boot\] sha=/);
});

test("a throwing logger does not propagate out of boot", () => {
  const { work } = makeRepoPair();
  assert.doesNotThrow(() => logBootProvenance({
    logger: () => { throw new Error("logger exploded"); },
    cwd: work
  }));
});

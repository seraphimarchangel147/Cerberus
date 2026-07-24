// Tier-1 hardening regression tests (2026-07):
//  * code-tools path gate is ENFORCED on read/search (was silently dropped)
//  * resolveSafe rejects symlink escapes out of allowed roots
//  * telegram webhook verification fails CLOSED with no configured secret
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafe, mustResolve } from "../src/code-tools.js";
import { verifyTelegramSecret } from "../src/auth.js";

test("mustResolve throws for paths outside allowed roots", () => {
  assert.throws(() => mustResolve("/etc/passwd"), /outside allowed roots/);
  assert.throws(() => mustResolve(path.join(os.homedir(), ".ssh", "id_rsa")), /outside allowed roots/);
});

test("mustResolve allows paths inside the operating system temp directory", () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const p = mustResolve(path.join(tempRoot, "openagi-hardening-test.txt"));
  assert.equal(path.dirname(p), tempRoot);
});

test("resolveSafe rejects a symlink inside an allowed root pointing outside", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-symlink-"));
  const allowed = path.join(dir, "allowed");
  const outside = path.join(dir, "outside");
  const link = path.join(allowed, "escape");
  try {
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "canary.txt"), "outside", "utf8");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const viaLink = resolveSafe(
      path.join(link, "canary.txt"),
      { roots: [allowed] }
    );
    assert.equal(viaLink.ok, false, "symlink escape must be rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSafe still allows creating new files under an allowed root", () => {
  const target = resolveSafe(path.join(
    os.tmpdir(),
    "oa-new-dir-not-yet-existing",
    "sub",
    "file.txt"
  ));
  assert.equal(target.ok, true);
});

test("telegram webhook fails closed when no secret is configured", () => {
  const r = verifyTelegramSecret({ headerValue: "anything", expected: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fail-closed/);
});

test("telegram webhook still verifies a configured secret", () => {
  assert.equal(verifyTelegramSecret({ headerValue: "s3cret", expected: "s3cret" }).ok, true);
  assert.equal(verifyTelegramSecret({ headerValue: "wrong", expected: "s3cret" }).ok, false);
});

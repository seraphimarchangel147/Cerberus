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

test("mustResolve allows paths inside /tmp", () => {
  const p = mustResolve("/tmp/openagi-hardening-test.txt");
  assert.ok(p.startsWith("/tmp/"));
});

test("resolveSafe rejects a symlink inside an allowed root pointing outside", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "oa-symlink-"));
  const link = path.join(dir, "escape");
  try {
    fs.symlinkSync("/etc", link);
    const viaLink = resolveSafe(path.join(link, "passwd"));
    assert.equal(viaLink.ok, false, "symlink escape must be rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSafe still allows creating new files under an allowed root", () => {
  const target = resolveSafe("/tmp/oa-new-dir-not-yet-existing/sub/file.txt");
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

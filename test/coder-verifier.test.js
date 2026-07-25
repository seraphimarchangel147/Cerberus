import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODE_VERIFIER_LIMITS,
  IsolatedCodeVerifier
} from "../src/coder-verifier.js";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coder-verify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("isolated verifier combines syntax and targeted test evidence", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "valid.js"), "export const value = 7;\n");
  fs.writeFileSync(path.join(root, "valid.test.js"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('value', () => assert.equal(7, 7));",
    ""
  ].join("\n"));
  const verifier = new IsolatedCodeVerifier();
  const result = await verifier.verify({
    workspaceDir: root,
    checks: [
      { type: "syntax", path: "valid.js" },
      { type: "test", path: "valid.test.js" }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(result.checksCompleted, 2);
  assert.deepEqual(result.results.map((entry) => entry.code), ["ok", "ok"]);
  assert.ok(result.results.every((entry) => entry.durationMs >= 0));
});

test("isolated verifier reports bounded deterministic failure evidence", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "broken.js"), "export const value = 1;\n");
  const verifier = new IsolatedCodeVerifier({
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit("data", "SyntaxError: Unexpected token verifier-secret");
        child.emit("close", 1, null);
      });
      return child;
    }
  });
  const result = await verifier.verify({
    workspaceDir: root,
    checks: [{ type: "syntax", path: "broken.js" }],
    redactValues: ["verifier-secret"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.results[0].code === "ok", false);
  assert.match(result.results[0].tail, /SyntaxError|Unexpected token/);
  assert.doesNotMatch(result.results[0].tail, /verifier-secret/);
  assert.match(result.results[0].tail, /\[REDACTED\]/);
  assert.ok(Buffer.byteLength(result.results[0].tail) <= CODE_VERIFIER_LIMITS.maxOutputBytes);
});

test("isolated verifier rejects traversal and symbolic-link targets", async (t) => {
  const root = workspace(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
  fs.writeFileSync(outside, "export default true;\n");
  t.after(() => fs.rmSync(outside, { force: true }));
  const verifier = new IsolatedCodeVerifier();

  await assert.rejects(
    verifier.verify({
      workspaceDir: root,
      checks: [{ type: "syntax", path: outside }]
    }),
    /outside the project workspace/
  );

  const link = path.join(root, "linked.js");
  try {
    fs.symlinkSync(outside, link);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  await assert.rejects(
    verifier.verify({
      workspaceDir: root,
      checks: [{ type: "syntax", path: "linked.js" }]
    }),
    /does not exist or is not a regular/
  );
});

test("isolated verifier honors a pre-aborted turn", async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, "valid.js"), "export default true;\n");
  const controller = new AbortController();
  controller.abort();
  const verifier = new IsolatedCodeVerifier();
  const result = await verifier.verify({
    workspaceDir: root,
    checks: [{ type: "syntax", path: "valid.js" }],
    signal: controller.signal
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "cancelled");
  assert.equal(result.checksCompleted, 0);
});

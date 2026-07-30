import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findDirectUnrefCalls,
  scanSourceForDirectUnrefCalls
} from "../scripts/unref-timer-guard.mjs";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src"
);

test("direct unref calls are detected while optional background unrefs stay explicit", () => {
  assert.deepEqual(
    findDirectUnrefCalls(
      "fixture.js",
      "const timer = setTimeout(done, 1000);\ntimer.unref();\n"
    ),
    [{ file: "fixture.js", line: 2, source: "timer.unref();" }]
  );
  assert.deepEqual(
    findDirectUnrefCalls(
      "fixture.js",
      "const timer = setTimeout(done, 1000);\ntimer.unref?.();\n"
    ),
    []
  );
});

test("src contains no direct unref calls that can silently end awaited work", () => {
  const allowlist = new Map([
    // Future legitimate direct unrefs must name the file and include a comment
    // explaining why no foreground caller can be awaiting the timer.
  ]);
  const findings = scanSourceForDirectUnrefCalls(SOURCE_ROOT)
    .filter((finding) => !allowlist.has(`${finding.file}:${finding.line}`));

  assert.deepEqual(findings, []);
});

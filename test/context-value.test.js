import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_VALUE_MAX_SAMPLE_CHARS,
  scoreContextSubstitutability
} from "../src/context-value.js";

test("substitutability signals move scores in the safe direction", () => {
  const dense = scoreContextSubstitutability({
    output: "The migration requires preserving every relationship between the "
      + "existing schema, its callers, and the rollback path. ".repeat(12)
  });
  const structured = scoreContextSubstitutability({
    output: JSON.stringify(Array.from({ length: 40 }, (_, index) => ({
      id: index,
      state: index % 2 === 0 ? "ready" : "waiting",
      owner: `worker-${index % 4}`
    })))
  });
  const repeated = scoreContextSubstitutability({
    output: "progress: 42 percent\n".repeat(200)
  });
  const refBacked = scoreContextSubstitutability({
    output: "The complete tool output is available by reference.",
    ref: "out_0123456789abcdef"
  });
  const tiny = scoreContextSubstitutability({ output: "ok" });
  const error = scoreContextSubstitutability({
    output: [
      "Traceback (most recent call last):",
      "  File \"worker.py\", line 12, in run",
      "TypeError: expected a string"
    ].join("\n")
  });

  assert.ok(structured.score > dense.score);
  assert.ok(repeated.score > dense.score);
  assert.ok(refBacked.score > dense.score);
  assert.ok(refBacked.score >= 8);
  assert.ok(tiny.score <= 2);
  assert.ok(error.score <= 2);
  assert.equal(error.reason, "error-bearing");
});

test("the scorer understands Anthropic tool results and inline durable refs", () => {
  const result = scoreContextSubstitutability({
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "use-1",
      content: `condensed preview\nFull output: out_fedcba9876543210\n${"row,value\n".repeat(80)}`
    }]
  });

  assert.ok(result.score >= 8);
  assert.equal(result.reason, "ref-backed");
});

test("the scorer is total, bounded, and deterministic for hostile or huge input", () => {
  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "output", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("must not execute");
    }
  });
  const throwingProxy = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error("hostile proxy");
    }
  });
  const huge = {
    output: `${"header,value\n".repeat(500_000)}tail`
  };

  assert.deepEqual(scoreContextSubstitutability(null), {
    score: 0,
    reason: "invalid"
  });
  assert.deepEqual(scoreContextSubstitutability(hostile), {
    score: 0,
    reason: "invalid"
  });
  assert.deepEqual(scoreContextSubstitutability(throwingProxy), {
    score: 0,
    reason: "invalid"
  });
  assert.deepEqual(scoreContextSubstitutability(Buffer.from("binary")), {
    score: 0,
    reason: "binary"
  });
  assert.equal(getterReads, 0);
  assert.ok(CONTEXT_VALUE_MAX_SAMPLE_CHARS <= 16_384);

  const first = scoreContextSubstitutability(huge);
  const second = scoreContextSubstitutability(huge);
  assert.deepEqual(first, second);
  assert.ok(first.score >= 5);
});

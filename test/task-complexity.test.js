import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTaskComplexity,
  escalateTier,
  HUGE_CONTEXT_BYTES,
  measureTaskComplexity,
  MEDIUM_CONTEXT_BYTES
} from "../src/task-complexity.js";

test("roughly 50k tokens impose a base-tier hard floor", () => {
  const input = `${"plain ".repeat(50_000)}done`;
  assert.equal(
    classifyTaskComplexity({ input, tools: [] }),
    "base",
    "a huge transcript must never fall through the capped additive score to nano"
  );
});

test("context floors bypass the capped additive context score", () => {
  assert.equal(
    classifyTaskComplexity({ bytes: HUGE_CONTEXT_BYTES, input: "plain" }),
    "base"
  );
  assert.equal(
    classifyTaskComplexity({ bytes: MEDIUM_CONTEXT_BYTES, input: "plain" }),
    "mini"
  );
  const justBelow = classifyTaskComplexity({
    bytes: MEDIUM_CONTEXT_BYTES - 1,
    input: "plain"
  });
  assert.equal(justBelow, "nano");
});

test("any advertised tool imposes at least a mini floor", () => {
  assert.equal(
    classifyTaskComplexity({
      input: "hello",
      tools: [{ name: "read_file" }]
    }),
    "mini"
  );
  assert.equal(
    classifyTaskComplexity({ input: "hello", tools: [] }),
    "nano"
  );
  assert.equal(
    classifyTaskComplexity({
      input: "hello",
      tools: [],
      requestShape: { visibleToolCount: 1 }
    }),
    "mini"
  );
});

test("independent detector scores are bounded and additive", () => {
  const measured = measureTaskComplexity({
    input: [
      "```js",
      "async function designArchitecture(value) { return value * 2; }",
      "```",
      "diff --git a/a.js b/a.js",
      "Explain why the transaction serialization algorithm has trade-offs.",
      "Compare latency and throughput when x = 42 / 7."
    ].join("\n"),
    tools: Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`
    }))
  });
  assert.ok(measured.score >= 50);
  assert.ok(measured.score <= 100);
  assert.equal(measured.scores.code, 20);
  assert.equal(measured.scores.tools, 20);
  for (const score of Object.values(measured.scores)) {
    assert.ok(score >= 0);
    assert.ok(score <= 20);
  }
});

test("tier escalation is monotone", () => {
  const tiers = ["nano", "mini", "base"];
  const rank = new Map(tiers.map((tier, index) => [tier, index]));
  for (const current of tiers) {
    for (const floor of tiers) {
      const resolved = escalateTier(current, floor);
      assert.ok(rank.get(resolved) >= rank.get(current));
      assert.ok(rank.get(resolved) >= rank.get(floor));
    }
  }
  assert.equal(escalateTier("base", "nano"), "base");
  assert.equal(escalateTier("unknown", "nano"), "base");
});

test("classifier fails open on an unserializable request", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(classifyTaskComplexity({ input: circular }), null);
});

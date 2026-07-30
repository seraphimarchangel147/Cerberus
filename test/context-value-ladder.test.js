import assert from "node:assert/strict";
import test from "node:test";

import {
  compressLiveContext,
  contextQuickRecountDecision,
  contextValueCompressionStage
} from "../src/memory-condenser.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

test("the graded ladder fires inclusively at each configured threshold", () => {
  const stage = (inputTokens) => contextValueCompressionStage({
    inputTokens,
    contextWindowTokens: 1_000
  });

  assert.equal(stage(499).stage, null);
  assert.equal(stage(500).stage, "mild");
  assert.equal(stage(849).stage, "mild");
  assert.equal(stage(850).stage, "aggressive");
  assert.equal(stage(949).stage, "aggressive");
  assert.equal(stage(950).stage, "emergency");
  assert.equal(stage(950).targetTokens, 600);
  assert.equal(stage(999).targetTokens, 600);
});

test("emergency compaction returns to its target instead of its trigger", async () => {
  const conversation = [
    { role: "user", content: "complete the current task" }
  ];
  for (let index = 0; index < 8; index += 1) {
    conversation.push(
      {
        type: "function_call",
        call_id: `old-${index}`,
        name: "poll",
        arguments: JSON.stringify({ index })
      },
      {
        type: "function_call_output",
        call_id: `old-${index}`,
        output: `progress-${index}\n`.repeat(220)
      }
    );
  }
  conversation.push(
    { type: "function_call", call_id: "recent", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "recent", output: "recent" }
  );
  const beforeChars = JSON.stringify(conversation).length;
  const targetChars = Math.floor(beforeChars * 0.6);

  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 320,
    valueAwareCompaction: true,
    valueAwareStage: "emergency",
    valueAwareTargetChars: targetChars
  });

  assert.equal(result.compressed, true);
  assert.equal(result.cascade.stage, "emergency");
  assert.equal(result.cascade.floorScore, 1);
  assert.ok(result.preview.afterChars <= targetChars);
  assert.ok(result.preview.afterChars < beforeChars * 0.95);
});

test("quick skips force a precise recount on the fifth consecutive skip", () => {
  let consecutiveSkips = 0;
  const decisions = [];
  for (let index = 0; index < 5; index += 1) {
    const decision = contextQuickRecountDecision({
      quickInputTokens: 400,
      mildThresholdTokens: 500,
      consecutiveSkips,
      maxConsecutiveSkips: 5
    });
    decisions.push(decision);
    consecutiveSkips = decision.nextConsecutiveSkips;
  }

  assert.deepEqual(
    decisions.map((decision) => decision.skipPreciseCount),
    [true, true, true, true, false]
  );
  assert.equal(decisions.at(-1).reason, "forced-recount");
  assert.equal(decisions.at(-1).nextConsecutiveSkips, 0);
  assert.equal(contextQuickRecountDecision({
    quickInputTokens: 500,
    mildThresholdTokens: 500,
    consecutiveSkips: 1,
    maxConsecutiveSkips: 5
  }).skipPreciseCount, false);
});

test("a throwing precise counter falls back to the legacy full recount", async () => {
  let preciseCalls = 0;
  let body = null;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_VALUE_AWARE_COMPACTION: "1" },
    contextWindowTokens: 1_000,
    contextKeepRecentHops: 1,
    contextEstimateCharsPerToken: 4,
    contextPreciseTokenCounter: () => {
      preciseCalls += 1;
      throw new Error("fixture precise counter failed");
    }
  });
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return { id: "done", output_text: "done", output: [] };
  };
  const messages = [];
  for (let index = 0; index < 24; index += 1) {
    messages.push(
      { role: "user", content: `request-${index}-${"x".repeat(180)}` },
      { role: "assistant", content: `answer-${index}-${"y".repeat(180)}` }
    );
  }

  await provider.generate({
    input: "current",
    instructions: "static",
    messages
  });

  assert.ok(preciseCalls >= 1);
  assert.ok(JSON.stringify(body).includes("[context summary]"));
});

test("ladder defaults and env overrides are explicit and allowlisted", () => {
  const defaults = new OpenAIResponsesProvider({ apiKey: "test", env: {} });
  const configured = new OpenAIResponsesProvider({
    apiKey: "test",
    env: {
      OPENAGI_CONTEXT_MILD_RATIO: "0.4",
      OPENAGI_CONTEXT_AGGRESSIVE_RATIO: "0.7",
      OPENAGI_CONTEXT_EMERGENCY_RATIO: "0.9",
      OPENAGI_CONTEXT_EMERGENCY_TARGET_RATIO: "0.55",
      OPENAGI_CONTEXT_QUICK_RECOUNT_SKIPS: "7"
    }
  });

  assert.deepEqual([
    defaults.contextMildRatio,
    defaults.contextAggressiveRatio,
    defaults.contextEmergencyRatio,
    defaults.contextEmergencyTargetRatio,
    defaults.contextQuickRecountSkips
  ], [0.5, 0.85, 0.95, 0.6, 5]);
  assert.deepEqual([
    configured.contextMildRatio,
    configured.contextAggressiveRatio,
    configured.contextEmergencyRatio,
    configured.contextEmergencyTargetRatio,
    configured.contextQuickRecountSkips
  ], [0.4, 0.7, 0.9, 0.55, 7]);

  for (const name of [
    "OPENAGI_CONTEXT_MILD_RATIO",
    "OPENAGI_CONTEXT_AGGRESSIVE_RATIO",
    "OPENAGI_CONTEXT_EMERGENCY_RATIO",
    "OPENAGI_CONTEXT_EMERGENCY_TARGET_RATIO",
    "OPENAGI_CONTEXT_QUICK_RECOUNT_SKIPS"
  ]) {
    assert.ok(SETUP_FIELDS.includes(name), `${name} must be wizard allowlisted`);
  }
});

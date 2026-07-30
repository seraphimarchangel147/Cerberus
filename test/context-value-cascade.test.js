import assert from "node:assert/strict";
import test from "node:test";

import {
  compressLiveContext,
  restoreContextLedger
} from "../src/memory-condenser.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function cascadeConversation() {
  return [
    { role: "user", content: "finish the active migration" },
    { type: "function_call", call_id: "error", name: "run_tests", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "error",
      output: "Traceback (most recent call last):\nTypeError: migration state is invalid"
    },
    { type: "function_call", call_id: "repeat", name: "poll_progress", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "repeat",
      output: "progress: waiting for worker\n".repeat(180)
    },
    { type: "function_call", call_id: "structured", name: "list_rows", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "structured",
      output: JSON.stringify(Array.from({ length: 80 }, (_, index) => ({
        id: index,
        state: index % 2 ? "waiting" : "ready"
      })))
    },
    { type: "function_call", call_id: "recent", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "recent", output: "current result" }
  ];
}

function assertNoOrphanedOpenAITools(conversation) {
  const calls = new Map();
  const results = new Map();
  for (const item of conversation) {
    if (item?.type === "function_call") {
      calls.set(item.call_id, (calls.get(item.call_id) ?? 0) + 1);
    }
    if (item?.type === "function_call_output") {
      results.set(item.call_id, (results.get(item.call_id) ?? 0) + 1);
    }
  }
  assert.deepEqual([...calls.entries()], [...results.entries()]);
}

test("value-aware compaction sheds the highest substitutability pair first", async () => {
  const conversation = cascadeConversation();
  const beforeChars = JSON.stringify(conversation).length;
  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 400,
    valueAwareCompaction: true,
    valueAwareTargetChars: beforeChars - 2_000
  });

  assert.equal(result.compressed, true);
  assert.equal(result.valueAware, true);
  assert.deepEqual(result.cascade.selectedScores, [9]);
  assert.equal(result.cascade.targetChars, beforeChars - 2_000);
  assert.ok(result.preview.afterChars <= result.cascade.targetChars);

  const retainedIds = result.conversation
    .filter((item) => item?.type === "function_call")
    .map((item) => item.call_id);
  assert.deepEqual(retainedIds, ["error", "structured", "recent"]);
  assert.match(result.conversation[2].output, /Traceback/);
  assertNoOrphanedOpenAITools(result.conversation);
  assert.deepEqual(restoreContextLedger(result), conversation);

  const repeated = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 400,
    valueAwareCompaction: true,
    valueAwareTargetChars: beforeChars - 2_000
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(repeated)),
    JSON.parse(JSON.stringify(result)),
    "cascade ordering and output must be deterministic"
  );
});

test("the value-aware flag defaults off and preserves legacy bytes", async () => {
  const conversation = cascadeConversation();
  const options = {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 400
  };
  const legacy = await compressLiveContext(conversation, options);
  const explicitlyOff = await compressLiveContext(conversation, {
    ...options,
    valueAwareCompaction: false,
    valueAwareTargetChars: 1
  });

  assert.equal(
    JSON.stringify(explicitlyOff),
    JSON.stringify(legacy),
    "flag-off public output must remain byte-identical"
  );
  assert.equal(explicitlyOff.valueAware, undefined);
});

test("the value-aware flag is provider-wired and setup allowlisted", () => {
  assert.equal(new OpenAIResponsesProvider({
    apiKey: "test",
    env: {}
  }).valueAwareCompaction, false);
  assert.equal(new OpenAIResponsesProvider({
    apiKey: "test",
    env: { OPENAGI_VALUE_AWARE_COMPACTION: "1" }
  }).valueAwareCompaction, true);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_VALUE_AWARE_COMPACTION"));
});

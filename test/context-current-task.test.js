import assert from "node:assert/strict";
import test from "node:test";

import { compressLiveContext } from "../src/memory-condenser.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { toolFailureFingerprint } from "../src/tool-outcome.js";
import {
  bindTurnProgressCounter,
  readTurnProgressOutputs
} from "../src/turn-progress.js";

function registerPollingTool(registry) {
  let revision = 0;
  registry.register({
    name: "poll_current_task",
    description: "Return changing progress for the active task.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" }
      },
      required: ["target"],
      additionalProperties: false
    },
    sideEffects: false,
    capability: { idempotent: true },
    handler: () => ({
      revision: ++revision,
      output: "progress: active\n".repeat(160)
    })
  });
}

async function progressIdentity() {
  const registry = new ToolRegistry();
  registerPollingTool(registry);
  const context = {
    sessionId: "session-current-task",
    __turnId: "turn-current-task",
    __providerToolCallId: "active-one"
  };
  bindTurnProgressCounter(context);
  await registry.invoke("poll_current_task", { target: "migration" }, context);
  context.__providerToolCallId = "active-two";
  const second = await registry.invoke(
    "poll_current_task",
    { target: "migration" },
    context
  );
  return {
    records: readTurnProgressOutputs(context),
    expectedSignature: toolFailureFingerprint("tool_output", second.result)
  };
}

function conversation() {
  return [
    { role: "user", content: "continue the active migration" },
    { type: "function_call", call_id: "active-two", name: "poll_current_task", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "active-two",
      output: "progress: active\n".repeat(160)
    },
    { type: "function_call", call_id: "other", name: "poll_other", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "other",
      output: "progress: unrelated\n".repeat(160)
    },
    { type: "function_call", call_id: "recent", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "recent", output: "recent result" }
  ];
}

test("turn progress retains the exact bounded output signature and provider call id", async () => {
  const { records, expectedSignature } = await progressIdentity();

  assert.equal(records.length, 2);
  assert.deepEqual(records.at(-1), {
    callId: "active-two",
    outputSignature: expectedSignature,
    progressed: true
  });
  assert.match(expectedSignature, /^[a-f0-9]{64}$/);
});

test("mild compaction protects signature-backed current-task lineage", async () => {
  const { records } = await progressIdentity();
  const currentTaskCallIds = records.map((record) => record.callId);
  const currentTaskOutputSignatures = records.map(
    (record) => record.outputSignature
  );
  const input = conversation();
  const targetChars = JSON.stringify(input).length - 2_000;
  const common = {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 320,
    valueAwareCompaction: true,
    valueAwareTargetChars: targetChars,
    currentTaskCallIds,
    currentTaskOutputSignatures
  };

  const mild = await compressLiveContext(input, {
    ...common,
    valueAwareStage: "mild"
  });
  const emergency = await compressLiveContext(input, {
    ...common,
    valueAwareStage: "emergency"
  });

  assert.equal(mild.compressed, true);
  assert.equal(mild.cascade.stage, "mild");
  assert.deepEqual(mild.cascade.protectedCurrentTaskIndexes, [1, 2]);
  assert.ok(mild.conversation.some((item) => item?.call_id === "active-two"));
  assert.ok(!mild.conversation.some((item) => item?.call_id === "other"));

  assert.equal(emergency.compressed, true);
  assert.equal(emergency.cascade.stage, "emergency");
  assert.deepEqual(emergency.cascade.protectedCurrentTaskIndexes, []);
  assert.ok(!emergency.conversation.some((item) => item?.call_id === "active-two"));
  assert.ok(emergency.conversation.some((item) => item?.call_id === "other"));

  const repeated = await compressLiveContext(input, {
    ...common,
    valueAwareStage: "mild"
  });
  assert.equal(JSON.stringify(repeated), JSON.stringify(mild));
});

import test from "node:test";
import assert from "node:assert/strict";
import { MemorySystem } from "../src/memory-system.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function toolsFor(memory, externalMemoryProvider = null) {
  const tools = new ToolRegistry();
  registerCoreTools(tools, { memory, externalMemoryProvider });
  return tools;
}

const TOOL_CONTEXT = {
  channel: "discord",
  from: "User:42/slash",
  agentId: "main",
  sessionId: "session-7",
  __memoryScope: "main"
};

test("built-in memory remains authoritative when the external provider is off", async () => {
  const memory = new MemorySystem();
  const tools = toolsFor(memory);

  const remembered = await tools.invoke(
    "remember",
    { content: "The deployment window starts at 4pm.", tags: ["deploy"] },
    TOOL_CONTEXT
  );
  assert.equal(remembered.ok, true);
  assert.equal(Object.hasOwn(remembered.result, "externalMemory"), false);

  const recalled = await tools.invoke("recall", { query: "deployment window" }, TOOL_CONTEXT);
  assert.equal(recalled.ok, true);
  assert.equal(Object.hasOwn(recalled.result, "externalUserModel"), false);
  assert.equal(Object.hasOwn(recalled.result, "externalMemory"), false);
  assert.ok(recalled.result.items.some((item) => item.id === remembered.result.id));

  assert.match(tools.get("remember").description, /external user model/i);
  assert.match(tools.get("recall").description, /local items are always returned/i);
  assert.match(tools.get("correct_memory").description, /mirrored to the external user model/i);
});

test("remember and correction commit locally before mirroring with stable identity", async () => {
  const memory = new MemorySystem();
  const writes = [];
  const queries = [];
  const provider = {
    provider: "mock-honcho",
    timeoutMs: 100,
    async setUserModel(request) {
      const local = memory.items.get(request.metadata.localMemoryId);
      assert.ok(local, "external write starts only after the local item commits");
      assert.equal(local.content, request.content);
      writes.push(request);
      return { provider: "mock-honcho", model: "updated" };
    },
    async queryUserModel(request) {
      queries.push(request);
      return {
        provider: "mock-honcho",
        answer: "The user prefers cautious, reversible deployments."
      };
    }
  };
  const tools = toolsFor(memory, provider);

  const remembered = await tools.invoke(
    "remember",
    { content: "The deployment window starts at 4pm.", tags: ["deploy"] },
    TOOL_CONTEXT
  );
  assert.equal(remembered.ok, true);
  assert.equal(remembered.result.externalMemory.status, "ok");
  assert.equal(writes[0].metadata.action, "remember");
  assert.equal(writes[0].content, remembered.result.content);
  assert.deepEqual({
    userId: writes[0].userId,
    observerId: writes[0].observerId
  }, {
    userId: "discord:User:42/slash",
    observerId: "main"
  });

  const recalled = await tools.invoke("recall", { query: "safe deployment style" }, TOOL_CONTEXT);
  assert.equal(recalled.ok, true);
  assert.ok(recalled.result.items.some((item) => item.id === remembered.result.id));
  assert.equal(
    recalled.result.externalUserModel,
    "The user prefers cautious, reversible deployments."
  );
  assert.equal(recalled.result.externalMemory.status, "ok");
  assert.equal(queries.length, 1);
  const { signal, ...queryRequest } = queries[0];
  assert.equal(signal.aborted, false);
  assert.deepEqual(queryRequest, {
    query: "safe deployment style",
    userId: "discord:User:42/slash",
    observerId: "main"
  });

  const corrected = await tools.invoke("correct_memory", {
    id: remembered.result.id,
    correction: "The deployment window starts at 5pm.",
    tags: ["deploy"]
  }, TOOL_CONTEXT);
  assert.equal(corrected.ok, true);
  assert.equal(corrected.result.externalMemory.status, "ok");
  assert.equal(writes[1].metadata.action, "correct");
  assert.equal(writes[1].content, "The deployment window starts at 5pm.");
  assert.deepEqual(writes[1].metadata.supersededIds, [remembered.result.id]);
  assert.equal(memory.items.get(corrected.result.id).content, writes[1].content);
});

test("external rejection is sanitized and cannot undo a successful local write", async () => {
  const memory = new MemorySystem();
  const leakedToken = "sk-123456789012345678901234567890";
  const tools = toolsFor(memory, {
    provider: "mock-honcho",
    timeoutMs: 100,
    async setUserModel() {
      throw new Error(`Authorization: Bearer ${leakedToken}`);
    }
  });

  const outcome = await tools.invoke(
    "remember",
    { content: "Keep the local fact even when sync fails." },
    TOOL_CONTEXT
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.externalMemory.status, "error");
  assert.equal(
    outcome.result.externalMemory.error,
    "External memory provider request failed."
  );
  assert.doesNotMatch(JSON.stringify(outcome.result), new RegExp(leakedToken));
  assert.equal(memory.items.get(outcome.result.id).content, outcome.result.content);
});

test("external query timeout still returns local recall results", async () => {
  const memory = new MemorySystem();
  const local = memory.remember(
    { content: "Rollback plans live in the operations handbook.", scope: "main" },
    { tier: "medium", capacityManaged: true }
  );
  const tools = toolsFor(memory, {
    provider: "slow-memory",
    timeoutMs: 5,
    queryUserModel: () => new Promise(() => {})
  });

  const recalled = await tools.invoke("recall", { query: "rollback plans" }, TOOL_CONTEXT);
  assert.equal(recalled.ok, true);
  assert.ok(recalled.result.items.some((item) => item.id === local.id));
  assert.equal(recalled.result.externalUserModel, null);
  assert.equal(recalled.result.externalMemory.status, "timeout");
  assert.match(recalled.result.externalMemory.error, /timed out/i);
});

test("turn cancellation aborts external recall without dropping local results", async () => {
  const memory = new MemorySystem();
  const local = memory.remember(
    { content: "Incident notes stay available locally.", scope: "main" },
    { tier: "medium", capacityManaged: true }
  );
  let providerSignal;
  const tools = toolsFor(memory, {
    provider: "abort-aware-memory",
    timeoutMs: 1000,
    queryUserModel: ({ signal }) => {
      providerSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });
  const controller = new AbortController();
  const pending = tools.invoke(
    "recall",
    { query: "incident notes" },
    { ...TOOL_CONTEXT, __abortSignal: controller.signal }
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("turn stopped"));
  const recalled = await pending;

  assert.equal(recalled.ok, true);
  assert.ok(recalled.result.items.some((item) => item.id === local.id));
  assert.equal(recalled.result.externalUserModel, null);
  assert.equal(recalled.result.externalMemory.status, "cancelled");
  assert.equal(providerSignal.aborted, true);
});

test("a rejected local write never reaches external memory", async () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 5 });
  let externalCalls = 0;
  const tools = toolsFor(memory, {
    provider: "mock-honcho",
    async setUserModel() {
      externalCalls += 1;
    }
  });

  const outcome = await tools.invoke(
    "remember",
    { content: "This cannot fit." },
    TOOL_CONTEXT
  );
  assert.equal(outcome.ok, false);
  assert.equal(externalCalls, 0);
  assert.equal(memory.curatedItems().length, 0);
});

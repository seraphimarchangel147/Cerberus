import test from "node:test";
import assert from "node:assert/strict";
import { MemorySystem, profileMemoryScope } from "../src/memory-system.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function harness() {
  const memory = new MemorySystem();
  const tools = new ToolRegistry();
  registerCoreTools(tools, { memory });
  return { memory, tools };
}

function context(overrides = {}) {
  return {
    channel: "local",
    from: "alice",
    agentId: "main",
    sessionId: "session-alice",
    __memoryScope: "project:alpha",
    __profileMemoryScope: profileMemoryScope({ channel: "local", from: "alice", sessionId: "session-alice" }),
    ...overrides
  };
}

test("memory_details exposes bounded provenance without reinforcing the item", async () => {
  const { memory, tools } = harness();
  const saved = await tools.invoke("remember", {
    content: "Prefer staged rollouts with a visible rollback plan.",
    memoryClass: "preference",
    tags: ["deployment"]
  }, context());
  assert.equal(saved.ok, true);
  const before = structuredClone(memory.items.get(saved.result.id));

  const inspected = await tools.invoke("memory_details", { id: saved.result.id }, context());
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.found, true);
  assert.equal(inspected.result.memoryClass, "preference");
  assert.equal(inspected.result.status, "active");
  assert.equal(inspected.result.provenance.sourceType, "explicit-memory-tool");
  assert.equal(inspected.result.provenance.trust, "direct-tool-request");
  assert.equal(inspected.result.provenance.humanApproved, false);
  assert.deepEqual(memory.items.get(saved.result.id), before, "inspection must not reinforce or mutate memory");
});

test("memory_details respects project and profile scope boundaries", async () => {
  const { tools } = harness();
  const alice = context();
  const bob = context({
    from: "bob",
    sessionId: "session-bob",
    __profileMemoryScope: profileMemoryScope({ channel: "local", from: "bob", sessionId: "session-bob" })
  });
  const preference = await tools.invoke("remember", {
    content: "Alice avoids late-day meetings.",
    memoryClass: "preference"
  }, alice);
  assert.equal(preference.ok, true);

  const hidden = await tools.invoke("memory_details", { id: preference.result.id }, bob);
  assert.equal(hidden.ok, true);
  assert.deepEqual(hidden.result, { found: false, id: preference.result.id });
});

test("memory_details makes correction and replacement lineage visible without raw metadata", async () => {
  const { tools } = harness();
  const saved = await tools.invoke("remember", {
    content: "The deployment window starts at 4pm."
  }, context());
  assert.equal(saved.ok, true);
  const corrected = await tools.invoke("correct_memory", {
    id: saved.result.id,
    correction: "The deployment window starts at 5pm."
  }, context());
  assert.equal(corrected.ok, true);

  const oldDetails = await tools.invoke("memory_details", { id: saved.result.id }, context());
  assert.equal(oldDetails.result.status, "superseded");
  assert.equal(oldDetails.result.relationships.supersededBy, corrected.result.id);

  const currentDetails = await tools.invoke("memory_details", { id: corrected.result.id }, context());
  assert.equal(currentDetails.result.status, "active");
  assert.deepEqual(currentDetails.result.relationships.corrects, [saved.result.id]);
  assert.equal(Object.hasOwn(currentDetails.result, "metadata"), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBackedAgentStore, InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { applyBackgroundReviewProposal } from "../src/background-review.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { MemoryCapacityError, MemorySystem } from "../src/memory-system.js";
import { AnthropicProvider, OpenAIResponsesProvider } from "../src/model-provider.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function curated(memory, content, options = {}) {
  return memory.remember(
    { source: "test", scope: options.scope ?? "main", content },
    {
      tier: options.tier ?? "medium",
      id: options.id,
      now: options.now,
      capacityManaged: true,
      replaceIds: options.replaceIds ?? []
    }
  );
}

test("curated memory accepts the exact cap and rejects cap plus one without mutation", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 20 });
  const exact = curated(memory, "x".repeat(9), { id: "exact" });
  assert.equal(exact.content, "x".repeat(9), "capacity-managed content is never truncated");
  const before = structuredClone([...memory.items]);

  assert.throws(
    () => curated(memory, "x".repeat(10), { id: "exact" }),
    (error) => {
      assert.ok(error instanceof MemoryCapacityError);
      assert.equal(error.code, "MEMORY_CAPACITY_EXCEEDED");
      assert.equal(error.usedChars, 20);
      assert.equal(error.requestedChars, 21, "the replacement bullet is charged");
      assert.equal(error.reclaimedChars, 20);
      assert.equal(error.projectedChars, 21);
      assert.equal(error.maxChars, 20);
      assert.match(error.message, /Nothing was saved/);
      assert.match(error.message, /recall.*replaceIds/i);
      return true;
    }
  );

  assert.deepEqual([...memory.items], before);
  assert.equal(memory.items.has("overflow"), false);
  assert.equal(memory.renderSessionMemorySnapshot().split("\n")[0], "[100% \u2014 20/20 chars]");
});

test("a rejected file-backed write leaves JSONL and the atomic snapshot byte-identical", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-memory-cap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new FileBackedMemorySystem({ dir, curatedMemoryMaxChars: 19 });
  curated(memory, "12345678", { id: "persisted" });
  const eventPath = path.join(dir, "memory-events.jsonl");
  const snapshotPath = path.join(dir, "memory-state.json");
  const beforeEvents = fs.readFileSync(eventPath);
  const beforeSnapshot = fs.readFileSync(snapshotPath);

  assert.throws(() => curated(memory, "9", { id: "rejected" }), MemoryCapacityError);
  assert.deepEqual(fs.readFileSync(eventPath), beforeEvents);
  assert.deepEqual(fs.readFileSync(snapshotPath), beforeSnapshot);
  assert.equal(memory.items.has("rejected"), false);
});

test("usage header is deterministic and atomic replacement creates room", async () => {
  const headerMemory = new MemorySystem({ curatedMemoryMaxChars: 2200 });
  curated(headerMemory, "h".repeat(1463), { id: "header" });
  assert.equal(
    headerMemory.renderSessionMemorySnapshot().split("\n")[0],
    "[67% \u2014 1,474/2,200 chars]"
  );

  const memory = new MemorySystem({ curatedMemoryMaxChars: 33 });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { memory });
  const context = { agentId: "main", sessionId: "capacity-session", __memoryScope: "main" };
  const first = await registry.invoke("remember", { content: "12345" }, context);
  const second = await registry.invoke("remember", { content: "67890" }, context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  memory.remember(
    { content: "raw legacy unique", scope: "main" },
    { id: "raw-legacy", tier: "medium" }
  );
  const rawRecall = await registry.invoke("recall", { query: "raw legacy unique" }, context);
  const rawResult = rawRecall.result.items.find((item) => item.id === "raw-legacy");
  assert.equal(rawResult.curated, false);
  assert.equal(rawResult.replaceable, false);

  const curatedRecall = await registry.invoke("recall", { query: "12345" }, context);
  const curatedResult = curatedRecall.result.items.find((item) => item.id === first.result.id);
  assert.equal(curatedResult.curated, true);
  assert.equal(curatedResult.replaceable, true);

  const malformedReplacement = await registry.invoke("remember", {
    content: "invalid replacement",
    replaceIds: "not-an-array"
  }, context);
  assert.equal(malformedReplacement.ok, false);
  assert.match(malformedReplacement.error, /replaceIds must be an array/);

  const rejected = await registry.invoke("remember", { content: "x" }, context);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /MEMORY|memory capacity|Curated memory/i);
  assert.match(rejected.error, /replaceIds/);

  const replacement = await registry.invoke("remember", {
    content: "abcdefghijklmnopqrstuv",
    replaceIds: [first.result.id, second.result.id]
  }, context);
  assert.equal(replacement.ok, true);
  assert.deepEqual(replacement.result.replaced, [first.result.id, second.result.id]);
  assert.equal(memory.curatedUsage().usedChars, 33);
  assert.equal(memory.items.get(first.result.id).metadata.supersededBy, replacement.result.id);
  assert.equal(memory.items.get(second.result.id).metadata.supersededBy, replacement.result.id);
  assert.match(registry.get("remember").description, /replaceIds/);
});

test("curated accounting includes rendered bullets and rejects empty content", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 33 });
  curated(memory, "12345", { id: "one" });
  curated(memory, "67890", { id: "two" });

  const usage = memory.curatedUsage();
  assert.equal(usage.body, "- [medium] 12345\n- [medium] 67890");
  assert.equal(usage.usedChars, usage.body.length);
  assert.equal(usage.usedChars, 33);
  assert.equal(memory.renderSessionMemorySnapshot().split("\n").slice(1).join("\n"), usage.body);

  const before = structuredClone([...memory.items]);
  assert.throws(
    () => curated(memory, " \n\t ", { id: "empty" }),
    /non-whitespace.*Nothing was saved/i
  );
  assert.deepEqual([...memory.items], before);
});

test("specialist projections inherit main memory and preflight the effective body", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 33 });
  curated(memory, "12345", {
    id: "global",
    scope: "main",
    now: "2026-01-01T00:00:00.000Z"
  });
  curated(memory, "67890", {
    id: "local",
    scope: "specialist:child",
    now: "2026-01-02T00:00:00.000Z"
  });

  const usage = memory.curatedUsage({ scope: "specialist:child" });
  assert.deepEqual(usage.items.map((item) => item.id), ["global", "local"]);
  assert.equal(usage.usedChars, 33);
  assert.match(memory.renderSessionMemorySnapshot({ scope: "specialist:child" }), /12345[\s\S]*67890/);

  const before = structuredClone([...memory.items]);
  assert.throws(
    () => curated(memory, "x", { id: "global-two", scope: "main" }),
    (error) => {
      assert.ok(error instanceof MemoryCapacityError);
      assert.equal(error.scope, "specialist:child");
      return true;
    }
  );
  assert.deepEqual([...memory.items], before, "a global write cannot overflow an inherited view");
});

test("oversized background-review memory errors intact instead of being sliced to fit", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 2200 });
  const content = "z".repeat(2300);
  const result = applyBackgroundReviewProposal({
    runtime: { memory },
    proposal: {
      memories: [{ content, kind: "preference", confidence: "high" }]
    },
    turn: { sessionId: "review-overflow", memoryScope: "main" }
  });

  assert.equal(result.memories.length, 0);
  assert.equal(result.memoryErrors.length, 1);
  assert.match(result.memoryErrors[0], /Nothing was saved/);
  assert.equal(memory.items.size, 0);
});

test("rejected query correction is read-only and corrections cannot cross scopes", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 16 });
  const original = curated(memory, "alpha", {
    id: "curated-main",
    now: "2026-01-01T00:00:00.000Z"
  });
  original.strength = 0.5;
  const beforeOverflow = structuredClone([...memory.items]);

  assert.throws(
    () => memory.correct({ query: "alpha", content: "123456", scope: "main" }),
    MemoryCapacityError
  );
  assert.deepEqual([...memory.items], beforeOverflow, "failed lookup does not reinforce or timestamp targets");

  const legacy = memory.remember(
    { content: "legacy main fact", scope: "main" },
    { id: "legacy-main", tier: "medium" }
  );
  const beforeScopeError = structuredClone([...memory.items]);
  assert.throws(
    () => memory.correct({
      id: legacy.id,
      content: "specialist rewrite",
      scope: "specialist:child"
    }),
    /belongs to scope "main".*Nothing was saved/
  );
  assert.deepEqual([...memory.items], beforeScopeError);
});

test("file-backed legacy correction persists one fully superseded state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-memory-correct-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new FileBackedMemorySystem({ dir, curatedMemoryMaxChars: 100 });
  const stale = memory.remember(
    { content: "legacy stale fact", scope: "main" },
    { id: "legacy-stale", tier: "medium" }
  );
  const eventsPath = path.join(dir, "memory-events.jsonl");
  const beforeEventCount = fs.readFileSync(eventsPath, "utf8").trim().split("\n").length;

  const result = memory.correct({
    id: stale.id,
    content: "corrected durable fact",
    scope: "main"
  });

  const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, beforeEventCount + 1, "correction performs one durable write");
  assert.equal(events.at(-1).op, "correct");
  assert.equal(events.at(-1).payload.item.id, result.item.id);
  assert.deepEqual(events.at(-1).payload.superseded, [stale.id]);

  const reloaded = new FileBackedMemorySystem({ dir, curatedMemoryMaxChars: 100 });
  assert.equal(reloaded.items.get(stale.id).metadata.supersededBy, result.item.id);
  assert.equal(reloaded.items.get(result.item.id).content, "corrected durable fact");
});

test("curated promotion preserves ids referenced by correction provenance", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 100 });
  const stale = curated(memory, "wrong", {
    id: "stale",
    now: "2026-01-01T00:00:00.000Z"
  });
  const correction = memory.correct({
    id: stale.id,
    content: "right",
    scope: "main"
  }).item;
  const future = new Date(new Date(correction.createdAt).getTime() + (46 * 24 * 60 * 60 * 1000));

  const { promoted } = memory.decay(future);
  const promotedCorrection = promoted.find((item) => item.kind === "correction");
  assert.equal(promotedCorrection.id, correction.id);
  assert.equal(stale.metadata.supersededBy, correction.id);
  assert.equal(memory.items.has(correction.id), true);
});

test("TTL maintenance neither overflows nor silently deletes active curated memory", () => {
  const exact = new MemorySystem({ curatedMemoryMaxChars: 11 });
  const short = exact.remember(
    {
      content: "x",
      scope: "main",
      repetition: 0.6
    },
    {
      id: "short-exact",
      tier: "short",
      capacityManaged: true,
      now: "2026-01-01T00:00:00.000Z"
    }
  );
  assert.equal(exact.curatedUsage().usedChars, 11);

  const shortDecay = exact.decay(new Date("2026-01-01T09:00:00.000Z"));
  assert.equal(shortDecay.promoted.length, 0, "a longer medium label cannot overflow the projection");
  assert.equal(shortDecay.removed.length, 0);
  assert.equal(exact.items.get(short.id).tier, "short");
  assert.equal(exact.curatedUsage().usedChars, 11);

  const durable = new MemorySystem({ curatedMemoryMaxChars: 100 });
  const medium = curated(durable, "keep this", {
    id: "durable-medium",
    now: "2026-01-01T00:00:00.000Z"
  });
  const mediumDecay = durable.decay(new Date("2026-02-16T00:00:00.000Z"));
  assert.equal(mediumDecay.removed.length, 0);
  assert.equal(durable.items.has(medium.id), true, "curated memory changes only through consolidation");
});

test("session memory snapshot survives later writes and a host restart", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-frozen-memory-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const memory = new MemorySystem();
  curated(memory, "Alpha existed before the session.", { id: "alpha" });
  let firstSignal = true;
  const runtime = {
    memory,
    tools: { toOpenAITools: () => [] },
    outcomes: null,
    processSignal() {
      if (firstSignal) {
        firstSignal = false;
        curated(memory, "Beta was written during the first turn.", { id: "beta" });
      }
      return {
        id: "signal",
        scrutiny: {
          action: "act",
          score: 0.7,
          reasons: ["fixture"],
          dimensions: { novelty: 0.5, risk: 0.1, repetition: 0.1 }
        },
        customContext: [],
        propagation: null
      };
    }
  };
  const captures = [];
  const provider = {
    isConfigured: () => true,
    async generate(request) {
      captures.push(request.sessionMemorySnapshot);
      return { provider: "fixture", model: "fixture", text: "done", toolCalls: [] };
    }
  };
  const storeDir = path.join(dataDir, "agent-host");
  const firstHost = new AgentHost({
    runtime,
    store: new FileBackedAgentStore({ dir: storeDir }),
    modelProvider: provider
  });
  await firstHost.handleMessage({ channel: "local", from: "creator", sessionId: "frozen", text: "build one" });

  const restartedHost = new AgentHost({
    runtime,
    store: new FileBackedAgentStore({ dir: storeDir }),
    modelProvider: provider
  });
  await restartedHost.handleMessage({ channel: "local", from: "creator", sessionId: "frozen", text: "build two" });
  await restartedHost.handleMessage({ channel: "local", from: "creator", sessionId: "fresh", text: "build three" });

  assert.equal(captures[0], captures[1]);
  assert.match(captures[0], /Alpha existed/);
  assert.doesNotMatch(captures[0], /Beta was written/);
  assert.match(captures[2], /Alpha existed/);
  assert.match(captures[2], /Beta was written/);
  const frozenMetadata = restartedHost.store.getSession("frozen").metadata;
  const persisted = Object.entries(frozenMetadata)
    .find(([key]) => key.startsWith("frozenMemoryV1:"))?.[1];
  assert.equal(persisted.text, captures[0]);
  assert.equal(persisted.sessionId, "frozen");
  assert.equal(persisted.scope, "main");
  assert.equal(persisted.agentId, "main");
});

test("frozen snapshot metadata isolates and validates session scope plus agent", async () => {
  const renders = [];
  const runtime = {
    memory: {
      renderSessionMemorySnapshot({ scope }) {
        renders.push(scope);
        return `snapshot:${scope}:${renders.length}`;
      }
    },
    processSignal: () => ({})
  };
  const store = new InMemoryAgentStore();
  const host = new AgentHost({
    runtime,
    store,
    modelProvider: { isConfigured: () => true }
  });

  const main = await host.sessionMemorySnapshotFor("shared", "main", "main");
  const specialist = await host.sessionMemorySnapshotFor("shared", "specialist:s1", "s1");
  assert.notEqual(main, specialist);
  assert.equal(await host.sessionMemorySnapshotFor("shared", "main", "main"), main);
  assert.deepEqual(renders, ["main", "specialist:s1"]);

  const metadata = store.getSession("shared").metadata;
  const mainKey = Object.keys(metadata).find((key) => key.endsWith(":main:main"));
  metadata[mainKey] = { ...metadata[mainKey], sessionId: "wrong-session" };
  const repaired = await host.sessionMemorySnapshotFor("shared", "main", "main");
  assert.notEqual(repaired, main);
  assert.equal(store.getSession("shared").metadata[mainKey].sessionId, "shared");
  assert.deepEqual(renders, ["main", "specialist:s1", "main"]);
});

test("both paid providers keep one frozen memory block byte-identical across turns", async () => {
  const snapshot = "[50% \u2014 1,100/2,200 chars]\n- [long] Stable preference";
  const openAIBodies = [];
  const openai = new OpenAIResponsesProvider({
    apiKey: "openai-test-key",
    contextWindowTokens: 100_000
  });
  openai.postResponses = async (body) => {
    openAIBodies.push(structuredClone(body));
    return { id: "done", output_text: "done", output: [] };
  };
  await openai.generate({ input: "one", instructions: "static", sessionMemorySnapshot: snapshot, turnContext: "turn one" });
  await openai.generate({ input: "two", instructions: "static", sessionMemorySnapshot: snapshot, turnContext: "turn two" });
  assert.equal(openAIBodies[0].instructions, openAIBodies[1].instructions);
  assert.equal((openAIBodies[0].instructions.match(/\[session-memory\]/g) ?? []).length, 1);

  const anthropicBodies = [];
  const anthropic = new AnthropicProvider({
    apiKey: "anthropic-test-key",
    contextWindowTokens: 100_000,
    stallTimeoutMs: 0
  });
  anthropic.postMessages = async (body) => {
    anthropicBodies.push(structuredClone(body));
    return { id: "done", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  };
  await anthropic.generate({ input: "one", instructions: "static", sessionMemorySnapshot: snapshot, turnContext: "turn one" });
  await anthropic.generate({ input: "two", instructions: "static", sessionMemorySnapshot: snapshot, turnContext: "turn two" });
  assert.equal(anthropicBodies[0].system[0].text, anthropicBodies[1].system[0].text);
  assert.equal((anthropicBodies[0].system[0].text.match(/\[session-memory\]/g) ?? []).length, 1);
  assert.deepEqual(anthropicBodies[0].system[0].cache_control, { type: "ephemeral" });
});

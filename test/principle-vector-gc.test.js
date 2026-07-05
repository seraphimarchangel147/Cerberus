// G10 remediation: principle vectors must be garbage-collected when their
// backing memory item is superseded (correct()) or cap-evicted
// (enforceLimits), reconciled at boot when orphaned, and filtered out of the
// C2 intuition channel when missing, superseded, or quarantined.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HashBagEmbedder,
  MemorySystem,
  VectorStore,
  createDefaultRuntime,
  createDurableRuntime
} from "../src/index.js";
import { AgentHost } from "../src/agent-host.js";

function tmpVectorStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-"));
  return new VectorStore({ embedder: new HashBagEmbedder(), dir });
}

test("correct() deletes the superseded item's principle vector", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const principle = memory.remember(
    { content: "Standup meetings are at 9am Mondays.", tags: ["principle", "standup"], kind: "principle" },
    { tier: "long" }
  );
  await vectors.upsert("principle", principle.id, principle.content, { confidence: "high" });
  assert.equal(vectors.list("principle").length, 1);

  const { superseded } = memory.correct({ id: principle.id, content: "Standup meetings moved to 9:30am Mondays." });

  assert.equal(superseded[0].id, principle.id);
  assert.equal(vectors.list("principle").length, 0, "superseding a principle removes its vector");
});

test("cap eviction deletes the evicted item's principle vector", async () => {
  const memory = new MemorySystem({ limits: { short: 100, medium: 100, long: 1 } });
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const weak = memory.remember(
    { content: "Old principle: check the calendar before booking anything.", kind: "principle" },
    { tier: "long", strength: 0.1 }
  );
  await vectors.upsert("principle", weak.id, weak.content);
  assert.equal(vectors.list("principle").length, 1);

  // Long-tier cap is 1: this stronger item evicts the weak principle.
  memory.remember({ content: "Newer long-term note that wins the cap." }, { tier: "long", strength: 0.9 });

  assert.equal(memory.items.has(weak.id), false, "weaker item was evicted");
  assert.equal(vectors.list("principle").length, 0, "evicted item's vector removed");
});

test("reconcilePrincipleVectors removes orphaned and superseded vectors, keeps live ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-rec-"));
  const runtime = createDefaultRuntime({
    agentHost: false,
    embedderOptions: { forceHash: true },
    vectorStoreOptions: { dir }
  });

  const live = runtime.memory.remember({ content: "Live principle about calendar hygiene.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", live.id, live.content);
  await runtime.vectorStore.upsert("principle", "mem_long_wiped_1", "Orphan principle whose memory item is gone.");
  const stale = runtime.memory.remember({ content: "Stale principle later corrected.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", stale.id, stale.content);
  // Simulate a supersede that happened before the GC wiring existed.
  stale.metadata = { ...stale.metadata, supersededBy: "mem_medium_fake_1" };

  const result = runtime.reconcilePrincipleVectors();

  assert.equal(result.checked, 3);
  assert.equal(result.removed, 2);
  assert.deepEqual(runtime.vectorStore.list("principle").map((e) => e.id), [live.id]);
});

test("createDurableRuntime reconciles orphaned principle vectors at boot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-boot-"));
  const seed = new VectorStore({ embedder: new HashBagEmbedder(), dir: path.join(dataDir, "vectors") });
  await seed.upsert("principle", "mem_long_wiped_2", "Orphan vector from a wiped memory state.");

  const runtime = createDurableRuntime({
    dataDir,
    agentHost: false,
    autoConnectMcp: false,
    embedderOptions: { forceHash: true }
  });

  assert.equal(runtime.vectorStore.list("principle").length, 0, "boot reconcile removed the orphan");
});

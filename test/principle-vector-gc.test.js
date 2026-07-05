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

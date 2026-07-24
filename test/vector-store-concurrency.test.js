import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cosine, HashBagEmbedder } from "../src/embeddings.js";
import { VectorStore } from "../src/vector-store.js";

test("cosine rejects mismatched embedding dimensions", () => {
  assert.equal(cosine([1, 0], [1, 0, 99]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});

test("stale vector-store instances reload under lock instead of losing namespaces", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vector-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const embedder = new HashBagEmbedder();
  const first = new VectorStore({ dir, embedder });
  const stale = new VectorStore({ dir, embedder });

  await first.upsert("principle", "p1", "first principle");
  await stale.upsert("specialist", "s1", "first specialist");
  const reloaded = new VectorStore({ dir, embedder });
  assert.deepEqual(
    reloaded.list("principle").map((entry) => entry.id),
    ["p1"]
  );
  assert.deepEqual(
    reloaded.list("specialist").map((entry) => entry.id),
    ["s1"]
  );

  const vector = await embedder.embed("verified recipe");
  stale.replaceNamespace("recipe:alpha", [{
    id: "recipe_0000000000000001",
    text: "verified recipe",
    embedding: vector,
    payload: { revision: 1 }
  }]);
  assert.deepEqual(
    new VectorStore({ dir, embedder }).list("principle").map((entry) => entry.id),
    ["p1"],
    "namespace replacement must retain concurrent foreign namespaces"
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SETUP_FIELDS } from "../src/setup-wizard.js";
import {
  reciprocalRankFusion,
  VectorStore
} from "../src/vector-store.js";

test("RRF math matches hand-computed ranks and handles empty or single lists", () => {
  const fused = reciprocalRankFusion([
    [{ id: "a" }, { id: "b" }],
    [{ id: "b" }, { id: "c" }]
  ]);
  const byId = new Map(fused.map((item) => [item.id, item.score]));

  assert.equal(byId.get("a"), 1 / 61);
  assert.equal(byId.get("b"), (1 / 62) + (1 / 61));
  assert.equal(byId.get("c"), 1 / 62);
  assert.deepEqual(fused.map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(
    reciprocalRankFusion([[{ id: "only" }]]).map((item) => item.id),
    ["only"]
  );
});

test("RRF ties are deterministic by stable id", () => {
  const lists = [
    [{ id: "b" }, { id: "a" }],
    [{ id: "a" }, { id: "b" }]
  ];
  const first = reciprocalRankFusion(lists);
  const second = reciprocalRankFusion(lists);

  assert.deepEqual(first.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(second, first);
});

test("hybrid search promotes evidence shared by vector and lexical ranks", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vector-rrf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const embedder = {
    dim: 2,
    embed: async () => [1, 0]
  };
  const store = new VectorStore({ dir, embedder });
  store.upsertVector("memory", "vector-only", "unrelated material", [1, 0]);
  store.upsertVector("memory", "both", "needle evidence", [0.8, 0.6]);
  store.upsertVector("memory", "lexical-only", "needle details", [0, 1]);

  const legacy = await store.search("memory", "needle", {
    limit: 3,
    minScore: 0.5
  });
  const explicitlyOff = await store.search("memory", "needle", {
    limit: 3,
    minScore: 0.5,
    hybrid: false
  });
  const hybrid = await store.search("memory", "needle", {
    limit: 3,
    minScore: 0.5,
    hybrid: true
  });

  assert.equal(JSON.stringify(explicitlyOff), JSON.stringify(legacy));
  assert.deepEqual(legacy.map((item) => item.id), ["vector-only", "both"]);
  assert.equal(hybrid[0].id, "both");
  assert.ok(hybrid.some((item) => item.id === "lexical-only"));
  assert.ok(hybrid[0].rrfScore > hybrid.at(-1).rrfScore);
  assert.ok(Number.isFinite(hybrid[0].vectorScore));
  assert.ok(Number.isFinite(hybrid[0].lexicalScore));
});

test("hybrid retrieval defaults off, accepts its env flag, and is allowlisted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vector-rrf-env-"));
  const embedder = { dim: 2, embed: async () => [1, 0] };
  try {
    assert.equal(new VectorStore({ dir, embedder, env: {} }).hybridSearch, false);
    assert.equal(new VectorStore({
      dir,
      embedder,
      env: { OPENAGI_VECTOR_HYBRID_SEARCH: "1" }
    }).hybridSearch, true);
    assert.ok(SETUP_FIELDS.includes("OPENAGI_VECTOR_HYBRID_SEARCH"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

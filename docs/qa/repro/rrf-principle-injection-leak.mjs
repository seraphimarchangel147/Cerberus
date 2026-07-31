// Throwaway probe #2: does the minScore leak reach a REAL consumer?
// Target: the principle-intuition injection path in agent-host.js, which
// gates relevance ONLY via vectorStore.search(..., { minScore: 0.1 }).
// filterPrincipleHits() re-checks scope/supersession/quarantine but NOT score.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../../src/vector-store.js";
import { filterPrincipleHits } from "../../../src/agent-host.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrf-principle-"));

const vectors = new Map([
  ["USER ASKS ABOUT DOCKER NETWORKING", [1, 0, 0]],
  ["p_relevant",   [0.95, 0.31, 0]],
  ["p_irrelevant", [0, 1, 0]],
]);
const embedder = { dim: 3, async embed(t) { return vectors.get(String(t)) ?? [0, 0, 1]; } };

const store = new VectorStore({ dir, embedder, dim: 3 });
await store.upsert("principle", "p_relevant", "p_relevant", {});
await store.upsert("principle", "p_irrelevant", "p_irrelevant", {});

// Give each principle its real-world TEXT (what the lexical ranker reads).
const file = path.join(dir, "store.json");
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
for (const e of (raw.entries ?? raw)) {
  if (e.id === "p_relevant") e.text = "Prefer bridge networks over host mode for container isolation.";
  // Shares the words "user" / "about" with the query but is semantically unrelated.
  if (e.id === "p_irrelevant") e.text = "the user asks about about about about about";
}
fs.writeFileSync(file, JSON.stringify(raw));

// A memory store stub: both principles are active, in scope, unquarantined.
const memory = {
  items: new Map([
    ["p_relevant",   { id: "p_relevant",   scope: "main", metadata: {} }],
    ["p_irrelevant", { id: "p_irrelevant", scope: "main", metadata: {} }],
  ])
};

const QUERY = "USER ASKS ABOUT DOCKER NETWORKING";

for (const hybrid of [false, true]) {
  const s = new VectorStore({ dir, embedder, dim: 3, hybridSearch: hybrid });
  const hits = await s.search("principle", QUERY, { limit: 10, minScore: 0.1 });
  const injected = filterPrincipleHits(hits, memory, { limit: 3, scope: "main" });
  console.log(`\n--- OPENAGI_VECTOR_HYBRID_SEARCH=${hybrid ? "1" : "off"} ---`);
  console.log("search returned:", hits.map((h) => `${h.id}@${h.score.toFixed(3)}`).join(", ") || "(none)");
  console.log("INJECTED as intuitions:", injected.map((h) => h.id).join(", ") || "(none)");
  const belowGate = injected.filter((h) => h.score < 0.1);
  if (belowGate.length) {
    console.log("  >>> INJECTED BELOW THE 0.1 GATE:",
      belowGate.map((h) => `${h.id} cosine=${h.score}`).join(", "));
  }
}

fs.rmSync(dir, { recursive: true, force: true });

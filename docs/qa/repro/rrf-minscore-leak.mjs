// Throwaway probe: does the RRF hybrid path violate the minScore contract
// that the legacy cosine path enforces? Not a committed test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../../src/vector-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrf-probe-"));

// Deterministic 3-dim embedder. The TEXT and the VECTOR are decoupled on
// purpose: that is exactly the situation hybrid retrieval exists to exploit.
const vectors = new Map([
  ["query",       [1, 0, 0]],
  ["near",        [0.99, 0.14, 0]],   // high cosine, no shared words
  ["orthogonal",  [0, 1, 0]],         // cosine 0, but shares query wording
]);
const embedder = {
  dim: 3,
  async embed(text) {
    return vectors.get(String(text)) ?? [0, 0, 1];
  }
};

async function run(hybrid) {
  const store = new VectorStore({ dir: path.join(dir, hybrid ? "h" : "l"), embedder, dim: 3 });
  // text is what the LEXICAL ranker sees; the embedding key is the 1st arg to embed()
  await store.upsert("probe", "near", "near", {});
  await store.upsert("probe", "orthogonal", "orthogonal", {});
  // Overwrite the stored text so lexical overlap is decoupled from the vector.
  const raw = JSON.parse(fs.readFileSync(path.join(dir, hybrid ? "h" : "l", "store.json"), "utf8"));
  for (const e of (raw.entries ?? raw)) {
    if (e.id === "near") e.text = "completely unrelated wording";
    if (e.id === "orthogonal") e.text = "query query query";
  }
  fs.writeFileSync(path.join(dir, hybrid ? "h" : "l", "store.json"), JSON.stringify(raw));

  const fresh = new VectorStore({ dir: path.join(dir, hybrid ? "h" : "l"), embedder, dim: 3, hybridSearch: hybrid });
  return fresh.search("probe", "query", { limit: 5, minScore: 0.05 });
}

const legacy = await run(false);
const hybrid = await run(true);

const fmt = (rows) => rows.map((r) => `${r.id} score=${r.score.toFixed(4)}${r.lexicalScore !== undefined ? ` lex=${r.lexicalScore.toFixed(3)} fused=${r.fusedScore.toFixed(3)}` : ""}`);

console.log("minScore = 0.05");
console.log("LEGACY (cosine only):", JSON.stringify(fmt(legacy), null, 1));
console.log("HYBRID (RRF):        ", JSON.stringify(fmt(hybrid), null, 1));

const violations = hybrid.filter((r) => r.score < 0.05);
console.log("\nHYBRID rows returned BELOW the caller's minScore:", violations.length);
for (const v of violations) console.log("   VIOLATION:", v.id, "score", v.score, "lexical", v.lexicalScore);

fs.rmSync(dir, { recursive: true, force: true });

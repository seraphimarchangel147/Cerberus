# Spec 04 — Memory hot path: recall ranking, tier double-count, condenser pollution

**Marker:** `MEMORY HOT PATH PHASE COMPLETE`
**Priority:** 4 (Azazel's #4). **Risk:** Med. **SCAFFOLD.**
**Files:** `src/memory-system.js`, `src/memory-condenser.js`.

## Confirmed issues (verified 2026-07-21)

1. **Recall is O(N) token-overlap, no index.** `memory-system.js:95`
   `tokenOverlapScore(queryText, ...)` scored across all items each recall. `this.vectors`
   (:20) is never bound — the vector namespace has no writer, so semantic recall is dead
   code. For Azazel's memory sizes this is fine correctness-wise but won't scale and misses
   semantic matches.
2. **Tier weighting is a partial inversion, NOT a clean flip.** `:96`
   `tierWeight = short 1.15 : medium 1 : long 0.85` — recent trivia multiplicatively
   outranks distilled principles. BUT `:112` adds `principleBoost + correctionBoost +
   dangerBoost + fidelityBoost` on top. **Do NOT blindly flip 1.15/0.85** — that would
   double-count with the additive principle boost and over-rank principles. Rebalance
   holistically (see below).
3. **Condenser fallback pollutes the long tier permanently.** `memory-condenser.js:166`
   emits `text: "Pattern across N notes: ..."` and `:68` writes it with
   `tier: "long", critical: true`. `memory-system.js:253` routes `critical:true` → `long`
   (longest TTL). So low-quality deterministic-fallback principles become permanent and get
   recalled (Azazel saw two near-duplicate copies injected into his own context).

## Direction

### Tier rebalance (do this carefully, measure)
- Treat the tier weight and the principle/correction boosts as ONE scoring model. Options:
  (a) drop the multiplicative tier penalty on `long` and rely on the additive
  principle/correction boosts to rank principles, or (b) make the tier weight reflect
  RECENCY×STRENGTH decay rather than a flat per-tier constant. Pick one, write it down, and
  add a ranking test with representative items (a fresh trivia short-memory vs. a distilled
  long principle on a principle-relevant query → principle should win; on a
  recency-relevant query → trivia can win). The GOAL: distilled principles and corrections
  outrank stale trivia for matching queries WITHOUT drowning fresh relevant context.

### Condenser pollution
- The deterministic extractive fallback (`:156-166`) should NOT write `critical: true`.
  Write it at a lower tier (medium) or with `critical:false` so it decays, and/or gate it
  behind a quality threshold (min distinct source count, min salient-phrase strength).
- **De-dup:** before writing a condensed principle, check for a near-duplicate existing
  principle (token-overlap over a threshold) and MERGE/skip instead of adding a second
  "Pattern across N notes" copy. Honor `metadata.condensedInto` so sources aren't
  re-condensed (already present at :78) — extend to the OUTPUT side.
- Respect `confidence`/quarantine: the condenser prompt already asks for
  `(confidence: high|medium|low)` (:102). Parse it and set tier/strength from confidence;
  low-confidence fallbacks must NOT land in infinite-TTL long.

### Recall index (optional in this phase)
- If cheap: add an FTS/BM25 recall path (SQLite FTS5 like `session-index.js` already uses)
  as an alternative to token-overlap, or wire a real writer for `this.vectors`. If it's
  more than M effort, land the tier rebalance + condenser fixes (the actual bugs Azazel
  felt) and DEFER the index with a note in CHANGES.md.

## Tests
- Ranking: principle-relevant query ranks a distilled long principle above fresh trivia;
  recency-relevant query still surfaces fresh short memory.
- Condenser: extractive fallback does not write `critical:true` to long; a near-duplicate
  principle is merged/skipped, not duplicated; low-confidence output decays.
- Regression: existing memory tests still pass (they construct fake runtimes — default any
  new deps).

## Live proof
Trigger a condense cycle with duplicate-ish notes; confirm only one principle lands and it's
not `critical:true` in the long tier. Confirm recall ordering on a representative query.

## DoD
Both lanes green + tests, homoglyph clean, no duplicate junk principle reproducible,
`CHANGES.md` entry ending with the marker. Index either implemented or explicitly deferred.

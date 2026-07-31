# QA finding B2-b — RRF hybrid retrieval silently violates the caller's `minScore`

**Status:** REPRODUCED (was scaffold item #4, "RRF still needs a repro or it's a ghost").
**Not a ghost.** But it is **latent, not live** — see Blast radius.

**Flag:** `OPENAGI_VECTOR_HYBRID_SEARCH` (default off)
**Files:** `src/vector-store.js` (search hybrid branch), `src/agent-host.js` (`filterPrincipleHits`)
**Repros:** `docs/qa/repro/rrf-minscore-leak.mjs`, `docs/qa/repro/rrf-principle-injection-leak.mjs`

---

## The defect

`VectorStore.search()` takes a `minScore`. The legacy cosine path enforces it:

```js
const score = cosine(queryEmbedding, entry.embedding);
if (score < minScore) continue;
```

The hybrid path applies `minScore` to the **vector list only**:

```js
.filter((item) => item.score >= minScore)   // vectorRanked — gated
...
.filter((item) => item.score > 0)           // lexicalRanked — gated at > 0, NOT minScore
```

Both lists are then fused. So **any entry with a single shared token enters the result set
regardless of `minScore`** — including entries at cosine exactly 0.

Since the B2 fix (`9b18139`) deliberately made `score` mean *cosine similarity* again, the
returned rows now carry a `score` that **fails the caller's own threshold**. The contract
"every row I return satisfies your `minScore`" was true pre-Wave-3 and is false with the flag on.

### Repro 1 — the raw contract break

```
minScore = 0.05
LEGACY (cosine only): [ "near score=0.9901" ]
HYBRID (RRF):         [ "near score=0.9901 lex=0.000 fused=0.500",
                        "orthogonal score=0.0000 lex=1.000 fused=0.500" ]

HYBRID rows returned BELOW the caller's minScore: 1
   VIOLATION: orthogonal score 0 lexical 1
```

### Repro 2 — it reaches a real consumer

The principle-intuition injection in `agent-host.js` gates relevance **only** via
`search(..., { minScore: 0.1 })`. `filterPrincipleHits()` re-checks scope, supersession and
quarantine — but never re-checks the score. So the leak lands directly in the system prompt:

```
--- OPENAGI_VECTOR_HYBRID_SEARCH=off ---
search returned: p_relevant@0.951
INJECTED as intuitions: p_relevant

--- OPENAGI_VECTOR_HYBRID_SEARCH=1 ---
search returned: p_irrelevant@0.000, p_relevant@0.951
INJECTED as intuitions: p_irrelevant, p_relevant
  >>> INJECTED BELOW THE 0.1 GATE: p_irrelevant cosine=0
```

The junk principle is not merely *included* — it ranks **first**, because RRF scores by rank
position and a cosine-0 row that tops the lexical list ties a cosine-0.95 row that tops the
vector list. With `limit: 3` on intuitions, two such rows would evict a genuinely relevant
principle entirely.

`tokenOverlapScore` is `hits / queryTokens.size` over a stopword-free tokenizer, so common
words ("the", "user", "about", "code") count as full matches. Junk text that happens to repeat
query stopwords scores a perfect **1.0**.

---

## Blast radius — why this is P2, not P1

- `OPENAGI_VECTOR_HYBRID_SEARCH` is **absent from the live unit** (`systemctl --user show
  openagi-azazel -p Environment` → not present = off). Verified 2026-07-31.
- The only recorded setting of it anywhere is `OPENAGI_VECTOR_HYBRID_SEARCH=off` in the F2
  redaction evidence.
- Of the four `vectorStore.search()` callers, **three pass `minScore: 0`**
  (`specialist-router`, `solution-recipe-store`, `signal-axes`) and are therefore unaffected by
  definition. **`agent-host` principle injection is the sole caller with a real threshold** —
  and it's the one that feeds the prompt.

So: no live impact today, and a real prompt-poisoning vector the moment anyone flips the flag.

---

## The part that needs a decision, not a patch

I did **not** push a fix, because the current behavior is **deliberate and test-locked**.
`test/vector-store-rrf.test.js` asserts precisely this:

```js
const hybrid = await store.search("memory", "needle", { limit: 3, minScore: 0.5, hybrid: true });
assert.ok(hybrid.some((item) => item.id === "lexical-only"));
```

`lexical-only` has cosine 0 against the query and is returned under `minScore: 0.5`. "Lexical
evidence may be recalled" is a stated Wave 3 feature (CHANGES.md), and it is genuinely the point
of hybrid retrieval — a keyword match a bad embedder missed is exactly what you want back.

The bug is not that lexical-only rows are recalled. It's that **they're returned wearing a
`score` field the caller uses as a gate, with no separate signal that they bypassed it.** Three
ways out, in my order of preference:

1. **Gate lexical entries on their own threshold** (e.g. `lexicalScore >= minScore`), keeping
   the two ladders symmetric. Cheapest, preserves the feature, kills the cosine-0 case. Requires
   updating the existing assertion's `minScore`.
2. **Tag the provenance** — add `matchedBy: "vector" | "lexical" | "both"` and let
   `filterPrincipleHits` drop lexical-only rows for prompt injection while search-style callers
   keep them. Most correct, touches two files.
3. **Stopword-filter `tokenOverlapScore`** — fixes the 1.0-on-garbage scoring but not the
   contract break. Worth doing regardless; note it's shared with `memory-system`,
   `specialist-router` and `solution-recipe-store`, so it is *not* a local change.

My recommendation is **1 + 3**. But this is Azazel's Wave 3 and the assertion is his intent,
so the call is his — I'm not going to quietly redefine a documented feature as a bug.

---

## Correction to my own earlier reporting

The scaffold called item #1 "3 triplicates". Against the live store that's **not accurate**:

- The exact-content triple (`03ed3bdae3c949fe`, `c2ee8b8809934d49`, `8390f942387a439a`) has
  **one member already carrying `condensedInto`** — it's a corpse the new reaper handles, not a
  duplicate needing `correct_memory`. Only **2** are live.
- Store-wide the real number is **9 live duplicate-hash groups / 10 redundant items**, not 3 —
  mostly repeated `autopilot` pulse prompts and `adaptive-review` cron output, i.e. a *write-side*
  intake problem, not something to hand-retire one id at a time.

Retiring 10 items by hand treats the symptom. The generator is that identical cron/autopilot
text is admitted as a fresh memory every run.

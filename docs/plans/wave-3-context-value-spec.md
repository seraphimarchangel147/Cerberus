# Phase: Wave 3 — Value-Aware Context Shedding & Hybrid Retrieval

**Spec author:** Seraphim · **Date:** 2026-07-29
**Baseline:** `main` @ `3db3351` (Wave 1 merged: `tests 2108 · pass 2084 · fail 0 · skipped 24`)
**Read first:** `docs/plans/tencentdb-memory-assessment.md` (evidence, verdicts, license)
**Upstream reference:** `TencentCloud/TencentDB-Agent-Memory` @ `104e9d8`, **MIT**

> **READ THIS SPEC IN FULL BEFORE EDITING.** All anchors verified against live source
> 2026-07-29. If an anchor doesn't match, STOP and report it in `CHANGES.md`.

## The thesis

Wave 1 taught the harness to decide **by progress instead of by clock**. Wave 3 teaches it to
shed context **by value instead of by position**. Same underlying defect, different axis:
*we discard context on the wrong axis.*

Today, compaction is purely positional. `contextKeepRecentHops` →
`liveContextRecentBoundary()` (`src/memory-condenser.js:2672`) → everything older than the
boundary is folded into **one digest**. Grep `score|priority|rank|importance` across
`src/tool-output-store.js` and `src/spill-store.js`: **zero hits.** We have **no notion of
per-entry value**, and no concept of "current task" in compaction at all. A mid-merge diff and a
40-hop-old `ls` are treated identically if they're the same age.

## ⚠️ Critical: what "score" means here (do not get this backwards)

Tencent's cascade score is **NOT importance.** It is **substitutability** — how safely a summary
can replace the original text (`local-llm/prompts/l1-prompt.ts:26`: 0–10, closer to 10 means the
summary better replaces the original). So the cascade sheds **10 first** (safe to compress) and
**protects 1** (compressing would lose real information).

This is the better question: *"what can I compress losslessly?"* not *"what do I care about
least?"* **Implement it in that direction.** An importance ranking would be a different — and
more dangerous — system, because "unimportant" and "safely compressible" are not the same thing.

**We are NOT porting their scorer.** Theirs calls a small local LLM **once per tool pair**.
That's a dependency and a per-call cost we won't take. We implement a **deterministic proxy**
(Fix 1). openAGI already has the ref/spill machinery that makes "is this losslessly
recoverable?" a cheap *local* question — that is our advantage over their design, not a
compromise.

## Scope

### Fix 1 — Deterministic substitutability score (pure, testable, foundation)

Add a **pure exported function** (new small module, e.g. `src/context-value.js`) that scores a
tool-output entry **0–10 for substitutability** with **no LLM call and no I/O**. Signals to
combine — all locally computable:

- **Losslessly recoverable?** If the full text is already spilled to a `ref` that can be fetched
  back on demand, substitutability is **high** — the information isn't lost, just moved. This is
  the strongest signal we have and their design lacks it.
- **Compressibility / redundancy** — highly repetitive output (log spam, progress bars, repeated
  identical lines) is highly substitutable. Cheap proxies: unique-line ratio, longest-repeated-run.
- **Structure** — a large structured blob (JSON/table) that a short digest can faithfully
  describe scores higher than dense prose or a code diff, where detail is the payload.
- **Size** — tiny outputs are pointless to shed (little gain, nonzero risk); cap their score.
- **Error-bearing output scores LOW** (protect it): tracebacks and error text are exactly what
  the model needs verbatim to recover. Wave 1's lesson — an error's content is load-bearing.

Return a bounded integer 0–10 plus a short machine-readable reason (e.g.
`{ score, reason: "ref-backed|redundant|structured|error-bearing|small" }`) for observability.

**Hard rules:** pure (no I/O, no clock, no randomness), total (never throws — invalid input ⇒
lowest score, i.e. **protect**), and **bounded work** (cap bytes inspected; never scan a 10MB
blob linearly, sample it).

**Test:** each signal moves the score in the correct direction; ref-backed > non-ref-backed;
error-bearing output is protected (low score); hostile/huge/binary input returns safely and fast;
identical input ⇒ identical score (determinism).

### Fix 2 — Substitutability cascade in compaction

**Anchors:** `src/memory-condenser.js:2672` (`liveContextRecentBoundary`), `:2688`
(`liveContextSummaryStart`), and `prepareContextLedgerCandidate` (~`:518`).

Today the boundary is the *only* decision. Add a cascade **inside the region eligible for
compaction**: walk a threshold from **high score down to low** (their 7→1; pick our own
constants and name them), shedding the most-substitutable entries first and **stopping as soon as
the context is under budget**. Entries below the floor are never auto-shed.

Preserve every existing invariant:
- **Tool-call/result pairing must stay intact** — `adjustLiveToolPairBoundary` /
  `adjustLiveToolPairSummaryStart` exist for a reason. Never orphan a tool call.
- **Reversibility** — the ledger's restore path (`attachContextLedgerRestore`) must still work.
- **Determinism** — same conversation + same config ⇒ same result. Ties broken deterministically
  (e.g. by age), never by iteration order of a Map.
- **Fail-open** — any error in scoring or cascading ⇒ fall back to today's positional behavior
  exactly. This must be a strict improvement or a no-op, never a regression.

**Default OFF** behind an env flag (e.g. `OPENAGI_VALUE_AWARE_COMPACTION=1`) for one release, so
it can be validated live before becoming the default. State the flag in `CHANGES.md`.

**Test:** given entries with mixed scores, the most-substitutable are shed first; a
low-score/error-bearing entry survives while high-score entries around it are shed; the flag off
⇒ **byte-identical** behavior to today (regression lock); tool pairs never orphaned; restore
still reconstructs; deterministic across runs.

### Fix 3 — Current-task protection

Their mild stage only replaces **non-current-task** results (`mildCurrentTaskRatio: 0.8`). We
have no such concept.

Define "current task" conservatively from information already available in the turn — the most
recent N hops, and/or entries sharing the active tool-call lineage. **Reuse Wave 1's
`src/turn-progress.js` and the `outputSignature` machinery** (`tool-registry.js:1036-1055`,
`toolFailureFingerprint`) rather than inventing a parallel notion of "recent."

Current-task entries are **exempt** from the mild cascade (they may still be touched by the
aggressive/emergency stages in Fix 4, which exist precisely to prevent a hard context overflow).

**Test:** a current-task entry with a high substitutability score is NOT shed by the mild
cascade; the same entry IS eligible under emergency; the definition is deterministic.

### Fix 4 — Graded ladder (mild → aggressive → emergency)

Today we have effectively one compaction trigger. Adopt their **graded ladder** shape, with our
own constants and env overrides:

| Stage | Trigger (fraction of budget) | Behavior |
|---|---|---|
| **mild** | ~0.50 | Substitutability cascade (Fix 2), current-task protected (Fix 3) |
| **aggressive** | ~0.85 | Widen: include current-task, shed lower-score entries too |
| **emergency** | ~0.95 | Shed until back **down to a target** (~0.60), not merely under the line |

The **emergency-with-target-ratio** is a genuine safety property worth having: recovering to 60%
prevents thrashing where each turn re-triggers compaction at 95%.

Also port their **quick-estimate optimization**: use a cheap heuristic token/char estimate to
skip the expensive precise count when clearly under threshold, but **force a precise recount every
N consecutive skips (their N=5)** to prevent drift. We already have
`contextEstimateCharsPerToken` — build on it, don't duplicate.

**Fail-open** at every stage. Each threshold env-tunable.

**Test:** each stage fires at its threshold and not before; emergency recovers to the target, not
just under the trigger; quick-skip streak forces a precise recount at N; a precise-count error ⇒
falls back to precise/legacy path, never skips compaction silently.

### Fix 5 — RRF hybrid retrieval

**Anchor:** `src/vector-store.js:93` `async search(namespace, queryText, { limit, minScore })` —
currently **cosine-only** (`:106` via `cosine()` from `embeddings.js:100`). No BM25, no fusion.

Add **Reciprocal Rank Fusion** as a pure exported helper (~40 LOC, zero deps):

```
rrfScore(item) = Σ over lists of 1 / (k + rank + 1),  k = 60
```

Merge ranked lists by a stable id, sum scores for items present in multiple lists, sort
descending. Then combine the existing cosine ranking with a lexical/keyword ranking over the same
namespace. `memory-system.js` already computes a `textScore` — **reuse that as the lexical list
rather than writing a new BM25**, unless a real BM25 is trivial without deps.

Keep it **additive and reversible**: expose fusion behind an option/flag so the existing
cosine-only path remains the default until validated. Identical inputs ⇒ identical ordering.

**Test:** RRF math matches hand-computed values for known ranked lists; an item ranked highly by
both lists outranks one ranked highly by only one; ties deterministic; empty/single-list inputs
handled; flag off ⇒ current behavior byte-identical.

## Non-goals — do NOT do these

- **Do NOT port their L0→L3 long-term persona pyramid.** Azazel's 3-tier memory is at or ahead
  (see the assessment, §3.1). Lateral motion; explicitly out of scope.
- **Do NOT add ANY dependency.** Not `sqlite-vec`, `js-tiktoken`, `@node-rs/jieba`, `ai`,
  `@ai-sdk/openai`, `node-llama-cpp`, `opik`. openAGI is `"dependencies": {}` — that is the
  repo's defining constraint.
- **Do NOT call an LLM to score entries.** Deterministic proxy only (Fix 1).
- **Do NOT touch the TencentDB/TCVDB cloud path concept** — vendor lock-in, no analogue.
- **Do NOT implement the Mermaid symbolic canvas / `node_id` graph.** Interesting, but
  speculative and much larger; a separate evaluation if we ever want it.
- **Do NOT change the memory tiers** (`src/memory-system.js`). Out of scope.

## Attribution (required)

Add to the header of files carrying the ported rules (Fix 2's cascade and Fix 5's RRF).
Precedent: `src/error-classifier.js:1`.

```js
// Portions adapted from TencentDB Agent Memory
// (https://github.com/TencentCloud/TencentDB-Agent-Memory), MIT.
// Copyright (C) 2026 Tencent. Derived from commit 104e9d8:
// src/core/store/search-utils.ts (Reciprocal Rank Fusion) and
// src/offload/hooks/llm-input-l3.ts (substitutability score cascade).
```

## Hard constraints

- Verified baseline `tests 2108 · pass 2084 · fail 0 · skipped 24`. Final suite: **fail 0**,
  **≥2084** plus your new tests. Re-measure before editing.
- **Zero new dependencies.**
- Do **NOT** restart the live daemon. Do **NOT** merge to `main`. No `git reset --hard`.
- **Every behavior change fail-open and flag-gated**, so a bug degrades to today's behavior.
- Compaction must stay **reversible and deterministic** — those are existing invariants of the
  context ledger and are not negotiable.
- One commit per fix, each with a test that fails before and passes after.

## Deliverables

1. Five commits, in order 1 → 5 (Fix 1 is the foundation; 2–4 build on it; 5 is independent and
   can land any time).
2. A test per fix; suite green at ≥2084 pass / 0 fail.
3. `CHANGES.md` per fix: what changed, the anchor, the locking test, **the env flag name and its
   default**, and anywhere reality differed from this spec.
4. Push the branch. Do not merge.
5. **Finish by appending this exact literal line as the last line of `CHANGES.md`:**

```
CONTEXT VALUE WAVE 3 COMPLETE
```

If a fix can't be completed, say so explicitly in `CHANGES.md` and **still write the marker**.

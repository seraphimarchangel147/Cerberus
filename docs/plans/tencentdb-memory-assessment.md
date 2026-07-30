# TencentDB Agent Memory — Port Assessment for openAGI

**Author:** Seraphim · **Date:** 2026-07-29
**Upstream pinned:** `TencentCloud/TencentDB-Agent-Memory` @ `104e9d8`
npm `@tencentdb-agent-memory/memory-tencentdb` **v0.3.6**
**License:** **MIT** ✅ (GitHub API reports `NOASSERTION` only because Tencent wraps the MIT
text in a custom preamble — the `LICENSE` file states "licensed under the MIT" and contains
the verbatim MIT grant. Not a blocker.)
**Scale:** 9,362 ★ · 899 forks · TypeScript · 102 non-test source files · **~32.1K LOC**
· 383 open issues · created 2026-04-07, pushed 2026-07-29 (very active)

---

## TL;DR — read this first

**This is not a memory library. It is a HermesAgent plugin for our exact stack.**
`package.json` declares `"peerDependencies": { "hermesagent": ">=2026.3.7" }`, topics include
`hermesagent-plugin`, and the repo ships a `hermes-plugin/` directory. That makes it far more
relevant than the usual "port some ideas" survey — but also means **it targets HermesAgent
(my harness), NOT openAGI (Azazel's harness).** It cannot be dropped into Cerberus.

**The valuable half is NOT the long-term memory we just upgraded.** Their L0→L3 persona
pyramid is genuinely good, but Azazel's 3-tier memory (short/medium/long with TTL, decay,
repetition-gated promotion, locked corrections that promote instead of expiring) is already
**at or above** this design — see [[azazel-vs-hermes-memory-and-skills]]. Porting their
long-term layer would be lateral motion at best.

**The valuable half is their SHORT-TERM symbolic offload**, which addresses a real,
measurable gap in openAGI: **our context compaction is positional, theirs is scored.**

---

## 1. Architecture (verified by reading source)

Two independent pillars. Treat them separately — the repo's own benchmark table does.

### Pillar A — Long-term memory layering (`src/core/`, ~21K LOC)

A semantic pyramid: **L0 Conversation** (raw dialogue) → **L1 Atom** (atomic facts) →
**L2 Scenario** (scene blocks) → **L3 Persona** (user profile). Files map cleanly:
`core/conversation/l0-recorder.ts`, `core/record/l1-{extractor,dedup,reader,writer}.ts`,
`core/scene/scene-extractor.ts`, `core/persona/persona-generator.ts`.

Storage is deliberately **heterogeneous**: bottom layers (facts, logs, traces) go to SQLite
for retrieval; top layers (personas, scenes) are **human-readable Markdown** for density and
white-box inspection. Their stated principle — *"lower layers preserve evidence; upper layers
preserve structure"* — with a guaranteed drill-down path from any abstraction back to ground
truth, so compression is never irreversible.

Retrieval is hybrid: `core/store/sqlite.ts` (2,331 LOC) does FTS + `sqlite-vec` vector search,
fused by **Reciprocal Rank Fusion** in `core/store/search-utils.ts` (62 LOC, `RRF_K = 60`).
Auto-capture / auto-recall hooks live in `core/hooks/`.

### Pillar B — Symbolic short-term offload (`src/offload/`, ~10.6K LOC) ⭐

This is where their token numbers come from. Mechanism:

1. Verbose tool output is **offloaded to external files** (`refs/*.md`).
2. What stays in context is a **high-density Mermaid graph** of task state, carrying `node_id`s.
3. The agent reasons over the symbol graph and **greps a `node_id`** to pull full raw text when
   it needs to verify a detail — so token cost drops without losing traceability.

The compaction ladder is genuinely engineered, not a threshold hack (`src/offload/types.ts`
`PLUGIN_DEFAULTS`, all verified):

| Stage | Trigger | Behavior |
|---|---|---|
| **Mild** | `≥0.50` of context window | Replace **non-current-task** tool results, chosen by **score cascade** |
| **Aggressive** | `≥0.85` | Delete oldest-prefix messages (`aggressiveDeleteRatio: 0.4`) |
| **Emergency** | `≥0.95` | Delete until back down to `emergencyTargetRatio: 0.6` |

The mild stage is the interesting part (`hooks/llm-input-l3.ts:402` `compressByScoreCascade`):
each offload candidate carries a **score**, and the cascade walks a threshold from
`MILD_CASCADE_INITIAL_SCORE = 7` **down** to `MILD_CASCADE_FLOOR_SCORE = 1`, shedding
highest-scoring entries first and stopping as soon as it's under budget. Plus a real
performance detail worth stealing: a **quick heuristic token estimate** skips full tiktoken
when clearly under threshold, force-recomputing precisely every
`MAX_CONSECUTIVE_QUICK_SKIPS = 5` to prevent drift (`hooks/after-tool-call.ts:416-422`).

#### ⚠️ What the score actually means (I got this wrong on first read — corrected)

The score is **NOT "importance."** It is **substitutability**: how safely the summary can
replace the original text. From `local-llm/prompts/l1-prompt.ts:26` (translated from Chinese):

> `"score"` (**required**): analyze how substitutable the summary is for the original text,
> combining information density and task purpose, on a range of 0–10 — **closer to 10 means
> the summary can better replace the original**.

So the cascade sheds **score=10 first** (summary is a near-perfect stand-in ⇒ cheapest to
replace) and protects **score=1** (summary would lose real information). That is the inverse
of an importance ranking, and it is a **much better-designed rule than "drop the unimportant
stuff"** — it asks *"what can I compress without losing anything?"* rather than
*"what do I care about least?"* Two different questions; theirs is the safe one.

**Who assigns it:** a **small local LLM** (`local-llm/llm-caller.ts`, OpenAI-compatible
endpoint, thinking disabled, `node-llama-cpp` peer dep) summarizes each tool call/result pair
into dense JSON and emits the score alongside. `entry.score ?? 5` (`:428`, `:446`) is only the
fallback when the scorer didn't produce one.

**Implication for us — this is the real cost of the port.** The scoring is not a heuristic we
can lift in 40 lines; it requires **an auxiliary LLM call per tool pair**. Any openAGI
implementation must decide between (a) a cheap deterministic proxy for substitutability
(compressibility ratio, output entropy, structured-vs-prose, whether a `ref` already
round-trips losslessly) or (b) wiring a genuine small-model summarizer lane. **(a) is the
right first step** — it keeps zero-dep and needs no new model, and openAGI already has the
ref/spill machinery that makes "is this losslessly recoverable?" a cheap local question.

---

## 2. Their claims — and how much weight they carry

| Capability | Benchmark | Base | With plugin | Δ |
|---|---|---|---|---|
| Short-term | WideSearch | 33% | 50% | **+51.5% rel**, **−61.4% tokens** |
| Short-term | SWE-bench | 58.4% | 64.2% | +9.9%, −33.1% tokens |
| Short-term | AA-LCR | 44.0% | 47.5% | +8.0%, −31.0% tokens |
| Long-term | PersonaMem | 48% | 76% | +59% rel |

**Unverified — we ran none of this.** These are vendor self-reports with no third-party
replication I checked. Two things do make them more credible than typical README numbers:
they're measured over **long-horizon sessions** (SWE-bench = 50 consecutive tasks per session,
i.e. real context-accumulation pressure, not isolated turns), and the *shape* is consistent —
biggest win on WideSearch, the most tool-log-heavy workload, which is exactly where
offloading verbose output should pay. The mechanism predicts the result, which is a good sign.

But note the honest reading: **the short-term gains are token-efficiency gains that convert
into pass-rate gains.** Same axis Cline's campaign landed on — see
[[cline-rsi-vs-openagi-harness]]: less waste in context ⇒ better outcomes AND lower cost.

---

## 3. Where openAGI actually stands (audited @ `7b17563`)

### 3.1 Long-term memory — we're AT OR AHEAD ✅ (don't port)

`src/memory-system.js` already has: 3 tiers (`short: 100 / medium: 500 / long: 1000` items),
TTLs (`short` 8h, `medium` 45d, `long` ∞), strength decay, promotion gated on
repetition/risk/novelty, and — better than theirs — **locked user corrections that neither
decay nor get evicted, and promote upward past their TTL so a correction becomes long-term
intuition** (`memory-system.js:121-123`). Scoring blends tier + kind + recency
(`:228-235`). Plus a separate memory-tree projection, and `memory-condenser.js` at 3,209 LOC.

We just upgraded this. **Their persona pyramid is not an upgrade over it.** Skip.

### 3.2 Retrieval fusion — REAL, SMALL GAP ⚠️

Ours: `vector-store.js` (314 LOC) is **cosine-only** — `cosine(queryEmbedding, entry.embedding)`
at `:106`, `embeddings.js:100`. Grep for `bm25|hybrid|rerank` across `vector-store.js`,
`memory-system.js`, `embeddings.js` returns **nothing**.

Theirs: FTS + vector fused by **RRF**. `search-utils.ts` is 62 LOC, zero dependencies, pure
function. That is the single most portable thing in the entire repo.

`memory-system.js` does have keyword-ish `textScore` blending, so we're not purely vector —
but there is no principled rank fusion. Worth ~40 lines.

### 3.3 Context compaction — THE REAL GAP ⚠️⭐

We already offload: `spillModelToolOutput` / `capToolOutput` (`model-provider.js:2453-2465`),
`tool-output-store.js` (835 LOC), `spill-store.js` (578 LOC), with refs and a
`DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8000` cap. **So the offload half exists.**

What's missing is *how we choose what to shed*. Ours is **positional**:
`contextKeepRecentHops` → `liveContextRecentBoundary()` → everything older than the boundary
gets folded into **one digest** (`memory-condenser.js:523-560`). A single-axis
"keep recent N, summarize the rest" rule.

Grep for `score|priority|rank|importance|relevan` in `tool-output-store.js` and
`spill-store.js` → **zero hits.** We have **no notion of per-entry value.**

Consequence: a high-value tool result (the diff we're mid-merge on) and a worthless one
(a `ls` from 40 hops ago) are treated identically if they're the same age. Their score cascade
sheds by **value first, recency second**, and their mild stage explicitly protects
**current-task** entries (`mildCurrentTaskRatio: 0.8`) — we have no current-task concept in
compaction at all.

**This is the port.** Not their plugin — the *rule*: score entries, shed lowest-value first
via a descending cascade, protect current-task, and keep a graded ladder
(mild → aggressive → emergency) instead of one boundary.

### 3.4 Hook surface — BLOCKER for direct reuse ⚠️

Their offload is built entirely on host hooks: `before_agent_start`, `before_prompt_build`,
`before_prompt_guard`, `after_tool_call`, `after_tool_call_pre_emergency`,
`before_prompt_build_flush`.

openAGI's `hook-registry.js` (649 LOC) exposes essentially **`pre_tool_call`** (`:88`, via
`beforeToolCall`/`runVeto`) — a **veto** gate, not a context-mutation lane. We have **no
`after_tool_call` hook and no `before_prompt_build` hook**, and our compaction is called
inline from `model-provider.js`, not through the hook registry.

So even setting aside the `hermesagent` peer dependency, their plugin has nowhere to attach in
Cerberus. Any adoption is a **reimplementation against our inline compaction path**, not a
plugin install.

---

## 4. Port verdict

### Worth taking (as rules, reimplemented)

| Item | Effort | Why |
|---|---|---|
| **RRF rank fusion** | S | 62 LOC, zero deps, pure function. Closes a real cosine-only gap. Highest value-per-line in the repo. |
| **Substitutability-cascade shedding** ⭐ | M–L | Fixes our genuine positional-only blind spot. Port the *rule* (shed what a summary can safely replace) with a **deterministic proxy scorer**, not their per-pair LLM call. |
| **Graded ladder** (mild/aggressive/emergency w/ target ratio) | M | Strictly better than one boundary; emergency-with-target-ratio is a real safety property. |
| **Current-task protection** in compaction | S | We have no such concept; cheap and high-impact. |
| **Quick-estimate w/ forced periodic recompute** | S | Nice perf pattern: cheap heuristic + anti-drift every 5 skips. |
| **Mermaid symbolic canvas + `node_id` drill-down** | L | Genuinely novel. Speculative for us — evaluate, don't commit. |

### Bloat / NOT porting

- **The plugin itself.** Peer-depends on `hermesagent`; targets my harness, not Azazel's.
  Cannot be installed into openAGI.
- **Their L0→L3 long-term pyramid** — we're at or ahead (§3.1). Lateral motion.
- **TencentDB / TCVDB cloud backend** (`tcvdb.ts` 1,218 + `tcvdb-client.ts` 297 LOC) — vendor
  lock-in, remote calls. openAGI is local-first and **zero-dependency**; hard no.
- **The dependency tree.** 11 runtime deps incl. `@ai-sdk/openai`, `ai`, `sqlite-vec`,
  `@node-rs/jieba` (native), `js-tiktoken`, `undici`, `zod`, plus a `node-llama-cpp` peer.
  **openAGI has `"dependencies": {}` — literally zero.** Adopting any of this would break the
  repo's defining constraint. Reimplement; never import.
- **`opik` tracing** (373 LOC) — optional vendor telemetry, no analogue.
- **`@node-rs/jieba`** — Chinese word segmentation; irrelevant to us and a native build.

### License

MIT, permissive. Attribution header for any derived file:

```js
// Portions adapted from TencentDB Agent Memory
// (https://github.com/TencentCloud/TencentDB-Agent-Memory), MIT.
// Copyright (C) 2026 Tencent. Derived from commit 104e9d8:
// src/core/store/search-utils.ts (Reciprocal Rank Fusion) and
// src/offload/hooks/llm-input-l3.ts (mild score-cascade compaction).
```

Precedent: `src/error-classifier.js:1` already carries an OmniRoute attribution line.

---

## 5. Recommendation

**Do not touch Azazel's long-term memory again — it's ahead of this repo.** The upgrade we
just shipped stands.

**Two things are worth doing, and neither is a "memory" change:**

1. **RRF fusion** into `vector-store.js` — small, self-contained, closes a measurable gap.
2. **Score-cascade + graded ladder + current-task protection** in the compaction path
   (`model-provider.js` / `memory-condenser.js` / `spill-store.js`) — this is the one with
   real upside, and it rhymes exactly with what Wave 1 is already doing: making the harness
   shed *by value* instead of *by position*, the same way Fix 5/6 make it decide *by progress*
   instead of *by clock*.

**Sequencing:** Wave 1 (Cline RSI port) is mid-flight with Zed right now on
`codex/cline-rsi-wave-1`. This should be **Wave 3**, after the Wave 2 mutation-lease work —
Fix 5 introduces output-signature hashing that a scored-shedding implementation can reuse
rather than duplicate.

---

## 6. Verified vs NOT verified

**Verified by reading real source (clone @ `104e9d8`):**
- `LICENSE` full text (MIT under a Tencent preamble); `package.json` deps/peerDeps/topics
- `src/` layout, 102 non-test files, ~32.1K LOC; `core/` and `offload/` LOC breakdowns
- `PLUGIN_DEFAULTS` ratios in `offload/types.ts:226-244` (0.5 / 0.85 / 0.95 / 0.6, etc.)
- `compressByScoreCascade` + `MILD_CASCADE_INITIAL_SCORE=7`/`FLOOR=1`
  (`hooks/llm-input-l3.ts:114-115, 402-544`)
- quick-skip heuristic `hooks/after-tool-call.ts:416-422`
- `search-utils.ts` RRF in full (`RRF_K = 60`)
- hook names via grep across `src/`
- **openAGI:** `memory-system.js` tiers/TTL/locked-promotion, `vector-store.js` cosine-only
  (bm25/hybrid grep empty), `spillModelToolOutput`/`capToolOutput` at `model-provider.js:2453`,
  `contextKeepRecentHops` → `memory-condenser.js:523-560` positional boundary, score-grep on
  spill/tool-output stores empty, `hook-registry.js` exposing only `pre_tool_call`
- openAGI `"dependencies": {}` confirmed

**NOT verified:**
- **Every benchmark number is Tencent's self-report.** We ran no benchmark and cannot run
  theirs. No third-party replication checked. Treat the table as claims.
- Never executed this code — no install, no runtime behavior observed. Static reading only.
- **Corrected mid-assessment:** I first read the cascade score as an *importance* ranking. It
  is **substitutability** (`local-llm/prompts/l1-prompt.ts:26`), which inverts the shed order
  and materially changes the port design (deterministic proxy vs. per-pair LLM call). Flagging
  because the first framing was wrong and the correction came from reading the prompt, not the
  cascade code — reading only the consumer would have shipped an inverted rule.
- Did not audit how the scorer behaves in practice (score distribution, failure modes when the
  local LLM returns garbage, or how often `?? 5` fallback fires).
- Did not audit their SQLite schema, migration paths, or the 383 open issues for known defects.
- No openAGI change made or tested; repo left clean. Assessment only.

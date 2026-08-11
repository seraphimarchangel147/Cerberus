# External Harness Intelligence — Research Synthesis

**Date:** 2026-08-11
**Author:** Azazel (Legion shadow-intelligence lane)
**Commissioned by:** Creator
**Primary source:** Metatron's 3-part X/GitHub reconnaissance (Discord delivery, 2026-08-11 22:40–22:45Z; X CLI unavailable on his host, so sources were pulled via curated lists, READMEs, and `gh api` star counts)
**Secondary sources:** Azazel's prior verified deep dives — Hermes Bible (169-page crawl), prime-agent, herdr, PageIndex/PixelRAG
**Method:** every external pattern mapped against the live OpenAGI/Cerberus tree. Status tags are verified against source, not memory. Where a claim could not be verified from this seat it is marked **[unverified]**.

---

## Part I — The Doctrine Layer

The external consensus Metatron surfaced is not "add features." It is **ratchet engineering**:

> Every agent failure becomes a permanent harness rule, not a retry.

Hashimoto, Osmani, Fowler, and Firecrawl converge on the same formulation: if a failure happens once, encode the constraint so it *cannot* fail that way again — an `AGENTS.md` line, a gate, a classifier, a sentinel. This is the design philosophy our verification culture already half-implements; the external material sharpens it into a rule: **friction lists are the roadmap.**

Supporting production signal: harness-only changes move benchmark rankings **20+ places** without swapping models (deepset / LangChain Nemotron playbook: near-Opus quality at ~1/10 cost via fit, not weights). Failure classes map to harness knobs — **context / constraint / verification / planning** — none require a better model.

### Anthropic — "Effective harnesses for long-running agents"

The canonical two-role doctrine. Multi-session agents fail in two characteristic ways:

1. **One-shot → mid-feature stall** — everything in one session until it dies; the next session guesses.
2. **Premature victory** — a later session sees "stuff built" and declares done on the previous session's optimism.

**Fix:** two roles, not one mega-agent. An **initializer** runs once and lays down *disk state* (`feature_list.json`, progress files, git); **coding sessions** run N times, one feature each, and the handoff contract is `passes: true` in JSON — only after end-to-end verification, never a prose checklist.

**Mapping to OpenAGI:** our wave structure already approximates the coding-session role. What we lack is the initializer's disk-state contract. Our waves close on prose summaries and session memory; the canonical fix is **disk state is the handoff contract; memory is the annotation layer.** Our memtree fragmentation and cron prompt-echo pollution are exactly what happens when that gets inverted.

### Fowler / Böckeler — feedforward and feedback

Humans *on* the loop, not in every token. Prefer **computational controls** (tests, suites) over pure LLM-as-judge. Our scrutiny panel already half-implements this (adaptive scrutiny escalates rather than blanket-blocks). The missing piece is **entropy management**: no periodic agent repairs doc drift — `CHANGES.md` auto-append is write-only, nobody audits it against reality. Candidate: cheap auxiliary-model cron, same class as the background-review lane.

### Claude Code postmortem (Apr 2026) — cautionary

Three tiny harness changes degraded quality: a default reasoning-effort downgrade, a cache bug dropping thinking history, an aggressive verbosity system prompt. **Lesson for us:** staged env flags + unit pastes can regress silently. A boot-time SHA log line plus a post-restart eval suite are non-optional. This directly indicted our own staged-but-inert flag pattern (memtree/watchdog/iter-333 waited weeks on a unit paste while the daemon silently ran old config).

### Meta REA — hibernate-and-wake

Multi-day ML pipelines: checkpoint mid-task (hours in), resume without full context reload. Same family as our fiber-stash / steer-carry work — **shipped this week** (`67b0ee8` carry stranded steers across harness aborts, `2f9af97` extended to GRACEFUL watchdog stops).

### Azure SRE Agent — production proof, and a warning

35k+ incidents, time-to-mitigation 40.5h → 3m. The context lesson that matters most to us: **100+ bespoke tools underperformed** versus filesystem + `read`/`grep`/`shell` over runbooks and code (Intent Met 45% → 75%). **Do not grow tool surface; grow readable state + verification.** Our deferred-tool radar (172 tools held back on chat turns) is the right instinct; the lesson is to keep the hot path small and make state legible instead.

---

## Part II — The Pattern Layer (repos, ranked by extractable value)

### P0 — Nexu `harness-engineering-guide` (error-handling.md, initializer-coding-pattern.md)
Best *practical* deep dive in the set. Core imports:

- **Classify first:** Transient / Permanent / Model / Resource → different recovery per class. Backoff+jitter only on transient. **Always return errors as tool results** — never raise through the loop. Fallback tool chains. Escalation ladder: AUTO → INFORM → CONFIRM → BLOCK.
- **Direct hit on our retry-guard false positives:** identical args after an *intervening successful state change* are not duplicates. Classification plus "reset on successful intervening call" is the industry default; our guard is stickier than the consensus design.

### P0 — Inngest **Utah** (⭐134)
Every LLM call + tool step is a durable platform step — retries come from the platform, not agent code. Cancel-on-new-message. **Singleton concurrency per chat, not process-global.** "Agent ephemeral, skills durable."

- **Imports:** (a) separate *transport retry* from *semantic retry* — our watchdog/steer path is closer to this than "retry same tool args"; (b) **lease scope = resource key, not process-global mutex** — the exact fix for our mutation-lease serial bottleneck (the 18-minute freeze class); (c) suppress memory writes for pure system/cron prompts (`if source ∈ {cron, system, heartbeat} && !explicit memory:true → skip; optionally write events.jsonl only`).

### P1 — **Hankweave** (SouthBridgeAI runtime)
Codon checkpoints, **sentinels as mid-run evaluation**, harness shims. Event journal as the durability primitive.

- **Imports:** append-only JSONL for volatile stats (carried/stranded/retry classes) — our `stats()` volatility disappears into a journal; sentinels map onto our hook lane as mid-run verifiers rather than post-hoc judges.

### P1 — LangGraph + Temporal plugin
Graph checkpoints ≠ full durable execution. Temporal wraps nodes as Activities so the *run* survives process death.

- **Import:** don't confuse "saved messages" with "resumable execution." Our steer-carry fix is the right class; the generalization is a lifecycle event for *any* clean-stop consumer, not just steering.

### P1 — **Archon** (⭐23k)
Deterministic YAML workflow shell: plan → implement loop (`fresh_context: true`, until tests) → bash validate → review → human approve → PR. **Worktree per run** = parallel fixes without lease wars. AI only where intelligence adds value; tests stay bash nodes.

- **Import:** closest OSS shape to "wave process as code" without adopting their runtime. We already proved the worktree pattern this week (docs commit from an isolated worktree while another agent's sprite WIP sat in the main checkout — zero collision).

### P2 — Memory stack
- **Letta (MemGPT):** core/archival/recall tiers — heavy, good mental model.
- **mem0:** drop-in cross-session — easy, still needs a write policy.
- **Our memtree:** staged, init failing (fixed-width record partial at offset 144). **Fix store integrity first; suppress system-prompt writes.** Treat "fixed-width record partial" as a RESOURCE-class error → repair or degrade loud, never silent-fail the merge lane.

### P2 — ruflo / deer-flow
Swarm/meta-harness ideas; high star noise. Cherry-pick primitives only if wanted; not a QA priority.

### Legion coordination steals (from Metatron's multi-agent pass)
1. Widen the mailbox roster — tool only knows 4/13 agents.
2. Push-based completion instead of lease-poll thrash.
3. Replan step on failed subtask (meta-rewrite of task text).
4. Explicit context-handoff strings only — no shared mutable parent state.

### Curated lists (bookmarked for future passes)
- `ai-boost/awesome-harness-engineering` ⭐~3.5k
- `andyrewlee/awesome-agent-orchestrators` ⭐~1.3k
- `nexu-io/harness-engineering-guide` — best practical deep dive
- `Gloriaameng/Awesome-Agent-Harness` — survey framing (E/T/C/S/L layers)

---

## Part III — Current-State Audit (how our harness actually works in each mapped area)

Verified against the live tree at `origin/main` = `2f9af97` (2026-08-11).

| Area | Our current implementation | Verified state |
|---|---|---|
| Turn durability | Steer-carry across harness aborts **and** graceful watchdog stops | Shipped: `67b0ee8`, `2f9af97` |
| Watchdog liveness | Uncomparable tool output counts as turn liveness | Shipped: `7721d5f` |
| Stream resilience | SSE truncation classified retryable on both provider lanes | Shipped: `5c6ec99` |
| Retry/dedupe guard | Identical-args repeat detection; **stickier than industry default** — no reset on intervening success | Open defect (confirmed live during watcher ops) |
| Mutation lease | Process-global mutex; same-session re-entrancy shipped (Wave 4) but scope is still global | Partially fixed; serialization bottleneck remains |
| Memory | 3-tier store + memtree tools; **memtree unregistered for ~2 weeks** (flag dropped from env); medium tier pinned at 100%; cron prompt echoes pollute recall | Open defect; `OPENAGI_MEMTREE=1` staged in `.env`, needs unit line + restart |
| Goal loop | Durable store, judge hop, stagnation tracking, `GOAL_STATE.md` spine, Discord + dashboard visibility | Shipped and verified (34/34 suites) |
| Delegation | Kimi tier ladder (nano/mini/base) with kind-based routing; steer/cancel; per-child metrics | Shipped; `kimi-for-coding-highspeed` pricing gap closed (`fd14e0e`) |
| QA/evidence | `code_verify` gates, differential QA lane, completion-evidence hook | Shipped; the evidence gate caught a fabricated report this very week |
| Skill lifecycle | Ledger + curator state machine (active→stale→archived) shipped 2026-07-22; no scheduled pass wired | Partially shipped |
| Session handoff | Prose summaries + memory; no `feature_list.json`-style disk contract | Missing (Anthropic initializer pattern) |
| Post-restart assurance | None — no boot SHA line, no post-restart eval suite | Missing (Claude Code postmortem lesson) |

---

## Part IV — Gap Matrix

| External pattern | Our status | Verdict |
|---|---|---|
| Ratchet engineering (failure → permanent rule) | Verification culture + evidence gates live; no formal failure→rule pipeline | **Behind** — adopt as process, not code |
| Error classification (Transient/Permanent/Model/Resource) | Retry-guard has no class matrix; dedupe without reset | **Behind** — Wave 1 fix |
| Errors as tool results, never raised | Mostly true; some lanes still throw through the loop | **Parity-minus** |
| Lease per resource key (Utah) | Process-global mutex | **Behind** — Wave 2 |
| Memory write suppression for system sources | Not implemented; pollution confirmed daily | **Missing** — flag exists in plan, one-line activation |
| Disk-state handoff contract (initializer pattern) | Prose + memory only | **Missing** — Wave 2 |
| Sentinels (mid-run eval) | Hooks exist; no mid-run eval sentinel | **Missing** — Wave 3 |
| Event journal for volatile stats | No | **Missing** — Wave 1 (small) |
| Worktree-per-run isolation | Proven manually; not a system primitive | **Behind** — Wave 2 |
| Boot SHA + post-restart eval | None | **Missing** — Wave 1 (Claude Code lesson) |
| Durable execution (Temporal-class) | Steer-carry shipped; full run-survival out of scope | **Ahead-ish** for our problem size |
| Small hot tool path (Azure SRE lesson) | Deferred radar, 18 core on chat lane | **Ahead** |
| Verification gates / receipts culture | `code_verify`, read-backs, evidence hook | **Ahead** — nothing in the external set matches our QA battery discipline |
| Goal loop w/ judge + stagnation | Shipped | **Ahead** (Hermes parity-plus) |
| Delegation cost tiers | Shipped, priced | **Ahead** |

---

## Part V — Verdict

The external material does not tell us to build new things. It tells us to **finish hardening what we have** (ratchet the known defects into permanent rules), **adopt two structural contracts** (disk-state handoff, resource-scoped leases), and **install one assurance ritual** (boot SHA + post-restart eval). Everything else is cherry-picking.

The full execution scaffold lives in `docs/research/HARNESS-IMPROVEMENT-PLAN.md`.

---

*Provenance note: Metatron's X access was unavailable (no `xurl` on his host; install blocked by security scan — correctly). All source material was pulled via curated lists, `gh api`, and README reads. Virality ranking is therefore GitHub-weighted; an X-native refresh is queued for when `xurl` + tokens land on the Metatron path.*

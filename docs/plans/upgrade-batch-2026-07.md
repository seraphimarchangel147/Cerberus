# SPEC: openAGI/Cerberus upgrade batch — implementation brief for Zed Codex

**Author:** Seraphim · **Date:** 2026-07-27 · **Target repo:** `~/openagi` (Node, ESM, zero-dep preferred)
**Status:** ready to implement. Each work item is independently landable and independently revertable.

---

## 0. Ground rules (read before writing any code)

1. **Zero new npm dependencies.** Everything below is Node stdlib (`fs`, `path`, `crypto`). If you
   think you need a dep, stop and flag it instead.
2. **LICENSE DISCIPLINE — non-negotiable.**
   - `world-model-optimizer` — **NO LICENSE FILE. All rights reserved.** Verified twice (filesystem
     + GitHub API `license: null`). **Do not copy a single line.** Reimplement the *described
     behaviour* clean-room from this spec only. Do not clone it to "check".
   - `OptMem` — **NO LICENSE.** Same rule. The recurrence in §4 is a clean-room restatement; port
     from this spec, never from `memo`.
   - `PageIndex` — MIT. Copyable **with attribution header**.
   - `OmniRoute` — MIT. Copyable **with attribution header**, pin commit `ed7db3e`.
   - `agent-skills` — MIT. Copyable **with attribution header**.
3. **Every item ships with a kill switch** — an env var that restores byte-for-byte prior
   behaviour. Default the risky ones OFF.
4. **Fail-open.** Every new heuristic wraps in `try/catch → fall back to current behaviour`. A
   classifier bug must never break a request.
5. **Do not "fix" `task: "prompt"`.** See §1. It is not a bug. Leave it alone.

---

## 1. ⚠️ CORRECTION — a bug that was reported to you and is NOT REAL

An earlier research pass claimed: *`task: "prompt"` is passed at 4 call sites but is absent from
`TASK_PROFILES`, so it silently resolves to the expensive base model.*

**This is a false positive. I traced it. Do not act on it.**

- The 4 sites (`tool-registry.js:4458`, `hosted-interface.js:3842`/`:3850`,
  `discord-commands.js:1487`) set `task` as a field on a **cron job object**.
- That field is a **job-type discriminator** consumed at `abi-runtime.js:1112`
  (`if (job.task === "prompt") return this.runScheduledPrompt(job)`), a sibling of `"self-qa"`,
  `"autopilot"`, `"signal"`.
- It is **never** passed to `ModelRouter.resolve()`. The only two call sites reaching the router are
  `model-provider.js:3707` and `:4721`, fed by the model-provider's own `task` option.
- `runScheduledPrompt` delegates to `agentHost.handleMessage(...)`, which resolves under its own
  task name. Nothing is mis-billed.

Two identically-named fields in different namespaces. **No fix required.**

**The one real (tiny) improvement in that area:** `ModelRouter.resolve()` silently falls back to
base for any unknown task name, so a genuine typo in a real router call is invisible. Add a
dev-only warning:

```js
// model-router.js, in resolve(), after `const profile = TASK_PROFILES[task];`
if (!profile && process.env.OPENAGI_DEV_WARN === "1") {
  console.warn(`[model-router] unknown task "${task}" → falling back to base model`);
}
```
Guarded by env so it cannot spam production. ~3 lines. That's the whole item.

---

## 2. WORK ITEM A — CUA session identity + Legion-wide desktop lease

**Priority: HIGHEST.** This is the only item fixing a *live correctness hazard* rather than adding
capability.

### A.1 The problem

`computer-use-controller.js` guards concurrency like this (line 63):

```js
if (this._active(context)) {
  throw new Error("A computer-use session is already active for this project session. End it before starting another.");
}
```

Scope of that guard = `ownerFromContext()` (line 723) = `{ projectId, agentSessionId }`.

**That is a per-agent-session mutex over a SINGLE PHYSICAL RESOURCE.** There is exactly one Windows
desktop behind `cua-driver`, shared by every Legion agent (Seraphim, Azazel, Levi, Ziz, Cherubim…).
Two different agent sessions — or two different *agents* — each pass their own `_active()` check and
drive the same mouse simultaneously. Interleaved clicks, typing into whatever window won the race.
Nothing detects it; nothing logs it.

`ComputerUseLog` is already durable (snapshot + journal via `writeJsonAtomic`/`appendJsonLine` under
`resolveDataDir()/computer-use`), so cross-process coordination is viable on disk today.

### A.2 Design — an advisory lease file

New module `src/desktop-lease.js` (~140 LOC, stdlib only).

**Lease location:** `${OPENAGI_DESKTOP_LEASE_PATH || os.tmpdir()}/legion-desktop.lease.json`
Default to a path *outside* any single agent's data dir — every Legion harness must see the same
file. Recommend `/tmp/legion/desktop.lease.json` (WSL `/tmp` is shared across all Linux-side
agents). Document that a Windows-side harness would need the same path mapped.

**Lease record:**
```json
{
  "holder":      { "agent": "seraphim", "pid": 12345, "host": "wsl-ubuntu",
                   "projectId": "default", "agentSessionId": "sess-abc" },
  "sessionId":   "cus_...",
  "goal":        "first 200 chars, for the takeover message",
  "surface":     "desktop",
  "acquiredAt":  "2026-07-27T00:00:00.000Z",
  "renewedAt":   "2026-07-27T00:00:30.000Z",
  "ttlMs":       120000,
  "generation":  7
}
```

**Identity resolution** — new `agentIdentity()` helper, first non-empty of:
`OPENAGI_AGENT_NAME` env → `runtime.config.agentName` → `hostname()`-derived → `"unknown"`.
Include `pid`. This is what makes contention messages actionable ("Azazel holds it") instead of
opaque.

**Acquire algorithm (atomic, no deps):**
1. `fs.openSync(path, "wx")` — exclusive create. Success ⇒ lease acquired, write record, return.
2. `EEXIST` ⇒ read + parse the record.
   - Parse failure / malformed ⇒ treat as expired (log loudly, steal).
   - `now - renewedAt > ttlMs` ⇒ **stale**, steal it: rewrite with `generation + 1`, log a
     `lease-stolen` event with the dead holder's identity.
   - Holder is *us* (same agent + pid + agentSessionId) ⇒ **re-entrant**, renew and proceed.
   - Otherwise ⇒ **contended**. Throw a structured error carrying holder identity, goal, and age.
3. Write is `writeJsonAtomic` (tmp + rename), consistent with the rest of the codebase.

**Renew:** every action in the controller that currently calls `_requireActive(context)` also calls
`lease.renew(sessionId)`. Cheap — one atomic write. If renew finds the lease held by *someone else*
(we were stolen from mid-session), **abort the local session immediately** rather than keep driving
a desktop we no longer own. That is the single most important line in this item.

**Release:** in `end()` (line 111) and in the `catch` at line 93. Release must be idempotent and
must never throw out of a `finally`.

**Crash safety:** TTL is the backstop; there is no cleanup daemon. Default `ttlMs = 120000` with
renew every action. Also opportunistically verify holder liveness via `process.kill(pid, 0)` when
`host` matches ours — a dead PID means instant steal without waiting out the TTL.

### A.3 Wiring

- `start()` (line 42): acquire **after** validation, **before** `this.log.startSession(...)`. On
  contention, throw before any session record exists — no orphan sessions.
- Keep the existing per-session `_active()` check. It's a good local guard; the lease is the global
  one. Belt and braces.
- Log `lease-acquired` / `lease-renewed` / `lease-released` / `lease-stolen` / `lease-contended`
  through the existing `ComputerUseLog` event channel so the audit trail is unified.

### A.4 Kill switch & config

- `OPENAGI_DESKTOP_LEASE=0` → module no-ops entirely (all methods return success). Restores exact
  current behaviour.
- `OPENAGI_DESKTOP_LEASE_TTL_MS` (default `120000`)
- `OPENAGI_DESKTOP_LEASE_PATH`
- `OPENAGI_AGENT_NAME`

### A.5 Tests (required)

`test/desktop-lease.test.js`:
1. acquire → second acquire from a different identity **throws** with holder name in the message
2. acquire → same identity re-acquire is **re-entrant**, not an error
3. expired lease (`renewedAt` backdated past TTL) is **stolen**, `generation` increments
4. release → acquire by another identity **succeeds**
5. malformed/truncated JSON lease file is treated as expired, not fatal
6. `OPENAGI_DESKTOP_LEASE=0` disables every check
7. renew-after-steal **aborts** the local session

---

## 3. WORK ITEM B — Complexity-aware model routing (OmniRoute port)

**Source:** OmniRoute `autoCombo/complexityRouter.ts`, `services/specificityRules.ts`, MIT, commit
`ed7db3e`. Attribution header required.

### B.0 PREREQUISITE — ledger enrichment (do this FIRST, alone)

`~/.openagi/budget/ledger.jsonl` today: 908 rows, **`latencyMs` / `stopReason` / `requestBytes` /
`task` present in 0 of 908**, every row `model: "kimi-k3"`. Zero comparative data.

Nothing data-driven is possible until this lands. ~20 LOC at the ledger write site: add `latencyMs`,
`stopReason`, `task`, `attempt`, `inputTokens`, `outputTokens`. Ship it, let it collect, *then*
evaluate B.1.

### B.1 `src/task-complexity.js` (~120 LOC, pure, zero deps)

Additive 0–100 score from independent detectors over the outgoing request:

| Detector | Signal | Max |
|---|---|---|
| code | fenced blocks, `diff --git`, language keywords | 20 |
| context | payload bytes/tokens (bucketed) | 15 |
| tools | count of tools carried | 20 |
| reasoning | "why/explain/design/architect/trade-off" markers | 15 |
| math | formulae, numeric density | 15 |
| jargon | domain vocabulary | 15 |

Score → tier floor: `<20 nano` · `20–49 mini` · `≥50 base`.

**Two hard rules that matter more than the scoring:**

1. **Tool-use floor.** Any request carrying ≥1 tool is floored at `mini` (their `cheap`) regardless
   of prose triviality. Justification from our own ledger: **502/908 requests carried ≥1 tool.** A
   nano model fumbling a tool-call turn costs a retry, which costs more than the tier upgrade saved.

2. **Context hard-floor — THIS IS A REAL BUG THE RESEARCH AGENT CAUGHT BY RUNNING ITS OWN PORT.**
   `contextScore` caps at 15, which **cannot clear the 20 threshold on its own**. A ~50k-token
   payload therefore scored **13 → nano**. That is exactly the `condense`/`mine`-on-huge-transcript
   case — the worst possible place to silently downgrade. Add an explicit override that bypasses the
   additive score:
   ```js
   if (bytes >= HUGE_CTX) return "base";   // ~32k+ tokens
   if (bytes >= MED_CTX)  return "mini";
   ```
   **Write the failing test first** (50k payload must not resolve nano), watch it fail against the
   naive additive version, then add the floor. Do not skip this — it is the one defect we know is
   waiting.

3. **`escalateTier` is monotone.** It may only ever move a task to a *more* capable tier, never
   less. Worst case is overspend; never a nano model handling a 44k-token tool turn.

4. **Fail-open:** whole classifier wrapped `catch → return null` ⇒ caller uses the static profile.

### B.2 Router integration

`ModelRouter.resolve()` precedence becomes:
```
explicit env/override pin  >  TASK_PROFILES static tier  >  escalateTier(runtime floor)
```
Floor-only insert. A manual pin always wins.

**Kill switch:** `AGENT_ROUTING=static` ⇒ byte-for-byte current behaviour. Default `static` for the
first week; flip to `auto` once the enriched ledger shows the classifier agreeing with reality.

### B.3 `src/error-classifier.js` (~80 LOC)

Classify failures by **status AND body text**:
- `429` + quota/billing language ⇒ `quota-exhausted`, back off **1h** / until reset header
- `429` otherwise ⇒ `rate-limit`, back off **60s**
- **HTTP 200 with empty content ⇒ treat as silent failure and retry** — *except* when
  `stop_reason ∈ {max_tokens, tool_use}`, which are legitimate empty-content terminations.

That last rule is a real bug class we do not currently catch at all.

### B.4 Tier defaults

- `ANTHROPIC_MODEL_NANO=claude-haiku-4-5` — clear win; `observer`/`scrutiny`/`goal` are short,
  bounded, frequent.
- **Leave `MINI` unset initially.** `condense`/`mine`/`plan` all write into memory, so quality loss
  there *compounds* instead of staying local. Unset ⇒ falls back to base ⇒ safe.
- ⚠️ **`claude-haiku-4-5` / `claude-sonnet-4-6` were read from openagi source strings and were NOT
  verified against the live API.** Confirm both model IDs resolve before setting any env var.
- Note `renderModelPlan` currently suggests Haiku for *both* tiers, collapsing the nano/mini split.

### B.5 Explicitly DO NOT PORT

12/13-factor weighted scoring · 19 routing strategies · ε-greedy bandit · SLA/chaos/self-healing ·
DB-backed ELO tables (`taskFitness.ts` imports `getDbInstance` — not portable) · **all 17 "free
endpoint" providers** (their own README flags 15 as ToS-questionable; several are consumer-web
scrapers).

The multi-factor scorer is **inert without a multi-provider pool**. Copy the *shape* of their
`ProviderCandidate` (one object owning provider + model + key + endpoint together) rather than the
scoring math — and note that fixing per-provider instantiation at `model-provider.js:3691`/`:4707`
is worth more than any port on this list.

---

## 4. WORK ITEM C — Budgeted memory + tool-output spill (OptMem + PageIndex)

**⚠️ OptMem has NO LICENSE. Clean-room from this spec only. PageIndex is MIT (attribution).**

### C.1 Why — the deciding evidence

The existing compression path **never fired in 7 days / 672 requests**, and latency is bytes-bound
(>200 KB → 14.9 s; <80 KB → 6.3 s). Eager threshold-triggered compression has a single point of
failure — the trigger — and ours is **silently dead**.

Inverting it fixes the class, not the instance: make the *read* always budgeted, so there is no
trigger left to fail. Memory grows unbounded; bytes injected stay flat. Correctness by construction.

### C.2 `lib/memtree.js` (~300 LOC, stdlib only)

**Store (~60):** `LOG.txt` = every memory as one padded 320-byte record, append-only, never edited.
`TREE/<size>` = one file per power-of-two level, 288-byte records. Position is identity ⇒ O(1) read
via `fs.readSync(fd, buf, 0, REC, i*REC)`; `logLen` is `statSync(size)/LOG_REC`, never a scan.

**Cover (~50) — the core algorithm.** Age-decayed power-of-two tiling: recent memories at full
detail, older ones progressively merged. `cover(T, budget)` binary-searches `alpha` so the tiling
fits the budget, then spends leftover slack subdividing the most recent blocks.

**Merges (~50):** `pending()` = one `statSync` per level (never a scan). Merge requests are emitted
**in-band** on the output of `note()`/`wake()` — no background worker, no second model, no queue.
The agent pays one extra tool call, amortized.

**Commands (~80):** `wake(budget)` · `note(text)` · `merge(lo,hi,line)` · `zoom(lo,hi)` (PageIndex
drill-down) · `recall(regex)` (verbatim grep over LOG.txt).

**Spill — the PageIndex half (~60):** any tool result over `SPILL_BYTES` (~24 KB) is written to
`~/.openagi/spill/<id>` and replaced in context by a skeleton. Segment by structure in priority
order: markdown headings (code-fence aware) → `diff --git` → blank-line paragraphs → fixed 200-line
windows. Emit `[{id, title, lines: "120-180", bytes, firstLine}]`. New tool `read_spill(id, range)`
returns the exact slice.

**Config:** `WAKE_BUDGET` (tune against the 80 KB latency target), `SPILL_BYTES`, `ENTRY_CHARS`
(280).

**Migration:** existing `~/.openagi/memory` notes import one-per-note, oldest first by mtime. Old
summaries are discardable — the tree is a cache and rebuilds from the log.

### C.3 Verification — the part that actually matters

The previous failure was invisible **because nothing counted it.** Emit per-request counters:
`memoryBytesInjected`, `spillCount`, `mergesRequested`, `mergesCompleted`.

`cover()` is pure and trivially property-testable. Required test:
```
for T in 1..10000, for budget in {8,16,32,64}:
  assert cover(T,budget).length <= budget
  assert blocks tile [0,T) exactly — no gaps, no overlaps
```
**That single property test would have caught the entire class of bug we are currently living with.**

### C.4 Reject

**Unstract** — a distributed platform (Django + Celery + Postgres + MinIO + workers) solving
document-ETL for a different buyer. Wildly too heavy. Not embeddable. Skip entirely.

---

## 5. WORK ITEM D — Skill-routing evals (agent-skills)

**MIT, attribution.** ~800 LOC Node, zero deps, fully decoupled from runtime. Verified real: the
research agent ran the upstream harness — **124 checks passed, 86% rank-1 (65/76).**

TF-IDF over skill **descriptions** detects:
1. **trigger regressions**, via a `--min-rank1` CI ratchet
2. **description collisions between skills** ← the live risk

openAGI has no equivalent, and `skills.js:351` lets the agent **author skills at runtime**, so
collision risk grows unattended. Adopt the eval harness; **reject** their 24 skill bodies and
`commands/*.toml` (our skill subsystem is strictly more capable — theirs is flat SKILL.md with no
version field).

Wire `--min-rank1` into CI so a new skill that hijacks an existing skill's triggers fails the build.

---

## 6. WORK ITEM E — Per-domain browser learnings (ego-lite)

**MIT. Adopt the notes plane ONLY, phased.**

Port the `learnings/<domain>/manifest.json` idea: URL-glob-scoped procedural memory that
auto-injects per-site notes when the browser lands on a matching domain. Both halves already exist
here — `skills.js` plus `semantic-browser.js`'s existing `domainChanged` detection is the exact hook
point.

**Phase 1 (do now):** notes plane only — plain text guidance injected on domain match. Copy
`relativeSitePath()` path-confinement **verbatim** (it's the security-relevant bit).

**Phase 2 (gated):** the executable-tool plane uses dynamic `import()` and therefore runs at **full
agent privilege**. Put it behind the approval queue. Do not ship phase 2 with phase 1.

### Explicitly REJECT the rest of ego-lite

The perception algorithm **is not in the repo.** `observe.ts:52` calls `browserEgo().snapshot()`;
`browser-runtime.ts:32` resolves that to `globalThis.ego`, injected by a **closed-source, macOS-only
`.dmg`**. Zero hits for `Accessibility.getFullAXTree`/`DOMSnapshot` outside test mocks. There is
nothing to port, the "2.5×/5× faster" claim is unaudited marketing, and the 5× feature is labelled
"coming soon".

Adopting their driver would also **regress us**: their visual fallback is prose advice, ours is a
SHA-256 screenshot gate; their re-observation is manual, ours is automatic and generation-bound.
Plus macOS-only vs our WSL. Our 2,810-LOC Playwright `semantic-browser.js` stays.

---

## 7. WORK ITEM F — Self-optimization patterns (world-model-optimizer)

**⚠️⚠️ NO LICENSE = ALL RIGHTS RESERVED. Do not clone, do not copy, do not vendor. Clean-room
reimplementation of the three described behaviours only.**

1. **Hash-precondition "copy-not-guess" deltas.** A proposer must echo each target surface's hash;
   `applyDelta` verifies and rejects atomically on mismatch. Identity fields are filled from ground
   truth and **never trusted from the model**. This is our existing `visual_click` hash gate,
   generalized to self-modification.

2. **Evidence-backed reward judge.** *"An agent that claims success without the environment
   confirming it does NOT succeed."* Wire our completion-evidence graph as a reward function —
   every unsupported completion claim becomes a **free deterministic negative**, no labelling
   required.

3. **Strict-improvement tie-break** (`_earliest_best`): on equal scores the **incumbent wins**, the
   successor does not. This is the anti-drift guard — without it a self-optimizing loop random-walks
   through equal-scoring variants forever.

4. **Deterministic `FailureSignature`** — the model never free-texts its own failure label;
   signatures are computed from structured outcome data so failures cluster reliably.

Their `GradedTests` honesty note (19.6% of trials scored 0 while passing ≥1 test) argues for
**graded partial credit** wherever binary pass/fail has no resolution.

**Reject:** their router, distill half, E2B sandbox integration, hosted platform, posthog.

---

## 8. Recommended sequencing

| # | Item | Size | Risk | Gate |
|---|---|---|---|---|
| 1 | **A** — desktop lease | ~140 LOC + tests | low | none — fixes a live hazard |
| 2 | **B.0** — ledger enrichment | ~20 LOC | none | none |
| 3 | **B.1/B.2** — complexity routing | ~120 LOC | med | `AGENT_ROUTING=static` default |
| 4 | **B.3** — error classifier | ~80 LOC | low | none |
| 5 | **D** — skill-routing evals | ~800 LOC, isolated | low | CI-only, no runtime coupling |
| 6 | **C** — memtree + spill | ~300 LOC | **high** | property tests + counters first |
| 7 | **E ph.1** — domain learnings | ~150 LOC | low | notes plane only |
| 8 | **F** — self-opt patterns | design-led | med | clean-room review before merge |

**A first** — it is the only item fixing something already broken. **C is highest-risk** (it touches
the memory path) and must not start before its property tests and counters exist.

Do not batch these into one PR. One PR per work item, each independently revertable.

---

## Completion marker

When every work item you attempted is committed, green, and pushed, append the literal line below
as the LAST line of this file and include it in your final commit:

UPGRADE BATCH PHASE 1 COMPLETE

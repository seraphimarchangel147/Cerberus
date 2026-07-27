# Phase: Hermes-parity autonomous skill lifecycle + budget-as-optional

**Read this document in full BEFORE editing any implementation file.**
Everything below is anchored to real file:line in this repo at baseline
`60754f9`. Do not rebuild subsystems that already exist — the anchors tell you
what is already there and what to change.

Two independent workstreams. Do them in order, commit separately.

---

## Motivation (measured, not hypothetical)

**Incident, 2026-07-27.** The daemon hard-stopped mid-conversation with
`Daily budget reached: $10.0032 of $10.00`. Root cause chain:

1. `kimi-k3` is not in `DEFAULT_PRICES` (`src/budget-guard.js:9-20`), so
   `priceFor()` silently fell through to `prices.default`
   (`{in: 3, out: 15}` — Sonnet-class flagship rates) for every call.
2. Real spend was a fraction of that; the *recorded* spend hit the $10 cap.
3. There is no way to turn the budget off. `check()` at
   `src/budget-guard.js:54-62` tests `day.usd >= this.dailyUsdLimit`, so
   `OPENAGI_DAILY_USD_LIMIT=0` **hard-bricks the daemon** — every call fails
   on the first check. The only working escape was a sentinel ceiling
   (`100000`), which is a lie in every status readout.

**Second finding, same session.** The skill curator (`SkillRegistry.curate()`,
`src/skills.js:527`) runs daily via `createDailySkillCuratorJob`
(`src/cron-scheduler.js:264`) and reports `15 skills checked, 0 transitions` —
every single day. It is not broken; it is **inert by construction**. Read the
exemption ladder at `src/skills.js:551-558`:

```js
if (skill.bundled)              result = "exempt: bundled";
else if (skill.pinned)          result = "exempt: pinned";
else if (!isAgentCreated(skill)) result = "exempt: not agent-created";
else if (!activityAt)           result = "exempt: no activity timestamp";
```

Every installed skill trips one of the first three rungs, so nothing is ever
curated. Worse, the *acquisition* side is fully manual: a mined or observed
skill candidate lands as `status: "pending"`
(`src/skill-materialize.js:100`) in `.openagi/skills-suggested/` and only
becomes a real `SKILL.md` when a human clicks Accept in the dashboard
(`src/hosted-interface.js:3777-3790`). The owner's requirement, verbatim:

> "the skill system should be like Hermes... I shouldn't have to manually go
> into the dashboard and approve and unapprove skills. His harness should be
> able to do that natively and edit them and make them better over time."

So: the harness must acquire, improve, and retire its own skills without a
human in the loop, while keeping every mutation reversible.

---

## Reference implementation — READ IT

`docs/plans/reference/hermes-curator-excerpt.py` is a verbatim excerpt of
Hermes' own curator (`agent/curator.py`, lines 85-400). It is the behavioural
target. Study these specific semantics and port them:

- **Config-driven gates, not hardcoded exemptions** — `is_enabled()`,
  `get_stale_after_days()`, `get_prune_builtins()`, `get_consolidate()`.
  Note that `prune_builtins` defaults to **True**: Hermes *does* curate its
  bundled skills. That is the key difference from our current ladder.
- **Seeded baselines** (`seed_record_if_missing`, `counts["seeded"]`) — the
  first time a newly-eligible skill is seen, anchor its inactivity clock to
  *now* and defer. Never archive something on the first pass just because it
  has no history.
- **Never-used grace floor** — `use_count == 0` skills are not archived until
  they are at least `stale_after_days` old. "Absence of evidence is not
  evidence of staleness."
- **Reactivation** — a skill used again after being marked stale returns to
  active. The transition is bidirectional.
- **Referenced-elsewhere protection** — `_cron_referenced_skills()`: a skill
  named by any cron job (including paused/future jobs) is never transitioned.
- **Deferred first run** — `should_run_now()` seeds `last_run_at` and returns
  False on the very first observation rather than mutating the library
  immediately after an update.

Where the reference is better than this spec, **follow the reference** and
note the deviation in `CHANGES.md`.

---

## Workstream A — Budget as a genuinely optional guard

### A1. A real disabled state (no sentinel arithmetic)

**Anchor:** `src/budget-guard.js:25`
```js
this.dailyUsdLimit = options.dailyUsdLimit ?? Number.parseFloat(process.env.OPENAGI_DAILY_USD_LIMIT ?? "10");
```

**Bug:** there is no representable "off". `0` means "block everything",
`Infinity`/`100000` means "lie in every status readout". `Number.parseFloat`
of a non-numeric string yields `NaN`, and `day.usd >= NaN` is `false` — so
today a typo silently disables the guard by accident. That accidental path is
the only "off" that exists, and it is invisible.

**Fix:**
1. Add a `resolveDailyLimit(raw)` exported pure function. Contract:
   - `undefined` / `""` / unset → the default `10`.
   - The literal strings `"off"`, `"none"`, `"unlimited"`, `"disabled"`
     (case-insensitive, trimmed) → `null`, meaning **disabled**.
   - A finite number `> 0` → that number.
   - A finite number `<= 0` → **throw** with a message naming `off` as the
     correct way to disable. Zero must never silently brick the daemon again.
   - Anything else non-numeric → throw the same error. No accidental `NaN`
     disable.
2. Store the result as `this.dailyUsdLimit` (`number | null`). Add a getter
   `get enabled() { return this.dailyUsdLimit !== null; }`.
3. `check()` (`src/budget-guard.js:54`): **short-circuit first** —
   `if (!this.enabled) return;` before touching `state.days`. No arithmetic
   against a sentinel.
4. `status()` (`src/budget-guard.js:36-52`): when disabled, report
   `dailyUsdLimit: null`, `remainingUsd: null`, `enabled: false`. Keep
   `spentUsd`, `calls`, `tokens`, and `history` fully populated — **spend is
   still tracked and still visible when the cap is off.** Disabling the guard
   must not blind the operator.
5. `record()`/`addUsd` (around `src/budget-guard.js:130`) keeps accumulating
   unchanged; the returned `limit` field becomes `null` when disabled.

**Required tests** (`test/budget-guard.test.js`, extend or create):
- `resolveDailyLimit` table test covering every branch above, including that
  `"0"` and `"-5"` **throw** and `"off"`/`"OFF "`/`"none"` yield `null`.
- A disabled guard: 1000 recorded calls totalling far above any cap, then
  `check()` does not throw, and `status().enabled === false` while
  `status().spentUsd > 0`.
- An enabled guard still throws at the boundary exactly as before (regression:
  `day.usd >= limit`).

### A2. Warn on unpriced models — the silent mispricing must not recur

**Anchor:** `priceFor()` at `src/budget-guard.js:133-144`. The
longest-prefix fallback to `this.prices.default` is silent.

**Fix:**
1. Add `"kimi-k3"` to `DEFAULT_PRICES` with its real published rates. If you
   cannot verify the rates from a source, use
   `{ in: 0.6, out: 2.5, cacheRead: 0.06, cacheWrite: 0 }` and add a
   `// TODO(pricing): verify against provider docs` comment naming the date —
   do **not** silently guess without marking it.
2. `priceFor(model)` returns the price **and** records the resolution mode.
   When neither an exact key nor a prefix matched and `prices.default` was
   used, emit **once per distinct model id per process** (dedupe via a
   `Set` on the instance — never log per call, that would flood):
   ```
   [budget] model '<id>' has no price entry; billing at default rates
   (in $3/out $15 per 1M). Recorded spend for this model is an ESTIMATE and
   may be wildly wrong. Add it to DEFAULT_PRICES in src/budget-guard.js.
   ```
   Route it through the same warn channel the rest of the runtime uses
   (`console.warn` is acceptable if there is no injected logger; prefer an
   injected `options.warn` with a `console.warn` default, matching
   `SkillRegistry`'s pattern at `src/skills.js:49`).
3. Surface it in `status()` as `unpricedModels: string[]` so the dashboard
   Credits pane can show a warning badge.

**Required tests:** unpriced model warns exactly once across three calls;
a priced model and a prefix-matched model (`gpt-5-nano` must NOT match
`gpt-5`'s flagship entry — that regression is already guarded, keep it) warn
zero times; `status().unpricedModels` lists the offender.

### A3. Dashboard toggle

**Anchor:** the `/budget` route already exists in `src/hosted-interface.js`
(grep `"/budget"`). The auto-approve toggle at
`src/hosted-interface.js:2749-2760` is the pattern to copy — it reads
`autoApproveEnabled()` and mutates `process.env` so the next read sees it
immediately.

**Fix:** add `POST /budget/limit` accepting `{ limit: number | "off" }`.
It must run the same `resolveDailyLimit` validation (reject `0` with the
same error text — the API and the env var must not disagree), update the live
`BudgetGuard` instance, and persist so a restart keeps the setting. In the
Credits pane render a real tri-state control: a numeric input plus an
explicit **Disabled** state. The UI must never write `0` to mean off.

---

## Workstream B — Autonomous skill lifecycle (Hermes parity)

The goal state: the agent acquires, improves, and retires skills on its own.
The dashboard becomes an *observation and override* surface, not a gate.

### B1. Auto-materialize high-confidence skill candidates

**Anchor:** `src/skill-materialize.js:100` sets `status: "pending"`.
`src/hosted-interface.js:3777-3790` is the human-click path that calls
`createSkillFromCandidate` / `createSkillFromSuggestion`.

**Bug:** every mined skill requires a dashboard click. Candidates accumulate
unread in `.openagi/skills-suggested/` forever.

**Fix:**
1. New module `src/skill-autocurator.js`. Export
   `autoMaterializeCandidates({ runtime, now, env })`.
2. It reads pending candidates via the existing aggregator
   `listAllSuggestions(runtime, { status: "pending" })`
   (`src/suggestion-feed.js:29`) — **reuse it, do not re-walk the dirs.**
3. Filter to `category === "skill"`, then auto-accept a candidate only when
   **all** hold:
   - `sequence.confidence >= OPENAGI_SKILL_AUTO_CONFIDENCE` (default `0.8`);
   - `sequence.count >= OPENAGI_SKILL_AUTO_MIN_OCCURRENCES` (default `3`) —
     a pattern seen once is a coincidence;
   - the candidate has a non-empty `proposal.body` (or `draftBody`);
   - no existing active skill has the same slug (the writer already dedupes —
     confirm, don't duplicate the logic);
   - the daily auto-creation budget is not exhausted:
     `OPENAGI_SKILL_AUTO_MAX_PER_DAY` (default `3`). Persist the counter in
     the data dir keyed by date. An agent that mints 40 skills overnight is a
     failure mode, not a feature.
   Candidates that fail a gate stay `pending` for the dashboard — the manual
   lane keeps working unchanged.
4. Auto-accepted candidates go through the **same** materializers the human
   path uses (`createSkillFromCandidate` / `createSkillFromSuggestion`), then
   `runtime.skills.reload()`. Stamp lineage `createdBy: "skill-autocurator"`
   and `autoAccepted: true` with the gate values that passed, so every
   auto-created skill is auditable and distinguishable from a human-approved
   one.
5. Master switch `OPENAGI_SKILL_AUTOCURATE` — default **on**; `off`/`0`
   restores today's fully-manual behaviour.
6. Emit a `skill-autocreated` runtime event (`runtime.events.emit`) so the
   Discord/dashboard notification lanes can report it. Autonomy without
   visibility is how you lose trust — the agent acts, then *tells* you.

### B2. Fix the inert curator ladder

**Anchor:** `src/skills.js:551-558`.

**Fix:** replace the hard exemptions with configurable policy, mirroring the
reference's `prune_builtins`:

- `bundled` → exempt only when `OPENAGI_CURATOR_PRUNE_BUNDLED` is off.
  Default it **off** (bundled skills ship with the repo and re-seed on
  update, so archiving them is churn) — but make it a real knob and *report*
  the count of skipped-bundled in the report so the inertness is visible.
- `pinned` → **always exempt.** Keep this. It is the user's explicit override.
- `!isAgentCreated(skill)` (`src/skills.js:1464`) → this is the rung that
  actually causes the 0-transitions. Replace with:
  `OPENAGI_CURATOR_SCOPE` ∈ `agent-created` (today's behaviour) | `all`
  (curate anything unpinned/unbundled). Default **`all`**, matching Hermes,
  which prunes built-ins by default.
- `!activityAt` → **do not exempt.** Port the reference's seeding: on first
  sight write a baseline activity record anchored to `now`, count it as
  `seeded`, and skip this pass only. Next pass it ages normally.
- Port the **never-used grace floor**: `views + runs === 0` skills are not
  archived until older than `staleDays`.
- Port **cron-reference protection**: before transitioning, collect skill
  names referenced by any job in the cron scheduler
  (`src/cron-scheduler.js`) and treat them as pinned. A `use_skill` reference
  inside a scheduled job's prompt counts.

The report (`renderCuratorReport`, `src/skills.js:1469`) must gain a
`seeded` count and a per-reason exemption tally, so "0 transitions" is never
again ambiguous between *healthy* and *inert*.

### B3. Self-improvement pass — skills that get better over time

This is the part that does not exist yet at all, and it is the heart of the
request.

**New:** `improveSkills({ runtime, now, env })` in `src/skill-autocurator.js`.

Selection: a skill is an improvement candidate when it has been **used at
least `OPENAGI_SKILL_IMPROVE_MIN_USES` times (default `5`)** since its last
revision, or when a recorded execution failed. Usage lives in the JSONL that
`loadUsage` (`src/skills.js:1338`) already reads — extend the usage record
with an `outcome` field (`ok` | `error`) written by `run()`
(`src/skills.js:897`) and by `use_skill`, defaulting to `ok` for backward
compatibility with existing lines.

For each candidate, run a **single** focused sub-generation through the
existing model provider (the same one `run()` uses at
`src/skills.js:899`) with the skill body plus its recent usage outcomes, and
ask for a targeted patch — not a rewrite. Apply via the existing
`patchSkill` path so `appendSkillRevision` records it and **rollback_skill
still works**. Every autonomous edit must be revertible by exactly the
mechanism that already exists; do not invent a second history.

Hard constraints:
- **Never** touch a `pinned` skill. Ever.
- At most `OPENAGI_SKILL_IMPROVE_MAX_PER_RUN` (default `2`) skills per run —
  this pass costs model tokens and runs under the budget guard.
- The improvement call goes through `budget.check()` like any other model
  call. A disabled budget does not exempt it from the ordinary call path.
- If the returned patch does not apply cleanly (`old_string` not found or
  ambiguous), **skip and log** — do not fall back to a whole-body rewrite.
  A failed patch is a no-op, never a clobber.
- Log every improvement to the edit log with `by: "skill-autocurator"`.

### B4. Wire it into the existing daily job

**Anchor:** `src/abi-runtime.js:1175` (`return this.skills.curate({ now })`),
reached by the `skill-curator` task from
`createDailySkillCuratorJob` (`src/cron-scheduler.js:264`).

Extend that handler to run, in order: `autoMaterializeCandidates` → `curate`
→ `improveSkills`, returning a combined summary
`{ materialized, curated, improved }`. Keep `curate()`'s existing return
shape nested under `curated` so the Discord command at
`src/discord-commands.js:1031` keeps working — check that call site and
update its rendering to show the new counts.

**Required tests** (`test/skill-autocurator.test.js`, new):
- auto-materialize accepts a candidate meeting every gate, and leaves
  `pending` a candidate that fails each gate in turn (one case per gate);
- the daily cap blocks the 4th creation and the counter resets on a new date;
- `OPENAGI_SKILL_AUTOCURATE=off` materializes nothing;
- curator with `scope=all` transitions a non-agent-created stale skill that
  today is exempt (this is the regression proving the inertness is fixed);
- first-sight seeding does not archive, and the second pass does;
- never-used grace floor holds;
- a pinned skill is never transitioned and never improved;
- an improvement patch that fails to apply leaves the file byte-identical.

---

## Hard constraints (environment — you cannot discover these yourself)

- Node repo, **zero runtime dependencies**. Do not add a package. Do not
  create `package.json` dependencies. Standard library only.
- Gate with `node --test`. The suite must be green with **no fewer passing
  tests than baseline** — run it before you start and record the count in
  `CHANGES.md`.
- The live daemon runs from a different checkout under systemd. **Do not
  restart, kill, or touch any running process.** Work in this clone only.
- ASCII only in identifiers and filenames. No Cyrillic/fullwidth lookalikes
  anywhere in the diff — the repo has been bitten by homoglyph corruption
  before and the diff will be byte-scanned on review.
- Commit each workstream separately with a descriptive message. Workstream A
  first (it fixes a live outage), then B.
- Every new env var must be documented in `CHANGES.md` with its default and
  what happens when unset.

## Completion marker

When both workstreams are committed, tested green, and pushed, append the
literal line below as the **last line of this file** and include it in the
final commit:

AUTONOMOUS SKILLS AND BUDGET PHASE COMPLETE

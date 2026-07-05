# Phase G: End-to-End Verification (Week 6)

> Run after all phases land. This is the proof that the loops actually close on the live install — the whole point of the plan. Each check is observational: run the command / look at the surface, record pass/fail. **Never paste live personal content anywhere; report counts and statuses only.**

**User story:** As Spencer, I want one checklist that proves the watch → learn → remember → suggest → automate → verify-outcome loop runs end to end on my machine, so that "the system works" is an observation, not a hope.

## G-0. Preconditions

- [ ] `npm test` green on main.
- [ ] The packaged Mac app is running the NEW build (check the boot banner timestamp in the daemon log against the merge date — the July audit found the app running a build from two days prior).
- [ ] Decision Gate 1 resolved: exactly one machine runs the full daemon; `~/.openagi/node.json` matches that decision.

## G-1. The skill loop closes (A1 + G3)

- [ ] `ls ~/.openagi/skills-suggested | wc -l` — note the count. Triage begins: open the digest (or `GET /outreach/digest`) and confirm skill candidates appear as durable items with accept/dismiss actions.
- [ ] Accept one real candidate. Confirm: a `SKILL.md` appears under `~/.openagi/skills/` (count goes 0 → 1 for the first time ever).
- [ ] Dismiss one candidate. Confirm it never reappears in a later digest (dedupe holds).
- [ ] 48h later: an untriaged candidate re-surfaces in the digest under the stale/still-waiting section.
- [ ] **Target metric:** accepted skills ≥ 2 within the first week of operation (the funnel converted at exactly 0 for the prior month).

## G-2. Memory hygiene holds (A2 + G10)

- [ ] Run the boot reconciliation once; note the logged orphan-removal count (expected ≈ 98 on the live store as of 2026-07-05).
- [ ] After reconciliation: principle vector count equals principle-tagged memory item count (compare the two counts the way `evidence/gaps.md` G10 did — counts only).
- [ ] Trigger a memory correction via chat ("actually, that's wrong — X is Y"); confirm the superseded principle's vector is gone and the corrected fact is what surfaces next turn.

## G-3. Outcomes measure success (B1 + B2 + G5)

- [ ] Force a failing run (e.g. a cron job whose only tool call errors). Check the outcomes snapshot: its resolved score is 0.1, not 0.7.
- [ ] Reply naturally to an agent message; confirm the linked outcome resolves with source `user-followup` (the live store had **zero** of these in 2,000 outcomes — the first one is the proof).
- [ ] Tap 👍 on a digest item; confirm an `explicit-rating` resolution at 0.9.
- [ ] **Target metric:** within 2 weeks, `system-inferred` falls below 80% of resolutions (was 95%).

## G-4. Ambient signals flow (C1 + G1)

- [ ] After one active hour at the machine, check that an `ambient-capture` signal was processed (scrutiny event or memory event referencing taskType `ambient-capture` — the string appeared **nowhere** in the codebase before C1).
- [ ] Confirm the signal's domain is content-derived (e.g. `app-cursor`), not `general`.
- [ ] After ~1 week: the memory condenser has distilled at least one principle whose source is ambient (check condense events count rising and one principle tagged from ambient signals — counts/tags only).
- [ ] Idle hour (machine asleep) produces no signal — no noise when nothing happened.

## G-5. Propagation divides (C2 + G2)

- [ ] `~/.openagi/agents/specialists.json` — snapshot the count (was exactly 2 for a month).
- [ ] After 2 weeks of C1+C2 running: at least one NEW specialist exists whose `boundedScope` is content-derived (not a verbatim copy of the two default workflow texts), and the two legacy generic specialists show declining share of activations.
- [ ] Scrutiny axes vary: pull the last 50 outcomes' dimensions; risk is no longer 0.35 in 100% of rows; at least 4 of the recorded dimensions show a standard deviation > 0.05.
- [ ] The fitter variance guard (B3) either applies a fit (dims vary) or logs named flat dimensions — never silently fits constants.

## G-6. The spine holds (D1 + D2)

- [ ] Kill the daemon mid-cron-run (find the running job window); on restart, a "job interrupted" outreach item appears naming the job.
- [ ] Inject a hung job in a dev run (test fixture from D1); the schedule advances past it after the timeout and other jobs still fire on time.
- [ ] Prompt cache: with logging enabled for one session, confirm the Anthropic system block is byte-identical across 3 consecutive turns (D2's staticness test run against the live config), while memory hits still appear in responses.

## G-7. Reach and safety (E1–E3)

- [ ] Ask the agent "what did we discuss about <topic from ~3 weeks ago>" — it uses `search_sessions` and quotes the actual exchange.
- [ ] With the laptop lid closed, the evening digest arrives on Telegram; an unpaired stranger messaging the bot gets silence.
- [ ] Ask the agent to replay a skill: a pending-action confirmation appears (first item ever in that store) and nothing executes until approved.

## G-8. Regression sweep

- [ ] `npm test` green.
- [ ] `grep -rn "vocabulary-curator\|scrutiny-judge" src/ test/` returns nothing (F1 deletions complete; no dangling imports).
- [ ] Daemon uptime ≥ 72h with no unhandled-rejection crash entries in the log tail.
- [ ] Budget ledger daily spend within 1.5× its pre-plan baseline (C1's hourly job must not blow the budget — it is deterministic, so any big jump is a bug).

## Sign-off

When every box above is checked, write the date and observed metrics into this file, commit it, and — separately — decide whether the deferred items (execution surface, compression, more channels) have earned their turn: the criterion is G-1 and G-4 sustaining for two consecutive weeks.

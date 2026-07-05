# OpenAGI Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute tasks in dependency order (see the week map below). Every task is self-contained: it names its files, quotes the current code, shows the complete new code, and gives exact test commands with expected output. Do not improvise beyond what a task specifies.

**Goal:** Close the verified gaps between openAGI's spec (scrutiny → tiered memory → propagation, fed by ambient capture) and its running implementation, so the system delivers daily proactive value: mined skills reach the user durably, outcomes measure success instead of activity, ambient observations feed the learning loop, and the daemon is operationally trustworthy.

**Architecture:** No new subsystems. Every task either wires an existing, tested component into a loop that currently never closes, replaces hardcoded constants with measured values, hardens the cron/prompt spine, or deletes machinery that cannot complete its own loop. The evidence for every change was adversarially verified against the code and live data on 2026-07-05 (see `evidence/`).

**Tech Stack:** Node.js ESM (plain JavaScript, no TypeScript), `node --test` + `node:assert` for tests, SQLite (same driver as `src/observation-store.js`) for FTS, Swift/SwiftUI for the Mac app (Task A3 Option B only).

## Global Constraints

- Plain JavaScript ESM only; import paths include the `.js` extension. No TypeScript syntax anywhere.
- Never mix `??` and `||` without parentheses — V8 rejects the expression at parse time.
- Test runner is `npm test` (`node --test`); test files live at `test/<name>.test.js` and must match the style of neighboring tests.
- Commit after every green step: conventional-commit style (`fix(outreach): ...`), **plain text only, no backticks in commit messages** (the shell eats them as command substitution).
- Keep diffs narrow: touch only the lines a task names. Do not "tidy" adjacent code, imports, or logging.
- `~/.openagi` is live personal data. No task ever reads its content; migrations that touch it require a dry run and explicit approval from Spencer first (called out in-task).
- The repo-local `.openagi/` directory is a stale dev snapshot from May — never treat it as current state.
- No new npm dependencies. Reuse the SQLite driver, event bus, store patterns, and test helpers the repo already has.
- No LLM calls in new code paths unless a task explicitly says so (all v1 heuristics are deterministic).

## Why this plan exists (context for a fresh executor)

A 33-agent verified audit (2026-07-05) compared openAGI's spec, its implementation, its live runtime data, and NousResearch's hermes-agent. Ten spec-vs-implementation gaps survived adversarial verification (`evidence/gaps.md`, IDs G1–G10) and twelve hermes advantages (`evidence/hermes-advantages.md`). Headlines:

- **G1 (critical):** 742MB of ambient screen observations never become ABI signals — the capture stream never touches scrutiny or tiered memory.
- **G2 (critical):** propagation has only ever minted 2 generic specialists because every signal hardcodes `domain: 'general'` and one of two taskTypes.
- **G3 (critical):** 74 mined skill candidates sit unseen (0 accepted) because the only notification is a transient SSE event at 02:30/03:30 UTC; the accept/materialize/replay pipeline is built and tested but has never run.
- **G4/G5 (major):** scrutiny axes are hardcoded constants and outcome "quality" is a flat 0.7 for "executed ≥1 tool call", so every learner trains on noise.
- **G6 (major):** capture is hardwired to localhost while the machine is paired to a remote main — two divergent brains.

Each task cites its gap ID. Read the cited evidence entry before starting a task — it contains verified file:line pointers.

## Week map

| Week | Task | Title | Size | Depends on |
|------|------|-------|------|------------|
| 1 | A1 | Durable skill-candidate outreach (close mine→accept) | S | none |
| 1 | A2 | Principle vector GC + intuition-channel filtering | S–M | none |
| 1 | A3 | Capture client mode / topology decision ⚠️ gate | S or M | **DECISION GATE 1** |
| 2 | B1 | Outcome quality measures success, not activity | M | none |
| 2 | B2 | User feedback resolves outcomes (tone + thumbs) | M | B1 |
| 2 | B3 | Purge poisoned fitter data + variance guard ⚠️ gate | S | **DECISION GATE 2** |
| 3 | C1 | Ambient observations → ABI signals (hourly digest) | M | none (better after B1) |
| 3–4 | C2 | Measured scrutiny axes replace constants | L | B3 (guard must exist) |
| 4 | D1 | Cron hardening: overlap guard, timeout, boot note | M | A1 (uses outreach map) |
| 4 | D2 | Byte-stable system prompt (prompt-cache hits) | M | none |
| 5 | E1 | search_sessions tool (FTS over transcripts) | M | none |
| 5 | E2 | Telegram delivery with pairing security | M | A1 (digest content) |
| 5 | E3 | replay_skill behind the confirmation gate | S | none |
| 6 | F1 | Delete unearned adaptivity; real harsh-review threshold | M | C2 (fitter guard live) |
| 6 | G | End-to-end verification (phase-g-verification.md) | M | all of the above |

Phase files: `phase-a-close-the-loops.md` (A1–A3), `phase-b-real-feedback.md` (B1–B3), `phase-c-feed-the-brain.md` (C1–C2), `phase-d-harden-the-spine.md` (D1–D2), `phase-e-reach-and-recall.md` (E1–E3), `phase-f-deletions.md` (F1), `phase-g-verification.md`.

## Decision gates (STOP and ask Spencer)

1. **Before A3:** Which machine is the main brain? Option A (declare this Mac the main; config-only runbook) or Option B (build remote capture streaming to the Distiller). The task scopes both; only one gets executed.
2. **Before B3's real migration run:** show Spencer the dry-run counts (`OPENAGI_MIGRATE_DRY_RUN=1`) of outcome rows to be purged, and get an explicit yes. A timestamped backup is mandatory either way.
3. **Anything not in a task.** If a task's quoted "current code" no longer matches the file, stop and report the drift instead of guessing — the repo may have moved since 2026-07-05.

## Shared-file collision table (expected quote drift)

Tasks were each verified against the repo as of 2026-07-05. Executing in week order means later tasks will find these files already changed by earlier tasks — that drift is expected; apply the edit by intent (see the Drift rule in each phase file). Any OTHER drift means the repo moved: stop and report.

| File | Edited by (in execution order) |
|------|-------------------------------|
| `src/outreach-mapper.js` | A1, B2, D1 |
| `src/outreach-store.js` | A1, B2 |
| `src/outreach-config.js` | A1, E2 |
| `src/outreach-digest.js` | A1, E2 |
| `src/hosted-interface.js` | A1, A3, B2, D1, E2, F1 |
| `src/outcome-store.js` | B1, B2 |
| `src/abi-runtime.js` | A2, C1, D1, E1, E2, F1 |
| `src/agent-host.js` | A2, B2, C2, D2, E1, F1 |
| `src/tool-registry.js` | A3, E1, E3, F1 |
| `src/index.js` | B1, C1, C2, E1, F1 |
| `src/channels.js` | E2, F1 |
| `test/abi-runtime.test.js` | B2, B3, F1 |

## What is deliberately NOT in this plan

- No terminal/file/browser execution surface (amplifying an agent that can't yet grade its own success — revisit after Phase B proves out).
- No conversation summarization/compression (the 12-message window is not yet the binding constraint).
- No new messaging channels beyond Telegram, no blueprint-slot forms, no new sensors. One loop must demonstrably close end-to-end first.

## User stories (one per task)

- **A1:** As Spencer, I want overnight-mined skill candidates to land in my morning digest and re-surface until I decide, so that skills get accepted or rejected instead of rotting unseen.
- **A2:** As Spencer, I want the intuition channel to inject only live, non-superseded principles, so that every chat turn stops being polluted by 98 orphaned vectors.
- **A3:** As Spencer, I want exactly one brain that both sees my screen and makes proactive decisions, so that the system stops being the "cancerous multiplication" its own docs warn about.
- **B1:** As Spencer, I want a run where every tool call failed to score 0.1 instead of 0.7, so that retirement, routing, and the fitter learn from success — not motion.
- **B2:** As Spencer, I want my replies and one-tap thumbs to resolve outcome quality, so that the system learns from my judgment, not just its own inference.
- **B3:** As Spencer, I want the fitter to train only on real, current-format outcomes and to refuse to fit flat dimensions, so that "adaptive" stops meaning "noise".
- **C1:** As Spencer, I want each hour of my screen activity condensed into one signal through scrutiny and memory, so that the agent actually learns how I work from watching me.
- **C2:** As Spencer, I want signals scored by measured novelty/repetition/risk/specificity and scoped by content, so that propagation can mint real specialists instead of two generic buckets.
- **D1:** As Spencer, I want the scheduler to never double-fire, never hang on one stuck job, and tell me when a job died mid-run, so that I can trust a 24/7 daemon.
- **D2:** As Spencer, I want the static system prompt to be byte-stable so prompt caching actually hits, so that 24/7 operation gets cheaper and faster without behavior change.
- **E1:** As Spencer, I want to ask "what did we decide about X three weeks ago" and get the actual conversation, so that recall isn't a lossy compressed guess.
- **E2:** As Spencer, I want digests and urgent outreach on Telegram behind a pairing code, so that proactivity survives my laptop lid closing.
- **E3:** As Spencer, I want replay_skill (AppleScript control of my Mac) to require my confirmation, so that no injected text can drive my machine.
- **F1:** As Spencer, I want dead adaptivity machinery deleted and the harsh-review threshold actually implemented, so that the concept count shrinks and what remains is real.

## Execution protocol

1. One task at a time, in week order. Read the task's evidence entry first.
2. TDD every step: failing test → run it and see the exact failure → minimal code → green → `npm test` → commit → push.
3. If `npm test` was failing before you started a task, stop and report — don't build on red.
4. After each phase completes, run the relevant slice of `phase-g-verification.md`.

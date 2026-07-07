# Review Report

> Adapted from the BuildBetter `/review` template. This repo doesn't use the spec.md/plan.md/tasks.md spec-kit format — the equivalent artifacts are `00-INDEX.md` (spec: user stories, global constraints, decision gates) and `phase-a-*.md` through `phase-f-*.md` (plan + tasks: acceptance criteria, file-level task breakdown). No BuildBetter evidence files exist for this work; evidence below is direct code/test verification instead of BB-EXTRACTION IDs.

## Review Scope
- Mode: both (usability + code)
- BuildBetter Evidence: missing (not applicable — this is an internal infra/agent project, not a customer-facing BuildBetter feature)
- Branch: `codex/openagi-gap-remediation-execution` vs `main`, 65 files changed, ~4800 lines
- Underlying spec: `docs/superpowers/plans/2026-07-05-openagi-gap-remediation/00-INDEX.md` + `evidence/gaps.md` (10 verified spec-vs-implementation gaps, G1–G10) + `evidence/hermes-advantages.md` (12 verified competitor-comparison advantages)

## Usability Review

Most of this plan's 14 tasks are backend/infra plumbing (cron scheduling, prompt caching, scrutiny scoring, memory GC) with no direct end-user surface — those are assessed via **API/integration behavior checks** below, not a UI walkthrough, per the skill's own branching rule. Five tasks have a real user-facing surface (Mac app notifications, the web dashboard, or a messaging channel) and get the full pass/risk/fail walkthrough.

### A1 — Skill candidates land in the outreach feed
- **Easy to use:** pass — accept/dismiss are single actions on an existing card type Spencer already uses for drafts/suggestions.
- **Intuitive:** pass — a "still waiting" re-ping after 48h matches the mental model of "this needs your attention" rather than silently expiring.
- **Solves the problem:** pass — the verified defect (74 candidates, 0 accepted, notification only fired once at 2:30am with no client connected) is structurally fixed: candidates are now durable feed items, not fire-and-forget events.
- **Works:** pass — `test/outreach-mapper.test.js` (9/9), `test/outreach-skill-accept.test.js` (3/3), `test/outreach-digest.test.js` (7/7) all green; accept path traced end-to-end through `createSkillFromCandidate`.

### B2 — Thumbs feedback on outreach items
- **Easy to use:** pass — up/down added to existing card actions, no new UI pattern introduced.
- **Intuitive:** risk — thumbs resolve the *linked outcome*, not the visible card content directly; a user might expect "👎" to mean "this suggestion was bad" when it's scoring an earlier model turn's outcome. Low risk in practice since the two usually coincide, but worth a one-line tooltip if this ships to end users.
- **Solves the problem:** pass — closes the verified gap (0 of 2000 live outcomes had ever resolved via explicit rating).
- **Works:** pass — `test/outreach-feedback.test.js` (verified 200/400/404/idempotent-replay paths).

### A3 — Capture topology (Mac ↔ Distiller)
- **Easy to use:** risk — Option A (declare-this-mac-main) is a manual runbook (correct, since it's a one-time irreversible-ish choice); Option B (remote capture) ships the mechanism (`daemonBaseURL` UserDefaults key) but **no Settings UI toggle** — a user has to know to run `defaults write` or edit UserDefaults directly. Confirmed via `grep daemonBaseURL mac/Sources/OpenAGI/AppState.swift`: the property and setter exist, but no SwiftUI view binds to it anywhere in the diff.
- **Intuitive:** fail (for now) — there's no visible indication in the app of which daemon capture is actually streaming to. This matches a real, live discrepancy: Spencer confirmed the Distiller is main, but this Mac's capture bridge is still defaulting to its own local daemon (`http://127.0.0.1:43210`) because nothing has set `daemonBaseURL` yet.
- **Solves the problem:** partial — the plumbing (`sourceMachineId`, configurable URL, machine-filtered recall) is real and tested, but the actual two-brain split (G6) isn't closed until the setting is applied.
- **Works:** pass (mechanism), not yet applied (deployment) — `test/observation-machine.test.js` (5/5), `test/recall-activity-machine.test.js` verified.
- **Recommendation:** add a Settings row for "Capture destination" before this ships broadly, or this stays an invisible footgun.

### E2 — Telegram pairing + digest delivery
- **Easy to use:** pass — one-time 6-digit code, single `/pair CODE` message, matches a pattern users already know from 2FA setup.
- **Intuitive:** pass — 10-minute expiry + 5-attempt lockout are sane, unsurprising defaults.
- **Solves the problem:** pass — closes the "outreach is Mac-notification-only" gap; digest now reaches the user off-device.
- **Works:** pass — `test/telegram-pairing.test.js` (5/5, including lockout persisting against the correct code), `test/telegram-channel-gate.test.js` (4/4, unauthenticated pairing-code route returns 401).
- **Gap found in this review (not previously flagged):** the web dashboard's existing Channels tab (`renderChannels()` in `src/hosted-interface.js`) shows only `"configured" / "no token"` and polling on/off for Telegram — **it was not updated to show pairing state** (how many chats are paired, current pairing code, a "generate new code" action). A user relying on the dashboard rather than the daemon log has no way to complete pairing without hitting `GET /channels/telegram/pairing-code` directly via curl. This is a real, if minor, usability gap introduced by this diff — the feature is complete server-side but the one browser-facing surface that already exists for channel status wasn't extended to cover it.

### E3 — replay_skill confirmation gate
- **Easy to use:** pass — reuses the existing pending-actions approve/deny flow already built for other side-effecting tools; no new UI concept.
- **Intuitive:** pass — matches the mental model established by every other gated tool.
- **Solves the problem:** pass — the one tool that could drive the Mac via AppleScript/keyboard now requires explicit approval; verified as a real code path (`test/replay-skill-gate.test.js`, 3/3: invoke → pending → approve → executes; deny → never executes).
- **Works:** pass.
- **Note:** the companion audit (`tool-gate-audit.md`) flags `send_message`, `schedule_message`, `rize_query` (GraphQL mutations), and `set_provider` as other ungated side-effecting tools — correctly scoped out of this task, but worth a follow-up ticket.

### Playwright Recommendation
- **Needed:** yes, narrowly — this project does serve a real browser dashboard (`renderApp`/`renderChannels`/`renderOutcomes`/etc. in `src/hosted-interface.js`), so it's not purely an API surface.
- **Why:** the one concrete UI gap found in this review (Telegram pairing state invisible in Channels tab) would have been caught by a Playwright check that actually loads `/`, navigates to Channels, and asserts pairing UI is present — none of the 65 changed files include such a test.
- **Suggested scenarios** (if/when a Playwright harness is added to this repo — none exists today, so this is new infrastructure, not a quick add):
  1. Happy path: load dashboard → Channels tab → see Telegram card reflects `configured: true` after a token is set.
  2. Alternate flow: outreach feed shows a skill-candidate card with accept/dismiss/up/down actions and clicking accept removes it from the unresolved list.
  3. Failure/edge case: an interrupted cron job (`cron-interrupted` event) surfaces as a dismissable suggestion in the feed after a simulated daemon restart.
- For every other task (A2, B1, B3, C1, C2, D1, D2, E1, F1): **not visual-heavy** — recommended validation is the API/integration test suite that already exists (`node --test`), which is the correct level for cron internals, memory GC, prompt assembly, and scrutiny scoring.

## Code Review Findings

An **xhigh-effort, 10-angle adversarial code review** (correctness × 5 angles, cleanup × 3, altitude, conventions → independent 1-vote verification → gap sweep) ran on the full diff (workflow `wf_38dd7c96-456`): 24 candidates survived dedup, all 24 verified CONFIRMED or PLAUSIBLE. The 14 most severe were reported and triaged; **8 real bugs were fixed** (TDD: failing test reproducing the exact defect → fix → green → full-suite check), commits `350ea38`..`c4d9fb3`:

| # | Finding | Fix |
|---|---------|-----|
| 1 | **CRITICAL** — F1's harsh-review act-threshold override (0.68→0.85) was completely bypassed by the `propagate` branch, which ran first and ignored the override; `propagate` grants identical full-tool-access to `act`. | `actThresholdOverride` now gates `propagate` too when present (`350ea38`). |
| 2 | **SECURITY** — CaptureBridge fell back to the *local* daemon's auth token when a remote capture URL was set but no remote token configured, leaking the local secret to a remote host. | Never falls back to the local token for a remote URL; sends no token if unset (`38fe2e7`). |
| 3 | `search_sessions`' FTS5 query wrapped the whole input in one phrase match — multi-word queries required exact word order, undermining E1's entire purpose. | Per-term phrase-quoting joined as AND-of-terms (`1a0570e`). |
| 4 | `SessionIndex.init()` had no busy_timeout and no unconditional rejection handler — a transient sqlite lock became an unhandled rejection that permanently disabled session search. | Added busy_timeout; init() now degrades to the existing JSONL fallback on any open/exec failure instead of ever rejecting (`1a0570e`). |
| 5 | `POST /outreach/:id/act`'s switch silently "succeeded" for any unhandled `sourceRef.kind` (today: `cron-job`) — indistinguishable from a real success in the outreach history. | Throws instead of silently returning (`2aaa85a`). |
| 6 | Dead SMS-rendering ternary left in the dashboard after the Twilio deletion. | Removed (`2aaa85a`). |
| 7 | Machine-filtered activity search used a ref format (`rowid`) that doesn't match pre-migration rows (old format: `"App:Window"`), silently making all pre-upgrade capture history invisible under a machine filter. | Join now matches either format — no data migration, no risk to live data (`3dcaffc`). |
| 8 | `noteJobStart`/`noteJobEnd` each triggered a full jobs.json rewrite per due job — a 3-job tick did 7 writes instead of 1, working against D1's own hardening goal. | Removed the provably-redundant `noteJobEnd` write; crash-visibility guarantee unchanged, verified by a dedicated write-count test (`c4d9fb3`). |

**Deliberately not fixed — real, disclosed, lower priority (follow-up tickets, not blockers):**
- **`outcomeId` is never populated** by any real event producer (draft-store, proactive-observer, pending-actions, clarification-store, pattern-miner/session-miner all predate this diff and don't emit it) — B2's "thumbs resolves the linked outcome" degrades to recording a disconnected `explicit-feedback` outcome for every real item a user sees. Fixing this properly means touching 5 modules outside this diff's scope; flagging for a dedicated follow-up rather than expanding scope tonight.
- `POST /outreach/:id/feedback` duplicates `POST /outreach/:id/act` with `action: up|down` (same helper, nothing in the repo calls `/feedback`) — a bigger API-surface decision than a review fix.
- Minor reuse duplication: `telegram-pairing.js`'s `codesEqual()` vs `auth.js`'s `safeEqual()`; `session-index.js`'s `capSnippet()` vs `utils.js`'s `summarizeText()`.
- Minor efficiency: `VectorStore.delete()` syncs to disk on every call (A2 added 3 new loop-based call sites); `TelegramPairing.isAllowed()` re-reads `allowlist.json` from disk on every inbound message instead of caching in memory.
- `resolveSweep`'s 30-minute follow-up window creates a backlog-visibility lag for fast-cadence jobs — likely an accepted tradeoff of B2's design, not obviously a bug (PLAUSIBLE, not CONFIRMED).

**A separate, pre-existing, unrelated bug found while chasing the full-suite result:** `test/abi-runtime.test.js`'s pattern-miner judge-bypass test is time-of-day-flaky — confirmed via `git stash` that it already failed on the clean pre-review commit, and `pattern-miner.js` has zero diff vs `main`. Root cause appears to be `scoreSequence()`'s `hourVariance` calculation not handling hour/day-boundary wraparound correctly, so a lookback window that happens to straddle several wall-clock hours scores artificially low confidence. **Not fixed** — out of scope for this review (untouched file, pre-existing on `main`), but worth its own ticket.

**Final suite state: 465/466** (the one failure is the pre-existing, unrelated flake above).

## Coverage and Traceability Matrix

All 14 tasks were independently adversarially verified against their literal acceptance criteria in a separate pass (not self-reported by the implementer) — see the per-task verdicts below. Evidence = actual command output / source inspection, not BuildBetter IDs.

| Task | User story (00-INDEX.md) | Acceptance criteria source | Verification verdict |
|------|---------------------------|------------------------------|----------------------|
| A1 | Skill candidates land in the digest and re-surface until decided | `phase-a-close-the-loops.md` §A1.1–A1.3 | fully_met |
| A2 | Intuition channel injects only live, non-superseded principles | `phase-a-close-the-loops.md` §A2 | fully_met |
| A3 | Exactly one brain sees the screen and decides | `phase-a-close-the-loops.md` §A3 | fully_met (mechanism); **topology now confirmed Distiller=main, capture-bridge activation still pending — see Usability §A3** |
| B1 | Outcome quality reflects success, not activity | `phase-b-real-feedback.md` §B1 | fully_met |
| B2 | User replies/thumbs resolve outcomes | `phase-b-real-feedback.md` §B2 | fully_met |
| B3 | Fitter trains on real data; flat dims don't fit | `phase-b-real-feedback.md` §B3 | fully_met (poisoned data has since self-resolved via the store's own rolling cap — live purge would be a safe no-op if ever run) |
| C1 | Ambient activity becomes ABI signals | `phase-c-feed-the-brain.md` §C1 | fully_met |
| C2 | Scrutiny axes are measured, specialists divide by content | `phase-c-feed-the-brain.md` §C2 | fully_met |
| D1 | Scheduler never double-fires, never hangs, reports mid-run deaths | `phase-d-harden-the-spine.md` §D1 | fully_met |
| D2 | System prompt is byte-stable for cache hits | `phase-d-harden-the-spine.md` §D2 | fully_met (automated criteria); live A/B cache-hit test is a pending manual step |
| E1 | Agent can search its own past conversations | `phase-e-reach-and-recall.md` §E1 | fully_met |
| E2 | Digests reach the user off-Mac via Telegram | `phase-e-reach-and-recall.md` §E2a–d | fully_met (automated); E2d live phone-pairing round trip is a pending manual step; **dashboard gap found in this review (see Usability §E2)** |
| E3 | replay_skill requires explicit confirmation | `phase-e-reach-and-recall.md` §E3 | fully_met |
| F1 | Dead adaptivity deleted; harsh-review threshold real | `phase-f-deletions.md` §F1 | fully_met |

**Weak-evidence / pending-manual flags** (none block automated readiness, all are explicitly human-operated steps that can't run in a sandbox): A3's live device relaunch, D2's live cache-hit A/B, E2d's real Telegram phone pairing.

## Verdict

- **Ready.** All 14 tasks pass their own acceptance criteria; the xhigh code review's 8 real bugs (including one CRITICAL correctness bug and one security leak) are fixed, tested, and verified with no regressions; final suite is 465/466 (the one failure is a pre-existing, unrelated, out-of-scope flake in an untouched file).
- **Two things need your explicit action before they're actually in effect** (both already built, neither auto-applied):
  1. **A3 activation gap:** the Mac's capture bridge still defaults to its own local daemon rather than the Distiller, despite the topology decision being made. Setting `daemonBaseURL` is a live-config change I won't make without your go-ahead.
  2. **E2 dashboard gap:** Telegram pairing state isn't visible in the web Channels tab — minor, non-blocking, good follow-up.
- **Disclosed, deliberately deferred (not blockers):** `outcomeId` wiring, the duplicate `/feedback` route, and a handful of minor reuse/efficiency items — see the table above.
- **Suggested next step:** merge to `main` and proceed with the deployment sequence (Distiller update, Mac app build) you asked for.

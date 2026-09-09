# Phase: harness-hardening-1 — regression repair + stall guard + HermesAgent/Minara adoptions

Repo: openAGI (Cerberus). Branch: `codex/harness-hardening-1`. Node.js, zero runtime deps.
House rules: run tests with `npm test` (full suite) or `node --test test/<file>` (targeted).
Baseline: suite currently shows **2,477 pass / 9 fail** — the 9 fails are the bugs you are fixing
(8 regressions + 1 pre-existing `unmerged slots are re-queued for merge, never served as data`,
which you must NOT try to fix; leave it failing).
Do NOT touch any daemon, systemd unit, or running process. Work only in this clone.

## Fix 1 — REGRESSION: structured wrap-up template clobbers real forced answers (8 failing tests)

Commit `b2f962f` added `structuredShortStopReport()` (src/model-provider.js ~4790-4830) and
applied it unconditionally at the forced-answer sites (~5743, 5761, 5770, 6197, 6745, 6764, 6773
and the localPartialSummary wrapper at ~5040). Old behavior: when the model produced a real
forced answer, that text was returned AS-IS; the canned summary appeared only when the model
produced nothing. New behavior wraps EVERY forced answer in '## Done / ## Remaining / ## Blocked
/ ## Next', which breaks 8 tests that assert the model's actual text is preserved, e.g.
test/provider-resilience.test.js:205 expects exactly 'Recovered from the interrupted batch.'

Required semantics (this is the fix, not a suggestion):
- If the model's forced/final text is non-empty → return it UNCHANGED (current tests define this
  contract). The structured template applies ONLY when the model produced NO text and the harness
  must synthesize a summary (the localPartialSummary fallback path).
- Keep the template itself and `hasStructuredWrapUp` — they are good; only the application
  condition is wrong.
- The forceAnswerPrompt (~4707) may keep ASKING the model for the four sections — prompting for
  structure is fine; force-wrapping the response is not.
Failing tests to make green (run each): test/provider-resilience.test.js (2),
test/responses-continuation-provider.test.js (2), test/openai-responses-stream-hardening.test.js (1),
test/persistent-goals.test.js (1), test/dual-threshold-compression.test.js (2),
and the memtree one stays red (pre-existing).

## Fix 2 — checkpoint burst loop drains idle allowances in seconds

Evidence (run-inspector, turn_38f1db2712734dec): wall-clock checkpoints fired every ~180ms —
iterations 19→151 in 8 seconds with zero tool calls between, consuming all 150 idle strikes,
turn stopped STALLED while nothing was actually wrong.
Mechanism: in the iteration loop (src/model-provider.js ~5195-5210 and the twin at ~6300),
when `this.now() >= deadline` the code calls `maybeWallClockCheckpoint(...)` and `continue`s.
If the next model hop returns instantly (cheap/failing request, cached error, tight loop),
the deadline is hit again immediately → another checkpoint → another idle strike, in a hot loop.
`evaluateWallClockCheckpoint` (~1132) has no notion of minimum spacing.

Fix: add a minimum interval between IDLE-strike spends (progress extensions stay free/unlimited).
- In `createWallClockCheckpointState` (~1086) record `lastIdleSpendAt: null`.
- In `idleWallClockDecision` (~1112) or its caller: if the previous idle spend was less than
  `OPENAGI_IDLE_STRIKE_MIN_INTERVAL_MS` ago (env, default 5000ms, positiveInteger pattern like
  resolveSubagentConfig in src/integrations/delegate-task.js), extend WITHOUT decrementing
  `state.left` and mark the decision `extensionKind: "idle-debounced"`.
- The Discord formatter formatWallClockCheckpointActivity (src/discord-channel.js:65) and the
  inspector branch in src/run-inspector.js (turnInspectorMetadata, the wall-clock branch) must
  tolerate the new extensionKind (they already pass through strings — just verify).
- Add tests in test/wall-clock-progress.test.js: (a) two instant back-to-back idle checkpoints
  spend exactly ONE strike; (b) after the interval elapses (inject a fake provider.now), the next
  idle checkpoint spends the second strike; (c) progress checkpoints are unaffected.

## Fix 3 — [HermesAgent adopt] delegated-reply recovery markers

Problem this solves (real incident 2026-09-08): the daemon was killed mid-turn after the agent's
work was complete; the reply was lost silently. HermesAgent v2026.9.x solves this with idempotent
recovery markers.
Implementation for openAGI:
- In src/agent-host.js, when a turn's final reply text is ready but BEFORE channel delivery,
  persist a small marker file `~/.openagi/agent-host/pending-replies/<sessionId>-<turnId>.json`
  containing { sessionId, channel, replyText (cap 64KB), createdAt, deliveryTarget }.
  Delete it after confirmed delivery.
- On daemon boot (where sessions are restored), scan that dir; for each marker younger than
  24h whose delivery never confirmed, re-deliver ONCE with prefix "(recovered after restart)" and
  delete the marker. Older markers are deleted unsent. Corrupt marker files: quarantine
  (rename to .bad), never crash boot.
- Fail-safe: any error in marker write/read must never break the live turn — wrap in try/catch,
  advisory only (follow the existing "advisory" comment pattern used throughout agent-host.js).
- Tests: new test/pending-reply-recovery.test.js — marker written before delivery + removed after;
  boot rescan re-delivers exactly once (idempotent on double boot); corrupt marker quarantined;
  stale marker dropped.

## Fix 4 — [HermesAgent adopt] quarantine-not-crash cron boot

Current behavior: file-backed-cron-scheduler.js parses ~/.openagi/cron/jobs.json at boot; a
malformed row can throw. Adopt quarantine semantics:
- A cron row that fails validation is moved to `~/.openagi/cron/quarantine.jsonl` (append, with
  a reason field + timestamp) and skipped; boot continues with the valid rows.
- Log one line per quarantined row. Never throw for a data problem.
- Tests in the existing cron scheduler test file: malformed row (bad JSON type, missing id,
  negative intervalMs) → quarantined, others load; quarantine file grows append-only.

## Fix 5 — [Minara adopt] tool permission tiers + operator killswitch

Scope deliberately minimal (foundation, not a rework):
- Add `permissionTier` to tool registration metadata in src/tool-registry.js: one of
  "read_only" | "standard" | "sensitive" | "manual_only". Default when unspecified: "standard".
  Stamp obvious cases only: tools with sideEffects===false register as read_only.
- Killswitch: if the file `~/.openagi/KILLSWITCH` exists, every tool invocation with
  tier !== "read_only" is refused with a typed error naming the file; the agent can read the
  refusal but nothing can override it in-process. Check is a cheap fs.existsSync per invocation
  (or cached with 2s TTL). Document in CHANGES.md.
- Tests: killswitch file blocks a write tool but allows a read tool; removing the file restores;
  tier defaults correct.

## Process rules
- One commit per Fix, message prefix `fix(harness):` or `feat(harness):`, descriptive body.
- After EACH fix: run the targeted test file(s), then before the final commit run the FULL
  `npm test` — required end state: **2,485+ pass / 1 fail** (only the pre-existing memtree red).
  Print the final pass/fail counts in CHANGES.md.
- No new runtime dependencies. Follow existing code style (advisory try/catch, positiveInteger
  helpers, Object.freeze patterns).
- Do not modify: src/imessage-extractor.js, drafts/, examples/.
- End by appending the literal line `HARNESS HARDENING PHASE 1 COMPLETE` as the last line of
  CHANGES.md, included in the final commit.

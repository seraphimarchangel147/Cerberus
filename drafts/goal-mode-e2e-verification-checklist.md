# Goal-Mode End-to-End Verification Checklist (DRAFT)

Prepared by daily planner (2026-07-26). Draft only — nothing here has been executed.
Verify each item against the live system; check off as confirmed. Source of truth: `~/openagi` runtime + `goal_status` tool.

## 0. Pre-flight
- [ ] OpenAGI daemon running (`localhost:43210` responds).
- [ ] `goal_status` returns clean state: no stale active goal from a previous session. If one exists, decide: resume, pause, or clear — don't stack goals.
- [ ] Test budget sanity: note current turn-budget defaults so a runaway goal can't burn unbounded turns.

## 1. Goal activation
- [ ] Start a small, bounded goal with an explicit low turn budget (e.g. a goal whose success condition is verifiable in 2–3 turns).
- [ ] `goal_status` shows `active`, correct budget, and audit trail entry for activation.
- [ ] Confirm the goal actually drives an automatic continuation turn (work happens without a user nudge).

## 2. Judge loop
- [ ] After each auto-turn, latest judge result appears in `goal_status` (score + rationale, not just pass/fail).
- [ ] Judge termination works: when success criteria are met, the goal completes on its own and stops consuming turns.
- [ ] Judge rejection works: craft a deliberately unsatisfiable step and confirm the goal does NOT mark complete; audit trail records the rejection.

## 3. Budget enforcement
- [ ] Exhaust the turn budget on a test goal. Confirm automatic continuation stops at the cap (no silent overflow).
- [ ] Confirm the state after exhaustion is explicit (failed/exhausted, not silently active).

## 4. Pause / resume / clear
- [ ] `pause_goal` halts auto-continuation immediately; reason recorded in audit trail.
- [ ] While paused, no turns are consumed (verify across at least one pulse cycle).
- [ ] `resume_goal` restarts continuation subject to *remaining* budget (not a fresh budget).
- [ ] `clear_goal` stops all continuation; audit history retained and visible afterward.

## 5. Session survival
- [ ] Restart the daemon mid-goal. Confirm persisted goal state reloads correctly (status, remaining budget, audit trail).
- [ ] After restart, auto-continuation resumes only if the goal was active before restart — a paused goal stays paused.

## 6. Interaction with autopilot pulses
- [ ] While a goal is active, run one autopilot pulse; confirm queue-draining and goal work don't double-fire the same turn or corrupt each other's state.

## 7. Cleanup
- [ ] Clear all test goals. `goal_status` empty/clean.
- [ ] No orphan scheduled messages or cron entries left behind by the test runs.
- [ ] Write a one-paragraph verification report (what passed, what failed, any code fixes needed) before closing the parent goal item.

## Notes / findings
_(fill in during execution)_

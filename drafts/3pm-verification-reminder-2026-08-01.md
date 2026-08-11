# Draft: 3 PM Verification-Tests Reminder

**Status:** DRAFT for review (Azazel, 2026-08-01, planner task `task_8e9f1d0c95b04275`). NOT scheduled — awaiting approval.

## Intent
Mid-afternoon pause so the end-to-end goal-mode loop verification doesn't get pushed to end-of-day.

## Proposed reminder text
> "3 PM check: pause build work and run the loop-verification suite — `code_verify` (syntax + targeted tests) plus the e2e checklist in `drafts/goal-mode-e2e-verification-checklist.md` / `drafts/auth-goal-loop-e2e-verification-script.md`. Log pass/fail receipts before continuing."

## Proposed scheduling (on approval)
- `schedule_message`, one-shot, fires 15:00 local, non-recurring.
- If 3 PM has already passed today when approved, schedule for next occurrence or fire immediately — Creator's call.

## Note
As of drafting (2026-08-01 ~19:16 UTC), today's 3 PM window has likely passed in most US timezones; flagging so approval can target tomorrow or a same-day immediate ping instead.

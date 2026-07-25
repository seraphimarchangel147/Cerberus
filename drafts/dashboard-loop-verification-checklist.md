# Dashboard + Loop Verification — Build/Verify Checklist (DRAFT)

_Prepared 2026-07-25 by autopilot (daily planner task). Draft only — review before acting._

## Build
- [ ] Confirm dashboard entry point runs locally (`npm run dev` / equivalent in `~/openagi`)
- [ ] Verify dashboard reads live data (pending actions, queue, sessions) from `localhost:43210`
- [ ] Auth token loaded from `~/.openagi/.env` (`OPENAGI_AUTH_TOKEN`) for any mutating dashboard actions

## Loop verification
- [ ] End-to-end pulse loop: `agent_pick_next` → work → `complete_task`/`move_task` observable in dashboard task list
- [ ] Queue proposals verified in system of record: run `~/.openagi/workspace/bin/verify-queue.sh` and confirm `act_` IDs appear in `GET localhost:43210/pending-actions` before reporting done
- [ ] Scheduled messages (reminders) fire and deliver to originating channel
- [ ] Memory writes (`remember`/`correct_memory`) surface on next session start

## Carry-over rules
- [ ] Anything not checked by end of day moves to tomorrow's plan as an explicit task (not implicit context)
- [ ] Blockers noted inline with the failing step + observed vs expected

_Do not publish or schedule anything from this draft without review._

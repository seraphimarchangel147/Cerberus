# Provider-Auth Dashboard — Requirements Checklist

**Status:** DRAFT for review (prepared by Azazel, 2026-07-30, planner task `task_8081c19fabe34e42`). Draft only — nothing built, sent, or scheduled externally. Builds on `drafts/provider-auth-dashboard-outline.md` (2026-07-29).

---

## 1. Must-Have Views

- [ ] **V1 Overview** — provider card grid; status dot, last OK, last error (truncated), spend vs cap, p50 latency per card; global banner for stuck lease / false budget-cap / pending approvals.
- [ ] **V2 Provider Detail** — config source (env key name only, `set`/`unset`, never the secret), 24h health history, sanitized error tail, budget panel, action buttons.
- [ ] **V3 Approvals & Queue** — pending approvals with approve/deny (same backend as Discord buttons, single source of truth); autopilot task queue with enqueue/start/duration/status.
- [ ] **V4 Goal-Mode Loop** — active goal status, turn budget consumed, latest judge decision + reasons, checkpoint/extension usage.

## 2. Must-Have Fields (per provider)

- [ ] provider_id, status (live/degraded/down/unconfigured), last_ok_at, last_error (sanitized), key_configured (bool — presence only), spend_today_usd, daily_cap_usd, calls_today, latency_p50_ms.
- [ ] Queue items: task_id, title, enqueued_at, started_at, duration, status, source (daily-plan/manual).
- [ ] Approvals: approval_id, action summary, requesting agent, age, approve/deny affordance.

## 3. Must-Have Error States

- [ ] **Provider down** — card shows ○ + last_error snippet; drill-down shows failure streak; probe cadence escalates (detect < 5 min).
- [ ] **Degraded / rate-limited** — ◐ with 429/5xx counter; distinct from hard down.
- [ ] **Unconfigured** — key missing: grey card, "set env key" hint, excluded from probes.
- [ ] **False budget cap** — daemon says "Daily budget reached" but ledger spend is low: banner with diagnosed cause (model missing from priced table) and link to fix.
- [ ] **Stuck mutation lease** — global banner with lease holder age + "clear lease" action (approval-gated).
- [ ] **Approval timeout (300s)** — expired approvals shown distinctly from denied.
- [ ] **Empty queue** — explicit "standing by" state, not a blank panel.
- [ ] **Backend unreachable** — dashboard shows stale-data warning with last-refresh timestamp; never silently renders old data as live.

## 4. Hard Requirements

- [ ] No secret values rendered anywhere — env key names and presence flags only.
- [ ] Every mutating action (probe-if-locked, rotate key, disable provider, clear lease, approve/deny) routes through the existing approval policy; dashboard adds zero bypass paths.
- [ ] Approve/deny shares state with the Discord button flow — an action taken in one surface is immediately reflected in the other.
- [ ] All timestamps in local tz with UTC tooltip; spend in USD with 2dp.

## 5. Out of Scope (v1)

- Historical spend charts beyond 24h; multi-runtime aggregation beyond LAPTOP-EU81EB48; provider key rotation automation (manual approval flow only).

---

**Next step on approval:** promote into the build plan for the provider-auth dashboard goal; keep §3 (error states) as the acceptance test list.

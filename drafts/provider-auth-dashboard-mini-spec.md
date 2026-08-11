# Provider-Auth Dashboard — One-Page Mini-Spec

**Status:** DRAFT for review (Azazel, 2026-08-01, planner task `task_c282606f57704dfe`). Nothing built, sent, or scheduled.
**Companion docs:** `drafts/provider-auth-dashboard-outline.md` (full outline + wireframe), `drafts/provider-auth-dashboard-requirements-checklist.md` (field/state checklist), `drafts/provider-auth-dashboard-technical-outline.md` (components/build order).

---

## Problem
No single pane shows which providers are authenticated, live, failing, or burning budget. Failures surface as opaque tool errors; the "Daily budget reached" false-positive incident proved we can't trust surface signals without a system of record.

## Goal
A dashboard view answering, in under 10 seconds: **Is every provider I need working, and if not, why and what do I do about it?**

## Views (3)
1. **Overview** — provider cards: status (live/degraded/down/unconfigured), last successful call, last error (sanitized, truncated), spend today vs cap, p50 latency. Global banner: stuck leases, pending approvals count, budget posture.
2. **Provider detail** — key configured? (presence only, never secret values), 24h health-probe history, error tail, budget with projected exhaustion, actions: run probe / rotate key (approval-gated) / disable / clear lease.
3. **Approvals & queue** — pending approvals with approve/deny (parity with Discord button flow, same backend), autopilot lane showing task enqueue→start→duration.

## Data (per provider)
`provider_id, status, last_ok_at, last_error, key_configured, spend_today_usd, daily_cap_usd, calls_today, latency_p50_ms` — sourced from config registry, probe log, spend ledger, usage counters. No new secrets handling; read-only against existing stores.

## Non-negotiables
- Every mutating action routes through the existing approval policy — dashboard never bypasses gates.
- Sanitized errors only; no key material rendered.
- Approval actions share one backend with Discord — no split-brain state.

## Success criteria
- Provider outage detectable < 5 min.
- Zero unexplained budget-cap trips.
- Approval latency measurable end-to-end.
- Goal-mode loop verification items observable without log spelunking.

## Open questions for Creator
1. Extend existing OpenAGI dashboard or standalone page?
2. Probe cadence: on-demand only vs background interval (token cost)?
3. Per-`kind` subagent spend breakout in scope for v1?

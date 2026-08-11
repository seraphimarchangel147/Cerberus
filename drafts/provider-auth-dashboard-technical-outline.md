# Provider-Auth Dashboard — Technical Outline (One Page)

**Status:** DRAFT for review (prepared by Azazel, 2026-07-31, planner task `task_92f78a24e1424b80`). Nothing built, sent, or scheduled — awaiting approval. Complements `drafts/provider-auth-dashboard-outline.md` (functional views/wireframe) and `drafts/provider-auth-dashboard-requirements-checklist.md` (must-have fields).

---

## 1. Components

| # | Component | Responsibility | Notes |
|---|-----------|----------------|-------|
| C1 | **Probe runner** | Periodic health probes per configured provider (headless API ping, e.g. tiny completion / search query / Discord gateway heartbeat). Cadence ~5 min. | Reuses existing priced-model & provider registry; probes must be cheapest available call. |
| C2 | **Provider state store** | Append-only probe log + materialized `provider_state` table: status, last_ok_at, last_error (sanitized), latency rolling window, spend_today, calls_today. | SQLite alongside existing OpenAGI data (`~/.openagi/`); sanitize errors before persist. |
| C3 | **Spend ledger reader** | Read-only view over existing usage/cost accounting so dashboard shows spend vs daily cap without duplicating accounting logic. | Must match `status()` unpriced/false-cap semantics (see `fix-false-budget-cap` skill). |
| C4 | **Read API** (`GET /dashboard/*`) | Endpoints: `/providers`, `/providers/:id`, `/approvals/pending`, `/queue`, `/goal-status`. Auth via existing `OPENAGI_AUTH_TOKEN`. | Mirrors `/pending-actions` pattern already used by `bin/verify-queue.sh`. |
| C5 | **Action API (mutation lane)** | `POST /providers/:id/probe`, `/disable`, `/rotate-key`, `/leases/clear`. **Every mutation routes through the existing approval policy** — dashboard enqueues, never bypasses. | Same single source of truth as Discord approve/deny buttons. |
| C6 | **Web UI** | Tabs: Overview grid → Provider detail → Approvals & Queue → Goal-Mode Loop. Renders C4 data; actions hit C5 and surface the approval ID. | Keep it a thin client; no business logic in UI. |

## 2. Data Flow

```
providers (config registry / env presence)
        │
        ▼
  [C1 probe runner] ──probe results──► [C2 state store] ◄── [C3 spend ledger]
                                            │
                                     read-only queries
                                            ▼
                              [C4 Read API] ──► [C6 Web UI]
                                            ▲
                              user clicks "run probe" / "approve"
                                            │
                              [C5 Action API] ──► approval queue ──► existing approval policy
                                            │
                        decision (act/ask/propagate) recorded ◄── goal-mode judge feed
```

Key invariants:
- Secrets never flow: UI receives only `key_configured: bool` (+ optional last-4 hash fragment). Secret values stay in the secret store / env.
- One source of truth for approvals: Discord buttons and dashboard buttons write to the same store; no forked state.
- Sanitization at the boundary: probe errors sanitized in C1 before hitting C2, so the UI can never leak keys or internal paths.

## 3. Integration Points

1. **Provider registry / priced-model table** — enumeration of providers + cheapest probe call; missing entries cause false budget caps, so C1 must warn on unpriced models.
2. **Approval store** (`localhost:43210` pattern) — C5 enqueues; verification via `GET /pending-actions` with `OPENAGI_AUTH_TOKEN`, same as `bin/verify-queue.sh`.
3. **Mutation lease manager** — V1 banner + `POST /leases/clear`; surface stuck leases, never silently override them.
4. **Goal-mode runtime** — C4 `/goal-status` exposes active goal, turn budget, latest judge decision + reasons (feeds e2e checklist §7 in `drafts/goal-mode-e2e-verification-checklist.md`).
5. **Scheduler/cron** — probe runner and probe cadence registered as a daemon job; reload daemon after registration to avoid stale in-memory state (null-nextRunAt lesson).
6. **Discord gateway** — shared approval backend; dashboard approval events should mirror to the ops channel for audit parity.

## 4. Build Order (proposed)

1. C2 state store + C1 probe runner (headless, CLI-verifiable first).
2. C4 read API + minimal C6 Overview tab.
3. C5 action API wired through approval policy.
4. Approvals & Queue tab, then Goal-Mode Loop tab.
5. E2E verification per `drafts/auth-goal-loop-e2e-verification-script.md`.

## 5. Risks / Pitfalls

- **Secret leakage** — highest risk; sanitize at C1, assert in tests that no key material reaches C4 responses.
- **Forked approval state** — dashboard and Discord must share the store; add a regression test approving via one surface and confirming visibility on the other.
- **Probe cost creep** — cap probe spend; count it in the same daily ledger so the dashboard can't blow the budget it reports on.
- **False-cap propagation** — reuse `status()` unpriced-model semantics rather than reimplementing budget math.

# Provider-Auth Dashboard — Functional Outline & Wireframe

**Status:** DRAFT for review (prepared by Azazel, 2026-07-29, planner task `task_3664f0f3c82647d0`). Nothing built, sent, or scheduled — awaiting approval.

---

## 1. Purpose

Single-pane visibility into provider authentication state across Legion runtimes: which providers are configured, which are live, which are failing, spend/budget posture, and remediation actions. Ties into the active goal (provider-auth dashboard + goal-mode loop verification).

## 2. Views

### V1 — Overview (default landing)
- **Provider grid/cards:** one card per configured provider (Kimi, OpenAI, Anthropic, Brave/Exa/Tavily search, Discord, Telegram, etc.)
- Each card: status dot (live / degraded / down / unconfigured), last successful call, last error (truncated), today's spend vs daily cap, latency p50.
- Global banner: stuck mutation lease? budget-cap false positive? approvals pending count.

### V2 — Provider Detail (drill-down)
- Config source: env key name (never the secret value — show only `set`/`unset` + last-4 hash fragment if available).
- Health history: last 24h of probe results (success/fail, latency).
- Error log tail (sanitized).
- Budget: daily spend, cap, projected exhaustion time.
- Actions: **run health probe**, **rotate key (opens approval)**, **disable provider**, **clear stuck lease**.

### V3 — Approvals & Queue
- Pending approvals with approve/deny buttons (mirrors Discord button flow per Creator request).
- Autopilot lane: task queue with enqueue time, start time, duration, status — answers "when work gets sent there and how long it takes."

### V4 — Goal-Mode Loop (verification support)
- Active goal status, turn budget consumed, latest judge decision (act/ask/propagate) with reasons.
- Checkpoint history and extension usage — feeds the e2e checklist in `drafts/goal-mode-e2e-verification-checklist.md`.

## 3. Data Fields (per provider record)

| Field | Type | Source |
|---|---|---|
| provider_id | string | config registry |
| status | enum(live/degraded/down/unconfigured) | last probe |
| last_ok_at | timestamp | probe log |
| last_error | string (sanitized) | probe log |
| key_configured | bool | env presence check |
| spend_today_usd | number | spend ledger |
| daily_cap_usd | number | config |
| calls_today | int | usage counter |
| latency_p50_ms | number | rolling window |

## 4. Interactions

1. Click provider card → V2 detail.
2. "Run probe" → live health check, result inline (requires approval if mutation lane locked).
3. Approve/deny in V3 → same action as Discord buttons (shared backend, single source of truth).
4. Filters: by status, by spend > threshold.
5. All mutating actions route through the existing approval policy — the dashboard never bypasses gates.

## 5. Wireframe (V1, text)

```
+---------------------------------------------------------------+
| LEGION  Provider-Auth                    [⚠ 2 pending approvals]|
+---------------------------------------------------------------+
| Global: lease OK | budget $3.12/$25 | queue: 1 running (4m)   |
+---------------------------------------------------------------+
| +-----------+ +-----------+ +-----------+ +-----------+        |
| | Kimi   ●  | | OpenAI ●  | | Brave  ◐  | | Discord●  |        |
| | live      | | live      | | degraded  | | live      |        |
| | ok 2m ago | | ok 1m ago | | 429 x3    | | ok 5m ago |        |
| | $1.20/day | | $0.40/day | | free tier | | —         |        |
| +-----------+ +-----------+ +-----------+ +-----------+        |
| [+ unconfigured: SerpAPI, Firecrawl]                           |
+---------------------------------------------------------------+
| Tabs: [Overview] [Approvals & Queue] [Goal-Mode Loop]          |
+---------------------------------------------------------------+
```

Legend: ● live · ◐ degraded · ○ down/unconfigured

## 6. Success Metrics

- Time-to-detect provider outage < 5 min (probe cadence).
- Zero false "Daily budget reached" incidents visible without explanation.
- Approval latency measurable end-to-end (Discord and dashboard parity).
- Loop-verification checklist items observable from V4 without log spelunking.

## 7. Open Questions for the Creator

1. Dashboard surface: extend existing OpenAGI dashboard, or standalone page?
2. Probe cadence: on-demand only, or background interval (costs tokens)?
3. Should spend figures include delegated subagent usage broken out per `kind` lane?

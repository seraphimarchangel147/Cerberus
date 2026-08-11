# Draft — E2E Verification Script: Auth-to-Goal-Mode Loop
**Date:** 2026-07-30
**Task:** `task_272c9d2ceece494a` (daily-plan, 2026-07-30 — draft only, for user review)
**Status:** DRAFT — not executed, not scheduled. Run only after user approval.
**Companion docs:** `drafts/goal-mode-e2e-verification-checklist.md` (full checklist), `drafts/provider-auth-dashboard-requirements-checklist.md`, `drafts/provider-oauth-patterns.md`

---

## Purpose
Verify the full loop: provider auth → dashboard state → goal-mode loop reacts → audit trail proves each hop. This is a runnable, step-by-step script with a **pass condition per step**. Do not proceed past a failed step; log and stop.

## Conventions
- `[CLI]` = run in shell on the host. `[UI]` = perform in dashboard/browser. `[AGENT]` = trigger via agent tool or prompt.
- Evidence: after each step, capture the artifact named in **Proof** (file path, command output, or screenshot ref) before moving on.
- Env: export `OPENAGI_AUTH_TOKEN` from `~/.openagi/.env` before any `[CLI]` step that hits `localhost:43210`.

---

## Phase 0 — Pre-flight
1. `[CLI]` `systemctl --user status openagi` (or equivalent) → **Pass:** daemon active, uptime > 60s.
2. `[CLI]` `node --version` and repo `git rev-parse HEAD` → record both in the run log.
3. `[CLI]` `curl -s -H "Authorization: Bearer $OPENAGI_AUTH_TOKEN" localhost:43210/health` → **Pass:** 200.
4. `[CLI]` Confirm no stuck mutation lease: run the lease status check → **Pass:** zero durable leases older than 10 min.
5. `[UI]` Open dashboard → **Pass:** loads without console errors.

## Phase 1 — Provider Auth (link)
6. `[UI]` Start a provider link flow from the dashboard → **Pass:** redirect lands on provider consent page; URL contains `state` and `code_challenge` (PKCE).
7. `[UI]` Complete consent with a test account → **Pass:** callback returns, dashboard shows connection row.
8. `[CLI]` Verify stored state: query the dashboard's backend endpoint for the connection → **Pass:** row shows `linked`, granted scopes (not just requested), absolute-UTC token expiry, provider account id. **Proof:** JSON response saved to run log.
9. `[CLI]` Confirm no secret leakage: `grep -R` the dashboard's served bundle/log for the test `client_secret` / access token → **Pass:** zero hits.

## Phase 2 — Auth State Reflected in Dashboard
10. `[UI]` Refresh dashboard → **Pass:** connection persists; scopes and expiry match step 8.
11. `[CLI]` Force expiry/revocation at the provider (revoke test grant) → `[UI]` reload → **Pass:** state flips to `needs-reauth`/`revoked` with a distinct remediation hint — not a generic error. **Proof:** screenshot + row JSON.
12. `[UI]` Re-link → **Pass:** state returns to `linked`; audit log shows revoke + re-link events with correlation ids.

## Phase 3 — Goal-Mode Loop Reaction
13. `[AGENT]` Create a throwaway goal whose success metric reads the dashboard's connection state (e.g., "verify provider X shows `linked`").
14. `[AGENT]` Let one goal-mode turn run → **Pass:** `goal_status` shows the goal active; the turn's tool calls include the dashboard/backend read (not a guess from memory).
15. `[CLI]` Pull the audit/judge record for that turn → **Pass:** the verdict cites live state from step 14. **Proof:** audit entry id + excerpt.
16. `[AGENT]` Complete/clear the throwaway goal → **Pass:** rollup reflects completion; no residual auto-continuation.

## Phase 4 — Negative Paths
17. `[CLI]` Call the exchange endpoint with a tampered `state` → **Pass:** rejected, no session created, event logged.
18. `[CLI]` Replay a consumed auth `code` → **Pass:** rejected (`invalid_grant` or provider equivalent); surfaced as needs-relink, not retried blindly.
19. `[UI]` Disconnect mid-flow (close tab at consent) → **Pass:** no partial connection row; stale `state` expires per TTL.

## Phase 5 — Regression & Sign-off
20. `[CLI]` Run repo test suite (or the harness QA battery subset touching auth/goal-mode) → **Pass:** green.
21. Assemble run log: env versions, per-step proofs, failures → save under `docs/qa/` with date.
22. Verdict: all 21 steps pass → loop verified. Any failure → file findings, stop.

---

**Failure-handling rule (all phases):** a failed step means capture proof, note the hypothesis (config vs. code vs. state), and halt the script — do not "retry until green."

**End of draft. Awaiting user review.**

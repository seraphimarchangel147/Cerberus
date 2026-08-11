# End-to-End Verification — Evidence Artifact Checklist

_DRAFT — prepared by Azazel (daily-plan task task_21b42dc5a4b247e3, 2026-08-06; re-issued 2026-08-07 as task_88045ea3b0d64d1f with explicit metrics scope — this checklist covers both). Review before use. Not sent, published, or scheduled._

Purpose: a consistent inventory of artifacts to capture during every verification run, so any two runs are directly comparable. Use alongside `drafts/goal-loop-verification-evidence-template.md` (per-stage slots) and `drafts/goal-mode-e2e-verification-checklist.md` (step sequence).

**Naming convention:** `<YYYYMMDD>-<runId>/<artifact-type>-<stage>.<ext>` — e.g. `20260806-run01/screenshot-dashboard-loaded.png`.

---

## 1. Screenshots

- ☐ Dashboard initial load (provider list / empty state)
- ☐ Auth grant flow (prompt + post-grant state)
- ☐ Provider states visible (connected / expired / revoked)
- ☐ Goal-mode engaged indicator
- ☐ Loop completion / termination state
- ☐ Any error or blocked state encountered (capture immediately)

## 2. Logs

- ☐ Harness/agent log excerpt covering the full run window (UTC timestamps noted)
- ☐ Dashboard/service log excerpt (if separate process)
- ☐ Auth-flow log lines (grant, token issue, refresh — redact secrets)
- ☐ Goal-mode loop turn log (start → each turn → termination)
- ☐ Any stack traces or warnings, copied verbatim

## 3. Test outputs

- ☐ `node --test` (or relevant suite) output for touched components
- ☐ Any scripted verification output (`drafts/auth-goal-loop-e2e-verification-script.md` run log)
- ☐ Command transcripts for manual steps (exact commands + exit codes)
## 4. Metrics

- ☐ Loop turn count (turns executed vs. budget) — from goal status / loop log
- ☐ Wall-clock duration per stage and total run time
- ☐ Dashboard page load time (initial + post-auth)
- ☐ Auth round-trip latency (grant → token stored → first authenticated call)
- ☐ Token/session expiry window observed (time-to-expiry at grant, any refresh events)
- ☐ Tool-call count and failure/retry count during loop execution
- ☐ Error rate: failed vs. total calls per stage
- ☐ Budget/token spend for the run (if tracked)

## 5. URLs / references
## 4. URLs / references

- ☐ Dashboard route(s) exercised (full URLs)
- ☐ Auth provider URLs touched (authorize/callback — redact tokens in query strings)
- ☐ API endpoints hit (method + path, response status)
- ☐ Session key / goal ID / task IDs created during the run
## 6. Run metadata
## 5. Run metadata

- ☐ Run ID, date/time started and ended (with timezone)
- ☐ Operator
- ☐ Harness build/commit hash
- ☐ Config snapshot ref (or diff vs. baseline)
- ☐ Environment notes (WSL/macOS/node, versions)
## 7. Anomaly evidence
## 6. Anomaly evidence

- ☐ For every FAIL/N/A in the evidence template: screenshot or log excerpt attached
- ☐ Anomaly IDs cross-referenced to the report skeleton's Open Items table

---

**Collection discipline:**
1. Capture at the moment of observation — never reconstruct after the fact.
2. Redact tokens/credentials in all artifacts before the run closes.
3. One folder per run; nothing lives outside it.
4. Verdicts recorded per stage in the evidence template before the report is written.

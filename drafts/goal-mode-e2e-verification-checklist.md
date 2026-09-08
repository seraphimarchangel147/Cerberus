# Provider Auth + Goal-Mode End-to-End Verification Checklist (DRAFT)

Prepared for daily-planner task `task_d1e65ba72be244ab` on 2026-09-08. Draft only: no tests have been executed and no external action has been taken.

## Test record

- Build / commit: `________________`
- Environment: `________________`
- Base URL: `________________`
- Tester / timestamp / timezone: `________________`
- Browser / version: `________________`
- Providers exercised: `________________`
- Goal/session/run IDs: `________________`
- Evidence directory or report link: `________________`

### Evidence rules

- Give every step a verdict: **PASS**, **FAIL**, **BLOCKED**, or **NOT RUN**.
- Record actual behavior; never treat an action, command, or click as proof.
- Capture deterministic receipts where available: HTTP status and redacted response, runtime state read-back, test output, event/audit record, and relevant log excerpt.
- Screenshots supplement receipts; they do not replace them. Never capture secrets, bearer tokens, authorization codes, cookies, or provider keys.
- Use one correlation key (goal ID, run ID, or request ID) across UI, API, audit, and logs.
- For every failure, record reproduction steps, expected vs. actual result, timestamp, correlation key, severity, and proposed owner.

## 0. Pre-flight and safety

| # | Check | Expected result | Required evidence | Verdict |
|---|---|---|---|---|
| 0.1 | Record build, environment, provider configuration, and test identities. | Run is reproducible without exposing credentials. | Commit/build ID; redacted config summary. | |
| 0.2 | Confirm the test account has only intended permissions. | Least-privilege account; no unrelated production access. | Redacted role/scope read-back. | |
| 0.3 | Confirm secrets enter through the approved secret store, never ordinary text fields, logs, URLs, or artifacts. | No secret material is visible or persisted outside the secret store. | Secret-name/config read-back; redacted log scan. | |
| 0.4 | Record initial `goal_status` and clear or deliberately preserve any prior test goal. | Known baseline; no accidental stacked goal. | Before-state JSON/text and audit receipt. | |
| 0.5 | Record goal-mode turn budget and cleanup plan. | Bounded execution with explicit stop conditions. | Config/state read-back. | |

## 1. Provider authentication

| # | Check | Expected result | Required evidence | Verdict |
|---|---|---|---|---|
| 1.1 | Open an auth-gated dashboard route while signed out. | Access denied or redirected to login; protected data is absent. | URL, HTTP status/redirect chain, screenshot. | |
| 1.2 | Start authentication with a supported provider. | Correct provider/tenant is used; state/nonce and PKCE protections are present where applicable. | Redacted authorize request metadata and network receipt. | |
| 1.3 | Complete a valid login. | Callback succeeds once, session is established, and user returns to the intended safe route. | Redacted callback status, session/user read-back, screenshot. | |
| 1.4 | Refresh/reload after login. | Session persists according to policy without a second consent prompt. | Before/after route and session-state receipt. | |
| 1.5 | Sign out, then revisit protected routes using back/reload/direct URL. | Session is invalidated; protected content cannot be recovered from cache or history. | Logout response, post-logout HTTP status, screenshot. | |
| 1.6 | Repeat login with denied consent or user cancellation. | Explicit recoverable cancellation state; no partial session or credential record. | Error code/state, session read-back, screenshot. | |
| 1.7 | Exercise invalid, replayed, mismatched-state, and expired callbacks. | All fail closed; callback/code cannot be reused; event is auditable. | Status/error codes and redacted audit/log entries. | |
| 1.8 | Exercise expired/revoked access and refresh credentials. | One bounded refresh if policy allows; otherwise re-authentication prompt. No refresh loop. | Network trace, retry count, final UI/session state. | |
| 1.9 | Use an account lacking required provider scopes. | Missing scopes are named with a remediation path; unrelated features remain safe. | Provider scope read-back and UI error state. | |
| 1.10 | Attempt an unsafe post-login redirect. | Redirect is rejected or normalized to an allowlisted local route. | Request and final location, with secrets redacted. | |

## 2. Dashboard state matrix

| # | State | Trigger | Expected UI and behavior | Required evidence | Verdict |
|---|---|---|---|---|---|
| 2.1 | Loading | Cold load and slow API. | Stable loading indicator; controls that require data are disabled; no false empty/error flash. | Screenshot plus request timing. | |
| 2.2 | Authenticated / ready | Valid session and healthy APIs. | Identity, provider state, goal state, budget, and latest judge result match live runtime/API state. | Screenshot plus side-by-side API/`goal_status` read-back. | |
| 2.3 | Empty | No goals/runs/providers as applicable. | Actionable empty state, not a blank panel or misleading zero. | Screenshot and backing API response. | |
| 2.4 | Partial data | One widget/API fails. | Healthy widgets remain usable; failed widget is explicit; no stale values presented as current. | Screenshot, failed response, healthy response. | |
| 2.5 | Unauthorized | Session absent or revoked. | Protected data is removed immediately and login path is offered. | Screenshot and 401/403 receipt. | |
| 2.6 | Provider missing/unconfigured | Remove or disable provider config. | Provider is visibly marked unavailable/misconfigured; start controls are blocked with remediation. | Redacted config and screenshot. | |
| 2.7 | Provider degraded/down | Inject timeout, 429, or 5xx. | Bounded retry/backoff; readable error; no frozen spinner or duplicate goal run. | Attempt count/timestamps, logs, screenshot. | |
| 2.8 | Stale/offline | Disconnect or serve old data. | Freshness timestamp/offline warning appears; destructive or misleading controls are gated. | Screenshot and timestamps. | |
| 2.9 | Long/hostile content | Long names, Unicode, and HTML/script-like text. | Layout remains usable and text is escaped; no script executes. | Test fixture and screenshot. | |
| 2.10 | Accessibility/responsiveness | Keyboard-only and narrow viewport. | Focus order, labels, status announcements, contrast, and layout remain usable. | Accessibility output and screenshots. | |

## 3. Goal-mode transition matrix

Use one bounded, deterministic test goal with a 2–3 turn success condition. For every row, compare dashboard state, `goal_status`, API state, and audit/event history.

| # | Transition | Action | Expected result | Required evidence | Verdict |
|---|---|---|---|---|---|
| 3.1 | none → active | Start one goal once. | Exactly one goal/run is created with correct objective and budget. | Goal/run IDs; API response; dashboard and `goal_status`. | |
| 3.2 | active → working | Allow automatic continuation. | Work starts without a user nudge; one turn is charged once. | Turn event, budget delta, correlated logs. | |
| 3.3 | working → judged | Finish one turn. | Latest judge score/rationale is recorded and rendered accurately. | Judge record and matching dashboard state. | |
| 3.4 | judged → working | Return an incomplete/rejected result. | Goal remains active, audit explains why, and next turn respects remaining budget. | Judge/audit records; before/after budget. | |
| 3.5 | active → paused | Pause with a reason. | Continuation halts promptly; reason is retained; no turn is consumed while paused. | Pause event and state sampled across a pulse interval. | |
| 3.6 | paused → active | Resume. | Continuation resumes using remaining—not reset—budget. | Resume event and budget read-back. | |
| 3.7 | active/paused → cleared | Clear the goal. | Continuation stops; current goal disappears; audit history remains available. | Clear receipt, post-state, retained audit. | |
| 3.8 | working → completed | Satisfy success criteria. | Judge closes goal exactly once; no further turns fire. | Success record, final state, later no-op observation. | |
| 3.9 | working → exhausted | Use all allowed turns without success. | Goal stops explicitly as exhausted/failed; no cap overflow. | Turn count, budget ledger, final status. | |
| 3.10 | active/paused → restart recovery | Restart service mid-goal. | State, budget, and audit reload consistently; only previously active goals may resume. | Pre/post state and startup logs. | |
| 3.11 | active + autopilot pulse | Trigger a queue pulse during goal work. | Queue and goal execution do not double-fire or corrupt shared state. | Event ordering, turn count, task/goal IDs. | |
| 3.12 | concurrent start | Submit duplicate starts rapidly. | Idempotency or conflict handling prevents duplicate active runs. | Responses, database/API count, audit. | |

## 4. Failure and recovery cases

| # | Injected failure | Expected containment and recovery | Required evidence | Verdict |
|---|---|---|---|---|
| 4.1 | Provider timeout/network loss during a turn. | Bounded timeout/retry; explicit goal/UI state; no lost or double-charged turn. | Timings, retries, budget before/after, logs. | |
| 4.2 | Provider 401/403. | Credential path is identified; refresh or re-auth occurs at most as policy allows; no secret leak. | Status sequence and final state. | |
| 4.3 | Provider 429. | Retry-After/backoff honored; no request storm; user sees delayed/degraded state. | Timestamped request sequence and UI. | |
| 4.4 | Provider 5xx/malformed payload. | Validation rejects bad data; fallback or explicit stop follows policy; no corrupt goal state. | Raw response schema summary, validation error, post-state. | |
| 4.5 | Dashboard/API 401 after page load. | Session is cleared and protected data disappears; safe re-login path shown. | Network and screenshot sequence. | |
| 4.6 | Dashboard/API 500. | Error boundary contains failure; retry is safe and does not duplicate mutations. | Error state and request IDs. | |
| 4.7 | Lost client response after successful mutation. | Retrying with same idempotency key yields one logical mutation. | Mutation count, response/audit receipts. | |
| 4.8 | Process restart during auth callback or goal turn. | Transaction resumes safely or rolls back explicitly; no orphan session/run. | Pre/post records and startup recovery logs. | |
| 4.9 | Persistence unavailable/read-only. | Mutation fails explicitly; UI does not claim success; no partial durable state. | Error response and storage read-back. | |
| 4.10 | Turn/judge emits oversized or unsafe text. | Output is bounded/escaped/redacted in UI and logs. | Fixture, rendered screenshot, redacted log. | |
| 4.11 | User lacks authorization for goal mutation. | Server returns 403 and state is unchanged regardless of hidden/disabled UI controls. | Request status and before/after state. | |
| 4.12 | Cleanup fails. | Failure is visible and retryable; orphan resources are enumerated, not silently ignored. | Cleanup report and residual-state query. | |

## 5. Security and observability gates

- [ ] Authorization is enforced server-side for every protected read and mutation.
- [ ] Cookies/session tokens use the intended `Secure`, `HttpOnly`, and `SameSite` policy.
- [ ] CSRF protections cover state-changing browser requests where relevant.
- [ ] OAuth/OIDC state, nonce, redirect allowlisting, PKCE, and one-time code handling match the provider flow.
- [ ] Logs, traces, URLs, screenshots, and drafts contain no credentials, authorization codes, cookies, or raw tokens.
- [ ] Audit records identify actor, action, target, result, timestamp, and correlation key without storing secrets.
- [ ] Provider and dashboard health metrics expose latency, errors, rate limits, auth failures, and goal transition counts.
- [ ] Alerting distinguishes user-caused auth failures from provider/system incidents.

**Evidence:** security test output, redacted cookie/header/config inspection, audit sample, log scan, metrics snapshot, and alert receipt.

## 6. Completion and cleanup

- [ ] Revoke/delete test credentials and sessions through the supported path.
- [ ] Clear test goals and verify `goal_status` has no active test state.
- [ ] Confirm no orphan tasks, scheduled messages, cron entries, provider grants, or test records remain.
- [ ] Store only redacted evidence under the agreed retention policy.
- [ ] Populate a final report with pass/fail counts, blocking defects, owners, severity, and retest criteria.
- [ ] Do not claim end-to-end completion unless all critical rows pass with deterministic evidence.

## Result summary

- Passed: `___`
- Failed: `___`
- Blocked: `___`
- Not run: `___`
- Critical blockers: `________________`
- Residual risks: `________________`
- Retest owner/date: `________________`
- Overall verdict: **PASS / CONDITIONAL / FAIL / NOT RUN**

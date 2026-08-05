# Hermes Parity Wave 4 — Event Push, Steering, Safety Valve, A2A

**Author:** Seraphim (spec) → Codex (implementation)
**Baseline:** `main` @ the commit this file lands on
**Verified test baseline:** `npm test` = **2178 pass / 0 fail** (measured 2026-08-03 on this tree, Linux-side, ~27s)
**Branch:** `codex/hermes-parity-wave-4`
**Completion marker:** append the literal line `PARITY WAVE 4 COMPLETE` as the last line of this file, in the final commit.

---

## 0. Read this first

This wave ports four capabilities from Hermes v0.20.0 into openAGI/Cerberus. Every claim
below was grep-verified against **this** tree, with file:line anchors. Where the anchor
says something exists, it exists — do not re-implement it.

**Reference source is in the repo.** Hermes is a Python codebase living on the WSL side at
a path you cannot read. The relevant implementations have been copied into
`docs/plans/reference/`:

| File | What it is |
|---|---|
| `hermes-outbound_webhooks.py` | Full 569-line signed-webhook dispatcher (Phase 1 reference) |
| `hermes-approval-denial-breaker-excerpt.py` | Consecutive-denial circuit breaker (Phase 2 reference) |
| `hermes-steer-marker-excerpt.py` | The steer marker text + system-prompt block (Phase 3) |
| `hermes-steer-redirect-excerpt.py` | `steer()`, `redirect()`, `_drain_pending_steer()`, `apply_pending_steer_to_tool_results()` (Phase 3) |
| `hermes-a2a-protocol.py` / `hermes-a2a-security.py` / `hermes-a2a-DESIGN.md` | A2A v1.0 spec compliance (Phase 4) |

**Read the reference, copy its semantics, do not transliterate its Python.** Where the
reference is better than this spec, follow the reference and note why in `CHANGES.md`.

### Hard constraints (non-negotiable)

1. **Zero runtime dependencies.** `package.json` has `"dependencies": {}` and it stays that
   way. Use `node:crypto`, `node:http`, global `fetch`, `node:test`. No npm installs.
2. **`npm test` must stay green at ≥ 2178 pass / 0 fail**, plus your new tests. Run it
   before your first commit to confirm the baseline, and before every commit after.
3. **Never restart or touch the live daemon.** Azazel's Cerberus gateway is running from
   this repo. You work in the delegation clone only. No `systemctl`, no `pkill`, no
   `scripts/update.sh`.
4. **ASCII only in identifiers, filenames, and string literals you author.** A homoglyph
   scan runs on every added diff line at review time; a Cyrillic c (U+0441) or a fullwidth
   question mark (U+FF1F) inside an identifier fails the gate. This has bitten this codebase
   before — a homoglyph in a filename or a heredoc is invisible in a diff view.
5. **One commit per phase**, message prefix `feat(wave4):` / `test(wave4):`. Do not squash
   the four phases into one commit — the review gates run per-phase.
6. **Do not modify the reference files** under `docs/plans/reference/`. They are immutable
   source material.
7. Every new module gets a header comment explaining *why*, in the style of the existing
   code (see `src/legion-siblings.js` for the house style — resolution order, rationale,
   what is and is not a secret).

### The single design doctrine for this entire wave

Stated verbatim in Hermes `approval.py:2219` and it is the reason all four features are
safe to add to a running agent:

> **Escalate behavior by changing what the model reads next — never by restructuring what
> it has already read.**

Concretely: a circuit breaker changes the *text of a tool result*. A steer *appends to an
existing tool-result message*. Neither inserts a new message, neither rewrites history,
neither breaks role alternation — so both are **prompt-cache-invariant by construction**.
If you find yourself splicing the messages array, you have taken a wrong turn.

---

## Phase 1 — Outbound signed webhooks

### What exists already (do not rebuild)

`src/hook-registry.js` (649 lines) is a complete, well-built hook system:

- `HookRegistry.notify(event, payload)` — **line 165**. Queues observer hooks on a
  serialized promise chain (`#observerQueue`) and returns immediately. This is exactly the
  seam Hermes uses. It already exists.
- `HookRegistry.runVeto(event, payload, opts)` — **line 96**. Awaited, fail-closed for
  builtins, fail-open for extensions, fair-share deadline splitting.
- `flush()` — **line 176**. Awaits the observer queue. This is your `atexit` equivalent.
- `_register(spec, {builtin, source})` — **line 243**. `spec = {name, event, tier, handler, timeoutMs}`.
  Tiers are `gateway` (0) / `plugin` (1) / `shell` (2); ordering is builtin-first then tier
  then registration order.
- `eventMatches(pattern, event)` — **line 306**. Supports `*` wildcards, so a webhook
  subscription can register on `event: "*"` and receive everything.

**Correction to an earlier assessment I made: `notify()` and non-veto events are NOT
absent.** What is absent is a *subscriber* that signs and POSTs. Build only that.

### Events currently emitted (the full inventory — grep-verified)

| Event | Emitter |
|---|---|
| `post_tool_call` | `src/tool-registry.js:1919` (`_notifyPostToolCall`) |
| `gateway:startup` | `src/hosted-interface.js:4553` |
| `gateway:shutdown` | `src/hosted-interface.js:4576` |
| `session:branch` | `src/agent-host.js:1811` via `_notifyHook` |
| `session:end` | `src/agent-host.js:1826` via `_notifyHook` |
| `pre_tool_call` | `src/tool-registry.js:1497` (veto path, `beforeToolCall`) |

`src/agent-host.js:1832` — `_notifyHook(event, payload)` wraps
`this.runtime.hooks?.notify?.(event, sanitizeForAudit(payload))`. **Reuse it.** All new
emissions in this phase go through `_notifyHook`, so redaction is automatic.

### Deliverable 1.1 — `src/outbound-webhooks.js` (new file)

Mirror `docs/plans/reference/hermes-outbound_webhooks.py`. Required behavior:

**Signing.** HMAC-SHA256 over the **raw serialized body bytes** (not the object — sign the
exact string you send). Header `X-Cerberus-Signature-256: sha256=<lowercase hex>`. Use
`node:crypto` `createHmac`. Constant-time comparison is a *receiver* concern, but document
the expected verification snippet in the module header so consumers get it right.

Additional headers on every POST:
- `X-Cerberus-Event: <event name>`
- `X-Cerberus-Delivery: <uuid>` — use `crypto.randomUUID()`, **unique per POST attempt**,
  not per event (a retry gets a new id; include `X-Cerberus-Delivery-Attempt: <n>` so a
  receiver can dedupe on a separate stable `eventId` field in the body).
- `Content-Type: application/json`
- `User-Agent: cerberus-webhooks/1`

**Body shape:**
```json
{
  "eventId": "<uuid, stable across retries>",
  "event": "post_tool_call",
  "at": "<ISO 8601>",
  "agent": "<OPENAGI_AGENT_NAME or 'cerberus'>",
  "payload": { ...sanitized hook payload... }
}
```

**Queue discipline.** Bounded queue, capacity **256**. One drain loop (an async worker
promise chain, mirroring the `#observerQueue` pattern already in `hook-registry.js` — do
not spawn threads, Node has none here). On overflow, **drop the oldest** and increment a
`dropped` counter exposed via `stats()`; log at most one warning per 60s (copy the
rate-limited-warning pattern at `src/agent-host.js:646-660` — it carries a `suppressed`
count so a persistent failure stays visible without one line per event).

**Network I/O must never block the agent loop.** `notify()` is already fire-and-forget;
your handler must return immediately after enqueueing. The handler registered on the
HookRegistry must **not** await the HTTP call.

**Retry policy (copy exactly):**
- Retry on **5xx and connection/network errors only**.
- **Do not retry 4xx** — a 4xx means the receiver rejected you; retrying is spam.
- Exponential backoff with jitter, max 3 attempts total, cap the total wall time per event
  at 30s. Bound the backoff explicitly — an unbounded `base ** attempt` is how you get an
  18-hour sleep on attempt 10.
- **Never follow 3xx.** This is the subtle one and the reference documents it: a redirected
  POST gets silently converted to a body-less GET by most HTTP clients, which drops the
  signed payload while returning 200. Treat 3xx as a permanent failure and log it as a
  misconfiguration. In Node's `fetch`, pass `redirect: "manual"`.
- Per-request timeout 10s via `AbortSignal.timeout(10_000)`.

**Config.** `<dataDir>/webhooks.json`, loaded through `resolveDataDir()` from
`src/data-dir.js` and `readJsonFile` from `src/file-utils.js` (both already exist — use
them, do not write a new JSON loader). Shape:
```json
{
  "webhooks": [
    {
      "name": "dashboard",
      "url": "https://...",
      "secret": "<hmac key>",
      "events": ["post_tool_call", "session:*"],
      "enabled": true,
      "timeoutMs": 10000
    }
  ]
}
```
Fail-open on a malformed file: warn, keep the last valid configuration (mirror
`loadShellConfig` at `hook-registry.js:180`). Cap at 32 subscriptions.

**Secret handling.** The secret is a credential. It must never appear in a log line, an
error message, `stats()`, or a `/health` payload. `src/credential-redaction.js` exists —
read it and route through it. Add a test asserting the secret does not appear in the
module's own log output.

**URL safety.** `src/url-guard.js` exists. Use it to reject webhook URLs pointing at
loopback/link-local/metadata addresses unless an explicit `allowPrivate: true` is set on
the subscription — otherwise a webhook config becomes an SSRF primitive against the host.

### Deliverable 1.2 — Wire-up

- In `src/abi-runtime.js` (which imports `HookRegistry` at line 66), construct the
  dispatcher and register one hook per subscription: `{name: "webhook:<name>", event: <pattern>, tier: "plugin", handler}`.
  Registering on the existing registry is the whole point — **zero call-site changes**.
- In `src/hosted-interface.js` shutdown path (near line 4576, next to `gateway:shutdown`),
  await `dispatcher.flush()` with a bounded timeout so a short-lived run does not lose its
  final events. Mirror `endActiveHookSessions`' use of `boundedAllSettled`
  (`src/agent-host.js:1828`).

### Deliverable 1.3 — Two new emissions

Add these via `_notifyHook`, because a webhook consumer that only sees `post_tool_call` is
not useful:
- `turn:complete` — emit in `src/agent-host.js` after the turn resolves. Payload:
  `{sessionId, projectId, turnId, stopReason, iterations, durationMs, channel}`.
- `approval:required` — emit in `src/tool-registry.js:1178` `_suspendForApproval`, right
  after `markExecutionDecision(receiptState, "approval", "pending")`. Payload:
  `{actionId, toolName, summary, severity, sessionId}`. **Do not include `args`** — a
  catastrophic command's arguments may contain credentials. This is the highest-value
  event in the set: it lets the dashboard stop polling for pending approvals.

### Tests (`test/outbound-webhooks.test.js`)

Use `node:http` to stand up a real local server; do not mock `fetch`.

1. Signature is correct: recompute HMAC over the received raw body, assert it equals the
   header.
2. Signature is over **raw bytes** — send a payload with a non-ASCII character in a string
   value and confirm the receiver's recomputation still matches (catches an encode-twice bug).
3. 4xx → exactly 1 attempt.
4. 5xx → retries, then gives up; total attempts ≤ 3.
5. 3xx → **not followed**, counted as failed, exactly 1 attempt.
6. Queue overflow at 256 drops oldest, increments `dropped`, does not throw.
7. Event filtering: a subscription on `session:*` receives `session:end` and not `post_tool_call`.
8. `flush()` resolves after all in-flight deliveries settle.
9. A hung receiver (never responds) does not delay the caller of `notify()` — assert the
   `notify()` call returns in < 50ms while the receiver holds the socket open.
10. The secret never appears in captured log output.

---

## Phase 2 — Consecutive-denial circuit breaker

### What exists already

- `src/catastrophic-policy.js` (239 lines) — `classifyCommand`, `isCatastrophicToolCall`,
  `createCatastrophicPreToolHook()` at line 55. Returns
  `{action:"block", approvalRequired:true, reason}` for catastrophic calls.
- `src/tool-registry.js:1526` — the `hookDecision?.action === "block"` branch. Line 1527
  `markExecutionDecision(receiptState, "pre_hook", "blocked")`. Line 1554 onward builds the
  non-catastrophic block envelope with
  `const error = hookDecision.message ?? \`Tool ${name} was blocked by a pre_tool_call hook.\``
- `src/pending-actions.js:215` — `decide(id, {decision, ...})`, accepts `"approve"` or `"deny"`.
- Auto-approve is **ON** in this deployment (`OPENAGI_AUTO_APPROVE`), which is precisely why
  this valve matters: without it, a model in a bad loop can hammer a blocked tool forever.

### Deliverable 2.1 — `src/denial-breaker.js` (new file)

Mirror `docs/plans/reference/hermes-approval-denial-breaker-excerpt.py`.

```js
export class DenialBreaker {
  constructor({ threshold = 3, maxSessions = 256 } = {})
  record(sessionKey)      // increment, return new count
  reset(sessionKey)       // an allow/approve happened
  addendum(sessionKey)    // returns "" below threshold, escalation text at/above
  stats()
}
```

- Threshold from `OPENAGI_DENIAL_BREAKER_THRESHOLD`, default **3**. **`0` disables** the
  breaker entirely (`addendum()` always returns `""`) — an operator must be able to turn
  it off without a code change.
- In-memory `Map`, capped at **256** sessions with insertion-order (LRU-ish) eviction —
  same shape as `hermes-approval-denial-breaker-excerpt.py`. Delete-then-set on `record()`
  so a touched session moves to the tail. Not persisted; a restart resets the tally, which
  is correct (the loop that caused it is gone too).
- `addendum()` text must (a) state the count and threshold, (b) instruct the model to
  **stop retrying and explain the blockage to the user in plain language instead**, and
  (c) tell it that a different approach or a human decision is required. Be explicit; a
  vague "consider stopping" gets ignored.

**Critical constraint:** `addendum()` returns a **string that is appended to the existing
block message**. It does not throw, does not abort the turn, does not insert a message,
does not touch the messages array. If your implementation does any of those, it is wrong.

### Deliverable 2.2 — Wire into the block path

In `src/tool-registry.js`, in the `hookDecision?.action === "block"` branch (line 1526):

1. On the **non-catastrophic block** path (the code around line 1554–1560 that builds
   `error`): call `record(sessionKey)`, then append `addendum(sessionKey)` to `error`
   before it goes into the semantic envelope.
2. On the **catastrophic** path, do **not** record on the block itself — a catastrophic
   block enqueues for approval rather than being a dead end. Instead record on a **denied**
   decision, and reset on **approved**, at the `waitForDecision` result in
   `_suspendForApproval` (`src/tool-registry.js:1218-1222`): `decision.decision === "approve"`
   → `reset`; `"deny"` → `record` + append the addendum to the denial error string.
3. **Reset on every successful dispatch.** Find the success return path in `invoke` (the
   `_notifyPostToolCall` call at line 1884 with a non-error semantic) and reset there. A
   single successful tool call means the model is no longer stuck — clearing the tally is
   what keeps this from false-firing across a long session.
4. `sessionKey` = `context?.sessionId ?? "default"`. Namespace it (`\`${projectId}:${sessionId}\``)
   if a projectId is available on context, so two projects cannot share a tally.

### Tests (`test/denial-breaker.test.js`)

1. Below threshold → `addendum()` returns `""`.
2. At threshold → non-empty, contains the count and the word describing the escalation.
3. `reset()` clears; the next denial starts from 1.
4. Threshold `0` disables entirely, even after 50 denials.
5. Eviction: 300 distinct sessions → map size ≤ 256, and the most recently touched session
   still has its count.
6. **Integration test through the real tool registry:** a stub hook that always blocks,
   invoked N times, produces a block message that gains the addendum on invocation N — and
   the messages array shape is unchanged (assert only the result string differs).
7. A successful invocation between denials resets the tally.

---

## Phase 3 — Mid-turn steering (redirect, not preempt)

### The problem, with the anchor

`src/agent-host.js:660-676`:
```js
// A real inbound user message always wins over an automated goal loop.
if (!ephemeral && input.goalContinuation !== true && input.metadata?.authorBot !== true
    && !["autopilot","cron","subagent"].includes(channel)) {
  try {
    if (this.runtime.goals?.get?.(sessionId)?.status === "active") {
      this.runtime.goals.preempt(sessionId, "real user message");   // <-- line 671
    }
  } catch { /* Goal control is advisory... */ }
}
```

`goals.preempt()` (`src/goal-store.js:148`) sets `preemptedAt` and moves the goal out of
`active`. The provider loops check this every iteration:
`src/model-provider.js:4786` and `:5842` — `if (!goalContinuationIsCurrent(context, goalContinuationRevision)) { stopReason = "goal-preempted"; break; }`.

So today a user typing "actually, use the other API" while Azazel is 6 tool calls into a
goal **kills the goal loop and throws away in-flight progress**. Hermes converts that into
a course correction.

### Deliverable 3.1 — `src/turn-steering.js` (new file)

Mirror `docs/plans/reference/hermes-steer-redirect-excerpt.py` (contains `steer()`,
`redirect()`, `_drain_pending_steer()`, `apply_pending_steer_to_tool_results()`) and
`hermes-steer-marker-excerpt.py` (the marker constants).

```js
export const STEER_MARKER_OPEN  = "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered mid-turn; not tool output]";
export const STEER_MARKER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";
export function formatSteerMarker(text)          // "\n\n" + OPEN + "\n" + text + "\n" + CLOSE
export class TurnSteering {
  steer(sessionId, text)          // stash; concatenate with "\n" if one is pending
  drain(sessionId)                // take-and-clear
  hasPending(sessionId)
  applyToToolResults(sessionId, toolResults)   // mutate last tool_result in place
  clear(sessionId)                             // on hard interrupt / turn end
}
```

**The em-dash in `STEER_MARKER_OPEN` is intentional and must be copied byte-for-byte** —
it is part of a marker the model is taught to trust, and it is in a string literal, not an
identifier, so it is exempt from the ASCII rule. Do not "fix" it to a hyphen. Add a test
that asserts the exact marker string.

**Why the marker exists — read this before simplifying it.** Hermes' comment
(`prompt_builder.py:652`) records that a bare `"User guidance: ..."` line appended to a
tool result got **refused by the model as prompt injection in the wild**. The fix was a
bounded, self-describing marker plus a system-prompt block teaching the model to trust
**that exact marker and no lookalike**. Both halves are required — the marker without the
system-prompt block will get refused again.

### Deliverable 3.2 — Delivery at the tool-batch boundary

Two provider paths, both need it. The delivery point is where the tool results become a
message, immediately before the next model request:

- **Anthropic path:** `src/model-provider.js:6049` —
  `if (toolUses.length > 0) convo.push({ role: "user", content: toolResults });`
  Call `applyToToolResults(sessionId, toolResults)` **immediately before** this push.
  The `toolResults` entries are `{type:"tool_result", tool_use_id, content, is_error}`
  built at line 6144. `content` is **either a string or an array of blocks** (the image
  case at 6147-6162) — handle both: string → concatenate; array → push
  `{type:"text", text: marker}` as the last block. Copy this branch from the reference
  (`apply_pending_steer_to_tool_results`, the `isinstance(existing_content, str)` split).
- **OpenAI/Responses path:** `src/model-provider.js:5209-5225` —
  `conversationInput.push({type:"function_call_output", call_id, output})`.
  Apply the marker to the **last** `function_call_output` pushed in the batch, appending to
  its `output` string.

**Target the LAST tool result in the batch, walking backwards and skipping non-tool
entries** (line 6170-6172 can push a `duplicateNotice` text block after the results — you
must not land the steer on that). If no tool-result entry is found in the batch, **put the
steer back** so it can be delivered as a normal next-turn user message; never silently drop it.

### Deliverable 3.3 — Convert preempt into redirect

Replace the block at `src/agent-host.js:660-676`. New logic:

```
if (<same guard conditions as today>) {
  const goal = this.runtime.goals?.get?.(sessionId);
  if (goal?.status === "active") {
    if (<a turn is currently in flight for this session>) {
      steering.steer(sessionId, text);      // redirect: goal survives
      // do NOT preempt
    } else {
      this.runtime.goals.preempt(sessionId, "real user message");   // unchanged fallback
    }
  }
}
```

**Determining "a turn is in flight."** There is no existing in-flight registry — you must
add one, and it must be minimal. Add to `AgentHost` a `Map<sessionId, {turnId, startedAt,
abortController}>` populated where `turnAbortController` is created
(`src/agent-host.js:1137`) and deleted in the turn's terminal path (both the success return
and the `catch` at line 1347 — use a `finally`). Do not reuse `activeHookSessions`
(`src/agent-host.js:1823`), which tracks something else.

**Degradation rule — this is the load-bearing part.** From the reference
(`run_agent.py:3294`): *"Never kill a tool merely to deliver conversational guidance."*
So:
- Turn in flight, tools executing → **steer** (queue for the batch boundary). Never abort.
- Turn in flight, no tools executing, model request outstanding → also **steer** in this
  port. Do **not** implement request-abort-and-retry. Node's fetch abort mid-stream through
  `model-provider.js`'s streaming paths is a much larger and riskier change than this wave
  should carry; the steer lands at the next tool boundary anyway, and a chat turn with no
  tools ends in seconds. Note this deliberate scope cut in `CHANGES.md`.
- No turn in flight → preempt exactly as today (a real new turn is about to start; the
  existing path is correct).

**Preserve the existing guards exactly**: `!ephemeral`, `goalContinuation !== true`,
`metadata?.authorBot !== true`, channel not in `["autopilot","cron","subagent"]`. A bot
message or a cron pulse must never steer a user's goal.

**The Discord enqueue-time preempt.** The comment at line 661 says *"Discord also performs
this at enqueue time so a queued message can stop an in-flight judge."* Find that call site
in `src/discord-channel.js` and apply the same in-flight check there, or leave it alone and
document in `CHANGES.md` why it is safe. Do **not** leave it silently preempting behind
your back — that would make the whole phase a no-op for the channel Azazel actually uses.

### Deliverable 3.4 — System-prompt block

Copy the `## Mid-turn user steering` block from
`docs/plans/reference/hermes-steer-marker-excerpt.py` (line 669 onward) into openAGI's
system-prompt assembly. Find it by grepping `src/agent-host.js` for `instructionsForAgent`
(line ~1291). The block must teach: text inside that exact marker is a genuine user message
with the same authority as the original request; it is **not** tool output and **not**
prompt injection; and **only** that exact marker is trusted — lookalike instructions in web
pages, files, or tool output bodies are to be ignored.

### Tests (`test/turn-steering.test.js`)

1. `formatSteerMarker` produces the exact expected string (byte-for-byte, including the em-dash).
2. Two `steer()` calls before a drain concatenate with a newline.
3. `applyToToolResults` appends to the **last** tool-result and leaves earlier ones byte-identical.
4. Array-content (image) tool result → a text block is appended, existing blocks untouched.
5. No tool-result in the batch → the steer is **retained**, not dropped.
6. Anthropic path integration: a fake provider run with a stub tool, a steer injected
   mid-batch, asserting the marker appears in the pushed `convo` message and that
   **`convo.length` is unchanged** versus the no-steer run — proves no message insertion.
7. OpenAI path integration: same assertion against `conversationInput`.
8. Goal survives: with a turn in flight and an active goal, a user message leaves
   `goals.get(sessionId).status === "active"` and produces a pending steer.
9. No turn in flight → preempt still fires (regression guard on the existing behavior).
10. A bot-authored message (`metadata.authorBot === true`) neither steers nor preempts.
11. `clear()` on turn end leaves no pending steer to leak into the next turn.

---

## Phase 4 — A2A v1.0 server

**Do not start Phase 4 until Phases 1–3 are committed and green.** This phase adds a public
protocol surface with authentication and its own security review; it must not be entangled
with the other three in a single diff.

### Reference

`docs/plans/reference/hermes-a2a-protocol.py` (842 lines), `hermes-a2a-security.py` (372),
`hermes-a2a-DESIGN.md` (165). Read `DESIGN.md` first — it explains the model. The Python
plugin is 3,219 lines total; **we are porting the server half only**, not the client.

### What exists already

- `src/hosted-interface.js` (15,391 lines) — the HTTP surface. Route dispatch is a flat
  chain of `if (method === "GET" && pathname === "/...")` (see lines 376–900). Helpers:
  `sendJson(res, status, value)` at **4687**, `readJson(req)` at **5515**,
  `sendHtml` at **4623**.
- `src/auth.js:9-12` — Bearer token check via `safeEqual`. Reuse it; do not invent a second
  auth scheme.
- `src/job-store.js` / `src/job-manager.js` — existing async job machinery. **Read these
  before writing the task store.** If they can back A2A task state, use them; if their
  lifecycle does not fit the 8 A2A states, write a thin adapter over them rather than a
  parallel store, and say which you chose and why in `CHANGES.md`.

### Deliverables

**4.1 — `src/a2a-protocol.js`.** Pure protocol layer, no HTTP, fully unit-testable:
- The 8 task states, verbatim: `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`,
  `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_COMPLETED`,
  `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`.
- A legal state-transition table + a `canTransition(from, to)` guard. Terminal states
  (`COMPLETED`/`FAILED`/`CANCELED`/`REJECTED`) accept no outgoing transitions.
- JSON-RPC 2.0 request/response framing with the spec error codes: **-32001** TaskNotFound,
  **-32002** TaskNotCancelable, **-32003** PushNotificationNotSupported, plus standard
  -32700/-32600/-32601/-32602/-32603.

**4.2 — Agent Card at `GET /.well-known/agent-card.json`.** **Public, unauthenticated** —
that is the discovery contract. It must therefore contain **no** secrets, no session data,
no project names, no internal paths. Derive `skills` from the registered toolsets
(`src/tool-registry.js` exposes the registry) — but publish a **curated allowlist**, not
every one of the 119 tools. Publishing `code_shell` as a discoverable skill to any agent on
the network is not a feature. Gate the whole endpoint behind `OPENAGI_A2A_ENABLED`,
**default off**.

**4.3 — JSON-RPC binding on `POST /a2a`.** Methods: `message/send`, `message/stream` (SSE),
`tasks/get`, `tasks/cancel`. Bearer auth via `src/auth.js` on everything except the agent
card. Rate limit per token — check whether `src/budget-guard.js` already provides a limiter
before writing one.

**4.4 — Task store.** Persist through the existing data-dir conventions
(`resolveDataDir()`); bound the retained task count and prune terminal tasks on a TTL.

**4.5 — SSE streaming** for `message/stream`. There is already an SSE implementation in
`hosted-interface.js` for the dashboard — find it and reuse the framing helpers.

### Security requirements (non-negotiable)

- Default **off**. `OPENAGI_A2A_ENABLED=1` to enable.
- Bind to loopback by default; a non-loopback bind requires an explicit env opt-in.
- An A2A-submitted task runs with a **restricted tool policy** — it must not inherit the
  operator's auto-approve. Route it through the same read-only/approval rails a `subagent`
  channel uses. An external agent must never be able to trigger a catastrophic tool call.
- Bound request body size in `readJson` (check whether it already caps; if not, cap it here).
- The agent card leaks nothing. Add an explicit test asserting the card contains no
  substring from a list of sentinel secrets planted in config.

### Tests (`test/a2a-protocol.test.js`, `test/a2a-server.test.js`)

State machine table (legal + illegal transitions), each spec error code, agent-card shape +
the no-leak assertion, auth rejection on `/a2a` without a token, an end-to-end
`message/send` → `tasks/get` → `COMPLETED` cycle against a real local server, `tasks/cancel`
on a terminal task returning **-32002**, and the disabled-by-default assertion (routes 404
when the env flag is unset).

---

## Definition of done

- [ ] Four commits, one per phase, prefixed `feat(wave4):` / `test(wave4):`.
- [ ] `npm test` green: ≥ 2178 baseline + all new tests, **0 fail**, on the final commit.
- [ ] `package.json` `dependencies` still `{}`.
- [ ] `CHANGES.md` updated with one section per phase, recording every deliberate deviation
      from this spec and why — especially the Phase 3 scope cut and the Phase 4
      job-store-vs-new-store decision.
- [ ] Every new module has a why-comment header in the house style.
- [ ] No `TODO` / `FIXME` / `unimplemented` in added lines.
- [ ] Branch pushed to `origin/codex/hermes-parity-wave-4`.
- [ ] The literal line `PARITY WAVE 4 COMPLETE` appended as the last line of **this file**,
      included in the final commit.

## If you get stuck

Do not silently skip a deliverable. If something in this spec is wrong or impossible
against the real tree, implement what you can, and write the discrepancy into `CHANGES.md`
under a `## Wave 4 — spec deviations` heading with the file:line evidence. An honest,
documented gap is worth far more than a stub that makes the checklist look complete.

PARITY WAVE 4 COMPLETE

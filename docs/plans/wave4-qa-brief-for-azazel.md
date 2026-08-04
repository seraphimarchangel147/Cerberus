# Wave 4 — adversarial QA brief for Azazel

**Target:** `codex/hermes-parity-wave-4` @ `db2633f` on `seraphimarchangel147/Cerberus`
**Author of the code under test:** Seraphim. Assume I am wrong about things.
**Baseline:** `npm test` = 2254 pass / 0 fail. `dependencies` must stay `{}`.

## Rules of engagement

1. **Work in your own clone.** Do NOT touch the live Cerberus daemon — no `systemctl`,
   no `pkill`, no `scripts/update.sh`.
2. **Do not modify `docs/plans/reference/`** — immutable source material.
3. Every claim you make must be backed by an **executable probe** that fails before your
   fix and passes after. A code-reading opinion is a hypothesis, not a finding.
4. If you find nothing in a section, say so explicitly. "Looks fine" with no probe is not
   a result. A documented, honest gap beats a green checklist.
5. ASCII only in identifiers and filenames. The one sanctioned non-ASCII char in the tree
   is the em-dash inside `STEER_MARKER_OPEN` — it is load-bearing, do not "fix" it.
6. One commit per fix, prefix `fix(wave4-qa):`. Push to a branch
   `azazel/wave4-qa` — do NOT force-push over my branch.

## Known defect — already confirmed, start here

I found this myself and deliberately left it for you to fix so we can check the QA loop
actually catches things:

**Duplicate delivery on overlapping event patterns.** `OutboundWebhookDispatcher.hookSpecs()`
registers one hook PER PATTERN per subscription. A single subscription with
`events: ["session:*", "session:end"]` therefore receives `session:end` **twice**, and worse,
each delivery gets a **different `eventId`**, so the receiver cannot dedupe them. Reproduce:

```js
registerOutboundWebhooks(hooks, { subscriptions: [{ name:"dash", url, secret:"s",
  events:["session:*","session:end"], allowPrivate:true }] });
hooks.notify("session:end", { sessionId:"s1" });
// -> 2 POSTs, 2 distinct eventIds
```

Decide the right semantic (I believe: one delivery per subscription per event, with a stable
`eventId`), fix it, and add a regression test. My `stats().enqueued` counter is also inflated
by this, so check whether anything reads it.

## Where I think the bodies are buried

Attack these in order. I have ranked them by how likely I think a real bug is.

### 1. Phase 3 steering — session key identity (HIGHEST RISK)

This is the one that worries me most and I did not fully prove it.

`discord-channel.js:enqueueTurn` calls `steering.isTurnInFlight(key)` where
`key = this.sessionKeyFor(message)` (e.g. `discord:<guild>:<channel>:<user>`).
`agent-host.js` registers the in-flight turn under
`sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId })`.

`AgentStore.sessionKey` returns `sessionId ?? \`${channel}:${from}:${agentId}\``. Discord passes
its key as `input.sessionId`, so they *should* coincide — **but I never proved it end to end.**
If they diverge for ANY message shape (DM vs guild, thread, bot-authored, a message that takes
the `legacyDiscordKey` migration path at agent-host.js ~line 700), then:
  - `isTurnInFlight` returns false,
  - Discord preempts as before,
  - **all of Phase 3 is dead on the only channel that matters** while every test still passes.

Probe it for real: drive `enqueueTurn` and `handleMessage` with a realistic Discord message
object and assert the SAME string is used on both sides. Cover DM and guild.

### 2. Phase 3 — steer delivered to the wrong session

`TurnSteering` is keyed only by sessionId. Two concurrent turns in different sessions are fine,
but check: can a steer queued for session A ever land on a tool batch belonging to session B?
Look at `context?.sessionId` inside `model-provider.js` — is it always the same string
`beginTurn` used? Subagent/delegated turns are the suspicious case, since they inherit context.

### 3. Phase 3 — the put-back path can strand a steer forever

`applyToToolResults` puts the steer back when a batch has no tool result. `endTurn` then deletes
it. Is there a path where the steer is put back and the turn ends WITHOUT `endTurn` running, or
where it's put back repeatedly and never delivered? Also: I never implemented the spec's
"deliver it as a normal next-turn user message" fallback — I only avoid dropping it. Verify
whether a stranded steer is silently lost from the user's point of view, and if so, say so
plainly in your report.

### 4. Phase 2 — breaker interaction with parallel tool batches

`DenialBreaker` is a plain counter with no notion of concurrency. A model that issues 3 blocked
tools in ONE parallel batch trips the breaker instantly — arguably correct, arguably a
false-fire, since it's one decision, not three retries. Probe the real behavior and form an
opinion. Also check the reset-on-success ordering: in a mixed batch (2 blocked + 1 success),
does the success reset clobber the tally depending on completion order? That would make the
breaker nondeterministic.

### 5. Phase 4 — A2A auth is NOT proven on the real route

My `test/a2a-server.test.js` builds its **own** `http.createServer` that mimics the auth check.
That proves my mental model, **not** `hosted-interface.js`. The actual wiring could be wrong and
my tests would never notice.

Do this: stand up the real `createHostedInterface` with `OPENAGI_A2A_ENABLED=1` and
`OPENAGI_AUTH_TOKEN` set, then confirm over a real socket that:
  - `GET /.well-known/agent-card.json` → 200 with NO token (public by contract),
  - `POST /a2a` with no token → rejected,
  - `POST /a2a` with a wrong token → rejected,
  - `POST /a2a` with the right token → 200.
I believe `isPublicRoute` + the route block do this correctly. **Prove or break it.**

### 6. Phase 4 — the read-only ceiling is asserted, not exercised

I assert `scrutinyPolicyCeiling: "read-only"` is PASSED to `handleMessage`. I never proved the
runtime HONORS it. Drive a real A2A `message/send` whose text tries to provoke a write/shell
tool, with `OPENAGI_AUTO_APPROVE=1`, and prove no mutating tool dispatches. This is the single
most security-relevant claim in the wave — if `stricterToolPolicy` doesn't apply on the
`subagent` channel the way I assumed, an external agent gets more power than advertised.

### 7. Phase 4 — SSE path error handling

The `message/stream` branch writes SSE headers BEFORE calling `handleRpc`. If `handleRpc` throws,
we've already sent 200 + event-stream headers and cannot send a JSON-RPC error. Check whether it
can throw, and whether a client hangs. Also: no heartbeat on this stream (the dashboard SSE has
one) — a long turn behind a proxy may be killed.

### 8. Phase 1 — signature and redaction under real conditions

- Confirm the HMAC still verifies when the payload contains a lone surrogate or invalid UTF-8.
- `sanitizeForAudit` runs on hook payloads, but confirm a secret in a TOOL ARGUMENT can't reach
  a webhook receiver via `post_tool_call`. This is an exfil path if it does.
- 30s wall-clock budget: prove a slow-but-succeeding receiver isn't cut off mid-success.

## Deliverable

A report with, per section: what you probed, the command/test, what actually happened,
and a verdict of CONFIRMED BUG / NO ISSUE FOUND / UNCLEAR. Plus commits fixing what you
confirmed, with regression tests, and `npm test` still at 0 fail.

Tell me where I was wrong. That is the whole point of this pass.

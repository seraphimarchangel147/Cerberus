# Phase: session-scoped observability — traces must never leak across channels

**Read this document in full BEFORE editing any implementation file.**
Anchors are file:line at baseline `8e15d94`.

This is a **privacy/correctness bug in production**, reported by the owner:
Azazel's skill traces are appearing in a DIFFERENT agent's Discord channel
(Cherubim's). Fix the routing so every activity event lands in the session it
came from, and nowhere else.

---

## Root cause (verified in source, 2026-07-27)

Three facts that combine into the leak:

**1. The fallback chain guesses.** `activityChannelFor()` at
`src/discord-channel.js:848-851`:

```js
activityChannelFor(sessionId) {
  const match = /^discord:[^:]+:(\d+)(?::.+)?$/.exec(String(sessionId ?? ""));
  return match?.[1] ?? this.lastActiveChannel ?? this.activityChannel ?? null;
}
```

When `sessionId` is absent or unparseable it falls through to
`this.lastActiveChannel` — the channel of whatever message was most recently
received (`src/discord-channel.js:324`). That is a **mutable global**: if
another agent, another user, or another channel spoke last, the trace is
posted there.

**2. The trace emitters carry no session at all.** `recordUse()` at
`src/skills.js:190-210` emits:

```js
this.runtime?.events?.emit?.("skill-use", { skill: name, mode, outcome, at });
```

No `sessionId` field. Same for `skill-edit` (`src/skills.js:254`), which emits
a `record` built by `logEdit` with no session either. So EVERY skill trace
takes the `lastActiveChannel` fallback, 100% of the time. This is not an edge
case — it is the only path.

**3. The session is available and simply is not threaded through.** The tool
handlers already receive `context`, and `src/skills.js:1037` proves
`context?.sessionId` is populated and already used for outcome records. The
`use_skill` handler at `src/skills.js:773-779` calls `this.view(args.name,
args.file)` and drops `context` on the floor.

So the data exists at the boundary and is discarded one frame later.

---

## Workstream A — thread the session through the trace lane

### A1. `recordUse` accepts and emits a session

**Anchor:** `src/skills.js:190`, signature
`recordUse(name, mode, outcome = "ok", at = nowIso())`.

Add a fifth parameter `sessionId = null`. Include it in the emitted payload:
`{ skill, mode, outcome, at, sessionId }`. Do **not** put it in the JSONL
usage log written at `src/skills.js:203` — that file feeds the curator's
activity clock and its schema is validated by `loadUsage`
(`src/skills.js:~1338`); changing it risks breaking curation. Telemetry event
only.

### A2. Thread `context` from every call site

Update all `recordUse` callers to pass `context?.sessionId ?? null`:
`src/skills.js:404, 407, 411` (inside `view`) and `1010, 1073, 1081` (inside
`run`).

`view(name, file)` at `src/skills.js:~393` needs a third parameter
`sessionId = null`; the `use_skill` handler at `src/skills.js:773-779` must
pass `context?.sessionId ?? null`. `run()` already receives `context`
(`src/skills.js:~893`) — read the session off it directly.

### A3. `skill-edit` carries a session too

**Anchor:** `logEdit` / the emit at `src/skills.js:254`.

Every authoring tool handler (`create_skill`, `edit_skill`, `pin_skill`,
`delete_skill`, `restore_skill`, `rollback_skill` in
`src/skills.js:698-890`) already receives `context` and passes
`context?.agentId` as `by`. Thread `context?.sessionId ?? null` through the
same path into the `skill-edit` payload. Where a caller genuinely has no
session (the autocurator's autonomous edits in `src/skill-autocurator.js`),
pass `null` explicitly — do not invent one.

---

## Workstream B — make the fallback fail safe instead of guessing

This is the more important half. Even after A, any event that legitimately has
no session must not be broadcast into an arbitrary channel.

### B1. Delete the `lastActiveChannel` fallback for activity traces

**Anchor:** `src/discord-channel.js:848-851`.

Split the resolution into two explicit functions:

- `activityChannelFor(sessionId)` — returns the channel parsed from the
  session, else `this.activityChannel` (the agent's OWN configured home /
  activity channel), else `null`. **`lastActiveChannel` must not appear in
  this path at all.** A trace with no resolvable session goes to the agent's
  own channel or is dropped — never to whichever channel spoke most recently.
- Keep a separate `replyChannelFor(...)` if any caller genuinely needs
  "where the conversation is happening" semantics for a direct reply. Audit
  the callers of `activityChannelFor` (there are at least two:
  `src/discord-channel.js:714` for approval cards and `:887` in `postEmbed`)
  and decide per call site. **Approval cards must be strictly
  session-scoped** — an approval button posted into the wrong channel lets the
  wrong person approve an action, which is a security bug, not a cosmetic one.

If after this change `lastActiveChannel` has no remaining readers, delete the
field and its assignment at `src/discord-channel.js:324` entirely rather than
leaving a loaded gun in the code.

### B2. Drop, don't misroute

In `postEmbed` (`src/discord-channel.js:886-890`), when no channel resolves,
the current behaviour (`if (!chan) return;`) is correct — keep it. Add a
`this.log({ op: "feed-dropped", reason: "unresolved-session" })` line so a
silently dropped trace is diagnosable rather than invisible.

### B3. Guard against cross-agent bleed explicitly

The reported symptom is Azazel's trace in **Cherubim's** channel. Add a
defensive check in `postEmbed`: if the resolved channel is not in this
adapter's configured guild/channel allowlist, drop and log rather than post.
Each Legion agent runs its own adapter instance with its own channel config,
so a resolved id outside that config is by definition a misroute.

---

## Required tests

Add `test/discord-activity-routing.test.js`:

1. `activityChannelFor("discord:guild:123456")` returns `"123456"`.
2. `activityChannelFor(null)` returns the configured `activityChannel`, and
   **never** `lastActiveChannel` — set `lastActiveChannel` to a distinct
   sentinel id in the fixture and assert the result is not that id. This is
   the regression test for the reported bug; it must fail against the current
   code.
3. `activityChannelFor("garbage")` behaves the same as `null`.
4. With no `activityChannel` configured and no session, `postEmbed` posts
   nothing and logs `feed-dropped`.
5. A `skill-use` event emitted through the runtime carries the `sessionId`
   supplied to `recordUse`, and routes to that session's channel while a
   different `lastActiveChannel` is set.
6. An approval card for an action whose context has a session posts to that
   session's channel only.

Extend the existing skill tests to assert `recordUse` still records usage
identically when `sessionId` is omitted (backward compatibility — the curator
depends on this).

---

## Hard constraints (environment — you cannot discover these yourself)

- Node repo, **zero runtime dependencies**. Do not add a package.
- Gate with `node --test`. Baseline is **1912 passing, 0 failing, 24 skipped**
  (the 24 are pre-existing browser-dependent QA tests). Record it in
  `CHANGES.md` before you start; do not finish below it.
- A live daemon runs from a DIFFERENT checkout under systemd. **Do not
  restart, kill, or touch any running process.** Work in this clone only.
- ASCII only in identifiers and filenames. No Cyrillic/fullwidth lookalikes
  anywhere in the diff — it will be byte-scanned on review.
- Do not change the JSONL usage-log schema (`src/skills.js:203`) — the skill
  curator's activity clock reads it and `loadUsage` validates it.
- Do not weaken existing guards: pinned skills untouchable, every mutation
  through `appendSkillRevision`, `assertDefaultProjectSkillControl` preflights
  intact.
- Commit each workstream separately. Workstream A first.

## Completion marker

When both workstreams are committed, tested green, and pushed, append the
literal line below as the **last line of this file** and include it in the
final commit:

SESSION SCOPED TRACE ROUTING PHASE COMPLETE

SESSION SCOPED TRACE ROUTING PHASE COMPLETE

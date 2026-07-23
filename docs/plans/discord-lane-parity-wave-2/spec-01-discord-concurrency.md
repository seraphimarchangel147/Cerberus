# Spec 01 — Per-user Discord session keys + per-key concurrency

**Marker:** `DISCORD CONCURRENCY PHASE COMPLETE`
**Priority:** 1 (Azazel's #1, "worst UX gap"). **Risk:** Med.
**Files:** `src/discord-channel.js`.

## The two bugs (verified live 2026-07-21)

1. **Global busy-lock serializes the ENTIRE bot.** `discord-channel.js:87`:
   ```js
   this.busy = Promise.resolve(); // serialize agent turns
   ```
   and `:309`:
   ```js
   this.busy = this.busy.then(() => this.runTurn(message, cleaned)).catch(...);
   await this.busy;
   ```
   One promise chain for every channel + every DM. A long turn in one channel blocks
   every other channel and DM behind it. This is the daily blocker.

2. **Session key is per-CHANNEL, not per-user** (`:385`):
   ```js
   sessionId: `discord:${message.guild_id ?? "dm"}:${message.channel_id}`,
   ```
   In a shared guild channel, two users share one session → context bleed between users.

## Required behavior

- **Per-key concurrency:** replace the single `this.busy` promise with a `Map<key,
  Promise>` so turns with DIFFERENT keys run concurrently while turns with the SAME key
  stay serialized (preserves ordering within a conversation, kills cross-conversation
  head-of-line blocking).
- **Per-user session identity in guild channels:** the session key must include the
  author id in guild channels so users don't share context. DMs stay per-channel (already
  1:1). Keep the existing `discord:` prefix shape so `activityChannelFor()`
  (`:638`, regex `^discord:[^:]+:(\d+)$`) and pending-action routing still resolve a
  channel id.

## Implementation

### Session key
Introduce a helper:
```js
sessionKeyFor(message) {
  const guild = message.guild_id ?? "dm";
  const channel = message.channel_id;
  // Guild channels are multi-user → isolate per author to stop context bleed.
  // DMs are already 1:1, keep them channel-keyed for continuity.
  const user = message.guild_id ? (message.author?.id ?? "unknown") : null;
  return user
    ? `discord:${guild}:${channel}:${user}`
    : `discord:${guild}:${channel}`;
}
```
**CRITICAL — update the consumers of the old key shape** or you break approval routing:
- `activityChannelFor(sessionId)` (`:638`) regex is `^discord:[^:]+:(\d+)$`. Broaden to
  capture the channel id even with a trailing `:user` segment:
  `^discord:[^:]+:(\d+)(?::.+)?$`.
- Anywhere the code parses/derives a channel from a sessionId (grep
  `discord:` and the regex) must tolerate the optional 4th segment.
- Pending-action `context.sessionId` (used for session-allow at `:550/:583`) now includes
  the user — that's DESIRABLE (session-allow becomes per-user), but confirm
  `allowForSession` keying still works.

### Per-key concurrency
Replace the single lock with a keyed map. Serialize per key, run different keys in
parallel, and GC settled entries so the map doesn't grow unbounded:
```js
// was: this.busy = Promise.resolve();
this.turnLocks = new Map(); // sessionKey -> tail Promise

enqueueTurn(message, cleaned) {
  const key = this.sessionKeyFor(message);
  const prev = this.turnLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => this.runTurn(message, cleaned)).catch((err) => {
    this.log({ op: "turn-rejected", key, error: err?.message ?? String(err) });
    return this.sendMessage(
      message.channel_id,
      `⚠ Turn failed hard: ${(err?.message ?? String(err)).slice(0, 400)}`,
      message.id
    ).catch((e) => this.log({ op: "turn-rejected-notify-failed", error: e?.message ?? String(e) }));
  });
  this.turnLocks.set(key, next);
  // GC: when this is the current tail and it settles, drop the entry.
  next.finally(() => { if (this.turnLocks.get(key) === next) this.turnLocks.delete(key); });
  return next;
}
```
Call `this.enqueueTurn(message, cleaned)` where the old
`this.busy = this.busy.then(...)` block was (`:305-317`). Whether the top-level handler
should `await` it: do NOT `await` across different keys (that would re-serialize) — the
handler already returns after dispatch; keep the runTurn's own try/catch as the safety
net (the `:307` comment already notes this).

### Optional global safety cap
Add `OPENAGI_DISCORD_MAX_CONCURRENT_TURNS` (default e.g. 4, `WIZARD_FIELDS`) so a flood of
distinct keys can't spawn unbounded concurrent model turns / blow the 12GB WSL cap. A
simple in-flight counter with a small queue is enough; keep it OFF (0 = unlimited) by
default if it complicates P1 — note it as a follow-up rather than block the phase.

## Tests (`test/discord-concurrency.test.js`)
- `sessionKeyFor`: guild message → key ends `:<authorId>`; DM message → no user segment.
- Two messages, DIFFERENT keys: both `runTurn`s are in-flight simultaneously (stub
  runTurn with a deferred promise; assert both started before either resolves).
- Two messages, SAME key: second `runTurn` does not start until the first resolves.
- `activityChannelFor` still extracts the channel id from a 4-segment (per-user) key.
- Map GC: after all turns settle, `turnLocks` is empty.

## Live proof (after restart)
Fire two authed `POST /message` calls with different `sessionId`s that each do slow work;
confirm from `~/.openagi/channels/discord/events.jsonl` (or timing) that they overlap
rather than serialize. Then confirm two different guild users in the same channel get
distinct session files under `~/.openagi/agent-host/sessions/`.

## Definition of Done
Both lanes green + new test file, homoglyph scan clean, live overlap + per-user isolation
demonstrated, `CHANGES.md` entry ending with the marker.

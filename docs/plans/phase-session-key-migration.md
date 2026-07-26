# Phase: Discord session-key migration + lookup fallback (Bug #1)

## Motivation (measured, real incident)

On 2026-07-22 a self-QA of Cerberus found that a Discord guild session forked.
The session-key scheme in `src/discord-channel.js` `sessionKeyFor()` was changed
to append the author id for guild channels:

```
discord:${guild}:${channel}:${user}   // NEW (guild)
discord:${guild}:${channel}            // OLD (still used for DMs)
```

The cutover orphaned the pre-existing transcript. Verified on the live store
(`~/.openagi/agent-host/sessions/`):

- `discord_1477363316836798614_1496557186900431100.json` → **63 messages** (orphaned; old key)
- `discord_1477363316836798614_1496557186900431100_1473282928464105625.json` → **4 messages** (new key, started fresh)

There is **no alias, lookup fallback, or migration** anywhere. The moment the
key gained the `:user` segment, 63 messages of context went dark and the model
started a fresh 4-message history. Subagent sessions
(`subagent_discord_..._<uuid>.json`) were spawned off the old-format base key
and are likewise stranded on the 3-segment lineage.

Goal: recover the orphaned history on first post-upgrade turn, deterministically
and idempotently, with zero data loss, and prevent silent forks like this going
forward.

## Exact anchors (verified against source at commit 147d481)

1. `src/discord-channel.js:318-327` — `sessionKeyFor(message)` builds the key.
   `guild = message.guild_id ?? "dm"`, `channel = message.channel_id`,
   `user = message.guild_id ? (author?.id ?? "unknown") : null`. Returns
   4-segment for guilds, 3-segment for DMs.
2. `src/discord-channel.js:418` — `runTurn` passes
   `sessionId: this.sessionKeyFor(message)` into `agentHost.handleMessage`.
3. `src/agent-host.js:164` — `handleMessage` resolves
   `const sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId })`.
   `sessionKey` (agent-store.js:147-149) just returns the passed `sessionId`
   verbatim (`sessionId ?? default`), so the Discord key flows straight through.
4. `src/agent-host.js:182-184` — first read/append:
   `sessionBefore = await this.store.appendMessage(sessionId, {...})`.
   `appendMessage` → `getSession(sessionId)` → `readJsonFile(sessionPath(id), {empty})`.
   A missing file returns an empty transcript (ENOENT → fallback), which is
   exactly how the fork produced a 4-message fresh session.
5. `src/agent-store.js:151-170` — `sessionPath(id)` =
   `join(sessionsDir, safeFilename(id) + ".json")`; `getSession`, `saveSession`.
   `sessionsDir = join(this.dir, "sessions")` (line 89).
6. `src/file-utils.js:8-15` — `safeFilename` maps `:` `/` `\` and any
   non `[a-zA-Z0-9._-]` to `_`. So key `discord:G:C:U` → file
   `discord_G_C_U.json`; old key `discord:G:C` → `discord_G_C.json`.

## Deliverables

### Fix 1 — One-time, idempotent migration on session resolve (the core fix)

Add a private method on the FileAgentStore-consuming path. The cleanest,
lowest-risk placement is in `src/agent-store.js` on the file-backed store
(the class that owns `sessionPath`/`getSession`/`saveSession` around lines
147-193), as a new method `migrateLegacyKey(newId, legacyId)`:

Behavior (all steps guarded, best-effort, must never throw into the turn):
1. If the target file `sessionPath(newId)` already EXISTS and has a non-empty
   `messages` array → **do nothing, return false** (already migrated / real
   new-format history present; never clobber).
2. Else if the legacy file `sessionPath(legacyId)` exists AND has messages →
   copy it to the new path via `saveSession({ ...legacySession, id: newId })`
   (atomic write already provided by `writeJsonAtomic`). Preserve `createdAt`
   from the legacy session; `saveSession` refreshes `updatedAt`. Leave the
   legacy file in place (do NOT delete — keep a recovery copy; a follow-up
   can prune). Return true.
3. Else return false (nothing to migrate).

Idempotency contract: running it on every turn is safe. After the first turn
copies 63→new, step 1's "target already has messages" guard makes every
subsequent call a no-op. There must be no path that appends or double-copies.

Expose the legacy-key derivation so the caller can supply it. Add a pure
helper (exported, unit-testable) `legacyDiscordKey(sessionId)`:
- Input `discord:<guild>:<channel>:<user>` → returns `discord:<guild>:<channel>`.
- Input already 3-segment (`discord:<guild>:<channel>`) or a DM key or any
  non-matching string → returns `null` (no legacy ancestor).
- Use an anchored regex: `/^discord:([^:]+):([^:]+):([^:]+)$/`. Only the
  exact 4-segment guild shape has a legacy ancestor. Do not touch `dm` keys.

### Fix 2 — Wire the migration into the resolve path

In `src/agent-host.js` right AFTER line 164 (`const sessionId = this.store.sessionKey(...)`)
and BEFORE the first `appendMessage` at line 182-184, call the migration when
a legacy ancestor exists:

```js
const legacyId = legacyDiscordKey(sessionId);
if (legacyId && typeof this.store.migrateLegacyKey === "function") {
  try { this.store.migrateLegacyKey(sessionId, legacyId); }
  catch (err) { this.log?.({ op: "session-migrate-failed", sessionId, legacyId, error: err?.message ?? String(err) }); }
}
```

Guard with `typeof ... === "function"` so the in-memory store variant (which
has no file/migration concept) is unaffected. Import `legacyDiscordKey` from
agent-store.js (or wherever you place the pure helper — keep helper and
`migrateLegacyKey` colocated).

Do NOT change `sessionKeyFor` in discord-channel.js — the new keying is the
intended, correct scheme (guild multi-user isolation). We are recovering the
old lineage into the new key, not reverting the key.

### Fix 3 — Subagent lineage note (scope-limited)

The stranded subagent sessions (`subagent_discord_<guild>_<channel>_<uuid>`)
are keyed off the base session id at spawn time. Do NOT attempt to migrate or
rename subagent files in this phase — they are ephemeral worker transcripts and
renaming risks breaking in-flight resume. Instead, add a one-line comment at
the subagent-spawn site documenting that subagent keys inherit the (now
migrated) base key, so future readers know the base migration is sufficient for
new subagents. If you cannot find a clean single spawn site, skip Fix 3 (it is
documentation-only, non-blocking).

## Tests (required)

Add `test/session-key-migration.test.js` using `node --test`:

1. `legacyDiscordKey` unit tests:
   - `discord:g:c:u` → `discord:g:c`
   - `discord:g:c` → `null`
   - `discord:dm:c` (DM) → `null`
   - `local:user:main` → `null`
   - empty / undefined → `null`
2. `migrateLegacyKey` integration (use a temp sessionsDir):
   - Seed a legacy file with N messages, no new file → after migrate, new file
     has N messages, legacy file still present. Returns true.
   - Run migrate a SECOND time → new file unchanged (still N, not 2N), returns
     false. (idempotency)
   - New file already has messages → migrate is a no-op, does NOT overwrite
     with legacy content. Returns false. (never-clobber)
   - Neither file exists → returns false, no crash.
3. End-to-end through the store: appendMessage to the new key after a migration
   appends to the recovered transcript (message count = N+1), proving the
   handleMessage path sees recovered history.

All new tests must pass under `node --test`; the pre-existing suite must stay
green at its baseline count. Homoglyph-clean (ASCII only in all added lines).

## Hard constraints

- Zero-dependency repo — do NOT add npm packages.
- Best-effort/non-throwing: a migration failure must degrade to "fresh session",
  never break the turn (wrap in try/catch, log via `this.log`).
- Never delete or truncate the legacy file (recovery safety).
- Idempotent: safe to run on every single turn.
- Do NOT revert or alter `sessionKeyFor` — the 4-segment key is correct.
- Commit to branch `codex/session-key-migration`. Keep uncommitted files out;
  commit everything you touch.
- Update `CHANGES.md` with an entry describing the fix and the measured
  incident (63 orphaned messages).

## Completion marker

Finish by appending the literal line below as the LAST line of THIS file, in
the same commit as the code:

SESSION KEY MIGRATION PHASE COMPLETE

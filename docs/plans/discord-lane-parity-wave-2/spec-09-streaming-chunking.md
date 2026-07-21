# Spec 09 — Streaming default-on + fence-aware chunking + bounded 429 retry

**Marker:** `STREAMING CHUNKING PHASE COMPLETE`
**Priority:** 9 (Azazel's #9, nice-to-have). **Risk:** Small. **SCAFFOLD.**
**Files:** `src/discord-channel.js` (sendMessage chunking, `DISCORD_STREAMING`),
`src/model-provider.js` (already streams internally).

## Items
1. **Fence-aware chunking.** Discord's 2000-char limit splits messages; the current chunker
   can split mid ```code fence```, corrupting rendering. Make the splitter fence-aware:
   never break inside a fenced block — close the fence, split, and re-open it on the next
   chunk (` ```lang ` continued). Also prefer splitting on paragraph/line boundaries over
   mid-word. Apply to both normal sends and streamed edits.
2. **Streaming default-on (evaluate).** `DISCORD_STREAMING` exists (default OFF, 1.2s
   throttled edits, rollover before 2000 chars per the skill notes). Consider flipping
   default ON — but only if the fence-aware chunker (item 1) covers the streamed-edit
   rollover too, else streaming worsens the mid-fence split. Gate the flip behind the fix.
3. **Bounded 429 retry on Discord REST.** `rest()` / `sendMessage` should honor Discord's
   429 `retry_after` with a bounded retry (max ~3), rather than failing a send on a
   transient rate limit. (Distinct from spec-02 which is PROVIDER 429s; this is DISCORD API
   429s.)

## Constraints
- Chunker must be pure/testable in isolation (export it). Byte-identical output for
  messages with no fences and under the limit.
- Don't double-send on 429 retry (idempotency: retry only on 429 before any partial send).

## Tests
- Chunker: a message with a code fence spanning the 2000 boundary yields chunks each with
  balanced fences; a plain long message splits on line boundaries; a short message is one
  chunk unchanged.
- 429 retry: a scripted 429-then-200 send succeeds once; 3×429 gives up gracefully.

## DoD
Both lanes green + tests, homoglyph clean, `CHANGES.md` entry ending with the marker.
Streaming-default decision recorded in the entry.

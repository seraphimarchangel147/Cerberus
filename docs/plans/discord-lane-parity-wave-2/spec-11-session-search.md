# Spec 11 — Session search: bm25 rank + filters; verify/clean tool name

**Marker:** `SESSION SEARCH PHASE COMPLETE`
**Priority:** 11 (Azazel's #11, nice-to-have). **Risk:** Small. **SCAFFOLD.**
**Files:** `src/session-index.js` (search :140, query :167-168).

## Items
1. **bm25 ranking.** `session-index.js:168` orders results `ORDER BY ts DESC` — pure
   recency, ignoring relevance. SQLite FTS5 provides `bm25(messages)`. Change the ranked
   query to `ORDER BY bm25(messages) [, ts DESC]` so the best textual match ranks first,
   with recency as a tiebreak. Keep the JSONL fallback path (`:70`, no FTS) working
   (it can stay recency-ordered with a note).
2. **Filters.** Add optional filters to `search(query, opts)`: `role`
   (user/assistant/tool), `sessionId`, time range (`since`/`until`). Thread them into the
   FTS query WHERE clause safely (parameterized, never string-interpolated).
3. **Tool-name cleanup.** Azazel claims the live tool list contains `searcmcp_sessions` as a
   "shipped typo." Seraphim could NOT corroborate a literal typo — grep shows it as the
   intentional name in `session-index.js` and CHANGES.md ("intentionally named read-only
   searcmcp_sessions"). ACTION: confirm the actual registered tool name in the tool registry;
   if there's a genuine misspelling or a stale duplicate/alias, remove it; if the name is
   correct, note "no typo found — name is intentional" in CHANGES.md and close item. Do not
   rename a working tool on an unverified claim (breaking callers).

## Constraints
- bm25 is only available on FTS5 virtual tables — guard for the fallback (non-FTS) path.
- Snippet cap already exists (:22) — keep it.

## Tests
- Ranked search returns the best textual match first (not just newest) on FTS path.
- Role/time filters narrow results correctly; params are bound (injection-safe).
- Fallback (no-FTS) path still returns results.

## DoD
Both lanes green + tests, homoglyph clean, tool-name question resolved either way in the
`CHANGES.md` entry, which ends with the marker.

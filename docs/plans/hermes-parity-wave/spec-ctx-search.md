# Spec 4 — `searcmcp_sessions` (session_search over own transcripts)

Branch: `codex/ctx-search`. Reviewer: Seraphim. Read `README.md` first. This is the SMALLEST
lift in the wave — the engine already exists, it was just never exposed as a tool.

## Goal

Let Azazel answer "what did we do about X last week?" by searching his OWN past session
transcripts, the way Hermes's `session_search` does.

## What already exists (do NOT rebuild)

- `src/session-index.js` — `SessionIndex`: SQLite **FTS5** index over every persisted chat
  message, file-backed at `<dataDir>/agent-host/session-index.db`, with a JSONL fallback when
  `node:sqlite` is unavailable. It ALREADY has:
  - `async search(query, { limit = 8 })` → `[{ sessionId, ts, role, snippet }]` (snippet
    capped for privacy).
  - `indexMessage(...)` (live-appended from `agent-host.js` on every turn).
  - `rebuildFromTranscripts(store)` (boot backfill, wired in `abi-runtime.js`).
- The tool `searcmcp_sessions` referenced in the file's header comment was **never registered**.
  That's the entire gap.

## Implementation

### 1. New file: `src/integrations/session-search-tool.js` (or fold into an existing
integration registrar)

Register tool `searcmcp_sessions`:
```
name: "searcmcp_sessions"
sideEffects: false
description: "Search your OWN past conversations (full-text over session transcripts). Use to
  recall prior decisions, context, or 'what did we do about X'. Returns matching snippets with
  their session id and timestamp."
parameters: {
  query: string (required),
  limit?: integer (1..20, default 8)
}
handler: async (args, context) => {
  const idx = context.runtime?.sessionIndex ?? runtime.sessionIndex;
  const hits = await idx.search(args.query, { limit: clamp(args.limit ?? 8, 1, 20) });
  if (!hits.length) return { query: args.query, count: 0, hits: [] };
  return { query: args.query, count: hits.length, hits };
}
```

Wire the registration into wherever the other first-party tools register (near
`registerCodeTools` / `registerWebSearchTools` in `abi-runtime.js` assembly). Pass `runtime`
so the handler can reach `runtime.sessionIndex`.

### 2. Privacy note (already handled, keep it)

`SessionIndex.search()` already caps snippet length so a single hit can't dump a long personal
passage. Do NOT add a "return full transcript" mode in v1 — snippets only. If the model needs
more, it can ask the user or open the specific session id via a future tool.

### 3. Scrutiny

`sideEffects:false` → available under `act`/`ask`/`watch`, blocked only under `ignore`. Good
default; no special gating.

### 4. Optional: `/recall <query>` Discord slash command

Mirror the tool as a slash command in `discord-commands.js` (pattern identical to `/memory`
which already calls `runtime.memory.retrieve`). Low effort, nice for the operator. Add to
`COMMAND_DEFS` + a `cmdRecall` handler. Skip if time-boxed — the tool is the deliverable.

## Tests (`test/session-search-tool.test.js`)

- Seed a `SessionIndex` (in-memory/temp dir) with a few messages, register the tool against a
  fake runtime, invoke it → assert hits returned with capped snippets.
- Empty query / no matches → `count:0`, no throw.
- `limit` clamped to 1..20.
- Fallback path (force `fallback:true`) still returns results.

## Definition of done

Both lanes green, homoglyph-clean, CHANGES.md, commit SHA, branch only. This one should be a
quick win — flag it if it takes more than a couple hours, that means something in the index
wiring is off and Seraphim should look.

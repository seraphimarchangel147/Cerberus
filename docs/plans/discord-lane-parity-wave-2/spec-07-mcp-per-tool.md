# Spec 07 — MCP per-tool selection + in-band overflow notice + tool search

**Marker:** `MCP PER-TOOL PHASE COMPLETE`
**Priority:** 7. **Risk:** Med. **SCAFFOLD.**
**Files:** `src/tool-registry.js` (`_modelToolList` at :85-136, `toOpenAITools`/
`toAnthropicTools`).

## What's ALREADY built (do not redo — verified 2026-07-21)
`tool-registry.js:89-136` already:
- filters by `options.only` (advisory allowlist),
- caps at `OPENAGI_MAX_MODEL_TOOLS` (default 128),
- picks per-SERVER within a budget, and
- `_logToolCap()` `console.warn`s the overflow ("never silently drop tools; reachable via
  run_mcp_tool").
So Azazel's "PostHog drops entirely, model never told" is STALE — it's server-granular and
the notice is out-of-band (console only, model doesn't see it).

## Remaining work
1. **Per-TOOL granularity.** Instead of dropping/keeping whole servers, allow selecting
   individual tools across servers up to the budget (e.g. keep a representative/most-used
   subset per server, or rank by recent-use telemetry if available). A 118-tool server
   should contribute its most relevant tools, not all-or-nothing.
2. **In-band overflow notice.** Beyond `console.warn`, surface to the MODEL that N tools
   are reachable via `run_mcp_tool` — e.g. append a short system/tool note listing overflow
   servers+counts, so the model knows to escalate. Keep it tiny (don't re-bloat the
   context the cap is protecting).
3. **`searcmcp_tools` tool.** Add a tool that lets the model query the full registry by
   keyword and get back matching tool names+descriptions (Hermes's tool-search parity), so
   capped tools are discoverable on demand. Read-only, no side effects.

## Constraints
- Byte-identical when under the cap and no `only`/search used (guard the hot path — the
  existing code already documents this invariant at :88 "existing hot path byte-for-byte").
- Don't change the invocation gate — `run_mcp_tool` / scrutiny stays authoritative; this is
  advertisement only.

## Tests
- Per-tool selection keeps core tools + a bounded per-tool subset; total ≤ cap.
- Overflow produces an in-band notice string (assert it's present when over cap, absent
  under cap).
- `searcmcp_tools` returns matches for a keyword; empty for no match.
- Regression: under-cap, no-options call byte-identical to before.

## DoD
Both lanes green + tests, homoglyph clean, `CHANGES.md` entry ending with the marker.

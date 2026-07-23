# Spec 03 — Context compression (per-tool output caps + mid/cross-turn compaction)

**Marker:** `CONTEXT COMPRESSION PHASE COMPLETE`
**Priority:** 3 (Azazel's #3 — "biggest token/drift win"). **Risk:** Med-Lg. **SCAFFOLD.**
**Files:** `src/model-provider.js` (the iteration loop that pushes to `conversationInput`).

## Problem
Tool outputs are appended to `conversationInput` and re-sent in full every hop. Verified:
the OpenAI path pushes `function_call_output` at :618/:631, the Anthropic path builds
`tool_result` blocks similarly; nothing caps or compacts them. A few large tool outputs
(file reads, graphify dumps, web fetches) balloon the context, cost tokens every iteration,
and drift the model. There is a `truncate()` helper (:1128) used for memory-hit display
(:435) but NOT for tool outputs in the conversation.

## Direction (Hermes parity)
Three layers, cheapest first:
1. **Per-tool-output cap (mid-turn).** When appending a `function_call_output` /
   `tool_result`, cap its serialized length at `OPENAGI_MAX_TOOL_OUTPUT_CHARS` (default
   e.g. 8000). On overflow, store the FULL output out-of-band (a ref id) and append a
   head+tail-truncated version with a `[...N chars elided; full output at ref:<id>...]`
   marker. Keep image blocks (base64 screenshots) exempt from char-count but capped by
   count. Wire at the two `conversationInput.push({type:"function_call_output"...})` sites
   (:618/:631) and the Anthropic equivalent.
2. **Cross-turn compaction.** When the running transcript exceeds a token/char budget
   (`OPENAGI_CONTEXT_COMPACT_CHARS`), summarize the OLDEST tool outputs / assistant hops
   into a compact recap block, preserving the most recent K hops verbatim. Reuse the
   memory-condenser summarizer (`summarizeText` in memory-system.js) or a cheap aux-model
   call (see spec-08) for the summary. Never compact the current user turn or the system
   prompt.
3. **Optional: mid-turn compaction** at the iteration boundary when a single turn runs many
   hops (Azazel's cap is 120) so late hops don't carry every early tool dump.

## Constraints / pitfalls
- Must be byte-identical for turns UNDER the caps (guard the hot path — same lesson as the
  `only:[...]` tool-list option, which already guards "behave identically when absent").
- Compaction must NOT drop a `function_call` without also handling its `function_call_output`
  (well-formedness — see spec-02's orphan reconcile; reuse that helper).
- Store elided full outputs under `~/.openagi/` via `file-utils.js` so `ref:<id>` is
  retrievable (optionally expose a `read_tool_output` tool so the model can pull the full
  thing on demand — Hermes does exactly this).
- Config knobs to `WIZARD_FIELDS`: `OPENAGI_MAX_TOOL_OUTPUT_CHARS`,
  `OPENAGI_CONTEXT_COMPACT_CHARS`, `OPENAGI_CONTEXT_KEEP_RECENT_HOPS`.

## Tests
- A tool output over the cap is truncated with the marker + a retrievable ref; under the
  cap is untouched.
- A transcript over the compact budget yields a recap block + verbatim recent hops; total
  size drops; no orphaned function_calls.
- Regression: a short turn produces byte-identical conversationInput to pre-change.

## Live proof
Fire a turn that reads a large file / does a big tool dump; confirm via events.jsonl / token
metadata that later hops carry the truncated form and total tokens drop vs. baseline.

## DoD
Both lanes green + tests, homoglyph clean, token reduction demonstrated, `CHANGES.md` entry
ending with the marker.

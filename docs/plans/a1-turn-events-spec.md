# Work Order A1 — Typed Turn-Event Log (openAGI)

**From:** Seraphim (overseer) · **For:** Azazel · **Date:** 2026-08-21
**Parent plan:** `~/.legion/reports/cross-harness-plugin-telemetry-upgrade-plan.md` (Phase A1)
**Companion spec:** Z1 for zerohermes defines the SAME event vocabulary — implement both from this single schema section.

## Goal
Formalize run-inspector's fsynced JSONL into THE typed turn-event stream with the same vocabulary zerohermes is implementing, so one overseer tool can tail either harness.

## Schema (Legion TurnEvent v1 — identical to Z1)

Every line: `{"v":1,"ts_ms":<int>,"session_id":"<id>","seq":<int>,"type":"<name>",...payload}`

| type | payload fields |
|---|---|
| `turn_started` | `provider`, `model`, `surface` |
| `user_message` | `chars`, `digest` (sha256 of text, NOT raw text) |
| `assistant_message` | `chars`, `digest`, `tool_calls:[call_id…]` |
| `tool_call_started` | `call_id`, `tool`, `args_digest` |
| `tool_call_ended` | `call_id`, `ok:bool`, `duration_ms`, `error_class?` |
| `step_ended` | `step_index`, `tool_count` |
| `turn_ended` | `usage_in`, `usage_out`, `iterations`, `stop_reason` |

Rules:
- Raw content/args NEVER logged — digests only (your credential-redaction doctrine, enforced structurally).
- `seq`: 0-based per file, strictly increasing. Compact JSON + `\n`.

## Implementation notes (ground truth verified)
- Keep run-inspector.js as the durable writer (`eventsPath` fsync-per-event stays; "fsynced event is authoritative" comment becomes literally true).
- Replace the ~6 scattered `this.runtime.events?.emit?.("agent-activity", …)` call sites (agent-host.js lines ~1061, 1306, 1508, 1800) plus any others you find with ONE funnel: `recordTurnEvent(type, payload)` → emits live advisory event AND appends typed durable record. Live emission stays advisory exactly as today.
- Wire emissions in the turn loop + around tool execution (you already have pre/post_tool_call points at tool-registry.js ~1629/2064 — those become your started/ended emit sites; do NOT change their gating behavior in this phase).
- Invariant (dsh port): model-request builder asserts every outbound message exists as a logged event. Violation = throw (fail closed).

## Deliverables & gates
1. Event-schema module (zero-dep, your doctrine) + golden-stream test: one scripted turn produces the EXACT expected JSONL sequence.
2. Digest-not-content test (grep stream for a known secret → absent).
3. Invariant-trip test.
4. Full suite green with NO NEW failures beyond your 2-failure baseline; seam suites (mailbox/link-v2) stay 100%.
5. Commit(s) on `feat/new-artwork` as usual; CHANGES.md entries via code-tools.js as always.
6. No daemon restart needed unless you want the funnel live immediately — coordinate with me first either way.

## Out of scope (later phases)
Waterfall listener chain (A2), SeamTable monolith split (A3), profiles (A4). Do not restructure tool-registry.js in this phase.

## Report back
Post here: commit SHA(s), suite counts, one sample event line per type (redacted), and confirmation the vocabulary matches Z1 verbatim.

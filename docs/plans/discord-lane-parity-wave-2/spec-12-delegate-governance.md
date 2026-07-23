# Spec 12 — delegate_subtask governance parity (or deletion)

**Marker:** `DELEGATE GOVERNANCE PHASE COMPLETE`
**Priority:** 12 (Azazel's #12). **Risk:** Small. **Files:** `src/code-tools.js` (:403).

## The gap (verified 2026-07-21)
`code-tools.js:403` registers `delegate_subtask`. It HAS a nesting guard
(`if (context?.channel === "subagent") throw ...`), but its handler calls
`host.handleMessage({ channel: "subagent", ... })` directly — bypassing the normal tool
scrutiny / budget / audit path that a governed `delegate_task` would enforce. It's a
governance bypass, not a nesting hole.

## Direction — pick ONE
**Option A — bring it up to governance parity:**
- Route the sub-turn through the same budget guard (`OPENAGI_MAX_TURN_USD` /
  per-hop budget) so a delegated turn can't spend unbounded.
- Emit audit records (outcome-store) for the delegation: who delegated, prompt label,
  cost, result — same as other side-effecting tools.
- Apply scrutiny/side-effect classification: mark it `sideEffects: true` so it's honestly
  categorized (it spawns a full agent turn).
- Cap concurrency/count (`OPENAGI_MAX_CHILDREN` — Azazel noted this already fires at 3;
  ensure `delegate_subtask` respects it, not just some other path).
- Keep the nesting guard.

**Option B — delete it** if `delegate_task`/another governed path already covers the use
case. Grep for callers/tests first; if nothing depends on it and a governed equivalent
exists, remove the tool and its tests, note the removal in CHANGES.md.

Recommendation: **Option A** unless a governed `delegate_task` already exists and
`delegate_subtask` is purely redundant — decide by grepping the registry for both names.

## Tests
- (A) A delegated sub-turn records an audit entry, is bounded by budget, respects
  `OPENAGI_MAX_CHILDREN`, and still refuses to nest.
- (B) Tool removed; no dangling references; governed path covers the case.

## DoD
Both lanes green + tests, homoglyph clean, decision (A or B) recorded, `CHANGES.md` entry
ending with the marker.

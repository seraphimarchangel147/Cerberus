# Spec 08 — Post-turn background self-improvement review (cheap aux model)

**Marker:** `BACKGROUND REVIEW PHASE COMPLETE`
**Priority:** 8 (Azazel's #8). **Risk:** Med. **SCAFFOLD.**
**Files:** `src/agent-host.js` (post-turn hook), reuse `src/memory-system.js`,
`src/skills.js`, `src/outcome-store.js`. Model routing via `src/model-router.js`.

## Direction (Hermes parity)
After a turn completes, optionally run a CHEAP auxiliary-model pass that:
1. **Captures durable memories** from the turn (preferences, corrections, environment
   facts) → write via the existing MemorySystem (respect tiers + the condenser de-dup from
   spec-04; do NOT write `critical:true` junk).
2. **Proposes skill patches / new skills** when a non-trivial workflow succeeded → route
   through the existing skill materialize/candidate pipeline
   (`skill-materialize.js`/`skill-replay.js`) and, if it has side effects, the approval
   gate (spec-05 suspend/resume) — never auto-write skills silently.

## Wiring
- Hook at the end of `agent-host.handleMessage` (after the reply is sent), fired
  asynchronously so it never blocks the user reply. Guard with
  `OPENAGI_BACKGROUND_REVIEW` (default OFF until proven) in `WIZARD_FIELDS`.
- Use a cheap tier via `model-router.js` TASK_PROFILES (add a `review` task → cheapest
  tier). For Azazel that's still the kimi endpoint — use the base/highspeed model, small
  token budget, hard iteration cap (e.g. 2).
- Persist proposals to `~/.openagi/` (JSONL) and surface accepted memory/skill changes in
  the activity feed / dashboard, with approval where side-effecting.

## Constraints
- MUST be fully async / best-effort: a review failure never affects the user turn (wrap in
  try/catch, log only).
- Rate-limit: skip review for trivial/conversational turns (reuse the
  `isConversationalTurn` signal) so it doesn't burn tokens on "hi".
- No recursion: a review pass must not itself trigger another review.

## Tests
- Review runs after a substantive turn, is skipped for a conversational turn, and never
  throws into the main path (inject a failing aux model → user turn still returns).
- Proposed memory respects de-dup + tier rules; proposed skill goes to candidate/approval,
  not a silent write.

## DoD
Both lanes green + tests, homoglyph clean, default OFF, `CHANGES.md` entry ending with the
marker.

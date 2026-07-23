# Spec 3 — `delegate_task` / Parallel Subagents

Branch: `codex/subagents`. Reviewer: Seraphim. Read `README.md` first. This is the
highest-value / highest-risk item — build it AFTER web-search and execute-code are merged.

## Goal

Hermes-style `delegate_task`: spawn one or more subagents that work in ISOLATED contexts
(own conversation, own tool loop) and return ONLY a final summary to the parent. The parent's
context never sees the subagents' intermediate tool output. Supports a batch of up to N
concurrent tasks (config, default 3).

## What exists today (don't rebuild, extend)

- `src/specialist-router.js` (`SpecialistRouter`) + `ensureSpecialistAgent` in agent-host.js:
  this ROUTES a message to a specialist persona in the SAME session. It is NOT isolated
  parallel execution with a summary-only return. Reuse the specialist ALLOWLIST/bounding
  machinery (`agent.metadata.specialist.allowedTools`) for tool-scoping subagents, but the
  execution model is new.
- `AgentHost.handleMessage` is the single turn engine. A subagent = a fresh sessionId +
  a bounded tool policy + a capped iteration budget, run through the SAME `handleMessage`.

## Implementation

### 1. New file: `src/integrations/delegate-task.js`

Register tool `delegate_task`:
```
parameters: {
  goal?: string,                 // single-task mode
  context?: string,              // background the subagent needs (it knows nothing of parent chat)
  role?: "leaf" | "orchestrator" (default "leaf"),
  tasks?: [{ goal, context, role }]   // batch mode (mutually exclusive with goal)
}
sideEffects: true
```

Handler:
1. Validate: exactly one of `goal` / `tasks`. Cap batch at `OPENAGI_MAX_CHILDREN` (default 3).
2. For each task, build an isolated run:
   - `sessionId = \`subagent:${parentSessionId}:${uuid}\`` (own session file, own memory scope
     — do NOT write subagent turns into the parent session).
   - Seed the subagent's first user message = `goal` + a clearly delimited `context` block.
   - Tool policy: `leaf` gets the standard tool set MINUS `delegate_task` (no nesting for
     leaves — enforce `OPENAGI_MAX_SPAWN_DEPTH`, default 1) MINUS interactive tools. An
     `orchestrator` keeps `delegate_task` but is silently demoted to `leaf` when depth cap = 1.
   - Iteration budget: a smaller cap (`OPENAGI_SUBAGENT_MAX_ITERATIONS`, default 30) + its own
     wall-clock guard (default 600s) so a runaway child can't burn the whole budget.
3. Run tasks **concurrently** with `Promise.allSettled` (batch) — each is an independent
   `agentHost.handleMessage({ channel:"subagent", sessionId, text, ... , routeTo:false })`.
   `routeTo:false` skips the specialist router (already inside a delegated run).
4. Collect each child's FINAL `reply` only. Return:
   ```
   { results: [{ goal, ok, summary, iterations, stopReason, error? }], ... }
   ```
   The parent model receives just the summaries.
5. Budget: children share the parent's `runtime.budget` guard (same daily cap). Each child
   re-checks `checkRequestBudget` per iteration (already built into the providers).

### 2. Isolation & safety

- Children MUST run under the parent turn's scrutiny verdict OR STRICTER — never more
  permissive. A child cannot escalate past the parent's tool policy. Pass the parent's
  `__scrutinyPolicy` down as a ceiling.
- Catastrophic gate still applies inside children (route child tool calls through the same
  `runtime.tools.invoke`).
- Depth guard: `context.__spawnDepth` increments per level; refuse to spawn past
  `OPENAGI_MAX_SPAWN_DEPTH`. Return `{error:"max spawn depth"}` rather than throwing.
- Children are NOT durable: if the parent turn is cancelled/errors, cancel outstanding child
  promises (AbortController wired into each child's provider call).
- Children CANNOT use interactive/asking tools (no clarify equivalent) — they run headless.

### 3. Live-status integration (nice-to-have, do if cheap)

Emit an `{phase:"subagent", n, total, state}` tool-event so the Discord status card can show
"delegating 2/3…". Reuse the existing `__onToolEvent` plumbing.

### 4. Config surface

Add to the env/wizard allowlist: `OPENAGI_MAX_CHILDREN` (3), `OPENAGI_MAX_SPAWN_DEPTH` (1),
`OPENAGI_SUBAGENT_MAX_ITERATIONS` (30), `OPENAGI_SUBAGENT_MAX_TURN_SECONDS` (600).

## Tests (`test/delegate-task.test.js`)

- Single task: a stubbed model that calls one tool then answers → parent gets ONLY the
  summary, and the parent session file does NOT contain the child's turns.
- Batch of 3: all run, `results` has 3 entries, one failing child → `ok:false` + `error`, the
  others still return (Promise.allSettled semantics).
- Depth cap: a leaf trying to `delegate_task` again → refused.
- Scrutiny ceiling: under a `watch` parent verdict, a child cannot invoke a side-effecting
  tool (prove the ceiling holds). Unpinned; must pass in both lanes.
- Budget: children increment the shared budget guard.

## Definition of done

Both lanes green, homoglyph-clean, CHANGES.md, commit SHA, branch only. Report the isolation
boundary (how child sessions/memory are kept out of the parent) for Seraphim review — this is
the part most likely to leak context if done wrong.

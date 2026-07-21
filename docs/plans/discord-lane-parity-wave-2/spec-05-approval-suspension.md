# Spec 05 — In-channel approval turn-suspension (resume after approve)

**Marker:** `APPROVAL SUSPENSION PHASE COMPLETE`
**Priority:** 5 (Azazel's #5 — he stalled on `code_shell` during the review turn itself).
**Risk:** Med. **Files:** `src/tool-registry.js`, `src/discord-channel.js`,
`src/model-provider.js` (minimal), `src/pending-actions.js`.

## The bug (verified 2026-07-21)

When auto-approve is OFF and a gated tool is invoked, `tool-registry.js:255` returns:
```js
return { ok: true, result: {
  status: "awaiting_confirmation", actionId: action.id, summary: action.summary,
  message: `Queued for human approval. Visit the dashboard's Approvals tab (or run /pending-actions)...`
}};
```
This is fire-and-forget: the tool result handed back to the model is a "go check the
dashboard" string. The model has no way to WAIT for the human decision and resume the same
turn — it either dead-ends or hallucinates that the action happened. In-channel there's no
suspend/resume, so the agent stalls (exactly what Azazel hit).

Note: auto-approve is default-ON for Azazel, so this path is the OFF case + the
catastrophic-class hard-gate (which ignores auto-approve). Both need real suspend/resume.

## Required behavior (Hermes-style suspend → approve → resume)

When a gated tool diverts to the approval queue, the tool invocation should **await the
human decision** (up to a timeout) and then return the ACTUAL result (approved → real tool
output; denied → an error result the model can reason about), so the turn continues
naturally within its iteration/wall-clock budget.

## Implementation

### 1. Make PendingActionStore awaitable
In `src/pending-actions.js`, add a promise that resolves when an action is decided:
```js
enqueue(spec) {
  const action = { ...spec, id: `act_${randomHex()}`, status: "pending", createdAt: Date.now() };
  action._decided = new Promise((res) => { action._resolve = res; });
  // ...persist as today (JSONL + snapshot)...
  return action;
}
decide(id, { decision, decidedBy, result, error }) {
  const action = this._byId(id);
  if (!action || action.status !== "pending") return;
  action.status = decision === "approve" ? "approved" : "denied";
  action.decidedBy = decidedBy; action.result = result; action.error = error;
  // ...persist...
  action._resolve?.({ decision, result, error });
}
waitForDecision(id, { timeoutMs }) {
  const action = this._byId(id);
  if (!action) return Promise.resolve({ decision: "denied", error: "unknown action" });
  if (action.status !== "pending") return Promise.resolve({ decision: action.status === "approved" ? "approve" : "deny", result: action.result, error: action.error });
  return Promise.race([
    action._decided,
    new Promise((res) => setTimeout(() => res({ decision: "timeout" }), timeoutMs))
  ]);
}
```
Keep `_decided`/`_resolve` NON-enumerable / stripped from anything serialized to disk
(they're runtime-only). On daemon restart, in-flight awaits are lost — that's acceptable
(the turn was already gone); the action stays `pending` in the store for manual handling.

### 2. tool-registry.invoke() — await instead of returning the string
Replace the fire-and-forget return (the `:255` block) with a suspend-and-await:
```js
const action = this.pendingActions.enqueue({ toolName: name, args, context, summary, reason });
context.__onToolEvent?.({ phase: "awaiting-approval", actionId: action.id, toolName: name, summary: action.summary });
const timeoutMs = Number(process.env.OPENAGI_APPROVAL_TIMEOUT_MS) || 300000; // 5 min
const decision = await this.pendingActions.waitForDecision(action.id, { timeoutMs });
if (decision.decision === "approve") {
  return this.invoke(name, args, { ...(context ?? {}), __confirmed: true });
}
if (decision.decision === "timeout") {
  this.pendingActions.decide?.(action.id, { decision: "deny", decidedBy: "timeout", error: "approval timed out" });
  return { ok: false, error: `Action ${action.id} timed out awaiting approval after ${Math.round(timeoutMs/1000)}s.` };
}
return { ok: false, error: `Action ${action.id} denied by ${decision.decidedBy ?? "human"}.` };
```
- Config `OPENAGI_APPROVAL_TIMEOUT_MS` (default 300000) in `WIZARD_FIELDS`.
- The awaited approval must run WITHIN the turn's wall-clock budget. Ensure the turn
  wall-clock guard (`OPENAGI_MAX_TURN_SECONDS`, default 900) is >= approval timeout, or
  that the approval await is excluded from the stall watchdog (it's not model silence, it's
  a human wait). IMPORTANT: the stall watchdog (`OPENAGI_STALL_TIMEOUT_MS`, default 120s)
  must NOT abort a turn that's legitimately blocked on human approval — gate the watchdog
  off while `awaiting-approval` is active (emit the phase event and have the model-provider
  pause the idle timer between `awaiting-approval` and the tool result).

### 3. Discord approve/deny already posts buttons — wire the resolve
`discord-channel.js` already renders catastrophic approval prompts with buttons
(`pa:approve|session|deny:<id>` at :550-583) and has `/pending-actions` command approval.
Confirm BOTH decision paths call `pendingActions.decide(id, {...})` (which now resolves the
await). The button handler at :583 (`allowForSession`) and the approve/deny handlers must
route through `decide()`. The synchronous HTTP approve endpoint
(`POST /pending-actions/<id>/approve`) must ALSO resolve the await rather than re-invoking
in parallel — i.e. `decide(approve)` triggers the suspended invoke's resume; avoid
double-execution (guard: an action already `approved`/resumed can't be approved again).

### 4. Auto-approve path unchanged
The `autoApproveEnabled()` branch (:238-253) stays as-is (immediate run + audit resolve).
Only the OFF / catastrophic-divert path gains suspend/resume.

## Tests (`test/approval-suspension.test.js`)
- `waitForDecision` resolves `approve` when `decide(approve)` is called; returns the real
  result on resume; resolves `deny`; resolves `timeout` after the timeout with a fake clock.
- `invoke()` on a gated tool (auto-approve OFF): pending until decided; on approve returns
  the real tool result; on deny returns an error result the model can see; on timeout
  returns a timeout error and marks the action denied.
- Double-approve guard: approving an already-resumed action is a no-op.
- Auto-approve ON path is byte-identical to before (regression).

## Live proof
Auto-approve OFF, fire an authed `POST /message` that triggers a gated `code_shell`;
approve via the button / HTTP endpoint; confirm the SAME turn resumes and returns the tool
output (read events.jsonl: `awaiting-approval` → decision → tool result → final answer, no
stall abort). Repeat with deny and with timeout.

## Definition of Done
Both lanes green + new tests (queue-semantics tests pin `OPENAGI_AUTO_APPROVE=0`), homoglyph
clean, suspend→approve→resume demonstrated live, watchdog does NOT abort an approval wait,
`CHANGES.md` entry ending with the marker.

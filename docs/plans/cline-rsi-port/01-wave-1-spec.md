# Phase: Cline RSI Port — Harness Reliability Wave 1

**Spec author:** Seraphim · **Date:** 2026-07-29
**Read first:** `docs/plans/cline-rsi-port/00-assessment.md` (evidence + verdicts)
**Baseline:** `main` @ `7b17563`
**Upstream reference:** Cline PR #12465 @ `d1324e402a58`, Apache-2.0

> **READ THIS SPEC IN FULL BEFORE EDITING ANY FILE.** Every anchor below was verified
> against live source on 2026-07-29. If an anchor does not match what you find, STOP and
> report the mismatch in `CHANGES.md` instead of guessing.

## Scope and non-goals

Six fixes, ordered by risk (lowest first). Every one must be defensible **without
mentioning any benchmark** — these are general harness reliability improvements.

**NON-GOALS — do not do these:**
- Do NOT port Cline's `LoopDetectionTracker` class verbatim. Our tracking unit is a
  per-turn `fingerprint` scope, not a flat last-call pair. Port the *rule*.
- Do NOT replace `requestWithRetry()` with an SDK's `maxRetries`. Our classifier is better.
- Do NOT import Terminal-Bench, Harbor, or any benchmark harness.
- Do NOT add hardcoded per-model effort→budget lookup tables.
- Do NOT touch `apps/`-style CLI/TUI surfaces (we have no analogue).

**Hard constraints:**
- WSL 12GB memory cap — never run a full parallel build.
- The **live daemon must not be restarted** by you. Leave it alone; the Creator bounces it.
- Node zero-dep repo: no new dependencies, ever.
- `npm test` must stay green. **Verified baseline on `main` @ `f786534` (2026-07-29):
  `tests 2083 · pass 2059 · fail 0 · skipped 24`.** Your final suite must show **fail 0** and
  a pass count of **at least 2059** plus your new tests. Re-measure yourself before editing.
- Every fix gets a test that fails before the fix and passes after.
- Commit each fix separately with a descriptive message.

---

## Fix 1 — Shell tool: PID guidance, prevent daemon self-kill

**Anchor:** `src/code-tools.js:1056`

```js
description: "Run a shell command in the current project workspace. THIS REQUIRES USER APPROVAL because arbitrary commands are dangerous. Prefer the specific code_* tools when they cover the need.",
```

**Bug:** No guidance against broad pattern-kills. Cline lost 2 benchmark tasks to an agent
running `pkill -f <pattern>` where the pattern matched **its own harness command line**,
terminating itself mid-task. Our blast radius is worse: openAGI is a long-lived supervising
daemon, so a broad `pkill -f` from `code_shell` can kill the daemon itself and every child
it supervises.

**Fix:** Append to the description string (keep existing text intact):

> "Commands must be non-interactive; use flags like `git --no-pager` to avoid pagers. When
> you start background work, capture its PID or process group and use that exact identifier
> to stop it later. Never use broad command-line matching such as `pkill -f` or
> `killall` — the pattern can match this agent's own supervising process and terminate the
> harness mid-task."

**Test:** assert the registered `code_shell` description contains `pkill` and `PID`, so the
guidance cannot be silently dropped by a future edit.

---

## Fix 2 — Retry ceiling: 3 → 5 attempts, raise max single delay

**Anchors:** `src/model-provider.js:81-83`

```js
const DEFAULT_PROVIDER_MAX_RETRIES = 3;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 500;
const MAX_PROVIDER_RETRY_DELAY_MS = 8000;
```

**Bug:** Cline's Experiment 1 measured **5 benchmark tasks lost to a single 429** where the
session was otherwise healthy. Three retries at base 500ms covers only ~3.5s of backoff.
When one provider serves a hot model under tight capacity, that is far too short a window.

**Fix:**
- `DEFAULT_PROVIDER_MAX_RETRIES` → `5`
- `MAX_PROVIDER_RETRY_DELAY_MS` → `30000`
- Add a comment recording the rationale and that 5 retries at base 500ms with the 30s cap
  covers roughly a minute of provider unavailability.

**Do NOT change:** the `RETRYABLE_PROVIDER_STATUSES` set, the `Retry-After` handling at
`:201`/`:297-301`, or the rule that retry wraps only the HTTP request (`:262-263`). Those
are already correct and better than upstream.

**Test:** a stub request failing 4 consecutive times with a retryable 429 must ultimately
succeed on the 5th attempt; a non-retryable 400 must NOT be retried; honoring an explicit
`Retry-After` must still take precedence over computed backoff. Use the existing
`retrySleep`/`retryRandom` injection points (`:383-384`) so tests don't actually sleep.

---

## Fix 3 — Unref'd-timer regression guard

**Current state:** `grep -rn '\.unref()' src` returns **zero hits**. We are clean.

**Bug class being guarded (Cline Experiment 3):** a `setTimeout(...).unref()` fallback timer
that a **foreground caller is awaiting**. If the worker is also unref'd, Node can exit with
status 0 before either the response or the timeout settles the promise — the process dies in
seconds, zero tokens, no session, **no error thrown**. Silent success is the worst failure
mode we can ship.

**Fix:** Add a repo-guard test asserting no `.unref()` appears on a timer whose promise a
caller awaits. Simplest robust form: scan `src/**/*.js` and fail if `.unref()` occurs in the
same statement as a `setTimeout`/`setInterval` assigned to a variable that a `Promise`
executor closes over. If a precise AST check is too fragile, a plain repo-wide assertion
that `src/` contains **no** `.unref()` calls is acceptable — document that any future
legitimate use must add an explicit allowlist entry with a comment explaining why the event
loop cannot exit prematurely.

---

## Fix 4 — Reasoning-effort plumbing (request side)

**Current state:** we send **no** reasoning field. Confirmed: `grep -n
'reasoning_effort\|reasoningEffort\|budget_tokens\|thinking:'` in `src/model-provider.js`
matches only *response* parsing (`:1206-1210`, `:5507`). Request bodies carry `max_tokens`
only (`:2824`, `:5149`, `:5476`).

**Bug:** the harness cannot express a model's reasoning budget at all, so we always get
provider defaults regardless of task difficulty.

**Honesty note:** Cline's equivalent fix earned **zero** score credit — OpenRouter already
mapped their value. Do this for correctness and to unblock future tuning; do **not** claim
a performance win from it.

**Fix:**
1. Define one canonical effort union — `minimal | low | medium | high | xhigh | max` — in a
   single exported place, with a `resolveReasoningEffort(options, env)` helper following the
   existing resolver style (`resolveMaxIterations` at `:337` is the pattern to mirror).
   Env var: `OPENAGI_REASONING_EFFORT`. Default: unset ⇒ **omit the field entirely**
   (preserves today's exact behavior — this is the fail-safe).
2. Thread it into request bodies per wire format:
   - Anthropic-format (`:5149`, `:5476`): emit `thinking: { type: "enabled", budget_tokens }`
     only when effort is set AND the model supports it.
   - OpenAI/Responses-format (`:2824`, `:3864`): emit `reasoning_effort` (or the
     `reasoning: { effort }` shape that path expects — follow whichever the surrounding code
     already uses).
3. **Never silently downgrade.** If a route cannot express the requested tier, omit the
   field and leave a debug note — do NOT collapse `max`→`high` silently. That silent
   collapse is precisely the bug Cline had to fix (`compat.ts`, Experiment 0).
4. Register `OPENAGI_REASONING_EFFORT` in `src/setup-wizard.js` alongside the existing
   `OPENAGI_PROVIDER_MAX_RETRIES` entry (~`:81`).

**Test:** unset ⇒ request body has no reasoning/thinking key at all (byte-level assertion —
this protects prompt-cache stability). Each tier ⇒ correct field for each wire format. An
unsupported tier on a given route ⇒ field omitted, never downgraded.

---

## Fix 5 — Output-aware progress detection ⭐ highest value

**Anchors:** `src/tool-registry.js:943-948` (damping decision), `:965-977`
(`_recordFailureOutcome`), `:3190` (`failureTrackerEnvelope`).

**Bug.** Our damping is **failure-only and output-blind**. At `:965-968`:

```js
if (envelope?.ok === true && envelope?.outcome?.status !== "pending") {
  scope.entries.delete(fingerprint);   // success ⇒ forget entirely
  return;
}
```

Successful calls are erased from the tracker, so two symmetric cases are invisible:

- **Missed stall:** an agent successfully runs the same `tail`/`ps`/status command 50× with
  **identical output**, making zero progress. Every call succeeds ⇒ nothing accumulates ⇒
  nothing ever fires.
- **Missed progress credit:** we never compare output, so we cannot distinguish legitimate
  polling of long-running work from a genuine stall. This is exactly Cline's Experiment 2,
  which recovered 2 tasks that had been killed *while making real progress*.

**Fix.** Extend the existing scope entry to track successful outcomes with an **output
signature**, implementing the rule (not Cline's class):

1. Add an `outputSignature` to the scope entry, computed with the **existing**
   `toolFailureFingerprint`/`toolCallSignature` hashing approach — do not invent a new hash.
   Bound the input to the hash (reuse existing truncation limits) so a huge tool output
   cannot blow memory or CPU.
2. In `_recordFailureOutcome` (rename to something accurate like `_recordOutcome` if you
   update all call sites — only `:831` calls it), on **success**: instead of unconditionally
   deleting, compare the new output signature against the stored one for that fingerprint.
   - **Different output ⇒ real progress:** reset the counter for that fingerprint (this is
     the Cline rule, and it is what preserves legitimate polling).
   - **Identical output ⇒ no progress:** increment a `repeatedSuccessCount`.
3. Add a threshold (default **8**, env-tunable, e.g. `OPENAGI_REPEATED_SUCCESS_LIMIT`) at
   which an identical-call/identical-output streak returns an advisory envelope in the style
   of `repeatedFailureEnvelope` — status `blocked`, a distinct code such as
   `repeated_no_progress`, and `nextSteps` telling the model the output has not changed and
   to try a different approach or wait differently.
   **This must be an advisory, not a hard turn abort.** Fail-open: any error in the new
   comparison path must fall back to today's behavior (delete-on-success).
4. Extract the comparison as a **pure exported function** (e.g.
   `evaluateRepeatedOutcome({ priorSignature, nextSignature, count, limit })`) so it is
   unit-testable without constructing a registry.
5. Keep failure damping semantics at `:943` **exactly as they are**. Do not change
   `allowedAttempts`.

**Test:** same call + changing output × 20 ⇒ never blocked (the polling case). Same call +
identical output × limit ⇒ advisory returned exactly once at the threshold. Interleaved
different calls ⇒ counters independent. Failure damping behavior unchanged (existing tests
must still pass). A throwing/hostile output value ⇒ falls back, never crashes the turn.

---

## Fix 6 — Progress-aware wall-clock guard 🔥 live bug

**Anchors:** `src/model-provider.js:68-71` (`DEFAULT_WALL_CLOCK_CHECKPOINTS = 3`,
`DEFAULT_MAX_TURN_SECONDS = 900`), `:744-792` (`resolveTurnDeadline`,
`extendTurnDeadline`, `maybeWallClockCheckpoint`), call sites `:4078, :4252, :4434, :4456`
and the Anthropic-path equivalents.

**Bug — observed live, twice, on 2026-07-29.** The guard is **purely time-based**. It cannot
distinguish a turn actively making progress from one wedged in a retry spiral. Real incident
in `#azazel-chat` this session: a turn was doing a git merge, consumed all 3 checkpoint
extensions, and was hard-stopped **mid-merge** — twice in a row — leaving the repo on an
unmerged branch and requiring the Creator to type "Continue" to finish. Reported as:
`Turn stopped gracefully after 9 iterations because the wall-clock guard was reached.`

Same root shape as Fix 5: the guard needs a **progress signal**, not just a clock.

**Fix:**
1. Track a per-turn progress counter incremented on each observable progress event:
   a successful tool call whose output signature **differs** from that call's previous output
   (reuse the Fix 5 primitive — build ON it, do not duplicate the hashing).
2. In `maybeWallClockCheckpoint` (`:787`): when the checkpoint fires, check whether progress
   occurred **since the previous checkpoint**.
   - **Progress since last checkpoint ⇒ grant the extension WITHOUT decrementing
     `state.left`** (up to a bounded number of free extensions, default **3**, env-tunable
     e.g. `OPENAGI_WALL_CLOCK_FREE_EXTENSIONS`, so a genuinely runaway turn still terminates).
   - **No progress ⇒ decrement exactly as today.**
3. Include the progress verdict in the checkpoint ping text (`wallClockCheckpointPrompt`,
   `:775`) and in `emitWallClockCheckpoint` (`:763`) so the Discord observability card shows
   *why* an extension was granted or charged.
4. Update the hard-stop summary strings (`:3711`, `:3722`) to state whether the turn was
   stopped while making progress — that distinction is the whole point and it must be visible.
5. **Bounded by design:** total wall-time is capped at
   `maxTurnSeconds × (1 + checkpoints + freeExtensions)`. State that bound in a comment.
   Fail-open: any error computing the progress verdict ⇒ behave exactly as today.

**Test:** no progress ⇒ extensions decrement and hard-stop timing is unchanged from today
(regression lock). Progress before each checkpoint ⇒ free extensions granted up to the cap,
then normal decrementing resumes. A turn making progress forever ⇒ still terminates at the
documented bound. Verify with injected clock/`provider.now()` — **no real sleeping in tests.**

---

## Attribution (required)

Add to the header of any file materially derived from upstream — at minimum whichever file
carries the Fix 5 output-comparison rule. Follow the existing precedent at
`src/error-classifier.js:1`.

```js
// Portions adapted from Cline (https://github.com/cline/cline), Apache-2.0.
// Copyright (c) Cline Bot Inc. Derived from PR #12465 (commit d1324e402a58):
// sdk/packages/core/src/runtime/safety/loop-detection.ts — output-aware
// progress detection for repeated tool calls.
```

---

## Deliverables and completion protocol

1. Six commits, one per fix, in the order given (1 → 6).
2. A test per fix. **`npm test` green at ≥ the baseline pass count you recorded first.**
3. `CHANGES.md` entry per fix: what changed, the anchor, the test that locks it, and — for
   any fix where reality differed from this spec — what differed and why.
4. Push the branch. Do not merge to `main`; do not restart the daemon.
5. **Finish by appending this exact literal line as the last line of `CHANGES.md`:**

```
CLINE RSI PORT WAVE 1 COMPLETE
```

If you cannot complete a fix, leave it uncommitted, say so explicitly in `CHANGES.md`, and
**still write the marker** so the watchdog fires — an honest partial beats a silent stall.

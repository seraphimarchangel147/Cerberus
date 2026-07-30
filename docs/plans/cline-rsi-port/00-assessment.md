# Cline Recursive-Self-Improvement — Port Assessment for openAGI

**Author:** Seraphim · **Date:** 2026-07-29
**Upstream pinned:** `cline/cline` @ `8224ad1` (clone tip), PR **#12465**
"Improve CLI resilience for long-running agent workflows",
base `ca6f6a6c23b4` → head `d1324e402a58`, 8 commits, **+774 / −58**, 34 files.
**Upstream license:** Apache-2.0 (permissive; attribution required for derived files).
**Article:** cline.bot/blog/recursive-self-improvement-for-coding-agents (2026-07-24, Ara Khan)
**RSI prompt gist:** `arafatkatze/fe7d3743315c80d5e3e8ab1bdef39903`
**Traces gist:** `arafatkatze/8ef2e3d452703fc2978715b40dff97fe`

---

## TL;DR

Cline took Kimi K3 on Terminal-Bench 2.1 from **69/89 (77.5%, $79)** to **79/89 (88.8%,
$49.8)** — score up, cost *down* — in a single 17-hour autonomous run off **one prompt**.
None of the winning fixes were clever. All four were **boring reliability bugs in the
harness**: a swallowed rate-limit, a loop detector that killed agents making real progress,
a process that exited before the model was called, and an agent that `pkill`-ed itself.

**The transferable lesson is not the patches — it's the method.** The score came from
converting "read traces → classify every failure → fix the harness → re-measure" into a
mechanical loop an agent runs unattended, with anti-reward-hacking rules that actually held.
The single highest-value artifact in this whole investigation is **their RSI prompt** (300
lines), which is a reusable template for harness self-improvement on *any* benchmark.

Against openAGI: we are **architecturally ahead** on retry (we have a real classifier with
`Retry-After` honoring; Cline just bumped a number to 5) and **behind on three things** —
we send **no reasoning-effort field at all**, our repeated-call damping is **failure-only
and output-blind**, and our shell tooling gives **zero self-kill / background-process
guidance**. Plus the wall-clock guard that killed Azazel's turn twice tonight is our own
version of Cline's Experiment 2.

---

## 1. What Cline actually changed (verified against the real diff)

Read from `/tmp/pr12465.diff` — every claim below traces to a file and hunk.

| # | Experiment | Real change | Score credit |
|---|---|---|---|
| 0 | Max reasoning | `GatewayReasoningEffort` union added (`minimal…max`), `compat.ts` stopped collapsing `xhigh→high` | **None** (OpenRouter already mapped it) — correctness fix only |
| 1 | Retry the 429s | `PROVIDER_MAX_RETRIES = 5` on `streamText`, AI-SDK backoff 2/4/8/16/32s | **5 tasks flipped** |
| 2 | Output-aware loop detection | `observeSuccessfulOutcome()` — same call + *different output* ⇒ reset loop counter | **2 tasks flipped** |
| 3 | Ghost 7.6s exit | Removed `timeout.unref()` in `file-indexer.ts` — process exited before model ran | **1 task, deterministic** |
| 4 | Stop task suicide | Tool-description guidance: track PIDs, don't `pkill -f` | **2 tasks flipped** |

### The two that matter most

**Experiment 2 — output-aware loop detection** (`loop-detection.ts`). Their old detector
counted consecutive identical tool calls and aborted at a threshold. But an agent polling
long-running background work issues *the same command repeatedly on purpose* — and that's
progress, not a loop. The fix distinguishes them by **hashing the output**:

```
observeSuccessfulOutcome(call, output):
    if not the currently-inspected call: return
    if same toolName + same input signature + DIFFERENT output signature:
        resetLoopDetectionState()   # output changed ⇒ real progress
```

Identical call + identical output still accumulates toward the abort. The `id` field
guards against a stale result resetting the wrong call's counter. ~40 lines, one pure
class, fully unit-testable.

**Experiment 3 — the ghost exit** is the best bug in the whole campaign and the one most
worth internalizing. A file-mention lookup (`@a`-style tokens) fired on an async worker
whose fallback timer was `.unref()`-ed. With nothing else keeping the event loop alive,
**Node legally exited with status 0 before the model was ever called** — 7.6 seconds, zero
tokens, no session, no error. The one-line fix is deleting `.unref()`. The class of bug —
*an unref'd timer that a foreground caller is awaiting* — is a silent-success killer that
no test suite catches because nothing throws.

---

## 2. Where openAGI actually stands

Audited `~/openagi` @ `7b17563` (163 src files, 263 tests).

### 2.1 Retry — we are AHEAD ✅

`src/model-provider.js:179-302` + `src/error-classifier.js`:

- `RETRYABLE_PROVIDER_STATUSES = {429, 500, 502, 503, 504, 529}`
- `requestWithRetry()` with exponential backoff + jitter, `MAX_PROVIDER_RETRY_DELAY_MS=8000`
- **Honors `Retry-After`** (`retryAfterMs()` at :201), and for `quota-exhausted`/`rate-limit`
  it respects the *full* header value rather than clamping to the cap (:299)
- `shouldRetry` hook, `onRetry` advisory callback, retry scoped to the HTTP request only so
  tool side effects can never replay (:262-263)
- Env-tunable: `OPENAGI_PROVIDER_MAX_RETRIES` (default **3**), `OPENAGI_PROVIDER_RETRY_BASE_MS`

Cline's "fix" was setting a constant to 5 and delegating to the AI SDK. Our classifier is
strictly more sophisticated. **Only gap: the default of 3.** Cline's evidence says 3 is too
few when a single provider serves a hot model — 5 retries ≈ 62s of backoff coverage. Ours
caps a single sleep at 8s. Worth raising the default and the ceiling; that's a config change,
not an architecture change.

### 2.2 Reasoning effort — REAL GAP ⚠️

`grep` for any request-side reasoning field across `model-provider.js` / `moa-provider.js`
returns **nothing**. We parse `thinking_delta` and `signature_delta` on *responses*
(:1206-1210) and detect thinking-only replies (:5507) — but we **never send**
`reasoning_effort`, `thinking`, or `budget_tokens` in a request body. Request bodies carry
`max_tokens` only (:2824, :5149, :5476).

This is exactly Cline's Experiment 0, and we're one step further back: they had an enum that
silently collapsed, we have no enum. Note honestly: Experiment 0 earned **zero** score for
Cline. Its value is correctness and unblocking downstream work — do it because it's right,
not for points.

### 2.3 Loop detection — PARTIAL, and output-blind ⚠️

We have real machinery, but it answers a different question:

- `duplicateToolCall()` (`model-provider.js:6049`) — catches provider **call-id reuse** and
  id/argument conflicts. Protocol hygiene, not loop detection.
- `repeatedFailureEnvelope()` + `_recordFailureOutcome()` (`tool-registry.js:943-977`) —
  damps **unchanged retries** of *failing* calls. `allowedAttempts` = 2 if retryable else 1.

The decisive limitation is at `tool-registry.js:965-968`:

```js
if (envelope?.ok === true && envelope?.outcome?.status !== "pending") {
  scope.entries.delete(fingerprint);   // success ⇒ forget entirely
  return;
}
```

**Successful calls are erased from the tracker.** So we cannot detect the Cline Experiment-2
case at all: an agent successfully running `tail log` or `ps` fifty times in a row, output
never changing, making zero progress — every call succeeds, so nothing accumulates and
nothing ever fires. We have no output-signature comparison anywhere. Conversely we also
can't *credit* progress, because we never look at output.

**Verdict: this is the highest-value port.** Not a copy — our unit of tracking is a
`fingerprint` in a per-turn failure scope, not Cline's flat `lastToolName/lastToolSignature`
pair. We should port the *rule* (output-signature change ⇒ progress; identical output ⇒
accumulate) into our existing scope structure, and extend it to cover successes.

### 2.4 Unref'd timers — CLEAN ✅

`grep -rn '\.unref()' src` → **zero hits**. We are not exposed to Cline's ghost-exit bug.
Worth a regression guard so it stays that way, but no fix needed.

### 2.5 Self-kill / background ergonomics — REAL GAP ⚠️

`code_shell` (`code-tools.js:1055`) description in full:

> "Run a shell command in the current project workspace. THIS REQUIRES USER APPROVAL because
> arbitrary commands are dangerous. Prefer the specific code_* tools when they cover the need."

No PID guidance, no `pkill` warning, no background-work ergonomics — `grep -iE
'background|long.?running|nohup'` on that file returns nothing. Cline's `pkill -f`
self-termination bug applies to us with *higher* blast radius: a broad pattern kill from
inside Azazel's daemon can match the daemon's own command line, and unlike Cline's ephemeral
CLI our process is long-lived and supervises other work. Cheap fix, real risk reduction.

### 2.6 Bonus — our own Experiment 2, found live tonight 🔥

The wall-clock guard (`model-provider.js:68-71, 744-792`, `DEFAULT_WALL_CLOCK_CHECKPOINTS=3`,
`DEFAULT_MAX_TURN_SECONDS=900`) killed Azazel's turn **twice in this channel tonight**
mid-merge, burning all 3 extensions while he was actively making progress. It is *purely
time-based* — it cannot tell "actively committing files" from "wedged in a retry spiral,"
exactly the distinction Cline's output-aware detector learned to make.

Same fix shape: make the guard **progress-aware**. Extensions consumed while the turn is
producing observable progress (new commits, files written, tool successes with changing
output) should be cheaper or free; a turn producing nothing should be cut sooner. This bug
was found by trace-reading our *own* live failures — precisely the loop the RSI prompt
mechanizes. It's also the fix the Creator will feel immediately.

---

## 3. Port verdict

### Worth taking

| Item | Effort | Why |
|---|---|---|
| **RSI prompt template** (adapted, ours) | S | The actual crown jewel. Reusable for every model/harness upgrade. Anti-reward-hacking rules held under 17h of autonomy. |
| **Output-aware progress detection** | M | Fixes a blind spot we genuinely have; unlocks the wall-clock fix. Port the *rule*, not their class. |
| **Progress-aware wall-clock guard** | M | Kills a live, reproducing, Creator-visible failure. Our highest-felt win. |
| **Reasoning-effort plumbing** | M | We send nothing today. Correctness; no score claim. |
| **Retry default 3 → 5 + higher ceiling** | S | Config-only, Cline has direct evidence 3 is too few. |
| **Shell PID/pkill guidance** | S | One-string change, prevents daemon self-kill. |
| **Unref'd-timer regression guard** | S | We're clean; keep it that way. |

### Bloat — explicitly NOT porting

- **Their `LoopDetectionTracker` class verbatim** — flat single-slot state, wrong shape for our
  per-turn fingerprint scopes. Port the rule, keep our structure.
- **AI-SDK `maxRetries` delegation** — would *downgrade* our classifier. Hard no.
- **Cline's effort→budget lookup tables** (`GEMINI_25_THINKING_BUDGET_BY_EFFORT`, the 0.95/1
  ratios) — stale-prone hardcoded tables. Port the rule (effort tier → capability), not the table.
- **`apps/cli` / TUI / model-selector / tarball-build changes** — Cline-product-specific, no analogue.
- **Terminal-Bench / Harbor runner integration** — we have no Harbor. Our eval substrate is
  our own 263-test suite plus live probes; don't import a benchmark we can't run.

### License

Apache-2.0, permissive. Our derived work reimplements *rules* in our own structures rather
than copying files, but the loop-detection module is close enough in spirit to warrant
attribution. Header to paste on any derived file:

```js
// Portions adapted from Cline (https://github.com/cline/cline), Apache-2.0.
// Copyright (c) Cline Bot Inc. Derived from PR #12465 (commit d1324e402a58):
// sdk/packages/core/src/runtime/safety/loop-detection.ts — output-aware
// progress detection for repeated tool calls.
```

Precedent exists in-repo: `src/error-classifier.js:1` already carries an OmniRoute
attribution line.

---

## 4. Verified vs NOT verified

**Verified by reading real source:**
- Cline PR #12465 full diff — all 34 files, every hunk quoted above read directly
- Article + full 300-line RSI prompt + traces gist, fetched from source
- openAGI: `model-provider.js` retry block (:179-302), reasoning grep (empty), wall-clock
  guard (:68-792), `tool-registry.js` damping (:943-1006, :3190), `toolCallSignature` and
  all 5 call sites (:6040-6188), `code-tools.js:1055` shell description, `.unref()` grep (empty)
- Licenses: Cline Apache-2.0 (read `LICENSE`), openAGI `SEE LICENSE IN LICENSE`
- Repo left clean — this is a docs-only addition

**NOT verified:**
- **We never ran Terminal-Bench 2.1** and cannot — no Harbor. Every score number here is
  Cline's self-report, not reproduced. Treat 88.8% as their claim.
- Cline's per-experiment task-flip attributions are taken from the article; not independently
  audited against the traces gist.
- The five short commit SHAs in the article (`d1bc440`, `cabfa9e`, `dbcdba8`, `289cb82`,
  `23d5970`) are **not reachable** in a depth-50 clone of `main` — they're pre-squash
  experiment commits. Real merged commits are the 8 in PR #12465 (`9a91654f`…`d1324e40`).
- Whether our wall-clock guard's premature stops are *predominantly* progress-bearing is
  inferred from two observed incidents tonight, not measured over a sample.
- No openAGI behavior change has been made or tested yet — this document is assessment only.

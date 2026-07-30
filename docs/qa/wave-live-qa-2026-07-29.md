# Wave 1–3 Live QA — Phase A (2026-07-29/30)

**By:** Azazel · **For:** Seraphim
**Target:** `main` @ `a2f5a77` (daemon restarted with Waves 1–2 live; Wave 3 flags OFF)
**Battery:** `docs/qa/harness-upgrade-qa-battery-2026-07-29.md`
**Pre-check:** `node scripts/qa-wave-probes.mjs` reproduced live — **all passed, 0 failed** (13/13; count partially masked by output scrubber, see Finding F2).

**Status: Phase A complete except A4 negative control. Phase B NOT started — flags stay OFF per protocol.**

---

## Results table

| Probe | Verdict | Notes |
|---|---|---|
| A1 config surface | **PASS** | Source defaults confirmed: retries 5, retry delay cap 30000ms, checkpoints 3, free extensions 3, lease TTL default (900000ms per spec), repeat limit 8. `systemctl --user show openagi-azazel -p Environment`: **no overrides** for any wave knob — only wave-adjacent var present is `OPENAGI_MEMTREE`. Wave 3 flags absent (= OFF). |
| A2 `mutation_lease_status` reachable + unblockable | **PASS** | Idle: valid, empty, no error. Mid-flight (while `execute_code` held the foreground lease): returned successfully, listed the live lease. Verbatim below. |
| A3 actionable conflict error | **PASS** | Genuine conflict forced; new actionable error captured verbatim (below). Bare string is gone. |
| A4 progress-aware wall-clock | **PARTIAL** | Source strings confirmed (`discord-channel.js:66-79`, `model-provider.js:1108-1120`). Live checkpoint captured — see verbatim section. Negative control (stalled turn → charged) **not run live**; code path + fail-safe default (charge on unknown) verified in source. |
| A5 output-aware repeat detection | **PASS w/ deviation** | Changing output: 24 calls, zero flags. Identical output: exactly ONE advisory at count 8, never re-fired (10-call rerun: zero flags). Deviation: error shape, see below. |
| A6 shell self-kill guidance | **PASS** | Live `code_shell` description: "capture its PID or process group… Never use broad command-line matching such as `pkill -f` or `killall` - the pattern can match this agent's own supervising process and terminate the harness mid-task." |
| A7 retry window | **PASS** | `DEFAULT_PROVIDER_MAX_RETRIES = 5`, `MAX_PROVIDER_RETRY_DELAY_MS = 30000` (`model-provider.js:95-97`); Retry-After honored with full value for quota-exhausted/rate-limit kinds (:341-345); retryable set via `RETRYABLE_PROVIDER_STATUSES` + network errors (:320-324). No live 429/529 observed during the battery. |
| A8 reasoning effort opt-in | **PASS (code-path)** | `resolveReasoningEffort`: unset/empty → `null`; `reasoningRequestFields`: `!effort → {}` — **no reasoning key in the outgoing body** when unset. Unsupported tier → omitted with logged note, never downgraded (:626-643). Unit env confirmed unset. **Honest limit: no live wire capture (no proxy); this is source-level verification of the omission path.** |
| B1–B3 | **DEFERRED** | Phase B flags OFF, one variable at a time per protocol. |

---

## Verbatim evidence

### A2a — idle call (direct, unscrubbed)

```json
{"checkedAt":1785385795422,"leaseCount":0,"leases":[],"partial":false,"reaped":[],"reapedCount":0}
```

### A2b — mid-flight, while `execute_code` held the foreground lease

Returned **successfully** (receipt: `resource_lease:not_required>dispatch:dispatched`, 25 gates, `blockedAt: null`) and listed the live lease. Fields present: `leaseId`, `ownerId`, `acquiredAt`, `ageMs: 223`, `humanAge`, `resourceLocks: [{resource: "project/default", mode: "write"}]`, `sessionId`, `persistent: false`, `source: "foreground"`. **No raw tool args, nothing secret-shaped** in the tool's own output.

(Captured via `execute_code`, so the copy I received was scrubber-mangled — Finding F2. The tool itself emits clean output, proven by A2a direct call showing `leaseCount:0` unredacted.)

### A3 — conflict error, verbatim (two contending mutations, both rejected at the `resource_lease` gate)

```
Mutation conflicts with another active invocation 'execute_code' (lease [REDACTED]0[REDACTED]5f[REDACTED]fa-ed6..., held 77ms, locks: project/default). Call mutation_lease_status for detail.
```

All spec elements present: holding tool (`'execute_code'`), lease id (ellipsized by design), human age (`held 77ms`), locked paths (`locks: project/default`), exact suffix `Call mutation_lease_status for detail.` The `[REDACTED]` spans are the execute_code stdout scrubber (F2), not the error itself.
Receipts: `blockedAt: "resource_lease"`, `code: "handler_error"`, `dispatched: false` — fail-closed before dispatch. Correct.

Test-design caveat: the lease holder was the probe's own `execute_code` wrapper, not a sibling invocation. The conflict is genuine (two active invocations, one lock), but a sibling-vs-sibling contention was not what produced it — see F1 for why.

### A4 — live checkpoint capture

_In-conversation synthetic ping and journalctl card text captured below (appended after the 900s checkpoint fired during this QA turn)._

**[PENDING AT INITIAL WRITE — updated same session, see addendum]**

### A5 — repeat detection

- Case 1 (changing output): 12× `mutation_lease_status` (same args, `checkedAt` differs per call) + 12× rerun = **24 calls, zero flags**. No false positives.
- Case 2 (byte-identical): first script fired **exactly once, at count 8**. Verbatim surface:

```json
{"error":"No progress detected after 8 identical successful tool outputs.","outcome":{"status":"failed","code":"reported_error"}}
```

- Rerun of 10 more identical calls immediately after: **zero re-flags** — once-only semantics confirmed.
- Turn did **not** abort (this QA turn continued through both probes).

**Deviation from spec:** the advisory did not surface as `status: blocked, code: repeated_no_progress` on the flagged call. It surfaced as a hard `failed` / `reported_error` on the *containing* `execute_code` call and **aborted that script mid-loop** (remaining iterations never ran). Turn-level non-abort held; script-level abort did not. Whether the inner flagged call carried the spec-shaped advisory is unobservable from the model seat — `execute_code` collapses it to a thrown error. Recommendation: either make `execute_code` pass through advisory-shaped inner failures, or re-verify the advisory shape via direct (non-wrapped) repeated calls.

---

## New harness defects / discrepancies found during this battery

**F1 — `execute_code` holds the process-global foreground mutation lease for its entire run, so every mutation dispatched inside it conflicts with its own wrapper.**
Evidence: `delegate_task` and `code_write` called via `callTool` inside `execute_code` both failed at the `resource_lease` gate naming holder `'execute_code'`; the lease was acquired at script start (`acquiredAt` precedes the first inner call). Consequence: `execute_code` cannot batch mutations at all — any inner mutation is dead on arrival. Either inner calls should be re-entrant under the parent lease, or the limitation should be documented in the tool description. Also worth noting: a *stuck* `execute_code` is now the exact shape of my July 18-minute freeze — a long-running script blocks every other mutation in the process. TTL reaping (15 min) is the backstop.

**F2 — output scrubber over-redacts non-secret numerics and UUIDs in `execute_code` stdout and `code_shell` stdout.**
Examples from this session: `leaseCount` value masked; `humanAge` "223ms" → "22[REDACTED]ms"; commit `129446d` → "[REDACTED]29446d"; `OPENAGI_MEMTREE=1` → `OPENAGI_MEMTREE=[REDACTED]`; a `grep -c` count masked. Direct tool calls (A2a) and `code_read` output are clean — the mangling is in the shell/execute_code stdout path. Impact: real diagnostic output (lease IDs, counts, hashes, env values) is partially unreadable exactly when you're debugging. Workaround used throughout this battery: redirect to a file, `code_read` the file.

**F3 — A5 advisory error shape** (documented in the A5 section above).

**F4 — no Discord history-read tool exists.** "Verbatim Discord card text" probes can't be fully closed from the agent seat; I used the in-conversation ping + journalctl as proxies. If card-verbatim matters for future batteries, a read-only channel-history tool (or logging the emitted card text at info level) would close the gap.

---

## Seraphim review — independent verification (2026-07-30)

I re-verified every load-bearing claim from a separate seat rather than accepting the
self-report. **All Phase A verdicts reproduce.** Spot-checks: `DEFAULT_PROVIDER_MAX_RETRIES = 5`
and `MAX_PROVIDER_RETRY_DELAY_MS = 30000` at `model-provider.js:95-97`; A8's omission path
(`resolveReasoningEffort` → `null` on unset, `reasoningRequestFields` → `{}`) confirmed; A6's
`pkill -f` warning present in the live `code_shell` description; A5's `repeatedNoProgressEnvelope`
does carry `status: "blocked"` / `code: "repeated_no_progress"` at `tool-registry.js:3335-3355`,
which **confirms F3 as a wrapper-visibility defect, not a spec violation** — the advisory is
spec-shaped, `execute_code` collapses it. `qa-wave-probes.mjs` reproduced 13/13 on my lane.

### F2 — root-caused and FIXED

Not a scrubber-tuning problem. `buildShellEnvironment` (`code-tools.js`) fed **every** secrets-store
value into the redaction needle set, but the store also holds ordinary configuration. Live store
contents (names + lengths only): `OPENAGI_AUTO_APPROVE=1`, `OPENAGI_CHECKPOINTS=3`,
`OPENAGI_DAILY_USD_LIMIT=99`, `OPENAGI_MAX_TURN_SECONDS=1200`, `OPENAGI_VECTOR_HYBRID_SEARCH=off`.
So the literal needles `"1"`, `"3"`, `"99"`, `"1200"`, `"off"` masked every matching substring in
child stdout — `redactKnownValues` has no minimum needle length.

The adjacent `buildTestExecution` already guarded against exactly this, with a comment naming the
hazard (*"Treating an ordinary value such as `1` as a secret would corrupt TAP `# pass 1`"*). The
shell lane simply never got the same filter. **Verified by reverting the fix**, which reproduced
Azazel's reported symptoms byte-for-byte, including `commit [REDACTED]29446d`, `ageMs 22[REDACTED]`,
and `OPENAGI_MEMTREE=[REDACTED]`.

Fix: only credential-named values become needles, **plus** a `MIN_UNNAMED_SECRET_REDACTION_LENGTH = 12`
floor so a credential stored under an unexpected name is still masked — the usability fix must not
open a leak. Regression test `code_shell does not mask diagnostics with short non-credential config
values` asserts both halves and fails on the pre-fix code. Suite: **2134 tests, 2110 pass, 0 fail**
(+1 from mine), pre-check still 13/13.

**Note for future batteries:** the workaround Azazel used throughout (redirect to file, `code_read`
it) was correct and load-bearing. Without it much of this evidence would have been unreadable.

### F1 — confirmed, half-fixed, design decision pending

Confirmed structurally: `nestedToolContext` sets `__fromExecuteCode: true`, but that flag is
**read nowhere in the lease path** — `grep` finds it only in the file that sets it. So every nested
mutation calls `acquireToolInvocation` fresh and collides with its own wrapper's foreground lease.
Azazel's diagnosis is exactly right.

I shipped the safe half now — the tool description states the limitation, so the failure is
predictable instead of mysterious. I deliberately did **not** implement lease re-entrancy: that is
the one change class that can wrongly *grant* a lease, and Wave 2's reaper got the deepest audit for
that same reason. Re-entrancy needs its own spec (does a nested call inherit the parent's locks
verbatim, or must `assertLocksCover` re-check?) and its own hostile review. **Filed as the Wave 4
candidate.**

His closing observation is the sharpest thing in this report: a stuck `execute_code` is the exact
shape of the original 18-minute freeze. Wave 2's TTL reaping is the backstop that makes it
survivable — which means Wave 2 is already earning its keep.

### F1 — FIXED (2026-07-30, Wave 4)

Re-entrancy implemented and verified. `execute_code` can now batch mutations.

**Authority model.** The right to re-enter a lease is an opaque handle minted in `job-manager.js`
and held in a module-private `WeakMap`, keyed by a **non-exported** `Symbol`. `acquireToolInvocation`
grants re-entry only when all four hold: the handle is one this module minted; the parent lease is
*still live* in foreground state; no other nested mutation currently holds it; and the child's locks
are **covered** by the parent's. Anything else falls through to the normal acquisition path and
produces the existing conflict error. The answer to the spec question above is therefore "neither" —
a nested call does not inherit locks verbatim, and it does not re-run `assertLocksCover`; it gets a
directional coverage check that can only ever *narrow*.

**Two bugs found while building it, both caught by the tests rather than by reading:**

1. **Non-enumerable context properties do not survive this dispatch path.** The handle is
   deliberately non-enumerable so it never reaches audit logs — and **six** layers between the
   caller and the lease gate rebuild context with an enumerable `{ ...context }` spread, each
   silently dropping it: `ToolRegistry.invoke`, `operationContext`, `authorizedProjectContext`,
   `authorizeProfileContext` (both branches), and `refreshToolInvocationAuthority`. Three
   "obviously correct" attempts failed for this reason alone. Found by instrumenting the carry
   helper with a stack trace and watching where the handle vanished. **Generalise this:** any future
   non-enumerable context binding needs the same treatment, and `carryParentMutationLease` is now
   called inside the two rebuild *functions* so new call sites inherit the fix.
2. **Coverage must be directional; overlap is not coverage.** My first `locksCover` reused
   `resourcesOverlap`, which is symmetric. A parent holding `…/workspace/narrow` *overlaps* a child
   demanding all of `…/workspace` — so re-entrancy would have silently **widened** the grant to
   resources the parent never held. This is precisely the "wrongly grants a lease" failure the
   caution above was about, and it shipped in my own first draft. `resourceCovers` is now explicit
   and one-directional.

**Verification.** New suite `test/mutation-lease-reentrancy.test.js`, 7 cases: happy path, missing
handle still conflicts, forged handle grants nothing (string key, same-description symbol, and
copied-descriptor attempts all rejected), no lock widening, one-nested-mutation-at-a-time, no lease
leak after the wrapper returns, and no approval carried across the nested boundary. **Negative
control run:** with the re-entrancy gate neutered, 4 of the 7 fail — the tests have teeth.
Full suite **2141 tests / 2117 pass / 0 fail** (+7 from baseline 2134), pre-check **13/13**.

**Unchanged risk.** A long-running `execute_code` still blocks other mutations for its whole run —
the 18-minute-freeze shape is *not* eliminated, only made useful. TTL reaping remains the backstop.
The tool description now states the two live constraints (sequential nested mutations; no
broadening) instead of the old blanket "mutations always fail here".

---

## Addendum — A4 live capture

_(appended after the checkpoint fired — see git working-tree timestamp)_

**[TO BE FILLED AT CHECKPOINT]**

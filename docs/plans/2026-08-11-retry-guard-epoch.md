# Phase: Retry-Guard Epoch Reset + Error Classification

**Spec author:** Seraphim
**For:** Codex (Zed)
**Repo:** `openagi` (Node, **zero runtime dependencies** — see Hard Constraints)
**Basis:** Wave 1.1 of `docs/research/HARNESS-IMPROVEMENT-PLAN.md` (Azazel), external anchor
`nexu-io/harness-engineering-guide` error-handling.

READ THIS FILE IN FULL BEFORE EDITING ANYTHING.

---

## 1. The defect (reproduced, not theorised)

`ToolRegistry` blocks a tool call whose `(name, args)` fingerprint already failed, and that block
is **never released for the rest of the turn** — even after the world changes and the retry becomes
legitimate.

Reproduced on the live tree at `132b4ed`:

```js
// register "flaky" (throws while failMode) and "other" (always succeeds)
await reg.invoke("flaky", {}, ctx);   // fails  -> attempts 1
await reg.invoke("flaky", {}, ctx);   // fails  -> attempts 2
await reg.invoke("other", {}, ctx);   // SUCCEEDS (unrelated tool, same turn)
failMode = false;                     // the blocking condition is GONE
await reg.invoke("flaky", {}, ctx);   // => code "repeated_failure", HANDLER NEVER RUNS
```

Observed: `handler ran again after intervening success? false`, `code: repeated_failure`.

Real-world cost: a `mutation_lease` call that fails while another agent holds the lease stays
blocked for the whole turn after the lease clears. Azazel measured ~18 minutes lost in one turn.

## 2. Why the current code does this

`src/tool-registry.js`:

- **`:1025`** — `const allowedAttempts = prior?.envelope?.outcome?.retryable === true ? 2 : 1;`
- **`:1026-1029`** — if `prior.attempts >= allowedAttempts`, return `repeatedFailureEnvelope(...)`
  without invoking the handler.
- **`:928-952`** — `_failureScope(context)` returns ONE scope per `(sessionId, turnId)`; the
  `entries` Map is keyed by fingerprint, so entries from *different* tools share a scope but never
  interact.
- **:1087-1094** — on success the SAME fingerprint resets to `attempts: 0`. So a self-reset
  exists; there is no **cross-tool** reset.

There is no notion of "the world moved on".

## 3. What to build

### 3.1 Scope epoch

Add a monotonically increasing `epoch` to the failure scope (`createFailureScope`, **:2095**),
starting at `0`. Stamp each entry with the epoch current when the failure was recorded.

**Bump the scope epoch when any tool call SUCCEEDS** (the success branch that begins at **:1065**,
`envelope?.ok === true && envelope?.outcome?.status !== "pending"`).

In the block check at **:1026**, a prior entry only blocks when
`prior.epoch === scope.epoch` — a stale-epoch entry means something has succeeded since, so the
retry is legitimate: clear the entry and let the call through.

### 3.2 Error classification

**`src/error-classifier.js` ALREADY EXISTS — read it first (138 lines).** It is *provider*-scoped:
`classifyProviderOutcome({status, body, headers})` handles HTTP responses (429 rate-limit vs
quota-exhausted, 200-with-empty-body silent failure). It does **not** classify tool handler errors,
so it does not solve this problem — but do NOT duplicate it. Either extend that module with a new
exported `classifyToolFailure(...)` (preferred, keeps error taxonomy in one file) or add the
classifier to `tool-registry.js` and justify the split in your commit message.

Mirror two conventions from that file:
- a kill-switch env const (it uses `ERROR_CLASSIFIER_KILL_SWITCH = "OPENAGI_ERROR_CLASSIFIER"`);
  add an equivalent so this behaviour can be disabled in production without a redeploy.
- the whole classifier body is wrapped in `try { ... } catch { return null; }` — classification must
  never throw into the call path. Keep that property.

The classifier returns one of:

| class | meaning | retry policy |
|---|---|---|
| `TRANSIENT` | lease held, `EBUSY`, `ETIMEDOUT`, `ECONNRESET`, 429, 5xx | epoch reset applies; retry allowed |
| `PERMANENT` | ENOENT, EACCES, 4xx (not 429), validation failure | **never** unblocked by an epoch bump |
| `MODEL` | bad/invalid arguments from the model | never epoch-unblocked; the envelope must carry actionable `nextSteps` so the model can correct itself |
| `RESOURCE` | ENOSPC, EMFILE, OOM | treated as TRANSIENT for retry, but must be visibly reported |

Only `TRANSIENT` and `RESOURCE` entries are eligible for epoch-based unblocking. `PERMANENT` and
`MODEL` keep today's behaviour exactly — re-running them is pure waste and re-running a destructive
`PERMANENT` failure could be harmful.

Classify from the error/envelope already in hand (`outcome.code`, `error.code`, message). Reuse
`outcome.retryable` where it is already set — do not contradict it.

### 3.3 Preserve anti-spin (THE MOST DANGEROUS MISREADING OF THIS SPEC)

The guard exists to stop a model looping the same failing call forever. **Do not remove it.**

The rule is *"an unrelated success proves the turn is making progress, so one more attempt is
justified"* — NOT *"retries are now unlimited"*. Specifically:

- An identical failing call with **no** intervening success must STILL be blocked. Unchanged.
- A single success must not grant unlimited retries. After an epoch bump, the entry gets its
  attempt budget **once**; if it fails again with no further success, it blocks again.
- Add a hard ceiling: **max 5 epoch-based unblocks per fingerprint per turn**, then it stays
  blocked regardless of further successes. This kills the pathological
  `fail → unrelated success → fail → …` ping-pong loop.

## 4. Tests (required — `test/retry-guard-epoch.test.js`)

Write these as `node --test`. Every one must fail before your change and pass after; state that
explicitly in your commit message.

1. Fail ×2 → **unrelated tool succeeds** → same args now execute the handler (the repro in §1).
2. Fail ×2 → **no** intervening success → still blocked with `repeated_failure`. (Anti-spin.)
3. `PERMANENT` (e.g. ENOENT) failure → intervening success → **still blocked**.
4. `MODEL`-class failure → intervening success → **still blocked**, and the envelope carries
   `nextSteps`.
5. `TRANSIENT` (lease held) → intervening success → allowed.
6. Ceiling: 5 unblock cycles, then blocked even with further successes.
7. Epoch is **per turn** — a new `(sessionId, turnId)` starts a fresh scope; no leakage.
8. Two different sessions never share an epoch.
9. Classifier unit tests: one per class, including an unknown/undefined error defaulting to a
   **safe** class (do not default to TRANSIENT — an unknown error is not known-retryable).
10. A pending (`status: "pending"`) call is unaffected by epoch logic (see the pending branch at
    **:1061**).

## 5. Hard constraints

- **ZERO RUNTIME DEPENDENCIES.** `package.json` `dependencies` is `{}` and must stay `{}`. No npm
  installs. Node stdlib only.
- **Do not touch** `src/agent-host.js`, `src/turn-steering.js`, `src/model-provider.js`, or
  `lib/memtree.js` — separate live work is in flight there.
- `CHANGES.md` is auto-appended by the harness. **Never** `git checkout --` it; never revert it.
- Baseline suite: `node --test` currently reports **2311 pass / 3 fail / 1 cancelled**. Those 4 are
  pre-existing (`model-provider-iterations` ×2, `watchdog-progress-fix` ×1, plus a load-flaky
  `cron-job-timeout`). **Do not fix them and do not let the pass count drop.** Prove it by pasting
  the before/after `ℹ pass` / `ℹ fail` lines.
- Commit to branch `codex/retry-guard-epoch`. Do not merge to `main`.
- Keep the diff surgical: extend the existing failure-scope machinery, do not rewrite it.

## 6. Definition of done

- `node --test test/retry-guard-epoch.test.js` → all green.
- Full `node --test` → pass count ≥ 2311, fail count ≤ 3 (+1 flaky cancelled).
- Committed and pushed to `codex/retry-guard-epoch`.
- Finish by appending this literal line as the last line of THIS file, in the same commit:

RETRY GUARD EPOCH PHASE COMPLETE

RETRY GUARD EPOCH PHASE COMPLETE

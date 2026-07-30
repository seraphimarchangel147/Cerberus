# Phase: Wave 2 — Mutation Lease Observability & TTL

**Spec author:** Seraphim · **Date:** 2026-07-29
**Baseline:** `main` @ `3db3351` (Wave 1 merged: `tests 2108 · pass 2084 · fail 0 · skipped 24`)
**Motivating incident:** live, 2026-07-29, `#azazel-chat`

> **READ THIS SPEC IN FULL BEFORE EDITING.** All anchors verified against live source
> 2026-07-29. If an anchor doesn't match, STOP and report it in `CHANGES.md` rather than guess.

## The incident this exists to prevent

Azazel spent **~18 minutes** unable to write anything. Every mutation lane failed with the
same message:

```
Mutation conflicts with another active invocation.
```

- Direct `code_edit` ×3 — refused
- Governed `coder_apply` transactions ×3 (`coder_d96ba…`, `coder_f82a4…`, `coder_84aaa…`) —
  all checkpointed, **none applied**
- A delegated child agent in a **fresh session** with 10 minutes of retries — same wall

Reads worked fine. A fresh child session hitting the identical wall proved it wasn't his
session's ghost leases — something **process-global** held the lock and never released it. The
only thing that cleared it was a daemon restart.

**He diagnosed the two defects himself, and he was right:**

1. **No lease observability.** There is no way to see *who* holds the mutation lock. A stuck
   lease is invisible — he burned 18 minutes and three transactions *proving it was stuck*
   instead of reading one status line.
2. **Leases can outlive their invocation** with no TTL and no reconcile.

## Verified ground truth (read this before designing)

**`src/job-manager.js:337` `acquireToolInvocation(tool, args, context)`** is the gate. Flow:
- `tool.sideEffects === false` → returns a no-op immediately (reads are never blocked ✓)
- durable-job path (`context.__jobId`) checks the store record
- then three conflict scans: durable job records, `state.quarantined`, and **`state.foreground`**
- on success: `state.foreground.set(leaseId, { owner: this, resourceLocks: required })`
  (`:386-389`), returning an idempotent release closure that deletes the entry.

**The defect, precisely (`:386-389`):** a foreground lease entry stores **only `owner` and
`resourceLocks`**. There is:
- **no `ownerId`/tool name** → the error can't say who holds it
- **no acquisition timestamp** → age is unknowable, so no TTL is even possible
- **no `sessionId`/`jobId`** → can't tell whose session created it

The error at `:381` therefore cannot name the holder, by construction.

**IMPORTANT NUANCE — do not "fix" the wrong thing.** The release **is** already correctly
wrapped: `tool-registry.js:1887-1889` calls `releaseJobLease?.()` inside a `finally`. So a leak
requires a handler that **never returns** (hung await, unresolved promise, un-aborted network
call) — not a missing release. **Therefore: do NOT move or restructure the release. The fix is
a TTL/reap for leases whose invocation can no longer complete, plus visibility.**

**`persistent: true` leases exist.** `reserveWorkspaceLease` (`:988-993`) sets
`{ owner, ownerId, persistent: true, resourceLocks }`. **These are long-lived by design and
MUST NEVER be TTL-reaped.** Note it already carries `ownerId` — follow that precedent.

## Scope

### Fix 1 — Lease metadata (foundation; everything else depends on it)

**Anchor:** `src/job-manager.js:386-389`

Extend the foreground lease entry with: a stable `leaseId` (already generated), `ownerId`
(tool name — from `tool.name`), `sessionId` and `jobId` when derivable from `context`,
`acquiredAt` (use the runtime's injectable clock if one exists; otherwise `Date.now()` behind a
seam so tests don't sleep), and the existing `resourceLocks`. Preserve `persistent` where set.

**Do not** put raw tool arguments in the lease — they can carry secrets. Tool name +
resource locks only.

**Test:** acquiring a lease records all metadata; a `persistent` lease keeps its flag; releasing
removes the entry; the release closure stays idempotent.

### Fix 2 — `mutation_lease_status` tool (the 10-second diagnosis)

Register a **read-only** tool (`sideEffects: false`, so it can never be blocked by the very
lock it inspects — this is essential and non-negotiable) returning, for each active lease:
`leaseId`, `ownerId`, `ageMs`/human age, `resourceLocks` (the file/resource scope),
`persistent`, and `sessionId`/`jobId` when known. Include `quarantined` and conflicting durable
job records too, since all three sets can block a write.

Follow the existing registration style in `src/tool-registry.js` and expose it in whatever
tool-list surface the chat lane uses, so it is reachable **without** a special mode. Redact via
the existing redaction helpers; never emit raw args or secret values.

**Test:** with N leases held, the tool lists them with correct owners/ages; it returns
successfully **while a conflicting lease is held** (proving it isn't self-blocked); output
contains no secret-shaped values.

### Fix 3 — Actionable conflict errors

**Anchors:** `src/job-manager.js:381` (and the sibling messages at `:366`, `:373`, `:983-987`)

Today: `"Mutation conflicts with another active invocation."` — unactionable.

Change to name the holder and its age, e.g.:
`"Mutation conflicts with active invocation 'code_edit' (lease 3f2a…, held 18m4s, locks: src/foo.js). Call mutation_lease_status for detail."`

Keep it one line, bounded length, and **never interpolate tool arguments**. Keep the existing
error *type/shape* so callers that match on it still work.

**Test:** a conflict error names the holding tool and includes an age; message length is
bounded; no secrets appear.

### Fix 4 — Lease TTL + reap (the actual unstick)

Add a TTL for **non-persistent** foreground leases: default **15 minutes**, env-tunable
(`OPENAGI_MUTATION_LEASE_TTL_MS`), `0` disables reaping entirely.

Rules — read carefully, this is the risky fix:
- **`persistent: true` leases are NEVER reaped.** Not at any age.
- Reap **lazily**, evaluated during conflict scanning (no new background timer — and note Wave 1
  Fix 3 added an unref'd-timer guard; do not introduce a timer that trips it).
- A reaped lease must be **loudly reported**: log with `leaseId`, `ownerId`, age, and locks.
  A silent reap is how you get a corrupted write nobody can explain. Emit it as a warning.
- **Fail safe:** any error in age computation or reaping ⇒ treat the lease as still held
  (i.e. keep today's behavior). Never let a reaper bug *grant* a lease it shouldn't.
- Expose `reapedAt`/`reapedReason` in `mutation_lease_status` history if cheap; skip if not.

**Rationale for lazy + loud:** the release is already in a `finally`, so a lease older than the
TTL means its invocation is genuinely wedged and will never return. Reaping it is strictly
better than requiring a daemon restart — but only if it's visible.

**Test:** a lease past TTL is reaped and a subsequent acquire succeeds; a `persistent` lease
past TTL is **NOT** reaped; TTL `0` disables reaping; a throwing clock ⇒ lease treated as held
(fail-safe); the reap emits a warning naming owner and age. **Use an injected clock — no real
sleeping in tests.**

## Hard constraints

- Verified baseline `tests 2108 · pass 2084 · fail 0 · skipped 24`. Final suite must show
  **fail 0** and **≥2084** plus your new tests. Re-measure before editing.
- **Zero new dependencies** — openAGI is `"dependencies": {}`.
- Do **NOT** restart the live daemon. Do **NOT** merge to `main`.
- Do **NOT** use `git reset --hard`.
- Reads must remain unblockable: never make `sideEffects === false` tools acquire a lease.
- Every new behavior fail-safe: on any internal error, preserve today's semantics.
- One commit per fix, each with a test that fails before and passes after.

## Deliverables

1. Four commits (order 1 → 4; Fix 1 first, it's the foundation).
2. A test per fix; suite green at ≥2084 pass / 0 fail.
3. `CHANGES.md` entry per fix: what changed, the anchor, the locking test, and any place
   reality differed from this spec.
4. Push the branch. Do not merge.
5. **Finish by appending this exact literal line as the last line of `CHANGES.md`:**

```
MUTATION LEASE WAVE 2 COMPLETE
```

If a fix can't be completed, say so explicitly in `CHANGES.md` and **still write the marker** —
an honest partial beats a silent stall.

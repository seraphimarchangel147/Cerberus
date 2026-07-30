# FIXED: compaction no-op when keepRecentTurns == role-message count

**Found:** 2026-07-30 during Wave-3 B3 QA (seraphim), initially as "the KEEP=2 no-op".
**Fixed:** 2026-07-30 (seraphim). Regression test in `test/context-compression.test.js`.

## Symptom (as first observed)

With `contextKeepRecentHops = 2`, `compressLiveContext` returned `compressed:false`
with an empty selection, while every neighbouring value worked:

```
keep 1 compressed true  selIdx [5,6,7,8]
keep 2 compressed false selIdx []        <-- no-op
keep 3 compressed true  selIdx [5,6,7,8]
```

Reproduction: `/tmp/qa-b/b3-window.mjs`.

## What it actually was

**Not** specific to 2. The no-op fires whenever `keepRecentTurns` equals the
transcript's **role-message count**. A generalized sweep showed the failure
tracking the transcript shape, not the constant:

```
roleCount=2 -> breaks at turns=2
roleCount=3 -> breaks at turns=3
roleCount=4 -> breaks at turns=4
```

The published defect title ("KEEP=2") was a sampling artifact of the one fixture
in use. The real invariant violated is **monotonicity**: asking to keep *more*
recent context compacted *less* (nothing at all), which is never sensible.

## Root cause

In a tool-heavy Responses transcript most items are `function_call` /
`function_call_output`, not role messages. `liveContextRecentBoundary` counts
backwards over **role messages only**. When the requested count equals the number
of role messages present, the walk lands on the transcript's **first** role
message (index 0 in the fixture). `liveContextSummaryStart` then returns
`index < boundary ? index + 1 : 0` — i.e. `0` — so `summaryStart == boundary == 0`,
the region `[summaryStart, boundary)` is empty, and the `boundary <= summaryStart`
guard short-circuits to a no-op. The item-suffix fallback that exists for exactly
this "many tool items, few role messages" case was unreachable, because it only
runs when the role walk finds *nothing*.

## Fix

`src/memory-condenser.js`, in `prepareContextLedgerCandidate`: when the computed
window is degenerate (`boundary <= summaryStart`), recompute it as "keep the
opening role turn verbatim, summarize the completed tool hops between it and the
final role turn" — the intent already documented on `liveContextSummaryStart` —
and adopt it only if it yields a non-empty region. A genuinely short transcript
with nothing to shed still falls through to the normal no-op.

This is in shared code, so it applies with the value-aware flag **on or off**.

## Verification

- Original repro `b3-window.mjs`: all keep values 1-7 now compress.
- Generalized sweep (roleCount 2-5 x toolPairs 4,6 x every keep value): no no-ops.
- Correctness held across that matrix: no orphaned tool call/result pairs, restore
  exact, most recent role turn retained verbatim, input never mutated.
- B1 flag-off corpus vs pre-Wave-3: 4 of 16 compaction cases changed, **all four
  strictly no-op -> compress** (33086 -> 3695 chars, 28966 -> 16605). The other 12
  unchanged; retrieval byte-identical. The corpus had been carrying four latent
  instances of this bug.
- Full suite 2155 tests, 0 fail (default + prod-policy).
- Regression test verified **non-vacuous**: reverting the fix makes it fail with
  `roleCount=2 keepRecentTurns=2 silently declined to compact`.

## Note on impact

Original report said "default is 4, so this is latent". That was too generous:
the trigger is transcript-shape-dependent, so any deployment can hit it whenever a
conversation's role-message count coincides with the configured keep value —
including at the default. It was silent when it happened.

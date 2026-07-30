# Open defect: KEEP=2 compaction no-op (pre-existing, not Wave 3)

**Found:** 2026-07-30 during Wave-3 B3 QA (seraphim).
**Status:** OPEN — reported, not fixed. Deliberately out of scope for the Wave-3 flag QA.

## Symptom

With `contextKeepRecentHops = 2`, `compressLiveContext` returns `compressed:false`
with an empty selection, while every neighbouring value works:

```
keep 1 compressed true  selIdx [5,6,7,8]
keep 2 compressed false selIdx []        <-- no-op
keep 3 compressed true  selIdx [5,6,7,8]
keep 4..7 compressed true selIdx [5,6,7,8]
```

Reproduction: `/tmp/qa-b/b3-window.mjs`.

## Why it is NOT a Wave-3 regression

It reproduces at the pre-Wave-3 worktree (`735f723`) AND on HEAD with
`valueAwareCompaction` off. It is a shared-code boundary bug in the positional
summary-start / tool-pair adjustment path, not in the value-aware cascade.
My initial read was wrong and is corrected here.

## Suspected area

`adjustLiveToolPairSummaryStart` + the recent-hop boundary computation in
`src/memory-condenser.js`: at KEEP=2 the adjusted summary start appears to land
on or past the boundary, leaving an empty prefix, which short-circuits to a
no-op instead of nudging the boundary.

## Impact

Any deployment configured with `contextKeepRecentHops: 2` gets NO live-context
compaction at all — silently. Default is 4, so this is latent rather than live.

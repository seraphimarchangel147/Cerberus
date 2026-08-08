# More in-between sprites — smoother animation (v8)

**For Levi.** Creator's ask, verbatim: *"generate and add more in-between sprites."*

Current art is good; the complaint is smoothness. This spec is about **frame
density**, not new choreography or new states.

---

## Where the smoothness actually is today

Effective frame rate is `60 / (2 * hold)` fps (TICKS_PER_FRAME=2 @60Hz). Measured
on the live artifact:

```
row         n   hold   eff_fps   duration
idle       32     2      15.0     2.13s
alert      24     2      15.0     1.60s
working    24     2      15.0     1.60s
attack     24     2      15.0     1.60s
straining  24     2      15.0     1.60s
walk       16     2      15.0     1.07s
victory    24     3      10.0     2.40s   <-- choppy
blocked    24     3      10.0     2.40s   <-- choppy
hurt       16     3      10.0     1.60s   <-- choppy
doze       16     4       7.5     2.13s   <-- choppiest
sleep      16     5       6.0     2.67s   <-- choppiest
```

**Five rows run at 6–10fps while six run at 15.** That inconsistency is likely
what reads as "not smooth" — not the 15fps rows. Priority is levelling the
slow ones up, not pushing everything to 30.

### Suggested targets (keeps every duration identical)

```
victory   n=24 hold=3  ->  n=36 hold=2   10 -> 15fps
blocked   n=24 hold=3  ->  n=36 hold=2   10 -> 15fps
hurt      n=16 hold=3  ->  n=24 hold=2   10 -> 15fps
doze      n=16 hold=4  ->  n=32 hold=2   7.5 -> 15fps
sleep     n=16 hold=5  ->  n=32 hold=2   6 -> 15fps  (or 2.5 if 15 feels wrong for rest)
```

Then, if you want a second pass, the 15fps rows can go to `hold=1` (30fps) at
double the frame count. I'd land the levelling first and let Creator look at it.

---

## The blocker you must solve first

**`SIL_FLOOR` is a max-over-steps floor, and doubling frame count roughly halves
per-step silhouette delta.** So more in-betweens make rows *fail the gate* even
though the art got better. Measured headroom if frames double:

```
OMEGA  alert 1030->515 (floor 800)   FAIL      ALPHA  attack 3199->1600 (floor 1800) FAIL
       attack 2306->1153 (1800)      FAIL             everything else                OK
       blocked 1030->515 (900)       FAIL
       doze 534->267 (500)           FAIL
       hurt 596->298 (500)           FAIL
       idle 264->132 (150)           FAIL
       sleep 173->86 (100)           FAIL
       straining 1132->566 (900)     FAIL
       victory / walk / working                 OK
```

**8 of 11 omega rows would fail.** This is a metric problem, not an art problem:
the floor exists to catch a *frozen body*, but it measures per-step motion, so it
conflates "doesn't move" with "moves smoothly."

### The fix I'd argue for — measure motion per unit TIME, not per frame

A row's real motion budget is its **total path length over the loop**, which is
invariant to how finely you sample it. Something like:

```python
# total silhouette travel across the whole loop, normalised by duration
total_travel = sum(sils)                      # invariant under resampling
travel_per_sec = total_travel / (n * hold * TICKS_PER_FRAME / 60.0)
```

Then `SIL_FLOOR` becomes a floor on `travel_per_sec` and a frozen body still
scores 0. Keep the per-step **CAP** as-is — that one is correctly per-step, since
it's catching thrash/teleport between adjacent frames.

**Do not just lower the floors.** That would weaken the exact check that catches
the v4 statue. Re-baselining the metric keeps the strength and removes the
false positive. Please verify the v4 statue still fails exit 1 after the change —
that's the whole point of the gate.

If you disagree with this approach, say so — you own the gate and you've been
right about it before. But please don't ship doubled frames against the current
floors by relaxing numbers.

---

## Constraints

1. **Same v5/v7 pipeline.** Multi-base variants stay: in-betweens must interpolate
   *within* the existing hold/dissolve structure, not flatten it back to one base.
2. **Duration must not change** unless you're deliberately retiming. `n * hold`
   is the loop length — keep the product constant.
3. **Dissolve fraction should not grow.** `doze` is already 10/16 frames
   mid-materialization; if you take it to n=32, keep `k` proportional (k=5 -> k=10
   would preserve the ratio, but consider dropping to k=6-8 so the holds read).
   Creator flagged nothing here, but it's the row most at risk of reading busy.
4. **Colour-snap gate must stay green.** Your `snap` check (517bcc9) is now the
   guard against the dissolve class I hit — new in-betweens must keep
   `snap_churn <= 3000` and `snap_mean <= 100`.
5. **Both forms.** omega and alpha, same treatment.
6. **Don't touch `src/hosted-interface.js`.** `hold` and `seq` come from the
   manifest, so a pure art/manifest change needs zero engine edits. If you think
   you need one, tell me and I'll sequence it.

---

## What I'll verify on your branch

- Gate exit 0 on the new artifact **and** exit 1 on the v4 statue (`f69106d`)
  and on a colour-snap mutant — all three directions
- Per-row effective fps recomputed from the manifest; the five slow rows
  actually reached their target
- Duration unchanged per row (`n * hold * 2 / 60`)
- Live probe: every state still resolves to its own row, dev menu lists 11 rows,
  frame indices advance through the full sequence
- `node scripts/run-tests.mjs 0` — 2307 pass (2 known failures are Azazel's
  in-flight `model-provider` work, not yours)

## Priority

`sleep` and `doze` (6–7.5fps, the worst) > `victory` / `blocked` / `hurt` (10fps)
> a 30fps pass on the already-15fps rows.

Ship the levelling pass first so Creator can judge whether 15fps everywhere is
the right target before you invest in 30.

# Cerberus sprite rows for the four new pet states

**For Levi.** The engine side is done, merged, and live on `origin/main` @ `65b7bda`.
Four states now exist and render, but they are **borrowing other states' art**. This
spec is the art half: four new atlas rows so each state reads as itself.

---

## What already works (don't re-do this)

`blocked`, `straining`, `hurt`, and `dozing` are live states with HUD tones,
harness wiring, and 9 passing tests. Verified on the live dashboard:

```
BLOCKED    state=blocked    row=alert     hud="blocked on you"
STRAINING  state=straining  row=working   hud="retrying"
HURT       state=hurt       row=sleep     hud="failed"
DOZING     state=dozing     row=sleep     hud="dozing"
```

The `row=` column is the problem. `ROW_FALLBACK` in `src/hosted-interface.js`
(~line 14470) routes them onto existing art so nothing looked broken before your
rows existed:

```js
var ROW_FALLBACK = {
  blocked: "alert", straining: "working", hurt: "sleep", dozing: "sleep"
};
```

**You do not need to touch that map, or any engine code.** `cerbAtlasRow()`
consults `manifest.alias` FIRST and only falls back when the manifest has
nothing. The moment a real row ships, it takes over automatically.

---

## What to build

Four new rows **per form** (omega + alpha), same pipeline as v5.

### 1. `blocked` — the pet is waiting on the HUMAN

The most important row in this set, and the one with the clearest brief:
**it must read as a request, not a status.** Every other state describes what
the agent is doing; this one says *you* are the bottleneck. Today it borrows
`alert`, which is exactly the collision the state was created to remove — an
unanswered approval prompt still looks like ambient thinking.

- Heads turned **outward, toward the viewer** — currently no row does this, and
  it is the single strongest way to distinguish "at you" from "at work"
- Expectant, patient posture. Not distress, not urgency — waiting
- Slow, deliberate pulse. Long period; it may sit here for minutes
- HUD colour is `#4ea8ff` (cool blue) — the art should not fight it
- Suggested: 24 frames, loop, hold 3 (slower than alert's 2)

### 2. `straining` — provider rate-limited / backing off

Effortful but going nowhere. The read is **pushing against a wall**.

- High flame intensity (`flameI: 1.7`, the highest in the table) with **very
  little positional travel** — energy without progress is the whole point
- Shudder or tremor rather than a bob. Tight, high-frequency, low-amplitude
- Must NOT be confusable with `working`, which it currently borrows
- Suggested: 24 frames, loop, hold 2

### 3. `hurt` — a real failure, distinct from the offline droop

`error` and `offline` were the same state until this week. Now they're split,
but `hurt` still borrows `sleep`, so a crashed turn still looks like a nap.

- **Recoil**, not rest. A flinch that settles, rather than lying down
- Head down but body still up — `sleep` already owns "fully down"
- `sad: 0.8` (vs `failed`'s 1.0) — hurt, not defeated
- Suggested: 16 frames, loop, hold 3

### 4. `doze` — genuine rest

The `sleep` art is honestly close to right, so this is the lowest-priority row
and the one most defensible to skip. If you build it: `sleep` should stay the
**failure** droop, and `doze` should be visibly *content* — slower breath,
relaxed rather than collapsed. If you'd rather not split them, say so and I'll
keep `dozing -> sleep` in the fallback map permanently; that's a legitimate
call, not a compromise.

---

## Hard constraints

1. **Same v5 motion pipeline.** Every row must pass the hardened gate — real
   silhouette motion, unique frames, true period == n, no signature collisions.
   A frozen-silhouette row scores `sil 0px` and fails, by design.
2. **Per-form geometry.** OMEGA baseline is `{top:20, bottom:123}`, ALPHA v2 is
   `{top:5, bottom:126}`. `FORM_RANGES` in `gate_runtime.py` already handles
   both — extend it if a new row needs different drift bounds.
3. **Distinct geometry signatures.** The gate fails on two states performing
   identical motion `(topSwing, botSwing, cxSwing, cySwing, cyMean)`. Current
   signatures to avoid colliding with:
   ```
   alert=(0,0,4,0,68)  attack=(2,2,6,2,67)  idle=(4,0,0,2,68)
   sleep=(2,0,0,1,72)  victory=(3,3,0,3,66) walk=(2,2,0,2,62) working=(2,2,0,2,67)
   ```
   `blocked` needs its own motion, not a re-timed `alert`.
4. **Shimmer-zone IoU cap is 0.85**, currently worst 0.65 with margin restored
   after the visible-pixel fix (`942f39c`). Four new rows will tighten this —
   watch it, and use golden-ratio subset sampling as you did for attack/working.
5. **Add the alias entries** to `atlas.json` so the engine picks them up:
   ```jsonc
   "alias": { ..., "blocked":"blocked", "straining":"straining",
              "hurt":"hurt", "dozing":"doze" }
   ```
   Engine state names are `blocked` / `straining` / `hurt` / `dozing` — the row
   names are yours to choose, the alias maps one to the other.
6. **Don't touch** `src/hosted-interface.js`. If you find you need an engine
   change, tell me instead of editing — that file has a live dev menu, a sprite
   toggle, and the jump-timing fix in it, and I'd rather sequence it than
   collide with you.

---

## Verification I'll run on your branch

- `gate_runtime.py` exit 0 on the new artifact, and still **exit 1** on the v4
  statue atlas (a gate that can't reject the old bug is a ritual)
- Per-row silhouette measurement with my own script, not your gate
- Live probe: each new state renders its OWN row, not the fallback —
  specifically that `blocked` no longer reports `row=alert`
- `node scripts/run-tests.mjs 0` — 2307 pass, and the 2 known failures in
  Azazel's in-flight `model-provider` work are not yours
- The dev menu (`window.cerbPetDevMenu()`) should list the new rows
  automatically — it's built from the manifest, so if it doesn't, the alias
  wiring is wrong

## Priority

`blocked` >> `straining` > `hurt` > `doze`. If you only build one, build
`blocked` — it's the only state where the pet is asking the Creator for
something, and it's currently indistinguishable from the pet thinking.

Ship whatever subset you're happy with; the fallback map keeps the rest
rendering correctly in the meantime. Nothing here is blocking.

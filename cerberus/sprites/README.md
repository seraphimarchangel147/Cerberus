# Cerberus Sprite Animation Pipeline

Procedural state-machine compositors that turn registered sprite frames into
animated state GIFs for the two Cerberus forms.

## Forms

- **OMEGA** — volcanic hellhound (magma-crack fur, golden armor, fire + embers)
- **ALPHA** — mechanical/crystalline guardian (steel plating, cyan reactor core,
  blue flames + procedural lightning)

## Layout

```
sprites/
  omega/                      26 registered 128x128 OMEGA frames (despilled, common baseline)
  alpha/                      15 registered 128x128 ALPHA frames
  omega_state_compositor.py   OMEGA engine  -> out/omega_*.gif
  alpha_state_compositor.py   ALPHA engine  -> out/alpha_*.gif
  out/                        generated GIFs (gitignored — run the scripts to rebuild)
```

## States (12 per form)

Core: `idle`, `thinking`, `working`, `sleeping`, `attack`, `victory`, `error`, `walk`
Tool: `terminal`, `browser`, `search`, `code` (colored screen-glow reflecting up off the beast)

## Build

Two separate outputs, for two different consumers:

### 1. Runtime atlas (what the dashboard actually renders)

```bash
python3 cerberus/sprites/build_runtime_atlas.py
```

Writes `runtime/omega_atlas.png`, `runtime/alpha_atlas.png` and `runtime/atlas.json`.
**These are committed** — the daemon serves them at `/assets/cerberus/` and the pet
renderer in `src/hosted-interface.js` blits from them. Re-run this and commit the
result whenever the source frames change, or the dashboard keeps showing the old art.

`atlas.json` is the single source of truth for playback: which frames exist, the
sequence each state plays, how long each frame is held, and the engine-state →
art-row alias map. Frames are addressed **by name**, so repacking the sheet cannot
silently repoint a state at the wrong pose. The build validates every reference and
fails loudly rather than emitting a broken manifest.

Verify a change with the end-to-end browser check (drives every form × state,
asserts rows match the manifest alias and that looping rows actually advance):

```bash
node scripts/qa/verify-cerberus-sprites.mjs http://127.0.0.1:<port>/
```

### 2. Preview GIFs (docs / eyeballing only)

```bash
python3 cerberus/sprites/omega_state_compositor.py
python3 cerberus/sprites/alpha_state_compositor.py
```

Both scripts resolve paths relative to their own location, so they run from
anywhere. Output lands in `sprites/out/` (gitignored). Requires `Pillow`, `numpy`, `scipy`.
Nothing at runtime reads these.

## Procedural layers (compositor-level, on top of baked frames)

- Breathing (vertical scale oscillation anchored at the paw baseline)
- Per-state color grading (tint multiplication)
- Thought particles (thinking state: rising cyan sparks off the heads)
- Screen shake (attack/error)
- State-specific halo/rim colors, fire intensity, ember density, cross-fade speed
- Walk: vertical bob (locomotion is capped by source art — see note below)
- Hold-then-blend keyframe window (22%) to avoid cross-fade ghosting

## Frame registration constants

`TARGET_H = 104`, `BASELINE_Y = 124`, `CANVAS = 128`. Aggressive green despill
(clamps G to avg(R,B) on green-dominant pixels). Zero green spill verified across
all frames.

## Animation architecture (v6 — bodies move, identity holds)

Every animated frame is derived from ONE base per state via bounded
procedural motion plus a photometric shimmer wave — NOT independently
generated illustrations. Independently generated frames re-decide
pose/proportions/silhouette each time and strobe when sequenced
(inter-frame change 30-58%); derivation locks identity structurally.

v5 history: v4 locked every frame to an exact bbox (top=20, bottom=123) to
prevent drift and phase aliasing. That invariant overshot into forbidding
ALL silhouette motion — 12 of 14 rows recolored glow interiors on a frozen
body, and the eye reads that as static. v5 keeps v4's uniqueness/period
machinery and adds real geometry motion per state. v6 (2026-08) adds rows
for the four harness states the engine learned in `65b7bda` (blocked /
straining / hurt / dozing) — all derived from the FRONTAL `idle_neutral`
base, the only pose with the center head facing the viewer, so "waiting on
you" reads as facing you rather than as ambient work:

- `derive_frames.py` — derives all cycles from the bases. Motion vocabulary:
  - idle (`dl*`, 32f): BREATH — baseline-anchored vertical chest scale,
    feet planted (bottom=123 exact), 2 rows of rise/fall over 2 cycles
  - alert (`al*`, 24f): SWAY — whole-body horizontal weight-shift ±2px
  - working (`wo*`, 24f): BOB — vertical lift 0..2px off the baseline
  - attack (`at*`, 24f): stance surge + LUNGE — leg-cluster snaps, bob,
    and a ±3px horizontal lunge on the beat (one-shot row)
  - victory (`vc*`, 24f): BOB — the biggest vertical lift (3px) + broad swell
  - walk (`wk*`, 16f): stride — alternating leg-cluster weight-shift + bob,
    from `walk_step_right`
  - sleep (`sl*`, 16f): BREATH — one slow shallow breath per loop, feet planted
  - blocked (`bl*`, 24f): EXPECTANT — one LONG breath per loop + lean-in
    sway; patient, not distressed (hold 3, slower than alert on purpose)
  - straining (`st*`, 24f): TREMOR — high-freq ±1px shudder + occasional
    1px chest compression; energy without travel, hot shimmer, feet planted
  - hurt (`hu*`, 16f): FLINCH — snap to full compression, ease back only
    partway, throb + a one-way backward stagger (a wince has a direction)
  - doze (`dz*`, 16f): CONTENT REST — slow breath + a gentle symmetric loll,
    quietest shimmer of the set
  All motion is driven by the same coprime beat-wave pair as the shimmer
  phases, so uniqueness/period survive; shimmer rides the moving body.
- `gate_runtime.py` — gate QA measured from the packed runtime atlas (what
  the engine consumes), rebuilt around ALPHA-channel metrics (RGB diffs are
  contaminated by any geometry transform on textured art): silhouette
  presence-XOR per-state FLOOR (frozen bodies fail) + CAP, bounded top/bottom
  ranges, planted feet for the six baseline-anchored states, every frame
  unique, true period == seq length, shimmer on alpha-constant pixels >=
  0.5%, geometry-signature collision check (no two states perform identical
  motion), shimmer-zone IoU cap, and the COLOR-SNAP check: a step whose
  silhouette barely moves (XOR < 50px) must not churn more than 3,000
  interior pixels or mean RGB delta > 100 — the signature of a palette
  hard-cut (pre-fbcf723 dissolve: 6,488px churn, delta 215.9, silXOR 0;
  the fixed artifact's worst geometry-quiet step is 1,377px/14.7).
  Frames that fail a gate do not ship.

Run order: `derive_frames.py` → `build_runtime_atlas.py` → `gate_runtime.py`.

## Known limitation: true locomotion

The AI image model cannot produce frames with differentiated leg articulation
(confirmed across multiple prompt strategies — feet stay planted, side views
drop heads to two). The walk cycle is therefore shimmer + weight-shift on a
single stride pose; a true multi-pose walk cycle needs hand-drawn frames or a
model with reliable pose control.

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

## Animation architecture (identity-locked derivation)

Every animated frame is derived from ONE identity-locked base per state via
bounded procedural transforms — NOT independently generated illustrations.
Independently generated frames re-decide pose/proportions/silhouette each time
and strobe when sequenced (inter-frame change 30-58%); derivation locks identity
structurally.

- `derive_frames.py` — derives all cycles from the bases, with DISTINCT
  choreography per state (different seeded glow zone, amplitude, wavelength,
  and cycle count, so states read as different energies, not one shimmer at
  different speeds):
  - idle (`dl*`, 32f): calm breathing, 9% glow subset, slow long wave
  - alert (`al*`, 24f): watchful scan, 12% subset, tighter faster wave
  - working (`wo*`, 24f): rhythmic processing pulse, 10% subset, mid wave
  - attack (`at*`, 24f): aggressive surge, 12% subset, big amp + whole-stance
    horizontal snaps on leg clusters (one-shot row)
  - victory (`vc*`, 24f): celebratory bloom, 20% subset, broad slow swell
  - walk (`wk*`, 16f): stride shimmer + alternating weight-shift on leg
    clusters from `walk_step_right`
  - sleep (`sl*`, 16f): slow shallow flicker on a 7% subset of `sleep_rest`
- Beat wave: every cycle pairs the main wave with an incommensurate minor wave
  (coprime cycle count) so the combined period is exactly n — every frame is
  unique, no phase-aliasing duplicates.
- `gate_runtime.py` — gate QA measured from the packed runtime atlas (what the
  engine consumes): inter-frame changed px, width spread, meanRGB swing,
  baseline top=20/bottom=123, PLUS lower bounds: every frame unique, true
  period == seq length, min motion 0.5%. Frames that fail a gate do not ship.

Run order: `derive_frames.py` → `build_runtime_atlas.py` → `gate_runtime.py`.

## Known limitation: true locomotion

The AI image model cannot produce frames with differentiated leg articulation
(confirmed across multiple prompt strategies — feet stay planted, side views
drop heads to two). The walk cycle is therefore shimmer + weight-shift on a
single stride pose; a true multi-pose walk cycle needs hand-drawn frames or a
model with reliable pose control.

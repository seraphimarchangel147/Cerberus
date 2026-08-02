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

## Known limitation: the walk cycle

The AI-generated walk frames keep all four feet planted on the ground line, and
the model cannot reliably differentiate leg lifts. The brain decodes walking from
leg position, so compositor-level body tilt/shear does not sell locomotion (it was
tried and regressed the read). The walk state ships a clean vertical bob only; a
true walk cycle needs new source frames with real leg articulation.

# New Artwork Workflow — shipping NEW sprite variants to the live atlas

Repeatable pipeline for "give Cerberus new sprite art." Every step is
scripted under `tools/` and every failure mode below was measured in the
field (v10 cycle, 2026-08-09). Full reasoning lives in the Levi skill
`sprite-new-artwork-pipeline`; this doc is the shared-repo copy.

## Quick command sequence

```bash
cd ~/openagi/cerberus/sprites

# 1. Generate a reference-locked candidate (primary sprite = image reference)
python3 tools/generate_variant.py \
    omega/idle_neutral.png /tmp/newart/omega_e.png \
    "A STORMCLOUD CLOAK of dark violet smoke swirls around the shoulders" \
    --form omega
#    --form alpha locks the palette cold (cyan/steel/white, no warm colors)

# 2. Anatomy-gate it against the primary (3-vote majority, exit !=0 on reject)
python3 tools/anatomy_gate.py omega omega/idle_neutral.png /tmp/newart/omega_e.png
#    SHIP criteria: SAME ANATOMY (majority) AND distinctiveness >= 4
#    REJECT -> regenerate; registration cannot repair anatomy

# 3. Register onto the per-form baseline (magenta key, drift-checked)
python3 tools/register_variants.py omega:/tmp/newart/omega_e.png:idle_variant_e

# 4. Weave into rows in derive_frames.py (build_track(b0, vN, N, k=...)),
#    rebuild, gate
python3 derive_frames.py && python3 build_runtime_atlas.py && python3 gate_runtime.py

# 5. Commit (ONLY cerberus/sprites/), push, restart daemon, verify SERVED shas
curl -s http://127.0.0.1:43210/assets/cerberus/atlas.json | python3 -c \
    "import json,sys; print({f:v['sha'] for f,v in json.load(sys.stdin)['forms'].items()})"
#    shas must equal runtime/atlas.json on disk — mismatch = not live
```

## Hard rules (each cost a failed cycle)

1. **Reference-lock anatomy.** Text-only "same identity" prompts flip
   quadruped<->biped even when heads/palette QA perfect. Always pass the
   primary base as the image reference; change ONLY the listed decoration.
2. **Single primary, full cell.** Never a side-by-side composite as the
   reference — the model renders a squat small target below the drift window.
3. **Prompt the height explicitly.** The generator's template includes it;
   do not strip it when hand-writing prompts.
4. **Decoration must not duplicate the form's own FX** (ice/lightning on
   ALPHA is its baseline look -> low distinctiveness -> reject).
5. **Never two same-motion rows on the same variant** — geometry signatures
   collide (blocked+doze on one variant with equal sway = gate FAIL).
6. **Generation background is PURE MAGENTA** (#FF00FF). `register_variants.py`
   here is the magenta key; the legacy green-key script in the tree is for
   older generations only.
7. **Verify the SERVED bytes.** Daemon serves from the working tree (not
   origin/main) and ETag-caches bodies until restart. Merge != deploy and
   deploy != merge; the sha check above is the only truth.

## Baselines (cell 128, drift-checked automatically)

| form  | primary top | primary bottom | width | target_h |
|-------|-------------|----------------|-------|----------|
| omega | 20          | 123            | 122   | 104      |
| alpha | 5           | 126            | 121   | 122      |

## Generation route

`generate_variant.py` uses OpenRouter `google/gemini-3.1-flash-image`
(chat-completions + `modalities`, key `OPENROUTER_API_KEY` in the shared
Hermes .env, ~8-10s/image). This is the designed fallback for when the
QwenCloud weekly token-plan quota 429s — quota exhaustion never blocks art.

## Proof of delivery

Render GIFs from the PACKED runtime atlas (hold frames at 33ms/frame), not
from source frames. The variant materializes MID-LOOP (~1s into a 2s idle),
so a glance at loop start shows only the primary — say so when delivering,
or the user will conclude nothing shipped.

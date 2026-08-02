#!/usr/bin/env python3
"""Pack the registered Cerberus sprite frames into RUNTIME atlases.

The state compositors (omega_state_compositor.py / alpha_state_compositor.py)
produce offline GIFs for docs and previews. This script produces the artifact
the *engine* consumes: a single PNG sheet per form plus a JSON animation map
that the pet renderer in src/hosted-interface.js blits from.

Design notes
------------
* One sheet per form, frames packed in a stable, name-indexed order. The
  animation map references frames by NAME, never by grid position, so
  re-ordering or adding art cannot silently repoint a state at the wrong pose.
* All source frames are registered to a common baseline (content spans
  y=20..124 on a 128px canvas), so no per-frame offset table is needed.
* Shipped as a real HTTP asset (GET /assets/cerberus/<form>_atlas.png), NOT as
  inline base64 in the HTML. The previous generation baked a 318KB base64 blob
  into the served page, which is ~33% larger than the binary, uncacheable, and
  reparsed on every load. As a static asset it is content-hash cached and the
  HTML shrinks by the whole payload.
* NOT palette-quantized. This art is rendered with soft shading, not flat pixel
  art — the OMEGA sheet alone carries ~71k unique colors, so a 256-entry
  palette produced visible banding (p99.9 channel error 60/255) for almost no
  size win. Plain optimized RGBA PNG it is.

Run:
    python3 cerberus/sprites/build_runtime_atlas.py
Writes:
    runtime/omega_atlas.png  runtime/alpha_atlas.png  runtime/atlas.json
"""

import json
import math
import os

from PIL import Image

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, "runtime")
CELL = 128

# ── Frame inventory ────────────────────────────────────────────────────────
# Order is the pack order. Keep it append-only: the JSON map keys by name, but
# a stable order keeps diffs on the generated PNG readable.
OMEGA_FRAMES = [
    "idle_neutral", "idle_calm", "idle_breath", "idle_deepbreath", "idle_inhale",
    "idle_alert", "idle_tense", "idle_halfroar", "idle_snarl", "idle_roar",
    "idle_recovery", "working_stare", "working_snarl",
    "attack_windup", "attack_lunge", "attack_roar2", "attack_overdrive",
    "attack_recover", "special_ability",
    "victory_howl", "victory_howl2", "sleep_rest", "sleep_stir",
    "walk_left", "walk_right", "walk_step_left", "walk_step_right", "base_lock",
]

ALPHA_FRAMES = [
    "idle_neutral", "idle_calm", "idle_thinking", "idle_tense", "idle_snarl",
    "idle_roar", "working_focus",
    "attack_overdrive", "attack_recover",
    "victory_howl", "victory_howl2", "sleep_rest", "sleep_stir",
    "walk_left", "walk_right", "walk_step_left", "walk_step_right",
]

# ── Animation map ──────────────────────────────────────────────────────────
# `seq`  : frame names, played in order
# `hold` : rendered frames each entry is held for, at the engine's 30fps
# `loop` : false rows hold their final frame until the engine state changes
#
# The engine's own state vocabulary is idle / running / review / failed /
# waving / jumping / waiting. `alias` maps that vocabulary onto these rows so
# the art rows stay named after what they DEPICT, not after engine internals.
OMEGA_STATES = {
    "idle": {
        # Breathing cycle with occasional alert/recovery glances woven in so
        # the idle reads as "alive and watchful", not a static chest pump.
        "seq": ["idle_neutral", "idle_calm", "idle_breath", "idle_deepbreath",
                "idle_inhale", "idle_deepbreath", "idle_breath", "idle_alert",
                "idle_calm", "idle_neutral", "idle_recovery", "idle_calm"],
        "hold": 6, "loop": True,
    },
    "alert": {
        "seq": ["idle_alert", "idle_tense", "idle_alert", "idle_neutral"],
        "hold": 6, "loop": True,
    },
    "working": {
        "seq": ["working_stare", "idle_alert", "idle_tense", "working_snarl",
                "idle_halfroar", "working_stare", "idle_snarl", "idle_tense"],
        "hold": 4, "loop": True,
    },
    "attack": {
        "seq": ["idle_tense", "attack_windup", "attack_lunge", "attack_overdrive",
                "attack_roar2", "special_ability", "attack_recover", "idle_recovery"],
        "hold": 3, "loop": False,
    },
    "victory": {
        "seq": ["idle_alert", "idle_snarl", "idle_roar", "victory_howl",
                "victory_howl2", "victory_howl", "idle_roar", "idle_snarl"],
        "hold": 4, "loop": True,
    },
    "sleep": {
        "seq": ["sleep_rest", "sleep_rest", "sleep_stir", "sleep_rest"],
        "hold": 12, "loop": True,
    },
    "walk": {
        # 4-frame alternating stride (L, R, L, R) with two distinct poses per
        # side so the gait doesn't rock back and forth on just two frames.
        "seq": ["walk_left", "walk_right", "walk_step_left", "walk_step_right"],
        "hold": 3, "loop": True,
    },
}

ALPHA_STATES = {
    "idle": {
        # Doubled from 4 frames: breathing base with thinking/snarl micro-shifts
        # so the mechanical guardian reads as scanning/processing, not frozen.
        "seq": ["idle_neutral", "idle_calm", "idle_thinking", "idle_calm",
                "idle_neutral", "idle_tense", "idle_snarl", "idle_calm"],
        "hold": 6, "loop": True,
    },
    "alert": {
        "seq": ["idle_thinking", "idle_tense", "idle_thinking", "idle_neutral"],
        "hold": 6, "loop": True,
    },
    "working": {
        "seq": ["working_focus", "idle_tense", "idle_snarl", "idle_tense"],
        "hold": 4, "loop": True,
    },
    "attack": {
        "seq": ["idle_tense", "idle_snarl", "attack_overdrive", "idle_roar",
                "attack_recover", "idle_neutral"],
        "hold": 3, "loop": False,
    },
    "victory": {
        "seq": ["idle_snarl", "idle_roar", "victory_howl", "victory_howl2",
                "victory_howl", "idle_roar"],
        "hold": 4, "loop": True,
    },
    "sleep": {
        "seq": ["sleep_rest", "sleep_rest", "sleep_stir", "sleep_rest"],
        "hold": 12, "loop": True,
    },
    "walk": {
        # 4-frame alternating stride (L, R, L, R) with two distinct poses per
        # side so the gait doesn't rock back and forth on just two frames.
        "seq": ["walk_left", "walk_right", "walk_step_left", "walk_step_right"],
        "hold": 3, "loop": True,
    },
}

# Engine state -> art row. Every key of the engine's STATES table must appear.
ALIAS = {
    "idle": "idle",
    "running": "working",
    "review": "alert",
    "failed": "sleep",
    "waving": "victory",
    "jumping": "attack",
    "waiting": "alert",
}


def pack(form, names):
    """Pack `names` from cerberus/sprites/<form>/ into a square-ish sheet."""
    src_dir = os.path.join(BASE_DIR, form)
    cols = math.ceil(math.sqrt(len(names)))
    rows = math.ceil(len(names) / cols)
    sheet = Image.new("RGBA", (cols * CELL, rows * CELL), (0, 0, 0, 0))
    index = {}
    for i, name in enumerate(names):
        path = os.path.join(src_dir, f"{name}.png")
        im = Image.open(path).convert("RGBA")
        if im.size != (CELL, CELL):
            raise SystemExit(f"{path}: expected {CELL}x{CELL}, got {im.size}")
        sheet.paste(im, ((i % cols) * CELL, (i // cols) * CELL))
        index[name] = i
    return sheet, cols, rows, index


def sha_short(path):
    import hashlib
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:12]


def validate(states, index, alias):
    for state, spec in states.items():
        for frame in spec["seq"]:
            if frame not in index:
                raise SystemExit(f"state {state!r} references unpacked frame {frame!r}")
        if spec["hold"] < 1:
            raise SystemExit(f"state {state!r}: hold must be >= 1")
    for engine_state, row in alias.items():
        if row not in states:
            raise SystemExit(f"alias {engine_state!r} -> unknown row {row!r}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {"cell": CELL, "alias": ALIAS, "forms": {}}

    for form, names, states in (("omega", OMEGA_FRAMES, OMEGA_STATES),
                                ("alpha", ALPHA_FRAMES, ALPHA_STATES)):
        print(f"{form}:")
        sheet, cols, rows, index = pack(form, names)
        validate(states, index, ALIAS)
        out_png = os.path.join(OUT_DIR, f"{form}_atlas.png")
        sheet.save(out_png, optimize=True)
        size = os.path.getsize(out_png)
        digest = sha_short(out_png)
        print(f"    {cols}x{rows} cells, {len(names)} frames, "
              f"{size:,} bytes, sha {digest}")
        manifest["forms"][form] = {
            "cols": cols, "rows": rows, "sha": digest,
            "frames": index, "states": states,
        }

    out_json = os.path.join(OUT_DIR, "atlas.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"wrote {out_json}")


if __name__ == "__main__":
    main()

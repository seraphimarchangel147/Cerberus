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
# Every frame is derived from ONE identity-locked base per state via bounded
# procedural transforms (photometric shimmer on a fixed glow subset + a
# horizontal weight-shift for walk), so inter-frame change is gated:
#   idle/active/sleep <= 10% changed px, walk <= 25%, width spread 0px,
#   baseline top=20 bottom=123 exact on every frame.
# Naming: dl=derived-idle, act=derived-active, wk=derived-walk, sl=derived-sleep.
def derived_names(prefix, n):
    return [f"{prefix}{i:02d}" for i in range(n)]

OMEGA_FRAMES = derived_names("dl", 24) + derived_names("act", 24) \
    + derived_names("wk", 16) + derived_names("sl", 16)

ALPHA_FRAMES = derived_names("dl", 24) + derived_names("act", 24) \
    + derived_names("wk", 16) + derived_names("sl", 16)

# ── Animation map ──────────────────────────────────────────────────────────
# `seq`  : frame names, played in order
# `hold` : rendered frames each entry is held for, at the engine's 30fps
# `loop` : false rows hold their final frame until the engine state changes
#
# The engine's own state vocabulary is idle / running / review / failed /
# waving / jumping / waiting. `alias` maps that vocabulary onto these rows so
# the art rows stay named after what they DEPICT, not after engine internals.
OMEGA_STATES = {
    # Calm breathing shimmer (dl cycle, 24 frames). hold 3 @30fps = 100ms/frame, 2.4s loop.
    "idle": {"seq": derived_names("dl", 24), "hold": 3, "loop": True},
    # Agitated shimmer (act cycle, 24 frames) — same identity-locked base, faster wave.
    "alert": {"seq": derived_names("act", 24), "hold": 3, "loop": True},
    "working": {"seq": derived_names("act", 24), "hold": 2, "loop": True},
    # One-shot agitated burst, holds its final frame until state changes.
    "attack": {"seq": derived_names("act", 24), "hold": 2, "loop": False},
    "victory": {"seq": derived_names("act", 24), "hold": 3, "loop": True},
    # Slow shallow flicker (sl cycle, 16 frames). hold 5 = 167ms/frame, 2.67s loop.
    "sleep": {"seq": derived_names("sl", 16), "hold": 5, "loop": True},
    # Stride shimmer + horizontal weight-shift (wk cycle, 16 frames). hold 2 = 67ms/frame.
    "walk": {"seq": derived_names("wk", 16), "hold": 2, "loop": True},
}

ALPHA_STATES = {
    "idle": {"seq": derived_names("dl", 24), "hold": 3, "loop": True},
    "alert": {"seq": derived_names("act", 24), "hold": 3, "loop": True},
    "working": {"seq": derived_names("act", 24), "hold": 2, "loop": True},
    "attack": {"seq": derived_names("act", 24), "hold": 2, "loop": False},
    "victory": {"seq": derived_names("act", 24), "hold": 3, "loop": True},
    "sleep": {"seq": derived_names("sl", 16), "hold": 5, "loop": True},
    "walk": {"seq": derived_names("wk", 16), "hold": 2, "loop": True},
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

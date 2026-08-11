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
# Every frame is derived from ONE base per state via bounded procedural
# motion (breath / bob / sway / lunge / leg weight-shift) plus a photometric
# shimmer wave on a seeded glow subset, so motion is real silhouette change
# and inter-frame behavior is gated (see gate_runtime.py):
#   silhouette presence-XOR per-state FLOOR (frozen bodies fail) and CAP
#   (thrash fails), bounded top/bottom ranges, planted feet for idle/sleep,
#   every frame unique, true period == seq length, shimmer on alpha-constant
#   pixels >= 0.5%, geometry-signature collision check, shimmer-zone IoU cap.
# v4 required a frozen silhouette and produced a statue (recolor-only rows);
# v5 moves the body — Creator's eye caught what the old gate certified.
# Each state has DISTINCT choreography — different motion (breath vs bob vs
# sway vs lunge) and different shimmer zone — so states read as different
# energies, not one effect at different speeds.
# Naming: dl=idle, al=alert, wo=working, at=attack, vc=victory,
#         wk=walk, sl=sleep, bl=blocked, st=straining, hu=hurt, dz=doze.
def derived_names(prefix, n):
    return [f"{prefix}{i:02d}" for i in range(n)]

# v9 smooth-in-between pass: every row doubles its frame count and its
# dissolve step count in the same proportion; holds drop 2 -> 1 so every
# loop's wall-clock duration (n*hold ticks) is unchanged. 30fps sampling,
# half the pixels flipped per materialization step = smooth transitions.
# PITFALL (v13): these constants DUPLICATE derive_frames.py's — when a row's
# frame count changes (e.g. idle 64->128 super-loop) BOTH files must be
# updated, or the builder packs the stale count and the gate reads a stale n.
N_IDLE, N_ALERT, N_WORKING, N_ATTACK, N_VICTORY, N_WALK, N_SLEEP = 128, 48, 48, 48, 72, 32, 80
# Harness-state rows (blocked / straining / hurt / dozing), all derived from
# the frontal idle_neutral pose.
N_BLOCKED, N_STRAINING, N_HURT, N_DOZE = 72, 48, 48, 64

OMEGA_FRAMES = derived_names("dl", N_IDLE) + derived_names("al", N_ALERT) \
    + derived_names("wo", N_WORKING) + derived_names("at", N_ATTACK) \
    + derived_names("vc", N_VICTORY) + derived_names("wk", N_WALK) \
    + derived_names("sl", N_SLEEP) + derived_names("bl", N_BLOCKED) \
    + derived_names("st", N_STRAINING) + derived_names("hu", N_HURT) \
    + derived_names("dz", N_DOZE)

ALPHA_FRAMES = derived_names("dl", N_IDLE) + derived_names("al", N_ALERT) \
    + derived_names("wo", N_WORKING) + derived_names("at", N_ATTACK) \
    + derived_names("vc", N_VICTORY) + derived_names("wk", N_WALK) \
    + derived_names("sl", N_SLEEP) + derived_names("bl", N_BLOCKED) \
    + derived_names("st", N_STRAINING) + derived_names("hu", N_HURT) \
    + derived_names("dz", N_DOZE)

# ── Animation map ──────────────────────────────────────────────────────────
# `seq`  : frame names, played in order
# `hold` : rendered frames each entry is held for, at the engine's 30fps
# `loop` : false rows hold their final frame until the engine state changes
#
# The engine's own state vocabulary is idle / running / review / failed /
# waving / jumping / waiting. `alias` maps that vocabulary onto these rows so
# the art rows stay named after what they DEPICT, not after engine internals.
OMEGA_STATES = {
    # Calm breathing shimmer (dl, 32f). hold 2 @30fps = 67ms/frame, 2.13s loop.
    "idle": {"seq": derived_names("dl", N_IDLE), "hold": 1, "loop": True},
    # Watchful scan (al, 24f) — tighter wave, faster, different glow zone.
    "alert": {"seq": derived_names("al", N_ALERT), "hold": 1, "loop": True},
    # Rhythmic processing pulse (wo, 24f). hold 2 = 67ms/frame, 1.6s loop.
    "working": {"seq": derived_names("wo", N_WORKING), "hold": 1, "loop": True},
    # Aggressive surge (at, 24f): big amp + whole-stance side snaps. One-shot,
    # holds final frame until the state changes.
    "attack": {"seq": derived_names("at", N_ATTACK), "hold": 1, "loop": False},
    # Celebratory bloom (vc, 36f): broad slow swell over a wide glow zone.
    # v8: hold 2 @30fps, 2.4s loop — same duration as the old 24f/hold-3.
    "victory": {"seq": derived_names("vc", N_VICTORY), "hold": 1, "loop": True},
    # Slow shallow flicker (sl, 40f). v8: hold 2 = 67ms/frame, 2.67s loop —
    # same duration as the old 16f/hold-5 (6fps -> 15fps).
    "sleep": {"seq": derived_names("sl", N_SLEEP), "hold": 1, "loop": True},
    # Stride shimmer + alternating weight-shift (wk, 16f). hold 2 = 67ms/frame.
    "walk": {"seq": derived_names("wk", N_WALK), "hold": 1, "loop": True},
    # Waiting on the human (bl, 36f): one long breath per loop + lean-in sway.
    # v8: hold 2, 2.4s loop — same duration as the old 24f/hold-3.
    "blocked": {"seq": derived_names("bl", N_BLOCKED), "hold": 1, "loop": True},
    # Rate-limited tremor (st, 24f): high-freq shudder, hot shimmer, no travel.
    "straining": {"seq": derived_names("st", N_STRAINING), "hold": 1, "loop": True},
    # Flinch that settles (hu, 24f): snap + partial recovery, throb.
    # v8: hold 2, 1.6s loop — same duration as the old 16f/hold-3.
    "hurt": {"seq": derived_names("hu", N_HURT), "hold": 1, "loop": True},
    # Content rest (dz, 32f): slow breath, quietest shimmer. v8: hold 2,
    # 2.13s loop — same duration as the old 16f/hold-4; dissolve fraction
    # dropped 62.5% -> 50% so the rest actually reads as rest.
    "doze": {"seq": derived_names("dz", N_DOZE), "hold": 1, "loop": True},
}

ALPHA_STATES = {
    "idle": {"seq": derived_names("dl", N_IDLE), "hold": 1, "loop": True},
    "alert": {"seq": derived_names("al", N_ALERT), "hold": 1, "loop": True},
    "working": {"seq": derived_names("wo", N_WORKING), "hold": 1, "loop": True},
    "attack": {"seq": derived_names("at", N_ATTACK), "hold": 1, "loop": False},
    "victory": {"seq": derived_names("vc", N_VICTORY), "hold": 1, "loop": True},
    "sleep": {"seq": derived_names("sl", N_SLEEP), "hold": 1, "loop": True},
    "walk": {"seq": derived_names("wk", N_WALK), "hold": 1, "loop": True},
    "blocked": {"seq": derived_names("bl", N_BLOCKED), "hold": 1, "loop": True},
    "straining": {"seq": derived_names("st", N_STRAINING), "hold": 1, "loop": True},
    "hurt": {"seq": derived_names("hu", N_HURT), "hold": 1, "loop": True},
    "doze": {"seq": derived_names("dz", N_DOZE), "hold": 1, "loop": True},
}

# Engine state -> art row. Every key of the engine's STATES table must appear.
# The harness states (65b7bda) use their OWN rows when present; the engine's
# ROW_FALLBACK map is only consulted for states the manifest doesn't know.
ALIAS = {
    "idle": "idle",
    "running": "working",
    "review": "alert",
    "failed": "sleep",
    "waving": "victory",
    "jumping": "attack",
    "waiting": "alert",
    "blocked": "blocked",
    "straining": "straining",
    "hurt": "hurt",
    "dozing": "doze",
}

# ── Transition windows (v12 contract, generalized v13) ─────────────────────
# Base-cycle spec per row: (bases, k). bases = number of distinct sprites the
# row cycles through (idle super-loop = 3; every other multi-base row = 2;
# sleep = 1 => no transition). k = dissolve steps per transition and MUST
# mirror the build_track([...], N_*, k=...) calls in derive_frames.py — that
# file is the source of truth; attach_transitions() validates the windows
# tile the seq so drift fails the build loudly.
# v12 purpose: the renderer overlays an evolve-style canvas composite (glow
# bloom + energy streaks + shockwave ring) during dissolve windows so the
# pixel materialization reads as energy FX instead of cheap pixel flips.
ROW_SPEC = {
    "idle": {"bases": 3, "k": 16},     # v13 super-loop: b0 -> C -> D -> b0
    "alert": {"bases": 2, "k": 8},
    "working": {"bases": 2, "k": 8},
    "attack": {"bases": 2, "k": 6},
    "victory": {"bases": 2, "k": 8},
    "walk": {"bases": 2, "k": 8},
    "sleep": {"bases": 1, "k": None},  # single-base: no visual transition
    "blocked": {"bases": 2, "k": 6},
    "straining": {"bases": 2, "k": 8},
    "hurt": {"bases": 2, "k": 10},
    "doze": {"bases": 2, "k": 16},
}


def transition_windows(n, m, k):
    """Inclusive seq-index ranges for one row's base cycle.

    Mirrors build_track()'s layout in derive_frames.py EXACTLY:
      for each base j: hold_j [lo, hi] then dissolve_j [lo, hi]; the last
      hold absorbs the remainder r. Returned as a list of M
      {"hold": [lo,hi], "dissolve": [lo,hi]} phase dicts in play order.
    """
    h = (n - m * k) // m
    r = n - m * k - m * h
    windows, cursor = [], 0
    for j in range(m):
        hold_len = h + (r if j == m - 1 else 0)
        hold = [cursor, cursor + hold_len - 1]
        cursor += hold_len
        dis = [cursor, cursor + k - 1]
        cursor += k
        windows.append({"hold": hold, "dissolve": dis})
    assert cursor == n
    return windows


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


# Per-form registration baseline. OMEGA keeps the classic geometry; ALPHA v2
# fills the cell (bigger + more detailed per Creator's overhaul request) so its
# top/bottom differ. Recorded in the manifest so gate QA validates each form
# against its OWN baseline instead of a single hardcoded constant.
BASELINE = {
    "omega": {"top": 20, "bottom": 123},
    "alpha": {"top": 5, "bottom": 126},
}


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


def attach_transitions(states):
    """Add per-row base-cycle windows to the manifest (v12 contract, v13
    generalized to M bases). Validates ROW_SPEC arithmetic against seq
    lengths so a k/bases drift in derive_frames.py fails the build instead
    of mis-timing the renderer's FX overlay."""
    for row, spec in states.items():
        n = len(spec["seq"])
        row_spec = ROW_SPEC.get(row)
        if row_spec is None:
            raise SystemExit(f"row {row!r} missing from ROW_SPEC")
        m, k = row_spec["bases"], row_spec["k"]
        if m == 1:                         # single-base row: no transition
            spec["transition"] = None
            continue
        if k < 1 or m * k > n:
            raise SystemExit(f"row {row!r}: m={m} k={k} invalid for n={n}")
        wins = transition_windows(n, m, k)
        # windows must tile [0, n-1] contiguously — catches formula drift
        covered = []
        for w in wins:
            for key in ("hold", "dissolve"):
                lo, hi = w[key]
                covered.extend(range(lo, hi + 1))
        if covered != list(range(n)):
            raise SystemExit(f"row {row!r}: windows do not tile the seq: {wins}")
        dissolve_idx = []
        for w in wins:
            dissolve_idx.extend(range(w["dissolve"][0], w["dissolve"][1] + 1))
        spec["transition"] = {
            "bases": m,
            "k": k,
            "windows": wins,              # [{"hold": [lo,hi], "dissolve": [lo,hi]}, ...]
            # engine convenience: dissolve frames in seq order, so the FX
            # overlay can fire on membership instead of index math.
            "dissolve_idx": dissolve_idx,
        }
    return states


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {"cell": CELL, "alias": ALIAS, "forms": {}}

    for form, names, states in (("omega", OMEGA_FRAMES, OMEGA_STATES),
                                ("alpha", ALPHA_FRAMES, ALPHA_STATES)):
        print(f"{form}:")
        sheet, cols, rows, index = pack(form, names)
        validate(states, index, ALIAS)
        attach_transitions(states)
        out_png = os.path.join(OUT_DIR, f"{form}_atlas.png")
        sheet.save(out_png, optimize=True)
        size = os.path.getsize(out_png)
        digest = sha_short(out_png)
        print(f"    {cols}x{rows} cells, {len(names)} frames, "
              f"{size:,} bytes, sha {digest}")
        manifest["forms"][form] = {
            "cols": cols, "rows": rows, "sha": digest,
            "baseline": BASELINE[form],
            "frames": index, "states": states,
        }

    out_json = os.path.join(OUT_DIR, "atlas.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"wrote {out_json}")


if __name__ == "__main__":
    main()

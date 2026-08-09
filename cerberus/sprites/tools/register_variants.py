#!/usr/bin/env python3
"""Register anatomy-gated variants onto the per-form sprite baseline.

Usage:
    python3 register_variants.py <form>:<src.png>:<registered_name> [...]
    example:
    python3 register_variants.py omega:/tmp/newart/omega_c.png:idle_variant_c \
                                 alpha:/tmp/newart/alpha_c.png:idle_variant_c

Pipeline (proven on Cerberus v10): magenta chroma-key -> fringe despill ->
(alpha only) cool recolor -> crop -> scale to primary height -> EXACT
width-match to primary -> plant on baseline. Then drift-checks the
registered bbox against the primary base's own bbox and fails loud if it
drifts outside tolerance.

Input art must be prompted on SOLID PURE MAGENTA (#FF00FF) — use
generate_variant.py. For green-keyed generations use the legacy
register_variants.py in the cerberus tree instead.

Cerberus baselines (cell 128):
    omega: target_h=104, baseline=123   (primary: top=20 bot=123 width=122)
    alpha: target_h=122, baseline=126   (primary: top=5  bot=126 width=121)
"""
import os
import sys

import numpy as np
from PIL import Image

SPR = os.path.expanduser("~/openagi/cerberus/sprites")
CANVAS = 128

FORM = {
    "omega": {"target_h": 104, "baseline": 123},
    "alpha": {"target_h": 122, "baseline": 126},
}
# drift tolerance vs the primary base's own bbox
TOP_TOL, BOT_TOL = 2, 1


def magenta_key(im):
    a = np.array(im.convert("RGBA")).astype(np.int32)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mag = (r > 140) & (b > 140) & (g < r - 40) & (g < b - 40)
    a[mag, 3] = 0
    op = a[:, :, 3] > 0
    # despill: fringe pixels carrying a magenta cast -> neutralize r/b toward g
    fringe = op & (a[:, :, 0] > a[:, :, 1] + 15) & (a[:, :, 2] > a[:, :, 1] + 15)
    a[:, :, 0][fringe] = a[:, :, 1][fringe]
    a[:, :, 2][fringe] = a[:, :, 1][fringe]
    return a, int(mag.sum()), int(fringe.sum())


def cool_recolor(a):
    """ALPHA identity is cold cyan/steel: swap r<->b on warm pixels."""
    op = a[:, :, 3] > 0
    r, b = a[:, :, 0], a[:, :, 2]
    warm = op & (r > b + 40) & (r > 100)
    n = int(warm.sum())
    nr, nb = b[warm].copy(), r[warm].copy()
    a[:, :, 0][warm] = nr
    a[:, :, 2][warm] = nb
    return a, n


def primary_bbox(form, name):
    """Registered bbox of the primary base for this row family."""
    base = "idle_neutral" if name.startswith("idle") else "walk_step_right"
    a = np.array(Image.open(os.path.join(SPR, form, f"{base}.png")).convert("RGBA"))
    op = a[:, :, 3] > 0
    ys, xs = np.where(op)
    return int(ys.min()), int(ys.max()), int(xs.max() - xs.min() + 1)


def register(form, src, name):
    cfg = FORM[form]
    im = Image.open(src)
    a, n_key, n_fringe = magenta_key(im)
    n_recolored = 0
    if form == "alpha":
        a, n_recolored = cool_recolor(a)
    op = a[:, :, 3] > 0
    if not op.any():
        sys.exit(f"{form}/{name}: empty mask — wrong key color?")
    ys, xs = np.where(op)
    crop = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1, :]
    ch, cw = crop.shape[:2]
    scale = min(cfg["target_h"] / ch, CANVAS / cw)
    new_h = int(round(ch * scale))
    p_top, p_bot, p_w = primary_bbox(form, name)
    new_w = p_w  # EXACT width-match: gate allows <=8px spread across a loop
    im2 = Image.fromarray(np.clip(crop, 0, 255).astype(np.uint8), "RGBA")
    im2 = im2.resize((new_w, new_h), Image.NEAREST)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    xoff = (CANVAS - new_w) // 2
    yoff = cfg["baseline"] - new_h + 1
    canvas.paste(im2, (xoff, yoff))
    out = os.path.join(SPR, form, f"{name}.png")
    canvas.save(out)

    v = np.array(canvas.convert("RGBA"))
    opv = v[:, :, 3] > 0
    vys, vxs = np.where(opv)
    top, bot, width = int(vys.min()), int(vys.max()), int(vxs.max() - vxs.min() + 1)
    print(f"{form}/{name}: crop={cw}x{ch} -> {new_w}x{new_h} top={top} "
          f"bottom={bot} width={width} (primary {p_w}) keyed={n_key} "
          f"despilled={n_fringe} recolored={n_recolored}")

    # drift check against the primary base's own registered bbox
    errors = []
    if abs(top - p_top) > TOP_TOL:
        errors.append(f"top {top} vs primary {p_top} (tol {TOP_TOL})")
    if abs(bot - p_bot) > BOT_TOL:
        errors.append(f"bottom {bot} vs primary {p_bot} (tol {BOT_TOL})")
    if width != p_w:
        errors.append(f"width {width} vs primary {p_w} (exact)")
    if errors:
        sys.exit(f"{form}/{name}: DRIFT FAIL — {'; '.join(errors)}")
    print(f"{form}/{name}: drift-clean (primary top={p_top} bot={p_bot} w={p_w})")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for spec in sys.argv[1:]:
        try:
            form, src, name = spec.split(":")
        except ValueError:
            sys.exit(f"bad spec {spec!r} — expected form:src.png:name")
        if form not in FORM:
            sys.exit(f"unknown form {form!r} — {sorted(FORM)}")
        register(form, os.path.expanduser(src), name)
    print("all variants registered + drift-clean")


if __name__ == "__main__":
    main()

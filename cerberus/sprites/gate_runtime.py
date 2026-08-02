#!/usr/bin/env python3
"""Gate QA measured FROM THE RUNTIME ATLAS ARTIFACT (what the consumer reads):
runtime/atlas.json + <form>_atlas.png. Same sweep Seraphim runs."""
from PIL import Image
import numpy as np, json, os

RUN = os.path.expanduser("~/openagi/cerberus/sprites/runtime")
m = json.load(open(os.path.join(RUN, "atlas.json")))
CELL = m["cell"]

def cell_img(atlas, fd, name):
    slot = fd["frames"][name]
    sx = (slot % fd["cols"]) * CELL
    sy = (slot // fd["cols"]) * CELL
    return np.array(atlas.crop((sx, sy, sx + CELL, sy + CELL)).convert("RGBA"))

def stats(a):
    op = a[:, :, 3] > 0
    ys, xs = np.where(op)
    return dict(top=int(ys.min()), bottom=int(ys.max()),
                width=int(xs.max() - xs.min() + 1),
                mean=[float(a[:, :, k][op].mean()) for k in range(3)])

LIMITS = {"idle": 10, "alert": 25, "working": 25, "attack": 25,
          "victory": 25, "sleep": 10, "walk": 25}

allok = True
for form in ["omega", "alpha"]:
    fd = m["forms"][form]
    atlas = Image.open(os.path.join(RUN, f"{form}_atlas.png"))
    print(f"== {form} (sha {fd['sha']}) ==")
    for st, spec in fd["states"].items():
        imgs = [cell_img(atlas, fd, n) for n in spec["seq"]]
        ss = [stats(a) for a in imgs]
        chgs, widths = [], []
        means = np.array([s["mean"] for s in ss])
        for i in range(len(imgs)):
            a, b = imgs[i], imgs[(i + 1) % len(imgs)]
            union = (a[:, :, 3] > 0) | (b[:, :, 3] > 0)
            diff = (a[:, :, :3] != b[:, :, :3]).any(axis=2) | (a[:, :, 3] != b[:, :, 3])
            chgs.append(100.0 * diff[union].sum() / max(1, union.sum()))
            widths.append(ss[i]["width"])
        mswing = [means[:, k].max() - means[:, k].min() for k in range(3)]
        tops = {s["top"] for s in ss}; bottoms = {s["bottom"] for s in ss}
        lim = LIMITS.get(st, 10)
        ok = (max(chgs) <= lim and (max(widths) - min(widths)) <= 8
              and all(v <= 8 for v in mswing) and tops == {20} and bottoms == {123})
        allok &= ok
        print(f"  {st:8} n={len(spec['seq']):2} chg max={max(chgs):5.2f}% (gate {lim}) "
              f"w_spread={max(widths)-min(widths)} meanRGB={mswing[0]:.1f}/{mswing[1]:.1f}/{mswing[2]:.1f} "
              f"top={sorted(tops)} bot={sorted(bottoms)} -> {'PASS' if ok else 'FAIL'}")
print("RUNTIME ARTIFACT:", "ALL PASS" if allok else "FAIL")

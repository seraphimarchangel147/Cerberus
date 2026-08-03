#!/usr/bin/env python3
"""Gate QA measured FROM THE RUNTIME ATLAS ARTIFACT (what the consumer reads):
runtime/atlas.json + <form>_atlas.png. Same sweep Seraphim runs."""
from PIL import Image
import numpy as np, json, os, sys, hashlib

RUN = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/openagi/cerberus/sprites/runtime")
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
        hashes = [hashlib.md5(a.tobytes()).hexdigest() for a in imgs]
        uniq = len(set(hashes))
        n = len(spec["seq"])
        period = n
        for p in range(1, n + 1):
            if all(hashes[i] == hashes[(i + p) % n] for i in range(n)):
                period = p
                break
        for i in range(len(imgs)):
            a, b = imgs[i], imgs[(i + 1) % len(imgs)]
            union = (a[:, :, 3] > 0) | (b[:, :, 3] > 0)
            diff = (a[:, :, :3] != b[:, :, :3]).any(axis=2) | (a[:, :, 3] != b[:, :, 3])
            chgs.append(100.0 * diff[union].sum() / max(1, union.sum()))
            widths.append(ss[i]["width"])
        mswing = [means[:, k].max() - means[:, k].min() for k in range(3)]
        tops = {s["top"] for s in ss}; bottoms = {s["bottom"] for s in ss}
        lim = LIMITS.get(st, 10)
        # Lower bounds, not just upper: byte-identical frames pass any max-change
        # gate while animating nothing (phase aliasing: sin(2*pi*cycles*i/n) has
        # period n/gcd(cycles,n), so frames repeat invisibly). Require every
        # frame unique, true period == n, and at least 0.5% visible motion.
        ok = (max(chgs) <= lim and min(chgs) >= 0.5
              and uniq == n and period == n
              and (max(widths) - min(widths)) <= 8
              and all(v <= 8 for v in mswing) and tops == {20} and bottoms == {123})
        allok &= ok
        print(f"  {st:8} n={n:2} uniq={uniq:2} period={period:2} "
              f"chg {min(chgs):5.2f}-{max(chgs):5.2f}% (gate {lim}) "
              f"w_spread={max(widths)-min(widths)} meanRGB={mswing[0]:.1f}/{mswing[1]:.1f}/{mswing[2]:.1f} "
              f"top={sorted(tops)} bot={sorted(bottoms)} -> {'PASS' if ok else 'FAIL'}")
    # Extent claim, not just rate: rates can vary while every state animates the
    # SAME pixel set (glow-pool clamp -- alpha 191px pool, IoU 1.00 across four
    # states, all rates pinned at 3.5%). Compute each state's motion mask (pixels
    # that vary anywhere in the cycle) and fail on SAME-PIXEL-SET overlap.
    masks = {}
    for st, spec in fd["states"].items():
        stack = np.stack([cell_img(atlas, fd, nm).astype(np.int16) for nm in spec["seq"]])
        masks[st] = (stack.max(axis=0) != stack.min(axis=0)).any(axis=2)
    st_names = sorted(masks)
    worst = 0.0
    for i in range(len(st_names)):
        for j in range(i + 1, len(st_names)):
            a, b = masks[st_names[i]], masks[st_names[j]]
            iou = (a & b).sum() / max(1, (a | b).sum())
            worst = max(worst, iou)
    distinct = worst < 0.85
    allok &= distinct
    print(f"  distinctness: worst state-pair motion-mask IoU={worst:.2f} "
          f"(cap 0.85) -> {'PASS' if distinct else 'FAIL -- states share one pixel set'}")
print("RUNTIME ARTIFACT:", "ALL PASS" if allok else "FAIL")

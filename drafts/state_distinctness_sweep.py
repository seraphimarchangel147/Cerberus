#!/usr/bin/env python3
"""Inversion sweep: peer's gate asserts states DIFFER. Test whether they differ ENOUGH
to be perceived as different choreography, not merely non-byte-identical.

Checks the peer's gate cannot see:
  A. motion-mask IoU between states -- WHICH pixels animate. If alert and working
     animate the same pixel set, they are one choreography with different speeds,
     which is exactly what the peer claims to have fixed.
  B. amplitude ceiling clustering -- N states landing on the same max-change value
     to 2dp implies a clamp, not independent design.
  C. per-state animated-pixel fraction vs the claimed "% subset" in the commit msg.
  D. cross-form: is alpha a real derivation or a washed-out copy of omega's motion?
"""
import hashlib, json, os, sys, itertools
import numpy as np
from PIL import Image

run = sys.argv[1] if len(sys.argv) > 1 else "runtime"
man = json.load(open(os.path.join(run, "atlas.json")))
cell = man["cell"]

CLAIMED = {"idle": 9, "alert": 12, "working": 10, "attack": 12, "victory": 20, "sleep": 7}

def load(form):
    fd = man["forms"][form]
    atlas = Image.open(os.path.join(run, f"{form}_atlas.png"))
    def crop(name):
        s = fd["frames"][name]
        sx, sy = (s % fd["cols"]) * cell, (s // fd["cols"]) * cell
        return np.array(atlas.crop((sx, sy, sx+cell, sy+cell)).convert("RGBA"))
    return fd, crop

report = {}
for form in man["forms"]:
    fd, crop = load(form)
    print(f"\n===== {form} =====")
    masks, amps = {}, {}
    for state, spec in sorted(fd["states"].items()):
        imgs = [crop(n).astype(np.int16) for n in spec["seq"]]
        stack = np.stack(imgs)
        # a pixel "animates" if it differs anywhere across the cycle
        varies = (stack.max(axis=0) != stack.min(axis=0)).any(axis=2)
        opaque = (stack[..., 3] > 0).any(axis=0)
        masks[state] = varies
        frac = 100.0 * varies.sum() / max(1, opaque.sum())
        # peak per-pixel amplitude across cycle (RGB range)
        rng = (stack[..., :3].max(axis=0) - stack[..., :3].min(axis=0)).max(axis=2)
        amps[state] = float(rng[varies].mean()) if varies.any() else 0.0
        cl = CLAIMED.get(state)
        flag = ""
        if cl is not None and abs(frac - cl) > 4:
            flag = f"  <-- claimed ~{cl}% subset"
        print(f"  {state:8} animated_px={varies.sum():5} ({frac:5.1f}% of body) "
              f"mean_amp={amps[state]:5.1f}/255{flag}")
        report.setdefault(form, {})[state] = frac

    print(f"  -- motion-mask IoU between states (1.00 = identical pixels animate) --")
    worst = []
    for a, b in itertools.combinations(sorted(masks), 2):
        inter = (masks[a] & masks[b]).sum()
        union = (masks[a] | masks[b]).sum()
        iou = inter / max(1, union)
        # containment: is the smaller mask entirely inside the larger?
        cont = inter / max(1, min(masks[a].sum(), masks[b].sum()))
        if iou >= 0.60 or cont >= 0.95:
            worst.append((iou, cont, a, b))
    if worst:
        for iou, cont, a, b in sorted(worst, reverse=True):
            tag = "SAME PIXEL SET" if iou >= 0.85 else ("nested" if cont >= 0.95 else "high overlap")
            print(f"     {a:8} vs {b:8}  IoU={iou:.2f} containment={cont:.2f}  <-- {tag}")
    else:
        print("     all pairs IoU < 0.60 -- genuinely different pixel sets")

# cross-form comparison
if len(man["forms"]) == 2:
    f1, f2 = sorted(man["forms"])
    print(f"\n===== cross-form: {f1} vs {f2} animated fraction =====")
    for st in sorted(report[f1]):
        a, b = report[f1][st], report[f2][st]
        ratio = a / max(1e-9, b)
        print(f"  {st:8} {f1}={a:5.1f}%  {f2}={b:5.1f}%  ratio={ratio:.2f}")

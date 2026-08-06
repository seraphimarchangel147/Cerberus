#!/usr/bin/env python3
"""Gate QA measured FROM THE RUNTIME ATLAS ARTIFACT (what the consumer reads):
runtime/atlas.json + <form>_atlas.png. Same sweep Seraphim runs.

v5 — the gate is rebuilt around ALPHA-channel metrics. v4 gated RGB change
under a frozen silhouette (tops=={20}, bottoms=={123} exact) and thereby
REQUIRED a statue: 12 of 14 rows moved 0 silhouette px and only recolored
glow interiors. Creator saw it on the live dashboard the moment he looked.

v5 bodies MOVE (breath/bob/sway/lunge), and any geometry transform
contaminates per-frame RGB diffs on textured art — a 2px bob shifts texture
through the column wave and reads as 99% "change". Alpha is invariant to
recolor and precise about motion, so:

  MOTION        silhouette delta between consecutive frames — per-state FLOOR
                (a frozen body scores 0 and fails) and CAP (bodies must not
                thrash). This is the check v4 never made.
  DRIFT         top/bottom bounding ranges + planted feet for idle/sleep —
                frames may breathe and bob within bounds, never wander.
  COMPLETENESS  every frame byte-unique, true period == seq length (v4
                anti-aliasing checks, motion-safe by construction).
  DISTINCTNESS  geometry signature (top/bot/cx/cy swings per state) must not
                collide, and alpha-constant shimmer zones must not overlap
                more than 0.85 IoU — states must perform DIFFERENT motion on
                DIFFERENT glow regions.
"""
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

# ── Silhouette motion: floor (body MUST move) and cap (it must not thrash) ──
# Presence-XOR symmetric difference of consecutive frames, measured on the v5
# artifact (max over the cycle, both forms): idle ~200-240, sleep ~170-200,
# victory/working ~690-950, walk ~660-770, alert ~1030-1170, attack
# ~2200-2300. Floors sit under the observed minimums and above 0 — a
# recolor-only row scores exactly 0 and fails every floor. Caps sit over the
# observed maximums — a runaway thrash fails them. Presence-XOR, not raw
# alpha-value diff: NEAREST rescales churn soft-edge alpha VALUES far beyond
# the pixels whose presence actually changed, and presence is what the eye
# reads as shape motion.
SIL_FLOOR = {"idle": 150, "alert": 800, "working": 500, "attack": 1800,
             "victory": 500, "sleep": 100, "walk": 400}
SIL_CAP = {"idle": 1000, "alert": 2200, "working": 2000, "attack": 4000,
           "victory": 2000, "sleep": 800, "walk": 1800}
TOP_RANGE = (17, 23)      # frames may breathe/bob within these canvas rows
BOTTOM_RANGE = (120, 123)
PLANTED = ("idle", "sleep")   # feet never leave the baseline in these states

# Shimmer lower bound on alpha-constant pixels: interior glow must recolor on
# top of the geometry motion (no upper bound — with moving bodies, RGB diffs
# are contaminated by the motion itself and are not a clean shimmer signal).
SHIMMER_FLOOR = 0.5
ZONE_IOU_CAP = 0.85

allok = True
for form in ["omega", "alpha"]:
    fd = m["forms"][form]
    atlas = Image.open(os.path.join(RUN, f"{form}_atlas.png"))
    print(f"== {form} (sha {fd['sha']}) ==")
    sigs = {}
    zones = {}
    for st, spec in fd["states"].items():
        imgs = [cell_img(atlas, fd, n) for n in spec["seq"]]
        n = len(spec["seq"])
        hashes = [hashlib.md5(a.tobytes()).hexdigest() for a in imgs]
        uniq = len(set(hashes))
        period = n
        for p in range(1, n + 1):
            if all(hashes[i] == hashes[(i + p) % n] for i in range(n)):
                period = p
                break
        # Alpha-channel geometry per frame
        tops, bots, cxs, cys, widths = [], [], [], [], []
        for a in imgs:
            op = a[:, :, 3] > 0
            ys, xs = np.where(op)
            tops.append(int(ys.min())); bots.append(int(ys.max()))
            cxs.append(float(xs.mean())); cys.append(float(ys.mean()))
            widths.append(int(xs.max() - xs.min() + 1))
        # Silhouette delta between consecutive frames — THE motion metric
        sils = []
        for i in range(n):
            a, b = imgs[i], imgs[(i + 1) % n]
            sils.append(int(((a[:, :, 3] > 0) ^ (b[:, :, 3] > 0)).sum()))
        # Shimmer on alpha-constant pixels (excludes pixels that flip in/out
        # of the silhouette — those are motion, not recolor)
        shims = []
        for i in range(n):
            a, b = imgs[i], imgs[(i + 1) % n]
            adiff = a[:, :, 3] != b[:, :, 3]
            rgbdiff = (a[:, :, :3] != b[:, :, :3]).any(axis=2)
            const = ~adiff
            denom = int(np.logical_or(a[:, :, 3] > 0, b[:, :, 3] > 0)[const].sum())
            shims.append(100.0 * int(np.logical_and(rgbdiff, const).sum()) / max(1, denom))
        sfloor, scap = SIL_FLOOR.get(st, 500), SIL_CAP.get(st, 2500)
        ok = (uniq == n and period == n
              and min(shims) >= SHIMMER_FLOOR
              and max(sils) >= sfloor and max(sils) <= scap
              and all(TOP_RANGE[0] <= t <= TOP_RANGE[1] for t in tops)
              and all(BOTTOM_RANGE[0] <= b <= BOTTOM_RANGE[1] for b in bots)
              and (st not in PLANTED or set(bots) == {123})
              and (max(widths) - min(widths)) <= 8)
        allok &= ok
        sigs[st] = (max(tops) - min(tops), max(bots) - min(bots),
                    round(max(cxs) - min(cxs)), round(max(cys) - min(cys)),
                    round(float(np.mean(cys))))
        stack = np.stack(imgs)
        rgb_var = (stack[:, :, :, :3].max(0) != stack[:, :, :, :3].min(0)).any(2)
        alpha_const = (stack[:, :, :, 3].max(0) == stack[:, :, :, 3].min(0))
        zones[st] = np.logical_and(rgb_var, alpha_const)
        print(f"  {st:8} n={n:2} uniq={uniq:2} period={period:2} "
              f"sil {min(sils):4d}-{max(sils):4d}px (floor {sfloor} cap {scap}) "
              f"shim {min(shims):5.2f}-{max(shims):5.2f}% "
              f"top={sorted(set(tops))} bot={sorted(set(bots))} -> {'PASS' if ok else 'FAIL'}")
    # Distinctness 1: no two states may perform the same geometry. Signature =
    # (topSwing, botSwing, cxSwing, cySwing, cyMean) — measured on alpha only,
    # so it survives recolor and reads exactly which motion each state does.
    st_names = sorted(sigs)
    dup = [(a, b) for i, a in enumerate(st_names) for b in st_names[i + 1:]
           if sigs[a] == sigs[b]]
    distinct_geom = not dup
    allok &= distinct_geom
    print(f"  geometry signatures: "
          + ", ".join(f"{s}={sigs[s]}" for s in st_names))
    print(f"  signature collisions: {dup if dup else 'none'} -> "
          f"{'PASS' if distinct_geom else 'FAIL -- two states perform identical motion'}")
    # Distinctness 2: shimmer zones (pixels whose RGB varies while alpha stays
    # constant across the cycle) must not collapse onto one pixel set — the
    # v3 glow-pool clamp failure class. Motion-mask IoU is not usable once
    # bodies translate (the union degenerates to the whole body); restricting
    # to alpha-constant pixels keeps the mask tracking the glow zone.
    worst = 0.0
    wp = None
    for i in range(len(st_names)):
        for j in range(i + 1, len(st_names)):
            a, b = zones[st_names[i]], zones[st_names[j]]
            iou = np.logical_and(a, b).sum() / max(1, np.logical_or(a, b).sum())
            if iou > worst:
                worst, wp = iou, (st_names[i], st_names[j])
    distinct = worst < ZONE_IOU_CAP
    allok &= distinct
    print(f"  distinctness: worst shimmer-zone IoU={worst:.2f} {wp} "
          f"(cap {ZONE_IOU_CAP}) -> {'PASS' if distinct else 'FAIL -- states share one pixel set'}")
print("RUNTIME ARTIFACT:", "ALL PASS" if allok else "FAIL")
# Exit non-zero on failure so CI/automation can actually enforce this gate.
sys.exit(0 if allok else 1)

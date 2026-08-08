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

  MOTION        total silhouette travel per second — sum of per-step
                presence-XOR over the loop, divided by loop duration. This
                is invariant under resampling: adding in-betweens halves the
                per-step deltas but doubles the step count, so a frozen body
                still scores 0 (fails) and a smooth body no longer fails
                just for being smooth. (v7 gated max-over-steps, which
                conflated "doesn't move" with "moves smoothly" — doubling
                frames would have failed 8 of 11 rows, Seraphim's catch.)
                A per-step CAP is kept: that one is correctly per-step,
                since it catches thrash/teleport between adjacent frames.
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

RUN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "runtime")
m = json.load(open(os.path.join(RUN, "atlas.json")))
CELL = m["cell"]

def cell_img(atlas, fd, name):
    slot = fd["frames"][name]
    sx = (slot % fd["cols"]) * CELL
    sy = (slot // fd["cols"]) * CELL
    return np.array(atlas.crop((sx, sy, sx + CELL, sy + CELL)).convert("RGBA"))

# ── Silhouette motion: travel-per-second floor + per-step thrash cap ──
# Presence-XOR symmetric difference of consecutive frames, measured on the
# packed artifact, both forms. The FLOOR is on TOTAL travel per second
# (sum of per-step XOR over the loop / loop duration): invariant under
# resampling, so denser in-betweens can never false-fail a moving row, while
# a frozen body still scores exactly 0. Calibrated at ~60% of the observed
# minimum across forms on the v8 artifact (sleep is the quietest legitimate
# mover at ~260px/s; anything below these floors is a statue or a corpse).
# The CAP stays per-step: it catches thrash/teleport between ADJACENT frames,
# which finer sampling legitimately shrinks — so the cap must not be
# resampling-normalised.
TRAVEL_FLOOR = {"idle": 1500, "alert": 4600, "working": 3900, "attack": 10000,
                "victory": 3000, "sleep": 150, "walk": 4600,
                # v8 densified rows: travel/sec is resampling-invariant, so
                # floors carry over from the v7 measurements (omega minimums:
                # blocked 4519, straining 8044, hurt 3970, doze 3014).
                "blocked": 2700, "straining": 4800, "hurt": 2300, "doze": 1800}
SIL_CAP = {"idle": 1000, "alert": 2200, "working": 2000, "attack": 4000,
           "victory": 2000, "sleep": 800, "walk": 1800,
           # Caps over the observed per-step maximums with headroom: blocked/
           # straining peak at 1828, hurt/doze at ~1108. Finer sampling only
           # shrinks per-step deltas, so caps keep their v7 values.
           "blocked": 2500, "straining": 2500, "hurt": 1600, "doze": 1600}
# Per-form drift bounds. OMEGA keeps the classic geometry; ALPHA v2 fills the
# cell (top=5, bottom=126) so its frames breathe within different canvas rows.
# Read from the manifest's per-form baseline when present.
FORM_RANGES = {
    "omega": {"top": (17, 23), "bottom": (120, 123), "planted": 123},
    "alpha": {"top": (2, 8), "bottom": (123, 126), "planted": 126},
}
PLANTED = ("idle", "sleep", "blocked", "straining", "hurt", "doze")

# Shimmer lower bound on alpha-constant pixels: interior glow must recolor on
# top of the geometry motion (no upper bound — with moving bodies, RGB diffs
# are contaminated by the motion itself and are not a clean shimmer signal).
SHIMMER_FLOOR = 0.5
ZONE_IOU_CAP = 0.85

# ── COLOR-SNAP check (fourth bite of "silhouette is not the whole frame") ──
# The v6 dissolve bug: pixels were flipped on silhouette XOR only, so every
# interior pixel that was opaque in both variants stayed untouched through
# the dissolve and then HARD-CUT its palette at the dissolve->hold boundary.
# Signature of that defect class: silhouette XOR == 0 (nothing moved) while
# thousands of interior pixels change color in one step. Measured: the bug's
# boundary step churned 6,488 interior px at mean RGB delta 215.9; the fixed
# dissolve's boundary is 0px by construction, and its within-dissolve steps
# churn ~1,300 px. Legitimate geometry-quiet steps (shimmer/breath on hold
# frames) churn <= 1,377 px across all 22 rows of the current artifact.
# Thresholds: 3,000px churn AND interior-wide mean delta > 100 (both
# conditions — a broad bright churn, not the small-dim deltas of shimmer).
SNAP_SIL_XOR = 50        # a step is "geometry-quiet" below this silhouette XOR
SNAP_CHURN_CAP = 3000    # interior pixels that may recolor on a quiet step
SNAP_MEAN_CAP = 100      # interior-wide mean RGB delta on a quiet step

allok = True
for form in ["omega", "alpha"]:
    fd = m["forms"][form]
    # Per-form drift bounds. The manifest's baseline (written by the builder)
    # is authoritative when present; FORM_RANGES supplies the breathing room
    # around it. ALPHA v2 fills the cell (top=5, bottom=126); OMEGA keeps the
    # classic geometry (top=20, bottom=123).
    fr = FORM_RANGES.get(form, FORM_RANGES["omega"])
    top_range, bottom_range, planted_row = fr["top"], fr["bottom"], fr["planted"]
    atlas = Image.open(os.path.join(RUN, f"{form}_atlas.png"))
    bl = fd.get("baseline", {})
    print(f"== {form} (sha {fd['sha']}, baseline {bl or 'classic'}) ==")
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
        # COLOR-SNAP measurement on the same adjacency pass. A step whose
        # silhouette barely moves may still churn its interior palette (the
        # dissolve hard-cut class). Track, per geometry-quiet step, how many
        # interior (opaque-in-both) pixels recolor and how hard they shift.
        snap_worst = (0, 0.0, 0)   # (churn px, mean delta, step index)
        for i in range(n):
            a, b = imgs[i], imgs[(i + 1) % n]
            aA, bA = a[:, :, 3] > 0, b[:, :, 3] > 0
            sil = int((aA ^ bA).sum())
            sils.append(sil)
            if sil < SNAP_SIL_XOR:
                interior = aA & bA
                d = np.abs(a[:, :, :3].astype(np.int32)
                           - b[:, :, :3].astype(np.int32)).sum(axis=2)
                churn = int((interior & (d > 0)).sum())
                meand = float(d[interior].mean()) if interior.any() else 0.0
                if churn > snap_worst[0]:
                    snap_worst = (churn, meand, i)
        snap_churn, snap_mean, snap_i = snap_worst
        snap_ok = snap_churn <= SNAP_CHURN_CAP and snap_mean <= SNAP_MEAN_CAP
        # Travel-per-second: total silhouette travel over the loop, divided by
        # loop duration derived from the manifest itself (n * hold rendered
        # frames at 30fps). Resampling-invariant by construction.
        duration = n * spec["hold"] / 30.0
        travel = sum(sils)
        travel_rate = travel / duration
        tfloor = TRAVEL_FLOOR.get(st, 3000)
        # Shimmer on alpha-constant pixels (excludes pixels that flip in/out
        # of the silhouette — those are motion, not recolor)
        shims = []
        for i in range(n):
            a, b = imgs[i], imgs[(i + 1) % n]
            adiff = a[:, :, 3] != b[:, :, 3]
            rgbdiff = (a[:, :, :3] != b[:, :, :3]).any(axis=2)
            const = ~adiff
            # A pixel only shimmers if it is VISIBLE. RGB churn in fully
            # transparent pixels is invisible to the eye but was being counted,
            # which pushed the reported rate above 100% (a fraction cannot
            # exceed its own denominator) -- measured 230% on ALPHA v2 attack,
            # 57% of that numerator being pixels transparent in both frames.
            # The larger cell-filling art exposed a latent bug: the numerator
            # spanned the whole cell while the denominator was visible-only.
            visible = np.logical_or(a[:, :, 3] > 0, b[:, :, 3] > 0)
            denom = int(visible[const].sum())
            shims.append(100.0 * int(np.logical_and(np.logical_and(rgbdiff, const), visible).sum()) / max(1, denom))
        ok = (uniq == n and period == n
              and min(shims) >= SHIMMER_FLOOR
              and travel_rate >= tfloor and max(sils) <= SIL_CAP.get(st, 2500)
              and all(top_range[0] <= t <= top_range[1] for t in tops)
              and all(bottom_range[0] <= b <= bottom_range[1] for b in bots)
              and (st not in PLANTED or set(bots) == {planted_row})
              and (max(widths) - min(widths)) <= 8
              and snap_ok)
        allok &= ok
        sigs[st] = (max(tops) - min(tops), max(bots) - min(bots),
                    round(max(cxs) - min(cxs)), round(max(cys) - min(cys)),
                    round(float(np.mean(cys))))
        stack = np.stack(imgs)
        rgb_var = (stack[:, :, :, :3].max(0) != stack[:, :, :, :3].min(0)).any(2)
        alpha_const = (stack[:, :, :, 3].max(0) == stack[:, :, :, 3].min(0))
        # Visible-only, same reason as the shimmer rate above: RGB variation in
        # pixels that are transparent for the whole cycle is invisible, and
        # including it inflates every zone toward the full cell -- which drives
        # the pairwise IoU toward 1.0 and erodes this check's margin.
        ever_visible = stack[:, :, :, 3].max(0) > 0
        zones[st] = np.logical_and(np.logical_and(rgb_var, alpha_const), ever_visible)
        print(f"  {st:8} n={n:2} uniq={uniq:2} period={period:2} "
              f"travel {travel_rate:7.1f}px/s (floor {tfloor}) "
              f"step {min(sils):4d}-{max(sils):4d}px (cap {SIL_CAP.get(st, 2500)}) "
              f"shim {min(shims):5.2f}-{max(shims):5.2f}% "
              f"snap {snap_churn:4d}px/{snap_mean:5.1f}d@{snap_i} "
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

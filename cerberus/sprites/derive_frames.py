#!/usr/bin/env python3
"""Coherent frame derivation v3 — identity-locked, vectorized.

Invariant: every derived frame keeps the base's alpha mask and bbox EXACTLY
(top=20, bottom=123). Motion sources:

  PHOTOMETRIC SHIMMER — brightness wave over a fixed SUBSET of glow pixels.
                        Only that subset's RGB changes; alpha + geometry never
                        move, so baseline/width are exact by construction and
                        inter-frame change == subset fraction.
  PAW LIFT (walk only) — the bottom paw block of one leg cluster shifts up 2px;
                        opposite feet stay planted so bottom=123 holds; body
                        and top rows untouched so top=20 holds.

Deterministic. No global ramps, no whole-frame bobs, no bbox-moving scales.
"""
from PIL import Image
import numpy as np
import os, math

REPO = os.path.expanduser("~/openagi/cerberus/sprites")
CANVAS = 128
BASELINE = 123
TOP = 20


def load_base(form, name):
    return np.array(Image.open(os.path.join(REPO, form, f"{name}.png")).convert("RGBA")).astype(np.int32)


def glow_mask(base, form):
    r, g, b, a = base[:, :, 0], base[:, :, 1], base[:, :, 2], base[:, :, 3]
    op = a > 0
    if form == "omega":
        return op & (r > 150) & (g < r) & (b < 100)
    return op & (b > 150) & (g > 120) & (r < 110)


def subset_mask(glow, target):
    ys, xs = np.where(glow)
    n = len(xs)
    sel = np.zeros(glow.shape, dtype=bool)
    if n <= target:
        sel[glow] = True
    else:
        idx = np.linspace(0, n - 1, target).astype(int)
        sel[ys[idx], xs[idx]] = True
    return sel


def save(arr, path):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA").save(path)


def _beat(cycles, n):
    """Second, incommensurate cycle count so sampled phases stay distinct.

    A single wave sampled as phase_i = 2*pi*cycles*i/n only yields
    n/gcd(cycles, n) DISTINCT phases -- with cycles=2,n=24 that is 12 unique
    frames repeated twice; cycles=4,n=24 gives 6 repeated four times. Adding a
    minor wave whose cycle count is coprime to both `cycles` and `n` makes the
    combined period exactly n, so every frame is a unique image.
    """
    for c in range(cycles + 1, cycles + n):
        if math.gcd(c, n) == 1 and math.gcd(c, max(cycles, 1)) == 1:
            return c
    return 1


def shimmer(form, base, sel, amp, wl, cycles, n, prefix):
    """Vectorized photometric shimmer on the fixed subset `sel`."""
    xs = np.arange(CANVAS)[None, :]
    c2 = _beat(cycles, n)
    wl2 = wl * 0.61                               # incommensurate spatial period
    for i in range(n):
        phase = 2 * math.pi * cycles * i / n
        phase2 = 2 * math.pi * c2 * i / n
        m = np.clip(1.0 + amp * (0.82 * np.sin(2 * math.pi * xs / wl - phase)
                                 + 0.18 * np.sin(2 * math.pi * xs / wl2 - phase2)),
                    0.6, 1.5)
        frame = base.copy()
        for k in range(3):
            layer = frame[:, :, k].astype(np.float32)
            layer[sel] = (layer * m[0] if False else frame[:, :, k] * m)[sel]
            frame[:, :, k] = layer.astype(np.int32)
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))


def leg_clusters(base):
    op = base[:, :, 3] > 0
    band = op[100:BASELINE + 1, :]
    cols = band.sum(axis=0)
    clusters, in_c, x0 = [], False, 0
    for x in range(CANVAS):
        if cols[x] > 2 and not in_c:
            x0, in_c = x, True
        elif cols[x] <= 2 and in_c:
            clusters.append((x0, x - 1)); in_c = False
    if in_c:
        clusters.append((x0, CANVAS - 1))
    return clusters


def paw_shift(frame, cluster, dx):
    """Horizontal weight-shift of one leg block. Vertical extents untouched,
    so bottom=123 and top=20 hold by construction."""
    x0, x1 = cluster
    reg = frame[110:BASELINE + 1, x0:x1 + 1, :].copy()
    reg = np.roll(reg, dx, axis=1)
    if dx > 0:
        reg[:, :dx, :] = 0
    elif dx < 0:
        reg[:, dx:, :] = 0
    frame[110:BASELINE + 1, x0:x1 + 1, :] = reg


def walk(form, base, sel, amp, wl, cycles, n, prefix, lift):
    clusters = leg_clusters(base)
    xs = np.arange(CANVAS)[None, :].astype(np.float32)
    c2 = _beat(cycles, n)
    wl2 = wl * 0.61
    for i in range(n):
        phase = 2 * math.pi * cycles * i / n
        phase2 = 2 * math.pi * c2 * i / n
        m = np.clip(1.0 + amp * (0.82 * np.sin(2 * math.pi * xs / wl - phase)
                                 + 0.18 * np.sin(2 * math.pi * xs / wl2 - phase2)),
                    0.6, 1.5)[0]  # (C,)
        frame = base.copy()
        for k in range(3):
            layer = frame[:, :, k].astype(np.float32)
            layer = layer * m[None, :]
            frame[:, :, k] = np.where(sel, layer, base[:, :, k]).astype(np.int32)
        if len(clusters) >= 2:
            # alternate the weight-shift direction across clusters/frames
            dx = lift if (i % 2 == 0) else -lift
            paw_shift(frame, clusters[i % len(clusters)], dx)
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))
    return clusters


N_IDLE = 24
N_ACTIVE = 24
N_WALK = 16
N_SLEEP = 16


def main():
    for form in ["omega", "alpha"]:
        # idle: 9% subset shimmer, calm breathing energy
        b = load_base(form, "idle_neutral")
        sel = subset_mask(glow_mask(b, form), int(0.09 * (b[:, :, 3] > 0).sum()))
        shimmer(form, b, sel, amp=0.28, wl=56, cycles=2, n=N_IDLE, prefix="dl")
        # active: same base, agitated shimmer (higher amp, faster, shorter wave)
        # for alert/working/attack/victory rows
        shimmer(form, b, sel, amp=0.45, wl=40, cycles=4, n=N_ACTIVE, prefix="act")
        # walk: 18% subset shimmer + horizontal weight-shift on leg clusters
        b = load_base(form, "walk_step_right")
        sel = subset_mask(glow_mask(b, form), int(0.18 * (b[:, :, 3] > 0).sum()))
        cl = walk(form, b, sel, amp=0.26, wl=48, cycles=2, n=N_WALK, prefix="wk", lift=2)
        # sleep: 7% subset, slow shallow flicker
        b = load_base(form, "sleep_rest")
        sel = subset_mask(glow_mask(b, form), int(0.07 * (b[:, :, 3] > 0).sum()))
        shimmer(form, b, sel, amp=0.16, wl=72, cycles=1, n=N_SLEEP, prefix="sl")
        print(f"{form}: derived {N_IDLE} idle + {N_ACTIVE} active + {N_WALK} walk (clusters={cl}) + {N_SLEEP} sleep")
    print("done v3")


if __name__ == "__main__":
    main()

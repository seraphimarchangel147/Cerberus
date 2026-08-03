#!/usr/bin/env python3
"""Coherent frame derivation v4 — identity-locked, distinct choreography.

Invariant: every derived frame keeps the base's alpha mask and bbox EXACTLY
(top=20, bottom=123). Motion sources:

  PHOTOMETRIC SHIMMER — brightness wave over a fixed SUBSET of glow pixels.
                        Only that subset's RGB changes; alpha + geometry never
                        move, so baseline/width are exact by construction and
                        inter-frame change ~= subset fraction.
  WEIGHT-SHIFT (walk/attack) — a leg block slides horizontally <=2px; vertical
                        extents untouched so bottom=123 holds by construction.

Distinct choreography: each state gets its own subset region (seeded), wave
amplitude, spatial wavelength, and cycle count — so idle/alert/working/attack/
victory read as different energies on the same identity-locked body instead of
one shared shimmer at different speeds.

Beat wave: every cycle pairs the main wave with an incommensurate minor wave
(coprime cycle count) so the combined period is exactly n — every frame is a
unique image, no phase-aliasing duplicates.

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


MAX_SUBSET = 0.20  # largest per-state subset requested below (victory)


def glow_mask(base, form, min_frac=MAX_SUBSET * 1.15):
    """Glow pool for shimmer. MUST stay larger than the biggest per-state subset,
    otherwise every state clamps to the same pixels and all choreography collapses
    into one animation (alpha regression, 2026-08-02).

    The strict hue rule is kept as the preferred core; if it yields too small a
    pool for this form's palette, the pool is grown by cool/warm-cast ranking so
    each state still gets a distinct region. Geometry is never touched.
    """
    r, g, b, a = (base[:, :, i].astype(np.int32) for i in range(4))
    op = a > 0
    if form == "omega":
        core = op & (r > 150) & (g < r) & (b < 100)
        score = r - (g + b) // 2          # warm-cast ranking
    else:
        core = op & (b > 150) & (g > 120) & (r < 110)
        score = (b + g) // 2 - r          # cool-cast ranking

    need = int(min_frac * op.sum())
    if core.sum() >= need:
        return core

    # grow: keep the core, then add the highest-scoring remaining body pixels
    pool = core.copy()
    cand = op & ~core
    ys, xs = np.where(cand)
    if len(ys):
        order = np.argsort(-score[ys, xs], kind="stable")
        take = order[: max(0, need - int(core.sum()))]
        pool[ys[take], xs[take]] = True
    return pool


def subset_mask(glow, target, seed=0):
    """Deterministic subset of `target` glow pixels. `seed` rotates the
    sampling order so different states shimmer on different physical glow
    regions (visibly distinct shimmer zones, still identity-locked)."""
    ys, xs = np.where(glow)
    n = len(xs)
    sel = np.zeros(glow.shape, dtype=bool)
    if n <= target:
        # Clamping means this state gets the WHOLE pool -- and so does every other
        # state that clamps, making their choreography byte-identical in extent.
        raise ValueError(
            f"glow pool exhausted: {n} px available, {target} requested (seed={seed}). "
            "Every clamping state would animate the identical pixel set. "
            "Widen glow_mask() for this form instead of clamping.")
    else:
        order = np.roll(np.arange(n), seed * 7919)
        idx = order[np.linspace(0, n - 1, target).astype(int)]
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
    xs = np.arange(CANVAS)[None, :].astype(np.float32)
    c2 = _beat(cycles, n)
    wl2 = wl * 0.61                               # incommensurate spatial period
    for i in range(n):
        phase = 2 * math.pi * cycles * i / n
        phase2 = 2 * math.pi * c2 * i / n
        m = np.clip(1.0 + amp * (0.82 * np.sin(2 * math.pi * xs / wl - phase)
                                 + 0.18 * np.sin(2 * math.pi * xs / wl2 - phase2)),
                    0.6, 1.5)[0]  # (C,)
        frame = base.copy()
        for k in range(3):
            layer = frame[:, :, k].astype(np.float32) * m[None, :]
            frame[:, :, k] = np.where(sel, layer, base[:, :, k]).astype(np.int32)
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


def gait(form, base, sel, amp, wl, cycles, n, prefix, dx, mode):
    """Shimmer + horizontal leg weight-shift.
    mode 'walk'  : clusters shift one at a time, alternating direction.
    mode 'attack': all clusters surge together, alternating direction per
                   frame — reads as coiled aggression, not locomotion."""
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
            layer = frame[:, :, k].astype(np.float32) * m[None, :]
            frame[:, :, k] = np.where(sel, layer, base[:, :, k]).astype(np.int32)
        if clusters:
            if mode == "walk":
                paw_shift(frame, clusters[i % len(clusters)],
                          dx if (i % 2 == 0) else -dx)
            else:  # attack surge: whole stance snaps side to side
                d = dx if (i % 2 == 0) else -dx
                for c in clusters:
                    paw_shift(frame, c, d)
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))
    return clusters


# ── Cycle sizes ──────────────────────────────────────────────────────────
N_IDLE = 32      # calm breathing — the state seen most, gets the most frames
N_ALERT = 24
N_WORKING = 24
N_ATTACK = 24
N_VICTORY = 24
N_WALK = 16
N_SLEEP = 16


def main():
    for form in ["omega", "alpha"]:
        b = load_base(form, "idle_neutral")
        glow = glow_mask(b, form)

        # idle: calm breathing shimmer, 9% subset, slow long wave
        sel = subset_mask(glow, int(0.09 * (b[:, :, 3] > 0).sum()), seed=0)
        shimmer(form, b, sel, amp=0.28, wl=56, cycles=2, n=N_IDLE, prefix="dl")

        # alert: watchful scan — tighter wave, faster, different glow zone
        sel = subset_mask(glow, int(0.12 * (b[:, :, 3] > 0).sum()), seed=1)
        shimmer(form, b, sel, amp=0.40, wl=34, cycles=5, n=N_ALERT, prefix="al")

        # working: rhythmic processing pulse — mid wave, high frequency
        sel = subset_mask(glow, int(0.10 * (b[:, :, 3] > 0).sum()), seed=2)
        shimmer(form, b, sel, amp=0.34, wl=46, cycles=7, n=N_WORKING, prefix="wo")

        # attack: aggressive surge — big amp, tight wave, whole-stance snaps
        sel = subset_mask(glow, int(0.12 * (b[:, :, 3] > 0).sum()), seed=3)
        cl = gait(form, b, sel, amp=0.50, wl=30, cycles=6, n=N_ATTACK,
                  prefix="at", dx=2, mode="attack")

        # victory: celebratory bloom — broad slow swell over a wide glow zone
        sel = subset_mask(glow, int(0.20 * (b[:, :, 3] > 0).sum()), seed=4)
        shimmer(form, b, sel, amp=0.38, wl=64, cycles=3, n=N_VICTORY, prefix="vc")

        # walk: stride shimmer + alternating weight-shift on leg clusters
        b = load_base(form, "walk_step_right")
        sel = subset_mask(glow_mask(b, form), int(0.18 * (b[:, :, 3] > 0).sum()), seed=5)
        clw = gait(form, b, sel, amp=0.26, wl=48, cycles=2, n=N_WALK,
                   prefix="wk", dx=2, mode="walk")

        # sleep: slow shallow flicker on a small subset
        b = load_base(form, "sleep_rest")
        sel = subset_mask(glow_mask(b, form), int(0.07 * (b[:, :, 3] > 0).sum()), seed=6)
        shimmer(form, b, sel, amp=0.16, wl=72, cycles=1, n=N_SLEEP, prefix="sl")

        total = N_IDLE + N_ALERT + N_WORKING + N_ATTACK + N_VICTORY + N_WALK + N_SLEEP
        print(f"{form}: derived {total} frames "
              f"(idle={N_IDLE} alert={N_ALERT} working={N_WORKING} attack={N_ATTACK} "
              f"victory={N_VICTORY} walk={N_WALK} sleep={N_SLEEP}; clusters walk={clw} attack={cl})")
    print("done v4")


if __name__ == "__main__":
    main()

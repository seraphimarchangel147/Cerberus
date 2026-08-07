#!/usr/bin/env python3
"""Coherent frame derivation v5 — bodies MOVE, identity holds.

v4 locked every frame to an exact bbox (top=20, bottom=123) to stop drift and
phase-aliasing duplicates. That invariant overshot: it FORBADE all silhouette
motion, so 12 of 14 state rows animated only interior recolor on a fixed body
— a statue with lights flickering inside it. The eye reads that as static.

v5 keeps everything v4 got right (unique frames, true period == n, distinct
per-state choreography, bounded drift) and adds REAL geometry motion:

  BREATH (idle/sleep)   — vertical rescale of the body anchored at the paw
                          baseline. The chest rises and falls; feet stay planted.
  BOB (working/victory/ — vertical translation of the whole body 0..amp rows
       walk)              off the baseline. The compositor's own QA found this
                          is the one locomotion cue the eye actually decodes.
  SWAY (alert)          — horizontal whole-body weight-shift, +/-amp px.
  LUNGE+SURGE (attack)  — stance snaps + horizontal lunge on the beat.
  WEIGHT-SHIFT (walk/   — horizontal leg-cluster slide, unchanged from v4.
       attack)
  PHOTOMETRIC SHIMMER   — brightness wave over a fixed glow subset, unchanged.
                          Now rides ON the moving body instead of substituting
                          for motion.

Geometry drive uses the same coprime beat-wave pair as the shimmer phases, so
the combined period stays exactly n — every frame unique, no aliasing.

Deterministic. Bounds are enforced by gate_runtime.py: silhouette delta per
row must clear a per-state FLOOR (a frozen body is 0 and fails), tops/bottoms
stay inside ranges, and a max-delta cap keeps frames on-baseline.
"""
from PIL import Image
import numpy as np
import os, math

REPO = os.path.expanduser("~/openagi/cerberus/sprites")
CANVAS = 128

# Per-form geometry. OMEGA keeps the classic registration; ALPHA v2 fills the
# cell (bigger + more detailed per Creator's overhaul) so its baseline differs.
FORM_GEOM = {
    "omega": {"baseline": 123},
    "alpha": {"baseline": 126},
}


def geom(form):
    return FORM_GEOM[form]["baseline"]


def load_base(form, name):
    return np.array(Image.open(os.path.join(REPO, form, f"{name}.png")).convert("RGBA")).astype(np.int32)


MAX_SUBSET = 0.20  # largest per-state subset requested below (victory)


def glow_mask(base, form, min_frac=MAX_SUBSET * 1.15):
    """Glow pool for shimmer. MUST stay larger than the biggest per-state subset,
    otherwise every state clamps to the same pixels and all choreography collapses
    into one animation (alpha regression, 2026-08-02).

    The strict hue rule is kept as the preferred core; if it yields too small a
    pool for this form's palette, the pool is grown by cool/warm-cast ranking so
    each state still gets a distinct region.
    """
    r, g, b, a = (base[:, :, i].astype(np.int32) for i in range(4))
    op = a > 0
    if form == "omega":
        core = op & (r > 150) & (g < r) & (b < 100)
        score = r - (g + b) // 2          # warm-cast ranking
    else:
        # ALPHA v2: blue flames + cyan glows + white-hot lightning are all
        # energy — all of it shimmers. (Lightning bolts read as static
        # decoration if excluded, and Creator asked for them overhauled.)
        blue_flame = op & (b > 140) & (b >= r + 10)
        white_hot = op & (r > 190) & (g > 190) & (b > 190)
        core = blue_flame | white_hot
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
    """Deterministic subset of `target` glow pixels.

    Sampling uses a golden-ratio stride over the pool: idx_k = (seed*offset +
    k*stride) mod n, stride = int(n * 0.618...). Low-discrepancy, so any two
    states' subsets overlap only in proportion to their sizes — unlike the old
    linspace+roll lattice, which phase-aligned nearby seeds and let attack and
    working share 89% of their shimmer zone (2026-08-05)."""
    ys, xs = np.where(glow)
    n = len(xs)
    sel = np.zeros(glow.shape, dtype=bool)
    if n <= target:
        raise ValueError(
            f"glow pool exhausted: {n} px available, {target} requested (seed={seed}). "
            "Every clamping state would animate the identical pixel set. "
            "Widen glow_mask() for this form instead of clamping.")
    stride = max(1, int(n * 0.6180339887))
    start = (seed * 7919) % n
    idx = np.unique([(start + k * stride) % n for k in range(target)])
    sel[ys[idx], xs[idx]] = True
    return sel


def save(arr, path):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA").save(path)


def _beat(cycles, n):
    """Second, incommensurate cycle count so sampled phases stay distinct.

    A single wave sampled as phase_i = 2*pi*cycles*i/n only yields
    n/gcd(cycles, n) DISTINCT phases. Adding a minor wave whose cycle count is
    coprime to both `cycles` and `n` makes the combined period exactly n, so
    every frame is a unique image.
    """
    for c in range(cycles + 1, cycles + n):
        if math.gcd(c, n) == 1 and math.gcd(c, max(cycles, 1)) == 1:
            return c
    return 1


def _wave(i, n, cycles, amp):
    """Beat-wave sample in [-amp, amp]: main cycle + incommensurate minor wave.
    Used for BOTH the shimmer phase and the geometry drive, so the motion
    inherits the exact-period property."""
    c2 = _beat(cycles, n)
    return amp * (0.8 * math.sin(2 * math.pi * cycles * i / n)
                  + 0.2 * math.sin(2 * math.pi * c2 * i / n))


def body_rows(frame):
    op = frame[:, :, 3] > 0
    ys = np.where(op.any(axis=1))[0]
    return int(ys.min()), int(ys.max())


def breath(form, frame, dy):
    """Vertical rescale anchored at the paw baseline: chest rises (dy>0) and
    falls (dy<0) while the feet stay planted at the form's baseline."""
    base_row = geom(form)
    top, bot = body_rows(frame)
    h = bot - top + 1
    new_h = h + dy
    if new_h < h // 2 or base_row - new_h + 1 < 0:
        return frame
    content = frame[top:bot + 1, :, :]
    img = Image.fromarray(np.clip(content, 0, 255).astype(np.uint8), "RGBA")
    scaled = np.array(img.resize((CANVAS, new_h), Image.NEAREST))
    out = np.zeros_like(frame)
    new_top = base_row - new_h + 1
    out[new_top:base_row + 1, :, :] = scaled
    return out


def bob(frame, dy):
    """Vertical translation: lift the whole body `dy` rows off the baseline
    (dy >= 0). The compositor's own QA: vertical bob is the one cue the eye
    decodes as locomotion on planted-foot sprites; shear does not read."""
    if dy <= 0:
        return frame
    top, bot = body_rows(frame)
    content = frame[top:bot + 1, :, :]
    out = np.zeros_like(frame)
    nt = max(0, top - dy)
    out[nt:nt + (bot - top + 1), :, :] = content
    return out


def sway(frame, dx):
    """Horizontal weight-shift of the whole body (dx may be negative). Feet
    slide with the body — reads as shifting while thinking, and it is
    structurally orthogonal to the vertical bob, so bob states and sway states
    stay distinct in motion signature, not just in shimmer zone."""
    if dx == 0:
        return frame
    top, bot = body_rows(frame)
    content = frame[top:bot + 1, :, :]
    shifted = np.roll(content, dx, axis=1)
    if dx > 0:
        shifted[:, :dx, :] = 0
    else:
        shifted[:, dx:, :] = 0
    out = np.zeros_like(frame)
    out[top:bot + 1, :, :] = shifted
    return out


def shimmer_frame(base, sel, amp, wl, i, n, cycles):
    """One photometric shimmer frame: brightness wave over the fixed subset."""
    xs = np.arange(CANVAS)[None, :].astype(np.float32)
    c2 = _beat(cycles, n)
    wl2 = wl * 0.61                               # incommensurate spatial period
    phase = 2 * math.pi * cycles * i / n
    phase2 = 2 * math.pi * c2 * i / n
    m = np.clip(1.0 + amp * (0.82 * np.sin(2 * math.pi * xs / wl - phase)
                             + 0.18 * np.sin(2 * math.pi * xs / wl2 - phase2)),
                0.6, 1.5)[0]  # (C,)
    frame = base.copy()
    for k in range(3):
        layer = frame[:, :, k].astype(np.float32) * m[None, :]
        frame[:, :, k] = np.where(sel, layer, base[:, :, k]).astype(np.int32)
    return frame


def derive(form, base, sel, amp, wl, cycles, n, prefix, kind, gamp):
    """Shimmer + per-frame geometry motion.
    kind 'breath': baseline-anchored vertical scale, amplitude gamp rows.
    kind 'bob'   : vertical lift 0..gamp rows.
    kind 'sway'  : horizontal whole-body weight-shift, +/-gamp px.
    kind 'none'  : geometry untouched (callers that bring their own, e.g. gait).
    """
    for i in range(n):
        frame = shimmer_frame(base, sel, amp, wl, i, n, cycles)
        if kind == "breath":
            frame = breath(form, frame, int(round(_wave(i, n, cycles, gamp))))
        elif kind == "bob":
            frame = bob(frame, int(round(abs(_wave(i, n, cycles, gamp)))))
        elif kind == "sway":
            frame = sway(frame, int(round(_wave(i, n, cycles, gamp))))
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))


def leg_clusters(form, base):
    base_row = geom(form)
    op = base[:, :, 3] > 0
    band = op[base_row - 23:base_row + 1, :]
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


def paw_shift(form, frame, cluster, dx):
    """Horizontal weight-shift of one leg block."""
    base_row = geom(form)
    x0, x1 = cluster
    reg = frame[base_row - 13:base_row + 1, x0:x1 + 1, :].copy()
    reg = np.roll(reg, dx, axis=1)
    if dx > 0:
        reg[:, :dx, :] = 0
    elif dx < 0:
        reg[:, dx:, :] = 0
    frame[base_row - 13:base_row + 1, x0:x1 + 1, :] = reg


def gait(form, base, sel, amp, wl, cycles, n, prefix, dx, mode, gamp, samp=0):
    """Shimmer + horizontal leg weight-shift + vertical bob + optional lunge.
    mode 'walk'  : clusters shift one at a time, alternating direction; body
                   bobs on the beat — the stride read.
    mode 'attack': all clusters surge together, alternating direction per
                   frame, plus a whole-body horizontal LUNGE (samp px) on the
                   beat — coiled aggression. The lunge also gives attack a
                   motion signature distinct from working's pure vertical bob.
    """
    clusters = leg_clusters(form, base)
    for i in range(n):
        frame = shimmer_frame(base, sel, amp, wl, i, n, cycles)
        if clusters:
            if mode == "walk":
                paw_shift(form, frame, clusters[i % len(clusters)],
                          dx if (i % 2 == 0) else -dx)
            else:  # attack surge: whole stance snaps side to side
                d = dx if (i % 2 == 0) else -dx
                for c in clusters:
                    paw_shift(form, frame, c, d)
        if gamp:
            frame = bob(frame, int(round(abs(_wave(i, n, cycles, gamp)))))
        if samp:
            frame = sway(frame, int(round(_wave(i, n, cycles, samp))))
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
        body = int((b[:, :, 3] > 0).sum())

        # idle: chest rises and falls — two calm breaths per 2.1s loop
        sel = subset_mask(glow, int(0.09 * body), seed=0)
        derive(form, b, sel, amp=0.28, wl=56, cycles=2, n=N_IDLE,
               prefix="dl", kind="breath", gamp=2)

        # alert: watchful scan — weight shifts side to side, tighter shimmer wave
        sel = subset_mask(glow, int(0.12 * body), seed=1)
        derive(form, b, sel, amp=0.40, wl=34, cycles=5, n=N_ALERT,
               prefix="al", kind="sway", gamp=2)

        # working: rhythmic processing pulse — bob on the beat
        sel = subset_mask(glow, int(0.10 * body), seed=2)
        derive(form, b, sel, amp=0.34, wl=46, cycles=7, n=N_WORKING,
               prefix="wo", kind="bob", gamp=2)

        # attack: aggressive surge — big amp, whole-stance snaps + lunge bob
        sel = subset_mask(glow, int(0.12 * body), seed=3)
        cl = gait(form, b, sel, amp=0.50, wl=30, cycles=6, n=N_ATTACK,
                  prefix="at", dx=2, mode="attack", gamp=2, samp=3)

        # victory: celebratory — broad swell + the biggest bob of any state
        sel = subset_mask(glow, int(0.20 * body), seed=4)
        derive(form, b, sel, amp=0.38, wl=64, cycles=3, n=N_VICTORY,
               prefix="vc", kind="bob", gamp=3)

        # walk: stride shimmer + alternating weight-shift + stride bob
        b = load_base(form, "walk_step_right")
        sel = subset_mask(glow_mask(b, form), int(0.18 * (b[:, :, 3] > 0).sum()), seed=5)
        clw = gait(form, b, sel, amp=0.26, wl=48, cycles=2, n=N_WALK,
                   prefix="wk", dx=2, mode="walk", gamp=2)

        # sleep: one slow shallow breath per loop on a small subset
        b = load_base(form, "sleep_rest")
        sel = subset_mask(glow_mask(b, form), int(0.07 * (b[:, :, 3] > 0).sum()), seed=6)
        derive(form, b, sel, amp=0.16, wl=72, cycles=1, n=N_SLEEP,
               prefix="sl", kind="breath", gamp=1)

        total = N_IDLE + N_ALERT + N_WORKING + N_ATTACK + N_VICTORY + N_WALK + N_SLEEP
        print(f"{form}: derived {total} frames "
              f"(idle={N_IDLE} alert={N_ALERT} working={N_WORKING} attack={N_ATTACK} "
              f"victory={N_VICTORY} walk={N_WALK} sleep={N_SLEEP}; clusters walk={clw} attack={cl})")
    print("done v5")


if __name__ == "__main__":
    main()

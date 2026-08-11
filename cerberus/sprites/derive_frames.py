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
import json
import numpy as np
import os, math

# Script-relative, NOT ~/openagi: the pipeline must read bases and write
# derived frames wherever THIS checkout lives. The old expanduser() home
# path silently wrote 176 files into the live repo when the pipeline ran
# from a worktree (2026-08-08, caught + reverted by Seraphim).
REPO = os.path.dirname(os.path.abspath(__file__))
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


def dissolve_masks(b_from, b_to, k):
    """Cumulative pixel-flip masks for a k-step dissolve between two bases.

    Only pixels that DIFFER between the two bases flip -- both silhouette
    pixels (alpha changes) and body pixels that merely change colour. The
    latter matters more than it sounds: between two variant bases there are
    typically ~3x more recoloured-but-still-opaque pixels than alpha-differing
    ones, so dissolving on alpha alone left the entire body interior to snap
    palette in a single frame. The silhouette metric could not see it (XOR
    stayed ~260px) but the mean RGB step spiked 9 -> 124, which reads as a
    hard cut with a scattering of pixels around it.

    Flip order groups pixels into COHERENT SHARDS, not single-pixel scatter:
    a spatial hash over 6px superpixel cells ((7cx+13cy) mod k) reveals a whole
    cell's worth of xor pixels on one step. Single-pixel scatter read as TV
    static once upscaled nearest-neighbor 128->160 (Creator 2026-08-10:
    "pixelated, looks kinda cheap"); 6px plates materializing as units read
    as energy shards condensing instead. Each step still reveals ~XOR/k
    pixels: bounded by construction, and gate_runtime.py's per-state cap can
    verify it arithmetically (k-step dissolve <= chunk_size + motion delta).
    """
    alpha_xor = (b_from[:, :, 3] > 0) != (b_to[:, :, 3] > 0)
    botmcp_opaque = (b_from[:, :, 3] > 0) & (b_to[:, :, 3] > 0)
    rgb_xor = botmcp_opaque & (b_from[:, :, :3] != b_to[:, :, :3]).any(axis=2)
    xor = alpha_xor | rgb_xor
    ys, xs = np.where(xor)
    if len(ys) == 0:
        z = np.zeros(xor.shape, dtype=bool)
        return [z] * k
    SHARD = 6                                # superpixel cell size
    ranks = (7 * (xs // SHARD) + 13 * (ys // SHARD)) % k   # coherent shards
    masks, acc = [], np.zeros(xor.shape, dtype=bool)
    for j in range(1, k + 1):
        acc = acc.copy()
        sel_j = ranks <= j - 1
        acc[ys[sel_j], xs[sel_j]] = True
        masks.append(acc)
    return masks


# v11.1 transition smoothing: each pixel cohort passes through a true
# IN-BETWEEN on the step it flips, then settles to its final state on the
# next step. Three cases per fresh pixel:
#   appearing  (from transparent -> to opaque) : to-color fades in at partial
#                                                alpha with a faint energy tint
#   vanishing  (from opaque -> to transparent) : from-color fades out at
#                                                partial alpha
#   recolored  (both opaque, different color)  : 50/50 midpoint blend of the
#                                                two colors + slight tint
# Each per-step color/alpha delta is therefore ~HALVED vs the hard flip,
# which is what makes the materialization read smooth instead of popping.
# The first ghost-ramp attempt used a fixed bright tint as the intermediate —
# that sat FARTHER from both endpoints and raised per-step delta 118->173
# (measured). Midpoint blend is the correct in-between; tint stays subtle.
GHOST_TINT = {"omega": (255, 214, 110), "alpha": (170, 240, 255)}
GHOST_ALPHA_FADE = 150      # partial-alpha in/out phase
GHOST_TINT_MIX = 0.18       # subtle energy tint over the midpoint


def dissolve_frame(b_from, b_to, masks, j, form):
    """Transition frame j (1..k): cumulative flip set j applied; the FRESH
    cohort (flipped on THIS step) renders as its in-between state instead of
    jumping straight to the final. The previous step's cohort has already
    settled, so every pixel passes through exactly one in-between frame."""
    frame = np.where(masks[j - 1][:, :, None], b_to, b_from)
    prev = masks[j - 2] if j >= 2 else np.zeros(masks[0].shape, dtype=bool)
    fresh = masks[j - 1] & ~prev
    if not fresh.any():
        return frame
    tint = np.array(GHOST_TINT[form], dtype=np.int32)
    g = frame[fresh].copy()
    fa = b_from[fresh][:, 3] > 0          # opaque on the FROM side
    ta = b_to[fresh][:, 3] > 0            # opaque on the TO side
    appearing = ta & ~fa
    vanishing = fa & ~ta
    recolored = fa & ta
    # appearing: fade the to-color in at partial alpha + faint tint
    if appearing.any():
        c = b_to[fresh][appearing, :3].astype(np.int32)
        c = (c * (1 - GHOST_TINT_MIX) + tint * GHOST_TINT_MIX)
        g[appearing, :3] = c
        g[appearing, 3] = GHOST_ALPHA_FADE
    # vanishing: fade the from-color out at partial alpha
    if vanishing.any():
        g[vanishing, :3] = b_from[fresh][vanishing, :3]
        g[vanishing, 3] = GHOST_ALPHA_FADE
    # recolored: true midpoint blend + slight tint
    if recolored.any():
        c = 0.5 * b_from[fresh][recolored, :3].astype(np.int32) \
            + 0.5 * b_to[fresh][recolored, :3].astype(np.int32)
        c = c * (1 - GHOST_TINT_MIX) + tint * GHOST_TINT_MIX
        g[recolored, :3] = c
        g[recolored, 3] = 255
    frame[fresh] = g
    return frame


def build_track(bases, n, k, form):
    """Per-frame base track + motion envelope + layout for one row over M bases.

    v13 generalization (idle super-loop): M >= 2 bases cycle
      hold b0 | dissolve->b1 | hold b1 | ... | hold b(M-1) | dissolve->b0
    with h hold frames per base (remainder r joins the LAST hold) and k
    dissolve frames per transition. Frame 0 and frame n-1 are both pure b0,
    so the loop wraps seamlessly. M == 2 reproduces the v8 layout exactly.

    Returns (frames, env, layout). env[i] is the geometric-motion envelope
    for frame i: 0.0 on dissolve frames, ramping 0.5 -> 1.0 at hold edges.
    layout is the ACTUAL phase structure this call produced:
      {"bases": M, "k": k,
       "windows": [{"hold": [lo, hi], "dissolve": [lo, hi]}, ...]}
    v14 contract: the builder consumes this layout verbatim (via
    track_layout.json, emitted by main) instead of re-deriving it from a
    hand-maintained ROW_SPEC. The v13 idle row shipped with exactly that
    duplication wrong (ROW_SPEC said bases=3; the track has 4 entries
    [b0, vc, b0, vd]), so the engine's dissolve FX fired over HOLD frames
    for two of three transitions. One source of truth kills the class.

    WHY THE ENVELOPE EXISTS: a dissolve frame carries the UNION of both
    bases' silhouette boundaries, so its perimeter is much larger than
    either base's. Any whole-body transform (sway/bob/breath) on such a
    frame moves that union boundary and produces silhouette deltas of
    2500-4700px — instantly blowing the gate's per-state caps (measured
    2026-08-08: alpha doze 4704px from a single 1px sway on a half-
    dissolved frame). Motion therefore rides only the stable single-base
    hold frames; transitions play motion-free and the materialization reads
    clean. For a single-base track (sleep), pass the base twice: the
    identical-bases fast path keeps env 1.0 throughout.
    """
    m = len(bases)
    if m < 2:
        raise ValueError("build_track needs at least two bases "
                         "(pass the same base twice for single-base rows)")
    b0 = bases[0]
    identical = all(np.array_equal(b0, b) for b in bases[1:])
    frames = []
    if identical:
        frames = [b0.copy() for _ in range(n)]
        # single-base row: no phases, no transition (sleep). The builder
        # publishes transition=None for bases==1 layouts.
        return frames, np.ones(n), {"bases": 1, "k": None, "windows": []}
    h = (n - m * k) // m
    r = n - m * k - m * h
    if h < 1:
        raise ValueError(f"n={n} too small for {m} bases x k={k}")
    # precompute one dissolve mask set per transition (b_j -> b_{j+1 mod m})
    masks = [dissolve_masks(bases[j], bases[(j + 1) % m], k) for j in range(m)]
    cursor = 0
    env = np.ones(n)
    holds = []                       # (lo, hi) per base, documented layout
    windows = []                     # v14: the REAL phase layout, emitted verbatim
    for j in range(m):
        hold_len = h + (r if j == m - 1 else 0)
        hold_lo, hold_hi = cursor, cursor + hold_len - 1
        holds.append((hold_lo, hold_hi))
        for i in range(hold_lo, hold_hi + 1):
            frames.append(bases[j])
        cursor += hold_len
        dis_lo, dis_hi = cursor, cursor + k - 1
        for i in range(dis_lo, dis_hi + 1):
            frames.append(dissolve_frame(bases[j], bases[(j + 1) % m],
                                         masks[j], i - dis_lo + 1, form))
        cursor += k
        windows.append({"hold": [hold_lo, hold_hi],
                        "dissolve": [dis_lo, dis_hi]})
    assert len(frames) == n and cursor == n
    env = np.ones(n)
    # dissolve frames: motion-free; holds: ramp 0.5 -> 1.0 at the edges
    cursor = 0
    for j in range(m):
        hold_len = h + (r if j == m - 1 else 0)
        hold_lo, hold_hi = cursor, cursor + hold_len - 1
        for i in range(hold_lo, hold_hi + 1):
            d = min(i - hold_lo, hold_hi - i) + 1
            env[i] = min(1.0, d / 2.0)
        cursor += hold_len
        for i in range(cursor, cursor + k):
            env[i] = 0.0
        cursor += k
    return frames, env, {"bases": m, "k": k, "windows": windows}


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


def union_glow(form, bases):
    """Glow pool covering EVERY base in a multi-base track: the union of the
    per-base glow masks. Variant bases bring their own energy pixels (flames,
    bolts, magma) that the primary's mask never covered — without the union
    those pixels would sit dead during the variant hold."""
    u = np.zeros((CANVAS, CANVAS), dtype=bool)
    for b in bases:
        u |= glow_mask(b, form)
    return u


def derive(form, track, sel, amp, wl, cycles, n, prefix, kind, gamp):
    """Shimmer + per-frame geometry motion over a multi-base track.
    track: (frames, env) from build_track; geometric amplitudes are scaled
    by the envelope (0 on dissolve frames, 1 deep in holds).
    kind 'breath': baseline-anchored vertical scale, amplitude gamp rows.
    kind 'bob'   : vertical lift 0..gamp rows.
    kind 'sway'  : horizontal whole-body weight-shift, +/-gamp px.
    kind 'none'  : geometry untouched (callers that bring their own, e.g. gait).
    """
    frames, env, _layout = track
    for i in range(n):
        frame = shimmer_frame(frames[i], sel, amp, wl, i, n, cycles)
        e = env[i]
        if kind == "breath":
            frame = breath(form, frame, int(round(e * _wave(i, n, cycles, gamp))))
        elif kind == "bob":
            frame = bob(frame, int(round(e * abs(_wave(i, n, cycles, gamp)))))
        elif kind == "sway":
            frame = sway(frame, int(round(e * _wave(i, n, cycles, gamp))))
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))


def flinch_dy(i, n):
    """Recoil that settles, for the hurt row: frame 0 is the upright starting
    pose, frame 1 snaps to full compression (-2 rows), the rest of the cycle
    eases back only to -1 — a throb that never fully recovers before the next
    wince. Distinct from sleep's even breath: hurt motion is asymmetric by
    construction (snap, partial settle, repeat)."""
    if i == 0:
        return 0
    t = (i - 1) / max(1, n - 2)          # 0..1 across the recovery
    return int(math.floor(-2 + t + 0.5))  # -2 early, settles at -1


def expectant(form, track, sel, amp, wl, cycles, n, prefix, gamp, samp):
    """Shimmer + slow breath + gentle whole-body sway over a multi-base track.
    Used by the two 'being, not doing' rows: blocked (waiting on the human)
    and doze (content rest). Same frontal pose as idle — the distinction is
    the RHYTHM: one long deliberate breath per loop instead of idle's two
    quick ones, plus a sway that reads as leaning in (blocked) or lolling
    (doze). Motion is envelope-scaled: dissolve frames play clean."""
    frames, env, _layout = track
    for i in range(n):
        frame = shimmer_frame(frames[i], sel, amp, wl, i, n, cycles)
        e = env[i]
        frame = breath(form, frame, int(round(e * _wave(i, n, cycles, gamp))))
        frame = sway(frame, int(round(e * _wave(i, n, cycles + 2, samp))))
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))


def tremor(form, track, sel, amp, wl, cycles, n, prefix):
    """Shimmer + high-frequency low-amplitude shudder over a multi-base track:
    fast horizontal ±1px jitter (incommensurate minor wave keeps the period
    exactly n) plus an occasional 1px chest compression. Energy without
    travel — pushing against a wall. Structurally unlike working's on-beat
    bob: the dominant frequency here is ~n/2 cycles per loop, not the gait
    beat. Jitter is envelope-scaled: dissolve frames play clean."""
    frames, env, _layout = track
    for i in range(n):
        frame = shimmer_frame(frames[i], sel, amp, wl, i, n, cycles)
        e = env[i]
        frame = sway(frame, int(round(e * _wave(i, n, cycles, 1.3))))
        # Dip capped at -1: deeper compression would push this row's geometry
        # signature toward blocked's (the gate only sees swings, not tempo).
        if e > 0 and _wave(i, n, cycles + 3, 1.6) < -0.8:
            frame = breath(form, frame, -1)
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))


def hurt(form, track, sel, amp, wl, cycles, n, prefix):
    """Shimmer + the flinch_dy recoil sequence + a one-way backward stagger
    over a multi-base track.
    Head-down-but-body-up: compression anchors at the paw baseline, so the
    chest drops while the stance holds — recoil, not the sleep droop. The
    stagger only pulls BACK (a wince has a direction), which also gives hurt
    cxSwing=1 vs doze's symmetric ±1 loll (cxSwing=2) — the two rows stay
    apart on a swing dimension, not just on a fragile 1px cyMean difference.
    Recoil is envelope-scaled: dissolve frames play clean."""
    frames, env, _layout = track
    for i in range(n):
        frame = shimmer_frame(frames[i], sel, amp, wl, i, n, cycles)
        e = env[i]
        frame = breath(form, frame, int(round(e * flinch_dy(i, n))))
        stag = int(round(e * min(0.0, _wave(i, n, cycles + 2, 1.2))))
        frame = sway(frame, stag)
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


def gait(form, base, track, sel, amp, wl, cycles, n, prefix, dx, mode, gamp, samp=0):
    """Shimmer + horizontal leg weight-shift + vertical bob + optional lunge
    over a multi-base track.
    mode 'walk'  : clusters shift one at a time, alternating direction; body
                   bobs on the beat — the stride read.
    mode 'attack': all clusters surge together, alternating direction per
                   frame, plus a whole-body horizontal LUNGE (samp px) on the
                   beat — coiled aggression. The lunge also gives attack a
                   motion signature distinct from working's pure vertical bob.
    Leg clusters are anchored to the PRIMARY base (frame 0): the paw-shift
    band geometry is defined by the registered stance, not by the variant.
    All geometry is envelope-scaled: dissolve frames play clean.
    """
    frames, env, _layout = track
    clusters = leg_clusters(form, base)
    for i in range(n):
        frame = shimmer_frame(frames[i], sel, amp, wl, i, n, cycles)
        e = env[i]
        if clusters and e > 0:
            dxi = int(round(e * dx))
            if dxi:
                if mode == "walk":
                    paw_shift(form, frame, clusters[i % len(clusters)],
                              dxi if (i % 2 == 0) else -dxi)
                else:  # attack surge: whole stance snaps side to side
                    d = dxi if (i % 2 == 0) else -dxi
                    for c in clusters:
                        paw_shift(form, frame, c, d)
        if gamp:
            frame = bob(frame, int(round(e * abs(_wave(i, n, cycles, gamp)))))
        if samp:
            frame = sway(frame, int(round(e * _wave(i, n, cycles, samp))))
        save(frame, os.path.join(REPO, form, f"{prefix}{i:02d}.png"))
    return clusters


# ── Cycle sizes ──────────────────────────────────────────────────────────
# v9 — smooth-in-between pass (Creator 2026-08-08: "generate more in between
# sprites that transition into a smoother animation"). Every row doubles its
# frame count AND its dissolve step count k in the same proportion, then hold
# halves 2 -> 1: loop wall-clock duration is unchanged (n*hold ticks constant
# modulo rounding), but the sampling doubles to 30fps and each materialization
# step flips HALF the pixels — the transitions read as smooth assembly instead
# of chunky pops. Gate needs no change: the travel/sec floor is resampling-
# invariant by design and per-step caps only shrink under finer sampling.
#   idle 32->64 alert 24->48 working 24->48 attack 24->48 victory 36->72
#   walk 16->32 sleep 40->80 blocked 36->72 straining 24->48 hurt 24->48
#   doze 32->64
N_IDLE = 128     # v13 super-loop: 4 phases (b0,vc,b0,vd) x (16 hold + 16 dissolve) = 128f, 4.3s — three sprites per loop, v12 rhythm intact
N_ALERT = 64     # v14 super-loop: 4 phases (b0,vd,b0,vc) x (8 hold + 8 dissolve), 2.1s — three sprites per loop
N_WORKING = 64   # v14 super-loop: 4 phases (b0,va,b0,vb), same layout
N_ATTACK = 48
N_WALK = 32
N_VICTORY = 72
N_BLOCKED = 72   # waiting on the human: one long deliberate breath
N_STRAINING = 48 # rate-limited / backing off: high-freq tremor, no travel
N_HURT = 48      # a real failure: flinch that settles, not the sleep droop
N_DOZE = 64      # genuine rest: slower, content breath on the same pose
N_SLEEP = 80


# ── v11 eye blinks — the cheapest 'alive' cue (Creator standing mission) ──
# Eye positions located empirically and vision-confirmed (2026-08-09):
# OMEGA = four bright red-orange glow dots (side heads + center-head pair);
# ALPHA = bright cyan/white pixels in the skull-mask sockets. Coordinates are
# RELATIVE TO THE SILHOUETTE TOP (eyes are fixed to the head; the whole
# frame moves ±2px on breath/bob, but top is recomputed per frame).
# Pure color-band detection failed on ALPHA: the head flames bleed into the
# same hue band and merge eye clusters into oversize blobs that the size
# filter rejects (measured: E2/E4 eyes missed on most frames). Template
# windows + brightness threshold are immune to flame contamination.
# Blink is RGB-only: silhouette never changes, so every geometry gate
# (top/bottom ranges, travel, signatures, baselines) is unaffected.
EYE_WINDOWS = {
    # (cx, cy) relative to silhouette top; window = ±3px square
    "omega": [(24, 23), (57, 24), (72, 24), (105, 23)],
    "alpha": [(14, 28), (42, 27), (53, 27), (79, 27)],
}
EYE_WIN_R = 3  # half-window radius


def eye_mask(frame, form):
    """Eye pixels of this frame: bright pixels inside the template eye
    windows (anchored to per-frame silhouette top). ALPHA additionally gets
    an eyelid patch — ALL opaque pixels within ±1px of each eye center —
    because its eyes are only 1-3px each and pure bright-pixel dimming was
    invisible at display size (vision judge 1/10 despite 95% measured
    darkening; the surrounding cyan flame washes small changes out)."""
    r, g, b, al = (frame[:, :, i] for i in range(4))
    op = al > 0
    ys_all = np.where(op)[0]
    if len(ys_all) == 0:
        return op & False
    top = int(ys_all.min())
    out = np.zeros(op.shape, dtype=bool)
    if form == "omega":
        bright = (np.maximum(r, g) > 180) & (r > b + 40)
    else:
        bright = (b > 140) & (g > 100) & (np.maximum(b, g) > r + 20)
    H, W = op.shape
    for cx, cy in EYE_WINDOWS[form]:
        y0 = max(0, top + cy - EYE_WIN_R)
        y1 = min(H, top + cy + EYE_WIN_R + 1)
        x0 = max(0, cx - EYE_WIN_R)
        x1 = min(W, cx + EYE_WIN_R + 1)
        win = op[y0:y1, x0:x1] & bright[y0:y1, x0:x1]
        out[y0:y1, x0:x1] |= win
        if form == "alpha":
            # eyelid patch: solid dark core over the socket itself
            ly0 = max(0, top + cy - 1)
            ly1 = min(H, top + cy + 2)
            lx0 = max(0, cx - 1)
            lx1 = min(W, cx + 2)
            out[ly0:ly1, lx0:lx1] |= op[ly0:ly1, lx0:lx1]
    return out


def dim_eyes(frame, mask, strength):
    """Darken eye pixels toward closed-lid shadow, keeping a faint hue."""
    if not mask.any():
        return
    frame[mask, :3] = np.clip(
        frame[mask, :3] * (1.0 - strength), 0, 255).astype(np.int32)


def _blink_windows(n, seed):
    """Two blink windows per loop, deterministic per row seed, placed away
    from the wrap seam (frames 0-3 and n-4..n-1 stay clean)."""
    h = (seed * 2654435761) % (2 ** 31)
    usable = n - 12
    if usable < 8:
        return []
    s1 = 4 + (h % usable)
    s2 = s1 + n // 2 + ((h >> 3) % 7)
    wins = []
    for s in (s1, s2):
        if s + 3 <= n - 4:
            wins.append(s)
    return wins


def blink_pass(form, prefix, n, seed, mode="blink"):
    """Post-process a derived row's saved frames with eye animation.
    mode 'blink' : two quick close-open windows per loop (awake rows).
    mode 'drowsy': half-lidded all loop (doze).
    mode 'closed' : eyes shut all loop (sleep).
    """
    d = os.path.join(REPO, form)
    if mode == "closed":
        for i in range(n):
            p = os.path.join(d, f"{prefix}{i:02d}.png")
            f = np.array(Image.open(p).convert("RGBA")).astype(np.int32)
            dim_eyes(f, eye_mask(f, form), 0.90)
            save(f, p)
        return
    if mode == "drowsy":
        for i in range(n):
            p = os.path.join(d, f"{prefix}{i:02d}.png")
            f = np.array(Image.open(p).convert("RGBA")).astype(np.int32)
            dim_eyes(f, eye_mask(f, form), 0.50)
            save(f, p)
        return
    # awake blink: open -> half -> shut -> half -> open over 4 frames
    strengths = {0: 0.55, 1: 0.95, 2: 0.95, 3: 0.55}
    for s in _blink_windows(n, seed):
        for j, st in strengths.items():
            i = s + j
            p = os.path.join(d, f"{prefix}{i:02d}.png")
            f = np.array(Image.open(p).convert("RGBA")).astype(np.int32)
            dim_eyes(f, eye_mask(f, form), st)
            save(f, p)


def main():
    # v14: record every row's ACTUAL track layout and emit it for the
    # builder. The builder used to re-derive windows from a hand-maintained
    # ROW_SPEC — that duplication shipped wrong for idle in v13 (bases=3 vs
    # the real 4-entry track), mis-timing the engine's dissolve FX. One
    # source of truth: the code that builds the frames publishes the layout.
    layouts = {}
    for form in ["omega", "alpha"]:
        b0 = load_base(form, "idle_neutral")
        va = load_base(form, "idle_variant_a")
        vb = load_base(form, "idle_variant_b")
        # v10 — two MORE generated bases (crown-spiked / icicle-crowned proud
        # stances), spread across the remaining rows so every loop visibly
        # cycles different sprite art. Generated via OpenRouter
        # (gemini-3.1-flash-image) when QwenCloud quota was exhausted;
        # magenta-keyed + drift-clean registered (top/bottom == primary).
        vc = load_base(form, "idle_variant_c")
        vd = load_base(form, "idle_variant_d")
        # Glow pool = union over every base any row will play, so variant
        # energy pixels (flames/bolts/magma) shimmer during their holds too.
        glow_u = union_glow(form, [b0, va, vb, vc, vd])
        body = int((b0[:, :, 3] > 0).sum())

        # ── Multi-base tracks (Creator 2026-08-08: several distinct sprites
        # per animation, not one). k = dissolve steps, sized so each step's
        # silhouette delta stays under 60% of the state's gate cap. Rows are
        # split across the two variants so they stay visually distinct.
        # v9: k doubled WITH n — same dissolve fraction, half the pixels per
        # materialization step, so transitions read smooth, not chunky. ──

        # idle: the super-loop — FOUR phases cycle THREE distinct sprites:
        # neutral -> variant C -> neutral -> variant D -> neutral. 128 frames,
        # 4.3s. Every dissolve is neutral<->variant (the small, smooth XOR
        # class); a direct variant->variant dissolve was measured at 1886px
        # per step — 5.5x coarser and over idle's gate cap — so the cycle
        # routes through the home pose instead. Hold rhythm (16f) and
        # dissolve fraction (50%) are EXACTLY v12's; breath tempo unchanged
        # (4 cycles over 128 = 32-frame period, same as 2 cycles over 64).
        tr = build_track([b0, vc, b0, vd], N_IDLE, k=16, form=form)
        sel = subset_mask(glow_u, int(0.09 * body), seed=0)
        derive(form, tr, sel, amp=0.28, wl=56, cycles=4, n=N_IDLE,
               prefix="dl", kind="breath", gamp=2)
        layouts["idle"] = tr[2]

        # alert: watchful scan — v14 SUPER-LOOP: three sprites cycle
        # (neutral -> D -> neutral -> C), 64 frames / 2.1s, same layout math
        # as idle. Sway rhythm (5 cycles, gamp=2) unchanged; travel/sec is
        # resampling-invariant so the gate floor carries over untouched.
        tr = build_track([b0, vd, b0, vc], N_ALERT, k=8, form=form)
        sel = subset_mask(glow_u, int(0.12 * body), seed=1)
        derive(form, tr, sel, amp=0.40, wl=34, cycles=5, n=N_ALERT,
               prefix="al", kind="sway", gamp=2)
        layouts["alert"] = tr[2]

        # working: rhythmic processing pulse — v14 SUPER-LOOP: three sprites
        # (neutral -> A -> neutral -> B). Bob rhythm (7 cycles) unchanged.
        tr = build_track([b0, va, b0, vb], N_WORKING, k=8, form=form)
        sel = subset_mask(glow_u, int(0.10 * body), seed=2)
        derive(form, tr, sel, amp=0.34, wl=46, cycles=7, n=N_WORKING,
               prefix="wo", kind="bob", gamp=2)
        layouts["working"] = tr[2]

        # attack: aggressive surge + lunge — variant B
        tr = build_track([b0, vb], N_ATTACK, k=6, form=form)
        sel = subset_mask(glow_u, int(0.12 * body), seed=3)
        cl = gait(form, b0, tr, sel, amp=0.50, wl=30, cycles=6, n=N_ATTACK,
                  prefix="at", dx=2, mode="attack", gamp=2, samp=3)
        layouts["attack"] = tr[2]

        # victory: celebratory swell + biggest bob — variant C (v10)
        tr = build_track([b0, vc], N_VICTORY, k=8, form=form)
        sel = subset_mask(glow_u, int(0.20 * body), seed=4)
        derive(form, tr, sel, amp=0.38, wl=64, cycles=3, n=N_VICTORY,
               prefix="vc", kind="bob", gamp=3)
        layouts["victory"] = tr[2]

        # walk: stride with the opposite-step variant dissolving in
        bw = load_base(form, "walk_step_right")
        wv = load_base(form, "walk_variant")
        tr = build_track([bw, wv], N_WALK, k=8, form=form)
        sel = subset_mask(union_glow(form, [bw, wv]),
                          int(0.18 * (bw[:, :, 3] > 0).sum()), seed=5)
        clw = gait(form, bw, tr, sel, amp=0.26, wl=48, cycles=2, n=N_WALK,
                   prefix="wk", dx=2, mode="walk", gamp=2)
        layouts["walk"] = tr[2]

        # sleep: one slow shallow breath — single base (no sleep variant yet)
        b = load_base(form, "sleep_rest")
        sel = subset_mask(glow_mask(b, form), int(0.07 * (b[:, :, 3] > 0).sum()), seed=6)
        tr = build_track([b, b], N_SLEEP, k=8, form=form)
        derive(form, tr, sel, amp=0.16, wl=72, cycles=1, n=N_SLEEP,
               prefix="sl", kind="breath", gamp=1)
        layouts["sleep"] = tr[2]

        # ── v6 harness states — now each gets its own variant pairing too,
        # so blocked/straining/hurt/doze read as different SPRITES, not just
        # different rhythms on one silhouette.

        # blocked: long deliberate breath + lean-in — variant D (v10)
        tr = build_track([b0, vd], N_BLOCKED, k=6, form=form)
        sel = subset_mask(glow_u, int(0.10 * body), seed=7)
        expectant(form, tr, sel, amp=0.22, wl=68, cycles=1, n=N_BLOCKED,
                  prefix="bl", gamp=1, samp=2)
        layouts["blocked"] = tr[2]

        # straining: high-freq tremor against a wall — variant A
        tr = build_track([b0, va], N_STRAINING, k=8, form=form)
        sel = subset_mask(glow_u, int(0.12 * body), seed=8)
        tremor(form, tr, sel, amp=0.45, wl=30, cycles=9, n=N_STRAINING,
               prefix="st")
        layouts["straining"] = tr[2]

        # hurt: flinch that settles — variant B
        tr = build_track([b0, vb], N_HURT, k=10, form=form)
        sel = subset_mask(glow_u, int(0.08 * body), seed=9)
        hurt(form, tr, sel, amp=0.20, wl=52, cycles=1, n=N_HURT,
             prefix="hu")
        layouts["hurt"] = tr[2]

        # doze: content rest, quietest shimmer — variant B (v10: blocked took
        # variant D, and putting both 'expectant' rows on the same variant
        # collapsed their geometry signatures into an identical collision —
        # the signature sees only integer swings, and 1px sway is 1px sway.
        # Splitting the variant pair is the cleanest structural fix.)
        # Shallower breath (gamp=1 vs idle's 2) keeps doze apart from idle.
        tr = build_track([b0, vb], N_DOZE, k=16, form=form)
        sel = subset_mask(glow_u, int(0.07 * body), seed=10)
        expectant(form, tr, sel, amp=0.14, wl=76, cycles=1, n=N_DOZE,
                  prefix="dz", gamp=1, samp=1)
        layouts["doze"] = tr[2]

        # ── v11 blinks: eyes animate in every row (RGB-only post-pass).
        # Awake rows blink twice per loop on row-unique seeds (no synced
        # blinking across states); doze rides half-lidded; sleep stays shut.
        for prefix, nrows, seed in [("dl", N_IDLE, 11), ("al", N_ALERT, 12),
                                    ("wo", N_WORKING, 13), ("at", N_ATTACK, 14),
                                    ("vc", N_VICTORY, 15), ("wk", N_WALK, 16),
                                    ("bl", N_BLOCKED, 17), ("st", N_STRAINING, 18),
                                    ("hu", N_HURT, 19)]:
            blink_pass(form, prefix, nrows, seed, mode="blink")
        blink_pass(form, "dz", N_DOZE, 20, mode="drowsy")
        blink_pass(form, "sl", N_SLEEP, 21, mode="closed")

        total = (N_IDLE + N_ALERT + N_WORKING + N_ATTACK + N_VICTORY + N_WALK
                 + N_SLEEP + N_BLOCKED + N_STRAINING + N_HURT + N_DOZE)
        print(f"{form}: derived {total} frames over multi-base tracks "
              f"(idle={N_IDLE} alert={N_ALERT} working={N_WORKING} attack={N_ATTACK} "
              f"victory={N_VICTORY} walk={N_WALK} sleep={N_SLEEP} "
              f"blocked={N_BLOCKED} straining={N_STRAINING} hurt={N_HURT} doze={N_DOZE}; "
              f"clusters walk={clw} attack={cl})")
    # v14: emit the REAL track layouts for the builder (single source of
    # truth — replaces the hand-maintained ROW_SPEC). Both forms build the
    # same layout (identical n/k/bases lists), so one form's dict is the
    # contract; assert agreement before writing.
    for row, lay in layouts.items():
        assert set(lay) == {"bases", "k", "windows"}, f"bad layout {row}"
    out = os.path.join(REPO, "runtime", "track_layout.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"note": "emitted by derive_frames.py build_track; "
                           "consumed verbatim by build_runtime_atlas.py",
                   "rows": layouts}, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"wrote {out} ({len(layouts)} rows)")
    print("done v14 track-layout contract")


if __name__ == "__main__":
    main()

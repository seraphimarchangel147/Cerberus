"""ALPHA blue-flame + lightning compositor.
Blue flames (dark navy -> azure -> cyan -> white-hot) + procedural lightning bolts.
"""
from PIL import Image
import numpy as np
import os, math, random
from scipy.ndimage import distance_transform_edt

# Resolve all asset paths relative to this file so the pipeline runs from anywhere.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(BASE_DIR, "alpha")
OUT_DIR = os.path.join(BASE_DIR, "out")

random.seed(271)
np.random.seed(271)

W = H = 128
OUT_SCALE = 3

# Blue flame palette: dark navy -> deep blue -> azure -> cyan -> white-hot
BLUE_FLAME = [
    (2, 4, 18), (6, 16, 52), (10, 36, 100), (16, 64, 160), (24, 100, 210),
    (40, 140, 235), (70, 175, 248), (120, 205, 255), (180, 230, 255), (230, 248, 255),
]

def blue_flame_color(t):
    t = max(0.0, min(1.0, t))
    idx = t * (len(BLUE_FLAME) - 1)
    i = int(idx)
    if i >= len(BLUE_FLAME) - 1:
        return BLUE_FLAME[-1]
    f = idx - i
    c0, c1 = BLUE_FLAME[i], BLUE_FLAME[i+1]
    return tuple(int(c0[k] + (c1[k]-c0[k])*f) for k in range(3))


class BlueFlameColumn:
    def __init__(self, x, base_y, width, height, speed, phase):
        self.x = x; self.base_y = base_y; self.width = width
        self.height = height; self.speed = speed; self.phase = phase

    def render(self, buf, t, intensity=1.0):
        flick = math.sin(t * self.speed + self.phase)
        flick2 = math.sin(t * self.speed * 1.7 + self.phase * 2.3)
        flick3 = math.sin(t * self.speed * 3.1 + self.phase * 0.7)
        h = self.height * intensity * (0.72 + 0.28 * flick)
        w = self.width * (0.82 + 0.18 * flick2)
        sway = math.sin(t * self.speed * 0.6 + self.phase) * 2.5 + flick3 * 1.2
        cx = self.x + sway
        for dy in range(int(h)):
            frac = dy / h
            temp = (1.0 - frac) ** 1.3
            half_w = max(0.5, w * 0.5 * (1.0 - frac * 0.85))
            y = int(self.base_y - dy)
            if y < 0 or y >= H:
                continue
            wobble = math.sin(dy * 0.55 + t * self.speed * 2.2 + self.phase) * (1.5 + frac * 3.5)
            row_cx = cx + wobble
            x0 = int(row_cx - half_w); x1 = int(row_cx + half_w)
            for x in range(max(0, x0), min(W, x1 + 1)):
                edge = abs(x - row_cx) / max(0.5, half_w)
                local_temp = temp * (1.0 - edge * edge)
                local_temp += 0.10 * math.sin(x * 1.3 + dy * 0.7 + t * 8)
                col = blue_flame_color(local_temp)
                for k in range(3):
                    buf[y, x, k] = min(255, int(buf[y, x, k]) + col[k])


class LightningBolt:
    """Procedural jagged lightning bolt that flickers in and out."""
    def __init__(self, x_start, y_start, length, angle_range=(-0.4, 0.4)):
        self.x_start = x_start
        self.y_start = y_start
        self.length = length
        self.angle_range = angle_range
        self.segments = []
        self.life = 0.0
        self.max_life = random.uniform(0.15, 0.4)
        self.timer = random.uniform(0, 3.0)
        self.regenerate()

    def regenerate(self):
        self.segments = []
        x, y = self.x_start, self.y_start
        angle = random.uniform(self.angle_range[0], self.angle_range[1])
        seg_len = self.length / random.randint(5, 9)
        for _ in range(random.randint(5, 9)):
            nx = x + math.sin(angle) * seg_len + random.uniform(-3, 3)
            ny = y - math.cos(angle) * seg_len
            self.segments.append(((int(x), int(y)), (int(nx), int(ny))))
            x, y = nx, ny
            angle += random.uniform(-0.5, 0.5)

    def update(self, dt):
        self.timer -= dt
        if self.timer <= 0:
            self.life = self.max_life
            self.timer = random.uniform(1.5, 4.0)
            self.regenerate()
        if self.life > 0:
            self.life -= dt

    def render(self, buf):
        if self.life <= 0:
            return
        a = self.life / self.max_life
        brightness = int(200 * a + 55)
        for (x0, y0), (x1, y1) in self.segments:
            self._draw_line(buf, x0, y0, x1, y1, brightness)

    def _draw_line(self, buf, x0, y0, x1, y1, brightness):
        dx = abs(x1 - x0); dy = abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy
        while True:
            if 0 <= x0 < W and 0 <= y0 < H:
                # Core white-blue
                buf[y0, x0, 0] = min(255, buf[y0, x0, 0] + brightness)
                buf[y0, x0, 1] = min(255, buf[y0, x0, 1] + brightness)
                buf[y0, x0, 2] = min(255, buf[y0, x0, 2] + brightness)
                # Glow around
                for gx, gy in [(x0-1,y0),(x0+1,y0),(x0,y0-1),(x0,y0+1)]:
                    if 0 <= gx < W and 0 <= gy < H:
                        g = brightness // 3
                        buf[gy, gx, 0] = min(255, buf[gy, gx, 0] + g)
                        buf[gy, gx, 1] = min(255, buf[gy, gx, 1] + g)
                        buf[gy, gx, 2] = min(255, buf[gy, gx, 2] + g)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy; x0 += sx
            if e2 < dx:
                err += dx; y0 += sy


class Spark:
    def __init__(self):
        self.full_height = False
        self.reset()
    def reset(self):
        self.x = random.uniform(10, W - 10)
        self.y = random.uniform(H * 0.5, H)
        self.vy = random.uniform(0.3, 0.9)
        self.vx = random.uniform(-0.2, 0.2)
        self.life = random.uniform(0.5, 1.0)
        self.max_life = self.life
        self.size = random.choice([1, 1, 1, 2])
        self.hot = random.random()
        self.full_height = False
    def reset_fg(self):
        self.x = random.uniform(18, W - 18)
        y_frac = min(random.random(), random.random())
        self.y = H * (0.10 + 0.85 * y_frac)
        self.vy = random.uniform(0.25, 0.65)
        self.vx = random.uniform(-0.25, 0.25)
        self.life = random.uniform(0.6, 1.0)
        self.max_life = self.life
        self.size = random.choice([2, 2, 3])
        self.hot = random.uniform(0.75, 1.0)
        self.full_height = True
    def update(self):
        self.y -= self.vy
        self.x += self.vx + math.sin(self.y * 0.1) * 0.15
        self.life -= 0.012
        if self.life <= 0 or self.y < 0:
            if self.full_height:
                self.reset_fg()
            else:
                self.reset()
    def render(self, buf):
        x, y = int(self.x), int(self.y)
        if 0 <= x < W and 0 <= y < H:
            a = self.life / self.max_life
            temp = 0.5 + 0.5 * self.hot
            col = blue_flame_color(temp)
            for dy in range(self.size):
                for dx in range(self.size):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < W and 0 <= yy < H:
                        for k in range(3):
                            buf[yy, xx, k] = min(255, int(buf[yy, xx, k]) + int(col[k] * a))


class ThoughtParticle:
    """Slow-drifting cyan spark rising off the heads — thinking state only.
    Matches ALPHA's cold-plasma identity (low R, high G, max B)."""
    def __init__(self):
        self.reset()
    def reset(self):
        self.x = random.uniform(W * 0.30, W * 0.70)
        self.y = random.uniform(H * 0.12, H * 0.42)
        self.vy = random.uniform(0.10, 0.30)
        self.vx = random.uniform(-0.08, 0.08)
        self.life = random.uniform(0.6, 1.0)
        self.max_life = self.life
        self.size = random.choice([2, 2, 3, 3])
        self.bright = random.random()
    def update(self):
        self.y -= self.vy
        self.x += self.vx + math.sin(self.y * 0.15 + self.x * 0.1) * 0.12
        self.life -= 0.008
        if self.life <= 0 or self.y < 0:
            self.reset()
    def render(self, buf):
        x, y = int(self.x), int(self.y)
        if 0 <= x < W and 0 <= y < H:
            a = self.life / self.max_life
            r = int(40 + 90 * self.bright)
            g = int(190 + 60 * self.bright)
            b = 255
            for dy in range(self.size):
                for dx in range(self.size):
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < W and 0 <= yy < H:
                        for k, val in enumerate([r, g, b]):
                            buf[yy, xx, k] = min(255, int(buf[yy, xx, k]) + int(val * a))


def render_thought_particles(buf, particles):
    for p in particles:
        p.update()
        p.render(buf)
    return buf


def make_bg(t=0.0, glow_intensity=1.0):
    bg = np.zeros((H, W, 3), dtype=np.uint8)
    pulse = 0.5 + 0.5 * math.sin(t * 1.5)
    for y in range(H):
        frac = y / H
        r = int(2 + 6 * frac)
        g = int(4 + 12 * frac + 2 * pulse * frac)
        b = int(16 + 30 * frac + 5 * pulse * frac)
        bg[y, :] = (r, g, b)
    cx, cy = W // 2, int(H * 0.60)
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.sqrt((xx - cx) ** 2 + ((yy - cy) * 1.2) ** 2)
    glow = np.clip(1.0 - dist / 95.0, 0, 1) ** 1.6
    glow *= (0.55 + 0.20 * pulse) * glow_intensity
    bg[:, :, 0] = np.clip(bg[:, :, 0].astype(int) + (glow * 16).astype(int), 0, 255).astype(np.uint8)
    bg[:, :, 1] = np.clip(bg[:, :, 1].astype(int) + (glow * 80).astype(int), 0, 255).astype(np.uint8)
    bg[:, :, 2] = np.clip(bg[:, :, 2].astype(int) + (glow * 140).astype(int), 0, 255).astype(np.uint8)
    return bg


def build_blue_flame_field(t, columns, sparks, lightning, intensity=1.0, glow_intensity=1.0, dt=0.04):
    buf = make_bg(t, glow_intensity).astype(np.int32)
    for c in columns:
        c.render(buf, t, intensity)
    for bolt in lightning:
        bolt.update(dt)
        bolt.render(buf)
    buf = np.clip(buf, 0, 255).astype(np.uint8)
    for e in sparks:
        e.update()
        e.render(buf)
    return buf


def render_foreground_sparks(buf, fg_sparks):
    for e in fg_sparks:
        e.update()
        e.render(buf)
    return buf


def cross_fade_sprites(frames, weights):
    acc = np.zeros((H, W, 4), dtype=np.float32)
    for frame, w in zip(frames, weights):
        if w <= 0:
            continue
        acc += np.array(frame).astype(np.float32) * w
    return Image.fromarray(np.clip(acc, 0, 255).astype(np.uint8), "RGBA")


def keyframe_blend(pos, blend_frac=0.22):
    """Hold each pose solid for most of its span, blend only during the last
    `blend_frac` — avoids the prolonged double-exposure ghosting of a full
    smoothstep blend across the whole span."""
    nk_floor = int(pos)
    frac = pos - nk_floor
    if frac < (1.0 - blend_frac):
        return nk_floor, nk_floor + 1, 0.0
    local = (frac - (1.0 - blend_frac)) / blend_frac
    s = local * local * (3 - 2 * local)
    return nk_floor, nk_floor + 1, s


def apply_breathing(sprite_rgba, t, breath_speed=2.0, breath_amp=0.015):
    arr = np.array(sprite_rgba)
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 0)
    if len(ys) == 0:
        return sprite_rgba
    bottom = ys.max()
    scale = 1.0 + breath_amp * math.sin(t * breath_speed)
    new_h = int((bottom + 1) * scale)
    if new_h < 1:
        return sprite_rgba
    new_h = min(new_h, H)
    content = arr[:bottom+1, :, :]
    content_img = Image.fromarray(content, "RGBA")
    scaled = content_img.resize((W, new_h), Image.NEAREST)
    result = np.zeros((H, W, 4), dtype=np.uint8)
    scaled_arr = np.array(scaled)
    if new_h >= H:
        result[:, :, :] = scaled_arr[new_h-H:, :, :]
    else:
        result[H-new_h:, :, :] = scaled_arr
    return Image.fromarray(result, "RGBA")


def apply_walk_bob(sprite_rgba, t, bob_speed=4.0, bob_amp=3.0):
    """Vertical bob for walking — body rises and falls with each step."""
    arr = np.array(sprite_rgba)
    alpha = arr[:, :, 3]
    ys, xs = np.where(alpha > 0)
    if len(ys) == 0:
        return sprite_rgba
    top, bottom = ys.min(), ys.max()
    content_h = bottom - top + 1
    content = arr[top:bottom+1, :, :]
    offset = int(bob_amp * abs(math.sin(t * bob_speed)))
    result = np.zeros((H, W, 4), dtype=np.uint8)
    new_top = bottom - content_h + 1 - offset
    if new_top < 0:
        new_top = 0
    result[new_top:new_top+content_h, :, :] = content
    return Image.fromarray(result, "RGBA")


def apply_color_grade(sprite_rgba, tint):
    arr = np.array(sprite_rgba).astype(np.float32)
    arr[:, :, 0] *= tint[0]
    arr[:, :, 1] *= tint[1]
    arr[:, :, 2] *= tint[2]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def load_frames(names, folder=FRAMES_DIR):
    return {n: Image.open(os.path.join(folder, f"{n}.png")).convert("RGBA") for n in names}


def composite_frame(flame_buf, sprite_rgba, halo_color=(30, 110, 180), rim_color=(40, 130, 200)):
    alpha = np.array(sprite_rgba)[:, :, 3]
    opaque = alpha > 0
    outside = ~opaque
    dist_out = distance_transform_edt(outside)
    halo = np.clip(1.0 - dist_out / 5.0, 0, 1) * outside.astype(float)
    flame_img = np.array(Image.fromarray(flame_buf, "RGB")).astype(np.int32)
    flame_img[:, :, 0] = np.clip(flame_img[:, :, 0] + (halo * halo_color[0]).astype(int), 0, 255)
    flame_img[:, :, 1] = np.clip(flame_img[:, :, 1] + (halo * halo_color[1]).astype(int), 0, 255)
    flame_img[:, :, 2] = np.clip(flame_img[:, :, 2] + (halo * halo_color[2]).astype(int), 0, 255)
    bg = Image.fromarray(np.clip(flame_img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    bg.paste(sprite_rgba, (0, 0), sprite_rgba)
    comp = np.array(bg.convert("RGB")).astype(np.int32)
    a_pad = np.pad(alpha, 1, mode="constant", constant_values=0)
    interior = (a_pad[1:-1, 1:-1] > 0)
    neigh_trans = ((a_pad[:-2, 1:-1] == 0) | (a_pad[2:, 1:-1] == 0) |
                   (a_pad[1:-1, :-2] == 0) | (a_pad[1:-1, 2:] == 0))
    edge = interior & neigh_trans
    a_pad2 = np.pad(alpha, 2, mode="constant", constant_values=0)
    inner1 = (a_pad2[2:-2, 2:-2] > 0)
    ring2 = inner1 & (~interior)
    comp[edge, 0] = np.clip(comp[edge, 0] + rim_color[0], 0, 255)
    comp[edge, 1] = np.clip(comp[edge, 1] + rim_color[1], 0, 255)
    comp[edge, 2] = np.clip(comp[edge, 2] + rim_color[2], 0, 255)
    comp[ring2, 0] = np.clip(comp[ring2, 0] + rim_color[0]//2, 0, 255)
    comp[ring2, 1] = np.clip(comp[ring2, 1] + rim_color[1]//2, 0, 255)
    comp[ring2, 2] = np.clip(comp[ring2, 2] + rim_color[2]//2, 0, 255)
    return Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8), "RGB")


def apply_screen_shake(img, t, shake_intensity=0.0):
    if shake_intensity <= 0:
        return img
    dx = int(random.uniform(-shake_intensity, shake_intensity))
    dy = int(random.uniform(-shake_intensity, shake_intensity))
    if dx == 0 and dy == 0:
        return img
    arr = np.array(img)
    result = np.zeros_like(arr)
    h, w = arr.shape[:2]
    src_x0 = max(0, dx); src_x1 = min(w, w + dx)
    src_y0 = max(0, dy); src_y1 = min(h, h + dy)
    dst_x0 = max(0, -dx); dst_y0 = max(0, -dy)
    result[dst_y0:dst_y0+(src_y1-src_y0), dst_x0:dst_x0+(src_x1-src_x0)] = \
        arr[src_y0:src_y1, src_x0:src_x1]
    return Image.fromarray(result, "RGB")


def make_cycle(keyframes, frames, n_out, fps, columns, sparks, fg_sparks, lightning,
               out_path, t_start=0.0, t_per_frame=0.08,
               flame_intensity=1.0, glow_intensity=1.0, spark_active=True,
               breath_speed=2.0, breath_amp=0.015,
               walk_bob=False, bob_speed=4.0, bob_amp=3.0,
               color_tint=(1.0, 1.0, 1.0),
               thought_active=False, thought_particles=None,
               shake_intensity=0.0,
               halo_color=(30, 110, 180), rim_color=(40, 130, 200)):
    imgs = []
    nk = len(keyframes)
    for i in range(n_out):
        t = t_start + i * t_per_frame
        pos = (i / n_out) * nk
        k0r, k1r, s = keyframe_blend(pos, blend_frac=0.22)
        k0 = k0r % nk
        k1 = k1r % nk
        sprite = cross_fade_sprites([frames[keyframes[k0]], frames[keyframes[k1]]], [1 - s, s])
        if walk_bob:
            sprite = apply_walk_bob(sprite, t, bob_speed, bob_amp)
        else:
            sprite = apply_breathing(sprite, t, breath_speed, breath_amp)
        if color_tint != (1.0, 1.0, 1.0):
            sprite = apply_color_grade(sprite, color_tint)
        flame = build_blue_flame_field(t, columns, sparks, lightning, flame_intensity, glow_intensity, t_per_frame)
        comp = composite_frame(flame, sprite, halo_color, rim_color)
        if spark_active and fg_sparks is not None:
            comp_arr = np.array(comp).astype(np.int32)
            render_foreground_sparks(comp_arr, fg_sparks)
            comp = Image.fromarray(np.clip(comp_arr, 0, 255).astype(np.uint8), "RGB")
        if thought_active and thought_particles is not None:
            comp_arr = np.array(comp).astype(np.int32)
            render_thought_particles(comp_arr, thought_particles)
            comp = Image.fromarray(np.clip(comp_arr, 0, 255).astype(np.uint8), "RGB")
        if shake_intensity > 0:
            comp = apply_screen_shake(comp, t, shake_intensity)
        imgs.append(comp.resize((W * OUT_SCALE, H * OUT_SCALE), Image.NEAREST))
    imgs[0].save(out_path, save_all=True, append_images=imgs[1:],
                 duration=int(1000 / fps), loop=0)
    return os.path.getsize(out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    names = ["idle_neutral","idle_roar","sleep_rest","idle_thinking","working_focus",
             "victory_howl","walk_left","walk_right","idle_snarl",
             "idle_calm","idle_tense","attack_recover","sleep_stir","attack_overdrive","victory_howl2"]
    frames = load_frames(names)

    columns = []
    for x in range(8, W, 10):
        columns.append(BlueFlameColumn(x, H - 4, random.uniform(5, 9), random.uniform(28, 46),
                                       random.uniform(3, 6), random.uniform(0, 6.28)))
    for x in [28, 48, 64, 80, 100]:
        columns.append(BlueFlameColumn(x, H - 40, random.uniform(6, 10), random.uniform(50, 72),
                                       random.uniform(2.5, 5), random.uniform(0, 6.28)))

    sparks = [Spark() for _ in range(80)]
    for _ in range(80):
        for e in sparks:
            e.update()
    fg_sparks = [Spark() for _ in range(46)]
    for e in fg_sparks:
        e.reset_fg()
    for _ in range(80):
        for e in fg_sparks:
            e.update()

    # Lightning bolts — 4 prominent bolts around the beast
    lightning = [
        LightningBolt(30, H - 20, 60, (-0.5, 0.1)),
        LightningBolt(98, H - 20, 60, (-0.1, 0.5)),
        LightningBolt(50, H - 30, 50, (-0.3, 0.3)),
        LightningBolt(78, H - 30, 50, (-0.3, 0.3)),
    ]

    thought_particles = [ThoughtParticle() for _ in range(64)]
    for _ in range(60):
        for p in thought_particles:
            p.update()

    states = {
        "idle": {
            "keys": ["idle_neutral","idle_calm","idle_thinking","idle_neutral","idle_roar",
                     "idle_neutral","idle_calm","idle_thinking","idle_neutral"],
            "n": 144, "fps": 24, "t_per_frame": 0.08,
            "flame": 1.0, "glow": 1.0, "sparks": True,
            "breath_speed": 2.0, "breath_amp": 0.015,
            "tint": (1.0, 1.0, 1.0), "shake": 0.0,
            "halo": (30, 110, 180), "rim": (40, 130, 200),
            "walk": False,
        },
        "thinking": {
            "keys": ["idle_neutral","idle_calm","idle_thinking","idle_neutral","idle_calm",
                     "idle_thinking","idle_neutral","idle_calm","idle_thinking","idle_neutral"],
            "n": 192, "fps": 24, "t_per_frame": 0.12,
            "flame": 0.25, "glow": 0.35, "sparks": False,
            "breath_speed": 1.2, "breath_amp": 0.02,
            "tint": (0.85, 0.92, 1.15), "shake": 0.0,
            "thought": True,
            "halo": (20, 90, 160), "rim": (30, 110, 180),
            "walk": False,
        },
        "working": {
            "keys": ["working_focus","idle_tense","idle_roar","working_focus","idle_snarl",
                     "working_focus","idle_tense","idle_roar","working_focus","idle_snarl"],
            "n": 96, "fps": 24, "t_per_frame": 0.05,
            "flame": 1.3, "glow": 1.2, "sparks": True,
            "breath_speed": 3.5, "breath_amp": 0.012,
            "tint": (0.95, 1.05, 1.12), "shake": 0.0,
            "halo": (40, 130, 210), "rim": (50, 150, 230),
            "walk": False,
        },
        "sleeping": {
            "keys": ["sleep_rest","sleep_stir","sleep_rest","sleep_rest"],
            "n": 144, "fps": 24, "t_per_frame": 0.15,
            "flame": 0.12, "glow": 0.15, "sparks": False,
            "breath_speed": 0.8, "breath_amp": 0.025,
            "tint": (0.72, 0.76, 0.82), "shake": 0.0,
            "halo": (15, 50, 90), "rim": (20, 60, 100),
            "walk": False,
        },
        "attack": {
            "keys": ["idle_neutral","idle_tense","idle_roar","idle_snarl","attack_overdrive",
                     "idle_roar","attack_recover","idle_neutral"],
            "n": 144, "fps": 24, "t_per_frame": 0.06,
            "flame": 1.5, "glow": 1.4, "sparks": True,
            "breath_speed": 4.0, "breath_amp": 0.01,
            "tint": (0.92, 1.08, 1.18), "shake": 1.5,
            "halo": (50, 150, 230), "rim": (60, 170, 250),
            "walk": False,
        },
        "victory": {
            "keys": ["idle_neutral","idle_roar","victory_howl","victory_howl2","victory_howl",
                     "idle_roar","idle_neutral"],
            "n": 120, "fps": 24, "t_per_frame": 0.08,
            "flame": 1.2, "glow": 1.3, "sparks": True,
            "breath_speed": 2.5, "breath_amp": 0.018,
            "tint": (0.96, 1.04, 1.10), "shake": 0.0,
            "halo": (35, 120, 190), "rim": (45, 140, 210),
            "walk": False,
        },
        "error": {
            "keys": ["idle_roar","idle_tense","working_focus","attack_overdrive","idle_roar","idle_snarl"],
            "n": 72, "fps": 24, "t_per_frame": 0.04,
            "flame": 1.6, "glow": 1.5, "sparks": True,
            "breath_speed": 5.0, "breath_amp": 0.008,
            "tint": (1.10, 0.85, 0.88), "shake": 2.5,
            "halo": (180, 40, 60), "rim": (200, 50, 70),
            "walk": False,
        },
        "walk": {
            "keys": ["walk_left","walk_right","walk_left","walk_right"],
            "n": 96, "fps": 24, "t_per_frame": 0.06,
            "flame": 0.8, "glow": 0.9, "sparks": True,
            "breath_speed": 2.0, "breath_amp": 0.015,
            "tint": (1.0, 1.0, 1.0), "shake": 0.0,
            "halo": (30, 110, 180), "rim": (40, 130, 200),
            "walk": True, "bob_speed": 4.0, "bob_amp": 3.0,
        },
    }

    for name, cfg in states.items():
        size = make_cycle(
            cfg["keys"], frames, cfg["n"], cfg["fps"], columns, sparks, fg_sparks, lightning,
            os.path.join(OUT_DIR, f"alpha_{name}.gif"), t_start=hash(name) % 100,
            t_per_frame=cfg["t_per_frame"],
            flame_intensity=cfg["flame"], glow_intensity=cfg["glow"],
            spark_active=cfg["sparks"],
            breath_speed=cfg["breath_speed"], breath_amp=cfg["breath_amp"],
            walk_bob=cfg.get("walk", False),
            bob_speed=cfg.get("bob_speed", 4.0), bob_amp=cfg.get("bob_amp", 3.0),
            color_tint=cfg["tint"],
            thought_active=cfg.get("thought", False), thought_particles=thought_particles,
            shake_intensity=cfg["shake"],
            halo_color=cfg["halo"], rim_color=cfg["rim"],
        )
        print(f"alpha_{name}.gif: {size} bytes ({cfg['n']} frames @{cfg['fps']}fps)")

    print("done")


if __name__ == "__main__":
    main()

// Tiny zero-dependency PNG chart renderer for Discord attachments.
// RGBA canvas → PNG via node:zlib. No fonts, no axes labels — titles and
// legends live in the embed text; the image carries the shape of the data.
import zlib from "node:zlib";

// ── PNG encoding ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export class Canvas {
  constructor(width, height, bg = [0x2b, 0x2d, 0x31, 255]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  set(x, y, [r, g, b, a = 255]) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
  }

  fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) this.set(xx, yy, color);
  }

  line(x0, y0, x1, y1, color, thick = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let t = -Math.floor(thick / 2); t <= Math.floor(thick / 2); t += 1) {
        this.set(x0 + (dy === 0 ? 0 : t), y0 + (dy === 0 ? t : 0), color);
        this.set(x0 + t, y0, color);
        this.set(x0, y0 + t, color);
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  png() {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (this.width * 4 + 1)] = 0; // filter: none
      this.data.copy(raw, y * (this.width * 4 + 1) + 1, y * this.width * 4, (y + 1) * this.width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0))
    ]);
  }
}

// ── charts ───────────────────────────────────────────────────────────
const PALETTE = [
  [87, 242, 135, 255],   // green
  [88, 101, 242, 255],   // blurple
  [243, 156, 18, 255],   // amber
  [231, 76, 60, 255],    // red
  [155, 89, 182, 255]    // purple
];
const GRID = [70, 73, 80, 255];
const AXIS = [148, 155, 164, 255];

// series: [{ points: [numbers], kind: "line"|"bar" }]
// Returns a PNG Buffer sized for a crisp Discord inline preview.
export function renderChart({ series = [], width = 720, height = 260, pad = 16 } = {}) {
  const c = new Canvas(width, height);
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const all = series.flatMap((s) => s.points).filter((v) => Number.isFinite(v));
  const max = Math.max(1e-9, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const y = (v) => pad + plotH - ((v - min) / span) * plotH;

  // grid: 4 horizontal lines + baseline
  for (let g = 0; g <= 4; g += 1) {
    const gy = pad + (plotH * g) / 4;
    c.line(pad, gy, pad + plotW, gy, GRID);
  }
  c.line(pad, pad + plotH, pad + plotW, pad + plotH, AXIS);
  c.line(pad, pad, pad, pad + plotH, AXIS);

  series.forEach((s, si) => {
    const color = s.color ?? PALETTE[si % PALETTE.length];
    const n = s.points.length;
    if (n === 0) return;
    if (s.kind === "bar") {
      const bw = Math.max(2, Math.floor(plotW / Math.max(1, n) * 0.6));
      s.points.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = pad + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)) - bw / 2;
        const top = y(v);
        c.fillRect(Math.round(x), Math.round(top), bw, Math.max(1, Math.round(pad + plotH - top)), color);
      });
    } else {
      let prev = null;
      s.points.forEach((v, i) => {
        if (!Number.isFinite(v)) { prev = null; return; }
        const x = pad + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
        const py = y(v);
        if (prev) c.line(prev[0], prev[1], x, py, color, 2);
        c.fillRect(Math.round(x) - 1, Math.round(py) - 1, 3, 3, color);
        prev = [x, py];
      });
    }
  });
  return c.png();
}

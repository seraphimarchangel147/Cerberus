#!/usr/bin/env node
// Ambient Activity → PNG chart (zero dependencies).
// Pulls /observations/timeline (last 24h) + /observations/stats from the local
// daemon and renders a stacked hourly bar chart to a PNG file.
// Output path: $OUT or ~/.openagi/workspace/ambient-activity.png
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE = process.env.OPENAGI_BASE_URL || "http://127.0.0.1:43210";
const OUT =
  process.env.OUT ||
  path.join(os.homedir(), ".openagi", "workspace", "ambient-activity.png");

function getJson(route) {
  return new Promise((resolve, reject) => {
    http
      .get(BASE + route, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("bad json from " + route + ": " + body.slice(0, 120)));
          }
        });
      })
      .on("error", reject);
  });
}

// ---------- CRC32 + minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- tiny 3x5 bitmap font (uppercase + digits + few symbols) ----------
const F = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7],
  "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7],
  "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 2, 2], "8": [7, 5, 7, 5, 7],
  "9": [7, 5, 7, 1, 7], " ": [0, 0, 0, 0, 0], "-": [0, 0, 7, 0, 0],
  ".": [0, 0, 0, 0, 2], ":": [0, 2, 0, 2, 0], "/": [1, 1, 2, 4, 4],
  "(": [1, 2, 2, 2, 1], ")": [4, 2, 2, 2, 4], "%": [5, 1, 2, 4, 5],
};

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) this.setRaw(i, bg);
  }
  setRaw(i, [r, g, b]) {
    this.px[i * 4] = r;
    this.px[i * 4 + 1] = g;
    this.px[i * 4 + 2] = b;
    this.px[i * 4 + 3] = 255;
  }
  rect(x, y, w, h, color) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++)
        this.setRaw(yy * this.w + xx, color);
  }
  text(x, y, str, color, scale = 1) {
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const g = F[ch] || F[" "];
      for (let row = 0; row < 5; row++)
        for (let col = 0; col < 3; col++)
          if (g[row] & (4 >> col)) this.rect(cx + col * scale, y + row * scale, scale, scale, color);
      cx += 4 * scale;
    }
  }
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex("#0d0d10");
const FG = hex("#d8d8dd");
const MUTED = hex("#8a8a92");
const GRID = hex("#26262c");
const PALETTE = ["#ff2b2b", "#ff7a45", "#f0b454", "#7fd4e8", "#b78bff"].map(hex);
const OTHER = hex("#55555e");

const cleanApp = (a) => String(a || "unknown").replace(/\.exe$/i, "").toLowerCase();

async function main() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [tl, stats] = await Promise.all([
    getJson("/observations/timeline?since=" + encodeURIComponent(since)),
    getJson("/observations/stats").catch(() => ({})),
  ]);
  const rows = Array.isArray(tl) ? tl : [];

  // Build 24 consecutive hour buckets ending at the current hour (UTC).
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const hours = [];
  for (let i = 23; i >= 0; i--) hours.push(new Date(now.getTime() - i * 3600 * 1000).toISOString().slice(0, 13));
  const byHour = new Map(hours.map((h) => [h, {}]));
  const appTotals = new Map();
  for (const r of rows) {
    const app = cleanApp(r.app);
    const cell = byHour.get(r.hour);
    if (cell) cell[app] = (cell[app] || 0) + r.n;
    appTotals.set(app, (appTotals.get(app) || 0) + r.n);
  }
  const topApps = [...appTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
  const colorOf = (app) => {
    const i = topApps.indexOf(app);
    return i >= 0 ? PALETTE[i] : OTHER;
  };
  const totalEvents = [...appTotals.values()].reduce((a, b) => a + b, 0);

  const W = 960, H = 440;
  const c = new Canvas(W, H, BG);
  const chartX = 50, chartY = 46, chartW = W - chartX - 20, chartH = 300;
  const bottom = chartY + chartH;
  const maxTotal = Math.max(1, ...hours.map((h) => Object.values(byHour.get(h)).reduce((a, b) => a + b, 0)));

  // gridlines
  for (const frac of [0.5, 1]) {
    const y = Math.round(bottom - chartH * frac);
    c.rect(chartX, y, chartW, 1, GRID);
  }
  // bars
  const step = chartW / 24;
  hours.forEach((h, i) => {
    const cell = byHour.get(h);
    let y = bottom;
    const x = Math.round(chartX + i * step) + 2;
    const bw = Math.max(2, Math.round(step) - 5);
    const entries = Object.entries(cell).sort((a, b) => topApps.indexOf(a[0]) - topApps.indexOf(b[0]));
    for (const [app, n] of entries) {
      const hh = Math.max(1, Math.round((n / maxTotal) * chartH));
      y -= hh;
      c.rect(x, y, bw, hh, colorOf(app));
    }
  });
  // axis
  c.rect(chartX, bottom, chartW, 1, MUTED);
  // hour ticks every 6h
  hours.forEach((h, i) => {
    if (i % 6 !== 0) return;
    const label = h.slice(11) + "00";
    c.text(Math.round(chartX + i * step), bottom + 8, label, MUTED);
  });
  // title + totals
  c.text(chartX, 16, "AMBIENT ACTIVITY - LAST 24H", FG, 2);
  c.text(W - 200, 18, "EVENTS " + totalEvents, MUTED);
  // legend
  let lx = chartX;
  const ly = bottom + 32;
  for (const app of topApps) {
    c.rect(lx, ly, 10, 10, colorOf(app));
    c.text(lx + 14, ly + 2, app, FG);
    lx += 14 + app.length * 4 + 22;
  }
  if (appTotals.size > topApps.length) {
    c.rect(lx, ly, 10, 10, OTHER);
    c.text(lx + 14, ly + 2, "other", MUTED);
  }
  // footer
  c.text(chartX, H - 22, "SOURCE " + cleanApp(stats.mode || "observation-store") + " - GENERATED " + new Date().toISOString().slice(0, 16).replace("T", " ") + "Z", MUTED);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, encodePng(W, H, c.px));
  console.log(JSON.stringify({ out: OUT, events: totalEvents, topApps, mode: stats.mode || "?" }));
}

main().catch((e) => {
  console.error("chart failed:", e.message);
  process.exit(1);
});

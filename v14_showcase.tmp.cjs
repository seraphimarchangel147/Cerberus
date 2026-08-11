#!/usr/bin/env node
/** v14 showcase capture — visual proof of every shipped feature, all from the
 * live deployed page. Emits PNGs into /tmp/v14_show/. */
const { chromium } = require("playwright");
const fs = require("fs");

const OUT = "/tmp/v14_show";
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

  await page.goto("http://127.0.0.1:43210/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2600);

  const probe = () => page.evaluate(() => window.__cerbProbe ? window.__cerbProbe() : null);
  const canvasBox = () => page.evaluate(() => {
    const c = document.getElementById("cerbPet");
    if (!c) return null;
    const isOffscreen = (el) => {
      let n = el;
      while (n) {
        const s = getComputedStyle(n);
        if (s.display === "none" || s.visibility === "hidden") return true;
        n = n.parentElement;
      }
      return false;
    };
    if (isOffscreen(c)) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  const snap = async (name, box) => {
    if (!box) { console.log("SKIP", name, "(pet canvas offscreen)"); return; }
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: box });
  };
  /* head region of the 480x480 display canvas: eyes sit ~14-18% down */
  const headClip = async () => {
    const b = await canvasBox();
    return b && { x: b.x, y: b.y, width: b.width, height: Math.round(b.height * 0.55) };
  };

  /* ── 1. PUPIL TRACKING (OMEGA): mouse far left vs far right ── */
  await page.mouse.move(20, 150);
  await page.waitForTimeout(1000);
  let p = await probe();
  console.log("left shot: gaze settled, flick", Math.round(p.flick));
  await snap("01_pupils_LEFT", await headClip());

  await page.mouse.move(1480, 850);
  await page.waitForTimeout(1000);
  await snap("02_pupils_RIGHT", await headClip());

  /* ── 2. CURIOSITY BEAT: park mouse neutral, catch the dart window ── */
  await page.mouse.move(20, 150);   /* neutral: pupils pulled left by cursor */
  await page.waitForTimeout(800);
  let got = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !got) {
    p = await probe();
    const t = Math.round(p.flick) % 768;
    if (t >= 8 && t <= 26) {       /* inside the 48-tick dart, early half */
      await snap("03_curiosity_DART", await headClip());
      console.log("dart caught at t=", t);
      got = true;
    } else {
      await page.waitForTimeout(15);
    }
  }
  /* control: just outside the window */
  const dl2 = Date.now() + 30000;
  while (Date.now() < dl2) {
    p = await probe();
    const t = Math.round(p.flick) % 768;
    if (t >= 300 && t <= 320) {
      await snap("03b_curiosity_CALM", await headClip());
      console.log("calm control at t=", t);
      break;
    }
    await page.waitForTimeout(15);
  }

  /* ── 3. CONTRACT FIX: FX on a REAL dissolve window vs a hold frame ── */
  const whiteCount = () => page.evaluate(() => {
    const c = document.getElementById("cerbPet");
    if (!c) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let w = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) w++;
    }
    return w;
  });
  const catchIdx = async (want) => {
    await page.reload({ waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1600);
    const dl = Date.now() + 10000;
    while (Date.now() < dl) {
      const q = await probe();
      if (q && q.indices && q.indices.omega === want) return true;
      await page.waitForTimeout(6);
    }
    return false;
  };
  /* FX-active: idx 20 sits inside the REAL window 16-31 */
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await catchIdx(20)) {
      const w = await whiteCount();
      if (w > 150) {
        await snap("04_FX_ACTIVE", await canvasBox());
        console.log("FX-active captured, white=", w);
        break;
      }
    }
  }
  /* FX-quiet: idx 4 is a plain hold */
  if (await catchIdx(4)) {
    await snap("05_FX_QUIET", await canvasBox());
    console.log("FX-quiet captured");
  }

  /* ── 4. ALPHA: frost wisps + pupils (stage 4 via persisted settings) ── */
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("cerbPetSettings") || "{}");
    saved.stage = 4;
    localStorage.setItem("cerbPetSettings", JSON.stringify(saved));
  });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2600);
  p = await probe();
  console.log("alpha stage:", p.stage, "row:", p.rows.alpha);
  await page.mouse.move(20, 150);
  await page.waitForTimeout(900);
  await snap("06_alpha_frost_LEFT", await canvasBox());
  await page.mouse.move(1480, 850);
  await page.waitForTimeout(900);
  await snap("07_alpha_frost_RIGHT", await canvasBox());

  console.log("ERRORS:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

/** FORGE proof-of-concept capture: load the rigged 3D creature, walk through
    one full procedural cycle, capture frames at fixed phases, assemble GIF. */
const { chromium } = require("playwright");
const fs = require("fs");
const GIF = require("gif-encoder-2");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--use-gl=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto("http://127.0.0.1:45210/harness.html", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.title === "FORGE ready", { timeout: 20000 });

  /* sanity probe */
  const info = await page.evaluate(() => ({
    title: document.title,
    hasForge: !!window.__forge,
    lw: window.__forge ? window.__forge.LW : 0,
  }));
  console.log("harness:", JSON.stringify(info));

  const N = 16;
  const frames = [];
  for (let i = 0; i < N; i++) {
    const p = i / N;
    await page.evaluate((ph) => window.__forge.setPhase(ph), p);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 480 } });
    frames.push(buf);
  }

  /* assemble GIF with pngjs-decoded frames */
  const PNG = require("pngjs").PNG;
  const encoder = new GIF(480, 480, "neuquant", false);
  const out = fs.createWriteStream("/tmp/forge_walk.gif");
  encoder.createReadStream().pipe(out);
  encoder.setDelay(83);   /* ~12fps */
  encoder.setRepeat(0);
  encoder.start();
  for (const buf of frames) {
    const png = PNG.sync.read(buf);
    encoder.addFrame(png.data);
  }
  encoder.finish();
  await new Promise((r) => out.on("finish", r));

  /* also save phase snapshots as PNGs for inspection */
  fs.mkdirSync("/tmp/forge_show", { recursive: true });
  fs.writeFileSync("/tmp/forge_show/phase_000.png", frames[0]);
  fs.writeFileSync("/tmp/forge_show/phase_025.png", frames[4]);
  fs.writeFileSync("/tmp/forge_show/phase_050.png", frames[8]);
  fs.writeFileSync("/tmp/forge_show/phase_075.png", frames[12]);

  console.log("GIF bytes:", fs.statSync("/tmp/forge_walk.gif").size);
  console.log("ERRORS:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

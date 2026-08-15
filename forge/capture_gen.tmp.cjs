/** FORGE generated-mesh capture: turntable around the AI-generated Cerberus. */
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

  await page.goto("http://127.0.0.1:45210/harness_gen.html", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.title === "FORGE gen ready", { timeout: 30000 });

  const info = await page.evaluate(() => ({
    title: document.title,
    ready: window.__forge.ready(),
    mesh: window.__forge.meshInfo(),
  }));
  console.log("harness:", JSON.stringify(info));

  const N = 16;
  const frames = [];
  let voxTotal = 0;
  for (let i = 0; i < N; i++) {
    const p = i / N;
    const v = await page.evaluate((ph) => window.__forge.setPhase(ph), p);
    voxTotal += v;
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 480 } });
    frames.push(buf);
  }
  console.log("avg voxels/frame:", Math.round(voxTotal / N));

  const PNG = require("pngjs").PNG;
  const encoder = new GIF(480, 480, "neuquant", false);
  const out = fs.createWriteStream("/tmp/forge_gen_turntable.gif");
  encoder.createReadStream().pipe(out);
  encoder.setDelay(90);
  encoder.setRepeat(0);
  encoder.start();
  for (const buf of frames) {
    const png = PNG.sync.read(buf);
    encoder.addFrame(png.data);
  }
  encoder.finish();
  await new Promise((r) => out.on("finish", r));

  fs.mkdirSync("/tmp/forge_gen_show", { recursive: true });
  fs.writeFileSync("/tmp/forge_gen_show/turn_000.png", frames[0]);
  fs.writeFileSync("/tmp/forge_gen_show/turn_025.png", frames[4]);
  fs.writeFileSync("/tmp/forge_gen_show/turn_050.png", frames[8]);
  fs.writeFileSync("/tmp/forge_gen_show/turn_075.png", frames[12]);

  console.log("GIF bytes:", fs.statSync("/tmp/forge_gen_turntable.gif").size);
  console.log("ERRORS:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

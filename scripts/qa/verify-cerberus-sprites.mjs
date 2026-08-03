/**
 * Visual + behavioural verification for the Cerberus runtime sprite atlas.
 *
 * Renders the live dashboard in a real Chromium, forces the pet through every
 * evolved form and engine state, and asserts against the RENDERER'S OWN state
 * rather than against pixels: the procedural FX (flame wall, corona, crystal
 * wall) repaint the whole canvas every frame, so a naive pixel probe measures
 * the compositor, not the atlas. Screenshots are captured for eyeballing.
 */
import fs from "node:fs";

/* playwright is an OPTIONAL dependency (see package.json), so a plain top-level
   import makes this whole gate unrunnable — with a module-resolution stack
   trace, not a diagnosis — on any checkout that installed without optionals.
   Skip loudly with a fix instruction instead, and reserve exit 1 for real
   verification failures so CI can tell "not run" from "regressed". */
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIP  cerberus sprite verification — optional dependency 'playwright' is not installed.");
  console.log("      Install it with:  npm install --include=optional playwright && npx playwright install chromium");
  process.exit(0);
}

const URL = process.argv[2] ?? "http://127.0.0.1:43210/";
const OUT = "/tmp/cerb-shots";
fs.mkdirSync(OUT, { recursive: true });

const fail = [];
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) fail.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const assetReqs = [];
page.on("response", (r) => {
  if (r.url().includes("/assets/cerberus/")) {
    assetReqs.push({ url: r.url().split("/").pop(), status: r.status() });
  }
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// The dashboard keeps an SSE stream open, so "networkidle" never fires.
await page.goto(URL, { waitUntil: "domcontentloaded" });

// The atlas loads via fetch + Image decode; give it a moment.
await page.waitForFunction(() => window.__cerbProbe && window.__cerbProbe().ready, null,
  { timeout: 15000 }).catch(() => {});

const probe = await page.evaluate(() => (window.__cerbProbe ? window.__cerbProbe() : null));
check("probe hook exposed", probe !== null, probe ? JSON.stringify(probe.forms) : "window.__cerbProbe missing");
check("atlas reported ready", probe && probe.ready === true,
  probe ? `ready=${probe.ready} failed=${probe.failed}` : "");
check("atlas fetch did not fail", probe && probe.failed === false);

// Asset transport
const json = assetReqs.find((r) => r.url.startsWith("atlas.json"));
const pngs = assetReqs.filter((r) => r.url.includes("_atlas.png"));
check("atlas.json fetched 200", !!json && json.status === 200, JSON.stringify(json));
check("both form atlases fetched 200",
  pngs.length === 2 && pngs.every((p) => p.status === 200), JSON.stringify(pngs));

// No inline base64 art left in the document
const inlineB64 = await page.evaluate(() =>
  (document.documentElement.outerHTML.match(/data:image\/png;base64/g) || []).length);
check("no inline base64 sprite art in DOM", inlineB64 === 0, `count=${inlineB64}`);

// Drive every form + state and confirm the atlas frame actually advances and
// that each engine state maps to the expected art row.
const FORMS = [{ stage: 3, form: "omega" }, { stage: 4, form: "alpha" }];
const STATES = ["idle", "running", "review", "failed", "waving", "jumping", "waiting"];

for (const { stage, form } of FORMS) {
  await page.evaluate((s) => window.cerbPetSetForm(s), stage);
  await page.waitForTimeout(400);

  /* Park the cursor ON the pet before asserting rows. The side/walk row is
     selected by LOCOMOTION, not by engine state — if the pet is mid-chase the
     walk row legitimately wins over the state's own art, and every alias
     assertion below fails for a reason that has nothing to do with the atlas.
     Without this the alias check is untestable: it was measuring the mouse. */
  await page.evaluate(() => {
    const p = window.__cerbProbe();
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: p.petX, clientY: p.petY - 60 }));
  });
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => window.__cerbProbe());
  check(`${form}: pet settles out of locomotion before row assertions`,
    settled.moving === false, `moving=${settled.moving} row=${settled.rows[form]}`);

  for (const st of STATES) {
    await page.evaluate((s) => window.cerbPetSetState(s), st);
    await page.waitForTimeout(120);
    const a = await page.evaluate(() => window.__cerbProbe());
    await page.waitForTimeout(700);
    const b = await page.evaluate(() => window.__cerbProbe());

    const rowA = a.rows[form], rowB = b.rows[form];
    check(`${form}/${st}: renders from atlas`, !!rowB && !!b.frames[form],
      `row=${rowB} frame=${b.frames[form]}`);
    // Compare against the state the engine is ACTUALLY in at read time. Some
    // states are transient (the engine drops out of "jumping" on its own), so
    // asserting against the requested state would be testing the test.
    check(`${form}/${st}: row matches manifest alias`,
      rowB === b.alias[b.state], `state=${b.state} row=${rowB}, alias says ${b.alias[b.state]}`);
    // Looping rows must advance. Sample repeatedly rather than taking two
    // point reads: the engine can re-enter a state (resetting the cursor to
    // frame 0), so a single before/after pair can land on 0 -> 0 by chance.
    // Collecting distinct indices over a window proves playback is running.
    if (b.looping[form] && rowA === rowB) {
      const seen = await page.evaluate(async (f) => {
        const s = new Set();
        for (let i = 0; i < 20; i++) {
          const p = window.__cerbProbe();
          if (p.indices[f] != null) s.add(p.indices[f]);
          await new Promise((r) => setTimeout(r, 60));
        }
        return [...s];
      }, form);
      check(`${form}/${st}: animation advances`, seen.length > 1,
        `distinct frame indices over 1.2s: [${seen.join(",")}]`);
    }
  }

  // Walk row: the side view forces "walk" independent of engine state.
  await page.evaluate(() => window.cerbPetSetState("running"));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${form}.png` });

  /* Clamped-chase regression: park the cursor in a screen corner the pet can
     never reach (its travel box is inset from the viewport). The chase target
     stays > the trigger distance forever while the position clamp eats every
     step, so a locomotion flag driven by INTENT rather than by actual
     displacement latches on and the pet walks in place indefinitely — pinning
     every state to the side/walk row. Assert the pet stops walking once it has
     stopped moving. This is the check the alias assertions above cannot make,
     because they deliberately park the mouse ON the pet. */
  await page.evaluate(() => window.cerbPetSetState("idle"));
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0, clientY: 0 })));
  /* Collect positions across the window and judge pinning from the LAST several
     samples with a small tolerance. Subpixel step aliasing makes per-second
     petX jitter by ~1px at the corner clamp, so an exact-equality break can
     never fire and the assertion would read one noisy sample. A parked pet's
     last samples sit within a few px; a walking-in-place pet's spread stays
     large, so 3px tolerance still catches the original defect. */
  const samples = [];
  for (let i = 0; i < 65; i++) {           // omega's corner walk measured ~43s; budget 65s
    await page.waitForTimeout(1000);
    samples.push(await page.evaluate(() => window.__cerbProbe()));
    if (samples.length >= 5) {
      const tail = samples.slice(-5);
      const spread = Math.max(...tail.map(s => s.petX)) - Math.min(...tail.map(s => s.petX))
                   + Math.max(...tail.map(s => s.petY)) - Math.min(...tail.map(s => s.petY));
      if (spread < 6) break;               // pinned: x+y spread < 3px each
    }
  }
  const pinned = samples[samples.length - 1];
  check(`${form}: unreachable chase target does not latch the walk row`,
    pinned && pinned.moving === false && pinned.rows[form] !== "walk",
    `pos=(${Math.round(pinned.petX)},${Math.round(pinned.petY)}) moving=${pinned.moving} row=${pinned.rows[form]}`);
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\nscreenshots -> ${OUT}`);
if (fail.length) {
  console.log(`\n${fail.length} FAILING: ${fail.join(", ")}`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");

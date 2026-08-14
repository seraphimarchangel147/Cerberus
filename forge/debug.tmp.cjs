const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
  const log = [];
  page.on("pageerror", (e) => log.push("PAGEERROR: " + e.message));
  page.on("console", (m) => log.push(m.type() + ": " + m.text()));
  page.on("requestfailed", (r) => log.push("REQFAIL: " + r.url() + " " + r.failure()?.errorText));
  await page.goto("http://127.0.0.1:45210/harness.html", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(4000);
  console.log(log.slice(0, 20).join("\n"));
  await browser.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

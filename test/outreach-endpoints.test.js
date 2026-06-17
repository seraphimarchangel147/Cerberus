// test/outreach-endpoints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

test("GET /outreach/feed?since=N returns items after the cursor", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const b = runtime.outreach.append({ type: "draft", title: "B" });
  runtime.outreach.append({ type: "draft", title: "C" });
  const res = await fetch(`${base}/outreach/feed?since=${b.seq}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(json.items.map((i) => i.title), ["C"]);
  assert.equal(json.cursor, runtime.outreach.nextSeq - 1);
  await app.close?.();
});

test("GET /outreach/digest returns the current rollup or null", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const res = await fetch(`${base}/outreach/digest`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok("digest" in json);
  await app.close?.();
});

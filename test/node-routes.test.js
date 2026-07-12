// test/node-routes.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";

// dataDir is passed explicitly everywhere below (to createDurableRuntime AND
// to createHostedInterface's options) rather than via process.env +
// resolveDataDir()'s fallback — resolveDataDir() memoizes its first result
// in a module-level cache, so mutating the env var between a "main" and a
// "node" instance in the same test process would make the second instance
// silently resolve to the first instance's directory.
async function bootApp(dataDir, opts = {}) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: opts.authToken ?? null
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base };
}

test("GET /nodes on a standalone/main instance returns a self-entry and an empty roster", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.self.role, "main");
    assert.ok(json.self.nodeId);
    assert.equal(json.self.pairedTo, null);
    assert.deepEqual(json.nodes, []);
    assert.equal(json.stale, false);
  } finally { await app.close(); }
});

test("POST /nodes/heartbeat upserts the sender, then GET /nodes includes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main2-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const hb = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://100.1.2.3:43210", version: "0.0.10" })
    });
    assert.equal(hb.status, 200);
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(json.nodes.length, 1);
    assert.equal(json.nodes[0].name, "Mac mini");
    assert.equal(json.nodes[0].status, "online");
  } finally { await app.close(); }
});

test("POST /nodes/heartbeat rejects a malformed body", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main3-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "no id or role" })
    });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test("GET /nodes on a paired instance proxies to its main and caches the result", async () => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-realmain-"));
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "other", name: "Distiller", role: "main", url: mainBase, version: "0.0.10" })
  });

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-selfnode-"));
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${nodeBase}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.self.role, "node");
    assert.equal(json.self.pairedTo, mainBase);
    assert.equal(json.stale, false);
    assert.equal(json.nodes.length, 1);
    assert.equal(json.nodes[0].name, "Distiller");

    const cached = JSON.parse(fs.readFileSync(path.join(nodeDir, "nodes", "cache.json"), "utf8"));
    assert.ok(cached.cachedAt, "proxy result was cached to disk");
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

test("GET /nodes on a paired instance falls back to the cache, marked stale, when the main is unreachable", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-staletest-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir); // port 1: nothing listens there
  fs.mkdirSync(path.join(nodeDir, "nodes"), { recursive: true });
  fs.writeFileSync(
    path.join(nodeDir, "nodes", "cache.json"),
    JSON.stringify({ self: { nodeId: "x", name: "y", role: "node", version: "0.0.9", pairedTo: "http://127.0.0.1:1" }, nodes: [{ nodeId: "other", name: "Distiller", role: "main", status: "online" }], cachedAt: new Date(Date.now() - 300000).toISOString() })
  );
  const { app, base } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.stale, true);
    assert.ok(json.cachedAt);
    assert.equal(json.nodes[0].name, "Distiller", "served from the stale cache, not empty");
  } finally { await app.close(); }
});

test("GET /nodes on a paired instance with no cache yet returns an empty-but-valid shape, not an error", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-nocache-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir);
  const { app, base } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.stale, true);
    assert.equal(json.cachedAt, null);
    assert.deepEqual(json.nodes, []);
  } finally { await app.close(); }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SecretsStore,
  TunnelWatcher,
  createDefaultRuntime,
  createDurableRuntime
} from "../src/index.js";

function runtimeOptions(dataDir, env) {
  return {
    dataDir,
    env,
    agentHost: false,
    integrations: false,
    registerDefaults: false,
    autoConnectMcp: false
  };
}

test("default runtime wires one filesystem-lazy secrets store into MCP", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = createDefaultRuntime(runtimeOptions(dataDir, {}));

  assert.ok(runtime.secrets instanceof SecretsStore);
  assert.equal(runtime.mcp.secretStore, runtime.secrets);
  assert.equal(
    fs.existsSync(path.join(dataDir, "secrets")),
    false,
    "constructing a non-durable runtime must not initialize secret storage"
  );
  await runtime.sessionIndex.ready;
});

test("durable runtime migrates and hydrates secrets before MCP config loads", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-durable-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, ".env"),
    "OPENAI_API_KEY=durable-secret-canary\nCUSTOM_VALUE=preserved\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, "mcp.json"),
    JSON.stringify({
      servers: {
        example: {
          transport: "stdio",
          command: "node",
          args: ["server.js", "${OPENAI_API_KEY}"]
        }
      }
    }),
    "utf8"
  );
  const env = {};
  const runtime = createDurableRuntime(runtimeOptions(dataDir, env));

  assert.equal(runtime.mcp.secretStore, runtime.secrets);
  assert.equal(env.OPENAI_API_KEY, "durable-secret-canary");
  assert.equal(
    runtime.secrets.getSecret("OPENAI_API_KEY", { decidedBy: "test:runtime" }),
    "durable-secret-canary"
  );
  assert.equal(runtime.mcp.listServers()[0].args[1], "${OPENAI_API_KEY}");
  const snapshot = fs.readFileSync(
    path.join(dataDir, "secrets", "secrets.json"),
    "utf8"
  );
  assert.match(snapshot, /durable-secret-canary/);
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /CUSTOM_VALUE=preserved/);
  await runtime.sessionIndex.ready;
});

test("tunnel URL persistence goes through the authoritative secrets store", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-tunnel-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const previous = process.env.OPENAGI_PUBLIC_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_PUBLIC_URL;
    else process.env.OPENAGI_PUBLIC_URL = previous;
  });
  const store = new SecretsStore({
    dataDir,
    allowlist: ["OPENAGI_PUBLIC_URL"],
    env: process.env
  });
  const watcher = new TunnelWatcher({
    dataDir,
    secretStore: store
  });
  const url = "https://phase-one.trycloudflare.com";

  watcher.applyUrl(url);

  assert.equal(
    store.getSecret("OPENAGI_PUBLIC_URL", { decidedBy: "test:tunnel" }),
    url
  );
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), new RegExp(url));
  assert.match(
    fs.readFileSync(path.join(dataDir, "secrets", "audit.jsonl"), "utf8"),
    /"decidedBy":"system:tunnel-watcher"/
  );
});

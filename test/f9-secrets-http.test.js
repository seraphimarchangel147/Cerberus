import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedInterface } from "../src/hosted-interface.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { McpRegistry } from "../src/mcp-registry.js";
import { SecretsStore } from "../src/secrets-store.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

const AUTH_TOKEN = "f9-http-auth-token";

async function startApp(t, runtime, {
  authToken = AUTH_TOKEN,
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-http-")),
  ...appOptions
} = {}) {
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    authToken,
    dataDir,
    tickerMs: 0,
    ...appOptions
  });
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return address.url;
}

function bearer(token = AUTH_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function jsonRequest(method, body, token = AUTH_TOKEN) {
  return {
    method,
    headers: {
      ...bearer(token),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function memorySecrets(allowedNames) {
  const allowed = new Set(allowedNames);
  const values = new Map();
  const assertAllowed = (name) => {
    if (!allowed.has(name)) throw new TypeError(`Unknown secret name: ${name}`);
  };
  const metadata = (name, value) => {
    const last4 = value.length > 4 ? value.slice(-4) : null;
    return {
      name,
      last4,
      preview: last4 ? `****${last4}` : "****",
      // Deliberately violate the store contract: the HTTP boundary must still
      // select only public fields if a future backend accidentally over-shares.
      value
    };
  };
  return {
    setSecret(name, value) {
      assertAllowed(name);
      values.set(name, value);
      return metadata(name, value);
    },
    listSecrets() {
      return [...values].map(([name, value]) => metadata(name, value));
    },
    removeSecret(name) {
      assertAllowed(name);
      return values.delete(name);
    }
  };
}

test("secrets HTTP surface requires auth and never echoes submitted values", async (t) => {
  const store = memorySecrets(["OPENAI_API_KEY", "OPENAGI_AUTH_TOKEN"]);
  const base = await startApp(t, { secrets: store });

  let response = await fetch(`${base}/secrets`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/secrets`, { headers: bearer("wrong-token") });
  assert.equal(response.status, 401);

  const canary = "sk-f9-http-canary-1234567890ABCD";
  response = await fetch(
    `${base}/secrets`,
    jsonRequest("POST", { name: "OPENAI_API_KEY", value: canary })
  );
  const setText = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(setText, new RegExp(canary));
  const setBody = JSON.parse(setText);
  assert.deepEqual(setBody.secret, {
    name: "OPENAI_API_KEY",
    last4: "ABCD",
    preview: "****ABCD"
  });

  response = await fetch(`${base}/secrets`, { headers: bearer() });
  const listText = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(listText, new RegExp(canary));
  assert.deepEqual(JSON.parse(listText).secrets, [setBody.secret]);

  const rejectedCanary = "unknown-f9-secret-canary";
  response = await fetch(
    `${base}/secrets`,
    jsonRequest("POST", { name: "NOT_ALLOWLISTED", value: rejectedCanary })
  );
  const rejectedText = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(rejectedText, new RegExp(rejectedCanary));
  assert.deepEqual(JSON.parse(rejectedText), { error: "unknown secret name" });

  response = await fetch(`${base}/secrets/OPENAI_API_KEY`, {
    method: "DELETE",
    headers: bearer()
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: "OPENAI_API_KEY",
    removed: true
  });

  response = await fetch(`${base}/secrets`, { headers: bearer() });
  assert.deepEqual((await response.json()).secrets, []);
});

test("secrets HTTP surface fails closed when no auth token is configured", async (t) => {
  const calls = [];
  const base = await startApp(t, {
    secrets: {
      listSecrets() {
        calls.push("list");
        return [];
      },
      setSecret() {
        calls.push("set");
        return {};
      },
      removeSecret() {
        calls.push("remove");
        return true;
      }
    }
  }, { authToken: "" });

  const requests = [
    fetch(`${base}/secrets`),
    fetch(`${base}/secrets`, jsonRequest("POST", { name: "OPENAI_API_KEY", value: "canary" })),
    fetch(`${base}/secrets/OPENAI_API_KEY`, { method: "DELETE", headers: bearer() })
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.status), [401, 401, 401]);
  assert.deepEqual(calls, [], "fail-closed auth rejects requests before touching the store");
});

test("legacy HTTP configuration surfaces do not reflect stored or submitted secrets", async (t) => {
  const storedCanary = "corrupt-snapshot-secret-canary";
  const submittedCanary = "submitted-setup-secret-canary";
  const store = {
    initialize() {
      throw new SyntaxError(`invalid snapshot near ${storedCanary}`);
    },
    listSecretNames() {
      throw new SyntaxError(`invalid snapshot near ${storedCanary}`);
    }
  };
  const base = await startApp(t, { secrets: store }, {
    publicUrl: "https://agent.example",
    buildBetterWebhookSecret: storedCanary
  });

  let response = await fetch(
    `${base}/setup/save`,
    jsonRequest("POST", { OPENAI_API_KEY: submittedCanary })
  );
  let text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(text, new RegExp(`${storedCanary}|${submittedCanary}`));

  response = await fetch(
    `${base}/integrations/connect-mcp`,
    jsonRequest("POST", { catalogId: "stripe", apiKey: submittedCanary })
  );
  text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(text, new RegExp(`${storedCanary}|${submittedCanary}`));

  response = await fetch(`${base}/channels`, { headers: bearer() });
  text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, new RegExp(storedCanary));
  assert.deepEqual(JSON.parse(text), {
    enabled: false,
    publicUrl: "https://agent.example",
    buildBetterWebhook: "https://agent.example/webhooks/buildbetter",
    buildBetterWebhookReady: true
  });
});

test("setup HTML is not cacheable and setup saves install an HttpOnly auth cookie", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-setup-cookie-"));
  const saved = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    auth: process.env.OPENAGI_AUTH_TOKEN
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAGI_AUTH_TOKEN;
  t.after(() => {
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openai;
    if (saved.auth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = saved.auth;
  });
  const store = new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    env: process.env
  });
  const base = await startApp(t, { secrets: store }, {
    authToken: "",
    dataDir
  });

  let response = await fetch(`${base}/setup`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const canary = "new-setup-auth-token-canary";
  response = await fetch(`${base}/setup/save`, jsonRequest(
    "POST",
    { OPENAGI_AUTH_TOKEN: canary },
    ""
  ));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(text, new RegExp(canary));
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /openagi_token=new-setup-auth-token-canary/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);

  response = await fetch(`${base}/setup/save`, jsonRequest(
    "POST",
    { OPENAI_MODEL: "gpt-test" },
    ""
  ));
  assert.equal(response.status, 200);
  const upgradedCookie = response.headers.get("set-cookie") ?? "";
  assert.match(upgradedCookie, /openagi_token=new-setup-auth-token-canary/);
  assert.match(upgradedCookie, /HttpOnly/i);
});

test("setup connectivity responses redact stored values and hide provider errors", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-setup-test-"));
  const canary = "setup-provider-reflection-canary";
  const store = new SecretsStore({
    dataDir,
    allowlist: ["OPENAI_API_KEY"],
    env: {}
  });
  store.setSecret("OPENAI_API_KEY", canary, { decidedBy: "test:seed" });
  let fail = false;
  const channels = {
    async handleLocalMessage() {
      if (fail) throw new Error(`provider reflected ${canary}`);
      return {
        reply: `<img src=x onerror=alert(1)> ${canary}`,
        model: "test-model"
      };
    },
    start() {},
    stop() {}
  };
  const base = await startApp(t, { secrets: store }, {
    dataDir,
    channels
  });

  let response = await fetch(
    `${base}/setup/test`,
    jsonRequest("POST", { text: "test" })
  );
  let text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(text, new RegExp(canary));
  assert.match(JSON.parse(text).reply, /\[REDACTED\]/);

  fail = true;
  response = await fetch(
    `${base}/setup/test`,
    jsonRequest("POST", { text: "test" })
  );
  text = await response.text();
  assert.equal(response.status, 500);
  assert.doesNotMatch(text, new RegExp(canary));
  assert.deepEqual(JSON.parse(text), {
    error: "setup connectivity test failed"
  });
});

test("paired node topology responses and caches redact a reflected pairing token", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-node-reflect-"));
  const canary = "paired-node-reflection-canary";
  let seenAuthorization = null;
  const upstream = http.createServer((req, res) => {
    seenAuthorization = req.headers.authorization ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      nodes: [{ nodeId: "reflected", name: canary, status: canary }]
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const remote = `http://127.0.0.1:${address.port}`;
  writeNodeConfig({ remote, token: canary }, dataDir);
  const store = new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    env: {}
  });
  const base = await startApp(t, { secrets: store }, {
    dataDir,
    heartbeatIntervalMs: 60_000
  });

  const response = await fetch(`${base}/nodes`, { headers: bearer() });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(seenAuthorization, `Bearer ${canary}`);
  assert.doesNotMatch(text, new RegExp(canary));
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(dataDir, "nodes", "cache.json"), "utf8"),
    new RegExp(canary)
  );
});

test("legacy node topology caches are scrubbed before an HTTP fallback response", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-node-cache-"));
  const canary = "legacy-node-cache-token-canary";
  writeNodeConfig({
    remote: "http://127.0.0.1:1",
    token: canary
  }, dataDir);
  const cachePath = path.join(dataDir, "nodes", "cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    nodes: [{ nodeId: "legacy", name: canary, status: canary }],
    cachedAt: "2026-07-23T00:00:00.000Z"
  }), "utf8");
  const store = new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    env: {}
  });
  const base = await startApp(t, { secrets: store }, {
    dataDir,
    heartbeatIntervalMs: 60_000
  });

  const response = await fetch(`${base}/nodes`, { headers: bearer() });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, new RegExp(canary));
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(fs.readFileSync(cachePath, "utf8"), new RegExp(canary));
});

test("HTTP cannot remove the live auth token", async (t) => {
  let removed = false;
  const base = await startApp(t, {
    secrets: {
      removeSecret() {
        removed = true;
        return true;
      }
    }
  });

  const response = await fetch(`${base}/secrets/OPENAGI_AUTH_TOKEN`, {
    method: "DELETE",
    headers: bearer()
  });
  assert.equal(response.status, 409);
  assert.equal(removed, false);
  assert.match((await response.json()).error, /cannot be removed/);
});

test("MCP registration returns only the non-secret public subset", async (t) => {
  const canary = "mcp-register-canary-secret";
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-mcp-"));
  t.after(() => fs.rmSync(registryDir, { recursive: true, force: true }));
  const registry = new McpRegistry({
    dataDir: registryDir,
    permittedEnvKeys: new Set(["MCP_HTTP_SECRET"])
  });
  const base = await startApp(t, { mcp: registry });

  let response = await fetch(`${base}/mcp/register`, jsonRequest("POST", {
    name: "rejected-canary-server",
    transport: "http",
    url: "https://example.com/mcp",
    apiKey: canary,
    headers: { authorization: `Bearer ${canary}` },
    env: { SERVICE_SECRET: canary }
  }));
  let text = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(text, new RegExp(canary));
  assert.equal(
    registry.listServers().some((server) => server.name === "rejected-canary-server"),
    false,
    "literal credential rejection leaves no persisted registry entry"
  );

  response = await fetch(`${base}/mcp/register`, jsonRequest("POST", {
    name: "placeholder-server",
    transport: "http",
    url: "https://example.com/mcp",
    auth: "bearer",
    apiKey: "${MCP_HTTP_SECRET}",
    headers: {
      authorization: "Bearer ${MCP_HTTP_SECRET}",
      "x-client-version": "f9-test"
    },
    env: {
      SERVICE_SECRET: "${MCP_HTTP_SECRET}",
      MODE: "readonly"
    }
  }));
  text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, new RegExp(canary));
  assert.deepEqual(JSON.parse(text), {
    name: "placeholder-server",
    transport: "http"
  });
  const registered = registry.servers.get("placeholder-server");
  assert.equal(registered.apiKey, "${MCP_HTTP_SECRET}");
  assert.equal(registered.headers.authorization, "Bearer ${MCP_HTTP_SECRET}");
  assert.equal(registered.env.SERVICE_SECRET, "${MCP_HTTP_SECRET}");
  assert.equal(registered.headers["x-client-version"], "f9-test");
  assert.equal(registered.env.MODE, "readonly");
});

test("MCP auth clearing rejects encoded traversal before touching secrets", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-f9-clear-auth-"));
  const secretsDir = path.join(dataDir, "secrets");
  const secretsPath = path.join(secretsDir, "secrets.json");
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(secretsPath, "{\"canary\":\"must-survive\"}\n", "utf8");
  const base = await startApp(t, { mcp: {} }, { dataDir });

  const response = await fetch(
    `${base}/mcp/clear-auth/%2e%2e%2f%2e%2e%2fsecrets%2fsecrets`,
    { method: "POST", headers: bearer() }
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid MCP server name" });
  assert.equal(fs.readFileSync(secretsPath, "utf8"), "{\"canary\":\"must-survive\"}\n");
});

test("MCP catalog credential checks use the secrets store as source of truth", async (t) => {
  const saved = process.env.STRIPE_MCP_API_KEY;
  process.env.STRIPE_MCP_API_KEY = "env-only-must-not-count";
  t.after(() => {
    if (saved === undefined) delete process.env.STRIPE_MCP_API_KEY;
    else process.env.STRIPE_MCP_API_KEY = saved;
  });

  let storedNames = [];
  const actors = [];
  let registered = null;
  const base = await startApp(t, {
    secrets: {
      listSecretNames({ decidedBy }) {
        actors.push(decidedBy);
        return storedNames;
      }
    },
    mcp: {
      listServers: () => [],
      allowEnvKey() {},
      registerServer(server) {
        registered = server;
        return server;
      }
    }
  });

  let response = await fetch(`${base}/integrations/status`, { headers: bearer() });
  let stripe = (await response.json()).catalog.find((entry) => entry.id === "stripe");
  assert.equal(response.status, 200);
  assert.equal(stripe.apiKeyConfigured, false, "process.env does not override an existing store");
  response = await fetch(
    `${base}/integrations/connect-mcp`,
    jsonRequest("POST", { catalogId: "stripe" })
  );
  assert.equal(response.status, 400);
  assert.equal(registered, null, "an env-only credential cannot authorize catalog registration");

  delete process.env.STRIPE_MCP_API_KEY;
  storedNames = ["STRIPE_MCP_API_KEY"];
  response = await fetch(`${base}/integrations/status`, { headers: bearer() });
  stripe = (await response.json()).catalog.find((entry) => entry.id === "stripe");
  assert.equal(stripe.apiKeyConfigured, true, "the store can configure a catalog key absent from process.env");
  response = await fetch(
    `${base}/integrations/connect-mcp`,
    jsonRequest("POST", { catalogId: "stripe" })
  );
  assert.equal(response.status, 200);
  assert.equal(registered.apiKey, "${STRIPE_MCP_API_KEY}");
  assert.ok(actors.includes("http:/integrations/status:credential-check"));
  assert.ok(actors.includes("http:/integrations/connect-mcp:credential-check"));
});

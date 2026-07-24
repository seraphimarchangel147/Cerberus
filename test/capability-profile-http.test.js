import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";

const TOKEN = "capability-profile-http-token";

function access(overrides = {}) {
  return {
    filesystem: "none",
    network: false,
    secrets: false,
    subprocess: false,
    api: false,
    ui: false,
    hooks: false,
    ...overrides
  };
}

async function request(base, route, {
  token = TOKEN,
  method = "GET",
  body
} = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-openagi-project": "default",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

test("capability HTTP administration requires auth and binding CAS", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-profile-http-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const runtime = createDefaultRuntime({
    dataDir,
    workspaceDir,
    registerDefaults: false,
    semanticBrowser: false
  });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: TOKEN,
    channels: {
      start() {},
      stop() {},
      status: () => ({ local: { enabled: true } })
    }
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { url: base } = await app.listen();

  const anonymous = await request(base, "/profiles", { token: null });
  assert.equal(anonymous.response.status, 401);

  const bundle = await request(base, "/capability-bundles", {
    method: "POST",
    body: {
      id: "workspace-read",
      name: "Workspace read",
      toolGrants: ["code_read"],
      access: access({ filesystem: "read" })
    }
  });
  assert.equal(bundle.response.status, 201);
  assert.equal(bundle.body.status, "disabled");

  const profile = await request(base, "/profiles", {
    method: "POST",
    body: {
      id: "reviewer",
      name: "Reviewer",
      activeSkills: [],
      toolGrants: [],
      capabilityBundleIds: ["workspace-read"]
    }
  });
  assert.equal(profile.response.status, 201);

  const missingCas = await request(base, "/profiles/activate", {
    method: "POST",
    body: { id: "reviewer", scope: "project" }
  });
  assert.equal(missingCas.response.status, 400);

  const activated = await request(base, "/profiles/activate", {
    method: "POST",
    body: {
      id: "reviewer",
      scope: "project",
      expectedBindingProfileId: "",
      expectedProfileRevision: 1
    }
  });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body.profileId, "reviewer");

  const stale = await request(base, "/profiles/activate", {
    method: "POST",
    body: {
      id: "reviewer",
      scope: "project",
      expectedBindingProfileId: "",
      expectedProfileRevision: 1
    }
  });
  assert.equal(stale.response.status, 409);
});

test("capability HTTP administration fails closed without a configured token", async (t) => {
  const calls = [];
  const app = createHostedInterface({
    profiles: {
      listProfiles() {
        calls.push("list");
        return [];
      }
    }
  }, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    authToken: ""
  });
  t.after(async () => app.close());
  const { url: base } = await app.listen();
  const response = await fetch(`${base}/profiles`);
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

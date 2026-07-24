import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { HashBagEmbedder } from "../src/embeddings.js";
import { createHostedInterface } from "../src/hosted-interface.js";

async function requestJson(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return {
    response,
    text,
    json: text ? JSON.parse(text) : null
  };
}

async function openEvents(base, token, projectId) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/events?project=${encodeURIComponent(projectId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    }
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async readUntil(needle, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffered.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for ${needle}`);
        let timer;
        const part = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for ${needle}`)),
              remaining
            );
          })
        ]).finally(() => clearTimeout(timer));
        if (part.done) throw new Error("SSE stream ended early");
        buffered += decoder.decode(part.value, { stream: true });
      }
      return buffered;
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  };
}

test("authenticated recipe HTTP and metadata-only SSE remain project-scoped", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-recipe-http-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const embedder = new HashBagEmbedder();
  embedder.model = "http-test";
  const runtime = createDefaultRuntime({
    dataDir,
    workspaceDir,
    embedder,
    registerDefaults: false,
    semanticBrowser: false,
    modelProvider: {
      isConfigured: () => true,
      async generate() {
        throw new Error("model provider is not used");
      }
    },
    backgroundReviewer: {}
  });
  runtime.projects.create({ id: "alpha", name: "Alpha" });
  runtime.projects.create({ id: "beta", name: "Beta" });
  const token = "recipe-http-token";
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: token,
    channels: {
      start() {},
      stop() {},
      status: () => ({ local: { enabled: true } })
    }
  });
  let stream;
  try {
    const { url: base } = await app.listen();
    stream = await openEvents(base, token, "alpha");
    const unauthorized = await requestJson(base, null, "/recipes");
    assert.equal(unauthorized.response.status, 401);

    const created = await requestJson(base, token, "/recipes", {
      method: "POST",
      headers: { "x-openagi-project": "alpha" },
      body: {
        title: "Private deploy procedure",
        summary: "Deploy the alpha service after its focused checks pass.",
        preconditions: ["The alpha release artifact is pinned."],
        actions: [
          "Inspect the pinned artifact.",
          "Run the alpha release check.",
          "Deploy only after the check succeeds."
        ],
        evidence: [{ ref: "human:http-alpha" }],
        failureModes: ["Stop on a failed release check."],
        tags: ["alpha", "deploy"]
      }
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.json.status, "candidate");
    assert.equal(created.json.projectId, "alpha");
    const id = created.json.id;

    const event = await stream.readUntil('"event":"recipe-proposed"');
    assert.match(event, /event: recipe/);
    assert.equal(event.includes("Private deploy procedure"), false);
    assert.equal(event.includes("Deploy the alpha service"), false);

    const foreign = await requestJson(base, token, `/recipes/${id}`, {
      headers: { "x-openagi-project": "beta" }
    });
    assert.equal(foreign.response.status, 404);
    assert.equal(foreign.text.includes("Private deploy procedure"), false);

    const verified = await requestJson(base, token, `/recipes/${id}/verify`, {
      method: "POST",
      headers: { "x-openagi-project": "alpha" },
      body: {
        expectedRevision: 1,
        method: "Operator observed the release check pass.",
        evidence: [{ ref: "human:http-verification" }]
      }
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.json.status, "verified");
    const fact = runtime.memory.remember({
      content: "Alpha deployment owner is the release team.",
      scope: "project:alpha",
      tags: ["alpha", "deploy"]
    });
    const facts = runtime.memory.retrieve("alpha deployment owner", {
      scope: "project:alpha"
    });
    assert.equal(facts.some((entry) => entry.item.id === id), false);
    const procedures = await runtime.recipes.recall("alpha deploy", {
      projectId: "alpha"
    });
    assert.equal(procedures.items.some((entry) => entry.id === fact.id), false);

    const search = await requestJson(
      base,
      token,
      "/recipes?q=deploy&status=verified",
      { headers: { "x-openagi-project": "alpha" } }
    );
    assert.equal(search.response.status, 200);
    assert.equal(search.json.count, 1);
    assert.equal(search.json.items[0].id, id);

    const conflict = await requestJson(base, token, `/recipes/${id}`, {
      method: "PATCH",
      headers: { "x-openagi-project": "alpha" },
      body: {
        expectedRevision: 1,
        summary: "This stale edit must fail."
      }
    });
    assert.equal(conflict.response.status, 409);
    const edited = await requestJson(base, token, `/recipes/${id}`, {
      method: "PATCH",
      headers: { "x-openagi-project": "alpha" },
      body: {
        expectedRevision: 2,
        summary: "Deploy alpha only after two focused checks pass."
      }
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.json.status, "candidate");
    assert.equal(edited.json.verification.status, "unverified");

    const exported = await requestJson(
      base,
      token,
      `/recipes/${id}/export?format=markdown`,
      { headers: { "x-openagi-project": "alpha" } }
    );
    assert.equal(exported.response.status, 200);
    assert.match(exported.json.content, /## Actions/);

    const removed = await requestJson(base, token, `/recipes/${id}`, {
      method: "DELETE",
      headers: { "x-openagi-project": "alpha" },
      body: { expectedRevision: 3 }
    });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.json.status, "deleted");
    const active = await requestJson(base, token, "/recipes?q=deploy", {
      headers: { "x-openagi-project": "alpha" }
    });
    assert.equal(active.json.count, 0);
  } finally {
    await stream?.close();
    await app.close();
  }
});

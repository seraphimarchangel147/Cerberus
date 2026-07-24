import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { registerCoreTools } from "../src/tool-registry.js";

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

async function eventStream(base, token, projectId) {
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

function temporaryRuntime(t, { registerDefaults = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-artifact-http-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createDefaultRuntime({
    dataDir,
    workspaceDir,
    registerDefaults,
    semanticBrowser: false,
    modelProvider: {
      isConfigured: () => true,
      async generate() {
        throw new Error("model provider is not used in this test");
      }
    },
    backgroundReviewer: {}
  });
  return { dataDir, root, runtime, workspaceDir };
}

test("authenticated Canvas HTTP, SSE, and branch-from-message stay project-scoped", async (t) => {
  const h = temporaryRuntime(t);
  const token = "artifact-http-test-token";
  h.runtime.projects.create({ id: "alpha", name: "Alpha" });
  h.runtime.projects.create({ id: "beta", name: "Beta" });
  const sourceSessionId = "alpha:source";
  h.runtime.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  for (const [id, role, content] of [
    ["msg_0000000000000001", "user", "first private message"],
    ["msg_0000000000000002", "assistant", "second private message"],
    ["msg_0000000000000003", "user", "excluded message"]
  ]) {
    await h.runtime.agentHost.store.appendMessage(sourceSessionId, {
      id,
      role,
      content,
      agentId: "main",
      metadata: { projectId: "alpha" }
    });
  }
  const channels = {
    start() {},
    stop() {},
    status: () => ({ local: { enabled: true } })
  };
  const originalProjectChange = h.runtime.projects.onChange;
  const app = createHostedInterface(h.runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: h.dataDir,
    authToken: token,
    channels
  });
  let stream;
  try {
    const { url: base } = await app.listen();
    stream = await eventStream(base, token, "alpha");
    const unauthorized = await requestJson(base, null, "/artifacts");
    assert.equal(unauthorized.response.status, 401);

    const created = await requestJson(base, token, "/artifacts", {
      method: "POST",
      headers: { "x-openagi-project": "alpha" },
      body: {
        kind: "markdown",
        title: "HTTP plan",
        content: "private Canvas content"
      }
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.json.projectId, "alpha");
    assert.equal(created.json.revision, 1);
    const artifactId = created.json.id;

    const artifactEvent = await stream.readUntil('"event":"artifact-created"');
    assert.match(artifactEvent, /event: artifact/u);
    assert.equal(artifactEvent.includes("private Canvas content"), false);
    assert.equal(artifactEvent.includes("HTTP plan"), false);

    const stale = await requestJson(base, token, `/artifacts/${artifactId}`, {
      method: "PATCH",
      headers: { "x-openagi-project": "alpha" },
      body: { expectedRevision: 0, content: "stale" }
    });
    assert.equal(stale.response.status, 400);
    const updated = await requestJson(base, token, `/artifacts/${artifactId}`, {
      method: "PATCH",
      headers: { "x-openagi-project": "alpha" },
      body: { expectedRevision: 1, content: "second revision" }
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.revision, 2);
    const conflict = await requestJson(base, token, `/artifacts/${artifactId}`, {
      method: "PATCH",
      headers: { "x-openagi-project": "alpha" },
      body: { expectedRevision: 1, content: "lost update" }
    });
    assert.equal(conflict.response.status, 409);

    const foreign = await requestJson(base, token, `/artifacts/${artifactId}`, {
      headers: { "x-openagi-project": "beta" }
    });
    assert.equal(foreign.response.status, 404);
    assert.equal(foreign.text.includes("second revision"), false);

    const versions = await requestJson(
      base,
      token,
      `/artifacts/${artifactId}/versions?includeContent=1`,
      { headers: { "x-openagi-project": "alpha" } }
    );
    assert.deepEqual(
      versions.json.map((revision) => revision.content),
      ["second revision", "private Canvas content"]
    );
    const restored = await requestJson(
      base,
      token,
      `/artifacts/${artifactId}/restore`,
      {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: { revision: 1, expectedRevision: 2 }
      }
    );
    assert.equal(restored.response.status, 200);
    assert.equal(restored.json.revision, 3);
    assert.equal(restored.json.content, "private Canvas content");

    const branched = await requestJson(
      base,
      token,
      `/sessions/${encodeURIComponent(sourceSessionId)}/branches`,
      {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: { messageId: "msg_0000000000000002" }
      }
    );
    assert.equal(branched.response.status, 201);
    assert.equal(branched.json.messageCount, 2);
    assert.equal(Object.hasOwn(branched.json, "messages"), false);
    const branchEvent = await stream.readUntil("event: session-branched");
    assert.equal(branchEvent.includes("first private message"), false);
    assert.equal(branchEvent.includes("second private message"), false);
    const transcript = h.runtime.agentHost.store.getSession(
      branched.json.sessionId
    );
    assert.deepEqual(
      transcript.messages.map((message) => message.id),
      ["msg_0000000000000001", "msg_0000000000000002"]
    );
    assert.equal(
      h.runtime.agentHost.store.getSession(sourceSessionId).messages.length,
      3
    );

    const missing = await requestJson(
      base,
      token,
      "/sessions/missing-session/branches",
      {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: { messageId: "msg_0000000000000002" }
      }
    );
    assert.equal(missing.response.status, 404);
    assert.equal(h.runtime.projects.hasSessionBinding("missing-session"), false);
  } finally {
    await stream?.close();
    await app.close();
    assert.equal(h.runtime.projects.onChange, originalProjectChange);
    assert.equal(h.runtime.events.listenerCount("artifact-created"), 0);
    assert.equal(h.runtime.events.listenerCount("session-branched"), 0);
    await h.runtime.close();
  }
});

test("Canvas tools are registered, project-scoped, and visible in the system prompt", async (t) => {
  const h = temporaryRuntime(t);
  const project = h.runtime.projects.create({
    id: "alpha",
    name: "Alpha",
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  });
  registerCoreTools(h.runtime.tools, h.runtime);
  const names = new Set(h.runtime.tools.list().map((tool) => tool.name));
  const expected = [
    "artifact_create",
    "artifact_list",
    "artifact_show",
    "artifact_update",
    "artifact_versions",
    "artifact_restore"
  ];
  for (const name of expected) assert.equal(names.has(name), true, name);
  const instructions = buildDefaultInstructions({
    agent: { id: "main", name: "Main", systemPrompt: "" }
  });
  for (const name of expected) assert.match(instructions, new RegExp(name, "u"));

  const context = () => {
    const current = h.runtime.projects.authorize("alpha");
    return {
      __projectId: "alpha",
      __projectRevision: current.revision,
      sessionId: null,
      agentId: "main"
    };
  };
  const created = await h.runtime.tools.invoke("artifact_create", {
    kind: "data",
    title: "Tool data",
    content: { ok: true }
  }, {
    ...context(),
    __projectRevision: project.revision
  });
  assert.equal(created.ok, true);
  assert.match(created.result.pinnedRef, /^artifact:artifact_[a-f0-9]{16}@1$/u);
  const shown = await h.runtime.tools.invoke("artifact_show", {
    id: created.result.id
  }, context());
  assert.equal(shown.ok, true);
  assert.deepEqual(shown.result.content, { ok: true });
  const foreign = h.runtime.projects.authorize("beta");
  assert.equal(foreign, null);
  await h.runtime.close();
});

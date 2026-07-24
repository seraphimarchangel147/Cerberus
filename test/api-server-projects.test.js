import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../src/api-server.js";

function projectStore() {
  const records = new Map([
    ["default", { id: "default", status: "active", revision: 1 }],
    ["alpha", { id: "alpha", status: "active", revision: 3 }],
    ["beta", { id: "beta", status: "active", revision: 7 }],
    ["retired", { id: "retired", status: "archived", revision: 9 }]
  ]);
  return {
    get(projectId, { includeArchived = true } = {}) {
      const project = records.get(projectId) ?? null;
      if (!includeArchived && project?.status === "archived") return null;
      return project ? { ...project } : null;
    }
  };
}

async function postCompletion(url, apiKey, body, headers = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test("API completion pins header-selected project identity into the agent turn", async (t) => {
  const calls = [];
  const app = createApiServer({
    apiKey: "project-api-key",
    port: 0,
    projects: projectStore(),
    agentHost: {
      async handleMessage(input) {
        calls.push(input);
        return { reply: "scoped", model: { stopReason: "completed" } };
      }
    }
  });
  t.after(() => app.close());
  const address = await app.listen();

  const response = await postCompletion(
    address.url,
    "project-api-key",
    { messages: [{ role: "user", content: "work here" }] },
    { "x-openagi-project": "Alpha" }
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, "alpha");
  assert.equal(calls[0].metadata.projectId, "alpha");
  assert.equal(calls[0].metadata.apiStream, false);
});

test("API streaming pins body-selected project identity before sending SSE", async (t) => {
  const calls = [];
  const app = createApiServer({
    apiKey: "project-stream-key",
    port: 0,
    projects: projectStore(),
    agentHost: {
      async handleMessage(input) {
        calls.push(input);
        input.onDelta("ready");
        return { reply: "ready", model: { stopReason: "completed" } };
      }
    }
  });
  t.after(() => app.close());
  const address = await app.listen();

  const response = await postCompletion(address.url, "project-stream-key", {
    projectId: "beta",
    stream: true,
    messages: [{ role: "user", content: "stream here" }]
  });
  const payload = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.match(payload, /data: \[DONE\]/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, "beta");
  assert.equal(calls[0].metadata.projectId, "beta");
  assert.equal(calls[0].metadata.apiStream, true);
});

test("API rejects conflicting, invalid, unknown, and archived project scopes", async (t) => {
  let calls = 0;
  const app = createApiServer({
    apiKey: "project-gate-key",
    port: 0,
    projects: projectStore(),
    agentHost: {
      async handleMessage() {
        calls += 1;
        return { reply: "must not run", model: { stopReason: "completed" } };
      }
    }
  });
  t.after(() => app.close());
  const address = await app.listen();

  const cases = [
    {
      body: {
        projectId: "beta",
        messages: [{ role: "user", content: "conflict" }]
      },
      headers: { "x-openagi-project": "alpha" },
      status: 400,
      code: "project_conflict"
    },
    {
      body: {
        projectId: { id: "alpha" },
        messages: [{ role: "user", content: "invalid" }]
      },
      status: 400,
      code: "invalid_project"
    },
    {
      body: {
        projectId: "missing",
        messages: [{ role: "user", content: "unknown" }]
      },
      status: 404,
      code: "project_not_found"
    },
    {
      body: {
        projectId: "retired",
        stream: true,
        messages: [{ role: "user", content: "archived" }]
      },
      status: 404,
      code: "project_not_found"
    }
  ];

  for (const item of cases) {
    const response = await postCompletion(
      address.url,
      "project-gate-key",
      item.body,
      item.headers
    );
    const payload = await response.json();
    assert.equal(response.status, item.status);
    assert.equal(payload.error.code, item.code);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /event-stream/u);
  }
  assert.equal(calls, 0);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedInterface } from "../src/hosted-interface.js";

const TOKEN = "jobs-http-test-token";

function project(id) {
  return {
    id,
    name: id === "default" ? "Default" : id.toUpperCase(),
    status: "active",
    revision: 1,
    workspaceRoot: `C:\\workspace\\${id}`,
    secretRefs: [],
    activeSkills: [],
    mcpGrants: [],
    hookIds: [],
    kanbanBoardId: id === "default" ? "default" : `project-${id}`,
    policy: { toolPolicy: "full", allowedTools: ["*"] },
    modelProfile: {},
    routingProfile: {}
  };
}

function projectBoundary(message) {
  const error = new Error(message);
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  return error;
}

class FakeProjects {
  constructor() {
    this.records = new Map([
      ["default", project("default")],
      ["alpha", project("alpha")],
      ["beta", project("beta")]
    ]);
    this.sessions = new Map([
      ["default-session", "default"],
      ["alpha-session", "alpha"],
      ["beta-session", "beta"]
    ]);
  }

  authorize(id, { includeArchived = false, sessionId = null } = {}) {
    const record = this.records.get(String(id)) ?? null;
    if (!record || (!includeArchived && record.status !== "active")) return null;
    if (sessionId && (this.sessions.get(sessionId) ?? "default") !== record.id) {
      throw projectBoundary("session is outside the requested project");
    }
    return structuredClone(record);
  }

  get(id, options) {
    return this.authorize(id, options);
  }
}

class FakeJobs {
  constructor() {
    this.records = new Map();
    this.nextId = 1;
    this.calls = [];
    this.timeoutIds = new Set();
    this.events = null;
  }

  bindEvents(events) {
    this.events = events;
  }

  start(input, context) {
    this.calls.push({ method: "start", input: structuredClone(input), context: cleanContext(context) });
    const id = `job_${this.nextId.toString(16).padStart(16, "0")}`;
    this.nextId += 1;
    const now = new Date().toISOString();
    const record = {
      id,
      revision: 1,
      kind: input.kind === "subagent" ? "subagent" : "direct-tool",
      target: input.tool ?? "delegate_task",
      projectId: context.__projectId,
      sessionId: context.sessionId,
      status: "queued",
      attempt: 0,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      recoveredAt: null,
      cancel: {
        requestedAt: null,
        reason: null,
        acknowledgedAt: null
      },
      toolOutputRef: null,
      error: null,
      input: structuredClone(input),
      result: null
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  list(filters, context) {
    this.calls.push({ method: "list", filters: structuredClone(filters), context: cleanContext(context) });
    return [...this.records.values()]
      .filter((job) => job.projectId === context.__projectId)
      .filter((job) => !filters.status || job.status === filters.status)
      .filter((job) => !filters.kind || job.kind === filters.kind)
      .slice(0, filters.limit)
      .map((job) => structuredClone(job));
  }

  status(id, context) {
    this.calls.push({ method: "status", id, context: cleanContext(context) });
    return this.#scoped(id, context);
  }

  wait(id, options, context) {
    this.calls.push({
      method: "wait",
      id,
      options: structuredClone(options),
      context: cleanContext(context)
    });
    const record = this.#scoped(id, context);
    if (this.timeoutIds.has(id)) {
      const error = new Error("planned wait timeout");
      error.code = "JOB_WAIT_TIMEOUT";
      throw error;
    }
    return record;
  }

  collect(id, options, context) {
    this.calls.push({
      method: "collect",
      id,
      options: structuredClone(options),
      context: cleanContext(context)
    });
    const record = this.#scoped(id, context);
    if (!["succeeded", "failed", "cancelled", "interrupted"].includes(record.status)) {
      const error = new Error("job is not ready");
      error.code = "JOB_NOT_READY";
      throw error;
    }
    return {
      job: record,
      output: record.result
    };
  }

  cancel(id, context) {
    this.calls.push({ method: "cancel", id, context: cleanContext(context) });
    const record = this.#scoped(id, context);
    record.revision += 1;
    record.status = "cancel_requested";
    record.updatedAt = new Date().toISOString();
    record.cancel.requestedAt = record.updatedAt;
    this.records.set(id, record);
    return structuredClone(record);
  }

  complete(id, result) {
    const record = this.records.get(id);
    record.revision += 1;
    record.status = "succeeded";
    record.result = structuredClone(result);
    record.finishedAt = new Date().toISOString();
    record.updatedAt = record.finishedAt;
    this.records.set(id, record);
    return structuredClone(record);
  }

  #scoped(id, context) {
    const record = this.records.get(id) ?? null;
    if (!record) return null;
    if (record.projectId !== context.__projectId) {
      throw projectBoundary("job is outside the requested project");
    }
    return structuredClone(record);
  }
}

function cleanContext(context) {
  return {
    channel: context.channel,
    from: context.from,
    sessionId: context.sessionId,
    __projectId: context.__projectId,
    __projectRevision: context.__projectRevision,
    __scrutinyPolicy: context.__scrutinyPolicy
  };
}

async function requestJson(base, route, {
  body,
  method = "GET",
  projectId,
  token = TOKEN
} = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { "x-openagi-project": projectId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    text,
    json: text ? JSON.parse(text) : null
  };
}

async function openEvents(base, projectId) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/events?project=${encodeURIComponent(projectId)}`,
    {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal
    }
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async readUntil(needle, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffered.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${needle}`);
        let timer;
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out waiting for ${needle}`)),
              remaining
            );
          })
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) throw new Error("event stream ended");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      return buffered;
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  };
}

test("hosted durable-job routes are authenticated, bounded, project-scoped, and status-only over SSE", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-jobs-http-"));
  const projects = new FakeProjects();
  const jobs = new FakeJobs();
  const runtime = {
    projects,
    jobs,
    tools: { list: () => [] },
    status: () => ({ ok: true }),
    async tick() {
      return [];
    }
  };
  const app = createHostedInterface(runtime, {
    authToken: TOKEN,
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0
  });
  let alphaEvents;
  let betaEvents;
  t.after(async () => {
    await alphaEvents?.close();
    await betaEvents?.close();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const address = await app.listen();
  const base = address.url;

  const unauthorized = await requestJson(base, "/jobs", { token: null });
  assert.equal(unauthorized.response.status, 401);

  alphaEvents = await openEvents(base, "alpha");
  betaEvents = await openEvents(base, "beta");

  const rawCanary = "raw-job-input-canary";
  const alphaStart = await requestJson(base, "/jobs", {
    method: "POST",
    projectId: "alpha",
    body: {
      kind: "tool",
      tool: "fixture_read",
      arguments: { payload: rawCanary },
      sessionId: "alpha-session"
    }
  });
  assert.equal(alphaStart.response.status, 202);
  assert.equal(alphaStart.json.projectId, "alpha");
  assert.equal(alphaStart.json.status, "queued");
  assert.equal(alphaStart.text.includes(rawCanary), false);
  assert.equal(jobs.calls.at(-1).context.__projectRevision, 1);
  assert.equal(jobs.calls.at(-1).context.sessionId, "alpha-session");

  const alphaStream = await alphaEvents.readUntil(alphaStart.json.id);
  assert.match(alphaStream, /event: job/u);
  assert.equal(alphaStream.includes(rawCanary), false);
  assert.equal(alphaStream.includes('"input"'), false);
  assert.equal(alphaStream.includes('"result"'), false);

  const betaStart = await requestJson(base, "/jobs", {
    method: "POST",
    projectId: "beta",
    body: {
      kind: "subagent",
      goal: "Inspect the beta fixture.",
      resourceLocks: ["workspace:beta"],
      sessionId: "beta-session"
    }
  });
  assert.equal(betaStart.response.status, 202);
  const betaStream = await betaEvents.readUntil(betaStart.json.id);
  assert.equal(betaStream.includes(alphaStart.json.id), false);

  const alphaList = await requestJson(base, "/jobs?limit=999", {
    projectId: "alpha"
  });
  assert.equal(alphaList.response.status, 200);
  assert.deepEqual(alphaList.json.jobs.map((job) => job.id), [alphaStart.json.id]);
  assert.equal(
    jobs.calls.findLast((call) => call.method === "list").filters.limit,
    100
  );

  const foreign = await requestJson(base, `/jobs/${alphaStart.json.id}`, {
    projectId: "beta"
  });
  assert.equal(foreign.response.status, 404);
  assert.deepEqual(foreign.json, { error: "unknown job" });

  const wrongSession = await requestJson(base, "/jobs", {
    method: "POST",
    projectId: "alpha",
    body: {
      kind: "subagent",
      goal: "Cross the boundary.",
      resourceLocks: ["workspace:alpha"],
      sessionId: "beta-session"
    }
  });
  assert.equal(wrongSession.response.status, 400);

  const wait = await requestJson(
    base,
    `/jobs/${alphaStart.json.id}/wait?timeoutMs=999999`,
    { projectId: "alpha" }
  );
  assert.equal(wait.response.status, 200);
  assert.equal(wait.json.timedOut, false);
  assert.equal(
    jobs.calls.findLast((call) => call.method === "wait").options.timeoutMs,
    30_000
  );

  jobs.timeoutIds.add(alphaStart.json.id);
  const timedOut = await requestJson(
    base,
    `/jobs/${alphaStart.json.id}/wait?timeoutMs=1`,
    { projectId: "alpha" }
  );
  assert.equal(timedOut.response.status, 200);
  assert.equal(timedOut.json.timedOut, true);
  jobs.timeoutIds.delete(alphaStart.json.id);

  const notReady = await requestJson(
    base,
    `/jobs/${alphaStart.json.id}/result`,
    { projectId: "alpha" }
  );
  assert.equal(notReady.response.status, 409);
  assert.equal(notReady.json.code, "JOB_NOT_READY");

  jobs.complete(alphaStart.json.id, {
    message: "completed result",
    detail: "x".repeat(200)
  });
  const result = await requestJson(
    base,
    `/jobs/${alphaStart.json.id}/result?offset=999999999&maxChars=40`,
    { projectId: "alpha" }
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.json.job.status, "succeeded");
  assert.equal(result.json.output.truncated, true);
  const collectCall = jobs.calls.findLast((call) => call.method === "collect");
  assert.equal(collectCall.options.offset, 64 * 1024 * 1024);
  assert.equal(collectCall.options.maxChars, 40);

  const cancelled = await requestJson(
    base,
    `/jobs/${betaStart.json.id}/cancel`,
    { method: "POST", projectId: "beta" }
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.json.status, "cancel_requested");

  const oversizedCount = jobs.calls.filter((call) => call.method === "start").length;
  const oversized = await requestJson(base, "/jobs", {
    method: "POST",
    projectId: "alpha",
    body: {
      kind: "subagent",
      goal: "x".repeat(270_000),
      resourceLocks: ["workspace:alpha"],
      sessionId: "alpha-session"
    }
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(
    jobs.calls.filter((call) => call.method === "start").length,
    oversizedCount
  );

  const invalidId = await requestJson(base, "/jobs/not-a-job", {
    projectId: "alpha"
  });
  assert.equal(invalidId.response.status, 400);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import {
  RunInspector,
  RunInspectorStore,
  turnInspectorMetadata
} from "../src/run-inspector.js";
import { ToolRegistry } from "../src/tool-registry.js";

const TOKEN = "run-inspector-test-token";
const ARTIFACT_REF = `qaart_${"a".repeat(64)}`;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(id) {
  return {
    id,
    name: id.toUpperCase(),
    status: "active",
    revision: 1,
    workspaceRoot: process.cwd(),
    secretRefs: [],
    activeSkills: [],
    mcpGrants: [],
    hookIds: [],
    kanbanBoardId: id,
    policy: { toolPolicy: "full", allowedTools: ["*"] },
    modelProfile: {},
    routingProfile: {}
  };
}

function projects() {
  const records = new Map([
    ["alpha", project("alpha")],
    ["beta", project("beta")]
  ]);
  return {
    authorize(id) {
      const record = records.get(String(id));
      return record ? structuredClone(record) : null;
    },
    get(id) {
      return this.authorize(id);
    }
  };
}

async function request(base, route, {
  projectId = "alpha",
  token = TOKEN
} = {}) {
  return fetch(`${base}${route}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { "x-openagi-project": projectId } : {})
    }
  });
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
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for SSE payload: ${needle}`);
        }
        let timer;
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(
                `Timed out waiting for SSE payload: ${needle}`
              )),
              remaining
            );
          })
        ]).finally(() => clearTimeout(timer));
        if (chunk.done) throw new Error("Run Inspector SSE stream ended.");
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

test("Run Inspector journal is durable, content-free, and project-scoped", (t) => {
  const dir = tempDir(t, "openagi-run-inspector-");
  const canary = "raw-tool-argument-must-never-persist";
  const changes = [];
  const store = new RunInspectorStore({
    dir,
    onChange: (run, event) => changes.push({ run, event })
  });

  store.record({
    runId: "turn_shared",
    kind: "turn",
    projectId: "alpha",
    sessionId: "alpha-session",
    phase: "turn_start",
    status: "running",
    metadata: {
      agentId: "main",
      scrutinyScore: 0.5,
      prompt: canary,
      arguments: { password: canary }
    }
  });
  const inspected = turnInspectorMetadata({
    phase: "end",
    name: "code_edit",
    arguments: { payload: canary },
    receipt: {
      id: "receipt_1",
      code: "ok",
      changed: true,
      dispatched: true,
      durationMs: 12,
      raw: canary
    },
    outcome: {
      content: canary,
      artifacts: [ARTIFACT_REF, "not-an-artifact"]
    }
  });
  store.record({
    runId: "turn_shared",
    kind: "turn",
    projectId: "alpha",
    sessionId: "alpha-session",
    ...inspected
  });
  store.record({
    runId: "turn_shared",
    kind: "turn",
    projectId: "beta",
    sessionId: "beta-session",
    phase: "turn_start",
    status: "running",
    metadata: { agentId: "main" }
  });

  assert.equal(changes.length, 3);
  assert.equal(store.list({ projectId: "alpha" }).length, 1);
  assert.equal(store.list({ projectId: "beta" }).length, 1);
  assert.equal(
    store.get("turn", "turn_shared", { projectId: "alpha" }).eventCount,
    2
  );
  assert.equal(
    store.get("turn", "turn_shared", { projectId: "beta" }).eventCount,
    1
  );

  store._rewriteJournal();
  const persisted = fs.readFileSync(
    path.join(dir, "events.jsonl"),
    "utf8"
  ) + fs.readFileSync(path.join(dir, "snapshot.json"), "utf8");
  assert.equal(persisted.includes(canary), false);
  assert.equal(persisted.includes('"arguments"'), false);
  assert.equal(persisted.includes('"prompt"'), false);
  assert.equal(persisted.includes(ARTIFACT_REF), true);

  const recovered = new RunInspectorStore({ dir });
  const alpha = recovered.get("turn", "turn_shared", {
    projectId: "alpha"
  });
  const beta = recovered.get("turn", "turn_shared", {
    projectId: "beta"
  });
  assert.equal(alpha.eventCount, 2);
  assert.deepEqual(alpha.events.map((event) => event.sequence), [1, 2]);
  assert.equal(beta.eventCount, 1);
  assert.equal(
    recovered.get("turn", "turn_shared", { projectId: "missing" }),
    null
  );
});

test("Run Inspector observers cannot break its authoritative journal", (t) => {
  const dir = tempDir(t, "openagi-run-inspector-observer-");
  const store = new RunInspectorStore({
    dir,
    onChange() {
      throw new Error("planned observer failure");
    }
  });
  assert.doesNotThrow(() => store.record({
    runId: "turn_observer",
    kind: "turn",
    projectId: "alpha",
    phase: "turn_start",
    status: "running"
  }));
  assert.equal(store.list({ projectId: "alpha" }).length, 1);
});

test("Run Inspector journal outranks snapshots and replays a valid suffix", (t) => {
  const dir = tempDir(t, "openagi-run-inspector-replay-");
  const canary = "snapshot-content-canary";
  const store = new RunInspectorStore({ dir });
  store.record({
    runId: "turn_replay",
    kind: "turn",
    projectId: "alpha",
    phase: "turn_start",
    status: "running",
    metadata: { agentId: "main" }
  });

  const snapshotPath = path.join(dir, "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  snapshot.runs[0].sequence = 99;
  snapshot.runs[0].eventCount = 99;
  snapshot.runs[0].status = "succeeded";
  snapshot.runs[0].latest.prompt = canary;
  snapshot.runs[0].events[0].metadata.arguments = canary;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  const suffixAt = new Date(Date.now() + 1_000).toISOString();
  fs.appendFileSync(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify({
      version: 1,
      id: "runevent_0123456789abcdef",
      runId: "turn_replay",
      kind: "turn",
      projectId: "alpha",
      sessionId: null,
      phase: "iteration",
      status: "running",
      sequence: 2,
      at: suffixAt,
      metadata: {
        iteration: 1,
        prompt: canary
      }
    })}\n`
  );

  const recovered = new RunInspectorStore({ dir }).get(
    "turn",
    "turn_replay",
    { projectId: "alpha" }
  );
  assert.equal(recovered.sequence, 2);
  assert.equal(recovered.eventCount, 2);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.latest.iteration, 1);
  assert.equal(JSON.stringify(recovered).includes(canary), false);
  assert.equal(JSON.stringify(recovered).includes("arguments"), false);
});

test("Run Inspector discovers pre-existing durable jobs without exposing results", (t) => {
  const dir = tempDir(t, "openagi-run-inspector-job-");
  const canary = "durable-job-result-canary";
  const job = {
    id: "job_0123456789abcdef",
    revision: 4,
    kind: "direct-tool",
    target: "fixture_read",
    projectId: "alpha",
    sessionId: "alpha-session",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    startedAt: "2026-01-01T00:00:10.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    recoveredAt: null,
    cancel: null,
    result: { raw: canary },
    error: {
      code: "fixture_failed",
      message: canary,
      retryable: false
    }
  };
  const runtime = {
    jobs: {
      list(_filters, context) {
        return context.__projectId === "alpha"
          ? [structuredClone(job)]
          : [];
      },
      status(id, context) {
        return id === job.id && context.__projectId === "alpha"
          ? structuredClone(job)
          : null;
      }
    }
  };
  const inspector = new RunInspector({ runtime, dir });
  const listed = inspector.list({ projectId: "alpha", kind: "job" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].latest.toolName, "fixture_read");
  assert.equal(listed[0].latest.errorCode, "fixture_failed");

  const detail = inspector.detail({
    projectId: "alpha",
    kind: "job",
    runId: job.id
  });
  assert.equal(detail.detail.target, "fixture_read");
  assert.equal(detail.detail.error.code, "fixture_failed");
  assert.equal(JSON.stringify(detail).includes(canary), false);
  assert.equal(
    inspector.detail({
      projectId: "beta",
      kind: "job",
      runId: job.id
    }),
    null
  );
});

test("AgentHost publishes a content-free live tool timeline", async (t) => {
  const dir = tempDir(t, "openagi-run-inspector-host-");
  const canary = "agent-host-raw-argument-canary";
  const tools = new ToolRegistry();
  tools.register({
    name: "fixture_read",
    description: "Read a fixture.",
    sideEffects: false,
    handler: async () => ({ ok: true })
  });
  const runtime = {
    tools,
    memory: {
      retrieve: () => [],
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory_inspector" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_inspector",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["test"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  runtime.runInspector = new RunInspector({ runtime, dir });
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider: {
      provider: "fixture",
      model: "fixture-model",
      isConfigured: () => true,
      async generate(input) {
        input.context.__onToolEvent({
          phase: "iteration",
          n: 1,
          max: 4,
          prompt: canary
        });
        input.context.__onToolEvent({
          phase: "start",
          name: "fixture_read",
          arguments: { secret: canary }
        });
        input.context.__onToolEvent({
          phase: "end",
          name: "fixture_read",
          arguments: { secret: canary },
          ok: true,
          receipt: {
            id: "receipt_fixture",
            code: "ok",
            changed: false,
            durationMs: 3
          },
          outcome: { text: canary }
        });
        return {
          provider: "fixture",
          model: "fixture-model",
          id: "response_inspector",
          text: "Completed.",
          toolCalls: [],
          iterations: 1,
          maxIterations: 4,
          stopReason: "completed",
          usage: { input_tokens: 42, output_tokens: 7 }
        };
      }
    }
  });

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "inspector-session",
    text: "Inspect the fixture."
  });
  const runs = runtime.runInspector.list({
    projectId: "default",
    kind: "turn"
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "succeeded");
  assert.deepEqual(
    runs[0].events.map((event) => event.phase),
    ["turn_start", "iteration", "tool_start", "tool_end", "turn_complete"]
  );
  assert.equal(runs[0].latest.inputTokens, 42);
  assert.equal(runs[0].latest.outputTokens, 7);

  const persisted = fs.readFileSync(
    path.join(dir, "events.jsonl"),
    "utf8"
  );
  assert.equal(persisted.includes(canary), false);
  assert.equal(persisted.includes('"arguments"'), false);
});

test("hosted Run Inspector is authenticated, live, project-scoped, and serves owned artifacts", async (t) => {
  const root = tempDir(t, "openagi-run-inspector-http-");
  const runtime = {
    projects: projects(),
    tools: { list: () => [] },
    status: () => ({ ok: true }),
    async tick() {
      return [];
    },
    webQa: {
      store: {
        list: () => [],
        get(id) {
          if (id !== "qa_0123456789abcdef") return null;
          return {
            id,
            projectId: "alpha",
            sessionId: "alpha-session",
            state: "passed",
            revision: 2,
            sourceRevision: "b".repeat(64),
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            manifest: {
              path: "qa-manifest.json",
              digest: "c".repeat(64),
              title: "Fixture"
            },
            summary: {
              routes: 1,
              controls: 1,
              passed: 2,
              failed: 0,
              warnings: 0
            },
            results: [],
            artifacts: [ARTIFACT_REF],
            error: null
          };
        }
      },
      artifacts: {
        readBytes(ref, scope) {
          assert.equal(ref, ARTIFACT_REF);
          assert.deepEqual(scope, {
            projectId: "alpha",
            runId: "qa_0123456789abcdef"
          });
          return {
            ref,
            mediaType: "image/png",
            data: Buffer.from("owned-image")
          };
        }
      }
    }
  };
  runtime.runInspector = new RunInspector({
    runtime,
    dir: path.join(root, "inspector")
  });
  const app = createHostedInterface(runtime, {
    authToken: TOKEN,
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0
  });
  let alphaEvents;
  t.after(async () => {
    await alphaEvents?.close();
    await app.close();
  });
  const address = await app.listen();
  alphaEvents = await openEvents(address.url, "alpha");

  const unauthorized = await request(address.url, "/runs", {
    token: null
  });
  assert.equal(unauthorized.status, 401);

  runtime.runInspector.recordTurn({
    runId: "turn_http",
    projectId: "alpha",
    sessionId: "alpha-session",
    phase: "turn_start",
    status: "running",
    metadata: { agentId: "main" }
  });
  const stream = await alphaEvents.readUntil("turn_http");
  assert.match(stream, /event: run-inspector/u);
  assert.equal(stream.includes('"projectId":"alpha"'), true);

  const alphaList = await request(address.url, "/runs", {
    projectId: "alpha"
  });
  assert.equal(alphaList.status, 200);
  assert.equal(alphaList.headers.get("cache-control"), "no-store");
  const alphaBody = await alphaList.json();
  assert.equal(
    alphaBody.runs.some((run) => run.runId === "turn_http"),
    true
  );

  const betaList = await request(address.url, "/runs", {
    projectId: "beta"
  });
  assert.equal(betaList.status, 200);
  const betaBody = await betaList.json();
  assert.equal(
    betaBody.runs.some((run) => run.runId === "turn_http"),
    false
  );

  const detail = await request(
    address.url,
    "/runs/turn/turn_http",
    { projectId: "alpha" }
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.equal((await detail.json()).run.eventCount, 1);

  const foreign = await request(
    address.url,
    "/runs/turn/turn_http",
    { projectId: "beta" }
  );
  assert.equal(foreign.status, 404);

  const artifact = await request(
    address.url,
    `/runs/qa/qa_0123456789abcdef/artifacts/${ARTIFACT_REF}`,
    { projectId: "alpha" }
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-type"), "image/png");
  assert.equal(artifact.headers.get("x-content-type-options"), "nosniff");
  assert.equal(artifact.headers.get("cache-control"), "private, no-store");
  assert.equal(Buffer.from(await artifact.arrayBuffer()).toString(), "owned-image");

  const foreignArtifact = await request(
    address.url,
    `/runs/qa/qa_0123456789abcdef/artifacts/${ARTIFACT_REF}`,
    { projectId: "beta" }
  );
  assert.equal(foreignArtifact.status, 404);
});

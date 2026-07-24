import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import {
  FileBackedAgentStore,
  InMemoryAgentStore
} from "../src/agent-store.js";
import { ProjectStore } from "../src/project-store.js";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-session-branch-host-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  projects.create({ id: "alpha", name: "Alpha" });
  const store = options.fileBacked
    ? new FileBackedAgentStore({ dir: path.join(dataDir, "agent-host") })
    : new InMemoryAgentStore();
  const events = new EventEmitter();
  const indexed = [];
  const hooks = [];
  const runtime = {
    projects,
    events,
    hooks: {
      notify(type, payload) {
        hooks.push({ type, payload });
      }
    },
    sessionIndex: {
      async indexMessage(sessionId, agentId, message) {
        indexed.push({ sessionId, agentId, message });
      }
    }
  };
  const host = new AgentHost({
    runtime,
    store,
    workspaceDir: workspace,
    modelProvider: {
      isConfigured: () => true,
      async generate() {
        throw new Error("not used");
      }
    },
    backgroundReviewer: {}
  });
  return {
    dataDir,
    events,
    hooks,
    host,
    indexed,
    projects,
    store,
    workspace
  };
}

test("AgentHost branches an exact inclusive prefix and emits metadata only", async (t) => {
  const h = harness(t);
  const sourceSessionId = "source:alpha";
  h.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  for (const [id, role, content] of [
    ["msg_0000000000000001", "user", "first secret text"],
    ["msg_0000000000000002", "assistant", "second private text"],
    ["msg_0000000000000003", "user", "must not be copied"]
  ]) {
    await h.store.appendMessage(sourceSessionId, {
      id,
      role,
      content,
      agentId: "main",
      metadata: { projectId: "alpha" }
    });
  }
  const sourceBefore = structuredClone(h.store.getSession(sourceSessionId));
  const seenEvents = [];
  h.events.on("session-branched", (event) => seenEvents.push(event));

  const result = await h.host.branchSession({
    sourceSessionId,
    messageId: "msg_0000000000000002",
    projectId: "alpha"
  });

  assert.match(result.sessionId, /^session_[a-f0-9]{16}$/u);
  assert.equal(result.projectId, "alpha");
  assert.equal(result.messageCount, 2);
  assert.deepEqual(h.store.getSession(sourceSessionId), sourceBefore);
  const branch = h.store.getSession(result.sessionId);
  assert.deepEqual(
    branch.messages.map((message) => message.id),
    ["msg_0000000000000001", "msg_0000000000000002"]
  );
  assert.deepEqual(branch.metadata, {
    projectId: "alpha",
    branchV1: {
      sourceSessionId,
      messageId: "msg_0000000000000002",
      messageCount: 2,
      createdAt: result.at
    }
  });
  assert.equal(h.projects.projectForSession(result.sessionId).id, "alpha");
  assert.equal(h.indexed.length, 2);
  assert.deepEqual(
    h.indexed.map((entry) => [entry.sessionId, entry.message.id]),
    [
      [result.sessionId, "msg_0000000000000001"],
      [result.sessionId, "msg_0000000000000002"]
    ]
  );
  assert.deepEqual(seenEvents, [{
    projectId: "alpha",
    sourceSessionId,
    sessionId: result.sessionId,
    messageId: "msg_0000000000000002",
    messageCount: 2,
    at: result.at
  }]);
  assert.equal(JSON.stringify(seenEvents).includes("secret text"), false);
  assert.equal(h.hooks.at(-1).type, "session:branch");
  assert.equal(JSON.stringify(h.hooks.at(-1)).includes("private text"), false);
});

test("AgentHost rejects missing and ambiguous selectors without leaving a target binding", async (t) => {
  const h = harness(t);
  const sourceSessionId = "source:ambiguous";
  h.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  for (const content of ["one", "two"]) {
    await h.store.appendMessage(sourceSessionId, {
      id: "msg_duplicated",
      role: "user",
      content,
      metadata: { projectId: "alpha" }
    });
  }
  const bindingsBefore = h.projects.sessionsForProject("alpha");

  await assert.rejects(
    h.host.branchSession({
      sourceSessionId,
      messageId: "msg_missing",
      projectId: "alpha"
    }),
    { code: "SESSION_BRANCH_MESSAGE_NOT_FOUND" }
  );
  await assert.rejects(
    h.host.branchSession({
      sourceSessionId,
      messageId: "msg_duplicated",
      projectId: "alpha"
    }),
    { code: "SESSION_BRANCH_MESSAGE_AMBIGUOUS" }
  );
  assert.deepEqual(h.projects.sessionsForProject("alpha"), bindingsBefore);
  assert.equal(h.store.listSessions().length, 1);
});

test("AgentHost waits for an already-queued source append before selecting the prefix", async (t) => {
  const h = harness(t, { fileBacked: true });
  const sourceSessionId = "source:queued";
  h.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  const pendingAppend = h.store.appendMessage(sourceSessionId, {
    id: "msg_queued",
    role: "user",
    content: "queued source message",
    metadata: { projectId: "alpha" }
  });
  const pendingBranch = h.host.branchSession({
    sourceSessionId,
    messageId: "msg_queued",
    projectId: "alpha"
  });

  await pendingAppend;
  const result = await pendingBranch;
  assert.deepEqual(
    h.store.getSession(result.sessionId).messages.map((message) => message.id),
    ["msg_queued"]
  );
});

test("AgentHost durably rolls back a target binding when branch persistence fails", async (t) => {
  const h = harness(t);
  const sourceSessionId = "source:failure";
  h.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  await h.store.appendMessage(sourceSessionId, {
    id: "msg_failure",
    role: "user",
    content: "source remains",
    metadata: { projectId: "alpha" }
  });
  h.store.createSessionBranch = async () => {
    throw new Error("simulated persistence failure");
  };

  await assert.rejects(
    h.host.branchSession({
      sourceSessionId,
      messageId: "msg_failure",
      projectId: "alpha"
    }),
    /simulated persistence failure/u
  );
  assert.deepEqual(
    h.projects.sessionsForProject("alpha"),
    [sourceSessionId]
  );
  const reloaded = new ProjectStore({
    dataDir: h.dataDir,
    defaultWorkspaceRoot: h.workspace
  });
  assert.deepEqual(reloaded.sessionsForProject("alpha"), [sourceSessionId]);
});

test("AgentHost cannot branch a source through another project", async (t) => {
  const h = harness(t);
  h.projects.create({ id: "beta", name: "Beta" });
  const sourceSessionId = "source:boundary";
  h.projects.resolveForSession(sourceSessionId, {
    requestedProjectId: "alpha",
    bind: true
  });
  await h.store.appendMessage(sourceSessionId, {
    id: "msg_0000000000000001",
    role: "user",
    content: "alpha only",
    metadata: { projectId: "alpha" }
  });

  await assert.rejects(
    h.host.branchSession({
      sourceSessionId,
      messageId: "msg_0000000000000001",
      projectId: "beta"
    }),
    { code: "PROJECT_BOUNDARY_VIOLATION" }
  );
  assert.deepEqual(h.projects.sessionsForProject("beta"), []);
});

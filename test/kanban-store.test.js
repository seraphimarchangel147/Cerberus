import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KanbanStore, KANBAN_COLUMNS } from "../src/kanban-store.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

const KANBAN_TOOL_NAMES = [
  "kanban_show",
  "kanban_list",
  "kanban_create",
  "kanban_complete",
  "kanban_block",
  "kanban_unblock",
  "kanban_comment",
  "kanban_heartbeat",
  "kanban_link"
];

function fixture(t) {
  // Some Windows test sandboxes reject fsync on ordinary temporary files.
  // Keep the production durability path intact while following the same
  // test-only shim used by cli-client.test.js.
  const originalFsyncSync = fs.fsyncSync;
  if (process.platform === "win32") fs.fsyncSync = () => {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-kanban-"));
  const dataDir = path.join(root, "data");
  const stores = [];
  const open = (options = {}) => {
    const store = new KanbanStore({ dataDir, ...options });
    stores.push(store);
    return store;
  };
  const store = open();

  t.after(async () => {
    try {
      for (const current of stores) await current.close();
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 5 : 0,
        retryDelay: 50
      });
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
  });
  return { root, dataDir, store, open };
}

async function ready(store) {
  await store.ready;
  assert.ok(store.db, store.unavailableReason ?? "Kanban SQLite did not initialize");
}

test("task lifecycle records assignment, attempts, trusted identity, and completion handoff", async (t) => {
  const { store } = fixture(t);
  await ready(store);
  const context = {
    agentId: "trusted-worker",
    sessionId: "session-kanban",
    channel: "test",
    from: "test-sender",
    nodeId: "spoofed-node",
    pid: 1,
    cwd: "C:\\spoofed"
  };

  const created = await store.createTask({
    title: "Ship the capability",
    body: "Implement and verify it"
  }, context);
  assert.equal(created.status, "backlog");
  assert.equal(created.assignee, null);

  const assigned = await store.assignTask(
    created.id,
    "implementation-agent",
    context,
    { reason: "ready for implementation" }
  );
  assert.equal(assigned.status, "in-progress");
  assert.equal(assigned.assignee, "implementation-agent");
  assert.equal(assigned.handoffs.at(-1).toAssignee, "implementation-agent");
  assert.equal(assigned.handoffs.at(-1).reason, "ready for implementation");

  const started = await store.heartbeatTask(
    created.id,
    { state: "start", detail: { phase: "implementation" } },
    context
  );
  assert.equal(started.run.attempt, 1);
  assert.equal(started.run.state, "running");
  assert.deepEqual(started.run.detail, { phase: "implementation" });
  assert.equal(started.worker.agentName, "trusted-worker");
  assert.equal(started.worker.nodeId, store.installIdentity.nodeId);
  assert.notEqual(started.worker.nodeId, context.nodeId);
  assert.equal(started.worker.pid, process.pid);
  assert.notEqual(started.worker.pid, context.pid);
  assert.equal(started.worker.cwd, process.cwd());
  assert.notEqual(started.worker.cwd, context.cwd);
  assert.equal(started.worker.sessionId, context.sessionId);
  assert.equal(started.worker.channel, context.channel);
  assert.equal(started.worker.sender, context.from);

  const heartbeat = await store.heartbeatTask(
    created.id,
    {
      runId: started.run.id,
      state: "heartbeat",
      detail: { phase: "tests" }
    },
    context
  );
  assert.equal(heartbeat.run.id, started.run.id);
  assert.equal(heartbeat.run.attempt, 1);
  assert.equal(heartbeat.run.state, "heartbeat");
  assert.deepEqual(heartbeat.run.detail, { phase: "tests" });

  const retry = await store.heartbeatTask(
    created.id,
    { state: "start", detail: "second attempt" },
    context
  );
  assert.equal(retry.run.attempt, 2);
  assert.notEqual(retry.run.id, started.run.id);
  assert.equal(retry.task.runs.length, 2);

  const blocked = await store.blockTask(
    created.id,
    { reason: "waiting for review environment" },
    context
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockReason, "waiting for review environment");
  await assert.rejects(
    store.completeTask(created.id, { summary: "too soon" }, context),
    /blocked/
  );

  const unblocked = await store.unblockTask(created.id, {}, context);
  assert.equal(unblocked.status, "in-progress");
  assert.equal(unblocked.blockReason, null);

  const commented = await store.commentTask(created.id, "Review environment is healthy.", context);
  assert.equal(commented.comment.author, "trusted-worker");
  assert.equal(commented.comment.body, "Review environment is healthy.");

  const completed = await store.completeTask(created.id, {
    summary: "Capability implemented and verified.",
    handoffTo: "release-reviewer",
    metadata: {
      commit: "abc123",
      tests: ["unit", "policy"]
    }
  }, context);
  assert.equal(completed.status, "done");
  assert.ok(completed.completedAt);
  assert.deepEqual(completed.runs.map((run) => run.state), ["succeeded", "succeeded"]);
  const completion = completed.handoffs.at(-1);
  assert.equal(completion.fromAssignee, "implementation-agent");
  assert.equal(completion.toAssignee, "release-reviewer");
  assert.equal(completion.reason, "completion");
  assert.equal(completion.summary, "Capability implemented and verified.");
  assert.deepEqual(completion.metadata, {
    commit: "abc123",
    tests: ["unit", "policy"]
  });
});

test("dependencies prevent completion and reject cycles or cross-board links", async (t) => {
  const { store } = fixture(t);
  await ready(store);
  const context = { agentId: "coordinator", sessionId: "dependency-session" };
  const parent = await store.createTask({
    title: "Prepare API",
    board: "release"
  }, context);
  const child = await store.createTask({
    title: "Publish API",
    board: "release"
  }, context);

  const linked = await store.linkTasks(parent.id, child.id, context);
  assert.equal(linked.status, "blocked");
  assert.deepEqual(linked.blockedBy, [parent.id]);
  await assert.rejects(
    store.completeTask(child.id, { summary: "cannot publish yet" }, context),
    new RegExp(`blocked by: ${parent.id}`)
  );
  await assert.rejects(
    store.linkTasks(child.id, parent.id, context),
    /create a cycle/
  );

  const otherBoard = await store.createTask({
    title: "Unrelated task",
    board: "other"
  }, context);
  await assert.rejects(
    store.linkTasks(otherBoard.id, child.id, context),
    /within one board/
  );

  await store.completeTask(parent.id, { summary: "API is ready" }, context);
  const released = await store.getTask(child.id);
  assert.equal(released.status, "in-progress");
  assert.deepEqual(released.blockedBy, []);
  const completed = await store.completeTask(child.id, { summary: "API published" }, context);
  assert.equal(completed.status, "done");
});

test("JSONL audit and atomic snapshot accompany SQLite persistence across reopen", async (t) => {
  const { dataDir, store, open } = fixture(t);
  await ready(store);
  const context = { agentId: "persistence-worker", sessionId: "persist-session" };
  const task = await store.createTask({
    title: "Persist this task",
    body: "The board must survive process restart.",
    board: "durability",
    boardName: "Durability"
  }, context);
  await store.commentTask(task.id, "Durable comment", context);

  const auditDir = path.join(dataDir, "kanban");
  const eventsPath = path.join(auditDir, "events.jsonl");
  const snapshotPath = path.join(auditDir, "snapshot.json");
  assert.ok(fs.existsSync(path.join(dataDir, "kanban.db")));
  assert.ok(fs.existsSync(eventsPath));
  assert.ok(fs.existsSync(snapshotPath));
  const events = fs.readFileSync(eventsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.op), ["create", "comment"]);
  assert.ok(events.every((event) => event.taskId === task.id));

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(snapshot.columns, KANBAN_COLUMNS);
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, task.id);
  assert.equal(snapshot.tasks[0].comments[0].body, "Durable comment");
  assert.equal(snapshot.boards.find((board) => board.id === "durability").counts.total, 1);

  await store.close();
  const reopened = open();
  await ready(reopened);
  const persisted = await reopened.getTask(task.id);
  assert.equal(persisted.title, "Persist this task");
  assert.equal(persisted.board, "durability");
  assert.equal(persisted.comments[0].body, "Durable comment");
});

test("all nine Kanban tools are wired, classified, invokable, and documented", async (t) => {
  const { store } = fixture(t);
  await ready(store);
  const registry = new ToolRegistry();
  registerCoreTools(registry, { kanban: store });

  for (const name of KANBAN_TOOL_NAMES) {
    assert.ok(registry.has(name), `${name} is registered`);
  }
  const readOnlyNames = registry.list({ readOnly: true })
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("kanban_"))
    .sort();
  assert.deepEqual(readOnlyNames, ["kanban_list", "kanban_show"]);
  for (const name of KANBAN_TOOL_NAMES) {
    assert.equal(
      registry.get(name).sideEffects,
      !["kanban_show", "kanban_list"].includes(name),
      `${name} side-effect classification`
    );
  }

  const context = { agentId: "tool-worker", sessionId: "tool-session" };
  const call = async (name, args) => {
    const result = await registry.invoke(name, args, context);
    assert.equal(result.ok, true, `${name}: ${result.error ?? "unexpected failure"}`);
    return result.result;
  };
  const parent = await call("kanban_create", {
    title: "Tool parent",
    board: "tool-board",
    assignee: "tool-worker"
  });
  const child = await call("kanban_create", {
    title: "Tool child",
    board: "tool-board"
  });
  const linked = await call("kanban_link", {
    parentId: parent.id,
    childId: child.id
  });
  assert.equal(linked.status, "blocked");
  const blocked = await call("kanban_block", {
    taskId: parent.id,
    reason: "temporary pause"
  });
  assert.equal(blocked.status, "blocked");
  const unblocked = await call("kanban_unblock", { taskId: parent.id });
  assert.equal(unblocked.status, "in-progress");
  const heartbeat = await call("kanban_heartbeat", {
    taskId: parent.id,
    state: "start",
    detail: { step: "implementation" }
  });
  assert.equal(heartbeat.run.attempt, 1);
  const commented = await call("kanban_comment", {
    taskId: parent.id,
    body: "Tool comment"
  });
  assert.equal(commented.comment.author, "tool-worker");
  const shown = await call("kanban_show", { taskId: parent.id });
  assert.equal(shown.id, parent.id);
  const listed = await call("kanban_list", { board: "tool-board" });
  assert.deepEqual(listed.columns, KANBAN_COLUMNS);
  assert.equal(listed.tasks.length, 2);
  const completed = await call("kanban_complete", {
    taskId: parent.id,
    summary: "Tool lifecycle complete",
    handoffTo: "reviewer",
    metadata: { verified: true }
  });
  assert.equal(completed.status, "done");

  const prompt = buildDefaultInstructions({ agent: { name: "Test" } });
  for (const name of KANBAN_TOOL_NAMES) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`), `${name} is in the system prompt`);
  }
});

test("terminal tasks and runs cannot be reopened or spoofed", async (t) => {
  const { store } = fixture(t);
  await ready(store);
  const owner = { agentId: "owner", sessionId: "owner-session" };
  const other = { agentId: "other", sessionId: "other-session" };
  const doneParent = await store.createTask({ title: "Done parent" }, owner);
  await store.completeTask(doneParent.id, { summary: "done" }, owner);
  const child = await store.createTask({
    title: "Child of done parent",
    blockedBy: [doneParent.id]
  }, owner);
  assert.equal(child.status, "backlog");
  assert.deepEqual(child.blockedBy, []);

  const running = await store.heartbeatTask(child.id, {
    state: "start",
    assignee: "spoofed-worker"
  }, owner);
  assert.equal(running.worker.agentName, "owner");
  await assert.rejects(
    store.heartbeatTask(child.id, { runId: running.run.id, state: "heartbeat" }, other),
    /belongs to another worker/
  );
  await store.heartbeatTask(child.id, {
    runId: running.run.id,
    state: "failed"
  }, owner);
  await assert.rejects(
    store.heartbeatTask(child.id, { runId: running.run.id, state: "heartbeat" }, owner),
    /already terminal/
  );

  await store.completeTask(child.id, { summary: "complete" }, owner);
  await assert.rejects(store.unblockTask(child.id, {}, owner), /completed/);
  await assert.rejects(store.linkTasks(doneParent.id, child.id, owner), /completed/);
  await assert.rejects(store.assignTask(child.id, "new-owner", owner), /completed/);
});

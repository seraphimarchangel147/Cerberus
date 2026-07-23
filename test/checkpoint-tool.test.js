import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function fixture(t, prefix = "openagi-checkpoint-tool-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceDir = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspaceDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspaceDir, dataDir };
}

function enabledStore(t, options = {}) {
  const dirs = fixture(t);
  const store = new CheckpointStore({
    dataDir: dirs.dataDir,
    workspaceDir: dirs.workspaceDir,
    allowedRoots: [dirs.workspaceDir],
    enabled: true,
    ...options
  });
  return { ...dirs, store };
}

function registerWriteTool(registry, handler) {
  registry.register({
    name: "code_write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    handler
  });
}

test("ToolRegistry snapshots a destructive target immediately before its handler", async (t) => {
  const { workspaceDir, store } = enabledStore(t);
  const target = path.join(workspaceDir, "state.txt");
  fs.writeFileSync(target, "before\n", "utf8");

  const events = [];
  const originalBeforeToolCall = store.beforeToolCall.bind(store);
  store.beforeToolCall = async (request) => {
    events.push("checkpoint:start");
    const result = await originalBeforeToolCall(request);
    events.push("checkpoint:done");
    return result;
  };

  const registry = new ToolRegistry();
  registry.bindCheckpoints(store);
  registerWriteTool(registry, async ({ path: filePath, content }) => {
    events.push("handler");
    assert.equal(store.list({ sessionId: "session-immediate" }).length, 1, "snapshot is durable before dispatch");
    assert.equal(fs.readFileSync(filePath, "utf8"), "before\n", "handler still sees the pre-mutation bytes");
    fs.writeFileSync(filePath, content, "utf8");
    return { path: filePath };
  });

  const context = { sessionId: "session-immediate", __turnId: "turn-immediate" };
  const args = { path: target, content: "after\n" };
  const result = await registry.invoke("code_write", args, context);

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["checkpoint:start", "checkpoint:done", "handler"]);
  assert.equal(fs.readFileSync(target, "utf8"), "after\n");

  const checkpoint = store.list({ sessionId: context.sessionId })[0];
  assert.equal(checkpoint.turnId, context.__turnId);
  assert.equal(checkpoint.toolNames.includes("code_write"), true);
  assert.deepEqual(checkpoint.targets, [target]);
  const preview = store.preview(checkpoint.id);
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].path, target);
  assert.equal(preview.files[0].status, "modified");

  const rolledBack = store.rollback(checkpoint.id, { decidedBy: "checkpoint-tool-test" });
  assert.deepEqual(rolledBack.restored, [target]);
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});

test("a checkpoint capture failure blocks destructive dispatch", async () => {
  const registry = new ToolRegistry();
  let handlerCalls = 0;
  registry.bindCheckpoints({
    async beforeToolCall({ toolName, args, context }) {
      assert.equal(toolName, "code_write");
      assert.deepEqual(args, { path: "blocked.txt", content: "never" });
      assert.equal(context.__turnId, "turn-blocked");
      throw new Error("checkpoint capture failed");
    }
  });
  registerWriteTool(registry, async () => {
    handlerCalls += 1;
    return { written: true };
  });

  const result = await registry.invoke(
    "code_write",
    { path: "blocked.txt", content: "never" },
    { sessionId: "session-blocked", __turnId: "turn-blocked" }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /checkpoint capture failed/i);
  assert.equal(handlerCalls, 0, "a mutation must not run without its checkpoint");
});

test("a denied credential edit cannot copy bytes into checkpoint blobs", async (t) => {
  const { dataDir, workspaceDir, store } = enabledStore(t);
  const target = path.join(workspaceDir, ".env");
  const canary = "checkpoint-secret-canary";
  fs.writeFileSync(target, `OPENAI_API_KEY=${canary}\n`, "utf8");
  let handlerCalls = 0;
  const registry = new ToolRegistry();
  registry.bindCheckpoints(store);
  registerWriteTool(registry, async () => {
    handlerCalls += 1;
    return { written: true };
  });

  const result = await registry.invoke(
    "code_write",
    { path: target, content: "replacement" },
    { sessionId: "session-secret", __turnId: "turn-secret" }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /sensitive credential material/);
  assert.equal(handlerCalls, 0);
  assert.equal(fs.readFileSync(target, "utf8").includes(canary), true);
  const checkpointDir = path.join(dataDir, "checkpoints");
  const persisted = fs.readdirSync(checkpointDir, { recursive: true })
    .filter((name) => fs.statSync(path.join(checkpointDir, name)).isFile())
    .map((name) => fs.readFileSync(path.join(checkpointDir, name)))
    .map((value) => value.toString("utf8"))
    .join("\n");
  assert.equal(persisted.includes(canary), false);
});

test("approval is resolved before checkpointing: queued calls capture nothing, confirmed calls do", async () => {
  const registry = new ToolRegistry();
  const queued = [];
  const captures = [];
  let handlerCalls = 0;
  registry.bindPendingActions({
    enqueue(action) {
      queued.push(action);
      return { id: "action-checkpoint", summary: action.summary };
    }
  });
  registry.bindCheckpoints({
    async beforeToolCall(request) {
      captures.push(request);
      return { enabled: true, destructive: true, targets: ["/"], checkpoints: [] };
    }
  });
  registry.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async () => {
      handlerCalls += 1;
      return { exitCode: 0 };
    }
  });

  // A catastrophic command always queues for a human, regardless of the
  // process-wide auto-approve setting used by either required test lane.
  const args = { command: "rm -rf /" };
  const context = { sessionId: "session-confirm", __turnId: "turn-confirm" };
  const pending = await registry.invoke("code_shell", args, context);
  assert.equal(pending.ok, true);
  assert.equal(pending.result.status, "awaiting_confirmation");
  assert.equal(queued.length, 1);
  assert.equal(captures.length, 0, "queuing is not a mutation and must not create a checkpoint");
  assert.equal(handlerCalls, 0);

  const confirmed = await registry.invoke("code_shell", args, { ...context, __confirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0], {
    toolName: "code_shell",
    args,
    context: { ...context, __confirmed: true }
  });
  assert.equal(handlerCalls, 1);
});

test("non-destructive tools create no checkpoints and a disabled store stays inert", async (t) => {
  const { root, workspaceDir, store } = enabledStore(t);
  const target = path.join(workspaceDir, "read-only.txt");
  fs.writeFileSync(target, "unchanged", "utf8");
  const registry = new ToolRegistry();
  registry.bindCheckpoints(store);
  registry.register({
    name: "code_read",
    sideEffects: false,
    handler: async ({ path: filePath }) => fs.readFileSync(filePath, "utf8")
  });

  const read = await registry.invoke("code_read", { path: target }, {
    sessionId: "session-read",
    __turnId: "turn-read",
    __scrutinyPolicy: "read-only"
  });
  assert.deepEqual(read, { ok: true, result: "unchanged" });
  assert.deepEqual(store.list(), []);

  const disabledDir = path.join(root, "disabled-checkpoints");
  const disabled = new CheckpointStore({
    dir: disabledDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: false
  });
  const disabledRegistry = new ToolRegistry();
  disabledRegistry.bindCheckpoints(disabled);
  let disabledHandlerCalls = 0;
  registerWriteTool(disabledRegistry, async () => {
    disabledHandlerCalls += 1;
    return { written: true };
  });
  const skipped = await disabledRegistry.invoke("code_write", {
    path: target,
    content: "not written by the test double"
  }, { sessionId: "session-disabled", __turnId: "turn-disabled" });

  assert.equal(skipped.ok, true);
  assert.equal(disabledHandlerCalls, 1, "disabled checkpoints add no dispatch gate");
  assert.deepEqual(disabled.list(), []);
  assert.equal(fs.existsSync(disabledDir), false, "disabled mode performs no checkpoint filesystem setup");
});

test("AgentHost keeps one turn id across destructive calls so the store dedupes per directory", async (t) => {
  const { workspaceDir, store } = enabledStore(t);
  const first = path.join(workspaceDir, "first.txt");
  const second = path.join(workspaceDir, "second.txt");
  fs.writeFileSync(first, "first-before", "utf8");
  fs.writeFileSync(second, "second-before", "utf8");

  const seenTurnIds = [];
  const originalBeforeToolCall = store.beforeToolCall.bind(store);
  store.beforeToolCall = async (request) => {
    seenTurnIds.push(request.context.__turnId);
    return originalBeforeToolCall(request);
  };
  const registry = new ToolRegistry();
  registry.bindCheckpoints(store);
  registerWriteTool(registry, async ({ path: filePath, content }) => {
    fs.writeFileSync(filePath, content, "utf8");
    return { path: filePath };
  });

  const modelProvider = {
    model: "checkpoint-test-model",
    isConfigured: () => true,
    async generate({ toolRegistry, context }) {
      const firstResult = await toolRegistry.invoke("code_write", { path: first, content: "first-after" }, context);
      const secondResult = await toolRegistry.invoke("code_write", { path: second, content: "second-after" }, context);
      return {
        provider: "test",
        model: "checkpoint-test-model",
        text: "done",
        toolCalls: [
          { name: "code_write", arguments: { path: first }, result: firstResult },
          { name: "code_write", arguments: { path: second }, result: secondResult }
        ],
        iterations: 1,
        maxIterations: 25,
        stopReason: "completed"
      };
    }
  };
  const runtime = {
    tools: registry,
    memory: null,
    outcomes: null,
    processSignal: () => ({
      id: "output-checkpoint",
      scrutiny: {
        action: "act",
        score: 0.9,
        reasons: [],
        dimensions: { novelty: 0.5, risk: 0.2, repetition: 0.1 }
      },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({ runtime, modelProvider });

  const result = await host.handleMessage({
    text: "write both checkpoint fixtures",
    channel: "local",
    from: "tester",
    ephemeral: true,
    turnId: "turn-host-stable"
  });

  assert.equal(result.id, "turn-host-stable");
  assert.deepEqual(seenTurnIds, ["turn-host-stable", "turn-host-stable"]);
  const checkpoints = store.list({ sessionId: "local:tester:main" });
  assert.equal(checkpoints.length, 1, "same directory and turn share one checkpoint");
  assert.equal(checkpoints[0].turnId, result.id);
  assert.deepEqual([...checkpoints[0].targets].sort(), [first, second].sort());

  store.rollback(checkpoints[0].id, { decidedBy: "checkpoint-tool-test" });
  assert.equal(fs.readFileSync(first, "utf8"), "first-before");
  assert.equal(fs.readFileSync(second, "utf8"), "second-before");
});

test("checkpoint core tools expose read-only listing and confirmation-gated rollback", async () => {
  const listCalls = [];
  const previewCalls = [];
  const rollbackCalls = [];
  const checkpoint = {
    id: "checkpoint-1",
    turnId: "turn-1",
    sessionId: "session-core",
    directory: "/workspace",
    targets: ["/workspace/file.txt"]
  };
  const checkpoints = {
    list(options) {
      listCalls.push(options);
      return [checkpoint];
    },
    preview(id) {
      previewCalls.push(id);
      return { checkpoint, files: [], truncated: false };
    },
    rollback(id, options) {
      rollbackCalls.push({ id, options });
      return { checkpointId: id, restored: [options.path], removed: [], at: "2026-07-22T00:00:00.000Z" };
    }
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, { checkpoints });

  const listTool = registry.get("list_checkpoints");
  const rollbackTool = registry.get("rollback");
  assert.equal(listTool.sideEffects, false);
  assert.equal(listTool.needsConfirmation, false);
  assert.equal(rollbackTool.sideEffects, true);
  assert.equal(rollbackTool.needsConfirmation, true);
  assert.deepEqual(rollbackTool.parameters.required, ["checkpointId"]);

  const listed = await registry.invoke("list_checkpoints", { limit: 3, directory: "/workspace" }, {
    sessionId: "session-core",
    __scrutinyPolicy: "read-only"
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listCalls, [{ limit: 3, sessionId: "session-core", directory: "/workspace" }]);
  assert.deepEqual(previewCalls, ["checkpoint-1"]);
  assert.equal(listed.result.enabled, true);
  assert.equal(listed.result.count, 1);
  assert.deepEqual(listed.result.checkpoints[0].preview, { checkpoint, files: [], truncated: false });

  const rolledBack = await registry.invoke("rollback", {
    checkpointId: "checkpoint-1",
    path: "/workspace/file.txt"
  }, {
    sessionId: "session-core",
    from: "fallback-user",
    __confirmed: true,
    __approval: { decider: "creator", description: "rollback requested" }
  });
  assert.equal(rolledBack.ok, true);
  assert.deepEqual(rollbackCalls, [{
    id: "checkpoint-1",
    options: { path: "/workspace/file.txt", decidedBy: "creator", sessionId: "session-core" }
  }]);
  assert.match(rolledBack.result.approvalNote, /approved by the user/i);
});

test("checkpoint core tools fail closed cleanly when the runtime store is disabled", async () => {
  const registry = new ToolRegistry();
  registerCoreTools(registry, {});

  const listed = await registry.invoke("list_checkpoints", {}, {
    sessionId: "session-disabled",
    __scrutinyPolicy: "read-only"
  });
  assert.deepEqual(listed, { ok: true, result: { enabled: false, checkpoints: [] } });

  const rollback = await registry.invoke("rollback", { checkpointId: "missing" }, { __confirmed: true });
  assert.equal(rollback.ok, false);
  assert.match(rollback.error, /checkpoints are disabled/i);
});

test("checkpoint env and both agent-facing tools are present in setup and prompt surfaces", () => {
  assert.equal(SETUP_FIELDS.includes("OPENAGI_CHECKPOINTS"), true);
  const prompt = buildDefaultInstructions({ agent: { name: "Checkpoint Tester" } });
  assert.match(prompt, /list_checkpoints/);
  assert.match(prompt, /rollback/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { registerCodeTools, mintTag } from "../src/code-tools.js";
import {
  CoderController,
  CoderRunStore,
  registerCoderTools
} from "../src/coder-controller.js";
import { IsolatedCodeVerifier } from "../src/coder-verifier.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

function harness(t, { verifier = new IsolatedCodeVerifier() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coder-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceDir = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const tools = new ToolRegistry();
  const checkpoints = new CheckpointStore({
    dataDir,
    dir: path.join(dataDir, "checkpoints"),
    workspaceDir,
    enabled: true
  });
  tools.bindCheckpoints(checkpoints);
  const runtime = {
    tools,
    checkpoints,
    codeVerifier: verifier
  };
  registerCodeTools(tools, runtime, { codeVerifier: verifier });
  const store = new CoderRunStore({ dir: path.join(dataDir, "coder-runs") });
  const coder = new CoderController({
    runtime,
    workspaceDir,
    dataDir,
    checkpoints,
    store
  });
  runtime.coder = coder;
  registerCoderTools(tools, runtime);
  const context = {
    sessionId: "coder-session",
    __projectWorkspaceDir: workspaceDir,
    __turnId: "coder-turn"
  };
  return { coder, context, dataDir, root, runtime, store, tools, workspaceDir };
}

function writeFixture(workspaceDir, expected = 2) {
  const source = path.join(workspaceDir, "value.mjs");
  const testFile = path.join(workspaceDir, "value.test.mjs");
  const initial = "export const value = 1;\n";
  fs.writeFileSync(source, initial);
  fs.writeFileSync(testFile, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from './value.mjs';",
    `test('value', () => assert.equal(value, ${expected}));`,
    ""
  ].join("\n"));
  return { source, testFile, initial };
}

async function startRun(tools, context, source, checks) {
  const content = fs.readFileSync(source, "utf8");
  const result = await tools.invoke("coder_start", {
    objective: "Update the exported value with verified evidence.",
    files: [{ path: "value.mjs", tag: mintTag(content) }],
    plan: [
      "Update the inspected export.",
      "Run syntax and targeted regression checks."
    ],
    checks
  }, context);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.state, "planned");
  return result.result;
}

test("coder transaction accepts completion only after isolated checks pass", async (t) => {
  const { context, dataDir, tools, workspaceDir } = harness(t);
  const { source } = writeFixture(workspaceDir, 2);
  const run = await startRun(tools, context, source, [
    { type: "syntax", path: "value.mjs" },
    { type: "test", path: "value.test.mjs" }
  ]);
  const applied = await tools.invoke("coder_apply", {
    runId: run.id,
    expectedRevision: run.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: run.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }],
      summary: "Update verified fixture"
    }]
  }, context);

  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.result.run.state, "passed");
  assert.equal(applied.result.run.verification.status, "passed");
  assert.equal(applied.result.run.edits.length, 1);
  assert.equal(applied.result.run.edits[0].receipt.tool, "code_edit");
  assert.match(fs.readFileSync(source, "utf8"), /value = 2/);

  const recovered = new CoderRunStore({
    dir: path.join(dataDir, "coder-runs")
  }).get(run.id);
  assert.equal(recovered.state, "passed");
  assert.equal(recovered.verification.results.length, 2);
});

test("failed verification automatically restores the inspected baseline", async (t) => {
  const { context, tools, workspaceDir } = harness(t);
  const { source, initial } = writeFixture(workspaceDir, 1);
  const run = await startRun(tools, context, source, [
    { type: "test", path: "value.test.mjs" }
  ]);
  const applied = await tools.invoke("coder_apply", {
    runId: run.id,
    expectedRevision: run.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: run.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);
  const status = await tools.invoke("coder_status", { runId: run.id }, context);

  assert.equal(applied.ok, false);
  assert.equal(status.result.state, "rolled_back");
  assert.equal(status.result.verification.status, "failed");
  assert.equal(status.result.rollback.status, "complete");
  assert.equal(fs.readFileSync(source, "utf8"), initial);
  assert.equal(applied.outcome.changed, false);
});

test("incomplete passing evidence fails closed and restores the baseline", async (t) => {
  const verifier = {
    verify: async () => ({
      ok: true,
      status: "passed",
      checksPlanned: 1,
      checksCompleted: 1,
      durationMs: 1,
      results: []
    })
  };
  const { context, tools, workspaceDir } = harness(t, { verifier });
  const { source, initial } = writeFixture(workspaceDir, 2);
  const run = await startRun(tools, context, source, [
    { type: "test", path: "value.test.mjs" }
  ]);
  const applied = await tools.invoke("coder_apply", {
    runId: run.id,
    expectedRevision: run.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: run.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);

  assert.equal(applied.ok, false);
  assert.equal(applied.result.run.state, "rolled_back");
  assert.equal(applied.result.run.verification.status, "passed");
  assert.equal(applied.result.run.verification.results.length, 0);
  assert.equal(fs.readFileSync(source, "utf8"), initial);
});

test("rollback refuses to overwrite a version changed outside controller ownership", async (t) => {
  let source;
  const verifier = {
    verify: async () => {
      fs.writeFileSync(source, "export const value = 99;\n");
      return {
        ok: false,
        status: "failed",
        checksPlanned: 1,
        checksCompleted: 1,
        durationMs: 1,
        results: [{
          type: "test",
          path: "value.test.mjs",
          ok: false,
          code: "exit_1",
          durationMs: 1,
          tail: "fixture failure"
        }]
      };
    }
  };
  const { context, tools, workspaceDir } = harness(t, { verifier });
  ({ source } = writeFixture(workspaceDir, 1));
  const run = await startRun(tools, context, source, [
    { type: "test", path: "value.test.mjs" }
  ]);
  const applied = await tools.invoke("coder_apply", {
    runId: run.id,
    expectedRevision: run.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: run.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);
  const status = await tools.invoke("coder_status", { runId: run.id }, context);

  assert.equal(applied.ok, false);
  assert.equal(status.result.state, "blocked");
  assert.equal(status.result.error.code, "rollback_ownership_lost");
  assert.match(fs.readFileSync(source, "utf8"), /value = 99/);
  assert.equal(applied.outcome.changed, null);
});

test("active coder runs reconcile to blocked after restart", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coder-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CoderRunStore({ dir: root });
  let run = store.create({
    projectId: "default",
    sessionId: "session",
    workspaceRoot: process.cwd(),
    objective: "Persist state",
    plan: ["Edit"],
    files: [{
      path: "src/example.js",
      tag: "a".repeat(64),
      missing: false,
      checkpointId: "cp_example"
    }],
    checks: [{ type: "syntax", path: "src/example.js" }]
  });
  run = store.update(run.id, run.revision, { state: "editing" });

  const recovered = new CoderRunStore({ dir: root }).get(run.id);
  assert.equal(recovered.state, "blocked");
  assert.equal(recovered.error.code, "controller_interrupted");
  assert.ok(fs.existsSync(path.join(root, "events.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "snapshot.json")));
});

test("coder tools and static guidance expose the durable protocol", () => {
  const names = [];
  const controller = {
    jobResources: () => ["workspace/file/test"],
    start: async () => ({}),
    apply: async () => ({}),
    status: () => ({}),
    rollback: () => ({})
  };
  const registry = {
    register(spec) { names.push(spec); }
  };
  registerCoderTools(registry, { coder: controller });
  assert.deepEqual(names.map((tool) => tool.name), [
    "coder_start",
    "coder_apply",
    "coder_status",
    "coder_rollback"
  ]);
  assert.equal(names.find((tool) => tool.name === "coder_rollback").needsConfirmation, true);
  const prompt = buildDefaultInstructions({ agent: { name: "Coder" } });
  assert.match(prompt, /coder_start\(objective, files, plan, checks\)/);
  assert.match(prompt, /Treat only state=passed as complete/);
});

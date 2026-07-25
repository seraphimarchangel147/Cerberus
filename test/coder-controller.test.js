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
  const identifiedChecks = checks.map((check, index) => ({
    id: `check_${index + 1}`,
    ...check
  }));
  const result = await tools.invoke("coder_start", {
    objective: "Update the exported value with verified evidence.",
    files: [{ path: "value.mjs", tag: mintTag(content) }],
    plan: [
      "Update the inspected export.",
      "Run syntax and targeted regression checks."
    ],
    checks: identifiedChecks,
    criteria: [{
      id: "exported_value",
      statement: "The exported value satisfies its targeted regression checks.",
      kind: "behavior",
      oracle: "test",
      checkIds: identifiedChecks.map((check) => check.id)
    }]
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
  assert.equal(applied.result.run.acceptance.status, "passed");
  assert.equal(applied.result.run.acceptance.summary.requiredPassed, 1);
  assert.equal(applied.result.run.acceptance.evidence.length, 2);
  assert.match(applied.result.run.acceptance.sourceRevision, /^[a-f0-9]{64}$/);
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
  assert.equal(applied.result.run.verification.status, "failed");
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
  assert.match(prompt, /coder_start\(objective, files, plan, checks, criteria\)/);
  assert.match(prompt, /acceptance\.status=passed/);
});

test("coder start rejects acceptance criteria that cannot be proven", async (t) => {
  const { context, tools, workspaceDir } = harness(t);
  const { source } = writeFixture(workspaceDir, 2);
  const result = await tools.invoke("coder_start", {
    objective: "Bind completion to an exact check.",
    files: [{
      path: "value.mjs",
      tag: mintTag(fs.readFileSync(source, "utf8"))
    }],
    plan: ["Verify the requested behavior."],
    checks: [{
      id: "targeted_test",
      type: "test",
      path: "value.test.mjs"
    }],
    criteria: [{
      id: "behavior",
      statement: "The requested behavior passes.",
      kind: "behavior",
      oracle: "test",
      checkIds: ["missing_check"]
    }]
  }, context);

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown ASCII check id/);
});

test("non-test evidence cannot self-certify coder completion", async (t) => {
  const { context, tools, workspaceDir } = harness(t);
  const { source, initial } = writeFixture(workspaceDir, 2);
  const content = fs.readFileSync(source, "utf8");
  const started = await tools.invoke("coder_start", {
    objective: "Require independent visual proof.",
    files: [{ path: "value.mjs", tag: mintTag(content) }],
    plan: ["Update the export.", "Require visual evidence."],
    checks: [{
      id: "targeted_test",
      type: "test",
      path: "value.test.mjs"
    }],
    criteria: [{
      id: "visual_state",
      statement: "The visible state matches the requested design.",
      kind: "visual",
      oracle: "screenshot",
      checkIds: ["targeted_test"]
    }]
  }, context);
  assert.equal(started.ok, true, started.error);

  const applied = await tools.invoke("coder_apply", {
    runId: started.result.id,
    expectedRevision: started.result.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: started.result.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);

  assert.equal(applied.ok, false);
  assert.equal(applied.result.run.state, "rolled_back");
  assert.equal(applied.result.run.acceptance.status, "pending");
  assert.equal(fs.readFileSync(source, "utf8"), initial);
});

test("acceptance criteria remain immutable after planning", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coder-criteria-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CoderRunStore({ dir: root });
  const run = store.create({
    projectId: "default",
    sessionId: "session",
    workspaceRoot: process.cwd(),
    objective: "Keep intent fixed",
    plan: ["Verify"],
    files: [{
      path: "src/example.js",
      tag: "a".repeat(64),
      missing: false,
      checkpointId: "cp_example"
    }],
    checks: [{ id: "syntax_check", type: "syntax", path: "src/example.js" }],
    criteria: [{
      id: "syntax_valid",
      statement: "The file remains valid JavaScript.",
      kind: "compatibility",
      oracle: "test",
      checkIds: ["syntax_check"]
    }]
  });

  assert.throws(
    () => store.update(run.id, run.revision, {
      acceptance: {
        ...run.acceptance,
        criteria: [{
          ...run.acceptance.criteria[0],
          statement: "Move the goalposts."
        }]
      }
    }),
    /immutable/
  );
});

test("coder completion accepts browser, visual, keyboard, screenshot, and accessibility proof from exact QA revision", async (t) => {
  const { context, tools, workspaceDir } = harness(t);
  const { source } = writeFixture(workspaceDir, 2);
  const qaCalls = [];
  const screenshotRef = `qaart_${"b".repeat(64)}`;
  tools.register({
    name: "qa_run",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        manifestPath: { type: "string" },
        mode: { type: "string" },
        sourceRevision: { type: "string" }
      },
      required: ["manifestPath", "mode", "sourceRevision"],
      additionalProperties: false
    },
    handler: async (args) => {
      qaCalls.push(args);
      return {
        ok: true,
        status: "passed",
        run: {
          id: "qa_0123456789abcdef",
          state: "passed",
          sourceRevision: args.sourceRevision,
          artifacts: [screenshotRef],
          results: [{
            status: "passed",
            screenshotRef,
            accessibility: {
              supported: true,
              violations: 0,
              incomplete: 0
            },
            keyboard: {
              supported: true,
              missing: 0,
              focusVisibleFailures: 0,
              trapped: false
            },
            visual: {
              status: "matched"
            }
          }],
          summary: { failed: 0 },
          error: null
        }
      };
    }
  });
  const content = fs.readFileSync(source, "utf8");
  const started = await tools.invoke("coder_start", {
    objective: "Update the visible value and prove the rendered behavior.",
    files: [{ path: "value.mjs", tag: mintTag(content) }],
    plan: ["Update the export.", "Run the exact UI evidence contract."],
    checks: [{
      id: "ui_contract",
      type: "qa",
      manifestPath: "qa-manifest.json",
      mode: "full"
    }],
    criteria: [
      {
        id: "browser_behavior",
        statement: "The browser behavior passes.",
        kind: "behavior",
        oracle: "browser",
        checkIds: ["ui_contract"]
      },
      {
        id: "visual_capture",
        statement: "The requested state has screenshot evidence.",
        kind: "visual",
        oracle: "screenshot",
        checkIds: ["ui_contract"]
      },
      {
        id: "accessible_state",
        statement: "The requested state passes accessibility checks.",
        kind: "accessibility",
        oracle: "accessibility",
        checkIds: ["ui_contract"]
      },
      {
        id: "keyboard_state",
        statement: "Every control is keyboard reachable with visible focus.",
        kind: "accessibility",
        oracle: "keyboard",
        checkIds: ["ui_contract"]
      },
      {
        id: "visual_match",
        statement: "The requested state matches its approved visual baseline.",
        kind: "visual",
        oracle: "visual",
        checkIds: ["ui_contract"]
      }
    ]
  }, context);
  assert.equal(started.ok, true, started.error);

  const applied = await tools.invoke("coder_apply", {
    runId: started.result.id,
    expectedRevision: started.result.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: started.result.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);

  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.result.run.state, "passed");
  assert.equal(applied.result.run.acceptance.status, "passed");
  assert.equal(applied.result.run.acceptance.summary.requiredPassed, 5);
  assert.equal(qaCalls.length, 1);
  assert.match(qaCalls[0].sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(
    applied.result.run.verification.results[0].evidence.screenshotRefs[0],
    screenshotRef
  );
});

test("failed QA evidence rolls coder-owned edits back", async (t) => {
  const { context, tools, workspaceDir } = harness(t);
  const { source, initial } = writeFixture(workspaceDir, 2);
  tools.register({
    name: "qa_run",
    sideEffects: false,
    handler: async (args) => ({
      ok: false,
      status: "failed",
      run: {
        id: "qa_fedcba9876543210",
        state: "failed",
        sourceRevision: args.sourceRevision,
        artifacts: [],
        results: [{
          status: "failed",
          screenshotRef: null,
          accessibility: {
            supported: true,
            violations: 1,
            incomplete: 0
          }
        }],
        summary: { failed: 1 },
        error: {
          code: "qa_evidence_failed",
          message: "Button behavior failed."
        }
      }
    })
  });
  const content = fs.readFileSync(source, "utf8");
  const started = await tools.invoke("coder_start", {
    objective: "Reject an unproven interface change.",
    files: [{ path: "value.mjs", tag: mintTag(content) }],
    plan: ["Update.", "Verify UI."],
    checks: [{
      id: "ui_contract",
      type: "qa",
      manifestPath: "qa-manifest.json",
      mode: "full"
    }],
    criteria: [{
      id: "browser_behavior",
      statement: "The browser behavior passes.",
      kind: "behavior",
      oracle: "browser",
      checkIds: ["ui_contract"]
    }]
  }, context);
  assert.equal(started.ok, true, started.error);

  const applied = await tools.invoke("coder_apply", {
    runId: started.result.id,
    expectedRevision: started.result.revision,
    operations: [{
      kind: "edit",
      path: "value.mjs",
      tag: started.result.files[0].tag,
      edits: [{ start: 1, end: 1, replace: "export const value = 2;" }]
    }]
  }, context);

  assert.equal(applied.ok, false);
  assert.equal(applied.result.run.state, "rolled_back");
  assert.equal(applied.result.run.acceptance.status, "failed");
  assert.equal(fs.readFileSync(source, "utf8"), initial);
});

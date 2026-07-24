import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AbiRuntime } from "../src/abi-runtime.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerWorkspaceTimelineTools } from "../src/workspace-timeline-store.js";

test("workspace timeline tools expose bounded schemas and recovery approvals", () => {
  const calls = [];
  const runtime = {
    timeline: {
      list: (options) => {
        calls.push(["list", options]);
        return [];
      },
      diff: (...args) => {
        calls.push(["diff", ...args]);
        return { items: [] };
      },
      preview: (...args) => {
        calls.push(["preview", ...args]);
        return { items: [] };
      },
      travel: (...args) => {
        calls.push(["travel", ...args]);
        return { operation: { status: "complete" } };
      },
      revert: (...args) => {
        calls.push(["revert", ...args]);
        return { operation: { status: "complete" } };
      }
    }
  };
  const registry = new ToolRegistry();
  registerWorkspaceTimelineTools(registry, runtime);
  const tools = new Map(registry.list().map((tool) => [tool.name, tool]));
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "timeline_diff",
      "timeline_list",
      "timeline_preview",
      "timeline_revert",
      "timeline_travel"
    ]
  );
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.metadata.toolSearch, "deferred");
  }
  assert.equal(tools.get("timeline_list").sideEffects, false);
  assert.equal(tools.get("timeline_diff").sideEffects, false);
  assert.equal(tools.get("timeline_preview").sideEffects, false);
  assert.equal(tools.get("timeline_travel").needsConfirmation, true);
  assert.equal(tools.get("timeline_revert").needsConfirmation, true);
  assert.deepEqual(
    tools.get("timeline_travel").capability.resources,
    ["filesystem"]
  );

  const instructions = buildDefaultInstructions({
    agent: { name: "Timeline test" }
  });
  for (const name of [
    "timeline_list",
    "timeline_diff",
    "timeline_preview",
    "timeline_travel",
    "timeline_revert"
  ]) {
    assert.match(instructions, new RegExp(`\\b${name}\\b`, "u"));
  }
  assert.match(instructions, /checkpoints as the fast pre-mutation safety gate/u);
});

test("registry schedules post-dispatch filesystem captures on success and failure only", async () => {
  const scheduled = [];
  const registry = new ToolRegistry();
  registry.bindTimeline({
    schedulePostMutation(request) {
      scheduled.push(request);
    }
  });
  registry.register({
    name: "test_fs_write",
    capability: { resources: ["filesystem"] },
    handler: async () => ({ written: true })
  });
  registry.register({
    name: "test_fs_failure",
    capability: { resources: ["filesystem"] },
    handler: async () => {
      throw new Error("partial write");
    }
  });
  registry.register({
    name: "test_read",
    sideEffects: false,
    capability: { resources: ["filesystem"] },
    handler: async () => ({ read: true })
  });

  const context = {
    sessionId: "timeline-tools"
  };
  const success = await registry.invoke("test_fs_write", {}, context);
  const failure = await registry.invoke("test_fs_failure", {}, context);
  const read = await registry.invoke("test_read", {}, context);
  const blocked = await registry.invoke("test_fs_write", {}, {
    ...context,
    __scrutinyPolicy: "read-only"
  });

  assert.equal(success.ok, true);
  assert.equal(failure.ok, false);
  assert.equal(read.ok, true);
  assert.equal(blocked.ok, false);
  assert.deepEqual(
    scheduled.map((item) => [item.toolName, item.dispatched]),
    [["test_fs_write", true], ["test_fs_failure", true]]
  );
  assert.equal(Object.hasOwn(scheduled[0], "args"), false);
});

test("timeline scheduling is advisory and never changes the tool result", async () => {
  const registry = new ToolRegistry({
    timeline: {
      schedulePostMutation() {
        throw new Error("timeline offline");
      }
    }
  });
  registry.register({
    name: "test_fs_write",
    capability: { resources: ["filesystem"] },
    handler: async () => ({ written: true })
  });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const result = await registry.invoke("test_fs_write", {}, {});
    assert.equal(result.ok, true);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /capture scheduling failed/u);
});

test("registered timeline handlers carry project context and expected-head CAS", async () => {
  const calls = [];
  const runtime = {
    timeline: {
      list: (options) => {
        calls.push(["list", options]);
        return [];
      },
      diff: () => ({}),
      preview: () => ({}),
      travel: (id, options) => {
        calls.push(["travel", id, options]);
        return { id };
      },
      revert: () => ({})
    }
  };
  const registry = new ToolRegistry();
  registerWorkspaceTimelineTools(registry, runtime);
  const id = "timeline_0123456789abcdef";
  const result = await registry.invoke(
    "timeline_travel",
    { id, expectedHead: id },
    {
      __confirmed: true,
      sessionId: "timeline-session",
      agentId: "main"
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], [
    "travel",
    id,
    {
      projectId: "default",
      workspaceRoot: undefined,
      sessionId: "timeline-session",
      expectedHead: id,
      decidedBy: "main"
    }
  ]);
});

test("AbiRuntime binds, registers, flushes, and closes the workspace timeline", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-timeline-runtime-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspace);
  fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = new AbiRuntime({
    dataDir,
    workspaceDir: workspace,
    skills: false
  });
  t.after(() => runtime.close());
  for (const name of [
    "timeline_list",
    "timeline_diff",
    "timeline_preview",
    "timeline_travel",
    "timeline_revert"
  ]) {
    assert.equal(runtime.tools.has(name), true);
  }
  runtime.tools.register({
    name: "test_runtime_fs_write",
    capability: { resources: ["filesystem"] },
    handler: async () => {
      fs.writeFileSync(path.join(workspace, "state.txt"), "runtime\n");
      return { written: true };
    }
  });
  const project = runtime.projects.get("default");
  const result = await runtime.tools.invoke(
    "test_runtime_fs_write",
    {},
    {
      sessionId: "timeline-runtime",
      __projectId: project.id,
      __projectRevision: project.revision,
      __projectWorkspaceDir: project.workspaceRoot
    }
  );
  assert.equal(result.ok, true);
  const flushed = runtime.timeline.flush("default");
  assert.equal(flushed.length, 1);
  assert.equal(runtime.timeline.list({ projectId: "default" }).length, 1);
  await runtime.close();
});

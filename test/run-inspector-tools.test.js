import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRuntime } from "../src/abi-runtime.js";

function freshRuntime(options = {}) {
  // Isolated data dir per test — createDefaultRuntime() otherwise shares the
  // global ~/.openagi dir and live state leaks between runs.
  return createDefaultRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "run-inspector-tools-test-")),
    ...options
  });
}

const CTX = {
  channel: "local",
  from: "tester",
  agentId: "main",
  sessionId: "run-inspector-tools-test"
};

function seedTurn(runtime, {
  runId,
  projectId = "default",
  status = "succeeded",
  metadata = {}
}) {
  runtime.runInspector.recordTurn({
    runId,
    projectId,
    sessionId: `${runId}-session`,
    phase: "finalize",
    status,
    metadata
  });
}

test("list_runs and run_detail are registered", () => {
  const runtime = freshRuntime();
  const names = runtime.tools.list().map((t) => t.name);
  assert.ok(names.includes("list_runs"), "list_runs tool missing");
  assert.ok(names.includes("run_detail"), "run_detail tool missing");
});

test("list_runs returns seeded runs for the current project", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_probe_alpha" });
  seedTurn(runtime, { runId: "turn_probe_beta", status: "failed" });

  const out = await runtime.tools.invoke("list_runs", {}, CTX);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.projectId, "default");
  const ids = out.result.runs.map((run) => run.runId);
  assert.ok(ids.includes("turn_probe_alpha"), `missing alpha in ${ids}`);
  assert.ok(ids.includes("turn_probe_beta"), `missing beta in ${ids}`);
});

test("list_runs kind/status filters and limit clamp work", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_filter_ok", status: "succeeded" });
  seedTurn(runtime, { runId: "turn_filter_bad", status: "failed" });

  const failedOnly = await runtime.tools.invoke(
    "list_runs",
    { kind: "turn", status: "failed" },
    CTX
  );
  assert.equal(failedOnly.ok, true, JSON.stringify(failedOnly));
  const ids = failedOnly.result.runs.map((run) => run.runId);
  assert.ok(ids.includes("turn_filter_bad"));
  assert.ok(!ids.includes("turn_filter_ok"), "status filter leaked a succeeded run");

  const clamped = await runtime.tools.invoke("list_runs", { limit: 999999 }, CTX);
  assert.equal(clamped.ok, true, JSON.stringify(clamped));
});

test("run_detail returns the run for the owning project", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_detail_probe", metadata: { model: "probe-model" } });

  const out = await runtime.tools.invoke(
    "run_detail",
    { kind: "turn", runId: "turn_detail_probe" },
    CTX
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.found, true);
  assert.equal(out.result.run.runId, "turn_detail_probe");
  assert.equal(out.result.run.projectId, "default");
});

test("run_detail on an unknown run reports not-found, not a crash", async () => {
  const runtime = freshRuntime();
  const out = await runtime.tools.invoke(
    "run_detail",
    { kind: "turn", runId: "turn_does_not_exist" },
    CTX
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.found, false);
  assert.match(out.result.message, /No turn run/);
});

test("runs are fail-closed across projects", async () => {
  const runtime = freshRuntime();
  if (!runtime.projects.get("beta")) {
    runtime.projects.create({ id: "beta", name: "Beta", policy: { allowedTools: ["*"] } });
  }
  runtime.projects.resolveForSession("beta-session", { requestedProjectId: "beta" });
  seedTurn(runtime, { runId: "turn_default_only", projectId: "default" });

  const betaCtx = {
    ...CTX,
    sessionId: "beta-session",
    __projectId: "beta",
    __projectRevision: runtime.projects.get("beta").revision
  };
  const listed = await runtime.tools.invoke("list_runs", {}, betaCtx);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.result.projectId, "beta");
  assert.equal(
    listed.result.runs.some((run) => run.runId === "turn_default_only"),
    false,
    "default-project run leaked into beta listing"
  );

  const detail = await runtime.tools.invoke(
    "run_detail",
    { kind: "turn", runId: "turn_default_only" },
    betaCtx
  );
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.result.found, false, "cross-project run_detail must not find the run");
});

test("tools fail with a clear error when the inspector is disabled", async () => {
  const runtime = freshRuntime({ runInspector: false });
  const out = await runtime.tools.invoke("list_runs", {}, CTX);
  assert.equal(out.ok, false, "list_runs without an inspector must fail");
  assert.match(JSON.stringify(out), /Run inspector is not available/);
});

test("list_runs output stays content-free (metadata allowlist)", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, {
    runId: "turn_redaction_probe",
    metadata: {
      model: "probe-model",
      prompt: "SECRET PROMPT CONTENT",
      toolName: "code_edit"
    }
  });
  const out = await runtime.tools.invoke("list_runs", {}, CTX);
  assert.equal(out.ok, true, JSON.stringify(out));
  const serialized = JSON.stringify(out.result);
  assert.ok(!serialized.includes("SECRET PROMPT CONTENT"), "content leaked into list output");
});

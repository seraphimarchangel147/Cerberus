import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { SessionProjectionStore } from "../src/session-projection.js";

function freshRuntime(options = {}) {
  // Isolated data dir per test — createDefaultRuntime() otherwise shares the
  // global ~/.openagi dir and live state leaks between runs.
  return createDefaultRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "session-projection-test-")),
    ...options
  });
}

const CTX = {
  channel: "local",
  from: "tester",
  agentId: "main",
  sessionId: "session-projection-test"
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

test("projection tools are registered", () => {
  const runtime = freshRuntime();
  const names = runtime.tools.list().map((tool) => tool.name);
  for (const name of [
    "projection_capture",
    "projection_list",
    "projection_diff",
    "projection_export"
  ]) {
    assert.ok(names.includes(name), `${name} tool missing`);
  }
});

test("capture persists and provenance is stable for unchanged state", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_stable" });

  const first = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.result.id, /^proj_[a-f0-9]{16}$/);
  assert.equal(first.result.runCount, 1);

  const second = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(first.result.id, second.result.id);
  assert.equal(
    first.result.provenanceHash,
    second.result.provenanceHash,
    "unchanged system state must yield the same provenance hash"
  );

  const listed = await runtime.tools.invoke("projection_list", {}, CTX);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.result.count, 2);
  const ids = listed.result.projections.map((p) => p.id);
  assert.ok(ids.includes(first.result.id) && ids.includes(second.result.id));
});

test("diff against live state detects run status transitions", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_flip", status: "succeeded" });
  const cut = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(cut.ok, true, JSON.stringify(cut));

  // Same runId re-recorded with a new status — the inspector updates in place.
  seedTurn(runtime, { runId: "turn_proj_flip", status: "failed" });

  const diff = await runtime.tools.invoke(
    "projection_diff",
    { fromId: cut.result.id },
    CTX
  );
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(diff.result.identical, false);
  assert.equal(diff.result.to.id, null, "omitted toId diffs against live state");
  const flip = diff.result.statusChanged.find((c) => c.runId === "turn_proj_flip");
  assert.ok(flip, `status transition missing in ${JSON.stringify(diff.result)}`);
  assert.equal(flip.from, "succeeded");
  assert.equal(flip.to, "failed");
});

test("diff of two captures of unchanged state is identical", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_same" });
  const a = await runtime.tools.invoke("projection_capture", {}, CTX);
  const b = await runtime.tools.invoke("projection_capture", {}, CTX);
  const diff = await runtime.tools.invoke(
    "projection_diff",
    { fromId: a.result.id, toId: b.result.id },
    CTX
  );
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(diff.result.identical, true);
  assert.equal(diff.result.statusChanged.length, 0);
  assert.equal(diff.result.runsAdded.length, 0);
  assert.equal(diff.result.timelineHeadChanged, false);
});

test("projections are fail-closed across projects", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_scoped" });
  const cut = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(cut.ok, true, JSON.stringify(cut));

  const otherCtx = { ...CTX, __projectId: "other" };
  // Unknown projects are blocked at the harness project_scope gate before the
  // handler runs — the strongest fail-closed layer. Assert the block, then
  // verify the store's own cross-project semantics directly.
  const exported = await runtime.tools.invoke(
    "projection_export",
    { id: cut.result.id },
    otherCtx
  );
  assert.equal(exported.ok, false, "cross-project export must fail closed");
  const listed = await runtime.tools.invoke("projection_list", {}, otherCtx);
  assert.equal(listed.ok, false, "unknown project must be blocked at the gate");

  const storeGet = runtime.projections.get({
    projectId: "other",
    id: cut.result.id
  });
  assert.equal(storeGet, null, "store must not leak cuts across projects");
  const storeList = runtime.projections.list({ projectId: "other" });
  assert.equal(storeList.length, 0, "other project must not see default's cuts");
});

test("export applies the redaction waterfall and the severity ladder", async () => {
  const runtime = freshRuntime();
  const tokenishRunId = `sk-ant-${"a".repeat(20)}`;
  seedTurn(runtime, { runId: tokenishRunId, status: "failed" });
  seedTurn(runtime, { runId: "turn_proj_clean", status: "succeeded" });

  const cut = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(cut.ok, true, JSON.stringify(cut));
  const exported = await runtime.tools.invoke(
    "projection_export",
    { id: cut.result.id },
    CTX
  );
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.result.severity, "err", "failed run must escalate severity");
  assert.equal(exported.result.provenanceHash, cut.result.provenanceHash);

  const serialized = JSON.stringify(exported.result);
  assert.ok(
    !serialized.includes(tokenishRunId),
    "credential-shaped run id reached the export envelope unredacted"
  );
  assert.ok(serialized.includes("[REDACTED]"));
});

test("export severity is info for a clean cut", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_info", status: "succeeded" });
  const cut = await runtime.tools.invoke("projection_capture", {}, CTX);
  const exported = await runtime.tools.invoke(
    "projection_export",
    { id: cut.result.id },
    CTX
  );
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.result.severity, "info");
});

test("journal replays across store instances", async () => {
  const runtime = freshRuntime();
  seedTurn(runtime, { runId: "turn_proj_replay" });
  const cut = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(cut.ok, true, JSON.stringify(cut));

  const reloaded = new SessionProjectionStore({
    runtime,
    dir: runtime.projections.dir
  });
  const record = reloaded.get({ projectId: "default", id: cut.result.id });
  assert.ok(record, "captured projection did not survive a store reload");
  assert.equal(record.provenanceHash, cut.result.provenanceHash);
});

test("tools fail cleanly when the projection store is disabled", async () => {
  const runtime = freshRuntime({ projections: false });
  const out = await runtime.tools.invoke("projection_capture", {}, CTX);
  assert.equal(out.ok, false, "disabled store must not capture");
});

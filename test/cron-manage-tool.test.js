import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function freshRuntime() {
  // Isolated data dir per test. createDefaultRuntime() otherwise shares the
  // global ~/.openagi dir, so projects, capability profiles, and jobs leak
  // between runs and poison retries (specialist_scope / revision gates).
  return createDefaultRuntime({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cron-manage-test-"))
  });
}


const CTX = { channel: "local", from: "tester", agentId: "main", sessionId: "cron-manage-test" };

async function createPromptJob(runtime, prompt = "cron_manage probe", context = CTX) {
  const out = await runtime.tools.invoke("schedule_message", {
    prompt,
    delaySeconds: 60,
    channel: "local",
    target: "tester"
  }, context);
  assert.equal(out.ok, true, `schedule_message failed: ${JSON.stringify(out)}`);
  return out.result.id;
}

test("cron_manage is registered alongside schedule_message", () => {
  const runtime = freshRuntime();
  const names = runtime.tools.list().map((t) => t.name);
  assert.ok(names.includes("cron_manage"), "cron_manage tool missing");
});

test("cron_manage list shows prompt jobs created via schedule_message", async () => {
  const runtime = freshRuntime();
  const id = await createPromptJob(runtime, "list probe unique marker");
  const listed = await runtime.tools.invoke("cron_manage", { action: "list" }, CTX);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const found = listed.result.jobs.find((job) => job.id === id);
  assert.ok(found, "created job should appear in list");
  assert.equal(found.enabled, true);
  assert.equal(found.task, "prompt");
  assert.match(found.promptPreview, /list probe unique marker/);
  assert.equal(found.projectId, "default");
});

test("cron_manage status/pause/resume/cancel lifecycle", async () => {
  const runtime = freshRuntime();
  const id = await createPromptJob(runtime);

  const status = await runtime.tools.invoke("cron_manage", { action: "status", id }, CTX);
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.result.id, id);
  assert.equal(status.result.enabled, true);
  assert.ok(status.result.nextRunAt, "enabled job has a nextRunAt");

  const paused = await runtime.tools.invoke("cron_manage", { action: "pause", id }, CTX);
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(paused.result.enabled, false);
  assert.equal(paused.result.nextRunAt, null, "pause clears nextRunAt");
  assert.equal(runtime.cron.listJobs().find((j) => j.id === id).enabled, false);

  const resumed = await runtime.tools.invoke("cron_manage", { action: "resume", id }, CTX);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.result.enabled, true);
  assert.ok(resumed.result.nextRunAt, "resume recomputes nextRunAt");

  const cancelled = await runtime.tools.invoke("cron_manage", { action: "cancel", id }, CTX);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.result.removed, true);
  assert.equal(runtime.cron.listJobs().some((j) => j.id === id), false, "job removed from scheduler");

  const gone = await runtime.tools.invoke("cron_manage", { action: "status", id }, CTX);
  assert.equal(gone.ok, false, "status on a removed job must fail");
  assert.match(JSON.stringify(gone), /Unknown cron job/);
});

test("cron_manage mutations require an id", async () => {
  const runtime = freshRuntime();
  for (const action of ["status", "pause", "resume", "cancel"]) {
    const out = await runtime.tools.invoke("cron_manage", { action }, CTX);
    assert.equal(out.ok, false, `${action} without id should fail`);
    assert.match(JSON.stringify(out), /requires a job id/);
  }
});

test("cron_manage is fail-closed across projects", async () => {
  const runtime = freshRuntime();
  // Fresh projects default to policy.allowedTools=[] (zero-capability sandbox,
  // fail-closed by design). Grant wildcard tool access for the cross-project test.
  if (!runtime.projects.get("alpha")) {
    runtime.projects.create({ id: "alpha", name: "Alpha", policy: { allowedTools: ["*"] } });
  }
  if (!runtime.projects.get("beta")) {
    runtime.projects.create({ id: "beta", name: "Beta", policy: { allowedTools: ["*"] } });
  }
  runtime.projects.resolveForSession("alpha-session", { requestedProjectId: "alpha" });
  runtime.projects.resolveForSession("beta-session", { requestedProjectId: "beta" });
  // The project_scope gate requires the current integer revision on non-default
  // project contexts — the live runtime injects it per turn; tests must mirror that.
  const alphaCtx = {
    ...CTX,
    sessionId: "alpha-session",
    __projectId: "alpha",
    __projectRevision: runtime.projects.get("alpha").revision
  };
  const betaCtx = {
    ...CTX,
    sessionId: "beta-session",
    __projectId: "beta",
    __projectRevision: runtime.projects.get("beta").revision
  };
  const id = await createPromptJob(runtime, "alpha-only job", alphaCtx);

  const betaList = await runtime.tools.invoke("cron_manage", { action: "list" }, betaCtx);
  assert.equal(betaList.ok, true, JSON.stringify(betaList));
  assert.equal(
    betaList.result.jobs.some((job) => job.id === id),
    false,
    "beta must not see alpha's job"
  );

  for (const action of ["status", "pause", "resume", "cancel"]) {
    const out = await runtime.tools.invoke("cron_manage", { action, id }, betaCtx);
    assert.equal(out.ok, false, `beta must not ${action} alpha's job`);
    assert.match(JSON.stringify(out), /Unknown cron job/);
  }

  // The job is untouched and still owned by alpha.
  const alphaStatus = await runtime.tools.invoke("cron_manage", { action: "status", id }, alphaCtx);
  assert.equal(alphaStatus.ok, true, JSON.stringify(alphaStatus));
  assert.equal(alphaStatus.result.enabled, true);
});

test("cron_manage list can exclude disabled jobs", async () => {
  const runtime = freshRuntime();
  const id = await createPromptJob(runtime);
  await runtime.tools.invoke("cron_manage", { action: "pause", id }, CTX);
  const filtered = await runtime.tools.invoke(
    "cron_manage",
    { action: "list", includeDisabled: false },
    CTX
  );
  assert.equal(filtered.ok, true, JSON.stringify(filtered));
  assert.equal(
    filtered.result.jobs.some((job) => job.id === id),
    false,
    "disabled job excluded when includeDisabled=false"
  );
  const unfiltered = await runtime.tools.invoke("cron_manage", { action: "list" }, CTX);
  assert.ok(unfiltered.result.jobs.some((job) => job.id === id), "default list includes disabled jobs");
});

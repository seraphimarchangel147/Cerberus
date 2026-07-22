// Regression: the agent must be able to turn a cron job OFF (reversibly) and
// back ON from inside its own loop via set_cron_job_enabled, and cancel/toggle
// jobs by NAME as well as id. This exists because a "nightly-qa" job could be
// created but not paused from the runtime — only a destructive delete existed.
import assert from "node:assert/strict";
import test from "node:test";
import { CronScheduler } from "../src/cron-scheduler.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function setup() {
  const cron = new CronScheduler();
  const registry = new ToolRegistry();
  registerCoreTools(registry, { cron });
  return { cron, registry };
}

test("set_cron_job_enabled turns a job off (paused, not deleted) and back on", async () => {
  const { cron, registry } = setup();
  const job = cron.addJob({ name: "nightly-qa", task: "prompt", dailyAt: "03:00", input: {} });

  const off = await registry.invoke("set_cron_job_enabled", { id: job.id, enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.result.ok, true);
  assert.equal(off.result.enabled, false);
  assert.equal(off.result.nextRunAt, null, "a disabled job has no nextRunAt");
  // Preserved, not removed.
  assert.equal(cron.listJobs().length, 1);
  assert.equal(cron.jobs.get(job.id).enabled, false);

  const on = await registry.invoke("set_cron_job_enabled", { id: job.id, enabled: true });
  assert.equal(on.result.enabled, true);
  assert.ok(on.result.nextRunAt, "re-enabling recomputes nextRunAt");
});

test("set_cron_job_enabled resolves a job by name", async () => {
  const { cron, registry } = setup();
  cron.addJob({ name: "nightly-qa", task: "prompt", dailyAt: "03:00", input: {} });

  const off = await registry.invoke("set_cron_job_enabled", { id: "nightly-qa", enabled: false });
  assert.equal(off.result.ok, true);
  assert.equal(off.result.name, "nightly-qa");
  assert.equal(off.result.enabled, false);
});

test("cancel_cron_job deletes by name and reports the resolved id", async () => {
  const { cron, registry } = setup();
  const job = cron.addJob({ name: "nightly-qa", task: "prompt", dailyAt: "03:00", input: {} });

  const res = await registry.invoke("cancel_cron_job", { id: "nightly-qa" });
  assert.equal(res.result.removed, true);
  assert.equal(res.result.id, job.id);
  assert.equal(cron.listJobs().length, 0);
});

test("cron tools return an actionable error for an unknown job instead of a silent no-op", async () => {
  const { registry } = setup();
  const res = await registry.invoke("set_cron_job_enabled", { id: "does-not-exist", enabled: false });
  assert.equal(res.result.ok, false);
  assert.match(res.result.error, /No cron job matches/);
});

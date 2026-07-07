// test/cron-boot-marker.test.js
// D1 part 3: while a job handler runs, the file-backed scheduler persists a
// { runningJobId, startedAt } marker into cron/jobs.json. If the daemon dies
// mid-run, the next boot consumes the marker, emits "cron-interrupted", and
// the outreach mapper turns it into a durable feed item so the silent death
// is visible.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";
import { OutreachStore } from "../src/outreach-store.js";
import { OutreachMapper } from "../src/outreach-mapper.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function tempStorePath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "jobs.json");
}

test("runDue persists the running marker during the handler and clears it after", async () => {
  const storePath = tempStorePath("cron-marker-");
  const cron = new FileBackedCronScheduler({ storePath });
  cron.addJob({
    id: "digest",
    name: "Outreach digest",
    enabled: true,
    task: "outreach-digest",
    intervalMs: 3_600_000,
    nextRunAt: "2026-01-01T00:00:00.000Z"
  });
  let markerDuringRun = null;
  await cron.runDue(async (job) => {
    markerDuringRun = JSON.parse(fs.readFileSync(storePath, "utf8")).running ?? null;
    return { ok: true, jobId: job.id };
  }, new Date("2026-01-01T00:00:01.000Z"));
  assert.ok(markerDuringRun, "marker on disk while the handler runs");
  assert.equal(markerDuringRun.runningJobId, "digest");
  assert.ok(markerDuringRun.startedAt, "marker carries startedAt");
  const after = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(after.running ?? null, null, "marker cleared after the fire");
});

test("consumeInterruption returns the stale marker once and clears it", () => {
  const storePath = tempStorePath("cron-boot-");
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    jobs: [{
      id: "digest",
      name: "Outreach digest",
      enabled: true,
      task: "outreach-digest",
      intervalMs: 3_600_000,
      nextRunAt: "2026-01-01T01:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null
    }],
    running: { runningJobId: "digest", startedAt: "2026-01-01T00:00:00.000Z" }
  }));
  const cron = new FileBackedCronScheduler({ storePath });
  const marker = cron.consumeInterruption();
  assert.deepEqual(marker, {
    runningJobId: "digest",
    startedAt: "2026-01-01T00:00:00.000Z",
    jobName: "Outreach digest"
  });
  assert.equal(cron.consumeInterruption(), null, "second consume returns null");
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.running ?? null, null, "marker cleared on disk");
});

test("consumeInterruption returns null after a clean shutdown", () => {
  const storePath = tempStorePath("cron-clean-");
  const first = new FileBackedCronScheduler({ storePath });
  first.addJob({ id: "j1", name: "J1", enabled: true, task: "t", intervalMs: 60_000 });
  const second = new FileBackedCronScheduler({ storePath });
  assert.equal(second.consumeInterruption(), null);
});

test("cron-interrupted maps to a durable outreach suggestion naming the job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-map-"));
  const events = new EventEmitter();
  const store = new OutreachStore({ dir, runtime: { events } });
  const mapper = new OutreachMapper({ store, events });
  mapper.attach();
  events.emit("cron-interrupted", {
    at: "2026-07-05T08:00:00.000Z",
    jobId: "weekly-harsh-review",
    jobName: "Weekly harsh review",
    startedAt: "2026-07-04T20:00:05.000Z"
  });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "suggestion");
  assert.deepEqual(items[0].sourceRef, { kind: "cron-job", id: "weekly-harsh-review" });
  assert.match(items[0].title, /Weekly harsh review/);
  assert.equal(items[0].needsDecision, false);
  assert.ok(items[0].actions.includes("dismiss"));
});

test("boot emits cron-interrupted and the outreach feed shows the interrupted job", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-boot-app-"));
  process.env.OPENAGI_AUTH_TOKEN = "";
  const storePath = path.join(dataDir, "cron", "jobs.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    jobs: [{
      id: "weekly-harsh-review",
      name: "Weekly harsh review",
      enabled: true,
      task: "autopilot",
      intervalMs: 7 * 24 * 60 * 60 * 1000,
      nextRunAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null
    }],
    running: { runningJobId: "weekly-harsh-review", startedAt: "2026-07-04T20:00:05.000Z" }
  }));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0 });
  await app.listen();
  try {
    const items = runtime.outreach.list();
    const hit = items.find((i) => i.sourceRef?.kind === "cron-job" && i.sourceRef?.id === "weekly-harsh-review");
    assert.ok(hit, "durable outreach item exists for the interrupted job");
    assert.equal(hit.type, "suggestion");
    assert.match(hit.title, /Weekly harsh review/);
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal(onDisk.running ?? null, null, "marker cleared after boot");
  } finally {
    await app.close();
  }
});

// Code-review finding: noteJobStart/noteJobEnd each called the full save()
// (a synchronous rewrite of the whole job list) on every due-job invocation,
// so a 3-job tick did 7 full writes instead of 1 — directly working against
// D1's own goal of making the cron spine cheap to run continuously.
// noteJobEnd's write is redundant: the next job's noteJobStart (or the
// tick's own closing save when it's the last job) always overwrites it
// before a crash could observe the gap, so removing it doesn't weaken the
// crash-visibility guarantee proven by the tests above.
test("a multi-job tick writes to disk N+1 times, not 2N+1 (noteJobEnd doesn't add a redundant write)", async () => {
  const storePath = tempStorePath("cron-write-count-");
  const cron = new FileBackedCronScheduler({ storePath });
  cron.addJob({ id: "a", name: "A", enabled: true, task: "t", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  cron.addJob({ id: "b", name: "B", enabled: true, task: "t", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.100Z" });
  cron.addJob({ id: "c", name: "C", enabled: true, task: "t", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.200Z" });
  let writeCount = 0;
  const originalSave = cron.save.bind(cron);
  cron.save = () => { writeCount += 1; return originalSave(); };
  await cron.runDue(async () => ({ ok: true }), new Date("2026-01-01T00:00:01.000Z"));
  // N job-start writes (one per job) + 1 tick-closing write from runDue's own
  // "if (results.length > 0) this.save()" — no per-job end write.
  assert.equal(writeCount, 4, `expected 3 job-start writes + 1 tick-closing write, got ${writeCount}`);
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.running ?? null, null, "marker still correctly cleared on disk after the tick");
});

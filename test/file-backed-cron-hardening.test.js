import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileBackedCronScheduler,
  MAX_CRON_STORE_BYTES,
  MAX_PERSISTED_CRON_JOBS
} from "../src/file-backed-cron-scheduler.js";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-load-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "cron", "jobs.json");
}

function validJob(id = "valid-job") {
  return {
    id,
    name: "Valid job",
    enabled: true,
    task: "prompt",
    input: { prompt: "safe" },
    intervalMs: 60_000,
    dailyAt: null,
    nextRunAt: "2026-07-25T00:00:00.000Z",
    createdAt: "2026-07-24T00:00:00.000Z",
    lastRunAt: null,
    pinnedProvider: "openai",
    pinnedModel: "gpt-test"
  };
}

function writeStore(storePath, value) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(value));
}

test("file-backed cron ignores malformed roots and oversized files without reading them", (t) => {
  const malformedPath = tempStore(t);
  writeStore(malformedPath, { version: 1, jobs: { not: "an array" } });
  assert.deepEqual(
    new FileBackedCronScheduler({ storePath: malformedPath }).listJobs(),
    []
  );

  fs.writeFileSync(malformedPath, "{ definitely not json");
  assert.deepEqual(
    new FileBackedCronScheduler({ storePath: malformedPath }).listJobs(),
    []
  );

  fs.truncateSync(malformedPath, MAX_CRON_STORE_BYTES + 1);
  assert.deepEqual(
    new FileBackedCronScheduler({ storePath: malformedPath }).listJobs(),
    []
  );
});

test("file-backed cron accepts only bounded schema-valid jobs and markers", (t) => {
  const storePath = tempStore(t);
  let deepInput = { leaf: true };
  for (let depth = 0; depth < 60; depth += 1) {
    deepInput = { next: deepInput };
  }
  writeStore(storePath, {
    version: 1,
    jobs: [
      validJob("kept"),
      { ...validJob("kept"), name: "duplicate takeover" },
      { ...validJob("../../escape"), name: "invalid id" },
      { ...validJob("bad-task"), task: "../prompt" },
      { ...validJob("bad-date"), nextRunAt: "not-a-date" },
      { ...validJob("bad-enabled"), enabled: "yes" },
      { ...validJob("bad-input"), input: deepInput }
    ],
    running: {
      runningJobId: "../../escape",
      startedAt: "2026-07-24T12:00:00.000Z"
    }
  });

  const cron = new FileBackedCronScheduler({ storePath });
  assert.deepEqual(cron.listJobs().map((job) => job.id), ["kept"]);
  assert.equal(cron.listJobs()[0].name, "Valid job", "the first duplicate wins");
  assert.equal(cron.consumeInterruption(), null, "a marker cannot name a rejected job");
});

test("file-backed cron caps candidate processing deterministically", (t) => {
  const storePath = tempStore(t);
  writeStore(storePath, {
    version: 1,
    jobs: [
      ...Array.from({ length: MAX_PERSISTED_CRON_JOBS }, () => null),
      validJob("outside-the-bound")
    ]
  });
  assert.deepEqual(
    new FileBackedCronScheduler({ storePath }).listJobs(),
    []
  );
});

test("disabled jobs with null nextRunAt remain sortable and survive reload", (t) => {
  const storePath = tempStore(t);
  const cron = new FileBackedCronScheduler({ storePath });
  for (const id of ["one", "two", "three"]) {
    cron.addJob({
      id,
      name: id,
      task: "prompt",
      intervalMs: 60_000
    });
  }
  cron.enableJob("one", false);
  cron.enableJob("three", false);
  assert.deepEqual(
    cron.listJobs().filter((job) => !job.enabled).map((job) => job.id),
    ["one", "three"]
  );

  const reloaded = new FileBackedCronScheduler({ storePath });
  assert.deepEqual(
    reloaded.listJobs().filter((job) => !job.enabled).map((job) => job.id),
    ["one", "three"]
  );
  assert.equal(reloaded.listJobs().find((job) => job.id === "one").nextRunAt, null);
});

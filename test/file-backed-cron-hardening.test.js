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
    new FileBackedCronScheduler({ storePath, log: () => {} }).listJobs(),
    []
  );
});

for (const [label, invalid, reason] of [
  ["bad JSON type", "not a job", /must be an object/],
  ["missing id", { ...validJob(), id: undefined }, /missing or invalid id/],
  ["negative interval", { ...validJob(), intervalMs: -10 }, /intervalMs/],
  ["invalid daily time type", { ...validJob(), dailyAt: 123 }, /dailyAt/]
]) {
  test(`cron boot quarantines ${label} and loads valid neighbors`, (t) => {
    const storePath = tempStore(t);
    const rows = [validJob("first"), invalid, validJob("last")];
    writeStore(storePath, { version: 1, jobs: rows });
    const logs = [];
    const cron = new FileBackedCronScheduler({ storePath, log: (message) => logs.push(message) });
    assert.deepEqual(cron.listJobs().map((job) => job.id), ["first", "last"]);
    const receipts = fs.readFileSync(cron.quarantinePath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].row, JSON.parse(JSON.stringify(invalid)));
    assert.match(receipts[0].reason, reason);
    assert.ok(Number.isFinite(Date.parse(receipts[0].timestamp)));
    assert.equal(logs.length, 1);
    assert.match(logs[0], reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.map((job) => job.id), ["first", "last"]);
  });
}

test("cron quarantine grows append-only and cleaned rows are not quarantined again", (t) => {
  const storePath = tempStore(t);
  writeStore(storePath, { version: 1, jobs: [null, validJob()] });
  const cron = new FileBackedCronScheduler({ storePath, log: () => {} });
  const first = fs.readFileSync(cron.quarantinePath, "utf8");
  cron.load();
  assert.equal(fs.readFileSync(cron.quarantinePath, "utf8"), first);
  writeStore(storePath, { version: 1, jobs: [validJob(), { id: "missing-task" }] });
  cron.load();
  const second = fs.readFileSync(cron.quarantinePath, "utf8");
  assert.ok(second.startsWith(first));
  assert.equal(second.trim().split("\n").length, 2);
});

test("cron quarantine failure preserves bad rows on disk while valid jobs boot", (t) => {
  const storePath = tempStore(t);
  writeStore(storePath, { version: 1, jobs: [null, validJob()] });
  fs.mkdirSync(path.join(path.dirname(storePath), "quarantine.jsonl"));
  const logs = [];
  const cron = new FileBackedCronScheduler({ storePath, log: (message) => logs.push(message) });
  assert.equal(cron.listJobs().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.length, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /quarantine write failed/);
});

test("throwing quarantine logging cannot prevent valid jobs or interruption recovery", (t) => {
  const storePath = tempStore(t);
  writeStore(storePath, {
    version: 1, jobs: [false, validJob()],
    running: { runningJobId: "valid-job", startedAt: "2026-09-09T00:00:00.000Z" }
  });
  new FileBackedCronScheduler({ storePath, log: () => { throw new Error("broken logger"); } });
  const reloaded = new FileBackedCronScheduler({ storePath });
  assert.equal(reloaded.listJobs().length, 1);
  assert.equal(reloaded.consumeInterruption().runningJobId, "valid-job");
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

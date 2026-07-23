import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AbiRuntime } from "../src/abi-runtime.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";

function model(provider, name) {
  return { provider, model: name };
}

function promptJob(id, overrides = {}) {
  return {
    id,
    name: id,
    enabled: true,
    task: "prompt",
    intervalMs: 60_000,
    nextRunAt: "2026-07-22T12:00:00.000Z",
    input: {
      prompt: "Run the scheduled check",
      channel: "local",
      target: "owner",
      sessionId: `cron:${id}`
    },
    ...overrides
  };
}

function runtimeShell({ cron, events, agentHost, channels } = {}) {
  return Object.assign(Object.create(AbiRuntime.prototype), {
    cron,
    events: events ?? new EventEmitter(),
    agentHost: agentHost ?? {
      async handleMessage() {
        throw new Error("model-backed cron handler must not run after a pin mismatch");
      }
    },
    channels: channels ?? { async deliver() { return { delivered: true }; } },
    tasks: { agentPickNext: () => ({ id: "queued" }) },
    budget: { check() {} }
  });
}

function eventValue(event, side, field) {
  return event?.[side]?.[field] ?? event?.[`${side}${field[0].toUpperCase()}${field.slice(1)}`] ?? null;
}

test("cron jobs snapshot provider and model, preserve the pin, and repin on replace", () => {
  let current = model("openai", "gpt-old");
  const cron = new CronScheduler({ modelResolver: () => current });
  const first = cron.addJob(promptJob("pinned"));

  assert.equal(first.pinnedProvider, "openai");
  assert.equal(first.pinnedModel, "gpt-old");
  assert.equal(cron.checkModelPin(first).ok, true);

  current = model("anthropic", "claude-new");
  const mismatch = cron.checkModelPin(first);
  assert.equal(mismatch.ok, false);

  const unchanged = cron.addJob(promptJob("pinned"));
  assert.equal(unchanged.pinnedProvider, "openai", "an idempotent add keeps the original authorization");
  assert.equal(unchanged.pinnedModel, "gpt-old");

  const replaced = cron.addJob(promptJob("pinned", { replace: true }));
  assert.equal(replaced.pinnedProvider, "anthropic", "replace is an explicit repin");
  assert.equal(replaced.pinnedModel, "claude-new");
  assert.equal(cron.checkModelPin(replaced).ok, true);
});

test("file-backed cron preserves pins and backfills legacy jobs exactly once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-pin-"));
  const storePath = path.join(dir, "cron", "jobs.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = new FileBackedCronScheduler({
    storePath,
    modelResolver: () => model("openai", "gpt-snapshot")
  });
  first.addJob(promptJob("durable"));

  const reloaded = new FileBackedCronScheduler({
    storePath,
    modelResolver: () => model("anthropic", "claude-current")
  });
  const durable = reloaded.listJobs().find((job) => job.id === "durable");
  assert.equal(durable.pinnedProvider, "openai");
  assert.equal(durable.pinnedModel, "gpt-snapshot");
  assert.equal(reloaded.checkModelPin(durable).ok, false);

  const legacyPath = path.join(dir, "legacy", "jobs.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    jobs: [promptJob("legacy")]
  }));
  const legacy = new FileBackedCronScheduler({
    storePath: legacyPath,
    modelResolver: () => model("openai", "gpt-baseline")
  });

  const backfilled = legacy.listJobs().find((job) => job.id === "legacy");
  assert.equal(backfilled.pinnedProvider, "openai");
  assert.equal(backfilled.pinnedModel, "gpt-baseline");
  const disk = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  assert.equal(disk.jobs[0].pinnedProvider, "openai", "backfill is persisted atomically");
  assert.equal(disk.jobs[0].pinnedModel, "gpt-baseline");

  legacy.bindModelResolver(() => model("anthropic", "claude-later"), { backfill: true });
  assert.equal(legacy.listJobs()[0].pinnedProvider, "openai", "later binds never overwrite a stored pin");
  assert.equal(legacy.listJobs()[0].pinnedModel, "gpt-baseline");
});

test("scheduled and manually-invoked runtime methods fail closed and emit an alert", async () => {
  let current = model("openai", "gpt-old");
  const cron = new CronScheduler({ modelResolver: () => current });
  const scheduled = cron.addJob(promptJob("scheduled"));
  const autopilot = cron.addJob(promptJob("manual-autopilot", {
    task: "autopilot",
    input: { prompt: "Review queued work", sessionId: "autopilot:manual" }
  }));
  current = model("openai", "gpt-new");

  const events = new EventEmitter();
  const alerts = [];
  events.on("cron-model-mismatch", (event) => alerts.push(event));
  let modelCalls = 0;
  const runtime = runtimeShell({
    cron,
    events,
    agentHost: {
      async handleMessage() {
        modelCalls += 1;
        return { reply: "must not run" };
      }
    }
  });

  const scheduledResult = await runtime.runScheduledPrompt(scheduled);
  const manualResult = await runtime.runAutopilot(autopilot);

  for (const result of [scheduledResult, manualResult]) {
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "model-pin-mismatch");
  }
  assert.equal(modelCalls, 0, "no provider call occurs after either entry point detects a mismatch");
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((event) => event.jobId), ["scheduled", "manual-autopilot"]);
  for (const event of alerts) {
    assert.equal(eventValue(event, "expected", "model"), "gpt-old");
    assert.equal(eventValue(event, "current", "model"), "gpt-new");
  }
});

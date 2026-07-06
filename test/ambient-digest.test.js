import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAmbientDigest, createDefaultRuntime, ObservationStore } from "../src/index.js";

test("buildAmbientDigest rolls an hour of activity into domain + aggregate stats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  await store.record([
    { kind: "activity", at: "2026-07-01T09:05:00Z", app: "Cursor", window: "Cursor · openagi roadmap", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:10:00Z", app: "Cursor", window: "Cursor · openagi roadmap", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:20:00Z", app: "Cursor", window: "Cursor · ambient digest", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:30:00Z", app: "Slack", window: "Slack · #general", event: "focus" },
    { kind: "frame", at: "2026-07-01T09:15:00Z", app: "Cursor", window: "Cursor · openagi roadmap", frameId: "f1", ocrText: "SECRET_OCR_LINE must never leak into a digest", confidence: 0.9 }
  ]);
  const nowMs = Date.parse("2026-07-01T10:00:00Z");
  const digest = await buildAmbientDigest({ observations: store, sinceMs: nowMs - 60 * 60 * 1000, nowMs });
  assert.ok(digest, "expected a digest for a window with activity");
  assert.equal(digest.domain, "app-cursor");
  assert.equal(digest.stats.focusEvents, 4);
  assert.equal(digest.stats.distinctApps, 2);
  assert.deepEqual(digest.stats.topApps, [
    { app: "Cursor", count: 3 },
    { app: "Slack", count: 1 }
  ]);
  assert.deepEqual(digest.stats.topWindowTokens, ["cursor", "openagi", "roadmap", "ambient", "digest"]);
  assert.match(digest.summary, /4 focus events across 2 apps/);
  assert.match(digest.summary, /Cursor \(3\)/);
  // Privacy invariant: raw OCR text never enters the digest (summary OR stats).
  assert.ok(!JSON.stringify(digest).includes("SECRET_OCR_LINE"));
});

test("buildAmbientDigest returns null when the window has no activity rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-idle-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  // Activity exists, but only before the window opens — the digest must stay quiet.
  await store.record([
    { kind: "activity", at: "2026-07-01T07:00:00Z", app: "Cursor", window: "Cursor · early", event: "focus" }
  ]);
  const nowMs = Date.parse("2026-07-01T10:00:00Z");
  const digest = await buildAmbientDigest({ observations: store, sinceMs: nowMs - 60 * 60 * 1000, nowMs });
  assert.equal(digest, null);
});

test("ambient-digest cron job feeds observation digests into processIntegrationEvent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-cron-"));
  // Isolate every file-backed store to the temp dir — the default dirs would
  // share the real ~/.openagi stores (same trap the pattern-miner test notes).
  const runtime = createDefaultRuntime({
    dataDir,
    observationOptions: { dir: path.join(dataDir, "observations") },
    outcomeOptions: { dir: path.join(dataDir, "outcomes") },
    vectorStoreOptions: { dir: path.join(dataDir, "vectors") }
  });
  await runtime.observations.ready;
  await runtime.observations.record([
    { kind: "activity", at: "2026-07-01T09:10:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:20:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" }
  ]);

  const calls = [];
  const original = runtime.processIntegrationEvent.bind(runtime);
  runtime.processIntegrationEvent = (source, payload) => {
    calls.push({ source, payload });
    return original(source, payload);
  };

  // Make only ambient-digest due; push every other default job out a day.
  const now = new Date("2026-07-01T10:00:00Z");
  for (const job of runtime.cron.listJobs()) {
    runtime.cron.updateJob(job.id, {
      nextRunAt: job.id === "ambient-digest"
        ? now.toISOString()
        : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    });
  }

  const first = await runtime.tick(now);
  assert.equal(first.length, 1);
  assert.equal(first[0].job.id, "ambient-digest");
  assert.equal(first[0].result.fired, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "abi");
  assert.equal(calls[0].payload.taskType, "ambient-capture");
  assert.equal(calls[0].payload.domain, "app-cursor");
  assert.notEqual(calls[0].payload.domain, "general");
  assert.equal(calls[0].payload.risk, 0.1);
  assert.equal(calls[0].payload.urgency, 0.2);
  assert.equal(calls[0].payload.impact, 0.4);
  assert.equal(calls[0].payload.confidence, 0.7);
  assert.equal(calls[0].payload.specificity, 0.6);
  assert.equal(calls[0].payload.repetition, 0);
  assert.equal(calls[0].payload.novelty, 1);

  // The signal went through the full Signals→Scrutiny→Memory loop and absorbed:
  // only an "ignore" verdict skips memory, and these axes score well above the
  // panel's ignore band.
  const ambientOutputs = runtime.outputs.filter((o) => o.signal.taskType === "ambient-capture");
  assert.equal(ambientOutputs.length, 1);
  assert.ok(ambientOutputs[0].memory, "digest signal should absorb into tiered memory");
  assert.ok(ambientOutputs[0].memory.tags.includes("ambient-capture"));
  assert.ok(ambientOutputs[0].memory.tags.includes("app-cursor"));

  // Second hour: repetition is measured from the memory the first digest left.
  await runtime.observations.record([
    { kind: "activity", at: "2026-07-01T10:30:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" }
  ]);
  await runtime.tick(new Date("2026-07-01T11:00:00Z"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.repetition, 0.071); // min(1, 1/14) rounded to 3dp
  assert.equal(calls[1].payload.novelty, 0.929);

  // Idle hour: no activity rows in the 11:00-12:00 window → no signal at all.
  await runtime.tick(new Date("2026-07-01T12:00:00Z"));
  assert.equal(calls.length, 2);
});

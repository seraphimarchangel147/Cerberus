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

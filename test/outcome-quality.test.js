import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore, scoreFromToolCalls } from "../src/outcome-store.js";

test("scoreFromToolCalls grades runs by per-call ok flags", () => {
  const cases = [
    [[], 0.5],
    [null, 0.5],
    [undefined, 0.5],
    [[{ name: "remember", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: false }], 0.45],
    [[{ name: "remember", ok: false }], 0.1],
    [[{ name: "remember", ok: false }, { name: "recall", ok: false }], 0.1]
  ];
  for (const [calls, expected] of cases) {
    assert.equal(scoreFromToolCalls(calls), expected, `toolCalls=${JSON.stringify(calls)}`);
  }
});

test("resolveSweep grades cron/autopilot fires by tool-call results", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quality-"));
  const store = new OutcomeStore({ dir });
  const allFailed = store.record({
    kind: "cron-fire",
    sessionId: "s1",
    toolCalls: [{ name: "web_search", ok: false }, { name: "remember", ok: false }]
  });
  const mixed = store.record({
    kind: "autopilot-fire",
    sessionId: "s2",
    toolCalls: [{ name: "web_search", ok: true }, { name: "remember", ok: false }]
  });
  const allOk = store.record({
    kind: "cron-fire",
    sessionId: "s3",
    toolCalls: [{ name: "remember", ok: true }]
  });

  const sweep = store.resolveSweep();
  assert.equal(sweep.length, 3);

  const byId = new Map(sweep.map((r) => [r.id, r]));
  assert.equal(byId.get(allFailed.id).score, 0.1, "all-failed fire scores 0.1");
  assert.equal(byId.get(mixed.id).score, 0.45, "mixed fire scores 0.45");
  assert.equal(byId.get(allOk.id).score, 0.7, "all-ok fire scores 0.7");

  for (const o of [allFailed, mixed, allOk]) {
    const resolved = store.recent(10).find((r) => r.id === o.id);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.source, "system-inferred", "resolution source string is unchanged");
  }
});

test("resolveSweep still scores a quiet old cron fire 0.5", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quiet-"));
  const store = new OutcomeStore({ dir });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const quiet = store.record({ kind: "cron-fire", sessionId: "s1", toolCalls: [], at: twoHoursAgo });

  const sweep = store.resolveSweep();
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].id, quiet.id);
  assert.equal(sweep[0].score, 0.5);
  assert.equal(sweep[0].source, "system-inferred");
});

// Regression: routines that straddle midnight must not be scored as chaos.
//
// getHours() over occurrences at ~23:5x/00:0x used to produce a naive
// variance of ~130 (23 vs 0 treated as 23h apart), zeroing timeStability
// and silently dropping the candidate. This is why the pattern-miner test
// only failed when the suite ran near local midnight ("pre-existing flaky
// failure on master"). The fix uses a circular mean + wrapped deviations.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PatternMiner } from "../src/pattern-miner.js";

function makeMiner(occurrences, dir) {
  const fakeProvider = {
    isConfigured: () => true,
    generate: async () => ({ text: JSON.stringify({ pass: true, reason: "noise" }) })
  };
  return new PatternMiner({
    runtime: {
      dataDir: dir,
      observations: { search: async () => occurrences },
      agentHost: { modelProvider: fakeProvider },
      events: { emit: () => {} }
    },
    dataDir: dir,
    minOccurrences: 5,
    minSequenceLen: 3,
    maxSequenceLen: 4,
    minConfidence: 0.7
  });
}

function sequenceStraddlingMidnight() {
  // 10 occurrences of A→B→C, every 10 minutes, ending just past local
  // midnight — hours mix 23 and 0, the exact geometry that broke scoring.
  const apps = ["com.a", "com.b", "com.c"];
  const base = new Date("2026-07-18T00:50:00"); // LOCAL time on purpose
  const occ = [];
  for (let i = 0; i < 10; i++) {
    for (const [j, app] of apps.entries()) {
      occ.push({
        kind: "activity",
        event: "focus",
        app,
        at: new Date(base.getTime() - (10 - i) * 600 * 1000 + j * 30 * 1000).toISOString()
      });
    }
  }
  return occ;
}

test("pattern miner scores a midnight-straddling routine as stable, not chaotic", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-midnight-"));
  try {
    const miner = makeMiner(sequenceStraddlingMidnight(), dir);
    const result = await miner.mine({ now: new Date("2026-07-18T00:55:00") });
    assert.ok(
      (result.candidates ?? 0) >= 1,
      `midnight routine must clear the confidence bar (got ${result.candidates ?? 0} candidates, mined ${result.mined})`
    );
    const seq = miner.list()[0]?.sequence;
    assert.ok(seq, "candidate persisted with its sequence");
    assert.ok(seq.hourVariance < 2, `circular variance should be small, got ${seq.hourVariance}`);
    assert.ok(seq.startHour === 23 || seq.startHour === 0, `startHour wraps sanely, got ${seq.startHour}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pattern miner mid-day scoring is unchanged by the circular-variance fix", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-midday-"));
  try {
    const apps = ["com.x", "com.y", "com.z"];
    const base = new Date("2026-07-17T14:30:00");
    const occ = [];
    for (let i = 0; i < 10; i++) {
      for (const [j, app] of apps.entries()) {
        occ.push({
          kind: "activity",
          event: "focus",
          app,
          at: new Date(base.getTime() - (10 - i) * 600 * 1000 + j * 30 * 1000).toISOString()
        });
      }
    }
    const miner = makeMiner(occ, dir);
    const result = await miner.mine({ now: new Date("2026-07-17T15:00:00") });
    assert.ok((result.candidates ?? 0) >= 1, "mid-day routine still lands");
    const seq = miner.list()[0]?.sequence;
    assert.ok(seq.hourVariance < 2, `mid-day variance stays tight, got ${seq.hourVariance}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

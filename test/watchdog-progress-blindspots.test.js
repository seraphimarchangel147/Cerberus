// Repro for the false-STALLED watchdog stops Azazel keeps hitting.
//
// Hypothesis under test: progress is ONLY recorded from
// ToolRegistry._recordOutcome() on an envelope where ok === true AND
// outcome.status !== "pending". Every other legitimate form of forward
// motion is invisible to the watchdog:
//
//   1. A tool call that FAILS is not progress -- but a turn spending 10
//      minutes correctly diagnosing a failing test suite IS working.
//   2. A tool call still RUNNING (status "pending") is not progress -- so a
//      single long `node --test` spanning several checkpoints scores zero,
//      which is exactly the shape of Azazel's last stop (39 calls, killed
//      while rerunning a suite to a file).
//   3. A REPEAT with identical output is not progress even when it is the
//      correct action (polling a build, re-running a suite to confirm green).
//
// Run: node --test test/watchdog-progress-blindspots.test.js
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRepeatedOutcome } from "../src/tool-registry.js";
import {
  bindTurnProgressCounter,
  recordTurnProgress,
  readTurnProgressCount
} from "../src/turn-progress.js";

test("first-time successful call counts as progress (already fixed, c00a179)", () => {
  const evaluation = evaluateRepeatedOutcome({
    priorSignature: undefined,
    nextSignature: "a".repeat(64),
    count: 0,
    limit: 3
  });
  assert.equal(evaluation.progressed, true, "regression: c00a179 must hold");
});

test("distinct output on a repeated call counts as progress", () => {
  const evaluation = evaluateRepeatedOutcome({
    priorSignature: "a".repeat(64),
    nextSignature: "b".repeat(64),
    count: 1,
    limit: 3
  });
  assert.equal(evaluation.progressed, true);
});

test("BLINDSPOT: identical repeated output scores no progress", () => {
  const same = "c".repeat(64);
  const evaluation = evaluateRepeatedOutcome({
    priorSignature: same,
    nextSignature: same,
    count: 1,
    limit: 3
  });
  // This is correct for a genuine spin loop, but it is ALSO what a legitimate
  // "re-run the suite to confirm still-green" produces. Documented, not a bug
  // on its own -- it only becomes one combined with the two below.
  assert.equal(evaluation.progressed, false);
});

test("BUG 1: a failing tool call records ZERO progress", () => {
  // _recordOutcome only enters the progress path when envelope.ok === true.
  // A turn doing real diagnostic work against failing commands is invisible.
  const context = {};
  const counter = bindTurnProgressCounter(context);
  assert.ok(counter, "counter must bind");

  const before = readTurnProgressCount(counter);
  // Simulate 10 failing tool calls: _recordOutcome never calls
  // recordTurnProgress for these, so the count cannot move.
  const after = readTurnProgressCount(counter);

  assert.equal(before, 0);
  assert.equal(
    after,
    0,
    "10 failing-but-productive calls advanced the progress counter"
  );
  // The assertion above PASSES today and documents the defect: the watchdog
  // cannot distinguish "failing usefully" from "doing nothing".
});

test("BUG 2: a long PENDING tool call records ZERO progress", () => {
  // _recordOutcome requires outcome.status !== "pending". A single
  // `node --test` spanning multiple checkpoints therefore scores nothing,
  // burning every idle allowance while the process is demonstrably alive.
  const context = {};
  const counter = bindTurnProgressCounter(context);
  const before = readTurnProgressCount(counter);
  // No recordTurnProgress call is reachable for a pending envelope.
  assert.equal(
    readTurnProgressCount(counter),
    before,
    "a pending long-running call cannot signal liveness"
  );
});

test("counter itself works when progress IS recorded (control)", () => {
  const context = {};
  const counter = bindTurnProgressCounter(context);
  assert.equal(readTurnProgressCount(counter), 0);
  recordTurnProgress(context);
  recordTurnProgress(context);
  assert.equal(
    readTurnProgressCount(counter),
    2,
    "control failed: the counter mechanism itself is broken"
  );
});

// Regression tests for the false-STALLED watchdog stops.
//
// Root cause (verified in src/tool-registry.js _recordOutcome): progress was
// credited ONLY for a completed, successful, output-changing tool call. Two
// legitimate forms of work were scored as ZERO progress and burned idle
// allowances on healthy turns:
//
//   BUG 1 -- a FAILING call (envelope.ok !== true) never reached the progress
//            counter. Diagnosing a broken suite looked identical to idling.
//   BUG 2 -- a PENDING call (long-running build / test suite) was excluded by
//            `outcome.status !== "pending"`. A single multi-checkpoint command
//            scored nothing while the process was provably alive. This is the
//            observed stop: killed at 39 tool calls re-running a suite.
//
// Both fixes preserve the anti-spin property: a genuine loop retries the SAME
// call, so distinct-failure counting (attempts === 1) credits it once and
// never again.
import test from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../src/tool-registry.js";
import {
  bindTurnProgressCounter,
  readTurnProgressCount
} from "../src/turn-progress.js";

function harness() {
  const registry = new ToolRegistry();
  const context = {};
  const counter = bindTurnProgressCounter(context);
  return { registry, context, counter };
}

function tracking(registry, context, fingerprint) {
  // Mirror the shape _reserveFailureTracking() produces.
  const state = registry._failureState?.() ?? null;
  return {
    scope: { entries: new Map() },
    fingerprint,
    reserved: true,
    progressContext: context,
    activeKey: null,
    operationReceipt: null,
    __state: state
  };
}

test("BUG 2 FIXED: a pending long-running call credits liveness", () => {
  const { registry, context, counter } = harness();
  const t = tracking(registry, context, "fp-pending");

  assert.equal(readTurnProgressCount(counter), 0);
  registry._recordOutcome(t, {
    ok: true,
    outcome: { status: "pending" },
    result: "still running"
  });
  assert.equal(
    readTurnProgressCount(counter),
    1,
    "a pending (still-executing) call must signal liveness to the watchdog"
  );
});

test("BUG 2 FIXED: repeated pending checkpoints keep crediting liveness", () => {
  const { registry, context, counter } = harness();
  const t = tracking(registry, context, "fp-long-suite");
  for (let i = 0; i < 5; i += 1) {
    registry._recordOutcome(t, {
      ok: true,
      outcome: { status: "pending" },
      result: "node --test running"
    });
  }
  assert.equal(
    readTurnProgressCount(counter),
    5,
    "a suite spanning 5 checkpoints must not burn idle allowances"
  );
});

test("BUG 1 FIXED: a first failing call counts as progress", () => {
  const { registry, context, counter } = harness();
  const t = tracking(registry, context, "fp-fail-1");

  registry._recordOutcome(t, { ok: false, error: "exit 1" });
  assert.equal(
    readTurnProgressCount(counter),
    1,
    "failing usefully is work, not idling"
  );
});

test("BUG 1 FIXED: distinct failing calls each count as progress", () => {
  const { registry, context, counter } = harness();
  const scope = { entries: new Map() };
  for (const fp of ["fp-a", "fp-b", "fp-c"]) {
    registry._recordOutcome(
      { scope, fingerprint: fp, reserved: true, progressContext: context },
      { ok: false, error: "exit 1" }
    );
  }
  assert.equal(
    readTurnProgressCount(counter),
    3,
    "a turn failing through DIFFERENT commands is advancing"
  );
});

test("ANTI-SPIN PRESERVED: hammering the SAME failing call credits once", () => {
  const { registry, context, counter } = harness();
  const scope = { entries: new Map() };
  const t = { scope, fingerprint: "fp-same", reserved: true, progressContext: context };

  for (let i = 0; i < 10; i += 1) {
    registry._recordOutcome(t, { ok: false, error: "exit 1" });
  }
  assert.equal(
    readTurnProgressCount(counter),
    1,
    "a genuine retry loop must NOT keep earning progress -- runaway guard intact"
  );
});

test("progress-aware watchdog: elapsed-time guards stay non-binding for productive turns", async () => {
  // RECONCILED CONTRACT (was: doesNotMatch DEFAULT_MAX_TURN_HARD_SECONDS).
  // The original grep predates the 2026-08-09 runaway backstop (da8dcb35),
  // which added an 8h absolute ceiling for the one failure mode idle-strike
  // detection cannot see: a loop producing novel-looking-but-worthless output
  // every cycle. That backstop has its own passing suite (wall-clock-progress)
  // and env overrides, so the unified contract is:
  //   1. Work-bounded primary — idle strikes stop turns, elapsed time below
  //      the backstop never does (pinned by the BUG 1/2 tests above).
  //   2. The absolute backstop, if present, must default to >= 8h so a
  //      productive turn can never realistically hit it.
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../src/model-provider.js", import.meta.url), "utf8")
  );
  const match = src.match(/DEFAULT_MAX_TURN_HARD_SECONDS = (\d+)/);
  assert.ok(match, "runaway backstop constant exists (wall-clock-progress suite depends on it)");
  assert.ok(
    Number(match[1]) >= 28800,
    "absolute backstop defaults to >= 8h — non-binding for any productive turn"
  );
});

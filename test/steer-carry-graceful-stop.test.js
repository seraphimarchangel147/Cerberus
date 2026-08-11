/**
 * Seam test for Azazel's HIGH finding on 67b0ee8.
 *
 * The carry feature classified abort cause ONLY from a thrown error. But the
 * idle watchdog does not throw: maybeWallClockCheckpoint() returns null
 * (model-provider.js:1247/:1252) and the caller breaks with
 * stopReason = "turn-timeout" (:4995, :5173, :5358). The turn RETURNS NORMALLY.
 *
 * So the dominant real-world death -- the graceful stall-stop that killed
 * Azazel's 27- and 39-call turns -- left turnAbortCause = "completed" and the
 * steer was discarded, exactly the bug the feature exists to fix.
 *
 * These tests drive the CAUSE RESOLUTION seam directly: given what the turn
 * actually produced (a thrown error OR a graceful stopReason), what cause does
 * the steering layer receive?
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTurnCause } from "../src/agent-host.js";
import { TurnSteering, HARNESS_ABORT_CAUSES } from "../src/turn-steering.js";

const SID = "discord:1:2:3";

test("REPRO: graceful watchdog stop resolves to a harness cause, not completed", () => {
  // No error thrown; the provider returned normally carrying stopReason.
  const cause = resolveTurnCause({ thrown: null, stopReason: "turn-timeout" });
  assert.notEqual(cause, "completed", "a watchdog stop is NOT a normal completion");
  assert.ok(HARNESS_ABORT_CAUSES.has(cause), `${cause} must be a carrying cause`);
});

test("REPRO: the graceful stop actually carries the steer end-to-end", () => {
  const steering = new TurnSteering();
  steering.beginTurn(SID, { turnId: "t1" });
  steering.steer(SID, "stop rewriting the tests, fix the source");

  // Exactly what agent-host does in its finally block.
  const cause = resolveTurnCause({ thrown: null, stopReason: "turn-timeout" });
  const stranded = steering.endTurn(SID, { turnId: "t1", cause });

  assert.equal(stranded, null, "must not be reported as a silent discard");
  assert.equal(steering.hasCarried(SID), true, "THE BUG: this was false before the fix");
  assert.equal(steering.takeCarried(SID), "stop rewriting the tests, fix the source");
});

test("every graceful harness stopReason carries", () => {
  for (const reason of ["turn-timeout", "stalled", "provider-error", "request-timeout", "context-too-large"]) {
    const cause = resolveTurnCause({ thrown: null, stopReason: reason });
    assert.ok(HARNESS_ABORT_CAUSES.has(cause), `${reason} -> ${cause} should carry`);
  }
});

test("a genuinely completed turn still discards", () => {
  for (const reason of ["end_turn", "completed", "stop", null, undefined]) {
    assert.equal(
      resolveTurnCause({ thrown: null, stopReason: reason }), "completed",
      `${reason} must NOT carry`
    );
  }
});

test("iteration-cap and budget-cap are harness stops too", () => {
  // The user did not ask for the turn to end; the harness decided.
  assert.ok(HARNESS_ABORT_CAUSES.has(resolveTurnCause({ thrown: null, stopReason: "iteration-cap" })));
  assert.ok(HARNESS_ABORT_CAUSES.has(resolveTurnCause({ thrown: null, stopReason: "budget-cap" })));
});

test("a thrown error still wins over stopReason", () => {
  const abort = new Error("The turn was cancelled.");
  abort.name = "AbortError";
  // User pressed stop DURING a turn that also had a timeout reason: the
  // explicit user action is authoritative and must not carry.
  assert.equal(
    resolveTurnCause({ thrown: abort, stopReason: "turn-timeout" }), "user-interrupt",
    "an explicit user interrupt outranks an incidental stopReason"
  );
});

test("thrown harness errors keep carrying (67b0ee8 behavior preserved)", () => {
  const stall = new Error("turn stopped as STALLED");
  assert.equal(resolveTurnCause({ thrown: stall, stopReason: null }), "stalled");
  const deadline = new Error("deadline");
  deadline.name = "TurnDeadlineError";
  assert.equal(resolveTurnCause({ thrown: deadline, stopReason: null }), "hard-ceiling");
});

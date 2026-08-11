import test from "node:test";
import assert from "node:assert/strict";
import { TurnSteering, HARNESS_ABORT_CAUSES } from "../src/turn-steering.js";
import { classifyAbortCause } from "../src/agent-host.js";
import { createInspectorLogger, opToPhase } from "../src/host-logger.js";

const SID = "discord:1:2:3";

function steeredTurn(cause) {
  const steering = new TurnSteering();
  steering.beginTurn(SID, { turnId: "t1" });
  steering.steer(SID, "actually use the other branch");
  return { steering, stranded: steering.endTurn(SID, { turnId: "t1", cause }) };
}

test("user interrupt DISCARDS the steer (unchanged behavior)", () => {
  const { steering, stranded } = steeredTurn("user-interrupt");
  assert.equal(stranded, "actually use the other branch", "caller must be told, to re-route it");
  assert.equal(steering.hasCarried(SID), false, "a user-ended turn must not carry");
  assert.equal(steering.stranded, 1);
  assert.equal(steering.carried, 0);
});

test("normal completion DISCARDS the steer", () => {
  const { steering, stranded } = steeredTurn("completed");
  assert.equal(stranded, "actually use the other branch");
  assert.equal(steering.hasCarried(SID), false);
});

test("watchdog stall CARRIES the steer instead of dropping it", () => {
  const { steering, stranded } = steeredTurn("stalled");
  assert.equal(stranded, null, "carried steers are not reported as stranded");
  assert.equal(steering.hasCarried(SID), true);
  assert.equal(steering.carried, 1);
  assert.equal(steering.stranded, 0, "a rescued steer is not a lost one");
});

test("every harness abort cause carries", () => {
  for (const cause of HARNESS_ABORT_CAUSES) {
    const { steering } = steeredTurn(cause);
    assert.equal(steering.hasCarried(SID), true, `${cause} should carry`);
  }
});

test("carried steer is delivered EXACTLY once", () => {
  const { steering } = steeredTurn("stalled");
  assert.equal(steering.takeCarried(SID), "actually use the other branch");
  assert.equal(steering.takeCarried(SID), null, "second take must be empty");
  assert.equal(steering.hasCarried(SID), false);
});

test("no steer pending means nothing is carried", () => {
  const steering = new TurnSteering();
  steering.beginTurn(SID, { turnId: "t1" });
  assert.equal(steering.endTurn(SID, { turnId: "t1", cause: "stalled" }), null);
  assert.equal(steering.hasCarried(SID), false);
  assert.equal(steering.carried, 0);
});

test("carry is per-session, never cross-session", () => {
  const steering = new TurnSteering();
  steering.beginTurn(SID, { turnId: "t1" });
  steering.steer(SID, "session A correction");
  steering.endTurn(SID, { turnId: "t1", cause: "stalled" });
  assert.equal(steering.takeCarried("discord:9:9:9"), null, "must not leak to another session");
  assert.equal(steering.takeCarried(SID), "session A correction");
});

test("a sibling turn still running blocks the carry decision", () => {
  const steering = new TurnSteering();
  steering.beginTurn(SID, { turnId: "t1" });
  steering.beginTurn(SID, { turnId: "t2" });
  steering.steer(SID, "for t2");
  assert.equal(steering.endTurn(SID, { turnId: "t1", cause: "stalled" }), null);
  assert.equal(steering.hasCarried(SID), false, "t2 is still live; the steer is still deliverable");
  assert.equal(steering.peek(SID), "for t2", "steer must remain pending");
});

test("stats() exposes carried and awaitingCarry", () => {
  const { steering } = steeredTurn("stalled");
  const stats = steering.stats();
  assert.equal(stats.carried, 1);
  assert.equal(stats.awaitingCarry, 1);
  assert.equal(stats.stranded, 0);
});

test("classifyAbortCause distinguishes user cancel from harness kills", () => {
  const abort = new Error("The turn was cancelled.");
  abort.name = "AbortError";
  assert.equal(classifyAbortCause(abort), "user-interrupt");

  const deadline = new Error("deadline");
  deadline.name = "TurnDeadlineError";
  assert.equal(classifyAbortCause(deadline), "hard-ceiling");

  assert.equal(classifyAbortCause(new Error("turn stopped as STALLED")), "stalled");
  assert.equal(classifyAbortCause(new Error("wall-clock stop")), "wall-clock");
  assert.equal(classifyAbortCause(new Error("socket hang up")), "provider-error");
});

test("user-interrupt classification does NOT carry (end to end)", () => {
  const abort = new Error("The turn was cancelled.");
  abort.name = "AbortError";
  const { steering } = steeredTurn(classifyAbortCause(abort));
  assert.equal(steering.hasCarried(SID), false, "pressing stop must not resurrect the steer later");
});

test("inspector logger writes a valid run-inspector event", () => {
  const written = [];
  const logger = createInspectorLogger({ record: (e) => written.push(e) });
  logger({ op: "steer-undelivered", sessionId: SID, channel: "discord", chars: 12 });
  assert.equal(written.length, 1);
  assert.equal(written[0].kind, "turn");
  assert.equal(written[0].phase, "steer-undelivered");
  assert.equal(written[0].status, "running", "must not be a terminal status");
  assert.match(written[0].metadata.code, /ch=discord/);
  assert.match(written[0].metadata.code, /chars=12/);
});

test("logger returns null with no inspector, keeping this.log a safe no-op", () => {
  assert.equal(createInspectorLogger(null), null);
  assert.equal(createInspectorLogger({}), null);
});

test("logger never throws out of a turn", () => {
  const logger = createInspectorLogger({ record: () => { throw new Error("disk full"); } });
  assert.doesNotThrow(() => logger({ op: "turn-steered", sessionId: SID }));
});

test("opToPhase produces PHASE_RE-safe values", () => {
  assert.equal(opToPhase("steer-undelivered"), "steer-undelivered");
  assert.equal(opToPhase("Turn Steered!"), "turn-steered-");
  assert.match(opToPhase("9lives"), /^[a-z]/, "must start with a letter");
});

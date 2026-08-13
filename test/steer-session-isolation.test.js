// Azazel QA — wave 4 brief section 2: can a steer leak across sessions?
//
// Three probes, each executable, each with a negative control:
//   1. Subagent/delegated turns: drive the REAL delegate_task tool with a stub
//      host, capture the exact sessionId the child runs under, then prove a
//      steer pending on the PARENT session cannot be drained by the child's
//      tool-batch boundary. Negative controls prove the probe detects delivery
//      when keys DO collide.
//   2. Two concurrent turns in one session: pin the intended semantics —
//      a steer is session-scoped; the first tool boundary drains it.
//   3. beginTurn collision: two turns in flight under one session key (the
//      goal-loop + user-turn overlap). The FIRST turn's endTurn must not clear
//      the SECOND turn's in-flight registration or strand its pending steer.
//      This probe FAILS against the unfixed TurnSteering.

import test from "node:test";
import assert from "node:assert/strict";
import { TurnSteering } from "../src/turn-steering.js";
import { registerDelegateTaskTool } from "../src/integrations/delegate-task.js";

function toolResult(id, content) {
  return { type: "tool_result", tool_use_id: id, content, is_error: false };
}

// --- Case 1: delegated child turns -----------------------------------------

test("a steer queued for the parent session cannot leak into a delegated child's tool batch", async () => {
  const captured = [];
  const registry = {
    defs: new Map(),
    register(def) { this.defs.set(def.name, def); },
    list() { return [...this.defs.values()]; }
  };
  const runtime = {
    tools: registry,
    agentHost: {
      async handleMessage(input) {
        captured.push(input);
        return { reply: "child finished", model: { iterations: 1, stopReason: "completed", model: "stub", usage: null } };
      }
    }
  };
  registerDelegateTaskTool(runtime);
  const delegateTask = registry.defs.get("delegate_task");
  assert.ok(delegateTask, "delegate_task registered");

  const parentSession = "discord:guild1:chan1:user1";
  const steering = new TurnSteering();
  steering.beginTurn(parentSession, { turnId: "parent-turn" });
  steering.steer(parentSession, "actually, use the other API");

  // Drive the REAL delegate_task handler. Whatever sessionId the child turn
  // receives here is what model-provider.js will read as context.sessionId at
  // the child's tool-batch boundaries.
  const outcome = await delegateTask.handler(
    { goal: "summarize the depot layout" },
    { sessionId: parentSession, __spawnDepth: 0 }
  );
  assert.ok(!outcome?.error, `delegation must succeed: ${outcome?.error ?? ""}`);
  assert.equal(captured.length, 1, "exactly one child turn ran");

  const childSession = captured[0].sessionId;
  assert.notEqual(
    childSession,
    parentSession,
    "child MUST NOT inherit the parent session key — if it does, every parent steer lands in the child's batch"
  );
  assert.match(childSession, /^subagent:/, "child key is namespaced");
  assert.ok(childSession.includes(parentSession), "child key derives from the parent key but is distinct");

  // The child's tool-batch boundary, using the real delivery function the
  // provider loop calls with context.sessionId.
  const childBatch = [toolResult("c1", "child tool output")];
  const deliveredToChild = steering.applyToToolResults(childSession, childBatch);
  assert.equal(deliveredToChild, false, "no steer may land in the child's batch");
  assert.equal(childBatch[0].content, "child tool output", "child tool result must be byte-identical");
  assert.equal(steering.hasPending(parentSession), true, "the parent steer must survive the child's boundary");

  // NEGATIVE CONTROL 1: the same delivery call under the PARENT key does
  // deliver — so the assertion above is sensitive to delivery, not vacuous.
  const parentBatch = [toolResult("p1", "parent tool output")];
  assert.equal(steering.applyToToolResults(parentSession, parentBatch), true, "control: parent boundary receives the parent steer");
  assert.match(parentBatch[0].content, /OUT-OF-BAND USER MESSAGE/);
  assert.ok(parentBatch[0].content.includes("actually, use the other API"));

  // NEGATIVE CONTROL 2: if a child ever DID run under the parent key, delivery
  // fires — demonstrating the leak the key separation prevents. This is what
  // the first assertion in this test pins against regression.
  const leaky = new TurnSteering();
  leaky.steer("shared-key", "redirect mid-turn");
  const forgedBatch = [toolResult("x", "out")];
  assert.equal(
    leaky.applyToToolResults("shared-key", forgedBatch),
    true,
    "control: equal keys DO deliver — key separation is the only barrier, and it holds"
  );
});

test("a steer queued for a child session cannot leak into the parent's tool batch", async () => {
  // Reverse direction: a child key is namespaced under the parent, so a
  // prefix/key confusion would land child-bound text in the parent.
  const steering = new TurnSteering();
  const parentSession = "discord:guild1:chan1:user1";
  const childSession = `subagent:${parentSession}:00000000-0000-4000-8000-000000000000`;
  steering.steer(childSession, "child-internal note");

  const parentBatch = [toolResult("p1", "parent output")];
  assert.equal(steering.applyToToolResults(parentSession, parentBatch), false);
  assert.equal(parentBatch[0].content, "parent output");

  // Negative control: the child key itself still receives it.
  const childBatch = [toolResult("c1", "child output")];
  assert.equal(steering.applyToToolResults(childSession, childBatch), true);
  assert.ok(childBatch[0].content.includes("child-internal note"));
});

// --- Case 2: two concurrent turns, one session ------------------------------

test("one steer with two in-flight turns: the first tool boundary drains it (session-scoped by design)", () => {
  // Discord serializes turns per key, so this overlap is the goal-loop +
  // user-turn case. The steer belongs to the SESSION: whichever live turn
  // reaches a boundary first carries it to the model. This test pins that
  // semantic so a future change makes it explicit, not accidental.
  const steering = new TurnSteering();
  steering.beginTurn("s", { turnId: "goal-loop" });
  steering.beginTurn("s", { turnId: "user-turn" });
  steering.steer("s", "course correction");

  const userBatch = [toolResult("u1", "user-turn output")];
  assert.equal(steering.applyToToolResults("s", userBatch), true, "first boundary wins");

  const goalBatch = [toolResult("g1", "goal-loop output")];
  assert.equal(steering.applyToToolResults("s", goalBatch), false, "a drained steer is not delivered twice");
  assert.equal(goalBatch[0].content, "goal-loop output");
});

// --- Case 3: beginTurn collision / endTurn cross-clear ----------------------

test("CONFIRMED BUG (pre-fix): the first turn's endTurn must not clear the second turn's registration", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s", { turnId: "turn-1" });
  steering.beginTurn("s", { turnId: "turn-2" }); // goal-loop + user-turn overlap
  steering.steer("s", "for whichever turn is still running");

  // Turn 1 finishes FIRST, while turn 2 is still running.
  steering.endTurn("s", { turnId: "turn-1" });

  assert.equal(
    steering.isTurnInFlight("s"),
    true,
    "turn 2 is still running — its in-flight registration must survive turn 1's endTurn"
  );
  assert.equal(
    steering.hasPending("s"),
    true,
    "the pending steer belongs to the session, not to turn 1 — it must survive for turn 2"
  );

  // The surviving turn can still receive the steer at its next boundary.
  const batch = [toolResult("a", "out")];
  assert.equal(steering.applyToToolResults("s", batch), true, "turn 2 receives the session's steer");
  assert.ok(batch[0].content.includes("for whichever turn is still running"));

  // When the LAST turn ends, the session leaves the registry.
  steering.endTurn("s", { turnId: "turn-2" });
  assert.equal(steering.isTurnInFlight("s"), false);
});

test("stranded accounting still fires when the LAST turn of a session ends with an undelivered steer", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s", { turnId: "t1" });
  steering.beginTurn("s", { turnId: "t2" });
  steering.steer("s", "never delivered");

  assert.equal(steering.endTurn("s", { turnId: "t1" }), null, "turn 2 may still deliver it — not stranded yet");
  assert.equal(steering.stranded, 0);

  const stranded = steering.endTurn("s", { turnId: "t2" });
  assert.equal(stranded, "never delivered", "the last surviving turn's endTurn reports the stranded steer");
  assert.equal(steering.stranded, 1);
});

test("a stale endTurn for an already-ended turn does not disturb a newer turn in the same session", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s", { turnId: "t1" });
  steering.endTurn("s", { turnId: "t1" });

  steering.beginTurn("s", { turnId: "t2" });
  steering.steer("s", "for t2");

  steering.endTurn("s", { turnId: "t1" }); // late finally / double-run
  assert.equal(steering.isTurnInFlight("s"), true, "t2 is untouched");
  assert.equal(steering.hasPending("s"), true, "t2's steer is untouched");
});

test("legacy endTurn without a turnId ends every turn for the session (back-compat)", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s", { turnId: "t1" });
  steering.steer("s", "stale guidance");
  const stranded = steering.endTurn("s");
  assert.equal(stranded, "stale guidance");
  assert.equal(steering.isTurnInFlight("s"), false);
});

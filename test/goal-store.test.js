import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_GOAL_MAX_TURNS,
  GoalRevisionError,
  GoalStore,
  resolveGoalMaxTurns
} from "../src/goal-store.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-goal-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    store: new GoalStore({ dataDir, ...options })
  };
}

test("goal state persists through events and an atomic snapshot", (t) => {
  const { dataDir, store } = fixture(t, { maxTurns: 4 });
  const activated = store.activate("session-1", {
    goalId: "goal-1",
    objective: "Prepare and verify the release"
  });
  const judged = store.recordJudge("session-1", {
    satisfied: false,
    why: "Verification remains"
  }, activated.revision);
  const advanced = store.incrementTurn("session-1", judged.revision);
  const paused = store.pause("session-1", "waiting for input", advanced.revision);

  const goalsDir = path.join(dataDir, "goals");
  const events = fs.readFileSync(path.join(goalsDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const snapshot = JSON.parse(fs.readFileSync(path.join(goalsDir, "snapshot.json"), "utf8"));

  assert.deepEqual(events.map((event) => event.op), ["activate", "judge", "turn", "pause"]);
  assert.equal(events.at(-1).state.status, "paused");
  assert.equal(snapshot.sessions[0].revision, paused.revision);

  const reloaded = new GoalStore({ dataDir, maxTurns: 99 });
  assert.deepEqual(reloaded.get("session-1"), paused);
  assert.equal(reloaded.get("session-1").maxTurns, 4);
});

test("journal replay recovers state when the snapshot is missing", (t) => {
  const { dataDir, store } = fixture(t, { maxTurns: 3 });
  const active = store.activate("session-replay", {
    goalId: "goal-replay",
    objective: "Recover from the journal"
  });
  const next = store.incrementTurn("session-replay", active.revision);
  fs.unlinkSync(path.join(dataDir, "goals", "snapshot.json"));

  const reloaded = new GoalStore({ dataDir });
  assert.equal(reloaded.get("session-replay").revision, next.revision);
  assert.equal(reloaded.get("session-replay").turns, 1);
});

test("stale judge results are rejected without changing goal state", (t) => {
  const { store } = fixture(t);
  const active = store.activate("session-cas", {
    goalId: "goal-cas",
    objective: "Do not accept late judge replies"
  });
  const preempted = store.preempt("session-cas", "user-message", active.revision);

  assert.throws(
    () => store.recordJudge("session-cas", { satisfied: false, why: "late" }, active.revision),
    (error) => {
      assert.ok(error instanceof GoalRevisionError);
      assert.equal(error.code, "GOAL_REVISION_CONFLICT");
      assert.equal(error.expectedRevision, active.revision);
      assert.equal(error.actualRevision, preempted.revision);
      return true;
    }
  );
  assert.deepEqual(store.get("session-cas"), preempted);
});

test("turn budget exposes a safe continuation decision and never exceeds the cap", (t) => {
  const { store } = fixture(t, { maxTurns: 2 });
  let state = store.activate("session-cap", {
    goalId: "goal-cap",
    objective: "Stop after two turns"
  });
  assert.equal(state.remainingTurns, 2);
  assert.equal(state.canContinue, true);

  state = store.incrementTurn("session-cap", state.revision);
  assert.equal(state.turns, 1);
  assert.equal(state.canContinue, true);

  state = store.incrementTurn("session-cap", state.revision);
  assert.equal(state.turns, 2);
  assert.equal(state.remainingTurns, 0);
  assert.equal(state.canContinue, false);

  const revisionAtCap = state.revision;
  state = store.incrementTurn("session-cap", revisionAtCap);
  assert.equal(state.turns, 2);
  assert.equal(state.revision, revisionAtCap);
  assert.equal(state.canContinue, false);

  state = store.pause("session-cap", "cap reached", state.revision);
  const resumed = store.resume("session-cap", "try again", state.revision);
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.revision, state.revision, "resume cannot bypass an exhausted goal budget");
});

test("pause, resume, preempt, complete, and clear retain an audit trail", (t) => {
  const { store } = fixture(t);
  let state = store.activate("session-lifecycle", {
    goalId: "goal-lifecycle",
    objective: "Exercise every lifecycle state"
  });
  state = store.preempt("session-lifecycle", undefined, state.revision);
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "user-message");
  assert.ok(state.preemptedAt);

  state = store.resume("session-lifecycle", null, state.revision);
  assert.equal(state.status, "active");
  state = store.pause("session-lifecycle", "manual pause", state.revision);
  assert.equal(state.status, "paused");
  state = store.resume("session-lifecycle", null, state.revision);
  state = store.complete("session-lifecycle", "judge satisfied", state.revision);
  assert.equal(state.status, "completed");
  state = store.clear("session-lifecycle", "dismissed", state.revision);
  assert.equal(state.status, "cleared");

  assert.deepEqual(
    state.audit.map((entry) => entry.action),
    ["activate", "preempt", "resume", "pause", "resume", "complete", "clear"]
  );
  assert.deepEqual(
    state.audit.map((entry) => entry.status),
    ["active", "paused", "active", "paused", "active", "completed", "cleared"]
  );
});

test("goal activation replaces state with a monotonic revision", (t) => {
  const { store } = fixture(t);
  const first = store.activate("session-replace", {
    goalId: "goal-old",
    objective: "Old goal"
  });
  const replacement = store.activate("session-replace", {
    goalId: "goal-new",
    objective: "New goal",
    maxTurns: 7
  });

  assert.equal(replacement.revision, first.revision + 1);
  assert.equal(replacement.goalId, "goal-new");
  assert.equal(replacement.turns, 0);
  assert.equal(replacement.maxTurns, 7);
  assert.equal(replacement.audit.at(-1).replacedGoalId, "goal-old");
  assert.throws(
    () => store.recordJudge("session-replace", { satisfied: false }, first.revision),
    { code: "GOAL_REVISION_CONFLICT" }
  );
});

test("max-turn parsing defaults safely and rejects invalid per-goal limits", (t) => {
  assert.equal(resolveGoalMaxTurns(undefined), DEFAULT_GOAL_MAX_TURNS);
  assert.equal(resolveGoalMaxTurns("6"), 6);
  assert.equal(resolveGoalMaxTurns("not-a-number"), DEFAULT_GOAL_MAX_TURNS);

  const { store } = fixture(t);
  assert.throws(
    () => store.activate("session-invalid", {
      goalId: "goal-invalid",
      objective: "Invalid limit",
      maxTurns: 0
    }),
    /maxTurns must be a positive integer/
  );
  assert.equal(store.get("session-invalid"), null);
});

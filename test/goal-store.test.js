import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_GOAL_MAX_TURNS,
  DEFAULT_GOAL_STAGNATION_LIMIT,
  GoalRevisionError,
  GoalStore,
  resolveGoalMaxTurns,
  resolveGoalStagnationLimit
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

test("judge verdicts track stagnation across consecutive no-progress turns", (t) => {
  const { store } = fixture(t, { maxTurns: 10, stagnationLimit: 3 });
  const active = store.activate("session-stag", {
    goalId: "goal-stag",
    objective: "Spin without progress"
  });

  const first = store.recordJudge("session-stag", {
    satisfied: false,
    progress: false,
    why: "No new work",
    critique: "Repeated the same failing command",
    nextAdjustment: "Try the alternate adapter"
  }, active.revision);
  assert.equal(first.stagnationTurns, 1);
  assert.equal(first.lastJudge.progress, false);
  assert.equal(first.lastJudge.critique, "Repeated the same failing command");
  assert.equal(first.lastJudge.nextAdjustment, "Try the alternate adapter");

  const second = store.recordJudge("session-stag", {
    satisfied: false,
    progress: false,
    why: "Still nothing new"
  }, first.revision);
  assert.equal(second.stagnationTurns, 2);

  const forward = store.recordJudge("session-stag", {
    satisfied: false,
    progress: true,
    why: "Real progress"
  }, second.revision);
  assert.equal(forward.stagnationTurns, 0);

  const unknown = store.recordJudge("session-stag", {
    satisfied: false,
    why: "Legacy verdict without progress field"
  }, forward.revision);
  assert.equal(unknown.lastJudge.progress, null);
  assert.equal(unknown.stagnationTurns, 0);

  const satisfied = store.recordJudge("session-stag", {
    satisfied: true,
    why: "Done"
  }, unknown.revision);
  assert.equal(satisfied.stagnationTurns, 0);
  assert.equal(satisfied.lastJudge.satisfied, true);
});

test("GOAL_STATE.md spine renders active state and history on every commit", (t) => {
  const { dataDir, store } = fixture(t, { maxTurns: 5 });
  const statePath = path.join(dataDir, "goals", "GOAL_STATE.md");

  const active = store.activate("session-md", {
    goalId: "goal-md",
    objective: "Ship the loop integration"
  });
  let text = fs.readFileSync(statePath, "utf8");
  assert.match(text, /# Goal Loop State/);
  assert.match(text, /Ship the loop integration/);
  assert.match(text, /Turns: 0\/5/);

  store.recordJudge("session-md", {
    satisfied: false,
    progress: false,
    why: "Verifier still red",
    critique: "Fix addressed the wrong test",
    nextAdjustment: "Patch the integration test, not the unit test"
  }, active.revision);
  text = fs.readFileSync(statePath, "utf8");
  assert.match(text, /NO PROGRESS/);
  assert.match(text, /Stagnation: 1\/3/);
  assert.match(text, /Critique: Fix addressed the wrong test/);
  assert.match(text, /Next adjustment: Patch the integration test/);

  const judged = store.get("session-md");
  store.complete("session-md", "all green", judged.revision);
  text = fs.readFileSync(statePath, "utf8");
  assert.match(text, /## Recent history/);
  assert.match(text, /✅ Ship the loop integration — completed/);
  assert.match(text, /## Active\n- \(none\)/);
});

test("state spine can be disabled and stored states without stagnation fields load", (t) => {
  const { dataDir, store } = fixture(t, { stateMdPath: null });
  store.activate("session-nomd", { goalId: "goal-nomd", objective: "No spine" });
  assert.equal(fs.existsSync(path.join(dataDir, "goals", "GOAL_STATE.md")), false);

  // Simulate a pre-upgrade snapshot: no stagnationTurns field at all.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-goal-legacy-"));
  t.after(() => fs.rmSync(legacyDir, { recursive: true, force: true }));
  const legacy = new GoalStore({ dataDir: legacyDir, stateMdPath: null });
  const seeded = legacy.activate("session-legacy", { goalId: "goal-legacy", objective: "Legacy state" });
  const snapshotPath = path.join(legacyDir, "goals", "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  delete snapshot.sessions[0].stagnationTurns;
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  // The journal holds the full modern state and wins on replay; a true legacy
  // load has only the snapshot, so drop the journal for this simulation.
  fs.rmSync(path.join(legacyDir, "goals", "events.jsonl"), { force: true });
  const reloaded = new GoalStore({ dataDir: legacyDir, stateMdPath: null });
  const view = reloaded.get("session-legacy");
  assert.equal(view.goalId, seeded.goalId);
  assert.equal(view.stagnationTurns, undefined);
  // A fresh judge verdict on legacy state starts the counter cleanly.
  const judged = reloaded.recordJudge("session-legacy", {
    satisfied: false,
    progress: false,
    why: "spinning"
  }, view.revision);
  assert.equal(judged.stagnationTurns, 1);
});

test("stagnation-limit parsing defaults safely and rejects invalid values", () => {
  assert.equal(resolveGoalStagnationLimit(undefined), DEFAULT_GOAL_STAGNATION_LIMIT);
  assert.equal(resolveGoalStagnationLimit("5"), 5);
  assert.equal(resolveGoalStagnationLimit("junk"), DEFAULT_GOAL_STAGNATION_LIMIT);
  assert.throws(() => resolveGoalStagnationLimit(0, { fallback: null }), /positive integer/);
});
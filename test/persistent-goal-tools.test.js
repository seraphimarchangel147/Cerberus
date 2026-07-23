import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { saveEnv, SETUP_FIELDS } from "../src/setup-wizard.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function createHarness() {
  const calls = [];
  const states = new Map();
  const runtime = {
    tasks: {
      addGoal(args) {
        return {
          id: "goal_1",
          title: args.title,
          description: args.description ?? "",
          status: "active"
        };
      },
      linkTaskToGoal(taskId, goalId) {
        return { id: taskId, parentGoalId: goalId };
      }
    },
    goals: {
      activate(sessionId, input) {
        calls.push(["activate", sessionId, input]);
        const state = { sessionId, ...input, status: "active", turns: 0, maxTurns: 20 };
        states.set(sessionId, state);
        return state;
      },
      get(sessionId) {
        calls.push(["get", sessionId]);
        return states.get(sessionId) ?? null;
      },
      pause(sessionId, reason) {
        calls.push(["pause", sessionId, reason]);
        const current = states.get(sessionId);
        if (!current) return null;
        const state = { ...current, status: "paused", reason };
        states.set(sessionId, state);
        return state;
      },
      resume(sessionId, reason) {
        calls.push(["resume", sessionId, reason]);
        const current = states.get(sessionId);
        if (!current) return null;
        const state = { ...current, status: "active", reason };
        states.set(sessionId, state);
        return state;
      },
      clear(sessionId, reason) {
        calls.push(["clear", sessionId, reason]);
        const current = states.get(sessionId);
        if (!current) return null;
        const state = { ...current, status: "cleared", reason };
        states.set(sessionId, state);
        return state;
      }
    }
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);
  return { calls, registry };
}

test("add_goal activates persistent goal mode for the current session", async () => {
  const { calls, registry } = createHarness();
  const result = await registry.invoke(
    "add_goal",
    { title: "Ship the release", description: "Build and verify two changes" },
    { sessionId: "session_1" }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], [
    "activate",
    "session_1",
    { goalId: "goal_1", objective: "Ship the release: Build and verify two changes" }
  ]);
  assert.equal(result.result.goalMode.status, "active");
});

test("goal control tools operate only on the current session", async () => {
  const { registry } = createHarness();
  const context = { sessionId: "session_2" };
  await registry.invoke("add_goal", { title: "Finish phase one" }, context);

  const status = await registry.invoke("goal_status", {}, context);
  assert.equal(status.result.status, "active");

  const paused = await registry.invoke("pause_goal", { reason: "waiting" }, context);
  assert.equal(paused.result.status, "paused");
  assert.equal(paused.result.reason, "waiting");

  const resumed = await registry.invoke("resume_goal", {}, context);
  assert.equal(resumed.result.status, "active");
  assert.equal(resumed.result.reason, "resumed-by-agent");

  const cleared = await registry.invoke("clear_goal", {}, context);
  assert.equal(cleared.result.status, "cleared");
  assert.equal(cleared.result.reason, "cleared-by-agent");
});

test("goal controls fail safely outside a session", async () => {
  const { registry } = createHarness();
  for (const name of ["goal_status", "pause_goal", "resume_goal", "clear_goal"]) {
    const result = await registry.invoke(name, {});
    assert.equal(result.ok, true);
    assert.match(result.result.error, /requires a session/);
  }
});

test("goal turn budget is persisted by the setup allowlist", (t) => {
  assert.ok(SETUP_FIELDS.includes("OPENAGI_GOAL_MAX_TURNS"));
  const previous = process.env.OPENAGI_GOAL_MAX_TURNS;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-goal-wizard-"));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENAGI_GOAL_MAX_TURNS;
    else process.env.OPENAGI_GOAL_MAX_TURNS = previous;
  });

  const result = saveEnv({ dataDir, values: { OPENAGI_GOAL_MAX_TURNS: "14" } });
  assert.deepEqual(result.keys, ["OPENAGI_GOAL_MAX_TURNS"]);
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /^OPENAGI_GOAL_MAX_TURNS=14$/m);
});

test("the default model prompt documents every goal-facing tool", () => {
  const prompt = buildDefaultInstructions({ agent: { name: "Test" } });
  for (const name of [
    "add_goal",
    "list_goals",
    "link_task_to_goal",
    "goal_status",
    "pause_goal",
    "resume_goal",
    "clear_goal"
  ]) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`), name);
  }
});

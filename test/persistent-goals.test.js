import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { GoalStore } from "../src/goal-store.js";
import { ModelRouter } from "../src/model-router.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  parseGoalJudgeVerdict
} from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

const agent = { id: "main", name: "Main Agent" };

function goalRuntime(t, { maxTurns = 4 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-goal-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const goals = new GoalStore({ dataDir, maxTurns });
  const taskUpdates = [];
  const runtime = {
    goals,
    tasks: {
      updateGoal(id, patch) {
        taskUpdates.push({ id, patch });
        return { id, ...patch };
      }
    }
  };
  goals.activate("session-goal", { goalId: "goal-task", objective: "Finish both release steps" });
  return { runtime, goals, taskUpdates };
}

function goalContext(runtime, events = []) {
  return {
    runtime,
    sessionId: "session-goal",
    __onToolEvent: (event) => events.push(event)
  };
}

test("goal judge verdict parser accepts strict JSON and rejects ambiguous output", () => {
  assert.deepEqual(parseGoalJudgeVerdict('{"satisfied":true,"why":"done"}'), { satisfied: true, why: "done" });
  assert.deepEqual(parseGoalJudgeVerdict('```json\n{"satisfied":"no","why":"one step remains"}\n```'), {
    satisfied: false,
    why: "one step remains"
  });
  assert.equal(parseGoalJudgeVerdict("probably"), null);
  assert.equal(parseGoalJudgeVerdict('{"satisfied":"maybe"}'), null);
});

test("OpenAI goal loop auto-continues once, uses the cheap model, then completes", async (t) => {
  const { runtime, goals, taskUpdates } = goalRuntime(t);
  const router = new ModelRouter({
    envPrefix: "OPENAI",
    baseModel: "base-model",
    overrides: { tiers: { nano: "cheap-model" } }
  });
  const provider = new OpenAIResponsesProvider({ apiKey: "test", model: "base-model", router, maxIterations: 6 });
  const sent = [];
  let mainRequests = 0;
  let judgeRequests = 0;
  provider.postResponses = async (body) => {
    sent.push(structuredClone(body));
    if (String(body.instructions).includes("goal-completion judge")) {
      judgeRequests += 1;
      return {
        id: `judge-${judgeRequests}`,
        output_text: JSON.stringify(judgeRequests === 1
          ? { satisfied: false, why: "second step remains" }
          : { satisfied: true, why: "both steps are complete" }),
        output: []
      };
    }
    mainRequests += 1;
    return {
      id: `main-${mainRequests}`,
      output_text: mainRequests === 1 ? "Finished step one." : "Finished step two.",
      output: []
    };
  };

  const events = [];
  const result = await provider.generate({
    input: "Complete the release",
    agent,
    context: goalContext(runtime, events)
  });

  assert.equal(result.text, "Finished step two.");
  assert.equal(result.stopReason, "goal-satisfied");
  assert.equal(result.iterations, 2);
  assert.equal(mainRequests, 2);
  assert.equal(judgeRequests, 2);
  const judgeBodies = sent.filter((body) => String(body.instructions).includes("goal-completion judge"));
  assert.ok(judgeBodies.every((body) => (
    body.model === "cheap-model"
    && body.max_output_tokens === 256
    && !("tools" in body)
  )));
  const secondMain = sent.filter((body) => !String(body.instructions).includes("goal-completion judge"))[1];
  assert.match(JSON.stringify(secondMain.input), /Finished step one/);
  assert.match(JSON.stringify(secondMain.input), /Continue the same task/);
  assert.equal(goals.get("session-goal").status, "completed");
  assert.deepEqual(taskUpdates, [{ id: "goal-task", patch: { status: "completed" } }]);
  assert.ok(events.some((event) => event.phase === "goal" && event.action === "continue"));
  assert.ok(events.some((event) => event.phase === "goal" && event.action === "completed"));
});

test("Anthropic goal loop reuses synthetic continuation and completes", async (t) => {
  const { runtime, goals } = goalRuntime(t);
  const router = new ModelRouter({
    envPrefix: "ANTHROPIC",
    baseModel: "strong-model",
    overrides: { tiers: { nano: "small-model" } }
  });
  const provider = new AnthropicProvider({ apiKey: "test", model: "strong-model", router, maxIterations: 6 });
  const sent = [];
  let mainRequests = 0;
  let judgeRequests = 0;
  provider.postMessages = async (body) => {
    sent.push(structuredClone(body));
    if (typeof body.system === "string" && body.system.includes("goal-completion judge")) {
      judgeRequests += 1;
      return {
        id: `judge-${judgeRequests}`,
        stop_reason: "end_turn",
        content: [{
          type: "text",
          text: JSON.stringify(judgeRequests === 1
            ? { satisfied: false, why: "continue" }
            : { satisfied: true, why: "done" })
        }]
      };
    }
    mainRequests += 1;
    return {
      id: `main-${mainRequests}`,
      stop_reason: "end_turn",
      content: [{ type: "text", text: mainRequests === 1 ? "First stage done." : "Second stage done." }]
    };
  };

  const result = await provider.generate({ input: "Complete both stages", agent, context: goalContext(runtime) });
  assert.equal(result.text, "Second stage done.");
  assert.equal(result.stopReason, "goal-satisfied");
  assert.equal(mainRequests, 2);
  assert.equal(judgeRequests, 2);
  const judges = sent.filter((body) => typeof body.system === "string");
  assert.ok(judges.every((body) => body.model === "small-model" && !("tools" in body)));
  const secondMain = sent.filter((body) => Array.isArray(body.system))[1];
  assert.match(JSON.stringify(secondMain.messages), /First stage done/);
  assert.match(JSON.stringify(secondMain.messages), /Continue the same task/);
  assert.equal(goals.get("session-goal").status, "completed");
});

test("goal turn budget stops the loop after the configured maximum", async (t) => {
  const { runtime, goals } = goalRuntime(t, { maxTurns: 1 });
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 6 });
  let mainRequests = 0;
  provider.postResponses = async (body) => {
    if (String(body.instructions).includes("goal-completion judge")) {
      return { id: "judge", output_text: '{"satisfied":false,"why":"not done"}', output: [] };
    }
    mainRequests += 1;
    return { id: "main", output_text: "Made partial progress.", output: [] };
  };

  const result = await provider.generate({ input: "Work on goal", agent, context: goalContext(runtime) });
  assert.equal(mainRequests, 1);
  assert.equal(result.text, "Made partial progress.");
  assert.equal(result.stopReason, "goal-turn-cap");
  assert.equal(goals.get("session-goal").status, "paused");
  assert.equal(goals.get("session-goal").turns, 1);
});

test("goal judge errors fail open and return the main assistant reply", async (t) => {
  const { runtime, goals } = goalRuntime(t);
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 6 });
  let mainRequests = 0;
  provider.postResponses = async (body) => {
    if (String(body.instructions).includes("goal-completion judge")) throw new Error("judge unavailable");
    mainRequests += 1;
    return { id: "main", output_text: "Safe partial answer.", output: [] };
  };

  const result = await provider.generate({ input: "Work on goal", agent, context: goalContext(runtime) });
  assert.equal(mainRequests, 1);
  assert.equal(result.text, "Safe partial answer.");
  assert.equal(result.stopReason, "goal-judge-error");
  assert.equal(goals.get("session-goal").status, "paused");
  assert.match(goals.get("session-goal").reason, /judge unavailable/);
});

test("a user preemption while the judge is pending prevents continuation", async (t) => {
  const { runtime, goals } = goalRuntime(t);
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 6 });
  let mainRequests = 0;
  let resolveJudge;
  let judgeStarted;
  const started = new Promise((resolve) => { judgeStarted = resolve; });
  provider.postResponses = async (body) => {
    if (String(body.instructions).includes("goal-completion judge")) {
      judgeStarted();
      return new Promise((resolve) => { resolveJudge = resolve; });
    }
    mainRequests += 1;
    return { id: "main", output_text: "First pass complete.", output: [] };
  };

  const generation = provider.generate({ input: "Work on goal", agent, context: goalContext(runtime) });
  await started;
  goals.preempt("session-goal", "new real user message");
  resolveJudge({ id: "judge", output_text: '{"satisfied":false,"why":"continue"}', output: [] });
  const result = await generation;

  assert.equal(mainRequests, 1);
  assert.equal(result.stopReason, "goal-preempted");
  assert.equal(goals.get("session-goal").status, "paused");
  assert.equal(goals.get("session-goal").reason, "new real user message");
});

test("preemption during a synthetic model request vetoes its tool calls", async (t) => {
  const { runtime, goals } = goalRuntime(t);
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 6 });
  let mainRequests = 0;
  let resolveSecondMain;
  let secondMainStarted;
  const started = new Promise((resolve) => { secondMainStarted = resolve; });
  provider.postResponses = async (body) => {
    if (String(body.instructions).includes("goal-completion judge")) {
      return { id: "judge", output_text: '{"satisfied":false,"why":"continue"}', output: [] };
    }
    mainRequests += 1;
    if (mainRequests === 1) return { id: "main-1", output_text: "First pass.", output: [] };
    secondMainStarted();
    return new Promise((resolve) => { resolveSecondMain = resolve; });
  };
  let toolInvocations = 0;
  const toolRegistry = {
    toOpenAITools: () => [{ type: "function", name: "dangerous_step", parameters: {} }],
    async invoke() {
      toolInvocations += 1;
      return { ok: true, result: "should not run" };
    }
  };

  const generation = provider.generate({
    input: "Work on goal",
    agent,
    toolRegistry,
    context: goalContext(runtime)
  });
  await started;
  goals.preempt("session-goal", "new real user message");
  resolveSecondMain({
    id: "main-2",
    output: [{ type: "function_call", call_id: "call-2", name: "dangerous_step", arguments: "{}" }]
  });
  const result = await generation;

  assert.equal(result.stopReason, "goal-preempted");
  assert.equal(toolInvocations, 0);
  assert.equal(result.toolCalls.length, 0);
});

test("a goal created by the first tool hop is CAS-guarded before its first judge", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-new-goal-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const goals = new GoalStore({ dataDir, maxTurns: 4 });
  const runtime = { goals };
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxIterations: 6 });
  let requestCount = 0;
  let releaseSecond;
  let markSecondStarted;
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  provider.postResponses = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        id: "main-1",
        output: [{ type: "function_call", call_id: "goal-call", name: "add_goal", arguments: "{}" }]
      };
    }
    markSecondStarted();
    return new Promise((resolve) => { releaseSecond = resolve; });
  };
  let dangerousInvocations = 0;
  const toolRegistry = {
    toOpenAITools: () => [
      { type: "function", name: "add_goal", parameters: {} },
      { type: "function", name: "dangerous_step", parameters: {} }
    ],
    async invoke(name) {
      if (name === "add_goal") {
        const goalMode = goals.activate("session-goal", {
          goalId: "goal-from-tool",
          objective: "Finish the guarded work"
        });
        return { ok: true, result: { id: "goal-from-tool", goalMode } };
      }
      dangerousInvocations += 1;
      return { ok: true, result: "must not run" };
    }
  };

  const generation = provider.generate({
    input: "Create and finish a goal",
    agent,
    toolRegistry,
    context: goalContext(runtime)
  });
  await secondStarted;
  goals.preempt("session-goal", "new real user message");
  releaseSecond({
    id: "main-2",
    output: [{ type: "function_call", call_id: "danger-call", name: "dangerous_step", arguments: "{}" }]
  });
  const result = await generation;

  assert.equal(result.stopReason, "goal-preempted");
  assert.equal(dangerousInvocations, 0);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["add_goal"]);
});

test("AgentHost preempts real users but preserves explicit goal continuations and bot events", async (t) => {
  const { runtime, goals } = goalRuntime(t);
  runtime.tools = new ToolRegistry();
  for (const name of ["goal_status", "pause_goal", "resume_goal", "clear_goal"]) {
    runtime.tools.register({
      name,
      sideEffects: false,
      description: `${name} fixture`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true })
    });
  }
  runtime.memory = { remember: () => ({ id: "memory" }) };
  runtime.tasks.add = () => null;
  runtime.processSignal = () => ({
    id: "output",
    scrutiny: {
      action: "act",
      score: 0.5,
      reasons: [],
      dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
    },
    customContext: [],
    propagation: null
  });
  const requests = [];
  const modelProvider = {
    model: "fixture",
    isConfigured: () => true,
    async generate(request) {
      requests.push(request);
      return {
        provider: "fixture",
        model: "fixture",
        text: "ok",
        toolCalls: [],
        iterations: 1,
        stopReason: "completed"
      };
    }
  };
  const host = new AgentHost({ runtime, store: new InMemoryAgentStore(), modelProvider });

  await host.handleMessage({
    channel: "local",
    from: "user",
    sessionId: "session-goal",
    text: "A new real message",
    backgroundReview: false
  });
  assert.equal(goals.get("session-goal").status, "paused");
  assert.equal(goals.get("session-goal").reason, "real user message");

  goals.resume("session-goal");
  await host.handleMessage({
    channel: "discord",
    from: "user",
    sessionId: "session-goal",
    text: "Continue the active persistent goal",
    goalContinuation: true,
    backgroundReview: false
  });
  assert.equal(goals.get("session-goal").status, "active");
  assert.equal(requests.at(-1).maxIterations, undefined, "goal continuation bypasses the four-turn chat fast lane");
  assert.deepEqual(
    requests.at(-1).tools.map((tool) => tool.name),
    ["goal_status", "pause_goal", "resume_goal", "clear_goal"],
    "goal controls stay available in the conversational schema lane"
  );

  await host.handleMessage({
    channel: "discord",
    from: "bot",
    sessionId: "session-goal",
    text: "Automated bot event",
    metadata: { authorBot: true },
    backgroundReview: false
  });
  assert.equal(goals.get("session-goal").status, "active");
});

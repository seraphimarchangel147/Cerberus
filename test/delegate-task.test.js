// Delegation is useful only when child work stays isolated and inherits every
// parent safety boundary. These tests exercise the real AgentHost entry point.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AbiRuntime } from "../src/abi-runtime.js";
import { AgentHost, stricterToolPolicy } from "../src/agent-host.js";
import { FileBackedAgentStore } from "../src/agent-store.js";
import { BudgetGuard } from "../src/budget-guard.js";
import { registerCodeTools } from "../src/code-tools.js";
import { LiveStatus } from "../src/discord-channel.js";
import { MemorySystem } from "../src/memory-system.js";
import {
  registerDelegateTaskTool,
  resolveSubagentConfig,
  SUBAGENT_DEFAULTS
} from "../src/integrations/delegate-task.js";
import { saveEnv } from "../src/setup-wizard.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

const SUBAGENT_ENV_KEYS = [
  "OPENAGI_MAX_CHILDREN",
  "OPENAGI_MAX_SPAWN_DEPTH",
  "OPENAGI_SUBAGENT_MAX_ITERATIONS",
  "OPENAGI_SUBAGENT_MAX_TURN_SECONDS"
];

function modelResult(text, { toolCalls = [], iterations = 2, stopReason = "completed" } = {}) {
  return {
    provider: "delegate-test",
    model: "stub",
    text,
    toolCalls,
    iterations,
    maxIterations: 30,
    stopReason
  };
}

function makeHarness(provider, { scrutinyAction = "act" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-task-"));
  const tools = new ToolRegistry();
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  const budget = new BudgetGuard({
    storePath: path.join(dir, "budget", "usage.json"),
    dailyUsdLimit: 100
  });
  const memoryWrites = [];
  const memory = {
    items: new Map(),
    retrieve: () => [],
    remember: (item) => {
      memoryWrites.push(item);
      return { id: `memory-${memoryWrites.length}`, tier: "short", ...item };
    }
  };
  const runtime = {
    tools,
    budget,
    memory,
    outcomes: null,
    tasks: null,
    sessionIndex: null,
    vectorStore: null,
    observations: null,
    processSignal: (signal) => ({
      id: `output-${signal.id}`,
      scrutiny: {
        action: scrutinyAction,
        score: 0.9,
        reasons: ["test verdict"],
        dimensions: { novelty: 0.4, risk: 0.35, repetition: 0.2 }
      },
      propagation: null,
      customContext: []
    })
  };
  provider.budgetGuard = budget;
  provider.isConfigured ??= () => true;
  const host = new AgentHost({ runtime, store, modelProvider: provider });
  runtime.agentHost = host;
  registerDelegateTaskTool(runtime);
  return { budget, dir, host, memoryWrites, runtime, store, tools };
}

function delegateHandler(tools) {
  return tools.get("delegate_task").handler;
}

test("legacy delegate_subtask is removed and governed delegate_task covers a single child", async () => {
  const tools = new ToolRegistry();
  const childTurns = [];
  const runtime = {
    tools,
    agentHost: {
      async handleMessage(input) {
        childTurns.push(input);
        return { reply: "governed child summary", model: { iterations: 1, stopReason: "completed" } };
      }
    }
  };
  registerCodeTools(tools, runtime);
  registerDelegateTaskTool(runtime);

  assert.equal(tools.has("delegate_subtask"), false);
  assert.equal(tools.get("delegate_task").sideEffects, true);
  const result = await delegateHandler(tools)({ goal: "inspect the isolated fixture" }, {
    sessionId: "parent-governance",
    from: "creator",
    __scrutinyPolicy: "read-only"
  });

  assert.equal(result.results[0].summary, "governed child summary");
  assert.equal(childTurns.length, 1);
  assert.equal(childTurns[0].routeTo, false);
  assert.equal(childTurns[0].scrutinyPolicyCeiling, "read-only");
  assert.equal(childTurns[0].spawnDepth, 1);
  assert.equal(childTurns[0].maxIterations, SUBAGENT_DEFAULTS.maxIterations);
  assert.equal(childTurns[0].maxTurnSeconds, SUBAGENT_DEFAULTS.maxTurnSeconds);
});

test("single delegate_task returns only the summary and keeps child turns out of the parent session", async () => {
  const seen = {};
  const provider = {
    async generate(request) {
      seen.request = request;
      const invocation = await request.toolRegistry.invoke("probe_read", { item: "fixture" }, request.context);
      assert.equal(invocation.ok, true);
      return modelResult("Reviewed three files; all checks passed.", {
        toolCalls: [{ name: "probe_read", arguments: { item: "fixture" }, result: invocation }],
        iterations: 2
      });
    }
  };
  const { memoryWrites, store, tools } = makeHarness(provider);
  tools.register({
    name: "probe_read",
    sideEffects: false,
    handler: async () => ({ raw: "INTERMEDIATE TOOL OUTPUT MUST STAY IN THE CHILD" })
  });
  const parentSessionId = "discord:guild:parent";
  await store.appendMessage(parentSessionId, {
    role: "user",
    content: "parent-only transcript",
    agentId: "main",
    channel: "discord",
    from: "creator"
  });

  const outcome = await tools.invoke("delegate_task", {
    goal: "Inspect the three fixture files",
    context: "They are test fixtures only."
  }, { sessionId: parentSessionId, from: "creator" });

  assert.equal(outcome.ok, true);
  assert.deepEqual(Object.keys(outcome.result), ["results"]);
  assert.deepEqual(outcome.result.results[0], {
    goal: "Inspect the three fixture files",
    ok: true,
    summary: "Reviewed three files; all checks passed.",
    iterations: 2,
    stopReason: "completed"
  });
  assert.doesNotMatch(JSON.stringify(outcome.result), /INTERMEDIATE TOOL OUTPUT/);

  const parent = store.getSession(parentSessionId);
  assert.equal(parent.messages.length, 1);
  assert.equal(parent.messages[0].content, "parent-only transcript");
  const children = store.listSessions().filter((session) => session.id.startsWith(`subagent:${parentSessionId}:`));
  assert.equal(children.length, 1);
  const child = store.getSession(children[0].id);
  assert.equal(child.messages.length, 2);
  assert.match(child.messages[0].content, /<background_context>[\s\S]*test fixtures only/);
  assert.equal(child.messages[1].content, "Reviewed three files; all checks passed.");
  assert.doesNotMatch(JSON.stringify(child), /INTERMEDIATE TOOL OUTPUT/);
  assert.ok(memoryWrites.every((item) => item.scope.startsWith("subagent:")));
  assert.equal(seen.request.context.__spawnDepth, 1);
  assert.match(seen.request.context.__memoryScope, /^subagent:/);
  assert.ok(!seen.request.tools.some((tool) => ["delegate_task", "delegate_subtask", "send_message", "schedule_message"].includes(tool.name)));
});

test("subagent memory scope reaches remember, recall, and correction tools", async () => {
  const scopes = [];
  const runtime = {
    memory: {
      remember: (item) => {
        scopes.push(["remember", item.scope]);
        return { id: "memory", tier: "short", content: item.content };
      },
      retrieve: (query, options) => {
        scopes.push(["recall", options.scope]);
        return [];
      },
      correct: (request) => {
        scopes.push(["correct", request.scope]);
        return {
          item: { id: "corrected", tier: "long", content: request.content },
          superseded: []
        };
      }
    }
  };
  const tools = new ToolRegistry();
  registerCoreTools(tools, runtime);
  const context = { agentId: "main", sessionId: "child", __memoryScope: "subagent:private" };

  assert.equal((await tools.invoke("remember", { content: "child fact" }, context)).ok, true);
  assert.equal((await tools.invoke("recall", { query: "child" }, context)).ok, true);
  assert.equal((await tools.invoke("correct_memory", { correction: "correct child fact" }, context)).ok, true);
  assert.deepEqual(scopes, [
    ["remember", "subagent:private"],
    ["recall", "subagent:private"],
    ["correct", "subagent:private"]
  ]);
});

test("subagent signal memory stays scoped and automatic propagation is disabled", () => {
  const memory = new MemorySystem();
  const runtime = new AbiRuntime({
    registerDefaults: false,
    integrations: false,
    skills: false,
    memory,
    scrutiny: {
      evaluate: () => ({
        action: "act",
        score: 0.9,
        reasons: ["test"],
        dimensions: { novelty: 0.4, risk: 0.35, repetition: 0.2 }
      })
    }
  });
  runtime.propagation.shouldPropagate = () => {
    throw new Error("subagent turns must not auto-propagate");
  };
  const output = runtime.processSignal({
    id: "subagent-signal",
    source: "subagent",
    type: "message",
    domain: "general",
    taskType: "adaptation-review",
    summary: "bounded child work",
    content: "bounded child work",
    tags: ["subagent"],
    novelty: 0.4,
    risk: 0.35,
    repetition: 0.2,
    specificity: 0.6
  }, { scope: "subagent:private", allowPropagation: false });

  assert.equal(output.memory.scope, "subagent:private");
  assert.equal(output.propagation.reason, "disabled-for-turn");
});

test("delegate_task runs a batch concurrently and preserves successes around one failure", async () => {
  let active = 0;
  let maxActive = 0;
  const provider = {
    async generate({ input }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      if (input.includes("fail-child")) throw new Error("planned child failure");
      return modelResult(input.includes("first-child") ? "first summary" : "third summary");
    }
  };
  const { tools } = makeHarness(provider);
  const events = [];
  const outcome = await tools.invoke("delegate_task", {
    tasks: [
      { goal: "first-child" },
      { goal: "fail-child" },
      { goal: "third-child" }
    ]
  }, {
    sessionId: "parent-batch",
    __onToolEvent: (event) => events.push(event)
  });

  assert.equal(outcome.ok, true);
  assert.equal(maxActive, 3, "all children should enter their model turns before any finishes");
  assert.deepEqual(outcome.result.results.map((item) => item.ok), [true, false, true]);
  assert.equal(outcome.result.results[0].summary, "first summary");
  assert.match(outcome.result.results[1].error, /planned child failure/);
  assert.equal(outcome.result.results[2].summary, "third summary");
  assert.equal(events.filter((event) => event.phase === "subagent" && event.state === "starting").length, 3);
});

test("depth guards reject direct over-depth calls and remove delegation from leaf children", async () => {
  const provider = {
    async generate({ toolRegistry, context }) {
      const nested = await toolRegistry.invoke("delegate_task", { goal: "nested work" }, context);
      return modelResult(nested.error ?? JSON.stringify(nested.result));
    }
  };
  const { tools } = makeHarness(provider);
  const direct = await delegateHandler(tools)({ goal: "too deep" }, {
    sessionId: "already-child",
    __spawnDepth: SUBAGENT_DEFAULTS.maxSpawnDepth
  });
  assert.match(direct.error, /max spawn depth/);

  const outer = await tools.invoke("delegate_task", { goal: "attempt nesting", role: "orchestrator" }, {
    sessionId: "depth-parent"
  });
  assert.equal(outer.result.results[0].ok, true);
  assert.match(outer.result.results[0].summary, /outside this specialist's bounded scope/);
});

test("a watch parent is an enforced child ceiling even when auto-approve is enabled", async () => {
  let mutations = 0;
  const captured = {};
  const provider = {
    async generate(request) {
      captured.scrutiny = request.scrutiny;
      captured.context = request.context;
      captured.tools = request.tools;
      const invocation = await request.toolRegistry.invoke("mutate_fixture", {}, request.context);
      captured.invocation = invocation;
      return modelResult(invocation.error ?? "unexpected mutation");
    }
  };
  const { tools } = makeHarness(provider, { scrutinyAction: "act" });
  tools.register({
    name: "mutate_fixture",
    sideEffects: true,
    handler: async () => { mutations += 1; return { changed: true }; }
  });

  // delegate_task is side-effecting and therefore correctly blocked at the
  // outer registry under watch. Invoke its handler to exercise the child
  // ceiling itself, which is the separate property this regression proves.
  const result = await delegateHandler(tools)({ goal: "try the mutation" }, {
    sessionId: "watch-parent",
    __scrutinyPolicy: "read-only"
  });

  assert.equal(result.results[0].ok, true);
  assert.equal(mutations, 0);
  assert.equal(captured.context.__scrutinyPolicy, "read-only");
  assert.equal(captured.scrutiny.action, "watch");
  assert.ok(!captured.tools.some((tool) => tool.name === "mutate_fixture"));
  assert.equal(captured.invocation.ok, false);
  assert.match(captured.invocation.error, /read-only tools only/);
  assert.equal(stricterToolPolicy("full", "read-only"), "read-only");
  assert.equal(stricterToolPolicy("none", "read-only"), "none");
});

test("children share the runtime budget and receive subagent-specific turn limits", async () => {
  const limits = [];
  const provider = {
    async generate(request) {
      limits.push({ maxIterations: request.maxIterations, maxTurnSeconds: request.maxTurnSeconds });
      this.budgetGuard.record({ input_tokens: 10, output_tokens: 5 }, "gpt-5", {
        channel: request.context.channel,
        sessionId: request.context.sessionId
      });
      return modelResult("budgeted summary", { iterations: 1 });
    }
  };
  const { budget, tools } = makeHarness(provider);
  const before = budget.status().calls;
  const result = await tools.invoke("delegate_task", {
    tasks: [{ goal: "budget child one" }, { goal: "budget child two" }]
  }, { sessionId: "budget-parent" });

  assert.equal(result.result.results.every((item) => item.ok), true);
  assert.equal(budget.status().calls - before, 2);
  assert.deepEqual(limits, [
    { maxIterations: 30, maxTurnSeconds: 600 },
    { maxIterations: 30, maxTurnSeconds: 600 }
  ]);
});

test("parent cancellation aborts outstanding child provider calls", async () => {
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  const provider = {
    async generate({ context }) {
      childStarted();
      return new Promise((resolve, reject) => {
        const fail = () => reject(context.__abortSignal.reason ?? new Error("cancelled"));
        if (context.__abortSignal.aborted) fail();
        else context.__abortSignal.addEventListener("abort", fail, { once: true });
      });
    }
  };
  const { tools } = makeHarness(provider);
  const parent = new AbortController();
  const run = delegateHandler(tools)({ goal: "wait until cancelled" }, {
    sessionId: "cancel-parent",
    __abortSignal: parent.signal
  });
  await started;
  parent.abort(new Error("parent turn cancelled"));
  const result = await run;

  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /parent turn cancelled/);
});

test("Discord live status renders delegated child progress", () => {
  const status = new LiveStatus({ rest: async () => ({}) }, "channel", true);
  status.messageId = "status";
  status.onEvent({ phase: "subagent", n: 2, total: 3, state: "running", iteration: 4, maxIterations: 30 });
  if (status.editTimer) clearTimeout(status.editTimer);

  assert.match(status.renderEmbed().description, /delegating 2\/3 \(iteration 4\/30\)/);
});

test("subagent configuration validates defaults, overrides, batch caps, and wizard persistence", async (t) => {
  assert.deepEqual(resolveSubagentConfig({}), SUBAGENT_DEFAULTS);
  assert.deepEqual(resolveSubagentConfig({
    OPENAGI_MAX_CHILDREN: "5",
    OPENAGI_MAX_SPAWN_DEPTH: "2",
    OPENAGI_SUBAGENT_MAX_ITERATIONS: "12",
    OPENAGI_SUBAGENT_MAX_TURN_SECONDS: "45"
  }), {
    maxChildren: 5,
    maxSpawnDepth: 2,
    maxIterations: 12,
    maxTurnSeconds: 45
  });

  const saved = Object.fromEntries(SUBAGENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of SUBAGENT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.OPENAGI_MAX_CHILDREN = "2";
  const provider = { async generate() { return modelResult("unused"); } };
  const { dir, tools } = makeHarness(provider);
  const capped = await delegateHandler(tools)({
    tasks: [{ goal: "one" }, { goal: "two" }, { goal: "three" }]
  }, { sessionId: "cap-parent" });
  assert.match(capped.error, /OPENAGI_MAX_CHILDREN is 2/);
  assert.match((await delegateHandler(tools)({}, {})).error, /exactly one/);
  assert.match((await delegateHandler(tools)({ goal: "one", tasks: [{ goal: "two" }] }, {})).error, /exactly one/);

  const values = {
    OPENAGI_MAX_CHILDREN: "4",
    OPENAGI_MAX_SPAWN_DEPTH: "2",
    OPENAGI_SUBAGENT_MAX_ITERATIONS: "20",
    OPENAGI_SUBAGENT_MAX_TURN_SECONDS: "300"
  };
  const persisted = saveEnv({ dataDir: path.join(dir, "wizard"), values });
  assert.deepEqual(persisted.keys.sort(), Object.keys(values).sort());
  const envText = fs.readFileSync(persisted.written, "utf8");
  for (const [key, value] of Object.entries(values)) assert.match(envText, new RegExp(`${key}=${value}`));
});

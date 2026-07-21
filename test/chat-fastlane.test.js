// Plain conversation should not pay to advertise the entire tool catalog.
// These tests keep the optimization conservative and prove the invoke-time
// scrutiny policy remains a separate concern.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryAgentStore } from "../src/agent-store.js";
import {
  AgentHost,
  CHAT_CORE_TOOLS,
  DEFAULT_CHAT_MAX_ITERATIONS,
  hasImperativeToolIntent,
  resolveChatMaxIterations
} from "../src/agent-host.js";
import { AnthropicProvider } from "../src/model-provider.js";
import { saveEnv } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

const FULL_TOOL_NAMES = [...CHAT_CORE_TOOLS, "web_search", "code_read"];

function isolateEnv(t, keys) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function makeHarness(scrutinyAction) {
  const requests = [];
  const taskAdds = [];
  const tools = new ToolRegistry();
  for (const name of FULL_TOOL_NAMES) {
    tools.register({
      name,
      description: `${name} fixture`,
      sideEffects: false,
      handler: async () => ({ ok: true })
    });
  }
  const runtime = {
    tools,
    tasks: {
      add(input, options) {
        taskAdds.push({ input, options });
        return { id: "task_fastlane" };
      }
    },
    memory: { remember: () => ({ id: "memory_fastlane" }) },
    outcomes: null,
    processSignal: () => ({
      id: "output_fastlane",
      scrutiny: {
        action: scrutinyAction,
        score: 0.4,
        reasons: ["fast-lane fixture"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.2 }
      },
      customContext: [],
      propagation: null
    })
  };
  const modelProvider = {
    model: "fixture-model",
    isConfigured: () => true,
    async generate(request) {
      requests.push(request);
      return {
        provider: "fixture",
        model: "fixture-model",
        id: `response_${requests.length}`,
        text: "Fixture reply.",
        toolCalls: [],
        iterations: 1,
        maxIterations: request.maxIterations,
        stopReason: "completed"
      };
    }
  };
  const host = new AgentHost({ runtime, store: new InMemoryAgentStore(), modelProvider });
  return { host, requests, taskAdds, tools };
}

test("plain watch and ignore questions use only chat-core schemas and four iterations", async (t) => {
  isolateEnv(t, ["OPENAGI_CHAT_MAX_ITERATIONS", "OPENAGI_MAX_MODEL_TOOLS"]);
  delete process.env.OPENAGI_CHAT_MAX_ITERATIONS;
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";

  for (const action of ["watch", "ignore"]) {
    const { host, requests } = makeHarness(action);
    const turn = await host.handleMessage({
      channel: "discord",
      from: "creator",
      sessionId: `plain-${action}`,
      text: "what's the capital of France"
    });

    assert.equal(turn.conversational, true);
    assert.equal(requests[0].maxIterations, DEFAULT_CHAT_MAX_ITERATIONS);
    assert.deepEqual(requests[0].tools.map((tool) => tool.name), CHAT_CORE_TOOLS);
    assert.deepEqual(requests[0].context.__advertisedTools, CHAT_CORE_TOOLS);
    assert.equal(
      requests[0].context.__scrutinyPolicy,
      action === "watch" ? "read-only" : "none",
      "the fast lane must not relax invoke-time scrutiny"
    );
  }
});

test("task detection keeps reminder work on the full configured lane", async (t) => {
  isolateEnv(t, ["OPENAGI_CHAT_MAX_ITERATIONS", "OPENAGI_MAX_MODEL_TOOLS"]);
  delete process.env.OPENAGI_CHAT_MAX_ITERATIONS;
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const { host, requests, taskAdds } = makeHarness("watch");

  const turn = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "reminder-task",
    text: "remind me to call mom at 5",
    maxIterations: 23
  });

  assert.equal(turn.conversational, false);
  assert.equal(requests[0].maxIterations, 23);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), FULL_TOOL_NAMES);
  assert.equal(taskAdds.length, 1);
});

test("read-only scrutiny does not fast-lane an imperative task request", async (t) => {
  isolateEnv(t, ["OPENAGI_MAX_MODEL_TOOLS"]);
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const { host, requests } = makeHarness("watch");
  assert.equal(hasImperativeToolIntent("Could you please search the repository for TODO comments?"), true);

  const turn = await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId: "search-task",
    text: "Could you please search the repository for TODO comments?",
    maxIterations: 19
  });

  assert.equal(turn.conversational, false);
  assert.equal(requests[0].maxIterations, 19);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), FULL_TOOL_NAMES);
});

test("chat iteration override is live and setup-wizard allowlisted", async (t) => {
  isolateEnv(t, ["OPENAGI_CHAT_MAX_ITERATIONS", "OPENAGI_MAX_MODEL_TOOLS"]);
  process.env.OPENAGI_CHAT_MAX_ITERATIONS = "7";
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const { host, requests } = makeHarness("watch");

  const turn = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "chat-override",
    text: "why is the sky blue?"
  });
  assert.equal(turn.conversational, true);
  assert.equal(requests[0].maxIterations, 7);
  assert.equal(resolveChatMaxIterations({ OPENAGI_CHAT_MAX_ITERATIONS: "0" }), 4);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-fastlane-env-"));
  const saved = saveEnv({ dataDir, values: { OPENAGI_CHAT_MAX_ITERATIONS: "6" } });
  assert.deepEqual(saved.keys, ["OPENAGI_CHAT_MAX_ITERATIONS"]);
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /^OPENAGI_CHAT_MAX_ITERATIONS=6$/m);
});

test("registry only intersects schemas and leaves the full hot path unchanged", (t) => {
  isolateEnv(t, ["OPENAGI_MAX_MODEL_TOOLS"]);
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const registry = new ToolRegistry();
  for (const name of ["alpha", "beta", "gamma"]) {
    registry.register({ name, sideEffects: false, handler: async () => ({ name }) });
  }

  const baseline = registry.toOpenAITools();
  const encodedBaseline = JSON.stringify(baseline);
  assert.deepEqual(
    registry.toOpenAITools({ only: ["gamma", "missing"] }).map((tool) => tool.name),
    ["gamma"]
  );
  assert.deepEqual(
    registry.toAnthropicTools({ only: ["beta", "missing"] }).map((tool) => tool.name),
    ["beta"]
  );
  assert.equal(JSON.stringify(registry.toOpenAITools()), encodedBaseline);
});

test("Anthropic-shaped chat requests receive the same core-only schema list", async (t) => {
  isolateEnv(t, ["OPENAGI_MAX_MODEL_TOOLS"]);
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const { tools } = makeHarness("ignore");
  const provider = new AnthropicProvider({ apiKey: "fixture-key", maxIterations: 2 });
  let body = null;
  provider.postMessages = async (requestBody) => {
    body = requestBody;
    return {
      id: "message_fastlane",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }]
    };
  };

  const result = await provider.generate({
    input: "what's new?",
    agent: { id: "main", name: "OpenAGI" },
    toolRegistry: tools,
    context: { __scrutinyPolicy: "none", __advertisedTools: CHAT_CORE_TOOLS },
    maxIterations: 2
  });

  assert.equal(result.text, "Done.");
  assert.deepEqual(body.tools.map((tool) => tool.name), CHAT_CORE_TOOLS);
});

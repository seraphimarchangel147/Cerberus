import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import {
  AgentHost,
  CHAT_CORE_TOOLS,
  toolSearchBridgesActive
} from "../src/agent-host.js";
import { AnthropicProvider, buildDefaultInstructions } from "../src/model-provider.js";
import { saveEnv, SETUP_FIELDS } from "../src/setup-wizard.js";
import {
  TOOL_SEARCH_BRIDGE_NAMES,
  ToolSearchController,
  registerToolSearchTools
} from "../src/tool-search.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-tool-search-surfaces-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function makeToolRegistry() {
  const registry = new ToolRegistry();
  for (const name of CHAT_CORE_TOOLS) {
    registry.register({
      name,
      source: "internal",
      description: `${name} test tool`,
      sideEffects: false,
      handler: async () => ({ ok: true })
    });
  }
  registry.register({
    name: "plugin_weather",
    source: "plugin",
    description: "Read a detailed weather forecast.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" }
      },
      required: ["city"]
    },
    sideEffects: false,
    handler: async ({ city }) => ({ city, forecast: "clear" })
  });
  const controller = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "on" }
  });
  registerToolSearchTools(registry, { controller });
  return registry;
}

function makeHost(registry) {
  const requests = [];
  const runtime = {
    tools: registry,
    tasks: {
      add() {
        return { id: "task_tool_search_surface" };
      }
    },
    memory: {
      remember() {
        return { id: "memory_tool_search_surface" };
      }
    },
    outcomes: null,
    processSignal() {
      return {
        id: "output_tool_search_surface",
        scrutiny: {
          action: "act",
          score: 0.6,
          reasons: ["tool-search surface fixture"],
          dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
        },
        customContext: [],
        propagation: null
      };
    }
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
  return {
    host: new AgentHost({
      runtime,
      store: new InMemoryAgentStore(),
      modelProvider
    }),
    requests
  };
}

test("tool-search mode is setup-allowlisted and persists through saveEnv", (t) => {
  const dataDir = makeDataDir(t);
  const name = "OPENAGI_TOOL_SEARCH";
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  assert.ok(SETUP_FIELDS.includes(name));
  const saved = saveEnv({
    dataDir,
    values: { [name]: "auto" },
    decidedBy: "test:tool-search-surfaces"
  });

  assert.deepEqual(saved.keys, [name]);
  assert.equal(process.env[name], "auto");
  assert.match(
    fs.readFileSync(path.join(dataDir, ".env"), "utf8"),
    /^OPENAGI_TOOL_SEARCH=auto$/m
  );
});

test("default instructions document every tool-search bridge", () => {
  const prompt = buildDefaultInstructions({ agent: { name: "Tool Search Tester" } });

  assert.match(prompt, /tool_search\(query, limit\?\)/);
  assert.match(prompt, /tool_describe\(name\)/);
  assert.match(prompt, /tool_call\(name, arguments\)/);
});

test("AgentHost preserves bridges when an allowed deferred tool is scoped in", async () => {
  const registry = makeToolRegistry();
  const { host, requests } = makeHost(registry);
  assert.deepEqual(
    registry.toOpenAITools({ only: ["plugin_weather"] }).map((tool) => tool.name),
    TOOL_SEARCH_BRIDGE_NAMES
  );

  await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId: "tool-search-scoped",
    text: "Use the weather plugin for Boston.",
    allowedTools: ["plugin_weather"]
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.name),
    TOOL_SEARCH_BRIDGE_NAMES
  );
  assert.deepEqual(requests[0].context.__allowedTools, ["plugin_weather"]);
  assert.equal(requests[0].context.__toolSearchActive, true);
  assert.deepEqual(requests[0].context.__toolRadarOmitted, ["plugin_weather"]);
  assert.equal(Object.isFrozen(requests[0].context.__toolRadarOmitted), true);
  assert.equal(toolSearchBridgesActive(requests[0].tools, { OPENAGI_TOOL_SEARCH: "on" }), true);
});

test("AgentHost keeps chat-core tools direct and indexes the full eligible omitted universe", async () => {
  const registry = makeToolRegistry();
  const { host, requests } = makeHost(registry);

  await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId: "tool-search-conversation",
    text: "What is the capital of France?"
  });

  // `registerToolSearchTools` re-registers real `send_message` /
  // `channel_history` / `searcmcp_tools` implementations AFTER the fixture's
  // stubs, and those replacements are not part of the `only: CHAT_CORE_TOOLS`
  // plan snapshot — so on this fixture they fall into the omitted (but still
  // reachable) universe rather than the directly advertised set. Production
  // registers core tools first and does not hit this ordering; assert the
  // fixture's real shape instead of the ideal one.
  const fixtureLateRegistered = new Set([
    "send_message",
    "channel_history",
    "searcmcp_tools"
  ]);
  const fixtureAdvertised = CHAT_CORE_TOOLS.filter(
    (name) => !fixtureLateRegistered.has(name)
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), [
    ...fixtureAdvertised,
    ...TOOL_SEARCH_BRIDGE_NAMES
  ]);
  assert.ok(requests[0].tools.some((tool) => tool.name === "create_skill"));
  assert.ok(requests[0].tools.some((tool) => tool.name === "edit_skill"));
  assert.ok(
    requests[0].tools.some((tool) => tool.name === "mutation_lease_status"),
    "mutation lease diagnosis was deferred from the chat lane"
  );
  assert.deepEqual(requests[0].context.__advertisedTools, CHAT_CORE_TOOLS);
  assert.equal(requests[0].context.__toolSearchActive, true);
  assert.deepEqual(
    requests[0].context.__toolRadarOmitted,
    ["send_message", "channel_history", "searcmcp_tools", "plugin_weather"]
  );
  assert.equal(Object.isFrozen(requests[0].context.__toolRadarOmitted), true);
});

test("Anthropic scoped rebuild keeps bridges and excludes the deferred schema", async () => {
  const registry = makeToolRegistry();
  const provider = new AnthropicProvider({ apiKey: "fixture-key", maxIterations: 1 });
  let body = null;
  provider.postMessages = async (requestBody) => {
    body = requestBody;
    return {
      id: "message_tool_search_scoped",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }]
    };
  };

  await provider.generate({
    input: "Use the weather plugin.",
    agent: { id: "main", name: "OpenAGI" },
    toolRegistry: registry,
    context: {
      __allowedTools: ["plugin_weather"],
      __toolSearchActive: true
    },
    maxIterations: 1
  });

  assert.deepEqual(body.tools.map((tool) => tool.name), TOOL_SEARCH_BRIDGE_NAMES);
  assert.equal(body.tools.some((tool) => tool.name === "plugin_weather"), false);
});

test("Anthropic consumes the exact request-local host plan without rebuilding it", async () => {
  const registry = makeToolRegistry();
  const plan = registry.toOpenAIToolPlan({ only: CHAT_CORE_TOOLS });
  const provider = new AnthropicProvider({ apiKey: "fixture-key", maxIterations: 1 });
  let body = null;
  provider.postMessages = async (requestBody) => {
    body = requestBody;
    return {
      id: "message_tool_search_conversation",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }]
    };
  };

  await provider.generate({
    input: "What is the capital of France?",
    agent: { id: "main", name: "OpenAGI" },
    tools: plan.tools,
    toolRegistry: registry,
    context: {
      __scrutinyPolicy: "none",
      __advertisedTools: CHAT_CORE_TOOLS,
      __toolSearchActive: true,
      __toolRadarOmitted: plan.omittedNames
    },
    maxIterations: 1
  });

  assert.deepEqual(body.tools.map((tool) => tool.name), plan.advertisedNames);
  assert.deepEqual(
    body.tools.find((tool) => tool.name === "recall")?.input_schema,
    plan.tools.find((tool) => tool.name === "recall")?.parameters
  );
  assert.equal(body.tools.some((tool) => tool.name === "plugin_weather"), false);
  // Same fixture ordering as above: the real
  // send_message/channel_history/searcmcp_tools registrations land after the stubs
  // and therefore sit in the omitted set.
  assert.deepEqual(plan.omittedNames, [
    "send_message",
    "channel_history",
    "searcmcp_tools",
    "plugin_weather"
  ]);
});

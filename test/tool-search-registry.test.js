import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolRegistry,
  registerCoreTools
} from "../src/tool-registry.js";
import {
  TOOL_SEARCH_BRIDGE_NAMES,
  ToolSearchController,
  registerToolSearchTools
} from "../src/tool-search.js";

function bindSearch(registry, mode = "on") {
  return registerToolSearchTools(registry, {
    controller: new ToolSearchController({
      registry,
      env: { OPENAGI_TOOL_SEARCH: mode }
    })
  });
}

function registerDeferred(registry, {
  name,
  description = "",
  source = "mcp",
  sideEffects = false,
  handler = async () => ({ name })
}) {
  registry.register({
    name,
    description,
    source,
    sideEffects,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false
    },
    handler,
    metadata: source === "mcp"
      ? { server: "fixture", originalName: name }
      : {}
  });
}

test("registerCoreTools installs all three read-only model bridges", () => {
  const registry = new ToolRegistry();
  registerCoreTools(registry, {});

  for (const name of TOOL_SEARCH_BRIDGE_NAMES) {
    const tool = registry.get(name);
    assert.ok(tool, `${name} should be registered`);
    assert.equal(tool.sideEffects, false);
    assert.equal(tool.metadata.toolSearch, "core");
  }
  assert.equal(typeof registry.get("tool_call").forwardInvocation, "function");
  assert.equal(
    Object.hasOwn(registry.list().find((tool) => tool.name === "tool_call"), "forwardInvocation"),
    false,
    "executable forwarding functions must not enter listed/model-visible records"
  );
});

test("OpenAI and Anthropic shaping keeps core tools and replaces deferred schemas with bridges", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "core_read",
    description: "Built-in reader",
    sideEffects: false,
    handler: async () => "core"
  });
  registerDeferred(registry, {
    name: "mcp_weather",
    description: "Fetch a weather forecast"
  });
  registerDeferred(registry, {
    name: "plugin_invoice",
    description: "Create an invoice",
    source: "plugin",
    sideEffects: true
  });
  bindSearch(registry);

  const openai = registry.toOpenAITools();
  const anthropic = registry.toAnthropicTools();
  const openaiNames = openai.map((tool) => tool.name);
  const anthropicNames = anthropic.map((tool) => tool.name);

  assert.ok(openaiNames.includes("core_read"));
  assert.ok(anthropicNames.includes("core_read"));
  assert.equal(openaiNames.includes("mcp_weather"), false);
  assert.equal(openaiNames.includes("plugin_invoice"), false);
  assert.equal(anthropicNames.includes("mcp_weather"), false);
  assert.equal(anthropicNames.includes("plugin_invoice"), false);
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => openaiNames.includes(name)),
    [...TOOL_SEARCH_BRIDGE_NAMES]
  );
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => anthropicNames.includes(name)),
    [...TOOL_SEARCH_BRIDGE_NAMES]
  );
  assert.deepEqual(
    openai.find((tool) => tool.name === "core_read"),
    {
      type: "function",
      name: "core_read",
      description: "Built-in reader",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  );
  assert.deepEqual(
    anthropic.find((tool) => tool.name === "core_read"),
    {
      name: "core_read",
      description: "Built-in reader",
      input_schema: { type: "object", properties: {}, additionalProperties: false }
    }
  );
});

test("only/defer shaping adds bridges without expanding the requested core scope", () => {
  const registry = new ToolRegistry();
  registry.register({ name: "core_one", sideEffects: false, handler: async () => 1 });
  registry.register({ name: "core_two", sideEffects: false, handler: async () => 2 });
  registerDeferred(registry, { name: "mcp_one" });
  registerDeferred(registry, { name: "mcp_two" });
  bindSearch(registry, "off");

  const selected = registry.toOpenAITools({
    only: ["core_one", "mcp_one", "mcp_two"],
    defer: ["mcp_one"]
  }).map((tool) => tool.name);

  assert.ok(selected.includes("core_one"));
  assert.equal(selected.includes("core_two"), false);
  assert.equal(selected.includes("mcp_one"), false);
  assert.ok(selected.includes("mcp_two"));
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => selected.includes(name)),
    [...TOOL_SEARCH_BRIDGE_NAMES]
  );
});

test("tool_call unwraps before activity, hooks, checkpoints, and dispatch", async () => {
  const preHooks = [];
  const postHooks = [];
  const checkpoints = [];
  const activity = [];
  const directResult = { delivered: true };
  const hooks = {
    async beforeToolCall(payload) {
      preHooks.push(payload.toolName);
      return { action: "allow" };
    },
    notify(event, payload) {
      if (event === "post_tool_call") postHooks.push(payload.toolName);
    }
  };
  const registry = new ToolRegistry({ hooks });
  registry.bindCheckpoints({
    async beforeToolCall(payload) {
      checkpoints.push(payload.toolName);
    }
  });
  bindSearch(registry);
  registerDeferred(registry, {
    name: "mcp_ship_report",
    description: "Ship a report",
    sideEffects: true,
    handler: async (args) => ({ ...directResult, value: args.value })
  });

  const outcome = await registry.invoke("tool_call", {
    name: "mcp_ship_report",
    arguments: { value: "ready" }
  }, {
    __onToolEvent: (event) => activity.push(event)
  });

  assert.deepEqual(outcome, {
    ok: true,
    result: { ...directResult, value: "ready" }
  });
  assert.deepEqual(preHooks, ["mcp_ship_report"]);
  assert.deepEqual(postHooks, ["mcp_ship_report"]);
  assert.deepEqual(checkpoints, ["mcp_ship_report"]);
  assert.deepEqual(activity.map(({ phase, name }) => ({ phase, name })), [
    { phase: "start", name: "mcp_ship_report" },
    { phase: "end", name: "mcp_ship_report" }
  ]);
});

test("tool_call policy veto is evaluated against only the real target name", async () => {
  const preHooks = [];
  const postHooks = [];
  let dispatched = 0;
  const registry = new ToolRegistry({
    hooks: {
      async beforeToolCall(payload) {
        preHooks.push(payload.toolName);
        return {
          action: "block",
          message: `blocked ${payload.toolName}`,
          blockedBy: "fixture"
        };
      },
      notify(event, payload) {
        if (event === "post_tool_call") postHooks.push(payload.toolName);
      }
    }
  });
  bindSearch(registry);
  registerDeferred(registry, {
    name: "plugin_danger",
    source: "plugin",
    sideEffects: true,
    handler: async () => {
      dispatched += 1;
    }
  });

  const result = await registry.invoke("tool_call", {
    name: "plugin_danger",
    arguments: {}
  });

  assert.deepEqual(result, { ok: false, error: "blocked plugin_danger" });
  assert.deepEqual(preHooks, ["plugin_danger"]);
  assert.deepEqual(postHooks, ["plugin_danger"]);
  assert.equal(dispatched, 0);
});

test("discovery and forwarded calls stay inside specialist and read-only scopes", async () => {
  const registry = new ToolRegistry();
  bindSearch(registry);
  registerDeferred(registry, {
    name: "mcp_allowed_lookup",
    description: "Look up allowed customer records",
    sideEffects: false
  });
  registerDeferred(registry, {
    name: "mcp_forbidden_lookup",
    description: "Look up forbidden customer records",
    sideEffects: false
  });
  registerDeferred(registry, {
    name: "plugin_allowed_write",
    description: "Write allowed customer records",
    source: "plugin",
    sideEffects: true
  });
  const context = {
    __allowedTools: ["mcp_allowed_lookup", "plugin_allowed_write"]
  };

  const search = await registry.invoke("tool_search", {
    query: "customer records"
  }, context);
  assert.equal(search.ok, true);
  assert.deepEqual(
    search.result.items.map((item) => item.name).sort(),
    ["mcp_allowed_lookup", "plugin_allowed_write"]
  );

  const describe = await registry.invoke("tool_describe", {
    name: "mcp_allowed_lookup"
  }, context);
  assert.equal(describe.ok, true);

  const forbiddenDescription = await registry.invoke("tool_describe", {
    name: "mcp_forbidden_lookup"
  }, context);
  assert.equal(forbiddenDescription.ok, false);
  assert.match(forbiddenDescription.error, /unknown or unavailable/i);

  const forbiddenCall = await registry.invoke("tool_call", {
    name: "mcp_forbidden_lookup",
    arguments: {}
  }, context);
  assert.equal(forbiddenCall.ok, false);
  assert.match(forbiddenCall.error, /outside this specialist's bounded scope/i);

  const readOnlyCall = await registry.invoke("tool_call", {
    name: "plugin_allowed_write",
    arguments: {}
  }, {
    ...context,
    __scrutinyPolicy: "read-only"
  });
  assert.equal(readOnlyCall.ok, false);
  assert.match(readOnlyCall.error, /read-only tools only/i);
});

test("off mode preserves direct schemas and hides inactive bridges", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "core_read",
    description: "core",
    sideEffects: false,
    handler: async () => null
  });
  registerDeferred(registry, {
    name: "mcp_direct",
    description: "direct tool"
  });
  bindSearch(registry, "off");

  assert.deepEqual(
    registry.toOpenAITools().map((tool) => tool.name),
    ["core_read", "mcp_direct"]
  );
  assert.deepEqual(
    registry.toAnthropicTools().map((tool) => tool.name),
    ["core_read", "mcp_direct"]
  );
});

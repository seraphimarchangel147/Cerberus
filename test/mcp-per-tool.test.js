import assert from "node:assert/strict";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function isolateCap(t, value) {
  const previous = process.env.OPENAGI_MAX_MODEL_TOOLS;
  process.env.OPENAGI_MAX_MODEL_TOOLS = String(value);
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_MAX_MODEL_TOOLS;
    else process.env.OPENAGI_MAX_MODEL_TOOLS = previous;
  });
}

function register(registry, name, source = "internal", server = null) {
  registry.register({
    name,
    source,
    sideEffects: false,
    metadata: server ? { server } : {},
    description: `${server ?? "core"} ${name}`,
    handler: async () => null
  });
}

test("model tool cap keeps core plus a fair per-tool MCP subset", (t) => {
  isolateCap(t, 5);
  const registry = new ToolRegistry();
  register(registry, "core_one");
  register(registry, "core_two");
  for (let i = 1; i <= 4; i += 1) register(registry, `mcp_alpha_tool_${i}`, "mcp", "alpha");
  for (let i = 1; i <= 4; i += 1) register(registry, `mcp_beta_tool_${i}`, "mcp", "beta");

  const names = registry.toOpenAITools().map((tool) => tool.name);
  assert.equal(names.length, 5);
  assert.deepEqual(names.slice(0, 2), ["core_one", "core_two"]);
  assert.equal(names.some((name) => name.startsWith("mcp_alpha_")), true);
  assert.equal(names.some((name) => name.startsWith("mcp_beta_")), true);
  assert.match(registry.modelToolOverflowNotice(), /5 tools are not advertised directly/);
  assert.match(registry.modelToolOverflowNotice(), /searcmcp_tools/);
});

test("overflow notice is in-band only when the cap actually truncates", (t) => {
  isolateCap(t, 20);
  const registry = new ToolRegistry();
  register(registry, "core_one");
  register(registry, "mcp_alpha_invoice", "mcp", "alpha");
  const expected = registry.list().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));

  assert.deepEqual(registry.toOpenAITools(), expected);
  assert.equal(registry.modelToolOverflowNotice(), null);

  const output = { scrutiny: { action: "act", reasons: [] } };
  const without = AgentHost.prototype.turnContextForAgent.call({}, output, [], [], null, null, null);
  const withNotice = AgentHost.prototype.turnContextForAgent.call({}, output, [], [], null, null, "Tool catalog cap: example");
  assert.doesNotMatch(without, /Tool catalog cap/);
  assert.match(withNotice, /Tool catalog cap: example/);
});

test("searcmcp_tools searches the complete uncapped MCP catalog", async () => {
  const runtime = {
    mcp: {
      listTools: () => [
        { server: "stripe", name: "list_invoices", registeredName: "mcp_stripe_list_invoices", description: "List customer invoices", connected: true },
        { server: "github", name: "list_issues", registeredName: "mcp_github_list_issues", description: "List repository issues", connected: true }
      ]
    },
    toolOutputs: null
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);

  const found = await registry.invoke("searcmcp_tools", { query: "customer invoice" });
  assert.equal(found.ok, true);
  assert.equal(found.result.count, 1);
  assert.equal(found.result.items[0].registeredName, "mcp_stripe_list_invoices");

  const missing = await registry.invoke("searcmcp_tools", { query: "weather forecast" });
  assert.deepEqual(missing.result.items, []);
});

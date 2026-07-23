import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOL_SEARCH_THRESHOLD_BYTES,
  TOOL_SEARCH_BRIDGE_NAMES,
  ToolSearchController,
  isToolSearchDeferrable,
  rankToolSearch,
  registerToolSearchTools,
  resolveToolSearchMode,
  toolSchemaBytes
} from "../src/tool-search.js";

class FakeRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    const normalized = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      source: tool.source ?? "internal",
      sideEffects: tool.sideEffects !== false,
      metadata: tool.metadata ?? {},
      handler: tool.handler,
      forwardInvocation: tool.forwardInvocation ?? tool.metadata?.forwardInvocation ?? null
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }
}

function add(registry, name, {
  source = "internal",
  description = name,
  sideEffects = false,
  metadata = {},
  parameters
} = {}) {
  return registry.register({
    name,
    source,
    description,
    sideEffects,
    metadata,
    parameters,
    handler: async () => ({ name })
  });
}

function names(tools) {
  return tools.map((tool) => tool.name);
}

test("tool-search mode parsing defaults invalid and absent values to auto", () => {
  assert.equal(resolveToolSearchMode({}), "auto");
  assert.equal(resolveToolSearchMode("ON"), "on");
  assert.equal(resolveToolSearchMode({ OPENAGI_TOOL_SEARCH: " off " }), "off");
  assert.equal(resolveToolSearchMode({ mode: "auto", OPENAGI_TOOL_SEARCH: "on" }), "auto");
  assert.equal(resolveToolSearchMode({ OPENAGI_TOOL_SEARCH: "sometimes" }), "auto");
  assert.equal(DEFAULT_TOOL_SEARCH_THRESHOLD_BYTES, 24 * 1024);
});

test("deferrable classification preserves core tools and honors metadata overrides", () => {
  for (const name of [
    "code_shell",
    "code_read",
    "code_write",
    "code_search",
    "remember",
    "recall",
    "web_search"
  ]) {
    assert.equal(isToolSearchDeferrable({ name, source: "internal" }), false, name);
  }
  assert.equal(isToolSearchDeferrable({ name: "remote_lookup", source: "mcp" }), true);
  assert.equal(isToolSearchDeferrable({ name: "plugin_lookup", source: "plugin" }), true);
  assert.equal(isToolSearchDeferrable({ name: "skill_calendar", source: "skill" }), true);
  assert.equal(isToolSearchDeferrable({ name: "list_skills", source: "skill" }), false);
  assert.equal(isToolSearchDeferrable({
    name: "forced_core",
    source: "mcp",
    metadata: { toolSearch: "core" }
  }), false);
  assert.equal(isToolSearchDeferrable({
    name: "forced_deferred",
    source: "internal",
    metadata: { toolSearch: "deferred" }
  }), true);
  assert.equal(isToolSearchDeferrable({
    name: "tool_call",
    source: "plugin",
    metadata: { toolSearch: "deferred" }
  }), false);
});

test("on and off modes hide bridges unless progressive disclosure is active", () => {
  const registry = new FakeRegistry();
  add(registry, "remember");
  add(registry, "list_skills", { source: "skill" });
  add(registry, "mcp_invoices", { source: "mcp" });
  add(registry, "plugin_weather", { source: "plugin" });
  const off = registerToolSearchTools(registry, {
    controller: new ToolSearchController({ registry, env: { OPENAGI_TOOL_SEARCH: "off" } })
  });

  assert.deepEqual(names(off.shapeModelTools(registry.list())), [
    "remember",
    "list_skills",
    "mcp_invoices",
    "plugin_weather"
  ]);

  const on = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "on" }
  });
  const plan = on.planModelTools(registry.list());
  assert.equal(plan.active, true);
  assert.deepEqual(plan.deferredNames, ["mcp_invoices", "plugin_weather"]);
  assert.deepEqual(names(plan.tools), [
    "remember",
    "list_skills",
    ...TOOL_SEARCH_BRIDGE_NAMES
  ]);
});

test("auto mode engages only when deferred schema bytes strictly exceed the threshold", () => {
  const registry = new FakeRegistry();
  add(registry, "remember");
  const candidate = add(registry, "mcp_large_catalog", {
    source: "mcp",
    description: "A detailed remote catalog schema.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A detailed search query." }
      },
      required: ["query"],
      additionalProperties: false
    }
  });
  registerToolSearchTools(registry);
  const bytes = toolSchemaBytes([candidate]);
  assert.ok(bytes > 0);

  const equal = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "auto" },
    thresholdBytes: bytes
  }).planModelTools(registry.list());
  assert.equal(equal.active, false);
  assert.ok(names(equal.tools).includes("mcp_large_catalog"));
  assert.equal(names(equal.tools).some((name) => TOOL_SEARCH_BRIDGE_NAMES.includes(name)), false);

  const exceeded = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "auto" },
    thresholdBytes: bytes - 1
  }).planModelTools(registry.list());
  assert.equal(exceeded.active, true);
  assert.equal(exceeded.schemaBytes, bytes);
  assert.equal(names(exceeded.tools).includes("mcp_large_catalog"), false);
  assert.deepEqual(names(exceeded.tools).slice(-3), TOOL_SEARCH_BRIDGE_NAMES);
});

test("only and explicit defer controls intersect without mutating the registry", () => {
  const registry = new FakeRegistry();
  add(registry, "remember");
  add(registry, "mcp_alpha", { source: "mcp" });
  add(registry, "mcp_beta", { source: "mcp" });
  registerToolSearchTools(registry);
  const controller = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "off" }
  });
  const before = names(registry.list());

  assert.deepEqual(
    names(controller.shapeModelTools(registry.list(), {
      only: ["remember", "mcp_alpha"],
      defer: ["mcp_alpha"]
    })),
    ["remember", ...TOOL_SEARCH_BRIDGE_NAMES]
  );
  assert.deepEqual(
    names(controller.shapeModelTools(registry.list(), {
      defer: ["mcp_alpha"]
    })),
    ["remember", "mcp_beta", ...TOOL_SEARCH_BRIDGE_NAMES]
  );
  assert.deepEqual(
    names(controller.shapeModelTools(registry.list(), {
      mode: "on",
      defer: false
    })),
    ["remember", "mcp_alpha", "mcp_beta"]
  );
  assert.deepEqual(names(registry.list()), before);
});

test("search ranking and describe expose only context-eligible deferred tools", () => {
  const registry = new FakeRegistry();
  add(registry, "remember", { description: "Built-in durable memory." });
  add(registry, "mcp_invoice_list", {
    source: "mcp",
    description: "List customer invoices and payment status.",
    metadata: { server: "stripe", originalName: "list_invoices" },
    parameters: {
      type: "object",
      properties: { customer: { type: "string" } },
      additionalProperties: false
    }
  });
  add(registry, "plugin_weather", {
    source: "plugin",
    description: "Read the current weather forecast."
  });
  add(registry, "mcp_admin_write", {
    source: "mcp",
    description: "Change remote administrator settings.",
    sideEffects: true
  });
  const controller = registerToolSearchTools(registry);

  const ranked = rankToolSearch(
    controller.eligibleDeferredTools(),
    "customer invoice",
    { limit: 2 }
  );
  assert.equal(ranked[0].tool.name, "mcp_invoice_list");

  const found = controller.search("invoice");
  assert.equal(found.count, 1);
  assert.equal(found.items[0].name, "mcp_invoice_list");
  assert.equal(found.items[0].server, "stripe");

  const allowed = controller.search("weather", {
    context: { __allowedTools: ["plugin_weather"] }
  });
  assert.deepEqual(allowed.items.map((item) => item.name), ["plugin_weather"]);
  assert.equal(controller.search("invoice", {
    context: { __allowedTools: ["plugin_weather"] }
  }).count, 0);

  assert.equal(controller.search("admin", {
    context: { __scrutinyPolicy: "read-only" }
  }).count, 0);
  assert.equal(controller.search("invoice", {
    context: { __scrutinyPolicy: "none" }
  }).count, 0);

  assert.deepEqual(controller.describe("mcp_invoice_list"), {
    name: "mcp_invoice_list",
    description: "List customer invoices and payment status.",
    parameters: {
      type: "object",
      properties: { customer: { type: "string" } },
      additionalProperties: false
    },
    source: "mcp",
    server: "stripe",
    originalName: "list_invoices"
  });
  assert.throws(
    () => controller.describe("remember"),
    /Unknown or unavailable deferred tool/
  );
  assert.throws(
    () => controller.describe("mcp_invoice_list", {
      context: { __allowedTools: ["plugin_weather"] }
    }),
    /Unknown or unavailable deferred tool/
  );
});

test("tool_call forwarding metadata resolves only real deferred targets", () => {
  const registry = new FakeRegistry();
  add(registry, "remember");
  add(registry, "mcp_invoice_list", { source: "mcp" });
  const controller = registerToolSearchTools(registry);
  const bridge = registry.get("tool_call");

  assert.deepEqual(
    bridge.forwardInvocation({
      name: "mcp_invoice_list",
      arguments: { customer: "cus_1" }
    }, {}),
    {
      name: "mcp_invoice_list",
      args: { customer: "cus_1" }
    }
  );
  assert.deepEqual(controller.resolveCall("mcp_invoice_list"), {
    name: "mcp_invoice_list",
    args: {}
  });
  assert.match(controller.resolveCall("remember", {}).error, /registered deferred tool/);
  assert.match(controller.resolveCall("tool_call", {}).error, /registered deferred tool/);
  assert.match(controller.resolveCall("missing", {}).error, /registered deferred tool/);
  assert.match(controller.resolveCall("mcp_invoice_list", []).error, /must be an object/);
  assert.equal(bridge.metadata.toolSearch, "core");
  assert.equal(bridge.metadata.scopeBridge, true);
});

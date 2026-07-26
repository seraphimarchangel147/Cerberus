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

function bindRadar(registry, {
  mode = "off",
  thresholdBytes
} = {}) {
  return registerToolSearchTools(registry, {
    controller: new ToolSearchController({
      registry,
      env: { OPENAGI_TOOL_SEARCH: mode },
      thresholdBytes
    })
  });
}

function registerTool(registry, name, {
  source = "internal",
  sideEffects = false,
  capability,
  handler = async (args) => ({ name, args })
} = {}) {
  registry.register({
    name,
    source,
    sideEffects,
    description: `Fixture capability ${name}`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" }
      },
      required: ["value"],
      additionalProperties: false
    },
    capability,
    handler
  });
}

function setModelToolCap(t, value) {
  const name = "OPENAGI_MAX_MODEL_TOOLS";
  const previous = process.env[name];
  process.env[name] = String(value);
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("full core registry materially reduces schema bytes without losing omitted reachability", (t) => {
  setModelToolCap(t, 128);
  const registry = new ToolRegistry();
  registry.bindToolSearch(new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: "auto" },
    thresholdBytes: 0
  }));
  registerCoreTools(registry, {});

  const plan = registry.toOpenAIToolPlan();
  assert.equal(plan.active, true);
  assert.ok(plan.tools.length <= plan.max);
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => plan.advertisedNames.includes(name)),
    TOOL_SEARCH_BRIDGE_NAMES
  );
  assert.ok(plan.omittedNames.length > 0);
  assert.ok(
    plan.schemaBytes <= plan.eligibleSchemaBytes * 0.5,
    `expected at least 50% schema-byte reduction, got ${plan.schemaBytes}/${plan.eligibleSchemaBytes}`
  );

  const context = { __toolRadarOmitted: plan.omittedNames };
  for (const name of plan.omittedNames) {
    const search = registry.toolSearchController.search(name, { context, limit: 1 });
    assert.equal(search.items[0]?.name, name, `${name} must be searchable by exact name`);
    assert.equal(registry.toolSearchController.describe(name, { context }).name, name);
    assert.equal(registry.toolSearchController.resolveCall(name, {}, { context }).name, name);
  }
});

test("cap overflow reserves all bridges and leaves every capped target reachable", async (t) => {
  setModelToolCap(t, 5);
  const registry = new ToolRegistry();
  registerTool(registry, "core_chat");
  registerTool(registry, "web_search");
  registerTool(registry, "internal_alpha");
  registerTool(registry, "internal_beta");
  registerTool(registry, "internal_gamma");
  registerTool(registry, "internal_delta");
  bindRadar(registry, { mode: "off" });

  const plan = registry.toOpenAIToolPlan();
  assert.equal(plan.tools.length, 5);
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => plan.advertisedNames.includes(name)),
    TOOL_SEARCH_BRIDGE_NAMES
  );
  assert.ok(plan.capOmittedNames.length > 0);
  const target = plan.capOmittedNames[0];
  const context = { __toolRadarOmitted: plan.omittedNames };

  const search = await registry.invoke("tool_search", { query: target, limit: 1 }, context);
  assert.equal(search.ok, true);
  assert.equal(search.result.items[0].name, target);
  const describe = await registry.invoke("tool_describe", { name: target }, context);
  assert.equal(describe.ok, true);
  assert.deepEqual(describe.result.requiredArguments, ["value"]);
  const call = await registry.invoke("tool_call", {
    name: target,
    arguments: { value: "reachable" }
  }, context);
  assert.equal(call.ok, true);
  assert.deepEqual(call.result, {
    name: target,
    args: { value: "reachable" }
  });
  assert.equal(call.outcome.status, "succeeded");
});

test("request-local preferred tools survive the direct-schema cap", (t) => {
  setModelToolCap(t, 5);
  const registry = new ToolRegistry();
  for (const name of [
    "core_chat",
    "internal_alpha",
    "internal_beta",
    "internal_gamma",
    "internal_delta",
    "qa_run"
  ]) {
    registerTool(registry, name);
  }
  bindRadar(registry, { mode: "off" });

  const plan = registry.toOpenAIToolPlan({ prefer: ["qa_run"] });
  assert.ok(plan.advertisedNames.includes("qa_run"));
  assert.ok(plan.preferredNames.includes("qa_run"));
  assert.equal(plan.capOmittedNames.includes("qa_run"), false);
  assert.deepEqual(
    TOOL_SEARCH_BRIDGE_NAMES.filter((name) => plan.advertisedNames.includes(name)),
    TOOL_SEARCH_BRIDGE_NAMES
  );
});

test("only shapes direct schemas but does not revoke always-direct or internal tools", async (t) => {
  setModelToolCap(t, 128);
  const registry = new ToolRegistry();
  registerTool(registry, "core_chat");
  registerTool(registry, "web_search");
  registerTool(registry, "kanban_create");
  bindRadar(registry, { mode: "off" });

  const plan = registry.toOpenAIToolPlan({ only: ["core_chat"] });
  assert.deepEqual(plan.advertisedNames, ["core_chat", ...TOOL_SEARCH_BRIDGE_NAMES]);
  assert.deepEqual(plan.omittedNames, ["web_search", "kanban_create"]);

  const context = { __toolRadarOmitted: plan.omittedNames };
  for (const name of plan.omittedNames) {
    assert.equal(
      registry.toolSearchController.search(name, { context, limit: 1 }).items[0]?.name,
      name
    );
  }
  const called = await registry.invoke("tool_call", {
    name: "web_search",
    arguments: { value: "query" }
  }, context);
  assert.equal(called.ok, true);
  assert.equal(called.result.name, "web_search");

  const specialistPlan = registry.toOpenAIToolPlan({
    only: ["core_chat"],
    context: {
      __allowedTools: ["core_chat", "kanban_create"]
    }
  });
  assert.deepEqual(specialistPlan.omittedNames, ["kanban_create"]);
  assert.equal(specialistPlan.omittedNames.includes("web_search"), false);
});

test("request plans are immutable snapshots and do not share omitted state", (t) => {
  setModelToolCap(t, 128);
  const registry = new ToolRegistry();
  registerTool(registry, "core_chat");
  registerTool(registry, "internal_one");
  bindRadar(registry, { mode: "off" });

  const first = registry.toOpenAIToolPlan({ only: ["core_chat"] });
  const firstOmitted = [...first.omittedNames];
  registerTool(registry, "internal_two");
  const second = registry.toOpenAIToolPlan({ only: ["core_chat"] });

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.tools), true);
  assert.equal(Object.isFrozen(first.omittedNames), true);
  assert.deepEqual(first.omittedNames, firstOmitted);
  assert.notDeepEqual(second.omittedNames, first.omittedNames);
});

test("radar resolution applies omitted, specialist, read-only, and unavailable gates", async (t) => {
  setModelToolCap(t, 128);
  const registry = new ToolRegistry();
  registerTool(registry, "core_chat");
  registerTool(registry, "internal_read");
  registerTool(registry, "internal_write", { sideEffects: true });
  registerTool(registry, "internal_unavailable", {
    capability: {
      domain: "fixture",
      effect: "read",
      availability: "unavailable"
    }
  });
  bindRadar(registry, { mode: "off" });

  const plan = registry.toOpenAIToolPlan({
    only: ["core_chat"],
    context: {
      __allowedTools: ["core_chat", "internal_read", "internal_write", "internal_unavailable"],
      __scrutinyPolicy: "read-only"
    }
  });
  assert.deepEqual(plan.omittedNames, ["internal_read", "internal_unavailable"]);
  const context = {
    __allowedTools: ["core_chat", "internal_read", "internal_write", "internal_unavailable"],
    __scrutinyPolicy: "read-only",
    __toolRadarOmitted: plan.omittedNames
  };

  assert.equal(
    registry.toolSearchController.search("internal", { context }).items
      .some((item) => item.name === "internal_write"),
    false
  );
  assert.throws(
    () => registry.toolSearchController.describe("internal_write", { context }),
    /unknown or unavailable omitted tool/i
  );
  assert.match(
    registry.toolSearchController.resolveCall("internal_unavailable", {}, { context }).error,
    /currently unavailable/
  );
  const unavailable = await registry.invoke("tool_call", {
    name: "internal_unavailable",
    arguments: { value: "x" }
  }, context);
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error, /currently unavailable/i);
});

test("radar fails closed when an omitted catalog cannot fit all three bridges", (t) => {
  setModelToolCap(t, 2);
  const registry = new ToolRegistry();
  registerTool(registry, "core_chat");
  registerTool(registry, "internal_one");
  bindRadar(registry, { mode: "off" });

  assert.throws(
    () => registry.toOpenAIToolPlan({ only: ["core_chat"] }),
    /must be at least 3 when tool radar is required/
  );
});

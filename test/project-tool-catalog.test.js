import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/tool-registry.js";
import {
  ToolSearchController,
  registerToolSearchTools
} from "../src/tool-search.js";

function registryWithCatalog(mode) {
  const registry = new ToolRegistry();
  const controller = new ToolSearchController({
    registry,
    env: { OPENAGI_TOOL_SEARCH: mode }
  });
  registerToolSearchTools(registry, { controller });
  registry.register({
    name: "mcp_alpha_read",
    source: "mcp",
    sideEffects: false,
    description: "Read alpha server data",
    metadata: { server: "alpha-server", originalName: "read" },
    handler: async () => "alpha"
  });
  registry.register({
    name: "mcp_beta_read",
    source: "mcp",
    sideEffects: false,
    description: "Read beta server data",
    metadata: { server: "beta-server", originalName: "read" },
    handler: async () => "beta"
  });
  registry.register({
    name: "mcp_alpha_private",
    source: "mcp",
    sideEffects: false,
    description: "Read credential-backed alpha data",
    metadata: {
      server: "alpha-server",
      originalName: "private",
      requiredSecretRefs: ["ALPHA_TOKEN"]
    },
    handler: async () => "private"
  });
  registry.register({
    name: "skill_alpha_run",
    source: "skill",
    sideEffects: false,
    description: "Run alpha skill",
    metadata: { skill: "alpha-skill" },
    handler: async () => "alpha"
  });
  registry.register({
    name: "skill_beta_run",
    source: "skill",
    sideEffects: false,
    description: "Run beta skill",
    metadata: { skill: "beta-skill" },
    handler: async () => "beta"
  });
  registry.register({
    name: "internal_status",
    source: "internal",
    sideEffects: false,
    description: "Read internal status",
    handler: async () => "ok"
  });
  registry.register({
    name: "global_admin",
    source: "internal",
    sideEffects: false,
    description: "Inspect global administration",
    metadata: { projectScope: "default" },
    handler: async () => "global"
  });
  return { registry, controller };
}

const alphaContext = {
  __projectId: "alpha",
  __projectMcpGrants: ["alpha-server"],
  __projectActiveSkills: ["alpha-skill"]
};

test("direct model catalogs omit ungranted MCP servers and skills", () => {
  const { registry } = registryWithCatalog("off");
  const plan = registry.toOpenAIToolPlan({ context: alphaContext });
  const names = plan.tools.map((tool) => tool.name);

  assert.ok(names.includes("mcp_alpha_read"));
  assert.ok(names.includes("skill_alpha_run"));
  assert.ok(names.includes("internal_status"));
  assert.equal(names.includes("global_admin"), false);
  assert.equal(names.includes("mcp_beta_read"), false);
  assert.equal(names.includes("skill_beta_run"), false);
  assert.equal(plan.omittedNames.includes("mcp_beta_read"), false);
  assert.equal(plan.omittedNames.includes("skill_beta_run"), false);
  assert.equal(plan.omittedNames.includes("global_admin"), false);
});

test("tool radar cannot search, describe, or call ungranted catalog entries", () => {
  const { registry, controller } = registryWithCatalog("on");
  const plan = registry.modelToolPlan({ context: alphaContext });

  assert.ok(plan.omittedNames.includes("mcp_alpha_read"));
  assert.ok(plan.omittedNames.includes("skill_alpha_run"));
  assert.equal(plan.omittedNames.includes("mcp_beta_read"), false);
  assert.equal(plan.omittedNames.includes("skill_beta_run"), false);

  assert.deepEqual(
    controller.search("beta", { context: alphaContext }).items,
    []
  );
  assert.deepEqual(
    controller.search("global administration", { context: alphaContext }).items,
    []
  );
  assert.throws(
    () => controller.describe("mcp_beta_read", { context: alphaContext }),
    /unknown or unavailable/i
  );
  assert.match(
    controller.resolveCall("skill_beta_run", {}, { context: alphaContext }).error,
    /eligible omitted tool/i
  );
  assert.equal(
    controller.describe("mcp_alpha_read", { context: alphaContext }).name,
    "mcp_alpha_read"
  );
});

test("wildcard project grants retain the complete catalog", () => {
  const { registry } = registryWithCatalog("off");
  const names = registry.toOpenAIToolPlan({
    context: {
      __projectMcpGrants: ["*"],
      __projectActiveSkills: ["*"]
    }
  }).tools.map((tool) => tool.name);

  assert.ok(names.includes("mcp_alpha_read"));
  assert.ok(names.includes("mcp_beta_read"));
  assert.ok(names.includes("skill_alpha_run"));
  assert.ok(names.includes("skill_beta_run"));
});

test("nondefault project catalogs fail closed when grant arrays are omitted", () => {
  const scoped = {
    __projectId: "alpha",
    __projectRevision: 7
  };
  const { registry, controller } = registryWithCatalog("off");
  const directNames = registry.toOpenAIToolPlan({ context: scoped })
    .tools.map((tool) => tool.name);

  assert.ok(directNames.includes("internal_status"));
  assert.equal(directNames.includes("global_admin"), false);
  assert.equal(directNames.includes("mcp_alpha_read"), false);
  assert.equal(directNames.includes("mcp_beta_read"), false);
  assert.equal(directNames.includes("skill_alpha_run"), false);
  assert.equal(directNames.includes("skill_beta_run"), false);

  assert.deepEqual(controller.search("alpha", { context: scoped }).items, []);
  assert.throws(
    () => controller.describe("mcp_alpha_read", { context: scoped }),
    /unknown or unavailable/i
  );
});

test("MCP catalog entries require both server and secret-reference grants", () => {
  const { registry, controller } = registryWithCatalog("on");
  const denied = {
    ...alphaContext,
    __projectSecretRefs: []
  };
  const allowed = {
    ...alphaContext,
    __projectSecretRefs: ["ALPHA_TOKEN"]
  };

  assert.equal(
    registry.modelToolPlan({ context: denied }).omittedNames.includes("mcp_alpha_private"),
    false
  );
  assert.throws(
    () => controller.describe("mcp_alpha_private", { context: denied }),
    /unknown or unavailable/i
  );
  assert.ok(
    registry.modelToolPlan({ context: allowed }).omittedNames.includes("mcp_alpha_private")
  );
  assert.equal(
    controller.describe("mcp_alpha_private", { context: allowed }).name,
    "mcp_alpha_private"
  );
});

test("authoritative project state hides revoked grants and rejects stale catalog contexts", () => {
  const { registry, controller } = registryWithCatalog("on");
  registry.bindProjects({
    authorize(projectId) {
      assert.equal(projectId, "alpha");
      return {
        id: "alpha",
        status: "active",
        revision: 4,
        mcpGrants: [],
        activeSkills: [],
        secretRefs: []
      };
    }
  });
  const staleContext = {
    __projectId: "alpha",
    __projectRevision: 3,
    __projectMcpGrants: ["*"],
    __projectActiveSkills: ["*"]
  };
  const revokedContext = {
    ...staleContext,
    __projectRevision: 4
  };

  for (const context of [staleContext, revokedContext]) {
    const names = registry.modelToolPlan({ context })
      .tools.map((tool) => tool.name);
    assert.equal(names.includes("mcp_alpha_read"), false);
    assert.equal(names.includes("skill_alpha_run"), false);
    assert.deepEqual(controller.search("alpha", { context }).items, []);
    assert.match(
      controller.resolveCall("mcp_alpha_read", {}, { context }).error,
      /eligible omitted tool/i
    );
  }
});

test("default and unscoped legacy catalogs keep missing-grant compatibility", () => {
  const { registry } = registryWithCatalog("off");
  for (const context of [{}, { __projectId: "default", __projectRevision: 2 }]) {
    const names = registry.toOpenAIToolPlan({ context })
      .tools.map((tool) => tool.name);
    assert.ok(names.includes("mcp_alpha_read"));
    assert.ok(names.includes("mcp_beta_read"));
    assert.ok(names.includes("skill_alpha_run"));
    assert.ok(names.includes("skill_beta_run"));
  }
});

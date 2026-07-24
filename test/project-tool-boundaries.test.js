import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvePendingAction,
  PendingActionStore
} from "../src/pending-actions.js";
import { ProjectStore } from "../src/project-store.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function projectStore(overrides = {}) {
  const project = {
    id: "alpha",
    status: "active",
    revision: 3,
    mcpGrants: ["github"],
    activeSkills: ["triage"],
    ...overrides
  };
  return {
    get(id) {
      return id === project.id ? { ...project } : null;
    }
  };
}

function projectContext(overrides = {}) {
  return {
    __projectId: "alpha",
    __projectRevision: 3,
    ...overrides
  };
}

test("direct MCP and skill tools enforce current stored project grants", async () => {
  const calls = [];
  const registry = new ToolRegistry({ projects: projectStore() });
  registry.register({
    name: "mcp_github_list",
    source: "mcp",
    sideEffects: false,
    metadata: { server: "github", originalName: "list" },
    handler: async () => calls.push("github")
  });
  registry.register({
    name: "mcp_stripe_list",
    source: "mcp",
    sideEffects: false,
    metadata: { server: "stripe", originalName: "list" },
    handler: async () => calls.push("stripe")
  });
  registry.register({
    name: "skill_triage",
    source: "skill",
    sideEffects: false,
    metadata: { skill: "triage" },
    handler: async () => calls.push("triage")
  });
  registry.register({
    name: "skill_release",
    source: "skill",
    sideEffects: false,
    metadata: { skill: "release" },
    handler: async () => calls.push("release")
  });

  const forgedWildcard = projectContext({
    __projectMcpGrants: ["*"],
    __projectActiveSkills: ["*"]
  });
  assert.equal((await registry.invoke("mcp_github_list", {}, forgedWildcard)).ok, true);
  assert.equal((await registry.invoke("skill_triage", {}, forgedWildcard)).ok, true);

  const deniedMcp = await registry.invoke("mcp_stripe_list", {}, forgedWildcard);
  assert.equal(deniedMcp.ok, false);
  assert.equal(deniedMcp.code, "project_capability_denied");
  assert.match(deniedMcp.error, /MCP server 'stripe' is not granted/);

  const deniedSkill = await registry.invoke("skill_release", {}, forgedWildcard);
  assert.equal(deniedSkill.ok, false);
  assert.equal(deniedSkill.code, "project_capability_denied");
  assert.match(deniedSkill.error, /Skill 'release' is not active/);
  assert.deepEqual(calls, ["github", "triage"]);
});

test("project authorization canonicalizes memory scope and rejects foreign sessions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore({
    dataDir: path.join(root, "data"),
    defaultWorkspaceRoot: path.join(root, "default-workspace")
  });
  const alpha = projects.create({
    id: "alpha",
    name: "Alpha",
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  });
  projects.create({
    id: "beta",
    name: "Beta",
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  });
  projects.resolveForSession("alpha-session", {
    requestedProjectId: "alpha"
  });
  projects.resolveForSession("beta-session", {
    requestedProjectId: "beta"
  });

  const calls = [];
  const registry = new ToolRegistry({ projects });
  registry.register({
    name: "inspect_memory_scope",
    sideEffects: false,
    handler: async (_args, context) => {
      calls.push(context.__memoryScope);
      return {
        projectId: context.__projectId,
        memoryScope: context.__memoryScope,
        sessionId: context.sessionId
      };
    }
  });

  const forgedScope = await registry.invoke("inspect_memory_scope", {}, {
    __projectId: "alpha",
    __projectRevision: alpha.revision,
    __memoryScope: "project:beta",
    sessionId: "alpha-session"
  });
  assert.equal(forgedScope.ok, true);
  assert.equal(forgedScope.result.memoryScope, "project:alpha");

  const foreignSession = await registry.invoke("inspect_memory_scope", {}, {
    __projectId: "alpha",
    __projectRevision: alpha.revision,
    __memoryScope: "project:alpha",
    sessionId: "beta-session"
  });
  assert.equal(foreignSession.ok, false);
  assert.equal(foreignSession.code, "project_scope_invalid");
  assert.match(foreignSession.error, /outside project 'alpha'/u);
  assert.deepEqual(calls, ["project:alpha"]);
});

test("authorization refreshes cross-process revocations before invocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-revoke-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    dataDir: path.join(root, "data"),
    defaultWorkspaceRoot: path.join(root, "default-workspace")
  };
  const first = new ProjectStore(options);
  const alpha = first.create({
    id: "alpha",
    name: "Alpha",
    mcpGrants: ["github"],
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  });
  first.resolveForSession("alpha-session", {
    requestedProjectId: "alpha"
  });
  const second = new ProjectStore(options);
  const updated = second.update("alpha", { mcpGrants: [] }, {
    expectedRevision: alpha.revision
  });
  assert.equal(first.get("alpha").revision, alpha.revision);

  let calls = 0;
  const registry = new ToolRegistry({ projects: first });
  registry.register({
    name: "mcp_github_read",
    source: "mcp",
    sideEffects: false,
    metadata: { server: "github", originalName: "read" },
    handler: async () => {
      calls += 1;
      return "ok";
    }
  });
  const denied = await registry.invoke("mcp_github_read", {}, {
    __projectId: "alpha",
    __projectRevision: updated.revision,
    __projectMcpGrants: ["github"],
    sessionId: "alpha-session"
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "project_capability_denied");
  assert.match(denied.error, /not granted/u);
  assert.equal(calls, 0);
  assert.equal(first.get("alpha").revision, updated.revision);
});

test("MCP credentials require an independent current project secret grant", async () => {
  const calls = [];
  const registry = new ToolRegistry({
    projects: projectStore({
      mcpGrants: ["github"],
      secretRefs: []
    })
  });
  registry.register({
    name: "mcp_github_private",
    source: "mcp",
    sideEffects: false,
    metadata: {
      server: "github",
      originalName: "private",
      requiredSecretRefs: ["GITHUB_TOKEN"]
    },
    handler: async () => calls.push("private")
  });

  const denied = await registry.invoke(
    "mcp_github_private",
    {},
    projectContext({
      __projectMcpGrants: ["*"],
      __projectSecretRefs: ["*"]
    })
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "project_capability_denied");
  assert.match(denied.error, /GITHUB_TOKEN/u);

  registry.bindProjects(projectStore({
    mcpGrants: ["github"],
    secretRefs: ["GITHUB_TOKEN"]
  }));
  const allowed = await registry.invoke(
    "mcp_github_private",
    {},
    projectContext({ __projectSecretRefs: [] })
  );
  assert.equal(allowed.ok, true);
  assert.deepEqual(calls, ["private"]);
});

test("project validation rejects unknown, archived, and stale scopes before hooks", async () => {
  let hookCalls = 0;
  const activeProjects = projectStore();
  const registry = new ToolRegistry({
    projects: activeProjects,
    hooks: {
      beforeToolCall: async () => {
        hookCalls += 1;
        return { action: "allow" };
      }
    }
  });
  registry.register({
    name: "read_status",
    sideEffects: false,
    handler: async () => "ok"
  });

  const stale = await registry.invoke("read_status", {}, projectContext({ __projectRevision: 2 }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "project_scope_invalid");
  assert.match(stale.error, /revision 2 is stale/);

  const missing = await registry.invoke("read_status", {}, {
    __projectId: "missing",
    __projectRevision: 1
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);

  registry.bindProjects(projectStore({ status: "archived" }));
  const archived = await registry.invoke("read_status", {}, projectContext());
  assert.equal(archived.ok, false);
  assert.match(archived.error, /is archived/);
  assert.equal(hookCalls, 0);
});

test("missing project context and wildcard default grants remain compatible", async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "mcp_anything_read",
    source: "mcp",
    sideEffects: false,
    metadata: { server: "anything", originalName: "read" },
    handler: async () => {
      calls += 1;
      return "ok";
    }
  });

  assert.equal((await registry.invoke("mcp_anything_read", {})).ok, true);
  assert.equal((await registry.invoke("mcp_anything_read", {}, {
    __projectMcpGrants: ["*"]
  })).ok, true);

  registry.bindProjects(projectStore({
    id: "default",
    revision: 1,
    mcpGrants: ["*"],
    activeSkills: ["*"]
  }));
  assert.equal((await registry.invoke("mcp_anything_read", {}, {
    __projectId: "default",
    __projectRevision: 1
  })).ok, true);
  assert.equal(calls, 3);
});

test("MCP and core skill bridges filter discovery and reject ungranted dispatch", async () => {
  const mcpCalls = [];
  const skillCalls = [];
  const projects = projectStore();
  const runtime = {
    projects,
    mcp: {
      listTools: () => [
        {
          server: "github",
          name: "list_issues",
          registeredName: "mcp_github_list_issues",
          description: "List repository issues"
        },
        {
          server: "stripe",
          name: "list_invoices",
          registeredName: "mcp_stripe_list_invoices",
          description: "List customer invoices"
        }
      ],
      callTool: async (server, name) => {
        mcpCalls.push(`${server}:${name}`);
        return { server, name };
      }
    },
    skills: {
      list: () => [
        { name: "triage", description: "Triage issues" },
        { name: "release", description: "Release software" }
      ],
      run: async (name) => {
        skillCalls.push(name);
        return { name };
      }
    }
  };
  const registry = new ToolRegistry({ projects });
  registerCoreTools(registry, runtime);
  const context = projectContext({
    __projectMcpGrants: ["*"],
    __projectActiveSkills: ["*"]
  });

  const mcpList = await registry.invoke("list_mcp_tools", {}, context);
  assert.equal(mcpList.ok, true);
  assert.deepEqual(mcpList.result.items.map((item) => item.server), ["github"]);

  const hiddenSearch = await registry.invoke(
    "searcmcp_tools",
    { query: "customer invoice" },
    context
  );
  assert.deepEqual(hiddenSearch.result.items, []);

  const deniedMcp = await registry.invoke(
    "run_mcp_tool",
    { server: "stripe", tool: "list_invoices" },
    context
  );
  assert.equal(deniedMcp.ok, false);
  assert.match(deniedMcp.error, /not granted/);

  const allowedMcp = await registry.invoke(
    "run_mcp_tool",
    { server: "github", tool: "list_issues" },
    context
  );
  assert.equal(allowedMcp.ok, true);
  assert.deepEqual(mcpCalls, ["github:list_issues"]);

  const skillList = await registry.invoke("list_skills", {}, context);
  assert.deepEqual(skillList.result.items.map((item) => item.name), ["triage"]);

  const deniedSkill = await registry.invoke("run_skill", { name: "release" }, context);
  assert.equal(deniedSkill.ok, false);
  assert.match(deniedSkill.error, /not granted/);

  const allowedSkill = await registry.invoke("run_skill", { name: "triage" }, context);
  assert.equal(allowedSkill.ok, true);
  assert.deepEqual(skillCalls, ["triage"]);
});

test("approval identity changes with project revision and grant set", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "mutate",
    handler: async () => true
  });
  const base = {
    __projectId: "alpha",
    __projectRevision: 3,
    __projectMcpGrants: ["github"],
    __projectActiveSkills: ["triage"]
  };
  const first = registry.approvalIdentity("mutate", base);
  const reordered = registry.approvalIdentity("mutate", {
    ...base,
    __projectMcpGrants: ["github", "github"]
  });
  const revised = registry.approvalIdentity("mutate", {
    ...base,
    __projectRevision: 4
  });
  const expanded = registry.approvalIdentity("mutate", {
    ...base,
    __projectMcpGrants: ["stripe", "github"]
  });

  assert.equal(first, reordered);
  assert.notEqual(first, revised);
  assert.notEqual(first, expanded);
});

test("session tools exclude foreign, archived, and invalid project bindings", async () => {
  const projects = {
    get(id) {
      return id === "alpha"
        ? {
            id: "alpha",
            status: "active",
            revision: 3,
            policy: { toolPolicy: "full", allowedTools: ["*"] },
            mcpGrants: [],
            activeSkills: [],
            secretRefs: [],
            hookIds: [],
            workspaceRoot: "/workspace/alpha",
            kanbanBoardId: "project-alpha"
          }
        : null;
    },
    projectForSession(sessionId) {
      if (sessionId === "session-alpha") return { id: "alpha" };
      if (sessionId === "session-beta") return { id: "beta" };
      if (sessionId === "session-archived") throw new Error("project is archived");
      throw new TypeError("invalid session binding");
    }
  };
  const rows = [
    { sessionId: "session-alpha", ts: "2026-07-24T12:00:00.000Z", role: "user", snippet: "alpha" },
    { sessionId: "session-beta", ts: "2026-07-24T12:01:00.000Z", role: "user", snippet: "beta" },
    { sessionId: "session-archived", ts: "2026-07-24T12:02:00.000Z", role: "user", snippet: "archived" },
    { sessionId: "../hostile", ts: "2026-07-24T12:03:00.000Z", role: "user", snippet: "hostile" }
  ];
  const runtime = {
    projects,
    agentHost: {
      store: {
        listSessions: () => rows.map(({ sessionId }) => ({ id: sessionId }))
      }
    },
    sessionIndex: {
      search: async () => rows
    }
  };
  const registry = new ToolRegistry({ projects });
  registerCoreTools(registry, runtime);
  const context = projectContext();

  const listed = await registry.invoke("list_sessions", { limit: 20 }, context);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.map((session) => session.id), ["session-alpha"]);

  const searched = await registry.invoke(
    "search_sessions",
    { query: "fixture", limit: 20 },
    context
  );
  assert.equal(searched.ok, true);
  assert.deepEqual(
    searched.result.results.map((result) => result.sessionId),
    ["session-alpha"]
  );

  const archived = await registry.invoke(
    "search_sessions",
    { query: "fixture", sessionId: "session-archived" },
    context
  );
  assert.equal(archived.ok, false);
  assert.match(archived.error, /outside the current project/u);
});

test("cron tools expose and mutate only current project schedules", async () => {
  const detached = [];
  const removed = [];
  const enabled = [];
  const jobs = [
    { id: "default-job", name: "Default", input: {} },
    { id: "alpha-cancel", name: "Alpha cancel", input: { projectId: "alpha" } },
    { id: "alpha-toggle", name: "Alpha toggle", input: { projectId: "alpha" } },
    { id: "alpha-orphan", name: "Alpha orphan", input: { projectId: "alpha" } },
    { id: "beta-job", name: "Beta", input: { projectId: "beta" } }
  ];
  const project = {
    id: "alpha",
    status: "active",
    revision: 3,
    scheduleIds: ["alpha-cancel", "alpha-toggle"],
    mcpGrants: [],
    activeSkills: []
  };
  const projects = {
    get(id) {
      return id === project.id ? structuredClone(project) : null;
    },
    detachResource(projectId, field, resourceId) {
      detached.push({ field, projectId, resourceId });
      project.scheduleIds = project.scheduleIds.filter((id) => id !== resourceId);
      return structuredClone(project);
    }
  };
  const cron = {
    listJobs: () => jobs.filter((job) => !removed.includes(job.id)),
    removeJob(id) {
      removed.push(id);
      return true;
    },
    enableJob(id, value) {
      enabled.push({ id, value });
      return { ...jobs.find((job) => job.id === id), enabled: value, nextRunAt: "later" };
    }
  };
  const registry = new ToolRegistry({ projects });
  registerCoreTools(registry, { projects, cron });
  const context = projectContext();

  const listed = await registry.invoke("list_cron_jobs", {}, context);
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.result.map((job) => job.id).sort(),
    ["alpha-cancel", "alpha-toggle"]
  );

  const foreignCancel = await registry.invoke(
    "cancel_cron_job",
    { id: "beta-job" },
    context
  );
  assert.equal(foreignCancel.result.removed, false);
  assert.deepEqual(removed, []);

  const orphanToggle = await registry.invoke(
    "set_cron_job_enabled",
    { id: "alpha-orphan", enabled: false },
    context
  );
  assert.equal(orphanToggle.result.ok, false);
  assert.deepEqual(enabled, []);

  const toggled = await registry.invoke(
    "set_cron_job_enabled",
    { id: "alpha-toggle", enabled: false },
    context
  );
  assert.equal(toggled.result.ok, true);
  assert.deepEqual(enabled, [{ id: "alpha-toggle", value: false }]);

  const cancelled = await registry.invoke(
    "cancel_cron_job",
    { id: "alpha-cancel" },
    context
  );
  assert.equal(cancelled.result.removed, true);
  assert.deepEqual(detached, [{
    field: "scheduleIds",
    projectId: "alpha",
    resourceId: "alpha-cancel"
  }]);
  assert.deepEqual(removed, ["alpha-cancel"]);

  const defaultList = await registry.invoke("list_cron_jobs", {});
  assert.deepEqual(defaultList.result.map((job) => job.id), ["default-job"]);
});

test("durable approvals fail closed after project policy or revision changes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let current = {
    id: "alpha",
    status: "active",
    revision: 3,
    workspaceRoot: "/workspace/alpha",
    kanbanBoardId: "project-alpha",
    policy: { allowedTools: ["mutate"] },
    mcpGrants: ["github"],
    activeSkills: ["triage"],
    secretRefs: ["ALPHA_TOKEN"],
    hookIds: ["audit"]
  };
  const projects = {
    get(id) {
      return id === current.id ? structuredClone(current) : null;
    }
  };
  let calls = 0;
  const tools = new ToolRegistry({ projects });
  tools.register({
    name: "mutate",
    needsConfirmation: true,
    handler: async () => {
      calls += 1;
      return { changed: true };
    }
  });
  const pendingActions = new PendingActionStore({ dir });
  tools.bindPendingActions(pendingActions);
  const context = {
    __projectId: "alpha",
    __projectRevision: 3,
    __projectWorkspaceDir: current.workspaceRoot,
    __projectKanbanBoardId: current.kanbanBoardId,
    __projectMcpGrants: current.mcpGrants,
    __projectActiveSkills: current.activeSkills,
    __projectSecretRefs: current.secretRefs,
    __projectHookIds: current.hookIds
  };
  const action = pendingActions.enqueue({
    toolName: "mutate",
    args: {},
    context,
    summary: "mutate alpha",
    approvalIdentity: tools.approvalIdentity("mutate", context)
  });

  current = {
    ...current,
    revision: 4,
    secretRefs: []
  };
  const result = await approvePendingAction(
    { pendingActions, tools },
    action.id,
    { decidedBy: "test" }
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.outcome.code, "approval_identity_changed");
  assert.equal(calls, 0);
  assert.equal(pendingActions.get(action.id).status, "denied");
});

function controlPlaneFixture() {
  const projectsById = new Map([
    ["default", {
      id: "default",
      name: "Default",
      status: "active",
      revision: 1,
      workspaceRoot: "/workspace/default",
      policy: { toolPolicy: "full", allowedTools: ["*"] },
      mcpGrants: ["*"],
      activeSkills: ["*"],
      secretRefs: ["*"],
      hookIds: ["*"],
      kanbanBoardId: "default",
      modelProfile: {},
      routingProfile: {}
    }],
    ["alpha", {
      id: "alpha",
      name: "Alpha",
      status: "active",
      revision: 1,
      workspaceRoot: "/workspace/alpha",
      policy: { toolPolicy: "full", allowedTools: ["*"] },
      mcpGrants: [],
      activeSkills: [],
      secretRefs: [],
      hookIds: [],
      kanbanBoardId: "project-alpha",
      modelProfile: {},
      routingProfile: {}
    }],
    ["beta", {
      id: "beta",
      name: "Beta",
      status: "active",
      revision: 2,
      workspaceRoot: "/workspace/beta",
      policy: { toolPolicy: "full", allowedTools: ["*"] },
      mcpGrants: ["github"],
      activeSkills: ["triage"],
      secretRefs: ["BETA_TOKEN"],
      hookIds: [],
      kanbanBoardId: "project-beta",
      modelProfile: {},
      routingProfile: {}
    }]
  ]);
  const projectMutations = [];
  const mcpMutations = [];
  const observationSearches = [];
  const projects = {
    get(id, { includeArchived = true } = {}) {
      const project = projectsById.get(String(id).toLowerCase()) ?? null;
      if (!includeArchived && project?.status !== "active") return null;
      return project ? structuredClone(project) : null;
    },
    list({ includeArchived = false } = {}) {
      return [...projectsById.values()]
        .filter((project) => includeArchived || project.status === "active")
        .map((project) => structuredClone(project));
    },
    create(args) {
      projectMutations.push(["create", args.name]);
      return { id: "created", ...args };
    },
    select(id) {
      projectMutations.push(["select", id]);
      return this.get(id);
    },
    update(id, patch) {
      projectMutations.push(["update", id, patch]);
      return { ...this.get(id), ...patch };
    },
    archive(id) {
      projectMutations.push(["archive", id]);
      return { ...this.get(id), status: "archived" };
    }
  };
  const runtime = {
    projects,
    observations: {
      async search(args) {
        observationSearches.push(structuredClone(args));
        return [{ at: "2026-07-24T12:00:00.000Z", app: "Editor" }];
      }
    },
    mcp: {
      registerServer(spec) {
        mcpMutations.push(["register", spec.name]);
        return { ...spec, name: spec.name, transport: spec.transport ?? "http" };
      },
      async connect(name) {
        mcpMutations.push(["connect", name]);
        return true;
      },
      async disconnect(name) {
        mcpMutations.push(["disconnect", name]);
        return true;
      },
      allowEnvKey(name) {
        mcpMutations.push(["allow-env", name]);
      }
    }
  };
  const registry = new ToolRegistry({ projects });
  registerCoreTools(registry, runtime);
  return {
    registry,
    runtime,
    projectMutations,
    mcpMutations,
    observationSearches
  };
}

function controlContext(projectId, revision = 1) {
  return {
    __projectId: projectId,
    __projectRevision: revision,
    __confirmed: true,
    sessionId: `session-${projectId}`
  };
}

test("nondefault projects inspect only self and cannot escalate project or MCP control", async () => {
  const {
    registry,
    runtime,
    projectMutations,
    mcpMutations
  } = controlPlaneFixture();
  const alpha = controlContext("alpha");

  const listed = await registry.invoke("project_list", {}, alpha);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.projects.map((project) => project.id), ["alpha"]);
  assert.equal((await registry.invoke(
    "project_show",
    { projectId: "alpha" },
    alpha
  )).ok, true);

  const deniedReads = [
    ["project_show", { projectId: "beta" }]
  ];
  const deniedProjectMutations = [
    ["project_create", { name: "Escalated", policy: { allowedTools: ["*"] } }],
    ["project_select", { projectId: "beta" }],
    ["project_update", {
      projectId: "alpha",
      expectedRevision: 1,
      patch: {
        policy: { toolPolicy: "full", allowedTools: ["*"] },
        secretRefs: ["*"],
        mcpGrants: ["*"]
      }
    }],
    ["project_archive", { projectId: "beta", expectedRevision: 2 }]
  ];
  const deniedMcpMutations = [
    ["register_mcp_server", {
      name: "alpha-global",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      auth: "none"
    }],
    ["connect_mcp_server", { name: "github" }],
    ["disconnect_mcp_server", { name: "github" }],
    ["connect_catalog_mcp", { catalogId: "linear" }]
  ];
  const deniedGlobalControls = [
    ["set_provider", { preference: "auto" }],
    ["recall_activity", { query: "private activity" }],
    ["recall_spend", {}],
    ["get_audit", {}],
    ["get_budget", {}],
    ["add_task", { title: "cross-project task" }],
    ["list_tasks", {}],
    ["complete_task", { id: "task-1" }],
    ["move_task", { id: "task-1", status: "cancelled" }],
    ["add_goal", { title: "cross-project goal" }],
    ["list_goals", {}],
    ["link_task_to_goal", { taskId: "task-1", goalId: "goal-1" }],
    ["agent_pick_next", {}],
    ["daily_recap", {}],
    ["daily_plan", {}],
    ["list_mcp_catalog", {}],
    ["restart_daemon", { reason: "cross-project restart" }],
    ["retire_specialist", { id: "specialist-1" }]
  ];

  for (const [name, args] of [
    ...deniedReads,
    ...deniedProjectMutations,
    ...deniedMcpMutations,
    ...deniedGlobalControls
  ]) {
    const result = await registry.invoke(name, args, alpha);
    assert.equal(result.ok, false, `${name} must be denied`);
    assert.match(result.error, /current project|default project control plane/u);
  }
  assert.deepEqual(projectMutations, []);
  assert.deepEqual(mcpMutations, []);

  for (const [name, args] of [
    ...deniedMcpMutations,
    ...deniedGlobalControls
  ]) {
    await assert.rejects(
      registry.get(name).handler(args, alpha),
      /default project control plane/u,
      `${name} handler must defend against direct alias dispatch`
    );
  }
  assert.deepEqual(mcpMutations, []);
  assert.ok(runtime.projects.get("beta"), "cross-project denial must not mutate the target");
});

test("default project control plane retains project and global MCP administration", async () => {
  const {
    registry,
    projectMutations,
    mcpMutations,
    observationSearches
  } = controlPlaneFixture();
  const context = controlContext("default");

  const listed = await registry.invoke("project_list", {}, context);
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.result.projects.map((project) => project.id).sort(),
    ["alpha", "beta", "default"]
  );
  assert.equal((await registry.invoke(
    "project_show",
    { projectId: "beta" },
    context
  )).ok, true);

  for (const [name, args] of [
    ["project_create", { name: "Created" }],
    ["project_select", { projectId: "beta" }],
    ["project_update", {
      projectId: "beta",
      expectedRevision: 2,
      patch: { instructions: "Updated by the control plane." }
    }],
    ["project_archive", { projectId: "beta", expectedRevision: 2 }],
    ["register_mcp_server", {
      name: "manual",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      auth: "none"
    }],
    ["connect_mcp_server", { name: "manual" }],
    ["disconnect_mcp_server", { name: "manual" }],
    ["connect_catalog_mcp", { catalogId: "linear" }]
  ]) {
    const result = await registry.invoke(name, args, context);
    assert.equal(result.ok, true, `${name} must remain available to default`);
  }

  assert.deepEqual(
    projectMutations.map(([operation]) => operation),
    ["create", "select", "update", "archive"]
  );
  assert.deepEqual(mcpMutations, [
    ["register", "manual"],
    ["connect", "manual"],
    ["disconnect", "manual"],
    ["register", "linear"],
    ["connect", "linear"]
  ]);

  assert.doesNotThrow(() => (
    registry.get("set_provider").preflight({ preference: "auto" }, context)
  ));
  const activity = await registry.invoke(
    "recall_activity",
    { query: "editor", limit: 5 },
    context
  );
  assert.equal(activity.ok, true);
  assert.equal(activity.result.count, 1);
  assert.deepEqual(observationSearches, [{
    query: "editor",
    since: null,
    until: null,
    app: null,
    machine: null,
    limit: 5
  }]);
});

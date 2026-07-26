import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost, prepareTurnHints } from "../src/agent-host.js";
import { CapabilityProfileStore } from "../src/capability-profile-store.js";
import { ProjectStore } from "../src/project-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeHarness(options = {}) {
  const requests = [];
  const toolPlanContexts = [];
  const store = new InMemoryAgentStore();
  const tools = new ToolRegistry();
  if (options.captureToolPlanContexts) {
    const originalPlan = tools.toOpenAIToolPlan.bind(tools);
    tools.toOpenAIToolPlan = (planOptions = {}) => {
      toolPlanContexts.push(structuredClone(planOptions.context ?? {}));
      return originalPlan(planOptions);
    };
  }
  const runtime = {
    tools,
    memory: {
      retrieve: () => [],
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory_provider_request" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_provider_request",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["provider request fixture"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  if (options.projects) runtime.projects = options.projects;
  if (options.profiles) runtime.profiles = options.profiles;
  if (options.observations) runtime.observations = options.observations;
  if (options.tasks) runtime.tasks = options.tasks;
  const modelProvider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate(request) {
      const sequence = requests.length + 1;
      requests.push({
        input: request.input,
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        images: request.images.map((image) => ({ ...image })),
        requestShape: { ...request.context.__requestShape },
        instructions: request.instructions,
        model: request.model ?? null,
        tier: request.tier ?? null,
        task: request.task ?? null,
        completionContract: request.context.__completionContract ?? null,
        toolNames: request.tools.map((tool) => tool.name),
        memoryScope: request.context.__memoryScope ?? null,
        turnContext: request.turnContext,
        projectId: request.context.__projectId ?? null,
        projectModelProfile: request.context.__projectModelProfile ?? null,
        projectRoutingProfile: request.context.__projectRoutingProfile ?? null,
        capabilityProfile:
          request.context.__capabilityProfileResolution ?? null
      });
      return {
        provider: "fixture",
        model: "fixture-model",
        id: `response_provider_request_${sequence}`,
        usage: {
          input_tokens: 100 + sequence,
          output_tokens: 20 + sequence,
          input_tokens_details: { cached_tokens: 10 }
        },
        text: `Fixture reply ${sequence}.`,
        toolCalls: [],
        iterations: 1,
        maxIterations: request.maxIterations,
        stopReason: "completed"
      };
    }
  };
  Object.assign(modelProvider, options.modelProviderProperties ?? {});
  const host = new AgentHost({
    runtime,
    store,
    modelProvider,
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {})
  });
  return { host, requests, store, toolPlanContexts };
}

function durableMessages(store, sessionId) {
  return store.getSession(sessionId).messages.map(({ role, content }) => ({ role, content }));
}

function projectFixture(id = "release", overrides = {}) {
  return {
    id,
    name: id === "default" ? "Default" : "Release",
    status: "active",
    revision: 4,
    workspaceRoot: process.cwd(),
    instructions: "",
    policy: { toolPolicy: "full", allowedTools: ["*"] },
    secretRefs: [],
    activeSkills: [],
    mcpGrants: [],
    hookIds: [],
    kanbanBoardId: id === "default" ? "default" : `project-${id}`,
    modelProfile: {},
    routingProfile: {},
    ...overrides
  };
}

function projectResolver(project) {
  return {
    hasSessionBinding: () => false,
    resolveForSession: (_sessionId, options) => {
      assert.equal(options.requestedProjectId, project.id);
      return structuredClone(project);
    }
  };
}

function durableProjectStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-host-project-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ProjectStore({
    dataDir: path.join(root, "data"),
    defaultWorkspaceRoot: path.join(root, "default-workspace")
  });
}

test("turn hint preparation overlaps independent principle and ambient reads", async () => {
  let started = 0;
  let release;
  const rendezvous = new Promise((resolve) => {
    release = resolve;
  });
  const begin = async (value) => {
    started += 1;
    if (started === 2) release();
    await rendezvous;
    return value;
  };
  const principle = {
    id: "principle-fast-path",
    scope: "main",
    metadata: {}
  };
  const runtime = {
    memory: { items: new Map([[principle.id, principle]]) },
    vectorStore: {
      search: () => begin([{ id: principle.id, score: 0.9 }])
    },
    observations: {
      getRecentContext: () => begin({
        apps: [{ app: "editor", n: 1 }],
        snippets: []
      })
    }
  };

  const result = await prepareTurnHints({
    runtime,
    text: "inspect the current work",
    projectId: "default",
    channel: "discord",
    memoryScope: "main"
  });

  assert.equal(started, 2);
  assert.deepEqual(result.intuitions, [{ id: principle.id, score: 0.9 }]);
  assert.deepEqual(result.ambientContext.apps, [{ app: "editor", n: 1 }]);
});

test("AgentHost attaches bounded completion contracts only to actionable work", async () => {
  const actionable = makeHarness();
  await actionable.host.handleMessage({
    channel: "discord",
    from: "user-completion",
    sessionId: "completion-actionable",
    text: "Implement a new API endpoint.",
    backgroundReview: false
  });
  assert.deepEqual(actionable.requests[0].completionContract, {
    version: 1,
    kind: "code-change",
    requirements: ["mutation", "verification"],
    maxNudges: 1
  });

  const explanatory = makeHarness();
  await explanatory.host.handleMessage({
    channel: "discord",
    from: "user-completion",
    sessionId: "completion-explanation",
    text: "Explain how the API endpoint works.",
    backgroundReview: false
  });
  assert.equal(explanatory.requests[0].completionContract, null);
});

test("AgentHost keeps user-global auto tasks in the default project", async () => {
  const added = [];
  const tasks = {
    add(input) {
      added.push(structuredClone(input));
      return { id: "task-1", ...input };
    }
  };
  const release = projectFixture("release");
  const { host } = makeHarness({
    projects: projectResolver(release),
    tasks
  });

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "provider-request-project-task-boundary",
    projectId: "release",
    text: "remind me to publish the release notes tomorrow",
    backgroundReview: false
  });

  assert.deepEqual(added, []);
});

test("AgentHost repairs a lost binding from the unique durable transcript project tag", async (t) => {
  const projects = durableProjectStore(t);
  const alpha = projects.create({ id: "alpha", name: "Alpha" });
  const { host, requests, store } = makeHarness({ projects });
  const sessionId = "lost-alpha-project-binding";
  await store.appendMessage(sessionId, {
    role: "user",
    content: "Persisted alpha history.",
    metadata: { projectId: alpha.id }
  });
  await store.appendMessage(sessionId, {
    role: "assistant",
    content: "Persisted alpha reply.",
    metadata: { projectId: alpha.id }
  });
  assert.equal(projects.hasSessionBinding(sessionId), false);

  const result = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Continue in the original project.",
    backgroundReview: false
  });

  assert.equal(result.project.id, "alpha");
  assert.equal(requests[0].projectId, "alpha");
  assert.equal(projects.hasSessionBinding(sessionId), true);
  assert.equal(projects.projectForSession(sessionId).id, "alpha");
});

test("AgentHost rejects conflicting or mixed durable transcript project tags", async (t) => {
  const projects = durableProjectStore(t);
  projects.create({ id: "alpha", name: "Alpha" });
  projects.create({ id: "beta", name: "Beta" });
  const { host, requests, store } = makeHarness({ projects });

  await store.appendMessage("conflicting-project-request", {
    role: "user",
    content: "Alpha only.",
    metadata: { projectId: "alpha" }
  });
  await assert.rejects(
    host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "conflicting-project-request",
      projectId: "beta",
      text: "Try to move this transcript.",
      backgroundReview: false
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_BOUNDARY_VIOLATION");
      assert.match(error.message, /transcript belongs to project 'alpha'/u);
      return true;
    }
  );

  await store.appendMessage("mixed-project-tags", {
    role: "user",
    content: "Alpha message.",
    metadata: { projectId: "alpha" }
  });
  await store.appendMessage("mixed-project-tags", {
    role: "assistant",
    content: "Unexpected beta message.",
    metadata: { projectId: "beta" }
  });
  await assert.rejects(
    host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "mixed-project-tags",
      text: "Do not choose either project.",
      backgroundReview: false
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_BOUNDARY_VIOLATION");
      assert.match(error.message, /mixed persisted project tags/u);
      assert.deepEqual(error.projectIds, ["alpha", "beta"]);
      return true;
    }
  );

  assert.equal(projects.hasSessionBinding("conflicting-project-request"), false);
  assert.equal(projects.hasSessionBinding("mixed-project-tags"), false);
  assert.equal(requests.length, 0);
});

test("AgentHost rejects missing, archived, and malformed transcript projects", async (t) => {
  const projects = durableProjectStore(t);
  projects.create({ id: "archived", name: "Archived" });
  projects.archive("archived");
  const { host, requests, store } = makeHarness({ projects });
  const cases = [
    ["missing-project-tag", "missing", /Unknown project: missing/u],
    ["archived-project-tag", "archived", /is archived/u],
    ["malformed-project-tag", "../escape", /invalid persisted project tag/u]
  ];

  for (const [sessionId, projectId, expected] of cases) {
    await store.appendMessage(sessionId, {
      role: "user",
      content: "Durable project history.",
      metadata: { projectId }
    });
    await assert.rejects(
      host.handleMessage({
        channel: "local",
        from: "creator",
        sessionId,
        text: "Continue this transcript.",
        backgroundReview: false
      }),
      expected
    );
    assert.equal(projects.hasSessionBinding(sessionId), false);
  }
  assert.equal(requests.length, 0);
});

test("AgentHost reserves legacy default fallback for entirely untagged transcripts", async (t) => {
  const projects = durableProjectStore(t);
  const { host, requests, store } = makeHarness({ projects });
  const sessionId = "pre-project-legacy-transcript";
  await store.appendMessage(sessionId, {
    role: "user",
    content: "History from before project tags existed."
  });

  const result = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Continue the legacy transcript.",
    backgroundReview: false
  });

  assert.equal(result.project.id, "default");
  assert.equal(requests[0].projectId, "default");
  assert.equal(projects.hasSessionBinding(sessionId), true);
  assert.equal(projects.projectForSession(sessionId).id, "default");
});

test("AgentHost sends a first turn exactly once while persisting the raw user message", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-first-turn";
  const current = "Explain canonical provider request assembly.";

  const result = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: current,
    backgroundReview: false
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, current);
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(requests[0].requestShape, {
    historyMessageCount: 0,
    historyBytes: 2,
    currentTurnCount: 1,
    currentInputBytes: Buffer.byteLength(current),
    imageCount: 0,
    instructionBytes: requests[0].requestShape.instructionBytes,
    visibleToolCount: requests[0].requestShape.visibleToolCount,
    visibleSchemaBytes: requests[0].requestShape.visibleSchemaBytes,
    deferredToolCount: requests[0].requestShape.deferredToolCount,
    deferredSchemaBytes: requests[0].requestShape.deferredSchemaBytes
  });
  assert.ok(requests[0].requestShape.instructionBytes > 0);
  assert.equal(result.model.id, "response_provider_request_1");
  assert.deepEqual(result.model.usage, {
    input_tokens: 101,
    output_tokens: 21,
    input_tokens_details: { cached_tokens: 10 }
  });
  assert.deepEqual(durableMessages(store, sessionId), [
    { role: "user", content: current },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
});

test("AgentHost sends only prior persisted messages on a later turn", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-multi-turn";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "First durable turn.",
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Second current turn.",
    backgroundReview: false
  });

  assert.deepEqual(requests[0].messages, []);
  assert.equal(requests[1].input, "Second current turn.");
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: "First durable turn." },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.equal(requests[1].requestShape.historyMessageCount, 2);
  assert.ok(requests[1].requestShape.historyBytes > requests[0].requestShape.historyBytes);
  assert.deepEqual(durableMessages(store, sessionId), [
    { role: "user", content: "First durable turn." },
    { role: "assistant", content: "Fixture reply 1." },
    { role: "user", content: "Second current turn." },
    { role: "assistant", content: "Fixture reply 2." }
  ]);
});

test("AgentHost distinguishes repeated identical text from a duplicated current turn", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-repeated-text";
  const repeated = "Run the same verification again.";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: repeated,
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: repeated,
    backgroundReview: false
  });

  assert.equal(requests[1].input, repeated);
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: repeated },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.equal(
    requests[1].messages.filter((message) => message.role === "user" && message.content === repeated).length,
    1,
    "one identical prior user turn is history; the current copy belongs only in input"
  );
  assert.equal(
    durableMessages(store, sessionId).filter(
      (message) => message.role === "user" && message.content === repeated
    ).length,
    2,
    "both real user turns remain durable"
  );
});

test("AgentHost gives an ephemeral turn one current input and no persisted history", async () => {
  const { host, requests, store } = makeHarness();
  const current = "Connectivity probe.";

  await host.handleMessage({
    channel: "local",
    from: "setup",
    sessionId: "provider-request-ephemeral",
    text: current,
    ephemeral: true,
    backgroundReview: false
  });

  assert.equal(requests[0].input, current);
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(store.listSessions(), []);
});

test("AgentHost applies the active project model and routing profile", async () => {
  const project = {
    id: "release",
    name: "Release",
    status: "active",
    revision: 4,
    workspaceRoot: process.cwd(),
    instructions: "Use the release verification checklist.",
    policy: { toolPolicy: "full", allowedTools: ["*"] },
    secretRefs: [],
    activeSkills: [],
    mcpGrants: [],
    hookIds: [],
    kanbanBoardId: "project-release",
    modelProfile: { model: "fixture-project-model" },
    routingProfile: { task: "code", tier: "mini" }
  };
  const projects = {
    hasSessionBinding: () => false,
    resolveForSession: (_sessionId, options) => {
      assert.equal(options.requestedProjectId, "release");
      return structuredClone(project);
    }
  };
  const { host, requests } = makeHarness({ projects });

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "project-provider-profile",
    projectId: "release",
    text: "Verify this release.",
    ephemeral: true,
    backgroundReview: false
  });

  assert.equal(requests[0].model, "fixture-project-model");
  assert.equal(requests[0].tier, "mini");
  assert.equal(requests[0].task, "code");
  assert.equal(requests[0].projectId, "release");
  assert.deepEqual(requests[0].projectModelProfile, project.modelProfile);
  assert.deepEqual(requests[0].projectRoutingProfile, project.routingProfile);
  assert.match(requests[0].instructions, /release verification checklist/u);
});

test("AgentHost applies named project profiles to persona, routing, skills, and tool plans", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-host-named-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  const profiles = new CapabilityProfileStore({ dataDir, projects });
  profiles.createProfile("default", {
    id: "concise-review",
    name: "Concise review",
    persona: "Use terse, evidence-linked review notes.",
    modelProfile: { model: "profile-model" },
    routingProfile: { task: "review", tier: "mini" },
    activeSkills: [],
    toolGrants: [],
    capabilityBundleIds: []
  }, { actor: "operator" });
  profiles.bindProjectProfile("default", "concise-review", {
    actor: "operator"
  });
  const { host, requests, toolPlanContexts } = makeHarness({
    projects,
    profiles,
    captureToolPlanContexts: true
  });

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "named-profile-session",
    text: "Explain the current status.",
    backgroundReview: false
  });

  assert.equal(requests[0].model, "profile-model");
  assert.equal(requests[0].task, "review");
  assert.equal(requests[0].tier, "mini");
  assert.match(requests[0].instructions, /Active capability profile: Concise review/u);
  assert.match(requests[0].instructions, /terse, evidence-linked/u);
  assert.equal(requests[0].capabilityProfile.profileId, "concise-review");
  assert.ok(toolPlanContexts.length >= 1);
  assert.ok(toolPlanContexts.every((context) => (
    context.__capabilityProfileIdentity
    === requests[0].capabilityProfile.identity
  )));
});

test("AgentHost fails closed on a nondefault project when no ProjectStore is bound", async () => {
  const { host, requests } = makeHarness();

  await assert.rejects(
    host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "missing-project-store",
      projectId: "alpha",
      text: "Do not run in the default workspace.",
      ephemeral: true,
      backgroundReview: false
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_BOUNDARY_VIOLATION");
      assert.match(error.message, /project store is unavailable/u);
      return true;
    }
  );
  assert.equal(requests.length, 0);

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "explicit-default-without-store",
    projectId: "default",
    text: "Legacy default remains available.",
    ephemeral: true,
    backgroundReview: false
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].projectId, null);
});

test("AgentHost requires independent project grants for model credentials", async () => {
  const deniedProject = projectFixture("release", { secretRefs: [] });
  const denied = makeHarness({
    projects: projectResolver(deniedProject),
    modelProviderProperties: {
      credentialEnvSecretName: "OPENAI_API_KEY"
    }
  });
  await assert.rejects(
    denied.host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "provider-secret-denied",
      projectId: "release",
      text: "Use the project model.",
      ephemeral: true,
      backgroundReview: false
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_BOUNDARY_VIOLATION");
      assert.match(error.message, /OPENAI_API_KEY/u);
      return true;
    }
  );
  assert.equal(denied.requests.length, 0);

  const allowedProject = projectFixture("release", {
    secretRefs: ["OPENAI_API_KEY"]
  });
  const allowed = makeHarness({
    projects: projectResolver(allowedProject),
    modelProviderProperties: {
      credentialEnvSecretName: "OPENAI_API_KEY"
    }
  });
  await allowed.host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "provider-secret-allowed",
    projectId: "release",
    text: "Use the project model.",
    ephemeral: true,
    backgroundReview: false
  });
  assert.equal(allowed.requests.length, 1);
});

test("AgentHost keeps project memory roots exact and prefixes foreign scopes once", async () => {
  const project = projectFixture("release");
  const { host, requests } = makeHarness({
    projects: projectResolver(project)
  });
  const cases = [
    ["project:release", "project:release"],
    ["project:release:subagent:worker", "project:release:subagent:worker"],
    ["subagent:worker", "project:release:subagent:worker"],
    ["project:beta", "project:release:project:beta"]
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const [requested, expected] = cases[index];
    await host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: `project-memory-scope-${index}`,
      projectId: "release",
      memoryScope: requested,
      text: `Check memory scope ${index}.`,
      ephemeral: true,
      backgroundReview: false
    });
    assert.equal(requests.at(-1).memoryScope, expected);
  }

  const defaultHarness = makeHarness();
  await assert.rejects(
    defaultHarness.host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "default-cross-project-memory",
      memoryScope: "project:release",
      text: "Attempt cross-project memory.",
      ephemeral: true,
      backgroundReview: false
    }),
    (error) => {
      assert.equal(error.code, "PROJECT_BOUNDARY_VIOLATION");
      assert.match(error.message, /cannot enter a nondefault project memory scope/u);
      return true;
    }
  );
  assert.equal(defaultHarness.requests.length, 0);
});

test("AgentHost exposes user-global ambient OCR only to the default control plane", async () => {
  const ambient = {
    calls: 0,
    async getRecentContext() {
      this.calls += 1;
      return {
        apps: [{ app: "Private Editor", n: 2 }],
        snippets: [{
          app: "Private Editor",
          window: "secret.txt",
          at: "2026-07-24T12:34:00.000Z",
          text: "ambient-private-marker"
        }]
      };
    }
  };
  const defaultHarness = makeHarness({ observations: ambient });
  await defaultHarness.host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "default-ambient",
    text: "Where was I?",
    ephemeral: true,
    backgroundReview: false
  });
  assert.equal(ambient.calls, 1);
  assert.match(defaultHarness.requests[0].turnContext, /ambient-private-marker/u);

  const project = projectFixture("release");
  const isolatedHarness = makeHarness({
    projects: projectResolver(project),
    observations: ambient
  });
  await isolatedHarness.host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "project-ambient",
    projectId: "release",
    text: "Where was I?",
    ephemeral: true,
    backgroundReview: false
  });
  assert.equal(ambient.calls, 1, "isolated project must not query the global OCR store");
  assert.doesNotMatch(
    isolatedHarness.requests[0].turnContext,
    /ambient-private-marker/u
  );
});

test("AgentHost passes authoritative project grants into every model tool plan", async () => {
  const project = projectFixture("release", {
    revision: 7,
    activeSkills: ["release-check"],
    mcpGrants: ["github"]
  });
  const { host, toolPlanContexts } = makeHarness({
    projects: projectResolver(project),
    captureToolPlanContexts: true
  });

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "project-tool-plan-context",
    projectId: "release",
    text: "Verify the release.",
    ephemeral: true,
    backgroundReview: false
  });

  assert.ok(toolPlanContexts.length >= 1);
  for (const context of toolPlanContexts) {
    assert.equal(context.__projectId, "release");
    assert.equal(context.__projectRevision, 7);
    assert.deepEqual(context.__projectMcpGrants, ["github"]);
    assert.deepEqual(context.__projectActiveSkills, ["release-check"]);
  }
});

test("AgentHost expands a current context reference without replacing its raw durable form", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-request-context-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "evidence.txt"), "context evidence payload", "utf8");

  const { host, requests, store } = makeHarness({ workspaceDir });
  const sessionId = "provider-request-context-reference";
  const rawCurrent = "Inspect @file:evidence.txt";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Establish prior history.",
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: rawCurrent,
    backgroundReview: false
  });

  assert.match(requests[1].input, /^Inspect @file:evidence\.txt/);
  assert.match(requests[1].input, /--- Attached Context ---/);
  assert.match(requests[1].input, /context evidence payload/);
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: "Establish prior history." },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.equal(
    durableMessages(store, sessionId).at(-2).content,
    rawCurrent,
    "the transcript keeps the unexpanded user-authored text"
  );
});

test("AgentHost forwards current-turn images without adding the current text to history", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-image";
  const images = [{
    mediaType: "image/png",
    data: "AA==",
    filename: "pixel.png",
    bytes: 1
  }];

  await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId,
    text: "Describe the attached image.",
    images,
    backgroundReview: false
  });

  assert.equal(requests[0].input, "Describe the attached image.");
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(requests[0].images, images);
  assert.equal(durableMessages(store, sessionId)[0].content, "Describe the attached image.");
});

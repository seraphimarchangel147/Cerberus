import assert from "node:assert/strict";
import test from "node:test";
import { AbiRuntime } from "../src/abi-runtime.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function harness() {
  const calls = [];
  const detached = [];
  const removed = [];
  let project = {
    id: "alpha",
    status: "active",
    revision: 3,
    scheduleIds: ["alpha-prompt", "alpha-auto", "alpha-once"]
  };
  const self = {
    projects: {
      get(id) {
        return id === project.id && project.status === "active"
          ? structuredClone(project)
          : null;
      },
      detachResource(...args) {
        detached.push(args);
      }
    },
    agentHost: {
      async handleMessage(input) {
        calls.push(structuredClone(input));
        return { reply: "done" };
      }
    },
    budget: { check() {} },
    tasks: { agentPickNext: () => ({ id: "task-1" }) },
    cron: {
      removeJob(id) {
        removed.push(id);
        return true;
      }
    },
    channels: null
  };
  return {
    self,
    calls,
    detached,
    removed,
    setProject(next) {
      project = { ...project, ...next };
    }
  };
}

test("scheduled prompts require a current project-owned schedule", async () => {
  const { self, calls, setProject } = harness();
  const run = AbiRuntime.prototype.runScheduledPrompt;
  const valid = {
    id: "alpha-prompt",
    name: "Alpha prompt",
    input: {
      prompt: "project work",
      projectId: "alpha",
      projectRevision: 3
    }
  };

  const result = await run.call(self, valid);
  assert.equal(result.reply, "done");
  assert.equal(calls[0].projectId, "alpha");
  assert.equal(calls[0].metadata.projectId, "alpha");

  const unbound = await run.call(self, {
    ...valid,
    id: "foreign-schedule"
  });
  assert.deepEqual(unbound, {
    skipped: true,
    blocked: true,
    reason: "schedule-outside-project",
    projectId: "alpha"
  });
  assert.equal(calls.length, 1);

  for (const projectRevision of [undefined, null, "3", 3.5]) {
    const input = {
      prompt: "must not run without an integer project epoch",
      projectId: "alpha"
    };
    if (projectRevision !== undefined) input.projectRevision = projectRevision;
    const missingEpoch = await run.call(self, {
      ...valid,
      input
    });
    assert.deepEqual(missingEpoch, {
      skipped: true,
      blocked: true,
      reason: "project-revision-required",
      projectId: "alpha"
    });
  }
  assert.equal(calls.length, 1);

  setProject({ revision: 4 });
  const stale = await run.call(self, valid);
  assert.equal(stale.reason, "project-revision-changed");
  assert.equal(calls.length, 1);
});

test("autopilot and one-shot cleanup retain project scope", async () => {
  const { self, calls, detached, removed } = harness();
  const runAutopilot = AbiRuntime.prototype.runAutopilot;
  const runPrompt = AbiRuntime.prototype.runScheduledPrompt;

  const missingEpoch = await runAutopilot.call(self, {
    id: "alpha-auto",
    name: "Alpha automatic without epoch",
    input: {
      prompt: "must not run",
      projectId: "alpha"
    }
  });
  assert.equal(missingEpoch.reason, "project-revision-required");
  assert.equal(calls.length, 0);

  const automatic = await runAutopilot.call(self, {
    id: "alpha-auto",
    name: "Alpha automatic",
    input: {
      prompt: "continue",
      projectId: "alpha",
      projectRevision: 3
    }
  });
  assert.equal(automatic.autopilot, true);
  assert.equal(calls[0].projectId, "alpha");
  assert.equal(calls[0].metadata.projectId, "alpha");

  await runPrompt.call(self, {
    id: "alpha-once",
    name: "Alpha once",
    input: {
      prompt: "once",
      oneShot: true,
      projectId: "alpha",
      projectRevision: 3
    }
  });
  assert.deepEqual(removed, ["alpha-once"]);
  assert.equal(detached.length, 1);
  assert.deepEqual(detached[0].slice(0, 3), [
    "alpha",
    "scheduleIds",
    "alpha-once"
  ]);
});

test("new tool-created schedules pin the post-attachment project revision and run", async () => {
  const calls = [];
  let project = {
    id: "alpha",
    status: "active",
    revision: 3,
    workspaceRoot: "/workspace/alpha",
    scheduleIds: [],
    policy: { toolPolicy: "full", allowedTools: ["*"] },
    mcpGrants: [],
    activeSkills: [],
    secretRefs: [],
    hookIds: [],
    kanbanBoardId: "project-alpha",
    modelProfile: {},
    routingProfile: {}
  };
  const projects = {
    get(id) {
      return id === project.id ? structuredClone(project) : null;
    },
    attachResource(projectId, field, resourceId) {
      assert.equal(projectId, project.id);
      assert.equal(field, "scheduleIds");
      project = {
        ...project,
        revision: project.revision + 1,
        scheduleIds: [...project.scheduleIds, resourceId]
      };
      return structuredClone(project);
    },
    detachResource() {
      throw new Error("rollback must not run");
    }
  };
  const cron = new CronScheduler({
    modelResolver: () => ({
      provider: "fixture",
      model: "fixture-model"
    })
  });
  const runtime = {
    projects,
    cron,
    budget: { check() {} },
    channels: null,
    agentHost: {
      async handleMessage(input) {
        calls.push(structuredClone(input));
        return { reply: "ran-current-project-revision" };
      }
    }
  };
  const tools = new ToolRegistry({ projects });
  registerCoreTools(tools, runtime);
  const foreign = cron.addJob({
    id: "beta-owned-job",
    name: "Beta owned",
    enabled: true,
    task: "prompt",
    intervalMs: 60_000,
    input: {
      prompt: "beta work",
      projectId: "beta",
      projectRevision: 1
    }
  });

  const created = await tools.invoke(
    "schedule_message",
    {
      prompt: "run project work",
      intervalSeconds: 60,
      id: foreign.id
    },
    {
      __projectId: "alpha",
      __projectRevision: 3,
      sessionId: "alpha-session",
      channel: "local",
      from: "tester"
    }
  );
  assert.equal(created.ok, true);
  assert.notEqual(created.result.id, foreign.id);
  assert.equal(cron.listJobs().find((job) => job.id === foreign.id), foreign);
  assert.equal(foreign.input.projectId, "beta");
  const job = cron.listJobs().find((candidate) => candidate.id === created.result.id);
  assert.equal(project.revision, 4);
  assert.equal(job.input.projectRevision, project.revision);
  assert.ok(project.scheduleIds.includes(job.id));

  const result = await AbiRuntime.prototype.runScheduledPrompt.call(runtime, job);
  assert.equal(result.reply, "ran-current-project-revision");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, "alpha");
});

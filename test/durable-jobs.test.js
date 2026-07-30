import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAT_CORE_TOOLS } from "../src/agent-host.js";
import { JobManager, registerJobTools } from "../src/job-manager.js";
import { JobStore } from "../src/job-store.js";
import { registerDelegateTaskTool } from "../src/integrations/delegate-task.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ProjectStore } from "../src/project-store.js";
import { ToolOutputStore } from "../src/tool-output-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-durable-jobs-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir: root,
    defaultWorkspaceRoot: workspace
  });
  const tools = new ToolRegistry({ projects });
  const store = new JobStore({
    dir: path.join(root, "jobs"),
    maxConcurrency: options.maxConcurrency ?? 3
  });
  const runtime = {
    events: new EventEmitter(),
    projects,
    secrets: null,
    toolOutputs: new ToolOutputStore({
      dir: path.join(root, "tool-outputs")
    }),
    tools
  };
  const jobs = new JobManager({
    runtime,
    store,
    maxConcurrency: options.maxConcurrency ?? 3,
    maxInlineResultBytes: options.maxInlineResultBytes ?? 12_000,
    maxRuntimeMs: options.maxRuntimeMs,
    abortGraceMs: options.abortGraceMs,
    authorizationPollMs: options.authorizationPollMs,
    replayBatchSize: options.replayBatchSize,
    now: options.now
  });
  runtime.jobStore = store;
  runtime.jobs = jobs;
  registerJobTools(tools, runtime);
  registerDelegateTaskTool(runtime);
  t.after(async () => {
    await jobs.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    context(overrides = {}) {
      const project = projects.authorize("default");
      return {
        channel: "local",
        from: "tester",
        agentId: "main",
        sessionId: "local:tester:main",
        __projectId: "default",
        __projectRevision: project.revision,
        ...overrides
      };
    },
    jobs,
    projects,
    root,
    runtime,
    store,
    tools
  };
}

test("durable direct jobs re-enter ToolRegistry with stripped authority", async (t) => {
  const h = harness(t);
  let childContext;
  h.tools.register({
    name: "job_test_echo",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: false,
    handler: async (args, context) => {
      childContext = context;
      return { echoed: args.value };
    }
  });
  const context = h.context({
    __allowedTools: ["job_start", "job_test_echo"],
    __confirmed: true,
    __approval: { via: "parent" },
    __idempotencyKey: "provider_call_same"
  });

  const started = await h.tools.invoke("job_start", {
    kind: "tool",
    tool: "job_test_echo",
    arguments: { value: "hello" }
  }, context);
  assert.equal(started.ok, true);
  const jobId = started.result.id;
  const terminal = await h.jobs.wait(jobId, { timeoutMs: 5_000 }, context);
  assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));

  const collected = h.jobs.collect(jobId, {}, context);
  assert.equal(collected.output.result.echoed, "hello");
  assert.equal(childContext.__jobId, jobId);
  assert.equal(childContext.__projectId, "default");
  assert.equal(childContext.__projectRevision, h.projects.get("default").revision);
  assert.deepEqual(childContext.__allowedTools, ["job_start", "job_test_echo"]);
  assert.equal(childContext.__confirmed, undefined);
  assert.equal(childContext.__approval, undefined);
  assert.equal(childContext.__idempotencyKey, `job:${jobId}:dispatch`);

  const duplicateCall = await h.tools.invoke("job_start", {
    kind: "tool",
    tool: "job_test_echo",
    arguments: { value: "hello" }
  }, context);
  assert.equal(duplicateCall.ok, true);
  assert.equal(duplicateCall.result.id, jobId);
  assert.equal(h.store.list({ projectId: "default" }).length, 1);
});

test("all durable job controls are registered with correct effects and documented", (t) => {
  const h = harness(t);
  const descriptors = new Map(h.tools.list().map((tool) => [tool.name, tool]));
  assert.equal(descriptors.get("job_start").sideEffects, true);
  assert.equal(descriptors.get("job_status").sideEffects, false);
  assert.equal(descriptors.get("job_wait").sideEffects, false);
  assert.equal(descriptors.get("job_collect").sideEffects, false);
  assert.equal(descriptors.get("job_cancel").sideEffects, true);
  assert.equal(descriptors.get("mutation_lease_status").sideEffects, false);
  assert.ok(CHAT_CORE_TOOLS.includes("mutation_lease_status"));
  const prompt = buildDefaultInstructions({ agent: { name: "Job Tester" } });
  for (const name of [
    "job_start",
    "job_status",
    "job_wait",
    "job_collect",
    "job_cancel",
    "mutation_lease_status"
  ]) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`));
  }
});

test("mutation leases retain bounded metadata and release idempotently", (t) => {
  let now = 1_000;
  const h = harness(t, { now: () => now });
  const tool = h.tools.register({
    name: "job_test_lease_metadata",
    parameters: {
      type: "object",
      properties: {
        secret: { type: "string" }
      },
      required: ["secret"],
      additionalProperties: false
    },
    sideEffects: true,
    jobResourceRevision: "lease-metadata-v1",
    jobResources: () => ["workspace/metadata"],
    handler: async () => ({ ok: true })
  });
  const context = h.context({
    sessionId: "lease-session",
    jobId: "lease-job"
  });
  const release = h.jobs.acquireToolInvocation(
    tool,
    { secret: "sk-test-must-not-appear" },
    context
  );

  assert.deepEqual(h.jobs.inspectMutationLeases(), [{
    acquiredAt: 1_000,
    jobId: "lease-job",
    leaseId: h.jobs.inspectMutationLeases()[0].leaseId,
    ownerId: "job_test_lease_metadata",
    persistent: false,
    resourceLocks: [{
      resource: "project/default/workspace/metadata",
      mode: "write"
    }],
    sessionId: "lease-session"
  }]);
  assert.match(h.jobs.inspectMutationLeases()[0].leaseId, /^[a-f0-9-]{36}$/u);
  assert.doesNotMatch(
    JSON.stringify(h.jobs.inspectMutationLeases()),
    /sk-test-must-not-appear/u
  );

  release();
  release();
  assert.deepEqual(h.jobs.inspectMutationLeases(), []);

  now = 2_000;
  const releasePersistent = h.jobs.acquireWorkspaceLease(context, {
    ownerId: "workspace_owner"
  });
  const [persistent] = h.jobs.inspectMutationLeases();
  assert.equal(persistent.acquiredAt, 2_000);
  assert.equal(persistent.ownerId, "workspace_owner");
  assert.equal(persistent.persistent, true);
  assert.equal(persistent.sessionId, "lease-session");
  assert.equal(persistent.jobId, "lease-job");
  assert.match(persistent.leaseId, /^[a-f0-9-]{36}$/u);

  releasePersistent();
  releasePersistent();
  assert.deepEqual(h.jobs.inspectMutationLeases(), []);
});

test("mutation lease status is redacted, aged, and never blocked by held writes", async (t) => {
  let now = 10_000;
  const h = harness(t, { now: () => now });
  const secret = "sk-test-status-secret-12345678901234567890";
  const first = h.tools.register({
    name: "job_test_status_first",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "lease-status-v1",
    jobResources: () => ["workspace/status-first"],
    handler: async () => ({ ok: true })
  });
  const second = h.tools.register({
    name: "job_test_status_second",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "lease-status-v1",
    jobResources: () => ["workspace/status-second"],
    handler: async () => ({ ok: true })
  });
  const releaseFirst = h.jobs.acquireToolInvocation(
    first,
    { secret },
    h.context({ sessionId: "lease-status-first" })
  );
  now = 12_500;
  const releaseSecond = h.jobs.acquireToolInvocation(
    second,
    { secret },
    h.context({ sessionId: "lease-status-second" })
  );
  now = 15_000;

  const status = await h.tools.invoke(
    "mutation_lease_status",
    {},
    h.context({ sessionId: "lease-status-reader" })
  );
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(
    status.result.leases.map((lease) => ({
      age: lease.humanAge,
      ageMs: lease.ageMs,
      ownerId: lease.ownerId,
      source: lease.source
    })),
    [
      {
        age: "5s",
        ageMs: 5_000,
        ownerId: "job_test_status_first",
        source: "foreground"
      },
      {
        age: "2s500ms",
        ageMs: 2_500,
        ownerId: "job_test_status_second",
        source: "foreground"
      }
    ]
  );
  assert.doesNotMatch(JSON.stringify(status), /sk-test-status-secret/u);

  releaseFirst();
  releaseSecond();
});

test("mutation conflicts name the bounded holder, age, and recovery tool", (t) => {
  let now = 1_000;
  const h = harness(t, { now: () => now });
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const holder = h.tools.register({
    name: "job_test_conflict_holder",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "lease-conflict-v1",
    jobResources: ({ secret: value }) => [
      "workspace/conflict-detail",
      `workspace/${value}`
    ],
    handler: async () => ({ ok: true })
  });
  const contender = h.tools.register({
    name: "job_test_conflict_contender",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "lease-conflict-v1",
    jobResources: ({ secret: value }) => [
      "workspace/conflict-detail",
      `workspace/${value}`
    ],
    handler: async () => ({ ok: true })
  });
  const release = h.jobs.acquireToolInvocation(
    holder,
    { secret },
    h.context({ sessionId: "lease-conflict-holder" })
  );
  const [lease] = h.jobs.inspectMutationLeases();
  now = 1_085_000;

  assert.throws(
    () => h.jobs.acquireToolInvocation(
      contender,
      { secret },
      h.context({ sessionId: "lease-conflict-contender" })
    ),
    (error) => {
      assert.equal(error.constructor, Error);
      assert.match(error.message, /another active invocation 'job_test_conflict_holder'/u);
      assert.match(error.message, new RegExp(`lease ${lease.leaseId.slice(0, 12)}`));
      assert.match(error.message, /held 18m4s/u);
      assert.match(error.message, /locks: project\/default\/workspace\/conflict-detail/u);
      assert.match(error.message, /Call mutation_lease_status for detail/u);
      assert.doesNotMatch(error.message, /sk-abcdefghijklmnopqrstuvwxyz/u);
      assert.doesNotMatch(error.message, /[\r\n]/u);
      assert.ok(error.message.length <= 700, error.message);
      return true;
    }
  );

  release();
});

test("job manager rejects lock aliases and prototype-bearing JSON keys", (t) => {
  const h = harness(t);
  const context = h.context();
  h.tools.register({
    name: "job_test_validation",
    sideEffects: false,
    handler: async () => ({ ok: true })
  });
  assert.throws(
    () => h.jobs.start({
      kind: "tool",
      tool: "job_test_validation",
      arguments: {},
      resourceLocks: ["workspace/../outside"]
    }, context),
    /dot segment/i
  );
  assert.throws(
    () => h.jobs.start({
      kind: "tool",
      tool: "job_test_validation",
      arguments: JSON.parse('{"__proto__":{"polluted":true}}')
    }, context),
    /safe JSON field/i
  );
});

test("job controls cannot cross sessions inside one project", async (t) => {
  const h = harness(t);
  h.tools.register({
    name: "job_test_session",
    sideEffects: false,
    handler: async () => ({ ok: true })
  });
  const owner = h.context({ sessionId: "default-session-owner" });
  const other = h.context({ sessionId: "default-session-other" });
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_session",
    arguments: {}
  }, owner);
  await h.jobs.wait(started.id, { timeoutMs: 5_000 }, owner);
  assert.throws(
    () => h.jobs.status(started.id, other),
    (error) => error.code === "JOB_SESSION_BOUNDARY_VIOLATION"
  );
  assert.deepEqual(h.jobs.list({}, other), []);
  assert.throws(
    () => h.jobs.collect(started.id, {}, other),
    (error) => error.code === "JOB_SESSION_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => h.jobs.cancel(started.id, other),
    (error) => error.code === "JOB_SESSION_BOUNDARY_VIOLATION"
  );
});

test("default concurrency is three and overlapping mutations stay serialized", async (t) => {
  const h = harness(t);
  const active = new Set();
  const releases = new Map();
  let peak = 0;
  h.tools.register({
    name: "job_test_mutation",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "test-mutation-v1",
    jobResources: ({ id }) => [{
      resource: id === "overlap"
        ? "workspace/a/child"
        : `workspace/${id === "first" ? "a" : id === "second" ? "b" : "c"}`,
      mode: "write"
    }],
    handler: async ({ id }, context) => {
      active.add(id);
      peak = Math.max(peak, active.size);
      await new Promise((resolve) => {
        releases.set(id, () => {
          active.delete(id);
          resolve();
        });
        context.__abortSignal?.addEventListener?.("abort", () => {
          active.delete(id);
          resolve();
        }, { once: true });
      });
      return { id };
    }
  });
  const context = h.context();
  const start = (id, lock) => h.jobs.start({
    kind: "tool",
    tool: "job_test_mutation",
    arguments: { id },
    resourceLocks: [lock]
  }, context);

  const first = start("first", "workspace/a");
  const second = start("second", "workspace/b");
  const third = start("third", "workspace/c");
  const overlapping = start("overlap", "workspace/a/child");
  await until(() => active.size === 3);
  assert.equal(peak, 3);
  assert.equal(h.jobs.status(overlapping.id, context).status, "queued");

  releases.get("second")();
  await until(() => h.jobs.status(second.id, context).status === "succeeded");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.jobs.status(overlapping.id, context).status, "queued");

  releases.get("first")();
  await until(() => active.has("overlap"));
  releases.get("third")();
  releases.get("overlap")();
  await Promise.all([
    h.jobs.wait(first.id, { timeoutMs: 5_000 }, context),
    h.jobs.wait(third.id, { timeoutMs: 5_000 }, context),
    h.jobs.wait(overlapping.id, { timeoutMs: 5_000 }, context)
  ]);
  assert.equal(peak, 3);
});

test("foreground mutations honor active durable resource leases", async (t) => {
  const h = harness(t);
  let release;
  let foregroundRuns = 0;
  h.tools.register({
    name: "job_test_foreground_lock",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "foreground-lock-v1",
    jobResources: () => ["workspace/shared"],
    handler: async ({ mode }) => {
      if (mode === "background") {
        await new Promise((resolve) => {
          release = resolve;
        });
      } else {
        foregroundRuns += 1;
      }
      return { mode };
    }
  });
  const context = h.context();
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_foreground_lock",
    arguments: { mode: "background" },
    resourceLocks: ["workspace/shared"]
  }, context);
  await until(() => typeof release === "function");
  const held = await h.tools.invoke("mutation_lease_status", {}, context);
  assert.equal(held.ok, true);
  assert.ok(held.result.leases.some((lease) => (
    lease.source === "durable"
    && lease.jobId === started.id
    && lease.ownerId === "job_test_foreground_lock"
    && lease.persistent === true
  )));
  const foreground = await h.tools.invoke(
    "job_test_foreground_lock",
    { mode: "foreground" },
    context
  );
  assert.equal(foreground.ok, false);
  assert.match(foreground.error, /active durable job/i);
  assert.equal(foregroundRuns, 0);
  release();
  assert.equal(
    (await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context)).status,
    "succeeded"
  );
});

test("queued direct jobs fail closed when their tool identity changes", async (t) => {
  const h = harness(t, { maxConcurrency: 1 });
  let releaseBlocker;
  let mutated = false;
  h.tools.register({
    name: "job_test_identity_blocker",
    sideEffects: true,
    jobResourceRevision: "identity-blocker-v1",
    jobResources: () => ["workspace/blocker"],
    handler: async () => new Promise((resolve) => {
      releaseBlocker = () => resolve({ released: true });
    })
  });
  h.tools.register({
    name: "job_test_identity_target",
    sideEffects: false,
    handler: async () => ({ read: true })
  });
  const context = h.context();
  h.jobs.start({
    kind: "tool",
    tool: "job_test_identity_blocker",
    arguments: {},
    resourceLocks: ["workspace/blocker"]
  }, context);
  await until(() => typeof releaseBlocker === "function");
  const queued = h.jobs.start({
    kind: "tool",
    tool: "job_test_identity_target",
    arguments: {}
  }, context);
  h.tools.register({
    name: "job_test_identity_target",
    sideEffects: true,
    handler: async () => {
      mutated = true;
      return { mutated: true };
    }
  });
  releaseBlocker();
  const terminal = await h.jobs.wait(
    queued.id,
    { timeoutMs: 5_000 },
    context
  );
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.attempt, 0);
  assert.equal(terminal.error.code, "JOB_DISPATCH_BOUNDARY_CHANGED");
  assert.equal(mutated, false);
});

test("cancellation is requested before abort and settles when the worker stops", async (t) => {
  const h = harness(t);
  let entered = false;
  let observedAbort = false;
  h.tools.register({
    name: "job_test_cancel",
    sideEffects: true,
    handler: async (_args, context) => {
      entered = true;
      await new Promise((resolve) => {
        context.__abortSignal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      return { stopped: true };
    }
  });
  const context = h.context();
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_cancel",
    arguments: {},
    resourceLocks: ["workspace/cancel"]
  }, context);
  await until(() => entered);

  const requested = h.jobs.cancel(started.id, context);
  assert.equal(["cancel_requested", "cancelled"].includes(requested.status), true);
  const terminal = await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context);
  assert.equal(terminal.status, "cancelled");
  assert.equal(observedAbort, true);
});

test("failed durable cancel persistence never aborts the worker", async (t) => {
  const h = harness(t);
  let entered = false;
  let observedAbort = false;
  let release;
  h.tools.register({
    name: "job_test_cancel_order",
    sideEffects: true,
    jobResourceRevision: "cancel-order-v1",
    jobResources: () => ["workspace/cancel-order"],
    handler: async (_args, context) => {
      entered = true;
      context.__abortSignal.addEventListener("abort", () => {
        observedAbort = true;
      }, { once: true });
      await new Promise((resolve) => {
        release = resolve;
      });
      return { released: true };
    }
  });
  const context = h.context();
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_cancel_order",
    arguments: {},
    resourceLocks: ["workspace/cancel-order"]
  }, context);
  await until(() => entered);
  const durableCancel = h.store.cancel.bind(h.store);
  h.store.cancel = () => {
    throw new Error("planned durable append failure");
  };
  assert.throws(
    () => h.jobs.cancel(started.id, context),
    /planned durable append failure/
  );
  assert.equal(observedAbort, false);
  assert.equal(h.jobs.status(started.id, context).status, "running");
  h.store.cancel = durableCancel;
  h.jobs.cancel(started.id, context);
  release();
  assert.equal(
    (await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context)).status,
    "cancelled"
  );
});

test("non-cooperative jobs are quarantined without releasing conflicting locks", async (t) => {
  const h = harness(t, {
    maxRuntimeMs: 30,
    abortGraceMs: 20,
    authorizationPollMs: 1_000
  });
  let releaseStuck;
  h.tools.register({
    name: "job_test_watchdog",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: true,
    jobResourceRevision: "watchdog-v1",
    jobResources: ({ resource }) => [`workspace/${resource}`],
    handler: async ({ mode, resource }) => {
      if (mode === "stuck") {
        await new Promise((resolve) => {
          releaseStuck = resolve;
        });
      }
      return { mode, resource };
    }
  });
  const context = h.context();
  const stuck = h.jobs.start({
    kind: "tool",
    tool: "job_test_watchdog",
    arguments: { mode: "stuck", resource: "shared" },
    resourceLocks: ["workspace/shared"]
  }, context);
  const terminal = await h.jobs.wait(
    stuck.id,
    { timeoutMs: 2_000 },
    context
  );
  assert.equal(terminal.status, "cancelled");
  const held = await h.tools.invoke("mutation_lease_status", {}, context);
  assert.equal(held.ok, true);
  assert.ok(held.result.leases.some((lease) => (
    lease.source === "quarantined"
    && lease.jobId === stuck.id
    && lease.ownerId === "job_test_watchdog"
    && lease.persistent === true
  )));

  const conflict = h.jobs.start({
    kind: "tool",
    tool: "job_test_watchdog",
    arguments: { mode: "fast", resource: "shared" },
    resourceLocks: ["workspace/shared"]
  }, context);
  const disjoint = h.jobs.start({
    kind: "tool",
    tool: "job_test_watchdog",
    arguments: { mode: "fast", resource: "other" },
    resourceLocks: ["workspace/other"]
  }, context);
  assert.equal(
    (await h.jobs.wait(disjoint.id, { timeoutMs: 2_000 }, context)).status,
    "succeeded"
  );
  assert.equal(h.jobs.status(conflict.id, context).status, "queued");
  releaseStuck();
  assert.equal(
    (await h.jobs.wait(conflict.id, { timeoutMs: 2_000 }, context)).status,
    "succeeded"
  );
});

test("restart hydration advances beyond each bounded replay batch", async (t) => {
  const h = harness(t, {
    maxConcurrency: 2,
    replayBatchSize: 2
  });
  h.tools.register({
    name: "job_test_replay_batch",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: false,
    handler: async ({ value }) => ({ value })
  });
  const context = h.context();
  const ids = [];
  for (let value = 0; value < 5; value += 1) {
    ids.push(h.jobs.start({
      kind: "tool",
      tool: "job_test_replay_batch",
      arguments: { value }
    }, context).id);
  }
  await h.jobs.close();

  const restartedStore = new JobStore({
    dir: path.join(h.root, "jobs"),
    maxConcurrency: 2
  });
  const restartedJobs = new JobManager({
    runtime: h.runtime,
    store: restartedStore,
    maxConcurrency: 2,
    replayBatchSize: 2
  });
  h.runtime.jobStore = restartedStore;
  h.runtime.jobs = restartedJobs;
  restartedJobs.resume();
  try {
    const terminal = await Promise.all(ids.map((id) => restartedJobs.wait(
      id,
      { timeoutMs: 5_000 },
      context
    )));
    assert.deepEqual(
      terminal.map((job) => job.status),
      ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]
    );
  } finally {
    await restartedJobs.close();
  }
});

test("project revision changes durably cancel active jobs", async (t) => {
  const h = harness(t, {
    authorizationPollMs: 20,
    abortGraceMs: 20
  });
  const project = h.projects.create({
    id: "alpha",
    name: "Alpha",
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  });
  h.projects.resolveForSession("alpha-job-session", {
    requestedProjectId: "alpha",
    actor: "test"
  });
  let entered = false;
  h.tools.register({
    name: "job_test_project_change",
    sideEffects: true,
    jobResourceRevision: "project-change-v1",
    jobResources: () => ["workspace/project-change"],
    handler: async (_args, context) => {
      entered = true;
      await new Promise((resolve) => {
        context.__abortSignal.addEventListener("abort", resolve, {
          once: true
        });
      });
      return { stopped: true };
    }
  });
  const context = h.context({
    sessionId: "alpha-job-session",
    __projectId: "alpha",
    __projectRevision: project.revision
  });
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_project_change",
    arguments: {},
    resourceLocks: ["workspace/project-change"]
  }, context);
  await until(() => entered);
  h.projects.archive("alpha", {
    expectedRevision: project.revision,
    actor: "test"
  });
  const terminal = await h.jobs.wait(
    started.id,
    { timeoutMs: 2_000 },
    context
  );
  assert.equal(terminal.status, "cancelled");
  assert.match(terminal.cancel.reason, /project authorization changed/i);
});

test("large results use project-owned tool-output references", async (t) => {
  const h = harness(t, { maxInlineResultBytes: 128 });
  h.tools.register({
    name: "job_test_large",
    sideEffects: false,
    handler: async () => ({ text: "x".repeat(4_000) })
  });
  const context = h.context();
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_large",
    arguments: {}
  }, context);
  const terminal = await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context);
  assert.match(
    terminal.toolOutputRef,
    /^out_[a-f0-9]{16}$/,
    JSON.stringify(terminal)
  );

  const first = h.jobs.collect(started.id, {
    offset: 0,
    maxChars: 200
  }, context);
  assert.equal(first.output.ref, terminal.toolOutputRef);
  assert.equal(first.output.hasMore, true);
  assert.match(first.output.content, /"ok":true/);
});

test("secret-bearing inputs stay live-only and are never exposed by status", async (t) => {
  const h = harness(t);
  h.tools.register({
    name: "job_test_secret_shape",
    parameters: { type: "object", additionalProperties: true },
    sideEffects: false,
    handler: async () => ({ accepted: true })
  });
  const context = h.context();
  const started = h.jobs.start({
    kind: "tool",
    tool: "job_test_secret_shape",
    arguments: { apiKey: "not-a-real-secret-value" }
  }, context);
  const durable = h.store.get(started.id, { projectId: "default" });
  assert.equal(durable.replayPayload, null);
  assert.equal(JSON.stringify(durable).includes("not-a-real-secret-value"), false);
  const status = h.jobs.status(started.id, context);
  assert.equal(Object.hasOwn(status, "replayPayload"), false);
  await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context);
});

test("durable subagent jobs inherit project, policy, budget, deadline, and abort rails", async (t) => {
  const h = harness(t);
  let captured;
  h.runtime.agentHost = {
    async handleMessage(input) {
      captured = input;
      return {
        reply: "subagent finished",
        model: { iterations: 1, stopReason: "completed" }
      };
    }
  };
  const budgetEnvelope = { limitUsd: 0.3, spentUsd: 0.1 };
  const turnDeadline = Date.now() + 20_000;
  const context = h.context({
    __scrutinyPolicy: "confirm",
    __budgetEnvelope: budgetEnvelope,
    __turnDeadline: turnDeadline,
    __remainingIterations: 5
  });
  const started = h.jobs.start({
    kind: "subagent",
    goal: "inspect the bounded fixture",
    context: "Use only the supplied project.",
    role: "leaf",
    resourceLocks: ["workspace/subagent"]
  }, context);
  const terminal = await h.jobs.wait(started.id, { timeoutMs: 5_000 }, context);
  assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
  assert.equal(captured.projectId, "default");
  assert.equal(captured.origin, "job");
  assert.equal(captured.jobId, started.id);
  assert.equal(captured.scrutinyPolicyCeiling, "confirm");
  assert.equal(captured.budgetEnvelope, budgetEnvelope);
  assert.equal(captured.turnDeadline, turnDeadline);
  assert.equal(captured.maxIterations, 5);
  assert.ok(captured.abortSignal instanceof AbortSignal);
  assert.ok(!captured.allowedTools.includes("job_start"));
  assert.ok(!captured.allowedTools.includes("job_cancel"));
});

async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not reached before timeout");
}

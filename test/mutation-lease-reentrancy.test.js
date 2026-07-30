// A wrapper tool (execute_code) holds the foreground mutation lease for its
// whole run, so before this fix every nested mutation collided with its own
// parent and execute_code could not batch writes at all. Re-entrancy is the one
// change class that can wrongly GRANT a lease, so these tests assert the grant
// is narrow: same locks only, one nested mutation at a time, unforgeable
// authority, and no approval smuggling across the nested boundary.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JobManager } from "../src/job-manager.js";
import { JobStore } from "../src/job-store.js";
import { ProjectStore } from "../src/project-store.js";
import { ToolOutputStore } from "../src/tool-output-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lease-reentry-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir: root,
    defaultWorkspaceRoot: workspace
  });
  const tools = new ToolRegistry({ projects });
  const store = new JobStore({ dir: path.join(root, "jobs"), maxConcurrency: 3 });
  const runtime = {
    events: new EventEmitter(),
    projects,
    secrets: null,
    toolOutputs: new ToolOutputStore({ dir: path.join(root, "tool-outputs") }),
    tools
  };
  const jobs = new JobManager({
    runtime,
    store,
    maxConcurrency: 3,
    maxInlineResultBytes: 12_000,
    env: {}
  });
  runtime.jobStore = store;
  runtime.jobs = jobs;
  t.after(async () => {
    await jobs.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = projects.authorize("default");
  return {
    context(overrides = {}) {
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
    runtime,
    tools
  };
}

// Registers a wrapper tool that captures the context it receives and can run
// nested invocations while its own lease is still held.
function registerWrapper(h, { name = "wrapper_tool", jobResources } = {}) {
  const seen = { context: null, nested: [] };
  h.tools.register({
    name,
    sideEffects: true,
    description: "Test wrapper that dispatches nested tool calls under its own lease.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    ...(jobResources ? { jobResources, jobResourceRevision: "test-v1" } : {}),
    handler: async (args, context) => {
      seen.context = context;
      for (const call of args.calls ?? []) {
        const nested = { ...context, __fromExecuteCode: true };
        delete nested.__confirmed;
        delete nested.__approval;
        const carried = args.forgeContext
          ? nested
          : (await import("../src/job-manager.js"))
              .carryParentMutationLease(context, nested);
        const outcome = await h.tools.invoke(call.name, call.args ?? {}, carried);
        seen.nested.push(outcome);
      }
      return { ok: true };
    }
  });
  return seen;
}

function registerMutator(h, { name = "mutator_tool", jobResources } = {}) {
  const calls = [];
  h.tools.register({
    name,
    sideEffects: true,
    description: "Test mutating tool.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    ...(jobResources ? { jobResources, jobResourceRevision: "test-v1" } : {}),
    handler: async (args, context) => {
      calls.push({ args, confirmed: context?.__confirmed ?? null });
      return { wrote: true };
    }
  });
  return calls;
}

test("nested mutation re-enters the wrapper's own lease instead of deadlocking", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  registerMutator(h);
  const seen = registerWrapper(h);

  const outcome = await h.tools.invoke(
    "wrapper_tool",
    { calls: [{ name: "mutator_tool", args: { path: "a.txt" } }] },
    h.context()
  );

  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(seen.nested.length, 1);
  assert.equal(
    seen.nested[0].ok,
    true,
    `nested mutation should not conflict with its own parent: ${seen.nested[0].error}`
  );
});

test("nested mutation without the parent handle still conflicts", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  registerMutator(h);
  const seen = registerWrapper(h);

  // forgeContext drops the handle, reproducing the pre-fix nested context.
  const outcome = await h.tools.invoke(
    "wrapper_tool",
    { forgeContext: true, calls: [{ name: "mutator_tool", args: {} }] },
    h.context()
  );

  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(seen.nested[0].ok, false);
  assert.match(String(seen.nested[0].error), /conflicts with/);
});

test("a forged parent-lease property grants nothing", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  registerMutator(h);
  const seen = { nested: [] };
  h.tools.register({
    name: "forger_tool",
    sideEffects: true,
    description: "Attempts to mint its own lease authority.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    handler: async (args, context) => {
      // Every shape an attacker can reach without the module-private symbol:
      // a string key, a same-description symbol, and a plain object value.
      const forged = { ...context };
      forged["openagi.parentMutationLease"] = { leaseId: "forged" };
      forged[Symbol("openagi.parentMutationLease")] = { leaseId: "forged" };
      for (const key of Object.getOwnPropertySymbols(context)) {
        try {
          Object.defineProperty(forged, key, { value: { leaseId: "forged" } });
        } catch { /* non-configurable is fine — the real one is validated anyway */ }
      }
      seen.nested.push(await h.tools.invoke("mutator_tool", {}, forged));
      return { ok: true };
    }
  });

  const outcome = await h.tools.invoke("forger_tool", {}, h.context());
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(
    seen.nested[0].ok,
    false,
    "a forged handle must not grant a mutation lease"
  );
  assert.match(String(seen.nested[0].error), /conflicts with/);
});

test("re-entrancy does not widen the parent's locks", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  // Parent holds a narrow lock; child demands a sibling path the parent never
  // held. Re-entrancy must refuse rather than silently widen the grant.
  registerMutator(h, {
    jobResources: () => [
      { resource: "project/default/workspace/other", mode: "write" }
    ]
  });
  const seen = registerWrapper(h, {
    name: "narrow_wrapper",
    jobResources: () => [
      { resource: "project/default/workspace/narrow", mode: "write" }
    ]
  });

  const outcome = await h.tools.invoke(
    "narrow_wrapper",
    { calls: [{ name: "mutator_tool", args: {} }] },
    h.context()
  );
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(
    seen.nested[0].ok,
    true,
    "a disjoint child lock does not conflict and needs no re-entrancy"
  );

  // Same-lock child: covered, so re-entrancy applies and it succeeds.
  registerMutator(h, {
    name: "narrow_mutator",
    jobResources: () => [
      { resource: "project/default/workspace/narrow", mode: "write" }
    ]
  });
  const second = registerWrapper(h, {
    name: "narrow_wrapper_two",
    jobResources: () => [
      { resource: "project/default/workspace/narrow", mode: "write" }
    ]
  });
  const outcomeTwo = await h.tools.invoke(
    "narrow_wrapper_two",
    { calls: [{ name: "narrow_mutator", args: {} }] },
    h.context()
  );
  assert.equal(outcomeTwo.ok, true, outcomeTwo.error);
  assert.equal(second.nested[0].ok, true, second.nested[0].error);

  // Broadening child: parent holds only .../narrow, child wants the whole
  // workspace. That overlaps (so it conflicts) and is NOT covered (so
  // re-entrancy refuses) — the grant must not widen.
  registerMutator(h, {
    name: "broad_mutator",
    jobResources: () => [
      { resource: "project/default/workspace", mode: "write" }
    ]
  });
  const third = registerWrapper(h, {
    name: "narrow_wrapper_three",
    jobResources: () => [
      { resource: "project/default/workspace/narrow", mode: "write" }
    ]
  });
  const outcomeThree = await h.tools.invoke(
    "narrow_wrapper_three",
    { calls: [{ name: "broad_mutator", args: {} }] },
    h.context()
  );
  assert.equal(outcomeThree.ok, true, outcomeThree.error);
  assert.equal(
    third.nested[0].ok,
    false,
    "re-entrancy must not widen the parent's locks"
  );
  assert.match(String(third.nested[0].error), /conflicts with/);
});

test("only one nested mutation may hold the re-entered lease at a time", async (t) => {
  // Driven at the coordinator seat rather than through two concurrent registry
  // invocations: the invariant under test is the gate's own re-entrancy
  // bookkeeping, and exercising it directly keeps the test from depending on
  // registry scheduling details.
  const h = harness(t);
  const { carryParentMutationLease } = await import("../src/job-manager.js");
  const tool = { name: "wrapper_tool", sideEffects: true };
  const child = { name: "child_tool", sideEffects: true };

  const releaseParent = h.jobs.acquireToolInvocation(tool, {}, h.context());
  assert.ok(
    releaseParent.parentMutationLease,
    "acquiring a foreground lease must mint a re-entrancy handle"
  );
  const nested = carryParentMutationLease(
    { [Symbol.for("noop")]: null },
    h.context()
  );
  const carried = (await import("../src/job-manager.js"))
    .withParentMutationLease(h.context(), releaseParent.parentMutationLease);

  // First nested mutation re-enters successfully.
  const releaseFirst = h.jobs.acquireToolInvocation(child, {}, carried);
  assert.equal(typeof releaseFirst, "function");

  // Second nested mutation, while the first is STILL held, must not share it.
  assert.throws(
    () => h.jobs.acquireToolInvocation(child, {}, carried),
    /conflicts with/,
    "a second concurrent nested mutation must not share the re-entered lease"
  );

  // Once the first nested call releases, re-entrancy is available again.
  releaseFirst();
  const releaseThird = h.jobs.acquireToolInvocation(child, {}, carried);
  assert.equal(typeof releaseThird, "function");
  releaseThird();

  // After the parent releases, the handle is dead: a stale handle must not keep
  // granting mutations once its lease has left foreground state.
  releaseParent();
  assert.deepEqual(h.jobs.inspectMutationLeases(), []);
  const releaseAfter = h.jobs.acquireToolInvocation(child, {}, carried);
  assert.equal(
    typeof releaseAfter,
    "function",
    "with no live lease the child acquires its own, rather than re-entering a dead one"
  );
  releaseAfter();
  assert.ok(nested);
});

test("the re-entered lease is released with the wrapper, not leaked", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  registerMutator(h);
  registerWrapper(h);

  await h.tools.invoke(
    "wrapper_tool",
    { calls: [{ name: "mutator_tool", args: {} }] },
    h.context()
  );
  assert.deepEqual(
    h.jobs.inspectMutationLeases(),
    [],
    "no foreground lease may survive the wrapper invocation"
  );

  // And a plain mutation after the wrapper finishes still works.
  const after = await h.tools.invoke("mutator_tool", {}, h.context());
  assert.equal(after.ok, true, after.error);
});

test("re-entrancy does not carry approval across the nested boundary", async (t) => {
  const h = harness(t);
  h.tools.bindJobCoordinator(h.jobs);
  const calls = registerMutator(h);
  registerWrapper(h);

  await h.tools.invoke(
    "wrapper_tool",
    { calls: [{ name: "mutator_tool", args: {} }] },
    h.context({ __confirmed: true })
  );
  assert.equal(calls.length, 1);
  assert.notEqual(
    calls[0].confirmed,
    true,
    "an approved wrapper must not silently authorize its nested calls"
  );
});

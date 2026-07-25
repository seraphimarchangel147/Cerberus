import assert from "node:assert/strict";
import test from "node:test";
import {
  executeToolBatch,
  TOOL_BATCH_MAX_CONCURRENCY
} from "../src/tool-batch-executor.js";
import { ToolRegistry } from "../src/tool-registry.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("read-only calls run in bounded parallel and retain input order", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_item",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false
    },
    handler: async ({ id }) => ({ id })
  });
  let active = 0;
  let peak = 0;
  const releases = [];
  const entries = Array.from({ length: 6 }, (_, id) => ({
    name: "read_item",
    args: { id }
  }));

  const execution = executeToolBatch(entries, {
    toolRegistry: registry,
    maxConcurrency: 2,
    invoke: async (entry) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      releases.push(() => {
        active -= 1;
        gate.resolve();
      });
      await gate.promise;
      return entry.args.id;
    }
  });
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  releases.splice(0).forEach((release) => release());
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());

  const result = await execution;
  assert.deepEqual(result.results.map((item) => item.value), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(result.waves.map((wave) => wave.width), [2, 2, 2]);
});

test("unscoped mutations and approvals remain sequential barriers", async () => {
  const registry = new ToolRegistry();
  for (const [name, needsConfirmation] of [
    ["mutate_unscoped", false],
    ["mutate_approved", true]
  ]) {
    registry.register({
      name,
      parameters: { type: "object", additionalProperties: false },
      sideEffects: true,
      needsConfirmation,
      handler: async () => ({ ok: true })
    });
  }
  let active = 0;
  let peak = 0;
  const result = await executeToolBatch([
    { name: "mutate_unscoped", args: {} },
    { name: "mutate_unscoped", args: {} },
    { name: "mutate_approved", args: {} }
  ], {
    toolRegistry: registry,
    invoke: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return true;
    }
  });
  assert.equal(peak, 1);
  assert.deepEqual(result.waves.map((wave) => wave.width), [1, 1, 1]);
  assert.ok(result.results.every((item) => item.batch.classification === "exclusive"));
});

test("trusted disjoint mutation resources run together while overlaps split waves", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "write_path",
    parameters: {
      type: "object",
      properties: { resource: { type: "string" } },
      required: ["resource"],
      additionalProperties: false
    },
    sideEffects: true,
    jobResources: ({ resource }) => [`workspace/${resource}`],
    jobResourceRevision: "batch-test-v1",
    handler: async () => ({ ok: true })
  });
  const result = await executeToolBatch([
    { name: "write_path", args: { resource: "a" } },
    { name: "write_path", args: { resource: "b" } },
    { name: "write_path", args: { resource: "a/child" } },
    { name: "write_path", args: { resource: "c" } }
  ], {
    toolRegistry: registry,
    invoke: async (entry) => entry.args.resource
  });
  assert.deepEqual(result.waves, [
    { index: 0, width: 2, classification: "mutation", entries: [0, 1] },
    { index: 1, width: 2, classification: "mutation", entries: [2, 3] }
  ]);
  assert.deepEqual(
    result.results.map((item) => item.value),
    ["a", "b", "a/child", "c"]
  );
});

test("reads and mutations never share a wave", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_item",
    sideEffects: false,
    parameters: { type: "object", additionalProperties: false },
    handler: async () => true
  });
  registry.register({
    name: "write_item",
    sideEffects: true,
    parameters: { type: "object", additionalProperties: false },
    jobResources: () => ["workspace/item"],
    jobResourceRevision: "batch-test-v1",
    handler: async () => true
  });
  const result = await executeToolBatch([
    { name: "read_item", args: {} },
    { name: "read_item", args: {} },
    { name: "write_item", args: {} },
    { name: "read_item", args: {} }
  ], {
    toolRegistry: registry,
    invoke: async () => true
  });
  assert.deepEqual(
    result.waves.map(({ width, classification }) => ({ width, classification })),
    [
      { width: 2, classification: "read" },
      { width: 1, classification: "mutation" },
      { width: 1, classification: "read" }
    ]
  );
});

test("goal barriers, invalid resolvers, and rejected invocations are isolated", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_item",
    sideEffects: false,
    parameters: { type: "object", additionalProperties: false },
    handler: async () => true
  });
  registry.register({
    name: "bad_resource",
    sideEffects: true,
    parameters: { type: "object", additionalProperties: false },
    jobResources: () => Promise.resolve(["workspace/item"]),
    jobResourceRevision: "batch-test-v1",
    handler: async () => true
  });
  const result = await executeToolBatch([
    { name: "read_item", args: {} },
    { name: "goal_control", args: {} },
    { name: "bad_resource", args: {} },
    { name: "read_item", args: {} }
  ], {
    toolRegistry: registry,
    barrierNames: ["goal_control"],
    invoke: async (_entry, index) => {
      if (index === 2) throw new Error("planned failure");
      return index;
    }
  });
  assert.deepEqual(result.waves.map((wave) => wave.width), [1, 1, 1, 1]);
  assert.equal(result.results[2].status, "rejected");
  assert.match(result.results[2].reason.message, /planned failure/u);
  assert.equal(result.results[3].value, 3);
});

test("the hard cap cannot be raised above four", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_item",
    sideEffects: false,
    parameters: { type: "object", additionalProperties: false },
    handler: async () => true
  });
  const result = await executeToolBatch(
    Array.from({ length: 9 }, () => ({ name: "read_item", args: {} })),
    {
      toolRegistry: registry,
      maxConcurrency: 100,
      invoke: async () => true
    }
  );
  assert.equal(TOOL_BATCH_MAX_CONCURRENCY, 4);
  assert.deepEqual(result.waves.map((wave) => wave.width), [4, 4, 1]);
});

test("an aborted batch never launches a later wave", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_item",
    sideEffects: false,
    parameters: { type: "object", additionalProperties: false },
    handler: async () => true
  });
  const controller = new AbortController();
  const invoked = [];
  const result = await executeToolBatch(
    Array.from({ length: 5 }, (_, id) => ({
      name: "read_item",
      args: { id }
    })),
    {
      toolRegistry: registry,
      context: { __abortSignal: controller.signal },
      maxConcurrency: 2,
      invoke: async (_entry, index) => {
        invoked.push(index);
        if (index === 0) controller.abort();
        return index;
      }
    }
  );

  assert.deepEqual(invoked, [0, 1]);
  assert.equal(result.results[0].status, "fulfilled");
  assert.equal(result.results[1].status, "fulfilled");
  assert.ok(result.results.slice(2).every((entry) => (
    entry.status === "rejected"
    && entry.reason.code === "TOOL_BATCH_CANCELLED"
    && entry.batch.skipped === true
  )));
});

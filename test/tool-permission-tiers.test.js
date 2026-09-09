import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { HookRegistry } from "../src/hook-registry.js";
import { ToolKillswitchError, ToolRegistry, TOOL_PERMISSION_TIERS } from "../src/tool-registry.js";
import { registerToolSearchTools, ToolSearchController } from "../src/tool-search.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-killswitch-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const registry = new ToolRegistry({ ...options, dataDir });
  const killswitchPath = path.join(dataDir, "KILLSWITCH");
  const enable = () => fs.writeFileSync(killswitchPath, "operator stop\n");
  const disable = () => fs.unlinkSync(killswitchPath);
  return { dataDir, registry, killswitchPath, enable, disable };
}

function register(registry, options = {}) {
  return registry.register({ name: "write_fixture", handler: () => ({ changed: true }), ...options });
}

function assertBlocked(result, killswitchPath) {
  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "killswitch_active");
  assert.equal(result.outcome.status, "blocked");
  assert.equal(result.outcome.changed, false);
  assert.ok(result.error.includes(killswitchPath));
  assert.equal(result.receipt.dispatched, false);
}

test("permission tiers default to standard except explicitly side-effect-free tools", (t) => {
  const { registry } = fixture(t);
  assert.equal(register(registry).permissionTier, "standard");
  assert.equal(register(registry, { name: "read_fixture", sideEffects: false }).permissionTier, "read_only");
  assert.equal(register(registry, { name: "explicit_write", sideEffects: true }).permissionTier, "standard");
  assert.equal(register(registry, { name: "sensitive_read", sideEffects: false, permissionTier: "sensitive" }).permissionTier, "sensitive");
});

test("all declared permission tiers are public registration metadata", (t) => {
  const { registry } = fixture(t);
  for (const permissionTier of TOOL_PERMISSION_TIERS) register(registry, { name: permissionTier, permissionTier });
  assert.deepEqual(registry.list().map((tool) => tool.permissionTier), [...TOOL_PERMISSION_TIERS]);
  for (const invalid of [null, "", "read-only", "admin", 1]) {
    assert.throws(() => register(registry, { permissionTier: invalid }), /permissionTier must be one of/);
  }
});

test("killswitch blocks a write and permits a read", async (t) => {
  const f = fixture(t);
  let writes = 0;
  let reads = 0;
  register(f.registry, { handler: () => { writes += 1; return {}; } });
  register(f.registry, { name: "read_fixture", sideEffects: false, handler: () => { reads += 1; return {}; } });
  f.enable();
  assertBlocked(await f.registry.invoke("write_fixture", {}), f.killswitchPath);
  assert.equal((await f.registry.invoke("read_fixture", {})).ok, true);
  assert.equal(writes, 0);
  assert.equal(reads, 1);
});

for (const permissionTier of ["standard", "sensitive", "manual_only"]) {
  test(`killswitch refuses ${permissionTier} even when its sideEffects hint is false`, async (t) => {
    const f = fixture(t);
    register(f.registry, { permissionTier, sideEffects: false, handler: () => assert.fail("must not dispatch") });
    f.enable();
    assertBlocked(await f.registry.invoke("write_fixture", {}), f.killswitchPath);
  });
}

test("removing the killswitch immediately restores the same invocation", async (t) => {
  const f = fixture(t);
  let writes = 0;
  register(f.registry, { handler: () => ({ writes: ++writes }) });
  const context = { sessionId: "session", __turnId: "turn" };
  assert.equal((await f.registry.invoke("write_fixture", {}, context)).ok, true);
  f.enable();
  assertBlocked(await f.registry.invoke("write_fixture", {}, context), f.killswitchPath);
  assertBlocked(await f.registry.invoke("write_fixture", {}, context), f.killswitchPath);
  f.disable();
  assert.equal((await f.registry.invoke("write_fixture", {}, context)).ok, true);
  assert.equal(writes, 2);
});

test("approval flags, session allowances, and hooks cannot override the killswitch", async (t) => {
  const hooks = new HookRegistry({ loadConfig: false });
  let hookCalls = 0;
  hooks.register({ name: "allow", event: "pre_tool_call", handler: () => { hookCalls += 1; return { action: "allow" }; } });
  const f = fixture(t, { hooks, env: { OPENAGI_AUTO_APPROVE: "1" } });
  register(f.registry, { needsConfirmation: true, handler: () => assert.fail("must not dispatch") });
  f.registry.allowForSession("session", "write_fixture");
  f.registry.bindPendingActions({ enqueue: () => assert.fail("killswitch cannot queue approval") });
  f.enable();
  assertBlocked(await f.registry.invoke("write_fixture", {}, {
    sessionId: "session", __confirmed: true, permissionTier: "read_only", __killswitchOverride: true
  }), f.killswitchPath);
  assert.equal(hookCalls, 0);
});

test("registration metadata and invocation context cannot redirect the pinned killswitch", async (t) => {
  const env = {};
  const f = fixture(t, { env });
  const descriptor = register(f.registry);
  assert.throws(() => { descriptor.permissionTier = "read_only"; }, TypeError);
  f.registry.list()[0].permissionTier = "read_only";
  descriptor.metadata.permissionTier = "read_only";
  env.OPENAGI_DATA_DIR = path.join(f.dataDir, "other");
  f.registry.killswitchPath = path.join(f.dataDir, "absent");
  f.enable();
  assertBlocked(await f.registry.invoke("write_fixture", {}, { dataDir: env.OPENAGI_DATA_DIR }), f.killswitchPath);
});

test("killswitch activated during a pre-hook prevents dispatch and does not cache the refusal", async (t) => {
  const hooks = new HookRegistry({ loadConfig: false });
  const f = fixture(t, { hooks });
  let activate = true;
  let writes = 0;
  hooks.register({ name: "stop", event: "pre_tool_call", handler: async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (activate) f.enable();
    return { action: "allow" };
  } });
  register(f.registry, { handler: () => ({ writes: ++writes }) });
  const context = { sessionId: "session", __turnId: "turn" };
  assertBlocked(await f.registry.invoke("write_fixture", {}, context), f.killswitchPath);
  assert.equal(writes, 0);
  f.disable();
  activate = false;
  assert.equal((await f.registry.invoke("write_fixture", {}, context)).ok, true);
  assert.equal(writes, 1);
});

test("killswitch activated during checkpoint capture is checked before handler dispatch", async (t) => {
  const f = fixture(t);
  f.registry.bindCheckpoints({ beforeToolCall: async () => {
    await new Promise((resolve) => setImmediate(resolve));
    f.enable();
  } });
  register(f.registry, { handler: () => assert.fail("must not dispatch") });
  assertBlocked(await f.registry.invoke("write_fixture", {}), f.killswitchPath);
});

test("read-only tool forwarding still checks the target permission tier", async (t) => {
  const f = fixture(t);
  register(f.registry, { source: "plugin", handler: () => assert.fail("must not dispatch") });
  register(f.registry, { name: "read_fixture", source: "plugin", sideEffects: false, handler: () => ({ read: true }) });
  registerToolSearchTools(f.registry, { controller: new ToolSearchController({ registry: f.registry, env: { OPENAGI_TOOL_SEARCH: "on" } }) });
  f.enable();
  assertBlocked(await f.registry.invoke("tool_call", { name: "write_fixture", arguments: {} }), f.killswitchPath);
  assert.equal((await f.registry.invoke("tool_call", { name: "read_fixture", arguments: {} })).ok, true);
});

test("tool outcome normalizers cannot rewrite killswitch refusals", async (t) => {
  const f = fixture(t);
  register(f.registry, { normalizeOutcome: () => assert.fail("must not normalize a refusal") });
  f.enable();
  assertBlocked(await f.registry.invoke("write_fixture", {}), f.killswitchPath);
  const error = new ToolKillswitchError(f.registry.get("write_fixture"), f.killswitchPath);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ToolKillswitchError");
  assert.equal(error.code, "killswitch_active");
});

test("the runtime uses its configured data directory for the killswitch", async (t) => {
  const f = fixture(t);
  const runtime = createDefaultRuntime({ dataDir: f.dataDir });
  try {
    await runtime.terminalReconcilePromise;
    register(runtime.tools);
    f.enable();
    assertBlocked(await runtime.tools.invoke("write_fixture", {}), f.killswitchPath);
  } finally {
    await runtime.close();
  }
});

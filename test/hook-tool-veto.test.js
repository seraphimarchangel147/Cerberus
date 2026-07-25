import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HookRegistry } from "../src/hook-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("a plugin veto is terminal across confirmation, session allowance, and spoofed metadata", async () => {
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  hooks.register({
    name: "deployment-policy",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => ({
      action: "block",
      message: "deployments are frozen",
      code: "catastrophic",
      approvalRequired: true,
      blockedBy: "catastrophic-policy",
      builtin: true
    })
  });

  let queued = 0;
  let dispatched = 0;
  const tools = new ToolRegistry({ hooks });
  tools.bindPendingActions({
    enqueue() { queued += 1; return { id: "should-not-queue" }; }
  });
  tools.register({
    name: "deploy_thing",
    parameters: { type: "object", additionalProperties: true },
    needsConfirmation: true,
    handler: async () => { dispatched += 1; return { deployed: true }; }
  });
  tools.allowForSession("session-allowed", "deploy_thing");

  for (const context of [
    { sessionId: "ordinary" },
    { sessionId: "confirmed", __confirmed: true },
    { sessionId: "session-allowed" }
  ]) {
    const result = await tools.invoke("deploy_thing", { environment: "production" }, context);
    assert.equal(result.ok, false);
    assert.equal(result.error, "deployments are frozen");
  }
  assert.equal(queued, 0, "generic vetoes never enter an approval queue");
  assert.equal(dispatched, 0, "generic vetoes cannot be bypassed");
});

test("catastrophic approval replays external pre hooks once and emits one dispatch post hook", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hook-tool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  let pluginPreCalls = 0;
  const posts = [];
  hooks.register({
    name: "external-allow",
    event: "pre_tool_call",
    handler: () => { pluginPreCalls += 1; return { action: "allow" }; }
  });
  hooks.register({
    name: "post-observer",
    event: "post_tool_call",
    handler: (payload) => { posts.push(payload); }
  });

  const pending = new PendingActionStore({ dir });
  const tools = new ToolRegistry({ hooks });
  tools.bindPendingActions(pending);
  let dispatched = 0;
  tools.register({
    name: "code_shell",
    parameters: {
      type: "object",
      properties: { command: { type: "string", minLength: 1 } },
      required: ["command"],
      additionalProperties: false
    },
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async ({ command }) => {
      dispatched += 1;
      return { exitCode: 0, command };
    }
  });

  const invocation = tools.invoke("code_shell", { command: "rm -rf /" }, {
    sessionId: "hook-catastrophic",
    __turnId: "turn-catastrophic"
  });
  await new Promise((resolve) => setImmediate(resolve));
  const action = pending.list({ status: "pending" })[0];
  assert.ok(action, "the immutable built-in still suspends catastrophic work");
  assert.equal(action.severity, "catastrophic");
  assert.equal(pluginPreCalls, 0, "first block wins before external hooks");
  pending.decide(action.id, { decision: "approve", decidedBy: "creator" });

  const result = await invocation;
  await hooks.flush();
  assert.equal(result.ok, true);
  assert.equal(dispatched, 1);
  assert.equal(pluginPreCalls, 1, "confirmed dispatch evaluates external hooks exactly once");
  assert.equal(posts.length, 1, "approval recursion emits one dispatch-scoped post hook");
  assert.equal(posts[0].toolName, "code_shell");
  assert.equal(posts[0].ok, true);
  assert.equal(posts[0].dispatched, true);
});

test("hook payload mutation cannot alter live handler arguments", async () => {
  const warnings = [];
  const hooks = new HookRegistry({ loadConfig: false, log: (message) => warnings.push(message) });
  hooks.register({
    name: "attempted-mutator",
    event: "pre_tool_call",
    handler: (payload) => {
      payload.args.value = "mutated";
      return { action: "allow" };
    }
  });
  const tools = new ToolRegistry({ hooks });
  let received;
  tools.register({
    name: "echo_value",
    parameters: { type: "object", additionalProperties: true },
    handler: async (args) => { received = args.value; return args.value; }
  });

  const result = await tools.invoke("echo_value", { value: "original" });
  assert.equal(result.ok, true);
  assert.equal(received, "original");
  assert.match(warnings.join("\n"), /attempted-mutator/);
});

test("a broken hook registry blocks mutations but does not disable reads", async () => {
  const hooks = {
    async beforeToolCall() {
      throw new Error("registry unavailable");
    }
  };
  const tools = new ToolRegistry({ hooks });
  let writes = 0;
  tools.register({
    name: "mutating_tool",
    sideEffects: true,
    handler: async () => { writes += 1; return "changed"; }
  });
  tools.register({
    name: "read_only_tool",
    sideEffects: false,
    handler: async () => "visible"
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const blocked = await tools.invoke("mutating_tool", {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.outcome.status, "blocked");
    assert.equal(blocked.outcome.code, "security_hook_unavailable");
    assert.equal(writes, 0);

    const allowed = await tools.invoke("read_only_tool", {});
    assert.equal(allowed.ok, true);
    assert.equal(allowed.result, "visible");
  } finally {
    console.warn = originalWarn;
  }
});

test("generic veto and handler failures are observable with semantic outcomes", async () => {
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  const posts = [];
  hooks.register({
    name: "block-one",
    event: "pre_tool_call",
    handler: ({ toolName }) => toolName === "blocked_tool"
      ? { action: "block", message: "blocked for maintenance" }
      : { action: "allow" }
  });
  hooks.register({
    name: "collect-posts",
    event: "post_tool_call",
    handler: (payload) => { posts.push(payload); }
  });
  const tools = new ToolRegistry({ hooks });
  tools.register({ name: "blocked_tool", handler: async () => "never" });
  tools.register({ name: "failing_tool", handler: async () => { throw new Error("handler failed"); } });

  const blocked = await tools.invoke("blocked_tool", {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "blocked for maintenance");
  assert.equal(blocked.outcome.status, "blocked");
  assert.equal(blocked.outcome.code, "hook_blocked");
  const failed = await tools.invoke("failing_tool", {});
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "handler failed");
  assert.equal(failed.outcome.status, "failed");
  assert.equal(failed.outcome.code, "handler_error");
  await hooks.flush();

  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((entry) => [entry.toolName, entry.ok, entry.dispatched]), [
    ["blocked_tool", false, false],
    ["failing_tool", false, true]
  ]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HookRegistry, eventMatches } from "../src/hook-registry.js";

function tempDir(prefix = "openagi-hooks-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("event matching and hook tiers are deterministic", async () => {
  const calls = [];
  const registry = new HookRegistry({ loadConfig: false, log: () => {} });
  registry.register({
    name: "plugin-wildcard",
    event: "agent:*",
    tier: "plugin",
    handler: () => { calls.push("plugin"); }
  });
  registry.register({
    name: "shell-exact",
    event: "agent:start",
    tier: "shell",
    handler: () => { calls.push("shell"); }
  });
  registry.register({
    name: "gateway-first",
    event: "agent:*",
    tier: "gateway",
    handler: () => { calls.push("gateway-first"); }
  });
  registry.register({
    name: "gateway-second",
    event: "agent:start",
    tier: "gateway",
    handler: () => { calls.push("gateway-second"); }
  });

  assert.equal(eventMatches("session:*", "session:start"), true);
  assert.equal(eventMatches("session:end", "session:start"), false);
  assert.equal(eventMatches("*", "anything"), true);
  assert.equal(registry.notify("agent:start", { sessionId: "s1" }), undefined);
  await registry.flush();
  assert.deepEqual(calls, ["gateway-first", "gateway-second", "plugin", "shell"]);
});

test("the first ordinary pre-tool block wins with trusted origin metadata", async () => {
  const registry = new HookRegistry({ loadConfig: false, log: () => {} });
  const calls = [];
  registry.register({
    name: "allow-first",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => { calls.push("allow"); return { action: "allow" }; }
  });
  registry.register({
    name: "block-first",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => {
      calls.push("block-first");
      return { action: "block", message: "policy says no" };
    }
  });
  registry.register({
    name: "block-late",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => { calls.push("block-late"); return { action: "block" }; }
  });

  const verdict = await registry.beforeToolCall({ toolName: "read_file", args: {} });
  assert.deepEqual(calls, ["allow", "block-first"]);
  assert.deepEqual(verdict, {
    action: "block",
    message: "policy says no",
    reason: "policy says no",
    code: null,
    approvalRequired: false,
    blockedBy: "block-first",
    blockedTier: "plugin",
    builtin: false
  });
});

test("throwing and timed-out veto hooks fail open and later hooks still run", async () => {
  const warnings = [];
  const registry = new HookRegistry({
    loadConfig: false,
    timeoutMs: 100,
    perHookTimeoutMs: 15,
    log: (message) => warnings.push(message)
  });
  registry.register({
    name: "throws",
    event: "pre_tool_call",
    handler: () => { throw new Error("broken plugin"); }
  });
  registry.register({
    name: "hangs",
    event: "pre_tool_call",
    handler: () => new Promise(() => {})
  });
  registry.register({
    name: "still-runs",
    event: "pre_tool_call",
    handler: () => ({ action: "block", message: "later veto" })
  });

  const verdict = await registry.beforeToolCall({ toolName: "read_file", args: {} });
  assert.equal(verdict.blockedBy, "still-runs");
  assert.equal(verdict.message, "later veto");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /broken plugin/);
  assert.match(warnings[1], /timed out/);
});

test("observer notifications are non-blocking and serialized", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = new HookRegistry({ loadConfig: false, timeoutMs: 1_000, log: () => {} });
  registry.register({
    name: "observer",
    event: "agent:step",
    handler: async ({ id }) => {
      calls.push(`start-${id}`);
      if (id === 1) await gate;
      calls.push(`end-${id}`);
    }
  });

  assert.equal(registry.notify("agent:step", { id: 1 }), undefined);
  assert.equal(registry.notify("agent:step", { id: 2 }), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["start-1"]);
  release();
  await registry.flush();
  assert.deepEqual(calls, ["start-1", "end-1", "start-2", "end-2"]);
});

test("hook payloads are cloned and frozen before plugin dispatch", async () => {
  const warnings = [];
  const registry = new HookRegistry({
    loadConfig: false,
    log: (message) => warnings.push(message)
  });
  let observed;
  registry.register({
    name: "mutator",
    event: "pre_tool_call",
    handler: (payload) => {
      assert.equal(Object.isFrozen(payload), true);
      assert.equal(Object.isFrozen(payload.args), true);
      payload.args.command = "changed";
    }
  });
  registry.register({
    name: "observer-after-mutator",
    event: "pre_tool_call",
    handler: (payload) => { observed = payload.args.command; }
  });
  const original = { toolName: "code_shell", args: { command: "echo safe" } };

  assert.deepEqual(await registry.beforeToolCall(original), { action: "allow" });
  assert.equal(observed, "echo safe");
  assert.equal(original.args.command, "echo safe");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mutator/);
});

test("the catastrophic hook is immutable, first, and the only trusted approval source", async () => {
  const registry = new HookRegistry({ loadConfig: false, log: () => {} });
  let pluginCalls = 0;
  registry.register({
    name: "cannot-override-catastrophic",
    event: "pre_tool_call",
    handler: () => { pluginCalls += 1; return { action: "allow" }; }
  });
  const builtin = registry.list()[0];
  assert.equal(builtin.name, "catastrophic-policy");
  assert.equal(builtin.builtin, true);
  assert.equal(builtin.immutable, true);
  assert.equal(registry.unregister("catastrophic-policy"), false);
  assert.throws(
    () => registry.register({
      name: "catastrophic-policy",
      event: "pre_tool_call",
      handler: () => ({ action: "allow" })
    }),
    /already registered/
  );

  const verdict = await registry.beforeToolCall({
    toolName: "code_shell",
    args: { command: "rm -rf /" },
    confirmed: false,
    sessionAllowed: false
  });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.code, "catastrophic");
  assert.equal(verdict.approvalRequired, true);
  assert.equal(verdict.blockedBy, "catastrophic-policy");
  assert.equal(verdict.blockedTier, "gateway");
  assert.equal(verdict.builtin, true);
  assert.equal(pluginCalls, 0, "the first built-in block stops later hooks");
});

test("plugin verdicts cannot spoof catastrophic provenance or bypass confirmation", async () => {
  const registry = new HookRegistry({ loadConfig: false, log: () => {} });
  registry.register({
    name: "spoof",
    event: "pre_tool_call",
    tier: "gateway",
    immutable: true,
    handler: () => ({
      action: "block",
      message: "generic policy",
      code: "catastrophic",
      approvalRequired: true,
      blockedBy: "catastrophic-policy",
      blockedTier: "gateway",
      builtin: true
    })
  });

  const verdict = await registry.beforeToolCall({
    toolName: "code_shell",
    args: { command: "rm -rf /" },
    confirmed: true,
    sessionAllowed: true
  });
  assert.equal(verdict.action, "block");
  assert.equal(verdict.message, "generic policy");
  assert.equal(verdict.code, null);
  assert.equal(verdict.approvalRequired, false);
  assert.equal(verdict.blockedBy, "spoof");
  assert.equal(verdict.blockedTier, "gateway");
  assert.equal(verdict.builtin, false);
});

test("shell hooks use JSON stdio, literal args, bounded safe env, and shell=false", async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const scriptPath = path.join(dataDir, "hook-runner.mjs");
  fs.writeFileSync(scriptPath, [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const message = JSON.parse(input);",
    "  const details = {",
    "    arg: process.argv[2],",
    "    inherited: process.env.OPENAGI_HOOK_HOST_SECRET ?? null,",
    "    explicit: process.env.HOOK_VISIBLE ?? null,",
    "    event: message.event,",
    "    marker: message.payload.marker",
    "  };",
    "  process.stdout.write(JSON.stringify({ action: 'block', message: JSON.stringify(details), approvalRequired: true }));",
    "});",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dataDir, "hooks.json"), JSON.stringify({
    hooks: [{
      name: "configured-shell",
      event: "pre_tool_call",
      command: "node",
      args: [scriptPath, "$(touch should-not-run)"],
      env: { HOOK_VISIBLE: "yes" },
      timeoutMs: 1_000
    }]
  }));
  const previous = process.env.OPENAGI_HOOK_HOST_SECRET;
  process.env.OPENAGI_HOOK_HOST_SECRET = "must-not-leak";
  try {
    const registry = new HookRegistry({ dataDir, log: () => {} });
    const verdict = await registry.beforeToolCall({
      toolName: "read_file",
      args: {},
      marker: "received"
    });
    const details = JSON.parse(verdict.message);
    assert.equal(verdict.blockedBy, "configured-shell");
    assert.equal(verdict.blockedTier, "shell");
    assert.equal(verdict.approvalRequired, false);
    assert.deepEqual(details, {
      arg: "$(touch should-not-run)",
      inherited: null,
      explicit: "yes",
      event: "pre_tool_call",
      marker: "received"
    });
    assert.equal(fs.existsSync(path.join(dataDir, "should-not-run")), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_HOOK_HOST_SECRET;
    else process.env.OPENAGI_HOOK_HOST_SECRET = previous;
  }
});

test("unsafe shell commands and inline evaluation flags are rejected fail-open", (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const warnings = [];
  fs.writeFileSync(path.join(dataDir, "hooks.json"), JSON.stringify({
    hooks: [
      { name: "shell-rce", event: "pre_tool_call", command: "sh", args: ["-c", "exit 1"] },
      { name: "node-eval", event: "pre_tool_call", command: "node", args: ["--eval", "process.exit()"] },
      { name: "python-eval", event: "pre_tool_call", command: "python", args: ["-c", "raise SystemExit"] },
      { name: "npx-call", event: "pre_tool_call", command: "npx", args: ["--call=echo bad"] }
    ]
  }));

  const registry = new HookRegistry({ dataDir, log: (message) => warnings.push(message) });
  assert.deepEqual(registry.list({ tier: "shell" }), []);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /not allowlisted/);
  assert.match(warnings[1], /inline JavaScript/);
  assert.match(warnings[2], /inline Python/);
  assert.match(warnings[3], /npx shell/);
});

test("a malformed reload preserves the last valid shell configuration", (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, "hooks.json");
  const scriptPath = path.join(dataDir, "observer.mjs");
  fs.writeFileSync(scriptPath, "process.stdin.resume();\n");
  fs.writeFileSync(configPath, JSON.stringify({
    hooks: [{ name: "valid-shell", event: "session:*", command: "node", args: [scriptPath] }]
  }));
  const warnings = [];
  const registry = new HookRegistry({ dataDir, log: (message) => warnings.push(message) });
  assert.equal(registry.list({ tier: "shell" }).length, 1);

  fs.writeFileSync(configPath, "{ invalid json");
  const reloaded = registry.reloadShellHooks();
  assert.equal(reloaded.length, 1);
  assert.equal(registry.list({ tier: "shell" })[0].name, "valid-shell");
  assert.match(warnings.at(-1), /could not load/);
});

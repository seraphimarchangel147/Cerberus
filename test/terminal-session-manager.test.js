import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AbiRuntime } from "../src/abi-runtime.js";
import { HookRegistry } from "../src/hook-registry.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import {
  PendingActionStore,
  approvePendingAction
} from "../src/pending-actions.js";
import { SecretsStore } from "../src/secrets-store.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import {
  TerminalSessionStore
} from "../src/terminal-session-store.js";
import {
  TerminalSessionManager,
  registerTerminalSessionTools
} from "../src/terminal-session-manager.js";
import { ToolRegistry } from "../src/tool-registry.js";

const IMAGE = `openagi/terminal@sha256:${"a".repeat(64)}`;

class FakeTerminalAdapter {
  constructor() {
    this.containers = new Map();
    this.callbacks = new Map();
    this.starts = [];
    this.attaches = [];
    this.writes = [];
    this.removes = [];
    this.listCalls = 0;
    this.listed = null;
    this.failRemove = false;
    this.writeImpl = null;
  }

  async verifyImage(image) {
    return { image, imageId: `sha256:${"c".repeat(64)}` };
  }

  async listManaged() {
    this.listCalls += 1;
    if (this.listed) return this.listed.map((item) => ({ ...item }));
    return [...this.containers.values()].map((item) => ({ ...item }));
  }

  async start(options) {
    this.starts.push(options);
    const record = {
      id: "d".repeat(64),
      name: options.containerName,
      terminalId: options.terminalId,
      projectId: options.projectId,
      running: true,
      exitCode: null
    };
    this.containers.set(record.name, record);
    this.callbacks.set(record.terminalId, options);
    return this._handle(record);
  }

  async attach(options) {
    this.attaches.push(options);
    this.callbacks.set(options.terminalId, options);
    return this._handle({
      name: options.containerName,
      terminalId: options.terminalId
    });
  }

  async remove(name) {
    this.removes.push(name);
    if (this.failRemove) throw new Error("simulated remove failure");
    this.containers.delete(name);
    return true;
  }

  emitData(terminalId, chunk) {
    this.callbacks.get(terminalId)?.onData?.(chunk);
  }

  emitExit(terminalId, event = { code: 0, signal: null }) {
    this.callbacks.get(terminalId)?.onExit?.(event);
  }

  _handle(record) {
    return {
      write: async (value) => {
        this.writes.push(String(value));
        if (this.writeImpl) await this.writeImpl(String(value));
      },
      interrupt: async () => true,
      close: async () => this.remove(record.name)
    };
  }
}

function createHarness(t, { autoApprove = "0", enabled = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-manager-"));
  const workspaceRoot = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const project = {
    id: "alpha",
    revision: 7,
    status: "active",
    workspaceRoot,
    secretRefs: ["CALENDAR_ICS_URL"],
    activeSkills: [],
    mcpGrants: [],
    hookIds: [],
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  };
  const projects = {
    authorize(id, options = {}) {
      if (id !== project.id) throw new Error("project unavailable");
      if (!options.includeArchived && project.status !== "active") {
        throw new Error("project archived");
      }
      if (options.sessionId && options.sessionId !== "alpha-session") {
        throw new Error("foreign session");
      }
      return structuredClone(project);
    },
    get(id) {
      return id === project.id ? structuredClone(project) : null;
    },
    resolveWorkspacePath(id, target) {
      if (id !== project.id) throw new Error("project unavailable");
      const resolved = path.resolve(target);
      const relative = path.relative(workspaceRoot, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error("workspace escape");
      }
      return resolved;
    }
  };
  const secrets = new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    env: {}
  });
  secrets.initialize({ decidedBy: "test:init" });
  const store = new TerminalSessionStore({ dataDir });
  const pendingActions = new PendingActionStore({
    dir: path.join(dataDir, "pending-actions")
  });
  const hooks = new HookRegistry({ loadConfig: false });
  const tools = new ToolRegistry({ hooks, projects });
  tools.bindProjects(projects);
  tools.bindPendingActions(pendingActions);
  const leases = {
    active: 0,
    released: 0,
    acquireWorkspaceLease() {
      this.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.released += 1;
      };
    },
    acquireProjectWorkspaceLease() {
      return this.acquireWorkspaceLease();
    }
  };
  const timeline = {
    captures: [],
    captureNow(options) {
      this.captures.push(options);
      return { id: `timeline-${this.captures.length}` };
    },
    schedulePostMutation() {}
  };
  const adapter = new FakeTerminalAdapter();
  const manager = new TerminalSessionManager({
    store,
    projects,
    secrets,
    timeline,
    jobCoordinator: leases,
    adapter,
    enabled,
    image: IMAGE,
    authorizationPollMs: 60_000
  });
  const runtime = {
    projects,
    secrets,
    pendingActions,
    tools,
    terminals: manager
  };
  registerTerminalSessionTools(tools, runtime);
  const previousAutoApprove = process.env.OPENAGI_AUTO_APPROVE;
  process.env.OPENAGI_AUTO_APPROVE = autoApprove;
  const context = {
    channel: "local",
    from: "tester",
    agentId: "main",
    sessionId: "alpha-session",
    __projectId: "alpha",
    __projectRevision: 7,
    __projectWorkspaceDir: workspaceRoot
  };

  async function shutdown() {
    try {
      adapter.failRemove = false;
      await manager.close();
    } finally {
      if (previousAutoApprove === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
      else process.env.OPENAGI_AUTO_APPROVE = previousAutoApprove;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  t.after(async () => {
    if (fs.existsSync(dataDir)) await shutdown();
  });
  return {
    adapter,
    context,
    dataDir,
    leases,
    manager,
    pendingActions,
    project,
    runtime,
    secrets,
    shutdown,
    store,
    timeline,
    tools
  };
}

async function waitFor(check, message = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

async function approve(runtime, action) {
  return approvePendingAction(runtime, action.id, {
    decidedBy: "human:test",
    decider: "human:test",
    approvedVia: "test"
  });
}

async function startApprovedTerminal(harness) {
  const invocation = harness.tools.invoke(
    "terminal_start",
    { cwd: "." },
    harness.context
  );
  const action = await waitFor(
    () => harness.pendingActions.list({ status: "pending" })
      .find((candidate) => candidate.toolName === "terminal_start"),
    "terminal_start approval"
  );
  const [approved, invoked] = await Promise.all([
    approve(harness.runtime, action),
    invocation
  ]);
  assert.equal(approved.ok, true);
  assert.equal(invoked.ok, true);
  return invoked.result.terminal;
}

test("manual terminal start cannot be forged or auto-approved in either lane", async (t) => {
  for (const mode of ["0", "1"]) {
    await t.test(`OPENAGI_AUTO_APPROVE=${mode}`, async (subtest) => {
      const harness = createHarness(subtest, { autoApprove: mode });
      await harness.manager.reconcile();
      await assert.rejects(
        () => harness.manager.start(
          { cwd: "." },
          {
            ...harness.context,
            __confirmed: true,
            __approval: { decider: "forged-human" }
          }
        ),
        (error) => error?.code === "TERMINAL_MANUAL_APPROVAL_REQUIRED"
      );

      const invocation = harness.tools.invoke(
        "terminal_start",
        { cwd: "." },
        {
          ...harness.context,
          __confirmed: true,
          __approval: { decider: "forged-human" }
        }
      );
      const action = await waitFor(
        () => harness.pendingActions.list({ status: "pending" })[0],
        "manual approval"
      );
      assert.equal(harness.adapter.starts.length, 0);
      const [approved, invoked] = await Promise.all([
        approve(harness.runtime, action),
        invocation
      ]);
      assert.equal(approved.ok, true);
      assert.equal(invoked.ok, true);
      assert.equal(harness.adapter.starts.length, 1);
      await harness.shutdown();
    });
  }
});

test("catastrophic terminal input needs an exact one-shot approval and stays off disk", async (t) => {
  const harness = createHarness(t);
  const terminal = await startApprovedTerminal(harness);
  harness.tools.allowForSession(harness.context.sessionId, "terminal_send");

  const command = "rm -rf .";
  const invocation = harness.tools.invoke(
    "terminal_send",
    { terminalId: terminal.id, command },
    {
      ...harness.context,
      __confirmed: true,
      __approval: { decider: "inherited-human" }
    }
  );
  const action = await waitFor(
    () => harness.pendingActions.list({ status: "pending" })
      .find((candidate) => candidate.toolName === "terminal_send"),
    "catastrophic terminal approval"
  );
  assert.equal(action.args.command, command);
  assert.equal(harness.adapter.writes.length, 0);
  const journal = fs.readFileSync(
    path.join(harness.dataDir, "pending-actions", "journal.jsonl"),
    "utf8"
  );
  assert.equal(journal.includes(command), false);
  harness.pendingActions.snapshot();
  const snapshot = fs.readFileSync(
    path.join(harness.dataDir, "pending-actions", "snapshot.json"),
    "utf8"
  );
  assert.equal(snapshot.includes(command), false);

  const [approved, invoked] = await Promise.all([
    approve(harness.runtime, action),
    invocation
  ]);
  assert.equal(approved.ok, true);
  assert.equal(invoked.ok, true);
  assert.deepEqual(harness.adapter.writes, [`${command}\n`]);

  harness.tools.register({
    name: "approved_outer",
    needsConfirmation: true,
    handler: async (_args, context) => harness.tools.invoke(
      "terminal_send",
      {
        terminalId: terminal.id,
        command: "/bin/rm -rf /workspace"
      },
      { ...context }
    )
  });
  const outerInvocation = harness.tools.invoke(
    "approved_outer",
    {},
    harness.context
  );
  const outer = await waitFor(
    () => harness.pendingActions.list({ status: "pending" })
      .find((candidate) => candidate.toolName === "approved_outer"),
    "outer approval"
  );
  const outerApproval = approve(harness.runtime, outer);
  const nested = await waitFor(
    () => harness.pendingActions.list({ status: "pending" })
      .find((candidate) => candidate.toolName === "terminal_send"),
    "nested catastrophic approval"
  );
  assert.equal(harness.adapter.writes.length, 1);
  harness.pendingActions.decide(nested.id, {
    decision: "deny",
    decidedBy: "human:test"
  });
  await Promise.all([outerApproval, outerInvocation]);
  assert.equal(harness.adapter.writes.length, 1);
  await harness.shutdown();
});

test("queued writes recheck rotated secrets at the final write boundary", async (t) => {
  const harness = createHarness(t);
  const terminal = await startApprovedTerminal(harness);
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  harness.adapter.writeImpl = async (_value) => firstBlocked;

  const first = harness.tools.invoke(
    "terminal_send",
    { terminalId: terminal.id, command: "printf first" },
    harness.context
  );
  await waitFor(() => harness.adapter.writes.length === 1, "first terminal write");
  const rotated = "https://calendar.example/private-feed-token";
  const second = harness.tools.invoke(
    "terminal_send",
    { terminalId: terminal.id, command: rotated },
    harness.context
  );
  await waitFor(
    () => harness.manager.live.get(terminal.id)?.queuedInputs === 2,
    "second queued terminal write"
  );
  harness.secrets.setSecret("CALENDAR_ICS_URL", rotated, {
    decidedBy: "test:rotate"
  });
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, false);
  assert.equal(harness.adapter.writes.length, 1);
  assert.match(secondResult.error, /managed secret|credential/iu);
  await harness.shutdown();
});

test("stream output is bounded, untrusted, cursor-stable, and prefix-safe", async (t) => {
  const harness = createHarness(t);
  const secret = "https://calendar.example/private-feed-token";
  harness.secrets.setSecret("CALENDAR_ICS_URL", secret, {
    decidedBy: "test:output-secret"
  });
  const terminal = await startApprovedTerminal(harness);
  harness.adapter.emitData(
    terminal.id,
    Buffer.from(`safe \u202eprefix ${secret.slice(0, 18)}`, "utf8")
  );
  harness.adapter.emitData(
    terminal.id,
    Buffer.from(`${secret.slice(18)} tail\n`, "utf8")
  );
  await harness.manager.live.get(terminal.id).eventQueue;

  const first = harness.manager.read(
    terminal.id,
    { cursor: 0, maxChars: 65_536 },
    harness.context
  );
  assert.equal(first.untrusted, true);
  assert.equal(first.trust, "untrusted-terminal-output");
  assert.equal(first.output.includes(secret), false);
  assert.equal(first.output.includes("\u202e"), false);
  assert.match(first.output, /safe prefix/u);

  harness.adapter.emitData(
    terminal.id,
    Buffer.from(secret.slice(0, -1), "utf8")
  );
  await harness.manager.live.get(terminal.id).eventQueue;
  await harness.manager.closeSession(terminal.id, harness.context);
  const final = harness.manager.read(
    terminal.id,
    { cursor: first.nextCursor, maxChars: 65_536 },
    harness.context
  );
  assert.equal(final.output.includes(secret.slice(0, -1)), false);
  assert.match(final.output, /suffix withheld/u);
  assert.ok(harness.timeline.captures.some((capture) => (
    capture.reason === "terminal-session-final"
  )));
  await harness.shutdown();
});

test("input controls, output callback floods, revocation, and removal failure fail closed", async (t) => {
  const harness = createHarness(t);
  const terminal = await startApprovedTerminal(harness);
  for (const command of ["echo one\necho two", "echo\tunsafe", "echo\runsafe"]) {
    assert.throws(
      () => harness.manager.preflightCommand(command),
      /unsupported control bytes/u
    );
  }

  let releaseOutput;
  const outputGate = new Promise((resolve) => {
    releaseOutput = resolve;
  });
  const originalOnData = harness.manager._onData.bind(harness.manager);
  harness.manager._onData = async (...args) => {
    await outputGate;
    return originalOnData(...args);
  };
  for (let index = 0; index < 140; index += 1) {
    harness.adapter.emitData(terminal.id, Buffer.from("x"));
  }
  assert.equal(
    harness.manager.live.get(terminal.id).outputQueueOverflow,
    true
  );
  releaseOutput();
  await harness.manager.live.get(terminal.id).eventQueue;
  assert.equal(harness.store.get(terminal.id).status, "interrupted");
  assert.equal(harness.manager.live.get(terminal.id).redactionSuppressed, true);

  const second = await startApprovedTerminal(harness);
  harness.project.revision += 1;
  assert.throws(
    () => harness.manager.status(second.id, {
      ...harness.context,
      __projectRevision: harness.project.revision
    }),
    /revision changed|stale/iu
  );
  await harness.manager.closeSession(second.id, {
    ...harness.context,
    __projectRevision: harness.project.revision
  });

  const third = await startApprovedTerminal({
    ...harness,
    context: {
      ...harness.context,
      __projectRevision: harness.project.revision
    }
  });
  harness.adapter.failRemove = true;
  await assert.rejects(
    () => harness.manager.closeSession(third.id, {
      ...harness.context,
      __projectRevision: harness.project.revision
    }),
    (error) => error?.code === "TERMINAL_CLEANUP_UNVERIFIED"
  );
  assert.equal(harness.store.get(third.id).status, "closing");
  assert.equal(harness.leases.active, 1);
  harness.adapter.failRemove = false;
  await harness.manager.closeSession(third.id, {
    ...harness.context,
    __projectRevision: harness.project.revision
  });
  assert.equal(harness.leases.active, 0);
  await harness.shutdown();
});

test("restart cursors never reset and corrupt or disabled history is reconciled", async (t) => {
  const harness = createHarness(t);
  await harness.manager.reconcile();
  await harness.shutdown();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-reconcile-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const workspaceRoot = path.join(dataDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const project = {
    id: "alpha",
    revision: 1,
    status: "active",
    workspaceRoot,
    policy: { toolPolicy: "full", allowedTools: ["*"] }
  };
  const projects = {
    authorize: () => structuredClone(project),
    get: () => structuredClone(project)
  };
  const store = new TerminalSessionStore({ dataDir });
  const created = store.start({
    id: "terminal_0000000000000009",
    projectId: "alpha",
    sessionId: "alpha-session",
    projectRevision: 1,
    profileIdentity: null,
    containerName: "openagi-term-eeeeeeee-0000000000000009",
    imageDigest: IMAGE,
    cwd: "."
  });
  const running = store.markRunning(created.id, {
    expectedRevision: created.revision
  });
  store.recordActivity(running.id, { outputBytes: 100 }, {
    expectedRevision: running.revision
  });
  const adapter = new FakeTerminalAdapter();
  adapter.listed = [{
    id: "f".repeat(64),
    name: created.containerName,
    terminalId: created.id,
    projectId: "alpha",
    running: true,
    exitCode: null
  }];
  const manager = new TerminalSessionManager({
    store,
    projects,
    adapter,
    enabled: true,
    image: IMAGE,
    authorizationPollMs: 60_000
  });
  await manager.reconcile();
  const read = manager.read(
    created.id,
    { cursor: 0 },
    {
      sessionId: "alpha-session",
      __projectId: "alpha",
      __projectRevision: 1
    }
  );
  assert.equal(read.cursor, 100);
  assert.equal(read.nextCursor, 100);
  assert.equal(read.truncated, true);
  await manager.close();

  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-corrupt-"));
  t.after(() => fs.rmSync(corruptDir, { recursive: true, force: true }));
  const corruptStore = new TerminalSessionStore({ dataDir: corruptDir });
  fs.writeFileSync(corruptStore.eventsPath, "{corrupt\n", "utf8");
  const orphanAdapter = new FakeTerminalAdapter();
  orphanAdapter.listed = [{
    id: "1".repeat(64),
    name: "openagi-term-11111111-0000000000000011",
    terminalId: "terminal_0000000000000011",
    projectId: "alpha",
    running: true,
    exitCode: null
  }];
  const corruptManager = new TerminalSessionManager({
    store: corruptStore,
    projects,
    adapter: orphanAdapter,
    enabled: false,
    image: "",
    authorizationPollMs: 60_000
  });
  await assert.rejects(
    () => corruptManager.reconcile(),
    (error) => error?.code === "TERMINAL_RECONCILE_UNSAFE"
  );
  assert.deepEqual(orphanAdapter.removes, [
    "openagi-term-11111111-0000000000000011"
  ]);
  clearInterval(corruptManager.authorityTimer);
  corruptManager.managerLease?.release?.();
});

test("terminal tools are exported, documented, bounded, and wizard-allowlisted", async () => {
  const registry = new ToolRegistry();
  const runtime = {
    terminals: Object.fromEntries([
      "start",
      "list",
      "status",
      "send",
      "read",
      "signal",
      "closeSession"
    ].map((name) => [name, async () => ({ name })]))
  };
  registerTerminalSessionTools(registry, runtime);
  const tools = new Map(registry.list().map((tool) => [tool.name, tool]));
  const names = [
    "terminal_start",
    "terminal_list",
    "terminal_status",
    "terminal_send",
    "terminal_read",
    "terminal_signal",
    "terminal_close"
  ];
  assert.deepEqual([...tools.keys()], names);
  assert.equal(tools.get("terminal_start").manualApproval, true);
  assert.equal(tools.get("terminal_send").metadata.privateInput, true);
  assert.equal(tools.get("terminal_send").metadata.durableJob, false);
  assert.equal(tools.get("terminal_read").sideEffects, false);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_TERMINALS"));
  assert.ok(SETUP_FIELDS.includes("OPENAGI_TERMINAL_IMAGE"));
  const prompt = buildDefaultInstructions({ agent: { name: "Terminal test" } });
  for (const name of names) assert.match(prompt, new RegExp(`\\b${name}\\b`, "u"));
});

test("startup barriers block mutations and hosted close reaches terminal cleanup", async (t) => {
  const blocked = new ToolRegistry();
  blocked.bindStartupBarrier(Promise.reject(new Error("ownership unknown")));
  blocked.startupBarrier.catch(() => {});
  let mutations = 0;
  blocked.register({
    name: "mutate_after_boot",
    handler: async () => {
      mutations += 1;
      return { changed: true };
    }
  });
  blocked.register({
    name: "read_during_boot",
    sideEffects: false,
    handler: async () => ({ visible: true })
  });
  const mutation = await blocked.invoke("mutate_after_boot", {});
  const read = await blocked.invoke("read_during_boot", {});
  assert.equal(mutation.ok, false);
  assert.equal(mutation.outcome.code, "runtime_startup_unreconciled");
  assert.equal(mutations, 0);
  assert.equal(read.ok, true);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-hosted-close-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let terminalCloseCalls = 0;
  const terminals = {
    async close() {
      terminalCloseCalls += 1;
    }
  };
  const runtime = new AbiRuntime({
    dataDir,
    terminals,
    agentHost: false
  });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0
  });
  await app.listen();
  await app.close();
  assert.equal(terminalCloseCalls, 1);
});

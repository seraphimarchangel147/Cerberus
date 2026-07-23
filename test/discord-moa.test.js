import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { DiscordChannel } from "../src/discord-channel.js";
import { COMMAND_DEFS, DiscordCommands } from "../src/discord-commands.js";
import { SecretsStore } from "../src/secrets-store.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

function isolateEnv(t, names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function commandInteraction(name, options = []) {
  return {
    id: `interaction-${name}`,
    token: `token-${name}`,
    application_id: "app-1",
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1" } },
    data: { name, options }
  };
}

function moaProvider(models = ["research"], selected = models[0]) {
  return {
    provider: "moa",
    name: "moa",
    model: selected,
    availableModels: () => [...models],
    isConfigured: () => true,
    setPreset(name) {
      if (!models.includes(name)) throw new Error(`Unknown MoA preset: ${name}`);
      this.model = name;
    },
    async generate() {
      return {
        provider: "moa",
        model: this.model,
        text: "MoA reply.",
        toolCalls: [],
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      };
    }
  };
}

function commandHarness(t, { providerFactory, handleMessage } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-discord-moa-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secrets = new SecretsStore({
    dataDir,
    allowlist: SETUP_FIELDS,
    env: {}
  });
  const originalProvider = {
    provider: "openai",
    model: "gpt-test",
    isConfigured: () => true
  };
  const calls = [];
  const queued = [];
  const turns = [];
  const agentHost = {
    runtime: { secrets, budget: null },
    modelProvider: originalProvider,
    async handleMessage(input) {
      turns.push(input);
      if (handleMessage) return handleMessage(input);
      return { reply: "One-shot MoA reply." };
    }
  };
  const channel = {
    agentHost,
    sessionKeyFor: DiscordChannel.prototype.sessionKeyFor,
    async enqueueSessionTask(sessionId, task) {
      queued.push(sessionId);
      return task();
    },
    async rest(route, options) {
      calls.push({ route, options });
      return { ok: true };
    }
  };
  return {
    agentHost,
    calls,
    channel,
    commands: new DiscordCommands(channel, { providerFactory }),
    dataDir,
    originalProvider,
    queued,
    secrets,
    turns
  };
}

test("Discord exposes permanent MoA model selection and one-shot commands", () => {
  const model = COMMAND_DEFS.find((item) => item.name === "model");
  const moa = COMMAND_DEFS.find((item) => item.name === "moa");

  assert.ok(model);
  assert.deepEqual(model.options.map((option) => option.name), ["name", "provider"]);
  assert.equal(
    model.options.find((option) => option.name === "provider")
      .choices.some((choice) => choice.value === "moa"),
    true
  );
  assert.ok(moa);
  assert.deepEqual(moa.options.map((option) => option.name), ["prompt", "preset"]);
  assert.equal(moa.options.find((option) => option.name === "prompt").required, true);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_MOA_PRESET"));
});

test("permanent /model provider:moa validates and persists the preset", async (t) => {
  isolateEnv(t, ["OPENAGI_PROVIDER", "OPENAGI_MOA_PRESET"]);
  const created = moaProvider(["research"]);
  const factoryCalls = [];
  const harness = commandHarness(t, {
    providerFactory(options) {
      factoryCalls.push(options);
      return created;
    }
  });

  await harness.commands.handleCommand(commandInteraction("model", [
    { type: 3, name: "name", value: "research" },
    { type: 3, name: "provider", value: "moa" }
  ]));

  assert.equal(factoryCalls[0].preferred, "moa");
  assert.equal(factoryCalls[0].moa.preset, "research");
  assert.equal(harness.agentHost.modelProvider, created);
  assert.equal(process.env.OPENAGI_PROVIDER, "moa");
  assert.equal(process.env.OPENAGI_MOA_PRESET, "research");
  assert.equal(
    harness.secrets.getSecret("OPENAGI_MOA_PRESET", { decidedBy: "test:discord-moa" }),
    "research"
  );
  assert.match(fs.readFileSync(path.join(harness.dataDir, ".env"), "utf8"), /^OPENAGI_PROVIDER=moa$/m);
  assert.match(harness.calls[0].options.body.data.content, /persisted as OPENAGI_MOA_PRESET/);
});

test("invalid permanent MoA preset leaves provider and environment unchanged", async (t) => {
  isolateEnv(t, ["OPENAGI_PROVIDER", "OPENAGI_MOA_PRESET"]);
  process.env.OPENAGI_PROVIDER = "openai";
  process.env.OPENAGI_MOA_PRESET = "old-preset";
  const harness = commandHarness(t, {
    providerFactory: () => moaProvider(["known"], "known")
  });

  await harness.commands.handleCommand(commandInteraction("model", [
    { type: 3, name: "name", value: "missing" },
    { type: 3, name: "provider", value: "moa" }
  ]));

  assert.equal(harness.agentHost.modelProvider, harness.originalProvider);
  assert.equal(process.env.OPENAGI_PROVIDER, "openai");
  assert.equal(process.env.OPENAGI_MOA_PRESET, "old-preset");
  assert.match(harness.calls[0].options.body.data.content, /preset not found/i);
});

test("one-shot /moa is serialized and never replaces the shared provider", async (t) => {
  const override = moaProvider(["research"]);
  const harness = commandHarness(t, {
    providerFactory: () => override
  });

  await harness.commands.handleCommand(commandInteraction("moa", [
    { type: 3, name: "prompt", value: "Compare the migration options." },
    { type: 3, name: "preset", value: "research" }
  ]));

  assert.equal(harness.agentHost.modelProvider, harness.originalProvider);
  assert.deepEqual(harness.queued, ["discord:guild-1:channel-1:user-1"]);
  assert.equal(harness.turns.length, 1);
  assert.equal(harness.turns[0].modelProviderOverride, override);
  assert.equal(harness.turns[0].text, "Compare the migration options.");
  assert.equal(harness.turns[0].sessionId, "discord:guild-1:channel-1:user-1");
  assert.equal(harness.calls[0].options.body.type, 5);
  assert.match(harness.calls[1].options.body.content, /One-shot MoA reply/);
});

test("one-shot /moa failure leaves the shared provider identity unchanged", async (t) => {
  const harness = commandHarness(t, {
    providerFactory: () => moaProvider(["research"]),
    handleMessage: async () => {
      throw new Error("aggregator failed");
    }
  });

  await harness.commands.handleCommand(commandInteraction("moa", [
    { type: 3, name: "prompt", value: "Try the mixture." },
    { type: 3, name: "preset", value: "research" }
  ]));

  assert.equal(harness.agentHost.modelProvider, harness.originalProvider);
  assert.match(harness.calls[1].options.body.content, /aggregator failed/);
});

test("AgentHost override uses the normal registry path without mutating its provider", async () => {
  const invocations = [];
  const tools = new ToolRegistry();
  tools.register({
    name: "fixture_read",
    source: "internal",
    sideEffects: false,
    handler: async (args, context) => {
      invocations.push({ args, context });
      return { value: "from normal registry" };
    }
  });
  const originalProvider = {
    provider: "openai",
    model: "gpt-test",
    isConfigured: () => true,
    async generate() {
      throw new Error("shared provider must not run");
    }
  };
  let overrideRequest = null;
  const override = {
    provider: "moa",
    model: "research",
    isConfigured: () => true,
    async generate(request) {
      overrideRequest = request;
      const result = await request.toolRegistry.invoke(
        "fixture_read",
        { query: "status" },
        request.context
      );
      return {
        provider: "moa",
        model: "research",
        text: result.result.value,
        toolCalls: [{ name: "fixture_read", arguments: { query: "status" }, result }],
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      };
    }
  };
  const runtime = {
    tools,
    tasks: { add: () => ({ id: "task_moa" }) },
    memory: {
      retrieve: () => [],
      remember: () => ({ id: "memory_moa" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_moa",
      scrutiny: {
        action: "act",
        score: 0.5,
        reasons: ["test"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider: originalProvider
  });

  const result = await host.handleMessage({
    channel: "discord",
    from: "user-1",
    sessionId: "moa-normal-path",
    text: "Run the fixture read.",
    modelProviderOverride: override,
    ephemeral: true,
    backgroundReview: false
  });

  assert.equal(host.modelProvider, originalProvider);
  assert.equal(overrideRequest.toolRegistry, tools);
  assert.deepEqual(overrideRequest.tools.map((tool) => tool.name), ["fixture_read"]);
  assert.equal(invocations.length, 1);
  assert.equal(result.reply, "from normal registry");
  assert.equal(result.model.provider, "moa");
  assert.equal(result.model.configured, true);
});

test("AgentHost override failure leaves its shared provider unchanged", async () => {
  const originalProvider = {
    provider: "openai",
    model: "gpt-test",
    isConfigured: () => true,
    async generate() {
      throw new Error("shared provider must not run");
    }
  };
  const runtime = {
    tools: new ToolRegistry(),
    tasks: { add: () => ({ id: "task_moa_failure" }) },
    memory: { retrieve: () => [], remember: () => ({ id: "memory_moa_failure" }) },
    outcomes: null,
    processSignal: () => ({
      id: "output_moa_failure",
      scrutiny: {
        action: "act",
        score: 0.5,
        reasons: ["test"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider: originalProvider
  });
  const override = {
    provider: "moa",
    model: "research",
    isConfigured: () => true,
    async generate() {
      throw new Error("reference failed");
    }
  };

  await assert.rejects(
    host.handleMessage({
      channel: "discord",
      from: "user-1",
      sessionId: "moa-failure",
      text: "Run the mixture.",
      modelProviderOverride: override,
      ephemeral: true
    }),
    /reference failed/
  );
  assert.equal(host.modelProvider, originalProvider);
});

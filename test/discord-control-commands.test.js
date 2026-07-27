// Discord control surface: /skill, /gateway, /config.
//
// These commands can delete skills, restart the daemon, and rewrite runtime
// settings, so the tests focus on the GATES rather than the happy path:
// owner checks, confirm buttons, fail-closed supervision, and the refusal to
// treat /config as a credential editor.
import test from "node:test";
import assert from "node:assert/strict";

import { DiscordCommands, COMMAND_DEFS } from "../src/discord-commands.js";
import { DiscordChannel } from "../src/discord-channel.js";

function commandNamed(name) {
  return COMMAND_DEFS.find((cmd) => cmd.name === name);
}

// Minimal fake: capture what the handler would send back to Discord.
function harness({ skills = {}, owner = "owner-1", env = {} } = {}) {
  const sent = [];
  // The class reads runtime via `channel.agentHost.runtime`, not channel.runtime.
  const runtime = {
    skills: {
      has: () => true,
      view: () => ({ description: "A test skill.", body: "Step 1. Do the thing." }),
      setPinned: (...args) => { sent.push({ call: "setPinned", args }); return { ok: true }; },
      deleteSkill: (...args) => { sent.push({ call: "deleteSkill", args }); return { ok: true }; },
      curate: async () => ({ changed: [] }),
      ...skills
    },
    secrets: { dataDir: "/tmp/openagi-test" }
  };
  const channel = {
    agentHost: { modelProvider: { model: "kimi-k3" }, runtime },
    rest: async () => ({}),
    log: () => {},
    runtime,
    sessionKeyFor: DiscordChannel.prototype.sessionKeyFor
  };
  const cmds = new DiscordCommands(channel, {});
  cmds.respond = async (_interaction, payload) => { sent.push(payload); return payload; };
  cmds.followUp = async (_interaction, payload) => { sent.push(payload); return payload; };
  cmds.defer = async () => {};
  cmds.secretOwnerAllowed = (userId) => userId === owner;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return { cmds, sent, channel };
}

function interaction(name, sub, options = [], userId = "owner-1") {
  return {
    data: { name, options: [{ type: 1, name: sub, options }] },
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: userId } }
  };
}

function componentInteraction(customId, userId = "owner-1") {
  return {
    data: { custom_id: customId },
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: userId } }
  };
}

test("the new commands are registered with subcommands", () => {
  for (const name of ["skill", "gateway", "config"]) {
    const cmd = commandNamed(name);
    assert.ok(cmd, `/${name} must be registered`);
    assert.ok(Array.isArray(cmd.options) && cmd.options.length > 0, `/${name} needs subcommands`);
  }
  const gateway = commandNamed("gateway").options.map((o) => o.name);
  assert.deepEqual(gateway.sort(), ["restart", "status", "update"]);
});

test("/config set only offers non-secret keys", () => {
  const setSub = commandNamed("config").options.find((o) => o.name === "set");
  const choices = setSub.options.find((o) => o.name === "key").choices.map((c) => c.value);
  for (const value of choices) {
    assert.ok(
      !/KEY|TOKEN|SECRET|PASSWORD/u.test(value),
      `${value} looks like a credential and must not be settable via /config`
    );
  }
});

test("/skill delete requires an owner", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdSkill(interaction("skill", "delete", [{ name: "name", value: "graphify" }], "stranger"));
  assert.match(sent.at(-1).content, /owner allowlist/u);
  assert.ok(!sent.some((s) => s.call === "deleteSkill"), "must not delete for a non-owner");
});

test("/skill delete asks for confirmation instead of deleting immediately", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdSkill(interaction("skill", "delete", [{ name: "name", value: "graphify" }]));
  const reply = sent.at(-1);
  assert.match(reply.content, /Delete skill/u);
  assert.ok(reply.components?.[0]?.components?.[0]?.custom_id.startsWith("skill-delete:"));
  assert.ok(!sent.some((s) => s.call === "deleteSkill"), "must not delete before confirmation");
});

test("/skill delete rejects an unknown skill before offering a button", async () => {
  const { cmds, sent } = harness({ skills: { has: () => false } });
  await cmds.cmdSkill(interaction("skill", "delete", [{ name: "name", value: "nope" }]));
  assert.match(sent.at(-1).content, /Unknown skill/u);
  assert.ok(!sent.at(-1).components, "no confirm button for a nonexistent skill");
});

test("confirming a delete actually deletes, and only for the requester", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdSkill(interaction("skill", "delete", [{ name: "name", value: "graphify" }]));
  const confirmId = sent.at(-1).components[0].components[0].custom_id;

  // A different user cannot confirm someone else's destructive action.
  await cmds.handleComponent(componentInteraction(confirmId, "stranger"), "stranger");
  assert.ok(!sent.some((s) => s.call === "deleteSkill"), "another user must not confirm");

  await cmds.handleComponent(componentInteraction(confirmId), "owner-1");
  const deleted = sent.find((s) => s.call === "deleteSkill");
  assert.ok(deleted, "the requester's confirmation should delete");
  assert.equal(deleted.args[0], "graphify");
  assert.equal(deleted.args[2], "discord:guild-1:channel-1:owner-1");

  // The confirmation is single-use.
  const before = sent.filter((s) => s.call === "deleteSkill").length;
  await cmds.handleComponent(componentInteraction(confirmId), "owner-1");
  assert.equal(sent.filter((s) => s.call === "deleteSkill").length, before, "replay must not re-delete");
});

test("/skill pin protects a skill", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdSkill(interaction("skill", "pin", [{ name: "name", value: "graphify" }]));
  const call = sent.find((s) => s.call === "setPinned");
  assert.deepEqual(call.args.slice(0, 2), ["graphify", true]);
  assert.equal(call.args[3], "discord:guild-1:channel-1:owner-1");
  assert.match(sent.at(-1).content, /pinned/u);
});

test("/skill pin with state=unpin unpins", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdSkill(interaction("skill", "pin", [
    { name: "name", value: "graphify" },
    { name: "state", value: "unpin" }
  ]));
  assert.equal(sent.find((s) => s.call === "setPinned").args[1], false);
});

test("/skill curate reports the combined autonomous lifecycle counts", async () => {
  const { cmds, sent, channel } = harness();
  channel.runtime.runSkillCurator = async () => ({
    materialized: { created: 2 },
    curated: {
      changed: 1,
      seeded: 3,
      exemptions: { pinned: 1, bundled: 4, scope: 2, cron: 1 },
      rows: [{
        name: "old-skill",
        before: "active",
        after: "stale",
        result: "transitioned"
      }]
    },
    improved: { improved: 1 }
  });

  await cmds.cmdSkill(interaction("skill", "curate"));
  assert.match(sent.at(-1).content, /2 materialized, 1 transitioned, 1 improved/u);
  assert.match(sent.at(-1).content, /Seeded 3/u);
  assert.match(sent.at(-1).content, /bundled=4/u);
});

test("/gateway restart refuses when no supervisor is declared", async () => {
  delete process.env.OPENAGI_SUPERVISED;
  const { cmds, sent } = harness();
  await cmds.cmdGateway(interaction("gateway", "restart"));
  assert.match(sent.at(-1).content, /No process supervisor/u);
  assert.ok(!sent.at(-1).components, "must not offer a restart button when unsupervised");
});

test("/gateway restart offers a confirm button when supervised", async () => {
  const { cmds, sent } = harness({ env: { OPENAGI_SUPERVISED: "1" } });
  await cmds.cmdGateway(interaction("gateway", "restart"));
  assert.ok(sent.at(-1).components?.[0]?.components?.[0]?.custom_id.startsWith("gateway-restart:"));
  delete process.env.OPENAGI_SUPERVISED;
});

test("/gateway update requires an owner", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdGateway(interaction("gateway", "update", [], "stranger"));
  assert.match(sent.at(-1).content, /owner allowlist/u);
});

test("/config set refuses a key outside the allowlist", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdConfig(interaction("config", "set", [
    { name: "key", value: "ANTHROPIC_API_KEY" },
    { name: "value", value: "sk-leak" }
  ]));
  assert.match(sent.at(-1).content, /Not a settable key/u);
});

test("/config set rejects a non-integer iteration cap", async () => {
  const { cmds, sent } = harness();
  await cmds.cmdConfig(interaction("config", "set", [
    { name: "key", value: "OPENAGI_CHAT_MAX_ITERATIONS" },
    { name: "value", value: "lots" }
  ]));
  assert.match(sent.at(-1).content, /positive integer/u);
});

test("/config show never prints a credential", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";
  const { cmds, sent } = harness();
  await cmds.cmdConfig(interaction("config", "show"));
  const text = JSON.stringify(sent.at(-1));
  assert.ok(!text.includes("sk-ant-secret-value"), "/config show must not leak keys");
});

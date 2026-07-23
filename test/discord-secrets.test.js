import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { COMMAND_DEFS, DiscordCommands } from "../src/discord-commands.js";
import { SecretsStore } from "../src/secrets-store.js";

function commandInteraction(action, { name, user = "owner", suffix = action } = {}) {
  const option = { type: 1, name: action };
  if (name) {
    option.options = [{ type: 3, name: "name", value: name }];
  }
  return {
    id: `interaction-${suffix}`,
    token: `token-${suffix}`,
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: user } },
    data: { name: "secrets", options: [option] }
  };
}

function modalInteraction(name, value, { user = "owner", suffix = "modal" } = {}) {
  return {
    id: `interaction-${suffix}`,
    token: `token-${suffix}`,
    type: 5,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: user } },
    data: {
      custom_id: `secret-set:${name}`,
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "secret-value",
          value
        }]
      }]
    }
  };
}

function harness(t, { allowFrom = ["owner"] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-discord-secrets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({
    dataDir,
    allowlist: ["DISCORD_TEST_SECRET", "OPENAGI_AUTH_TOKEN"],
    env: {}
  });
  const calls = [];
  const logs = [];
  const channel = {
    allowFrom,
    agentHost: { runtime: { secrets: store } },
    async rest(route, options) {
      calls.push({ route, options });
      return { ok: true };
    },
    log(entry) {
      logs.push(entry);
    }
  };
  return {
    calls,
    commands: new DiscordCommands(channel),
    dataDir,
    logs,
    store
  };
}

function response(call) {
  return call.options.body;
}

test("secrets slash command declares list, modal set, and remove", () => {
  const definition = COMMAND_DEFS.find((item) => item.name === "secrets");
  assert.ok(definition);
  assert.deepEqual(definition.options.map((item) => item.name), ["list", "set", "remove"]);
  assert.equal(definition.options[1].options[0].required, true);
  assert.equal(definition.options[2].options[0].required, true);
});

test("Discord secret set, list, and remove never echo the submitted value", async (t) => {
  const state = harness(t);
  const canary = "discord-secret-canary-9X2Q";

  await state.commands.handle(commandInteraction("set", {
    name: "DISCORD_TEST_SECRET"
  }));
  let body = response(state.calls.at(-1));
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "secret-set:DISCORD_TEST_SECRET");
  assert.equal(JSON.stringify(body).includes(canary), false);

  await state.commands.handle(modalInteraction("DISCORD_TEST_SECRET", canary));
  body = response(state.calls.at(-1));
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /\*{4}9X2Q/);
  assert.equal(JSON.stringify(body).includes(canary), false);
  assert.equal(
    state.store.getSecret("DISCORD_TEST_SECRET", { decidedBy: "test:verify" }),
    canary
  );

  await state.commands.handle(commandInteraction("list", { suffix: "list" }));
  body = response(state.calls.at(-1));
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /DISCORD_TEST_SECRET: \*{4}9X2Q/);
  assert.equal(JSON.stringify(body).includes(canary), false);

  await state.commands.handle(commandInteraction("remove", {
    name: "DISCORD_TEST_SECRET",
    suffix: "remove"
  }));
  body = response(state.calls.at(-1));
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /Removed DISCORD_TEST_SECRET/);
  assert.equal(JSON.stringify(state.calls).includes(canary), false);
  assert.equal(JSON.stringify(state.logs).includes(canary), false);
  assert.equal(
    state.store.getSecret("DISCORD_TEST_SECRET", { decidedBy: "test:missing" }),
    null
  );

  const audit = fs.readFileSync(
    path.join(state.dataDir, "secrets", "audit.jsonl"),
    "utf8"
  );
  assert.match(audit, /"decidedBy":"discord:owner"/);
  assert.equal(audit.includes(canary), false);
});

test("Discord secrets fail closed without a configured owner allowlist", async (t) => {
  const state = harness(t, { allowFrom: [] });
  const canary = "must-never-be-saved";

  await state.commands.handle(commandInteraction("set", {
    name: "DISCORD_TEST_SECRET"
  }));
  let body = response(state.calls.at(-1));
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /configured Discord owner allowlist/);

  await state.commands.handle(modalInteraction("DISCORD_TEST_SECRET", canary));
  body = response(state.calls.at(-1));
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /configured Discord owner allowlist/);
  assert.equal(fs.existsSync(path.join(state.dataDir, "secrets")), false);
  assert.equal(JSON.stringify(state.calls).includes(canary), false);
});

test("Discord secrets reject non-allowlisted names before opening a modal", async (t) => {
  const state = harness(t);
  await state.commands.handle(commandInteraction("set", {
    name: "NOT_ALLOWLISTED"
  }));
  const body = response(state.calls.at(-1));
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /not allowlisted/);
});

test("Discord secrets refuse live auth-token removal", async (t) => {
  const state = harness(t);
  state.store.setSecret("OPENAGI_AUTH_TOKEN", "current-auth-token", {
    decidedBy: "test:seed"
  });

  await state.commands.handle(commandInteraction("remove", {
    name: "OPENAGI_AUTH_TOKEN"
  }));
  const body = response(state.calls.at(-1));
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /cannot be removed while running/);
  assert.equal(
    state.store.getSecret("OPENAGI_AUTH_TOKEN", { decidedBy: "test:verify" }),
    "current-auth-token"
  );
});

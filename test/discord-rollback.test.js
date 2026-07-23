import assert from "node:assert/strict";
import test from "node:test";
import { DiscordChannel } from "../src/discord-channel.js";
import { COMMAND_DEFS, DiscordCommands } from "../src/discord-commands.js";

function rollbackInteraction({ number, user = "user-1", suffix = "command" } = {}) {
  return {
    id: `interaction-${suffix}`,
    token: `token-${suffix}`,
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: user } },
    data: {
      name: "rollback",
      options: number === undefined ? [] : [{ type: 4, name: "number", value: number }]
    }
  };
}

function componentInteraction(customId, { user = "user-1", suffix = "component" } = {}) {
  return {
    id: `interaction-${suffix}`,
    token: `token-${suffix}`,
    type: 3,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: user } },
    data: { custom_id: customId }
  };
}

function harness({ checkpoints } = {}) {
  const rows = checkpoints ?? [
    { id: "cp-new", createdAt: "2026-07-22T12:00:00.000Z", directory: "/work/new" },
    { id: "cp-old", createdAt: "2026-07-22T11:00:00.000Z", directory: "/work/old" }
  ];
  const responses = [];
  const listCalls = [];
  const previewCalls = [];
  const invocations = [];
  const runtime = {
    checkpoints: {
      async list(args) {
        listCalls.push(args);
        return rows;
      },
      async preview(checkpointId) {
        previewCalls.push(checkpointId);
        return {
          checkpoint: rows.find((checkpoint) => checkpoint.id === checkpointId) ?? null,
          files: [{
            path: checkpointId === "cp-new" ? "/work/new/file.js" : "/work/old/file.js",
            status: "modified",
            diff: checkpointId === "cp-new" ? "new preview" : "old preview"
          }],
          truncated: false
        };
      }
    },
    tools: {
      async invoke(...args) {
        invocations.push(args);
        return { ok: true, result: { restored: true } };
      }
    }
  };
  const channel = {
    allowFrom: [],
    agentHost: { runtime },
    sessionKeyFor: DiscordChannel.prototype.sessionKeyFor,
    async rest(route, options) {
      responses.push({ route, options });
      return { ok: true };
    },
    log() {}
  };
  return {
    commands: new DiscordCommands(channel),
    invocations,
    listCalls,
    previewCalls,
    responses
  };
}

function responseData(call) {
  return call.options.body.data;
}

test("rollback slash command declares an optional positive integer", () => {
  const definition = COMMAND_DEFS.find((item) => item.name === "rollback");
  assert.ok(definition);
  assert.equal(definition.options.length, 1);
  assert.deepEqual(definition.options[0], {
    type: 4,
    name: "number",
    description: "Checkpoint number from the newest-first list",
    required: false,
    min_value: 1
  });
});

test("rollback without a number lists session-scoped checkpoints and previews newest first", async () => {
  const state = harness();
  await state.commands.handle(rollbackInteraction());

  assert.deepEqual(state.listCalls, [{
    sessionId: "discord:guild-1:channel-1:user-1",
    limit: 10
  }]);
  assert.deepEqual(state.previewCalls, ["cp-new", "cp-old"]);
  assert.equal(state.invocations.length, 0);
  const data = responseData(state.responses[0]);
  assert.equal(data.flags, 64);
  assert.match(data.content, /1\. .*cp-new.*new preview/);
  assert.match(data.content, /2\. .*cp-old.*old preview/);
});

test("rollback selection previews first, then a confirmation click invokes exactly once", async () => {
  const state = harness();
  await state.commands.handle(rollbackInteraction({ number: 2 }));

  assert.deepEqual(state.previewCalls, ["cp-old"]);
  assert.equal(state.invocations.length, 0, "slash selection itself is non-destructive");
  const prompt = responseData(state.responses[0]);
  assert.match(prompt.content, /old preview/);
  const button = prompt.components[0].components[0];
  assert.equal(button.style, 4);
  assert.match(button.custom_id, /^rollback-confirm:/);

  await state.commands.handle(componentInteraction(button.custom_id));
  assert.deepEqual(state.invocations, [[
    "rollback",
    { checkpointId: "cp-old" },
    {
      channel: "discord",
      sessionId: "discord:guild-1:channel-1:user-1",
      __confirmed: true,
      __approval: { approvedVia: "discord-button", decidedBy: "user-1" }
    }
  ]]);
  const completed = state.responses.at(-1).options.body;
  assert.equal(completed.type, 7);
  assert.deepEqual(completed.data.components, []);

  await state.commands.handle(componentInteraction(button.custom_id, { suffix: "replay" }));
  assert.equal(state.invocations.length, 1, "a replayed component cannot restore twice");
  const replay = state.responses.at(-1).options.body;
  assert.equal(replay.type, 4);
  assert.equal(replay.data.flags, 64);
  assert.match(replay.data.content, /expired|already used/i);
});

test("rollback confirmation is bound to the exact per-user session key", async () => {
  const state = harness();
  await state.commands.handle(rollbackInteraction({ number: 1 }));
  const button = responseData(state.responses[0]).components[0].components[0];

  await state.commands.handle(componentInteraction(button.custom_id, { user: "user-2", suffix: "wrong-user" }));
  assert.equal(state.invocations.length, 0);
  assert.equal(responseData(state.responses.at(-1)).flags, 64);
  assert.match(responseData(state.responses.at(-1)).content, /another session/i);

  await state.commands.handle(componentInteraction(button.custom_id, { user: "user-1", suffix: "owner" }));
  assert.equal(state.invocations.length, 1, "the owning user can still use the untouched confirmation");
  assert.equal(state.invocations[0][2].sessionId, "discord:guild-1:channel-1:user-1");
});

test("invalid and out-of-range rollback numbers remain non-destructive", async () => {
  const state = harness();
  for (const [index, number] of [0, -1, 1.5, 3].entries()) {
    await state.commands.handle(rollbackInteraction({ number, suffix: `invalid-${index}` }));
    const data = responseData(state.responses.at(-1));
    assert.equal(data.flags, 64);
    assert.equal(data.components, undefined);
    assert.match(data.content, /positive integer|out of range/i);
  }
  assert.equal(state.previewCalls.length, 0);
  assert.equal(state.invocations.length, 0);
  assert.equal(state.commands.rollbackConfirmations.size, 0);
});

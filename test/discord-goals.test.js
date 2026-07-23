import assert from "node:assert/strict";
import test from "node:test";
import { DiscordChannel } from "../src/discord-channel.js";
import { COMMAND_DEFS, DiscordCommands } from "../src/discord-commands.js";

function interaction({ action = "status", guild = "guild-1", channel = "channel-1", user = "user-1" } = {}) {
  const value = {
    id: `interaction-${action}`,
    token: `token-${action}`,
    channel_id: channel,
    data: { name: "goal", options: [{ type: 1, name: action }] }
  };
  if (guild == null) value.user = { id: user };
  else {
    value.guild_id = guild;
    value.member = { user: { id: user } };
  }
  return value;
}

function commandHarness({ current = null } = {}) {
  const calls = [];
  const operations = [];
  const goals = {
    get(sessionId) {
      operations.push(["get", sessionId]);
      return current;
    },
    pause(sessionId) { operations.push(["pause", sessionId]); },
    resume(sessionId) { operations.push(["resume", sessionId]); },
    clear(sessionId) { operations.push(["clear", sessionId]); }
  };
  const channel = {
    agentHost: { runtime: { goals } },
    sessionKeyFor: DiscordChannel.prototype.sessionKeyFor,
    rest: async (route, options) => {
      calls.push({ route, options });
      return { ok: true };
    }
  };
  return { commands: new DiscordCommands(channel), calls, operations };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("goal slash command exposes the required control subcommands", () => {
  const definition = COMMAND_DEFS.find((item) => item.name === "goal");
  assert.ok(definition);
  assert.deepEqual(definition.options.map((item) => item.name), ["status", "pause", "resume", "clear"]);
});

test("goal slash status uses the exact guild user session key", async () => {
  const current = { status: "active", objective: "Finish the migration", turns: 3, maxTurns: 20 };
  const { commands, calls, operations } = commandHarness({ current });

  await commands.handleCommand(interaction());

  assert.deepEqual(operations, [["get", "discord:guild-1:channel-1:user-1"]]);
  assert.match(calls[0].options.body.data.content, /Finish the migration/);
  assert.match(calls[0].options.body.data.content, /3\/20/);
});

test("goal slash controls preserve the historical DM session key", async () => {
  for (const action of ["pause", "resume", "clear"]) {
    const status = action === "resume" ? "paused" : "active";
    const { commands, operations } = commandHarness({ current: { status, objective: "Keep going" } });

    await commands.handleCommand(interaction({ action, guild: null, channel: "dm-9", user: "user-7" }));

    assert.deepEqual(operations, [
      ["get", "discord:dm:dm-9"],
      [action, "discord:dm:dm-9"]
    ]);
  }
});

test("goal slash resume starts a synthetic continuation turn", async () => {
  const calls = [];
  const turns = [];
  const queued = [];
  const goals = {
    get: () => ({ status: "paused", objective: "Finish", turns: 1, maxTurns: 20 }),
    resume: () => ({ status: "active", objective: "Finish", turns: 1, maxTurns: 20 })
  };
  const channel = {
    agentHost: {
      runtime: { goals },
      async handleMessage(input) {
        turns.push(input);
        return { reply: "Goal finished." };
      }
    },
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
  const commands = new DiscordCommands(channel);
  await commands.handleCommand(interaction({ action: "resume" }));

  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, "discord:guild-1:channel-1:user-1");
  assert.equal(turns[0].goalContinuation, true);
  assert.equal(turns[0].from, "user-1");
  assert.match(turns[0].text, /Objective: Finish/);
  assert.deepEqual(queued, ["discord:guild-1:channel-1:user-1"]);
  assert.equal(calls.length, 2, "resume defers, then edits the interaction reply");
  assert.match(calls[1].options.body.content, /Goal finished/);
});

test("goal slash resume refuses to start a duplicate active loop", async () => {
  const { commands, calls, operations } = commandHarness({
    current: { status: "active", objective: "Already running", turns: 1, maxTurns: 20 }
  });

  await commands.handleCommand(interaction({ action: "resume" }));

  assert.deepEqual(operations, [["get", "discord:guild-1:channel-1:user-1"]]);
  assert.match(calls[0].options.body.data.content, /already active/i);
});

test("enqueueSessionTask serializes slash continuations with message turns", async () => {
  const gate = deferred();
  const order = [];
  const channel = Object.create(DiscordChannel.prototype);
  channel.turnLocks = new Map();

  const first = channel.enqueueSessionTask("session", async () => {
    order.push("first-start");
    await gate.promise;
    order.push("first-end");
  });
  const second = channel.enqueueSessionTask("session", async () => {
    order.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.equal(channel.turnLocks.size, 0);
});

test("enqueueTurn synchronously preempts an active goal before its turn lock", async () => {
  const firstGate = deferred();
  const started = [];
  const preemptions = [];
  let active = false;
  const channel = Object.create(DiscordChannel.prototype);
  channel.turnLocks = new Map();
  channel.agentHost = {
    runtime: {
      goals: {
        get: () => active ? { status: "active" } : null,
        preempt: (sessionId, reason) => preemptions.push([sessionId, reason])
      }
    }
  };
  channel.runTurn = async (message) => {
    started.push(message.id);
    if (message.id === "first") await firstGate.promise;
  };
  channel.log = () => {};
  channel.sendMessage = async () => null;
  const base = { guild_id: "guild-1", channel_id: "channel-1", author: { id: "user-1" } };

  const first = channel.enqueueTurn({ ...base, id: "first" }, "one");
  await new Promise((resolve) => setImmediate(resolve));
  active = true;
  const second = channel.enqueueTurn({ ...base, id: "second" }, "two");

  assert.deepEqual(started, ["first"]);
  assert.deepEqual(preemptions, [["discord:guild-1:channel-1:user-1", "discord-user-message"]]);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("enqueueTurn does not treat a bot message as real user preemption", async () => {
  let preempted = false;
  const channel = Object.create(DiscordChannel.prototype);
  channel.turnLocks = new Map();
  channel.agentHost = {
    runtime: {
      goals: {
        get: () => ({ status: "active" }),
        preempt: () => { preempted = true; }
      }
    }
  };
  channel.runTurn = async () => {};
  channel.log = () => {};
  channel.sendMessage = async () => null;

  await channel.enqueueTurn({
    id: "bot-message",
    guild_id: "guild-1",
    channel_id: "channel-1",
    author: { id: "bot-1", bot: true }
  }, "automated");

  assert.equal(preempted, false);
});

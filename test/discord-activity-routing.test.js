import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscordChannel } from "../src/discord-channel.js";
import { SkillRegistry } from "../src/skills.js";

// Hermetic env: DiscordChannel's constructor falls back to ambient DISCORD_*
// env vars. In particular `activityChannel: null` harness options are defeated
// by an exported DISCORD_ACTIVITY_CHANNEL (`null ?? env` yields env), which
// makes unroutable-feed tests post instead of drop. Scrub for determinism.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("DISCORD_")) delete process.env[key];
}

function createHarness(t, {
  activityChannel = "222222",
  guilds = []
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-activity-routing-"));
  const events = new EventEmitter();
  const logs = [];
  const messages = [];
  const embeds = [];
  const restCalls = [];
  const runtime = {
    events,
    pendingActions: {
      get() {
        return null;
      }
    },
    tools: {
      get() {
        return null;
      }
    }
  };
  const channel = new DiscordChannel({
    agentHost: { runtime },
    token: null,
    dir: path.join(root, "discord"),
    activityChannel,
    guilds,
    presence: false,
    liveStatus: false
  });
  channel.log = (entry) => {
    logs.push(entry);
  };
  channel.sendMessage = async (channelId, content) => {
    messages.push({ channelId, content });
    return { id: `message-${messages.length}` };
  };
  channel.sendEmbed = async (channelId, value) => {
    embeds.push({ channelId, value });
    return { id: `embed-${embeds.length}` };
  };
  channel.rest = async (pathname, options = {}) => {
    restCalls.push({
      pathname,
      method: options.method ?? "GET",
      body: options.body ?? null
    });
    return { id: `rest-${restCalls.length}` };
  };
  t.after(() => {
    channel.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    runtime,
    events,
    logs,
    messages,
    embeds,
    restCalls,
    channel
  };
}

test("activityChannelFor extracts the channel from a Discord session", (t) => {
  const harness = createHarness(t);
  assert.equal(
    harness.channel.activityChannelFor("discord:guild:123456"),
    "123456"
  );
});

test("activityChannelFor ignores lastActiveChannel when the session is null", (t) => {
  const harness = createHarness(t, { activityChannel: "222222" });
  harness.channel.lastActiveChannel = "999999";

  const resolved = harness.channel.activityChannelFor(null);

  assert.equal(resolved, "222222");
  assert.notEqual(resolved, "999999");
});

test("activityChannelFor uses the configured channel for a garbage session", (t) => {
  const harness = createHarness(t, { activityChannel: "222222" });
  harness.channel.lastActiveChannel = "999999";

  const resolved = harness.channel.activityChannelFor("garbage");

  assert.equal(resolved, "222222");
  assert.notEqual(resolved, "999999");
});

test("postEmbed drops and logs a feed item with no resolvable channel", (t) => {
  const harness = createHarness(t, { activityChannel: null });
  harness.channel.bindActivityFeed(harness.events);

  harness.events.emit("skill-edit", {
    skill: "session-skill",
    action: "edited",
    sessionId: null
  });

  assert.equal(harness.embeds.length, 0);
  assert.ok(
    harness.logs.some(
      (entry) => entry.op === "feed-dropped"
        && entry.reason === "unresolved-session"
    )
  );
});

test("skill-use telemetry routes to its session instead of lastActiveChannel", (t) => {
  const harness = createHarness(t, { activityChannel: "123456" });
  const emitted = [];
  harness.events.on("skill-use", (payload) => {
    emitted.push(payload);
  });
  harness.channel.bindActivityFeed(harness.events);
  harness.channel.lastActiveChannel = "999999";
  const registry = new SkillRegistry({
    runtime: harness.runtime,
    dirs: [],
    dataDir: path.join(harness.root, "skills-data"),
    autoLoad: false
  });

  registry.recordUse(
    "session-skill",
    "view",
    "ok",
    "2026-07-27T12:00:00.000Z",
    "discord:guild:123456:user-1"
  );

  assert.equal(emitted[0]?.sessionId, "discord:guild:123456:user-1");
  assert.deepEqual(
    harness.embeds.map((entry) => entry.channelId),
    ["123456"]
  );
  assert.ok(
    harness.embeds.every((entry) => entry.channelId !== "999999")
  );
});

test("approval cards post only to the action context session", async (t) => {
  const harness = createHarness(t, {
    activityChannel: null,
    guilds: ["guild"]
  });
  harness.channel.lastActiveChannel = "999999";

  await harness.channel.postCatastrophicApproval({
    id: "pending-session-approval",
    toolName: "code_shell",
    summary: "session-scoped approval",
    context: {
      sessionId: "discord:guild:333333:user-1"
    }
  });

  assert.deepEqual(
    harness.restCalls.map((call) => call.pathname),
    ["/channels/333333/messages"]
  );
});

test("activity feed drops a session outside the configured allowlist", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: ["allowed-guild"]
  });
  harness.channel.bindActivityFeed(harness.events);

  harness.events.emit("skill-edit", {
    skill: "session-skill",
    action: "edited",
    sessionId: "discord:other-guild:333333:user-1"
  });

  assert.equal(harness.embeds.length, 0);
  assert.ok(
    harness.logs.some(
      (entry) => entry.op === "feed-dropped"
        && entry.reason === "channel-not-allowed"
        && entry.channelId === "333333"
    )
  );
});

// A same-guild session channel is a channel this adapter provably ingested a
// message from (inbound is guild-gated on `this.guilds`), so its trace belongs
// there — that IS session scoping. An earlier revision additionally required
// channelId === activityChannel, which collapsed every session-scoped trace
// back onto the home channel: measured against the live event log, 95.6% of
// this agent's real conversations happen OUTSIDE its configured activity
// channel, so that rule silently reintroduced the misroute it was meant to fix
// while every test stayed green. Keep this test as the guard against
// re-narrowing.
test("same-guild traces route to their own session channel", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: ["shared-guild"]
  });
  harness.channel.bindActivityFeed(harness.events);

  harness.events.emit("skill-edit", {
    skill: "session-skill",
    action: "edited",
    sessionId: "discord:shared-guild:333333:user-1"
  });

  assert.deepEqual(
    harness.embeds.map((entry) => entry.channelId),
    ["333333"]
  );
  assert.ok(
    !harness.logs.some((entry) => entry.op === "feed-dropped")
  );
});

test("a session in a NON-allowlisted guild is still dropped", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: ["shared-guild"]
  });
  harness.channel.bindActivityFeed(harness.events);

  harness.events.emit("skill-edit", {
    skill: "session-skill",
    action: "edited",
    sessionId: "discord:intruder-guild:333333:user-1"
  });

  assert.equal(harness.embeds.length, 0);
  assert.ok(
    harness.logs.some(
      (entry) => entry.op === "feed-dropped"
        && entry.reason === "channel-not-allowed"
    )
  );
});

// Fail-closed: with no guild allowlist we cannot prove a session channel
// belongs to this agent, so an unverifiable session must NOT be trusted.
test("without a guild allowlist an unverifiable session is not trusted", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: []
  });
  harness.channel.bindActivityFeed(harness.events);

  harness.events.emit("skill-edit", {
    skill: "session-skill",
    action: "edited",
    sessionId: "discord:any-guild:333333:user-1"
  });

  assert.equal(harness.embeds.length, 0);
  assert.ok(
    harness.logs.some(
      (entry) => entry.op === "feed-dropped"
        && entry.reason === "channel-not-allowed"
    )
  );
});

test("approval cards without a session are dropped instead of using home", async (t) => {
  const harness = createHarness(t, { activityChannel: "222222" });

  const result = await harness.channel.postCatastrophicApproval({
    id: "pending-no-session",
    toolName: "code_shell",
    summary: "must not guess"
  });

  assert.equal(result, null);
  assert.equal(harness.restCalls.length, 0);
  assert.ok(
    harness.logs.some(
      (entry) => entry.op === "feed-dropped"
        && entry.reason === "unresolved-session"
        && entry.feed === "approval"
    )
  );
});

test("goal lifecycle events post to the session channel", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: ["shared-guild"]
  });
  harness.channel.bindActivityFeed(harness.events);
  const sessionId = "discord:shared-guild:333333:user-1";

  harness.events.emit("agent-activity", {
    phase: "goal", action: "completed", why: "all steps done", sessionId
  });
  harness.events.emit("agent-activity", {
    phase: "goal", action: "stagnated", stagnationTurns: 3, sessionId
  });

  assert.equal(harness.messages.length, 2);
  assert.ok(harness.messages[0].content.includes("Goal completed"));
  assert.ok(harness.messages[0].content.includes("all steps done"));
  assert.ok(harness.messages[1].content.includes("Goal stagnated"));
  assert.ok(harness.messages[1].content.includes("human review"));
  assert.ok(harness.messages.every((m) => m.channelId === "333333"));
});

test("goal continue events are hard-throttled", (t) => {
  const harness = createHarness(t, {
    activityChannel: "222222",
    guilds: ["shared-guild"]
  });
  harness.channel.bindActivityFeed(harness.events);
  const sessionId = "discord:shared-guild:333333:user-1";

  harness.events.emit("agent-activity", {
    phase: "goal", action: "continue", turns: 2, maxTurns: 20, sessionId
  });
  harness.events.emit("agent-activity", {
    phase: "goal", action: "continue", turns: 3, maxTurns: 20, sessionId
  });

  assert.equal(harness.messages.length, 1);
  assert.ok(harness.messages[0].content.includes("Goal turn 2/20"));
});

test("goal events are dropped when DISCORD_ACTIVITY_GOALS=0", (t) => {
  const prev = process.env.DISCORD_ACTIVITY_GOALS;
  process.env.DISCORD_ACTIVITY_GOALS = "0";
  try {
    const harness = createHarness(t, {
      activityChannel: "222222",
      guilds: ["shared-guild"]
    });
    harness.channel.bindActivityFeed(harness.events);
    harness.events.emit("agent-activity", {
      phase: "goal",
      action: "completed",
      sessionId: "discord:shared-guild:333333:user-1"
    });
    assert.equal(harness.messages.length, 0);
  } finally {
    if (prev === undefined) delete process.env.DISCORD_ACTIVITY_GOALS;
    else process.env.DISCORD_ACTIVITY_GOALS = prev;
  }
});

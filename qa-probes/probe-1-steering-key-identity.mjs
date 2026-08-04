// Probe 1 (brief section 1, HIGHEST RISK): the key discord-channel.js uses for
// isTurnInFlight/steer at enqueue time must be the SAME string agent-host.js
// registers in beginTurn via store.sessionKey -- for guild, DM, and thread
// message shapes, end to end through real AgentHost.handleMessage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryAgentStore, FileBackedAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { TurnSteering } from "../src/turn-steering.js";
import { DiscordChannel } from "../src/discord-channel.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe1-"));
let failures = 0;
const fail = (m) => { failures += 1; console.log("FAIL:", m); };
const ok = (m) => console.log("ok:", m);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function runShape(label, message, makeStore = () => new InMemoryAgentStore(), afterStore = null) {
  const steering = new TurnSteering();
  const beginKeys = [];
  const steerCalls = [];
  const inflightChecks = [];
  const origBegin = steering.beginTurn.bind(steering);
  const origSteer = steering.steer.bind(steering);
  const origInflight = steering.isTurnInFlight.bind(steering);
  steering.beginTurn = (k, info) => { beginKeys.push(k); return origBegin(k, info); };
  steering.steer = (k, t) => { steerCalls.push({ key: k, text: t }); return origSteer(k, t); };
  steering.isTurnInFlight = (k) => { const r = origInflight(k); inflightChecks.push({ key: k, result: r }); return r; };

  const preemptCalls = [];
  const runtime = {
    tools: new ToolRegistry(),
    memory: { retrieve: () => [], renderSessionMemorySnapshot: () => "", remember: () => ({ id: "m" }) },
    checkpoints: null,
    tasks: { add: () => ({ id: "t" }) },
    outcomes: null,
    steering,
    goals: {
      get: () => ({ status: "active" }),
      preempt: (key, reason) => { preemptCalls.push({ key, reason }); }
    },
    processSignal: () => ({
      id: "o1",
      scrutiny: { action: "act", score: 0.5, reasons: [], dimensions: {} },
      customContext: [],
      propagation: null
    })
  };

  const gate = deferred();
  let generateCalls = 0;
  const provider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate() {
      generateCalls += 1;
      if (generateCalls === 1) await gate.promise; // hold turn 1 in flight
      return {
        provider: "fixture", model: "fixture-model", id: "r1",
        text: "done", toolCalls: [], iterations: 1, maxIterations: 1, stopReason: "completed"
      };
    }
  };

  const store = makeStore();
  const host = new AgentHost({ runtime, store, modelProvider: provider });
  const channel = new DiscordChannel({
    agentHost: host, token: null, dir: path.join(root, `d-${label}`),
    guilds: [], presence: false, liveStatus: false
  });
  channel.log = () => {};
  channel.sendMessage = async () => ({ id: "x" });
  channel.rest = async () => ({});

  // Turn 1: long-running.
  const turn1 = channel.enqueueTurn(message, "start the long task");
  // Wait until beginTurn has actually fired inside handleMessage.
  for (let i = 0; i < 200 && beginKeys.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (beginKeys.length !== 1) { fail(`${label}: beginTurn fired ${beginKeys.length}x (expected 1)`); gate.resolve(); await turn1.catch(() => {}); return; }

  // Turn 2: the steer, enqueued while turn 1 is blocked in generate().
  // (msg1's own enqueue legitimately preempted: no turn was in flight yet.
  // Only preempts NEW since this point indicate the bug.)
  const preemptsBefore = preemptCalls.length;
  const steerMessage = { ...message, id: `${message.id}-2` };
  const turn2 = channel.enqueueTurn(steerMessage, "actually, use the other API");

  const expectedKey = channel.sessionKeyFor(message);
  if (beginKeys[0] !== expectedKey) {
    fail(`${label}: beginTurn key '${beginKeys[0]}' !== sessionKeyFor(message) '${expectedKey}'`);
  } else {
    ok(`${label}: beginTurn key === sessionKeyFor(message) === '${expectedKey}'`);
  }
  const enqueueSteer = steerCalls.find((c) => c.text.includes("actually"));
  if (!enqueueSteer) {
    fail(`${label}: no steer() call at enqueue time (inflight=${JSON.stringify(inflightChecks)}, preempts=${JSON.stringify(preemptCalls)})`);
  } else if (enqueueSteer.key !== beginKeys[0]) {
    fail(`${label}: steer key '${enqueueSteer.key}' !== beginTurn key '${beginKeys[0]}' -- PHASE 3 DEAD ON THIS SHAPE`);
  } else {
    ok(`${label}: enqueue-time steer key matches beginTurn key`);
  }
  const newPreempts = preemptCalls.slice(preemptsBefore).filter((c) => c.reason === "discord-user-message");
  if (newPreempts.length > 0) fail(`${label}: discord preempted at steer-enqueue time despite in-flight turn`);
  else ok(`${label}: no preempt at steer-enqueue time`);

  gate.resolve();
  await turn1.catch(() => {});
  await turn2.catch(() => {});
  if (afterStore) afterStore(store);
}

const guildMsg = {
  id: "m1", guild_id: "g1", channel_id: "c1",
  author: { id: "u1", username: "alice", bot: false }, member: null, attachments: []
};
const dmMsg = {
  id: "m2", channel_id: "c9",
  author: { id: "u2", username: "bob", bot: false }, member: null, attachments: []
};
const threadMsg = {
  id: "m3", guild_id: "g1", channel_id: "thread-7",
  author: { id: "u1", username: "alice", bot: false }, member: null, attachments: []
};

await runShape("guild", guildMsg);
await runShape("dm", dmMsg);
await runShape("thread", threadMsg);

// Legacy-migration shape: a 3-segment legacy transcript exists on disk. The
// migration must copy it INTO the 4-segment key without the key ever changing.
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe1-legacy-"));
const legacyMsg = {
  id: "m4", guild_id: "gL", channel_id: "cL",
  author: { id: "u1", username: "alice", bot: false }, member: null, attachments: []
};
await runShape("legacy-migration", legacyMsg, () => {
  const store = new FileBackedAgentStore({ dir: path.join(legacyDir, "agent-host") });
  store.saveSession({
    id: "discord:gL:cL", // legacy 3-segment key
    messages: [{ id: "old1", role: "user", content: "pre-upgrade history", at: "2026-01-01T00:00:00Z" }],
    createdAt: "2026-01-01T00:00:00Z"
  });
  return store;
}, (store) => {
  const migrated = store.getSession("discord:gL:cL:u1");
  const hasLegacy = (migrated.messages ?? []).some((m) => m.content === "pre-upgrade history");
  if (hasLegacy) ok("legacy-migration: legacy transcript copied into the 4-segment key");
  else fail("legacy-migration: legacy transcript NOT found under the new key");
});

console.log(failures === 0 ? "PROBE PASS" : `PROBE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

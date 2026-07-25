import assert from "node:assert/strict";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { applyBackgroundReviewProposal } from "../src/background-review.js";
import {
  MemorySystem,
  canReadMemoryScope,
  profileMemoryScope
} from "../src/memory-system.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

function curated(memory, content, scope, id) {
  return memory.remember({ content, scope }, {
    id,
    tier: "medium",
    capacityManaged: true
  });
}

test("profile memory is bounded separately and never inherits across users or projects", () => {
  const memory = new MemorySystem({
    curatedMemoryMaxChars: 180,
    profileMemoryMaxChars: 80
  });
  const alice = profileMemoryScope({ channel: "local", from: "alice" });
  const bob = profileMemoryScope({ channel: "local", from: "bob" });
  curated(memory, "Project alpha deploys through a canary.", "project:alpha", "project-fact");
  curated(memory, "Alice prefers concise release updates.", alice, "alice-pref");
  curated(memory, "Bob prefers detailed release updates.", bob, "bob-pref");

  const snapshot = memory.renderSessionMemorySnapshot({
    scope: "project:alpha",
    profileScope: alice
  });
  assert.match(snapshot, /User profile/);
  assert.match(snapshot, /Alice prefers concise/);
  assert.match(snapshot, /Project alpha deploys/);
  assert.doesNotMatch(snapshot, /Bob prefers detailed/);
  assert.equal(canReadMemoryScope("project:alpha", alice), false);
  assert.equal(canReadMemoryScope(alice, "project:alpha"), false);
  assert.equal(memory.retrieve("release", { scope: alice, exactScope: true }).length, 1);
});

test("memory tools route explicit preferences to the caller profile and recall merges only that profile", async () => {
  const memory = new MemorySystem();
  const tools = new ToolRegistry();
  registerCoreTools(tools, { memory });
  const alice = profileMemoryScope({ channel: "local", from: "alice" });
  const bob = profileMemoryScope({ channel: "local", from: "bob" });
  const aliceContext = {
    channel: "local",
    from: "alice",
    sessionId: "alice-session",
    __memoryScope: "project:alpha",
    __profileMemoryScope: alice
  };
  const bobContext = {
    channel: "local",
    from: "bob",
    sessionId: "bob-session",
    __memoryScope: "project:alpha",
    __profileMemoryScope: bob
  };

  const preference = await tools.invoke("remember", {
    content: "Alice prefers concise release updates.",
    memoryClass: "preference"
  }, aliceContext);
  const fact = await tools.invoke("remember", {
    content: "Project alpha uses a canary rollout.",
    memoryClass: "fact"
  }, aliceContext);
  await tools.invoke("remember", {
    content: "Bob prefers detailed release updates.",
    memoryClass: "preference"
  }, bobContext);

  assert.equal(preference.ok, true);
  assert.equal(preference.result.memoryClass, "preference");
  assert.equal(memory.items.get(preference.result.id).scope, alice);
  assert.equal(memory.items.get(fact.result.id).scope, "project:alpha");

  const aliceRecall = await tools.invoke("recall", { query: "release canary", limit: 10 }, aliceContext);
  assert.equal(aliceRecall.ok, true);
  assert.equal(aliceRecall.result.items.some((item) => /Alice prefers/.test(item.content)), true);
  assert.equal(aliceRecall.result.items.some((item) => /Bob prefers/.test(item.content)), false);
  assert.equal(aliceRecall.result.items.some((item) => /canary rollout/.test(item.content)), true);

  const corrected = await tools.invoke("correct_memory", {
    id: preference.result.id,
    correction: "Alice prefers concise release updates with release risks first.",
    memoryClass: "preference"
  }, aliceContext);
  assert.equal(corrected.ok, true);
  assert.equal(memory.items.get(corrected.result.id).scope, alice);
  assert.equal(memory.items.get(preference.result.id).metadata.supersededBy, corrected.result.id);
});

test("AgentHost derives and freezes a user profile scope with the session memory view", async () => {
  const memory = new MemorySystem();
  const alice = profileMemoryScope({ channel: "local", from: "alice", sessionId: "profile-session" });
  curated(memory, "Alice prefers status updates in bullet points.", alice, "host-pref");
  const requests = [];
  const runtime = {
    memory,
    tools: { toOpenAITools: () => [] },
    outcomes: null,
    processSignal: () => ({
      id: "signal",
      scrutiny: {
        action: "act",
        score: 0.1,
        reasons: [],
        dimensions: { novelty: 0, risk: 0, repetition: 0 }
      },
      customContext: [],
      propagation: null
    })
  };
  const host = new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      async generate(request) {
        requests.push(request);
        return { provider: "fixture", model: "fixture", text: "done", toolCalls: [] };
      }
    }
  });
  await host.handleMessage({
    channel: "local",
    from: "alice",
    sessionId: "profile-session",
    text: "Show my status format."
  });

  assert.equal(requests[0].context.__profileMemoryScope, alice);
  assert.match(requests[0].sessionMemorySnapshot, /Alice prefers status updates/);
  assert.match(requests[0].sessionMemorySnapshot, /User profile/);
});

test("background review routes user-preference proposals to the frozen profile scope", () => {
  const memory = new MemorySystem();
  const profile = profileMemoryScope({ channel: "local", from: "alice" });
  const actions = [];
  const result = applyBackgroundReviewProposal({
    runtime: {
      memory,
      pendingActions: {
        enqueue(action) {
          actions.push(action);
          return { id: "act_profile", status: "pending" };
        }
      }
    },
    proposal: {
      memories: [{
        content: "Alice prefers bullet-point status updates.",
        kind: "preference",
        confidence: "medium"
      }]
    },
    turn: {
      sessionId: "profile-review",
      memoryScope: "project:alpha",
      profileMemoryScope: profile
    }
  });

  assert.equal(result.memories.length, 1);
  assert.equal(actions[0].args.proposal.scope, profile);
  assert.equal(memory.items.size, 0);
});

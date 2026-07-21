// Post-turn learning must stay off the reply's critical path and must never
// turn an auxiliary model suggestion into an unapproved skill write.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import {
  BackgroundReviewer,
  DEFAULT_BACKGROUND_REVIEW_MAX_ITERATIONS,
  backgroundReviewEnabled,
  parseBackgroundReview
} from "../src/background-review.js";
import { MemorySystem } from "../src/memory-system.js";
import { TASK_PROFILES } from "../src/model-router.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function isolateEnv(t, key) {
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function hostRuntime() {
  return {
    tools: { toOpenAITools: () => [{ name: "fixture_tool" }] },
    memory: { remember: () => ({ id: "turn-memory" }) },
    outcomes: null,
    processSignal: () => ({
      id: "review-output",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["substantive fixture"],
        dimensions: { novelty: 0.5, risk: 0.1, repetition: 0.2 }
      },
      customContext: [],
      propagation: null
    })
  };
}

function primaryProvider() {
  return {
    model: "fixture",
    isConfigured: () => true,
    async generate() {
      return { provider: "fixture", model: "fixture", text: "Finished the work.", toolCalls: [] };
    }
  };
}

test("background review is opt-in and routed to the cheapest tier", () => {
  assert.equal(backgroundReviewEnabled({}), false);
  assert.equal(backgroundReviewEnabled({ OPENAGI_BACKGROUND_REVIEW: "true" }), true);
  assert.equal(backgroundReviewEnabled({ OPENAGI_BACKGROUND_REVIEW: "ON" }), true);
  assert.equal(backgroundReviewEnabled({ OPENAGI_BACKGROUND_REVIEW: "yes" }), false);
  assert.equal(TASK_PROFILES.review.tier, "nano");
  assert.ok(SETUP_FIELDS.includes("OPENAGI_BACKGROUND_REVIEW"));
});

test("review memories use confidence tiers and merge duplicates while skills stay pending", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-background-review-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const memory = new MemorySystem();
  const duplicate = memory.remember({
    source: "user",
    scope: "main",
    content: "The user prefers concise release notes.",
    kind: "preference",
    tags: ["release-notes"],
    specificity: 0.8
  }, { tier: "medium", strength: 0.7 });
  const persistedSkills = [];
  const events = [];
  const runtime = {
    dataDir,
    memory,
    events: new EventEmitter(),
    proactiveObserver: {
      persist(candidate) {
        persistedSkills.push(candidate);
        return { suggested: 1, candidate: { id: "prop-review", ...candidate } };
      }
    }
  };
  runtime.events.on("background-review", (event) => events.push(event));
  const requests = [];
  const reviewer = new BackgroundReviewer({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      async generate(request) {
        requests.push(request);
        return {
          text: JSON.stringify({
            memories: [
              { content: "The user prefers concise release notes.", kind: "preference", confidence: "medium", tags: ["release-notes"] },
              { content: "The release environment uses canary deployments before production.", kind: "environment", confidence: "high", tags: ["release", "deploy"] }
            ],
            skill: {
              title: "Canary release check",
              rationale: "The workflow succeeded and is repeatable.",
              draftBody: "Verify canary health, then promote the release."
            }
          })
        };
      }
    }
  });

  const result = await reviewer.review({
    sessionId: "discord:guild:channel:user",
    agentId: "main",
    memoryScope: "main",
    userText: "Deploy this release through canary.",
    assistantText: "Canary passed and production was promoted.",
    toolCalls: [{ name: "deploy", ok: true }]
  });

  assert.equal(requests[0].task, "review");
  assert.equal(requests[0].maxIterations, DEFAULT_BACKGROUND_REVIEW_MAX_ITERATIONS);
  assert.deepEqual(requests[0].context.__advertisedTools, []);
  assert.equal(result.applied.duplicatesSkipped, 1);
  assert.equal(result.applied.memories.length, 1);
  assert.equal(result.applied.memories[0].tier, "long", "only high-confidence review learning reaches long tier");
  assert.equal(memory.items.size, 2);
  assert.ok(duplicate.strength > 0.7, "near-duplicate evidence reinforces instead of duplicating");
  assert.equal(persistedSkills.length, 1);
  assert.equal(persistedSkills[0].status, "pending");
  assert.equal(persistedSkills[0].source, "background-review");
  assert.equal(events.length, 1);
  assert.equal(events[0].skillPending, true);

  const lines = fs.readFileSync(path.join(dataDir, "background-review", "reviews.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).status, "reviewed");
});

test("AgentHost schedules substantive reviews after returning and skips conversational turns", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const calls = [];
  const reviewer = { async review(turn) { calls.push(turn); return { skipped: false }; } };
  const host = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: reviewer
  });

  const turn = await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId: "review-substantive",
    text: "build the release checklist"
  });
  assert.equal(turn.reply, "Finished the work.");
  assert.equal(calls.length, 0, "the auxiliary pass must not delay the returned reply");
  await host.lastBackgroundReview;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "review-substantive");

  const casualHost = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: reviewer
  });
  await casualHost.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId: "review-casual",
    text: "hello there"
  });
  assert.equal(casualHost.lastBackgroundReview, null);
  assert.equal(calls.length, 1, "plain conversation must not spend review tokens");
});

test("a failed asynchronous review never rejects the user turn", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "on";
  const logged = [];
  const host = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: { async review() { throw new Error("aux model unavailable"); } },
    backgroundReviewLog: (error) => logged.push(error.message)
  });

  const turn = await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId: "review-failure",
    text: "create the deployment report"
  });
  assert.equal(turn.reply, "Finished the work.");
  assert.deepEqual(await host.lastBackgroundReview, { skipped: true, reason: "review failed: aux model unavailable" });
  assert.deepEqual(logged, ["aux model unavailable"]);
});

test("review parsing accepts fenced JSON but rejects prose", () => {
  assert.deepEqual(parseBackgroundReview('```json\n{"memories":[],"skill":null}\n```'), { memories: [], skill: null });
  assert.equal(parseBackgroundReview("Here is the review: none"), null);
});

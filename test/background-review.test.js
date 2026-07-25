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
  buildBackgroundReviewDigest,
  parseBackgroundReview
} from "../src/background-review.js";
import { MemorySystem } from "../src/memory-system.js";
import { TASK_PROFILES } from "../src/model-router.js";
import { PendingActionStore, approvePendingAction } from "../src/pending-actions.js";
import { ProjectStore } from "../src/project-store.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

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

test("review memories stage screened candidates while duplicate evidence and skills stay pending", async (t) => {
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
  }, { tier: "medium", strength: 0.7, capacityManaged: true });
  const persistedSkills = [];
  const events = [];
  const runtime = {
    dataDir,
    memory,
    pendingActions: new PendingActionStore({ dir: path.join(dataDir, "pending-actions") }),
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
    projectId: "alpha",
    projectRevision: 4,
    memoryScope: "main",
    modelProfile: { model: "project-review-model" },
    routingProfile: { tier: "mini", task: "project-review" },
    userText: "Deploy this release through canary.",
    assistantText: "Canary passed and production was promoted.",
    toolCalls: [{ name: "deploy", ok: true }]
  });

  assert.equal(requests[0].task, "project-review");
  assert.equal(requests[0].model, "project-review-model");
  assert.equal(requests[0].tier, "mini");
  assert.equal(requests[0].context.__projectId, "alpha");
  assert.equal(requests[0].context.__projectRevision, 4);
  assert.equal(requests[0].maxIterations, DEFAULT_BACKGROUND_REVIEW_MAX_ITERATIONS);
  assert.deepEqual(requests[0].context.__advertisedTools, []);
  assert.equal(result.applied.duplicatesSkipped, 1);
  assert.equal(result.applied.memories.length, 1);
  assert.equal(result.applied.memories[0].status, "pending");
  assert.equal(result.applied.memories[0].kind, "environment");
  assert.equal(memory.items.size, 1, "model review cannot write memory before approval");
  assert.equal(duplicate.strength, 0.7, "unapproved duplicate evidence cannot silently reinforce memory");
  const staged = runtime.pendingActions.list({ status: "pending" });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].toolName, "apply_background_memory_proposal");
  assert.equal(staged[0].args.proposal.content, "The release environment uses canary deployments before production.");
  assert.equal(persistedSkills.length, 1);
  assert.equal(persistedSkills[0].status, "pending");
  assert.equal(persistedSkills[0].source, "background-review");
  assert.equal(persistedSkills[0].context.projectId, "alpha");
  assert.equal(events.length, 1);
  assert.equal(events[0].skillPending, true);
  assert.equal(events[0].memoriesStaged, 1);

  const lines = fs.readFileSync(path.join(dataDir, "background-review", "reviews.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).status, "reviewed");
  assert.equal(JSON.parse(lines[0]).projectId, "alpha");
});

test("AgentHost reviews a substantive session only after it ends and skips conversational sessions", async (t) => {
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
  assert.equal(calls.length, 0, "a live session must not spend auxiliary tokens");
  host.resetSession({ sessionId: "review-substantive", nextSessionId: "review-next" });
  await host.lastBackgroundReview;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "review-substantive");
  assert.equal(calls[0].messages.length, 2);

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
  casualHost.resetSession({ sessionId: "review-casual", nextSessionId: "review-casual-next" });
  assert.equal(casualHost.lastBackgroundReview, null);
  assert.equal(calls.length, 1, "plain conversation must not spend review tokens");
});

test("AgentHost preserves project scope and model routing in post-session review", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = new ProjectStore({
    dataDir: path.join(root, "data"),
    defaultWorkspaceRoot: path.join(root, "default")
  });
  const project = projects.create({
    id: "review-project",
    name: "Review Project",
    modelProfile: { model: "project-review-model" },
    routingProfile: { task: "project-review", tier: "mini" }
  });
  const runtime = { ...hostRuntime(), projects };
  const calls = [];
  const host = new AgentHost({
    runtime,
    workspaceDir: path.join(root, "default"),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: {
      async review(turn) {
        calls.push(turn);
        return { skipped: false };
      }
    }
  });

  await host.handleMessage({
    sessionId: "project-review-session",
    projectId: project.id,
    text: "build the project report"
  });
  host.resetSession({
    sessionId: "project-review-session",
    nextSessionId: "project-review-next"
  });
  await host.lastBackgroundReview;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, project.id);
  assert.equal(calls[0].projectRevision, project.revision);
  assert.equal(calls[0].memoryScope, `project:${project.id}`);
  assert.deepEqual(calls[0].modelProfile, { model: "project-review-model" });
  assert.deepEqual(calls[0].routingProfile, { task: "project-review", tier: "mini" });
});

test("durable review watermarks process only appended substantive messages across reopen and restart", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const calls = [];
  const reviewer = {
    async review(turn) {
      calls.push(turn);
      return { skipped: false };
    }
  };
  const store = new InMemoryAgentStore();
  const host = new AgentHost({
    runtime: hostRuntime(),
    store,
    modelProvider: primaryProvider(),
    backgroundReviewer: reviewer
  });

  await host.handleMessage({ sessionId: "review-watermark", text: "build first" });
  host.resetSession({ sessionId: "review-watermark", nextSessionId: "after-first" });
  await host.lastBackgroundReview;
  const firstSession = store.getSession("review-watermark");
  const firstWatermark = firstSession.metadata.backgroundReviewV1;
  assert.equal(firstWatermark.reviewedMessageCount, 2);
  assert.equal(firstWatermark.reviewedLastMessageId, firstSession.messages[1].id);

  await host.handleMessage({ sessionId: "review-watermark", text: "build second" });
  host.resetSession({ sessionId: "review-watermark", nextSessionId: "after-second" });
  await host.lastBackgroundReview;
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].messages.map((message) => message.content),
    ["build second", "Finished the work."],
    "a reopened session reviews only the suffix after its durable watermark"
  );

  const restarted = new AgentHost({
    runtime: hostRuntime(),
    store,
    modelProvider: primaryProvider(),
    backgroundReviewer: reviewer
  });
  const repeated = restarted.queueBackgroundReviewForSession("review-watermark");
  assert.equal(repeated, null, "a host restart does not rereview an unchanged transcript");
  assert.equal(calls.length, 2);
});

test("session review excludes turns that explicitly opt out", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const calls = [];
  const host = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: {
      async review(turn) {
        calls.push(turn);
        return { skipped: false };
      }
    }
  });

  await host.handleMessage({ sessionId: "review-opt-out", text: "build public one" });
  await host.handleMessage({
    sessionId: "review-opt-out",
    text: "build sensitive middle",
    backgroundReview: false
  });
  await host.handleMessage({ sessionId: "review-opt-out", text: "build public two" });
  host.resetSession({ sessionId: "review-opt-out", nextSessionId: "review-opt-out-next" });
  await host.lastBackgroundReview;

  const digestSource = calls[0].messages.map((message) => message.content).join("\n");
  assert.match(digestSource, /public one/);
  assert.match(digestSource, /public two/);
  assert.doesNotMatch(digestSource, /sensitive middle/);
});

test("reset-created sessions wait for successful review learning before freezing memory", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const memory = new MemorySystem();
  memory.remember(
    { content: "Existing preference.", scope: "main" },
    { id: "existing", tier: "medium", capacityManaged: true }
  );
  const snapshots = [];
  const runtime = {
    ...hostRuntime(),
    memory,
    processSignal: hostRuntime().processSignal
  };
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider: {
      ...primaryProvider(),
      async generate(request) {
        snapshots.push(request.sessionMemorySnapshot);
        return { provider: "fixture", model: "fixture", text: "Finished the work.", toolCalls: [] };
      }
    },
    backgroundReviewer: {
      async review() {
        memory.remember(
          { content: "Learned at session end.", scope: "main" },
          { id: "learned", tier: "medium", capacityManaged: true }
        );
        return { skipped: false };
      }
    },
    backgroundReviewSnapshotWaitMs: 500
  });

  await host.handleMessage({ sessionId: "review-before-reset", text: "build first" });
  host.resetSession({ sessionId: "review-before-reset", nextSessionId: "review-after-reset" });
  await host.handleMessage({ sessionId: "review-after-reset", text: "build second" });
  assert.match(snapshots[1], /Learned at session end/);

  host.resetSession({ sessionId: "review-after-reset", nextSessionId: "review-after-resolved" });
  await host.lastBackgroundReview;
  await host.handleMessage({ sessionId: "review-after-resolved", text: "build third" });
  assert.match(
    snapshots[2],
    /Learned at session end/,
    "cleanup after an already-resolved dependency is safe because learning is persisted first"
  );
});

test("reset-created session snapshots fail open after the bounded review wait", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: {
      async review() {
        await gate;
        return { skipped: false };
      }
    },
    backgroundReviewSnapshotWaitMs: 20
  });

  await host.handleMessage({ sessionId: "review-before-timeout", text: "build first" });
  host.resetSession({ sessionId: "review-before-timeout", nextSessionId: "review-after-timeout" });
  const startedAt = Date.now();
  const result = await host.handleMessage({ sessionId: "review-after-timeout", text: "build second" });
  assert.equal(result.reply, "Finished the work.");
  assert.ok(Date.now() - startedAt < 500, "a stuck auxiliary review cannot block the next user turn");
  release();
  await host.lastBackgroundReview;
});

test("session-end review preserves specialist memory scope", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  const calls = [];
  const store = new InMemoryAgentStore();
  store.ensureAgent({ id: "specialist-1", name: "Specialist", role: "specialist" });
  const host = new AgentHost({
    runtime: hostRuntime(),
    store,
    modelProvider: primaryProvider(),
    backgroundReviewer: {
      async review(turn) {
        calls.push(turn);
        return { skipped: false };
      }
    }
  });

  await host.handleMessage({
    sessionId: "specialist-review",
    agentId: "specialist-1",
    memoryScope: "specialist:private",
    routeTo: false,
    text: "build specialist report"
  });
  host.resetSession({ sessionId: "specialist-review", nextSessionId: "specialist-next" });
  await host.lastBackgroundReview;
  assert.equal(calls[0].agentId, "specialist-1");
  assert.equal(calls[0].memoryScope, "specialist:private");
});

test("endActiveHookSessions returns a bounded allSettled review flush", async (t) => {
  isolateEnv(t, "OPENAGI_BACKGROUND_REVIEW");
  process.env.OPENAGI_BACKGROUND_REVIEW = "1";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = new AgentHost({
    runtime: hostRuntime(),
    store: new InMemoryAgentStore(),
    modelProvider: primaryProvider(),
    backgroundReviewer: {
      async review(turn) {
        if (turn.sessionId === "review-shutdown-slow") await gate;
        return { skipped: false };
      }
    },
    backgroundReviewFlushMs: 20
  });

  await host.handleMessage({ sessionId: "review-shutdown-fast", text: "build quick shutdown report" });
  await host.handleMessage({ sessionId: "review-shutdown-slow", text: "build slow shutdown report" });
  const statuses = await host.endActiveHookSessions("test-close");
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].status, "fulfilled");
  assert.equal(statuses[1].status, "rejected");
  assert.match(statuses[1].reason.message, /flush exceeded/);
  release();
  await host.lastBackgroundReview;
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
  host.resetSession({ sessionId: "review-failure", nextSessionId: "review-failure-next" });
  assert.deepEqual(await host.lastBackgroundReview, { skipped: true, reason: "review failed: aux model unavailable" });
  assert.deepEqual(logged, ["aux model unavailable"]);
  assert.equal(host.store.getSession("review-failure").metadata.backgroundReviewV1, undefined);

  host.backgroundReviewer = { async review() { return { skipped: false }; } };
  const retry = host.queueBackgroundReviewForSession("review-failure");
  assert.ok(retry, "a failed review leaves no permanent in-process dedupe marker");
  await retry;
  assert.equal(host.store.getSession("review-failure").metadata.backgroundReviewV1.reviewedMessageCount, 2);
});

test("review parsing accepts fenced JSON but rejects prose", () => {
  assert.deepEqual(parseBackgroundReview('```json\n{"memories":[],"skill":null}\n```'), { memories: [], skill: null });
  assert.equal(parseBackgroundReview("Here is the review: none"), null);
});

test("warm-cache session digests are deterministic and bounded to recent messages", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}-${"x".repeat(80)}`
  }));
  const first = buildBackgroundReviewDigest(messages, { maxChars: 500 });
  const second = buildBackgroundReviewDigest(messages, { maxChars: 500 });
  assert.equal(first, second);
  assert.ok(first.length <= 500);
  assert.match(first, /older messages omitted/);
  assert.match(first, /message-19/);
  assert.doesNotMatch(first, /message-0-/);
});

test("post-session review sends the bounded digest without duplicating the last turn", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-background-digest-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let request;
  const reviewer = new BackgroundReviewer({
    dataDir,
    runtime: { memory: new MemorySystem() },
    modelProvider: {
      isConfigured: () => true,
      async generate(value) {
        request = value;
        return { text: '{"memories":[],"skill":null}' };
      }
    }
  });
  await reviewer.review({
    sessionId: "digest",
    userText: "LAST USER",
    assistantText: "LAST ASSISTANT",
    messages: [
      { role: "user", content: "LAST USER" },
      { role: "assistant", content: "LAST ASSISTANT" }
    ]
  });

  assert.match(request.input, /Warm-cache session digest/);
  assert.equal((request.input.match(/LAST USER/g) ?? []).length, 1);
  assert.equal((request.input.match(/LAST ASSISTANT/g) ?? []).length, 1);
  assert.equal(request.task, "review");
  assert.deepEqual(request.context.__advertisedTools, []);
});

test("a full curated projection stages review candidates without blocking skills", async (t) => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 16 });
  memory.remember({ content: "12345", scope: "main" }, { tier: "medium", capacityManaged: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-background-full-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const skills = [];
  const runtime = {
    memory,
    pendingActions: new PendingActionStore({ dir: path.join(dataDir, "pending-actions") }),
    proactiveObserver: {
      persist(candidate) {
        skills.push(candidate);
        return { candidate };
      }
    }
  };
  const reviewer = new BackgroundReviewer({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      async generate() {
        return {
          text: JSON.stringify({
            memories: [{ content: "new fact", kind: "preference", confidence: "high" }],
            skill: { title: "Safe draft", rationale: "repeatable", draftBody: "Do the safe steps." }
          })
        };
      }
    }
  });

  const result = await reviewer.review({ sessionId: "full", memoryScope: "main" });
  assert.equal(result.skipped, false);
  assert.equal(result.applied.memories.length, 1);
  assert.equal(result.applied.memoryErrors.length, 0);
  assert.equal(memory.items.size, 1, "capacity is checked at the human-approved mutation boundary");
  assert.equal(skills.length, 1);
});

test("a staged background memory needs an exact human approval and cannot be auto-promoted", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-background-approval-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const memory = new MemorySystem();
  const pendingActions = new PendingActionStore({ dir: path.join(dataDir, "pending-actions") });
  const tools = new ToolRegistry();
  const runtime = { memory, pendingActions, tools };
  tools.bindPendingActions(pendingActions);
  registerCoreTools(tools, runtime);

  const reviewer = new BackgroundReviewer({
    runtime,
    dataDir,
    modelProvider: {
      isConfigured: () => true,
      async generate() {
        return {
          text: JSON.stringify({
            memories: [{
              content: "The user prefers weekly rollout summaries.",
              kind: "preference",
              confidence: "high",
              tags: ["rollout"]
            }],
            skill: null
          })
        };
      }
    }
  });
  const reviewed = await reviewer.review({ sessionId: "approval-session", memoryScope: "main" });
  const action = pendingActions.get(reviewed.applied.memories[0].actionId);
  assert.equal(memory.items.size, 0);
  assert.equal(tools.toOpenAITools().some((tool) => tool.name === "apply_background_memory_proposal"), false);

  await assert.rejects(() => tools.get("apply_background_memory_proposal").handler(action.args, {
    sessionId: "approval-session",
    __memoryScope: "main"
  }), /explicit human approval/);
  assert.equal(memory.items.size, 0);

  const approved = await approvePendingAction(runtime, action.id, {
    decidedBy: "human-reviewer",
    approvedVia: "test"
  });
  assert.equal(approved.ok, true);
  assert.equal(memory.items.size, 1);
  const item = [...memory.items.values()][0];
  assert.equal(item.tier, "long");
  assert.equal(item.metadata.provenance.trust, "human-approved-model-proposal");
  assert.equal(item.metadata.provenance.approvalActionId, action.id);
});

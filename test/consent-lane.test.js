// Explicit user consent outranks a low-evidence scrutiny score, but the raw
// score/action must survive for audit. These tests exercise that split through
// AgentHost instead of only testing the phrase matcher in isolation.
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import {
  AgentHost,
  CONSENT_PHRASE_PATTERNS,
  confirmPolicyReason,
  isExplicitConsent,
  verdictGuidance
} from "../src/agent-host.js";

function isolateAutoApprove(t) {
  const previous = process.env.OPENAGI_AUTO_APPROVE;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previous;
  });
}

function makeHost(rawVerdict = "ask") {
  const captured = { model: null, outcome: null };
  const store = new InMemoryAgentStore();
  const runtime = {
    tools: {
      toOpenAITools: ({ readOnly = false } = {}) => readOnly
        ? [{ name: "lookup_thing" }]
        : [{ name: "lookup_thing" }, { name: "send_thing" }]
    },
    memory: { remember: () => ({ id: "memory_1" }) },
    outcomes: {
      resolveByUserFollowup() {},
      record(input) {
        captured.outcome = input;
        return { id: "outcome_1" };
      }
    },
    processSignal: () => ({
      id: "output_1",
      scrutiny: {
        action: rawVerdict,
        score: 0.54,
        reasons: ["short low-evidence reply"],
        dimensions: { novelty: 0.2, risk: 0.2, repetition: 0.3 }
      },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    store,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      async generate(args) {
        captured.model = args;
        return { text: "Working on it.", provider: "stub", model: "stub", id: "response_1", toolCalls: [] };
      }
    }
  });
  return { captured, host, store };
}

function seedAssistantQuestion(store, sessionId, question = "Should I go ahead with the implementation?") {
  store.appendMessage(sessionId, { role: "user", content: "Please prepare the implementation." });
  store.appendMessage(sessionId, { role: "assistant", content: question });
}

test("consent phrase detector exports its regex list and rejects stops or new questions", () => {
  assert.ok(CONSENT_PHRASE_PATTERNS.length >= 4);
  assert.ok(CONSENT_PHRASE_PATTERNS.every((pattern) => pattern instanceof RegExp));

  const positives = [
    "go ahead", "yes", "Yep!", "yeah", "do it", "proceed", "continue",
    "approved", "ok", "okay", "ok go", "okay go ahead", "sounds good",
    "whatever you want", "whatever you prefer", "either", "you choose",
    "you pick", "full send", "[Spencer] yes, go ahead"
  ];
  for (const phrase of positives) {
    assert.equal(isExplicitConsent(phrase), true, `expected consent: ${phrase}`);
  }

  const negatives = [
    "no", "no, wait", "stop", "not yet", "don't continue", "okay but wait",
    "I said yes yesterday", "Could you compare the two approaches?",
    "yes, but what will happen?", "continue?"
  ];
  for (const phrase of negatives) {
    assert.equal(isExplicitConsent(phrase), false, `must not infer consent: ${phrase}`);
  }
});

test("AgentHost consent lane acts while retaining the raw ask verdict for audit", async () => {
  const { captured, host, store } = makeHost("ask");
  const sessionId = "consent-session";
  seedAssistantQuestion(store, sessionId);
  const events = [];

  const result = await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId,
    text: "[Spencer] ok go ahead",
    onToolEvent: (event) => events.push(event)
  });

  assert.equal(result.output.scrutiny.action, "ask", "raw scrutiny remains unchanged for audit");
  assert.equal(captured.outcome.scrutinyAction, "ask");
  assert.equal(captured.outcome.metadata.consentOverride, true);
  assert.equal(captured.outcome.metadata.effectiveScrutinyAction, "act");
  assert.equal(captured.model.scrutiny.action, "act");
  assert.equal(captured.model.context.__scrutinyPolicy, null, "consent receives full tool access");
  assert.match(captured.model.turnContext, /Current decision: act/);
  assert.match(captured.model.turnContext, /Consent lane:.*proceed now/i);
  assert.doesNotMatch(captured.model.turnContext, /clarify before acting/i);
  assert.deepEqual(events, [{ phase: "verdict", action: "act", score: 0.54 }]);
});

test("a direct answer after one clarifying question damps a repeated ask verdict", async () => {
  const { captured, host, store } = makeHost("ask");
  const sessionId = "damping-session";
  seedAssistantQuestion(store, sessionId, "Should I use the blue or green option?");

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Use the blue option."
  });

  assert.equal(isExplicitConsent("Use the blue option."), false, "this path is damping, not phrase consent");
  assert.equal(captured.model.scrutiny.action, "act");
  assert.equal(captured.model.context.__scrutinyPolicy, null);
  assert.equal(captured.outcome.metadata.consentOverride, false);
  assert.equal(captured.outcome.metadata.askDamped, true);
  assert.match(captured.outcome.metadata.verdictOverrideReason, /clarifying question/i);

  // A stop/delay or a genuinely new question is not the answer that closes
  // the clarification lane, so neither may be promoted to act.
  for (const reply of ["no, wait", "Could you compare those options first?"]) {
    const blocked = makeHost("ask");
    const blockedSession = `blocked-${reply.length}`;
    seedAssistantQuestion(blocked.store, blockedSession);
    await blocked.host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: blockedSession,
      text: reply
    });
    assert.equal(blocked.captured.model.scrutiny.action, "ask", `must preserve ask for: ${reply}`);
    assert.equal(blocked.captured.outcome.metadata.askDamped, false);
    assert.equal(blocked.captured.outcome.metadata.consentOverride, false);
  }
});

test("ask guidance and confirmation reasons tell the truth about auto-approve", (t) => {
  isolateAutoApprove(t);

  process.env.OPENAGI_AUTO_APPROVE = "1";
  const automatic = verdictGuidance("ask");
  assert.match(automatic, /proceed with the requested work/i);
  assert.match(automatic, /will run immediately/i);
  assert.match(automatic, /logged.*audit/i);
  assert.doesNotMatch(automatic, /queued for the user's approval|act next turn/i);
  assert.match(confirmPolicyReason(0.54), /execute immediately.*audit/i);

  process.env.OPENAGI_AUTO_APPROVE = "0";
  const manual = verdictGuidance("ask");
  assert.match(manual, /ask ONE focused clarifying question/i);
  assert.match(manual, /queued for the user's approval/i);
  assert.doesNotMatch(manual, /will run immediately/i);
  assert.match(confirmPolicyReason(0.54), /queued for user approval/i);
});

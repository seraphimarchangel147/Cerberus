import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  REASONING_EFFORTS,
  resolveReasoningEffort
} from "../src/model-provider.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

async function captureOpenAI(options = {}) {
  const bodies = [];
  const notes = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: options.model ?? "gpt-5",
    env: options.env ?? {},
    maxIterations: 1,
    stallTimeoutMs: 0,
    reasoningEffort: options.reasoningEffort,
    reasoningDebugLog: (message) => {
      notes.push(message);
    }
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return {
      id: "response-1",
      output_text: "done",
      output: []
    };
  };
  await provider.generate({
    input: "reason carefully",
    instructions: "test"
  });
  return { body: bodies[0], notes };
}

async function captureAnthropic(options = {}) {
  const bodies = [];
  const notes = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: options.model ?? "claude-sonnet-4-6",
    env: options.env ?? {},
    maxIterations: 1,
    maxTokens: 8192,
    stallTimeoutMs: 0,
    reasoningEffort: options.reasoningEffort,
    reasoningDebugLog: (message) => {
      notes.push(message);
    }
  });
  provider.postMessages = async (body) => {
    bodies.push(structuredClone(body));
    return {
      id: "message-1",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  await provider.generate({
    input: "reason carefully",
    instructions: "test"
  });
  return { body: bodies[0], notes };
}

test("reasoning effort resolves the canonical union and omits invalid values", () => {
  assert.deepEqual(
    REASONING_EFFORTS,
    ["minimal", "low", "medium", "high", "xhigh", "max"]
  );
  for (const effort of REASONING_EFFORTS) {
    assert.equal(
      resolveReasoningEffort({}, { OPENAGI_REASONING_EFFORT: effort }),
      effort
    );
  }
  assert.equal(
    resolveReasoningEffort(
      { reasoningEffort: "high" },
      { OPENAGI_REASONING_EFFORT: "low" }
    ),
    "high"
  );
  assert.equal(resolveReasoningEffort({}, {}), null);
  assert.equal(
    resolveReasoningEffort({}, { OPENAGI_REASONING_EFFORT: "ultra" }),
    null
  );
});

test("unset reasoning effort preserves exact request key omission", async () => {
  const openai = await captureOpenAI();
  const anthropic = await captureAnthropic();

  assert.equal(Object.hasOwn(openai.body, "reasoning"), false);
  assert.equal(Object.hasOwn(openai.body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(anthropic.body, "thinking"), false);
  assert.doesNotMatch(JSON.stringify(openai.body), /reasoning/u);
  assert.doesNotMatch(JSON.stringify(anthropic.body), /thinking/u);
});

test("OPENAGI_REASONING_EFFORT reaches provider request construction", async () => {
  const openai = await captureOpenAI({
    env: { OPENAGI_REASONING_EFFORT: "medium" }
  });
  const anthropic = await captureAnthropic({
    env: { OPENAGI_REASONING_EFFORT: "medium" }
  });

  assert.deepEqual(openai.body.reasoning, { effort: "medium" });
  assert.deepEqual(anthropic.body.thinking, {
    type: "enabled",
    budget_tokens: 3510
  });
});

test("every canonical tier reaches both supported request wire formats", async () => {
  const expectedAnthropicBudgets = [
    1170,
    2340,
    3510,
    4681,
    5851,
    7021
  ];

  for (const [index, effort] of REASONING_EFFORTS.entries()) {
    const openai = await captureOpenAI({ reasoningEffort: effort });
    const anthropic = await captureAnthropic({ reasoningEffort: effort });
    assert.deepEqual(openai.body.reasoning, { effort });
    assert.deepEqual(anthropic.body.thinking, {
      type: "enabled",
      budget_tokens: expectedAnthropicBudgets[index]
    });
  }
});

test("unsupported reasoning routes omit instead of silently downgrading", async () => {
  const openai = await captureOpenAI({
    model: "gpt-4.1",
    reasoningEffort: "max"
  });
  const anthropic = await captureAnthropic({
    model: "kimi-k3",
    reasoningEffort: "max"
  });

  assert.equal(Object.hasOwn(openai.body, "reasoning"), false);
  assert.equal(Object.hasOwn(anthropic.body, "thinking"), false);
  assert.ok(openai.notes.some((message) => /max.*gpt-4\.1/u.test(message)));
  assert.ok(anthropic.notes.some((message) => /max.*kimi-k3/u.test(message)));
});

test("hostile reasoning configuration fails open to field omission", async () => {
  const hostile = {
    toString() {
      throw new Error("hostile effort");
    }
  };

  assert.equal(resolveReasoningEffort({ reasoningEffort: hostile }, {}), null);
  const { body } = await captureOpenAI({ reasoningEffort: hostile });
  assert.equal(Object.hasOwn(body, "reasoning"), false);
});

test("reasoning effort is setup-wizard persistable", () => {
  assert.equal(SETUP_FIELDS.includes("OPENAGI_REASONING_EFFORT"), true);
});

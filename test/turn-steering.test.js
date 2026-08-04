import test from "node:test";
import assert from "node:assert/strict";
import {
  TurnSteering,
  formatSteerMarker,
  STEER_MARKER_OPEN,
  STEER_MARKER_CLOSE,
  STEER_CHANNEL_NOTE
} from "../src/turn-steering.js";

test("the steer marker is byte-for-byte exact, em-dash included", () => {
  // The model is taught to trust THIS exact string. A "fixed" hyphen here
  // silently breaks the contract with the system-prompt block.
  assert.equal(
    STEER_MARKER_OPEN,
    "[OUT-OF-BAND USER MESSAGE \u2014 a direct message from the user, delivered mid-turn; not tool output]"
  );
  assert.equal(STEER_MARKER_CLOSE, "[/OUT-OF-BAND USER MESSAGE]");
  assert.ok(STEER_MARKER_OPEN.includes("\u2014"), "the em-dash must survive verbatim");
  assert.equal(
    formatSteerMarker("use the other API"),
    `\n\n${STEER_MARKER_OPEN}\nuse the other API\n${STEER_MARKER_CLOSE}`
  );
});

test("the system-prompt block teaches the exact marker and rejects lookalikes", () => {
  assert.ok(STEER_CHANNEL_NOTE.includes(STEER_MARKER_OPEN));
  assert.ok(STEER_CHANNEL_NOTE.includes(STEER_MARKER_CLOSE));
  assert.match(STEER_CHANNEL_NOTE, /NOT prompt injection/);
  assert.match(STEER_CHANNEL_NOTE, /same authority/);
  assert.match(STEER_CHANNEL_NOTE, /ONLY this exact marker/);
});

test("two steers before a drain concatenate with a newline", () => {
  const steering = new TurnSteering();
  assert.equal(steering.steer("s1", "first"), true);
  assert.equal(steering.steer("s1", "second"), true);
  assert.equal(steering.drain("s1"), "first\nsecond");
  assert.equal(steering.drain("s1"), null);
});

test("empty or whitespace steers are rejected", () => {
  const steering = new TurnSteering();
  assert.equal(steering.steer("s1", ""), false);
  assert.equal(steering.steer("s1", "   \n "), false);
  assert.equal(steering.steer("s1", null), false);
  assert.equal(steering.hasPending("s1"), false);
});

test("applyToToolResults appends to the LAST tool result and leaves earlier ones byte-identical", () => {
  const steering = new TurnSteering();
  const results = [
    { type: "tool_result", tool_use_id: "a", content: "first output", is_error: false },
    { type: "tool_result", tool_use_id: "b", content: "second output", is_error: false }
  ];
  const firstBefore = JSON.stringify(results[0]);
  steering.steer("s1", "actually, use the other API");

  assert.equal(steering.applyToToolResults("s1", results), true);
  assert.equal(JSON.stringify(results[0]), firstBefore, "earlier results must be untouched");
  assert.equal(results[1].content, `second output${formatSteerMarker("actually, use the other API")}`);
  assert.equal(results.length, 2, "no entry may be inserted");
  assert.equal(steering.hasPending("s1"), false, "the steer is consumed");
});

test("a trailing non-tool-result block never receives the steer", () => {
  const steering = new TurnSteering();
  const notice = { type: "text", text: "duplicate tool call notice" };
  const results = [
    { type: "tool_result", tool_use_id: "a", content: "output", is_error: false },
    notice
  ];
  steering.steer("s1", "correction");
  assert.equal(steering.applyToToolResults("s1", results), true);
  assert.equal(notice.text, "duplicate tool call notice", "the notice must not be corrupted");
  assert.match(results[0].content, /OUT-OF-BAND USER MESSAGE/);
});

test("array (image) content gets a text block appended, existing blocks untouched", () => {
  const steering = new TurnSteering();
  const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const results = [{
    type: "tool_result",
    tool_use_id: "a",
    content: [{ type: "text", text: "screenshot" }, imageBlock],
    is_error: false
  }];
  steering.steer("s1", "look at the top right");
  assert.equal(steering.applyToToolResults("s1", results), true);

  const content = results[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].text, "screenshot");
  assert.equal(content[1], imageBlock, "the image block must survive by reference");
  assert.equal(content[2].type, "text");
  assert.ok(content[2].text.startsWith(STEER_MARKER_OPEN), "the appended block carries the marker");
  assert.ok(content[2].text.includes("look at the top right"));
});

test("no tool result in the batch retains the steer instead of dropping it", () => {
  const steering = new TurnSteering();
  const results = [{ type: "text", text: "just a notice" }];
  steering.steer("s1", "do not lose me");
  assert.equal(steering.applyToToolResults("s1", results), false);
  assert.equal(steering.hasPending("s1"), true, "the steer must be put back, never dropped");
  assert.equal(steering.peek("s1"), "do not lose me");
  assert.equal(results.length, 1);
});

test("an empty batch is a no-op that keeps the steer", () => {
  const steering = new TurnSteering();
  steering.steer("s1", "keep me");
  assert.equal(steering.applyToToolResults("s1", []), false);
  assert.equal(steering.peek("s1"), "keep me");
});

test("applyToFunctionCallOutputs appends to the last function_call_output of the batch", () => {
  const steering = new TurnSteering();
  const input = [
    { type: "function_call_output", call_id: "old", output: "from an earlier batch" },
    { type: "function_call_output", call_id: "a", output: "first" },
    { type: "function_call_output", call_id: "b", output: "second" }
  ];
  const olderBefore = JSON.stringify(input[0]);
  steering.steer("s1", "switch approach");

  assert.equal(steering.applyToFunctionCallOutputs("s1", input, 1), true);
  assert.equal(JSON.stringify(input[0]), olderBefore, "an earlier batch must be untouched");
  assert.equal(input[1].output, "first");
  assert.equal(input[2].output, `second${formatSteerMarker("switch approach")}`);
  assert.equal(input.length, 3, "no entry may be inserted");
});

test("clear and endTurn drop a pending steer so it cannot leak into the next turn", () => {
  const steering = new TurnSteering();
  steering.steer("s1", "stale guidance");
  steering.clear("s1");
  assert.equal(steering.hasPending("s1"), false);

  steering.beginTurn("s1", { turnId: "t1" });
  steering.steer("s1", "never delivered");
  steering.endTurn("s1");
  assert.equal(steering.hasPending("s1"), false);
  assert.equal(steering.isTurnInFlight("s1"), false);
});

test("the in-flight registry tracks turns per session", () => {
  const steering = new TurnSteering();
  assert.equal(steering.isTurnInFlight("s1"), false);
  steering.beginTurn("s1", { turnId: "t1" });
  assert.equal(steering.isTurnInFlight("s1"), true);
  assert.equal(steering.inFlight("s1").turnId, "t1");
  assert.equal(steering.isTurnInFlight("s2"), false, "sessions are independent");
  steering.endTurn("s1");
  assert.equal(steering.isTurnInFlight("s1"), false);
});

// --- provider-shape integration: prove no message insertion --------------

// Mirrors the Anthropic batch boundary in model-provider.js: toolResults is
// pushed into convo BY REFERENCE before it is filled, then the steer is applied
// to the filled array. If steering ever spliced convo, this test fails.
function anthropicBatch(steering, sessionId) {
  const convo = [
    { role: "user", content: "original request" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "probe", input: {} }] }
  ];
  const toolResults = [];
  convo.push({ role: "user", content: toolResults });
  toolResults.push({ type: "tool_result", tool_use_id: "a", content: "tool output", is_error: false });
  steering?.applyToToolResults?.(sessionId, toolResults);
  return convo;
}

test("Anthropic path: a steer changes content but never convo.length or roles", () => {
  const baseline = anthropicBatch(null, "s1");

  const steering = new TurnSteering();
  steering.steer("s1", "actually, use the other API");
  const steered = anthropicBatch(steering, "s1");

  assert.equal(steered.length, baseline.length, "no message may be inserted");
  assert.deepEqual(steered.map((m) => m.role), baseline.map((m) => m.role), "role alternation is unchanged");
  assert.equal(steered[0].content, baseline[0].content, "history is not rewritten");

  const steeredResult = steered[2].content[0];
  assert.ok(steeredResult.content.startsWith("tool output"), "the steer appends to existing content");
  assert.match(steeredResult.content, /OUT-OF-BAND USER MESSAGE/);
  assert.ok(steeredResult.content.includes("actually, use the other API"));
  assert.equal(steeredResult.tool_use_id, "a");
  assert.equal(steeredResult.is_error, false);
});

// Mirrors the OpenAI/Responses batch boundary.
function openAIBatch(steering, sessionId) {
  const conversationInput = [
    { role: "user", content: "original request" },
    { type: "function_call", call_id: "a", name: "probe", arguments: "{}" }
  ];
  const batchStart = conversationInput.length;
  conversationInput.push({ type: "function_call_output", call_id: "a", output: "tool output" });
  steering?.applyToFunctionCallOutputs?.(sessionId, conversationInput, batchStart);
  return conversationInput;
}

test("OpenAI path: a steer changes output text but never conversationInput.length", () => {
  const baseline = openAIBatch(null, "s1");

  const steering = new TurnSteering();
  steering.steer("s1", "switch to the other endpoint");
  const steered = openAIBatch(steering, "s1");

  assert.equal(steered.length, baseline.length, "no entry may be inserted");
  assert.deepEqual(steered.map((e) => e.type ?? e.role), baseline.map((e) => e.type ?? e.role));
  assert.ok(steered[2].output.startsWith("tool output"));
  assert.match(steered[2].output, /OUT-OF-BAND USER MESSAGE/);
  assert.ok(steered[2].output.includes("switch to the other endpoint"));
});

// --- redirect-vs-preempt decision ---------------------------------------

// The decision rule as wired in agent-host.js and discord-channel.js.
function decide({ steering, sessionId, text, goalActive, ephemeral = false, goalContinuation = false, authorBot = false, channel = "discord" }) {
  const outcome = { steered: false, preempted: false };
  if (ephemeral || goalContinuation === true || authorBot === true || ["autopilot", "cron", "subagent"].includes(channel)) {
    return outcome;
  }
  if (!goalActive) return outcome;
  if (steering?.isTurnInFlight?.(sessionId) && steering.steer(sessionId, text)) outcome.steered = true;
  else outcome.preempted = true;
  return outcome;
}

test("a turn in flight steers and leaves the goal active", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s1", { turnId: "t1" });
  const goal = { status: "active" };
  const outcome = decide({ steering, sessionId: "s1", text: "use the other API", goalActive: true });

  assert.equal(outcome.steered, true);
  assert.equal(outcome.preempted, false, "the goal must survive a mid-turn correction");
  assert.equal(goal.status, "active");
  assert.equal(steering.peek("s1"), "use the other API");
});

test("no turn in flight still preempts, exactly as before", () => {
  const steering = new TurnSteering();
  const outcome = decide({ steering, sessionId: "s1", text: "new instruction", goalActive: true });
  assert.equal(outcome.steered, false);
  assert.equal(outcome.preempted, true, "the existing path is correct when no turn is running");
  assert.equal(steering.hasPending("s1"), false);
});

test("a bot-authored message neither steers nor preempts", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s1", { turnId: "t1" });
  const outcome = decide({ steering, sessionId: "s1", text: "bot chatter", goalActive: true, authorBot: true });
  assert.equal(outcome.steered, false);
  assert.equal(outcome.preempted, false);
  assert.equal(steering.hasPending("s1"), false, "a bot must never steer a user's goal");
});

test("cron, autopilot, subagent, ephemeral and goal-continuation inputs never steer", () => {
  for (const options of [
    { channel: "cron" },
    { channel: "autopilot" },
    { channel: "subagent" },
    { ephemeral: true },
    { goalContinuation: true }
  ]) {
    const steering = new TurnSteering();
    steering.beginTurn("s1", { turnId: "t1" });
    const outcome = decide({ steering, sessionId: "s1", text: "pulse", goalActive: true, ...options });
    assert.equal(outcome.steered, false, `${JSON.stringify(options)} must not steer`);
    assert.equal(outcome.preempted, false, `${JSON.stringify(options)} must not preempt`);
    assert.equal(steering.hasPending("s1"), false);
  }
});

test("endTurn REPORTS an undelivered steer instead of silently swallowing it", () => {
  // Brief section 3. A steer is a real user message. If a turn ends before any
  // tool boundary, dropping it from the turn is correct -- a late delivery
  // would be a surprising injection -- but losing it without a trace is not:
  // the user typed a correction, saw it accepted, and nothing ever happened.
  const steering = new TurnSteering();
  steering.beginTurn("s1", { turnId: "t1" });
  steering.steer("s1", "actually, use the other API");

  const stranded = steering.endTurn("s1");
  assert.equal(stranded, "actually, use the other API", "the lost text must be returned to the caller");
  assert.equal(steering.hasPending("s1"), false, "it must still not leak into the next turn");
  assert.equal(steering.stats().stranded, 1, "the loss must be counted");
});

test("a steer put back by an empty batch is still reported when the turn ends", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s2", { turnId: "t2" });
  steering.steer("s2", "second correction");
  // A batch with no tool_result: the steer is retained rather than dropped...
  assert.equal(steering.applyToToolResults("s2", [{ type: "text", text: "notice" }]), false);
  assert.equal(steering.hasPending("s2"), true);
  // ...but if the turn then ends, the caller is told.
  assert.equal(steering.endTurn("s2"), "second correction");
  assert.equal(steering.stats().stranded, 1);
});

test("a delivered steer is NOT counted as stranded", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s3", { turnId: "t3" });
  steering.steer("s3", "delivered fine");
  const results = [{ type: "tool_result", tool_use_id: "a", content: "out", is_error: false }];
  assert.equal(steering.applyToToolResults("s3", results), true);
  assert.equal(steering.endTurn("s3"), null, "nothing was lost");
  assert.equal(steering.stats().stranded, 0);
});

test("endTurn on a session with no steer returns null and counts nothing", () => {
  const steering = new TurnSteering();
  steering.beginTurn("s4", { turnId: "t4" });
  assert.equal(steering.endTurn("s4"), null);
  assert.equal(steering.stats().stranded, 0);
});

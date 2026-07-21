// Context reduction must be invisible below its thresholds and structurally
// safe above them. Full oversized evidence remains retrievable out of band.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  capToolOutput,
  compactConversation,
  reconcileOrphanedToolCalls
} from "../src/model-provider.js";
import { ToolOutputStore } from "../src/tool-output-store.js";

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-tool-output-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ToolOutputStore({ dir });
}

test("oversized tool output is capped with a retrievable ref", (t) => {
  const store = makeStore(t);
  const value = { body: `HEAD-${"x".repeat(1000)}-TAIL` };
  const full = JSON.stringify(value);
  const capped = capToolOutput(value, { maxChars: 220, store });

  assert.equal(capped.truncated, true);
  assert.ok(capped.output.length <= 220);
  assert.match(capped.output, /chars elided; full output at ref:out_[a-f0-9]{16}/);
  assert.match(capped.output, /HEAD-/);
  assert.match(capped.output, /-TAIL/);
  assert.equal(store.read(capped.ref, { maxChars: 5000 }).content, full);
  assert.throws(() => store.read("../secret"), /invalid tool-output ref/i);
});

test("under-cap tool output remains byte-identical", (t) => {
  const store = makeStore(t);
  const value = { ok: true, rows: [1, 2, 3] };
  const expected = JSON.stringify(value);
  const capped = capToolOutput(value, { maxChars: expected.length, store });
  assert.deepEqual(capped, {
    output: expected,
    ref: null,
    truncated: false,
    originalChars: expected.length
  });
  assert.deepEqual(fs.readdirSync(store.dir), []);
});

test("over-budget transcript becomes a recap plus verbatim recent complete hops", () => {
  const conversation = [
    { role: "user", content: `old request ${"a".repeat(500)}` },
    { type: "function_call", call_id: "old-call", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "old-call", output: `old result ${"b".repeat(800)}` },
    { role: "assistant", content: `old analysis ${"c".repeat(500)}` },
    { role: "user", content: "recent request" },
    { type: "function_call", call_id: "recent-call", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "recent-call", output: "recent result" },
    { role: "user", content: "current user turn" }
  ];
  const recent = structuredClone(conversation.slice(-3));
  const before = JSON.stringify(conversation).length;

  const result = compactConversation(conversation, {
    format: "openai",
    budgetChars: 700,
    keepRecentHops: 1
  });

  assert.equal(result.compacted, true);
  assert.ok(result.afterChars < before);
  assert.match(conversation[0].content, /^\[context recap:/);
  assert.deepEqual(conversation.slice(-3), recent);
  assert.equal(reconcileOrphanedToolCalls(conversation, "openai"), 0);
});

test("short successful turn sends the historical conversation bytes unchanged", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxToolOutputChars: 8000,
    contextCompactChars: 120000
  });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return { id: "done", output_text: "ok" };
  };

  const result = await provider.generate({ input: "hello", instructions: "test" });
  assert.equal(result.text, "ok");
  assert.equal(bodies.length, 1);
  assert.equal(JSON.stringify(bodies[0].input), JSON.stringify([{ role: "user", content: "hello" }]));
});

test("later hops receive a capped tool result whose full value is retrievable", async (t) => {
  const store = makeStore(t);
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxToolOutputChars: 200,
    contextCompactChars: 120000,
    maxIterations: 3
  });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? { output: [{ type: "function_call", call_id: "call-1", name: "large_dump", arguments: "{}" }] }
      : { output_text: "done" };
  };
  const fullValue = { dump: `begin-${"z".repeat(1000)}-end` };

  await provider.generate({
    input: "inspect",
    instructions: "test",
    context: { __toolOutputStore: store },
    tools: [{ type: "function", name: "large_dump" }],
    toolRegistry: { invoke: async () => ({ ok: true, result: fullValue }) }
  });

  const output = bodies[1].input.find((item) => item.type === "function_call_output").output;
  const ref = /ref:(out_[a-f0-9]{16})/.exec(output)?.[1];
  assert.ok(ref);
  assert.equal(store.read(ref, { maxChars: 5000 }).content, JSON.stringify(fullValue));
});

test("Anthropic tool_result blocks use the same capped ref path", async (t) => {
  const store = makeStore(t);
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    model: "test-model",
    maxToolOutputChars: 200,
    contextCompactChars: 120000,
    maxIterations: 3,
    stallTimeoutMs: 0
  });
  const bodies = [];
  provider.postMessages = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1
      ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "use-1", name: "large_dump", input: {} }] }
      : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
  };
  const fullValue = { dump: `begin-${"q".repeat(1000)}-end` };

  await provider.generate({
    input: "inspect",
    instructions: "test",
    context: { __toolOutputStore: store },
    toolRegistry: {
      toAnthropicTools: () => [{ name: "large_dump", input_schema: { type: "object" } }],
      invoke: async () => ({ ok: true, result: fullValue })
    }
  });

  const blocks = bodies[1].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  const output = blocks.find((block) => block.type === "tool_result").content;
  const ref = /ref:(out_[a-f0-9]{16})/.exec(output)?.[1];
  assert.ok(ref);
  assert.equal(store.read(ref, { maxChars: 5000 }).content, JSON.stringify(fullValue));
});

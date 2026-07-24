import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

const agent = { id: "main", name: "Main Agent" };

test("OpenAI rejects valid non-object JSON arguments before registry dispatch", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  const sent = [];
  provider.postResponses = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "response-call",
        output: [{
          type: "function_call",
          call_id: "call-1",
          name: "fixture_tool",
          arguments: "[]"
        }]
      };
    }
    return {
      id: "response-final",
      output_text: "done",
      output: []
    };
  };
  let invoked = 0;
  const result = await provider.generate({
    input: "run it",
    agent,
    tools: [{
      type: "function",
      name: "fixture_tool",
      description: "Fixture.",
      parameters: { type: "object", properties: {} }
    }],
    toolRegistry: {
      invoke: async () => {
        invoked += 1;
        return { ok: true, result: {} };
      }
    }
  });

  assert.equal(invoked, 0);
  assert.equal(result.toolCalls[0].result.outcome.code, "invalid_tool_arguments");
  const output = JSON.parse(
    sent[1].input.find((item) => item.type === "function_call_output").output
  );
  assert.equal(output.outcome.code, "invalid_tool_arguments");
});

test("Anthropic rejects non-object tool input before registry dispatch", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  const sent = [];
  provider.postMessages = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "message-call",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "use-1",
          name: "fixture_tool",
          input: []
        }]
      };
    }
    return {
      id: "message-final",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  let invoked = 0;
  const result = await provider.generate({
    input: "run it",
    agent,
    tools: [{
      name: "fixture_tool",
      description: "Fixture.",
      input_schema: { type: "object", properties: {} }
    }],
    toolRegistry: {
      invoke: async () => {
        invoked += 1;
        return { ok: true, result: {} };
      }
    }
  });

  assert.equal(invoked, 0);
  assert.equal(result.toolCalls[0].result.outcome.code, "invalid_tool_arguments");
  const toolResult = sent[1].messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === "tool_result");
  assert.equal(JSON.parse(toolResult.content).outcome.code, "invalid_tool_arguments");
});

test("provider-visible successful results retain legacy fields plus semantics", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  const sent = [];
  provider.postResponses = async (body) => {
    sent.push(structuredClone(body));
    if (sent.length === 1) {
      return {
        id: "response-call",
        output: [{
          type: "function_call",
          call_id: "call-1",
          name: "fixture_tool",
          arguments: "{}"
        }]
      };
    }
    return {
      id: "response-final",
      output_text: "done",
      output: []
    };
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "fixture_tool",
    description: "Fixture.",
    parameters: { type: "object", properties: {} },
    sideEffects: true,
    capability: { idempotent: false },
    handler: () => ({ value: 7, artifactId: "artifact_7" })
  });

  await provider.generate({
    input: "run it",
    agent,
    tools: registry.toOpenAITools(),
    toolRegistry: registry,
    context: { sessionId: "session-a", __turnId: "turn-provider" }
  });

  const output = JSON.parse(
    sent[1].input.find((item) => item.type === "function_call_output").output
  );
  assert.equal(output.value, 7);
  assert.deepEqual(output.outcome.artifacts, ["artifact:artifact_7"]);
  assert.equal(output.outcome.status, "succeeded");
});

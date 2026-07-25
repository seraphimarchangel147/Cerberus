import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

function registerProbe(registry, state, {
  name = "read_probe",
  sideEffects = false,
  jobResources = null
} = {}) {
  registry.register({
    name,
    description: "Bounded provider batching probe.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false
    },
    sideEffects,
    ...(jobResources
      ? {
          jobResources,
          jobResourceRevision: "provider-batch-test-v1"
        }
      : {}),
    handler: async ({ id }) => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      state.started.push(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.active -= 1;
      state.finished.push(id);
      return { id };
    }
  });
}

function probeState() {
  return {
    active: 0,
    peak: 0,
    started: [],
    finished: []
  };
}

function openAICall(id) {
  return {
    type: "function_call",
    call_id: `call-${id}`,
    name: "read_probe",
    arguments: JSON.stringify({ id })
  };
}

test("OpenAI executes independent reads concurrently and serializes results in call order", async () => {
  const registry = new ToolRegistry();
  const state = probeState();
  registerProbe(registry, state);
  const events = [];
  const requests = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    return requests.length === 1
      ? {
          id: "response-tools",
          output: [openAICall(1), openAICall(2), openAICall(3)]
        }
      : {
          id: "response-final",
          output_text: "done",
          output: []
        };
  };

  const result = await provider.generate({
    input: "inspect three items",
    instructions: "Use tools.",
    tools: registry.toOpenAITools(),
    toolRegistry: registry,
    context: {
      sessionId: "provider-batch-openai",
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(state.peak, 3);
  assert.deepEqual(result.toolCalls.map((call) => call.result.result.id), [1, 2, 3]);
  assert.deepEqual(
    requests[1].input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
    ["call-1", "call-2", "call-3"]
  );
  assert.deepEqual(
    events.find((event) => event.phase === "tool-batch"),
    {
      phase: "tool-batch",
      calls: 3,
      waves: 1,
      parallelWaves: 1,
      maxWidth: 3
    }
  );
});

test("Anthropic executes independent reads concurrently and preserves tool-result order", async () => {
  const registry = new ToolRegistry();
  const state = probeState();
  registerProbe(registry, state);
  const requests = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  provider.postMessages = async (body) => {
    requests.push(structuredClone(body));
    return requests.length === 1
      ? {
          stop_reason: "tool_use",
          content: [1, 2, 3].map((id) => ({
            type: "tool_use",
            id: `use-${id}`,
            name: "read_probe",
            input: { id }
          }))
        }
      : {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
  };

  const result = await provider.generate({
    input: "inspect three items",
    instructions: "Use tools.",
    tools: registry.toAnthropicTools(),
    toolRegistry: registry,
    context: { sessionId: "provider-batch-anthropic" }
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(state.peak, 3);
  assert.deepEqual(result.toolCalls.map((call) => call.result.result.id), [1, 2, 3]);
  const resultMessage = requests[1].messages.find((message) => (
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result")
  ));
  assert.deepEqual(
    resultMessage.content
      .filter((block) => block.type === "tool_result")
      .map((block) => block.tool_use_id),
    ["use-1", "use-2", "use-3"]
  );
});

test("provider batching keeps unscoped mutations sequential", async () => {
  const registry = new ToolRegistry();
  const state = probeState();
  registerProbe(registry, state, {
    name: "read_probe",
    sideEffects: true
  });
  let requests = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  provider.postResponses = async () => {
    requests += 1;
    return requests === 1
      ? {
          id: "response-tools",
          output: [openAICall(1), openAICall(2), openAICall(3)]
        }
      : {
          id: "response-final",
          output_text: "done",
          output: []
        };
  };

  const result = await provider.generate({
    input: "mutate three items",
    instructions: "Use tools.",
    tools: registry.toOpenAITools(),
    toolRegistry: registry,
    context: { sessionId: "provider-batch-exclusive" }
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(state.peak, 1);
  assert.deepEqual(state.started, [1, 2, 3]);
  assert.deepEqual(state.finished, [1, 2, 3]);
});

test("provider batching permits only disjoint trusted mutation resources", async () => {
  const registry = new ToolRegistry();
  const state = probeState();
  registerProbe(registry, state, {
    name: "read_probe",
    sideEffects: true,
    jobResources: ({ id }) => [`workspace/item-${id}`]
  });
  let requests = 0;
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  provider.postMessages = async () => {
    requests += 1;
    return requests === 1
      ? {
          stop_reason: "tool_use",
          content: [1, 2, 3].map((id) => ({
            type: "tool_use",
            id: `use-${id}`,
            name: "read_probe",
            input: { id }
          }))
        }
      : {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }]
        };
  };

  const result = await provider.generate({
    input: "mutate disjoint items",
    instructions: "Use tools.",
    tools: registry.toAnthropicTools(),
    toolRegistry: registry,
    context: { sessionId: "provider-batch-disjoint" }
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(state.peak, 3);
  assert.deepEqual(result.toolCalls.map((call) => call.result.result.id), [1, 2, 3]);
});

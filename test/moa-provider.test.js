import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MoaProvider,
  loadMoaPresets,
  normalizeMoaModelSpec,
  renderMoaAnalyses,
  validateMoaPresets
} from "../src/moa-provider.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

function preset(overrides = {}) {
  return {
    aggregator: { provider: "openai", model: "gpt-aggregator" },
    references: [
      { provider: "anthropic", model: "claude-reference" },
      { provider: "openai", model: "gpt-reference" }
    ],
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("canonical moa.json presets load, normalize, sort, and switch by name", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-moa-config-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "moa.json"), JSON.stringify({
    zeta: {
      aggregator: "openai/gpt-5",
      references: ["anthropic/claude-sonnet"]
    },
    alpha: {
      aggregator: { provider: "ANTHROPIC", model: "claude-opus" },
      references: [{ provider: "openai", model: "gpt-5-mini" }]
    }
  }));

  const loaded = loadMoaPresets({ dataDir });
  assert.deepEqual(loaded.zeta.aggregator, {
    provider: "openai",
    model: "gpt-5"
  });
  assert.deepEqual(loaded.alpha.references[0], {
    provider: "openai",
    model: "gpt-5-mini"
  });

  const provider = new MoaProvider({
    dataDir,
    preset: "zeta",
    providerFactory: () => ({ generate: async () => ({ text: "unused" }) })
  });
  assert.equal(provider.provider, "moa");
  assert.equal(provider.name, "moa");
  assert.equal(provider.model, "zeta");
  assert.equal(provider.isConfigured(), true);
  assert.deepEqual(provider.availableModels(), ["alpha", "zeta"]);
  provider.setPreset("alpha");
  assert.equal(provider.preset, "alpha");
  assert.equal(provider.model, "alpha");
  assert.throws(() => provider.setPreset("missing"), /Unknown MoA preset/);
});

test("model specs require direct providers and reject nested moa", () => {
  assert.deepEqual(normalizeMoaModelSpec("openai:gpt-5"), {
    provider: "openai",
    model: "gpt-5"
  });
  assert.throws(
    () => normalizeMoaModelSpec({ provider: "moa", model: "nested" }),
    /cannot use nested provider/
  );
  assert.throws(
    () => validateMoaPresets({
      nested: {
        aggregator: { provider: "moa", model: "other-preset" },
        references: []
      }
    }),
    /cannot use nested provider/
  );
  assert.throws(
    () => validateMoaPresets({
      broken: {
        aggregator: { provider: "openai", model: "gpt" },
        references: "anthropic/claude"
      }
    }),
    /references must be an array/
  );
});

test("references start concurrently behind one barrier and preserve config order", async () => {
  const first = deferred();
  const second = deferred();
  const started = [];
  let aggregatorStarted = false;
  let aggregatorTurnContext = "";
  const providers = {
    "claude-reference": {
      async generate() {
        started.push("claude-reference");
        await first.promise;
        return { provider: "anthropic", model: "claude-reference", text: "first analysis" };
      }
    },
    "gpt-reference": {
      async generate() {
        started.push("gpt-reference");
        await second.promise;
        return { provider: "openai", model: "gpt-reference", text: "second analysis" };
      }
    },
    "gpt-aggregator": {
      async generate(request) {
        aggregatorStarted = true;
        aggregatorTurnContext = request.turnContext;
        return { provider: "openai", model: "gpt-aggregator", text: "combined answer" };
      }
    }
  };
  const moa = new MoaProvider({
    presets: { council: preset() },
    preset: "council",
    providerFactory: (spec) => providers[spec.model]
  });

  const generation = moa.generate({ input: "Compare the options." });
  await nextTurn();
  assert.deepEqual(started.sort(), ["claude-reference", "gpt-reference"]);
  assert.equal(aggregatorStarted, false);

  second.resolve();
  await nextTurn();
  assert.equal(aggregatorStarted, false, "aggregator waits for every reference");
  first.resolve();

  const result = await generation;
  assert.equal(result.text, "combined answer");
  assert.equal(result.provider, "moa");
  assert.equal(result.model, "council");
  assert.equal(aggregatorStarted, true);
  assert.ok(
    aggregatorTurnContext.indexOf("first analysis")
      < aggregatorTurnContext.indexOf("second analysis"),
    "allSettled output retains configured reference order"
  );
  assert.deepEqual(result.moa.references.map((row) => row.status), ["ok", "ok"]);
});

test("reference calls are isolated from tools, streaming, activity, and scope", async () => {
  const referenceRequests = [];
  let aggregatorRequest;
  const tools = [{ type: "function", name: "real_tool", parameters: {} }];
  const toolRegistry = { invoke: async () => ({ ok: true }) };
  const onDelta = () => {};
  const onActivity = () => {};
  const context = {
    sessionId: "session-main",
    __advertisedTools: ["real_tool"],
    __allowedTools: ["real_tool"],
    __onToolEvent: onActivity,
    marker: "preserved"
  };
  const messages = [{ role: "user", content: "Earlier turn" }];
  const images = [{ mediaType: "image/png", data: "AA==" }];
  const sessionMemorySnapshot = "Stable memory";
  const moa = new MoaProvider({
    presets: { council: preset() },
    preset: "council",
    providerFactory: (spec, metadata) => ({
      async generate(request) {
        if (metadata.role === "reference") {
          referenceRequests.push(request);
          return { provider: spec.provider, model: spec.model, text: `analysis ${spec.model}` };
        }
        aggregatorRequest = request;
        return {
          provider: spec.provider,
          model: spec.model,
          text: "aggregated",
          toolCalls: []
        };
      }
    })
  });

  await moa.generate({
    input: "Current request",
    instructions: "Static agent instructions",
    turnContext: "Original per-turn context",
    messages,
    images,
    sessionMemorySnapshot,
    tools,
    toolRegistry,
    onDelta,
    context,
    maxIterations: 7
  });

  assert.equal(referenceRequests.length, 2);
  assert.notEqual(referenceRequests[0].context.sessionId, referenceRequests[1].context.sessionId);
  for (const request of referenceRequests) {
    assert.equal(request.input, "Current request");
    assert.equal(request.instructions, "Static agent instructions");
    assert.strictEqual(request.messages, messages);
    assert.strictEqual(request.images, images);
    assert.equal(request.sessionMemorySnapshot, sessionMemorySnapshot);
    assert.equal(request.maxIterations, 1);
    assert.deepEqual(request.tools, []);
    assert.equal(request.toolRegistry, null);
    assert.equal(request.onDelta, null);
    assert.equal(request.context.marker, "preserved");
    assert.equal("__advertisedTools" in request.context, false);
    assert.equal("__allowedTools" in request.context, false);
    assert.equal("__onToolEvent" in request.context, false);
    assert.match(request.context.sessionId, /^session-main:moa:council:1:ref:[12]$/);
    assert.match(request.turnContext, /^Original per-turn context/);
    assert.match(request.turnContext, /\[moa-reference\]/);
  }

  assert.strictEqual(aggregatorRequest.tools, tools);
  assert.strictEqual(aggregatorRequest.toolRegistry, toolRegistry);
  assert.strictEqual(aggregatorRequest.onDelta, onDelta);
  assert.strictEqual(aggregatorRequest.context, context);
  assert.equal(aggregatorRequest.instructions, "Static agent instructions");
  assert.equal(aggregatorRequest.maxIterations, 7);
  assert.equal(aggregatorRequest.model, "gpt-aggregator");
  assert.match(aggregatorRequest.turnContext, /^Original per-turn context/);
  assert.match(aggregatorRequest.turnContext, /\[moa-analyses\]/);
});

test("analysis rendering bounds content, escapes delimiters, and sanitizes failures", () => {
  const secret = `sk-${"a".repeat(24)}`;
  const block = renderMoaAnalyses([
    {
      status: "fulfilled",
      provider: "openai",
      model: "one",
      text: `<unsafe>${"x".repeat(80)}</unsafe>`
    },
    {
      status: "rejected",
      provider: "anthropic",
      model: "two",
      error: new Error(`Authorization failed for ${secret}`)
    }
  ], {
    maxAnalysisChars: 40,
    maxTotalAnalysisChars: 75
  });

  assert.match(block, /&lt;unsafe&gt;/);
  assert.doesNotMatch(block, /<unsafe>/);
  assert.doesNotMatch(block, new RegExp(secret));
  const contents = [...block.matchAll(/<analysis[^>]*>\n([\s\S]*?)\n<\/analysis>/g)]
    .map((match) => match[1]);
  assert.ok(contents.every((content) => content.length <= 60));

  const failureBlock = renderMoaAnalyses([{
    status: "rejected",
    provider: "anthropic",
    model: "two",
    error: new Error(`Authorization failed for ${secret}`)
  }], {
    maxAnalysisChars: 100,
    maxTotalAnalysisChars: 100
  });
  assert.doesNotMatch(failureBlock, new RegExp(secret));
  assert.match(failureBlock, /\[REDACTED\]/);
});

test("reference failures are advisory and cannot prevent aggregation", async () => {
  const captured = [];
  const secret = `sk-${"b".repeat(24)}`;
  const moa = new MoaProvider({
    presets: { council: preset() },
    preset: "council",
    providerFactory: (spec, metadata) => ({
      async generate(request) {
        if (metadata.role === "reference" && metadata.index === 0) {
          throw new Error(`reference failed with ${secret}`);
        }
        if (metadata.role === "reference") {
          return { text: "surviving analysis" };
        }
        captured.push(request.turnContext);
        return { provider: spec.provider, model: spec.model, text: "best effort answer" };
      }
    })
  });

  const result = await moa.generate({ input: "Continue despite one failure." });
  assert.equal(result.text, "best effort answer");
  assert.deepEqual(result.moa.references.map((row) => row.status), ["error", "ok"]);
  assert.doesNotMatch(result.moa.references[0].error, new RegExp(secret));
  assert.doesNotMatch(captured[0], new RegExp(secret));
  assert.match(captured[0], /Reference failed/);
  assert.match(captured[0], /surviving analysis/);
});

test("the direct aggregator retains the normal provider tool loop", async () => {
  const aggregator = new OpenAIResponsesProvider({
    apiKey: "fixture-key",
    model: "gpt-aggregator",
    maxIterations: 3,
    stallTimeoutMs: 0
  });
  let requests = 0;
  aggregator.postResponses = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        id: "response_tool",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "combine_fact",
          arguments: JSON.stringify({ value: 7 })
        }]
      };
    }
    return {
      id: "response_final",
      output_text: "Used the real tool loop.",
      output: []
    };
  };
  const registry = new ToolRegistry();
  let invoked = 0;
  registry.register({
    name: "combine_fact",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
      additionalProperties: false
    },
    handler: async ({ value }) => {
      invoked += 1;
      return { doubled: value * 2 };
    }
  });
  const tools = registry.toOpenAITools();
  const moa = new MoaProvider({
    presets: {
      tools: {
        aggregator: { provider: "openai", model: "gpt-aggregator" },
        references: [{ provider: "anthropic", model: "claude-reference" }]
      }
    },
    preset: "tools",
    providerFactory: (spec, metadata) => metadata.role === "aggregator"
      ? aggregator
      : { generate: async () => ({ text: "Reference says to double the value." }) }
  });

  const result = await moa.generate({
    input: "Use the tool.",
    agent: { id: "main", name: "Main" },
    tools,
    toolRegistry: registry,
    context: {},
    maxIterations: 3,
    maxTurnSeconds: 5
  });

  assert.equal(invoked, 1);
  assert.equal(requests, 2);
  assert.equal(result.text, "Used the real tool loop.");
  assert.equal(result.provider, "moa");
  assert.equal(result.model, "tools");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "combine_fact");
  assert.deepEqual(result.toolCalls[0].result, {
    ok: true,
    result: { doubled: 14 }
  });
});

test("abort cancels the reference barrier and never starts aggregation", async () => {
  const controller = new AbortController();
  let referencesStarted = 0;
  let aggregatorStarted = false;
  const moa = new MoaProvider({
    presets: { council: preset() },
    preset: "council",
    providerFactory: (_spec, metadata) => ({
      generate: ({ context }) => {
        if (metadata.role === "aggregator") {
          aggregatorStarted = true;
          return Promise.resolve({ text: "should not run" });
        }
        referencesStarted += 1;
        return new Promise((_resolve, reject) => {
          context.__abortSignal.addEventListener("abort", () => {
            const error = new Error("reference aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }
    })
  });

  const generation = moa.generate({
    input: "Long analysis",
    context: { sessionId: "abort-test", __abortSignal: controller.signal }
  });
  await nextTurn();
  assert.equal(referencesStarted, 2);
  controller.abort();
  await assert.rejects(generation, { name: "AbortError" });
  assert.equal(aggregatorStarted, false);

  const preAborted = new AbortController();
  preAborted.abort();
  let factoryCalls = 0;
  const preAbortedMoa = new MoaProvider({
    presets: { council: preset() },
    preset: "council",
    providerFactory: () => {
      factoryCalls += 1;
      return { generate: async () => ({ text: "never" }) };
    }
  });
  await assert.rejects(
    preAbortedMoa.generate({
      input: "Already stopped",
      context: { __abortSignal: preAborted.signal }
    }),
    { name: "AbortError" }
  );
  assert.equal(factoryCalls, 0);
});

test("a factory cannot smuggle a nested moa provider into a direct spec", async () => {
  const moa = new MoaProvider({
    presets: {
      nested: {
        aggregator: { provider: "openai", model: "gpt" },
        references: [{ provider: "anthropic", model: "claude" }]
      }
    },
    preset: "nested",
    providerFactory: () => ({
      provider: "moa",
      generate: async () => ({ text: "nested" })
    })
  });

  await assert.rejects(
    moa.generate({ input: "Do not recurse." }),
    /cannot resolve to another MoA provider/
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoaProvider, normalizeMoaModelSpec } from "../src/moa-provider.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  createDirectModelProviderFactory,
  createModelProvider
} from "../src/model-provider.js";
import {
  MODEL_PROVIDER_IDS,
  isModelProviderId,
  normalizeModelProviderId
} from "../src/model-router.js";

const PRESETS = {
  council: {
    aggregator: { provider: "openai", model: "gpt-aggregator" },
    references: [
      { provider: "anthropic", model: "claude-reference" },
      { provider: "openai", model: "gpt-reference" }
    ]
  },
  alternate: {
    aggregator: "anthropic:claude-aggregator",
    references: ["openai:gpt-reference"]
  }
};

function temporaryDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-moa-provider-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function stubFactory(log) {
  return async (spec, metadata) => {
    log.factories.push({ spec: { ...spec }, metadata: { ...metadata } });
    return {
      provider: spec.provider,
      model: spec.model,
      async generate(request) {
        log.requests.push({
          spec: { ...spec },
          metadata: { ...metadata },
          request: structuredClone({
            model: request.model,
            input: request.input,
            turnContext: request.turnContext,
            maxIterations: request.maxIterations,
            tools: request.tools,
            context: request.context
          })
        });
        if (metadata.role === "reference") {
          return {
            provider: spec.provider,
            model: spec.model,
            text: `analysis from ${spec.model}`,
            toolCalls: []
          };
        }
        return {
          provider: spec.provider,
          model: spec.model,
          text: "aggregated answer",
          toolCalls: [{ name: "fixture_tool", arguments: {}, result: { ok: true } }],
          iterations: 2,
          stopReason: "completed"
        };
      }
    };
  };
}

test("model-router registers moa without treating auto as a provider id", () => {
  assert.deepEqual(MODEL_PROVIDER_IDS, ["anthropic", "openai", "moa"]);
  assert.equal(isModelProviderId("MOA"), true);
  assert.equal(isModelProviderId("auto"), false);
  assert.equal(isModelProviderId("auto", { includeAuto: true }), true);
  assert.equal(normalizeModelProviderId(" MoA "), "moa");
  assert.equal(normalizeModelProviderId("unknown"), "auto");
});

test("preferred moa selects a native MoaProvider and preserves aggregator tool-loop output", async (t) => {
  const log = { factories: [], requests: [] };
  const provider = createModelProvider({
    preferred: "moa",
    dataDir: temporaryDataDir(t),
    env: {},
    moa: {
      presets: PRESETS,
      preset: "council",
      providerFactory: stubFactory(log)
    }
  });

  assert.equal(provider.constructor, MoaProvider);
  assert.equal(provider.provider, "moa");
  assert.equal(provider.name, "moa");
  assert.equal(provider.model, "council");
  assert.equal(provider.preset, "council");

  const result = await provider.generate({
    input: "solve this",
    turnContext: "[context]\noriginal\n[/context]",
    context: { sessionId: "session-1" }
  });

  assert.equal(result.provider, "moa");
  assert.equal(result.model, "council");
  assert.equal(result.text, "aggregated answer");
  assert.deepEqual(result.toolCalls, [{
    name: "fixture_tool",
    arguments: {},
    result: { ok: true }
  }]);
  assert.equal(result.iterations, 2);
  assert.deepEqual(
    log.factories.map(({ spec, metadata }) => ({
      provider: spec.provider,
      model: spec.model,
      role: metadata.role,
      preset: metadata.preset
    })).sort((left, right) => left.role.localeCompare(right.role)
      || left.model.localeCompare(right.model)),
    [
      {
        provider: "openai",
        model: "gpt-aggregator",
        role: "aggregator",
        preset: "council"
      },
      {
        provider: "anthropic",
        model: "claude-reference",
        role: "reference",
        preset: "council"
      },
      {
        provider: "openai",
        model: "gpt-reference",
        role: "reference",
        preset: "council"
      }
    ].sort((left, right) => left.role.localeCompare(right.role)
      || left.model.localeCompare(right.model))
  );
  const aggregatorRequest = log.requests.find((entry) => entry.metadata.role === "aggregator");
  assert.equal(aggregatorRequest.request.model, "gpt-aggregator");
  assert.match(aggregatorRequest.request.turnContext, /\[moa-analyses\]/);
  assert.match(aggregatorRequest.request.turnContext, /analysis from claude-reference/);
  assert.match(aggregatorRequest.request.turnContext, /analysis from gpt-reference/);
});

test("preset selection honors model alias, environment selection, and config order", (t) => {
  const dataDir = temporaryDataDir(t);
  const factory = async () => ({ generate: async () => ({ text: "ok" }) });

  const byModel = createModelProvider({
    preferred: "moa",
    dataDir,
    env: { OPENAGI_MOA_PRESET: "council" },
    moa: { presets: PRESETS, model: "alternate", providerFactory: factory }
  });
  assert.equal(byModel.model, "alternate");

  const byEnvironment = createModelProvider({
    preferred: "moa",
    dataDir,
    env: { OPENAGI_MOA_PRESET: "alternate" },
    moa: { presets: PRESETS, providerFactory: factory }
  });
  assert.equal(byEnvironment.model, "alternate");

  const byOrder = createModelProvider({
    preferred: "moa",
    dataDir,
    env: {},
    moa: { presets: PRESETS, providerFactory: factory }
  });
  assert.equal(byOrder.model, "council");

  assert.throws(
    () => createModelProvider({
      preferred: "moa",
      dataDir,
      env: {},
      moa: { presets: PRESETS, preset: "missing", providerFactory: factory }
    }),
    /unknown moa preset/i
  );
  assert.throws(
    () => createModelProvider({
      preferred: "moa",
      dataDir,
      env: {},
      moa: { presets: {}, providerFactory: factory }
    }),
    /no configured preset/i
  );
});

test("auto selection remains native even when valid MoA presets exist", (t) => {
  let factoryCalls = 0;
  const provider = createModelProvider({
    preferred: "auto",
    dataDir: temporaryDataDir(t),
    env: {},
    anthropic: { apiKey: "anthropic-key" },
    openai: { apiKey: "openai-key" },
    moa: {
      presets: PRESETS,
      providerFactory: async () => {
        factoryCalls += 1;
        throw new Error("auto must not construct MoA models");
      }
    }
  });

  assert.equal(provider.constructor, AnthropicProvider);
  assert.equal(factoryCalls, 0);
});

test("direct provider factory returns credential-aware native providers with exact model overrides", (t) => {
  const factory = createDirectModelProviderFactory({
    dataDir: temporaryDataDir(t),
    env: {},
    anthropic: {
      apiKey: "anthropic-key",
      model: "anthropic-base"
    },
    openai: {
      apiKey: "openai-key",
      model: "openai-base"
    }
  });

  const anthropic = factory({
    provider: "anthropic",
    model: "claude-direct"
  });
  const openai = factory({
    provider: "openai",
    model: "gpt-direct"
  });

  assert.equal(anthropic.constructor, AnthropicProvider);
  assert.equal(anthropic.model, "claude-direct");
  assert.equal(anthropic.apiKey, "anthropic-key");
  assert.ok(anthropic.credentialPool);
  assert.equal(openai.constructor, OpenAIResponsesProvider);
  assert.equal(openai.model, "gpt-direct");
  assert.equal(openai.apiKey, "openai-key");
  assert.ok(openai.credentialPool);
  assert.throws(
    () => factory({ provider: "moa", model: "nested" }),
    /cannot use nested provider/i
  );
  assert.throws(
    () => factory({ provider: "unknown", model: "model" }),
    /unsupported direct model provider/i
  );
});

test("real direct providers receive exact reference and aggregator model ids", async (t) => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({
      url: String(url),
      model: body.model,
      body,
      authorization: init.headers.authorization ?? null,
      apiKey: init.headers["x-api-key"] ?? null
    });
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify({
        id: "reference",
        output_text: "reference analysis",
        output: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      id: "aggregator",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "final answer" }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const provider = createModelProvider({
    preferred: "moa",
    dataDir: temporaryDataDir(t),
    env: {},
    openai: {
      apiKey: "openai-key",
      contextWindowTokens: 100_000
    },
    anthropic: {
      apiKey: "anthropic-key",
      contextWindowTokens: 100_000,
      stallTimeoutMs: 0
    },
    moa: {
      preset: "direct",
      presets: {
        direct: {
          aggregator: "anthropic:claude-aggregator-override",
          references: ["openai:gpt-reference-override"]
        }
      }
    }
  });

  const result = await provider.generate({
    input: "answer",
    instructions: "static",
    context: { sessionId: "direct-session", runtime: {} }
  });

  assert.equal(result.provider, "moa");
  assert.equal(result.model, "direct");
  assert.equal(result.text, "final answer");
  assert.deepEqual(
    requests.map((request) => request.model).sort(),
    ["claude-aggregator-override", "gpt-reference-override"]
  );
  const reference = requests.find((request) => request.url.endsWith("/responses"));
  const aggregator = requests.find((request) => request.url.endsWith("/messages"));
  assert.equal(reference.authorization, "Bearer openai-key");
  assert.equal(aggregator.apiKey, "anthropic-key");
  assert.match(JSON.stringify(aggregator.body.messages), /reference analysis/);
});

test("nested MoA model specs fail before any provider factory can recurse", (t) => {
  assert.throws(
    () => normalizeMoaModelSpec("moa:nested"),
    /cannot use nested provider/i
  );
  let factoryCalls = 0;
  assert.throws(
    () => createModelProvider({
      preferred: "moa",
      dataDir: temporaryDataDir(t),
      env: {},
      moa: {
        presets: {
          invalid: {
            aggregator: "moa:nested",
            references: ["openai:reference"]
          }
        },
        providerFactory: async () => {
          factoryCalls += 1;
        }
      }
    }),
    /cannot use nested provider/i
  );
  assert.equal(factoryCalls, 0);
});

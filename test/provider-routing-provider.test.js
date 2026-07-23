import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  createDirectModelProviderFactory,
  createModelProvider
} from "../src/model-provider.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1";

function makeDataDir(t, prefix = "openagi-provider-routing-provider") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function useFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = previous;
  });
}

function routingFixture() {
  return {
    sort: "throughput",
    only: ["Anthropic", "google-vertex/us-east5"],
    ignore: ["DeepInfra"],
    order: ["OpenAI", "Anthropic"],
    require_parameters: true,
    data_collection: "deny"
  };
}

function normalizedRoutingFixture() {
  return {
    sort: "throughput",
    only: ["anthropic", "google-vertex/us-east5"],
    ignore: ["deepinfra"],
    order: ["openai", "anthropic"],
    require_parameters: true,
    data_collection: "deny"
  };
}

test("OpenAI Responses serializes routing only for a gated endpoint", async (t) => {
  const requests = [];
  useFetch(t, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ id: "response", output: [], usage: {} });
  });

  const routed = new OpenAIResponsesProvider({
    apiKey: "openrouter-key",
    model: "openai/gpt-5",
    baseUrl: OPENROUTER_BASE_URL,
    providerRouting: routingFixture(),
    timeoutMs: 5000
  });
  const direct = new OpenAIResponsesProvider({
    apiKey: "kimi-key",
    model: "kimi-for-coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    providerRouting: routingFixture(),
    timeoutMs: 5000
  });
  const routedBody = Object.freeze({
    model: "openai/gpt-5",
    input: Object.freeze([{ role: "user", content: "route this" }])
  });
  const directBody = Object.freeze({
    model: "kimi-for-coding",
    input: Object.freeze([{ role: "user", content: "direct" }]),
    provider: Object.freeze({ caller_value: "preserved" })
  });

  await routed.postResponses(routedBody);
  await direct.postResponses(directBody);

  assert.equal(requests[0].url, `${OPENROUTER_BASE_URL}/responses`);
  assert.deepEqual(requests[0].body.provider, normalizedRoutingFixture());
  assert.equal("provider_routing" in requests[0].body, false);
  assert.deepEqual(routedBody, {
    model: "openai/gpt-5",
    input: [{ role: "user", content: "route this" }]
  });

  assert.equal(requests[1].url, "https://api.kimi.com/coding/v1/responses");
  assert.deepEqual(requests[1].body.provider, {
    caller_value: "preserved"
  });
  assert.deepEqual(directBody, {
    model: "kimi-for-coding",
    input: [{ role: "user", content: "direct" }],
    provider: { caller_value: "preserved" }
  });
});

test("Anthropic Messages serializes routing for Nous and omits it for direct Anthropic", async (t) => {
  const requests = [];
  useFetch(t, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({
      id: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {}
    });
  });

  const routed = new AnthropicProvider({
    apiKey: "nous-key",
    model: "anthropic/claude-sonnet",
    baseUrl: NOUS_BASE_URL,
    providerRouting: routingFixture(),
    timeoutMs: 5000,
    stallTimeoutMs: 0
  });
  const direct = new AnthropicProvider({
    apiKey: "anthropic-key",
    model: "claude-sonnet",
    baseUrl: "https://api.anthropic.com/v1",
    providerRouting: routingFixture(),
    timeoutMs: 5000,
    stallTimeoutMs: 0
  });
  const routedBody = Object.freeze({
    model: "anthropic/claude-sonnet",
    max_tokens: 32,
    messages: Object.freeze([{ role: "user", content: "route this" }])
  });
  const directBody = Object.freeze({
    model: "claude-sonnet",
    max_tokens: 32,
    messages: Object.freeze([{ role: "user", content: "direct" }])
  });

  await routed.postMessages(routedBody);
  await direct.postMessages(directBody);

  assert.equal(requests[0].url, `${NOUS_BASE_URL}/messages`);
  assert.deepEqual(requests[0].body.provider, normalizedRoutingFixture());
  assert.equal("provider_routing" in requests[0].body, false);
  assert.equal("provider" in routedBody, false);

  assert.equal(requests[1].url, "https://api.anthropic.com/v1/messages");
  assert.equal("provider" in requests[1].body, false);
  assert.equal("provider" in directBody, false);
});

test("createModelProvider loads routing once and carries it to primary and fallback providers", (t) => {
  const dataDir = makeDataDir(t);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    provider_routing: {
      sort: "latency",
      only: ["anthropic"],
      order: ["anthropic", "openai"]
    }
  }));
  const openaiRouter = {
    baseModel: "openai-base",
    resolve: () => "openai-routed",
    tierModel: () => "openai-tier"
  };
  const anthropicRouter = {
    baseModel: "anthropic-base",
    resolve: () => "anthropic-routed",
    tierModel: () => "anthropic-tier"
  };

  const provider = createModelProvider({
    dataDir,
    env: {},
    preferred: "openai",
    openai: {
      apiKey: "openai-key",
      baseUrl: OPENROUTER_BASE_URL,
      router: openaiRouter
    },
    anthropic: {
      apiKey: "anthropic-key",
      baseUrl: NOUS_BASE_URL,
      router: anthropicRouter
    }
  });

  assert.equal(provider.constructor, OpenAIResponsesProvider);
  assert.strictEqual(provider.router, openaiRouter);
  assert.deepEqual(provider.providerRouting, {
    sort: "latency",
    only: ["anthropic"],
    order: ["anthropic", "openai"]
  });
  assert.equal(provider.fallbackProvider.constructor, AnthropicProvider);
  assert.strictEqual(provider.fallbackProvider.router, anthropicRouter);
  assert.deepEqual(
    provider.fallbackProvider.providerRouting,
    provider.providerRouting
  );

  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    provider_routing: { sort: "price", only: ["changed-after-create"] }
  }));
  assert.equal(provider.providerRouting.sort, "latency");
  assert.deepEqual(provider.providerRouting.only, ["anthropic"]);
  assert.equal(provider.fallbackProvider.providerRouting.sort, "latency");
});

test("direct and default MoA factories inherit one explicit routing block", (t) => {
  const dataDir = makeDataDir(t, "openagi-provider-routing-moa");
  const options = {
    dataDir,
    env: {},
    providerRouting: routingFixture(),
    openai: {
      apiKey: "openai-key",
      baseUrl: OPENROUTER_BASE_URL
    },
    anthropic: {
      apiKey: "anthropic-key",
      baseUrl: NOUS_BASE_URL
    }
  };
  const directFactory = createDirectModelProviderFactory(options);
  const directOpenAI = directFactory({
    provider: "openai",
    model: "openai/direct"
  });
  const directAnthropic = directFactory({
    provider: "anthropic",
    model: "anthropic/direct"
  });
  assert.deepEqual(directOpenAI.providerRouting, normalizedRoutingFixture());
  assert.deepEqual(directAnthropic.providerRouting, normalizedRoutingFixture());

  const moa = createModelProvider({
    ...options,
    preferred: "moa",
    moa: {
      preset: "routed",
      presets: {
        routed: {
          aggregator: {
            provider: "openai",
            model: "openai/aggregator"
          },
          references: [{
            provider: "anthropic",
            model: "anthropic/reference"
          }]
        }
      }
    }
  });
  const aggregator = moa.providerFactory({
    provider: "openai",
    model: "openai/aggregator"
  });
  const reference = moa.providerFactory({
    provider: "anthropic",
    model: "anthropic/reference"
  });
  assert.deepEqual(aggregator.providerRouting, normalizedRoutingFixture());
  assert.deepEqual(reference.providerRouting, normalizedRoutingFixture());
});

test("explicit empty routing disables inherited config and custom MoA factories remain untouched", (t) => {
  const dataDir = makeDataDir(t, "openagi-provider-routing-disable");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    provider_routing: { sort: "latency", only: ["anthropic"] }
  }));
  const disabled = createModelProvider({
    dataDir,
    env: {
      OPENAGI_PROVIDER_ROUTING: JSON.stringify({
        sort: "throughput",
        only: ["openai"]
      })
    },
    providerRouting: {},
    preferred: "openai",
    openai: {
      apiKey: "openai-key",
      baseUrl: OPENROUTER_BASE_URL
    },
    anthropic: {
      apiKey: "anthropic-key",
      baseUrl: NOUS_BASE_URL
    }
  });
  assert.equal(disabled.providerRouting, null);
  assert.equal(disabled.fallbackProvider.providerRouting, null);

  const customFactory = () => ({
    isConfigured: () => true,
    generate: async () => ({ text: "custom", toolCalls: [] })
  });
  const moa = createModelProvider({
    dataDir,
    env: {},
    providerRouting: routingFixture(),
    preferred: "moa",
    moa: {
      preset: "custom",
      providerFactory: customFactory,
      presets: {
        custom: {
          aggregator: {
            provider: "openai",
            model: "custom-aggregator"
          },
          references: []
        }
      }
    }
  });
  assert.strictEqual(moa.providerFactory, customFactory);
});

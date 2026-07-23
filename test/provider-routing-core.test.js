import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProviderRouting,
  isProviderRoutingEndpoint,
  loadProviderRoutingConfig,
  normalizeProviderRouting,
  PROVIDER_ROUTING_MAX_LIST_ENTRIES
} from "../src/provider-routing.js";

function tempDataDir(t) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openagi-provider-routing-")
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("normalization preserves fields, list order, and unique provider slugs", () => {
  const input = {
    sort: "throughput",
    only: [" Anthropic ", "google-vertex/us-east5", "anthropic"],
    ignore: ["DeepInfra"],
    order: ["OpenAI", "amazon-bedrock"],
    require_parameters: true,
    data_collection: "deny"
  };
  const normalized = normalizeProviderRouting(input);

  assert.deepEqual(normalized, {
    sort: "throughput",
    only: ["anthropic", "google-vertex/us-east5"],
    ignore: ["deepinfra"],
    order: ["openai", "amazon-bedrock"],
    require_parameters: true,
    data_collection: "deny"
  });
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.only, input.only);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.only), true);
  assert.deepEqual(input.only, [
    " Anthropic ",
    "google-vertex/us-east5",
    "anthropic"
  ]);
});

test("normalization disables empty blocks and rejects malformed routing", () => {
  assert.equal(normalizeProviderRouting(undefined), null);
  assert.equal(normalizeProviderRouting(null), null);
  assert.equal(normalizeProviderRouting({}), null);
  assert.equal(normalizeProviderRouting({ data_collection: null }), null);
  assert.deepEqual(normalizeProviderRouting({
    only: [],
    ignore: [],
    order: [],
    require_parameters: false
  }), {
    only: [],
    ignore: [],
    order: [],
    require_parameters: false
  });

  const invalidValues = [
    [],
    "price",
    { sort: "fastest" },
    { only: "anthropic" },
    { only: ["anthropic", 7] },
    { only: ["https://example.invalid"] },
    { ignore: ["with whitespace"] },
    { require_parameters: "true" },
    { data_collection: "sometimes" },
    { unknown: true },
    {
      order: Array.from(
        { length: PROVIDER_ROUTING_MAX_LIST_ENTRIES + 1 },
        (_, index) => `provider-${index}`
      )
    }
  ];
  for (const value of invalidValues) {
    assert.throws(
      () => normalizeProviderRouting(value),
      TypeError,
      JSON.stringify(value)
    );
  }
});

test("config loading follows explicit then env then config.json precedence", (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    unrelated: { retained: true },
    provider_routing: {
      sort: "latency",
      only: ["anthropic"]
    }
  }));
  const env = {
    OPENAGI_PROVIDER_ROUTING: JSON.stringify({
      sort: "throughput",
      ignore: ["deepinfra"]
    })
  };

  assert.deepEqual(loadProviderRoutingConfig({ dataDir, env: {} }), {
    sort: "latency",
    only: ["anthropic"]
  });
  assert.deepEqual(loadProviderRoutingConfig({ dataDir, env }), {
    sort: "throughput",
    ignore: ["deepinfra"]
  });
  assert.deepEqual(loadProviderRoutingConfig({
    dataDir,
    env,
    providerRouting: {
      sort: "price",
      order: ["openai", "anthropic"]
    }
  }), {
    sort: "price",
    order: ["openai", "anthropic"]
  });
});

test("an explicit or env empty block disables lower-precedence routing", (t) => {
  const dataDir = tempDataDir(t);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    provider_routing: { sort: "latency" }
  }));

  assert.equal(loadProviderRoutingConfig({
    dataDir,
    env: {
      OPENAGI_PROVIDER_ROUTING: JSON.stringify({ sort: "throughput" })
    },
    providerRouting: {}
  }), null);
  assert.equal(loadProviderRoutingConfig({
    dataDir,
    env: {
      OPENAGI_PROVIDER_ROUTING: JSON.stringify({ sort: "throughput" })
    },
    providerRouting: undefined
  }), null);
  assert.equal(loadProviderRoutingConfig({
    dataDir,
    env: { OPENAGI_PROVIDER_ROUTING: "{}" }
  }), null);
});

test("invalid env and file JSON fail without reflecting secret-bearing input", (t) => {
  const secret = `sk-${"x".repeat(32)}`;
  const dataDir = tempDataDir(t);
  let envError;
  try {
    loadProviderRoutingConfig({
      dataDir,
      env: { OPENAGI_PROVIDER_ROUTING: `{"only":["${secret}"]` }
    });
  } catch (error) {
    envError = error;
  }
  assert.ok(envError instanceof TypeError);
  assert.doesNotMatch(envError.message, new RegExp(secret));

  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    `{"api_key":"${secret}","provider_routing":`
  );
  let fileError;
  try {
    loadProviderRoutingConfig({ dataDir, env: {} });
  } catch (error) {
    fileError = error;
  }
  assert.ok(fileError instanceof TypeError);
  assert.doesNotMatch(fileError.message, new RegExp(secret));
});

test("endpoint gating accepts official routing hosts and rejects lookalikes", () => {
  const accepted = [
    "https://openrouter.ai/api/v1",
    "https://api.openrouter.ai/v1",
    "https://edge.us.openrouter.ai/v1",
    "https://inference-api.nousresearch.com/v1",
    new URL("https://OPENROUTER.AI/api/v1/")
  ];
  const rejected = [
    undefined,
    "",
    "openrouter.ai",
    "http://openrouter.ai/api/v1",
    "https://openrouter.ai:8443/api/v1",
    "https://user:pass@openrouter.ai/api/v1",
    "https://evilopenrouter.ai/api/v1",
    "https://openrouter.ai.example.com/api/v1",
    "https://openrouter.ai@attacker.example/api/v1",
    "https://nousresearch.com/v1",
    "https://api.nousresearch.com/v1",
    "https://sub.inference-api.nousresearch.com/v1",
    "https://api.openai.com/v1",
    "https://api.anthropic.com/v1",
    "https://api.kimi.com/coding/v1",
    "https://custom.example/v1"
  ];

  for (const value of accepted) {
    assert.equal(isProviderRoutingEndpoint(value), true, String(value));
  }
  for (const value of rejected) {
    assert.equal(isProviderRoutingEndpoint(value), false, String(value));
  }
});

test("routing attaches as top-level provider without mutating the request body", () => {
  const body = Object.freeze({
    model: "openai/gpt-5",
    input: Object.freeze([{ role: "user", content: "Hello" }]),
    metadata: Object.freeze({ stable: true })
  });
  const routing = {
    sort: "price",
    only: ["Anthropic", "google"],
    ignore: ["deepinfra"],
    order: ["anthropic", "google"],
    require_parameters: true,
    data_collection: "deny"
  };

  const attached = applyProviderRouting(body, {
    baseUrl: "https://openrouter.ai/api/v1",
    routing
  });

  assert.notStrictEqual(attached, body);
  assert.deepEqual(body, {
    model: "openai/gpt-5",
    input: [{ role: "user", content: "Hello" }],
    metadata: { stable: true }
  });
  assert.strictEqual(attached.input, body.input);
  assert.strictEqual(attached.metadata, body.metadata);
  assert.deepEqual(attached.provider, {
    sort: "price",
    only: ["anthropic", "google"],
    ignore: ["deepinfra"],
    order: ["anthropic", "google"],
    require_parameters: true,
    data_collection: "deny"
  });
  assert.equal("provider_routing" in attached, false);
  assert.equal("extra_body" in attached, false);
});

test("direct endpoints and disabled routing are no-ops", () => {
  const body = {
    model: "kimi-for-coding",
    provider: { existing: "untouched" }
  };
  assert.strictEqual(applyProviderRouting(body, {
    baseUrl: "https://api.kimi.com/coding/v1",
    routing: { sort: "latency" }
  }), body);
  assert.strictEqual(applyProviderRouting(body, {
    baseUrl: "https://openrouter.ai/api/v1",
    routing: {}
  }), body);
  assert.deepEqual(body, {
    model: "kimi-for-coding",
    provider: { existing: "untouched" }
  });
});

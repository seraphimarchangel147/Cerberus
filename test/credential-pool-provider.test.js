import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialPool } from "../src/credential-pool.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  createModelProvider
} from "../src/model-provider.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function pool(provider, env, credentials, options = {}) {
  return new CredentialPool({
    provider,
    env,
    credentials,
    strategy: "round_robin",
    ...options
  });
}

function useFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = previous;
  });
}

test("OpenAI rotation uses the leased key, warns for the cache reset, and stays sticky across tool hops", async (t) => {
  const headers = [];
  const warnings = [];
  let requests = 0;
  useFetch(t, async (_url, init) => {
    headers.push(init.headers.authorization);
    requests += 1;
    if (requests === 1) {
      return jsonResponse(429, { error: { message: "Monthly usage limit reached" } });
    }
    if (requests === 2) {
      return jsonResponse(200, {
        id: "tool-hop",
        output: [{
          type: "function_call",
          call_id: "call-1",
          name: "step",
          arguments: "{}"
        }]
      });
    }
    return jsonResponse(200, {
      id: "done",
      output_text: "finished",
      output: []
    });
  });

  const credentialPool = pool("openai", {
    OPENAI_FIRST: "first-secret",
    OPENAI_SECOND: "second-secret"
  }, [
    { id: "first", secretName: "OPENAI_FIRST" },
    { id: "second", secretName: "OPENAI_SECOND" }
  ]);
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    model: "test-model",
    providerMaxRetries: 0,
    contextWindowTokens: 100_000,
    cacheWarningLog: (message) => warnings.push(message)
  });

  const result = await provider.generate({
    input: "run the step",
    instructions: "test",
    context: { runtime: {}, sessionId: "rotation-session" },
    tools: [{ type: "function", name: "step" }],
    toolRegistry: {
      async invoke() {
        return { ok: true, result: { done: true } };
      }
    }
  });

  assert.equal(result.text, "finished");
  assert.deepEqual(headers, [
    "Bearer first-secret",
    "Bearer second-secret",
    "Bearer second-secret"
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /full-price/);
  assert.doesNotMatch(warnings.join("\n"), /first-secret|second-secret/);
  assert.equal(provider.apiKey, "", "request leases must not mutate shared provider state");
});

test("generic OpenAI 429 retries the same lease once before rotating", async (t) => {
  const headers = [];
  useFetch(t, async (_url, init) => {
    headers.push(init.headers.authorization);
    if (headers.length <= 2) {
      return jsonResponse(429, { error: { message: "temporarily rate limited" } });
    }
    return jsonResponse(200, { id: "done", output_text: "ok", output: [] });
  });

  const credentialPool = pool("openai", {
    OPENAI_FIRST: "first-secret",
    OPENAI_SECOND: "second-secret"
  }, [
    { id: "first", secretName: "OPENAI_FIRST" },
    { id: "second", secretName: "OPENAI_SECOND" }
  ]);
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    providerMaxRetries: 3
  });

  const result = await provider.postResponses({ model: "test-model", input: [] });
  assert.equal(result.output_text, "ok");
  assert.deepEqual(headers, [
    "Bearer first-secret",
    "Bearer first-secret",
    "Bearer second-secret"
  ]);
});

test("Anthropic OAuth 401 refreshes in-pool and uses bearer authorization", async (t) => {
  const seen = [];
  useFetch(t, async (_url, init) => {
    seen.push({
      authorization: init.headers.authorization ?? null,
      apiKey: init.headers["x-api-key"] ?? null
    });
    if (seen.length === 1) {
      return jsonResponse(401, { error: { message: "access token expired" } });
    }
    return jsonResponse(200, {
      id: "done",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }]
    });
  });

  const credentialPool = pool("anthropic", {
    OAUTH_ACCESS: "expired-oauth-secret",
    OAUTH_REFRESH: "refresh-secret"
  }, [{
    id: "oauth",
    type: "oauth",
    secretName: "OAUTH_ACCESS",
    refreshTokenSecretName: "OAUTH_REFRESH"
  }], {
    refreshOAuth: async () => ({ accessToken: "fresh-oauth-secret" })
  });
  const provider = new AnthropicProvider({
    apiKey: "",
    credentialPool,
    stallTimeoutMs: 0,
    providerMaxRetries: 3
  });

  const result = await provider.postMessages({
    model: "test-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(result.content[0].text, "ok");
  assert.deepEqual(seen, [
    { authorization: "Bearer expired-oauth-secret", apiKey: null },
    { authorization: "Bearer fresh-oauth-secret", apiKey: null }
  ]);
});

test("first-hop 402 exhausts the primary pool and falls back to the other native provider", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-pool-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  useFetch(t, async (url, init) => {
    calls.push({
      url: String(url),
      authorization: init.headers.authorization ?? null,
      apiKey: init.headers["x-api-key"] ?? null
    });
    if (String(url).endsWith("/responses")) {
      return jsonResponse(402, { error: { message: "billing unavailable" } });
    }
    return jsonResponse(200, {
      id: "fallback",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "fallback answer" }]
    });
  });

  const provider = createModelProvider({
    preferred: "openai",
    dataDir,
    env: {
      OPENAI_PRIMARY: "openai-secret",
      ANTHROPIC_BACKUP: "anthropic-secret"
    },
    credentialPoolConfig: {
      version: 1,
      providers: {
        openai: {
          credentials: [{ id: "primary", secretName: "OPENAI_PRIMARY" }]
        },
        anthropic: {
          credentials: [{ id: "backup", secretName: "ANTHROPIC_BACKUP" }]
        }
      }
    },
    openai: { apiKey: "", providerMaxRetries: 0 },
    anthropic: { apiKey: "", stallTimeoutMs: 0, providerMaxRetries: 0 }
  });

  assert.equal(provider.constructor, OpenAIResponsesProvider);
  const result = await provider.generate({ input: "hello", instructions: "test" });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "fallback answer");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, "Bearer openai-secret");
  assert.equal(calls[1].apiKey, "anthropic-secret");
});

test("pool exhaustion after a successful tool hop never replays side effects on fallback", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-pool-side-effect-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let openaiCalls = 0;
  let anthropicCalls = 0;
  let toolCalls = 0;
  useFetch(t, async (url) => {
    if (String(url).endsWith("/messages")) {
      anthropicCalls += 1;
      return jsonResponse(200, {
        id: "fallback",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "must not run" }]
      });
    }
    openaiCalls += 1;
    if (openaiCalls === 1) {
      return jsonResponse(200, {
        id: "tool-hop",
        output: [{
          type: "function_call",
          call_id: "call-1",
          name: "side_effect",
          arguments: "{}"
        }]
      });
    }
    return jsonResponse(402, { error: { message: "billing unavailable" } });
  });

  const provider = createModelProvider({
    preferred: "openai",
    dataDir,
    env: {
      OPENAI_PRIMARY: "openai-secret",
      ANTHROPIC_BACKUP: "anthropic-secret"
    },
    credentialPoolConfig: {
      providers: {
        openai: {
          credentials: [{ id: "primary", secretName: "OPENAI_PRIMARY" }]
        },
        anthropic: {
          credentials: [{ id: "backup", secretName: "ANTHROPIC_BACKUP" }]
        }
      }
    },
    openai: { apiKey: "", providerMaxRetries: 0, maxIterations: 3 },
    anthropic: { apiKey: "", stallTimeoutMs: 0, providerMaxRetries: 0 }
  });

  const result = await provider.generate({
    input: "perform exactly once",
    instructions: "test",
    tools: [{ type: "function", name: "side_effect" }],
    toolRegistry: {
      async invoke() {
        toolCalls += 1;
        return { ok: true, result: { changed: true } };
      }
    }
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.stopReason, "provider-error");
  assert.equal(toolCalls, 1);
  assert.equal(anthropicCalls, 0);
  assert.equal(openaiCalls, 2);
});

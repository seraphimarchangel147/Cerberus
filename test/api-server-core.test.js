import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  DEFAULT_API_SERVER_PORT,
  DEFAULT_SUBSCRIPTION_PROXY_PORT,
  createApiServer,
  createSubscriptionProxy,
  startCapabilityServers
} from "../src/api-server.js";

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve({
        host,
        port: address.port,
        url: `http://${host}:${address.port}`
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

function requestRaw(url, {
  method = "GET",
  headers = {},
  body = null
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    request.once("error", reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function parseSse(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

test("API server runs an ephemeral full agent turn and returns an OpenAI completion", async (t) => {
  const calls = [];
  const runtime = {
    agentHost: {
      async handleMessage(input) {
        calls.push(input);
        return {
          reply: `Answer for: ${input.text}`,
          model: {
            id: "provider-response-1",
            model: "runtime-model",
            stopReason: "completed",
            usage: {
              input_tokens: 7,
              output_tokens: 5
            }
          }
        };
      }
    }
  };
  const app = createApiServer(runtime, {
    apiKey: "api-test-key",
    port: 0,
    now: () => new Date("2026-07-23T12:34:56.000Z"),
    createId: () => "chatcmpl-fallback"
  });
  t.after(() => app.close());
  const address = await app.listen();

  assert.equal(app.host, "127.0.0.1");
  assert.equal(app.port, 0);
  assert.ok(address.port > 0);
  assert.equal(app.address().port, address.port);
  const response = await fetch(`${address.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer api-test-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "requested-model",
      messages: [
        { role: "system", content: "System text" },
        { role: "user", content: "older question" },
        { role: "assistant", content: "older answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "latest" },
            { type: "image_url", image_url: { url: "https://invalid.test/x" } },
            { type: "input_text", text: "question" }
          ]
        }
      ]
    })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.id, "provider-response-1");
  assert.equal(body.created, 1784810096);
  assert.equal(body.model, "requested-model");
  assert.deepEqual(body.choices, [{
    index: 0,
    message: {
      role: "assistant",
      content: "Answer for: latest\nquestion"
    },
    finish_reason: "stop"
  }]);
  assert.deepEqual(body.usage, {
    prompt_tokens: 7,
    completion_tokens: 5,
    total_tokens: 12
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "api");
  assert.equal(calls[0].from, "api-client");
  assert.equal(calls[0].agentId, "main");
  assert.equal(calls[0].text, "latest\nquestion");
  assert.equal(calls[0].ephemeral, true);
  assert.match(calls[0].sessionId, /^api:/u);
  assert.ok(calls[0].abortSignal instanceof AbortSignal);
  assert.deepEqual(calls[0].metadata, {
    apiModel: "requested-model",
    apiStream: false
  });
});

test("API streaming emits role, sanitized progress, text, finish, and DONE", async (t) => {
  const secret = "tool-secret-must-not-leak";
  const calls = [];
  const app = createApiServer({
    apiKey: "stream-key",
    port: 0,
    createId: () => "chatcmpl-stream",
    now: () => 1700000000000,
    agentHost: {
      async handleMessage(input) {
        calls.push(input);
        input.onToolEvent({
          phase: "start",
          name: "safe_tool",
          args: { token: secret },
          result: secret,
          error: secret
        });
        input.onDelta("Hello ");
        input.onToolEvent({
          phase: "end",
          toolName: "safe_tool",
          ok: false,
          error: secret
        });
        input.onDelta("world");
        return {
          reply: "Hello world",
          model: { stopReason: "completed" }
        };
      }
    }
  });
  t.after(() => app.close());
  const address = await app.listen();

  const response = await fetch(`${address.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer stream-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "stream-model",
      stream: true,
      messages: [{ role: "user", content: "stream this" }]
    })
  });
  const raw = await response.text();
  const events = parseSse(raw);
  const chunks = events.filter((event) => event !== "[DONE]");
  const deltas = chunks
    .flatMap((event) => event.choices ?? [])
    .map((choice) => choice.delta);
  const progress = deltas
    .map((delta) => delta.tool_progress)
    .filter(Boolean);
  const text = deltas
    .filter((delta) => !delta.tool_progress)
    .map((delta) => delta.content ?? "")
    .join("");
  const inlineProgress = deltas
    .filter((delta) => delta.tool_progress)
    .map((delta) => delta.content ?? "")
    .join("");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.equal(events.at(-1), "[DONE]");
  assert.deepEqual(deltas[0], { role: "assistant" });
  assert.equal(text, "Hello world");
  assert.deepEqual(progress, [
    { phase: "start", name: "safe_tool", state: "running" },
    { phase: "end", name: "safe_tool", state: "failed" }
  ]);
  assert.equal(
    inlineProgress,
    "[tool safe_tool running]\n[tool safe_tool failed]\n"
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.deepEqual(chunks.at(-1).choices[0].delta, {});
  assert.doesNotMatch(raw, new RegExp(secret));
  assert.doesNotMatch(raw, /"args"|"result"|"error":"tool/u);
  assert.equal(calls[0].ephemeral, true);
  assert.ok(calls[0].abortSignal instanceof AbortSignal);
});

test("API auth, malformed JSON, body caps, and agent errors fail safely", async (t) => {
  const agentSecret = "agent-stack-secret";
  let calls = 0;
  const app = createApiServer({
    apiKey: "exact-key",
    port: 0,
    maxBodyBytes: 160,
    agentHost: {
      async handleMessage(input) {
        calls += 1;
        if (input.text === "explode") {
          throw new Error(`provider failed with ${agentSecret}`);
        }
        return { reply: "ok", model: { stopReason: "completed" } };
      }
    }
  });
  t.after(() => app.close());
  const address = await app.listen();
  const endpoint = `${address.url}/v1/chat/completions`;

  for (const authorization of [
    undefined,
    "Bearer wrong-key",
    "bearer exact-key",
    "Bearer  exact-key"
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "must not run" }]
      })
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "invalid_api_key");
  }
  assert.equal(calls, 0);

  const malformed = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer exact-key",
      "content-type": "application/json"
    },
    body: "{\"messages\":"
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_json");

  const noUser = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer exact-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({ messages: [{ role: "assistant", content: "only" }] })
  });
  assert.equal(noUser.status, 400);
  assert.equal((await noUser.json()).error.code, "missing_user_message");

  const tooLarge = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer exact-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "x".repeat(500) }]
    })
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "request_too_large");

  const failed = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer exact-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "explode" }]
    })
  });
  const failedText = await failed.text();
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failedText, new RegExp(agentSecret));
  assert.equal(JSON.parse(failedText).error.code, "agent_error");
});

test("subscription proxy substitutes a fresh secret and forwards raw request and response data", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks)
      });
      res.writeHead(207, {
        "content-type": "application/octet-stream",
        "x-upstream": "raw",
        connection: "close"
      });
      res.end(Buffer.from([0x00, 0x01, 0x7f, 0xff]));
    });
  });
  t.after(() => close(upstream));
  const upstreamAddress = await listen(upstream);
  const credentials = ["managed-first", "managed-second"];
  const secretCalls = [];
  const runtime = {
    secrets: {
      getSecret(name, options) {
        secretCalls.push({ name, options });
        return credentials[secretCalls.length - 1];
      }
    }
  };
  const proxy = createSubscriptionProxy(runtime, {
    upstreamUrl: upstreamAddress.url,
    secretName: "MANAGED_SUBSCRIPTION_KEY",
    port: 0
  });
  t.after(() => proxy.close());
  const address = await proxy.listen();

  const firstPayload = Buffer.from([0x10, 0x00, 0x20]);
  const first = await requestRaw(`${address.url}/v1/raw?mode=one`, {
    method: "POST",
    headers: {
      authorization: "Bearer arbitrary-client-token",
      "content-type": "application/octet-stream",
      "content-length": String(firstPayload.length),
      cookie: "session=inbound-cookie",
      "x-api-key": "inbound-api-key",
      connection: "keep-alive, x-remove-me",
      "x-remove-me": "hop-value",
      "x-safe-header": "kept"
    },
    body: firstPayload
  });
  const second = await requestRaw(`${address.url}/v1/raw?mode=two`, {
    headers: { authorization: "Bearer another-client-token" }
  });

  assert.equal(first.status, 207);
  assert.equal(first.headers["x-upstream"], "raw");
  assert.deepEqual(first.body, Buffer.from([0x00, 0x01, 0x7f, 0xff]));
  assert.equal(second.status, 207);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/raw?mode=one");
  assert.deepEqual(seen[0].body, firstPayload);
  assert.equal(seen[0].headers.authorization, "Bearer managed-first");
  assert.equal(seen[1].headers.authorization, "Bearer managed-second");
  assert.equal(seen[0].headers["x-safe-header"], "kept");
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.equal(seen[0].headers["x-remove-me"], undefined);
  assert.doesNotMatch(JSON.stringify(seen[0].headers), /arbitrary-client-token|inbound-api-key|inbound-cookie/u);
  assert.deepEqual(secretCalls, [
    {
      name: "MANAGED_SUBSCRIPTION_KEY",
      options: { decidedBy: "subscription-proxy:request" }
    },
    {
      name: "MANAGED_SUBSCRIPTION_KEY",
      options: { decidedBy: "subscription-proxy:request" }
    }
  ]);
});

test("subscription proxy supports a clean custom authorization header and rejects unsafe config", async (t) => {
  let upstreamHeaders = null;
  const upstream = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  t.after(() => close(upstream));
  const upstreamAddress = await listen(upstream);
  const proxy = createSubscriptionProxy({
    secretsStore: {
      getSecret: () => "custom-secret"
    },
    upstreamUrl: upstreamAddress.url,
    secretName: "CUSTOM_SECRET",
    authorizationHeader: "X-API-Key",
    authorizationPrefix: "Token ",
    port: 0
  });
  t.after(() => proxy.close());
  const address = await proxy.listen();
  const response = await requestRaw(`${address.url}/custom`, {
    headers: {
      authorization: "Bearer accepted",
      "x-api-key": "inbound-must-be-replaced"
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.toString("utf8"), "ok");
  assert.equal(upstreamHeaders["x-api-key"], "Token custom-secret");
  assert.equal(upstreamHeaders.authorization, undefined);

  const base = {
    secretsStore: { getSecret: () => "secret" },
    upstreamUrl: upstreamAddress.url,
    secretName: "CUSTOM_SECRET"
  };
  assert.throws(
    () => createSubscriptionProxy({ ...base, upstreamUrl: "ftp://example.test" }),
    /clean http\(s\) upstream/u
  );
  assert.throws(
    () => createSubscriptionProxy({ ...base, upstreamUrl: "http://user:pass@example.test" }),
    /clean http\(s\) upstream/u
  );
  assert.throws(
    () => createSubscriptionProxy({ ...base, authorizationHeader: "bad\r\nheader" }),
    /authorizationHeader is invalid/u
  );
  assert.throws(
    () => createSubscriptionProxy({ ...base, authorizationPrefix: "Bearer\r\nInjected: " }),
    /authorizationPrefix is invalid/u
  );
});

test("subscription proxy does not follow redirects and redacts failures", async (t) => {
  const secret = "managed-secret-never-reflect";
  let redirectTargetCalls = 0;
  const redirectTarget = http.createServer((_req, res) => {
    redirectTargetCalls += 1;
    res.end("must not be reached");
  });
  t.after(() => close(redirectTarget));
  const targetAddress = await listen(redirectTarget);
  let firstHopAuthorization = null;
  const redirecting = http.createServer((req, res) => {
    firstHopAuthorization = req.headers.authorization;
    res.writeHead(302, { location: `${targetAddress.url}/stolen` });
    res.end("redirect");
  });
  t.after(() => close(redirecting));
  const redirectAddress = await listen(redirecting);
  let secretCalls = 0;
  const logs = [];
  const proxy = createSubscriptionProxy({
    secretsStore: {
      getSecret() {
        secretCalls += 1;
        return secret;
      }
    },
    upstreamUrl: redirectAddress.url,
    secretName: "REDIRECT_SECRET",
    port: 0,
    maxBodyBytes: 8,
    log: (event) => logs.push(event)
  });
  t.after(() => proxy.close());
  const address = await proxy.listen();

  const unauthorized = await requestRaw(`${address.url}/redirect`);
  assert.equal(unauthorized.status, 401);
  assert.equal(secretCalls, 0);

  const oversized = await requestRaw(`${address.url}/redirect`, {
    method: "POST",
    headers: {
      authorization: "Bearer accepted",
      "content-length": "9"
    },
    body: "123456789"
  });
  assert.equal(oversized.status, 413);
  assert.equal(secretCalls, 0);

  const redirected = await requestRaw(`${address.url}/redirect`, {
    headers: { authorization: "Bearer accepted" }
  });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.body.toString("utf8"), "redirect");
  assert.equal(redirectTargetCalls, 0);
  assert.equal(firstHopAuthorization, `Bearer ${secret}`);
  assert.equal(secretCalls, 1);

  const closedServer = http.createServer();
  const closedAddress = await listen(closedServer);
  await close(closedServer);
  const failing = createSubscriptionProxy({
    secretsStore: { getSecret: () => secret },
    upstreamUrl: closedAddress.url,
    secretName: "FAILURE_SECRET",
    port: 0,
    upstreamTimeoutMs: 250,
    log: (event) => logs.push(event)
  });
  t.after(() => failing.close());
  const failingAddress = await failing.listen();
  const failed = await requestRaw(`${failingAddress.url}/failure`, {
    headers: { authorization: "Bearer accepted" }
  });
  const failedText = failed.body.toString("utf8");
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failedText, new RegExp(secret));
  assert.equal(JSON.parse(failedText).error.code, "upstream_error");
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
});

test("startCapabilityServers derives proxy settings and gates both surfaces", async () => {
  const calls = [];
  function fakeSurface(kind) {
    return {
      async listen() {
        calls.push(`${kind}:listen`);
        return { host: "127.0.0.1", port: kind === "api" ? 1001 : 1002 };
      },
      async close() {
        calls.push(`${kind}:close`);
      }
    };
  }
  const runtime = {
    secrets: { getSecret: () => "unused" },
    agentHost: {
      handleMessage: async () => ({ reply: "unused" }),
      modelProvider: {
        baseUrl: "https://managed.example/v1",
        credentialEnvSecretName: "MANAGED_PROVIDER_KEY",
        credentialProviderName: "anthropic"
      }
    }
  };
  let apiOptions = null;
  let proxyOptions = null;
  const manager = startCapabilityServers({
    runtime,
    env: {
      API_SERVER_ENABLED: "1",
      API_SERVER_KEY: "api-key",
      API_SERVER_PORT: "0",
      SUBSCRIPTION_PROXY_ENABLED: "true",
      SUBSCRIPTION_PROXY_PORT: "0"
    },
    createApiServer(options) {
      apiOptions = options;
      return fakeSurface("api");
    },
    createSubscriptionProxy(options) {
      proxyOptions = options;
      return fakeSurface("proxy");
    }
  });

  assert.ok(manager.apiServer);
  assert.ok(manager.subscriptionProxy);
  assert.equal(apiOptions.host, undefined);
  assert.equal(proxyOptions.host, undefined);
  assert.equal(proxyOptions.upstreamUrl, "https://managed.example/v1");
  assert.equal(proxyOptions.secretName, "MANAGED_PROVIDER_KEY");
  assert.equal(proxyOptions.authorizationHeader, "x-api-key");
  assert.equal(proxyOptions.authorizationPrefix, "");
  const addresses = await manager.listen();
  assert.deepEqual(addresses, {
    apiServer: { host: "127.0.0.1", port: 1001 },
    subscriptionProxy: { host: "127.0.0.1", port: 1002 }
  });
  await manager.close();
  assert.deepEqual(calls, [
    "api:listen",
    "proxy:listen",
    "api:close",
    "proxy:close"
  ]);

  assert.equal(DEFAULT_API_SERVER_PORT, 8642);
  assert.equal(DEFAULT_SUBSCRIPTION_PROXY_PORT, 8645);
  const disabled = startCapabilityServers({
    runtime,
    env: {},
    createApiServer() {
      throw new Error("disabled API must not be created");
    },
    createSubscriptionProxy() {
      throw new Error("disabled proxy must not be created");
    }
  });
  assert.equal(disabled.apiServer, null);
  assert.equal(disabled.subscriptionProxy, null);
  assert.deepEqual(await disabled.listen(), {
    apiServer: null,
    subscriptionProxy: null
  });
  await disabled.close();
});

test("startCapabilityServers rolls back a partially started listener", async () => {
  const calls = [];
  const failure = new Error("proxy port unavailable");
  const manager = startCapabilityServers({
    runtime: {
      secrets: { getSecret: () => "unused" },
      agentHost: {
        handleMessage: async () => ({ reply: "unused" }),
        modelProvider: {
          baseUrl: "https://managed.example/v1",
          credentialEnvSecretName: "MANAGED_PROVIDER_KEY"
        }
      }
    },
    env: {
      API_SERVER_ENABLED: "true",
      API_SERVER_KEY: "api-key",
      SUBSCRIPTION_PROXY_ENABLED: "true"
    },
    createApiServer() {
      return {
        async listen() {
          calls.push("api:listen");
          return { host: "127.0.0.1", port: 1001 };
        },
        async close() {
          calls.push("api:close");
        }
      };
    },
    createSubscriptionProxy() {
      return {
        async listen() {
          calls.push("proxy:listen");
          throw failure;
        },
        async close() {
          calls.push("proxy:close");
        }
      };
    }
  });

  await assert.rejects(manager.listen(), (error) => error === failure);
  assert.deepEqual(calls, [
    "api:listen",
    "proxy:listen",
    "api:close",
    "proxy:close"
  ]);
});

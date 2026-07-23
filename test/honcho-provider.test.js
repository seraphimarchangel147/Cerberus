import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HonchoMemoryProvider,
  assertExternalMemoryProvider,
  createExternalMemoryProvider,
  isExternalMemoryProvider,
  stableHonchoId
} from "../src/integrations/honcho-provider.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === undefined ? "" : JSON.stringify(body)
  };
}

function createMockHoncho(respond = null) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url,
      path: new URL(url).pathname,
      headers: init.headers,
      body: JSON.parse(init.body),
      signal: init.signal
    };
    calls.push(call);

    const override = respond?.(call);
    if (override) return override;
    if (call.path === "/v3/workspaces") {
      return jsonResponse({ id: call.body.id });
    }
    if (/\/v3\/workspaces\/[^/]+\/peers$/.test(call.path)) {
      return jsonResponse({ id: call.body.id });
    }
    if (call.path.endsWith("/conclusions")) {
      return jsonResponse([{
        id: "conclusion-1",
        content: call.body.conclusions[0].content,
        observer_id: call.body.conclusions[0].observer_id,
        observed_id: call.body.conclusions[0].observed_id
      }]);
    }
    if (call.path.endsWith("/representation")) {
      return jsonResponse({ representation: "Prefers concise answers." });
    }
    if (call.path.endsWith("/chat")) {
      return jsonResponse({ content: "Use a short checklist." });
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  return { calls, fetchImpl };
}

test("Honcho provider uses current v3 conclusions, representation, and dialectic routes", async () => {
  const secret = "hch-super-secret";
  const mock = createMockHoncho();
  const provider = createExternalMemoryProvider({
    provider: "honcho",
    env: {
      HONCHO_API_KEY: secret,
      HONCHO_URL: "https://honcho.test/",
      HONCHO_WORKSPACE_ID: "cerberus"
    },
    fetchImpl: mock.fetchImpl
  });

  const rawUserId = "discord:\u03b1";
  const rawObserverId = "agent/main";
  const userId = stableHonchoId(rawUserId, "openagi-user");
  const observerId = stableHonchoId(rawObserverId, "openagi-agent");
  const setResult = await provider.setUserModel({
    userId: rawUserId,
    observerId: rawObserverId,
    content: { z: 1, a: ["prefers-tests"] },
    metadata: { localMemoryId: "memory-1" }
  });
  const getResult = await provider.getUserModel({
    userId: rawUserId,
    observerId: rawObserverId,
    query: "answer style"
  });
  const queryResult = await provider.queryUserModel({
    userId: rawUserId,
    observerId: rawObserverId,
    query: "How should the agent respond?"
  });

  assert.equal(setResult.provider, "honcho");
  assert.equal(setResult.userId, userId);
  assert.equal(setResult.observerId, observerId);
  assert.equal(setResult.accepted, true);
  assert.equal(getResult.model, "Prefers concise answers.");
  assert.equal(queryResult.answer, "Use a short checklist.");
  assert.equal(Object.hasOwn(setResult, "raw"), false);
  assert.equal(Object.hasOwn(getResult, "raw"), false);
  assert.equal(Object.hasOwn(queryResult, "raw"), false);

  const workspaceCalls = mock.calls.filter((call) => call.path === "/v3/workspaces");
  const peerCalls = mock.calls.filter((call) => call.path.endsWith("/peers"));
  assert.equal(workspaceCalls.length, 1, "successful workspace bootstrap is cached");
  assert.equal(peerCalls.length, 2, "successful peer bootstraps are cached");
  assert.deepEqual(
    new Set(peerCalls.map((call) => call.body.id)),
    new Set([userId, observerId])
  );

  const conclusion = mock.calls.find((call) => call.path.endsWith("/conclusions"));
  assert.deepEqual(conclusion.body, {
    conclusions: [{
      content: '{"a":["prefers-tests"],"z":1}',
      session_id: null,
      observer_id: observerId,
      observed_id: userId
    }]
  });
  const representation = mock.calls.find(
    (call) => call.path.endsWith("/representation")
  );
  assert.equal(
    representation.path,
    `/v3/workspaces/cerberus/peers/${observerId}/representation`
  );
  assert.deepEqual(representation.body, {
    target: userId,
    search_query: "answer style"
  });
  const chat = mock.calls.find((call) => call.path.endsWith("/chat"));
  assert.equal(chat.path, `/v3/workspaces/cerberus/peers/${observerId}/chat`);
  assert.deepEqual(chat.body, {
    query: "How should the agent respond?",
    target: userId,
    reasoning_level: "minimal",
    stream: false
  });
  assert.ok(mock.calls.every((call) => call.headers.Authorization === `Bearer ${secret}`));
  assert.equal(JSON.stringify(provider).includes(secret), false);
});

test("failed workspace and peer bootstraps are retryable without leaking the bearer", async () => {
  const secret = "hch-never-print-this";
  let workspaceAttempts = 0;
  let peerAttempts = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (path === "/v3/workspaces") {
      workspaceAttempts += 1;
      if (workspaceAttempts === 1) {
        return jsonResponse({ message: `bad bearer ${secret}` }, 503);
      }
      return jsonResponse({ id: body.id });
    }
    if (path.endsWith("/peers")) {
      peerAttempts += 1;
      if (peerAttempts === 1) return jsonResponse({ message: secret }, 502);
      return jsonResponse({ id: body.id });
    }
    if (path.endsWith("/representation")) {
      return jsonResponse({ representation: "Recovered model." });
    }
    return jsonResponse([]);
  };
  const provider = new HonchoMemoryProvider({
    apiKey: secret,
    baseUrl: "https://honcho.test",
    fetchImpl
  });

  await assert.rejects(
    () => provider.getUserModel({ userId: "user", observerId: "agent" }),
    (error) => {
      assert.equal(error.code, "HONCHO_HTTP_ERROR");
      assert.equal(error.status, 503);
      assert.equal(String(error).includes(secret), false);
      return true;
    }
  );
  await assert.rejects(
    () => provider.getUserModel({ userId: "user", observerId: "agent" }),
    (error) => {
      assert.equal(error.code, "HONCHO_HTTP_ERROR");
      assert.equal(error.status, 502);
      assert.equal(String(error).includes(secret), false);
      return true;
    }
  );
  const recovered = await provider.getUserModel({
    userId: "user",
    observerId: "agent"
  });

  assert.equal(recovered.model, "Recovered model.");
  assert.equal(workspaceAttempts, 2, "a rejected workspace promise is not cached");
  assert.ok(peerAttempts >= 3, "a rejected peer promise is not cached");
});

test("request timeout settles even when an injected fetch ignores AbortSignal", async () => {
  let signal;
  const provider = new HonchoMemoryProvider({
    apiKey: "hch-timeout-secret",
    baseUrl: "https://honcho.test",
    timeoutMs: 15,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    }
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => provider.getUserModel({ userId: "user", observerId: "agent" }),
    (error) => {
      assert.equal(error.code, "HONCHO_TIMEOUT");
      assert.equal(String(error).includes("hch-timeout-secret"), false);
      return true;
    }
  );
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("provider contract, factory gating, and stable IDs fail closed", () => {
  const contract = {
    getUserModel() {},
    setUserModel() {},
    queryUserModel() {}
  };
  assert.equal(isExternalMemoryProvider(contract), true);
  assert.equal(assertExternalMemoryProvider(contract), contract);
  assert.throws(
    () => assertExternalMemoryProvider({ getUserModel() {} }),
    /setUserModel, queryUserModel/
  );
  assert.equal(createExternalMemoryProvider({ env: {} }), null);
  assert.throws(
    () => createExternalMemoryProvider({
      provider: "honcho",
      env: {},
      fetchImpl: async () => jsonResponse({})
    }),
    /HONCHO_API_KEY/
  );
  assert.throws(
    () => createExternalMemoryProvider({ provider: "mystery", env: {} }),
    /Unsupported external memory provider/
  );
  assert.throws(
    () => createExternalMemoryProvider({
      provider: "secret-provider-name",
      env: {}
    }),
    (error) => {
      assert.equal(String(error).includes("secret-provider-name"), false);
      return true;
    }
  );

  assert.equal(stableHonchoId("plain-peer"), "plain-peer");
  assert.match(stableHonchoId("discord:\u03b1"), /^[A-Za-z0-9_-]+$/);
  assert.notEqual(stableHonchoId("a:b"), stableHonchoId("a/b"));
  assert.ok(stableHonchoId("x".repeat(600)).length <= 512);
});

test("structured user-model writes reject circular data before transport", async () => {
  let calls = 0;
  const provider = new HonchoMemoryProvider({
    apiKey: "hch-key",
    baseUrl: "https://honcho.test",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    }
  });
  const content = {};
  content.self = content;
  await assert.rejects(
    () => provider.setUserModel({
      userId: "user",
      observerId: "agent",
      content
    }),
    /circular reference/
  );
  assert.equal(calls, 0);
});

test("correction metadata becomes an explicit supersession conclusion", async () => {
  const mock = createMockHoncho();
  const provider = new HonchoMemoryProvider({
    apiKey: "hch-key",
    baseUrl: "https://honcho.test",
    fetchImpl: mock.fetchImpl
  });

  const result = await provider.setUserModel({
    userId: "user",
    observerId: "agent",
    content: "The deployment window starts at 5pm.",
    metadata: {
      action: "correct",
      supersededIds: ["memory-old", "memory-older", "memory-old"]
    }
  });

  const call = mock.calls.find((item) => item.path.endsWith("/conclusions"));
  const encoded = JSON.parse(call.body.conclusions[0].content);
  assert.deepEqual(encoded, {
    action: "supersede",
    replacement: "The deployment window starts at 5pm.",
    supersededLocalMemoryIds: ["memory-old", "memory-older"]
  });
  assert.deepEqual(result, {
    provider: "honcho",
    userId: "user",
    observerId: "agent",
    accepted: true
  });
});

test("successful Honcho responses are validated per v3 endpoint", async (t) => {
  const cases = [
    {
      name: "workspace schema",
      respond: (call) => call.path === "/v3/workspaces"
        ? jsonResponse({ workspace: call.body.id })
        : null,
      invoke: (provider) => provider.getUserModel({ userId: "user", observerId: "agent" })
    },
    {
      name: "peer schema",
      respond: (call) => call.path.endsWith("/peers")
        ? jsonResponse({ id: "wrong-peer" })
        : null,
      invoke: (provider) => provider.getUserModel({ userId: "user", observerId: "agent" })
    },
    {
      name: "conclusions schema",
      respond: (call) => call.path.endsWith("/conclusions")
        ? jsonResponse([{ id: "conclusion-without-content" }])
        : null,
      invoke: (provider) => provider.setUserModel({
        userId: "user",
        observerId: "agent",
        content: "A fact."
      })
    },
    {
      name: "representation schema",
      respond: (call) => call.path.endsWith("/representation")
        ? jsonResponse({ representation: { nested: true } })
        : null,
      invoke: (provider) => provider.getUserModel({ userId: "user", observerId: "agent" })
    },
    {
      name: "chat schema",
      respond: (call) => call.path.endsWith("/chat")
        ? jsonResponse({ content: ["not", "text"] })
        : null,
      invoke: (provider) => provider.queryUserModel({
        userId: "user",
        observerId: "agent",
        query: "What matters?"
      })
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const mock = createMockHoncho(item.respond);
      const provider = new HonchoMemoryProvider({
        apiKey: "hch-key",
        baseUrl: "https://honcho.test",
        fetchImpl: mock.fetchImpl
      });
      await assert.rejects(
        () => item.invoke(provider),
        (error) => {
          assert.equal(error.code, "HONCHO_INVALID_RESPONSE");
          return true;
        }
      );
    });
  }
});

test("nullable v3 dialectic content maps to a bounded empty answer", async () => {
  const mock = createMockHoncho((call) => call.path.endsWith("/chat")
    ? jsonResponse({ content: null })
    : null);
  const provider = new HonchoMemoryProvider({
    apiKey: "hch-key",
    baseUrl: "https://honcho.test",
    fetchImpl: mock.fetchImpl
  });
  const result = await provider.queryUserModel({
    userId: "user",
    observerId: "agent",
    query: "What matters?"
  });
  assert.equal(result.answer, "");
});

test("HTTP payloads and provider-generated strings are bounded", async (t) => {
  await t.test("oversized HTTP response", async () => {
    const mock = createMockHoncho((call) => call.path === "/v3/workspaces"
      ? jsonResponse("x".repeat(300_000))
      : null);
    const provider = new HonchoMemoryProvider({
      apiKey: "hch-key",
      baseUrl: "https://honcho.test",
      fetchImpl: mock.fetchImpl
    });
    await assert.rejects(
      () => provider.getUserModel({ userId: "user", observerId: "agent" }),
      (error) => {
        assert.equal(error.code, "HONCHO_RESPONSE_TOO_LARGE");
        return true;
      }
    );
  });

  for (const endpoint of ["representation", "chat"]) {
    await t.test(`oversized ${endpoint} string`, async () => {
      const mock = createMockHoncho((call) => {
        if (endpoint === "representation" && call.path.endsWith("/representation")) {
          return jsonResponse({ representation: "x".repeat(25_001) });
        }
        if (endpoint === "chat" && call.path.endsWith("/chat")) {
          return jsonResponse({ content: "x".repeat(25_001) });
        }
        return null;
      });
      const provider = new HonchoMemoryProvider({
        apiKey: "hch-key",
        baseUrl: "https://honcho.test",
        fetchImpl: mock.fetchImpl
      });
      const operation = endpoint === "representation"
        ? provider.getUserModel({ userId: "user", observerId: "agent" })
        : provider.queryUserModel({
          userId: "user",
          observerId: "agent",
          query: "What matters?"
        });
      await assert.rejects(
        () => operation,
        (error) => {
          assert.equal(error.code, "HONCHO_RESULT_TOO_LARGE");
          return true;
        }
      );
    });
  }
});

test("blank URL uses the hosted default and plaintext HTTP is loopback-only", () => {
  const defaulted = createExternalMemoryProvider({
    provider: "honcho",
    env: {
      HONCHO_API_KEY: "hch-key",
      HONCHO_URL: "   "
    },
    fetchImpl: async () => jsonResponse({})
  });
  assert.equal(defaulted.baseUrl, "https://api.honcho.dev");

  for (const baseUrl of [
    "http://localhost:8000",
    "http://127.0.0.42:8000",
    "http://[::1]:8000"
  ]) {
    assert.doesNotThrow(() => new HonchoMemoryProvider({
      apiKey: "hch-key",
      baseUrl,
      fetchImpl: async () => jsonResponse({})
    }));
  }

  for (const baseUrl of [
    "http://honcho.test",
    "http://0.0.0.0:8000",
    "http://127.0.0.1.evil.test"
  ]) {
    assert.throws(
      () => new HonchoMemoryProvider({
        apiKey: "hch-key",
        baseUrl,
        fetchImpl: async () => jsonResponse({})
      }),
      /HTTPS.*loopback/
    );
  }
});

test("caller AbortSignal directly cancels in-flight provider transport", async () => {
  let markChatStarted;
  const chatStarted = new Promise((resolve) => {
    markChatStarted = resolve;
  });
  let transportAborted = false;
  const mock = createMockHoncho((call) => {
    if (!call.path.endsWith("/chat")) return null;
    markChatStarted();
    return new Promise((resolve, reject) => {
      call.signal.addEventListener("abort", () => {
        transportAborted = true;
        const error = new Error("transport aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  });
  const provider = new HonchoMemoryProvider({
    apiKey: "hch-key",
    baseUrl: "https://honcho.test",
    timeoutMs: 1_000,
    fetchImpl: mock.fetchImpl
  });
  const controller = new AbortController();
  const pending = provider.queryUserModel({
    userId: "user",
    observerId: "agent",
    query: "What matters?",
    signal: controller.signal
  });
  await chatStarted;
  controller.abort();

  await assert.rejects(
    () => pending,
    (error) => {
      assert.equal(error.code, "HONCHO_ABORTED");
      return true;
    }
  );
  assert.equal(transportAborted, true);

  let preAbortedCalls = 0;
  const preAbortedProvider = new HonchoMemoryProvider({
    apiKey: "hch-key",
    baseUrl: "https://honcho.test",
    fetchImpl: async () => {
      preAbortedCalls += 1;
      return jsonResponse({});
    }
  });
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () => preAbortedProvider.getUserModel({
      userId: "user",
      observerId: "agent",
      signal: preAborted.signal
    }),
    (error) => {
      assert.equal(error.code, "HONCHO_ABORTED");
      return true;
    }
  );
  assert.equal(preAbortedCalls, 0);
});

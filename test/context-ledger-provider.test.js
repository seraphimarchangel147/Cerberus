import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { CredentialPool } from "../src/credential-pool.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import {
  createConversationContentIdentity,
  createConversationLineageIdentity
} from "../src/responses-continuation.js";
import { SecretsStore } from "../src/secrets-store.js";

function longHistory(count = 30, width = 220) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `history-${index}-${"x".repeat(width)}`
  }));
}

function completedResponse(id, text = "done") {
  return {
    id,
    status: "completed",
    output_text: text,
    output: [],
    usage: {
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11
    }
  };
}

function continuationContext({
  sessionId,
  incarnation,
  history,
  input,
  epoch
}) {
  return {
    sessionId,
    __memoryScope: "main",
    __continuationEligible: true,
    __continuationHistoryIdentity: createConversationLineageIdentity(history),
    __continuationCurrentContentIdentity: createConversationContentIdentity(input),
    __continuationContextEpoch: epoch,
    __continuationSessionIncarnation: incarnation
  };
}

async function withinMilliseconds(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("paid requests never invoke an optional context-ledger summarizer", async () => {
  const bodies = [];
  let summarizerCalls = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "provider-summarizer-canary",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return completedResponse("response-without-summarizer");
  };

  const result = await withinMilliseconds(
    provider.generate({
      input: "current request",
      instructions: "stable instructions",
      messages: longHistory(),
      context: {
        __contextLedgerSummarizer: async () => {
          summarizerCalls += 1;
          return new Promise(() => {});
        },
        __contextLedgerSummarizerTimeoutMs: 1
      }
    }),
    3_000,
    "a nonsettling context summarizer delayed the paid request"
  );

  assert.equal(result.text, "done");
  assert.equal(summarizerCalls, 0);
  assert.equal(bodies.length, 1);
  assert.match(JSON.stringify(bodies[0].input), /\[context summary\]/u);
});

test("installed ledgers redact live store and active credential values after rotation", async () => {
  let activeCredential = "active-credential-canary-one";
  let liveStoreSecret = "live-store-canary-one";
  let rotationPhase = 1;
  const credentialReadsByPhase = new Map();
  const secretAccesses = [];
  const storeEnv = {
    LIVE_STORE_SECRET: liveStoreSecret,
    OPENAI_POOL_KEY: activeCredential
  };
  const secretsStore = {
    env: storeEnv,
    allowlist: new Set(["LIVE_STORE_SECRET"]),
    getSecret(name, { decidedBy } = {}) {
      secretAccesses.push({ operation: "get", name, decidedBy });
      if (name === "OPENAI_POOL_KEY") {
        credentialReadsByPhase.set(
          rotationPhase,
          (credentialReadsByPhase.get(rotationPhase) ?? 0) + 1
        );
        return activeCredential;
      }
      return null;
    },
    exportEnv() {
      secretAccesses.push({ operation: "unexpected-export" });
      throw new Error("provider redaction must not call exportEnv");
    }
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [{
      id: "primary",
      type: "api_key",
      secretName: "OPENAI_POOL_KEY"
    }],
    secretsStore,
    env: {}
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    secretsStore,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0,
    cacheWarningLog: () => {}
  });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return completedResponse(`redacted-${bodies.length}`);
  };

  const firstHistory = longHistory();
  firstHistory[0].content = `store evidence ${liveStoreSecret}`;
  firstHistory[1].content = `credential evidence ${activeCredential}`;
  await provider.generate({
    input: "first current request",
    instructions: "stable instructions",
    messages: firstHistory,
    context: { sessionId: "secret-rotation-session" }
  });

  activeCredential = "active-credential-canary-two";
  liveStoreSecret = "live-store-canary-two";
  storeEnv.LIVE_STORE_SECRET = liveStoreSecret;
  storeEnv.OPENAI_POOL_KEY = activeCredential;
  rotationPhase = 2;
  const secondHistory = longHistory();
  secondHistory[0].content = `rotated store evidence ${liveStoreSecret}`;
  secondHistory[1].content = `rotated credential evidence ${activeCredential}`;
  await provider.generate({
    input: "second current request",
    instructions: "stable instructions",
    messages: secondHistory,
    context: { sessionId: "secret-rotation-session" }
  });

  assert.equal(bodies.length, 2);
  assert.equal(
    secretAccesses.some((entry) => entry.operation === "unexpected-export"),
    false
  );
  assert.ok((credentialReadsByPhase.get(1) ?? 0) > 0);
  assert.ok((credentialReadsByPhase.get(2) ?? 0) > 0);
  for (const body of bodies) {
    assert.match(JSON.stringify(body.input), /\[context summary\]/u);
  }
  assert.doesNotMatch(
    JSON.stringify(bodies[0]),
    /active-credential-canary-one|live-store-canary-one/u
  );
  assert.doesNotMatch(
    JSON.stringify(bodies[1]),
    /active-credential-canary-two|live-store-canary-two/u
  );
});

test("short credentials redact and oversized credentials fail closed", async () => {
  const shortSecret = "k3!";
  const shortProvider = new OpenAIResponsesProvider({
    apiKey: shortSecret,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let shortBody;
  shortProvider.postResponses = async (request) => {
    shortBody = structuredClone(request);
    return completedResponse("short-secret-redacted");
  };
  const shortMessages = longHistory();
  shortMessages[0].content = `reflected credential ${shortSecret}`;
  await shortProvider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: shortMessages
  });
  assert.doesNotMatch(JSON.stringify(shortBody), /k3!/u);

  const oversizedSecret = `oversized-${"s".repeat(17_000)}`;
  const oversizedProvider = new OpenAIResponsesProvider({
    apiKey: oversizedSecret,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let oversizedRequests = 0;
  oversizedProvider.postResponses = async () => {
    oversizedRequests += 1;
    return completedResponse("must-not-send-oversized-secret");
  };
  const oversizedMessages = longHistory();
  oversizedMessages[0].content = oversizedSecret;
  const oversizedResult = await oversizedProvider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: oversizedMessages
  });
  assert.equal(oversizedResult.stopReason, "context-too-large");
  assert.equal(oversizedRequests, 0);
});

test("unresolved alternate pool credentials disable unsafe compression", async () => {
  const active = "get-secret-only-active";
  const alternate = "get-secret-only-alternate";
  const secretsStore = {
    getSecret(name) {
      if (name === "POOL_ACTIVE") return active;
      if (name === "POOL_ALTERNATE") return alternate;
      return null;
    }
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "POOL_ACTIVE" },
      { id: "alternate", secretName: "POOL_ALTERNATE" }
    ],
    secretsStore,
    env: {}
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-unresolved-alternate");
  };
  const messages = longHistory();
  messages[0].content = `alternate reflected ${alternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("historical opaque alternate values never prove current redaction coverage", async () => {
  let alternate = "historical-alternate-old";
  const secretsStore = {
    getSecret(name) {
      if (name === "HISTORICAL_ACTIVE") return "historical-active";
      if (name === "HISTORICAL_ALTERNATE") return alternate;
      return null;
    }
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "HISTORICAL_ACTIVE" },
      { id: "alternate", secretName: "HISTORICAL_ALTERNATE" }
    ],
    secretsStore,
    env: {}
  });
  credentialPool.acquire();
  credentialPool.acquire();
  alternate = "historical-alternate-rotated";
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-historical-alternate");
  };
  const messages = longHistory();
  messages[0].content = `rotated alternate ${alternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("one re-resolvable credential requires a current safe projection", async () => {
  let currentSecret = "single-resolver-old-secret";
  const secretsStore = {
    getSecret(name) {
      return name === "SINGLE_RESOLVER_KEY" ? currentSecret : null;
    }
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [{ id: "only", secretName: "SINGLE_RESOLVER_KEY" }],
    secretsStore,
    env: {}
  });
  credentialPool.acquire();
  currentSecret = "single-resolver-rotated-secret";

  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-single-resolver");
  };
  const messages = longHistory();
  messages[0].content = `rotated credential ${currentSecret}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("allowlisted stores without a safe projection disable compression", async () => {
  const hiddenSecret = "allowlisted-hidden-store-secret";
  const provider = new OpenAIResponsesProvider({
    apiKey: "allowlisted-provider-key",
    secretsStore: {
      env: {},
      allowlist: new Set(["ALLOWLISTED_HIDDEN_SECRET"]),
      getSecret(name) {
        return name === "ALLOWLISTED_HIDDEN_SECRET" ? hiddenSecret : null;
      }
    },
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-hidden-store-secret");
  };
  const messages = longHistory();
  messages[0].content = `hidden store value ${hiddenSecret}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("built-in secret-store projections distinguish missing data from accessors", async (t) => {
  const createInitializedStore = (child, options) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ledger-store-"));
    child.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = new SecretsStore({ dataDir, ...options });
    store.initialize({ decidedBy: "test:context-ledger-provider" });
    return store;
  };
  const runRequest = async (store, responseId) => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "built-in-store-provider-key",
      secretsStore: store,
      contextWindowTokens: 2_000,
      contextEstimateCharsPerToken: 4,
      contextKeepRecentHops: 2,
      contextDigestChars: 600,
      stallTimeoutMs: 0
    });
    let requests = 0;
    provider.postResponses = async () => {
      requests += 1;
      return completedResponse(responseId);
    };
    const result = await provider.generate({
      input: "current request",
      instructions: "stable instructions",
      messages: longHistory()
    });
    return { requests, result };
  };

  await t.test("a filesystem-lazy store cannot claim an unset value", async (child) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ledger-store-"));
    child.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = new SecretsStore({
      dataDir,
      allowlist: ["BUILT_IN_LAZY_SECRET"],
      env: {}
    });
    const { requests, result } = await runRequest(store, "must-not-send-lazy-store");
    assert.equal(result.stopReason, "context-too-large");
    assert.equal(requests, 0);
  });

  await t.test("a genuinely missing allowlisted value remains a trusted unset value", async (child) => {
    const store = createInitializedStore(child, {
      allowlist: ["BUILT_IN_MISSING_SECRET"],
      env: {}
    });
    const { requests, result } = await runRequest(store, "built-in-missing");
    assert.equal(result.text, "done");
    assert.equal(requests, 1);
  });

  await t.test("an accessor-backed env value fails closed without a read", async (child) => {
    let reads = 0;
    const env = {};
    const store = createInitializedStore(child, {
      allowlist: ["BUILT_IN_ACCESSOR_SECRET"],
      env
    });
    Object.defineProperty(env, "BUILT_IN_ACCESSOR_SECRET", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return "must-not-be-read";
      }
    });
    const { requests, result } = await runRequest(store, "must-not-send-env-accessor");
    assert.equal(result.stopReason, "context-too-large");
    assert.equal(requests, 0);
    assert.equal(reads, 0);
  });

  await t.test("an accessor-backed allowlist fails closed without a read", async (child) => {
    let reads = 0;
    const store = createInitializedStore(child, {
      allowlist: [],
      env: {}
    });
    Object.defineProperty(store, "allowlist", {
      configurable: true,
      get() {
        reads += 1;
        return new Set(["BUILT_IN_HIDDEN_ALLOWLIST_SECRET"]);
      }
    });
    const { requests, result } = await runRequest(
      store,
      "must-not-send-allowlist-accessor"
    );
    assert.equal(result.stopReason, "context-too-large");
    assert.equal(requests, 0);
    assert.equal(reads, 0);
  });
});

test("pool and store credential projections are both redacted", async () => {
  const poolEnv = {
    BOTH_ACTIVE: "stale-pool-active",
    BOTH_ALTERNATE: "stale-pool-alternate"
  };
  const storeEnv = {
    BOTH_ACTIVE: "current-store-active",
    BOTH_ALTERNATE: "current-store-alternate"
  };
  const secretsStore = {
    env: storeEnv,
    getSecret(name) {
      return storeEnv[name] ?? null;
    }
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "BOTH_ACTIVE" },
      { id: "alternate", secretName: "BOTH_ALTERNATE" }
    ],
    secretsStore,
    env: poolEnv
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let body;
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return completedResponse("both-projections-redacted");
  };
  const messages = longHistory();
  messages[0].content = "current current-store-alternate";
  messages[1].content = "stale stale-pool-alternate";

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.text, "done");
  assert.doesNotMatch(
    JSON.stringify(body),
    /current-store-alternate|stale-pool-alternate/u
  );
});

test("opaque credential pools disable compression with hidden alternates", async () => {
  const hiddenAlternate = "opaque-hidden-alternate";
  const realPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "OPAQUE_ACTIVE" },
      { id: "alternate", secretName: "OPAQUE_ALTERNATE" }
    ],
    env: {
      OPAQUE_ACTIVE: "opaque-active",
      OPAQUE_ALTERNATE: hiddenAlternate
    }
  });
  const opaquePool = {
    isConfigured: () => true,
    beginRequest: (...args) => realPool.beginRequest(...args)
  };
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool: opaquePool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-opaque-pool");
  };
  const messages = longHistory();
  messages[0].content = `hidden ${hiddenAlternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("array-shaped duck pools cannot claim complete credential coverage", async () => {
  const hiddenAlternate = "sparse-duck-pool-hidden-alternate";
  const realPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "SPARSE_DUCK_ACTIVE" },
      { id: "alternate", secretName: "SPARSE_DUCK_ALTERNATE" }
    ],
    env: {
      SPARSE_DUCK_ACTIVE: "sparse-duck-active",
      SPARSE_DUCK_ALTERNATE: hiddenAlternate
    }
  });
  const entries = new Array(2);
  entries[0] = { id: "active", secretName: "SPARSE_DUCK_ACTIVE" };
  const duckPool = {
    entries,
    states: new Map(),
    env: { SPARSE_DUCK_ACTIVE: "sparse-duck-active" },
    isConfigured: () => true,
    beginRequest: (...args) => realPool.beginRequest(...args)
  };
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool: duckPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-sparse-duck-pool");
  };
  const messages = longHistory();
  messages[0].content = `hidden alternate ${hiddenAlternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("proxied explicit redaction values fail closed without trap execution", async () => {
  const protectedSecret = "proxied-explicit-redaction-secret";
  let traps = 0;
  const proxiedValues = new Proxy(new Set([protectedSecret]), {
    get() {
      traps += 1;
      throw new Error("redaction proxy must not be inspected");
    }
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "proxied-explicit-provider-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-proxied-redaction");
  };
  const messages = longHistory();
  messages[0].content = `protected value ${protectedSecret}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages,
    context: { __redactValues: proxiedValues }
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
  assert.equal(traps, 0);
});

test("accessor-backed explicit redaction arrays fail closed without reads", async () => {
  const protectedSecret = "accessor-explicit-redaction-secret";
  let reads = 0;
  const redactionValues = [];
  Object.defineProperty(redactionValues, "0", {
    enumerable: true,
    get() {
      reads += 1;
      return protectedSecret;
    }
  });
  redactionValues.length = 1;
  const provider = new OpenAIResponsesProvider({
    apiKey: "accessor-explicit-provider-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-accessor-redaction");
  };
  const messages = longHistory();
  messages[0].content = `protected value ${protectedSecret}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages,
    context: { __redactValues: redactionValues }
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
  assert.equal(reads, 0);
});

test("proxied credential pools fail closed without proxy inspection", async () => {
  const hiddenAlternate = "proxied-pool-hidden-alternate";
  const realPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "active", secretName: "PROXY_POOL_ACTIVE" },
      { id: "alternate", secretName: "PROXY_POOL_ALTERNATE" }
    ],
    env: {
      PROXY_POOL_ACTIVE: "proxied-pool-active",
      PROXY_POOL_ALTERNATE: hiddenAlternate
    }
  });
  const facade = {
    isConfigured: () => true,
    beginRequest: (...args) => realPool.beginRequest(...args)
  };
  let traps = 0;
  const proxiedPool = new Proxy(facade, {
    ownKeys() {
      traps += 1;
      throw new Error("credential-pool proxy must not be inspected");
    }
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool: proxiedPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-proxied-pool");
  };
  const messages = longHistory();
  messages[0].content = `hidden alternate ${hiddenAlternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
  assert.equal(traps, 0);
});

test("redaction rotation during preparation rebuilds before installation", async () => {
  const oldSecret = "preparation-old-secret";
  const rotatedSecret = "preparation-rotated-secret";
  const storeEnv = { ROTATING_SECRET: oldSecret };
  const provider = new OpenAIResponsesProvider({
    apiKey: "preparation-provider-key",
    secretsStore: {
      env: storeEnv,
      allowlist: new Set(["ROTATING_SECRET"])
    },
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let body;
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return completedResponse("preparation-rotation-safe");
  };
  const messages = longHistory();
  messages[0].content = `future reflected ${rotatedSecret}`;

  const pending = provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });
  storeEnv.ROTATING_SECRET = rotatedSecret;
  const result = await pending;

  assert.equal(result.text, "done");
  assert.match(JSON.stringify(body.input), /\[context summary\]/u);
  assert.doesNotMatch(JSON.stringify(body), /preparation-rotated-secret/u);
});

test("context compression invalidates an OpenAI continuation before sending", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "continuation-compression-key",
    responsesContinuationMode: "auto",
    contextWindowTokens: 1_000_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return completedResponse(
      bodies.length === 1
        ? "continuation-seed-response"
        : "compressed-stateless-response",
      bodies.length === 1 ? "seed answer" : "compressed answer"
    );
  };

  const sessionId = "continuation-compression-session";
  const incarnation = "continuation-compression-incarnation";
  const seedHistory = longHistory();
  const seedInput = "seed current request";
  const seedResult = await provider.generate({
    input: seedInput,
    instructions: "stable instructions",
    messages: seedHistory,
    context: continuationContext({
      sessionId,
      incarnation,
      history: seedHistory,
      input: seedInput,
      epoch: 0
    }),
    agent: { id: "main", name: "Main Agent" }
  });
  const candidate = seedResult.__responsesContinuationCandidate;
  assert.ok(candidate);
  const committedHistory = [
    ...seedHistory,
    { role: "user", content: seedInput },
    { role: "assistant", content: seedResult.text }
  ];
  assert.deepEqual(
    provider.commitResponsesContinuation(candidate, {
      messages: committedHistory,
      contextEpoch: 1,
      sessionIncarnation: incarnation
    }),
    { committed: true, reason: "committed" }
  );
  assert.equal(provider.responsesContinuationStore.stats().entries, 1);

  provider.contextWindowTokens = 2_000;
  const nextInput = "current request after compression";
  const nextResult = await provider.generate({
    input: nextInput,
    instructions: "stable instructions",
    messages: committedHistory,
    context: continuationContext({
      sessionId,
      incarnation,
      history: committedHistory,
      input: nextInput,
      epoch: 1
    }),
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(nextResult.text, "compressed answer");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].store, true);
  assert.equal(bodies[1].store, false);
  assert.equal(Object.hasOwn(bodies[1], "previous_response_id"), false);
  assert.match(JSON.stringify(bodies[1].input), /\[context summary\]/u);
  assert.equal(nextResult.__responsesContinuationCandidate, undefined);
  const stats = provider.responsesContinuationStore.stats();
  assert.equal(stats.entries, 0);
  assert.equal(stats.reservations, 0);
});

test("throwing continuation invalidation cannot abort compressed replay", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "continuation-invalidation-key",
    responsesContinuationMode: "auto",
    contextWindowTokens: 1_000_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return completedResponse(
      bodies.length === 1 ? "throwing-invalidation-seed" : "throwing-invalidation-next",
      bodies.length === 1 ? "seed answer" : "compressed answer"
    );
  };
  const sessionId = "throwing-invalidation-session";
  const incarnation = "throwing-invalidation-incarnation";
  const seedHistory = longHistory();
  const seedInput = "seed current request";
  const seed = await provider.generate({
    input: seedInput,
    instructions: "stable instructions",
    messages: seedHistory,
    context: continuationContext({
      sessionId,
      incarnation,
      history: seedHistory,
      input: seedInput,
      epoch: 0
    }),
    agent: { id: "main", name: "Main Agent" }
  });
  const committedHistory = [
    ...seedHistory,
    { role: "user", content: seedInput },
    { role: "assistant", content: seed.text }
  ];
  assert.equal(
    provider.commitResponsesContinuation(seed.__responsesContinuationCandidate, {
      messages: committedHistory,
      contextEpoch: 1,
      sessionIncarnation: incarnation
    }).committed,
    true
  );
  provider.responsesContinuationStore.invalidate = () => {
    throw new Error("injected invalidation failure");
  };
  provider.contextWindowTokens = 2_000;
  const nextInput = "current request after compression";

  const next = await provider.generate({
    input: nextInput,
    instructions: "stable instructions",
    messages: committedHistory,
    context: continuationContext({
      sessionId,
      incarnation,
      history: committedHistory,
      input: nextInput,
      epoch: 1
    }),
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(next.text, "compressed answer");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].store, false);
  assert.equal(Object.hasOwn(bodies[1], "previous_response_id"), false);
});

test("redaction priority covers alternate pool credentials under saturation", async () => {
  const active = "pool-active-secret-canary";
  const alternate = "pool-alternate-secret-canary";
  const providerKey = "provider-api-secret-canary";
  const poolEnv = {
    POOL_KEY_ONE: active,
    POOL_KEY_TWO: alternate
  };
  for (let index = 0; index < 200; index += 1) {
    poolEnv[`DUMMY_SECRET_${index}`] = `dummy-secret-value-${index}`;
  }
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "one", secretName: "POOL_KEY_ONE" },
      { id: "two", secretName: "POOL_KEY_TWO" }
    ],
    env: poolEnv
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: providerKey,
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let body;
  provider.postResponses = async (request) => {
    body = structuredClone(request);
    return completedResponse("saturated-redaction");
  };
  const messages = longHistory();
  messages[0].content = `active ${active}`;
  messages[1].content = `alternate ${alternate}`;
  messages[2].content = `provider ${providerKey}`;

  await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.match(JSON.stringify(body.input), /\[context summary\]/u);
  assert.doesNotMatch(
    JSON.stringify(body),
    /pool-active-secret-canary|pool-alternate-secret-canary|provider-api-secret-canary/u
  );
});

test("redaction overflow fails closed before any oversized paid request", async () => {
  const alternate = "overflow-alternate-secret-canary";
  const poolEnv = {
    OVERFLOW_KEY_ONE: "overflow-active-secret-canary",
    OVERFLOW_KEY_TWO: alternate
  };
  const credentialPool = new CredentialPool({
    provider: "openai",
    credentials: [
      { id: "one", secretName: "OVERFLOW_KEY_ONE" },
      { id: "two", secretName: "OVERFLOW_KEY_TWO" }
    ],
    env: poolEnv
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "",
    credentialPool,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send");
  };
  const contextRedactions = Array.from(
    { length: 300 },
    (_, index) => `overflow-context-secret-${index}`
  );
  const messages = longHistory();
  messages[0].content = `alternate ${alternate}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages,
    context: { __redactValues: contextRedactions }
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("cross-realm redaction sets protect both provider request formats", async () => {
  const secret = "cross-realm-redaction-secret";
  const redactValues = runInNewContext(
    `new Set(["${secret}"])`
  );
  const openai = new OpenAIResponsesProvider({
    apiKey: "cross-realm-openai-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let openaiBody;
  openai.postResponses = async (request) => {
    openaiBody = structuredClone(request);
    return completedResponse("cross-realm-openai");
  };
  const openaiMessages = longHistory();
  openaiMessages[0].content = `reflected ${secret}`;
  await openai.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: openaiMessages,
    context: { __redactValues: redactValues }
  });

  const anthropic = new AnthropicProvider({
    apiKey: "cross-realm-anthropic-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let anthropicBody;
  anthropic.postMessages = async (request) => {
    anthropicBody = structuredClone(request);
    return {
      id: "cross-realm-anthropic",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  const anthropicMessages = longHistory();
  anthropicMessages[0].content = `reflected ${secret}`;
  await anthropic.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: anthropicMessages,
    context: { __redactValues: redactValues }
  });

  assert.doesNotMatch(JSON.stringify(openaiBody), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(anthropicBody), new RegExp(secret, "u"));
});

test("redaction iteration bounds fail closed on oversized invalid sets", async () => {
  const invalidValues = new Set(
    Array.from({ length: 1_100 }, () => ({}))
  );
  const provider = new OpenAIResponsesProvider({
    apiKey: "bounded-redaction-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-invalid-set");
  };

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: longHistory(),
    context: { __redactValues: invalidValues }
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("provider redaction ignores accessors and inherited proxy environments", async () => {
  let storeReads = 0;
  let inheritedOwnKeyReads = 0;
  const inherited = new Proxy({}, {
    ownKeys() {
      inheritedOwnKeyReads += 1;
      throw new Error("inherited environment proxy must not be traversed");
    }
  });
  const store = {
    env: Object.create(inherited),
    allowlist: new Set()
  };
  const provider = new OpenAIResponsesProvider({
    apiKey: "provider-accessor-key",
    secretsStore: store,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  Object.defineProperty(provider, "secretsStore", {
    configurable: true,
    get() {
      storeReads += 1;
      throw new Error("provider secretsStore accessor must not run");
    }
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("provider-accessor-safe");
  };

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages: longHistory(),
    context: {
      runtime: {
        secrets: store
      }
    }
  });

  assert.equal(result.text, "done");
  assert.equal(requests, 1);
  assert.equal(storeReads, 0);
  assert.equal(inheritedOwnKeyReads, 0);
});

test("oversized aggregate history blocks safely instead of rejecting", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "aggregate-fail-open-key",
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("must-not-send-aggregate");
  };
  const messages = Array.from({ length: 82 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `aggregate-${index}-${"x".repeat(200_000)}`
  }));

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.stopReason, "context-too-large");
  assert.equal(requests, 0);
});

test("advisory secret stores and unknown windows cannot block provider requests", async () => {
  let exportReads = 0;
  let envReads = 0;
  const hostileStore = {};
  Object.defineProperty(hostileStore, "exportEnv", {
    get() {
      exportReads += 1;
      throw new Error("exportEnv getter must not run");
    }
  });
  Object.defineProperty(hostileStore, "env", {
    get() {
      envReads += 1;
      throw new Error("env getter must fail open");
    }
  });
  const provider = new OpenAIResponsesProvider({
    apiKey: "hostile-store-provider-key",
    model: "unknown-context-model",
    secretsStore: hostileStore,
    stallTimeoutMs: 0,
    cacheWarningLog: () => {}
  });
  let requests = 0;
  provider.postResponses = async () => {
    requests += 1;
    return completedResponse("hostile-store-done");
  };

  const result = await provider.generate({
    input: "current",
    instructions: "stable",
    messages: longHistory()
  });

  assert.equal(result.text, "done");
  assert.equal(requests, 1);
  assert.equal(exportReads, 0);
  assert.equal(envReads, 0, "unknown windows skip all background ledger preparation");
});

test("Anthropic installs the same live-secret-safe ledger", async () => {
  const providerSecret = "anthropic-provider-secret-canary";
  const storedSecret = "anthropic-stored-secret-canary";
  const secretsStore = {
    env: { ANTHROPIC_AUX_SECRET: storedSecret },
    allowlist: new Set(["ANTHROPIC_AUX_SECRET"])
  };
  const provider = new AnthropicProvider({
    apiKey: providerSecret,
    secretsStore,
    contextWindowTokens: 2_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 2,
    contextDigestChars: 600,
    stallTimeoutMs: 0
  });
  let body;
  provider.postMessages = async (request) => {
    body = structuredClone(request);
    return {
      id: "anthropic-ledger-done",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  const messages = longHistory();
  messages[0].content = `provider ${providerSecret}`;
  messages[1].content = `stored ${storedSecret}`;

  const result = await provider.generate({
    input: "current request",
    instructions: "stable instructions",
    messages
  });

  assert.equal(result.text, "done");
  assert.match(JSON.stringify(body.messages), /\[context summary\]/u);
  assert.doesNotMatch(
    JSON.stringify(body),
    /anthropic-provider-secret-canary|anthropic-stored-secret-canary/u
  );
});

test("Anthropic max-hop resumes stay separate from tool results and out of later ledgers", async () => {
  const provider = new AnthropicProvider({
    apiKey: "anthropic-synthetic-resume-key",
    contextWindowTokens: 30_000,
    contextEstimateCharsPerToken: 4,
    contextKeepRecentHops: 1,
    contextDigestChars: 1_200,
    maxIterations: 4,
    maxRequestHops: 1,
    maxToolOutputChars: 8_000,
    stallTimeoutMs: 0
  });
  const bodies = [];
  provider.postMessages = async (request) => {
    bodies.push(structuredClone(request));
    const iteration = bodies.length;
    if (iteration < 4) {
      return {
        id: `anthropic-tool-${iteration}`,
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: `tool-${iteration}`,
          name: "step",
          input: { iteration }
        }],
        usage: {
          input_tokens: 15_000,
          output_tokens: 10
        }
      };
    }
    return {
      id: "anthropic-synthetic-resume-done",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
      usage: {
        input_tokens: 15_000,
        output_tokens: 10
      }
    };
  };
  const toolRegistry = {
    toAnthropicTools: () => [{
      name: "step",
      description: "advance one step",
      input_schema: { type: "object" }
    }],
    invoke: async (_name, args) => ({
      ok: true,
      result: {
        iteration: args.iteration,
        payload: "x".repeat(6_000)
      }
    })
  };

  const result = await provider.generate({
    input: "complete the real task",
    instructions: "stable instructions",
    messages: longHistory(12, 120),
    toolRegistry
  });

  assert.equal(result.text, "done");
  assert.equal(bodies.length, 4);
  const secondMessages = bodies[1].messages;
  const firstResultIndex = secondMessages.findIndex((message) => (
    Array.isArray(message.content)
    && message.content.some((block) => (
      block.type === "tool_result" && block.tool_use_id === "tool-1"
    ))
  ));
  assert.ok(firstResultIndex >= 0);
  assert.deepEqual(
    secondMessages[firstResultIndex].content.map((block) => block.type),
    ["tool_result"],
    "the synthetic resume must not be merged into the tool-result message"
  );
  assert.match(
    JSON.stringify(secondMessages[firstResultIndex + 1]),
    /Continue the same task now/u,
    "the synthetic resume remains a separate provider turn"
  );

  const finalSummary = bodies.at(-1).messages
    .flatMap((message) => (
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
          : []
    ))
    .find((text) => /^\[context summary\]/u.test(text));
  assert.equal(typeof finalSummary, "string");
  assert.doesNotMatch(
    finalSummary,
    /Continue the same task now/u,
    "harness-generated resume text must never become ledger objective"
  );
});

test("public entrypoint exposes the context-ledger lifecycle", async () => {
  const publicApi = await import("../src/index.js");
  for (const name of [
    "compressLiveContext",
    "cooperativeContextLedgerSummarizer",
    "createContextLedgerCandidate",
    "installContextLedgerCandidate",
    "previewContextLedger",
    "restoreContextLedger"
  ]) {
    assert.equal(typeof publicApi[name], "function", `${name} must be publicly exported`);
  }
});

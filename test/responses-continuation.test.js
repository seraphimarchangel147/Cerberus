import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationUnsupported,
  createConversationContentIdentity,
  createConversationLineageIdentity,
  createCredentialLeaseIdentity,
  createOpenAIPromptCacheKey,
  createRoutingIdentity,
  createVisibleToolCatalogIdentity,
  extendConversationLineageIdentity,
  parseResponsesContinuationMode,
  resolveResponsesContinuationMode,
  ResponsesContinuationStore
} from "../src/responses-continuation.js";

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  }
];

function cacheKey(overrides = {}) {
  return createOpenAIPromptCacheKey({
    model: "gpt-5",
    stableInstructions: "Use the available tools carefully.",
    tools,
    ...overrides
  });
}

function identity(overrides = {}) {
  return {
    sessionId: "session-a",
    sessionIncarnation: "incarnation-a",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5",
    credentialIdentity: createCredentialLeaseIdentity({
      provider: "openai",
      id: "lease-a",
      type: "api-key",
      credential: "secret-a"
    }),
    routingIdentity: createRoutingIdentity({
      endpoint: "https://api.openai.com/v1",
      organization: "org-a"
    }),
    projectId: "project-a",
    memoryScope: null,
    promptIdentity: cacheKey(),
    toolIdentity: createVisibleToolCatalogIdentity(tools),
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    lineageIdentity: createConversationLineageIdentity([]),
    contextEpoch: 0,
    ...overrides
  };
}

test("prompt cache keys are deterministic and preserve visible tool order", () => {
  const rekeyed = tools.map((tool) => JSON.parse(JSON.stringify(tool)));
  const first = cacheKey();

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(cacheKey({ tools: rekeyed }), first);
  assert.notEqual(cacheKey({ tools: [...tools].reverse() }), first);
});

test("prompt cache keys change for stable inputs and ignore data-only private extras", () => {
  const baseline = cacheKey({
    sessionId: "session-secret",
    userInput: "user-secret",
    credential: "credential-secret"
  });
  const withPrivateExtras = cacheKey({
    sessionId: "different-session",
    userInput: "different-user-secret",
    credential: "different-credential"
  });
  const withToolInternals = cacheKey({
    tools: tools.map((tool) => ({
      ...tool,
      metadata: { sessionId: "private-session" }
    }))
  });

  assert.equal(withPrivateExtras, baseline);
  assert.equal(withToolInternals, baseline);
  assert.notEqual(cacheKey({ model: "gpt-5-mini" }), baseline);
  assert.notEqual(cacheKey({ stableInstructions: "Use no tools." }), baseline);
  assert.notEqual(cacheKey({
    tools: [{
      ...tools[0],
      parameters: {
        type: "object",
        properties: { uri: { type: "string" } }
      }
    }]
  }), baseline);
  for (const canary of ["session-secret", "user-secret", "credential-secret"]) {
    assert.equal(baseline.includes(canary), false);
  }
});

test("canonical identities reject hostile and unbounded data without invoking it", () => {
  assert.throws(() => cacheKey({ tools: {} }), /array/);
  assert.throws(() => cacheKey({ tools: new Array(513).fill(tools[0]) }), /size/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => cacheKey({
    tools: [{ type: "function", name: "cyclic", parameters: cyclic }]
  }), /cycles/);
  assert.throws(() => createRoutingIdentity({ amount: 1n }), /BigInt/);
  assert.throws(() => createRoutingIdentity(new Date()), /plain prototype/);
  assert.throws(() => createRoutingIdentity(new Proxy({}, {})), /proxies/);

  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "token", {
    enumerable: true,
    get() {
      reads += 1;
      return "secret";
    }
  });
  assert.throws(() => createRoutingIdentity(accessor), /data properties/);
  assert.equal(reads, 0);

  const sparse = new Array(3);
  sparse[2] = "tail";
  assert.throws(() => createConversationContentIdentity(sparse), /dense/);
  const unsafe = JSON.parse('{"__proto__":"blocked"}');
  assert.throws(() => createRoutingIdentity(unsafe), /unsafe key/);
  assert.throws(
    () => createConversationContentIdentity("x".repeat(300 * 1024)),
    /byte size/
  );
  assert.throws(
    () => createRoutingIdentity({
      a: "a".repeat(220 * 1024),
      b: "b".repeat(220 * 1024),
      c: "c".repeat(220 * 1024),
      d: "d".repeat(220 * 1024),
      e: "e".repeat(220 * 1024)
    }),
    /byte size/
  );
  let deep = { value: true };
  for (let index = 0; index < 34; index += 1) deep = { child: deep };
  assert.throws(() => createRoutingIdentity(deep), /depth/);
  assert.throws(() => createRoutingIdentity({ value: Number.NaN }), /finite/);
});

test("lineage is ordered, composable, metadata-independent, and supports content hashes", () => {
  const first = { id: "private-1", role: "USER", content: "hello", timestamp: 1 };
  const second = { id: "private-2", role: "assistant", content: "hi", timestamp: 2 };
  const complete = createConversationLineageIdentity([first, second]);
  const extended = extendConversationLineageIdentity(
    createConversationLineageIdentity([first]),
    [second]
  );
  assert.equal(extended, complete);
  assert.notEqual(createConversationLineageIdentity([second, first]), complete);
  assert.equal(createConversationLineageIdentity([
    { role: "user", content: "hello", id: "changed" },
    { role: "assistant", content: "hi", metadata: { anything: true } }
  ]), complete);

  const contentIdentity = createConversationContentIdentity("durable raw text");
  const expanded = createConversationLineageIdentity([{
    role: "user",
    content: [{ type: "input_text", text: "expanded provider text" }],
    contentIdentity
  }]);
  const raw = createConversationLineageIdentity([{
    role: "user",
    content: "ignored because an identity is supplied",
    contentIdentity
  }]);
  assert.equal(expanded, raw);
  assert.throws(
    () => createConversationLineageIdentity([{ role: "tool", content: "x" }]),
    /user or assistant/
  );
  assert.throws(
    () => createConversationLineageIdentity([{
      role: "user",
      content: "x",
      contentIdentity: "not-a-hash"
    }]),
    /SHA-256/
  );
});

test("lineage rejects executable, accessor, proxy, and sparse transcript input", () => {
  let reads = 0;
  const message = { role: "user", content: "safe" };
  Object.defineProperty(message, "metadata", {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    }
  });
  assert.throws(() => createConversationLineageIdentity([message]), /data properties/);
  assert.equal(reads, 0);
  assert.throws(
    () => createConversationLineageIdentity([
      { role: "user", content: "safe", callback() {} }
    ]),
    /executable/
  );
  assert.throws(
    () => createConversationLineageIdentity([new Proxy({}, {})]),
    /plain object/
  );
  const sparse = new Array(2);
  sparse[1] = { role: "user", content: "tail" };
  assert.throws(() => createConversationLineageIdentity(sparse), /dense/);
});

test("credential and routing identities are stable hashes with full isolation", () => {
  const baseCredential = {
    provider: "openai",
    id: "lease-a",
    type: "api-key",
    credential: "private-token"
  };
  const first = createCredentialLeaseIdentity(baseCredential);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes("private-token"), false);
  assert.equal(createCredentialLeaseIdentity({ ...baseCredential }), first);
  assert.notEqual(
    createCredentialLeaseIdentity({ ...baseCredential, credential: "other-token" }),
    first
  );
  assert.equal(
    createCredentialLeaseIdentity({ ...baseCredential, id: "lease-b" }),
    first
  );
  assert.notEqual(
    createRoutingIdentity({ endpoint: "https://a.example/v1", pool: "a" }),
    createRoutingIdentity({ endpoint: "https://a.example/v1", pool: "b" })
  );
});

test("continuation mode is fail-closed and explicitly parsed", () => {
  assert.equal(parseResponsesContinuationMode(undefined), "off");
  assert.equal(parseResponsesContinuationMode(true), "off");
  assert.equal(parseResponsesContinuationMode(" AUTO "), "auto");
  assert.equal(parseResponsesContinuationMode("on"), "on");
  assert.equal(parseResponsesContinuationMode("enabled"), "off");
  assert.equal(resolveResponsesContinuationMode({}), "off");
  assert.equal(resolveResponsesContinuationMode({
    OPENAGI_RESPONSES_CONTINUATION: "on"
  }), "on");
});

test("the default-off store never retains response IDs", () => {
  const store = new ResponsesContinuationStore();
  assert.deepEqual(store.commit(identity(), "resp_private", state()), {
    committed: false,
    reason: "off"
  });
  assert.deepEqual(store.claim(identity(), state()), {
    hit: false,
    reason: "off",
    responseId: null,
    reservation: null
  });
  assert.equal(store.stats().entries, 0);
});

test("claims are atomic, single-use, and validate lineage plus context epoch", () => {
  const store = new ResponsesContinuationStore({ mode: "auto" });
  const base = identity();
  const initial = state();
  const initialClaim = store.claim(base, initial);
  assert.equal(initialClaim.reason, "not_found");
  const committed = {
    ...initial,
    contextEpoch: 1,
    reservation: initialClaim.reservation
  };
  assert.equal(store.commit(base, "resp_123", committed).committed, true);
  const mismatchedClaim = store.claim(base, initial);
  assert.equal(mismatchedClaim.hit, false);
  assert.equal(mismatchedClaim.reason, "context_epoch_mismatch");
  assert.equal(mismatchedClaim.responseId, null);
  assert.match(mismatchedClaim.reservation, /^[A-Za-z0-9_-]+$/);
  const secondClaim = store.claim(base, {
    ...initial,
    contextEpoch: 1
  });
  assert.equal(secondClaim.reason, "not_found");

  const restoredClaim = store.claim(base, {
    ...initial,
    contextEpoch: 1
  });
  assert.equal(store.commit(base, "resp_123", {
    ...initial,
    contextEpoch: 2,
    reservation: restoredClaim.reservation
  }).committed, true);
  const claimed = store.claim(base, {
    ...initial,
    contextEpoch: 2
  });
  assert.deepEqual({
    ...claimed,
    reservation: "<opaque>"
  }, {
    hit: true,
    reason: "claimed",
    responseId: "resp_123",
    reservation: "<opaque>"
  });
  assert.equal(store.claim(base, {
    ...initial,
    contextEpoch: 2
  }).reason, "not_found");

  const lineage = createConversationLineageIdentity([
    { role: "user", content: "next" }
  ]);
  const lineageReservation = store.claim(base, {
    ...initial,
    contextEpoch: 2
  }).reservation;
  assert.equal(store.commit(base, "resp_456", {
    lineageIdentity: lineage,
    contextEpoch: 3,
    reservation: lineageReservation
  }).committed, true);
  assert.equal(store.claim(base, {
    lineageIdentity: lineage,
    contextEpoch: 2
  }).reason, "context_epoch_mismatch");
  assert.equal(store.claim(base, {
    lineageIdentity: lineage,
    contextEpoch: 3
  }).reason, "not_found");

  const finalReservation = store.claim(base, {
    lineageIdentity: lineage,
    contextEpoch: 3
  }).reservation;
  assert.equal(store.commit(base, "resp_789", {
    lineageIdentity: lineage,
    contextEpoch: 4,
    reservation: finalReservation
  }).committed, true);
  assert.equal(store.claim(base, {
    lineageIdentity: createConversationLineageIdentity([]),
    contextEpoch: 4
  }).reason, "lineage_mismatch");
});

test("stale and duplicate commits cannot replace newer continuation state", () => {
  const store = new ResponsesContinuationStore({ mode: "auto" });
  const base = identity();
  const newer = {
    lineageIdentity: createConversationLineageIdentity([
      { role: "user", content: "new" }
    ]),
    contextEpoch: 4
  };
  const firstReservation = store.claim(base, state()).reservation;
  const winningReservation = store.claim(base, state()).reservation;
  assert.deepEqual(store.commit(base, "resp_late", {
    ...newer,
    reservation: firstReservation
  }), {
    committed: false,
    reason: "stale_reservation"
  });
  assert.equal(store.commit(base, "resp_new", {
    ...newer,
    reservation: winningReservation
  }).committed, true);
  const sameContextClaim = store.claim(base, newer);
  assert.deepEqual(store.commit(base, "resp_duplicate", {
    ...newer,
    reservation: sameContextClaim.reservation
  }), {
    committed: false,
    reason: "stale_context"
  });
  assert.equal(store.abandon(base, sameContextClaim.reservation).reason, "stale_reservation");
});

test("miss reservations supersede atomically, abandon once, and expire", () => {
  let now = 10_000;
  const store = new ResponsesContinuationStore({
    mode: "auto",
    ttlMs: 20,
    now: () => now
  });
  const base = identity();
  const first = store.claim(base, state());
  const second = store.claim(base, state());
  assert.equal(first.reason, "not_found");
  assert.equal(second.reason, "not_found");
  assert.notEqual(first.reservation, second.reservation);
  assert.deepEqual(store.abandon(base, first.reservation), {
    abandoned: false,
    reason: "stale_reservation"
  });
  assert.deepEqual(store.abandon(base, second.reservation), {
    abandoned: true,
    reason: "abandoned"
  });
  assert.deepEqual(store.abandon(base, second.reservation), {
    abandoned: false,
    reason: "stale_reservation"
  });

  const expiring = store.claim(base, state());
  now += 21;
  assert.deepEqual(store.commit(base, "resp_late", {
    ...state(),
    contextEpoch: 1,
    reservation: expiring.reservation
  }), {
    committed: false,
    reason: "stale_reservation"
  });
});

test("continuation isolates every security and routing boundary", () => {
  const variants = [
    { sessionId: "session-b" },
    { sessionIncarnation: "incarnation-b" },
    { provider: "azure-openai" },
    { endpoint: "https://example.openai.azure.com/openai/v1" },
    { model: "gpt-5-mini" },
    {
      credentialIdentity: createCredentialLeaseIdentity({
        provider: "openai",
        id: "lease-b",
        type: "api-key",
        credential: "secret-b"
      })
    },
    { routingIdentity: createRoutingIdentity({ route: "secondary" }) },
    { projectId: "project-b" },
    { projectId: null, memoryScope: "memory-a" },
    { promptIdentity: cacheKey({ stableInstructions: "Changed." }) },
    { toolIdentity: createVisibleToolCatalogIdentity([tools[0]]) }
  ];
  for (const [index, variant] of variants.entries()) {
    const store = new ResponsesContinuationStore({ mode: "auto" });
    const reservation = store.claim(identity(), state()).reservation;
    const committedState = {
      ...state(),
      contextEpoch: 1,
      reservation
    };
    store.commit(identity(), `resp_${index}`, committedState);
    assert.equal(store.claim(identity(variant), {
      ...state(),
      contextEpoch: 1
    }).hit, false);
    assert.equal(store.claim(identity(), {
      ...state(),
      contextEpoch: 1
    }).hit, true);
  }
});

test("negative capability cache is isolated by tenant, credential, route, and incarnation", () => {
  const store = new ResponsesContinuationStore({ mode: "auto" });
  const base = identity();
  assert.equal(store.markUnsupported(base).marked, true);
  const isolated = [
    identity({ sessionIncarnation: "incarnation-b" }),
    identity({ projectId: "project-b" }),
    identity({ projectId: null, memoryScope: "isolated-memory" }),
    identity({ routingIdentity: createRoutingIdentity({ route: "secondary" }) }),
    identity({
      credentialIdentity: createCredentialLeaseIdentity({
        provider: "openai",
        id: "lease-b",
        type: "api-key",
        credential: "secret-b"
      })
    })
  ];
  assert.equal(store.unsupportedStatus(base).unsupported, true);
  for (const candidate of isolated) {
    assert.equal(store.unsupportedStatus(candidate).unsupported, false);
  }
});

test("endpoint identity rejects embedded secrets and canonicalizes safe trailing slashes", () => {
  const store = new ResponsesContinuationStore({ mode: "auto" });
  const route = createRoutingIdentity({ target: "primary" });
  const original = identity({
    endpoint: "https://user:password@API.OpenAI.com/v1/?api_key=private#fragment",
    routingIdentity: route
  });
  const safeEquivalent = identity({
    endpoint: "https://api.openai.com/v1",
    routingIdentity: route
  });
  const reservation = store.claim(original, state()).reservation;
  assert.deepEqual(store.commit(original, "resp_endpoint", {
    ...state(),
    contextEpoch: 1,
    reservation
  }), { committed: false, reason: "invalid_input" });
  const safeReservation = store.claim(safeEquivalent, state()).reservation;
  store.commit(safeEquivalent, "resp_endpoint", {
    ...state(),
    contextEpoch: 1,
    reservation: safeReservation
  });
  assert.equal(store.claim(safeEquivalent, {
    ...state(),
    contextEpoch: 1
  }).responseId, "resp_endpoint");
});

test("store expiry, bounded LRU state, and invalidation are deterministic", () => {
  let now = 1_000;
  const store = new ResponsesContinuationStore({
    mode: "auto",
    maxEntries: 2,
    ttlMs: 50,
    now: () => now
  });
  const first = identity({ sessionId: "first" });
  const second = identity({ sessionId: "second" });
  const third = identity({ sessionId: "third" });
  for (const [entryIdentity, responseId] of [
    [first, "resp_first"],
    [second, "resp_second"],
    [third, "resp_third"]
  ]) {
    const reservation = store.claim(entryIdentity, state()).reservation;
    store.commit(entryIdentity, responseId, {
      ...state(),
      contextEpoch: 1,
      reservation
    });
  }

  const committedState = { ...state(), contextEpoch: 1 };
  assert.equal(store.claim(first, committedState).hit, false);
  const secondClaim = store.claim(second, committedState);
  assert.equal(secondClaim.hit, true);
  assert.equal(store.claim(third, committedState).hit, true);
  assert.equal(store.stats().evictions, 1);
  assert.ok(store.stats().lineages <= 2);

  assert.equal(store.commit(second, "resp_second_next", {
    ...state(),
    contextEpoch: 2,
    reservation: secondClaim.reservation
  }).committed, true);
  assert.deepEqual(store.invalidate(second), { invalidated: true, count: 2 });
  assert.equal(store.claim(second, { ...state(), contextEpoch: 2 }).hit, false);

  const expiryReservation = store.claim(first, state()).reservation;
  store.commit(first, "resp_expiring", {
    ...state(),
    contextEpoch: 1,
    reservation: expiryReservation
  });
  now += 51;
  assert.equal(store.claim(first, state()).hit, false);
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().lineages, 0);
});

test("unsupported bookkeeping makes auto mode fall back until expiry", () => {
  let now = 5_000;
  const store = new ResponsesContinuationStore({
    mode: "auto",
    unsupportedTtlMs: 100,
    now: () => now
  });
  const base = identity();
  const initialReservation = store.claim(base, state()).reservation;
  store.commit(base, "resp_before_unsupported", {
    ...state(),
    contextEpoch: 1,
    reservation: initialReservation
  });
  const marked = store.recordUnsupportedFallback(base);
  assert.equal(marked.marked, true);
  const unsupportedClaim = store.claim(base, {
    ...state(),
    contextEpoch: 1
  });
  assert.equal(unsupportedClaim.hit, false);
  assert.equal(unsupportedClaim.reason, "unsupported");
  assert.equal(unsupportedClaim.retryAfterMs, 100);
  assert.match(unsupportedClaim.reservation, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(store.commit(base, "resp_blocked", {
    ...state(),
    contextEpoch: 2,
    reservation: unsupportedClaim.reservation
  }), {
    committed: false,
    reason: "unsupported"
  });
  assert.equal(store.unsupportedStatus(base).unsupported, true);

  now += 101;
  assert.equal(store.unsupportedStatus(base).unsupported, false);
  const afterExpiryClaim = store.claim(base, {
    ...state(),
    contextEpoch: 1
  });
  assert.equal(store.commit(base, "resp_after_expiry", {
    ...state(),
    contextEpoch: 2,
    reservation: afterExpiryClaim.reservation
  }).committed, true);
  assert.equal(store.claim(base, {
    ...state(),
    contextEpoch: 2
  }).responseId, "resp_after_expiry");
  store.markUnsupported(base);
  assert.deepEqual(store.clearUnsupported(base), { cleared: true, count: 1 });
});

test("explicit on mode bypasses cached unsupported capability records", () => {
  const store = new ResponsesContinuationStore({ mode: "on" });
  const base = identity();
  store.markUnsupported(base);
  const claim = store.claim(base, state());
  assert.equal(store.commit(base, "resp_forced", {
    ...state(),
    contextEpoch: 1,
    reservation: claim.reservation
  }).committed, true);
  assert.equal(store.claim(base, {
    ...state(),
    contextEpoch: 1
  }).responseId, "resp_forced");
});

test("unsupported continuation errors are narrowly classified without getters", () => {
  assert.equal(continuationUnsupported(Object.assign(
    new Error("previous_response_id does not exist"),
    { status: 404 }
  )), true);
  assert.equal(continuationUnsupported({
    status: 400,
    providerCode: "invalid_previous_response_id",
    message: "bad request"
  }), true);
  assert.equal(continuationUnsupported({
    status: 400,
    message: "unrelated invalid request"
  }), false);
  assert.equal(continuationUnsupported({
    status: 500,
    message: "previous_response_id is unsupported"
  }), false);
  assert.equal(continuationUnsupported({
    providerCode: "invalid_previous_response_id",
    message: "previous_response_id is unsupported"
  }), false);

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() {
      reads += 1;
      return "previous_response_id is unsupported";
    }
  });
  assert.equal(continuationUnsupported(hostile), false);
  assert.equal(reads, 0);
});

test("invalid inputs fail closed and stats never expose raw identities", () => {
  const store = new ResponsesContinuationStore({ mode: "auto" });
  let identityReads = 0;
  const hostileIdentity = identity();
  Object.defineProperty(hostileIdentity, "provider", {
    enumerable: true,
    get() {
      identityReads += 1;
      return "openai";
    }
  });
  assert.equal(store.claim(hostileIdentity, state()).reason, "invalid_identity");
  assert.equal(store.markUnsupported(hostileIdentity).reason, "invalid_identity");
  assert.equal(identityReads, 0);

  assert.equal(store.commit(
    { ...identity(), sessionId: "" },
    "resp_1",
    state()
  ).committed, false);
  assert.equal(store.commit(identity(), "resp_1\ninjected", state()).committed, false);
  assert.equal(store.commit(identity(), "resp_1", {
    lineageIdentity: "invalid",
    contextEpoch: 0
  }).committed, false);
  assert.equal(store.claim(
    { ...identity(), credentialIdentity: null },
    state()
  ).hit, false);
  assert.equal(store.claim(
    { ...identity(), sessionIncarnation: null },
    state()
  ).hit, false);

  const oneShot = store.claim(identity(), state()).reservation;
  assert.deepEqual(store.commit(identity(), "invalid response id", {
    ...state(),
    contextEpoch: 1,
    reservation: oneShot
  }), {
    committed: false,
    reason: "invalid_input"
  });
  assert.deepEqual(store.commit(identity(), "resp_valid", {
    ...state(),
    contextEpoch: 1,
    reservation: oneShot
  }), {
    committed: false,
    reason: "stale_reservation"
  });

  const reservation = store.claim(identity(), state()).reservation;
  assert.equal(JSON.stringify(store.stats()).includes(reservation), false);
  store.commit(identity(), "resp_private_canary", {
    ...state(),
    contextEpoch: 1,
    reservation
  });
  store.markUnsupported(identity());
  const serializedStats = JSON.stringify(store.stats());
  for (const canary of [
    "resp_private_canary",
    "session-a",
    "secret-a",
    "project-a",
    "org-a"
  ]) {
    assert.equal(serializedStats.includes(canary), false);
  }
  assert.equal(new ResponsesContinuationStore({
    mode: "auto"
  }).claim(identity(), state()).hit, false);
});

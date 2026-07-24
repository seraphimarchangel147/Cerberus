import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { CredentialPool } from "../src/credential-pool.js";
import {
  OpenAIResponsesProvider,
  ProviderError
} from "../src/model-provider.js";
import {
  createConversationContentIdentity,
  createConversationLineageIdentity
} from "../src/responses-continuation.js";
import { saveEnv, SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

const TOOL_ALPHA = Object.freeze({
  type: "function",
  name: "alpha",
  description: "Run alpha.",
  parameters: {
    type: "object",
    properties: {}
  }
});

const TOOL_BETA = Object.freeze({
  type: "function",
  name: "beta",
  description: "Run beta.",
  parameters: {
    type: "object",
    properties: {}
  }
});

function providerOptions(overrides = {}) {
  return {
    apiKey: "credential-secret-a",
    model: "gpt-5",
    stallTimeoutMs: 0,
    providerMaxRetries: 0,
    contextWindowTokens: 200_000,
    ...overrides
  };
}

function continuationContext({
  sessionId = "continuation-session",
  incarnation = "continuation-incarnation",
  history = [],
  input,
  epoch = 0,
  extra = {}
}) {
  return {
    sessionId,
    __memoryScope: "main",
    __continuationEligible: true,
    __continuationHistoryIdentity: createConversationLineageIdentity(history),
    __continuationCurrentContentIdentity: createConversationContentIdentity(input),
    __continuationContextEpoch: epoch,
    __continuationSessionIncarnation: incarnation,
    ...extra
  };
}

function response(id, text, extra = {}) {
  return {
    id,
    status: "completed",
    output_text: text,
    output: [],
    usage: {
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11
    },
    ...extra
  };
}

function candidateOf(result) {
  return result?.__responsesContinuationCandidate ?? null;
}

function commitTurn(provider, result, {
  input,
  text = result.text,
  epoch = 1,
  incarnation = "continuation-incarnation"
}) {
  const messages = [
    { role: "user", content: input },
    { role: "assistant", content: text }
  ];
  return {
    messages,
    committed: provider.commitResponsesContinuation(candidateOf(result), {
      messages,
      contextEpoch: epoch,
      sessionIncarnation: incarnation
    })
  };
}

async function seedContinuation({
  provider = new OpenAIResponsesProvider(providerOptions({
    responsesContinuationMode: "auto"
  })),
  input = "First turn.",
  instructions = "Stable instructions.",
  tools = [TOOL_ALPHA, TOOL_BETA],
  sessionId = "continuation-session",
  incarnation = "continuation-incarnation"
} = {}) {
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return response("resp-seed-private", "Seed answer.");
  };
  const context = continuationContext({
    sessionId,
    incarnation,
    input,
    epoch: 0
  });
  const result = await provider.generate({
    input,
    instructions,
    tools,
    context,
    agent: { id: "main", name: "Main Agent" }
  });
  const committed = commitTurn(provider, result, {
    input,
    incarnation
  });
  assert.deepEqual(committed.committed, {
    committed: true,
    reason: "committed"
  });
  return {
    provider,
    bodies,
    context,
    result,
    messages: committed.messages,
    instructions,
    tools,
    sessionId,
    incarnation
  };
}

function makeHost(provider, store = new InMemoryAgentStore()) {
  const runtime = {
    tools: new ToolRegistry(),
    memory: {
      retrieve: () => [],
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory-continuation-provider" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "signal-continuation-provider",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["continuation integration fixture"],
        dimensions: {
          novelty: 0.2,
          risk: 0.1,
          repetition: 0.1
        }
      },
      customContext: [],
      propagation: null
    })
  };
  return {
    host: new AgentHost({
      runtime,
      store,
      modelProvider: provider
    }),
    store
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("default-off OpenAI requests remain stateless and carry a stable cache key", async () => {
  const provider = new OpenAIResponsesProvider(providerOptions());
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return response("resp-default-off", "Stateless answer.");
  };

  const result = await provider.generate({
    input: "Default behavior.",
    instructions: "Stable instructions.",
    tools: [TOOL_ALPHA],
    context: {
      sessionId: "default-off-session",
      __memoryScope: "main"
    },
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].store, false);
  assert.equal(Object.hasOwn(bodies[0], "previous_response_id"), false);
  assert.match(bodies[0].prompt_cache_key, /^[a-f0-9]{64}$/u);
  assert.equal(candidateOf(result), null);
  assert.equal(provider.responsesContinuationStore.stats().mode, "off");
  assert.equal(provider.responsesContinuationStore.stats().entries, 0);
});

test("an opt-in seed returns an opaque private candidate and commits only explicitly", async () => {
  const provider = new OpenAIResponsesProvider(providerOptions({
    responsesContinuationMode: "auto"
  }));
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return response("resp-private-candidate", "Seed answer.");
  };
  const input = "Seed this continuation.";
  const incarnation = "explicit-commit-incarnation";
  const result = await provider.generate({
    input,
    instructions: "Stable instructions.",
    tools: [TOOL_ALPHA],
    context: continuationContext({
      sessionId: "explicit-commit-session",
      incarnation,
      input
    }),
    agent: { id: "main", name: "Main Agent" }
  });

  const candidate = candidateOf(result);
  const descriptor = Object.getOwnPropertyDescriptor(
    result,
    "__responsesContinuationCandidate"
  );
  assert.equal(bodies[0].store, true);
  assert.ok(candidate);
  assert.equal(Object.isFrozen(candidate), true);
  assert.deepEqual(Object.keys(candidate), []);
  assert.equal(descriptor.enumerable, false);
  assert.equal(provider.responsesContinuationStore.stats().entries, 0);
  assert.equal(provider.responsesContinuationStore.stats().commits, 0);

  const committed = commitTurn(provider, result, { input, incarnation });
  assert.deepEqual(committed.committed, {
    committed: true,
    reason: "committed"
  });
  assert.equal(provider.responsesContinuationStore.stats().entries, 1);
  assert.equal(provider.responsesContinuationStore.stats().commits, 1);
  assert.deepEqual(
    provider.commitResponsesContinuation(candidate, {
      messages: committed.messages,
      contextEpoch: 1,
      sessionIncarnation: incarnation
    }),
    { committed: false, reason: "invalid_candidate" }
  );
});

test("AgentHost commits a completed turn and sends only the next current turn by continuation", async () => {
  const provider = new OpenAIResponsesProvider(providerOptions({
    responsesContinuationMode: "auto"
  }));
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return response(`resp-host-${bodies.length}`, `Host answer ${bodies.length}.`);
  };
  const { host, store } = makeHost(provider);
  const sessionId = "host-continuation-session";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "First host turn.",
    backgroundReview: false
  });
  assert.equal(provider.responsesContinuationStore.stats().entries, 1);

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Second host turn.",
    backgroundReview: false
  });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].previous_response_id, "resp-host-1");
  assert.equal(bodies[1].input.length, 1);
  assert.equal(bodies[1].input[0].role, "user");
  assert.match(JSON.stringify(bodies[1].input[0]), /Second host turn/u);
  assert.doesNotMatch(
    JSON.stringify(bodies[1].input),
    /First host turn|Host answer 1/u
  );
  assert.equal(store.getSession(sessionId).messages.length, 4);
  assert.equal(provider.responsesContinuationStore.stats().commits, 2);
  assert.equal(provider.responsesContinuationStore.stats().entries, 1);
});

test("AgentHost abandons provider state on append failure and keeps ephemeral turns stateless", async (t) => {
  await t.test("assistant append failure", async () => {
    class AssistantFailStore extends InMemoryAgentStore {
      appendMessage(sessionId, message) {
        if (message?.role === "assistant") {
          throw new Error("assistant append failed");
        }
        return super.appendMessage(sessionId, message);
      }
    }
    const provider = new OpenAIResponsesProvider(providerOptions({
      responsesContinuationMode: "auto"
    }));
    provider.postResponses = async (body) => response(
      "resp-append-failure-private",
      "Unpersisted answer.",
      { store: body.store }
    );
    const { host } = makeHost(provider, new AssistantFailStore());
    await assert.rejects(
      host.handleMessage({
        channel: "local",
        from: "creator",
        sessionId: "append-failure-session",
        text: "Do not retain a failed append.",
        backgroundReview: false
      }),
      /assistant append failed/u
    );
    assert.equal(provider.responsesContinuationStore.stats().entries, 0);
    assert.equal(provider.responsesContinuationStore.stats().reservations, 0);
  });

  await t.test("ephemeral turn", async () => {
    const provider = new OpenAIResponsesProvider(providerOptions({
      responsesContinuationMode: "auto"
    }));
    const bodies = [];
    provider.postResponses = async (body) => {
      bodies.push(structuredClone(body));
      return response("resp-ephemeral-private", "Ephemeral answer.");
    };
    const { host } = makeHost(provider);
    await host.handleMessage({
      channel: "local",
      from: "creator",
      sessionId: "ephemeral-continuation-session",
      text: "Keep this turn ephemeral.",
      ephemeral: true,
      backgroundReview: false
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].store, false);
    assert.equal(Object.hasOwn(bodies[0], "previous_response_id"), false);
    assert.equal(provider.responsesContinuationStore.stats().entries, 0);
    assert.equal(provider.responsesContinuationStore.stats().reservations, 0);
  });
});

test("provider continuation is isolated across every request identity and privacy boundary", async (t) => {
  const variants = [
    {
      name: "model",
      prepare: ({ request }) => { request.model = "gpt-5-mini"; },
      cacheChanges: true
    },
    {
      name: "instructions",
      prepare: ({ request }) => { request.instructions = "Changed instructions."; },
      cacheChanges: true
    },
    {
      name: "tool order",
      prepare: ({ request }) => { request.tools = [TOOL_BETA, TOOL_ALPHA]; },
      cacheChanges: true
    },
    {
      name: "session incarnation",
      prepare: ({ request }) => {
        request.context.__continuationSessionIncarnation = "other-incarnation";
      }
    },
    {
      name: "credential",
      prepare: ({ provider }) => { provider.apiKey = "credential-secret-b"; }
    },
    {
      name: "routing",
      seedProvider: () => new OpenAIResponsesProvider(providerOptions({
        baseUrl: "https://openrouter.ai/api/v1",
        responsesContinuationMode: "auto",
        providerRouting: { sort: "price" }
      })),
      prepare: ({ provider }) => new OpenAIResponsesProvider(providerOptions({
        baseUrl: "https://openrouter.ai/api/v1",
        responsesContinuationStore: provider.responsesContinuationStore,
        providerRouting: { sort: "latency" }
      }))
    },
    {
      name: "provider ZDR",
      prepare: ({ provider }) => { provider.zeroDataRetention = true; },
      stateless: true
    },
    {
      name: "request ZDR",
      prepare: ({ request }) => { request.context.__zeroDataRetention = true; },
      stateless: true
    },
    {
      name: "routing data collection deny",
      prepare: ({ provider }) => {
        provider.providerRouting = Object.freeze({ data_collection: "deny" });
      },
      stateless: true
    }
  ];

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const seeded = await seedContinuation({
        ...(variant.seedProvider ? { provider: variant.seedProvider() } : {}),
        sessionId: `isolation-${variant.name.replaceAll(" ", "-")}`
      });
      const bodies = [];
      const input = "Second isolated turn.";
      const request = {
        input,
        instructions: seeded.instructions,
        tools: seeded.tools,
        messages: seeded.messages,
        context: continuationContext({
          sessionId: seeded.sessionId,
          incarnation: seeded.incarnation,
          history: seeded.messages,
          input,
          epoch: 1
        }),
        agent: { id: "main", name: "Main Agent" }
      };
      const activeProvider = variant.prepare({
        provider: seeded.provider,
        request
      }) ?? seeded.provider;
      activeProvider.postResponses = async (body) => {
        bodies.push(structuredClone(body));
        return response(`resp-${variant.name}`, "Isolated answer.");
      };

      await activeProvider.generate(request);

      assert.equal(bodies.length, 1);
      assert.equal(Object.hasOwn(bodies[0], "previous_response_id"), false);
      assert.equal(bodies[0].input.length, 3);
      assert.equal(bodies[0].store, variant.stateless === true ? false : true);
      if (variant.cacheChanges) {
        assert.notEqual(
          bodies[0].prompt_cache_key,
          seeded.bodies[0].prompt_cache_key
        );
      }
    });
  }
});

test("unsupported previous-response fallback happens once before tool dispatch", async () => {
  const seeded = await seedContinuation({
    sessionId: "unsupported-fallback-session"
  });
  const events = [];
  const bodies = [];
  seeded.provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    events.push(`request:${bodies.length}`);
    if (bodies.length === 1) {
      throw new ProviderError("previous_response_id is not supported", {
        status: 400,
        providerCode: "unsupported_previous_response_id"
      });
    }
    if (bodies.length === 2) {
      return {
        id: "resp-tool-after-replay",
        status: "completed",
        output: [{
          type: "function_call",
          status: "completed",
          call_id: "call-once",
          name: "alpha",
          arguments: "{}"
        }]
      };
    }
    return response("resp-after-tool", "Fallback completed.");
  };
  let toolInvocations = 0;
  const input = "Continue and use alpha.";
  const result = await seeded.provider.generate({
    input,
    instructions: seeded.instructions,
    tools: seeded.tools,
    messages: seeded.messages,
    context: continuationContext({
      sessionId: seeded.sessionId,
      incarnation: seeded.incarnation,
      history: seeded.messages,
      input,
      epoch: 1
    }),
    toolRegistry: {
      async invoke(name) {
        events.push(`tool:${name}`);
        toolInvocations += 1;
        return { ok: true, result: { changed: true } };
      }
    },
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(result.text, "Fallback completed.");
  assert.equal(toolInvocations, 1);
  assert.deepEqual(events, [
    "request:1",
    "request:2",
    "tool:alpha",
    "request:3"
  ]);
  assert.equal(bodies[0].previous_response_id, "resp-seed-private");
  assert.equal(bodies[0].input.length, 1);
  assert.equal(Object.hasOwn(bodies[1], "previous_response_id"), false);
  assert.equal(bodies[1].store, false);
  assert.equal(bodies[1].input.length, 3);
  assert.equal(Object.hasOwn(bodies[2], "previous_response_id"), false);
  assert.equal(
    seeded.provider.responsesContinuationStore.stats().unsupportedFallbacks,
    1
  );
});

test("an unrelated HTTP 400 never triggers stateless continuation replay", async () => {
  const seeded = await seedContinuation({
    sessionId: "arbitrary-400-session"
  });
  const bodies = [];
  const failure = new ProviderError("Invalid unrelated request field.", {
    status: 400,
    providerCode: "invalid_request_error"
  });
  seeded.provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    throw failure;
  };
  const input = "Second turn with bad request.";
  let toolInvocations = 0;

  await assert.rejects(
    seeded.provider.generate({
      input,
      instructions: seeded.instructions,
      tools: seeded.tools,
      messages: seeded.messages,
      context: continuationContext({
        sessionId: seeded.sessionId,
        incarnation: seeded.incarnation,
        history: seeded.messages,
        input,
        epoch: 1
      }),
      toolRegistry: {
        async invoke() {
          toolInvocations += 1;
          return { ok: true, result: {} };
        }
      },
      agent: { id: "main", name: "Main Agent" }
    }),
    (error) => error === failure
  );

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].previous_response_id, "resp-seed-private");
  assert.equal(toolInvocations, 0);
  assert.equal(
    seeded.provider.responsesContinuationStore.stats().unsupportedFallbacks,
    0
  );
});

test("forced and synthetic answers never produce continuation candidates", async (t) => {
  await t.test("forced answer", async () => {
    const provider = new OpenAIResponsesProvider(providerOptions({
      responsesContinuationMode: "auto",
      maxIterations: 1
    }));
    const bodies = [];
    provider.postResponses = async (body) => {
      bodies.push(structuredClone(body));
      if (body.tools?.length) {
        return {
          id: "resp-before-force",
          status: "completed",
          output: [{
            type: "function_call",
            status: "completed",
            call_id: "call-force",
            name: "alpha",
            arguments: "{}"
          }]
        };
      }
      return response("resp-forced-private", "Forced final answer.");
    };
    let toolInvocations = 0;
    const input = "Force after one tool.";
    const result = await provider.generate({
      input,
      instructions: "Stable instructions.",
      tools: [TOOL_ALPHA],
      maxIterations: 1,
      context: continuationContext({
        sessionId: "forced-answer-session",
        input
      }),
      toolRegistry: {
        async invoke() {
          toolInvocations += 1;
          return { ok: true, result: { done: true } };
        }
      },
      agent: { id: "main", name: "Main Agent" }
    });

    assert.equal(result.stopReason, "iteration-cap");
    assert.equal(result.text, "Forced final answer.");
    assert.equal(toolInvocations, 1);
    assert.equal(candidateOf(result), null);
    assert.equal(bodies.at(-1).store, false);
    assert.equal(provider.responsesContinuationStore.stats().entries, 0);
    assert.equal(provider.responsesContinuationStore.stats().reservations, 0);
  });

  await t.test("synthetic provider-error answer", async () => {
    const provider = new OpenAIResponsesProvider(providerOptions({
      responsesContinuationMode: "auto"
    }));
    provider.postResponses = async () => {
      throw new ProviderError("Provider unavailable.", { status: 503 });
    };
    const input = "Return a safe synthetic result.";
    const result = await provider.generate({
      input,
      instructions: "Stable instructions.",
      context: continuationContext({
        sessionId: "synthetic-answer-session",
        input
      }),
      agent: { id: "main", name: "Main Agent" }
    });

    assert.equal(result.stopReason, "provider-error");
    assert.match(result.text, /provider.*unavailable/u);
    assert.equal(candidateOf(result), null);
    assert.equal(provider.responsesContinuationStore.stats().entries, 0);
    assert.equal(provider.responsesContinuationStore.stats().reservations, 0);
  });
});

test("mid-request credential rotation replays statelessly without crossing account state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const credentialA = "credential-private-a";
  const credentialB = "credential-private-b";
  const pool = new CredentialPool({
    provider: "openai",
    strategy: "fill_first",
    env: {
      OPENAI_A: credentialA,
      OPENAI_B: credentialB
    },
    credentials: [
      { id: "a", secretName: "OPENAI_A" },
      { id: "b", secretName: "OPENAI_B" }
    ]
  });
  const provider = new OpenAIResponsesProvider(providerOptions({
    apiKey: "",
    credentialPool: pool,
    responsesContinuationMode: "auto"
  }));
  const network = [];
  let phase = "seed";
  globalThis.fetch = async (_url, init) => {
    const authorization = init.headers.authorization;
    const body = JSON.parse(init.body);
    network.push({ authorization, body });
    if (phase === "seed") {
      return jsonResponse(200, response(
        "resp-credential-seed-private",
        "Credential seed."
      ));
    }
    if (authorization === `Bearer ${credentialA}`) {
      return jsonResponse(401, {
        error: { message: "Credential is no longer authorized." }
      });
    }
    return jsonResponse(200, response(
      "resp-credential-safe-private",
      "Credential-safe replay."
    ));
  };

  const firstInput = "Seed credential continuation.";
  const first = await provider.generate({
    input: firstInput,
    instructions: "Stable instructions.",
    context: continuationContext({
      sessionId: "credential-rotation-session",
      input: firstInput
    }),
    agent: { id: "main", name: "Main Agent" }
  });
  const committed = commitTurn(provider, first, { input: firstInput });
  assert.equal(committed.committed.committed, true);

  phase = "rotate";
  network.length = 0;
  const secondInput = "Continue after credential rotation.";
  const second = await provider.generate({
    input: secondInput,
    instructions: "Stable instructions.",
    messages: committed.messages,
    context: continuationContext({
      sessionId: "credential-rotation-session",
      history: committed.messages,
      input: secondInput,
      epoch: 1
    }),
    agent: { id: "main", name: "Main Agent" }
  });

  assert.equal(second.text, "Credential-safe replay.");
  assert.equal(network.length, 2);
  assert.equal(network[0].authorization, `Bearer ${credentialA}`);
  assert.equal(
    network[0].body.previous_response_id,
    "resp-credential-seed-private"
  );
  assert.equal(network[0].body.input.length, 1);
  assert.equal(network[1].authorization, `Bearer ${credentialB}`);
  assert.equal(Object.hasOwn(network[1].body, "previous_response_id"), false);
  assert.equal(network[1].body.store, false);
  assert.equal(network[1].body.input.length, 3);
  assert.equal(candidateOf(second), null);
  assert.doesNotMatch(
    JSON.stringify({
      result: second,
      stats: provider.responsesContinuationStore.stats(),
      bodies: network.map(({ body }) => body)
    }),
    /credential-private-a|credential-private-b/u
  );
});

test("continuation candidates, commit results, and stats serialize no IDs or secrets", async () => {
  const provider = new OpenAIResponsesProvider(providerOptions({
    apiKey: "credential-serialization-canary",
    responsesContinuationMode: "auto"
  }));
  provider.postResponses = async () => response(
    "resp-serialization-private-canary",
    "Serializable answer."
  );
  const input = "Serialization check.";
  const result = await provider.generate({
    input,
    instructions: "Stable instructions.",
    context: continuationContext({
      sessionId: "serialization-private-session",
      input
    }),
    agent: { id: "main", name: "Main Agent" }
  });
  const candidate = candidateOf(result);
  const before = JSON.stringify({
    candidate,
    stats: provider.responsesContinuationStore.stats()
  });
  const committed = commitTurn(provider, result, { input });
  const after = JSON.stringify({
    candidate,
    commitResult: committed.committed,
    stats: provider.responsesContinuationStore.stats()
  });

  for (const serialized of [before, after]) {
    assert.doesNotMatch(serialized, /resp-serialization-private-canary/u);
    assert.doesNotMatch(serialized, /credential-serialization-canary/u);
    assert.doesNotMatch(serialized, /serialization-private-session/u);
  }
  assert.equal(JSON.stringify(candidate), "{}");
});

test("continuation mode is setup-allowlisted and persists without adjacent keys", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-continuation-setup-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const name = "OPENAGI_RESPONSES_CONTINUATION";
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  assert.ok(SETUP_FIELDS.includes(name));
  const saved = saveEnv({
    dataDir,
    values: {
      [name]: "auto",
      OPENAGI_RESPONSES_CONTINUATION_UNSAFE: "on"
    },
    decidedBy: "test:responses-continuation"
  });
  assert.deepEqual(saved.keys, [name]);
  const projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(projection, /^OPENAGI_RESPONSES_CONTINUATION=auto$/mu);
  assert.doesNotMatch(projection, /OPENAGI_RESPONSES_CONTINUATION_UNSAFE/u);
});

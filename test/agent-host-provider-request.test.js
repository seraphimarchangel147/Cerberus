import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeHarness(options = {}) {
  const requests = [];
  const store = new InMemoryAgentStore();
  const runtime = {
    tools: new ToolRegistry(),
    memory: {
      retrieve: () => [],
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory_provider_request" })
    },
    outcomes: null,
    processSignal: () => ({
      id: "output_provider_request",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["provider request fixture"],
        dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
      },
      customContext: [],
      propagation: null
    })
  };
  const modelProvider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate(request) {
      const sequence = requests.length + 1;
      requests.push({
        input: request.input,
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        images: request.images.map((image) => ({ ...image }))
      });
      return {
        provider: "fixture",
        model: "fixture-model",
        id: `response_provider_request_${sequence}`,
        text: `Fixture reply ${sequence}.`,
        toolCalls: [],
        iterations: 1,
        maxIterations: request.maxIterations,
        stopReason: "completed"
      };
    }
  };
  const host = new AgentHost({
    runtime,
    store,
    modelProvider,
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {})
  });
  return { host, requests, store };
}

function durableMessages(store, sessionId) {
  return store.getSession(sessionId).messages.map(({ role, content }) => ({ role, content }));
}

test("AgentHost sends a first turn exactly once while persisting the raw user message", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-first-turn";
  const current = "Explain canonical provider request assembly.";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: current,
    backgroundReview: false
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, current);
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(durableMessages(store, sessionId), [
    { role: "user", content: current },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
});

test("AgentHost sends only prior persisted messages on a later turn", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-multi-turn";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "First durable turn.",
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Second current turn.",
    backgroundReview: false
  });

  assert.deepEqual(requests[0].messages, []);
  assert.equal(requests[1].input, "Second current turn.");
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: "First durable turn." },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.deepEqual(durableMessages(store, sessionId), [
    { role: "user", content: "First durable turn." },
    { role: "assistant", content: "Fixture reply 1." },
    { role: "user", content: "Second current turn." },
    { role: "assistant", content: "Fixture reply 2." }
  ]);
});

test("AgentHost distinguishes repeated identical text from a duplicated current turn", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-repeated-text";
  const repeated = "Run the same verification again.";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: repeated,
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: repeated,
    backgroundReview: false
  });

  assert.equal(requests[1].input, repeated);
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: repeated },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.equal(
    requests[1].messages.filter((message) => message.role === "user" && message.content === repeated).length,
    1,
    "one identical prior user turn is history; the current copy belongs only in input"
  );
  assert.equal(
    durableMessages(store, sessionId).filter(
      (message) => message.role === "user" && message.content === repeated
    ).length,
    2,
    "both real user turns remain durable"
  );
});

test("AgentHost gives an ephemeral turn one current input and no persisted history", async () => {
  const { host, requests, store } = makeHarness();
  const current = "Connectivity probe.";

  await host.handleMessage({
    channel: "local",
    from: "setup",
    sessionId: "provider-request-ephemeral",
    text: current,
    ephemeral: true,
    backgroundReview: false
  });

  assert.equal(requests[0].input, current);
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(store.listSessions(), []);
});

test("AgentHost expands a current context reference without replacing its raw durable form", async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-request-context-"));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspaceDir, "evidence.txt"), "context evidence payload", "utf8");

  const { host, requests, store } = makeHarness({ workspaceDir });
  const sessionId = "provider-request-context-reference";
  const rawCurrent = "Inspect @file:evidence.txt";

  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: "Establish prior history.",
    backgroundReview: false
  });
  await host.handleMessage({
    channel: "local",
    from: "creator",
    sessionId,
    text: rawCurrent,
    backgroundReview: false
  });

  assert.match(requests[1].input, /^Inspect @file:evidence\.txt/);
  assert.match(requests[1].input, /--- Attached Context ---/);
  assert.match(requests[1].input, /context evidence payload/);
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: "Establish prior history." },
    { role: "assistant", content: "Fixture reply 1." }
  ]);
  assert.equal(
    durableMessages(store, sessionId).at(-2).content,
    rawCurrent,
    "the transcript keeps the unexpanded user-authored text"
  );
});

test("AgentHost forwards current-turn images without adding the current text to history", async () => {
  const { host, requests, store } = makeHarness();
  const sessionId = "provider-request-image";
  const images = [{
    mediaType: "image/png",
    data: "AA==",
    filename: "pixel.png",
    bytes: 1
  }];

  await host.handleMessage({
    channel: "discord",
    from: "creator",
    sessionId,
    text: "Describe the attached image.",
    images,
    backgroundReview: false
  });

  assert.equal(requests[0].input, "Describe the attached image.");
  assert.deepEqual(requests[0].messages, []);
  assert.deepEqual(requests[0].images, images);
  assert.equal(durableMessages(store, sessionId)[0].content, "Describe the attached image.");
});

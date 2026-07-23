import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeWorkspace(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeHarness({
  workspaceDir,
  checkpointWorkspaceDir,
  onSignal = null
}) {
  const requests = [];
  const signals = [];
  const remembered = [];
  const tools = new ToolRegistry();
  const memory = {
    retrieve: () => [],
    renderSessionMemorySnapshot: () => "",
    remember(entry) {
      remembered.push(entry);
      return { id: "memory_context_reference" };
    }
  };
  const runtime = {
    tools,
    memory,
    checkpoints: checkpointWorkspaceDir
      ? { workspaceDir: checkpointWorkspaceDir }
      : null,
    tasks: {
      add() {
        return { id: "task_context_reference" };
      }
    },
    outcomes: null,
    processSignal(signal) {
      signals.push(signal);
      onSignal?.(signal);
      return {
        id: "output_context_reference",
        scrutiny: {
          action: "act",
          score: 0.6,
          reasons: ["context-reference fixture"],
          dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 }
        },
        customContext: [],
        propagation: null
      };
    }
  };
  const provider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate(request) {
      requests.push(request);
      return {
        provider: "fixture",
        model: "fixture-model",
        id: "response_context_reference",
        text: "Context received.",
        toolCalls: [],
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      };
    }
  };
  const store = new InMemoryAgentStore();
  const host = new AgentHost({
    runtime,
    store,
    modelProvider: provider,
    ...(workspaceDir ? { workspaceDir } : {})
  });
  return { host, remembered, requests, signals, store };
}

test("AgentHost expands references after scrutiny while preserving raw state", async (t) => {
  const workspaceDir = makeWorkspace(t, "openagi-context-host-workspace");
  const checkpointWorkspaceDir = makeWorkspace(t, "openagi-context-host-checkpoint");
  fs.writeFileSync(
    path.join(checkpointWorkspaceDir, "late-note.txt"),
    "wrong workspace content",
    "utf8"
  );
  const sequence = [];
  const harness = makeHarness({
    workspaceDir,
    checkpointWorkspaceDir,
    onSignal(signal) {
      sequence.push(["scrutiny", signal.content]);
      fs.writeFileSync(
        path.join(workspaceDir, "late-note.txt"),
        "created during scrutiny",
        "utf8"
      );
    }
  });
  const raw = "Inspect @file:late-note.txt and summarize it.";

  await harness.host.handleMessage({
    channel: "discord",
    from: "user-1",
    sessionId: "context-reference-expanded",
    text: raw,
    workspaceDir: checkpointWorkspaceDir,
    backgroundReview: false
  });
  sequence.push(["provider", harness.requests[0].input]);

  assert.equal(harness.host.workspaceDir, path.resolve(workspaceDir));
  assert.equal(harness.signals[0].content, raw);
  assert.equal(harness.signals[0].summary, raw);
  assert.equal(sequence[0][0], "scrutiny");
  assert.equal(sequence[1][0], "provider");
  assert.match(harness.requests[0].input, /^Inspect @file:late-note\.txt and summarize it\./);
  assert.match(harness.requests[0].input, /--- Attached Context ---/);
  assert.match(harness.requests[0].input, /created during scrutiny/);
  assert.doesNotMatch(harness.requests[0].input, /wrong workspace content/);

  const session = harness.store.getSession("context-reference-expanded");
  assert.equal(session.messages[0].role, "user");
  assert.equal(session.messages[0].content, raw);
  assert.equal(harness.remembered.length, 1);
  assert.match(harness.remembered[0].content, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(harness.remembered[0].content, /created during scrutiny/);
});

test("AgentHost leaves no-reference provider input byte-identical", async (t) => {
  const checkpointWorkspaceDir = makeWorkspace(t, "openagi-context-host-fallback");
  const harness = makeHarness({ checkpointWorkspaceDir });
  const raw = "This message has no context references, punctuation included: []{}!";

  await harness.host.handleMessage({
    channel: "discord",
    from: "user-2",
    sessionId: "context-reference-plain",
    text: raw,
    backgroundReview: false
  });

  assert.equal(harness.host.workspaceDir, path.resolve(checkpointWorkspaceDir));
  assert.equal(harness.requests[0].input, raw);
  assert.equal(
    Buffer.from(harness.requests[0].input).equals(Buffer.from(raw)),
    true
  );
  assert.equal(harness.store.getSession("context-reference-plain").messages[0].content, raw);
});

test("AgentHost passes its turn abort signal into reference expansion", async (t) => {
  const workspaceDir = makeWorkspace(t, "openagi-context-host-abort");
  fs.writeFileSync(path.join(workspaceDir, "note.txt"), "never delivered", "utf8");
  const harness = makeHarness({ workspaceDir });
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));

  await assert.rejects(
    harness.host.handleMessage({
      channel: "discord",
      from: "user-3",
      sessionId: "context-reference-abort",
      text: "Read @file:note.txt",
      abortSignal: controller.signal,
      backgroundReview: false
    }),
    (error) => error?.name === "AbortError" || /abort|stopped/i.test(error?.message ?? "")
  );
  assert.equal(harness.requests.length, 0);
});

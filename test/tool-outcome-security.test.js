import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HookRegistry } from "../src/hook-registry.js";
import {
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import {
  approvePendingAction,
  PendingActionStore
} from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setAutoApprove(t, value) {
  const previous = process.env.OPENAGI_AUTO_APPROVE;
  process.env.OPENAGI_AUTO_APPROVE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previous;
  });
}

async function waitForValue(read, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

test("catastrophic approval retains operation ownership and runs required hooks once", async (t) => {
  setAutoApprove(t, "0");
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  let externalPreCalls = 0;
  hooks.register({
    name: "required-external-policy",
    event: "pre_tool_call",
    handler: () => {
      externalPreCalls += 1;
      return { action: "allow" };
    }
  });

  const pendingActions = new PendingActionStore({
    dir: temporaryDirectory(t, "openagi-outcome-catastrophic-")
  });
  const registry = new ToolRegistry({ hooks });
  registry.bindPendingActions(pendingActions);
  let dispatches = 0;
  registry.register({
    name: "code_shell",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"],
      additionalProperties: false
    },
    needsConfirmation: true,
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      return { exitCode: 0, changed: true };
    }
  });

  const context = {
    sessionId: "security-catastrophic",
    __turnId: "turn-catastrophic-owner"
  };
  const invocation = registry.invoke(
    "code_shell",
    { command: "rm -rf /" },
    context
  );
  const action = await waitForValue(
    () => pendingActions.list({ status: "pending" })[0]
  );
  assert.ok(action, "catastrophic call entered the durable approval queue");

  const approval = approvePendingAction(
    { pendingActions, tools: registry },
    action.id,
    {
      decidedBy: "security-test",
      approvedVia: "test"
    }
  );
  const [result, approvalResult] = await Promise.all([invocation, approval]);
  await hooks.flush();

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(approvalResult, result);
  assert.equal(dispatches, 1, "the approved side effect dispatched exactly once");
  assert.equal(
    externalPreCalls,
    1,
    "confirmed replay retained ownership without bypassing required external hooks"
  );
});

test("restart-era approvals reject redacted arguments and changed tool identities", async (t) => {
  const dir = temporaryDirectory(t, "openagi-outcome-replay-");
  const registry = new ToolRegistry();
  let dispatches = 0;
  const register = () => registry.register({
    name: "send_once",
    needsConfirmation: true,
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      return { changed: true };
    }
  });
  register();
  const context = {
    sessionId: "security-replay",
    __turnId: "turn-replay"
  };
  const store = new PendingActionStore({ dir });
  const redacted = store.enqueue({
    toolName: "send_once",
    args: { authorization: "Bearer secret-replay-value" },
    context,
    approvalIdentity: registry.approvalIdentity("send_once", context)
  });
  const safe = store.enqueue({
    toolName: "send_once",
    args: { value: "safe" },
    context,
    approvalIdentity: registry.approvalIdentity("send_once", context)
  });

  const recovered = new PendingActionStore({ dir });
  const redactedResult = await approvePendingAction({
    pendingActions: recovered,
    tools: registry
  }, redacted.id, { decidedBy: "security-test" });
  assert.equal(redactedResult.ok, false);
  assert.equal(redactedResult.outcome.code, "approval_arguments_redacted");

  register();
  const changedResult = await approvePendingAction({
    pendingActions: recovered,
    tools: registry
  }, safe.id, { decidedBy: "security-test" });
  assert.equal(changedResult.ok, false);
  assert.equal(changedResult.outcome.code, "approval_identity_changed");
  assert.equal(dispatches, 0);
});

test("clearing a turn scope retains an in-flight non-idempotent reservation", async (t) => {
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  t.after(() => releaseFirst?.());

  const registry = new ToolRegistry();
  let dispatches = 0;
  registry.register({
    name: "write_once",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      if (dispatches === 1) await firstMayFinish;
      return { changed: true };
    }
  });
  const context = {
    sessionId: "security-in-flight",
    __turnId: "turn-in-flight"
  };

  const first = registry.invoke("write_once", { value: "same" }, context);
  const firstSettled = first.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );
  const started = await waitForValue(() => dispatches === 1);
  assert.equal(started, true, "the first handler reached its asynchronous boundary");

  registry.clearFailureScope(context);
  let duplicate;
  let duplicateError;
  try {
    duplicate = await registry.invoke(
      "write_once",
      { value: "same" },
      context
    );
  } catch (error) {
    duplicateError = error;
  } finally {
    releaseFirst();
  }
  const completed = await firstSettled;
  if (duplicateError) throw duplicateError;
  if (completed.error) throw completed.error;

  assert.equal(completed.value.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.outcome.status, "blocked");
  assert.equal(duplicate.outcome.code, "duplicate_in_flight");
  assert.equal(dispatches, 1, "scope cleanup did not release a live operation");
});

test("a provider timeout cannot release the same session operation in a new turn", async () => {
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const registry = new ToolRegistry();
  let dispatches = 0;
  registry.register({
    name: "write_once",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      if (dispatches === 1) await firstMayFinish;
      return { changed: true };
    }
  });
  const firstContext = {
    sessionId: "security-cross-turn",
    __turnId: "turn-one"
  };
  const first = registry.invoke("write_once", { value: "same" }, firstContext);
  await waitForValue(() => dispatches === 1);
  registry.clearFailureScope(firstContext);

  const second = await registry.invoke("write_once", { value: "same" }, {
    sessionId: "security-cross-turn",
    __turnId: "turn-two"
  });
  releaseFirst();
  const completed = await first;

  assert.equal(completed.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.outcome.code, "duplicate_in_flight");
  assert.equal(dispatches, 1);
});

test("a post-dispatch handler failure retains its checkpoint receipt", async () => {
  const registry = new ToolRegistry();
  registry.bindCheckpoints({
    beforeToolCall: async () => ({
      checkpoints: [{ id: "cp_partial_mutation" }]
    })
  });
  let dispatches = 0;
  registry.register({
    name: "mutate_then_fail",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      throw new Error("mutation failed after dispatch");
    }
  });

  const result = await registry.invoke(
    "mutate_then_fail",
    { path: "target.txt" },
    {
      sessionId: "security-checkpoint",
      __turnId: "turn-checkpoint"
    }
  );

  assert.equal(dispatches, 1);
  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "failed");
  assert.deepEqual(result.outcome.evidence, [
    "checkpoint:cp_partial_mutation"
  ]);
});

test("hostile or non-JSON handler outputs fail bounded without executing accessors", async () => {
  let getterCalls = 0;
  const cases = [
    {
      name: "accessor_result",
      create() {
        const value = { changed: true };
        Object.defineProperty(value, "payload", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "must-not-run";
          }
        });
        return value;
      }
    },
    {
      name: "cyclic_result",
      create() {
        const value = { changed: true };
        value.self = value;
        return value;
      }
    },
    {
      name: "bigint_result",
      create() {
        return { changed: true, value: 1n };
      }
    }
  ];

  for (const fixture of cases) {
    const registry = new ToolRegistry();
    registry.bindCheckpoints({
      beforeToolCall: async () => ({
        checkpoints: [{ id: `cp_${fixture.name}` }]
      })
    });
    registry.register({
      name: fixture.name,
      sideEffects: true,
      capability: { idempotent: false },
      handler: async () => fixture.create()
    });

    const result = await registry.invoke(
      fixture.name,
      {},
      {
        sessionId: "security-hostile-output",
        __turnId: `turn-${fixture.name}`
      }
    );

    assert.equal(result.ok, false, `${fixture.name} did not remain a success`);
    assert.equal(result.outcome.status, "failed");
    assert.equal(result.outcome.retryable, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0 && result.error.length <= 800);
    assert.deepEqual(result.outcome.evidence, [
      `checkpoint:cp_${fixture.name}`
    ]);
  }

  assert.equal(getterCalls, 0, "result validation never evaluated an accessor");
});

test("hostile thrown values cannot execute metadata accessors", async () => {
  const registry = new ToolRegistry();
  let getterCalls = 0;
  const hostile = {};
  for (const key of ["message", "code", "retryable"]) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile error getter executed");
      }
    });
  }
  registry.register({
    name: "throw_hostile",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      throw hostile;
    }
  });

  const result = await registry.invoke("throw_hostile", {}, {
    sessionId: "security-hostile-throw",
    __turnId: "turn-hostile-throw"
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "handler_error");
  assert.equal(result.outcome.retryable, false);
  assert.equal(getterCalls, 0);
});

test("hostile forwarding and hook errors cannot execute message accessors", async () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("hostile callback getter executed");
    }
  });
  const forwarding = new ToolRegistry();
  forwarding.register({
    name: "forward_hostile",
    sideEffects: false,
    forwardInvocation() {
      throw hostile;
    },
    handler: async () => ({ unreachable: true })
  });
  const forwarded = await forwarding.invoke("forward_hostile", {}, {});
  assert.equal(forwarded.ok, false);
  assert.equal(forwarded.outcome.code, "forwarding_error");

  let dispatches = 0;
  const hooks = {
    async beforeToolCall() {
      throw hostile;
    },
    notify() {}
  };
  const registry = new ToolRegistry({ hooks });
  registry.register({
    name: "read_after_hook",
    sideEffects: false,
    handler: async () => {
      dispatches += 1;
      return { value: "ok" };
    }
  });
  const previousWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await registry.invoke("read_after_hook", {}, {});
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(result.ok, true);
  assert.equal(dispatches, 1);
  assert.equal(getterCalls, 0);
});

test("side-effecting calls fail closed on arguments that cannot be fingerprinted", async () => {
  const registry = new ToolRegistry();
  let dispatches = 0;
  let getterCalls = 0;
  registry.register({
    name: "write_once",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      return { changed: true };
    }
  });
  const args = {};
  Object.defineProperty(args, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    }
  });

  const result = await registry.invoke("write_once", args, {
    sessionId: "security-unsafe-args",
    __turnId: "turn-unsafe-args"
  });

  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "blocked");
  assert.equal(result.outcome.code, "invalid_tool_arguments");
  assert.equal(dispatches, 0);
  assert.equal(getterCalls, 0);
});

test("a literal blocked handler status remains an outer blocked outcome", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "policy_result",
    sideEffects: false,
    handler: async () => ({
      status: "blocked",
      code: "policy_blocked",
      changed: false
    })
  });

  const result = await registry.invoke(
    "policy_result",
    {},
    {
      sessionId: "security-blocked-status",
      __turnId: "turn-blocked-status"
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "blocked");
  assert.equal(result.outcome.code, "policy_blocked");
  assert.equal(result.outcome.changed, false);
});

test("duplicate OpenAI function-call ids dispatch and serialize one operation", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  const requests = [];
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "response-duplicate-calls",
        output: [
          {
            type: "function_call",
            call_id: "call-duplicate",
            name: "write_once",
            arguments: "{\"value\":\"same\"}"
          },
          {
            type: "function_call",
            call_id: "call-duplicate",
            name: "write_once",
            arguments: "{\"value\":\"same\"}"
          },
          {
            type: "function_call",
            call_id: "call-duplicate",
            name: "write_once",
            arguments: "{\"value\":\"conflict\"}"
          },
          {
            type: "function_call",
            call_id: "",
            name: "write_once",
            arguments: "{\"value\":\"blank\"}"
          },
          {
            type: "function_call",
            call_id: "x".repeat(241),
            name: "write_once",
            arguments: "{\"value\":\"overlong\"}"
          },
          {
            type: "function_call",
            call_id: 17,
            name: "write_once",
            arguments: "{\"value\":\"non-string\"}"
          }
        ]
      };
    }
    return {
      id: "response-after-call",
      output_text: "done",
      output: []
    };
  };

  const registry = new ToolRegistry();
  let dispatches = 0;
  registry.register({
    name: "write_once",
    description: "Perform one non-idempotent write.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" }
      },
      required: ["value"],
      additionalProperties: false
    },
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      return { changed: true };
    }
  });

  const result = await provider.generate({
    input: "write once",
    instructions: "Use the available tool.",
    agent: { id: "main", name: "Main Agent" },
    tools: registry.toOpenAITools(),
    toolRegistry: registry,
    context: {
      sessionId: "security-duplicate-call-id",
      __turnId: "turn-duplicate-call-id"
    }
  });

  const secondInput = requests[1].input;
  assert.equal(result.stopReason, "completed");
  assert.equal(dispatches, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(
    secondInput.filter((item) => (
      item.type === "function_call"
      && item.call_id === "call-duplicate"
    )).length,
    1
  );
  assert.match(
    secondInput.find((item) => item.role === "user" && String(item.content).includes("[tool-protocol]")).content,
    /tool_call_id_conflict/u
  );
  assert.match(
    secondInput.find((item) => item.role === "user" && String(item.content).includes("[tool-protocol]")).content,
    /invalid_tool_call_identity/u
  );
  assert.equal(
    secondInput.filter((item) => (
      item.type === "function_call_output"
      && item.call_id === "call-duplicate"
    )).length,
    1
  );
});

test("duplicate Anthropic tool-use ids dispatch and serialize one operation", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 2,
    stallTimeoutMs: 0
  });
  const requests = [];
  provider.postMessages = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "use-duplicate", name: "write_once", input: { value: "same" } },
          { type: "tool_use", id: "use-duplicate", name: "write_once", input: { value: "same" } },
          { type: "tool_use", id: "use-duplicate", name: "write_once", input: { value: "conflict" } },
          { type: "tool_use", id: "", name: "write_once", input: { value: "blank" } },
          { type: "tool_use", id: 17, name: "write_once", input: { value: "non-string" } }
        ]
      };
    }
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  const registry = new ToolRegistry();
  let dispatches = 0;
  let observedContext = null;
  registry.register({
    name: "write_once",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async (_args, context) => {
      dispatches += 1;
      observedContext = context;
      return { changed: true };
    }
  });

  const result = await provider.generate({
    input: "write once",
    instructions: "Use the available tool.",
    agent: { id: "main", name: "Main Agent" },
    tools: registry.toAnthropicTools(),
    toolRegistry: registry,
    context: {
      sessionId: "security-anthropic-duplicate",
      __turnId: "turn-anthropic-duplicate"
    }
  });

  const blocks = requests[1].messages.flatMap((message) => (
    Array.isArray(message.content) ? message.content : []
  ));
  const assistantMessages = requests[1].messages.filter((message) => message.role === "assistant");
  const resultMessage = requests[1].messages.find((message) => (
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_result")
  ));
  assert.equal(result.stopReason, "completed");
  assert.equal(dispatches, 1);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(blocks.filter((block) => block.type === "tool_use").length, 1);
  assert.equal(blocks.filter((block) => block.type === "tool_result").length, 1);
  assert.ok(assistantMessages.every((message) => message.content.length > 0));
  assert.equal(resultMessage.content[0].type, "tool_result");
  assert.equal(resultMessage.content.at(-1).type, "text");
  assert.match(resultMessage.content.at(-1).text, /tool_call_id_conflict/u);
  assert.match(resultMessage.content.at(-1).text, /invalid_tool_call_identity/u);
  assert.equal(observedContext.__providerToolCallId, "use-duplicate");
  assert.match(observedContext.__idempotencyKey, /^provider_call_[a-f0-9]{32}$/u);
  assert.match(observedContext.__operationReceipt, /^operation_/u);
});

test("cross-hop Anthropic call-id conflicts are surfaced without redispatch", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 3,
    stallTimeoutMs: 0
  });
  const requests = [];
  provider.postMessages = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "use-cross-hop",
          name: "write_once",
          input: { value: "first" }
        }]
      };
    }
    if (requests.length === 2) {
      return {
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "use-cross-hop",
          name: "write_once",
          input: { value: "changed" }
        }]
      };
    }
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }]
    };
  };
  let dispatches = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "write_once",
    sideEffects: true,
    capability: { idempotent: false },
    handler: async () => {
      dispatches += 1;
      return { changed: true };
    }
  });

  await provider.generate({
    input: "write once",
    instructions: "Use the tool.",
    agent: { id: "main", name: "Main Agent" },
    tools: registry.toAnthropicTools(),
    toolRegistry: registry,
    context: {
      sessionId: "security-anthropic-cross-hop",
      __turnId: "turn-anthropic-cross-hop"
    }
  });

  assert.equal(dispatches, 1);
  const thirdMessages = requests[2].messages;
  assert.ok(thirdMessages.every((message) => (
    !Array.isArray(message.content) || message.content.length > 0
  )));
  const notice = thirdMessages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => (
      block.type === "text"
      && block.text.includes("tool_call_id_conflict")
    ));
  assert.match(notice.text, /tool_call_id_conflict/u);
});

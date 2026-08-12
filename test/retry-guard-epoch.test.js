import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_ERROR_CLASSIFIER_KILL_SWITCH,
  classifyToolFailure
} from "../src/error-classifier.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

function codedError(code, message, { retryable = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function registerTool(registry, name, handler, { idempotent = true } = {}) {
  registry.register({
    name,
    description: name + " fixture",
    parameters: {
      type: "object",
      properties: {
        step: { type: "integer" }
      },
      additionalProperties: false
    },
    sideEffects: false,
    capability: { idempotent },
    handler
  });
}

function context(sessionId, turnId) {
  return { sessionId, __turnId: turnId };
}

function registerProgressTool(registry) {
  registerTool(registry, "other", ({ step = 0 }) => ({ step, advanced: true }));
}

test("transient failure executes again after an unrelated success", async () => {
  const registry = new ToolRegistry();
  let failMode = true;
  let calls = 0;
  registerTool(registry, "flaky", () => {
    calls += 1;
    if (failMode) {
      throw codedError(
        "MUTATION_LEASE_CONFLICT",
        "Mutation conflicts with another active invocation.",
        { retryable: true }
      );
    }
    return { recovered: true };
  });
  registerProgressTool(registry);
  const turn = context("session-repro", "turn-repro");

  assert.equal((await registry.invoke("flaky", {}, turn)).ok, false);
  assert.equal((await registry.invoke("flaky", {}, turn)).ok, false);
  assert.equal(calls, 2);
  assert.equal((await registry.invoke("other", { step: 1 }, turn)).ok, true);
  failMode = false;

  const recovered = await registry.invoke("flaky", {}, turn);
  assert.equal(recovered.ok, true);
  assert.equal(calls, 3, "the stale failure entry must not skip the handler");
});

test("identical failure without intervening success remains blocked", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "flaky", () => {
    calls += 1;
    throw codedError("ETIMEDOUT", "temporary operation timeout", {
      retryable: true
    });
  });
  const turn = context("session-spin", "turn-spin");

  await registry.invoke("flaky", {}, turn);
  await registry.invoke("flaky", {}, turn);
  const blocked = await registry.invoke("flaky", {}, turn);

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(calls, 2, "anti-spin must still suppress the third dispatch");
});

test("permanent failure stays blocked after an unrelated success", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "missing_file", () => {
    calls += 1;
    throw codedError("ENOENT", "No such file or directory");
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-permanent", "turn-permanent");

  await registry.invoke("missing_file", {}, turn);
  await registry.invoke("other", { step: 1 }, turn);
  const blocked = await registry.invoke("missing_file", {}, turn);

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(calls, 1);
});

test("model failure stays blocked and carries corrective next steps", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "bad_model_call", () => {
    calls += 1;
    throw codedError(
      "INVALID_ARGUMENTS",
      "Invalid arguments: path must be a non-empty string"
    );
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-model", "turn-model");

  const first = await registry.invoke("bad_model_call", {}, turn);
  assert.ok(first.outcome.nextSteps.length > 0);
  assert.match(first.outcome.nextSteps.join(" "), /argument|input/i);
  await registry.invoke("other", { step: 1 }, turn);
  const blocked = await registry.invoke("bad_model_call", {}, turn);

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.ok(blocked.outcome.nextSteps.length > 0);
  assert.equal(calls, 1);
});

test("lease-held transient failure is epoch-unblocked", async () => {
  const registry = new ToolRegistry();
  let failMode = true;
  let calls = 0;
  registerTool(registry, "leased", () => {
    calls += 1;
    if (failMode) {
      throw codedError(
        "MUTATION_LEASE_CONFLICT",
        "Workspace lease is held by another invocation"
      );
    }
    return { acquired: true };
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-lease", "turn-lease");

  await registry.invoke("leased", {}, turn);
  await registry.invoke("other", { step: 1 }, turn);
  failMode = false;
  const acquired = await registry.invoke("leased", {}, turn);

  assert.equal(acquired.ok, true);
  assert.equal(calls, 2);
});

test("resource failure is epoch-unblocked and visibly actionable", async () => {
  const registry = new ToolRegistry();
  let failMode = true;
  let calls = 0;
  registerTool(registry, "disk_limited", () => {
    calls += 1;
    if (failMode) throw codedError("ENOSPC", "no space left on device");
    return { stored: true };
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-resource", "turn-resource");

  const first = await registry.invoke("disk_limited", {}, turn);
  assert.match(first.outcome.nextSteps.join(" "), /resource|reduce/i);
  await registry.invoke("other", { step: 1 }, turn);
  failMode = false;
  const recovered = await registry.invoke("disk_limited", {}, turn);

  assert.equal(recovered.ok, true);
  assert.equal(calls, 2);
});

test("five epoch unblocks is the per-fingerprint hard ceiling", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "always_busy", () => {
    calls += 1;
    throw codedError("EBUSY", "Resource is temporarily busy");
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-ceiling", "turn-ceiling");

  await registry.invoke("always_busy", {}, turn);
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    await registry.invoke("other", { step: cycle }, turn);
    const failed = await registry.invoke("always_busy", {}, turn);
    assert.notEqual(failed.outcome.code, "repeated_failure");
  }
  assert.equal(calls, 6);

  await registry.invoke("other", { step: 6 }, turn);
  const blocked = await registry.invoke("always_busy", {}, turn);
  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(calls, 6, "a sixth epoch unblock must never dispatch");
});

test("a new turn starts with a fresh failure scope", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "turn_local", () => {
    calls += 1;
    throw codedError("EBUSY", "busy");
  }, { idempotent: false });
  const firstTurn = context("session-turns", "turn-one");
  const secondTurn = context("session-turns", "turn-two");

  await registry.invoke("turn_local", {}, firstTurn);
  assert.equal(
    (await registry.invoke("turn_local", {}, firstTurn)).outcome.code,
    "repeated_failure"
  );
  assert.notEqual(
    (await registry.invoke("turn_local", {}, secondTurn)).outcome.code,
    "repeated_failure"
  );
  assert.equal(calls, 2);
});

test("two sessions never share a failure epoch", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "session_local", () => {
    calls += 1;
    throw codedError("ETIMEDOUT", "timeout");
  }, { idempotent: false });
  const first = context("session-one", "same-turn-id");
  const second = context("session-two", "same-turn-id");

  await registry.invoke("session_local", {}, first);
  assert.equal(
    (await registry.invoke("session_local", {}, first)).outcome.code,
    "repeated_failure"
  );
  assert.notEqual(
    (await registry.invoke("session_local", {}, second)).outcome.code,
    "repeated_failure"
  );
  assert.equal(calls, 2);
});

test("tool failure classifier covers all four classes and safe unknowns", () => {
  assert.equal(
    classifyToolFailure({
      error: codedError("ECONNRESET", "socket reset")
    }),
    "TRANSIENT"
  );
  assert.equal(
    classifyToolFailure({
      error: codedError("ENOENT", "missing file")
    }),
    "PERMANENT"
  );
  assert.equal(
    classifyToolFailure({
      outcome: { code: "invalid_tool_arguments", retryable: false },
      error: "Arguments do not match the declared schema"
    }),
    "MODEL"
  );
  assert.equal(
    classifyToolFailure({
      error: codedError("ENOSPC", "no space left on device")
    }),
    "RESOURCE"
  );
  assert.equal(classifyToolFailure(), "PERMANENT");
  assert.equal(classifyToolFailure({ error: undefined }), "PERMANENT");
});

test("classifier handles HTTP classes, explicit retryability, and kill switch", () => {
  assert.equal(classifyToolFailure({ status: 429 }), "TRANSIENT");
  assert.equal(classifyToolFailure({ status: 503 }), "TRANSIENT");
  assert.equal(classifyToolFailure({ status: 404 }), "PERMANENT");
  assert.equal(
    classifyToolFailure({ outcome: { retryable: true } }),
    "TRANSIENT"
  );
  assert.equal(
    classifyToolFailure({
      error: codedError("ENOENT", "missing but explicitly retryable", {
        retryable: true
      })
    }),
    "TRANSIENT"
  );
  assert.equal(
    classifyToolFailure({
      error: codedError("EBUSY", "busy"),
      env: { [TOOL_ERROR_CLASSIFIER_KILL_SWITCH]: "0" }
    }),
    null
  );
  assert.equal(
    SETUP_FIELDS.includes(TOOL_ERROR_CLASSIFIER_KILL_SWITCH),
    true
  );
});

test("classifier kill switch preserves the former turn-long retry block", async () => {
  const registry = new ToolRegistry({
    env: { [TOOL_ERROR_CLASSIFIER_KILL_SWITCH]: "0" }
  });
  let calls = 0;
  registerTool(registry, "disabled_classifier", () => {
    calls += 1;
    throw codedError("EBUSY", "temporarily busy");
  }, { idempotent: false });
  registerProgressTool(registry);
  const turn = context("session-kill-switch", "turn-kill-switch");

  await registry.invoke("disabled_classifier", {}, turn);
  await registry.invoke("other", { step: 1 }, turn);
  const blocked = await registry.invoke("disabled_classifier", {}, turn);

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(calls, 1);
});

test("pending outcomes neither bump nor consume failure epochs", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registerTool(registry, "pending_guarded", () => {
    calls += 1;
    throw codedError("EBUSY", "temporarily busy");
  }, { idempotent: false });
  registerTool(registry, "pending_work", () => ({
    status: "pending",
    operationId: "operation_pending"
  }));
  const turn = context("session-pending", "turn-pending");

  await registry.invoke("pending_guarded", {}, turn);
  const pending = await registry.invoke("pending_work", {}, turn);
  assert.equal(pending.outcome.status, "pending");
  const blocked = await registry.invoke("pending_guarded", {}, turn);

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(calls, 1);
});

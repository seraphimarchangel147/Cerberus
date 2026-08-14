import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureSemanticToolEnvelope,
  repeatedFailureEnvelope,
  semanticToolError,
  semanticToolResult,
  toolFailureFingerprint
} from "../src/tool-outcome.js";

const readTool = {
  sideEffects: false,
  capability: { idempotent: true }
};

test("semantic outcomes preserve the legacy result envelope", async () => {
  const result = await semanticToolResult(readTool, { value: 42 }, {}, {}, {
    evidence: ["checkpoint:cp_1"]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { value: 42 });
  assert.deepEqual(result.outcome, {
    status: "succeeded",
    code: "ok",
    retryable: false,
    changed: false,
    artifacts: [],
    evidence: ["checkpoint:cp_1"],
    verification: {
      status: "not_requested",
      summary: null
    },
    nextSteps: []
  });
});

test("legacy gate failures receive an additive blocked outcome", async () => {
  const legacy = {
    ok: false,
    error: "outside the allowed scope",
    blocked: true
  };
  const upgraded = await ensureSemanticToolEnvelope(
    readTool,
    legacy,
    {},
    {},
    { code: "scope_blocked" }
  );

  assert.equal(upgraded.ok, false);
  assert.equal(upgraded.error, legacy.error);
  assert.equal(upgraded.outcome.status, "blocked");
  assert.equal(upgraded.outcome.code, "scope_blocked");
});

test("reported tool failures cannot masquerade as successful mutations", async () => {
  const raw = {
    error: "remote update was rejected",
    code: "remote_rejected",
    retryable: true,
    checkpointId: "checkpoint_123"
  };
  const result = await semanticToolResult({
    sideEffects: true,
    capability: { idempotent: false }
  }, raw, {}, {});

  assert.equal(result.ok, false);
  assert.deepEqual(result.result, raw);
  assert.notEqual(result.result, raw);
  assert.equal(result.error, "remote update was rejected");
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.code, "remote_rejected");
  assert.equal(result.outcome.retryable, false);
  assert.deepEqual(result.outcome.evidence, ["checkpoint:checkpoint_123"]);
});

test("business-domain task and draft statuses do not impersonate execution state", async () => {
  const domainTool = {
    ...readTool,
    domainResultStatuses: [
      "pending",
      "blocked",
      "cancelled"
    ]
  };
  for (const raw of [
    { id: "task_1", title: "Waiting", status: "pending" },
    { id: "task_2", title: "Dependency", status: "blocked" },
    { id: "task_3", title: "Dropped", status: "cancelled" },
    { draftId: "draft_1", status: "pending", note: "Saved for review." }
  ]) {
    const result = await semanticToolResult(domainTool, raw, {}, {});
    assert.equal(result.ok, true, JSON.stringify(raw));
    assert.equal(result.outcome.status, "succeeded");
  }
});

test("failure statuses remain failures even when providers attach extra fields", async () => {
  for (const raw of [
    { status: "failed", details: { reason: "remote rejected" }, changed: false },
    { status: "blocked", reason: "policy veto", changed: false },
    { status: "cancelled", requestId: "request_1", changed: false }
  ]) {
    const result = await semanticToolResult(readTool, raw, {}, {});
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.ok(["failed", "blocked"].includes(result.outcome.status));
  }
});

test("only an explicitly idempotent tool can expose a retryable failure", async () => {
  const normalizeOutcome = () => ({
    status: "failed",
    code: "transient",
    retryable: true,
    nextSteps: ["Retry after backoff."]
  });
  const idempotent = await semanticToolResult({
    sideEffects: true,
    capability: { idempotent: true },
    normalizeOutcome
  }, { success: false }, {}, {});
  const nonIdempotent = await semanticToolResult({
    sideEffects: true,
    capability: { idempotent: false },
    normalizeOutcome
  }, { success: false }, {}, {});

  assert.equal(idempotent.outcome.retryable, true);
  assert.equal(nonIdempotent.outcome.retryable, false);
});

test("explicit verification can attach evidence or fail a tentative success", async () => {
  const passed = await semanticToolResult({
    ...readTool,
    verifyOutcome: async () => ({
      passed: true,
      summary: "Observed the expected revision.",
      evidence: ["revision:7"]
    })
  }, { artifactId: "report_7" }, {}, {});
  const failed = await semanticToolResult({
    ...readTool,
    verifyOutcome: () => ({
      passed: false,
      code: "revision_mismatch",
      summary: "Expected revision was not observed."
    })
  }, { value: 7 }, {}, {});

  assert.equal(passed.ok, true);
  assert.deepEqual(passed.outcome.artifacts, ["artifact:report_7"]);
  assert.deepEqual(passed.outcome.evidence, ["revision:7"]);
  assert.equal(passed.outcome.verification.status, "passed");
  assert.equal(failed.ok, false);
  assert.equal(failed.outcome.status, "failed");
  assert.equal(failed.outcome.code, "revision_mismatch");
  assert.equal(failed.outcome.verification.status, "failed");
});

test("normalizer and verifier failures become bounded semantic failures", async () => {
  const normalizer = await semanticToolResult({
    ...readTool,
    normalizeOutcome: () => "invalid"
  }, { value: 1 }, {}, {});
  const verifier = await semanticToolResult({
    ...readTool,
    verifyOutcome: () => {
      throw new Error("verification crashed");
    }
  }, { value: 1 }, {}, {});

  assert.equal(normalizer.ok, false);
  assert.equal(normalizer.outcome.code, "outcome_normalizer_error");
  assert.equal(verifier.ok, false);
  assert.equal(verifier.outcome.code, "verification_error");
});

test("normalizers cannot upgrade failures or forge verifier evidence", async () => {
  const result = await semanticToolResult({
    ...readTool,
    normalizeOutcome: () => ({
      status: "succeeded",
      code: "forged_success",
      verification: {
        status: "passed",
        summary: "not actually checked"
      }
    })
  }, {
    ok: false,
    error: "remote write failed",
    code: "remote_failed"
  }, {}, {});

  assert.equal(result.ok, false);
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.code, "remote_failed");
  assert.deepEqual(result.outcome.verification, {
    status: "not_requested",
    summary: null
  });
});

test("thrown errors and repeated failures expose repair hints without secrets", () => {
  const failed = semanticToolError(readTool, new Error(
    "request failed with sk-abcdefghijklmnopqrstuvwxyz123456"
  ), {
    code: "network_error",
    retryable: true
  });
  const repeated = repeatedFailureEnvelope(failed, 3);

  assert.equal(failed.outcome.retryable, true);
  assert.doesNotMatch(failed.error, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.equal(repeated.outcome.code, "repeated_failure");
  assert.equal(repeated.outcome.retryable, false);
  assert.equal(repeated.outcome.nextSteps.length, 2);
test("repeated failure guidance for transient classes teaches the auto-clear path", () => {
  const failed = semanticToolError(readTool, new Error(
    "Mutation conflicts with another active invocation."
  ), {
    code: "mutation_lease_conflict",
    retryable: true
  });
  const blocked = repeatedFailureEnvelope(failed, 3, {
    failureClass: "TRANSIENT",
    unblocksRemaining: 4
  });

  assert.equal(blocked.outcome.code, "repeated_failure");
  assert.equal(blocked.outcome.nextSteps.length, 3);
  assert.match(blocked.outcome.nextSteps[0], /do NOT change the arguments/);
  assert.match(blocked.outcome.nextSteps[1], /auto-clears after an intervening success/);
  assert.match(blocked.outcome.nextSteps[2], /budget remaining.*4/);
});

test("repeated failure guidance for exhausted transient budget names the limit", () => {
  const failed = semanticToolError(readTool, new Error("timeout"), {
    code: "network_error",
    retryable: true
  });
  const blocked = repeatedFailureEnvelope(failed, 2, {
    failureClass: "TRANSIENT",
    unblocksRemaining: 0
  });

  assert.match(blocked.outcome.nextSteps[0], /budget.*exhausted/);
  assert.doesNotMatch(blocked.outcome.nextSteps.join(" "), /auto-clears/);
});

test("repeated failure guidance without a failure class keeps the generic steps", () => {
  const failed = semanticToolError(readTool, new Error("validation failed"), {
    code: "validation_error"
  });
  const blocked = repeatedFailureEnvelope(failed, 2);
  const withModelClass = repeatedFailureEnvelope(failed, 2, {
    failureClass: "MODEL",
    unblocksRemaining: 5
  });

  assert.deepEqual(blocked.outcome.nextSteps, [
    "Change the arguments or satisfy the missing prerequisite.",
    "Inspect a different tool or ask the user for the required input."
  ]);
  assert.deepEqual(withModelClass.outcome.nextSteps, blocked.outcome.nextSteps);
});
});

test("failure fingerprints are stable across object key order but not arguments", () => {
  const first = toolFailureFingerprint("write_file", {
    path: "a.txt",
    content: "one"
  });
  const reordered = toolFailureFingerprint("write_file", {
    content: "one",
    path: "a.txt"
  });
  const changed = toolFailureFingerprint("write_file", {
    content: "two",
    path: "a.txt"
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("failure fingerprints distinguish prototype keys without invoking accessors", () => {
  const withPrototypeKey = Object.create(null);
  Object.defineProperty(withPrototypeKey, "__proto__", {
    value: { changed: true },
    enumerable: true
  });
  const withoutPrototypeKey = Object.create(null);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    }
  });

  assert.notEqual(
    toolFailureFingerprint("fixture", withPrototypeKey),
    toolFailureFingerprint("fixture", withoutPrototypeKey)
  );
  assert.throws(
    () => toolFailureFingerprint("fixture", accessor),
    /must not contain accessors/u
  );
  assert.equal(getterCalls, 0);
});

test("sparse arrays are rejected before materializing beyond structural bounds", async () => {
  const sparse = new Array(50000);
  assert.throws(
    () => toolFailureFingerprint("fixture", { sparse }),
    /array exceeds the failure-fingerprint bound/u
  );
  const result = await semanticToolResult(readTool, { sparse }, {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "tool_result_not_serializable");
});

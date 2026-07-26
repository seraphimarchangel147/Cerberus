import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicProvider,
  DeterministicModelProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import {
  assessCompletionEvidence,
  assistantClaimsCompletion,
  completionEvidenceDecision,
  createCompletionContract
} from "../src/completion-evidence.js";
import { ToolRegistry } from "../src/tool-registry.js";

const agent = { id: "main", name: "Main Agent" };

function successfulOutcome({ changed, verification = "not_requested" } = {}) {
  return {
    ok: true,
    result: { ok: true, status: "passed" },
    outcome: {
      status: "succeeded",
      code: "ok",
      retryable: false,
      changed: changed ?? false,
      artifacts: [],
      evidence: [],
      verification: { status: verification, summary: null },
      nextSteps: []
    }
  };
}

function completionRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "code_write",
    description: "Fixture mutation.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    },
    handler: ({ path }) => ({ path, changed: true })
  });
  registry.register({
    name: "code_verify",
    description: "Fixture verification.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: () => ({ ok: true, status: "passed", results: [{ ok: true }] })
  });
  registry.register({
    name: "qa_run",
    description: "Fixture visual verification.",
    sideEffects: true,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler: () => ({ ok: true, status: "passed" })
  });
  return registry;
}

test("completion contracts distinguish explanation, verification, code, and UI work", () => {
  assert.equal(createCompletionContract("Explain how this provider works."), null);
  assert.equal(createCompletionContract("Review the current implementation."), null);
  assert.equal(createCompletionContract("Check tomorrow's weather."), null);
  assert.deepEqual(
    createCompletionContract("Run the tests and verify this branch."),
    {
      version: 1,
      kind: "verification",
      requirements: ["verification"],
      maxNudges: 1
    }
  );
  assert.deepEqual(
    createCompletionContract("Implement a new API endpoint."),
    {
      version: 1,
      kind: "code-change",
      requirements: ["mutation", "verification"],
      maxNudges: 1
    }
  );
  assert.deepEqual(
    createCompletionContract("Fix every dashboard button."),
    {
      version: 1,
      kind: "ui-change",
      requirements: ["mutation", "verification", "visual"],
      maxNudges: 1
    }
  );
  assert.deepEqual(
    createCompletionContract("Test every dashboard button."),
    {
      version: 1,
      kind: "ui-verification",
      requirements: ["verification", "visual"],
      maxNudges: 1
    }
  );
  assert.equal(
    createCompletionContract("\u0456mplement a new API endpoint."),
    null,
    "a Cyrillic lookalike must not activate an ASCII intent contract"
  );
});

test("only successful semantic mutation, verification, and QA receipts satisfy a contract", () => {
  const registry = completionRegistry();
  const contract = createCompletionContract("Fix the dashboard button.");
  const failedMutation = {
    name: "code_write",
    result: {
      ok: false,
      error: "write failed",
      outcome: {
        status: "failed",
        changed: null,
        verification: { status: "not_requested" }
      }
    }
  };
  const mutation = {
    name: "code_write",
    result: successfulOutcome({ changed: true })
  };
  const verification = {
    name: "code_verify",
    result: successfulOutcome({ verification: "passed" })
  };
  const visual = {
    name: "qa_run",
    result: successfulOutcome({ changed: true })
  };
  const unrelatedMutation = {
    name: "remember",
    result: successfulOutcome({ changed: true })
  };

  const missing = assessCompletionEvidence(
    contract,
    [failedMutation, unrelatedMutation, verification],
    registry
  );
  assert.equal(missing.status, "incomplete");
  assert.deepEqual(missing.missing, ["mutation", "visual"]);
  assert.equal(missing.mutationCount, 0);
  assert.equal(missing.verificationCount, 1);

  const complete = assessCompletionEvidence(
    contract,
    [mutation, verification, visual],
    registry
  );
  assert.equal(complete.status, "verified");
  assert.deepEqual(complete.missing, []);
  assert.equal(complete.mutationCount, 1);
  assert.equal(complete.verificationCount, 2);
  assert.equal(complete.visualCount, 1);
});

test("completion claims receive at most one evidence retry", () => {
  const contract = createCompletionContract("Implement the API route.");
  assert.equal(assistantClaimsCompletion("Implemented and all green."), true);
  assert.equal(assistantClaimsCompletion("I added the route."), true);
  assert.equal(assistantClaimsCompletion("I could not implement it."), false);
  assert.equal(assistantClaimsCompletion("No files were changed."), false);

  const first = completionEvidenceDecision({
    contract,
    assistantText: "Done.",
    nudges: 0,
    canContinue: true
  });
  assert.equal(first.continue, true);
  const second = completionEvidenceDecision({
    contract,
    assistantText: "Done.",
    nudges: 1,
    canContinue: true
  });
  assert.equal(second.continue, false);
  assert.equal(second.report.status, "incomplete");
});

test("the deterministic fallback cannot report actionable work as complete", async () => {
  const provider = new DeterministicModelProvider();
  const result = await provider.generate({
    input: "Implement the API route.",
    agent,
    context: {
      __completionContract: createCompletionContract("Implement the API route.")
    }
  });
  assert.equal(result.stopReason, "evidence-incomplete");
  assert.equal(result.completionEvidence.status, "incomplete");
  assert.match(result.text, /Completion evidence: incomplete/u);
});

test("OpenAI retries an unsupported completion claim and accepts matching tool evidence", async () => {
  const registry = completionRegistry();
  const requests = [];
  const events = [];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 4,
    stallTimeoutMs: 0
  });
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "unsupported",
        status: "completed",
        output_text: "Implemented and verified.",
        output: []
      };
    }
    if (requests.length === 2) {
      return {
        id: "evidence",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "write-1",
            name: "code_write",
            arguments: JSON.stringify({ path: "fixture.js" })
          },
          {
            type: "function_call",
            call_id: "verify-1",
            name: "code_verify",
            arguments: "{}"
          }
        ]
      };
    }
    return {
      id: "supported",
      status: "completed",
      output_text: "Implemented and verified with passing checks.",
      output: []
    };
  };

  const result = await provider.generate({
    input: "Implement the API route.",
    instructions: "Use project tools.",
    tools: registry.toOpenAITools(),
    toolRegistry: registry,
    context: {
      sessionId: "completion-openai",
      __completionContract: createCompletionContract("Implement the API route."),
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[1].input), /completion-evidence/u);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.completionEvidence.status, "verified");
  assert.equal(result.completionEvidence.nudges, 1);
  assert.equal(result.completionEvidence.mutationCount, 1);
  assert.equal(result.completionEvidence.verificationCount, 1);
  assert.deepEqual(result.toolCalls.map((call) => call.name), [
    "code_write",
    "code_verify"
  ]);
  assert.deepEqual(
    events
      .filter((event) => event.phase === "completion-evidence")
      .map((event) => event.status),
    ["retry", "verified"]
  );
});

test("Anthropic labels a repeated unsupported claim incomplete without looping", async () => {
  const requests = [];
  const events = [];
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    maxIterations: 4,
    stallTimeoutMs: 0
  });
  provider.postMessages = async (body) => {
    requests.push(structuredClone(body));
    return {
      id: `unsupported-${requests.length}`,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done and verified." }]
    };
  };

  const result = await provider.generate({
    input: "Implement the API route.",
    instructions: "Use project tools.",
    context: {
      sessionId: "completion-anthropic",
      __completionContract: createCompletionContract("Implement the API route."),
      __onToolEvent: (event) => events.push(event)
    }
  });

  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /completion-evidence/u);
  assert.equal(result.stopReason, "evidence-incomplete");
  assert.equal(result.completionEvidence.status, "incomplete");
  assert.equal(result.completionEvidence.nudges, 1);
  assert.match(result.text, /Completion evidence: incomplete/u);
  assert.deepEqual(
    events
      .filter((event) => event.phase === "completion-evidence")
      .map((event) => event.status),
    ["retry", "incomplete"]
  );
});

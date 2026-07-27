import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { OutcomeStore } from "../src/outcome-store.js";
import { ScrutinyFitter } from "../src/scrutiny-fitter.js";
import {
  SelfOptimizationController,
  applyDelta,
  createOptionalSelfOptimizationController,
  deterministicFailureSignature,
  evidenceBackedReward,
  gradedTestScore,
  selectStrictImprovement,
  selfOptimizationEnabled,
  surfaceHash
} from "../src/self-optimization.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { ToolRegistry } from "../src/tool-registry.js";

const DEFAULT_WEIGHTS = Object.freeze({
  environment: 0.28,
  company: 0.26,
  evidence: 0.24,
  memory: 0.12,
  uncertainty: 0.1
});

function temporaryDirectory(prefix = "openagi-self-opt-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function completionEvidence(overrides = {}) {
  return {
    version: 1,
    required: true,
    kind: "code-change",
    status: "incomplete",
    missing: ["verification"],
    mutationCount: 1,
    verificationCount: 0,
    visualCount: 0,
    nudges: 1,
    ...overrides
  };
}

function scrutinyDimensions(value = 0.5) {
  return {
    environment: value,
    company: value,
    evidence: value,
    memory: value,
    uncertainty: value
  };
}

function scrutinyRuntime({ optimizer = new SelfOptimizationController(), outcomes = [] } = {}) {
  return {
    selfOptimization: optimizer,
    scrutiny: {
      judges: {
        cautious: { weights: { ...DEFAULT_WEIGHTS } },
        pragmatic: { weights: { ...DEFAULT_WEIGHTS } }
      }
    },
    outcomes: {
      recent: () => outcomes
    }
  };
}

test("self-optimization is exact opt-in and setup-wizard persistable", () => {
  for (const value of [undefined, "", "0", "true", "on", "yes", "2"]) {
    assert.equal(selfOptimizationEnabled({ OPENAGI_SELF_OPTIMIZATION: value }), false);
  }
  assert.equal(selfOptimizationEnabled({ OPENAGI_SELF_OPTIMIZATION: "1" }), true);
  assert.equal(createOptionalSelfOptimizationController({
    env: { OPENAGI_SELF_OPTIMIZATION: "0" }
  }), null);
  assert.ok(createOptionalSelfOptimizationController({
    env: { OPENAGI_SELF_OPTIMIZATION: "1" }
  }) instanceof SelfOptimizationController);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_SELF_OPTIMIZATION"));
});

test("surface hashes are canonical, bounded, and never invoke accessors", () => {
  const left = { beta: [2, 3], alpha: { value: 1 } };
  const right = { alpha: { value: 1 }, beta: [2, 3] };
  assert.equal(surfaceHash(left), surfaceHash(right));
  assert.notEqual(surfaceHash(left), surfaceHash({
    alpha: { value: 2 },
    beta: [2, 3]
  }));

  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "leaked";
    }
  });
  assert.throws(
    () => surfaceHash(hostile),
    (error) => error.code === "self_opt_surface_accessor"
  );
  assert.equal(getterCalls, 0);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => surfaceHash(cyclic),
    (error) => error.code === "self_opt_surface_cycle"
  );
});

test("applyDelta verifies every echoed hash before one atomic commit", () => {
  const state = new Map([
    ["one", { value: 1 }],
    ["two", { value: 2 }]
  ]);
  const resolveSurface = (target) => ({
    id: `ground:${target}`,
    kind: "fixture",
    value: state.get(target)
  });
  let commits = 0;
  const commit = (prepared) => {
    commits += 1;
    for (const entry of prepared) {
      state.set(
        entry.identity.surfaceId.slice("ground:".length),
        entry.nextValue
      );
    }
    return { count: prepared.length };
  };

  assert.throws(
    () => applyDelta({
      deltas: [
        {
          target: "one",
          expectedHash: surfaceHash(state.get("one")),
          value: { value: 10 }
        },
        {
          target: "two",
          expectedHash: "0".repeat(64),
          value: { value: 20 }
        }
      ],
      resolveSurface,
      commit
    }),
    (error) => (
      error.code === "self_opt_hash_mismatch"
      && error.details.identity.surfaceId === "ground:two"
    )
  );
  assert.equal(commits, 0);
  assert.deepEqual(state.get("one"), { value: 1 });
  assert.deepEqual(state.get("two"), { value: 2 });

  const applied = applyDelta({
    deltas: [
      {
        target: "one",
        expectedHash: surfaceHash(state.get("one")),
        value: { value: 10 }
      },
      {
        target: "two",
        expectedHash: surfaceHash(state.get("two")),
        value: { value: 20 }
      }
    ],
    resolveSurface,
    commit
  });
  assert.equal(commits, 1);
  assert.deepEqual(applied.commitResult, { count: 2 });
  assert.deepEqual(
    applied.surfaces.map((surface) => surface.identity),
    [
      { surfaceId: "ground:one", surfaceKind: "fixture" },
      { surfaceId: "ground:two", surfaceKind: "fixture" }
    ]
  );
  assert.deepEqual(state.get("one"), { value: 10 });
  assert.deepEqual(state.get("two"), { value: 20 });
});

test("applyDelta rejects proposer-supplied identity fields", () => {
  const value = { value: 1 };
  assert.throws(
    () => applyDelta({
      deltas: [{
        target: "one",
        expectedHash: surfaceHash(value),
        value: { value: 2 },
        id: "model-chosen-identity"
      }],
      resolveSurface: () => ({ id: "ground:one", kind: "fixture", value }),
      commit: () => assert.fail("commit must not run")
    }),
    (error) => error.code === "self_opt_delta_identity_untrusted"
  );
});

test("evidence rewards make unsupported claims zero and preserve honest partial credit", () => {
  const unsupported = evidenceBackedReward({
    completionEvidence: completionEvidence(),
    assistantText: "Implemented the endpoint.",
    gradedTests: { passed: 4, total: 4 }
  });
  assert.equal(unsupported.score, 0);
  assert.equal(unsupported.verdict, "unsupported_completion_claim");
  assert.match(
    unsupported.failureSignature,
    /^failure-v1:unsupported_completion_claim:[a-f0-9]{20}$/
  );

  const sameFailure = evidenceBackedReward({
    completionEvidence: completionEvidence(),
    assistantText: "Done and fixed.",
    gradedTests: { passed: 4, total: 4 }
  });
  assert.equal(sameFailure.failureSignature, unsupported.failureSignature);

  const honestPartial = evidenceBackedReward({
    completionEvidence: completionEvidence(),
    assistantText: "Verification is still pending; I cannot claim completion."
  });
  assert.equal(honestPartial.score, 0.5);
  assert.equal(honestPartial.verdict, "partial");

  const graded = evidenceBackedReward({
    completionEvidence: completionEvidence({
      status: "verified",
      missing: [],
      verificationCount: 1
    }),
    assistantText: "Verification is complete.",
    gradedTests: { passed: 1, total: 5 }
  });
  assert.equal(gradedTestScore({ passed: 1, total: 5 }), 0.2);
  assert.equal(graded.score, 0.6);
  assert.equal(graded.verdict, "partial");
});

test("failure signatures use structured fields and cluster independently of prose", () => {
  const first = deterministicFailureSignature({
    category: "verification_failure",
    status: "failed",
    code: "test_failed",
    missing: ["verification"],
    tests: { passed: 2, total: 3 }
  });
  const second = deterministicFailureSignature({
    category: "verification_failure",
    status: "failed",
    code: "test_failed",
    missing: ["verification"],
    tests: { passed: 2, total: 3 },
    message: "Model-authored prose is deliberately ignored."
  });
  assert.equal(first, second);

  const controller = new SelfOptimizationController();
  const clusters = controller.failureClusters([
    {
      at: "2026-07-27T01:00:00.000Z",
      metadata: {
        selfOptimization: {
          version: 1,
          score: 0,
          failureSignature: first
        }
      }
    },
    {
      at: "2026-07-27T02:00:00.000Z",
      metadata: {
        selfOptimization: {
          version: 1,
          score: 0.5,
          failureSignature: first
        }
      }
    }
  ]);
  assert.deepEqual(clusters, [{
    signature: first,
    count: 2,
    averageReward: 0.25,
    lastAt: "2026-07-27T02:00:00.000Z"
  }]);
});

test("strict improvement keeps the incumbent on ties and the earliest better successor", () => {
  const incumbent = { id: "incumbent", score: 0.8 };
  assert.equal(
    selectStrictImprovement(incumbent, [
      { id: "equal", score: 0.8 },
      { id: "worse", score: 0.79 }
    ]),
    incumbent
  );
  const firstBetter = { id: "first-better", score: 0.81 };
  assert.equal(
    selectStrictImprovement(incumbent, [
      firstBetter,
      { id: "same-better-score", score: 0.81 },
      { id: "invalid", score: Number.NaN }
    ]),
    firstBetter
  );
});

test("scrutiny fitter consumes free evidence rewards and hash-guards staged deltas", () => {
  const outcomes = [{
    resolved: false,
    qualityScore: null,
    scrutinyDimensions: scrutinyDimensions(),
    metadata: {
      selfOptimization: {
        version: 1,
        score: 0,
        verdict: "unsupported_completion_claim",
        failureSignature: deterministicFailureSignature({
          category: "unsupported_completion_claim",
          status: "incomplete",
          code: "claim_without_evidence",
          missing: ["verification"]
        })
      }
    }
  }];
  const runtime = scrutinyRuntime({ outcomes });
  const dir = temporaryDirectory();
  const fitter = new ScrutinyFitter({
    runtime,
    dir,
    minSamples: 1,
    warmupCycles: 5
  });
  fitter.addJudgeSignal({
    judge: "all",
    deltas: {
      environment: 0.05,
      company: -0.05,
      evidence: 0,
      memory: 0,
      uncertainty: 0
    }
  });
  const fit = fitter.fit();
  assert.equal(fit.sampleCount, 1);
  assert.equal(fit.autoApplied, false);
  assert.match(fit.proposals.cautious.expectedHash, /^[a-f0-9]{64}$/);
  assert.match(fit.proposals.pragmatic.expectedHash, /^[a-f0-9]{64}$/);

  const cautiousBefore = structuredClone(runtime.scrutiny.judges.cautious.weights);
  runtime.scrutiny.judges.pragmatic.weights = {
    ...DEFAULT_WEIGHTS,
    environment: DEFAULT_WEIGHTS.company,
    company: DEFAULT_WEIGHTS.environment
  };
  const pragmaticExternal = structuredClone(runtime.scrutiny.judges.pragmatic.weights);
  assert.throws(
    () => fitter.applyPending(fit.cycle),
    (error) => error.code === "self_opt_hash_mismatch"
  );
  assert.deepEqual(runtime.scrutiny.judges.cautious.weights, cautiousBefore);
  assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, pragmaticExternal);
  assert.equal(fitter.pending.proposals[0].applied, false);
  assert.equal(fs.existsSync(fitter.weightsPath), false);
});

test("scrutiny fitter persists the whole hash-verified set before live application", () => {
  const runtime = scrutinyRuntime({
    outcomes: [{
      resolved: true,
      qualityScore: 0.7,
      scrutinyDimensions: scrutinyDimensions()
    }]
  });
  const dir = temporaryDirectory();
  const fitter = new ScrutinyFitter({
    runtime,
    dir,
    minSamples: 1,
    warmupCycles: 5
  });
  fitter.addJudgeSignal({
    judge: "all",
    deltas: {
      environment: 0.05,
      company: -0.05,
      evidence: 0,
      memory: 0,
      uncertainty: 0
    }
  });
  const fit = fitter.fit();
  const applied = fitter.applyPending(fit.cycle);
  assert.equal(applied.applied, true);
  assert.notDeepEqual(runtime.scrutiny.judges.cautious.weights, DEFAULT_WEIGHTS);
  const saved = JSON.parse(fs.readFileSync(fitter.weightsPath, "utf8"));
  assert.deepEqual(saved.judges.cautious, runtime.scrutiny.judges.cautious.weights);
  assert.deepEqual(saved.judges.pragmatic, runtime.scrutiny.judges.pragmatic.weights);
  const history = fs.readFileSync(fitter.historyPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(history.length, 2);
  assert.ok(history.every((entry) => /^[a-f0-9]{64}$/.test(entry.previousHash)));
  assert.ok(history.every((entry) => /^[a-f0-9]{64}$/.test(entry.nextHash)));
});

test("AgentHost records evidence reward without storing model prose in its signature", async () => {
  const dataDir = temporaryDirectory();
  const outcomes = new OutcomeStore({ dir: path.join(dataDir, "outcomes") });
  const runtime = {
    tools: new ToolRegistry(),
    memory: {
      retrieve: () => [],
      renderSessionMemorySnapshot: () => "",
      remember: () => ({ id: "memory_self_opt" })
    },
    outcomes,
    selfOptimization: new SelfOptimizationController(),
    processSignal: () => ({
      id: "output_self_opt",
      scrutiny: {
        action: "act",
        score: 0.7,
        reasons: ["self optimization fixture"],
        dimensions: {
          ...scrutinyDimensions(),
          novelty: 0.2,
          risk: 0.1,
          repetition: 0.1
        }
      },
      customContext: [],
      propagation: null
    })
  };
  const host = new AgentHost({
    runtime,
    store: new InMemoryAgentStore(),
    modelProvider: {
      provider: "fixture",
      model: "fixture-model",
      isConfigured: () => true,
      generate: async () => ({
        provider: "fixture",
        model: "fixture-model",
        id: "response_self_opt",
        text: "Implemented the requested endpoint.",
        toolCalls: [],
        completionEvidence: completionEvidence(),
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      })
    }
  });
  await host.handleMessage({
    from: "test",
    channel: "local",
    text: "Implement the requested endpoint.",
    backgroundReview: false
  });
  const recorded = outcomes.recent(1)[0];
  assert.equal(recorded.metadata.selfOptimization.score, 0);
  assert.equal(
    recorded.metadata.selfOptimization.verdict,
    "unsupported_completion_claim"
  );
  assert.equal(
    recorded.metadata.selfOptimization.failureSignature.includes("Implemented"),
    false
  );
});

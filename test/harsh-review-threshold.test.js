// G7 / B3 (docs/scope/abi-completion.md:116-127): the weekly harsh review
// must actually raise the scrutiny act threshold (0.68 -> 0.85) for its
// turn, not just carry a skeptical prompt. Chain under test:
// cron job input.scrutinyOverrides -> runAutopilot -> agentHost.handleMessage
// -> messageToSignal -> processSignal -> DirectionalAdaptiveScrutiny.
import assert from "node:assert/strict";
import test from "node:test";
import { AbiRuntime, createDefaultRuntime } from "../src/abi-runtime.js";
import { AgentHost } from "../src/agent-host.js";
import { DirectionalAdaptiveScrutiny } from "../src/directional-adaptive-scrutiny.js";

const runAutopilot = AbiRuntime.prototype.runAutopilot;

test("selectAction: actThresholdOverride flips an act verdict to ask at 0.75", () => {
  const scrutiny = new DirectionalAdaptiveScrutiny(); // pragmatic defaults, act = 0.68
  const base = { score: 0.75, risk: 0.2, novelty: 0.3, propagationPressure: 0, memories: [{ score: 0.8 }], signal: {} };
  assert.equal(scrutiny.selectAction(base), "act");
  assert.equal(scrutiny.selectAction({ ...base, actThresholdOverride: 0.85 }), "ask");
});

// Code-review finding: the propagate branch ran before actThresholdOverride
// was applied, so a high propagationPressure (e.g. the harsh-review prompt's
// own wording tripping requiresSpecialist) bypassed the raised act bar
// entirely — agent-host.js grants "propagate" the identical full-tool-access
// policy as "act", so this silently defeated the whole point of the override.
test("selectAction: actThresholdOverride also gates the propagate branch, not just act", () => {
  const scrutiny = new DirectionalAdaptiveScrutiny();
  const base = { score: 0.5, risk: 0.2, novelty: 0.3, propagationPressure: 0.9, memories: [{ score: 0.8 }], signal: {} };
  // Without an override, high propagationPressure legitimately fires propagate
  // even though score (0.5) sits below the normal act bar (0.68) — this is
  // existing, intentional behavior and must not change.
  assert.equal(scrutiny.selectAction(base), "propagate");
  // With the harsh-review override, a score below the RAISED bar (0.85) must
  // not reach propagate either — it should fall through to "ask", same as
  // the act branch does today.
  assert.equal(scrutiny.selectAction({ ...base, actThresholdOverride: 0.85 }), "ask");
});

test("evaluate: overrides.act raises the bar for the whole verdict", () => {
  const scrutiny = new DirectionalAdaptiveScrutiny();
  // Crafted so the composite score lands between 0.68 and 0.85 (~0.812).
  const signal = {
    urgency: 1, impact: 1, environmentalPressure: 1, externalPressure: 1,
    goalAlignment: 1, policyFit: 1, internalPressure: 1, strategicFit: 1,
    citations: [], specificity: 0.5, confidence: 0.5, conflict: 0,
    ambiguity: 0, risk: 0.2, novelty: 0.3, repetition: 0
  };
  const memories = [{ score: 0.9 }];
  const normal = scrutiny.evaluate({ signal, memories });
  assert.ok(normal.score > 0.68 && normal.score < 0.85, `score ${normal.score} must sit between the default and harsh act thresholds`);
  assert.equal(normal.action, "act");
  const harsh = scrutiny.evaluate({ signal, memories, overrides: { act: 0.85 } });
  assert.equal(harsh.action, "ask");
  assert.equal(harsh.score, normal.score, "override changes the verdict, not the score");
});

// Drift note (C2): messageToSignal is now async and reads this.runtime's
// stores for measured axes, so it is called with a minimal runtime and
// awaited (the plan's original synchronous .call(null, ...) predates C2).
test("messageToSignal attaches scrutinyOverrides to the signal", async () => {
  const signal = await AgentHost.prototype.messageToSignal.call({ runtime: {} }, {
    text: "weekly review", channel: "autopilot", from: "autopilot",
    agent: { id: "main" }, sessionId: "s1", metadata: {},
    scrutinyOverrides: { act: 0.85 }
  });
  assert.deepEqual(signal.scrutinyOverrides, { act: 0.85 });
});

test("processSignal passes signal.scrutinyOverrides into scrutiny.evaluate", () => {
  const seen = [];
  const runtime = createDefaultRuntime({
    scrutiny: {
      evaluate(args) {
        seen.push(args.overrides);
        return { action: "act", score: 0.8, propagationPressure: 0, dimensions: { risk: 0.2, novelty: 0.3, repetition: 0.2 }, reasons: ["stub"] };
      }
    }
  });
  const shape = {
    source: "test", type: "message", domain: "general", taskType: "adaptation-review",
    summary: "s", content: "c", tags: [], risk: 0.2, novelty: 0.3, repetition: 0.2
  };
  runtime.processSignal({ id: "sig_hr", ...shape, scrutinyOverrides: { act: 0.85 } });
  runtime.processSignal({ id: "sig_plain", ...shape });
  assert.deepEqual(seen[0], { act: 0.85 });
  assert.deepEqual(seen[1], {}, "no override degrades to an empty overrides object");
});

test("weekly-harsh-review job registration carries the act override", () => {
  const runtime = createDefaultRuntime();
  const job = runtime.cron.listJobs().find((j) => j.id === "weekly-harsh-review");
  assert.ok(job, "weekly-harsh-review must be registered by default");
  assert.deepEqual(job.input.scrutinyOverrides, { act: 0.85 });
});

test("runAutopilot forwards scrutinyOverrides into handleMessage, with an id-keyed fallback for legacy persisted jobs", async () => {
  const captured = [];
  const self = {
    agentHost: { handleMessage: async (input) => { captured.push(input.scrutinyOverrides); return { reply: "ok" }; } },
    budget: { check() {} },
    tasks: { agentPickNext: () => null }
  };
  await runAutopilot.call(self, { id: "weekly-harsh-review", input: { prompt: "review", scrutinyOverrides: { act: 0.85 } } });
  assert.deepEqual(captured[0], { act: 0.85 });
  // A jobs.json persisted before this feature has no scrutinyOverrides in its
  // saved input (CronScheduler.addJob keeps the existing row) — the runtime
  // falls back by job id so the deployed install still gets the raised bar.
  await runAutopilot.call(self, { id: "weekly-harsh-review", input: { prompt: "review" } });
  assert.deepEqual(captured[1], { act: 0.85 });
  // Ordinary autopilot pulses carry no override.
  await runAutopilot.call(self, { id: "agent-pulse", input: { prompt: "pulse" } });
  assert.equal(captured[2], null);
});

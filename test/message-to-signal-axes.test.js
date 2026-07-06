// C2: messageToSignal carries measured axes (not constants) and derives a
// content-scoped specialist for specialization candidates, so different
// scopes hash to different propagation dedupe signatures — cracking the
// two-specialist collapse (G2). Signature hashes signal.goal, which is why
// messageToSignal sets goal from the derived scope.
import assert from "node:assert/strict";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { PropagationController } from "../src/propagation-controller.js";

// Stub runtime in the style of test/verdict-consequences.test.js makeHost():
// no vectorStore, no outcomes — messageToSignal must tolerate absent stores.
function makeHost() {
  const runtime = {
    memory: { remember: () => ({ id: "m1" }) },
    outcomes: null,
    processSignal: () => { throw new Error("processSignal is not exercised by these tests"); }
  };
  return new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async () => ({ text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] })
    }
  });
}

const AGENT = { id: "main", role: "generalist" };
const BASE = { channel: "local", from: "u", agent: AGENT, sessionId: "s1", metadata: {} };

test("two different messages produce different measured axes, not constants", async () => {
  const host = makeHost();
  const a = await host.messageToSignal({ ...BASE, text: "what did I do yesterday?" });
  const b = await host.messageToSignal({ ...BASE, text: "send invoice 4821 from /Users/me/billing/acme.pdf to the client" });
  assert.notEqual(a.specificity, b.specificity, "specificity must vary with content");
  assert.notEqual(a.risk, b.risk, "risk must vary with content");
  assert.notEqual(a.confidence, b.confidence, "confidence must vary with content");
  assert.ok(b.specificity > a.specificity, "numbers + a file path read as more specific");
  assert.ok(b.risk > a.risk, "naming a side-effecting action (send) elevates risk");
  assert.equal(a.confidence, 0.5, "question lowers confidence by 0.2");
  assert.equal(b.confidence, 0.7, "statement keeps the 0.7 baseline");
});

test("specialization candidates carry scope, metric, and a signature-differentiating goal", async () => {
  const host = makeHost();
  const controller = new PropagationController();
  const workflow = {
    id: "specialization-candidate",
    goal: "Decide whether a repeated or high-risk novel task should become a specialist."
  };

  const invoices = await host.messageToSignal({ ...BASE, text: "automate reconciling stripe invoices" });
  const triage = await host.messageToSignal({ ...BASE, text: "automate triaging github issues" });

  assert.equal(invoices.taskType, "specialization-candidate");
  assert.equal(triage.taskType, "specialization-candidate");
  assert.ok(invoices.specialistScope.includes("stripe"), `scope from content, got "${invoices.specialistScope}"`);
  assert.ok(triage.specialistScope.includes("github"), `scope from content, got "${triage.specialistScope}"`);
  assert.equal(invoices.successMetric, "outcome quality >= 0.6 over next 10 activations");
  assert.notEqual(invoices.specialistScope, triage.specialistScope);
  assert.notEqual(
    controller.signature(invoices, workflow),
    controller.signature(triage, workflow),
    "different scopes must hash to different propagation dedupe signatures"
  );

  const adaptation = await host.messageToSignal({ ...BASE, text: "hello there" });
  assert.equal(adaptation.taskType, "adaptation-review");
  assert.equal(adaptation.specialistScope, undefined, "non-candidates keep default scope fields");
  assert.equal(adaptation.goal, undefined, "non-candidates do not override the workflow goal");
});

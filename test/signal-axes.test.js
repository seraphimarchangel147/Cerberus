// C2: scrutiny axes are measured from the message + runtime stores, not
// hardcoded constants. Every heuristic is deterministic — no LLM, no network
// (stores are stubbed here so no data dir is touched).
import assert from "node:assert/strict";
import test from "node:test";
import {
  contentWords,
  countProperNouns,
  deriveSpecialistScope,
  measureAxes,
  measureSpecificity
} from "../src/signal-axes.js";

test("axis table: measured values move with message content", async () => {
  const cases = [
    { text: "remind me every tuesday to file my report", axis: "repetition", min: 0.8 },
    { text: "send the invoice to the client", axis: "risk", min: 0.6 },
    { text: "cancel the production deploy", axis: "risk", min: 0.9 },
    { text: "is the deploy done yet?", axis: "confidence", max: 0.5 },
    { text: "update src/agent-host.js lines 261-297 per https://example.com/spec", axis: "specificity", min: 0.6 },
    { text: "hello", axis: "specificity", max: 0.4 }
  ];
  for (const { text, axis, min, max } of cases) {
    const axes = await measureAxes({ text });
    if (min !== undefined) assert.ok(axes[axis] >= min, `${axis} of "${text}" should be >= ${min}, got ${axes[axis]}`);
    if (max !== undefined) assert.ok(axes[axis] <= max, `${axis} of "${text}" should be <= ${max}, got ${axes[axis]}`);
  }
});

test("repetition: similar past outcome summaries raise the measured value", async () => {
  const outcomeStore = {
    recent: () => Array.from({ length: 8 }, () => ({ metadata: { signalSummary: "reconcile stripe invoices for acme" } }))
  };
  const withHistory = await measureAxes({ text: "reconcile stripe invoices for acme", outcomeStore });
  const noHistory = await measureAxes({ text: "reconcile stripe invoices for acme" });
  assert.equal(withHistory.repetition, 1, "8 similar priors saturate min(1, count/8)");
  assert.equal(noHistory.repetition, 0.2, "no schedule keyword + no history = floor");
});

test("novelty: drops when the vector store already knows the topic", async () => {
  const known = { search: async () => [{ id: "p1", score: 0.9, text: "standup notes" }] };
  const empty = { search: async () => [] };
  const seen = await measureAxes({ text: "summarize the standup notes", vectorStore: known });
  const fallback = await measureAxes({ text: "summarize the standup notes", vectorStore: empty });
  assert.ok(seen.novelty < 0.2, `known topic should be low novelty, got ${seen.novelty}`);
  assert.equal(fallback.novelty, 0.4, "empty store + no keyword = old keyword fallback");
});

test("novelty: read-only memory overlap fallback never reinforces items", async () => {
  const { MemorySystem } = await import("../src/index.js");
  const memory = new MemorySystem();
  memory.remember({ source: "test", content: "weekly invoice reconciliation for acme", tags: [] });
  const before = [...memory.items.values()].map((i) => i.strength);
  const axes = await measureAxes({ text: "weekly invoice reconciliation for acme", memorySystem: memory });
  const after = [...memory.items.values()].map((i) => i.strength);
  assert.ok(axes.novelty < 0.4, `known topic should read as low novelty, got ${axes.novelty}`);
  assert.deepEqual(after, before, "measurement must not mutate memory strength");
});

test("impact: tracks specificity unless a remember/automate keyword fires", async () => {
  const vague = await measureAxes({ text: "hello there" });
  const specific = await measureAxes({ text: "move 3 files into /Users/me/projects/reports and update budget.json" });
  assert.ok(specific.impact > vague.impact, "impact follows measured specificity");
  const kw = await measureAxes({ text: "remember this preference" });
  assert.equal(kw.impact, 0.72, "keyword bump is kept as a floor");
});

test("deriveSpecialistScope: top content-word stems + domain; distinct texts -> distinct scopes", () => {
  const a = deriveSpecialistScope("automate reconciling stripe invoices every week", "general");
  const b = deriveSpecialistScope("automate triaging github issues every week", "general");
  assert.ok(a.includes("stripe"), `scope should carry content words, got "${a}"`);
  assert.ok(b.includes("github"), `scope should carry content words, got "${b}"`);
  assert.ok(a.endsWith("general") && b.endsWith("general"), "domain is appended");
  assert.notEqual(a, b);
  assert.equal(deriveSpecialistScope("", "general"), null, "no content words -> null (caller keeps defaults)");
  assert.equal(deriveSpecialistScope("automate", "general"), null, "trigger words alone -> null");
});

test("helpers: countProperNouns and contentWords behave as specified", () => {
  assert.equal(countProperNouns("Send the report to Spencer at Anthropic. Tomorrow works."), 2,
    "Spencer + Anthropic count; sentence-initial Send/Tomorrow do not");
  assert.deepEqual(contentWords("remind me every tuesday to file my report"), ["tuesday", "file", "report"]);
});

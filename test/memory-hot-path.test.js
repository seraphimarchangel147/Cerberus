// Recall should balance distilled knowledge with fresh context, while weak
// condenser fallbacks must decay and deduplicate instead of polluting memory.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCondenser } from "../src/memory-condenser.js";
import { MemorySystem } from "../src/memory-system.js";

const NOW = "2026-07-21T12:00:00.000Z";

function rememberGroup(memory, contents, tags = ["deploy", "rollback"]) {
  return contents.map((content) => memory.remember(
    { content, tags, repetition: 0.7, novelty: 0.4 },
    { tier: "medium", now: NOW }
  ));
}

test("matching principle edges fresh trivia without drowning recency-specific context", () => {
  const memory = new MemorySystem();
  memory.remember({
    content: "Deployment database backup rollback was discussed in standup trivia.",
    tags: ["deployment", "database", "backup", "rollback"]
  }, { tier: "short", strength: 1, now: NOW });
  const principle = memory.remember({
    content: "Deployment database backup rollback is mandatory before every release.",
    tags: ["deployment", "database", "backup", "rollback"],
    kind: "principle"
  }, { tier: "long", strength: 0.8, now: "2026-06-01T12:00:00.000Z" });
  const fresh = memory.remember({
    content: "The cafeteria blue badge reader is broken today.",
    tags: ["cafeteria", "badge"]
  }, { tier: "short", strength: 0.7, now: NOW });

  const policyHits = memory.retrieve("deployment database backup rollback", { now: NOW });
  assert.equal(policyHits[0].item.id, principle.id);
  const recencyHits = memory.retrieve("cafeteria blue badge today", { now: NOW });
  assert.equal(recencyHits[0].item.id, fresh.id);
});

test("deterministic condenser fallback lands in medium memory and decays", async () => {
  const memory = new MemorySystem();
  const sources = rememberGroup(memory, [
    "Always create a database backup before deployment.",
    "Always create a database backup before release.",
    "Always create a database backup before rollout."
  ]);
  const condenser = new MemoryCondenser({ runtime: { memory } });

  const result = await condenser.condense({ now: new Date(NOW) });
  assert.equal(result.principles, 1);
  assert.equal(memory.byTier("long").filter((item) => item.kind === "principle").length, 0);
  const principle = memory.byTier("medium").find((item) => item.kind === "principle");
  assert.ok(principle);
  assert.equal(principle.metadata.confidence, "low");
  assert.equal(principle.strength, 0.48);
  assert.equal(sources.every((source) => memory.items.get(source.id).metadata.condensedInto === principle.id), true);
});

test("near-duplicate condenser output merges sources instead of adding junk", async () => {
  const memory = new MemorySystem();
  const condenser = new MemoryCondenser({ runtime: { memory } });
  rememberGroup(memory, [
    "Always back up the database before deployment and rehearse rollback alpha.",
    "Always back up the database before deployment and rehearse rollback beta.",
    "Always back up the database before deployment and rehearse rollback gamma."
  ]);
  await condenser.condense({ now: new Date(NOW) });
  const existing = [...memory.items.values()].find((item) => item.kind === "principle");

  const secondSources = rememberGroup(memory, [
    "Always back up the database before deployment and rehearse rollback delta.",
    "Always back up the database before deployment and rehearse rollback epsilon.",
    "Always back up the database before deployment and rehearse rollback zeta."
  ]);
  const second = await condenser.condense({ now: new Date("2026-07-22T12:00:00.000Z") });

  assert.equal(second.principles, 0);
  assert.equal(second.duplicatesSkipped, 1);
  assert.equal([...memory.items.values()].filter((item) => item.kind === "principle").length, 1);
  assert.equal(secondSources.every((source) => memory.items.get(source.id).metadata.condensedInto === existing.id), true);
  assert.equal(existing.metadata.sources.length, 6);
});

test("parsed confidence controls condenser tier and strength", async () => {
  class LowConfidenceProvider {
    isConfigured() { return true; }
    async generate() {
      return { text: "Deploy only after checking the rollback plan. (confidence: low)" };
    }
  }
  const memory = new MemorySystem();
  rememberGroup(memory, ["Rollback check one", "Rollback check two", "Rollback check three"]);
  const condenser = new MemoryCondenser({
    runtime: { memory, agentHost: { modelProvider: new LowConfidenceProvider() } }
  });

  await condenser.condense({ now: new Date(NOW) });
  const principle = [...memory.items.values()].find((item) => item.kind === "principle");
  assert.equal(principle.tier, "medium");
  assert.equal(principle.strength, 0.48);
  assert.equal(principle.metadata.confidence, "low");
});

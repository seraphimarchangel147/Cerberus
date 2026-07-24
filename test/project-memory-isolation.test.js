import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCapacityError, MemorySystem } from "../src/memory-system.js";

const SCOPES = {
  alpha: "project:alpha",
  alphaSpecialist: "project:alpha:specialist:reviewer",
  alphaSubagent: "project:alpha:subagent:worker-1",
  beta: "project:beta",
  betaSpecialist: "project:beta:specialist:reviewer",
  legacySpecialist: "specialist:legacy"
};

function rememberFact(memory, id, scope) {
  return memory.remember(
    {
      content: `shared scope marker ${id}`,
      scope,
      tags: ["scope-marker"]
    },
    {
      id,
      tier: "medium",
      now: "2026-07-24T00:00:00.000Z"
    }
  );
}

function rememberCurated(memory, id, scope, content = `curated ${id}`) {
  return memory.remember(
    {
      content,
      scope
    },
    {
      id,
      tier: "medium",
      capacityManaged: true,
      now: "2026-07-24T00:00:00.000Z"
    }
  );
}

function recalledIds(memory, scope, exactScope = false) {
  return memory.retrieve("shared scope marker", {
    scope,
    exactScope,
    limit: 50,
    touch: false
  }).map(({ item }) => item.id).sort();
}

function curatedIds(memory, scope) {
  return memory.curatedItems({ scope }).map((item) => item.id).sort();
}

test("project fact retrieval inherits only its own project root", () => {
  const memory = new MemorySystem();
  const records = [
    ["fact-main", "main"],
    ["fact-legacy-specialist", SCOPES.legacySpecialist],
    ["fact-alpha", SCOPES.alpha],
    ["fact-alpha-specialist", SCOPES.alphaSpecialist],
    ["fact-alpha-subagent", SCOPES.alphaSubagent],
    ["fact-beta", SCOPES.beta],
    ["fact-beta-specialist", SCOPES.betaSpecialist]
  ];
  for (const [id, scope] of records) {
    assert.equal(rememberFact(memory, id, scope).scope, scope);
  }

  assert.deepEqual(recalledIds(memory, "main"), ["fact-main"]);
  assert.deepEqual(
    recalledIds(memory, SCOPES.legacySpecialist),
    ["fact-legacy-specialist", "fact-main"],
    "legacy specialist scopes continue to inherit main"
  );
  assert.deepEqual(recalledIds(memory, SCOPES.alpha), ["fact-alpha"]);
  assert.deepEqual(
    recalledIds(memory, SCOPES.alphaSpecialist),
    ["fact-alpha", "fact-alpha-specialist"]
  );
  assert.deepEqual(
    recalledIds(memory, SCOPES.alphaSubagent),
    ["fact-alpha", "fact-alpha-subagent"]
  );
  assert.deepEqual(recalledIds(memory, SCOPES.beta), ["fact-beta"]);
  assert.deepEqual(
    recalledIds(memory, SCOPES.betaSpecialist),
    ["fact-beta", "fact-beta-specialist"]
  );
  assert.deepEqual(
    recalledIds(memory, SCOPES.alphaSpecialist, true),
    ["fact-alpha-specialist"],
    "exact-scope retrieval remains exact"
  );
  assert.deepEqual(
    memory.retrieve("shared scope marker", {
      limit: 50,
      touch: false
    }).map(({ item }) => item.id).sort(),
    records.map(([id]) => id).sort(),
    "unscoped administrative retrieval remains backward compatible"
  );
});

test("curated project memory uses the same isolated inheritance tree", () => {
  const memory = new MemorySystem({ curatedMemoryMaxChars: 5_000 });
  const records = [
    ["curated-main", "main"],
    ["curated-legacy-specialist", SCOPES.legacySpecialist],
    ["curated-alpha", SCOPES.alpha],
    ["curated-alpha-specialist", SCOPES.alphaSpecialist],
    ["curated-alpha-subagent", SCOPES.alphaSubagent],
    ["curated-beta", SCOPES.beta],
    ["curated-beta-specialist", SCOPES.betaSpecialist]
  ];
  for (const [id, scope] of records) {
    assert.equal(rememberCurated(memory, id, scope).scope, scope);
  }

  assert.deepEqual(curatedIds(memory, "main"), ["curated-main"]);
  assert.deepEqual(
    curatedIds(memory, SCOPES.legacySpecialist),
    ["curated-legacy-specialist", "curated-main"]
  );
  assert.deepEqual(curatedIds(memory, SCOPES.alpha), ["curated-alpha"]);
  assert.deepEqual(
    curatedIds(memory, SCOPES.alphaSpecialist),
    ["curated-alpha", "curated-alpha-specialist"]
  );
  assert.deepEqual(
    curatedIds(memory, SCOPES.alphaSubagent),
    ["curated-alpha", "curated-alpha-subagent"]
  );
  assert.deepEqual(curatedIds(memory, SCOPES.beta), ["curated-beta"]);
  assert.deepEqual(
    curatedIds(memory, SCOPES.betaSpecialist),
    ["curated-beta", "curated-beta-specialist"]
  );

  const alphaSnapshot = memory.renderSessionMemorySnapshot({
    scope: SCOPES.alphaSpecialist
  });
  assert.match(alphaSnapshot, /curated curated-alpha/u);
  assert.match(alphaSnapshot, /curated curated-alpha-specialist/u);
  assert.doesNotMatch(alphaSnapshot, /curated curated-main/u);
  assert.doesNotMatch(alphaSnapshot, /curated curated-beta/u);
  assert.doesNotMatch(alphaSnapshot, /curated curated-alpha-subagent/u);
});

test("curated capacity is independent across projects and enforced on project descendants", () => {
  const isolated = new MemorySystem({ curatedMemoryMaxChars: 16 });
  rememberCurated(isolated, "main-five", "main", "12345");
  rememberCurated(isolated, "alpha-five", SCOPES.alpha, "67890");
  rememberCurated(isolated, "beta-five", SCOPES.beta, "abcde");
  assert.equal(isolated.curatedUsage({ scope: "main" }).usedChars, 16);
  assert.equal(isolated.curatedUsage({ scope: SCOPES.alpha }).usedChars, 16);
  assert.equal(isolated.curatedUsage({ scope: SCOPES.beta }).usedChars, 16);

  const inherited = new MemorySystem({ curatedMemoryMaxChars: 33 });
  rememberCurated(inherited, "alpha-root-five", SCOPES.alpha, "12345");
  rememberCurated(
    inherited,
    "alpha-specialist-five",
    SCOPES.alphaSpecialist,
    "67890"
  );
  assert.equal(
    inherited.curatedUsage({ scope: SCOPES.alphaSpecialist }).usedChars,
    33
  );

  const before = structuredClone([...inherited.items]);
  assert.throws(
    () => rememberCurated(inherited, "alpha-root-overflow", SCOPES.alpha, "x"),
    (error) => {
      assert.ok(error instanceof MemoryCapacityError);
      assert.equal(error.scope, SCOPES.alphaSpecialist);
      return true;
    }
  );
  assert.deepEqual(
    [...inherited.items],
    before,
    "a rejected project-root write cannot mutate a descendant projection"
  );
});

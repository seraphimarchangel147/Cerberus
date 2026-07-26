import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptancePassed,
  createAcceptanceGraph,
  normalizeAcceptanceCriteria,
  normalizeStoredGraph,
  recordVerificationEvidence,
  sourceRevisionForRun
} from "../src/acceptance-evidence.js";

const checks = [
  { id: "syntax_check", type: "syntax", path: "src/app.js" },
  { id: "behavior_test", type: "test", path: "test/app.test.js" }
];

const criteria = [{
  id: "requested_behavior",
  statement: "The requested behavior passes its exact regression test.",
  kind: "behavior",
  oracle: "test",
  required: true,
  checkIds: ["syntax_check", "behavior_test"]
}];

test("acceptance evidence is bound to the exact source revision", () => {
  const graph = createAcceptanceGraph({
    objective: "Implement the requested behavior.",
    criteria,
    checks
  });
  const revision = sourceRevisionForRun(
    [{ path: "src/app.js", tag: "a".repeat(64), missing: false }],
    [{ path: "src/app.js", postTag: "b".repeat(64) }]
  );
  const recorded = recordVerificationEvidence({
    graph,
    checks,
    sourceRevision: revision,
    at: "2026-01-01T00:00:00.000Z",
    verification: {
      receipt: { id: "receipt_exact" },
      results: [
        {
          id: "syntax_check",
          type: "syntax",
          path: "src/app.js",
          ok: true,
          code: "ok",
          durationMs: 1
        },
        {
          id: "behavior_test",
          type: "test",
          path: "test/app.test.js",
          ok: true,
          code: "ok",
          durationMs: 2
        }
      ]
    }
  });

  assert.equal(recorded.status, "passed");
  assert.equal(recorded.summary.requiredPassed, 1);
  assert.equal(acceptancePassed(recorded, revision), true);
  assert.equal(acceptancePassed(recorded, "c".repeat(64)), false);
});

test("one deterministic failure defeats other passing evidence", () => {
  const graph = createAcceptanceGraph({
    objective: "Implement the requested behavior.",
    criteria,
    checks
  });
  const revision = sourceRevisionForRun(
    [{ path: "src/app.js", tag: "a".repeat(64), missing: false }],
    []
  );
  const recorded = recordVerificationEvidence({
    graph,
    checks,
    sourceRevision: revision,
    verification: {
      results: [
        {
          id: "syntax_check",
          type: "syntax",
          ok: true,
          code: "ok"
        },
        {
          id: "behavior_test",
          type: "test",
          ok: false,
          code: "exit_1"
        }
      ]
    }
  });

  assert.equal(recorded.status, "failed");
  assert.equal(recorded.summary.failed, 1);
  assert.equal(acceptancePassed(recorded, revision), false);
});

test("criterion and check identities reject non-ASCII lookalikes", () => {
  const cyrillicSmallO = String.fromCodePoint(0x043e);
  assert.throws(
    () => normalizeAcceptanceCriteria([{
      id: `behavi${cyrillicSmallO}r`,
      statement: "Lookalike Cyrillic identifiers are forbidden.",
      kind: "security",
      oracle: "test",
      checkIds: ["behavior_test"]
    }], checks),
    /ASCII id/
  );
});

test("stored graph rejects objective or criterion drift", () => {
  const graph = createAcceptanceGraph({
    objective: "Original objective.",
    criteria,
    checks
  });
  assert.equal(
    normalizeStoredGraph(graph, {
      objective: "Changed objective.",
      checks
    }),
    null
  );

  const changed = structuredClone(graph);
  changed.criteria[0].statement = "A weaker replacement criterion.";
  assert.equal(
    normalizeStoredGraph(changed, {
      objective: "Original objective.",
      checks
    }),
    null
  );
});

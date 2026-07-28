// Delegation model routing.
//
// A delegated subagent used to inherit the `chat` task, so EVERY child ran on
// the base model — a one-line lookup cost the same as deep architectural
// reasoning. These tests pin the routing contract end to end: the kind->task
// map, the per-kind resolved model through the REAL ModelRouter, the
// conservative fallback, and the guarantee that omitting `kind` behaves
// byte-identically to the old code.
//
// The bar here is deliberately "which model would actually serve this turn",
// not "a flag was set" — a tier that silently falls back to base looks exactly
// like a working feature from the outside.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DELEGATE_KINDS,
  DELEGATE_KIND_GUIDANCE,
  ModelRouter,
  TASK_PROFILES,
  delegateTaskForKind
} from "../src/model-router.js";

// Mirrors Azazel's live Kimi lineup (probed 2026-07-28): k3 is the strong
// model, kimi-for-coding-highspeed the mid, kimi-for-coding the cheap one.
function router(env = {}) {
  return new ModelRouter({
    envPrefix: "ANTHROPIC",
    baseModel: "k3",
    env: {
      ANTHROPIC_MODEL_MINI: "kimi-for-coding-highspeed",
      ANTHROPIC_MODEL_NANO: "kimi-for-coding",
      ...env
    }
  });
}

test("every delegate kind maps to a task profile that exists", () => {
  for (const [kind, task] of Object.entries(DELEGATE_KINDS)) {
    assert.ok(
      Object.hasOwn(TASK_PROFILES, task),
      `kind '${kind}' maps to unknown task '${task}'`
    );
    assert.ok(
      DELEGATE_KIND_GUIDANCE[kind],
      `kind '${kind}' has no capability guidance for the tool schema`
    );
  }
  // Guidance must not describe kinds that do not exist.
  for (const kind of Object.keys(DELEGATE_KIND_GUIDANCE)) {
    assert.ok(Object.hasOwn(DELEGATE_KINDS, kind), `guidance for unknown kind '${kind}'`);
  }
});

test("each kind resolves to a model matched to the work", () => {
  const r = router();
  const resolved = (kind) => r.resolve(delegateTaskForKind(kind));

  // Reasoning and code writing must keep the strongest model.
  assert.equal(resolved("reason"), "k3");
  assert.equal(resolved("code"), "k3");

  // Verifiable, bounded work can drop a tier.
  assert.equal(resolved("debug"), "kimi-for-coding-highspeed");
  assert.equal(resolved("research"), "kimi-for-coding-highspeed");

  // Mechanical lookup takes the cheapest.
  assert.equal(resolved("extract"), "kimi-for-coding");
});

test("an unlabelled or unknown kind never downgrades", () => {
  const r = router();
  // This is the safety property: a caller that omits kind, or a typo, must end
  // up with MORE capability, never less.
  for (const kind of [undefined, null, "", "  ", "nonsense", "REASONING", 42, {}]) {
    assert.equal(delegateTaskForKind(kind), "delegate", `kind ${JSON.stringify(kind)}`);
    assert.equal(r.resolve(delegateTaskForKind(kind)), "k3");
  }
});

test("kind matching is case and whitespace insensitive", () => {
  assert.equal(delegateTaskForKind("  ReSeArCh "), "delegate_research");
  assert.equal(delegateTaskForKind("EXTRACT"), "delegate_extract");
});

test("omitting kind is byte-identical to the previous chat routing", () => {
  // Before this change a delegated child inherited `chat`. An unclassified
  // delegation must resolve to exactly the same model, or this is a behaviour
  // change disguised as an optimization.
  const r = router();
  assert.equal(r.resolve(delegateTaskForKind(undefined)), r.resolve("chat"));
});

test("unconfigured tiers fall back to base without pretending to save", () => {
  // THE TRAP: if ANTHROPIC_MODEL_MINI/NANO are unset, every tier silently
  // resolves to base. The feature would look wired and save nothing, so the
  // router must report that honestly via describe().onBase.
  const bare = new ModelRouter({ envPrefix: "ANTHROPIC", baseModel: "k3", env: {} });
  for (const kind of Object.keys(DELEGATE_KINDS)) {
    assert.equal(bare.resolve(delegateTaskForKind(kind)), "k3");
  }
  const rows = bare.describe().filter((row) => row.task.startsWith("delegate"));
  const downgradable = rows.filter((row) => row.tier !== "base");
  assert.ok(downgradable.length > 0, "expected some delegate tasks to target a cheaper tier");
  assert.ok(
    downgradable.every((row) => row.onBase),
    "unconfigured tiers must be reported as still-on-base, not as savings"
  );
});

test("delegate profiles are described with a rationale for the operator", () => {
  const rows = router().describe().filter((row) => row.task.startsWith("delegate"));
  assert.equal(rows.length, Object.keys(DELEGATE_KINDS).length + 1, "expected one row per kind plus the unclassified default");
  for (const row of rows) {
    assert.ok(row.label && row.label.length > 3, `${row.task} needs a label`);
    assert.ok(row.why && row.why.length > 20, `${row.task} needs a rationale`);
  }
});

test("an explicit task pin still overrides delegation routing", () => {
  // Operator intent outranks the delegator's classification.
  const r = router({ ANTHROPIC_MODEL_TASK_DELEGATE_EXTRACT: "k3-256k" });
  assert.equal(r.resolve(delegateTaskForKind("extract")), "k3-256k");
});

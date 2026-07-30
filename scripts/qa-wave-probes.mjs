#!/usr/bin/env node
// QA pre-check for harness upgrade Waves 1-3 (2026-07-29).
// Exercises the PURE / deterministic surfaces in-process. Zero deps, no daemon,
// no network, no writes. This is a fast sanity gate, NOT a substitute for the
// live probes in docs/qa/harness-upgrade-qa-battery-2026-07-29.md.
//
// Usage:  node scripts/qa-wave-probes.mjs
// Exit:   0 = all checks passed, 1 = at least one failed.

const results = [];
function check(id, label, fn) {
  try {
    const detail = fn();
    results.push({ id, label, ok: true, detail: detail ?? "ok" });
  } catch (error) {
    results.push({ id, label, ok: false, detail: error?.message ?? String(error) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const {
  scoreContextSubstitutability,
  CONTEXT_VALUE_MAX_SAMPLE_CHARS
} = await import("../src/context-value.js");
const {
  CONTEXT_VALUE_MILD_RATIO,
  CONTEXT_VALUE_AGGRESSIVE_RATIO,
  CONTEXT_VALUE_EMERGENCY_RATIO,
  CONTEXT_VALUE_EMERGENCY_TARGET_RATIO
} = await import("../src/memory-condenser.js");
const { reciprocalRankFusion } = await import("../src/vector-store.js");
const { evaluateRepeatedOutcome } = await import("../src/tool-registry.js");
const {
  bindTurnProgressCounter,
  recordTurnProgress,
  readTurnProgressCount
} = await import("../src/turn-progress.js");

// ---------------------------------------------------------------- Wave 3: scorer
check("W3.1", "scorer protects error-bearing output (low score)", () => {
  const a = scoreContextSubstitutability(
    "Traceback (most recent call last):\n  File \"x.py\", line 3\nValueError: boom"
  );
  assert(a.score <= 2, `expected <=2, got ${a.score} (${a.reason})`);
  return `score=${a.score} reason=${a.reason}`;
});

check("W3.2", "scorer treats ref-backed output as highly substitutable", () => {
  const r = scoreContextSubstitutability({
    ref: "out_0123456789abcdef",
    text: "a".repeat(5000)
  });
  assert(r.score >= 7, `expected >=7, got ${r.score} (${r.reason})`);
  return `score=${r.score} reason=${r.reason}`;
});

check("W3.3", "scorer is total: hostile input never throws, scores low", () => {
  for (const bad of [null, undefined, 42, {}, [], () => {}, Symbol("s")]) {
    const r = scoreContextSubstitutability(bad);
    assert(Number.isInteger(r.score), `non-integer score for ${String(bad)}`);
    assert(r.score >= 0 && r.score <= 10, `out-of-range ${r.score}`);
  }
  return "all hostile inputs handled";
});

check("W3.4", "scorer is deterministic and bounded", () => {
  const huge = "log line noise\n".repeat(200_000);
  const t0 = Date.now();
  const first = scoreContextSubstitutability(huge);
  const elapsed = Date.now() - t0;
  const second = scoreContextSubstitutability(huge);
  assert(first.score === second.score, "same input produced different scores");
  assert(elapsed < 2000, `scoring took ${elapsed}ms — sampling bound may be broken`);
  assert(
    Number.isInteger(CONTEXT_VALUE_MAX_SAMPLE_CHARS)
      && CONTEXT_VALUE_MAX_SAMPLE_CHARS <= 65_536,
    "sample bound missing or too large"
  );
  return `score=${first.score} ${elapsed}ms sample_cap=${CONTEXT_VALUE_MAX_SAMPLE_CHARS}`;
});

check("W3.5", "error-bearing scores BELOW ref-backed (shed order is correct)", () => {
  const err = scoreContextSubstitutability("FATAL: unhandled exception: nope");
  const ref = scoreContextSubstitutability({ ref: "out_0123456789abcdef", text: "x".repeat(4000) });
  assert(err.score < ref.score, `err ${err.score} !< ref ${ref.score}`);
  return `error=${err.score} < ref=${ref.score}`;
});

// ---------------------------------------------------------------- Wave 3: ladder
check("W3.6", "graded ladder ratios are ordered and emergency target recovers", () => {
  assert(CONTEXT_VALUE_MILD_RATIO === 0.5, `mild=${CONTEXT_VALUE_MILD_RATIO}`);
  assert(CONTEXT_VALUE_AGGRESSIVE_RATIO === 0.85, `aggressive=${CONTEXT_VALUE_AGGRESSIVE_RATIO}`);
  assert(CONTEXT_VALUE_EMERGENCY_RATIO === 0.95, `emergency=${CONTEXT_VALUE_EMERGENCY_RATIO}`);
  assert(
    CONTEXT_VALUE_EMERGENCY_TARGET_RATIO < CONTEXT_VALUE_EMERGENCY_RATIO,
    "emergency target must be BELOW the trigger or compaction will thrash"
  );
  assert(
    CONTEXT_VALUE_MILD_RATIO < CONTEXT_VALUE_AGGRESSIVE_RATIO
      && CONTEXT_VALUE_AGGRESSIVE_RATIO < CONTEXT_VALUE_EMERGENCY_RATIO,
    "ladder ratios out of order"
  );
  return `${CONTEXT_VALUE_MILD_RATIO} < ${CONTEXT_VALUE_AGGRESSIVE_RATIO} < ${CONTEXT_VALUE_EMERGENCY_RATIO} -> target ${CONTEXT_VALUE_EMERGENCY_TARGET_RATIO}`;
});

// ---------------------------------------------------------------- Wave 3: RRF
check("W3.7", "RRF ranks an item strong in BOTH lists above a single-list leader", () => {
  const both = { id: "both" };
  const vec = [{ id: "vecOnly" }, both];
  const lex = [{ id: "lexOnly" }, both];
  const fused = reciprocalRankFusion([vec, lex]);
  const idOf = (x) => x?.id ?? x?.item?.id;
  assert(fused.length >= 3, `expected >=3 fused, got ${fused.length}`);
  assert(idOf(fused[0]) === "both", `top was ${idOf(fused[0])}, expected "both"`);
  return `order=${fused.map(idOf).join(",")}`;
});

check("W3.8", "RRF is deterministic and handles empty/single lists", () => {
  const l = [{ id: "a" }, { id: "b" }];
  const one = reciprocalRankFusion([l]).map((x) => x.id ?? x.item?.id).join(",");
  const two = reciprocalRankFusion([l]).map((x) => x.id ?? x.item?.id).join(",");
  assert(one === two, "non-deterministic RRF ordering");
  assert(Array.isArray(reciprocalRankFusion([])), "empty input should return an array");
  return `stable order=${one}`;
});

// ------------------------------------------------- Wave 1: repeat detection
check("W1.1", "changing output = progress (never accumulates)", () => {
  let count = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = evaluateRepeatedOutcome({
      priorSignature: `sig-${i}`,
      nextSignature: `sig-${i + 1}`,
      count,
      limit: 8
    });
    assert(r.progressed === true, `iteration ${i} did not register progress`);
    assert(r.thresholdReached === false, `false positive at iteration ${i}`);
    count = r.repeatedSuccessCount;
  }
  return "12 changing-output calls, zero flags";
});

check("W1.2", "identical output fires the advisory EXACTLY once at the limit", () => {
  let count = 0;
  const fired = [];
  for (let i = 0; i < 12; i += 1) {
    const r = evaluateRepeatedOutcome({
      priorSignature: "same",
      nextSignature: "same",
      count,
      limit: 8
    });
    count = r.repeatedSuccessCount;
    if (r.thresholdReached) fired.push(count);
  }
  assert(fired.length === 1, `advisory fired ${fired.length} times (expected 1) at ${fired}`);
  assert(fired[0] === 8, `fired at ${fired[0]}, expected 8`);
  return `fired once at count=${fired[0]}`;
});

check("W1.3", "repeat evaluation fails safe on garbage input", () => {
  for (const bad of [null, undefined, {}, { nextSignature: 42 }, { nextSignature: "" }]) {
    const r = evaluateRepeatedOutcome(bad);
    assert(r && r.thresholdReached === false, `garbage input flagged: ${JSON.stringify(bad)}`);
  }
  return "no false advisory on malformed input";
});

// ------------------------------------------------- Wave 1: turn progress
check("W1.4", "turn progress counter records progress and rejects untrusted objects", () => {
  const ctx = {};
  const counter = bindTurnProgressCounter(ctx);
  assert(counter, "counter not bound");
  assert(readTurnProgressCount(counter) === 0, "counter did not start at 0");
  assert(recordTurnProgress(ctx) === true, "recordTurnProgress failed on bound context");
  assert(readTurnProgressCount(counter) === 1, "counter did not increment");
  assert(recordTurnProgress({}) === false, "unbound context should not record");
  assert(readTurnProgressCount({ count: 999 }) === null, "forged counter was trusted");
  return "bind/record/read + forgery rejection all correct";
});

check("W1.5", "turn progress binding is idempotent and fail-open", () => {
  const ctx = {};
  const a = bindTurnProgressCounter(ctx);
  const b = bindTurnProgressCounter(ctx);
  assert(a === b, "re-binding created a second counter");
  assert(bindTurnProgressCounter(null) === null, "null context should return null, not throw");
  assert(bindTurnProgressCounter(42) === null, "non-object should return null, not throw");
  return "idempotent, fail-open";
});

// ------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
let failed = 0;
console.log("\nHarness Upgrade QA pre-check — Waves 1-3");
console.log("=".repeat(78));
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${pad(r.id, 6)} ${pad(r.label, 52)}  ${r.detail}`
  );
}
console.log("=".repeat(78));
console.log(`${results.length - failed}/${results.length} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("A FAILURE HERE IS A REAL FINDING. Report it verbatim — do not smooth it over.\n");
}
process.exit(failed > 0 ? 1 : 0);

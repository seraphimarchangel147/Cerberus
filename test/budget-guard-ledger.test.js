// test/budget-guard-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "../src/budget-guard.js";
import { CreditLedger } from "../src/credit-ledger.js";

function tmp(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  const guard = new BudgetGuard({
    storePath: path.join(dir, "usage.json"),
    ledger,
    ...options
  });
  return { guard, ledger };
}

test("record(meta) writes a ledger entry carrying the context", () => {
  const { guard, ledger } = tmp();
  guard.record({ input_tokens: 1000, output_tokens: 500 }, "claude-opus-4-7", {
    channel: "autopilot", agentId: "main", sessionId: "s9", from: "cron", tools: ["web_search", "add_task"]
  });
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "autopilot");
  assert.deepEqual(rows[0].tools, ["web_search", "add_task"]);
  assert.equal(rows[0].model, "claude-opus-4-7");
  assert.ok(rows[0].usd > 0);
  assert.equal(rows[0].tokens.input, 1000);
});

test("record without meta still aggregates and does not throw (back-compat)", () => {
  const { guard, ledger } = tmp();
  const res = guard.record({ input_tokens: 100, output_tokens: 50 }, "gpt-5");
  assert.ok(res.added > 0);
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, null);
});

test("OpenAI cached input is split from the total instead of double-charged", () => {
  const { guard, ledger } = tmp({
    prices: {
      "test-openai": { in: 5, out: 0, cacheRead: 0.5, cacheWrite: 0 }
    }
  });
  const result = guard.record({
    input_tokens: 1000,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 400 }
  }, "test-openai");

  const [row] = ledger.query({ days: 1 });
  assert.deepEqual(row.tokens, {
    input: 600,
    output: 0,
    cacheRead: 400,
    cacheWrite: 0
  });
  assert.ok(Math.abs(result.added - 0.0032) < 1e-12);
  assert.deepEqual(guard.status().tokens, {
    input: 600,
    output: 0,
    cacheRead: 400,
    cacheWrite: 0
  });
});

test("OpenAI Chat cached input uses the same mutually-exclusive buckets", () => {
  const { guard, ledger } = tmp();
  guard.record({
    prompt_tokens: 300,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 125 }
  }, "gpt-5");

  assert.deepEqual(ledger.query({ days: 1 })[0].tokens, {
    input: 175,
    output: 20,
    cacheRead: 125,
    cacheWrite: 0
  });
});

test("Anthropic cache read/write fields remain additive to input_tokens", () => {
  const { guard, ledger } = tmp();
  guard.record({
    input_tokens: 100,
    output_tokens: 25,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 30
  }, "claude-sonnet-4-6");

  assert.deepEqual(ledger.query({ days: 1 })[0].tokens, {
    input: 100,
    output: 25,
    cacheRead: 40,
    cacheWrite: 30
  });
});

test("record forwards only normalized content-free efficiency metadata", () => {
  const { guard, ledger } = tmp();
  guard.record({ input_tokens: 10, output_tokens: 2 }, "gpt-5", {
    provider: "openai",
    tools: ["read_file", "write_file"],
    efficiency: {
      requestBytes: 4096,
      toolCount: 2,
      toolSuccessCount: 1,
      toolFailureCount: 1,
      toolSchemaBytes: 1024,
      visibleSchemaBytes: 384,
      deferredSchemaBytes: 640,
      visibleToolCount: 8,
      deferredToolCount: 12,
      compression: true,
      stopReason: "completed",
      latencyMs: 250,
      prompt: "this content must not be persisted"
    }
  });

  const [row] = ledger.query({ days: 1 });
  assert.equal(row.provider, "openai");
  assert.deepEqual(row.efficiency, {
    requestBytes: 4096,
    toolCount: 2,
    toolSuccessCount: 1,
    toolFailureCount: 1,
    toolSchemaBytes: 1024,
    visibleSchemaBytes: 384,
    deferredSchemaBytes: 640,
    visibleToolCount: 8,
    deferredToolCount: 12,
    compression: true,
    stopReason: "completed",
    latencyMs: 250
  });
  assert.doesNotMatch(JSON.stringify(row.efficiency), /this content/);
});

test("priceFor bills nano/mini variants at their own rate, not flagship (longest-prefix)", () => {
  const g = new BudgetGuard({ storePath: path.join(os.tmpdir(), `bg-${Date.now()}.json`) });
  // gpt-5.4-nano must NOT resolve to gpt-5 ($5/$15) — it's $0.20/$1.25.
  assert.equal(g.priceFor("gpt-5.4-nano").in, 0.2, "nano input price, not flagship");
  assert.equal(g.priceFor("gpt-5.4-nano").out, 1.25);
  assert.equal(g.priceFor("gpt-5-nano").in, 0.05);
  assert.equal(g.priceFor("gpt-5.4-mini").in, 0.75);
  assert.equal(g.priceFor("gpt-5.5").out, 30, "gpt-5.5 output is $30, not gpt-5's $15");
  assert.equal(g.priceFor("gpt-5").in, 5, "flagship still flagship");
  // an unknown future variant matches the longest sensible prefix, not bare gpt-5
  assert.equal(g.priceFor("gpt-5.4-nano-2027").in, 0.2);
});

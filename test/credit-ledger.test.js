// test/credit-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreditLedger } from "../src/credit-ledger.js";

function tmpLedger(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  return new CreditLedger({ storePath: path.join(dir, "ledger.jsonl"), ...opts });
}
const entry = (over = {}) => ({
  model: "claude-opus-4-7", usd: 0.05, channel: "chat", agentId: "main",
  sessionId: "s1", from: "user", tools: ["web_search"],
  tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, ...over
});

test("records and queries entries newest-first", () => {
  const L = tmpLedger();
  const now = new Date("2026-06-06T12:00:00.000Z");
  L.record(entry({ usd: 0.01, at: "2026-06-05T10:00:00.000Z" }), { now });
  L.record(entry({ usd: 0.02, at: "2026-06-06T10:00:00.000Z" }), { now });
  const rows = L.query({ days: 30, now });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd, 0.02);
  assert.equal(rows[0].channel, "chat");
});

test("query window excludes entries older than days", () => {
  const L = tmpLedger();
  L.record(entry({ at: "2026-05-01T10:00:00.000Z" }));
  L.record(entry({ at: "2026-06-06T10:00:00.000Z" }));
  const rows = L.query({ days: 30, now: new Date("2026-06-06T12:00:00.000Z") });
  assert.equal(rows.length, 1);
});

test("analytics groups by day, model, activity", () => {
  const L = tmpLedger();
  const now = new Date("2026-06-06T12:00:00.000Z");
  L.record(entry({ usd: 0.10, channel: "autopilot", model: "claude-opus-4-7", at: "2026-06-06T09:00:00.000Z" }), { now });
  L.record(entry({ usd: 0.04, channel: "chat", model: "gpt-5", at: "2026-06-06T10:00:00.000Z" }), { now });
  L.record(entry({ usd: 0.01, channel: "chat", model: "gpt-5", at: "2026-06-05T10:00:00.000Z" }), { now });
  const a = L.analytics({ days: 30, now });
  assert.equal(a.totalCalls, 3);
  assert.equal(a.totalUsd, 0.15);
  assert.equal(a.byActivity.find((x) => x.activity === "autopilot").usd, 0.10);
  assert.equal(a.byActivity[0].activity, "autopilot");
  assert.equal(a.byModel.find((x) => x.model === "gpt-5").calls, 2);
  assert.deepEqual(a.byDay.map((d) => d.date), ["2026-06-05", "2026-06-06"]);
});

test("analytics summarizes token and content-free efficiency totals", () => {
  const L = tmpLedger();
  const now = new Date("2026-06-06T12:00:00.000Z");
  L.record(entry({
    at: "2026-06-06T09:00:00.000Z",
    provider: "openai",
    tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40 },
    efficiency: {
      requestBytes: 500,
      toolCount: 2,
      toolSuccessCount: 2,
      toolFailureCount: 0,
      toolSchemaBytes: 200,
      visibleSchemaBytes: 80,
      deferredSchemaBytes: 120,
      visibleToolCount: 5,
      deferredToolCount: 7,
      compression: true,
      stopReason: "completed",
      latencyMs: 120
    }
  }), { now });
  L.record(entry({
    at: "2026-06-06T10:00:00.000Z",
    provider: "anthropic",
    tokens: { input: 50, output: 10, cacheRead: 5, cacheWrite: 0 },
    efficiency: {
      requestBytes: 250,
      toolCount: 1,
      toolSuccessCount: 0,
      toolFailureCount: 1,
      toolSchemaBytes: 100,
      visibleSchemaBytes: 40,
      deferredSchemaBytes: 60,
      visibleToolCount: 3,
      deferredToolCount: 4,
      compression: false,
      stopReason: "iteration-cap",
      latencyMs: 80
    }
  }), { now });

  const analytics = L.analytics({ days: 30, now });
  assert.deepEqual(analytics.tokens, {
    input: 150,
    output: 30,
    cacheRead: 35,
    cacheWrite: 40
  });
  assert.deepEqual(
    analytics.byProvider.map(({ provider, calls }) => ({ provider, calls })),
    [
      { provider: "anthropic", calls: 1 },
      { provider: "openai", calls: 1 }
    ]
  );
  assert.deepEqual(analytics.efficiency, {
    requestBytes: 750,
    toolCount: 3,
    toolSuccessCount: 2,
    toolFailureCount: 1,
    toolSchemaBytes: 300,
    visibleSchemaBytes: 120,
    deferredSchemaBytes: 180,
    visibleToolCount: 8,
    deferredToolCount: 11,
    compression: 1,
    latencyMs: 200,
    stopReasons: {
      completed: 1,
      "iteration-cap": 1
    }
  });
});

test("efficiency rows are bounded, typed, and ignore arbitrary content", () => {
  const L = tmpLedger();
  const row = L.record(entry({
    efficiency: {
      requestBytes: -1,
      toolCount: Number.POSITIVE_INFINITY,
      toolSuccessCount: -2,
      toolFailureCount: "2",
      toolSchemaBytes: "25",
      visibleSchemaBytes: "10",
      deferredSchemaBytes: 15.8,
      visibleToolCount: 3.9,
      deferredToolCount: -4,
      compression: "yes",
      stopReason: "secret user-supplied text",
      latencyMs: 10 ** 15,
      message: "must never land in the efficiency envelope"
    }
  }));

  assert.equal(row.efficiency.requestBytes, 0);
  assert.equal(row.efficiency.toolCount, 0);
  assert.equal(row.efficiency.toolSuccessCount, 0);
  assert.equal(row.efficiency.toolFailureCount, 2);
  assert.equal(row.efficiency.toolSchemaBytes, 25);
  assert.equal(row.efficiency.visibleSchemaBytes, 10);
  assert.equal(row.efficiency.deferredSchemaBytes, 15);
  assert.equal(row.efficiency.visibleToolCount, 3);
  assert.equal(row.efficiency.deferredToolCount, 0);
  assert.equal(row.efficiency.compression, false);
  assert.equal(row.efficiency.stopReason, null);
  assert.ok(Number.isSafeInteger(row.efficiency.latencyMs));
  assert.ok(row.efficiency.latencyMs > 0);
  assert.doesNotMatch(JSON.stringify(row.efficiency), /must never|secret user/);
});

test("analytics keeps pre-efficiency ledger rows compatible", () => {
  const L = tmpLedger();
  const now = new Date("2026-06-06T12:00:00.000Z");
  fs.writeFileSync(L.storePath, JSON.stringify({
    at: "2026-06-06T08:00:00.000Z",
    model: "legacy",
    usd: 0.01,
    channel: "chat",
    tokens: { input: 9, output: 4, cacheRead: 2, cacheWrite: 1 },
    tools: ["legacy_tool"]
  }) + "\n");

  const analytics = L.analytics({ days: 30, now });
  assert.equal(analytics.totalCalls, 1);
  assert.deepEqual(analytics.tokens, {
    input: 9,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1
  });
  assert.deepEqual(analytics.efficiency, {
    requestBytes: 0,
    toolCount: 0,
    toolSuccessCount: 0,
    toolFailureCount: 0,
    toolSchemaBytes: 0,
    visibleSchemaBytes: 0,
    deferredSchemaBytes: 0,
    visibleToolCount: 0,
    deferredToolCount: 0,
    compression: 0,
    latencyMs: 0,
    stopReasons: {}
  });
});

test("compacts when the file exceeds the byte threshold, keeping the window", () => {
  const L = tmpLedger({ compactBytes: 1 });
  L.record(entry({ at: "2026-05-01T10:00:00.000Z" }), { now: new Date("2026-06-06T10:00:00.000Z") });
  L.record(entry({ at: "2026-06-06T10:00:00.000Z" }), { now: new Date("2026-06-06T10:00:00.000Z") });
  const onDisk = fs.readFileSync(L.storePath, "utf8").split("\n").filter(Boolean);
  assert.equal(onDisk.length, 1);
});

test("tolerates a missing/corrupt file", () => {
  const L = tmpLedger();
  assert.deepEqual(L.query(), []);
  fs.writeFileSync(L.storePath, "not json\n{bad\n");
  assert.deepEqual(L.query(), []);
});

test("days=1 means today (UTC calendar day), not a rolling 24h window", () => {
  const L = tmpLedger();
  // now = today 08:00 UTC. An entry at yesterday 23:00 is within the last 24h
  // but is NOT today — it must be excluded from a days=1 ("today") query.
  L.record(entry({ at: "2026-06-05T23:00:00.000Z" })); // yesterday evening
  L.record(entry({ at: "2026-06-06T02:00:00.000Z" })); // today, early
  const now = new Date("2026-06-06T08:00:00.000Z");
  const rows = L.query({ days: 1, now });
  assert.equal(rows.length, 1, "only today's entry");
  assert.equal(rows[0].at, "2026-06-06T02:00:00.000Z");
  assert.equal(L.analytics({ days: 1, now }).totalCalls, 1);
});

test("days=7 includes today plus the previous 6 calendar days", () => {
  const L = tmpLedger();
  const now = new Date("2026-06-06T08:00:00.000Z");
  L.record(entry({ at: "2026-05-31T10:00:00.000Z" }), { now }); // 6 days before the 6th — included
  L.record(entry({ at: "2026-05-30T10:00:00.000Z" }), { now }); // 7 days before — excluded
  const rows = L.query({ days: 7, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, "2026-05-31T10:00:00.000Z");
});

test("enforces 30-day retention on disk even below the compaction threshold", () => {
  const L = tmpLedger({ compactBytes: 10 * 1024 * 1024 }); // never size-compacts
  const now = new Date("2026-06-06T10:00:00.000Z");
  L.record(entry({ at: "2026-04-01T10:00:00.000Z" }), { now }); // ~66 days old → pruned
  L.record(entry({ at: "2026-06-06T09:00:00.000Z" }), { now }); // within window
  const onDisk = fs.readFileSync(L.storePath, "utf8").split("\n").filter(Boolean);
  assert.equal(onDisk.length, 1, "old row physically removed despite a small file");
  assert.match(onDisk[0], /2026-06-06T09:00/);
});

test("clamps query/analytics to the retention window (stale on-disk rows never surface)", () => {
  const L = tmpLedger();
  // Write an aged-out row directly, bypassing record()'s prune, to simulate
  // data still on disk past the window.
  fs.writeFileSync(L.storePath, JSON.stringify({ at: "2026-04-01T10:00:00.000Z", model: "x", usd: 1, channel: "chat", tools: [] }) + "\n");
  const now = new Date("2026-06-06T10:00:00.000Z");
  assert.equal(L.query({ days: 90, now }).length, 0, "days=90 must not return a >30-day-old row");
  assert.equal(L.analytics({ days: 90, now }).totalCalls, 0);
});

test("creates the ledger file with private 0600 permissions", { skip: process.platform === "win32" }, () => {
  const L = tmpLedger();
  L.record(entry());
  const mode = fs.statSync(L.storePath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0o${mode.toString(8)}`);
});

test("re-arms the compaction threshold so it doesn't rewrite on every append", () => {
  const L = tmpLedger({ compactBytes: 1 }); // would compact on every append without re-arming
  const now = new Date("2026-06-06T10:00:00.000Z");
  L.record(entry({ at: "2026-06-06T09:00:00.000Z" }), { now });
  L.record(entry({ at: "2026-06-06T09:30:00.000Z" }), { now });
  // After compacting a retained (non-empty) window, the next threshold must
  // climb above compactBytes so subsequent appends within the headroom skip the
  // full read+rewrite.
  assert.ok(L._nextCompactBytes > 1, `expected re-armed threshold > 1, got ${L._nextCompactBytes}`);
});

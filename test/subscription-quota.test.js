// A USD/day cap is the wrong instrument for a flat-rate plan: the money is
// already spent. What binds is the provider's rolling usage window. These
// cover the window arithmetic, the honesty of an unknown ceiling, and the
// 429 signal that is the only ground truth a header-less endpoint provides.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SubscriptionQuotaTracker, subscriptionTrackingEnabled } from "../src/subscription-quota.js";
import { BudgetGuard } from "../src/budget-guard.js";
import { registerCoreTools, ToolRegistry } from "../src/tool-registry.js";

function tracker(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-quota-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new SubscriptionQuotaTracker({
    dir,
    statePath: path.join(dir, "state.json"),
    env: { OPENAGI_SUBSCRIPTION_WINDOW_HOURS: "5", ...env }
  });
}

const HOUR = 3_600_000;

test("the flag gates tracking and defaults to off", () => {
  assert.equal(subscriptionTrackingEnabled({}), false);
  assert.equal(subscriptionTrackingEnabled({ OPENAGI_SUBSCRIPTION_TRACKING: "1" }), true);
  assert.equal(subscriptionTrackingEnabled({ OPENAGI_SUBSCRIPTION_TRACKING: "0" }), false);
});

test("only calls inside the rolling window are counted", () => {
  const quota = tracker();
  const now = Date.now();
  // Inside the 5h window.
  quota.record({ tokens: { input: 100, output: 50, cacheRead: 900 }, at: now - HOUR });
  quota.record({ tokens: { input: 200, output: 25, cacheRead: 100 }, at: now - 2 * HOUR });
  // Outside it — must not count toward current pressure.
  quota.record({ tokens: { input: 9999, output: 9999 }, at: now - 6 * HOUR });

  const status = quota.status(now);
  assert.equal(status.calls, 2);
  assert.equal(status.tokens.input, 300);
  assert.equal(status.tokens.output, 75);
  // Cache reads are tracked but excluded from billable throughput; counting
  // them would badly overstate how full the window is.
  assert.equal(status.tokens.cacheRead, 1000);
  assert.equal(status.tokens.billable, 375);
});

test("reset time is driven by the oldest call ageing out", () => {
  const quota = tracker();
  const now = Date.now();
  quota.record({ tokens: { input: 10, output: 10 }, at: now - 4 * HOUR });
  quota.record({ tokens: { input: 10, output: 10 }, at: now });

  const status = quota.status(now);
  // Oldest in-window call was 4h ago, so capacity starts returning in ~1h.
  assert.equal(status.minutesUntilReset, 60);
  assert.ok(status.windowResetsAt);
});

test("an unknown plan ceiling is reported as unknown, never guessed", () => {
  const quota = tracker();
  quota.record({ tokens: { input: 500, output: 500 } });
  const status = quota.status();
  assert.equal(status.limitKnown, false);
  assert.equal(status.windowTokenLimit, null);
  assert.equal(status.percentUsed, null);
  assert.match(status.note, /Observed usage only/u);
});

test("a configured ceiling enables percentage tracking", () => {
  const quota = tracker({ OPENAGI_SUBSCRIPTION_WINDOW_TOKENS: "1000" });
  quota.record({ tokens: { input: 200, output: 50 } });
  const status = quota.status();
  assert.equal(status.limitKnown, true);
  assert.equal(status.windowTokenLimit, 1000);
  assert.equal(status.percentUsed, 25);
});

test("a provider 429 is recorded as ground truth over the estimate", () => {
  const quota = tracker();
  quota.record({ tokens: { input: 10, output: 10 } });
  assert.equal(quota.status().throttledInWindow, 0);

  quota.recordThrottle({ retryAfterMs: 30_000, model: "kimi-k3" });
  const status = quota.status();
  assert.equal(status.throttledInWindow, 1);
  assert.ok(status.lastThrottleAt);
  assert.match(status.note, /actually reached/u);
});

test("window state survives a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-quota-restart-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    dir,
    statePath: path.join(dir, "state.json"),
    env: { OPENAGI_SUBSCRIPTION_WINDOW_HOURS: "5" }
  };
  const first = new SubscriptionQuotaTracker(options);
  first.record({ tokens: { input: 123, output: 45 } });

  const reopened = new SubscriptionQuotaTracker(options);
  const status = reopened.status();
  assert.equal(status.calls, 1);
  assert.equal(status.tokens.billable, 168);
});

test("the budget guard drives the tracker and never breaks a reply", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-subscription-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = new BudgetGuard({
    storePath: path.join(dir, "usage.json"),
    env: { OPENAGI_SUBSCRIPTION_TRACKING: "1", OPENAGI_DAILY_USD_LIMIT: "off" }
  });
  assert.ok(guard.subscriptionQuota, "tracking flag must construct the tracker");

  guard.record({ input_tokens: 100, output_tokens: 20 }, "kimi-k3", {});
  const status = guard.subscriptionStatus();
  assert.equal(status.calls, 1);
  assert.equal(status.tokens.billable, 120);

  // Tracking is telemetry: a broken tracker must never break a reply.
  guard.subscriptionQuota = {
    record() { throw new Error("tracker exploded"); },
    status() { throw new Error("tracker exploded"); }
  };
  assert.doesNotThrow(() => guard.record({ input_tokens: 5, output_tokens: 5 }, "kimi-k3", {}));
  assert.equal(guard.subscriptionStatus(), null);
});

test("quota_status reports through the registry and is honest when off", async () => {
  const registry = new ToolRegistry();
  registerCoreTools(registry, {});
  const tool = registry.list().find((entry) => entry.name === "quota_status");
  assert.ok(tool, "quota_status must be registered");
  assert.equal(tool.sideEffects, false);

  const off = await registry.invoke("quota_status", {}, {});
  assert.equal((off.result ?? off).tracking, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-tool-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = new BudgetGuard({
    storePath: path.join(dir, "usage.json"),
    env: { OPENAGI_SUBSCRIPTION_TRACKING: "1", OPENAGI_DAILY_USD_LIMIT: "off" }
  });
  guard.record({ input_tokens: 10, output_tokens: 10 }, "kimi-k3", {});

  const live = new ToolRegistry();
  registerCoreTools(live, { budget: guard });
  const on = await live.invoke("quota_status", {}, {});
  const result = on.result ?? on;
  assert.equal(result.tracking, true);
  assert.equal(result.calls, 1);
  assert.equal(result.windowHours, 5);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import {
  BudgetGuard,
  resolveDailyLimit
} from "../src/budget-guard.js";
import { createHostedInterface } from "../src/hosted-interface.js";

function tempGuard(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-budget-limit-"));
  const guard = new BudgetGuard({
    storePath: path.join(dir, "usage.json"),
    ledger: { record() {} },
    ...options
  });
  return { dir, guard };
}

test("resolveDailyLimit accepts positive caps and explicit disabled literals", () => {
  const cases = [
    [undefined, 10],
    ["", 10],
    ["   ", 10],
    [12.5, 12.5],
    ["12.5", 12.5],
    ["off", null],
    ["OFF ", null],
    ["none", null],
    [" unlimited ", null],
    ["disabled", null]
  ];
  for (const [raw, expected] of cases) {
    assert.equal(resolveDailyLimit(raw), expected, String(raw));
  }

  for (const invalid of ["0", "-5", 0, -5, "not-a-number", Infinity, null]) {
    assert.throws(
      () => resolveDailyLimit(invalid),
      (error) => (
        error instanceof TypeError
        && /OPENAGI_DAILY_USD_LIMIT/u.test(error.message)
        && /off/u.test(error.message)
      ),
      String(invalid)
    );
  }
});

test("disabled guard tracks spend across 1000 calls without enforcing a cap", () => {
  const { guard } = tempGuard({ dailyUsdLimit: "off" });
  for (let index = 0; index < 1000; index += 1) {
    const result = guard.record(
      { input_tokens: 1_000_000, output_tokens: 0 },
      "kimi-k3"
    );
    assert.equal(result.limit, null);
  }

  assert.doesNotThrow(() => guard.check());
  const status = guard.status();
  assert.equal(guard.enabled, false);
  assert.equal(status.enabled, false);
  assert.equal(status.dailyUsdLimit, null);
  assert.equal(status.remainingUsd, null);
  assert.equal(status.calls, 1000);
  assert.ok(status.spentUsd > 1000);
});

test("enabled guard still throws at the exact daily boundary", () => {
  const { guard } = tempGuard({ dailyUsdLimit: 3 });
  guard.record(
    { input_tokens: 1_000_000, output_tokens: 0 },
    "kimi-k3"
  );
  assert.throws(
    () => guard.check(),
    (error) => error?.code === "BUDGET_EXCEEDED"
  );
});

test("unpriced model warnings are deduplicated and visible in status", () => {
  const warnings = [];
  const { guard } = tempGuard({ warn: (message) => warnings.push(message) });

  guard.priceFor("future-unknown-model");
  guard.priceFor("future-unknown-model");
  guard.priceFor("future-unknown-model");
  guard.priceFor("gpt-5");
  guard.priceFor("gpt-5-nano-preview");
  guard.priceFor("kimi-k3");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /future-unknown-model/u);
  assert.match(warnings[0], /ESTIMATE/u);
  assert.deepEqual(guard.status().unpricedModels, ["future-unknown-model"]);
});

test("Kimi K3 uses the published Kimi platform rates", () => {
  const { guard } = tempGuard();
  assert.deepEqual(guard.priceFor("kimi-k3"), {
    in: 3,
    out: 15,
    cacheRead: 0.3,
    cacheWrite: 0
  });
});

test("budget limit HTTP toggle validates, applies live, and persists", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-budget-http-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const previousLimit = process.env.OPENAGI_DAILY_USD_LIMIT;
  const previousAuth = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "budget-limit-test-token";
  const runtime = createDefaultRuntime({
    dataDir,
    workspaceDir,
    agentHost: false,
    registerDefaults: false,
    semanticBrowser: false,
    terminals: false,
    budgetOptions: {
      storePath: path.join(dataDir, "budget", "usage.json"),
      dailyUsdLimit: 5
    }
  });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: "budget-limit-test-token",
    channels: {
      start() {},
      stop() {},
      status: () => ({ local: { enabled: true } })
    }
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
    if (previousLimit === undefined) {
      delete process.env.OPENAGI_DAILY_USD_LIMIT;
    } else {
      process.env.OPENAGI_DAILY_USD_LIMIT = previousLimit;
    }
    if (previousAuth === undefined) {
      delete process.env.OPENAGI_AUTH_TOKEN;
    } else {
      process.env.OPENAGI_AUTH_TOKEN = previousAuth;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { url: base } = await app.listen();
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        authorization: "Bearer budget-limit-test-token",
        "x-openagi-project": "default",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    return {
      response,
      body: text ? JSON.parse(text) : null
    };
  };

  const disabled = await request("/budget/limit", {
    method: "POST",
    body: JSON.stringify({ limit: "off" })
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.dailyUsdLimit, null);
  assert.equal(runtime.budget.enabled, false);
  assert.equal(process.env.OPENAGI_DAILY_USD_LIMIT, "off");
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /OPENAGI_DAILY_USD_LIMIT=off/u);

  const enabled = await request("/budget/limit", {
    method: "POST",
    body: JSON.stringify({ limit: 25.5 })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.dailyUsdLimit, 25.5);
  assert.equal(runtime.budget.dailyUsdLimit, 25.5);
  assert.equal(process.env.OPENAGI_DAILY_USD_LIMIT, "25.5");

  const zero = await request("/budget/limit", {
    method: "POST",
    body: JSON.stringify({ limit: 0 })
  });
  assert.equal(zero.response.status, 400);
  let expectedError;
  try {
    resolveDailyLimit(0);
  } catch (error) {
    expectedError = error;
  }
  assert.equal(zero.body.error, expectedError.message);
  assert.equal(runtime.budget.dailyUsdLimit, 25.5);
  assert.equal(process.env.OPENAGI_DAILY_USD_LIMIT, "25.5");

  const dashboard = await fetch(`${base}/`, {
    headers: { authorization: "Bearer budget-limit-test-token" }
  });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /id="budgetLimitInput"/u);
  assert.match(html, /name="budgetLimitMode" value="off"/u);
  assert.match(html, /postJson\("\/budget\/limit"/u);

  const restarted = new BudgetGuard({
    storePath: path.join(root, "restarted", "usage.json"),
    env: { OPENAGI_DAILY_USD_LIMIT: process.env.OPENAGI_DAILY_USD_LIMIT }
  });
  assert.equal(restarted.dailyUsdLimit, 25.5);
});

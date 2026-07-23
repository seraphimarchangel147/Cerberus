import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultRuntime,
  HonchoMemoryProvider,
  isExternalMemoryProvider
} from "../src/index.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function contractProvider() {
  return {
    async getUserModel() {
      return null;
    },
    async setUserModel(model) {
      return model;
    },
    async queryUserModel() {
      return [];
    }
  };
}

function runtimeOptions(overrides = {}) {
  return {
    agentHost: false,
    registerDefaults: false,
    env: {},
    ...overrides
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test("an explicit external memory provider wins without replacing built-in memory", () => {
  const external = contractProvider();
  const warnings = [];
  const runtime = createDefaultRuntime(runtimeOptions({
    env: { OPENAGI_MEMORY_PROVIDER: "not-a-provider" },
    externalMemoryProvider: external,
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));

  assert.strictEqual(runtime.externalMemoryProvider, external);
  assert.equal(isExternalMemoryProvider(runtime.externalMemoryProvider), true);
  assert.deepEqual(warnings, []);

  const item = runtime.memory.remember("Built-in memory remains active.");
  assert.equal(item.content, "Built-in memory remains active.");
  assert.strictEqual(runtime.memory.items.get(item.id), item);
});

test("an explicit null external provider disables env selection", () => {
  const warnings = [];
  const runtime = createDefaultRuntime(runtimeOptions({
    env: {
      OPENAGI_MEMORY_PROVIDER: "honcho",
      HONCHO_API_KEY: "test-key",
      HONCHO_WORKSPACE_ID: "test-workspace"
    },
    externalMemoryProvider: null,
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));

  assert.equal(runtime.externalMemoryProvider, null);
  assert.deepEqual(warnings, []);
});

test("Honcho activates only when selected and configured", () => {
  const disabledWarnings = [];
  const disabled = createDefaultRuntime(runtimeOptions({
    externalMemoryWarningLog: (message) => disabledWarnings.push(message)
  }));
  assert.equal(disabled.externalMemoryProvider, null);
  assert.deepEqual(disabledWarnings, []);
  for (const selection of ["builtin", "built-in", "none"]) {
    const optedOut = createDefaultRuntime(runtimeOptions({
      env: { OPENAGI_MEMORY_PROVIDER: selection },
      externalMemoryWarningLog: (message) => disabledWarnings.push(message)
    }));
    assert.equal(optedOut.externalMemoryProvider, null);
  }
  assert.deepEqual(disabledWarnings, []);

  let fetchCalls = 0;
  const enabled = createDefaultRuntime(runtimeOptions({
    env: {
      OPENAGI_MEMORY_PROVIDER: "honcho",
      HONCHO_API_KEY: "test-key",
      HONCHO_URL: "https://honcho.invalid",
      HONCHO_WORKSPACE_ID: "test-workspace"
    },
    externalMemoryFetch: async () => {
      fetchCalls += 1;
      throw new Error("construction must not perform I/O");
    }
  }));
  assert.ok(enabled.externalMemoryProvider instanceof HonchoMemoryProvider);
  assert.equal(fetchCalls, 0);
});

test("an env-selected Honcho provider augments core memory tools end to end", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    if (path === "/v3/workspaces" || path.endsWith("/peers")) {
      return jsonResponse({ id: body.id });
    }
    if (path.endsWith("/conclusions")) {
      return jsonResponse([{
        id: "conclusion-1",
        content: body.conclusions[0].content,
        observer_id: body.conclusions[0].observer_id,
        observed_id: body.conclusions[0].observed_id
      }]);
    }
    if (path.endsWith("/chat")) {
      return jsonResponse({ content: "The user favors staged rollouts." });
    }
    return jsonResponse({ message: "not found" }, 404);
  };
  const runtime = createDefaultRuntime({
    ...runtimeOptions(),
    registerDefaults: true,
    skills: false,
    env: {
      OPENAGI_MEMORY_PROVIDER: "honcho",
      HONCHO_API_KEY: "test-key",
      HONCHO_URL: "https://honcho.test",
      HONCHO_WORKSPACE_ID: "runtime-test"
    },
    externalMemoryFetch: fetchImpl
  });
  const context = {
    channel: "local",
    from: "operator",
    agentId: "main",
    sessionId: "session-1",
    __memoryScope: "main"
  };

  const remembered = await runtime.tools.invoke(
    "remember",
    { content: "Prefer staged rollouts." },
    context
  );
  const recalled = await runtime.tools.invoke(
    "recall",
    { query: "staged rollouts" },
    context
  );

  assert.equal(remembered.ok, true);
  assert.equal(remembered.result.externalMemory.status, "ok");
  assert.ok(runtime.memory.items.has(remembered.result.id));
  assert.equal(recalled.ok, true);
  assert.equal(recalled.result.externalUserModel, "The user favors staged rollouts.");
  assert.ok(recalled.result.items.some((item) => item.id === remembered.result.id));
  assert.ok(calls.some((call) => call.path.endsWith("/conclusions")));
  assert.ok(calls.some((call) => call.path.endsWith("/chat")));
});

test("unknown or misconfigured selections fail open with an injectable warning", () => {
  const warnings = [];
  const unknown = createDefaultRuntime(runtimeOptions({
    env: { OPENAGI_MEMORY_PROVIDER: "unknown" },
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));
  const missingKey = createDefaultRuntime(runtimeOptions({
    env: { OPENAGI_MEMORY_PROVIDER: "honcho" },
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));
  const brokenWarningSink = createDefaultRuntime(runtimeOptions({
    env: { OPENAGI_MEMORY_PROVIDER: "unknown" },
    externalMemoryWarningLog: () => {
      throw new Error("warning sink failed");
    }
  }));

  assert.equal(unknown.externalMemoryProvider, null);
  assert.equal(missingKey.externalMemoryProvider, null);
  assert.equal(brokenWarningSink.externalMemoryProvider, null);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /external memory disabled.*unknown/iu);
  assert.match(warnings[1], /external memory disabled.*honcho/iu);
  assert.doesNotMatch(warnings.join("\n"), /test-key/iu);
});

test("external-memory configuration warnings never echo untrusted values", () => {
  const secret = "hch-warning-canary-never-log";
  const warnings = [];
  const selectedSecret = createDefaultRuntime(runtimeOptions({
    env: { OPENAGI_MEMORY_PROVIDER: secret },
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));
  const throwingProvider = new Proxy({}, {
    get() {
      throw new Error(secret);
    }
  });
  const invalidExplicit = createDefaultRuntime(runtimeOptions({
    externalMemoryProvider: throwingProvider,
    externalMemoryWarningLog: (message) => warnings.push(message)
  }));

  assert.equal(selectedSecret.externalMemoryProvider, null);
  assert.equal(invalidExplicit.externalMemoryProvider, null);
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join("\n"), new RegExp(secret, "u"));
  assert.match(warnings[0], /unknown provider selection/iu);
  assert.match(warnings[1], /invalid provider contract/iu);
});

test("the setup allowlist includes the external-memory configuration", () => {
  for (const key of [
    "OPENAGI_MEMORY_PROVIDER",
    "HONCHO_API_KEY",
    "HONCHO_URL",
    "HONCHO_WORKSPACE_ID"
  ]) {
    assert.ok(SETUP_FIELDS.includes(key), `${key} must be wizard-persistable`);
  }
});

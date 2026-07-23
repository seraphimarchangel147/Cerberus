import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { renderWizard } from "../src/setup-wizard.js";

function isolateEnv(t, names) {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("setup wizard renders the MoA provider and preset selector", () => {
  const html = renderWizard({
    existingEnv: {
      OPENAGI_PROVIDER: "moa",
      OPENAGI_MOA_PRESET: "research"
    }
  });

  assert.match(html, /name="OPENAGI_PROVIDER" value="moa" checked/);
  assert.match(html, /name="OPENAGI_MOA_PRESET" value="research"/);
});

test("hosted provider API lists and selects MoA presets", async (t) => {
  isolateEnv(t, ["OPENAGI_PROVIDER", "OPENAGI_MOA_PRESET"]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-moa-hosted-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, "moa.json"),
    JSON.stringify({
      research: {
        aggregator: "openai/gpt-aggregator",
        references: ["anthropic/claude-reference"]
      }
    }),
    "utf8"
  );

  const runtime = createDurableRuntime({ dataDir });
  const originalProvider = {
    provider: "openai",
    model: "gpt-test",
    isConfigured: () => true
  };
  runtime.agentHost = {
    runtime,
    modelProvider: originalProvider,
    handleMessage: async () => ({
      session: { id: "hosted-moa-test" },
      agent: { id: "main" },
      reply: "test",
      output: null
    }),
    status: () => ({
      provider: "OpenAI",
      providerConfigured: true,
      providerModel: "gpt-test",
      agents: [],
      sessions: []
    })
  };
  const selected = {
    provider: "moa",
    name: "moa",
    model: "research",
    availableModels: () => ["research"],
    isConfigured: () => true
  };
  const factoryCalls = [];
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: "test-token",
    channels: {
      start() {},
      stop() {},
      status: () => ({})
    },
    modelProviderFactory(options) {
      factoryCalls.push(options);
      return selected;
    }
  });
  const address = await app.listen();
  const headers = { authorization: "Bearer test-token" };

  try {
    const beforeResponse = await fetch(`${address.url}/admin/provider`, { headers });
    const before = await beforeResponse.json();
    assert.equal(beforeResponse.status, 200);
    assert.deepEqual(before.moaPresets, ["research"]);
    assert.equal(before.available.moa, true);

    const selectResponse = await fetch(`${address.url}/admin/provider`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json"
      },
      body: JSON.stringify({ preference: "moa", preset: "research" })
    });
    const selectedBody = await selectResponse.json();

    assert.equal(selectResponse.status, 200);
    assert.equal(factoryCalls[0].preferred, "moa");
    assert.equal(factoryCalls[0].moa.preset, "research");
    assert.equal(runtime.agentHost.modelProvider, selected);
    assert.equal(selectedBody.preference, "moa");
    assert.equal(selectedBody.moaPreset, "research");
    assert.equal(process.env.OPENAGI_PROVIDER, "moa");
    assert.equal(process.env.OPENAGI_MOA_PRESET, "research");
    assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /^OPENAGI_MOA_PRESET=research$/m);
  } finally {
    await app.close();
  }
});

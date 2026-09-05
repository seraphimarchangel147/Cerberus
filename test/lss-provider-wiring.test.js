// O2b wiring: with OPENAGI_LSS=1 the provider constructors resolve key
// material through the destination-pinned LSS adapter and FAIL CONSTRUCTION
// on a denied destination. Flag off = byte-identical pre-LSS env behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore } from "../src/secrets-store.js";
import { AnthropicProvider, OpenAIResponsesProvider } from "../src/model-provider.js";

const KEY_VALUE = "sk-ant-livekey-0123456789abcdef0123456789abcdef01234567";
const OPENAI_KEY_VALUE = "sk-openai-livekey-0123456789abcdef0123456789abcdef";

function fixture(t, { destinations = ["api.anthropic.com"], openaiDestinations = ["api.openai.com"] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lss-wire-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({
    dataDir,
    allowlist: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    env: {}
  });
  store.setSecret("ANTHROPIC_API_KEY", KEY_VALUE, { decidedBy: "test:fixture", destinations });
  store.setSecret("OPENAI_API_KEY", OPENAI_KEY_VALUE, { decidedBy: "test:fixture", destinations: openaiDestinations });
  return { dataDir, store };
}

function withEnv(t, patch) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("LSS on: matching destination resolves through the store, not env", (t) => {
  const { store } = fixture(t);
  withEnv(t, { ANTHROPIC_API_KEY: "sk-env-should-not-be-used-0123456789abcdef" });
  const provider = new AnthropicProvider({ secretsStore: store, env: { OPENAGI_LSS: "1" } });
  assert.equal(provider.apiKey, KEY_VALUE, "store material wins over ambient env under LSS");
});

test("LSS on: denied destination fails construction with typed error", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => new AnthropicProvider({
      secretsStore: store,
      baseUrl: "https://evil-anthropic.example.com/v1",
      env: { OPENAGI_LSS: "1" }
    }),
    (error) => error.code === "LSS_DESTINATION_DENIED"
      && !error.message.includes(KEY_VALUE)
  );
});

test("LSS on: OpenAI lane enforces pinning against its own baseUrl", (t) => {
  const { store } = fixture(t, { openaiDestinations: ["api.moonshot.ai"] });
  const ok = new OpenAIResponsesProvider({
    secretsStore: store,
    baseUrl: "https://api.moonshot.ai/v1",
    env: { OPENAGI_LSS: "1" }
  });
  assert.equal(ok.apiKey, OPENAI_KEY_VALUE);
  assert.throws(
    () => new OpenAIResponsesProvider({ secretsStore: store, env: { OPENAGI_LSS: "1" } }),
    (error) => error.code === "LSS_DESTINATION_DENIED",
    "default api.openai.com is denied when key is pinned to moonshot"
  );
});

test("LSS on: no store wired -> ambient env fallback still works", (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: KEY_VALUE });
  const provider = new AnthropicProvider({ env: { OPENAGI_LSS: "1" } });
  assert.equal(provider.apiKey, KEY_VALUE);
});

test("LSS on: store missing the key denies (NO ambient fallback for material)", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lss-wire-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({ dataDir, allowlist: ["ANTHROPIC_API_KEY"], env: {} });
  withEnv(t, { ANTHROPIC_API_KEY: KEY_VALUE });
  assert.throws(
    () => new AnthropicProvider({ secretsStore: store, env: { OPENAGI_LSS: "1" } }),
    (error) => error.code === "LSS_SCOPE_DENIED",
    "SPEC §2: LSS path must never fall back to process.env for material"
  );
});

test("LSS off: pre-LSS behavior is byte-identical (env wins, store ignored)", (t) => {
  const { store } = fixture(t);
  withEnv(t, { ANTHROPIC_API_KEY: "sk-env-value-0123456789abcdef0123456789" });
  const provider = new AnthropicProvider({ secretsStore: store, env: {} });
  assert.equal(provider.apiKey, "sk-env-value-0123456789abcdef0123456789");
  // Even a hostile store pin is irrelevant with the flag off.
  const hostile = new AnthropicProvider({
    secretsStore: store,
    baseUrl: "https://evil.example.com/v1",
    env: {}
  });
  assert.equal(hostile.apiKey, "sk-env-value-0123456789abcdef0123456789");
});

test("LSS on: explicit options.apiKey bypasses resolution (caller's responsibility)", (t) => {
  const { store } = fixture(t);
  const explicit = "sk-explicit-0123456789abcdef0123456789abcdef01";
  const provider = new AnthropicProvider({
    secretsStore: store,
    apiKey: explicit,
    baseUrl: "https://evil.example.com/v1",
    env: { OPENAGI_LSS: "1" }
  });
  assert.equal(provider.apiKey, explicit);
});

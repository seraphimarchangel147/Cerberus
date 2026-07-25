// Provider presets: the (baseUrl, apiKey, model) seam that lets one
// OpenAI-compatible lane serve xAI, OpenRouter, Moonshot, Groq, and Nous.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_PRESET_IDS,
  listProviderPresets,
  getProviderPreset,
  isProviderPresetId,
  presetEnvKeys,
  presetIsConfigured,
  presetActivationEnv,
  activeProviderPreset
} from "../src/provider-presets.js";

test("every preset targets a real native lane", () => {
  for (const preset of listProviderPresets()) {
    assert.ok(
      preset.lane === "anthropic" || preset.lane === "openai",
      `${preset.id} must ride a native lane, got ${preset.lane}`
    );
    assert.match(preset.baseUrl, /^https:\/\//u, `${preset.id} baseUrl must be https`);
    assert.ok(preset.models.includes(preset.defaultModel), `${preset.id} default model must be listed`);
    assert.ok(preset.keyEnv.endsWith("_API_KEY"), `${preset.id} keyEnv should name an API key`);
  }
});

test("the Creator's requested vendors are all present", () => {
  for (const id of ["anthropic", "openai", "xai", "openrouter", "moonshot"]) {
    assert.ok(PROVIDER_PRESET_IDS.includes(id), `missing requested provider: ${id}`);
  }
});

test("xAI is an API-key vendor, not an OAuth one", () => {
  // Regression against the Ziz mistake: wiring xai as xai-oauth produces a
  // provider that can never authenticate.
  assert.equal(getProviderPreset("xai").oauth, false);
  assert.equal(getProviderPreset("xai").keyEnv, "XAI_API_KEY");
});

test("unknown preset ids are rejected rather than silently defaulted", () => {
  assert.equal(isProviderPresetId("nope"), false);
  assert.throws(() => getProviderPreset("nope"), /Unknown provider preset/u);
});

test("activation points the OpenAI lane at the vendor base url and model", () => {
  const patch = presetActivationEnv("xai", { env: { XAI_API_KEY: "sk-test" } });
  assert.equal(patch.OPENAGI_PROVIDER, "openai");
  assert.equal(patch.OPENAI_BASE_URL, "https://api.x.ai/v1");
  assert.equal(patch.OPENAI_MODEL, "grok-4");
  assert.equal(patch.OPENAI_API_KEY, "sk-test");
  assert.ok(!("ANTHROPIC_BASE_URL" in patch), "must not touch the other lane");
});

test("activation on the anthropic lane uses anthropic env names", () => {
  const patch = presetActivationEnv("anthropic", { env: { ANTHROPIC_API_KEY: "sk-a" } });
  assert.equal(patch.OPENAGI_PROVIDER, "anthropic");
  assert.equal(patch.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1");
  assert.ok(!("OPENAI_BASE_URL" in patch));
});

test("activation never invents a key when the vendor env is empty", () => {
  const patch = presetActivationEnv("openrouter", { env: {} });
  assert.ok(!("OPENAI_API_KEY" in patch), "must not write a blank or fabricated key");
  assert.equal(patch.OPENAI_BASE_URL, "https://openrouter.ai/api/v1");
});

test("an explicit model override is honored", () => {
  const patch = presetActivationEnv("moonshot", { model: "kimi-k2-turbo-preview", env: {} });
  assert.equal(patch.OPENAI_MODEL, "kimi-k2-turbo-preview");
});

test("presetIsConfigured sees both the vendor key and an activated lane", () => {
  assert.equal(presetIsConfigured("xai", {}), false);
  assert.equal(presetIsConfigured("xai", { XAI_API_KEY: "sk" }), true);
  // Already activated: lane key present and lane base points at the vendor.
  assert.equal(
    presetIsConfigured("xai", { OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "https://api.x.ai/v1/" }),
    true
  );
  // Lane key present but aimed elsewhere is NOT this preset being configured.
  assert.equal(
    presetIsConfigured("xai", { OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "https://api.openai.com/v1" }),
    false
  );
});

test("activeProviderPreset reports where the lane currently points", () => {
  assert.equal(
    activeProviderPreset({ OPENAGI_PROVIDER: "openai", OPENAI_BASE_URL: "https://api.x.ai/v1" }),
    "xai"
  );
  assert.equal(
    activeProviderPreset({ OPENAGI_PROVIDER: "openai", OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }),
    "openrouter"
  );
  // Bare lane with no base url is the vendor's own default.
  assert.equal(activeProviderPreset({ OPENAGI_PROVIDER: "anthropic" }), "anthropic");
  assert.equal(activeProviderPreset({ OPENAGI_PROVIDER: "openai" }), "openai");
});

test("presetEnvKeys covers the vendor key and the lane it drives", () => {
  const keys = presetEnvKeys("openrouter");
  assert.ok(keys.includes("OPENROUTER_API_KEY"));
  assert.ok(keys.includes("OPENAI_BASE_URL"));
  assert.ok(!keys.includes("ANTHROPIC_API_KEY"));
});

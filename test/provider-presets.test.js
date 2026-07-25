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

test("the production Kimi coding lane is recognized, not reported as 'none'", () => {
  // Regression: Azazel runs kimi-k3 over the ANTHROPIC protocol at
  // api.kimi.com/coding/v1. Before this preset existed the Models tab showed
  // active:null while plainly serving that model.
  const live = {
    OPENAGI_PROVIDER: "anthropic",
    ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/v1",
    ANTHROPIC_MODEL: "kimi-k3"
  };
  assert.equal(activeProviderPreset(live), "kimi-coding");
  const preset = getProviderPreset("kimi-coding");
  assert.equal(preset.lane, "anthropic");
  assert.ok(preset.models.includes("kimi-k3"));
});

test("two presets may share a vendor key without colliding", () => {
  // moonshot (OpenAI protocol) and kimi-coding (Anthropic protocol) are the
  // same vendor on different lanes and intentionally share MOONSHOT_API_KEY.
  assert.equal(getProviderPreset("moonshot").keyEnv, getProviderPreset("kimi-coding").keyEnv);
  const openaiSide = presetActivationEnv("moonshot", { env: { MOONSHOT_API_KEY: "sk-m" } });
  const anthropicSide = presetActivationEnv("kimi-coding", { env: { MOONSHOT_API_KEY: "sk-m" } });
  assert.equal(openaiSide.OPENAGI_PROVIDER, "openai");
  assert.equal(anthropicSide.OPENAGI_PROVIDER, "anthropic");
  assert.equal(anthropicSide.ANTHROPIC_MODEL, "kimi-k3");
});

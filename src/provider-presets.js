// Provider presets.
//
// The harness ships two NATIVE provider classes: AnthropicProvider (Messages
// API) and OpenAIResponsesProvider (Responses API). Every other vendor the
// Creator asked for — xAI, OpenRouter, Moonshot/Kimi, Together, Groq, Nous —
// speaks an OpenAI-compatible protocol, so they are not new provider classes.
// They are a (baseUrl, apiKey, model) triple pointed at the existing OpenAI
// lane. That is the whole seam.
//
// This module is the single source of truth for that mapping so the dashboard,
// the Discord /provider command, and the setup wizard all offer the same list
// instead of each hard-coding their own.

/**
 * @typedef {Object} ProviderPreset
 * @property {string} id            Stable slug used in URLs, env, and commands.
 * @property {string} label         Human name for the dashboard/Discord.
 * @property {"anthropic"|"openai"} lane  Which native provider class serves it.
 * @property {string} baseUrl       API base the lane should point at.
 * @property {string} keyEnv        Env/secret name holding this vendor's key.
 * @property {string} defaultModel  Sensible default model id.
 * @property {string[]} models      Suggested model ids for the picker.
 * @property {string} keyUrl        Where a human goes to mint a key.
 * @property {boolean} oauth        Whether an OAuth login flow exists.
 * @property {string} note          One-line explanation for the UI.
 */

const PRESET_LIST = Object.freeze([
  {
    id: "anthropic",
    label: "Anthropic",
    lane: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    oauth: true,
    note: "Native Messages API lane. Prompt caching and the cache_control marker only work here."
  },
  {
    id: "openai",
    label: "OpenAI",
    lane: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5",
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
    keyUrl: "https://platform.openai.com/api-keys",
    oauth: true,
    note: "Native Responses API lane, including reasoning-item continuation."
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    lane: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    defaultModel: "grok-4",
    models: ["grok-4", "grok-4-fast", "grok-code-fast-1"],
    keyUrl: "https://console.x.ai",
    oauth: false,
    // Learned the hard way on Ziz: xAI is an API-KEY provider. Do not wire it
    // as an OAuth vendor — there is no consumer OAuth app to authorize against.
    note: "OpenAI-compatible. API key only — xAI has no OAuth flow for API access."
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    lane: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4.5",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5",
      "moonshotai/kimi-k2",
      "deepseek/deepseek-chat"
    ],
    keyUrl: "https://openrouter.ai/keys",
    oauth: true,
    // provider-routing.js already recognizes openrouter.ai as a routing
    // endpoint, so OPENAGI_PROVIDER_ROUTING is honored on this preset.
    note: "One key, many models. Honors OPENAGI_PROVIDER_ROUTING for upstream preference."
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    lane: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    keyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2-0905-preview",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-128k"],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    oauth: false,
    note: "OpenAI-compatible. The lane Azazel already runs on in production."
  },
  {
    id: "groq",
    label: "Groq",
    lane: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "qwen-2.5-32b"],
    keyUrl: "https://console.groq.com/keys",
    oauth: false,
    note: "OpenAI-compatible, very low latency — a good fit for the nano tier."
  },
  {
    id: "nous",
    label: "Nous Research",
    lane: "openai",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    keyEnv: "NOUS_API_KEY",
    defaultModel: "Hermes-4-405B",
    models: ["Hermes-4-405B", "Hermes-4-70B"],
    keyUrl: "https://portal.nousresearch.com",
    oauth: true,
    note: "OpenAI-compatible. Also a recognized provider-routing endpoint."
  }
]);

const PRESETS_BY_ID = Object.freeze(
  Object.fromEntries(PRESET_LIST.map((preset) => [preset.id, preset]))
);

export const PROVIDER_PRESET_IDS = Object.freeze(PRESET_LIST.map((preset) => preset.id));

/** Every preset, in display order. */
export function listProviderPresets() {
  return PRESET_LIST.map((preset) => ({ ...preset, models: [...preset.models] }));
}

export function isProviderPresetId(value) {
  return Object.hasOwn(PRESETS_BY_ID, String(value ?? "").trim().toLowerCase());
}

export function getProviderPreset(id) {
  const key = String(id ?? "").trim().toLowerCase();
  const preset = PRESETS_BY_ID[key];
  if (!preset) throw new Error(`Unknown provider preset: ${key || "(empty)"}`);
  return { ...preset, models: [...preset.models] };
}

/** Env names a preset owns, so a UI can show/clear exactly the right keys. */
export function presetEnvKeys(id) {
  const preset = getProviderPreset(id);
  const laneEnv = preset.lane === "anthropic"
    ? ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL"]
    : ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"];
  return Object.freeze([...new Set([preset.keyEnv, ...laneEnv])]);
}

/**
 * Whether a preset is usable right now: its own key env, or the lane key when
 * the lane is already pointed at this preset's baseUrl (the activated case).
 */
export function presetIsConfigured(id, env = process.env) {
  const preset = getProviderPreset(id);
  if (String(env[preset.keyEnv] ?? "").trim()) return true;
  const laneKey = preset.lane === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const laneBase = preset.lane === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  return Boolean(
    String(env[laneKey] ?? "").trim()
    && normalizeBaseUrl(env[laneBase]) === normalizeBaseUrl(preset.baseUrl)
  );
}

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/u, "").toLowerCase();
}

/**
 * The env patch that ACTIVATES a preset — what the dashboard/Discord writes.
 *
 * Deliberately returns a plain object rather than mutating process.env: the
 * caller persists it through SecretsStore/saveEnv, which owns redaction and
 * the audit trail. A preset never carries a literal key; the key comes from
 * the vendor env var the operator already stored.
 *
 * @param {string} id
 * @param {{ model?: string, env?: Record<string,string> }} [opts]
 */
export function presetActivationEnv(id, { model, env = process.env } = {}) {
  const preset = getProviderPreset(id);
  const chosenModel = String(model ?? "").trim() || preset.defaultModel;
  if (!preset.models.includes(chosenModel) && !model) {
    // defaultModel should always be in models; guard against a bad edit.
    throw new Error(`Preset ${preset.id} has a default model outside its model list.`);
  }
  const vendorKey = String(env[preset.keyEnv] ?? "").trim();
  const patch = { OPENAGI_PROVIDER: preset.lane };
  if (preset.lane === "anthropic") {
    patch.ANTHROPIC_BASE_URL = preset.baseUrl;
    patch.ANTHROPIC_MODEL = chosenModel;
    if (vendorKey) patch.ANTHROPIC_API_KEY = vendorKey;
  } else {
    patch.OPENAI_BASE_URL = preset.baseUrl;
    patch.OPENAI_MODEL = chosenModel;
    if (vendorKey) patch.OPENAI_API_KEY = vendorKey;
  }
  return patch;
}

/** Which preset the CURRENT env resolves to, for "you are here" in the UI. */
export function activeProviderPreset(env = process.env) {
  const lane = String(env.OPENAGI_PROVIDER ?? "auto").trim().toLowerCase();
  const laneBase = lane === "anthropic"
    ? normalizeBaseUrl(env.ANTHROPIC_BASE_URL)
    : normalizeBaseUrl(env.OPENAI_BASE_URL);
  const candidates = PRESET_LIST.filter((preset) => preset.lane === lane || lane === "auto");
  const matched = candidates.find((preset) => normalizeBaseUrl(preset.baseUrl) === laneBase);
  if (matched) return matched.id;
  // No explicit baseUrl means the lane's own default vendor.
  if (!laneBase && (lane === "anthropic" || lane === "openai")) return lane;
  return null;
}

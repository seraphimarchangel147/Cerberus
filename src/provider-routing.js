import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile } from "./file-utils.js";

export const PROVIDER_ROUTING_SORT_VALUES = Object.freeze([
  "price",
  "throughput",
  "latency"
]);
export const PROVIDER_ROUTING_DATA_COLLECTION_VALUES = Object.freeze([
  "allow",
  "deny"
]);
export const PROVIDER_ROUTING_MAX_LIST_ENTRIES = 64;
export const PROVIDER_ROUTING_MAX_SLUG_LENGTH = 128;

const ALLOWED_FIELDS = new Set([
  "sort",
  "only",
  "ignore",
  "order",
  "require_parameters",
  "data_collection"
]);
const SORT_VALUES = new Set(PROVIDER_ROUTING_SORT_VALUES);
const DATA_COLLECTION_VALUES = new Set(
  PROVIDER_ROUTING_DATA_COLLECTION_VALUES
);
const PROVIDER_SLUG_RE =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/u;

/**
 * Validate and copy the provider-routing request block.
 *
 * A nullish or empty object means routing is disabled. Optional null
 * data_collection is also treated as unset so no empty provider object is
 * sent to an upstream API.
 */
export function normalizeProviderRouting(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value)) {
    throw new TypeError("Provider routing config must be a plain JSON object.");
  }
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !ALLOWED_FIELDS.has(key)
    )
  ) {
    throw new TypeError(
      "Provider routing config contains an unsupported field."
    );
  }

  const normalized = {};
  if (Object.hasOwn(value, "sort")) {
    if (typeof value.sort !== "string" || !SORT_VALUES.has(value.sort)) {
      throw new TypeError(
        "Provider routing sort must be price, throughput, or latency."
      );
    }
    normalized.sort = value.sort;
  }
  if (Object.hasOwn(value, "only")) {
    normalized.only = normalizeProviderList(value.only, "only");
  }
  if (Object.hasOwn(value, "ignore")) {
    normalized.ignore = normalizeProviderList(value.ignore, "ignore");
  }
  if (Object.hasOwn(value, "order")) {
    normalized.order = normalizeProviderList(value.order, "order");
  }
  if (Object.hasOwn(value, "require_parameters")) {
    if (typeof value.require_parameters !== "boolean") {
      throw new TypeError(
        "Provider routing require_parameters must be a boolean."
      );
    }
    normalized.require_parameters = value.require_parameters;
  }
  if (
    Object.hasOwn(value, "data_collection")
    && value.data_collection !== null
  ) {
    if (
      typeof value.data_collection !== "string"
      || !DATA_COLLECTION_VALUES.has(value.data_collection)
    ) {
      throw new TypeError(
        "Provider routing data_collection must be allow, deny, or null."
      );
    }
    normalized.data_collection = value.data_collection;
  }

  return Object.keys(normalized).length === 0
    ? null
    : Object.freeze(normalized);
}

/**
 * Load one routing block using deterministic precedence:
 * explicit providerRouting, then OPENAGI_PROVIDER_ROUTING JSON, then
 * <dataDir>/config.json's provider_routing field.
 *
 * Presence of the explicit property is intentional, including nullish and
 * empty values, so callers can disable inherited configuration.
 */
export function loadProviderRoutingConfig(options = {}) {
  if (!isPlainRecord(options)) {
    throw new TypeError("Provider routing load options must be an object.");
  }
  if (Object.hasOwn(options, "providerRouting")) {
    return normalizeProviderRouting(options.providerRouting);
  }

  const env = options.env ?? process.env;
  if (env !== null && typeof env !== "object") {
    throw new TypeError("Provider routing environment must be an object.");
  }
  const envValue = env?.OPENAGI_PROVIDER_ROUTING;
  if (typeof envValue === "string" && envValue.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(envValue);
    } catch {
      throw new TypeError(
        "OPENAGI_PROVIDER_ROUTING must contain valid JSON."
      );
    }
    return normalizeProviderRouting(parsed);
  }
  if (envValue !== undefined && envValue !== null && envValue !== "") {
    throw new TypeError(
      "OPENAGI_PROVIDER_ROUTING must contain valid JSON."
    );
  }

  const dataDir = options.dataDir ?? resolveDataDir();
  const configPath = path.join(dataDir, "config.json");
  let config;
  try {
    config = readJsonFile(configPath, null);
  } catch {
    throw new TypeError("OpenAGI config.json must contain valid JSON.");
  }
  if (config === null) return null;
  if (!isPlainRecord(config)) {
    throw new TypeError("OpenAGI config.json must contain a JSON object.");
  }
  if (!Object.hasOwn(config, "provider_routing")) return null;
  return normalizeProviderRouting(config.provider_routing);
}

/**
 * Return true only for official OpenRouter or Nous Portal routing endpoints.
 * Hostname parsing and label-boundary checks prevent lookalike domains.
 */
export function isProviderRoutingEndpoint(baseUrl) {
  let endpoint;
  try {
    endpoint = baseUrl instanceof URL
      ? baseUrl
      : new URL(String(baseUrl ?? ""));
  } catch {
    return false;
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.port !== ""
    || endpoint.username
    || endpoint.password
  ) {
    return false;
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
  return hostname === "openrouter.ai"
    || hostname.endsWith(".openrouter.ai")
    || hostname === "inference-api.nousresearch.com";
}

/**
 * Attach normalized routing as the upstream top-level provider field.
 * Direct provider endpoints are a true no-op.
 */
export function applyProviderRouting(body, { baseUrl, routing } = {}) {
  if (!isPlainRecord(body)) {
    throw new TypeError("Provider request body must be a plain object.");
  }
  if (!isProviderRoutingEndpoint(baseUrl)) return body;
  const normalized = normalizeProviderRouting(routing);
  if (normalized === null) return body;
  return {
    ...body,
    provider: normalized
  };
}

function normalizeProviderList(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`Provider routing ${field} must be an array.`);
  }
  if (value.length > PROVIDER_ROUTING_MAX_LIST_ENTRIES) {
    throw new TypeError(
      `Provider routing ${field} accepts at most ${PROVIDER_ROUTING_MAX_LIST_ENTRIES} entries.`
    );
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      throw new TypeError(
        `Provider routing ${field} entry ${index + 1} must be a string.`
      );
    }
    const slug = value[index].trim().toLowerCase();
    if (
      slug.length === 0
      || slug.length > PROVIDER_ROUTING_MAX_SLUG_LENGTH
      || !PROVIDER_SLUG_RE.test(slug)
    ) {
      throw new TypeError(
        `Provider routing ${field} entry ${index + 1} is not a valid provider slug.`
      );
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    normalized.push(slug);
  }
  return Object.freeze(normalized);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

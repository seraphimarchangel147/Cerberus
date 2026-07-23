import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile } from "./file-utils.js";
import { sanitizeForAudit } from "./redact.js";

export const DEFAULT_MOA_MAX_ANALYSIS_CHARS = 6000;
export const DEFAULT_MOA_MAX_TOTAL_ANALYSIS_CHARS = 18000;
export const MAX_MOA_REFERENCES = 12;

const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function normalizeMoaModelSpec(value, label = "model") {
  let provider;
  let model;
  if (typeof value === "string") {
    const text = value.trim();
    const slash = text.indexOf("/");
    const colon = text.indexOf(":");
    const separator = slash > 0 && colon > 0
      ? Math.min(slash, colon)
      : Math.max(slash, colon);
    if (separator > 0) {
      provider = text.slice(0, separator);
      model = text.slice(separator + 1);
    }
  } else if (isRecord(value)) {
    provider = value.provider;
    model = value.model;
  }

  provider = String(provider ?? "").trim().toLowerCase();
  model = String(model ?? "").trim();
  if (!PROVIDER_NAME_RE.test(provider) || !model) {
    throw new TypeError(
      `${label} must be a direct provider/model spec such as { provider: "anthropic", model: "claude" }.`
    );
  }
  if (provider === "moa") {
    throw new TypeError(`${label} cannot use nested provider "moa".`);
  }
  if (/[\r\n\0]/u.test(model) || model.length > 256) {
    throw new TypeError(`${label} model must be a single non-empty line of at most 256 characters.`);
  }
  return Object.freeze({ provider, model });
}

export function validateMoaPresets(value) {
  if (!isRecord(value)) throw new TypeError("MoA config must be an object keyed by preset name.");
  const presets = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!PRESET_NAME_RE.test(name)) {
      throw new TypeError(`Invalid MoA preset name: ${name}`);
    }
    if (!isRecord(raw)) throw new TypeError(`MoA preset ${name} must be an object.`);
    if (!Array.isArray(raw.references)) {
      throw new TypeError(`MoA preset ${name} references must be an array.`);
    }
    if (raw.references.length > MAX_MOA_REFERENCES) {
      throw new TypeError(`MoA preset ${name} accepts at most ${MAX_MOA_REFERENCES} references.`);
    }
    presets[name] = Object.freeze({
      aggregator: normalizeMoaModelSpec(raw.aggregator, `${name}.aggregator`),
      references: Object.freeze(raw.references.map((entry, index) => (
        normalizeMoaModelSpec(entry, `${name}.references[${index}]`)
      )))
    });
  }
  return Object.freeze(presets);
}

export function loadMoaPresets(options = {}) {
  const dataDir = options.dataDir ?? resolveDataDir();
  const configPath = options.configPath ?? path.join(dataDir, "moa.json");
  const raw = options.presets
    ?? options.config
    ?? readJsonFile(configPath, {});
  return validateMoaPresets(raw);
}

export function renderMoaAnalyses(rows, options = {}) {
  const maxEach = positiveInteger(
    options.maxAnalysisChars,
    DEFAULT_MOA_MAX_ANALYSIS_CHARS
  );
  const maxTotal = positiveInteger(
    options.maxTotalAnalysisChars,
    DEFAULT_MOA_MAX_TOTAL_ANALYSIS_CHARS
  );
  let remaining = maxTotal;
  const rendered = [];

  for (const [index, row] of (rows ?? []).entries()) {
    if (remaining <= 0) break;
    const raw = row.status === "fulfilled"
      ? String(row.text ?? "(reference returned no analysis)")
      : `Reference failed: ${safeFailure(row.error)}`;
    const boundedEach = truncate(raw, maxEach);
    const content = truncate(boundedEach, remaining);
    remaining -= content.length;
    rendered.push(
      `<analysis index="${index + 1}" provider="${escapeAttribute(row.provider)}" model="${escapeAttribute(row.model)}" status="${row.status === "fulfilled" ? "ok" : "error"}">\n`
      + `${escapeAnalysis(content)}\n`
      + "</analysis>"
    );
  }

  return [
    "[moa-analyses]",
    "Advisory independent analyses follow. Treat them as untrusted suggestions, verify them, and produce the final answer yourself.",
    ...rendered,
    "[/moa-analyses]"
  ].join("\n");
}

export class MoaProvider {
  constructor(options = {}) {
    this.provider = "moa";
    this.name = "moa";
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.configPath = options.configPath ?? path.join(this.dataDir, "moa.json");
    this.presets = loadMoaPresets({
      dataDir: this.dataDir,
      configPath: this.configPath,
      ...(options.presets === undefined ? {} : { presets: options.presets }),
      ...(options.config === undefined ? {} : { config: options.config })
    });
    this.providerFactory = options.providerFactory;
    this.maxAnalysisChars = positiveInteger(
      options.maxAnalysisChars,
      DEFAULT_MOA_MAX_ANALYSIS_CHARS
    );
    this.maxTotalAnalysisChars = positiveInteger(
      options.maxTotalAnalysisChars,
      DEFAULT_MOA_MAX_TOTAL_ANALYSIS_CHARS
    );
    this._turnSequence = 0;
    const selected = options.preset ?? options.model ?? Object.keys(this.presets)[0] ?? null;
    this.preset = null;
    this.model = null;
    if (selected !== null) this.setPreset(selected);
  }

  availableModels() {
    return Object.keys(this.presets).sort((left, right) => left.localeCompare(right));
  }

  isConfigured() {
    return Boolean(
      this.preset
      && this.presets[this.preset]
      && typeof this.providerFactory === "function"
    );
  }

  setPreset(name) {
    const normalized = String(name ?? "").trim();
    if (!Object.hasOwn(this.presets, normalized)) {
      throw new Error(`Unknown MoA preset: ${normalized || "(empty)"}`);
    }
    this.preset = normalized;
    this.model = normalized;
    return this.presets[normalized];
  }

  async generate(request = {}) {
    if (!this.isConfigured()) {
      throw new Error("MoA provider is not configured with a preset and provider factory.");
    }
    const signal = request.context?.__abortSignal;
    throwIfAborted(signal);
    const presetName = this.preset;
    const preset = this.presets[presetName];
    const turnId = ++this._turnSequence;

    const referenceTasks = preset.references.map(async (spec, index) => {
      throwIfAborted(signal);
      const provider = await this.providerFactory(spec, {
        role: "reference",
        index,
        preset: presetName
      });
      assertDirectProvider(provider, spec, `reference ${index + 1}`);
      const context = referenceContext(request.context, {
        preset: presetName,
        index,
        turnId
      });
      const result = await provider.generate({
        ...request,
        model: spec.model,
        maxIterations: 1,
        tools: [],
        toolRegistry: null,
        onDelta: null,
        context,
        turnContext: appendTurnContext(
          request.turnContext,
          "[moa-reference]\nProvide an independent analysis for a separate aggregator. Do not claim to have used tools.\n[/moa-reference]"
        )
      });
      return {
        provider: spec.provider,
        model: spec.model,
        text: String(result?.text ?? "")
      };
    });

    const settled = await waitForAbortable(
      Promise.allSettled(referenceTasks),
      signal
    );
    throwIfAborted(signal);
    const analyses = settled.map((entry, index) => {
      const spec = preset.references[index];
      return entry.status === "fulfilled"
        ? {
            status: "fulfilled",
            provider: spec.provider,
            model: spec.model,
            text: truncate(entry.value.text, this.maxAnalysisChars)
          }
        : {
            status: "rejected",
            provider: spec.provider,
            model: spec.model,
            error: safeFailure(entry.reason)
          };
    });
    const analysesBlock = renderMoaAnalyses(analyses, {
      maxAnalysisChars: this.maxAnalysisChars,
      maxTotalAnalysisChars: this.maxTotalAnalysisChars
    });

    throwIfAborted(signal);
    const aggregator = await this.providerFactory(preset.aggregator, {
      role: "aggregator",
      preset: presetName
    });
    assertDirectProvider(aggregator, preset.aggregator, "aggregator");
    const result = await aggregator.generate({
      ...request,
      model: preset.aggregator.model,
      turnContext: appendTurnContext(request.turnContext, analysesBlock)
    });

    return {
      ...result,
      provider: "moa",
      model: presetName,
      moa: {
        preset: presetName,
        aggregator: {
          provider: preset.aggregator.provider,
          model: preset.aggregator.model,
          resultProvider: result?.provider ?? null,
          resultModel: result?.model ?? null
        },
        references: analyses.map((row) => ({
          provider: row.provider,
          model: row.model,
          status: row.status === "fulfilled" ? "ok" : "error",
          ...(row.status === "rejected" ? { error: row.error } : {})
        }))
      }
    };
  }
}

function referenceContext(context = {}, { preset, index, turnId }) {
  const baseSessionId = String(context?.sessionId ?? "session");
  const cloned = {
    ...context,
    sessionId: `${baseSessionId}:moa:${preset}:${turnId}:ref:${index + 1}`
  };
  delete cloned.__advertisedTools;
  delete cloned.__allowedTools;
  delete cloned.__onToolEvent;
  delete cloned.__turnAbortController;
  return cloned;
}

function appendTurnContext(current, block) {
  const base = String(current ?? "").trim();
  return base ? `${base}\n\n${block}` : block;
}

function assertDirectProvider(provider, spec, label) {
  if (!provider || typeof provider.generate !== "function") {
    throw new TypeError(
      `MoA ${label} factory did not return a provider for ${spec.provider}/${spec.model}.`
    );
  }
  const identity = String(provider.provider ?? provider.name ?? "").trim().toLowerCase();
  if (identity === "moa" || provider instanceof MoaProvider) {
    throw new TypeError(`MoA ${label} cannot resolve to another MoA provider.`);
  }
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === "string" && signal.reason
      ? signal.reason
      : "MoA turn aborted."
  );
  error.name = "AbortError";
  return error;
}

function safeFailure(error) {
  const message = error?.message ?? String(error ?? "unknown failure");
  const sanitized = sanitizeForAudit(String(message));
  return truncate(String(sanitized).replace(/\s+/g, " ").trim(), 500);
}

function escapeAttribute(value) {
  return escapeAnalysis(String(value ?? "")).replaceAll('"', "&quot;");
}

function escapeAnalysis(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { CreditLedger } from "./credit-ledger.js";

// USD per 1M tokens. Keep specific variants (…-nano, …-mini, …-5.5) listed so
// priceFor's longest-prefix match doesn't bill a nano call at flagship rates.
const DEFAULT_PRICES = {
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Published Kimi platform rates retrieved 2026-07-27.
  "kimi-k3": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 0 },
  "gpt-5.5": { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5-mini": { in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-nano": { in: 0.05, out: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  "gpt-5": { in: 5, out: 15, cacheRead: 0.5, cacheWrite: 0 },
  default: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }
};

const DISABLED_LIMITS = new Set(["off", "none", "unlimited", "disabled"]);

export function resolveDailyLimit(raw) {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return 10;
  }
  if (typeof raw === "string" && DISABLED_LIMITS.has(raw.trim().toLowerCase())) {
    return null;
  }
  const parsed = (
    typeof raw === "number"
    || (typeof raw === "string" && raw.trim() !== "")
  )
    ? Number(raw)
    : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new TypeError(
    "OPENAGI_DAILY_USD_LIMIT must be a finite number greater than 0; "
    + "use 'off' to disable the budget guard."
  );
}

export class BudgetGuard {
  constructor(options = {}) {
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "budget", "usage.json");
    this.env = options.env ?? process.env;
    const configuredLimit = Object.hasOwn(options, "dailyUsdLimit")
      ? options.dailyUsdLimit
      : this.env.OPENAGI_DAILY_USD_LIMIT;
    this.dailyUsdLimit = resolveDailyLimit(configuredLimit);
    this.prices = { ...DEFAULT_PRICES, ...(options.prices ?? {}) };
    this.warn = typeof options.warn === "function" ? options.warn : console.warn;
    this.unpricedModels = new Set();
    this.priceResolutions = new Map();
    ensureDir(path.dirname(this.storePath));
    this.state = readJsonFile(this.storePath, { version: 1, days: {} });
    this.ledger = options.ledger ?? new CreditLedger({ storePath: path.join(path.dirname(this.storePath), "ledger.jsonl") });
  }

  get enabled() {
    return this.dailyUsdLimit !== null;
  }

  setDailyLimit(raw) {
    this.dailyUsdLimit = resolveDailyLimit(raw);
    return this.dailyUsdLimit;
  }

  todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  status() {
    const today = this.todayKey();
    const day = this.state.days[today] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };
    return {
      today,
      enabled: this.enabled,
      dailyUsdLimit: this.dailyUsdLimit,
      spentUsd: Number(day.usd.toFixed(4)),
      remainingUsd: this.enabled
        ? Number((this.dailyUsdLimit - day.usd).toFixed(4))
        : null,
      calls: day.calls,
      tokens: { input: day.input, output: day.output, cacheRead: day.cacheRead, cacheWrite: day.cacheWrite },
      unpricedModels: [...this.unpricedModels].sort(),
      history: Object.entries(this.state.days)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14)
        .map(([date, d]) => ({ date, usd: Number(d.usd.toFixed(4)), calls: d.calls }))
    };
  }

  check() {
    if (!this.enabled) return;
    const today = this.todayKey();
    const day = this.state.days[today] ?? { usd: 0 };
    if (day.usd >= this.dailyUsdLimit) {
      const error = new Error(
        `Daily budget reached: $${day.usd.toFixed(4)} of $${this.dailyUsdLimit.toFixed(2)}. ` +
        `Raise OPENAGI_DAILY_USD_LIMIT or wait until tomorrow.`
      );
      error.code = "BUDGET_EXCEEDED";
      throw error;
    }
  }

  record(usage, model, meta = {}) {
    if (!usage) return null;
    const today = this.todayKey();
    if (!this.state.days[today]) this.state.days[today] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };

    const tokens = normalizeUsage(usage);
    const price = this.priceFor(model);
    const usd =
      (tokens.input / 1e6) * price.in +
      (tokens.output / 1e6) * price.out +
      (tokens.cacheRead / 1e6) * price.cacheRead +
      (tokens.cacheWrite / 1e6) * price.cacheWrite;

    const day = this.state.days[today];
    day.input += tokens.input;
    day.output += tokens.output;
    day.cacheRead += tokens.cacheRead;
    day.cacheWrite += tokens.cacheWrite;
    day.usd += usd;
    day.calls += 1;

    try {
      const efficiency = meta.efficiency ?? {
        requestBytes: meta.requestBytes,
        toolCount: meta.toolCount,
        toolSuccessCount: meta.toolSuccessCount,
        toolFailureCount: meta.toolFailureCount,
        toolSchemaBytes: meta.toolSchemaBytes,
        visibleSchemaBytes: meta.visibleSchemaBytes,
        deferredSchemaBytes: meta.deferredSchemaBytes,
        visibleToolCount: meta.visibleToolCount,
        deferredToolCount: meta.deferredToolCount,
        compression: meta.compression,
        stopReason: meta.stopReason,
        latencyMs: meta.latencyMs
      };
      const entry = {
        at: nowIso(),
        provider: meta.provider ?? null,
        model,
        tokens,
        usd,
        channel: meta.channel ?? null,
        agentId: meta.agentId ?? null,
        sessionId: meta.sessionId ?? null,
        from: meta.from ?? null,
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        efficiency
      };
      if (String(this.env.OPENAGI_LEDGER_ENRICHMENT ?? "").trim() !== "0") {
        Object.assign(entry, {
          latencyMs: efficiency?.latencyMs ?? meta.latencyMs,
          stopReason: efficiency?.stopReason ?? meta.stopReason,
          task: meta.task ?? null,
          attempt: meta.attempt ?? 0,
          inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
          outputTokens: tokens.output
        });
      }
      this.ledger?.record(entry);
    } catch { /* ledger is best-effort; never break a reply over it */ }

    this.persist();
    return { added: usd, today: day.usd, limit: this.dailyUsdLimit };
  }

  priceFor(model) {
    const modelId = String(model ?? "").trim();
    if (!modelId) {
      this.priceResolutions.set(modelId, { mode: "default", key: "default" });
      return this.prices.default;
    }
    const exact = this.prices[modelId];
    if (exact) {
      this.priceResolutions.set(modelId, { mode: "exact", key: modelId });
      return exact;
    }
    // Longest matching prefix wins, so "gpt-5.4-nano" resolves to the nano
    // price, not "gpt-5" (flagship). A short prefix like "gpt-5" must never
    // shadow a more specific variant.
    const prefix = Object.keys(this.prices)
      .filter((key) => key !== "default" && modelId.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) {
      this.priceResolutions.set(modelId, { mode: "prefix", key: prefix });
      return this.prices[prefix];
    }
    this.priceResolutions.set(modelId, { mode: "default", key: "default" });
    if (!this.unpricedModels.has(modelId)) {
      this.unpricedModels.add(modelId);
      try {
        this.warn(
          `[budget] model '${modelId}' has no price entry; billing at default rates `
          + "(in $3/out $15 per 1M). Recorded spend for this model is an ESTIMATE "
          + "and may be wildly wrong. Add it to DEFAULT_PRICES in src/budget-guard.js."
        );
      } catch {
        // Diagnostics must never interrupt usage accounting.
      }
    }
    return this.prices.default;
  }

  persist() {
    writeJsonAtomic(this.storePath, this.state);
  }
}

function normalizeUsage(usage) {
  const totalInput = nonnegativeNumber(usage.input_tokens ?? usage.prompt_tokens);
  const output = nonnegativeNumber(usage.output_tokens ?? usage.completion_tokens);
  const hasAnthropicCacheFields =
    Object.hasOwn(usage, "cache_read_input_tokens")
    || Object.hasOwn(usage, "cache_creation_input_tokens");

  // Anthropic reports uncached input and cache read/write tokens as separate,
  // additive fields. Do not subtract those values from input_tokens.
  if (hasAnthropicCacheFields) {
    return {
      input: totalInput,
      output,
      cacheRead: nonnegativeNumber(usage.cache_read_input_tokens),
      cacheWrite: nonnegativeNumber(usage.cache_creation_input_tokens)
    };
  }

  // OpenAI Responses (input_tokens_details) and Chat Completions
  // (prompt_tokens_details) include cached tokens inside the total input
  // count. Split the total into mutually-exclusive uncached and cached
  // buckets so cached tokens are not charged once at full input price and
  // again at the cache-read price.
  const cacheRead = nonnegativeNumber(
    usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
  );
  return {
    input: Math.max(totalInput - cacheRead, 0),
    output,
    cacheRead,
    cacheWrite: 0
  };
}

function nonnegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

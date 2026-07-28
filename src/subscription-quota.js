import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";

/**
 * Subscription quota tracking.
 *
 * A USD/day cap is the wrong instrument for a flat-rate plan: the money is
 * already spent, so a dollar ceiling throttles work at an imaginary limit
 * while ignoring the constraint that actually bites — the provider's rolling
 * usage window (Kimi bills a 5-hour window on its subscription tiers).
 *
 * The endpoint publishes NO rate-limit headers (verified live 2026-07-28
 * against api.kimi.com/coding/v1: no x-ratelimit-*, no retry-after on 200s),
 * so remaining quota cannot be read. It has to be RECONSTRUCTED from observed
 * usage, and corrected whenever the provider actually pushes back with a 429.
 *
 * This is therefore an ESTIMATE that self-corrects, and it says so. A tracker
 * that silently presents a guess as ground truth is worse than no tracker.
 */

const DEFAULT_WINDOW_HOURS = 5;
const MAX_EVENTS = 20_000;

export function subscriptionTrackingEnabled(env = process.env) {
  return String(env?.OPENAGI_SUBSCRIPTION_TRACKING ?? "").trim() === "1";
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class SubscriptionQuotaTracker {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.dir = options.dir ?? path.join(resolveDataDir(), "budget");
    this.statePath = options.statePath ?? path.join(this.dir, "subscription-window.json");
    this.windowMs = positiveNumber(
      this.env.OPENAGI_SUBSCRIPTION_WINDOW_HOURS,
      DEFAULT_WINDOW_HOURS
    ) * 60 * 60 * 1000;
    // Token allowance per window. Unknown by default: the plan's real ceiling
    // is not published per-key, so we report usage and only enforce once an
    // operator supplies a number they actually know.
    this.windowTokenLimit = Number.isFinite(Number(this.env.OPENAGI_SUBSCRIPTION_WINDOW_TOKENS))
      && Number(this.env.OPENAGI_SUBSCRIPTION_WINDOW_TOKENS) > 0
      ? Number(this.env.OPENAGI_SUBSCRIPTION_WINDOW_TOKENS)
      : null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch { /* best effort */ }
    this.state = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (raw && Array.isArray(raw.events)) return raw;
    } catch { /* fresh state */ }
    return { version: 1, events: [], throttleEvents: [] };
  }

  _save() {
    const tmp = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      fs.renameSync(tmp, this.statePath);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    // Keep a little history beyond the window so trend reporting survives a
    // restart, but never grow without bound.
    const keepFrom = now - this.windowMs * 4;
    this.state.events = this.state.events
      .filter((e) => e.at >= keepFrom)
      .slice(-MAX_EVENTS);
    this.state.throttleEvents = (this.state.throttleEvents ?? [])
      .filter((e) => e.at >= keepFrom)
      .slice(-500);
    return cutoff;
  }

  /**
   * Record one provider call. Cache reads are counted separately: they are
   * real tokens against throughput but are the cheap path, so conflating them
   * with fresh input would badly overstate window pressure.
   */
  record({ tokens = {}, model = null, at = Date.now() } = {}) {
    const event = {
      at: typeof at === "number" ? at : new Date(at).getTime(),
      i: Number(tokens.input) || 0,
      o: Number(tokens.output) || 0,
      c: Number(tokens.cacheRead) || 0,
      m: model ? String(model).slice(0, 40) : null
    };
    this.state.events.push(event);
    this._prune(event.at);
    this._save();
    return event;
  }

  /** A 429 is the only ground truth this endpoint gives us. */
  recordThrottle({ at = Date.now(), retryAfterMs = null, model = null } = {}) {
    this.state.throttleEvents = this.state.throttleEvents ?? [];
    this.state.throttleEvents.push({
      at: typeof at === "number" ? at : new Date(at).getTime(),
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
      m: model ? String(model).slice(0, 40) : null
    });
    this._prune(Date.now());
    this._save();
  }

  /**
   * Current rolling-window status. `limitKnown:false` is load-bearing — it
   * tells the caller these numbers are observed usage, not remaining quota.
   */
  status(now = Date.now()) {
    const cutoff = this._prune(now);
    const inWindow = this.state.events.filter((e) => e.at >= cutoff);
    const totals = inWindow.reduce(
      (acc, e) => {
        acc.input += e.i;
        acc.output += e.o;
        acc.cacheRead += e.c;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0 }
    );
    // Billable throughput excludes cache reads; reported separately below.
    const billableTokens = totals.input + totals.output;
    const oldest = inWindow.length > 0 ? Math.min(...inWindow.map((e) => e.at)) : null;
    const throttles = (this.state.throttleEvents ?? []).filter((e) => e.at >= cutoff);

    const windowResetsAt = oldest === null ? null : oldest + this.windowMs;
    const status = {
      windowHours: this.windowMs / 3_600_000,
      calls: inWindow.length,
      tokens: { ...totals, billable: billableTokens },
      // When the earliest in-window call ages out, capacity begins returning.
      windowResetsAt: windowResetsAt ? new Date(windowResetsAt).toISOString() : null,
      minutesUntilReset: windowResetsAt
        ? Math.max(0, Math.round((windowResetsAt - now) / 60_000))
        : null,
      throttledInWindow: throttles.length,
      lastThrottleAt: throttles.length > 0
        ? new Date(Math.max(...throttles.map((e) => e.at))).toISOString()
        : null,
      limitKnown: this.windowTokenLimit !== null,
      windowTokenLimit: this.windowTokenLimit,
      percentUsed: null,
      note: null
    };

    if (this.windowTokenLimit !== null) {
      status.percentUsed = Number(((billableTokens / this.windowTokenLimit) * 100).toFixed(1));
    } else {
      status.note = "Observed usage only. The provider publishes no quota headers, "
        + "so remaining allowance is unknown. Set OPENAGI_SUBSCRIPTION_WINDOW_TOKENS "
        + "to enable percentage tracking.";
    }
    if (throttles.length > 0) {
      status.note = `Provider returned ${throttles.length} rate-limit response(s) in this `
        + "window — the plan ceiling was actually reached, which is ground truth "
        + "rather than estimate.";
    }
    return status;
  }
}

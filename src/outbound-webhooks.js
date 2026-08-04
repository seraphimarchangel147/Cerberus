// Outbound signed webhooks — the push half of the hook system.
//
// The HookRegistry already has everything needed to observe the agent:
// `notify(event, payload)` queues observer hooks on a serialized promise chain
// and returns immediately, and `eventMatches()` understands `*` wildcards. What
// was missing is a *subscriber* that signs and POSTs. That is all this module
// is. Registering on the existing registry means zero call-site changes: every
// existing `notify()` emission becomes deliverable to an external receiver.
//
// Inbound webhooks wake the agent when the world changes; these tell the world
// when the agent does something — so a dashboard can stop polling for pending
// approvals and a CI system can react to a finished turn.
//
// Resolution order for configuration (first hit wins):
//   1. explicit `webhooks` array passed to the constructor (tests, embedders)
//   2. <dataDir>/webhooks.json — persisted operator config
// A malformed config file is fail-open: warn and keep the last valid set,
// mirroring `HookRegistry.loadShellConfig`.
//
// What is and is not a secret: the `url` and `events` of a subscription are
// routing metadata and appear in logs and `stats()`. The `secret` is an HMAC
// key and appears NOWHERE — not in logs, not in errors, not in stats(), not in
// a /health payload. It only ever reaches `createHmac`.
//
// Delivery is fire-and-forget through a bounded queue drained by a single async
// worker chain. The handler registered on the registry enqueues and returns; it
// never awaits the HTTP call, because `notify()` runs on the agent loop and an
// outbound target must never be able to add latency to a tool call.
//
// Receiver verification snippet (Node):
//
//   import { createHmac, timingSafeEqual } from "node:crypto";
//   const expected = "sha256=" + createHmac("sha256", secret)
//     .update(rawBodyBuffer)          // RAW bytes, before JSON.parse
//     .digest("hex");
//   const a = Buffer.from(expected);
//   const b = Buffer.from(req.headers["x-cerberus-signature-256"] ?? "");
//   const ok = a.length === b.length && timingSafeEqual(a, b);
//
// Verify over the raw body buffer, never over a re-serialized object: property
// order and unicode escaping differ and the digest will not match.

import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { assertSafePublicUrl } from "./url-guard.js";
import { eventMatches } from "./hook-registry.js";

export const QUEUE_CAPACITY = 256;
export const MAX_SUBSCRIPTIONS = 32;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TOTAL_DELIVERY_MS = 30_000;
export const SIGNATURE_HEADER = "X-Cerberus-Signature-256";
const WARN_INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4_000;

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Parse one raw config entry into a subscription, or return null with a reason.
 * Never throws: one broken entry must not take down the others.
 */
export function parseSubscription(raw, index = 0) {
  if (!raw || typeof raw !== "object") {
    return { error: `webhooks[${index}] must be an object` };
  }
  const name = String(raw.name ?? "").trim() || `webhook-${index}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { error: `webhooks[${index}].name must be ASCII letters, digits, dot, underscore, or dash` };
  }
  const url = String(raw.url ?? "").trim();
  if (!url) return { error: `webhooks[${index}] (${name}) is missing a url` };

  const allowPrivate = raw.allowPrivate === true;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: `webhooks[${index}] (${name}) has an unparseable url` };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { error: `webhooks[${index}] (${name}) url protocol must be http or https` };
  }
  if (!allowPrivate) {
    // Without this a webhooks.json entry is an SSRF primitive against the host:
    // an attacker who can write config gets a signed POST to 169.254.169.254.
    try {
      assertSafePublicUrl(url, `webhooks[${index}] (${name}) url`);
    } catch (error) {
      return { error: `${error?.message ?? String(error)} — set allowPrivate: true to override` };
    }
  }

  const events = Array.isArray(raw.events)
    ? raw.events.map((event) => String(event ?? "").trim()).filter(Boolean)
    : [];
  if (events.length === 0) {
    return { error: `webhooks[${index}] (${name}) needs a non-empty events list` };
  }

  const secret = typeof raw.secret === "string" && raw.secret ? raw.secret : null;
  return {
    subscription: {
      name,
      url,
      secret,
      events,
      allowPrivate,
      enabled: raw.enabled !== false,
      timeoutMs: clampInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000)
    }
  };
}

export function loadWebhookConfig(dataDir = resolveDataDir(), { log } = {}) {
  const filePath = path.join(dataDir, "webhooks.json");
  // readJsonFile returns the fallback for a missing file but rethrows a parse
  // error. A corrupt config must never crash the runtime that loads it.
  let parsed;
  try {
    parsed = readJsonFile(filePath, null);
  } catch (error) {
    const message = `could not parse webhooks.json: ${error?.message ?? String(error)}`;
    log?.(`[webhooks] ${message} — keeping previous configuration`);
    return { subscriptions: [], errors: [message], present: true, malformed: true };
  }
  if (parsed == null) return { subscriptions: [], errors: [], present: false };

  const entries = Array.isArray(parsed) ? parsed : parsed?.webhooks;
  if (!Array.isArray(entries)) {
    const message = "webhooks.json must contain a webhooks array";
    log?.(`[webhooks] ${message} — keeping previous configuration`);
    return { subscriptions: [], errors: [message], present: true, malformed: true };
  }

  const subscriptions = [];
  const errors = [];
  for (const [index, entry] of entries.entries()) {
    if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
      errors.push(`webhooks.json holds more than ${MAX_SUBSCRIPTIONS} subscriptions — extras ignored`);
      break;
    }
    const { subscription, error } = parseSubscription(entry, index);
    if (error) {
      errors.push(error);
      log?.(`[webhooks] ${error}`);
      continue;
    }
    subscriptions.push(subscription);
  }
  return { subscriptions, errors, present: true };
}

/**
 * Bounded, signing, retrying delivery queue. One instance per runtime.
 */
export class OutboundWebhookDispatcher {
  #queue = [];
  #draining = null;
  #closed = false;
  #warnState = new Map();

  constructor({
    subscriptions = null,
    dataDir = null,
    agent = process.env.OPENAGI_AGENT_NAME || "cerberus",
    fetchImpl = null,
    log = null,
    now = () => Date.now(),
    sleep = null
  } = {}) {
    this.agent = String(agent || "cerberus");
    this.log = typeof log === "function" ? log : (message) => { try { console.warn(message); } catch { /* logging must not wedge delivery */ } };
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.counters = { enqueued: 0, delivered: 0, failed: 0, dropped: 0, attempts: 0 };

    if (Array.isArray(subscriptions)) {
      const accepted = [];
      for (const [index, entry] of subscriptions.entries()) {
        if (accepted.length >= MAX_SUBSCRIPTIONS) break;
        const { subscription, error } = parseSubscription(entry, index);
        if (error) { this.log(`[webhooks] ${error}`); continue; }
        accepted.push(subscription);
      }
      this.subscriptions = accepted;
    } else {
      this.subscriptions = loadWebhookConfig(dataDir ?? resolveDataDir(), { log: this.log }).subscriptions;
    }
  }

  /** Subscriptions that are enabled and interested in `event`. */
  matching(event) {
    return this.subscriptions.filter(
      (subscription) => subscription.enabled
        && subscription.events.some((pattern) => eventMatches(pattern, event))
    );
  }

  /**
   * Hook specs to hand to `HookRegistry.register`. One per subscription per
   * pattern; the handler enqueues and returns synchronously.
   */
  hookSpecs() {
    const specs = [];
    for (const subscription of this.subscriptions) {
      if (!subscription.enabled) continue;
      for (const [index, pattern] of subscription.events.entries()) {
        specs.push({
          name: `webhook.${subscription.name}.${index}`,
          event: pattern,
          tier: "plugin",
          // HookRegistry passes (payload, {event, signal, timeoutMs}); the
          // second argument is a context object, not the event string.
          handler: (payload, context) => {
            this.enqueue(context?.event ?? pattern, payload, [subscription]);
            return undefined;
          }
        });
      }
    }
    return specs;
  }

  /**
   * Serialize + queue. Returns the number of deliveries queued. Synchronous by
   * contract: the agent loop must never wait on the network.
   */
  enqueue(event, payload = {}, subscriptions = null) {
    if (this.#closed) return 0;
    const targets = subscriptions ?? this.matching(event);
    if (targets.length === 0) return 0;

    const eventId = randomUUID();
    const at = new Date(this.now()).toISOString();
    let body;
    try {
      body = JSON.stringify({ eventId, event, at, agent: this.agent, payload });
    } catch (error) {
      // A payload that cannot be serialized is a bug in the emitter, never a
      // reason to interrupt the turn that produced it.
      this.#rateLimitedWarn(`serialize:${event}`, `payload serialization failed for ${event}: ${error?.message ?? String(error)}`);
      return 0;
    }

    let queued = 0;
    for (const subscription of targets) {
      this.#push({ eventId, event, body, subscription });
      queued += 1;
    }
    this.#startDrain();
    return queued;
  }

  #push(delivery) {
    if (this.#queue.length >= QUEUE_CAPACITY) {
      // Drop the OLDEST: the newest events describe what the agent is doing
      // now, which is what a receiver actually wants after an outage.
      this.#queue.shift();
      this.counters.dropped += 1;
      this.#rateLimitedWarn("overflow", `queue full at ${QUEUE_CAPACITY} — dropping oldest delivery`);
    }
    this.#queue.push(delivery);
    this.counters.enqueued += 1;
  }

  #startDrain() {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => { this.#draining = null; });
    this.#draining.catch(() => { /* #drain never rejects; belt and braces */ });
  }

  async #drain() {
    while (this.#queue.length > 0) {
      const delivery = this.#queue.shift();
      try {
        await this.#deliver(delivery);
      } catch (error) {
        this.counters.failed += 1;
        this.#rateLimitedWarn(
          `deliver:${delivery.subscription.name}`,
          `delivery crashed for ${delivery.subscription.name}: ${error?.message ?? String(error)}`
        );
      }
    }
  }

  #headers(delivery, attempt) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "cerberus-webhooks/1",
      "X-Cerberus-Event": delivery.event,
      "X-Cerberus-Delivery": randomUUID(),
      "X-Cerberus-Delivery-Attempt": String(attempt)
    };
    if (delivery.subscription.secret) {
      // Sign the exact bytes on the wire. Signing the object and re-serializing
      // on the receiver is the classic mismatch bug.
      const digest = createHmac("sha256", delivery.subscription.secret)
        .update(Buffer.from(delivery.body, "utf8"))
        .digest("hex");
      headers[SIGNATURE_HEADER] = `sha256=${digest}`;
    }
    return headers;
  }

  async #deliver(delivery) {
    const startedAt = this.now();
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      if (this.now() - startedAt >= MAX_TOTAL_DELIVERY_MS) {
        lastError = lastError || "wall-clock budget exhausted";
        break;
      }
      this.counters.attempts += 1;
      let response;
      try {
        response = await this.fetchImpl(delivery.subscription.url, {
          method: "POST",
          headers: this.#headers(delivery, attempt),
          body: delivery.body,
          // A followed 3xx becomes a body-less GET in most clients: the signed
          // payload is silently dropped and the receiver still answers 200.
          redirect: "manual",
          signal: AbortSignal.timeout(delivery.subscription.timeoutMs)
        });
      } catch (error) {
        lastError = error?.message ?? String(error);
        if (attempt < MAX_DELIVERY_ATTEMPTS) {
          await this.sleep(this.#backoffMs(attempt));
          continue;
        }
        break;
      }

      const status = Number(response?.status ?? 0);
      try { await response?.body?.cancel?.(); } catch { /* body drain is best effort */ }

      if (status >= 200 && status < 300) {
        this.counters.delivered += 1;
        return;
      }
      if (status >= 300 && status < 400) {
        this.counters.failed += 1;
        this.#rateLimitedWarn(
          `redirect:${delivery.subscription.name}`,
          `${delivery.subscription.name} returned HTTP ${status}; redirects are never followed — fix the configured url`
        );
        return;
      }
      if (status >= 400 && status < 500) {
        this.counters.failed += 1;
        this.#rateLimitedWarn(
          `rejected:${delivery.subscription.name}`,
          `${delivery.subscription.name} rejected delivery with HTTP ${status} — not retrying`
        );
        return;
      }
      lastError = `HTTP ${status}`;
      if (attempt < MAX_DELIVERY_ATTEMPTS) await this.sleep(this.#backoffMs(attempt));
    }
    this.counters.failed += 1;
    this.#rateLimitedWarn(
      `failed:${delivery.subscription.name}`,
      `delivery to ${delivery.subscription.name} failed after ${MAX_DELIVERY_ATTEMPTS} attempt(s): ${lastError}`
    );
  }

  /** Bounded exponential backoff with jitter. Unbounded growth is how you get an 18-hour sleep. */
  #backoffMs(attempt) {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  // Log the first occurrence, then at most once per 60s, carrying the
  // suppressed count so a persistent failure stays visible without one line
  // per event.
  #rateLimitedWarn(key, message) {
    const state = this.#warnState.get(key) ?? { lastAt: 0, suppressed: 0 };
    const now = this.now();
    if (now - state.lastAt >= WARN_INTERVAL_MS) {
      const note = state.suppressed > 0 ? ` (suppressed ${state.suppressed} repeat(s) since last log)` : "";
      state.lastAt = now;
      state.suppressed = 0;
      this.#warnState.set(key, state);
      this.log(`[webhooks] ${message}${note}`);
    } else {
      state.suppressed += 1;
      this.#warnState.set(key, state);
    }
  }

  /** Await every in-flight and queued delivery. Shutdown / test helper. */
  async flush() {
    while (this.#draining || this.#queue.length > 0) {
      if (!this.#draining) this.#startDrain();
      await this.#draining;
    }
  }

  async close() {
    await this.flush();
    this.#closed = true;
  }

  /** Operational counters. Contains no secret material by construction. */
  stats() {
    return {
      queued: this.#queue.length,
      capacity: QUEUE_CAPACITY,
      ...this.counters,
      subscriptions: this.subscriptions.map((subscription) => ({
        name: subscription.name,
        url: subscription.url,
        events: [...subscription.events],
        enabled: subscription.enabled,
        signed: Boolean(subscription.secret)
      }))
    };
  }
}

/**
 * Construct a dispatcher from config and register it on an existing
 * HookRegistry. Returns null when nothing is configured, so callers can skip
 * shutdown wiring entirely.
 */
export function registerOutboundWebhooks(hooks, options = {}) {
  if (!hooks || typeof hooks.register !== "function") return null;
  const dispatcher = new OutboundWebhookDispatcher(options);
  if (dispatcher.subscriptions.length === 0) return null;
  for (const spec of dispatcher.hookSpecs()) {
    try {
      hooks.register(spec);
    } catch (error) {
      dispatcher.log(`[webhooks] could not register ${spec.name}: ${error?.message ?? String(error)}`);
    }
  }
  return dispatcher;
}

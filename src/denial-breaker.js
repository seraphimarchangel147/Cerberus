// Consecutive-denial circuit breaker.
//
// Nothing stops a model from retrying variants of a blocked command. Each retry
// burns an agent iteration and, on the catastrophic path, another human
// decision. After N consecutive denials in one session the block message
// returned to the model escalates from "this was blocked" to a hard-stop
// instruction: stop retrying, explain the blockage to the user in plain
// language, and wait for a different approach or a human decision.
//
// Why this matters here specifically: auto-approve is ON in this deployment
// (OPENAGI_AUTO_APPROVE), so the usual human-in-the-loop back-pressure that
// would naturally interrupt a retry loop is absent. This valve replaces it.
//
// THE LOAD-BEARING DESIGN CONSTRAINT: `addendum()` returns a STRING that the
// caller appends to an existing block message. It does not throw, does not
// abort the turn, does not insert a message, and never touches the messages
// array. Escalating behavior by changing what the model reads next -- rather
// than by restructuring what it has already read -- is what makes this
// prompt-cache-invariant by construction. If a future change here starts
// splicing conversation history, that property is gone.
//
// Resolution order for the threshold (first hit wins):
//   1. `threshold` passed to the constructor (tests, embedders)
//   2. env OPENAGI_DENIAL_BREAKER_THRESHOLD
//   3. DEFAULT_DENIAL_THRESHOLD below
// A threshold of 0 (or negative) disables the breaker entirely, so an operator
// can turn it off without a code change.
//
// State is in-memory and deliberately not persisted: a restart clears the
// tally, which is correct, because the loop that caused it is gone too.

export const DEFAULT_DENIAL_THRESHOLD = 3;
export const MAX_TRACKED_SESSIONS = 256;

function resolveThreshold(explicit, env) {
  if (explicit != null) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  const raw = env?.OPENAGI_DENIAL_BREAKER_THRESHOLD;
  if (raw != null && String(raw).trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return DEFAULT_DENIAL_THRESHOLD;
}

/** Build the session tally key. Namespaced so two projects cannot share one. */
export function denialSessionKey(context) {
  const sessionId = String(context?.sessionId ?? "").trim() || "default";
  const projectId = String(context?.projectId ?? "").trim();
  return projectId ? `${projectId}:${sessionId}` : sessionId;
}

export class DenialBreaker {
  #tally = new Map();

  constructor({ threshold = null, maxSessions = MAX_TRACKED_SESSIONS, env = process.env, log = null } = {}) {
    this.threshold = resolveThreshold(threshold, env);
    this.maxSessions = Math.max(1, Number.parseInt(maxSessions, 10) || MAX_TRACKED_SESSIONS);
    this.log = typeof log === "function" ? log : null;
    this.tripped = 0;
  }

  get enabled() {
    return this.threshold > 0;
  }

  /**
   * Increment the session's consecutive-denial count and return it.
   * Delete-then-set moves an actively-denying session to the tail, so
   * insertion-order eviction drops genuinely idle keys, not hot ones.
   */
  record(sessionKey) {
    const key = String(sessionKey ?? "default");
    const count = (this.#tally.get(key) ?? 0) + 1;
    this.#tally.delete(key);
    this.#tally.set(key, count);
    while (this.#tally.size > this.maxSessions) {
      const oldest = this.#tally.keys().next().value;
      this.#tally.delete(oldest);
    }
    return count;
  }

  /** An allow / approve / successful dispatch happened: the model is unstuck. */
  reset(sessionKey) {
    this.#tally.delete(String(sessionKey ?? "default"));
  }

  count(sessionKey) {
    return this.#tally.get(String(sessionKey ?? "default")) ?? 0;
  }

  /**
   * Read-only. Returns "" below the threshold (or when disabled), otherwise a
   * leading-space addendum the caller appends verbatim to the block message.
   */
  addendum(sessionKey) {
    if (!this.enabled) return "";
    const count = this.count(sessionKey);
    if (count < this.threshold) return "";
    this.tripped += 1;
    this.log?.(
      `[denial-breaker] tripped for session ${sessionKey}: ${count} consecutive denials (threshold ${this.threshold})`
    );
    // Explicit on purpose. A vague "consider stopping" gets ignored; the model
    // needs to be told what to do INSTEAD of retrying, or it just rephrases.
    return (
      ` CIRCUIT BREAKER: ${count} consecutive tool calls were blocked in this session `
      + `(threshold ${this.threshold}). STOP retrying this operation and STOP trying variations of it. `
      + "Retrying will not succeed and each attempt burns another iteration. "
      + "Instead, explain to the user in plain language what you were trying to do, what was blocked, "
      + "and why it matters. Then either take a genuinely different approach that does not require the "
      + "blocked operation, or ask the user to make the decision or run it themselves."
    );
  }

  /** Convenience: record then read, the order every call site needs. */
  recordAndAddendum(sessionKey) {
    this.record(sessionKey);
    return this.addendum(sessionKey);
  }

  stats() {
    return {
      threshold: this.threshold,
      enabled: this.enabled,
      trackedSessions: this.#tally.size,
      maxSessions: this.maxSessions,
      tripped: this.tripped
    };
  }
}

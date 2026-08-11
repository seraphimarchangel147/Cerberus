/**
 * Bridges AgentHost's `this.log?.({ op, ... })` calls to the RunInspector,
 * which already fsyncs to ~/.openagi/run-inspector/events.jsonl.
 *
 * Why an adapter instead of calling `runInspector.record()` directly at the
 * emit sites: `record()` demands runId + kind + phase and drops any metadata
 * key that is not allowlisted (STRING_METADATA in run-inspector.js). The
 * existing call sites pass a loose `{ op, sessionId, channel, ... }` shape.
 * Rewriting every site to the strict shape would touch unrelated code and
 * invite drift; this maps the loose shape once, in one place.
 *
 * Mapping decisions:
 * - `kind: "turn"` — the only legal kind for host-level events
 *   (RUN_KINDS = coder|job|qa|turn).
 * - `phase` — the `op`, normalized to PHASE_RE (/^[a-z][a-z0-9_-]{0,63}$/).
 *   `turn-steered` and `steer-undelivered` already satisfy it unchanged.
 * - `status: "running"` — these are observations inside a turn, not terminal
 *   states. Using a TERMINAL_STATUSES value would corrupt run status.
 * - Non-allowlisted fields (`chars`, `channel`) are folded into `code`, which
 *   IS allowlisted (80 chars), so the payload survives instead of being
 *   silently dropped.
 */

const PHASE_SAFE = /[^a-z0-9_-]/g;

/** Normalize an `op` into something requiredPhase() will accept. */
export function opToPhase(op) {
  const phase = String(op ?? "").toLowerCase().replace(PHASE_SAFE, "-").slice(0, 64);
  return /^[a-z]/.test(phase) ? phase : `event-${phase}`.slice(0, 64);
}

/**
 * Build a `log(entry)` function backed by a RunInspector.
 * Returns null when no inspector is available, so `this.log?.()` stays a
 * no-op rather than throwing — same behavior as today, minus the silence.
 */
export function createInspectorLogger(runInspector, { projectId = "default" } = {}) {
  const store = runInspector?.store ?? runInspector;
  if (typeof store?.record !== "function") return null;

  return function log(entry) {
    if (!entry || typeof entry !== "object") return;
    const op = entry.op;
    if (!op) return;

    // Preserve fields the inspector's allowlist would otherwise drop.
    const extras = [];
    if (entry.channel) extras.push(`ch=${entry.channel}`);
    if (Number.isFinite(entry.chars)) extras.push(`chars=${entry.chars}`);
    if (entry.cause) extras.push(`cause=${entry.cause}`);

    try {
      store.record({
        projectId,
        kind: "turn",
        runId: entry.turnId ?? entry.sessionId ?? "host",
        sessionId: entry.sessionId ?? null,
        phase: opToPhase(op),
        status: "running",
        metadata: {
          ...(extras.length ? { code: extras.join(" ").slice(0, 80) } : {}),
          ...(entry.stopReason ? { stopReason: String(entry.stopReason) } : {})
        }
      });
    } catch {
      // Observability must never break a turn. A dropped log line is a
      // strictly better outcome than an aborted user request.
    }
  };
}

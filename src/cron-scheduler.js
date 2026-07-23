import { createId, nowIso } from "./utils.js";

// Per-job timeout: one hung handler (a stuck LLM call, a wedged MCP server)
// must not stall every later scheduled job. Each handler invocation in
// runDue() races a timer; on timeout the fire records as failed and
// nextRunAt advances normally. HONEST LIMITATION: Promise.race abandons the
// losing promise — the hung handler keeps running in the background; it is
// NOT cancelled. Acceptable v1 because handlers are in-process async work we
// cannot kill without worker isolation, and the property we need is that the
// schedule keeps moving; the leaked promise is bounded by process lifetime.
export const TIMEOUT_MS = 10 * 60 * 1000;

const TIMED_OUT = Symbol("cron-job-timed-out");

function pinText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function modelProviderIdentity(provider) {
  if (!provider || typeof provider !== "object") return null;
  const providerName = pinText(provider.provider)
    ?? pinText(provider.name)
    ?? pinText(provider.constructor?.name);
  const model = pinText(provider.model) ?? pinText(provider.name);
  return providerName && model ? { provider: providerName, model } : null;
}

function normalizeModelIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const provider = pinText(value.provider);
  const model = pinText(value.model);
  return provider && model ? { provider, model } : modelProviderIdentity(value);
}

// Env override: OPENAGI_CRON_JOB_TIMEOUT_MS, parsed with Number and only
// honored when finite and > 0; anything else falls back to TIMEOUT_MS.
export function resolveJobTimeoutMs(env = process.env) {
  const raw = env.OPENAGI_CRON_JOB_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return TIMEOUT_MS;
  const parsed = Number(raw);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : TIMEOUT_MS;
}

export class CronScheduler {
  constructor(options = {}) {
    this.jobs = new Map();
    this.modelResolver = typeof options.modelResolver === "function" ? options.modelResolver : null;
  }

  currentModelIdentity() {
    try {
      return normalizeModelIdentity(this.modelResolver?.());
    } catch {
      return null;
    }
  }

  bindModelResolver(resolver, { backfill = true } = {}) {
    this.modelResolver = typeof resolver === "function" ? resolver : null;
    const identity = this.currentModelIdentity();
    let updated = 0;
    if (backfill && identity) {
      for (const job of this.jobs.values()) {
        if (this._pinJob(job, identity)) updated += 1;
      }
      if (updated > 0) this._modelPinsChanged();
    }
    return { identity, updated };
  }

  checkModelPin(job) {
    const current = this.currentModelIdentity();
    if (current && this._pinJob(job, current)) {
      if (this.jobs.get(job.id) === job) this._modelPinsChanged();
    }
    const expected = {
      provider: pinText(job?.pinnedProvider),
      model: pinText(job?.pinnedModel)
    };
    if (!expected.provider || !expected.model) {
      return { ok: false, reason: "model-pin-missing", expected, current };
    }
    if (!current) {
      return { ok: false, reason: "model-identity-unavailable", expected, current: null };
    }
    const ok = expected.provider === current.provider && expected.model === current.model;
    return { ok, reason: ok ? null : "model-pin-mismatch", expected, current };
  }

  _pinJob(job, identity) {
    if (!job || !identity) return false;
    let changed = false;
    if (!pinText(job.pinnedProvider)) {
      job.pinnedProvider = identity.provider;
      changed = true;
    }
    if (!pinText(job.pinnedModel)) {
      job.pinnedModel = identity.model;
      changed = true;
    }
    return changed;
  }

  _modelPinsChanged() {}

  addJob(job) {
    const id = job.id ?? createId("job");
    const existing = this.jobs.get(id);
    if (existing && job.replace !== true) return existing;

    const identity = this.currentModelIdentity();
    const normalized = {
      id,
      name: job.name ?? "Scheduled job",
      enabled: job.enabled ?? true,
      task: job.task,
      input: job.input ?? {},
      intervalMs: job.intervalMs ?? null,
      dailyAt: job.dailyAt ?? null,
      nextRunAt: job.nextRunAt ?? this.computeNextRun(job, new Date()).toISOString(),
      createdAt: job.createdAt ?? nowIso(),
      lastRunAt: null,
      pinnedProvider: pinText(job.pinnedProvider) ?? identity?.provider ?? null,
      pinnedModel: pinText(job.pinnedModel) ?? identity?.model ?? null
    };
    this.jobs.set(normalized.id, normalized);
    return normalized;
  }

  listJobs() {
    return [...this.jobs.values()].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  dueJobs(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    return this.listJobs().filter((job) => job.enabled && new Date(job.nextRunAt) <= current);
  }

  async runDue(handler, now = new Date(), options = {}) {
    const timeoutMs = options.timeoutMs ?? resolveJobTimeoutMs();
    const results = [];
    for (const job of this.dueJobs(now)) {
      // Mid-run marker hook: FileBackedCronScheduler persists a
      // { runningJobId, startedAt } note so a daemon death mid-job is
      // visible on the next boot. No-op on the in-memory scheduler.
      this.noteJobStart?.(job);
      let result;
      let timer = null;
      try {
        const raced = await Promise.race([
          handler(job),
          new Promise((resolve) => {
            // Deliberately ref'd: when the handler hangs, this timer is the
            // only thing that resolves the race, so it must keep the event
            // loop alive until it fires. It is always cleared in finally, so
            // it never outlives the fire.
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          })
        ]);
        if (raced === TIMED_OUT) {
          result = {
            failed: true,
            timedOut: true,
            error: `Job ${job.id} timed out after ${timeoutMs}ms (handler abandoned, not cancelled)`
          };
          options.onTimeout?.(job, timeoutMs);
        } else {
          result = raced;
        }
      } catch (error) {
        // A throwing handler used to abort the whole runDue loop, leaving
        // this job due again next tick (hot retry every 10s) and later due
        // jobs unfired. Record the failure and keep the schedule moving.
        result = { failed: true, timedOut: false, error: error?.message ?? String(error) };
      } finally {
        if (timer) clearTimeout(timer);
        this.noteJobEnd?.(job);
      }
      job.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      job.nextRunAt = this.computeNextRun(job, new Date(job.lastRunAt)).toISOString();
      results.push({ job, result });
    }
    return results;
  }

  updateJob(id, patch) {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Unknown cron job: ${id}`);
    const updated = {
      ...existing,
      ...patch,
      id,
      updatedAt: nowIso()
    };
    if ("nextRunAt" in patch) {
      updated.nextRunAt = patch.nextRunAt;
    } else if ("intervalMs" in patch || "dailyAt" in patch) {
      updated.nextRunAt = this.computeNextRun(updated, new Date()).toISOString();
    }
    this.jobs.set(id, updated);
    return updated;
  }

  removeJob(id) {
    return this.jobs.delete(id);
  }

  enableJob(id, enabled) {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Unknown cron job: ${id}`);
    existing.enabled = Boolean(enabled);
    existing.nextRunAt = existing.enabled ? this.computeNextRun(existing, new Date()).toISOString() : null;
    return existing;
  }

  computeNextRun(job, from) {
    if (job.intervalMs) return new Date(from.getTime() + job.intervalMs);
    if (job.dailyAt) {
      const [hour, minute] = job.dailyAt.split(":").map((part) => Number.parseInt(part, 10));
      const next = new Date(from);
      next.setHours(hour, minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next;
    }
    return new Date(from.getTime() + 1000 * 60 * 60 * 24);
  }
}

export function createDailyAdaptationReviewJob(input = {}) {
  return {
    id: "daily-adaptation-review",
    name: "Daily Adaptation Review",
    dailyAt: input.dailyAt ?? "08:30",
    task: "daily-adaptation-review",
    input: {
      source: "cron",
      type: "adaptation-review-request",
      domain: "general",
      taskType: "adaptation-review",
      summary: "Review recent pressures, memory candidates, and propagation opportunities.",
      urgency: 0.45,
      impact: 0.75,
      novelty: 0.35,
      repetition: 0.85,
      risk: 0.45,
      goalAlignment: 0.9,
      strategicFit: 0.85,
      confidence: 0.7,
      specificity: 0.65,
      requiresSpecialist: true,
      ...(input.signal ?? {})
    }
  };
}

export function createDailySkillCuratorJob(input = {}) {
  return {
    id: "daily-skill-curator",
    name: "Daily skill curator",
    enabled: true,
    task: "skill-curator",
    dailyAt: input.dailyAt ?? "03:45"
  };
}

export const createDailyPersonaResearchJob = createDailyAdaptationReviewJob;

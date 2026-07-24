import fs from "node:fs";
import path from "node:path";
import { CronScheduler } from "./cron-scheduler.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

export const MAX_CRON_STORE_BYTES = 8 * 1024 * 1024;
export const MAX_PERSISTED_CRON_JOBS = 4096;

const MAX_CRON_INPUT_DEPTH = 48;
const MAX_CRON_INPUT_NODES = 20_000;
const MAX_CRON_INPUT_STRING = 256 * 1024;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const DAILY_AT_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class FileBackedCronScheduler extends CronScheduler {
  constructor(options = {}) {
    super(options);
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "cron", "jobs.json");
    ensureDir(path.dirname(this.storePath));
    // { runningJobId, startedAt } while a job handler is executing; persisted
    // into the store so a mid-run daemon death leaves a visible marker.
    this.running = null;
    // Marker found on disk at load time (previous process died mid-job).
    // Consumed once at boot via consumeInterruption().
    this._interrupted = null;
    if (options.autoLoad !== false) this.load();
    if (this.modelResolver) this.bindModelResolver(this.modelResolver, { backfill: true });
  }

  load() {
    const store = readCronStore(this.storePath);
    this.jobs = new Map();
    const storedJobs = store?.version === 1 && Array.isArray(store.jobs)
      ? store.jobs.slice(0, MAX_PERSISTED_CRON_JOBS)
      : [];
    for (const raw of storedJobs) {
      const job = normalizeStoredJob(raw);
      if (!job || this.jobs.has(job.id)) continue;
      this.jobs.set(job.id, job);
    }
    // A persisted running marker means the previous process died while this
    // job's handler was executing. Stash it for consumeInterruption().
    this._interrupted = normalizeRunningMarker(store?.running, this.jobs);
    this.running = null;
    return this.listJobs();
  }

  addJob(job) {
    const existing = job.id ? this.jobs.get(job.id) : null;
    const result = super.addJob(job);
    if (!existing || job.replace === true) this.save();
    return result;
  }

  updateJob(id, patch) {
    const job = super.updateJob(id, patch);
    this.save();
    return job;
  }

  removeJob(id) {
    const removed = super.removeJob(id);
    if (removed) this.save();
    return removed;
  }

  enableJob(id, enabled) {
    const job = super.enableJob(id, enabled);
    this.save();
    return job;
  }

  async runDue(handler, now = new Date(), options = {}) {
    const results = await super.runDue(handler, now, options);
    if (results.length > 0) this.save();
    return results;
  }

  // runDue() hooks (see CronScheduler.runDue): persist the mid-run marker
  // while a handler executes so a daemon death mid-job is visible next boot.
  noteJobStart(job) {
    this.running = { runningJobId: job.id, startedAt: nowIso() };
    this.save();
  }

  // No disk write here (was a full-file rewrite on every job, tripling I/O
  // per tick): the in-memory clear is always flushed by whichever comes
  // next — the following job's noteJobStart(), or runDue's own tick-closing
  // save() if this was the last job — before a crash could observe the gap.
  noteJobEnd() {
    this.running = null;
  }

  _modelPinsChanged() {
    this.save();
  }

  // Boot note: return the marker left by a process that died mid-job (or
  // null after a clean shutdown), clearing it from memory and disk. The
  // hosted interface calls this once at boot and emits "cron-interrupted".
  consumeInterruption() {
    const marker = this._interrupted;
    this._interrupted = null;
    if (!marker) return null;
    this.save();
    const job = marker.runningJobId ? this.jobs.get(marker.runningJobId) : null;
    return {
      ...marker,
      jobName: job?.name ?? (marker.runningJobId ?? "unknown"),
      projectId: job?.input?.projectId ?? "default",
      projectRevision: job?.input?.projectRevision ?? null
    };
  }

  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      jobs: this.listJobs(),
      ...(this.running ? { running: this.running } : {})
    });
  }
}

function readCronStore(storePath) {
  try {
    const stat = fs.statSync(storePath);
    if (!stat.isFile() || stat.size > MAX_CRON_STORE_BYTES) return null;
    const parsed = readJsonFile(storePath, null);
    return isPlainRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

function normalizeStoredJob(value) {
  if (!isPlainRecord(value)) return null;
  const id = boundedIdentifier(value.id, JOB_ID_RE);
  const task = boundedIdentifier(value.task, TASK_ID_RE);
  if (!id || !task) return null;
  if (
    (value.name !== undefined && boundedText(value.name, 512) === null)
    || (value.enabled !== undefined && typeof value.enabled !== "boolean")
    || (value.input !== undefined && !isPlainRecord(value.input))
  ) {
    return null;
  }
  const input = boundedJsonObject(value.input ?? {});
  if (!input) return null;
  const enabled = value.enabled ?? true;
  const intervalMs = value.intervalMs == null
    ? null
    : positiveSafeInteger(value.intervalMs);
  if (value.intervalMs != null && intervalMs === null) return null;
  const dailyAt = value.dailyAt == null ? null : boundedText(value.dailyAt, 5);
  if (dailyAt !== null && !DAILY_AT_RE.test(dailyAt)) return null;
  const nextRunAt = value.nextRunAt == null && !enabled
    ? null
    : validIso(value.nextRunAt);
  if (enabled && !nextRunAt) return null;
  if (!enabled && value.nextRunAt != null && !nextRunAt) return null;
  const createdAt = value.createdAt == null
    ? "1970-01-01T00:00:00.000Z"
    : validIso(value.createdAt);
  if (!createdAt) return null;
  const lastRunAt = value.lastRunAt == null ? null : validIso(value.lastRunAt);
  if (value.lastRunAt != null && !lastRunAt) return null;
  const pinnedProvider = value.pinnedProvider == null
    ? null
    : boundedText(value.pinnedProvider, 256);
  const pinnedModel = value.pinnedModel == null
    ? null
    : boundedText(value.pinnedModel, 512);
  if (
    (value.pinnedProvider != null && !pinnedProvider)
    || (value.pinnedModel != null && !pinnedModel)
  ) {
    return null;
  }
  return {
    id,
    name: boundedText(value.name, 512) ?? "Scheduled job",
    enabled,
    task,
    input,
    intervalMs,
    dailyAt,
    nextRunAt,
    createdAt,
    lastRunAt,
    pinnedProvider,
    pinnedModel
  };
}

function normalizeRunningMarker(value, jobs) {
  if (!isPlainRecord(value)) return null;
  const runningJobId = boundedIdentifier(value.runningJobId, JOB_ID_RE);
  const startedAt = validIso(value.startedAt);
  if (!runningJobId || !startedAt || !jobs.has(runningJobId)) return null;
  return { runningJobId, startedAt };
}

function boundedJsonObject(value) {
  if (!isPlainRecord(value)) return null;
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_CRON_INPUT_NODES || current.depth > MAX_CRON_INPUT_DEPTH) {
      return null;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_CRON_INPUT_NODES) return null;
      for (const item of current.value) {
        if (item && typeof item === "object") {
          if (!Array.isArray(item) && !isPlainRecord(item)) return null;
          stack.push({ value: item, depth: current.depth + 1 });
        } else if (!validJsonScalar(item)) {
          return null;
        }
      }
      continue;
    }
    if (!isPlainRecord(current.value)) return null;
    const entries = Object.entries(current.value);
    if (entries.length > MAX_CRON_INPUT_NODES) return null;
    for (const [key, item] of entries) {
      if (!key || key.length > 256) return null;
      if (item && typeof item === "object") {
        if (!Array.isArray(item) && !isPlainRecord(item)) return null;
        stack.push({ value: item, depth: current.depth + 1 });
      } else if (!validJsonScalar(item)) {
        return null;
      }
    }
  }
  return structuredClone(value);
}

function validJsonScalar(value) {
  return (
    value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= MAX_CRON_INPUT_STRING)
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedIdentifier(value, pattern) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return pattern.test(text) ? text : null;
}

function boundedText(value, maxLength) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validIso(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

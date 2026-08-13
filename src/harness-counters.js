import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { appendJsonLine } from "./file-utils.js";

export const HARNESS_COUNTERS_KILL_SWITCH = "OPENAGI_HARNESS_COUNTERS";
export const DEFAULT_HARNESS_COUNTER_MAX_BYTES = 5 * 1024 * 1024;

export class HarnessCounterJournal {
  constructor(options = {}) {
    const dataDir = path.resolve(options.dataDir ?? resolveDataDir());
    this.filePath = path.resolve(
      options.filePath ?? path.join(dataDir, "metrics", "harness-counters.jsonl")
    );
    this.rotatedPath = rotatedJournalPath(this.filePath);
    this.env = options.env ?? process.env;
    this.clock = typeof options.clock === "function" ? options.clock : () => new Date();
    const requestedMaxBytes = Number(options.maxBytes);
    this.maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.floor(requestedMaxBytes)
      : DEFAULT_HARNESS_COUNTER_MAX_BYTES;
  }

  record(kind, meta = {}) {
    try {
      if (!harnessCountersEnabled(this.env)) return false;
      const normalizedKind = typeof kind === "string" ? kind.trim() : "";
      if (!normalizedKind) return false;
      const event = counterEvent(normalizedKind, meta, this.clock);
      const lineBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
      rotateJournalIfNeeded(
        this.filePath,
        this.rotatedPath,
        this.maxBytes,
        lineBytes
      );
      appendJsonLine(this.filePath, event);
      return true;
    } catch {
      // Metrics must never become a new failure mode for the operation counted.
      return false;
    }
  }

  aggregate(options = {}) {
    return aggregateCounters({
      ...options,
      filePath: this.filePath
    });
  }
}

export function harnessCountersEnabled(env = process.env) {
  try {
    return String(env?.[HARNESS_COUNTERS_KILL_SWITCH] ?? "").trim() !== "0";
  } catch {
    return false;
  }
}

export function recordHarnessCounter(kind, meta = {}, options = {}) {
  return new HarnessCounterJournal(options).record(kind, meta);
}

export function aggregateCounters({
  since = null,
  dataDir = undefined,
  filePath = undefined
} = {}) {
  const journalPath = path.resolve(
    filePath
    ?? path.join(path.resolve(dataDir ?? resolveDataDir()), "metrics", "harness-counters.jsonl")
  );
  const sinceMs = normalizeSince(since);
  const totals = new Map();
  for (const candidate of [rotatedJournalPath(journalPath), journalPath]) {
    let contents;
    try {
      contents = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object" || typeof event.kind !== "string") continue;
      const kind = event.kind.trim();
      if (!kind) continue;
      if (sinceMs !== null) {
        const eventMs = Date.parse(String(event.ts ?? ""));
        if (!Number.isFinite(eventMs) || eventMs < sinceMs) continue;
      }
      totals.set(kind, (totals.get(kind) ?? 0) + 1);
    }
  }
  return Object.fromEntries(
    [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

function counterEvent(kind, meta, clock) {
  const event = Object.create(null);
  event.ts = normalizeTimestamp(clock());
  event.kind = kind;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta)) {
      if (key === "ts" || key === "kind") continue;
      event[key] = value;
    }
  }
  return event;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid harness counter timestamp.");
  return date.toISOString();
}

function normalizeSince(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function rotatedJournalPath(filePath) {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.1${extension}`;
}

function rotateJournalIfNeeded(filePath, rotatedPath, maxBytes, additionalBytes) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isFile() || stats.size + additionalBytes <= maxBytes) return;

  // Keep one bounded archive. The active journal itself is never rewritten or
  // truncated: it is moved wholesale, then the next append creates a new file.
  try {
    fs.rmSync(rotatedPath, { force: true });
    fs.renameSync(filePath, rotatedPath);
  } catch (error) {
    // Do not append past the cap when rotation cannot be completed.
    throw error;
  }
}

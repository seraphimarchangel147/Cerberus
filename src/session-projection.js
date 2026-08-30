// Session projection surface (DeepSeek-harness parity, dsh session-projection):
// consistent cuts across the run inspector's event journal and the workspace
// timeline head, with provenance hashing, cut diffing, and a redaction-
// waterfall export envelope.
//
// Read-side only: capturing a projection never mutates the systems it reads.
// Cuts are content-free by design — run ids/kinds/statuses plus the timeline
// head's content hash, never prompts, arguments, payloads, or file contents —
// matching the list_runs contract. The export path still runs
// sanitizeForAudit as a last-line redaction waterfall before anything leaves
// the process.
//
// File-backed at <dataDir>/projections/projections.jsonl. One JSONL journal,
// replayed on boot; compacted in place when it exceeds bounds. Same store
// conventions as run-inspector.js (fsynced appends are authoritative).

import path from "node:path";
import fs from "node:fs";
import {
  appendJsonLine,
  ensureDir,
  writeTextAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { sanitizeForAudit } from "./redact.js";
import { createId, nowIso, stableHash } from "./utils.js";

export const SESSION_PROJECTION_VERSION = 1;
export const MAX_PROJECTIONS = 1_000;
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
export const RUNS_PER_CUT = 500;

const ID_RE = /^proj_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,127})?$/;
const TERMINAL_ERR = new Set(["failed"]);
const TERMINAL_WARN = new Set(["blocked", "cancelled", "interrupted", "rolled_back"]);

export class SessionProjectionError extends Error {
  constructor(message, code = "SESSION_PROJECTION_ERROR") {
    super(message);
    this.name = "SessionProjectionError";
    this.code = code;
  }
}

function requiredProjectId(value) {
  const projectId = String(value ?? "").trim();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new SessionProjectionError(
      "A valid projectId is required.",
      "SESSION_PROJECTION_PROJECT_INVALID"
    );
  }
  return projectId;
}

function requiredProjectionId(value) {
  const id = String(value ?? "").trim();
  if (!ID_RE.test(id)) {
    throw new SessionProjectionError(
      "A valid projection id (proj_…) is required.",
      "SESSION_PROJECTION_ID_INVALID"
    );
  }
  return id;
}

// Canonical form for provenance hashing: recency ordering from the inspector
// is display order, not identity, so the hash sorts runs by kind|runId. Two
// captures of unchanged system state produce the same provenanceHash even
// though their ids and capturedAt timestamps differ.
function canonicalCut(cut) {
  const runs = [...cut.runs]
    .map((run) => `${run.kind}|${run.runId}|${run.status}|${run.updatedAt}`)
    .sort();
  return {
    runs,
    timeline: cut.timelineHead?.contentHash ?? null
  };
}

function normalizeStoredRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== SESSION_PROJECTION_VERSION) return null;
  if (!ID_RE.test(String(value.id ?? ""))) return null;
  if (!PROJECT_ID_RE.test(String(value.projectId ?? ""))) return null;
  if (typeof value.capturedAt !== "string" || value.capturedAt.length === 0) {
    return null;
  }
  if (typeof value.provenanceHash !== "string" || value.provenanceHash.length !== 64) {
    return null;
  }
  const cut = value.cut;
  if (!cut || typeof cut !== "object" || !Array.isArray(cut.runs)) return null;
  return value;
}

export class SessionProjectionStore {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "projections")
    );
    ensureDir(this.dir);
    this.journalPath = path.join(this.dir, "projections.jsonl");
    this.appendRecord = options.appendRecord ?? appendJsonLine;
    this.rewriteJournal = options.rewriteJournal ?? writeTextAtomic;
    this.now = options.now ?? nowIso;
    this.records = new Map(); // id -> record (insertion order = journal order)
    this._load();
  }

  _load() {
    let text = "";
    try {
      text = fs.readFileSync(this.journalPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // torn tail from an interrupted append is skipped
      }
      const record = normalizeStoredRecord(parsed);
      if (record) this.records.set(record.id, record);
    }
  }

  _persist(record) {
    this.appendRecord(this.journalPath, record);
    this.records.set(record.id, record);
    if (this.records.size > MAX_PROJECTIONS) this._compact();
  }

  _compact() {
    const retained = [...this.records.values()]
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, MAX_PROJECTIONS)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    this.rewriteJournal(
      this.journalPath,
      retained.length > 0
        ? `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`
        : ""
    );
    this.records = new Map(retained.map((record) => [record.id, record]));
  }

  // The live cut without persistence — the "to" side of a diff against now.
  currentCut(projectId) {
    const project = requiredProjectId(projectId);
    let runs = [];
    try {
      runs = typeof this.runtime?.runInspector?.list === "function"
        ? this.runtime.runInspector.list({ projectId: project, limit: RUNS_PER_CUT })
            .map((run) => ({
              runId: run.runId,
              kind: run.kind,
              status: run.status,
              updatedAt: run.updatedAt
            }))
        : [];
    } catch {
      runs = [];
    }
    let timelineHead = null;
    try {
      const head = this.runtime?.timeline?.head?.(project);
      if (head) {
        timelineHead = {
          id: head.id ?? null,
          contentHash: head.contentHash ?? null
        };
      }
    } catch {
      timelineHead = null; // unknown/unauthorized project workspace → no head
    }
    return { runs, timelineHead };
  }

  capture(options = {}) {
    const projectId = requiredProjectId(options.projectId);
    const cut = this.currentCut(projectId);
    const record = {
      version: SESSION_PROJECTION_VERSION,
      id: createId("proj"),
      projectId,
      capturedAt: this.now(),
      provenanceHash: stableHash(canonicalCut(cut)),
      cut
    };
    this._persist(record);
    return structuredClone(record);
  }

  get(options = {}) {
    const projectId = requiredProjectId(options.projectId);
    const id = requiredProjectionId(options.id);
    const record = this.records.get(id) ?? null;
    // Fail-closed: a projection from another project is indistinguishable
    // from one that does not exist.
    if (!record || record.projectId !== projectId) return null;
    return structuredClone(record);
  }

  list(options = {}) {
    const projectId = requiredProjectId(options.projectId);
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_PROJECTIONS)
      : 50;
    return [...this.records.values()]
      .filter((record) => record.projectId === projectId)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        capturedAt: record.capturedAt,
        provenanceHash: record.provenanceHash,
        runCount: record.cut.runs.length,
        timelineHead: record.cut.timelineHead
          ? { ...record.cut.timelineHead }
          : null
      }));
  }

  diff(options = {}) {
    const projectId = requiredProjectId(options.projectId);
    const from = this.get({ projectId, id: options.fromId });
    if (!from) {
      throw new SessionProjectionError(
        `No projection "${String(options.fromId ?? "").trim()}" in this project.`,
        "SESSION_PROJECTION_NOT_FOUND"
      );
    }
    const toRecord = options.toId != null
      ? this.get({ projectId, id: options.toId })
      : null;
    if (options.toId != null && !toRecord) {
      throw new SessionProjectionError(
        `No projection "${String(options.toId ?? "").trim()}" in this project.`,
        "SESSION_PROJECTION_NOT_FOUND"
      );
    }
    const toCut = toRecord ? toRecord.cut : this.currentCut(projectId);
    const toHash = toRecord
      ? toRecord.provenanceHash
      : stableHash(canonicalCut(toCut));
    const identical = from.provenanceHash === toHash;

    const fromRuns = new Map(
      from.cut.runs.map((run) => [`${run.kind}:${run.runId}`, run])
    );
    const toRuns = new Map(
      toCut.runs.map((run) => [`${run.kind}:${run.runId}`, run])
    );
    const runsAdded = [];
    const runsAgedOut = [];
    const statusChanged = [];
    for (const [key, run] of toRuns) {
      const prior = fromRuns.get(key);
      if (!prior) {
        runsAdded.push({ ...run });
      } else if (prior.status !== run.status) {
        statusChanged.push({
          runId: run.runId,
          kind: run.kind,
          from: prior.status,
          to: run.status
        });
      }
    }
    for (const [key, run] of fromRuns) {
      if (!toRuns.has(key)) runsAgedOut.push({ ...run });
    }

    const fromHead = from.cut.timelineHead?.contentHash ?? null;
    const toHead = toCut.timelineHead?.contentHash ?? null;
    return {
      projectId,
      from: { id: from.id, capturedAt: from.capturedAt, provenanceHash: from.provenanceHash },
      to: toRecord
        ? { id: toRecord.id, capturedAt: toRecord.capturedAt, provenanceHash: toRecord.provenanceHash }
        : { id: null, capturedAt: this.now(), provenanceHash: toHash },
      identical,
      runsAdded,
      runsAgedOut,
      statusChanged,
      timelineHeadChanged: fromHead !== toHead,
      timelineHead: { from: fromHead, to: toHead }
    };
  }

  // Outbound-safe telemetry envelope (dsh SessionTelemetryRecord parity):
  // severity ladder + provenance hash + redaction waterfall over the body.
  export(options = {}) {
    const projectId = requiredProjectId(options.projectId);
    const record = this.get({ projectId, id: options.id });
    if (!record) {
      throw new SessionProjectionError(
        `No projection "${String(options.id ?? "").trim()}" in this project.`,
        "SESSION_PROJECTION_NOT_FOUND"
      );
    }
    let severity = "info";
    for (const run of record.cut.runs) {
      if (TERMINAL_ERR.has(run.status)) {
        severity = "err";
        break;
      }
      if (TERMINAL_WARN.has(run.status)) severity = "warn";
    }
    return {
      version: SESSION_PROJECTION_VERSION,
      exportedAt: this.now(),
      projectId,
      severity,
      provenanceHash: record.provenanceHash,
      projection: sanitizeForAudit({
        id: record.id,
        capturedAt: record.capturedAt,
        cut: record.cut
      })
    };
  }
}
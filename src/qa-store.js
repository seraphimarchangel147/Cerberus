import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeBufferAtomic,
  writeJsonAtomic
} from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

const RUN_ID_RE = /^qa_[a-f0-9]{16}$/;
const ARTIFACT_REF_RE = /^qaart_[a-f0-9]{64}$/;
const BASELINE_ID_RE = /^qabase_[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RESULT_ID_RE = /^[a-z][a-z0-9_-]{0,255}$/;
const RUN_STATES = new Set([
  "planned",
  "running",
  "passed",
  "failed",
  "cancelled",
  "blocked"
]);
const ACTIVE_STATES = new Set(["running"]);
const MEDIA_TYPES = new Set([
  "application/json",
  "application/zip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain"
]);
const RETENTIONS = new Set(["baseline", "failure", "success"]);
const MAX_RUNS = 1_000;
const MAX_ARTIFACTS = 10_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_RESULTS = 500;
const SUCCESS_RETENTION_MS = 24 * 60 * 60 * 1_000;
const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class QaRunStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "qa-runs")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.now = options.now ?? nowIso;
    this.runs = new Map();
    ensureDir(this.dir);
    this._load();
    this._reconcileInterrupted();
  }

  create(input) {
    const at = this.now();
    const run = normalizeRun({
      version: 1,
      id: input.id ?? createId("qa"),
      revision: 1,
      state: "planned",
      projectId: input.projectId,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      sourceRevision: input.sourceRevision,
      manifest: input.manifest,
      mode: input.mode ?? "full",
      results: [],
      artifacts: [],
      summary: emptySummary(),
      error: null,
      createdAt: at,
      updatedAt: at
    });
    if (!run) throw new TypeError("QA run is invalid.");
    if (this.runs.has(run.id)) throw new Error(`QA run already exists: ${run.id}`);
    this._commit("create", run);
    return clone(run);
  }

  update(id, expectedRevision, patch) {
    const current = this.runs.get(String(id ?? ""));
    if (!current) throw new Error(`Unknown QA run: ${id}`);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `QA run revision conflict: expected ${expectedRevision}, found ${current.revision}.`
      );
    }
    const run = normalizeRun({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      version: current.version,
      revision: current.revision + 1,
      projectId: current.projectId,
      sessionId: current.sessionId,
      workspaceRoot: current.workspaceRoot,
      sourceRevision: current.sourceRevision,
      manifest: current.manifest,
      createdAt: current.createdAt,
      updatedAt: this.now()
    });
    if (!run) throw new TypeError("QA run transition is invalid.");
    this._commit("update", run);
    return clone(run);
  }

  get(id) {
    const run = this.runs.get(String(id ?? ""));
    return run ? clone(run) : null;
  }

  list({ projectId, sessionId, limit = 50 } = {}) {
    return [...this.runs.values()]
      .filter((run) => projectId == null || run.projectId === String(projectId))
      .filter((run) => sessionId == null || run.sessionId === String(sessionId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedInteger(limit, 1, 100, 50))
      .map(clone);
  }

  _commit(op, run) {
    const event = {
      version: 1,
      op,
      at: run.updatedAt,
      run
    };
    this.appendEvent(this.eventsPath, event);
    this.runs.set(run.id, clone(run));
    this._trim();
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: run.updatedAt,
        runs: [...this.runs.values()]
      });
    } catch {
      // The fsynced JSONL event is authoritative.
    }
  }

  _load() {
    const events = readJsonLines(this.eventsPath).filter((event) => (
      event?.version === 1
      && ["create", "update"].includes(event.op)
    ));
    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      snapshot = null;
    }
    if (events.length === 0) {
      for (const run of snapshot?.runs ?? []) this._install(run);
    } else {
      for (const event of events) this._install(event.run);
    }
    this._trim();
  }

  _install(value) {
    const run = normalizeRun(value);
    if (!run) return;
    const current = this.runs.get(run.id);
    if (!current || current.revision < run.revision) {
      this.runs.set(run.id, run);
    }
  }

  _trim() {
    if (this.runs.size <= MAX_RUNS) return;
    const retained = [...this.runs.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RUNS);
    this.runs = new Map(retained.map((run) => [run.id, run]));
  }

  _reconcileInterrupted() {
    for (const run of [...this.runs.values()]) {
      if (!ACTIVE_STATES.has(run.state)) continue;
      this.update(run.id, run.revision, {
        state: "blocked",
        error: {
          code: "qa_interrupted",
          message: "The QA process restarted during an active run."
        }
      });
    }
  }
}

export class QaArtifactStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "qa-runs", "artifacts")
    );
    this.blobDir = path.join(this.dir, "blobs");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.writeBlob = options.writeBlob ?? writeBufferAtomic;
    this.now = options.now ?? nowIso;
    this.entries = new Map();
    ensureDir(this.blobDir);
    this._load();
  }

  put(data, {
    projectId,
    runId,
    kind,
    mediaType,
    retention = "success"
  }) {
    const bytes = Buffer.from(data);
    if (bytes.length < 1 || bytes.length > MAX_ARTIFACT_BYTES) {
      throw new RangeError("QA artifact exceeds its 100 MiB bound.");
    }
    const project = requiredProjectId(projectId);
    const run = requiredRunId(runId);
    const normalizedKind = requiredAscii(kind, "artifact kind", 64);
    const normalizedMediaType = String(mediaType ?? "").toLowerCase();
    if (!MEDIA_TYPES.has(normalizedMediaType)) {
      throw new TypeError("QA artifact media type is unsupported.");
    }
    if (!RETENTIONS.has(retention)) {
      throw new TypeError("QA artifact retention class is invalid.");
    }
    const sha256 = createHash("sha256")
      .update(normalizedMediaType)
      .update("\0")
      .update(bytes)
      .digest("hex");
    const ref = `qaart_${sha256}`;
    const blobPath = this._blobPath(sha256);
    if (fs.existsSync(blobPath)) {
      const stat = fs.lstatSync(blobPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("QA artifact blob path is not a regular file.");
      }
      const existing = fs.readFileSync(blobPath);
      if (!existing.equals(bytes)) {
        throw new Error("QA artifact content-address collision.");
      }
    } else {
      this.writeBlob(blobPath, bytes);
    }

    const binding = {
      projectId: project,
      runId: run,
      kind: normalizedKind,
      retention,
      createdAt: this.now()
    };
    const event = {
      version: 1,
      op: "bind",
      at: binding.createdAt,
      artifact: {
        ref,
        sha256,
        bytes: bytes.length,
        mediaType: normalizedMediaType
      },
      binding
    };
    this.appendEvent(this.eventsPath, event);
    this._install(event);
    this._writeSnapshot();
    return this.metadata(ref, { projectId: project, runId: run });
  }

  retain(ref, {
    projectId,
    runId,
    kind,
    retention
  }) {
    const entry = this._authorized(ref, projectId, runId);
    const binding = {
      projectId: requiredProjectId(projectId),
      runId: requiredRunId(runId),
      kind: requiredAscii(kind, "artifact kind", 64),
      retention: String(retention ?? "")
        .toLowerCase(),
      createdAt: this.now()
    };
    if (!RETENTIONS.has(binding.retention)) {
      throw new TypeError("QA artifact retention class is invalid.");
    }
    const event = {
      version: 1,
      op: "bind",
      at: binding.createdAt,
      artifact: {
        ref: entry.ref,
        sha256: entry.sha256,
        bytes: entry.bytes,
        mediaType: entry.mediaType
      },
      binding
    };
    this.appendEvent(this.eventsPath, event);
    this._install(event);
    this._writeSnapshot();
    return this.metadata(ref, {
      projectId: binding.projectId,
      runId: binding.runId
    });
  }

  prune({
    now = this.now(),
    successTtlMs = SUCCESS_RETENTION_MS,
    failureTtlMs = FAILURE_RETENTION_MS
  } = {}) {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("QA artifact prune time is invalid.");
    }
    const successTtl = boundedInteger(
      successTtlMs,
      60_000,
      365 * 24 * 60 * 60 * 1_000,
      SUCCESS_RETENTION_MS
    );
    const failureTtl = boundedInteger(
      failureTtlMs,
      60_000,
      365 * 24 * 60 * 60 * 1_000,
      FAILURE_RETENTION_MS
    );
    let bindingsRemoved = 0;
    const refsBefore = new Set(this.entries.keys());
    for (const entry of [...this.entries.values()]) {
      for (const binding of [...entry.bindings]) {
        if (binding.retention === "baseline") continue;
        const ttl = binding.retention === "failure"
          ? failureTtl
          : successTtl;
        if (timestamp - Date.parse(binding.createdAt) < ttl) continue;
        const event = {
          version: 1,
          op: "unbind",
          at: now,
          ref: entry.ref,
          binding
        };
        this.appendEvent(this.eventsPath, event);
        this._install(event);
        bindingsRemoved += 1;
      }
    }
    let blobsRemoved = 0;
    for (const ref of refsBefore) {
      if (this.entries.has(ref)) continue;
      const sha256 = ref.slice("qaart_".length);
      const blobPath = this._blobPath(sha256);
      try {
        const stat = fs.lstatSync(blobPath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fs.unlinkSync(blobPath);
        blobsRemoved += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (bindingsRemoved > 0) this._writeSnapshot();
    return { bindingsRemoved, blobsRemoved };
  }

  metadata(ref, { projectId, runId = null } = {}) {
    const entry = this._authorized(ref, projectId, runId);
    return publicArtifact(entry, projectId, runId);
  }

  read(ref, {
    projectId,
    runId = null,
    includeData = false,
    maxBytes = 20 * 1024 * 1024
  } = {}) {
    const entry = this._authorized(ref, projectId, runId);
    const blobPath = this._blobPath(entry.sha256);
    const stat = fs.lstatSync(blobPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("QA artifact blob path is not a regular file.");
    }
    const blob = fs.readFileSync(blobPath);
    if (
      blob.length !== entry.bytes
      || createHash("sha256")
        .update(entry.mediaType)
        .update("\0")
        .update(blob)
        .digest("hex") !== entry.sha256
    ) {
      throw new Error("QA artifact failed its integrity check.");
    }
    const result = publicArtifact(entry, projectId, runId);
    if (includeData) {
      if (blob.length > boundedInteger(
        maxBytes,
        1,
        MAX_ARTIFACT_BYTES,
        20 * 1024 * 1024
      )) {
        throw new RangeError("QA artifact is too large for inline retrieval.");
      }
      result.data = entry.mediaType.startsWith("text/")
        || entry.mediaType === "application/json"
        ? blob.toString("utf8")
        : blob.toString("base64");
      result.encoding = entry.mediaType.startsWith("text/")
        || entry.mediaType === "application/json"
        ? "utf8"
        : "base64";
    }
    return result;
  }

  readBytes(ref, {
    projectId,
    runId = null,
    maxBytes = MAX_ARTIFACT_BYTES
  } = {}) {
    const entry = this._authorized(ref, projectId, runId);
    const limit = boundedInteger(
      maxBytes,
      1,
      MAX_ARTIFACT_BYTES,
      MAX_ARTIFACT_BYTES
    );
    if (entry.bytes > limit) {
      throw new RangeError("QA artifact exceeds the requested byte bound.");
    }
    const blobPath = this._blobPath(entry.sha256);
    const stat = fs.lstatSync(blobPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== entry.bytes
      || stat.size > limit
    ) {
      throw new Error("QA artifact blob path is invalid.");
    }
    const data = fs.readFileSync(blobPath);
    if (
      createHash("sha256")
        .update(entry.mediaType)
        .update("\0")
        .update(data)
        .digest("hex") !== entry.sha256
    ) {
      throw new Error("QA artifact failed its integrity check.");
    }
    return {
      ...publicArtifact(entry, projectId, runId),
      data
    };
  }

  list({ projectId, runId, limit = 100 } = {}) {
    const project = requiredProjectId(projectId);
    const run = runId == null ? null : requiredRunId(runId);
    const output = [];
    for (const entry of this.entries.values()) {
      const binding = entry.bindings.find((candidate) => (
        candidate.projectId === project
        && (run === null || candidate.runId === run)
      ));
      if (!binding) continue;
      output.push(publicArtifact(entry, project, run));
    }
    return output
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedInteger(limit, 1, 500, 100));
  }

  _authorized(ref, projectId, runId) {
    const id = String(ref ?? "");
    if (!ARTIFACT_REF_RE.test(id)) {
      throw new TypeError("Invalid QA artifact ref.");
    }
    const project = requiredProjectId(projectId);
    const run = runId == null ? null : requiredRunId(runId);
    const entry = this.entries.get(id);
    if (
      !entry
      || !entry.bindings.some((binding) => (
        binding.projectId === project
        && (run === null || binding.runId === run)
      ))
    ) {
      throw new Error("QA artifact is outside the current project or run.");
    }
    return entry;
  }

  _blobPath(sha256) {
    if (!SHA256_RE.test(String(sha256 ?? ""))) {
      throw new TypeError("Invalid QA artifact digest.");
    }
    return path.join(this.blobDir, sha256);
  }

  _load() {
    const events = readJsonLines(this.eventsPath).filter((event) => (
      event?.version === 1 && ["bind", "unbind"].includes(event.op)
    ));
    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      snapshot = null;
    }
    if (events.length === 0) {
      for (const entry of snapshot?.entries ?? []) {
        const normalized = normalizeArtifactEntry(entry);
        if (normalized) this.entries.set(normalized.ref, normalized);
      }
    } else {
      for (const event of events) this._install(event);
    }
    this._trim();
  }

  _install(event) {
    if (event?.version === 1 && event.op === "unbind") {
      const ref = String(event.ref ?? "");
      const binding = normalizeBinding(event.binding);
      if (!ARTIFACT_REF_RE.test(ref) || !binding) return;
      const current = this.entries.get(ref);
      if (!current) return;
      current.bindings = current.bindings.filter(
        (candidate) => !sameBinding(candidate, binding)
      );
      if (current.bindings.length < 1) {
        this.entries.delete(ref);
      } else {
        this.entries.set(ref, current);
      }
      return;
    }
    const artifact = normalizeArtifact(event?.artifact);
    const binding = normalizeBinding(event?.binding);
    if (event?.version !== 1 || event.op !== "bind" || !artifact || !binding) {
      return;
    }
    const current = this.entries.get(artifact.ref);
    if (
      current
      && (
        current.sha256 !== artifact.sha256
        || current.bytes !== artifact.bytes
        || current.mediaType !== artifact.mediaType
      )
    ) {
      return;
    }
    const entry = current ?? { ...artifact, bindings: [] };
    if (!entry.bindings.some((candidate) => (
      candidate.projectId === binding.projectId
      && candidate.runId === binding.runId
      && candidate.kind === binding.kind
    ))) {
      entry.bindings.push(binding);
    }
    this.entries.set(entry.ref, entry);
  }

  _trim() {
    if (this.entries.size <= MAX_ARTIFACTS) return;
    const retained = [...this.entries.values()]
      .sort((left, right) => latestBinding(right).localeCompare(latestBinding(left)))
      .slice(0, MAX_ARTIFACTS);
    this.entries = new Map(retained.map((entry) => [entry.ref, entry]));
  }

  _writeSnapshot() {
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: this.now(),
        entries: [...this.entries.values()]
      });
    } catch {
      // The fsynced JSONL binding is authoritative.
    }
  }
}

export class QaBaselineStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "qa-runs", "baselines")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.now = options.now ?? nowIso;
    this.baselines = new Map();
    ensureDir(this.dir);
    this._load();
  }

  approve({
    projectId,
    manifestDigest,
    resultId,
    screenshotRef,
    sourceRevision,
    runId,
    approvalId
  }) {
    const project = requiredProjectId(projectId);
    const manifest = requiredSha256(manifestDigest, "manifest digest");
    const result = requiredResultId(resultId);
    const ref = requiredArtifactRef(screenshotRef);
    const source = requiredSha256(sourceRevision, "source revision");
    const run = requiredRunId(runId);
    const approval = requiredAscii(approvalId, "approval id", 128);
    const id = baselineId(project, manifest, result);
    const current = this.baselines.get(id);
    const approvedAt = this.now();
    const baseline = normalizeBaseline({
      version: 1,
      id,
      revision: (current?.revision ?? 0) + 1,
      projectId: project,
      manifestDigest: manifest,
      resultId: result,
      screenshotRef: ref,
      sourceRevision: source,
      runId: run,
      approvalId: approval,
      approvedAt
    });
    if (!baseline) throw new TypeError("QA visual baseline is invalid.");
    const event = {
      version: 1,
      op: "approve",
      at: approvedAt,
      baseline
    };
    this.appendEvent(this.eventsPath, event);
    this._install(baseline);
    this._writeSnapshot();
    return clone(baseline);
  }

  get({ projectId, manifestDigest, resultId }) {
    const id = baselineId(
      requiredProjectId(projectId),
      requiredSha256(manifestDigest, "manifest digest"),
      requiredResultId(resultId)
    );
    const baseline = this.baselines.get(id);
    return baseline ? clone(baseline) : null;
  }

  list({ projectId, manifestDigest = null, limit = 200 } = {}) {
    const project = requiredProjectId(projectId);
    const manifest = manifestDigest == null
      ? null
      : requiredSha256(manifestDigest, "manifest digest");
    return [...this.baselines.values()]
      .filter((baseline) => baseline.projectId === project)
      .filter((baseline) => (
        manifest === null || baseline.manifestDigest === manifest
      ))
      .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))
      .slice(0, boundedInteger(limit, 1, 1_000, 200))
      .map(clone);
  }

  _load() {
    const events = readJsonLines(this.eventsPath).filter((event) => (
      event?.version === 1 && event.op === "approve"
    ));
    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      snapshot = null;
    }
    if (events.length === 0) {
      for (const baseline of snapshot?.baselines ?? []) {
        this._install(baseline);
      }
    } else {
      for (const event of events) this._install(event.baseline);
    }
  }

  _install(value) {
    const baseline = normalizeBaseline(value);
    if (!baseline) return;
    const current = this.baselines.get(baseline.id);
    if (!current || current.revision < baseline.revision) {
      this.baselines.set(baseline.id, baseline);
    }
  }

  _writeSnapshot() {
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: this.now(),
        baselines: [...this.baselines.values()]
      });
    } catch {
      // The fsynced JSONL approval is authoritative.
    }
  }
}

function normalizeRun(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== 1
    || !RUN_ID_RE.test(String(value.id ?? ""))
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !RUN_STATES.has(value.state)
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || typeof value.sessionId !== "string"
    || value.sessionId.length < 1
    || value.sessionId.length > 256
    || typeof value.workspaceRoot !== "string"
    || !SHA256_RE.test(String(value.sourceRevision ?? ""))
    || !value.manifest
    || typeof value.manifest !== "object"
    || !SHA256_RE.test(String(value.manifest.digest ?? ""))
    || !["full", "impacted", "explore"].includes(value.mode)
    || !Array.isArray(value.results)
    || value.results.length > MAX_RESULTS
    || !Array.isArray(value.artifacts)
    || !value.summary
    || typeof value.summary !== "object"
  ) {
    return null;
  }
  try {
    return clone(value);
  } catch {
    return null;
  }
}

function normalizeArtifact(value) {
  if (
    !value
    || typeof value !== "object"
    || !ARTIFACT_REF_RE.test(String(value.ref ?? ""))
    || !SHA256_RE.test(String(value.sha256 ?? ""))
    || value.ref !== `qaart_${value.sha256}`
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || value.bytes > MAX_ARTIFACT_BYTES
    || !MEDIA_TYPES.has(value.mediaType)
  ) {
    return null;
  }
  return {
    ref: value.ref,
    sha256: value.sha256,
    bytes: value.bytes,
    mediaType: value.mediaType
  };
}

function normalizeBinding(value) {
  if (
    !value
    || typeof value !== "object"
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || !RUN_ID_RE.test(String(value.runId ?? ""))
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(String(value.kind ?? ""))
    || !RETENTIONS.has(value.retention)
    || !validIso(value.createdAt)
  ) {
    return null;
  }
  return clone(value);
}

function normalizeBaseline(value) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== 1
    || !BASELINE_ID_RE.test(String(value.id ?? ""))
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !PROJECT_ID_RE.test(String(value.projectId ?? ""))
    || !SHA256_RE.test(String(value.manifestDigest ?? ""))
    || !RESULT_ID_RE.test(String(value.resultId ?? ""))
    || !ARTIFACT_REF_RE.test(String(value.screenshotRef ?? ""))
    || !SHA256_RE.test(String(value.sourceRevision ?? ""))
    || !RUN_ID_RE.test(String(value.runId ?? ""))
    || typeof value.approvalId !== "string"
    || value.approvalId.length < 1
    || value.approvalId.length > 128
    || !/^[\x20-\x7e]+$/u.test(value.approvalId)
    || !validIso(value.approvedAt)
    || value.id !== baselineId(
      value.projectId,
      value.manifestDigest,
      value.resultId
    )
  ) {
    return null;
  }
  return clone(value);
}

function normalizeArtifactEntry(value) {
  const artifact = normalizeArtifact(value);
  if (!artifact || !Array.isArray(value.bindings)) return null;
  const bindings = value.bindings.map(normalizeBinding).filter(Boolean);
  if (bindings.length < 1) return null;
  return { ...artifact, bindings };
}

function publicArtifact(entry, projectId, runId) {
  const bindings = entry.bindings
    .filter((binding) => (
      binding.projectId === projectId
      && (runId == null || binding.runId === runId)
    ))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const binding = bindings[0];
  return {
    ref: entry.ref,
    sha256: entry.sha256,
    bytes: entry.bytes,
    mediaType: entry.mediaType,
    runId: binding.runId,
    kind: binding.kind,
    retention: binding.retention,
    createdAt: binding.createdAt
  };
}

function latestBinding(entry) {
  return entry.bindings.reduce(
    (latest, binding) => binding.createdAt > latest
      ? binding.createdAt
      : latest,
    ""
  );
}

function sameBinding(left, right) {
  return left.projectId === right.projectId
    && left.runId === right.runId
    && left.kind === right.kind
    && left.retention === right.retention
    && left.createdAt === right.createdAt;
}

function baselineId(projectId, manifestDigest, resultId) {
  const digest = createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(manifestDigest)
    .update("\0")
    .update(resultId)
    .digest("hex");
  return `qabase_${digest}`;
}

function emptySummary() {
  return {
    routes: 0,
    controls: 0,
    controlsCovered: 0,
    assertions: 0,
    passed: 0,
    failed: 0,
    warnings: 0,
    visualChanges: 0,
    visualBaselinesMissing: 0,
    keyboardFailures: 0
  };
}

function readJsonLines(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const output = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      output.push(JSON.parse(line));
    } catch {
      // Ignore a partial trailing line.
    }
  }
  return output;
}

function requiredProjectId(value) {
  const id = String(value ?? "");
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid QA project id.");
  return id;
}

function requiredRunId(value) {
  const id = String(value ?? "");
  if (!RUN_ID_RE.test(id)) throw new TypeError("Invalid QA run id.");
  return id;
}

function requiredArtifactRef(value) {
  const ref = String(value ?? "");
  if (!ARTIFACT_REF_RE.test(ref)) {
    throw new TypeError("Invalid QA artifact ref.");
  }
  return ref;
}

function requiredResultId(value) {
  const id = String(value ?? "");
  if (!RESULT_ID_RE.test(id)) throw new TypeError("Invalid QA result id.");
  return id;
}

function requiredSha256(value, label) {
  const digest = String(value ?? "").toLowerCase();
  if (!SHA256_RE.test(digest)) throw new TypeError(`Invalid QA ${label}.`);
  return digest;
}

function requiredAscii(value, label, maxLength) {
  const text = String(value ?? "");
  if (
    text.length < 1
    || text.length > maxLength
    || !/^[\x20-\x7e]+$/u.test(text)
  ) {
    throw new TypeError(`Invalid QA ${label}.`);
  }
  return text;
}

function validIso(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value));
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function clone(value) {
  return structuredClone(value);
}

export const QA_STORE_LIMITS = Object.freeze({
  maxRuns: MAX_RUNS,
  maxArtifacts: MAX_ARTIFACTS,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  maxResults: MAX_RESULTS,
  successRetentionMs: SUCCESS_RETENTION_MS,
  failureRetentionMs: FAILURE_RETENTION_MS
});

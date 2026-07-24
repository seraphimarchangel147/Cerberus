import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso, stableHash } from "./utils.js";

export const WORKSPACE_TIMELINE_POLICY_VERSION = 1;
export const DEFAULT_TIMELINE_MAX_FILES = 5_000;
export const DEFAULT_TIMELINE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMELINE_MAX_BINARY_BYTES = 256 * 1024;
export const DEFAULT_TIMELINE_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TIMELINE_MAX_SNAPSHOTS = 50;
export const DEFAULT_TIMELINE_MAX_BLOB_BYTES = 512 * 1024 * 1024;
export const DEFAULT_TIMELINE_DEBOUNCE_MS = 250;

const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 128 * 1024 * 1024;
const MAX_OPERATIONS = 1_000;
const MAX_DIFF_ITEMS = 2_000;
const MAX_DIFF_CHARS = 64_000;
const MAX_OPAQUE_PATHS = 5_000;
const MAX_REASON_CHARS = 500;
const MAX_TOOL_NAMES = 32;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const ID_RE = /^timeline_[a-f0-9]{16}$/;
const OPERATION_ID_RE = /^timeline_op_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".openagi",
  ".docker",
  ".password-store",
  ".terraform",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".cache",
  "node_modules"
]);
const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".openagi",
  ".docker",
  ".password-store",
  ".terraform",
  ".secrets",
  "secrets"
]);
const REPOSITORY_MARKERS = [".git", ".hg", ".svn"];
const SECRET_FILE_RE = /^(?:\.env(?:\..+)?|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.yarnrc|\.pnpmrc|auth\.json|credentials?(?:\..+)?|secrets?(?:\..+)?|tokens?(?:\..+)?|terraform\.tfstate(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)$/i;
const SECRET_EXTENSION_RE = /\.(?:pem|key|p12|pfx|jks|keystore|tfvars)$/i;
const BINARY_EXTENSION_RE = /\.(?:7z|a|avi|bin|bmp|bz2|class|db|dll|dmg|docx?|dylib|eot|exe|flac|gif|gz|ico|jar|jpeg|jpg|m4a|mkv|mov|mp3|mp4|o|od[st]|ogg|otf|pdf|png|pptx?|pyc|rar|so|sqlite(?:3)?|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|xz|zip)$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export class WorkspaceTimelineError extends Error {
  constructor(message, code = "WORKSPACE_TIMELINE_ERROR", details = {}) {
    super(message);
    this.name = "WorkspaceTimelineError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class WorkspaceTimelineConflictError extends WorkspaceTimelineError {
  constructor(message, conflicts = []) {
    super(message, "WORKSPACE_TIMELINE_CONFLICT", {
      conflicts: [...conflicts].slice(0, 100)
    });
    this.name = "WorkspaceTimelineConflictError";
  }
}

export class WorkspaceTimelineHeadError extends WorkspaceTimelineError {
  constructor(expectedHead, actualHead) {
    super(
      `Workspace timeline head conflict: expected ${expectedHead ?? "none"}, found ${actualHead ?? "none"}.`,
      "WORKSPACE_TIMELINE_HEAD_CONFLICT",
      { expectedHead: expectedHead ?? null, actualHead: actualHead ?? null }
    );
    this.name = "WorkspaceTimelineHeadError";
  }
}

export class WorkspaceTimelineStore {
  constructor(options = {}) {
    const source = plainRecord(options, "WorkspaceTimelineStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(
      source.dir ?? path.join(dataDir, "workspace-timeline")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.manifestsDir = path.join(this.dir, "manifests");
    this.blobsDir = path.join(this.dir, "blobs");
    this.projects = source.projects ?? null;
    this.defaultWorkspaceRoot = path.resolve(
      source.workspaceDir ?? process.cwd()
    );
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.idFactory = typeof source.idFactory === "function"
      ? source.idFactory
      : () => `timeline_${randomBytes(8).toString("hex")}`;
    this.operationIdFactory = typeof source.operationIdFactory === "function"
      ? source.operationIdFactory
      : () => `timeline_op_${randomBytes(8).toString("hex")}`;
    this.maxFiles = integerInRange(
      source.maxFiles,
      "maxFiles",
      1,
      DEFAULT_TIMELINE_MAX_FILES,
      DEFAULT_TIMELINE_MAX_FILES
    );
    this.maxFileBytes = positiveInteger(
      source.maxFileBytes,
      DEFAULT_TIMELINE_MAX_FILE_BYTES
    );
    this.maxBinaryBytes = positiveInteger(
      source.maxBinaryBytes,
      DEFAULT_TIMELINE_MAX_BINARY_BYTES
    );
    this.maxSnapshotBytes = positiveInteger(
      source.maxSnapshotBytes,
      DEFAULT_TIMELINE_MAX_SNAPSHOT_BYTES
    );
    this.maxSnapshots = integerInRange(
      source.maxSnapshots,
      "maxSnapshots",
      2,
      1_000,
      DEFAULT_TIMELINE_MAX_SNAPSHOTS
    );
    this.maxBlobBytes = positiveInteger(
      source.maxBlobBytes,
      DEFAULT_TIMELINE_MAX_BLOB_BYTES
    );
    this.debounceMs = integerInRange(
      source.debounceMs,
      "debounceMs",
      0,
      60_000,
      DEFAULT_TIMELINE_DEBOUNCE_MS
    );
    this.lockTimeoutMs = positiveInteger(
      source.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS
    );
    this.staleLockMs = positiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS
    );
    this.onChange = typeof source.onChange === "function"
      ? source.onChange
      : null;
    this.sequence = 0;
    this.snapshots = new Map();
    this.operations = [];
    this.journalHealthy = true;
    this.journalError = null;
    this.lockDepth = 0;
    this.pendingChanges = null;
    this.pendingCaptures = new Map();
    this.closed = false;
    ensureDir(this.dir);
    ensureDir(this.manifestsDir);
    ensureDir(this.blobsDir);
    this._withLock(() => this._restore());
    if (this.journalHealthy) this._reconcileInterruptedOperations();
  }

  schedulePostMutation({
    toolName,
    tool,
    context = {},
    dispatched = false
  } = {}) {
    if (
      this.closed
      || dispatched !== true
      || !isWorkspaceMutationTool(toolName, tool)
    ) {
      return { scheduled: false };
    }
    const projectId = normalizeProjectId(
      context.__projectId ?? "default"
    );
    const workspaceRoot = path.resolve(
      context.__projectWorkspaceDir
      ?? this._projectWorkspace(projectId)
      ?? this.defaultWorkspaceRoot
    );
    const key = projectId;
    const existing = this.pendingCaptures.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const item = existing ?? {
      projectId,
      workspaceRoot,
      sessionId: context.sessionId == null
        ? null
        : String(context.sessionId).slice(0, 512),
      tools: new Set()
    };
    item.workspaceRoot = workspaceRoot;
    item.sessionId = context.sessionId == null
      ? item.sessionId
      : String(context.sessionId).slice(0, 512);
    if (item.tools.size < MAX_TOOL_NAMES) {
      item.tools.add(boundedToolName(toolName));
    }
    item.timer = setTimeout(() => {
      this._runPendingCapture(projectId);
    }, this.debounceMs);
    item.timer.unref?.();
    this.pendingCaptures.set(key, item);
    return {
      scheduled: true,
      projectId,
      debounceMs: this.debounceMs
    };
  }

  flush(projectId = null) {
    const ids = projectId == null
      ? [...this.pendingCaptures.keys()]
      : [normalizeProjectId(projectId)];
    const results = [];
    for (const id of ids) {
      const result = this._runPendingCapture(id, { throwOnError: true });
      if (result) results.push(result);
    }
    return results;
  }

  close() {
    if (this.closed) return [];
    const flushed = this.flush();
    this.closed = true;
    return flushed;
  }

  captureNow(options = {}) {
    const request = plainRecord(options, "timeline capture");
    const project = this._authorizeProject(request.projectId, {
      workspaceRoot: request.workspaceRoot
    });
    return this._mutate(() => {
      const authorized = this._reauthorizeProject(project);
      return this._captureLoaded({
        project: authorized,
        sessionId: request.sessionId ?? null,
        reason: request.reason ?? "manual",
        toolNames: request.toolNames ?? [],
        suppressGc: false
      });
    });
  }

  list({ projectId, limit = 20 } = {}) {
    const project = this._authorizeProject(projectId);
    const bounded = integerInRange(limit, "limit", 1, 200, 20);
    return this._readFresh(() => this._projectSnapshots(
      this._reauthorizeProject(project).id,
      project.workspaceRoot
    )
      .slice(-bounded)
      .reverse()
      .map((snapshot) => this._viewSnapshot(snapshot)));
  }

  head(projectId) {
    const project = this._authorizeProject(projectId);
    return this._readFresh(() => {
      const authorized = this._reauthorizeProject(project);
      const head = this._headLoaded(authorized.id, authorized.workspaceRoot);
      return head ? this._viewSnapshot(head) : null;
    });
  }

  diff(fromId, toId = "current", options = {}) {
    const request = plainRecord(options, "timeline diff options");
    const project = this._authorizeProject(request.projectId, {
      workspaceRoot: request.workspaceRoot
    });
    const fromSnapshotId = normalizeTimelineId(fromId);
    return this._readFresh(() => {
      const authorized = this._reauthorizeProject(project);
      const from = this._requireSnapshotLoaded(fromSnapshotId, authorized);
      const left = this._readManifest(from.contentHash);
      const right = toId == null || toId === "" || toId === "current"
        ? scanWorkspace(authorized.workspaceRoot, this._scanOptions())
        : this._readManifest(
            this._requireSnapshotLoaded(normalizeTimelineId(toId), authorized)
              .contentHash
          );
      return renderTimelineDiff(left, right, {
        includeText: request.includeText === true,
        maxItems: request.maxItems,
        maxChars: request.maxChars,
        readBlob: (hash) => this._readBlob(hash),
        rightBuffers: right.buffers ?? null
      });
    });
  }

  preview(id, options = {}) {
    const request = plainRecord(options, "timeline preview options");
    const project = this._authorizeProject(request.projectId, {
      workspaceRoot: request.workspaceRoot
    });
    const snapshotId = normalizeTimelineId(id);
    const action = request.action ?? "travel";
    if (!["travel", "revert"].includes(action)) {
      throw new TypeError("timeline preview action must be travel or revert.");
    }
    return this._readFresh(() => {
      const authorized = this._reauthorizeProject(project);
      const snapshot = this._requireSnapshotLoaded(snapshotId, authorized);
      const current = scanWorkspace(authorized.workspaceRoot, this._scanOptions());
      const base = {
        action,
        snapshot: this._viewSnapshot(snapshot),
        currentHead: this._viewSnapshot(
          this._headLoaded(authorized.id, authorized.workspaceRoot)
        )
      };
      try {
        let desired;
        if (action === "travel") {
          desired = buildTravelManifest(
            current,
            this._readManifest(snapshot.contentHash)
          );
        } else {
          const parent = this._requireRevertParentLoaded(snapshot, authorized);
          const selected = this._readManifest(snapshot.contentHash);
          const parentManifest = this._readManifest(parent.contentHash);
          desired = buildRevertManifest(current, selected, parentManifest);
        }
        validateManifestBlobs(
          desired,
          (hash) => current.buffers?.get(hash) ?? this._readBlob(hash)
        );
        preflightWorkspaceApply(authorized.workspaceRoot, current, desired);
        const diff = renderTimelineDiff(current, desired, {
          includeText: true,
          maxItems: request.maxItems,
          maxChars: request.maxChars,
          readBlob: (hash) => this._readBlob(hash),
          leftBuffers: current.buffers ?? null
        });
        return {
          ...base,
          safe: true,
          conflicts: [],
          ...diff
        };
      } catch (error) {
        if (!(error instanceof WorkspaceTimelineConflictError)) throw error;
        return {
          ...base,
          safe: false,
          conflicts: [...error.conflicts],
          error: safeErrorMessage(error),
          counts: null,
          items: [],
          truncated: false
        };
      }
    });
  }

  travel(id, options = {}) {
    return this._restoreOperation("travel", id, options);
  }

  revert(id, options = {}) {
    return this._restoreOperation("revert", id, options);
  }

  gc({ projectId } = {}) {
    const project = this._authorizeProject(projectId);
    return this._mutate(() => {
      const authorized = this._reauthorizeProject(project);
      return this._gcLoaded({
        projectId: authorized.id,
        force: true
      });
    });
  }

  history({ projectId, limit = 100 } = {}) {
    const project = this._authorizeProject(projectId);
    const bounded = integerInRange(limit, "limit", 1, 500, 100);
    return this._readFresh(() => {
      const authorized = this._reauthorizeProject(project);
      return this.operations
        .filter((operation) => operation.projectId === authorized.id)
        .slice(-bounded)
        .reverse()
        .map((operation) => structuredClone(operation));
    });
  }

  _restoreOperation(kind, id, options) {
    const request = plainRecord(options, `timeline ${kind} options`);
    const project = this._authorizeProject(request.projectId, {
      workspaceRoot: request.workspaceRoot
    });
    const snapshotId = normalizeTimelineId(id);
    const expectedHead = normalizeExpectedHead(request.expectedHead);
    return this._mutate(() => {
      const authorized = this._reauthorizeProject(project);
      const selected = this._requireSnapshotLoaded(snapshotId, authorized);
      const head = this._headLoaded(
        authorized.id,
        authorized.workspaceRoot
      );
      if ((head?.id ?? null) !== expectedHead) {
        throw new WorkspaceTimelineHeadError(expectedHead, head?.id ?? null);
      }
      const current = this._captureLoaded({
        project: authorized,
        sessionId: request.sessionId ?? null,
        reason: `before-${kind}`,
        toolNames: [`timeline_${kind}`],
        suppressGc: true
      });
      const currentManifest = this._readManifest(current.contentHash);
      let desired;
      if (kind === "travel") {
        desired = buildTravelManifest(
          currentManifest,
          this._readManifest(selected.contentHash)
        );
      } else {
        const parent = this._requireRevertParentLoaded(selected, authorized);
        const selectedManifest = this._readManifest(selected.contentHash);
        const parentManifest = this._readManifest(parent.contentHash);
        desired = buildRevertManifest(
          currentManifest,
          selectedManifest,
          parentManifest
        );
      }
      desired = this._writeManifest(desired);
      validateManifestBlobs(desired, (hash) => this._readBlob(hash));
      preflightWorkspaceApply(
        authorized.workspaceRoot,
        currentManifest,
        desired
      );

      const operation = normalizeOperation({
        version: 1,
        id: this.operationIdFactory(),
        kind,
        status: "pending",
        projectId: authorized.id,
        sourceSnapshotId: selected.id,
        beforeSnapshotId: current.id,
        resultSnapshotId: null,
        expectedHead,
        requestedAt: this._now(),
        completedAt: null,
        decidedBy: boundedActor(request.decidedBy),
        error: null
      });
      this._upsertOperationLoaded(operation);
      this._commit("operation", authorized.id, { operation });

      try {
        this._reauthorizeProject(authorized);
        verifyWorkspaceManifest(
          authorized.workspaceRoot,
          currentManifest,
          this._scanOptions()
        );
        applyWorkspaceManifest(
          authorized.workspaceRoot,
          currentManifest,
          desired,
          (hash) => this._readBlob(hash)
        );
        this._reauthorizeProject(authorized);
        const observed = scanWorkspace(
          authorized.workspaceRoot,
          this._scanOptions()
        );
        this._reauthorizeProject(authorized);
        assertManifestEntriesMatch(
          desired,
          observed,
          "Workspace recovery did not produce the intended eligible state."
        );
        desired = this._storeScannedManifest(observed);
      } catch (error) {
        const failed = normalizeOperation({
          ...operation,
          status: "failed",
          completedAt: this._now(),
          error: safeErrorMessage(error)
        });
        this._upsertOperationLoaded(failed);
        this._commit("operation", authorized.id, { operation: failed });
        throw error;
      }

      const result = this._recordManifestSnapshotLoaded({
        project: authorized,
        manifest: desired,
        parentId: current.id,
        sessionId: request.sessionId ?? null,
        reason: kind,
        toolNames: [`timeline_${kind}`]
      });
      const complete = normalizeOperation({
        ...operation,
        status: "complete",
        resultSnapshotId: result.id,
        completedAt: this._now(),
        error: null
      });
      this._upsertOperationLoaded(complete);
      this._commit("operation", authorized.id, { operation: complete });
      const gc = this._gcLoaded({ projectId: authorized.id });
      return {
        operation: structuredClone(complete),
        before: this._viewSnapshot(current),
        result: this._viewSnapshot(result),
        removedSnapshots: gc.removedSnapshots,
        quota: {
          retainedBlobBytes: gc.retainedBlobBytes,
          quotaBytes: gc.quotaBytes,
          exceededForRecoverySafety: gc.quotaExceeded
        }
      };
    });
  }

  _runPendingCapture(projectId, { throwOnError = false } = {}) {
    const item = this.pendingCaptures.get(projectId);
    if (!item) return null;
    this.pendingCaptures.delete(projectId);
    if (item.timer) clearTimeout(item.timer);
    try {
      return this.captureNow({
        projectId: item.projectId,
        workspaceRoot: item.workspaceRoot,
        sessionId: item.sessionId,
        reason: "post-mutation",
        toolNames: [...item.tools].sort()
      });
    } catch (error) {
      if (throwOnError) throw error;
      console.warn(
        `[workspace-timeline] post-mutation capture failed: ${safeErrorMessage(error)}`
      );
      return null;
    }
  }

  _captureLoaded({
    project,
    sessionId,
    reason,
    toolNames,
    suppressGc
  }) {
    const scanned = scanWorkspace(project.workspaceRoot, this._scanOptions());
    const manifest = this._storeScannedManifest(scanned);
    const head = this._headLoaded(project.id, project.workspaceRoot);
    if (head?.contentHash === manifest.contentHash) {
      return this._viewSnapshot(head, { deduplicated: true });
    }
    const snapshot = this._recordManifestSnapshotLoaded({
      project,
      manifest,
      parentId: head?.id ?? null,
      sessionId,
      reason,
      toolNames
    });
    if (!suppressGc) this._gcLoaded({ projectId: project.id });
    return this._viewSnapshot(snapshot);
  }

  _storeScannedManifest(scanned) {
    if (scanned.totalBytes > this.maxBlobBytes) {
      throw new WorkspaceTimelineError(
        `Workspace timeline blob quota exceeds ${this.maxBlobBytes} bytes.`,
        "WORKSPACE_TIMELINE_QUOTA"
      );
    }
    for (const [hash, data] of scanned.buffers) this._writeBlob(hash, data);
    return this._writeManifest(scanned);
  }

  _recordManifestSnapshotLoaded({
    project,
    manifest,
    parentId,
    sessionId,
    reason,
    toolNames
  }) {
    const id = String(this.idFactory());
    if (!ID_RE.test(id) || this.snapshots.has(id)) {
      throw new WorkspaceTimelineError(
        "Unable to allocate a unique workspace timeline id."
      );
    }
    const snapshot = normalizeSnapshot({
      version: 1,
      id,
      sequence: this.sequence + 1,
      projectId: project.id,
      projectRevision: project.revision,
      workspaceRoot: project.workspaceRoot,
      parentId,
      contentHash: manifest.contentHash,
      entryCount: manifest.entries.length,
      totalBytes: manifest.totalBytes,
      skipped: manifest.skipped,
      reason: boundedReason(reason),
      toolNames: normalizeToolNames(toolNames),
      sessionId: sessionId == null ? null : String(sessionId),
      createdAt: this._now()
    });
    this.snapshots.set(snapshot.id, snapshot);
    this._commit("snapshot", project.id, { snapshot });
    return snapshot;
  }

  _gcLoaded({ projectId, force = false } = {}) {
    const id = normalizeProjectId(projectId);
    const candidates = this._projectSnapshots(id);
    const remove = new Set();
    const protectedIds = new Set();
    const head = candidates.at(-1);
    if (head) protectedIds.add(head.id);
    const latestOperation = this.operations
      .filter((operation) => operation.projectId === id)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .at(-1);
    if (latestOperation?.beforeSnapshotId) {
      protectedIds.add(latestOperation.beforeSnapshotId);
    }
    let overflow = Math.max(0, candidates.length - this.maxSnapshots);
    for (const snapshot of candidates) {
      if (overflow <= 0) break;
      if (protectedIds.has(snapshot.id)) continue;
      remove.add(snapshot.id);
      overflow -= 1;
    }
    let referenced = this._referencedBlobBytes(remove, id);
    if (referenced.bytes > this.maxBlobBytes || force) {
      const ordered = candidates
        .filter((snapshot) => !remove.has(snapshot.id))
        .sort(compareSnapshot);
      for (const snapshot of ordered) {
        if (referenced.bytes <= this.maxBlobBytes) break;
        if (protectedIds.has(snapshot.id)) continue;
        remove.add(snapshot.id);
        referenced = this._referencedBlobBytes(remove, id);
      }
    }
    const quotaExceeded = referenced.bytes > this.maxBlobBytes;
    if (remove.size === 0) {
      if (force) this._sweepUnreferencedFiles();
      return {
        removedSnapshots: [],
        retainedBlobBytes: referenced.bytes,
        quotaBytes: this.maxBlobBytes,
        quotaExceeded
      };
    }
    const removedSnapshots = [...remove].sort();
    for (const id of removedSnapshots) this.snapshots.delete(id);
    this._commit("gc", id, { removedSnapshots });
    this._sweepUnreferencedFiles();
    return {
      removedSnapshots,
      retainedBlobBytes: referenced.bytes,
      quotaBytes: this.maxBlobBytes,
      quotaExceeded
    };
  }

  _referencedBlobBytes(excludedSnapshotIds = new Set(), projectId = null) {
    const manifests = new Set();
    for (const snapshot of this.snapshots.values()) {
      if (
        !excludedSnapshotIds.has(snapshot.id)
        && (projectId == null || snapshot.projectId === projectId)
      ) {
        manifests.add(snapshot.contentHash);
      }
    }
    const blobs = new Map();
    for (const hash of manifests) {
      const manifest = this._readManifest(hash);
      for (const entry of manifest.entries) {
        if (entry.kind === "file") blobs.set(entry.hash, entry.size);
      }
    }
    return {
      bytes: [...blobs.values()].reduce((sum, size) => sum + size, 0),
      manifests,
      blobs
    };
  }

  _sweepUnreferencedFiles() {
    const referenced = this._referencedBlobBytes();
    sweepHashDirectory(this.manifestsDir, referenced.manifests, ".json");
    sweepHashDirectory(this.blobsDir, new Set(referenced.blobs.keys()), "");
  }

  _scanOptions() {
    return {
      maxFiles: this.maxFiles,
      maxFileBytes: this.maxFileBytes,
      maxBinaryBytes: this.maxBinaryBytes,
      maxSnapshotBytes: this.maxSnapshotBytes
    };
  }

  _writeBlob(hash, data) {
    if (!HASH_RE.test(hash) || sha256(data) !== hash) {
      throw new WorkspaceTimelineError(
        "Workspace timeline blob hash mismatch.",
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
    const destination = path.join(this.blobsDir, hash);
    if (fs.existsSync(destination)) {
      const current = readRegularFileBounded(destination, this.maxFileBytes);
      if (sha256(current) !== hash || !current.equals(data)) {
        throw new WorkspaceTimelineError(
          `Workspace timeline blob ${hash} is corrupt.`,
          "WORKSPACE_TIMELINE_INTEGRITY"
        );
      }
      return;
    }
    writeBufferAtomic(destination, data);
  }

  _readBlob(hash) {
    if (!HASH_RE.test(String(hash ?? ""))) {
      throw new WorkspaceTimelineError(
        "Invalid workspace timeline blob identity.",
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
    const data = readRegularFileBounded(
      path.join(this.blobsDir, hash),
      this.maxFileBytes
    );
    if (sha256(data) !== hash) {
      throw new WorkspaceTimelineError(
        `Workspace timeline blob ${hash} failed verification.`,
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
    return data;
  }

  _writeManifest(scanned) {
    const core = normalizeManifestCore({
      version: 1,
      policyVersion: WORKSPACE_TIMELINE_POLICY_VERSION,
      totalBytes: scanned.totalBytes,
      entries: scanned.entries,
      opaque: scanned.opaque ?? [],
      skipped: scanned.skipped
    });
    const contentHash = hashManifestCore(core);
    const manifest = { ...core, contentHash };
    const destination = path.join(this.manifestsDir, `${contentHash}.json`);
    if (fs.existsSync(destination)) {
      const current = this._readManifest(contentHash);
      if (stableHash(current) !== stableHash(manifest)) {
        throw new WorkspaceTimelineError(
          `Workspace timeline manifest ${contentHash} is corrupt.`,
          "WORKSPACE_TIMELINE_INTEGRITY"
        );
      }
      return current;
    }
    writeJsonAtomic(destination, manifest);
    return manifest;
  }

  _readManifest(hash) {
    if (!HASH_RE.test(String(hash ?? ""))) {
      throw new WorkspaceTimelineError(
        "Invalid workspace timeline manifest identity.",
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
    const manifestPath = path.join(this.manifestsDir, `${hash}.json`);
    let raw;
    try {
      const stat = fs.lstatSync(manifestPath);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size > this.maxSnapshotBytes + 1024 * 1024
      ) {
        throw new Error("manifest is not a bounded regular file");
      }
      raw = readJsonFile(manifestPath, null);
    } catch (error) {
      throw new WorkspaceTimelineError(
        `Workspace timeline manifest ${hash} is unavailable.`,
        "WORKSPACE_TIMELINE_INTEGRITY",
        { cause: safeErrorMessage(error) }
      );
    }
    const source = plainRecord(raw, "workspace timeline manifest");
    assertOnlyKeys(
      source,
      new Set([
        "version",
        "policyVersion",
        "contentHash",
        "totalBytes",
        "entries",
        "opaque",
        "skipped"
      ]),
      "workspace timeline manifest"
    );
    const contentHash = normalizeHash(source.contentHash, "contentHash");
    const core = normalizeManifestCore(source);
    if (
      contentHash !== hash
      || hashManifestCore(core) !== contentHash
    ) {
      throw new WorkspaceTimelineError(
        `Workspace timeline manifest ${hash} failed verification.`,
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
    return { ...core, contentHash };
  }

  _headLoaded(projectId, workspaceRoot = null) {
    return this._projectSnapshots(projectId, workspaceRoot).at(-1) ?? null;
  }

  _projectSnapshots(projectId, workspaceRoot = null) {
    return [...this.snapshots.values()]
      .filter((snapshot) => (
        snapshot.projectId === projectId
        && (
          workspaceRoot == null
          || snapshot.workspaceRoot === workspaceRoot
        )
      ))
      .sort(compareSnapshot);
  }

  _requireSnapshotLoaded(id, project) {
    const snapshot = this.snapshots.get(id);
    if (
      !snapshot
      || snapshot.projectId !== project.id
      || snapshot.workspaceRoot !== project.workspaceRoot
    ) {
      throw new WorkspaceTimelineError(
        "Unknown workspace timeline snapshot.",
        "WORKSPACE_TIMELINE_NOT_FOUND"
      );
    }
    return snapshot;
  }

  _requireRevertParentLoaded(snapshot, project) {
    if (!snapshot.parentId) {
      throw new WorkspaceTimelineConflictError(
        "The first workspace timeline snapshot cannot be reverted."
      );
    }
    return this._requireSnapshotLoaded(snapshot.parentId, project);
  }

  _viewSnapshot(snapshot, additions = {}) {
    if (!snapshot) return null;
    return structuredClone({
      ...snapshot,
      parentAvailable: snapshot.parentId
        ? this.snapshots.has(snapshot.parentId)
        : false,
      ...additions
    });
  }

  _authorizeProject(projectId, { workspaceRoot } = {}) {
    const id = normalizeProjectId(projectId ?? "default");
    let project;
    if (this.projects) {
      try {
        project = typeof this.projects.authorize === "function"
          ? this.projects.authorize(id, { includeArchived: false })
          : this.projects.get?.(id, { includeArchived: false });
      } catch (error) {
        throw new WorkspaceTimelineError(
          `Project '${id}' cannot authorize workspace timeline access.`,
          "PROJECT_BOUNDARY_VIOLATION",
          { cause: safeErrorMessage(error) }
        );
      }
      if (!project || project.status !== "active") {
        throw new WorkspaceTimelineError(
          `Unknown or archived project '${id}'.`,
          "PROJECT_BOUNDARY_VIOLATION"
        );
      }
    } else if (id === "default") {
      project = {
        id,
        revision: 1,
        status: "active",
        workspaceRoot: this.defaultWorkspaceRoot
      };
    } else {
      throw new WorkspaceTimelineError(
        `Project '${id}' cannot be verified.`,
        "PROJECT_BOUNDARY_VIOLATION"
      );
    }
    const root = path.resolve(
      project.workspaceRoot ?? this.defaultWorkspaceRoot
    );
    if (
      workspaceRoot != null
      && path.resolve(String(workspaceRoot)) !== root
    ) {
      throw new WorkspaceTimelineError(
        `Project '${id}' workspace root changed.`,
        "PROJECT_BOUNDARY_VIOLATION"
      );
    }
    assertSafeWorkspaceRoot(root, this.dir);
    return {
      id,
      revision: positiveInteger(project.revision, 1),
      status: "active",
      workspaceRoot: root
    };
  }

  _reauthorizeProject(expected) {
    const fresh = this._authorizeProject(expected.id, {
      workspaceRoot: expected.workspaceRoot
    });
    if (fresh.revision !== expected.revision) {
      throw new WorkspaceTimelineError(
        `Project '${expected.id}' changed during workspace timeline access.`,
        "PROJECT_BOUNDARY_VIOLATION"
      );
    }
    return fresh;
  }

  _projectWorkspace(projectId) {
    try {
      const project = this.projects?.get?.(projectId, {
        includeArchived: false
      });
      return project?.workspaceRoot ?? null;
    } catch {
      return null;
    }
  }

  _readFresh(operation) {
    return this._withLock(() => {
      this._restore();
      this._assertJournalHealthy();
      return operation();
    });
  }

  _mutate(operation) {
    const outermost = this.lockDepth === 0;
    let result;
    let changes = [];
    let failure = null;
    try {
      result = this._withLock(() => {
        if (outermost) {
          this._restore();
          this._assertJournalHealthy();
          this.pendingChanges = [];
        }
        return operation();
      });
    } catch (error) {
      failure = error;
    } finally {
      if (outermost) {
        changes = this.pendingChanges ?? [];
        this.pendingChanges = null;
      }
    }
    if (outermost) {
      for (const change of changes) {
        try { this.onChange?.(structuredClone(change)); } catch { /* advisory */ }
      }
    }
    if (failure) throw failure;
    return result;
  }

  _withLock(operation) {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return operation();
      } finally {
        this.lockDepth -= 1;
      }
    }
    ensureDir(this.dir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: randomBytes(12).toString("hex")
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new WorkspaceTimelineError("Workspace timeline store is busy.");
        }
        if (!acquired) waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this._releaseLock(token);
    }
  }

  _breakStaleLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return false;
    }
    let owner = null;
    try { owner = JSON.parse(content); } catch { /* invalid owner */ }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Never remove an unverified lock.
    }
  }

  _commit(op, projectId, payload) {
    if (this.lockDepth < 1 || !Array.isArray(this.pendingChanges)) {
      throw new WorkspaceTimelineError(
        "Workspace timeline commits require the mutation lock."
      );
    }
    const at = this._now();
    const sequence = this.sequence + 1;
    const event = normalizeEvent({
      version: 1,
      sequence,
      op,
      at,
      projectId,
      ...payload
    });
    const expectedState = this._state(at, sequence);
    if (
      jsonBytes(event) > MAX_EVENT_BYTES
      || jsonBytes(expectedState) > MAX_STATE_BYTES
    ) {
      this._restore();
      throw new WorkspaceTimelineError(
        "Workspace timeline persistence quota exceeded.",
        "WORKSPACE_TIMELINE_QUOTA"
      );
    }
    let appendError = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      appendError = error;
      this._restore();
      if (
        this.sequence !== sequence
        || stableHash(this._state(expectedState.updatedAt, this.sequence))
          !== stableHash(expectedState)
      ) {
        throw error;
      }
    }
    if (!appendError) this.sequence = sequence;
    try {
      this.writeSnapshot(this.snapshotPath, expectedState);
    } catch (error) {
      console.warn(
        `[workspace-timeline] snapshot refresh failed: ${safeErrorMessage(error)}`
      );
    }
    const change = {
      op,
      sequence,
      at,
      projectId,
      snapshotId: event.snapshot?.id ?? null,
      operationId: event.operation?.id ?? null,
      removedCount: event.removedSnapshots?.length ?? 0
    };
    this.pendingChanges.push(change);
  }

  _state(updatedAt = this._now(), sequence = this.sequence) {
    return {
      version: 1,
      sequence,
      updatedAt,
      snapshots: [...this.snapshots.values()]
        .map((snapshot) => structuredClone(snapshot))
        .sort(compareSnapshot),
      operations: this.operations
        .map((operation) => structuredClone(operation))
        .slice(-MAX_OPERATIONS)
    };
  }

  _restore() {
    this.sequence = 0;
    this.snapshots = new Map();
    this.operations = [];
    this.journalHealthy = true;
    this.journalError = null;
    let cachedState = null;
    try {
      const stat = fs.statSync(this.snapshotPath);
      if (stat.size <= MAX_SNAPSHOT_FILE_BYTES) {
        const raw = readJsonFile(this.snapshotPath, null);
        if (validState(raw)) cachedState = normalizeState(raw);
      }
    } catch { /* snapshot is only a replaceable cache */ }

    let lines = [];
    try {
      lines = readEventLines(this.eventsPath);
    } catch (error) {
      this._markJournalUnhealthy(safeErrorMessage(error));
      return;
    }
    let expected = 1;
    let highest = 0;
    let latestAt = null;
    let replayBlocked = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
        this._markJournalUnhealthy("event line exceeds its size bound");
        replayBlocked = true;
        continue;
      }
      const event = parseEvent(line);
      if (!event || event.sequence !== expected) {
        this._markJournalUnhealthy(
          `event sequence ${expected} is missing or invalid`
        );
        replayBlocked = true;
        if (event?.sequence >= expected) expected = event.sequence + 1;
        continue;
      }
      expected += 1;
      highest = event.sequence;
      latestAt = event.at;
      if (replayBlocked) continue;
      try {
        this._applyEventLoaded(event);
      } catch {
        this._markJournalUnhealthy(
          `event sequence ${event.sequence} has invalid state`
        );
        replayBlocked = true;
      }
    }
    if (cachedState?.sequence > highest) {
      this._markJournalUnhealthy(
        "snapshot authority is newer than the event journal"
      );
      return;
    }
    if (!this.journalHealthy) return;
    try {
      for (const snapshot of this.snapshots.values()) {
        const manifest = this._readManifest(snapshot.contentHash);
        if (
          manifest.entries.length !== snapshot.entryCount
          || manifest.totalBytes !== snapshot.totalBytes
          || stableHash(manifest.skipped) !== stableHash(snapshot.skipped)
        ) {
          throw new TypeError("Timeline snapshot metadata does not match its manifest.");
        }
      }
    } catch (error) {
      this._markJournalUnhealthy(safeErrorMessage(error));
      return;
    }
    const authoritative = this._state(
      latestAt ?? cachedState?.updatedAt ?? this._now(),
      this.sequence
    );
    if (
      !cachedState
      || stableHash(stateProjection(cachedState))
        !== stableHash(stateProjection(authoritative))
    ) {
      try {
        this.writeSnapshot(this.snapshotPath, authoritative);
      } catch {
        // The append-only journal remains authoritative.
      }
    }
  }

  _applyEventLoaded(event) {
    if (event.op === "snapshot") {
      if (event.snapshot.sequence !== event.sequence) {
        throw new TypeError("Timeline snapshot sequence does not match its event.");
      }
      if (this.snapshots.has(event.snapshot.id)) {
        throw new TypeError("Duplicate workspace timeline snapshot event.");
      }
      if (event.snapshot.parentId) {
        const parent = this.snapshots.get(event.snapshot.parentId);
        if (
          !parent
          || parent.projectId !== event.projectId
          || parent.workspaceRoot !== event.snapshot.workspaceRoot
          || parent.projectRevision > event.snapshot.projectRevision
          || parent.sequence >= event.snapshot.sequence
        ) {
          throw new TypeError("Invalid workspace timeline parent.");
        }
      }
      this.snapshots.set(event.snapshot.id, event.snapshot);
    } else if (event.op === "operation") {
      const existing = this.operations.find(
        (item) => item.id === event.operation.id
      );
      if (!existing) {
        if (event.operation.status !== "pending") {
          throw new TypeError("Timeline operation must begin pending.");
        }
        for (const snapshotId of [
          event.operation.sourceSnapshotId,
          event.operation.beforeSnapshotId
        ]) {
          const snapshot = this.snapshots.get(snapshotId);
          if (!snapshot || snapshot.projectId !== event.projectId) {
            throw new TypeError("Timeline operation references an invalid snapshot.");
          }
        }
      } else {
        if (
          existing.status !== "pending"
          || !sameOperationIdentity(existing, event.operation)
          || event.operation.status === "pending"
        ) {
          throw new TypeError("Invalid workspace timeline operation transition.");
        }
        if (event.operation.status === "complete") {
          const result = this.snapshots.get(event.operation.resultSnapshotId);
          if (!result || result.projectId !== event.projectId) {
            throw new TypeError("Completed timeline operation has no result snapshot.");
          }
        }
      }
      this._upsertOperationLoaded(event.operation);
    } else if (event.op === "gc") {
      if (new Set(event.removedSnapshots).size !== event.removedSnapshots.length) {
        throw new TypeError("Timeline GC contains duplicate snapshot ids.");
      }
      for (const id of event.removedSnapshots) {
        const snapshot = this.snapshots.get(id);
        if (!snapshot || snapshot.projectId !== event.projectId) {
          throw new TypeError("Timeline GC crossed a project boundary.");
        }
        this.snapshots.delete(id);
      }
    }
    this.sequence = event.sequence;
  }

  _upsertOperationLoaded(operation) {
    const index = this.operations.findIndex((item) => item.id === operation.id);
    if (index >= 0) this.operations[index] = operation;
    else this.operations.push(operation);
    if (this.operations.length > MAX_OPERATIONS) {
      this.operations.splice(0, this.operations.length - MAX_OPERATIONS);
    }
  }

  _reconcileInterruptedOperations() {
    const pending = this.operations.filter(
      (operation) => operation.status === "pending"
    );
    if (pending.length === 0) return;
    this._mutate(() => {
      for (const operation of pending) {
        const reconciled = normalizeOperation({
          ...operation,
          status: "outcome-unknown",
          completedAt: this._now(),
          error: "Runtime restarted during workspace mutation."
        });
        this._upsertOperationLoaded(reconciled);
        this._commit("operation", operation.projectId, {
          operation: reconciled
        });
      }
    });
  }

  _markJournalUnhealthy(reason) {
    this.journalHealthy = false;
    this.journalError ??= String(reason || "timeline journal is invalid");
  }

  _assertJournalHealthy() {
    if (this.journalHealthy) return;
    throw new WorkspaceTimelineError(
      `Workspace timeline journal is unavailable: ${this.journalError}.`,
      "WORKSPACE_TIMELINE_JOURNAL_CORRUPT",
      { journalHealthy: false }
    );
  }

  _now() {
    const value = this.now();
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

export function registerWorkspaceTimelineTools(registry, runtime) {
  if (!registry?.register || !runtime?.timeline) return registry;
  const deferred = { toolSearch: "deferred" };
  registry.register({
    name: "timeline_list",
    metadata: deferred,
    sideEffects: false,
    description: "List recent content-addressed workspace timeline entries for the current project. This is the slower post-mutation history; checkpoints remain the fast pre-mutation safety rail.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    handler: (args, context) => ({
      snapshots: runtime.timeline.list({
        projectId: timelineProjectId(context),
        limit: args.limit ?? 20
      })
    })
  });

  registry.register({
    name: "timeline_diff",
    metadata: deferred,
    sideEffects: false,
    capability: { resources: ["filesystem"] },
    description: "Compare one workspace snapshot with another snapshot or the current eligible workspace. Text is omitted unless includeText is true.",
    parameters: {
      type: "object",
      properties: {
        fromId: timelineIdSchema(),
        toId: {
          type: "string",
          maxLength: 64,
          description: "Timeline id, or current. Defaults to current."
        },
        includeText: { type: "boolean" },
        maxItems: { type: "integer", minimum: 1, maximum: MAX_DIFF_ITEMS }
      },
      required: ["fromId"],
      additionalProperties: false
    },
    handler: (args, context) => runtime.timeline.diff(
      args.fromId,
      args.toId ?? "current",
      {
        ...timelineContext(context),
        includeText: args.includeText === true,
        maxItems: args.maxItems
      }
    )
  });

  registry.register({
    name: "timeline_preview",
    metadata: deferred,
    sideEffects: false,
    capability: { resources: ["filesystem"] },
    description: "Preview the bounded workspace changes and conflicts for travel or inverse revert without writing. Always preview before recovery.",
    parameters: {
      type: "object",
      properties: {
        id: timelineIdSchema(),
        action: { type: "string", enum: ["travel", "revert"] },
        maxItems: { type: "integer", minimum: 1, maximum: MAX_DIFF_ITEMS }
      },
      required: ["id", "action"],
      additionalProperties: false
    },
    handler: (args, context) => runtime.timeline.preview(args.id, {
      ...timelineContext(context),
      action: args.action,
      maxItems: args.maxItems
    })
  });

  for (const kind of ["travel", "revert"]) {
    registry.register({
      name: `timeline_${kind}`,
      metadata: deferred,
      needsConfirmation: true,
      capability: { resources: ["filesystem"] },
      jobResources: () => [{ resource: "workspace", mode: "write" }],
      jobResourceRevision: "workspace-timeline-v1",
      description: kind === "travel"
        ? "Replace the eligible project workspace with an exact prior snapshot after durably snapshotting current state. Requires the current timeline head."
        : "Conflict-safely inverse-apply one snapshot's parent-to-child change to the current workspace after durably snapshotting current state. Requires the current timeline head.",
      summarize: ({ id }) => (
        `${kind === "travel" ? "Travel workspace to" : "Revert workspace change"} ${String(id ?? "").slice(0, 64)}`
      ),
      parameters: {
        type: "object",
        properties: {
          id: timelineIdSchema(),
          expectedHead: timelineIdSchema(
            "Current head from timeline_list; prevents concurrent recovery."
          )
        },
        required: ["id", "expectedHead"],
        additionalProperties: false
      },
      handler: (args, context) => runtime.timeline[kind](args.id, {
        ...timelineContext(context),
        expectedHead: args.expectedHead,
        decidedBy: context?.__approval?.decider
          ?? context?.agentId
          ?? "agent"
      })
    });
  }
  return registry;
}

function timelineContext(context) {
  return {
    projectId: timelineProjectId(context),
    workspaceRoot: context?.__projectWorkspaceDir,
    sessionId: context?.sessionId ?? null
  };
}

function timelineProjectId(context) {
  return normalizeProjectId(context?.__projectId ?? "default");
}

function timelineIdSchema(description = "Workspace timeline snapshot id.") {
  return {
    type: "string",
    pattern: "^timeline_[a-f0-9]{16}$",
    description
  };
}

function scanWorkspace(workspaceRoot, options) {
  const root = path.resolve(workspaceRoot);
  assertSafeWorkspaceRoot(root);
  const rootIdentity = directoryIdentity(fs.lstatSync(root));
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_TIMELINE_MAX_FILES);
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_TIMELINE_MAX_FILE_BYTES
  );
  const maxBinaryBytes = positiveInteger(
    options.maxBinaryBytes,
    DEFAULT_TIMELINE_MAX_BINARY_BYTES
  );
  const maxSnapshotBytes = positiveInteger(
    options.maxSnapshotBytes,
    DEFAULT_TIMELINE_MAX_SNAPSHOT_BYTES
  );
  const entries = [];
  const opaque = [];
  const buffers = new Map();
  const skipped = emptySkipped();
  let totalBytes = 0;
  const recordOpaque = (relative, reason, stat) => {
    skipped[reason] += 1;
    if (!relative) return;
    opaque.push({
      path: relative,
      reason,
      kind: timelinePathKind(stat)
    });
    assertScanCount(entries.length + opaque.length, maxFiles);
  };
  const walk = (absolute, relative, isRoot = false, knownStat = null) => {
    if (!isRoot) assertSafeAncestors(root, absolute);
    const stat = knownStat ?? fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      recordOpaque(relative, "symlink", stat);
      return;
    }
    if (!isRoot && stat.isDirectory() && isNestedRepository(absolute)) {
      recordOpaque(relative, "repository", stat);
      return;
    }
    if (stat.isDirectory()) {
      const identity = directoryIdentity(stat);
      if (!isRoot) {
        entries.push({
          path: relative,
          kind: "directory",
          mode: stat.mode & 0o777
        });
        assertScanCount(entries.length + opaque.length, maxFiles);
      }
      const children = fs.readdirSync(absolute, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      assertNoNameCollisions(children.map((entry) => entry.name), relative);
      for (const child of children) {
        const childRelative = relative
          ? `${relative}/${normalizePathSegment(child.name)}`
          : normalizePathSegment(child.name);
        const childAbsolute = path.join(absolute, child.name);
        assertSafeAncestors(root, childAbsolute);
        const childStat = fs.lstatSync(childAbsolute);
        const category = excludedPathCategory(child.name, childStat);
        if (category) {
          recordOpaque(childRelative, category, childStat);
          continue;
        }
        walk(childAbsolute, childRelative, false, childStat);
      }
      const after = fs.lstatSync(absolute);
      if (
        !after.isDirectory()
        || after.isSymbolicLink()
        || directoryIdentity(after) !== identity
      ) {
        throw new WorkspaceTimelineConflictError(
          `Workspace directory changed while snapshotting '${relative || "."}'.`,
          [relative || "."]
        );
      }
      return;
    }
    if (!stat.isFile()) {
      recordOpaque(relative, "special", stat);
      return;
    }
    if (stat.nlink > 1) {
      recordOpaque(relative, "hardlink", stat);
      return;
    }
    if (stat.size > maxFileBytes) {
      recordOpaque(relative, "largeFile", stat);
      return;
    }
    const data = readWorkspaceFile(root, absolute, stat, relative);
    const binary = isBinary(data, relative);
    if (binary && data.length > maxBinaryBytes) {
      recordOpaque(relative, "largeBinary", stat);
      return;
    }
    totalBytes += data.length;
    if (totalBytes > maxSnapshotBytes) {
      throw new WorkspaceTimelineError(
        `Workspace snapshot exceeds ${maxSnapshotBytes} bytes.`,
        "WORKSPACE_TIMELINE_QUOTA"
      );
    }
    const hash = sha256(data);
    buffers.set(hash, data);
    entries.push({
      path: relative,
      kind: "file",
      mode: stat.mode & 0o777,
      size: data.length,
      hash,
      binary
    });
    assertScanCount(entries.length + opaque.length, maxFiles);
  };
  walk(root, "", true);
  const finalRoot = fs.lstatSync(root);
  if (
    !finalRoot.isDirectory()
    || finalRoot.isSymbolicLink()
    || directoryIdentity(finalRoot) !== rootIdentity
  ) {
    throw new WorkspaceTimelineConflictError(
      "Workspace root changed while snapshotting.",
      ["."]
    );
  }
  entries.sort(compareEntry);
  opaque.sort(compareOpaquePath);
  return {
    version: 1,
    policyVersion: WORKSPACE_TIMELINE_POLICY_VERSION,
    entries,
    opaque,
    skipped,
    totalBytes,
    buffers
  };
}

function excludedPathCategory(name, stat) {
  const lower = String(name).toLowerCase();
  if (SENSITIVE_DIRECTORY_NAMES.has(lower)) return "sensitive";
  if (REPOSITORY_MARKERS.includes(lower)) return "repository";
  if (stat.isDirectory() && IGNORED_DIRECTORY_NAMES.has(lower)) {
    return "ignored";
  }
  if (!stat.isDirectory() && lower === ".env.example") return null;
  if (
    SECRET_FILE_RE.test(name)
    || SECRET_EXTENSION_RE.test(name)
  ) {
    return "sensitive";
  }
  return null;
}

function isNestedRepository(directory) {
  return REPOSITORY_MARKERS.some((marker) => {
    try {
      const stat = fs.lstatSync(path.join(directory, marker));
      return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
}

function buildTravelManifest(current, target) {
  const desired = entryMap(target.entries);
  const targetOpaque = target.opaque ?? [];
  const currentOpaque = current.opaque ?? [];
  for (const entry of current.entries) {
    const protectedByTarget = targetOpaque.some((opaque) => (
      pathContains(opaque.path, entry.path)
    ));
    const requiredByCurrentOpaque = currentOpaque.some((opaque) => (
      entry.kind === "directory" && pathContains(entry.path, opaque.path)
    ));
    if (
      (protectedByTarget || requiredByCurrentOpaque)
      && !desired.has(entry.path)
    ) {
      desired.set(entry.path, structuredClone(entry));
    }
  }
  const entries = [...desired.values()].sort(compareEntry);
  const opaque = mergeOpaquePaths(targetOpaque, currentOpaque)
    .filter((item) => !entries.some((entry) => pathContains(item.path, entry.path)));
  return normalizeManifestCore({
    version: 1,
    policyVersion: WORKSPACE_TIMELINE_POLICY_VERSION,
    entries,
    opaque,
    totalBytes: entries
      .filter((entry) => entry.kind === "file")
      .reduce((sum, entry) => sum + entry.size, 0),
    skipped: mergeSkippedCounts(target.skipped, current.skipped)
  });
}

function buildRevertManifest(current, selected, parent) {
  const opaqueTransitions = changedOpaquePaths(
    selected.opaque ?? [],
    parent.opaque ?? []
  );
  if (opaqueTransitions.length > 0) {
    throw new WorkspaceTimelineConflictError(
      "A workspace change that crossed an opaque path cannot be safely reverted.",
      opaqueTransitions
    );
  }
  const currentMap = entryMap(current.entries);
  const selectedMap = entryMap(selected.entries);
  const parentMap = entryMap(parent.entries);
  const changed = new Set([
    ...selectedMap.keys(),
    ...parentMap.keys()
  ]);
  const conflicts = [];
  for (const relative of [...changed]) {
    const selectedEntry = selectedMap.get(relative) ?? null;
    const parentEntry = parentMap.get(relative) ?? null;
    if (sameEntry(selectedEntry, parentEntry)) {
      changed.delete(relative);
      continue;
    }
    const currentEntry = currentMap.get(relative) ?? null;
    if (
      !sameEntry(currentEntry, selectedEntry)
      && !sameEntry(currentEntry, parentEntry)
    ) {
      conflicts.push(relative);
    }
  }
  if (conflicts.length > 0) {
    throw new WorkspaceTimelineConflictError(
      `Workspace revert conflicts with ${conflicts.length} current path(s).`,
      conflicts
    );
  }
  for (const relative of changed) {
    const parentEntry = parentMap.get(relative);
    if (parentEntry) currentMap.set(relative, structuredClone(parentEntry));
    else currentMap.delete(relative);
  }
  const entries = [...currentMap.values()].sort(compareEntry);
  return normalizeManifestCore({
    version: 1,
    policyVersion: WORKSPACE_TIMELINE_POLICY_VERSION,
    entries,
    opaque: current.opaque ?? [],
    totalBytes: entries
      .filter((entry) => entry.kind === "file")
      .reduce((sum, entry) => sum + entry.size, 0),
    skipped: current.skipped ?? emptySkipped()
  });
}

function changedOpaquePaths(left, right) {
  const leftMap = new Map(left.map((item) => [item.path, item]));
  const rightMap = new Map(right.map((item) => [item.path, item]));
  return [...new Set([...leftMap.keys(), ...rightMap.keys()])]
    .filter((relative) => (
      stableHash(leftMap.get(relative) ?? null)
      !== stableHash(rightMap.get(relative) ?? null)
    ))
    .sort()
    .slice(0, 100);
}

function mergeOpaquePaths(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const item of group ?? []) {
      if (!merged.has(item.path)) merged.set(item.path, structuredClone(item));
    }
  }
  return [...merged.values()].sort(compareOpaquePath);
}

function mergeSkippedCounts(...groups) {
  const merged = emptySkipped();
  for (const group of groups) {
    for (const key of Object.keys(merged)) {
      merged[key] = Math.max(merged[key], group?.[key] ?? 0);
    }
  }
  return merged;
}

function preflightWorkspaceApply(root, current, desired) {
  const currentMap = entryMap(current.entries);
  const desiredMap = entryMap(desired.entries);
  const opaqueConflicts = [];
  for (const entry of desired.entries) {
    for (const opaque of current.opaque ?? []) {
      const opaqueContainsEntry = pathContains(opaque.path, entry.path);
      const entryChangesOpaqueAncestor = (
        pathContains(entry.path, opaque.path)
        && !sameEntry(currentMap.get(entry.path) ?? null, entry)
      );
      if (opaqueContainsEntry || entryChangesOpaqueAncestor) {
        opaqueConflicts.push(opaque.path);
      }
    }
  }
  if (opaqueConflicts.length > 0) {
    throw new WorkspaceTimelineConflictError(
      "Opaque current workspace paths block recovery.",
      [...new Set(opaqueConflicts)].sort()
    );
  }
  for (const entry of desired.entries) {
    const absolute = workspaceEntryPath(root, entry.path);
    assertPreflightAncestors(
      root,
      absolute,
      currentMap,
      desiredMap
    );
    const stat = safeLstat(absolute);
    const known = currentMap.get(entry.path) ?? null;
    if (!known && stat) {
      throw new WorkspaceTimelineConflictError(
        `Excluded or concurrent path blocks restore: '${entry.path}'.`,
        [entry.path]
      );
    }
    if (entry.kind === "file") {
      if (stat?.isDirectory() && known?.kind !== "directory") {
        throw new WorkspaceTimelineConflictError(
          `Untracked directory blocks file restore: '${entry.path}'.`,
          [entry.path]
        );
      }
    } else if (stat?.isFile() && !known) {
      throw new WorkspaceTimelineConflictError(
        `Untracked file blocks directory restore: '${entry.path}'.`,
        [entry.path]
      );
    }
  }
  for (const entry of current.entries) {
    if (desiredMap.get(entry.path)?.kind === entry.kind) continue;
    const absolute = workspaceEntryPath(root, entry.path);
    assertSafeAncestors(root, absolute);
    const stat = safeLstat(absolute);
    if (!stat) continue;
    if (entry.kind === "file" && !stat.isFile()) {
      throw new WorkspaceTimelineConflictError(
        `Workspace path changed type before restore: '${entry.path}'.`,
        [entry.path]
      );
    }
    if (entry.kind === "directory" && !stat.isDirectory()) {
      throw new WorkspaceTimelineConflictError(
        `Workspace path changed type before restore: '${entry.path}'.`,
        [entry.path]
      );
    }
  }
}

function applyWorkspaceManifest(root, current, desired, readBlob) {
  const currentMap = entryMap(current.entries);
  const desiredMap = entryMap(desired.entries);
  const removals = current.entries
    .filter((entry) => desiredMap.get(entry.path)?.kind !== entry.kind)
    .sort((left, right) => (
      right.path.split("/").length - left.path.split("/").length
      || right.path.localeCompare(left.path)
    ));
  for (const entry of removals.filter((item) => item.kind === "file")) {
    const absolute = workspaceEntryPath(root, entry.path);
    assertLiveEntry(root, entry);
    fs.unlinkSync(absolute);
    assertLiveEntry(root, null, entry.path);
  }
  for (const entry of removals.filter((item) => item.kind === "directory")) {
    const absolute = workspaceEntryPath(root, entry.path);
    assertLiveEntry(root, entry);
    if (fs.readdirSync(absolute).length > 0) {
      throw new WorkspaceTimelineConflictError(
        `Opaque or concurrent content blocks directory removal: '${entry.path}'.`,
        [entry.path]
      );
    }
    fs.rmdirSync(absolute);
    assertLiveEntry(root, null, entry.path);
  }

  const directories = desired.entries
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => (
      left.path.split("/").length - right.path.split("/").length
      || left.path.localeCompare(right.path)
    ));
  for (const entry of directories) {
    const absolute = workspaceEntryPath(root, entry.path);
    assertSafeAncestors(root, absolute);
    const before = currentMap.get(entry.path) ?? null;
    if (before?.kind === "directory") {
      assertLiveEntry(root, before);
      if (sameEntry(before, entry)) continue;
    } else {
      assertLiveEntry(root, null, entry.path);
    }
    ensureDir(absolute);
    safeChmod(absolute, entry.mode);
  }

  for (const entry of desired.entries.filter((item) => item.kind === "file")) {
    const existing = currentMap.get(entry.path) ?? null;
    const absolute = workspaceEntryPath(root, entry.path);
    if (existing?.kind === "file") assertLiveEntry(root, existing);
    else assertLiveEntry(root, null, entry.path);
    if (sameEntry(existing, entry)) continue;
    ensureDir(path.dirname(absolute));
    assertSafeAncestors(root, absolute);
    writeBufferAtomic(absolute, readBlob(entry.hash), entry.mode);
    safeChmod(absolute, entry.mode);
    assertLiveEntry(root, entry);
  }
}

function renderTimelineDiff(left, right, options = {}) {
  const leftMap = entryMap(left.entries);
  const rightMap = entryMap(right.entries);
  const paths = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const maxItems = integerInRange(
    options.maxItems,
    "maxItems",
    1,
    MAX_DIFF_ITEMS,
    500
  );
  const maxChars = integerInRange(
    options.maxChars,
    "maxChars",
    1,
    MAX_DIFF_CHARS,
    24_000
  );
  const items = [];
  let textChars = 0;
  let truncated = false;
  const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 };
  for (const relative of paths) {
    const before = leftMap.get(relative) ?? null;
    const after = rightMap.get(relative) ?? null;
    const status = !before
      ? "added"
      : !after
        ? "deleted"
        : sameEntry(before, after)
          ? "unchanged"
          : "modified";
    counts[status] += 1;
    if (status === "unchanged") continue;
    if (items.length >= maxItems) {
      truncated = true;
      continue;
    }
    const item = {
      path: relative,
      status,
      before: entrySummary(before),
      after: entrySummary(after)
    };
    if (
      options.includeText
      && before?.kind === "file"
      && after?.kind === "file"
      && !before.binary
      && !after.binary
      && textChars < maxChars
    ) {
      const beforeData = options.leftBuffers?.get(before.hash)
        ?? options.readBlob(before.hash);
      const afterData = options.rightBuffers?.get(after.hash)
        ?? options.readBlob(after.hash);
      const remaining = maxChars - textChars;
      item.diff = simpleTextDiff(beforeData, afterData, remaining);
      textChars += item.diff.length;
      if (textChars >= maxChars) truncated = true;
    }
    items.push(item);
  }
  return {
    counts,
    items,
    truncated,
    leftContentHash: manifestContentHash(left),
    rightContentHash: manifestContentHash(right)
  };
}

function manifestContentHash(manifest) {
  return manifest.contentHash ?? hashManifestCore(normalizeManifestCore(manifest));
}

function normalizeManifestCore(value) {
  const source = plainRecord(value, "workspace timeline manifest");
  if (source.version !== 1) throw new TypeError("Invalid timeline manifest version.");
  if (source.policyVersion !== WORKSPACE_TIMELINE_POLICY_VERSION) {
    throw new TypeError("Unsupported timeline manifest policy version.");
  }
  const entries = plainArray(
    source.entries,
    "timeline manifest entries",
    DEFAULT_TIMELINE_MAX_FILES
  ).map(normalizeEntry).sort(compareEntry);
  assertUniqueEntryPaths(entries);
  const opaque = plainArray(
    source.opaque ?? [],
    "timeline opaque paths",
    MAX_OPAQUE_PATHS
  ).map(normalizeOpaquePath).sort(compareOpaquePath);
  assertUniqueOpaquePaths(opaque, entries);
  if (entries.length + opaque.length > DEFAULT_TIMELINE_MAX_FILES) {
    throw new RangeError("Timeline manifest contains too many paths.");
  }
  const totalBytes = nonNegativeInteger(source.totalBytes, "totalBytes");
  const calculated = entries
    .filter((entry) => entry.kind === "file")
    .reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes !== calculated) {
    throw new TypeError("Timeline manifest byte count is inconsistent.");
  }
  const skipped = normalizeSkipped(source.skipped);
  for (const item of opaque) {
    if (skipped[item.reason] < 1) {
      throw new TypeError("Timeline opaque-path counts are inconsistent.");
    }
  }
  return {
    version: 1,
    policyVersion: WORKSPACE_TIMELINE_POLICY_VERSION,
    totalBytes,
    entries,
    opaque,
    skipped
  };
}

function normalizeEntry(value) {
  const source = plainRecord(value, "timeline manifest entry");
  const kind = source.kind;
  if (!["file", "directory"].includes(kind)) {
    throw new TypeError("Invalid timeline entry kind.");
  }
  const allowed = kind === "file"
    ? new Set(["path", "kind", "mode", "size", "hash", "binary"])
    : new Set(["path", "kind", "mode"]);
  assertOnlyKeys(source, allowed, "timeline manifest entry");
  const entry = {
    path: normalizeRelativePath(source.path),
    kind,
    mode: integerInRange(source.mode, "mode", 0, 0o777, 0o600)
  };
  if (kind === "file") {
    entry.size = nonNegativeInteger(source.size, "size");
    entry.hash = normalizeHash(source.hash, "hash");
    if (typeof source.binary !== "boolean") {
      throw new TypeError("Timeline file binary must be boolean.");
    }
    entry.binary = source.binary;
  }
  return entry;
}

function normalizeOpaquePath(value) {
  const source = plainRecord(value, "timeline opaque path");
  assertOnlyKeys(
    source,
    new Set(["path", "reason", "kind"]),
    "timeline opaque path"
  );
  const reasons = new Set(Object.keys(emptySkipped()));
  if (!reasons.has(source.reason)) {
    throw new TypeError("Invalid timeline opaque-path reason.");
  }
  if (!["file", "directory", "symlink", "special"].includes(source.kind)) {
    throw new TypeError("Invalid timeline opaque-path kind.");
  }
  return {
    path: normalizeRelativePath(source.path),
    reason: source.reason,
    kind: source.kind
  };
}

function normalizeSnapshot(value) {
  const source = plainRecord(value, "workspace timeline snapshot");
  assertOnlyKeys(
    source,
    new Set([
      "version",
      "id",
      "sequence",
      "projectId",
      "projectRevision",
      "workspaceRoot",
      "parentId",
      "contentHash",
      "entryCount",
      "totalBytes",
      "skipped",
      "reason",
      "toolNames",
      "sessionId",
      "createdAt"
    ]),
    "workspace timeline snapshot"
  );
  if (source.version !== 1) throw new TypeError("Invalid timeline snapshot version.");
  const id = normalizeTimelineId(source.id);
  const parentId = source.parentId == null
    ? null
    : normalizeTimelineId(source.parentId);
  if (parentId === id) throw new TypeError("Timeline snapshot cannot parent itself.");
  const rawWorkspaceRoot = requiredText(
    source.workspaceRoot,
    "workspaceRoot",
    4096
  );
  if (!path.isAbsolute(rawWorkspaceRoot)) {
    throw new TypeError("workspaceRoot must be absolute.");
  }
  const workspaceRoot = path.resolve(rawWorkspaceRoot);
  return {
    version: 1,
    id,
    sequence: positiveInteger(source.sequence, null, "snapshot sequence"),
    projectId: normalizeProjectId(source.projectId),
    projectRevision: positiveInteger(
      source.projectRevision,
      null,
      "projectRevision"
    ),
    workspaceRoot,
    parentId,
    contentHash: normalizeHash(source.contentHash, "contentHash"),
    entryCount: nonNegativeInteger(source.entryCount, "entryCount"),
    totalBytes: nonNegativeInteger(source.totalBytes, "totalBytes"),
    skipped: normalizeSkipped(source.skipped),
    reason: boundedReason(source.reason),
    toolNames: normalizeToolNames(source.toolNames),
    sessionId: source.sessionId == null
      ? null
      : requiredText(source.sessionId, "sessionId", 512),
    createdAt: requiredIso(source.createdAt, "createdAt")
  };
}

function normalizeOperation(value) {
  const source = plainRecord(value, "workspace timeline operation");
  assertOnlyKeys(
    source,
    new Set([
      "version",
      "id",
      "kind",
      "status",
      "projectId",
      "sourceSnapshotId",
      "beforeSnapshotId",
      "resultSnapshotId",
      "expectedHead",
      "requestedAt",
      "completedAt",
      "decidedBy",
      "error"
    ]),
    "workspace timeline operation"
  );
  if (source.version !== 1) throw new TypeError("Invalid timeline operation version.");
  if (!OPERATION_ID_RE.test(String(source.id ?? ""))) {
    throw new TypeError("Invalid timeline operation id.");
  }
  if (!["travel", "revert"].includes(source.kind)) {
    throw new TypeError("Invalid timeline operation kind.");
  }
  if (!["pending", "complete", "failed", "outcome-unknown"].includes(source.status)) {
    throw new TypeError("Invalid timeline operation status.");
  }
  const completedAt = source.completedAt == null
    ? null
    : requiredIso(source.completedAt, "completedAt");
  if ((source.status === "pending") !== (completedAt === null)) {
    throw new TypeError("Timeline operation completion state is inconsistent.");
  }
  const resultSnapshotId = source.resultSnapshotId == null
    ? null
    : normalizeTimelineId(source.resultSnapshotId);
  if ((source.status === "complete") !== (resultSnapshotId !== null)) {
    throw new TypeError("Timeline operation result state is inconsistent.");
  }
  const operationError = source.error == null
    ? null
    : requiredText(source.error, "error", 500);
  if (
    ["pending", "complete"].includes(source.status)
      ? operationError !== null
      : operationError === null
  ) {
    throw new TypeError("Timeline operation error state is inconsistent.");
  }
  return {
    version: 1,
    id: source.id,
    kind: source.kind,
    status: source.status,
    projectId: normalizeProjectId(source.projectId),
    sourceSnapshotId: normalizeTimelineId(source.sourceSnapshotId),
    beforeSnapshotId: normalizeTimelineId(source.beforeSnapshotId),
    resultSnapshotId,
    expectedHead: normalizeExpectedHead(source.expectedHead),
    requestedAt: requiredIso(source.requestedAt, "requestedAt"),
    completedAt,
    decidedBy: boundedActor(source.decidedBy),
    error: operationError
  };
}

function sameOperationIdentity(left, right) {
  return [
    "version",
    "id",
    "kind",
    "projectId",
    "sourceSnapshotId",
    "beforeSnapshotId",
    "expectedHead",
    "requestedAt",
    "decidedBy"
  ].every((field) => stableHash(left[field]) === stableHash(right[field]));
}

function normalizeEvent(value) {
  const source = plainRecord(value, "workspace timeline event");
  const base = new Set(["version", "sequence", "op", "at", "projectId"]);
  if (source.op === "snapshot") base.add("snapshot");
  else if (source.op === "operation") base.add("operation");
  else if (source.op === "gc") base.add("removedSnapshots");
  else throw new TypeError("Invalid workspace timeline event op.");
  assertOnlyKeys(source, base, "workspace timeline event");
  if (source.version !== 1) throw new TypeError("Invalid timeline event version.");
  const event = {
    version: 1,
    sequence: positiveInteger(source.sequence, null, "event sequence"),
    op: source.op,
    at: requiredIso(source.at, "event timestamp"),
    projectId: normalizeProjectId(source.projectId)
  };
  if (source.op === "snapshot") {
    event.snapshot = normalizeSnapshot(source.snapshot);
    if (event.snapshot.projectId !== event.projectId) {
      throw new TypeError("Timeline event project mismatch.");
    }
  } else if (source.op === "operation") {
    event.operation = normalizeOperation(source.operation);
    if (event.operation.projectId !== event.projectId) {
      throw new TypeError("Timeline operation project mismatch.");
    }
  } else {
    event.removedSnapshots = plainArray(
      source.removedSnapshots,
      "removedSnapshots",
      10_000
    ).map(normalizeTimelineId);
  }
  return event;
}

function normalizeState(value) {
  const source = plainRecord(value, "workspace timeline state");
  assertOnlyKeys(
    source,
    new Set(["version", "sequence", "updatedAt", "snapshots", "operations"]),
    "workspace timeline state"
  );
  if (source.version !== 1) throw new TypeError("Invalid timeline state version.");
  return {
    version: 1,
    sequence: nonNegativeInteger(source.sequence, "sequence"),
    updatedAt: requiredIso(source.updatedAt, "updatedAt"),
    snapshots: plainArray(
      source.snapshots,
      "timeline snapshots",
      50_000
    ).map(normalizeSnapshot),
    operations: plainArray(
      source.operations,
      "timeline operations",
      MAX_OPERATIONS
    ).map(normalizeOperation)
  };
}

function validState(value) {
  try {
    normalizeState(value);
    return true;
  } catch {
    return false;
  }
}

function stateProjection(value) {
  return {
    version: value.version,
    sequence: value.sequence,
    snapshots: value.snapshots,
    operations: value.operations
  };
}

function parseEvent(line) {
  try {
    return normalizeEvent(JSON.parse(line));
  } catch {
    return null;
  }
}

function readEventLines(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_EVENT_LOG_BYTES) {
      throw new RangeError("Workspace timeline event log is too large.");
    }
    return fs.readFileSync(file, "utf8").split(/\r?\n/u);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function hashManifestCore(core) {
  return sha256(Buffer.from(JSON.stringify(core), "utf8"));
}

function validateManifestBlobs(manifest, readBlob) {
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const data = readBlob(entry.hash);
    if (data.length !== entry.size) {
      throw new WorkspaceTimelineError(
        `Workspace timeline blob size mismatch for '${entry.path}'.`,
        "WORKSPACE_TIMELINE_INTEGRITY"
      );
    }
  }
}

function verifyWorkspaceManifest(root, expected, options) {
  const observed = scanWorkspace(root, options);
  assertManifestEntriesMatch(
    expected,
    observed,
    "Workspace changed after its pre-recovery snapshot."
  );
}

function assertManifestEntriesMatch(expected, observed, message) {
  const expectedMap = entryMap(expected.entries);
  const observedMap = entryMap(observed.entries);
  const paths = new Set([...expectedMap.keys(), ...observedMap.keys()]);
  const conflicts = [...paths]
    .filter((relative) => (
      !sameEntry(
        expectedMap.get(relative) ?? null,
        observedMap.get(relative) ?? null
      )
    ))
    .sort()
    .slice(0, 100);
  if (conflicts.length > 0) {
    throw new WorkspaceTimelineConflictError(
      message,
      conflicts
    );
  }
}

function assertLiveEntry(root, expected, relative = expected?.path) {
  const normalized = normalizeRelativePath(relative);
  const absolute = workspaceEntryPath(root, normalized);
  assertSafeWorkspaceRoot(root);
  assertSafeAncestors(root, absolute);
  const stat = safeLstat(absolute);
  if (!expected) {
    if (stat) {
      throw new WorkspaceTimelineConflictError(
        `Concurrent workspace path appeared: '${normalized}'.`,
        [normalized]
      );
    }
    return null;
  }
  if (!stat || stat.isSymbolicLink()) {
    throw new WorkspaceTimelineConflictError(
      `Workspace path changed before recovery: '${normalized}'.`,
      [normalized]
    );
  }
  if (expected.kind === "directory") {
    if (
      !stat.isDirectory()
      || (stat.mode & 0o777) !== expected.mode
    ) {
      throw new WorkspaceTimelineConflictError(
        `Workspace directory changed before recovery: '${normalized}'.`,
        [normalized]
      );
    }
    return stat;
  }
  if (
    !stat.isFile()
    || stat.nlink > 1
    || stat.size !== expected.size
    || (stat.mode & 0o777) !== expected.mode
  ) {
    throw new WorkspaceTimelineConflictError(
      `Workspace file changed before recovery: '${normalized}'.`,
      [normalized]
    );
  }
  const data = readWorkspaceFile(root, absolute, stat, normalized);
  if (sha256(data) !== expected.hash) {
    throw new WorkspaceTimelineConflictError(
      `Workspace file content changed before recovery: '${normalized}'.`,
      [normalized]
    );
  }
  return stat;
}

function emptySkipped() {
  return {
    sensitive: 0,
    symlink: 0,
    repository: 0,
    ignored: 0,
    largeFile: 0,
    largeBinary: 0,
    hardlink: 0,
    special: 0
  };
}

function normalizeSkipped(value) {
  const source = plainRecord(value ?? emptySkipped(), "timeline skipped counts");
  const expected = new Set(Object.keys(emptySkipped()));
  assertOnlyKeys(source, expected, "timeline skipped counts");
  const result = {};
  for (const key of expected) {
    result[key] = nonNegativeInteger(source[key] ?? 0, `skipped.${key}`);
  }
  return result;
}

function isWorkspaceMutationTool(name, tool) {
  const toolName = String(name ?? "").trim();
  if (!toolName || toolName.startsWith("timeline_")) return false;
  if (tool?.sideEffects === false) return false;
  const resources = Array.isArray(tool?.capability?.resources)
    ? tool.capability.resources.map((item) => String(item).toLowerCase())
    : [];
  if (resources.some((item) => ["filesystem", "file", "fs"].includes(item))) {
    return true;
  }
  return /^(?:code_(?:edit|write|shell)|write_file|patch|browser_download|rollback|terminal_send)$/u
    .test(toolName);
}

function assertSafeWorkspaceRoot(root, timelineDir = null) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceTimelineError(
      "Workspace timeline root must be a real directory.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  const real = fs.realpathSync(root);
  if (path.resolve(real) !== path.resolve(root)) {
    throw new WorkspaceTimelineError(
      "Workspace timeline root cannot traverse a symlink.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  if (
    timelineDir
    && pathsOverlap(path.resolve(root), path.resolve(timelineDir))
  ) {
    throw new WorkspaceTimelineError(
      "Workspace and timeline storage must not overlap.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
}

function workspaceEntryPath(root, relative) {
  const normalized = normalizeRelativePath(relative);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (absolute === root || !absolute.startsWith(root + path.sep)) {
    throw new WorkspaceTimelineError(
      "Timeline entry escapes its workspace.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  return absolute;
}

function assertSafeAncestors(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceTimelineError(
      "Timeline path escapes its workspace.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = safeLstat(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceTimelineConflictError(
        `Unsafe workspace ancestor: '${parts.join("/")}'.`,
        [parts.join("/")]
      );
    }
    const real = fs.realpathSync(current);
    if (real !== current) {
      throw new WorkspaceTimelineConflictError(
        `Workspace ancestor changed identity: '${parts.join("/")}'.`,
        [parts.join("/")]
      );
    }
  }
}

function assertPreflightAncestors(root, target, currentMap, desiredMap) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceTimelineError(
      "Timeline path escapes its workspace.",
      "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    const stat = safeLstat(current);
    if (!stat) break;
    const ancestor = parts.slice(0, index + 1).join("/");
    if (stat.isSymbolicLink()) {
      throw new WorkspaceTimelineConflictError(
        `Unsafe workspace ancestor: '${relative.replaceAll(path.sep, "/")}'.`,
        [relative.replaceAll(path.sep, "/")]
      );
    }
    if (!stat.isDirectory()) {
      if (
        stat.isFile()
        && currentMap.get(ancestor)?.kind === "file"
        && desiredMap.get(ancestor)?.kind === "directory"
      ) {
        break;
      }
      throw new WorkspaceTimelineConflictError(
        `Unsafe workspace ancestor: '${relative.replaceAll(path.sep, "/")}'.`,
        [relative.replaceAll(path.sep, "/")]
      );
    }
    if (fs.realpathSync(current) !== current) {
      throw new WorkspaceTimelineConflictError(
        `Workspace ancestor changed identity: '${relative.replaceAll(path.sep, "/")}'.`,
        [relative.replaceAll(path.sep, "/")]
      );
    }
  }
}

function normalizeRelativePath(value) {
  const text = requiredText(value, "timeline path", 4096)
    .replaceAll("\\", "/");
  if (
    text.startsWith("/")
    || /^[A-Za-z]:/u.test(text)
    || text.split("/").some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || CONTROL_RE.test(segment)
    ))
  ) {
    throw new TypeError("Invalid workspace timeline relative path.");
  }
  return text;
}

function normalizePathSegment(value) {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || CONTROL_RE.test(text)) {
    throw new WorkspaceTimelineError(
      "Workspace contains an unsupported path segment.",
      "WORKSPACE_TIMELINE_PATH"
    );
  }
  return text;
}

function assertNoNameCollisions(names, parent) {
  const folded = new Map();
  for (const name of names) {
    const key = String(name).normalize("NFKC").toLocaleLowerCase("en-US");
    const previous = folded.get(key);
    if (previous !== undefined && previous !== name) {
      throw new WorkspaceTimelineConflictError(
        `Workspace contains a case or Unicode-normalization collision under '${parent || "."}'.`,
        [parent || "."]
      );
    }
    folded.set(key, name);
  }
}

function assertUniqueEntryPaths(entries) {
  const exact = new Set();
  const folded = new Set();
  for (const entry of entries) {
    const key = entry.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (exact.has(entry.path) || folded.has(key)) {
      throw new TypeError("Duplicate or normalized-colliding timeline path.");
    }
    exact.add(entry.path);
    folded.add(key);
  }
}

function assertUniqueOpaquePaths(opaque, entries) {
  const tracked = new Set(
    entries.map((entry) => entry.path.normalize("NFKC").toLocaleLowerCase("en-US"))
  );
  const seen = new Set();
  const seenPaths = [];
  for (const item of opaque) {
    const key = item.path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (
      tracked.has(key)
      || seen.has(key)
      || entries.some((entry) => pathContains(item.path, entry.path))
      || seenPaths.some((other) => relativePathsOverlap(other, item.path))
    ) {
      throw new TypeError("Opaque timeline paths must be unique and untracked.");
    }
    seen.add(key);
    seenPaths.push(item.path);
  }
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function sameEntry(left, right) {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.mode !== right.mode) return false;
  if (left.kind === "directory") return true;
  return (
    left.size === right.size
    && left.hash === right.hash
    && left.binary === right.binary
  );
}

function entrySummary(entry) {
  if (!entry) return null;
  return entry.kind === "file"
    ? {
        kind: "file",
        bytes: entry.size,
        binary: entry.binary,
        hash: entry.hash
      }
    : { kind: "directory" };
}

function compareEntry(left, right) {
  return left.path.localeCompare(right.path);
}

function compareOpaquePath(left, right) {
  return left.path.localeCompare(right.path)
    || left.reason.localeCompare(right.reason)
    || left.kind.localeCompare(right.kind);
}

function compareSnapshot(left, right) {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function simpleTextDiff(before, after, maxChars) {
  const left = before.toString("utf8").split("\n");
  const right = after.toString("utf8").split("\n");
  let prefix = 0;
  while (
    prefix < left.length
    && prefix < right.length
    && left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const lines = [
    `@@ line ${prefix + 1} @@`,
    ...left.slice(prefix, left.length - suffix)
      .slice(0, 80)
      .map((line) => `-${line}`),
    ...right.slice(prefix, right.length - suffix)
      .slice(0, 80)
      .map((line) => `+${line}`)
  ];
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function sweepHashDirectory(directory, keep, extension) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const hash = extension && entry.name.endsWith(extension)
      ? entry.name.slice(0, -extension.length)
      : entry.name;
    if (!HASH_RE.test(hash) || keep.has(hash)) continue;
    fs.unlinkSync(path.join(directory, entry.name));
  }
}

function readRegularFileBounded(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new WorkspaceTimelineError(
      "Workspace timeline file is unavailable or oversized.",
      "WORKSPACE_TIMELINE_INTEGRITY"
    );
  }
  return fs.readFileSync(file);
}

function readWorkspaceFile(root, file, expectedStat, relative) {
  assertSafeWorkspaceRoot(root);
  assertSafeAncestors(root, file);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink > 1
      || fileIdentity(opened) !== fileIdentity(expectedStat)
    ) {
      throw new WorkspaceTimelineConflictError(
        `Workspace file changed while opening '${relative}'.`,
        [relative]
      );
    }
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      fileIdentity(after) !== fileIdentity(opened)
      || data.length !== opened.size
    ) {
      throw new WorkspaceTimelineConflictError(
        `Workspace file changed while reading '${relative}'.`,
        [relative]
      );
    }
    assertSafeWorkspaceRoot(root);
    assertSafeAncestors(root, file);
    const live = fs.lstatSync(file);
    if (
      live.isSymbolicLink()
      || fileIdentity(live) !== fileIdentity(opened)
    ) {
      throw new WorkspaceTimelineConflictError(
        `Workspace file path changed while reading '${relative}'.`,
        [relative]
      );
    }
    return data;
  } catch (error) {
    if (error instanceof WorkspaceTimelineError) throw error;
    throw new WorkspaceTimelineConflictError(
      `Workspace file could not be read safely: '${relative}'.`,
      [relative]
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writeBufferAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  let committed = false;
  try {
    fs.writeFileSync(temp, data, { mode });
    const fd = fs.openSync(temp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    committed = true;
  } finally {
    if (!committed) {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}

function fileIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.mode
  ].join(":");
}

function directoryIdentity(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.ctimeMs
  ].join(":");
}

function timelinePathKind(stat) {
  if (stat?.isSymbolicLink?.()) return "symlink";
  if (stat?.isDirectory?.()) return "directory";
  if (stat?.isFile?.()) return "file";
  return "special";
}

function normalizeToolNames(value) {
  const values = value == null
    ? []
    : plainArray(value, "toolNames", MAX_TOOL_NAMES);
  return [...new Set(values.map(boundedToolName))].sort();
}

function boundedToolName(value) {
  const name = requiredText(String(value ?? ""), "tool name", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(name)) {
    throw new TypeError("Invalid timeline tool name.");
  }
  return name;
}

function boundedReason(value) {
  const reason = String(value ?? "unspecified").trim() || "unspecified";
  if (reason.length > MAX_REASON_CHARS || CONTROL_RE.test(reason)) {
    throw new TypeError("Invalid timeline reason.");
  }
  return reason;
}

function boundedActor(value) {
  const actor = String(value ?? "runtime").trim() || "runtime";
  if (actor.length > 200 || CONTROL_RE.test(actor)) {
    throw new TypeError("Invalid timeline actor.");
  }
  return actor;
}

function normalizeTimelineId(value) {
  const id = String(value ?? "").trim();
  if (!ID_RE.test(id)) throw new TypeError("Invalid workspace timeline id.");
  return id;
}

function normalizeExpectedHead(value) {
  if (value == null || value === "") return null;
  return normalizeTimelineId(value);
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("projectId must be a string.");
  const id = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid projectId.");
  return id;
}

function normalizeHash(value, field) {
  const hash = requiredText(value, field, 64);
  if (!HASH_RE.test(hash)) throw new TypeError(`Invalid ${field}.`);
  return hash;
}

function plainRecord(value, field) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field}.${key} cannot be an accessor.`);
    }
  }
  return value;
}

function plainArray(value, field, max) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  if (value.length > max) throw new RangeError(`${field} is too large.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field} must be dense and contain no accessors.`);
    }
  }
  return value;
}

function assertOnlyKeys(source, allowed, field) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field}.${key} is not supported.`);
    }
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} is required.`);
  if (text.length > maxLength) throw new RangeError(`${field} is too long.`);
  if (CONTROL_RE.test(text)) {
    throw new TypeError(`${field} contains unsupported control characters.`);
  }
  return text;
}

function requiredIso(value, field) {
  const text = requiredText(value, field, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${field} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

function positiveInteger(value, fallback, field = "value") {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function integerInRange(value, field, minimum, maximum, fallback) {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return value;
}

function assertScanCount(count, maxFiles) {
  if (count > maxFiles) {
    throw new WorkspaceTimelineError(
      `Workspace snapshot exceeds ${maxFiles} entries.`,
      "WORKSPACE_TIMELINE_QUOTA"
    );
  }
}

function safeLstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function safeChmod(file, mode) {
  try {
    fs.chmodSync(file, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function isBinary(data, relative = "") {
  if (BINARY_EXTENSION_RE.test(relative)) return true;
  const limit = Math.min(data.length, 8_000);
  let controls = 0;
  for (let index = 0; index < limit; index += 1) {
    if (data[index] === 0) return true;
    if (
      data[index] < 32
      && ![9, 10, 13].includes(data[index])
    ) {
      controls += 1;
    }
  }
  if (limit > 0 && controls / limit > 0.02) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, limit));
    return false;
  } catch {
    return true;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function pathsOverlap(left, right) {
  return left === right
    || left.startsWith(right + path.sep)
    || right.startsWith(left + path.sep);
}

function pathContains(container, candidate) {
  const foldedContainer = foldTimelinePath(container);
  const foldedCandidate = foldTimelinePath(candidate);
  return (
    foldedCandidate === foldedContainer
    || foldedCandidate.startsWith(`${foldedContainer}/`)
  );
}

function relativePathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function foldTimelinePath(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? "Workspace timeline operation failed.")
    .replace(/[\r\n]+/gu, " ")
    .trim();
  return (message || "Workspace timeline operation failed.").slice(0, 500);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitSynchronously(milliseconds) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
}

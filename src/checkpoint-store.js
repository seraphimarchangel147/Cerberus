import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { createId, nowIso } from "./utils.js";

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PREVIEW_CHARS = 6000;
const DEFAULT_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ROLLBACKS = 1000;
const DEFAULT_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE_TOOLS = new Set(["code_write", "write_file"]);
const EDIT_TOOLS = new Set(["code_edit", "patch"]);

export class CheckpointTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckpointTargetError";
    this.code = "CHECKPOINT_TARGET_AMBIGUOUS";
  }
}

export function checkpointsEnabled(env = process.env) {
  return String(env?.OPENAGI_CHECKPOINTS ?? "").trim() === "1";
}

export class CheckpointStore {
  constructor(options = {}) {
    const dataDir = options.dataDir ?? resolveDataDir();
    this.dataDir = path.resolve(dataDir);
    this.dir = options.dir ?? path.join(dataDir, "checkpoints");
    this.blobsDir = path.join(this.dir, "blobs");
    this.indexPath = path.join(this.dir, "index.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.workspaceDir = path.resolve(options.workspaceDir ?? DEFAULT_WORKSPACE);
    this.allowedRoots = uniquePaths(options.allowedRoots ?? [this.workspaceDir, dataDir, os.tmpdir()]);
    this.protectedRoots = uniquePaths([
      path.join(this.dataDir, "secrets"),
      path.join(this.dataDir, "mcp", "auth"),
      path.join(this.dataDir, "node.json"),
      path.join(this.dataDir, "mcp.json"),
      path.join(this.dataDir, "nodes", "cache.json"),
      this.dir
    ]);
    this.enabled = options.enabled ?? checkpointsEnabled();
    this.now = typeof options.now === "function" ? options.now : nowIso;
    this.idFactory = typeof options.idFactory === "function" ? options.idFactory : () => createId("cp");
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.previewMaxChars = positiveInteger(options.previewMaxChars, DEFAULT_PREVIEW_CHARS);
    this.maxReplayBytes = positiveInteger(options.maxReplayBytes, DEFAULT_MAX_REPLAY_BYTES);
    this.maxEventBytes = positiveInteger(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
    this.maxSnapshotBytes = positiveInteger(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES);
    this.maxRollbacks = positiveInteger(options.maxRollbacks, DEFAULT_MAX_ROLLBACKS);
    this.checkpoints = new Map();
    this.dedupe = new Map();
    this.projectRoots = new Map();
    this.invalidProjectCheckpoints = new Set();
    this.nextSequence = 1;

    // Disabled mode is deliberately inert: no mkdir, stat, read, or replay.
    if (!this.enabled) return;
    ensureDir(this.dir);
    this._loadSnapshot();
    this._replayIndex();
    this._rebuildProjectRoots();
    this._rebuildDedupe();
    this._reconcileInterruptedRollbacks();
  }

  beforeToolCall({ toolName, args = {}, context = {} } = {}) {
    if (!this.enabled) return emptyCapture(false);
    const name = String(toolName ?? "");
    const projectId = normalizedProjectId(context.__projectId);
    if (projectId !== "default" && !nonEmpty(context.__projectWorkspaceDir)) {
      throw projectBoundaryError(
        `Project ${projectId} has no verified workspace for checkpoint capture`
      );
    }
    const workspaceDir = projectId === "default"
      ? (
          nonEmpty(context.__projectWorkspaceDir)
            ? path.resolve(String(context.__projectWorkspaceDir))
            : this.workspaceDir
        )
      : path.resolve(String(context.__projectWorkspaceDir));
    this._bindProjectRoot(projectId, workspaceDir);
    const allowedRoots = projectId === "default"
      ? this.allowedRoots
      : [workspaceDir];
    let destructive = false;
    let targets = [];

    if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
      destructive = true;
      if (!nonEmpty(args.path)) {
        throw new CheckpointTargetError(`${name} requires a concrete path before checkpointing`);
      }
      targets = [this._resolveOperand(args.path, workspaceDir)];
    } else if (name === "code_shell") {
      const extracted = extractShellMutationTargets(args.command, {
        cwd: args.cwd ? this._resolveOperand(args.cwd, workspaceDir) : workspaceDir
      });
      destructive = extracted.destructive;
      targets = extracted.targets.map((target) => this._resolveOperand(target, extracted.cwd));
    }

    if (!destructive) return emptyCapture(true);
    targets = [...new Set(targets)];
    if (targets.length === 0) {
      throw new CheckpointTargetError(`Destructive ${name} call had no safely resolvable targets`);
    }
    for (const target of targets) this._assertAllowed(target, allowedRoots);
    const turnId = nonEmpty(context.__turnId ?? context.__checkpointTurnId ?? context.turnId)
      ? String(context.__turnId ?? context.__checkpointTurnId ?? context.turnId)
      : createId("turn");
    const checkpoints = this.capture({
      turnId,
      sessionId: context.sessionId ?? null,
      projectId,
      workspaceRoot: workspaceDir,
      toolName: name,
      targets,
      allowedRoots
    });
    return { enabled: true, destructive: true, targets, checkpoints };
  }

  capture(options = {}) {
    if (!this.enabled) return [];
    const {
      turnId,
      sessionId = null,
      toolName = "unknown",
      targets
    } = options;
    if (!nonEmpty(turnId)) throw new TypeError("checkpoint capture requires turnId");
    const incoming = Array.isArray(targets) ? targets : [];
    if (incoming.length === 0) return [];
    const projectId = normalizedProjectId(options.projectId);
    if (projectId !== "default" && !nonEmpty(options.workspaceRoot)) {
      throw projectBoundaryError(
        `Project ${projectId} has no verified workspace for checkpoint capture`
      );
    }
    const workspaceRoot = projectId === "default"
      ? path.resolve(options.workspaceRoot ?? this.workspaceDir)
      : path.resolve(String(options.workspaceRoot));
    this._bindProjectRoot(projectId, workspaceRoot);
    const allowedRoots = projectId === "default"
      ? uniquePaths(options.allowedRoots ?? this.allowedRoots)
      : [workspaceRoot];

    const groups = new Map();
    for (const value of incoming) {
      const raw = typeof value === "object" && value !== null ? value.path : value;
      if (!nonEmpty(raw)) throw new CheckpointTargetError("checkpoint target path is required");
      const target = path.resolve(String(raw));
      this._assertAllowed(target, allowedRoots);
      const kind = lstatKind(target);
      const directory = kind === "directory" ? target : path.dirname(target);
      if (!groups.has(directory)) groups.set(directory, []);
      groups.get(directory).push(target);
    }

    const out = [];
    for (const [directory, roots] of groups) {
      const key = dedupeKey(turnId, directory, projectId);
      const existing = this.dedupe.get(key) ? this.checkpoints.get(this.dedupe.get(key)) : null;
      const seen = new Set((existing?.targets ?? []).map((target) => target.path));
      const budget = {
        files: existing?.targets?.length ?? 0,
        bytes: existing?.capturedBytes ?? 0
      };
      const records = [];
      for (const root of [...new Set(roots)].sort()) {
        this._collectTarget(root, records, seen, budget, true, allowedRoots);
      }

      const at = this._now();
      if (existing) {
        const toolNames = existing.toolNames.includes(toolName)
          ? existing.toolNames
          : [...existing.toolNames, toolName];
        if (records.length === 0 && toolNames.length === existing.toolNames.length) {
          out.push(this._view(existing));
          continue;
        }
        const next = {
          ...clone(existing),
          revision: existing.revision + 1,
          updatedAt: at,
          toolNames,
          targets: [...existing.targets, ...records].sort((a, b) => a.path.localeCompare(b.path)),
          capturedBytes: budget.bytes
        };
        this._persist("extend", next, { added: records.map((record) => record.path) });
        out.push(this._view(next));
        continue;
      }

      const checkpoint = {
        id: String(this.idFactory()),
        sequence: this.nextSequence++,
        revision: 1,
        turnId: String(turnId),
        sessionId: sessionId == null ? null : String(sessionId),
        projectId: String(projectId || "default"),
        workspaceRoot: path.resolve(workspaceRoot),
        directory,
        toolNames: [String(toolName || "unknown")],
        createdAt: at,
        updatedAt: at,
        capturedBytes: budget.bytes,
        targets: records.sort((a, b) => a.path.localeCompare(b.path)),
        rollbacks: []
      };
      this._persist("create", checkpoint, { roots: [...new Set(roots)] });
      this.dedupe.set(key, checkpoint.id);
      out.push(this._view(checkpoint));
    }
    return out;
  }

  get(id, { projectId } = {}) {
    if (!this.enabled || !nonEmpty(id)) return null;
    const checkpoint = this.checkpoints.get(String(id)) ?? null;
    if (checkpoint && this.invalidProjectCheckpoints.has(checkpoint.id)) return null;
    if (
      checkpoint
      && projectId === undefined
      && normalizedProjectId(checkpoint.projectId) !== "default"
    ) {
      return null;
    }
    if (
      checkpoint
      && projectId !== undefined
      && normalizedProjectId(checkpoint.projectId) !== normalizedProjectId(projectId)
    ) {
      return null;
    }
    return this._view(checkpoint);
  }

  list({ limit = 10, sessionId, directory, projectId } = {}) {
    if (!this.enabled) return [];
    const bounded = Math.max(0, Math.min(100, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 10));
    const wantedDir = nonEmpty(directory) ? path.resolve(String(directory)) : null;
    const wantedSession = sessionId == null ? sessionId : String(sessionId);
    return [...this.checkpoints.values()]
      .filter((checkpoint) => !this.invalidProjectCheckpoints.has(checkpoint.id))
      .filter((checkpoint) => (
        projectId !== undefined
        || normalizedProjectId(checkpoint.projectId) === "default"
      ))
      .filter((checkpoint) => sessionId === undefined || checkpoint.sessionId === wantedSession)
      .filter((checkpoint) => (
        projectId === undefined
        || normalizedProjectId(checkpoint.projectId) === normalizedProjectId(projectId)
      ))
      .filter((checkpoint) => !wantedDir || checkpoint.directory === wantedDir)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, bounded)
      .map((checkpoint) => this._view(checkpoint));
  }

  preview(id, { path: selectedPath, projectId } = {}) {
    if (!this.enabled) return null;
    const checkpoint = this.checkpoints.get(String(id));
    if (!checkpoint) return null;
    this._assertUsableCheckpoint(checkpoint);
    this._assertProject(checkpoint, projectId);
    const allowedRoots = this._checkpointAllowedRoots(checkpoint);
    const targets = this._selectTargets(checkpoint, selectedPath, allowedRoots);
    const files = [];
    let remaining = this.previewMaxChars;
    let truncated = false;

    for (const target of targets) {
      this._assertAllowed(target.path, allowedRoots);
      const current = readCurrent(target.path);
      const status = previewStatus(target, current);
      let diff = "";
      if (status !== "unchanged") {
        const before = target.kind === "file" ? this._readVerifiedBlob(target) : null;
        const after = current.kind === "file" ? current.data : null;
        diff = renderDiff(before, after, target, current);
        if (diff.length > remaining) {
          diff = diff.slice(0, Math.max(0, remaining));
          truncated = true;
        }
        remaining -= diff.length;
      }
      files.push({
        path: target.path,
        status,
        beforeHash: target.hash ?? null,
        afterHash: current.kind === "file" ? sha256(current.data) : null,
        beforeBytes: target.size ?? 0,
        afterBytes: current.kind === "file" ? current.data.length : 0,
        diff
      });
      if (remaining <= 0 && targets.length > files.length) {
        truncated = true;
        break;
      }
    }
    return { checkpoint: this._view(checkpoint), files, truncated };
  }

  rollback(id, {
    path: selectedPath,
    decidedBy = "system",
    sessionId,
    projectId
  } = {}) {
    if (!this.enabled) return null;
    const current = this.checkpoints.get(String(id));
    if (!current) return null;
    this._assertUsableCheckpoint(current);
    this._assertProject(current, projectId);
    const allowedRoots = this._checkpointAllowedRoots(current);
    const wantedSession = sessionId == null ? sessionId : String(sessionId);
    if (sessionId !== undefined && current.sessionId !== wantedSession) {
      throw new Error(`Checkpoint ${current.id} does not belong to this session`);
    }
    const targets = this._selectTargets(current, selectedPath, allowedRoots);
    if (targets.length === 0) throw new Error("checkpoint contains no matching targets");

    const blobs = new Map();
    for (const target of targets) {
      this._assertAllowed(target.path, allowedRoots);
      if (target.kind === "file") blobs.set(target.path, this._readVerifiedBlob(target));
      if (target.kind === "missing") this._assertSafeRemoval(target.path, allowedRoots);
    }

    const removed = [];
    const restored = [];
    const requestedAt = this._now();
    const rollbackId = createId("rollback");
    const intent = {
      id: rollbackId,
      at: requestedAt,
      requestedAt,
      completedAt: null,
      status: "pending",
      decidedBy: String(decidedBy ?? "system"),
      path: selectedPath == null ? null : String(selectedPath),
      targets: targets.map((target) => target.path),
      restored: [],
      removed: []
    };
    const pending = {
      ...clone(current),
      revision: current.revision + 1,
      updatedAt: requestedAt,
      rollbacks: boundedRollbackHistory(
        [...current.rollbacks, intent],
        this.maxRollbacks
      )
    };
    this._persist("rollback_intent", pending, {
      rollbackId,
      decidedBy: intent.decidedBy,
      path: intent.path,
      targets: intent.targets
    });

    try {
      const missing = targets.filter((target) => target.kind === "missing")
        .sort((a, b) => b.path.length - a.path.length);
      for (const target of missing) {
        this._assertSafeRemoval(target.path, allowedRoots);
        if (fs.existsSync(target.path) || isSymlink(target.path)) {
          fs.rmSync(target.path, { recursive: true, force: true });
          removed.push(target.path);
        }
      }

      const directories = targets.filter((target) => target.kind === "directory")
        .sort((a, b) => a.path.length - b.path.length);
      for (const target of directories) {
        this._assertAllowed(target.path, allowedRoots);
        if (fs.existsSync(target.path) && lstatKind(target.path) !== "directory") {
          fs.rmSync(target.path, { recursive: true, force: true });
        }
        ensureDir(target.path);
        safeChmod(target.path, target.mode);
        restored.push(target.path);
      }

      for (const target of targets.filter((entry) => entry.kind === "file")) {
        this._assertAllowed(target.path, allowedRoots);
        const liveKind = lstatKind(target.path);
        if (liveKind !== "missing" && liveKind !== "file") {
          fs.rmSync(target.path, { recursive: true, force: true });
        }
        ensureDir(path.dirname(target.path));
        writeBufferAtomic(target.path, blobs.get(target.path), target.mode ?? 0o600);
        safeChmod(target.path, target.mode);
        restored.push(target.path);
      }

      for (const target of targets.filter((entry) => entry.kind === "symlink")) {
        this._assertAllowed(target.path, allowedRoots);
        ensureDir(path.dirname(target.path));
        fs.rmSync(target.path, { recursive: true, force: true });
        fs.symlinkSync(target.linkTarget, target.path);
        restored.push(target.path);
      }
    } catch (error) {
      try {
        this._finishRollback(current.id, rollbackId, {
          status: "failed",
          restored,
          removed,
          error: safeErrorMessage(error)
        }, "rollback_failed");
      } catch {
        // The durable intent remains authoritative when failure-detail
        // persistence is itself unavailable. Do not mask the mutation error.
      }
      throw error;
    }

    const completedAt = this._now();
    this._finishRollback(current.id, rollbackId, {
      status: "complete",
      completedAt,
      restored,
      removed
    }, "rollback");
    return {
      checkpointId: current.id,
      rollbackId,
      restored,
      removed,
      at: completedAt
    };
  }

  _collectTarget(
    targetPath,
    records,
    seen,
    budget,
    root = false,
    allowedRoots = this.allowedRoots
  ) {
    const target = path.resolve(targetPath);
    this._assertAllowed(target, allowedRoots);
    if (seen.has(target)) return;
    seen.add(target);
    const stat = safeLstat(target);
    if (!stat) {
      records.push({ path: target, kind: "missing", existed: false, root });
      budget.files += 1;
      this._checkBudget(budget);
      return;
    }
    if (stat.isSymbolicLink()) {
      records.push({
        path: target,
        kind: "symlink",
        existed: true,
        root,
        mode: stat.mode & 0o777,
        linkTarget: fs.readlinkSync(target)
      });
      budget.files += 1;
      this._checkBudget(budget);
      return;
    }
    if (stat.isDirectory()) {
      records.push({ path: target, kind: "directory", existed: true, root, mode: stat.mode & 0o777 });
      budget.files += 1;
      this._checkBudget(budget);
      const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => entry.name).sort();
      for (const entry of entries) {
        this._collectTarget(
          path.join(target, entry),
          records,
          seen,
          budget,
          false,
          allowedRoots
        );
      }
      return;
    }
    if (!stat.isFile()) throw new CheckpointTargetError(`Unsupported checkpoint target type: ${target}`);
    const data = fs.readFileSync(target);
    budget.files += 1;
    budget.bytes += data.length;
    this._checkBudget(budget);
    const hash = sha256(data);
    this._writeBlob(hash, data);
    records.push({
      path: target,
      kind: "file",
      existed: true,
      root,
      mode: stat.mode & 0o777,
      size: data.length,
      hash
    });
  }

  _checkBudget(budget) {
    if (budget.files > this.maxFiles) {
      throw new CheckpointTargetError(`Checkpoint target exceeds ${this.maxFiles} entries`);
    }
    if (budget.bytes > this.maxBytes) {
      throw new CheckpointTargetError(`Checkpoint target exceeds ${this.maxBytes} bytes`);
    }
  }

  _writeBlob(hash, data) {
    const blobPath = this._blobPath(hash);
    if (fs.existsSync(blobPath)) {
      const stat = fs.lstatSync(blobPath);
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || stat.size !== data.length
        || sha256(fs.readFileSync(blobPath)) !== hash
      ) {
        throw new Error(`Checkpoint blob failed integrity check: ${hash}`);
      }
      return;
    }
    writeBufferAtomic(blobPath, data, 0o600);
  }

  _readVerifiedBlob(target) {
    const blobPath = this._blobPath(target.hash);
    let stat;
    try {
      stat = fs.lstatSync(blobPath);
    } catch {
      throw new Error(`Checkpoint blob failed integrity check for ${target.path}`);
    }
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size !== target.size
      || stat.size > this.maxBytes
    ) {
      throw new Error(`Checkpoint blob failed integrity check for ${target.path}`);
    }
    const data = fs.readFileSync(blobPath);
    if (data.length !== target.size || sha256(data) !== target.hash) {
      throw new Error(`Checkpoint blob failed integrity check for ${target.path}`);
    }
    return data;
  }

  _blobPath(hash) {
    return path.join(this.blobsDir, hash.slice(0, 2), hash);
  }

  _selectTargets(checkpoint, selectedPath, allowedRoots = this._checkpointAllowedRoots(checkpoint)) {
    if (!nonEmpty(selectedPath)) return checkpoint.targets.map(clone);
    const selected = path.isAbsolute(String(selectedPath))
      ? path.resolve(String(selectedPath))
      : path.resolve(checkpoint.directory, String(selectedPath));
    this._assertAllowed(selected, allowedRoots);
    const matches = checkpoint.targets.filter((target) => (
      target.path === selected || target.path.startsWith(selected + path.sep)
    ));
    if (matches.length === 0) throw new Error(`Path is not part of checkpoint ${checkpoint.id}: ${selected}`);
    return matches.map(clone);
  }

  _persist(op, checkpoint, details = {}) {
    const event = {
      version: 1,
      op,
      at: checkpoint.updatedAt,
      id: checkpoint.id,
      revision: checkpoint.revision,
      details,
      checkpoint
    };
    if (jsonByteLength(event) > this.maxEventBytes) {
      throw new Error(`Checkpoint event exceeds ${this.maxEventBytes} bytes`);
    }
    appendJsonLine(this.indexPath, event);
    this.checkpoints.set(checkpoint.id, clone(checkpoint));
    this._refreshCheckpointProjectState(checkpoint);
    this._rebuildDedupe();
    const snapshot = {
      version: 1,
      updatedAt: this._now(),
      nextSequence: this.nextSequence,
      checkpoints: [...this.checkpoints.values()].sort((a, b) => a.sequence - b.sequence)
    };
    if (jsonByteLength(snapshot) > this.maxSnapshotBytes) {
      throw new Error(`Checkpoint snapshot exceeds ${this.maxSnapshotBytes} bytes`);
    }
    writeCheckpointSnapshot(this.snapshotPath, snapshot);
  }

  _loadSnapshot() {
    let snapshot;
    try {
      const stat = fs.statSync(this.snapshotPath);
      if (!stat.isFile() || stat.size > this.maxSnapshotBytes) return;
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      return;
    }
    if (!Array.isArray(snapshot?.checkpoints)) return;
    for (const checkpoint of snapshot.checkpoints) {
      if (!this._validCheckpoint(checkpoint)) continue;
      this.checkpoints.set(checkpoint.id, clone(checkpoint));
      this.nextSequence = Math.max(this.nextSequence, checkpoint.sequence + 1);
    }
    if (Number.isSafeInteger(snapshot.nextSequence)) {
      this.nextSequence = Math.max(this.nextSequence, snapshot.nextSequence);
    }
  }

  _replayIndex() {
    let lines;
    try { lines = readJsonLineTail(this.indexPath, this.maxReplayBytes); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const checkpoint = event?.checkpoint;
      if (
        !this._validCheckpoint(checkpoint)
        || event.id !== checkpoint.id
        || event.revision !== checkpoint.revision
      ) {
        continue;
      }
      const current = this.checkpoints.get(checkpoint.id);
      if (!current || checkpoint.revision >= current.revision) this.checkpoints.set(checkpoint.id, clone(checkpoint));
      this.nextSequence = Math.max(this.nextSequence, checkpoint.sequence + 1);
    }
  }

  _validCheckpoint(checkpoint) {
    return validCheckpoint(checkpoint, {
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      maxRollbacks: this.maxRollbacks
    });
  }

  _finishRollback(checkpointId, rollbackId, changes, op) {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint not found while recording rollback: ${checkpointId}`);
    const index = checkpoint.rollbacks.findIndex((event) => event?.id === rollbackId);
    if (index < 0) throw new Error(`Rollback intent not found: ${rollbackId}`);
    const at = this._now();
    const rollbacks = checkpoint.rollbacks.map((event, eventIndex) => (
      eventIndex === index
        ? {
            ...event,
            ...changes,
            at,
            completedAt: changes.completedAt ?? at
          }
        : event
    ));
    const next = {
      ...clone(checkpoint),
      revision: checkpoint.revision + 1,
      updatedAt: at,
      rollbacks
    };
    this._persist(op, next, {
      rollbackId,
      status: changes.status,
      restored: [...(changes.restored ?? [])],
      removed: [...(changes.removed ?? [])],
      ...(changes.error ? { error: changes.error } : {})
    });
  }

  _reconcileInterruptedRollbacks() {
    for (const checkpoint of [...this.checkpoints.values()]) {
      if (this.invalidProjectCheckpoints.has(checkpoint.id)) continue;
      const pendingIds = checkpoint.rollbacks
        .filter((event) => event?.status === "pending" && nonEmpty(event.id))
        .map((event) => String(event.id));
      if (pendingIds.length === 0) continue;
      const at = this._now();
      const pending = new Set(pendingIds);
      const next = {
        ...clone(checkpoint),
        revision: checkpoint.revision + 1,
        updatedAt: at,
        rollbacks: checkpoint.rollbacks.map((event) => (
          pending.has(String(event?.id ?? ""))
            ? {
                ...event,
                at,
                completedAt: at,
                status: "outcome_unknown",
                error: "Process restarted before rollback completion was durably recorded."
              }
            : event
        ))
      };
      try {
        this._persist("rollback_reconcile", next, {
          rollbackIds: pendingIds,
          status: "outcome_unknown"
        });
      } catch {
        // A read-only or full store must not prevent startup. The original
        // durable pending intent remains visible for operator inspection.
      }
    }
  }

  _rebuildProjectRoots() {
    this.projectRoots = new Map();
    this.invalidProjectCheckpoints = new Set();
    const checkpoints = [...this.checkpoints.values()]
      .sort((left, right) => left.sequence - right.sequence);
    for (const checkpoint of checkpoints) {
      const projectId = normalizedProjectId(checkpoint.projectId);
      if (projectId === "default") {
        if (!this._checkpointTargetsAreAllowed(checkpoint, this.allowedRoots)) {
          this.invalidProjectCheckpoints.add(checkpoint.id);
        }
        continue;
      }
      if (!nonEmpty(checkpoint.workspaceRoot)) {
        this.invalidProjectCheckpoints.add(checkpoint.id);
        continue;
      }
      const workspaceRoot = path.resolve(String(checkpoint.workspaceRoot));
      const existing = this.projectRoots.get(projectId);
      if (existing && existing !== workspaceRoot) {
        this.invalidProjectCheckpoints.add(checkpoint.id);
        continue;
      }
      const overlapsAnotherProject = [...this.projectRoots.entries()].some(
        ([otherProjectId, otherRoot]) => (
          otherProjectId !== projectId && pathsOverlap(workspaceRoot, otherRoot)
        )
      );
      if (overlapsAnotherProject) {
        this.invalidProjectCheckpoints.add(checkpoint.id);
        continue;
      }
      this.projectRoots.set(projectId, workspaceRoot);
      if (!this._checkpointTargetsAreAllowed(checkpoint, [workspaceRoot])) {
        this.invalidProjectCheckpoints.add(checkpoint.id);
      }
    }
  }

  _refreshCheckpointProjectState(checkpoint) {
    this.invalidProjectCheckpoints.delete(checkpoint.id);
    const projectId = normalizedProjectId(checkpoint.projectId);
    if (projectId === "default") {
      if (!this._checkpointTargetsAreAllowed(checkpoint, this.allowedRoots)) {
        this.invalidProjectCheckpoints.add(checkpoint.id);
      }
      return;
    }
    if (!nonEmpty(checkpoint.workspaceRoot)) {
      this.invalidProjectCheckpoints.add(checkpoint.id);
      return;
    }
    const workspaceRoot = path.resolve(String(checkpoint.workspaceRoot));
    const existing = this.projectRoots.get(projectId);
    const overlap = [...this.projectRoots.entries()].some(
      ([otherProjectId, otherRoot]) => (
        otherProjectId !== projectId && pathsOverlap(workspaceRoot, otherRoot)
      )
    );
    if ((existing && existing !== workspaceRoot) || overlap) {
      this.invalidProjectCheckpoints.add(checkpoint.id);
      return;
    }
    this.projectRoots.set(projectId, workspaceRoot);
    if (!this._checkpointTargetsAreAllowed(checkpoint, [workspaceRoot])) {
      this.invalidProjectCheckpoints.add(checkpoint.id);
    }
  }

  _checkpointTargetsAreAllowed(checkpoint, allowedRoots) {
    try {
      for (const target of checkpoint.targets) {
        this._assertAllowed(target.path, allowedRoots);
      }
      return true;
    } catch {
      return false;
    }
  }

  _rebuildDedupe() {
    this.dedupe = new Map();
    for (const checkpoint of this.checkpoints.values()) {
      if (this.invalidProjectCheckpoints.has(checkpoint.id)) continue;
      const key = dedupeKey(
        checkpoint.turnId,
        checkpoint.directory,
        checkpoint.projectId ?? "default"
      );
      const current = this.dedupe.get(key) ? this.checkpoints.get(this.dedupe.get(key)) : null;
      if (!current || checkpoint.sequence > current.sequence) this.dedupe.set(key, checkpoint.id);
    }
  }

  _resolveOperand(value, cwd) {
    if (!nonEmpty(value)) throw new CheckpointTargetError("Checkpoint target path is empty");
    const text = String(value);
    if (hasShellExpansion(text)) throw new CheckpointTargetError(`Cannot safely resolve shell target: ${text}`);
    return path.resolve(cwd, text);
  }

  _assertAllowed(value, allowedRoots = this.allowedRoots) {
    const target = path.resolve(value);
    const roots = uniquePaths(allowedRoots);
    const lexical = roots.some(
      (root) => target === root || target.startsWith(root + path.sep)
    );
    const realTarget = resolveThroughExistingAncestor(target);
    const real = roots.map(resolveThroughExistingAncestor)
      .some((root) => realTarget === root || realTarget.startsWith(root + path.sep));
    if (!lexical || !real) {
      throw new CheckpointTargetError(`Checkpoint target is outside allowed roots: ${target}`);
    }
    const protectedRoots = [
      ...this.protectedRoots,
      ...this.protectedRoots.map(resolveThroughExistingAncestor)
    ];
    if (
      isSensitiveEnvPath(target)
      || isSensitiveEnvPath(realTarget)
      || protectedRoots.some((root) => pathsOverlap(target, root) || pathsOverlap(realTarget, root))
    ) {
      throw new CheckpointTargetError(`Checkpoint target contains sensitive credential material: ${target}`);
    }
  }

  _assertSafeRemoval(value, allowedRoots = this.allowedRoots) {
    const target = path.resolve(value);
    const roots = uniquePaths(allowedRoots);
    this._assertAllowed(target, roots);
    if (roots.some((root) => target === root)) {
      throw new Error(`Refusing to remove checkpoint root path: ${target}`);
    }
  }

  _assertProject(checkpoint, projectId) {
    const actual = normalizedProjectId(checkpoint.projectId);
    if (projectId === undefined) {
      if (actual === "default") return;
      throw projectBoundaryError(
        `Checkpoint ${checkpoint.id} requires an explicit project scope`
      );
    }
    if (actual !== normalizedProjectId(projectId)) {
      throw projectBoundaryError(
        `Checkpoint ${checkpoint.id} is outside the current project`
      );
    }
  }

  _assertUsableCheckpoint(checkpoint) {
    if (!this.invalidProjectCheckpoints.has(checkpoint.id)) return;
    throw projectBoundaryError(
      `Checkpoint ${checkpoint.id} has an invalid or conflicting project workspace`
    );
  }

  _bindProjectRoot(projectId, workspaceRoot) {
    if (projectId === "default") return;
    const root = path.resolve(workspaceRoot);
    const existing = this.projectRoots.get(projectId);
    if (existing && existing !== root) {
      throw projectBoundaryError(
        `Project ${projectId} checkpoint workspace does not match its existing binding`
      );
    }
    for (const [otherProjectId, otherRoot] of this.projectRoots) {
      if (otherProjectId !== projectId && pathsOverlap(root, otherRoot)) {
        throw projectBoundaryError(
          `Project ${projectId} checkpoint workspace overlaps project ${otherProjectId}`
        );
      }
    }
    this.projectRoots.set(projectId, root);
  }

  _checkpointAllowedRoots(checkpoint) {
    this._assertUsableCheckpoint(checkpoint);
    const projectId = normalizedProjectId(checkpoint.projectId);
    if (projectId === "default") return this.allowedRoots;
    const workspaceRoot = path.resolve(checkpoint.workspaceRoot);
    const boundRoot = this.projectRoots.get(projectId);
    if (!boundRoot || boundRoot !== workspaceRoot) {
      throw projectBoundaryError(
        `Checkpoint ${checkpoint.id} is outside its bound project workspace`
      );
    }
    return [workspaceRoot];
  }

  _view(checkpoint) {
    if (!checkpoint) return null;
    const view = clone(checkpoint);
    view.entries = view.targets;
    view.targets = view.entries.map((entry) => entry.path);
    return view;
  }

  _now() {
    const value = this.now();
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

export function extractShellMutationTargets(command, { cwd = DEFAULT_WORKSPACE } = {}) {
  const base = path.resolve(cwd);
  const text = unwrapShell(String(command ?? "").trim());
  if (!text) return { destructive: false, targets: [], cwd: base };
  if (hasUnquotedParenthesis(text) && mentionsDestructiveCommand(text)) {
    throw new CheckpointTargetError("Shell subshell syntax is not safely supported for checkpointing");
  }
  let segments;
  try { segments = splitShellSegments(text); }
  catch (error) {
    if (/\b(?:rm|mv|sed)\b/.test(text)) throw new CheckpointTargetError(error.message);
    return { destructive: false, targets: [], cwd: base };
  }
  const targets = [];
  let destructive = false;
  let directoryChanged = false;
  for (const segment of segments) {
    const words = shellWords(segment);
    if (words.length === 0) continue;
    stripCommandPrefixes(words);
    if (words.length === 0) continue;
    const commandName = path.basename(words[0]);
    if (["cd", "pushd", "popd"].includes(commandName)) {
      directoryChanged = true;
      continue;
    }
    if (commandName === "rm") {
      if (directoryChanged) throw new CheckpointTargetError("Set code_shell cwd instead of changing directories before rm");
      destructive = true;
      targets.push(...rmTargets(words.slice(1), base));
    } else if (commandName === "mv") {
      if (directoryChanged) throw new CheckpointTargetError("Set code_shell cwd instead of changing directories before mv");
      destructive = true;
      targets.push(...mvTargets(words.slice(1), base));
    } else if (commandName === "sed" && hasInPlaceOption(words.slice(1))) {
      if (directoryChanged) throw new CheckpointTargetError("Set code_shell cwd instead of changing directories before sed -i");
      destructive = true;
      targets.push(...sedTargets(words.slice(1), base));
    } else if (mentionsDestructiveCommand(segment)) {
      throw new CheckpointTargetError("Destructive shell syntax is not safely supported for checkpointing");
    }
  }
  if (destructive && targets.length === 0) {
    throw new CheckpointTargetError("Destructive shell command had no safely resolvable file targets");
  }
  return { destructive, targets: [...new Set(targets)], cwd: base };
}

function rmTargets(words, cwd) {
  const operands = positionalWords(words);
  if (operands.length === 0) throw new CheckpointTargetError("rm command has no target");
  return operands.map((word) => resolveShellWord(word, cwd));
}

function mvTargets(words, cwd) {
  if (words.some((word) => (
    word === "-t"
    || word === "--target-directory"
    || word.startsWith("--target-directory=")
    || word === "-T"
    || word === "--no-target-directory"
  ))) {
    throw new CheckpointTargetError("mv target-directory options are not safely supported for checkpointing");
  }
  const operands = positionalWords(words);
  if (operands.length < 2) throw new CheckpointTargetError("mv command requires source and destination targets");
  const resolved = operands.map((word) => resolveShellWord(word, cwd));
  const destination = resolved.at(-1);
  const sources = resolved.slice(0, -1);
  const destinationIsDirectory = lstatKind(destination) === "directory";
  if (sources.length > 1 && !destinationIsDirectory) {
    throw new CheckpointTargetError("mv with multiple sources requires an existing destination directory");
  }
  const changedDestinations = destinationIsDirectory
    ? sources.map((source) => path.join(destination, path.basename(source)))
    : [destination];
  return [...sources, ...changedDestinations];
}

function sedTargets(words, cwd) {
  const positional = [];
  let scriptProvided = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "-i" || word === "--in-place") {
      if (words[i + 1] === "") i += 1;
      continue;
    }
    if (/^-i.+/.test(word) || /^--in-place=/.test(word)) continue;
    if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
      if (i + 1 >= words.length) throw new CheckpointTargetError(`sed option ${word} is missing its value`);
      i += 1;
      scriptProvided = true;
      continue;
    }
    if (/^(?:--expression|--file)=/.test(word)) { scriptProvided = true; continue; }
    if (word.startsWith("-")) continue;
    if (!scriptProvided) { scriptProvided = true; continue; }
    positional.push(word);
  }
  if (positional.length === 0) throw new CheckpointTargetError("sed -i command has no file target");
  return positional.map((word) => resolveShellWord(word, cwd));
}

function hasInPlaceOption(words) {
  return words.some((word) => word === "-i" || word === "--in-place" || /^-i.+/.test(word) || /^--in-place=/.test(word));
}

function positionalWords(words) {
  const out = [];
  let optionsEnded = false;
  for (const word of words) {
    if (!optionsEnded && word === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("-")) continue;
    if (/^(?:\d*)?>{1,2}$/.test(word)) break;
    if (/^(?:\d*)?>/.test(word)) break;
    out.push(word);
  }
  return out;
}

function resolveShellWord(word, cwd) {
  if (!nonEmpty(word) || hasShellExpansion(word)) {
    throw new CheckpointTargetError(`Cannot safely resolve shell target: ${word}`);
  }
  return path.resolve(cwd, word);
}

function hasShellExpansion(value) {
  return /[$`*?\[\]{}<>|;&\n\r]/.test(String(value));
}

function unwrapShell(value) {
  let text = value;
  for (let i = 0; i < 2; i += 1) {
    const match = /^(?:\/[^\s]+\/)?bash\s+-lc\s+(?:'([\s\S]*)'|"([\s\S]*)"|([\s\S]+))$/i.exec(text);
    if (!match) break;
    text = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  }
  return text;
}

function splitShellSegments(value) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  const flush = () => { if (current.trim()) out.push(current.trim()); current = ""; };
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      flush();
      if ((char === "|" || char === "&") && value[i + 1] === char) i += 1;
      continue;
    }
    current += char;
  }
  if (quote || escaped) throw new Error("Cannot checkpoint shell command with unterminated quoting");
  flush();
  return out;
}

function shellWords(value) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let active = false;
  const flush = () => { if (active) out.push(current); current = ""; active = false; };
  for (const char of value) {
    if (escaped) { current += char; active = true; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; active = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    current += char;
    active = true;
  }
  if (quote || escaped) throw new CheckpointTargetError("Cannot checkpoint shell command with unterminated quoting");
  flush();
  return out;
}

function stripCommandPrefixes(words) {
  words[0] = words[0].replace(/^\(+/, "");
  const optionsWithValues = new Set([
    "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
    "-p", "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-u", "--user"
  ]);
  while (words.length > 0) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    const prefix = path.basename(words[0] ?? "");
    if (prefix === "command" || prefix === "builtin") {
      words.shift();
      continue;
    }
    if (prefix === "env") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        const option = words.shift();
        if (["-u", "--unset"].includes(option) && words.length > 0) words.shift();
        else if (!["-i", "--ignore-environment", "--"].includes(option)) {
          throw new CheckpointTargetError(`env option ${option} is not safely supported for checkpointing`);
        }
      }
      continue;
    }
    if (prefix !== "sudo") return;
    words.shift();
    while (words[0]?.startsWith("-")) {
      const option = words.shift();
      if (optionsWithValues.has(option) && words.length > 0) words.shift();
    }
  }
}

function hasUnquotedParenthesis(value) {
  let quote = null;
  let escaped = false;
  for (const char of String(value)) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(" || char === ")") return true;
  }
  return false;
}

function mentionsDestructiveCommand(value) {
  let words;
  try { words = shellWords(String(value).replace(/[()]/g, " ")); }
  catch { return /\b(?:rm|mv|sed)\b/.test(String(value)); }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const commandName = path.basename(word);
    if (commandName === "rm" || commandName === "mv") return true;
    if (commandName === "sed" && hasInPlaceOption(words.slice(index + 1))) return true;
    if (/\b(?:rm|mv)\b/.test(word)) return true;
    if (/\bsed\b/.test(word) && /(?:^|\s)-i(?:\s|$|\S)/.test(word)) return true;
  }
  return false;
}

function previewStatus(target, current) {
  if (target.kind === "missing") return current.kind === "missing" ? "unchanged" : "created";
  if (current.kind === "missing") return "deleted";
  if (target.kind !== current.kind) return "type-changed";
  if (target.kind === "file") return target.hash === sha256(current.data) ? "unchanged" : "modified";
  if (target.kind === "symlink") return target.linkTarget === current.linkTarget ? "unchanged" : "modified";
  return "unchanged";
}

function renderDiff(before, after, target, current) {
  if (before && after && !isBinary(before) && !isBinary(after)) return simpleTextDiff(before, after);
  if (target.kind === "missing") return `+ created ${current.kind}`;
  if (current.kind === "missing") return `- deleted ${target.kind}`;
  return `Binary or type change: ${target.kind} ${target.size ?? 0} bytes -> ${current.kind} ${after?.length ?? 0} bytes`;
}

function simpleTextDiff(before, after) {
  const left = before.toString("utf8").split("\n");
  const right = after.toString("utf8").split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  const removed = left.slice(prefix, left.length - suffix).slice(0, 30).map((line) => `-${line}`);
  const added = right.slice(prefix, right.length - suffix).slice(0, 30).map((line) => `+${line}`);
  return [`@@ line ${prefix + 1} @@`, ...removed, ...added].join("\n");
}

function readCurrent(filePath) {
  const stat = safeLstat(filePath);
  if (!stat) return { kind: "missing", data: null };
  if (stat.isSymbolicLink()) return { kind: "symlink", linkTarget: fs.readlinkSync(filePath), data: null };
  if (stat.isDirectory()) return { kind: "directory", data: null };
  if (stat.isFile()) return { kind: "file", data: fs.readFileSync(filePath) };
  return { kind: "other", data: null };
}

function safeLstat(filePath) {
  try { return fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function lstatKind(filePath) {
  const stat = safeLstat(filePath);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function isSymlink(filePath) {
  return safeLstat(filePath)?.isSymbolicLink() ?? false;
}

function safeChmod(filePath, mode) {
  if (!Number.isInteger(mode)) return;
  try { fs.chmodSync(filePath, mode); } catch { /* best effort on Windows */ }
}

function writeBufferAtomic(filePath, data, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, data, { mode });
  const fd = fs.openSync(tempPath, "r+");
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tempPath, filePath);
}

function writeCheckpointSnapshot(filePath, value) {
  try {
    writeJsonAtomic(filePath, value);
  } catch (error) {
    // Node on Windows rejects fsync on the read-only handle used by the
    // shared atomic-text helper. Preserve the same temp+flush+rename contract
    // with a writable handle rather than disabling durable snapshots.
    if (error?.code !== "EPERM" || process.platform !== "win32") throw error;
    writeBufferAtomic(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), 0o600);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isBinary(value) {
  const limit = Math.min(value.length, 8000);
  for (let i = 0; i < limit; i += 1) if (value[i] === 0) return true;
  return false;
}

function validCheckpoint(value, { maxFiles, maxBytes } = {}) {
  if (
    !value
    || typeof value !== "object"
    || !nonEmpty(value.id)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !nonEmpty(value.turnId)
    || !nonEmpty(value.directory)
    || !path.isAbsolute(String(value.directory))
    || !Array.isArray(value.toolNames)
    || value.toolNames.some((name) => !nonEmpty(name))
    || !Array.isArray(value.targets)
    || value.targets.length === 0
    || value.targets.length > positiveInteger(maxFiles, DEFAULT_MAX_FILES)
    || !Array.isArray(value.rollbacks)
  ) {
    return false;
  }
  if (
    value.workspaceRoot !== undefined
    && (!nonEmpty(value.workspaceRoot) || !path.isAbsolute(String(value.workspaceRoot)))
  ) {
    return false;
  }
  let capturedBytes = 0;
  for (const target of value.targets) {
    if (
      !target
      || typeof target !== "object"
      || !nonEmpty(target.path)
      || !path.isAbsolute(String(target.path))
      || !["missing", "directory", "file", "symlink"].includes(target.kind)
    ) {
      return false;
    }
    if (target.kind === "file") {
      if (
        !/^[a-f0-9]{64}$/u.test(String(target.hash ?? ""))
        || !Number.isSafeInteger(target.size)
        || target.size < 0
      ) {
        return false;
      }
      capturedBytes += target.size;
      if (capturedBytes > positiveInteger(maxBytes, DEFAULT_MAX_BYTES)) return false;
    }
    if (target.kind === "symlink" && typeof target.linkTarget !== "string") return false;
  }
  return true;
}

function emptyCapture(enabled) {
  return { enabled, destructive: false, targets: [], checkpoints: [] };
}

function dedupeKey(turnId, directory, projectId = "default") {
  return `${normalizedProjectId(projectId)}\u0000${String(turnId)}\u0000${path.resolve(directory)}`;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizedProjectId(value) {
  const projectId = String(value ?? "").trim();
  return projectId || "default";
}

function projectBoundaryError(message) {
  const error = new Error(message);
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  return error;
}

function boundedRollbackHistory(events, limit) {
  const bounded = positiveInteger(limit, DEFAULT_MAX_ROLLBACKS);
  return events.length <= bounded ? events : events.slice(-bounded);
}

function safeErrorMessage(error) {
  const message = String(error?.message ?? "Rollback failed")
    .replace(/[\r\n]+/gu, " ")
    .trim();
  return (message || "Rollback failed").slice(0, 500);
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readJsonLineTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return [];
  const length = Math.min(stat.size, positiveInteger(maxBytes, DEFAULT_MAX_REPLAY_BYTES));
  if (length === 0) return [];
  const offset = stat.size - length;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const count = fs.readSync(
        fd,
        buffer,
        bytesRead,
        length - bytesRead,
        offset + bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (offset > 0) {
    const newline = text.indexOf("\n");
    text = newline < 0 ? "" : text.slice(newline + 1);
  }
  return text.split(/\r?\n/u);
}

function uniquePaths(values) {
  return [...new Set(values.filter(nonEmpty).map((value) => path.resolve(String(value))))];
}

function resolveThroughExistingAncestor(value) {
  const target = path.resolve(value);
  let probe = target;
  while (!safeLstat(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return target;
    probe = parent;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { return target; }
  const tail = path.relative(probe, target);
  return path.resolve(real, tail);
}

function isSensitiveEnvPath(value) {
  const name = path.basename(value);
  return name.startsWith(".env") && name !== ".env.example";
}

function pathsOverlap(left, right) {
  return (
    left === right
    || left.startsWith(right + path.sep)
    || right.startsWith(left + path.sep)
  );
}

function clone(value) {
  return structuredClone(value);
}

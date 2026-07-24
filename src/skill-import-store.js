import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { DEFAULT_PROJECT_ID } from "./project-store.js";
import { pickUserSkillsDir } from "./skill-materialize.js";
import { createId, nowIso, stableHash } from "./utils.js";

export const SKILL_IMPORT_STATUSES = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected"
});

export const SKILL_IMPORT_KINDS = Object.freeze({
  ZIP: "zip",
  GIT: "git"
});

const IMPORT_ID_RE = /^skill_import_[a-f0-9]{16}$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const EVENT_OP_RE = /^[a-z][a-z-]{0,63}$/;
const PATH_LIKE_UNICODE_RE = /[\u2024\u2044\u2215\u29f8\u29f9\ufe52\uff0e\uff0f\uff3c]/u;
const ALLOWED_LINKED_DIRS = new Set([
  "references",
  "templates",
  "scripts",
  "assets"
]);
const STORED_CANDIDATE_FIELDS = new Set([
  "version",
  "id",
  "projectId",
  "projectRevision",
  "kind",
  "status",
  "revision",
  "skillName",
  "description",
  "allowedTools",
  "sourceLabel",
  "sourceHash",
  "manifest",
  "totalBytes",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "approvedAt",
  "approvedBy",
  "rejectedAt",
  "rejectedBy",
  "rejectionReason",
  "installedPath"
]);
const STORED_STATE_FIELDS = new Set([
  "version",
  "sequence",
  "updatedAt",
  "candidates"
]);
const MAX_CANDIDATES = 512;
const MAX_FILES = 128;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REVIEW_BYTES = 256 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 12 * 1024 * 1024;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class SkillImportRevisionError extends Error {
  constructor(id, expectedRevision, actualRevision) {
    super(
      `Skill import revision conflict for '${id}': expected ${expectedRevision}, found ${actualRevision ?? "none"}.`
    );
    this.name = "SkillImportRevisionError";
    this.code = "SKILL_IMPORT_REVISION_CONFLICT";
    this.id = id;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision ?? null;
  }
}

export class SkillImportBoundaryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkillImportBoundaryError";
    this.code = "SKILL_IMPORT_BOUNDARY";
    Object.assign(this, details);
  }
}

// Review-only import quarantine. Staging reads static bytes and never invokes
// Git, package managers, interpreters, hooks, filters, or imported scripts.
// "git" means an already-present local checkout inside the default project;
// fetching a remote repository remains a separately approved network action.
export class SkillImportStore {
  constructor(options = {}) {
    const source = plainRecord(options, "SkillImportStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(source.dir ?? path.join(dataDir, "skill-imports"));
    this.quarantineDir = path.join(this.dir, "quarantine");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.projects = source.projects ?? null;
    this.runtime = source.runtime ?? null;
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.onChange = typeof source.onChange === "function" ? source.onChange : null;
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.lockTimeoutMs = positiveInteger(
      source.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS
    );
    this.staleLockMs = positiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS
    );
    this.lockDepth = 0;
    this.pendingChanges = null;
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.candidates = new Map();
    ensurePrivateDir(this.dir);
    ensurePrivateDir(this.quarantineDir);
    this._withLock(() => this._restore());
  }

  list({ projectId, status = null, includeResolved = true } = {}) {
    const project = this._authorizeControlProject(projectId);
    if (status != null && !Object.values(SKILL_IMPORT_STATUSES).includes(status)) {
      throw new TypeError("Invalid skill import status.");
    }
    requireBoolean(includeResolved, "includeResolved");
    return this._readFresh(() => [...this.candidates.values()]
      .filter((candidate) => candidate.projectId === project.id)
      .filter((candidate) => !status || candidate.status === status)
      .filter((candidate) => (
        includeResolved || candidate.status === SKILL_IMPORT_STATUSES.PENDING
      ))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || left.id.localeCompare(right.id)
      ))
      .map(publicCandidate));
  }

  get(id, { projectId } = {}) {
    const project = this._authorizeControlProject(projectId);
    const candidateId = normalizeImportId(id);
    return this._readFresh(() => {
      const candidate = this.candidates.get(candidateId) ?? null;
      if (!candidate || candidate.projectId !== project.id) return null;
      return publicCandidate(candidate);
    });
  }

  stage(input = {}, context = {}) {
    const source = plainRecord(input, "skill import");
    assertOnlyKeys(
      source,
      new Set(["projectId", "kind", "sourcePath", "sourceLabel"]),
      "skill import"
    );
    const project = this._authorizeControlProject(source.projectId);
    const kind = normalizeKind(source.kind);
    const sourcePath = this._resolveSourcePath(project, source.sourcePath);
    const sourceLabel = optionalText(
      source.sourceLabel,
      "sourceLabel",
      500
    ) || path.basename(sourcePath);
    const extracted = kind === SKILL_IMPORT_KINDS.ZIP
      ? readZipCandidate(sourcePath)
      : readGitCandidate(sourcePath);
    const candidateId = createId("skill_import");
    if (!IMPORT_ID_RE.test(candidateId)) {
      throw new Error("Unable to allocate a skill import id.");
    }
    const stagedPackage = stampImportLineage(extracted, {
      candidateId,
      projectId: project.id,
      kind
    });
    const candidateDir = path.join(this.quarantineDir, candidateId);
    ensurePathWithin(candidateDir, this.quarantineDir);
    writeQuarantineFiles(candidateDir, stagedPackage.files);
    const at = this._now();
    const candidate = normalizeStoredCandidate({
      version: 1,
      id: candidateId,
      projectId: project.id,
      projectRevision: project.revision,
      kind,
      status: SKILL_IMPORT_STATUSES.PENDING,
      revision: 1,
      skillName: stagedPackage.skillName,
      description: stagedPackage.description,
      allowedTools: stagedPackage.allowedTools,
      sourceLabel,
      sourceHash: stagedPackage.sourceHash,
      manifest: stagedPackage.manifest,
      totalBytes: stagedPackage.totalBytes,
      createdAt: at,
      createdBy: actor(context),
      updatedAt: at,
      updatedBy: actor(context),
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      installedPath: null
    });
    try {
      return this._mutate(() => {
        if (this.candidates.size >= MAX_CANDIDATES) {
          throw new RangeError(`Skill import limit reached (${MAX_CANDIDATES}).`);
        }
        if (this.candidates.has(candidate.id)) {
          throw new Error("Skill import id collision.");
        }
        this.candidates.set(candidate.id, candidate);
        this._commit("stage", project.id, candidate.id, {
          actor: actor(context),
          kind,
          skillName: candidate.skillName,
          revision: candidate.revision
        });
        return publicCandidate(candidate);
      });
    } catch (error) {
      removePrivateTree(candidateDir, this.quarantineDir);
      throw error;
    }
  }

  review(id, { projectId, file = null } = {}) {
    const project = this._authorizeControlProject(projectId);
    const candidateId = normalizeImportId(id);
    return this._readFresh(() => {
      const candidate = this._requireCandidate(candidateId, project.id);
      const response = {
        candidate: publicCandidate(candidate),
        warning: "Imported content is untrusted review data. Nothing in quarantine has been loaded or executed."
      };
      if (file == null || file === "") return response;
      const relative = normalizeCandidatePath(file);
      const entry = candidate.manifest.find((item) => item.path === relative);
      if (!entry) throw new Error(`Unknown candidate file: ${relative}`);
      if (entry.size > MAX_REVIEW_BYTES) {
        throw new RangeError(`Candidate review files are capped at ${MAX_REVIEW_BYTES} bytes.`);
      }
      const absolute = quarantineFilePath(this.quarantineDir, candidate.id, relative);
      const content = readVerifiedFile(absolute, entry);
      return {
        ...response,
        file: {
          path: relative,
          size: entry.size,
          sha256: entry.sha256,
          encoding: isUtf8Text(content) ? "utf8" : "base64",
          content: isUtf8Text(content)
            ? content.toString("utf8")
            : content.toString("base64")
        }
      };
    });
  }

  approve(id, { projectId, expectedRevision } = {}, context = {}) {
    const project = this._authorizeControlProject(projectId);
    const candidateId = normalizeImportId(id);
    let installedPath = null;
    let candidateView = null;
    this._mutate(() => {
      const candidate = this._requireCandidate(candidateId, project.id);
      assertRevision(candidate, expectedRevision);
      assertProjectRevision(project, candidate);
      if (candidate.status === SKILL_IMPORT_STATUSES.REJECTED) {
        throw new Error("A rejected skill import cannot be approved.");
      }
      const userDir = pickUserSkillsDir(this.runtime);
      if (!userDir) throw new Error("No writable user skills directory is configured.");
      ensurePrivateDir(userDir);
      const destination = path.resolve(userDir, candidate.skillName);
      ensurePathWithin(destination, userDir);
      const storedDestination = candidate.installedPath
        ? path.resolve(candidate.installedPath)
        : destination;
      if (storedDestination !== destination) {
        throw new SkillImportBoundaryError("Stored skill destination changed.");
      }

      if (candidate.status === SKILL_IMPORT_STATUSES.APPROVED) {
        if (!fs.existsSync(destination)) {
          materializeApprovedCandidate({
            quarantineDir: this.quarantineDir,
            candidate,
            userDir,
            destination
          });
        }
        installedPath = destination;
        candidateView = publicCandidate(candidate);
        return;
      }
      if (fs.existsSync(destination)) {
        throw new Error(`Skill '${candidate.skillName}' already exists.`);
      }

      // Prepare and hash-check a hidden directory before recording approval.
      // Hidden directories are ignored by SkillRegistry.
      const prepared = prepareMaterialization({
        quarantineDir: this.quarantineDir,
        candidate,
        userDir
      });
      const at = this._now();
      const next = normalizeStoredCandidate({
        ...candidate,
        status: SKILL_IMPORT_STATUSES.APPROVED,
        revision: nextRevision(candidate.revision),
        updatedAt: at,
        updatedBy: actor(context),
        approvedAt: at,
        approvedBy: actor(context),
        installedPath: destination
      });
      this.candidates.set(candidate.id, next);
      try {
        // The explicit approval is durable before the atomic rename makes the
        // imported skill visible to SkillRegistry.
        this._commit("approve", project.id, candidate.id, {
          actor: actor(context),
          revision: next.revision,
          skillName: next.skillName
        });
      } catch (error) {
        removePrivateTree(prepared, userDir);
        throw error;
      }
      try {
        fs.renameSync(prepared, destination);
      } catch (error) {
        // Approval remains durable but the hidden prepared directory is not
        // executable. A later approve call can safely retry materialization.
        removePrivateTree(prepared, userDir);
        throw error;
      }
      installedPath = destination;
      candidateView = publicCandidate(next);
    });
    this.runtime?.skills?.reload?.();
    return {
      ...candidateView,
      installedPath,
      loaded: Boolean(this.runtime?.skills?.has?.(candidateView.skillName))
    };
  }

  reject(id, { projectId, expectedRevision, reason } = {}, context = {}) {
    const project = this._authorizeControlProject(projectId);
    const candidateId = normalizeImportId(id);
    return this._mutate(() => {
      const candidate = this._requireCandidate(candidateId, project.id);
      assertRevision(candidate, expectedRevision);
      assertProjectRevision(project, candidate);
      if (candidate.status === SKILL_IMPORT_STATUSES.APPROVED) {
        throw new Error("An approved skill import cannot be rejected.");
      }
      if (candidate.status === SKILL_IMPORT_STATUSES.REJECTED) {
        return publicCandidate(candidate);
      }
      const at = this._now();
      const next = normalizeStoredCandidate({
        ...candidate,
        status: SKILL_IMPORT_STATUSES.REJECTED,
        revision: nextRevision(candidate.revision),
        updatedAt: at,
        updatedBy: actor(context),
        rejectedAt: at,
        rejectedBy: actor(context),
        rejectionReason: requiredText(reason, "rejection reason", 2000)
      });
      this.candidates.set(candidate.id, next);
      this._commit("reject", project.id, candidate.id, {
        actor: actor(context),
        revision: next.revision,
        reason: next.rejectionReason
      });
      return publicCandidate(next);
    });
  }

  history({ projectId, limit = 100 } = {}) {
    const project = this._authorizeControlProject(projectId);
    const bounded = integerInRange(limit, "limit", 1, 500);
    return this._readFresh(() => readEventLines(this.eventsPath)
      .map(parseEvent)
      .filter(Boolean)
      .filter((event) => event.projectId === project.id)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, bounded)
      .map(({ state: _state, ...event }) => structuredClone(event)));
  }

  _resolveSourcePath(project, value) {
    const sourcePath = requiredText(value, "sourcePath", 4096);
    let resolved;
    if (typeof this.projects?.resolveWorkspacePath === "function") {
      resolved = this.projects.resolveWorkspacePath(project.id, sourcePath);
    } else {
      resolved = path.resolve(project.workspaceRoot ?? process.cwd(), sourcePath);
      ensurePathWithin(resolved, project.workspaceRoot ?? process.cwd());
    }
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new SkillImportBoundaryError("Skill import sources cannot be symlinks.");
    }
    return resolved;
  }

  _authorizeControlProject(projectId) {
    const id = normalizeProjectId(projectId ?? DEFAULT_PROJECT_ID);
    if (id !== DEFAULT_PROJECT_ID) {
      throw new SkillImportBoundaryError(
        "Skill definition imports are restricted to the default project control plane.",
        { projectId: id }
      );
    }
    if (!this.projects) {
      return { id, workspaceRoot: process.cwd() };
    }
    const project = typeof this.projects.authorize === "function"
      ? this.projects.authorize(id, { includeArchived: false })
      : this.projects.get?.(id, { includeArchived: false });
    if (!project) {
      throw new SkillImportBoundaryError("The default project is unavailable.");
    }
    return project;
  }

  _requireCandidate(id, projectId) {
    const candidate = this.candidates.get(id);
    if (!candidate || candidate.projectId !== projectId) {
      throw new Error(`Unknown skill import: ${id}`);
    }
    return candidate;
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
    let failure = null;
    let changes = [];
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
    ensurePrivateDir(this.dir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
          throw new Error("Skill import store is busy.");
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

  _commit(op, projectId, candidateId, details = {}) {
    if (this.lockDepth < 1 || !Array.isArray(this.pendingChanges)) {
      throw new Error("Skill import commits require the mutation lock.");
    }
    const at = this._now();
    const sequence = this.sequence + 1;
    const state = this._state(at, sequence);
    const event = {
      version: 1,
      sequence,
      op,
      at,
      projectId,
      candidateId,
      ...details,
      state
    };
    if (
      jsonBytes(state) > MAX_STATE_BYTES
      || jsonBytes(event) > MAX_EVENT_LINE_BYTES
    ) {
      this._restore();
      throw new RangeError("Skill import state exceeds its persistence bound.");
    }
    let appendError = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      appendError = error;
      this._restore();
      if (
        this.sequence !== sequence
        || stableHash(this._state(state.updatedAt, this.sequence)) !== stableHash(state)
      ) {
        throw error;
      }
    }
    if (!appendError) this.sequence = sequence;
    try {
      this.writeSnapshot(this.snapshotPath, state);
    } catch (error) {
      console.warn(`[skill-imports] snapshot refresh failed: ${error?.message ?? error}`);
    }
    this.pendingChanges.push({
      op,
      at,
      sequence,
      projectId,
      candidateId,
      ...details
    });
  }

  _state(at = this._now(), sequence = this.sequence) {
    return {
      version: 1,
      sequence,
      updatedAt: at,
      candidates: [...this.candidates.values()]
        .map((candidate) => structuredClone(candidate))
        .sort((left, right) => left.id.localeCompare(right.id))
    };
  }

  _restore() {
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.candidates = new Map();
    let snapshot = null;
    try {
      if (fs.statSync(this.snapshotPath).size <= MAX_SNAPSHOT_BYTES) {
        snapshot = readJsonFile(this.snapshotPath, null);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") snapshot = null;
    }
    if (validState(snapshot)) {
      try { this._applyState(snapshot); } catch { /* replay below */ }
    }
    let lines = [];
    try {
      lines = readEventLines(this.eventsPath);
    } catch (error) {
      this._markJournalUnhealthy(error?.message ?? "event log cannot be read");
      return;
    }
    let expectedSequence = 1;
    let replayBlocked = false;
    let highestValidSequence = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        this._markJournalUnhealthy("event line exceeds its size bound");
        replayBlocked = true;
        continue;
      }
      const event = parseEvent(line);
      if (
        !event
        || event.sequence !== expectedSequence
        || !validState(event.state)
        || event.state.sequence !== event.sequence
        || event.state.updatedAt !== event.at
      ) {
        this._markJournalUnhealthy(
          `event sequence ${expectedSequence} is missing or invalid`
        );
        replayBlocked = true;
        if (event?.sequence >= expectedSequence) {
          expectedSequence = event.sequence + 1;
        }
        continue;
      }
      expectedSequence += 1;
      highestValidSequence = event.sequence;
      if (replayBlocked || event.sequence <= this.sequence) continue;
      try {
        this._applyState(event.state);
      } catch {
        this._markJournalUnhealthy(
          `event sequence ${event.sequence} has invalid state`
        );
        replayBlocked = true;
      }
    }
    if (snapshot?.sequence > highestValidSequence) {
      this._markJournalUnhealthy(
        "snapshot authority is newer than the event journal"
      );
    }
  }

  _markJournalUnhealthy(reason) {
    this.journalHealthy = false;
    this.journalError ??= String(reason || "authority journal is invalid");
  }

  _assertJournalHealthy() {
    if (this.journalHealthy) return;
    throw new SkillImportBoundaryError(
      `Skill import authority journal is unavailable: ${this.journalError}.`,
      { journalHealthy: false }
    );
  }

  _applyState(state) {
    const candidates = new Map();
    for (const raw of state.candidates) {
      const candidate = normalizeStoredCandidate(raw);
      if (candidates.has(candidate.id)) {
        throw new TypeError("Duplicate stored skill import.");
      }
      candidates.set(candidate.id, candidate);
    }
    this.candidates = candidates;
    this.sequence = state.sequence;
  }

  _now() {
    const value = this.now();
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
  }
}

function readGitCandidate(sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isDirectory()) {
    throw new TypeError("A git skill source must be a local checkout directory.");
  }
  const marker = path.join(sourcePath, ".git");
  if (!fs.existsSync(marker)) {
    throw new TypeError("A git skill source must contain a .git checkout marker.");
  }
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isSymbolicLink()) {
    throw new SkillImportBoundaryError("The .git checkout marker cannot be a symlink.");
  }
  const files = [];
  walkStaticSkillTree(sourcePath, sourcePath, files);
  return finalizeCandidateFiles(files, {
    sourceHash: hashFiles(files)
  });
}

function walkStaticSkillTree(root, current, files) {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name.startsWith(".")) continue;
    const absolute = path.join(current, entry.name);
    const relative = normalizeCandidatePath(
      path.relative(root, absolute).split(path.sep).join("/")
    );
    const first = relative.split("/")[0];
    if (entry.isSymbolicLink()) {
      throw new SkillImportBoundaryError(`Skill imports cannot contain symlinks: ${relative}`);
    }
    if (entry.isDirectory()) {
      if (!ALLOWED_LINKED_DIRS.has(first)) {
        throw new SkillImportBoundaryError(`Unsupported skill directory: ${first}`);
      }
      walkStaticSkillTree(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new SkillImportBoundaryError(`Unsupported skill file type: ${relative}`);
    }
    if (relative !== "SKILL.md" && !ALLOWED_LINKED_DIRS.has(first)) {
      throw new SkillImportBoundaryError(`Unsupported file outside linked skill directories: ${relative}`);
    }
    assertImportFilePolicy(relative);
    const content = readRegularFileBounded(absolute, MAX_FILE_BYTES);
    files.push({ path: relative, content });
    enforceFileBounds(files);
  }
}

function readZipCandidate(sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile()) throw new TypeError("A zip skill source must be a regular file.");
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new RangeError(`ZIP source exceeds ${MAX_SOURCE_BYTES} bytes.`);
  }
  const archive = fs.readFileSync(sourcePath);
  const entries = parseZipEntries(archive);
  const skillEntries = entries.filter((entry) => !entry.directory);
  const roots = skillEntries
    .map((entry) => entry.path)
    .filter((name) => name === "SKILL.md" || name.endsWith("/SKILL.md"))
    .map((name) => name.slice(0, -"SKILL.md".length));
  if (roots.length !== 1) {
    throw new TypeError("ZIP skill imports must contain exactly one SKILL.md.");
  }
  const root = roots[0];
  const files = [];
  for (const entry of skillEntries) {
    if (entry.path.startsWith("__MACOSX/")) continue;
    if (!entry.path.startsWith(root)) {
      throw new SkillImportBoundaryError("ZIP contains files outside the skill root.");
    }
    const relative = normalizeCandidatePath(entry.path.slice(root.length));
    const first = relative.split("/")[0];
    if (relative !== "SKILL.md" && !ALLOWED_LINKED_DIRS.has(first)) {
      throw new SkillImportBoundaryError(`Unsupported ZIP skill file: ${relative}`);
    }
    assertImportFilePolicy(relative);
    files.push({
      path: relative,
      content: extractZipEntry(archive, entry)
    });
    enforceFileBounds(files);
  }
  return finalizeCandidateFiles(files, {
    sourceHash: sha256(archive)
  });
}

function parseZipEntries(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22) {
    throw new TypeError("Invalid ZIP archive.");
  }
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) throw new TypeError("ZIP end-of-directory record is missing.");
  const disk = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const countOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const count = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || countOnDisk !== count
    || count > MAX_FILES
    || count === 0
    || count === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || centralOffset + centralSize > eocdOffset
  ) {
    throw new TypeError("Unsupported ZIP archive layout.");
  }
  const entries = [];
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new TypeError("Invalid ZIP central-directory entry.");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      end > archive.length
      || diskStart !== 0
      || (flags & 0x1) !== 0
      || ![0, 8].includes(method)
      || compressedSize === 0xffffffff
      || size === 0xffffffff
      || size > MAX_FILE_BYTES
    ) {
      throw new TypeError("Unsupported or oversized ZIP entry.");
    }
    const mode = (externalAttributes >>> 16) & 0xffff;
    const fileType = mode & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
      throw new SkillImportBoundaryError(
        "ZIP skill imports cannot contain links, devices, sockets, or FIFOs."
      );
    }
    const nameBuffer = archive.subarray(offset + 46, offset + 46 + nameLength);
    const entryPath = normalizeArchivePath(nameBuffer.toString("utf8"));
    const directory = entryPath.endsWith("/");
    if (
      (!directory && fileType === 0x4000)
      || (directory && fileType === 0x8000)
    ) {
      throw new TypeError("ZIP entry type disagrees with its path.");
    }
    if (
      !directory
      && size > (compressedSize * 200) + (1024 * 1024)
    ) {
      throw new RangeError("ZIP entry compression ratio is unsafe.");
    }
    if (!directory) {
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new RangeError(`ZIP expands beyond ${MAX_TOTAL_BYTES} bytes.`);
      }
    }
    entries.push({
      path: directory ? entryPath.slice(0, -1) + "/" : entryPath,
      directory,
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      centralOffset
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw new TypeError("ZIP central-directory size is inconsistent.");
  }
  const ranges = entries
    .map((entry) => zipEntryDataRange(archive, entry))
    .sort((left, right) => left.start - right.start);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (range.end > centralOffset) {
      throw new TypeError("ZIP entry overlaps its central directory.");
    }
    if (index > 0 && range.start < ranges[index - 1].end) {
      throw new TypeError("ZIP entries overlap.");
    }
  }
  return entries;
}

function extractZipEntry(archive, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) {
    throw new TypeError("Invalid ZIP local entry.");
  }
  const localFlags = archive.readUInt16LE(offset + 6);
  const localMethod = archive.readUInt16LE(offset + 8);
  const localCrc = archive.readUInt32LE(offset + 14);
  const localCompressedSize = archive.readUInt32LE(offset + 18);
  const localSize = archive.readUInt32LE(offset + 22);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    throw new TypeError("ZIP local and central entry metadata differ.");
  }
  const localName = normalizeArchivePath(
    archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
  );
  if (localName !== entry.path) {
    throw new TypeError("ZIP local and central entry names differ.");
  }
  if (
    (localFlags & 0x8) === 0
    && (
      localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize
      || localSize !== entry.size
    )
  ) {
    throw new TypeError("ZIP local and central entry sizes differ.");
  }
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) throw new TypeError("ZIP entry data is truncated.");
  const compressed = archive.subarray(start, end);
  let content;
  if (entry.method === 0) {
    content = Buffer.from(compressed);
  } else {
    content = zlib.inflateRawSync(compressed, {
      maxOutputLength: Math.min(MAX_FILE_BYTES, entry.size) + 1
    });
  }
  if (
    content.length !== entry.size
    || content.length > MAX_FILE_BYTES
    || crc32(content) !== entry.crc
  ) {
    throw new TypeError("ZIP entry failed size or CRC verification.");
  }
  return content;
}

function zipEntryDataRange(archive, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) {
    throw new TypeError("Invalid ZIP local entry.");
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const start = offset;
  const end = offset + 30 + nameLength + extraLength + entry.compressedSize;
  if (end > archive.length) throw new TypeError("ZIP entry data is truncated.");
  return { start, end };
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  return -1;
}

function finalizeCandidateFiles(files, { sourceHash, allowLineage = false }) {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (sorted.length === 0 || sorted.length > MAX_FILES) {
    throw new RangeError("Skill import has an invalid file count.");
  }
  const paths = new Set();
  const portablePaths = new Set();
  let totalBytes = 0;
  for (const file of sorted) {
    if (paths.has(file.path)) throw new TypeError(`Duplicate skill path: ${file.path}`);
    paths.add(file.path);
    const portable = file.path.normalize("NFKC").toLowerCase();
    if (portablePaths.has(portable)) {
      throw new SkillImportBoundaryError(
        `Skill import has a case or normalization path collision: ${file.path}`
      );
    }
    portablePaths.add(portable);
    totalBytes += file.content.length;
  }
  if (!paths.has("SKILL.md")) throw new TypeError("Skill import is missing SKILL.md.");
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new RangeError(`Skill import exceeds ${MAX_TOTAL_BYTES} bytes.`);
  }
  const skillDocument = sorted.find((file) => file.path === "SKILL.md").content;
  if (!isUtf8Text(skillDocument)) throw new TypeError("SKILL.md must be UTF-8 text.");
  const metadata = parseSkillMetadata(
    skillDocument.toString("utf8"),
    { allowLineage }
  );
  const manifest = sorted.map((file) => ({
    path: file.path,
    size: file.content.length,
    sha256: sha256(file.content)
  }));
  return {
    files: sorted,
    manifest,
    totalBytes,
    skillName: metadata.name,
    description: metadata.description,
    allowedTools: metadata.allowedTools,
    sourceHash
  };
}

function parseSkillMetadata(document, { allowLineage = false } = {}) {
  if (Buffer.byteLength(document, "utf8") > MAX_FILE_BYTES) {
    throw new RangeError("SKILL.md is too large.");
  }
  const normalized = document.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(normalized);
  if (!match) throw new TypeError("SKILL.md requires YAML-style frontmatter and a body.");
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = unquoteScalar(line.slice(separator + 1).trim());
    if (!fields.has(key)) fields.set(key, value);
  }
  const name = String(fields.get("name") ?? "").trim();
  if (!SKILL_NAME_RE.test(name) || name.length > 64) {
    throw new TypeError("Imported skill name must be lowercase kebab-case.");
  }
  const description = String(fields.get("description") ?? "").trim();
  if (!description || description.length > 1024) {
    throw new TypeError("Imported skill description is required and must be at most 1024 characters.");
  }
  if (!fields.has("allowed_tools")) {
    throw new TypeError(
      "Imported skills must declare a finite allowed_tools JSON array."
    );
  }
  let allowedTools;
  try {
    allowedTools = JSON.parse(String(fields.get("allowed_tools")));
  } catch {
    throw new TypeError("Imported skill allowed_tools must be valid JSON.");
  }
  if (
    !Array.isArray(allowedTools)
    || allowedTools.length > 128
    || allowedTools.some((tool) => (
      typeof tool !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(tool)
      || tool === "*"
    ))
  ) {
    throw new TypeError(
      "Imported skill allowed_tools must be a finite array of explicit tool names."
    );
  }
  allowedTools = [...new Set(allowedTools)].sort();
  if (!allowLineage) {
    for (const reserved of [
      "sourceImportId",
      "sourceImportHash",
      "sourceImportKind",
      "ownerProjectId"
    ]) {
      if (fields.has(reserved)) {
        throw new TypeError(`Imported skill cannot predeclare reserved lineage field '${reserved}'.`);
      }
    }
  }
  if (!match[2].trim()) throw new TypeError("Imported skill body cannot be empty.");
  return { name, description, allowedTools };
}

function stampImportLineage(extracted, {
  candidateId,
  projectId,
  kind
}) {
  const files = extracted.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.content)
  }));
  const index = files.findIndex((file) => file.path === "SKILL.md");
  if (index < 0) throw new TypeError("Skill import is missing SKILL.md.");
  const document = files[index].content.toString("utf8").replace(/\r\n?/g, "\n");
  const match = /^(---\n[\s\S]*?)(\n---\n[\s\S]+)$/u.exec(document);
  if (!match) throw new TypeError("SKILL.md frontmatter cannot be stamped.");
  const lineage = [
    `sourceImportId: ${JSON.stringify(candidateId)}`,
    `sourceImportHash: ${JSON.stringify(extracted.sourceHash)}`,
    `sourceImportKind: ${JSON.stringify(kind)}`,
    `ownerProjectId: ${JSON.stringify(projectId)}`,
    'createdBy: "skill-import"'
  ].join("\n");
  files[index].content = Buffer.from(`${match[1]}\n${lineage}${match[2]}`, "utf8");
  return finalizeCandidateFiles(files, {
    sourceHash: extracted.sourceHash,
    allowLineage: true
  });
}

function unquoteScalar(value) {
  if (
    value.length >= 2
    && value.startsWith('"')
    && value.endsWith('"')
  ) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (
    value.length >= 2
    && value.startsWith("'")
    && value.endsWith("'")
  ) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function writeQuarantineFiles(candidateDir, files) {
  if (fs.existsSync(candidateDir)) throw new Error("Skill quarantine collision.");
  fs.mkdirSync(candidateDir, { recursive: false, mode: 0o700 });
  try {
    for (const file of files) {
      const destination = path.resolve(candidateDir, ...file.path.split("/"));
      ensurePathWithin(destination, candidateDir);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, file.content, {
        flag: "wx",
        mode: 0o600
      });
    }
  } catch (error) {
    removePrivateTree(candidateDir, path.dirname(candidateDir));
    throw error;
  }
}

function prepareMaterialization({ quarantineDir, candidate, userDir }) {
  const prepared = path.resolve(
    userDir,
    `.skill-import-${candidate.id}-${process.pid}-${Date.now()}`
  );
  ensurePathWithin(prepared, userDir);
  if (fs.existsSync(prepared)) throw new Error("Skill import preparation collision.");
  fs.mkdirSync(prepared, { recursive: false, mode: 0o700 });
  try {
    for (const entry of candidate.manifest) {
      const source = quarantineFilePath(
        quarantineDir,
        candidate.id,
        entry.path
      );
      const content = readVerifiedFile(source, entry);
      const destination = path.resolve(prepared, ...entry.path.split("/"));
      ensurePathWithin(destination, prepared);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
    }
    return prepared;
  } catch (error) {
    removePrivateTree(prepared, userDir);
    throw error;
  }
}

function materializeApprovedCandidate({
  quarantineDir,
  candidate,
  userDir,
  destination
}) {
  if (fs.existsSync(destination)) return destination;
  const prepared = prepareMaterialization({
    quarantineDir,
    candidate,
    userDir
  });
  try {
    fs.renameSync(prepared, destination);
  } catch (error) {
    removePrivateTree(prepared, userDir);
    throw error;
  }
  return destination;
}

function quarantineFilePath(quarantineDir, candidateId, relative) {
  const candidateDir = path.resolve(quarantineDir, candidateId);
  ensurePathWithin(candidateDir, quarantineDir);
  const absolute = path.resolve(candidateDir, ...relative.split("/"));
  ensurePathWithin(absolute, candidateDir);
  return absolute;
}

function readVerifiedFile(file, entry) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
    throw new SkillImportBoundaryError(`Quarantined file changed: ${entry.path}`);
  }
  const content = readRegularFileBounded(file, MAX_FILE_BYTES);
  if (sha256(content) !== entry.sha256) {
    throw new SkillImportBoundaryError(`Quarantined file hash changed: ${entry.path}`);
  }
  return content;
}

function readRegularFileBounded(file, maximum) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) {
    throw new SkillImportBoundaryError("Skill import source contains an unsafe file.");
  }
  const content = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || content.length !== after.size
  ) {
    throw new SkillImportBoundaryError("Skill import source changed while reading.");
  }
  return content;
}

function enforceFileBounds(files) {
  if (files.length > MAX_FILES) throw new RangeError(`Skill imports allow at most ${MAX_FILES} files.`);
  const total = files.reduce((sum, file) => sum + file.content.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new RangeError(`Skill import exceeds ${MAX_TOTAL_BYTES} bytes.`);
  }
}

function normalizeArchivePath(value) {
  if (value.endsWith("/")) {
    return normalizeCandidatePath(value.slice(0, -1)) + "/";
  }
  return normalizeCandidatePath(value);
}

function normalizeCandidatePath(value) {
  if (typeof value !== "string") throw new TypeError("Skill file path must be a string.");
  const text = value.trim();
  if (
    !text
    || text.includes("\0")
    || text.includes("\\")
    || text.includes(":")
    || PATH_LIKE_UNICODE_RE.test(text)
    || text.normalize("NFKC") !== text
    || path.posix.isAbsolute(text)
    || path.win32.isAbsolute(text)
  ) {
    throw new SkillImportBoundaryError("Skill file path is unsafe.");
  }
  const segments = text.split("/");
  if (
    segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment.startsWith(".")
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || /[\u0000-\u001f\u007f]/u.test(segment)
      || segment.length > 255
    ))
    || segments.length > 16
    || text.length > 1024
  ) {
    throw new SkillImportBoundaryError("Skill file path is unsafe.");
  }
  return segments.join("/");
}

function assertImportFilePolicy(relative) {
  const lower = relative.toLowerCase();
  const base = lower.split("/").at(-1);
  if (
    /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar|jar|war)$/u.test(lower)
    || /\.(?:pem|key|p12|pfx|jks)$/u.test(lower)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|authorized_keys|known_hosts)$/u.test(base)
  ) {
    throw new SkillImportBoundaryError(
      `Skill import contains a forbidden nested archive or credential file: ${relative}`
    );
  }
}

function normalizeStoredCandidate(value) {
  const source = plainRecord(value, "stored skill import");
  assertOnlyKeys(source, STORED_CANDIDATE_FIELDS, "stored skill import");
  if (source.version !== 1) throw new TypeError("Invalid stored skill import version.");
  const status = source.status;
  if (!Object.values(SKILL_IMPORT_STATUSES).includes(status)) {
    throw new TypeError("Invalid stored skill import status.");
  }
  const manifest = plainArray(source.manifest, "skill import manifest", MAX_FILES)
    .map((raw) => {
      const entry = plainRecord(raw, "skill import manifest entry");
      assertOnlyKeys(
        entry,
        new Set(["path", "size", "sha256"]),
        "skill import manifest entry"
      );
      const size = integerInRange(entry.size, "manifest size", 0, MAX_FILE_BYTES);
      const digest = requiredText(entry.sha256, "manifest sha256", 64);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid manifest sha256.");
      return {
        path: normalizeCandidatePath(entry.path),
        size,
        sha256: digest
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(manifest.map((entry) => entry.path)).size !== manifest.length) {
    throw new TypeError("Duplicate skill import manifest path.");
  }
  const totalBytes = integerInRange(
    source.totalBytes,
    "totalBytes",
    1,
    MAX_TOTAL_BYTES
  );
  if (manifest.reduce((sum, entry) => sum + entry.size, 0) !== totalBytes) {
    throw new TypeError("Skill import totalBytes does not match its manifest.");
  }
  const approvedAt = source.approvedAt == null
    ? null
    : requiredIso(source.approvedAt, "approvedAt");
  const rejectedAt = source.rejectedAt == null
    ? null
    : requiredIso(source.rejectedAt, "rejectedAt");
  if (
    (status === SKILL_IMPORT_STATUSES.APPROVED) !== (approvedAt !== null)
    || (status === SKILL_IMPORT_STATUSES.REJECTED) !== (rejectedAt !== null)
    || (approvedAt && rejectedAt)
  ) {
    throw new TypeError("Skill import status timestamps are inconsistent.");
  }
  const installedPath = source.installedPath == null
    ? null
    : path.resolve(requiredText(source.installedPath, "installedPath", 4096));
  if ((status === SKILL_IMPORT_STATUSES.APPROVED) !== Boolean(installedPath)) {
    throw new TypeError("Approved skill import requires installedPath.");
  }
  return {
    version: 1,
    id: normalizeImportId(source.id),
    projectId: normalizeProjectId(source.projectId),
    projectRevision: positiveInteger(
      source.projectRevision,
      null,
      "projectRevision"
    ),
    kind: normalizeKind(source.kind),
    status,
    revision: positiveInteger(source.revision, null, "revision"),
    skillName: normalizeSkillName(source.skillName),
    description: requiredText(source.description, "description", 1024),
    allowedTools: normalizeAllowedTools(source.allowedTools),
    sourceLabel: requiredText(source.sourceLabel, "sourceLabel", 500),
    sourceHash: normalizeDigest(source.sourceHash),
    manifest,
    totalBytes,
    createdAt: requiredIso(source.createdAt, "createdAt"),
    createdBy: requiredText(source.createdBy, "createdBy", 200),
    updatedAt: requiredIso(source.updatedAt, "updatedAt"),
    updatedBy: requiredText(source.updatedBy, "updatedBy", 200),
    approvedAt,
    approvedBy: approvedAt
      ? requiredText(source.approvedBy, "approvedBy", 200)
      : null,
    rejectedAt,
    rejectedBy: rejectedAt
      ? requiredText(source.rejectedBy, "rejectedBy", 200)
      : null,
    rejectionReason: rejectedAt
      ? requiredText(source.rejectionReason, "rejectionReason", 2000)
      : null,
    installedPath
  };
}

function publicCandidate(candidate) {
  return structuredClone({
    ...candidate,
    // Absolute install paths are operator metadata, not model review data.
    installedPath: candidate.installedPath
      ? path.basename(candidate.installedPath)
      : null
  });
}

function validState(value) {
  try {
    const source = plainRecord(value, "stored skill import state");
    assertOnlyKeys(source, STORED_STATE_FIELDS, "stored skill import state");
    if (
      source.version !== 1
      || !Number.isSafeInteger(source.sequence)
      || source.sequence < 0
      || requiredIso(source.updatedAt, "updatedAt") !== source.updatedAt
    ) {
      return false;
    }
    const candidates = plainArray(
      source.candidates,
      "stored skill imports",
      MAX_CANDIDATES
    );
    const ids = new Set();
    for (const raw of candidates) {
      const candidate = normalizeStoredCandidate(raw);
      if (ids.has(candidate.id)) return false;
      ids.add(candidate.id);
    }
    return true;
  } catch {
    return false;
  }
}

function parseEvent(line) {
  try {
    const event = JSON.parse(line);
    if (
      event?.version !== 1
      || !Number.isSafeInteger(event.sequence)
      || event.sequence < 1
      || typeof event.op !== "string"
      || !EVENT_OP_RE.test(event.op)
      || typeof event.projectId !== "string"
      || typeof event.candidateId !== "string"
      || requiredIso(event.at, "event timestamp") !== event.at
    ) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

function readEventLines(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 32 * 1024 * 1024) {
      throw new RangeError("Skill import event log is too large.");
    }
    return fs.readFileSync(file, "utf8").split(/\r?\n/u);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isUtf8Text(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.includes(0)) return false;
  return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

function normalizeImportId(value) {
  if (typeof value !== "string" || !IMPORT_ID_RE.test(value.trim())) {
    throw new TypeError("Invalid skill import id.");
  }
  return value.trim();
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("projectId must be a string.");
  const id = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid projectId.");
  return id;
}

function normalizeSkillName(value) {
  const name = requiredText(value, "skillName", 64);
  if (!SKILL_NAME_RE.test(name)) throw new TypeError("Invalid skillName.");
  return name;
}

function normalizeAllowedTools(value) {
  const tools = plainArray(value, "allowedTools", 128).map((item) => {
    const name = requiredText(item, "allowed tool", 128);
    if (
      name === "*"
      || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(name)
    ) {
      throw new TypeError("Invalid imported allowed tool.");
    }
    return name;
  });
  return [...new Set(tools)].sort();
}

function normalizeKind(value) {
  const kind = String(value ?? "").trim().toLowerCase();
  if (!Object.values(SKILL_IMPORT_KINDS).includes(kind)) {
    throw new TypeError("kind must be zip or git.");
  }
  return kind;
}

function normalizeDigest(value) {
  const digest = requiredText(value, "sourceHash", 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid sourceHash.");
  return digest;
}

function ensurePrivateDir(dir) {
  ensureDir(dir);
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows */ }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillImportBoundaryError("Skill import storage is not a safe directory.");
  }
}

function ensurePathWithin(candidate, root) {
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  if (
    relative === ""
    || (
      !relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative)
    )
  ) {
    return absolute;
  }
  throw new SkillImportBoundaryError("Skill import path escapes its root.");
}

function removePrivateTree(target, root) {
  const absolute = ensurePathWithin(target, root);
  if (absolute === path.resolve(root)) {
    throw new SkillImportBoundaryError("Refusing to remove the skill import root.");
  }
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(absolute);
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(absolute);
    return;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    removePrivateTree(path.join(absolute, entry.name), root);
  }
  fs.rmdirSync(absolute);
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
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${field}.${key} cannot be an accessor.`);
    }
  }
  return value;
}

function plainArray(value, field, maximum) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  if (value.length > maximum) throw new RangeError(`${field} is too large.`);
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
    if (!allowed.has(key)) throw new TypeError(`${field}.${key} is not supported.`);
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${field} is required.`);
  if (text.length > maxLength) throw new RangeError(`${field} is too long.`);
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${field} contains unsupported control characters.`);
  }
  return text;
}

function optionalText(value, field, maxLength) {
  if (value == null || value === "") return "";
  return requiredText(value, field, maxLength);
}

function requiredIso(value, field) {
  const text = requiredText(value, field, 64);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp.`);
  return date.toISOString();
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean.`);
}

function positiveInteger(value, fallback, field = "value") {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
  return value;
}

function integerInRange(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Revision limit reached.");
  }
  return value + 1;
}

function assertRevision(candidate, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new TypeError("expectedRevision must be a positive integer.");
  }
  if (candidate.revision !== expected) {
    throw new SkillImportRevisionError(
      candidate.id,
      expected,
      candidate.revision
    );
  }
}

function assertProjectRevision(project, candidate) {
  if (
    !Number.isSafeInteger(project?.revision)
    || project.revision !== candidate.projectRevision
  ) {
    throw new SkillImportBoundaryError(
      "The default project changed after this skill import was staged; stage it again before approval.",
      {
        projectId: candidate.projectId,
        stagedProjectRevision: candidate.projectRevision,
        currentProjectRevision: project?.revision ?? null
      }
    );
  }
}

function actor(context) {
  const source = context == null ? {} : plainRecord(context, "actor context");
  return requiredText(
    String(
      source.actor
      ?? source.decidedBy
      ?? source.from
      ?? source.agentId
      ?? "runtime"
    ),
    "actor",
    200
  );
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function waitSynchronously(milliseconds) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

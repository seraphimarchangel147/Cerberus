import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { createId, nowIso } from "./utils.js";

export const ARTIFACT_KINDS = Object.freeze(["markdown", "data"]);

const ARTIFACT_KIND_SET = new Set(ARTIFACT_KINDS);
const ARTIFACT_ID_RE = /^artifact_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const PINNED_REF_RE = /^artifact:(artifact_[a-f0-9]{16})@([1-9][0-9]{0,15})$/;
const MAX_ARTIFACTS = 4096;
const MAX_VERSIONS = 2048;
const MAX_TITLE_CHARS = 512;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_EVENTS_BYTES = 128 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const CREATE_FIELDS = new Set(["content", "kind", "metadata", "projectId", "title"]);
const UPDATE_FIELDS = new Set([
  "content",
  "expectedRevision",
  "metadata",
  "projectId",
  "title"
]);

export class ArtifactCanvasError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ArtifactCanvasError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class ArtifactRevisionError extends ArtifactCanvasError {
  constructor(artifactId, expectedRevision, actualRevision) {
    super(
      "ARTIFACT_REVISION_CONFLICT",
      `Artifact revision conflict for '${artifactId}': expected ${expectedRevision}, found ${actualRevision}.`,
      { artifactId, expectedRevision, actualRevision }
    );
    this.name = "ArtifactRevisionError";
  }
}

export function artifactPinnedRef(id, revision) {
  const artifactId = normalizeArtifactId(id);
  const normalizedRevision = positiveRevision(revision, "revision");
  return `artifact:${artifactId}@${normalizedRevision}`;
}

export function parseArtifactPinnedRef(value) {
  if (typeof value !== "string") return null;
  const match = PINNED_REF_RE.exec(value);
  if (!match) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return Object.freeze({ id: match[1], revision });
}

export class ArtifactCanvasStore {
  constructor(options = {}) {
    const source = plainRecord(options, "ArtifactCanvasStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(source.dir ?? path.join(dataDir, "drafts", "canvas"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.projects = source.projects ?? null;
    this.runtime = source.runtime ?? null;
    this.onEvent = typeof source.onEvent === "function" ? source.onEvent : null;
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.idFactory = typeof source.idFactory === "function"
      ? source.idFactory
      : () => createId("artifact");
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.lockTimeoutMs = boundedPositiveInteger(
      source.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      "lockTimeoutMs"
    );
    this.staleLockMs = boundedPositiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      "staleLockMs"
    );
    this.lockDepth = 0;
    this.artifacts = new Map();
    this.sequence = 0;
    ensureDir(this.dir);
    this._withLock(() => this._restore());
  }

  create(input, context = {}) {
    const source = plainRecord(input, "artifact input");
    assertOnlyKeys(source, CREATE_FIELDS, "artifact input");
    const mutationContext = plainRecord(context, "artifact context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const kind = normalizeKind(source.kind);
    const title = normalizeTitle(source.title);
    const content = normalizeContent(kind, source.content);
    const metadata = normalizeMetadata(source.metadata);
    const actor = normalizeActor(mutationContext.actor);
    this._authorizeProject(projectId);

    let notice;
    let result;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      if (this.artifacts.size >= MAX_ARTIFACTS) {
        throw new RangeError(`Artifact limit reached (${MAX_ARTIFACTS}).`);
      }
      const id = this._allocateId(projectId);
      let attached = false;
      try {
        this.projects?.attachResource?.(
          projectId,
          "artifactIds",
          id,
          { actor }
        );
        attached = Boolean(this.projects?.attachResource);
        const at = this._now();
        const revision = {
          revision: 1,
          title,
          content,
          metadata,
          createdAt: at,
          createdBy: actor,
          restoredFromRevision: null
        };
        const artifact = {
          id,
          projectId,
          kind,
          createdAt: at,
          createdBy: actor,
          revisions: [revision]
        };
        const event = this._commit("create", artifact, revision);
        result = this._view(artifact, revision);
        notice = metadataNotice("artifact-created", event, artifact, revision);
      } catch (error) {
        if (attached) {
          try {
            this.projects?.detachResource?.(
              projectId,
              "artifactIds",
              id,
              { actor: "artifact:create:rollback" }
            );
          } catch {
            // A dangling non-secret reference is safer than a hidden artifact.
          }
        }
        throw error;
      }
    });
    this._notify(notice);
    return result;
  }

  list(options = {}) {
    const source = plainRecord(options, "artifact list options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const kind = source.kind == null ? null : normalizeKind(source.kind);
    const limit = boundedListLimit(source.limit);
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    return [...this.artifacts.values()]
      .filter((artifact) => (
        artifact.projectId === projectId
        && (kind == null || artifact.kind === kind)
      ))
      .map((artifact) => {
        const head = artifact.revisions.at(-1);
        return this._summary(artifact, head);
      })
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit);
  }

  get(id, options = {}) {
    const artifactId = normalizeArtifactId(id);
    const source = plainRecord(options, "artifact get options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const revision = source.revision == null
      ? null
      : positiveRevision(source.revision, "revision");
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    const artifact = this._requireArtifact(artifactId, projectId);
    const selected = revision == null
      ? artifact.revisions.at(-1)
      : artifact.revisions.find((item) => item.revision === revision);
    if (!selected) {
      throw new ArtifactCanvasError(
        "ARTIFACT_REVISION_NOT_FOUND",
        "Unknown artifact revision.",
        { artifactId, revision }
      );
    }
    return this._view(artifact, selected);
  }

  update(id, patch, context = {}) {
    const artifactId = normalizeArtifactId(id);
    const source = plainRecord(patch, "artifact update");
    assertOnlyKeys(source, UPDATE_FIELDS, "artifact update");
    const mutationContext = plainRecord(context, "artifact context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const expectedRevision = positiveRevision(
      source.expectedRevision,
      "expectedRevision"
    );
    if (
      !Object.hasOwn(source, "title")
      && !Object.hasOwn(source, "content")
      && !Object.hasOwn(source, "metadata")
    ) {
      throw new TypeError("Artifact update requires title, content, or metadata.");
    }
    const actor = normalizeActor(mutationContext.actor);
    this._authorizeProject(projectId);

    let notice;
    let result;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const artifact = this._requireArtifact(artifactId, projectId);
      const head = artifact.revisions.at(-1);
      assertExpectedRevision(artifactId, expectedRevision, head.revision);
      if (artifact.revisions.length >= MAX_VERSIONS) {
        throw new RangeError(`Artifact version limit reached (${MAX_VERSIONS}).`);
      }
      const revision = {
        revision: head.revision + 1,
        title: Object.hasOwn(source, "title")
          ? normalizeTitle(source.title)
          : head.title,
        content: Object.hasOwn(source, "content")
          ? normalizeContent(artifact.kind, source.content)
          : structuredClone(head.content),
        metadata: Object.hasOwn(source, "metadata")
          ? normalizeMetadata(source.metadata)
          : structuredClone(head.metadata),
        createdAt: this._now(),
        createdBy: actor,
        restoredFromRevision: null
      };
      const event = this._commit("update", artifact, revision);
      result = this._view(artifact, revision);
      notice = metadataNotice("artifact-updated", event, artifact, revision);
    });
    this._notify(notice);
    return result;
  }

  versions(id, options = {}) {
    const artifactId = normalizeArtifactId(id);
    const source = plainRecord(options, "artifact versions options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const limit = boundedListLimit(source.limit);
    const includeContent = source.includeContent === true;
    if (
      source.includeContent !== undefined
      && typeof source.includeContent !== "boolean"
    ) {
      throw new TypeError("includeContent must be a boolean.");
    }
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    const artifact = this._requireArtifact(artifactId, projectId);
    return artifact.revisions
      .slice()
      .reverse()
      .slice(0, limit)
      .map((revision) => ({
        id: artifact.id,
        projectId: artifact.projectId,
        kind: artifact.kind,
        revision: revision.revision,
        title: revision.title,
        pinnedRef: artifactPinnedRef(artifact.id, revision.revision),
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
        restoredFromRevision: revision.restoredFromRevision,
        ...(includeContent
          ? {
              content: structuredClone(revision.content),
              metadata: structuredClone(revision.metadata)
            }
          : {})
      }));
  }

  restore(id, targetRevision, options = {}) {
    const artifactId = normalizeArtifactId(id);
    const source = plainRecord(options, "artifact restore options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const selectedRevision = positiveRevision(targetRevision, "revision");
    const expectedRevision = positiveRevision(
      source.expectedRevision,
      "expectedRevision"
    );
    const actor = normalizeActor(source.actor);
    this._authorizeProject(projectId);

    let notice;
    let result;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const artifact = this._requireArtifact(artifactId, projectId);
      const head = artifact.revisions.at(-1);
      assertExpectedRevision(artifactId, expectedRevision, head.revision);
      const selected = artifact.revisions.find(
        (revision) => revision.revision === selectedRevision
      );
      if (!selected) {
        throw new ArtifactCanvasError(
          "ARTIFACT_REVISION_NOT_FOUND",
          "Unknown artifact revision.",
          { artifactId, revision: selectedRevision }
        );
      }
      if (artifact.revisions.length >= MAX_VERSIONS) {
        throw new RangeError(`Artifact version limit reached (${MAX_VERSIONS}).`);
      }
      const revision = {
        revision: head.revision + 1,
        title: selected.title,
        content: structuredClone(selected.content),
        metadata: structuredClone(selected.metadata),
        createdAt: this._now(),
        createdBy: actor,
        restoredFromRevision: selected.revision
      };
      const event = this._commit("restore", artifact, revision);
      result = this._view(artifact, revision);
      notice = metadataNotice(
        "artifact-restored",
        event,
        artifact,
        revision
      );
    });
    this._notify(notice);
    return result;
  }

  resolvePinnedRef(ref, context = {}) {
    const parsed = parseArtifactPinnedRef(ref);
    if (!parsed) {
      throw new TypeError("Pinned artifact reference is invalid.");
    }
    const source = plainRecord(context, "artifact reference context");
    return this.get(parsed.id, {
      projectId: source.projectId ?? "default",
      revision: parsed.revision
    });
  }

  health() {
    this._refresh();
    return {
      ok: true,
      artifacts: this.artifacts.size,
      revisions: [...this.artifacts.values()].reduce(
        (total, artifact) => total + artifact.revisions.length,
        0
      ),
      sequence: this.sequence,
      dir: this.dir
    };
  }

  _allocateId(projectId) {
    const project = this.projects?.authorize?.(projectId, {
      includeArchived: false
    });
    const reserved = new Set(project?.artifactIds ?? []);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = normalizeArtifactId(this.idFactory());
      if (!this.artifacts.has(id) && !reserved.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique artifact id.");
  }

  _authorizeProject(projectId) {
    if (!this.projects) {
      if (projectId === "default") return { id: projectId };
      throw new ArtifactCanvasError(
        "PROJECT_BOUNDARY_VIOLATION",
        "Project-scoped artifacts require a project store."
      );
    }
    const project = typeof this.projects.authorize === "function"
      ? this.projects.authorize(projectId, { includeArchived: false })
      : this.projects.get?.(projectId, { includeArchived: false });
    if (!project) {
      throw new ArtifactCanvasError(
        "PROJECT_BOUNDARY_VIOLATION",
        "Unknown or archived project.",
        { projectId }
      );
    }
    return project;
  }

  _requireArtifact(id, projectId) {
    const artifact = this.artifacts.get(id);
    if (!artifact || artifact.projectId !== projectId) {
      throw new ArtifactCanvasError(
        "ARTIFACT_NOT_FOUND",
        "Unknown artifact.",
        { artifactId: id }
      );
    }
    return artifact;
  }

  _summary(artifact, revision) {
    return {
      id: artifact.id,
      projectId: artifact.projectId,
      kind: artifact.kind,
      title: revision.title,
      revision: revision.revision,
      pinnedRef: artifactPinnedRef(artifact.id, revision.revision),
      createdAt: artifact.createdAt,
      updatedAt: revision.createdAt
    };
  }

  _view(artifact, revision) {
    return {
      ...this._summary(artifact, revision),
      createdBy: artifact.createdBy,
      updatedBy: revision.createdBy,
      restoredFromRevision: revision.restoredFromRevision,
      content: structuredClone(revision.content),
      metadata: structuredClone(revision.metadata)
    };
  }

  _commit(op, artifact, revision) {
    const event = {
      version: 1,
      sequence: this.sequence + 1,
      op,
      at: revision.createdAt,
      artifactId: artifact.id,
      projectId: artifact.projectId,
      kind: artifact.kind,
      ...(op === "create"
        ? {
            artifact: {
              id: artifact.id,
              projectId: artifact.projectId,
              kind: artifact.kind,
              createdAt: artifact.createdAt,
              createdBy: artifact.createdBy
            }
          }
        : {}),
      revision: structuredClone(revision)
    };
    if (jsonBytes(event) > MAX_EVENT_LINE_BYTES) {
      throw new RangeError("Artifact revision exceeds its persistence bound.");
    }
    let state;
    try {
      this._applyEvent(event);
      state = this._state();
    } catch (error) {
      this._restore();
      throw error;
    }
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      this._restore();
      throw error;
    }
    try {
      this.writeSnapshot(this.snapshotPath, state);
    } catch (error) {
      console.warn(
        `[artifact-canvas] snapshot refresh failed: ${error?.message ?? error}`
      );
    }
    return event;
  }

  _state() {
    const state = {
      version: 1,
      sequence: this.sequence,
      updatedAt: this._now(),
      artifacts: [...this.artifacts.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((artifact) => structuredClone(artifact))
    };
    if (jsonBytes(state) > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("Artifact Canvas snapshot exceeds its size bound.");
    }
    return state;
  }

  _refresh() {
    this._withLock(() => this._restore());
  }

  _restore() {
    this.artifacts = new Map();
    this.sequence = 0;
    this._loadSnapshot();
    this._replayEvents();
  }

  _loadSnapshot() {
    let snapshot;
    try {
      const stat = fs.lstatSync(this.snapshotPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      if (stat.size > MAX_SNAPSHOT_BYTES) return;
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      return;
    }
    try {
      this._applyState(normalizeStoredState(snapshot));
    } catch {
      // The JSONL ledger remains authoritative when a snapshot is corrupt.
    }
  }

  _replayEvents() {
    let text;
    try {
      const stat = fs.lstatSync(this.eventsPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      if (stat.size > MAX_EVENTS_BYTES) {
        throw new RangeError("Artifact event ledger exceeds its replay bound.");
      }
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const line of text.split(/\r?\n/u)) {
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) continue;
      let event;
      try {
        event = normalizeStoredEvent(JSON.parse(line));
      } catch {
        continue;
      }
      if (event.sequence <= this.sequence) continue;
      if (event.sequence !== this.sequence + 1) break;
      try {
        this._applyEvent(event);
      } catch {
        break;
      }
    }
  }

  _applyState(state) {
    const artifacts = new Map();
    for (const artifact of state.artifacts) {
      artifacts.set(artifact.id, artifact);
    }
    this.artifacts = artifacts;
    this.sequence = state.sequence;
  }

  _applyEvent(event) {
    if (event.sequence !== this.sequence + 1) {
      throw new ArtifactCanvasError(
        "ARTIFACT_EVENT_SEQUENCE_GAP",
        "Artifact event sequence is discontinuous."
      );
    }
    if (event.op === "create") {
      if (this.artifacts.has(event.artifactId)) {
        throw new ArtifactCanvasError(
          "ARTIFACT_EVENT_CONFLICT",
          "Artifact create event collides with an existing artifact."
        );
      }
      this.artifacts.set(event.artifactId, {
        ...structuredClone(event.artifact),
        revisions: [structuredClone(event.revision)]
      });
    } else {
      const artifact = this.artifacts.get(event.artifactId);
      const head = artifact?.revisions.at(-1);
      if (
        !artifact
        || artifact.projectId !== event.projectId
        || artifact.kind !== event.kind
        || event.revision.revision !== head.revision + 1
      ) {
        throw new ArtifactCanvasError(
          "ARTIFACT_EVENT_CONFLICT",
          "Artifact revision event is inconsistent."
        );
      }
      artifact.revisions.push(structuredClone(event.revision));
    }
    this.sequence = event.sequence;
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
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let descriptor;
      try {
        descriptor = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, token, "utf8");
        fs.fsyncSync(descriptor);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* best effort */ }
            descriptor = undefined;
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new ArtifactCanvasError(
            "ARTIFACT_STORE_BUSY",
            "Artifact Canvas is busy."
          );
        }
        waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try {
          if (descriptor !== undefined) fs.closeSync(descriptor);
        } catch {
          // Best effort.
        }
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
    let owner;
    try {
      owner = JSON.parse(content);
    } catch {
      owner = null;
    }
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
      // Never remove a lock whose ownership cannot be verified.
    }
  }

  _notify(notice) {
    if (!notice) return;
    const { type, ...payload } = notice;
    try {
      this.onEvent?.(structuredClone(notice));
    } catch {
      // Persistence is authoritative; observers are advisory.
    }
    try {
      this.runtime?.events?.emit?.(type, structuredClone(payload));
    } catch {
      // Persistence is authoritative; observers are advisory.
    }
  }

  _now() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
  }
}

function metadataNotice(type, event, artifact, revision) {
  return {
    type,
    projectId: artifact.projectId,
    artifactId: artifact.id,
    revision: revision.revision,
    kind: artifact.kind,
    operation: event.op,
    at: event.at,
    ...(revision.restoredFromRevision == null
      ? {}
      : { restoredFromRevision: revision.restoredFromRevision })
  };
}

function normalizeStoredState(value) {
  const source = plainRecord(value, "stored artifact state");
  if (
    source.version !== 1
    || !Number.isSafeInteger(source.sequence)
    || source.sequence < 0
    || !Array.isArray(source.artifacts)
    || source.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new TypeError("Stored artifact state is invalid.");
  }
  const artifacts = source.artifacts.map(normalizeStoredArtifact);
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
    throw new TypeError("Stored artifact ids are not unique.");
  }
  return { version: 1, sequence: source.sequence, artifacts };
}

function normalizeStoredEvent(value) {
  const source = plainRecord(value, "stored artifact event");
  if (
    source.version !== 1
    || !Number.isSafeInteger(source.sequence)
    || source.sequence < 1
    || !["create", "update", "restore"].includes(source.op)
  ) {
    throw new TypeError("Stored artifact event is invalid.");
  }
  const artifactId = normalizeArtifactId(source.artifactId);
  const projectId = normalizeProjectId(source.projectId);
  const kind = normalizeKind(source.kind);
  const revision = normalizeStoredRevision(source.revision);
  const at = requiredIso(source.at, "event timestamp");
  const artifact = source.op === "create"
    ? normalizeStoredArtifact({
        ...plainRecord(source.artifact, "stored artifact identity"),
        revisions: [revision]
      })
    : null;
  if (
    (source.op === "create" && revision.revision !== 1)
    || revision.createdAt !== at
    || (source.op === "restore") !== (revision.restoredFromRevision != null)
    || (artifact && (
      artifact.id !== artifactId
      || artifact.projectId !== projectId
      || artifact.kind !== kind
    ))
  ) {
    throw new TypeError("Stored artifact event identity is inconsistent.");
  }
  return {
    version: 1,
    sequence: source.sequence,
    op: source.op,
    at,
    artifactId,
    projectId,
    kind,
    ...(artifact
      ? {
          artifact: {
            id: artifact.id,
            projectId: artifact.projectId,
            kind: artifact.kind,
            createdAt: artifact.createdAt,
            createdBy: artifact.createdBy
          }
        }
      : {}),
    revision
  };
}

function normalizeStoredArtifact(value) {
  const source = plainRecord(value, "stored artifact");
  const id = normalizeArtifactId(source.id);
  const projectId = normalizeProjectId(source.projectId);
  const kind = normalizeKind(source.kind);
  const revisions = Array.isArray(source.revisions)
    ? source.revisions.map(normalizeStoredRevision)
    : [];
  if (
    revisions.length < 1
    || revisions.length > MAX_VERSIONS
    || revisions.some((revision, index) => revision.revision !== index + 1)
  ) {
    throw new TypeError("Stored artifact revisions are invalid.");
  }
  if (
    kind === "markdown"
    && revisions.some((revision) => typeof revision.content !== "string")
  ) {
    throw new TypeError("Stored Markdown artifact content is invalid.");
  }
  const createdAt = requiredIso(source.createdAt, "artifact createdAt");
  if (revisions[0].createdAt !== createdAt) {
    throw new TypeError("Stored artifact creation timestamp is inconsistent.");
  }
  return {
    id,
    projectId,
    kind,
    createdAt,
    createdBy: normalizeActor(source.createdBy),
    revisions
  };
}

function normalizeStoredRevision(value) {
  const source = plainRecord(value, "stored artifact revision");
  return {
    revision: positiveRevision(source.revision, "revision"),
    title: normalizeTitle(source.title),
    content: normalizeStoredContent(source.content),
    metadata: normalizeMetadata(source.metadata),
    createdAt: requiredIso(source.createdAt, "revision createdAt"),
    createdBy: normalizeActor(source.createdBy),
    restoredFromRevision: source.restoredFromRevision == null
      ? null
      : positiveRevision(source.restoredFromRevision, "restoredFromRevision")
  };
}

function normalizeStoredContent(value) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) {
      throw new RangeError("Artifact content exceeds its size bound.");
    }
    return value;
  }
  const normalized = normalizeJsonValue(value, {
    maxBytes: MAX_CONTENT_BYTES,
    label: "artifact content"
  });
  return normalized;
}

function normalizeContent(kind, value) {
  if (kind === "markdown") {
    if (typeof value !== "string") {
      throw new TypeError("Markdown artifact content must be a string.");
    }
    if (Buffer.byteLength(value, "utf8") > MAX_CONTENT_BYTES) {
      throw new RangeError("Artifact content exceeds its size bound.");
    }
    return value;
  }
  return normalizeJsonValue(value, {
    maxBytes: MAX_CONTENT_BYTES,
    label: "artifact content"
  });
}

function normalizeMetadata(value) {
  if (value == null) return {};
  const source = plainRecord(value, "artifact metadata");
  return normalizeJsonValue(source, {
    maxBytes: MAX_METADATA_BYTES,
    label: "artifact metadata"
  });
}

function normalizeJsonValue(value, options) {
  const state = { nodes: 0, ancestors: new Set() };
  const normalized = normalizeJsonNode(value, 0, state, options.label);
  if (jsonBytes(normalized) > options.maxBytes) {
    throw new RangeError(`${options.label} exceeds its size bound.`);
  }
  return normalized;
}

function normalizeJsonNode(value, depth, state, label) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new RangeError(`${label} exceeds its structure bound.`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} numbers must be finite.`);
    }
    return value;
  }
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be JSON-compatible.`);
  }
  if (state.ancestors.has(value)) {
    throw new TypeError(`${label} cannot be cyclic.`);
  }
  state.ancestors.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((item) => (
      normalizeJsonNode(item, depth + 1, state, label)
    ));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} objects must be plain.`);
    }
    normalized = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value)
    )) {
      if (!Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label} cannot contain accessors.`);
      }
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError(`${label} contains an unsafe key.`);
      }
      Object.defineProperty(normalized, key, {
        value: normalizeJsonNode(descriptor.value, depth + 1, state, label),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  state.ancestors.delete(value);
  return normalized;
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value"))) {
    throw new TypeError(`${label} cannot contain accessors.`);
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  );
}

function assertOnlyKeys(value, allowed, label) {
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new TypeError(`${label} contains unsupported field '${unsupported}'.`);
}

function normalizeArtifactId(value) {
  if (typeof value !== "string" || !ARTIFACT_ID_RE.test(value)) {
    throw new TypeError("Artifact id is invalid.");
  }
  return value;
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("projectId must be a string.");
  const id = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("projectId is invalid.");
  return id;
}

function normalizeKind(value) {
  if (typeof value !== "string" || !ARTIFACT_KIND_SET.has(value)) {
    throw new TypeError("Artifact kind must be 'markdown' or 'data'.");
  }
  return value;
}

function normalizeTitle(value) {
  if (typeof value !== "string") throw new TypeError("Artifact title must be a string.");
  const title = value.trim();
  if (
    title.length < 1
    || title.length > MAX_TITLE_CHARS
    || /[\u0000-\u001f\u007f]/u.test(title)
  ) {
    throw new TypeError("Artifact title is invalid.");
  }
  return title;
}

function normalizeActor(value) {
  if (value == null || value === "") return "runtime";
  if (typeof value !== "string") throw new TypeError("Artifact actor must be a string.");
  const actor = value.trim();
  if (
    actor.length < 1
    || actor.length > 128
    || /[^\x20-\x7e]/u.test(actor)
  ) {
    throw new TypeError("Artifact actor is invalid.");
  }
  return actor;
}

function positiveRevision(value, label) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return revision;
}

function assertExpectedRevision(id, expected, actual) {
  if (expected !== actual) throw new ArtifactRevisionError(id, expected, actual);
}

function boundedListLimit(value) {
  if (value == null) return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Artifact list limit must be an integer from 1 to 100.");
  }
  return limit;
}

function boundedPositiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 600_000) {
    throw new TypeError(`${label} must be a positive bounded integer.`);
  }
  return number;
}

function requiredIso(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function waitSynchronously(ms) {
  try {
    Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Bounded fallback for runtimes without Atomics.wait.
    }
  }
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

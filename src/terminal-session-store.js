import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  appendJsonLine,
  ensureDir,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

const SNAPSHOT_VERSION = 1;
const RECORD_VERSION = 1;
const EVENT_VERSION = 1;
const DEFAULT_MAX_ACTIVE_GLOBAL = 3;
const DEFAULT_MAX_ACTIVE_PER_PROJECT = 1;
const DEFAULT_MAX_RECORDS = 1_000;
const DEFAULT_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_COMPACT_AT_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SESSION_ID_RE = /^terminal_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const OWNER_SESSION_RE = /^[\x20-\x7e]{1,512}$/;
const CONTAINER_RE = /^openagi-term-[a-f0-9]{8}-[a-f0-9]{16}$/;
const SHA256_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,511}@sha256:[a-f0-9]{64}$/;

export const TERMINAL_SESSION_STATUSES = Object.freeze({
  STARTING: "starting",
  RUNNING: "running",
  CLOSING: "closing",
  CLOSED: "closed",
  EXITED: "exited",
  INTERRUPTED: "interrupted",
  ORPHANED: "orphaned",
  FAILED: "failed"
});

const ACTIVE_STATUSES = new Set([
  TERMINAL_SESSION_STATUSES.STARTING,
  TERMINAL_SESSION_STATUSES.RUNNING,
  TERMINAL_SESSION_STATUSES.CLOSING
]);
const FINAL_STATUSES = new Set([
  TERMINAL_SESSION_STATUSES.CLOSED,
  TERMINAL_SESSION_STATUSES.EXITED,
  TERMINAL_SESSION_STATUSES.INTERRUPTED,
  TERMINAL_SESSION_STATUSES.ORPHANED,
  TERMINAL_SESSION_STATUSES.FAILED
]);
const ALLOWED_TRANSITIONS = new Map([
  [TERMINAL_SESSION_STATUSES.STARTING, new Set([
    TERMINAL_SESSION_STATUSES.RUNNING,
    ...FINAL_STATUSES
  ])],
  [TERMINAL_SESSION_STATUSES.RUNNING, new Set([
    TERMINAL_SESSION_STATUSES.CLOSING,
    ...FINAL_STATUSES
  ])],
  [TERMINAL_SESSION_STATUSES.CLOSING, new Set(FINAL_STATUSES)]
]);
const RECORD_FIELDS = new Set([
  "version",
  "id",
  "revision",
  "sequence",
  "status",
  "projectId",
  "sessionId",
  "projectRevision",
  "profileIdentity",
  "containerName",
  "imageDigest",
  "cwd",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "lastActivityAt",
  "lastCommandAt",
  "commandCount",
  "inputBytes",
  "outputBytes",
  "droppedOutputBytes",
  "exitCode",
  "reason"
]);

export class TerminalSessionStoreError extends Error {
  constructor(message, code = "TERMINAL_STORE_ERROR", options = {}) {
    super(message, options);
    this.name = "TerminalSessionStoreError";
    this.code = code;
  }
}

export class TerminalSessionConflictError extends TerminalSessionStoreError {
  constructor(message) {
    super(message, "TERMINAL_SESSION_CONFLICT");
    this.name = "TerminalSessionConflictError";
  }
}

export class TerminalSessionLeaseError extends TerminalSessionStoreError {
  constructor(message) {
    super(message, "TERMINAL_SESSION_LEASE_UNAVAILABLE");
    this.name = "TerminalSessionLeaseError";
  }
}

export class TerminalSessionStore {
  constructor(options = {}) {
    const dataDir = path.resolve(options.dataDir ?? resolveDataDir());
    this.dir = path.resolve(options.dir ?? path.join(dataDir, "terminal-sessions"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.managerLeasePath = path.join(this.dir, ".manager.lock");
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === "function"
      ? options.idFactory
      : () => `terminal_${crypto.randomBytes(8).toString("hex")}`;
    this.appendEvent = typeof options.appendEvent === "function"
      ? options.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof options.writeSnapshot === "function"
      ? options.writeSnapshot
      : writeJsonAtomic;
    this.compactJournal = typeof options.compactJournal === "function"
      ? options.compactJournal
      : (filePath) => writeTextAtomic(filePath, "");
    this.maxActiveGlobal = integerInRange(
      options.maxActiveGlobal,
      DEFAULT_MAX_ACTIVE_GLOBAL,
      1,
      32
    );
    this.maxActivePerProject = integerInRange(
      options.maxActivePerProject,
      DEFAULT_MAX_ACTIVE_PER_PROJECT,
      1,
      this.maxActiveGlobal
    );
    this.maxRecords = integerInRange(options.maxRecords, DEFAULT_MAX_RECORDS, 16, 10_000);
    this.maxReplayBytes = integerInRange(
      options.maxReplayBytes,
      DEFAULT_MAX_REPLAY_BYTES,
      1024,
      128 * 1024 * 1024
    );
    this.maxEventBytes = integerInRange(
      options.maxEventBytes,
      Math.min(DEFAULT_MAX_EVENT_BYTES, this.maxReplayBytes),
      1024,
      Math.min(1024 * 1024, this.maxReplayBytes)
    );
    this.compactAtBytes = integerInRange(
      options.compactAtBytes,
      Math.min(
        DEFAULT_COMPACT_AT_BYTES,
        Math.max(1, this.maxReplayBytes - this.maxEventBytes)
      ),
      1,
      this.maxReplayBytes
    );
    this.lockTimeoutMs = integerInRange(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      100,
      60_000
    );
    this.staleLockMs = integerInRange(
      options.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      1_000,
      10 * 60_000
    );
    this.records = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.lockDepth = 0;
    this.managerLease = null;

    ensureDir(this.dir);
    assertDirectoryNotLink(this.dir);
    this._withLock(() => this._restore());
  }

  start(input = {}) {
    return this._mutate(() => {
      this._pruneLoaded();
      const active = [...this.records.values()].filter((record) => (
        ACTIVE_STATUSES.has(record.status)
      ));
      if (active.length >= this.maxActiveGlobal) {
        throw new TerminalSessionConflictError(
          `Terminal session limit reached (${this.maxActiveGlobal}).`
        );
      }
      const projectId = normalizeProjectId(input.projectId);
      const projectActive = active.filter((record) => record.projectId === projectId);
      if (projectActive.length >= this.maxActivePerProject) {
        throw new TerminalSessionConflictError(
          `Project terminal session limit reached (${this.maxActivePerProject}).`
        );
      }
      if (this.records.size >= this.maxRecords) {
        throw new TerminalSessionConflictError(
          `Terminal history limit reached (${this.maxRecords}).`
        );
      }

      const at = this._timestamp();
      const id = normalizeTerminalId(input.id ?? this.idFactory());
      if (this.records.has(id)) {
        throw new TerminalSessionConflictError(`Terminal session '${id}' already exists.`);
      }
      const record = normalizeRecord({
        version: RECORD_VERSION,
        id,
        revision: 1,
        sequence: this.sequence + 1,
        status: TERMINAL_SESSION_STATUSES.STARTING,
        projectId,
        sessionId: normalizeOwnerSessionId(input.sessionId),
        projectRevision: positiveInteger(input.projectRevision, "projectRevision"),
        profileIdentity: normalizeProfileIdentity(input.profileIdentity),
        containerName: normalizeContainerName(input.containerName),
        imageDigest: normalizeImageDigest(input.imageDigest),
        cwd: normalizeRelativeCwd(input.cwd),
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        lastActivityAt: at,
        lastCommandAt: null,
        commandCount: 0,
        inputBytes: 0,
        outputBytes: 0,
        droppedOutputBytes: 0,
        exitCode: null,
        reason: null
      });
      this._commit("create", record);
      return viewRecord(record);
    });
  }

  markRunning(id, options = {}) {
    return this._transition(id, TERMINAL_SESSION_STATUSES.RUNNING, {
      ...options,
      startedAt: options.startedAt ?? this._timestamp(),
      reason: null
    });
  }

  markClosing(id, options = {}) {
    return this._transition(id, TERMINAL_SESSION_STATUSES.CLOSING, options);
  }

  markFinal(id, status, options = {}) {
    if (!FINAL_STATUSES.has(status)) {
      throw new TypeError("Terminal final status is invalid.");
    }
    return this._transition(id, status, {
      ...options,
      finishedAt: options.finishedAt ?? this._timestamp()
    });
  }

  recordActivity(id, patch = {}, options = {}) {
    return this._mutate(() => {
      const current = this._requireLoaded(id);
      assertExpectedRevision(current, options.expectedRevision);
      if (!ACTIVE_STATUSES.has(current.status)) {
        throw new TerminalSessionConflictError(
          `Terminal session '${current.id}' is not active.`
        );
      }
      const at = this._timestamp();
      const commandDelta = boundedCounterDelta(patch.commandCount, "commandCount");
      const inputDelta = boundedCounterDelta(patch.inputBytes, "inputBytes");
      const outputDelta = boundedCounterDelta(patch.outputBytes, "outputBytes");
      const droppedDelta = boundedCounterDelta(
        patch.droppedOutputBytes,
        "droppedOutputBytes"
      );
      const next = normalizeRecord({
        ...current,
        revision: current.revision + 1,
        sequence: this.sequence + 1,
        updatedAt: at,
        lastActivityAt: at,
        lastCommandAt: commandDelta > 0
          ? normalizeTimestamp(patch.lastCommandAt ?? at, "lastCommandAt")
          : current.lastCommandAt,
        commandCount: safeCounterAdd(current.commandCount, commandDelta),
        inputBytes: safeCounterAdd(current.inputBytes, inputDelta),
        outputBytes: safeCounterAdd(current.outputBytes, outputDelta),
        droppedOutputBytes: safeCounterAdd(
          current.droppedOutputBytes,
          droppedDelta
        )
      });
      this._commit("activity", next);
      return viewRecord(next);
    });
  }

  get(id, scope = {}) {
    return this._readFresh(() => {
      const record = this.records.get(normalizeTerminalId(id)) ?? null;
      if (!record || !matchesScope(record, scope)) return null;
      return viewRecord(record);
    });
  }

  list({
    projectId,
    sessionId,
    includeFinished = false,
    limit = 50
  } = {}) {
    const wantedProject = projectId == null ? null : normalizeProjectId(projectId);
    const wantedSession = sessionId == null ? null : normalizeOwnerSessionId(sessionId);
    const boundedLimit = integerInRange(limit, 50, 1, 200);
    return this._readFresh(() => [...this.records.values()]
      .filter((record) => wantedProject == null || record.projectId === wantedProject)
      .filter((record) => wantedSession == null || record.sessionId === wantedSession)
      .filter((record) => includeFinished || ACTIVE_STATUSES.has(record.status))
      .sort((left, right) => (
        right.sequence - left.sequence || right.id.localeCompare(left.id)
      ))
      .slice(0, boundedLimit)
      .map(viewRecord));
  }

  listActive() {
    return this._readFresh(() => [...this.records.values()]
      .filter((record) => ACTIVE_STATUSES.has(record.status))
      .sort((left, right) => left.sequence - right.sequence)
      .map(viewRecord));
  }

  acquireManagerLease({ ownerId, pid = process.pid } = {}) {
    if (this.managerLease) return this.managerLease.public;
    const owner = normalizeLeaseOwner(ownerId ?? crypto.randomUUID());
    const processId = positiveInteger(pid, "pid");
    const token = {
      version: 1,
      ownerId: owner,
      pid: processId,
      createdAt: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex")
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let fd;
      try {
        fd = fs.openSync(this.managerLeasePath, "wx", 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(token)}\n`, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        const release = () => this.releaseManagerLease(owner);
        const publicLease = Object.freeze({ ownerId: owner, release });
        this.managerLease = { token, public: publicLease };
        return publicLease;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
        }
        if (error?.code !== "EEXIST") throw error;
        if (!this._removeStaleManagerLease()) {
          throw new TerminalSessionLeaseError(
            "Another runtime owns the persistent terminal manager lease."
          );
        }
      }
    }
    throw new TerminalSessionLeaseError(
      "Persistent terminal manager lease could not be acquired."
    );
  }

  releaseManagerLease(ownerId = null) {
    const lease = this.managerLease;
    if (!lease) return false;
    if (ownerId != null && normalizeLeaseOwner(ownerId) !== lease.token.ownerId) {
      return false;
    }
    try {
      const current = readLeaseFile(this.managerLeasePath);
      if (
        current
        && current.ownerId === lease.token.ownerId
        && current.nonce === lease.token.nonce
      ) {
        fs.unlinkSync(this.managerLeasePath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      this.managerLease = null;
    }
    return true;
  }

  close() {
    this.releaseManagerLease();
  }

  _transition(id, status, options = {}) {
    return this._mutate(() => {
      const current = this._requireLoaded(id);
      assertExpectedRevision(current, options.expectedRevision);
      if (current.status === status) return viewRecord(current);
      const allowed = ALLOWED_TRANSITIONS.get(current.status);
      if (!allowed?.has(status)) {
        throw new TerminalSessionConflictError(
          `Terminal session '${current.id}' cannot transition from ${current.status} to ${status}.`
        );
      }
      const at = this._timestamp();
      const next = normalizeRecord({
        ...current,
        revision: current.revision + 1,
        sequence: this.sequence + 1,
        status,
        updatedAt: at,
        startedAt: options.startedAt === undefined
          ? current.startedAt
          : normalizeOptionalTimestamp(options.startedAt, "startedAt"),
        finishedAt: options.finishedAt === undefined
          ? current.finishedAt
          : normalizeOptionalTimestamp(options.finishedAt, "finishedAt"),
        lastActivityAt: at,
        exitCode: options.exitCode === undefined
          ? current.exitCode
          : normalizeExitCode(options.exitCode),
        reason: options.reason === undefined
          ? current.reason
          : normalizeReason(options.reason)
      });
      this._commit("transition", next);
      return viewRecord(next);
    });
  }

  _pruneLoaded() {
    if (this.records.size < this.maxRecords) return;
    const removable = [...this.records.values()]
      .filter((record) => FINAL_STATUSES.has(record.status))
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, Math.max(1, this.records.size - this.maxRecords + 1))
      .map((record) => record.id);
    if (removable.length === 0) return;
    const event = normalizeEvent({
      version: EVENT_VERSION,
      sequence: this.sequence + 1,
      op: "prune",
      at: this._timestamp(),
      ids: removable
    });
    this._appendAndApply(event);
  }

  _commit(op, state) {
    const event = normalizeEvent({
      version: EVENT_VERSION,
      sequence: this.sequence + 1,
      op,
      at: this._timestamp(),
      id: state.id,
      state
    });
    this._appendAndApply(event);
  }

  _appendAndApply(event) {
    this._assertHealthy();
    const serialized = `${JSON.stringify(event)}\n`;
    const eventBytes = Buffer.byteLength(serialized, "utf8");
    if (eventBytes > this.maxEventBytes) {
      throw new RangeError("Terminal session event exceeds the persistence limit.");
    }
    this._ensureJournalCapacity(eventBytes);
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (cause) {
      this._restore();
      this._assertHealthy();
      const reconciled = event.op === "prune"
        ? event.ids.every((id) => !this.records.has(id))
          && this.sequence >= event.sequence
        : this.records.get(event.id)?.revision === event.state.revision
          && this.sequence >= event.sequence;
      if (!reconciled) {
        throw new TerminalSessionStoreError(
          "Terminal session event could not be persisted.",
          "TERMINAL_EVENT_APPEND_FAILED",
          { cause }
        );
      }
      return;
    }
    this._applyEvent(event);
    let snapshotWritten = false;
    try {
      this.writeSnapshot(this.snapshotPath, this._snapshotValue());
      snapshotWritten = true;
    } catch {
      // JSONL is authoritative. A cache refresh failure cannot roll back a
      // durable event or make a successful lifecycle transition ambiguous.
    }
    if (snapshotWritten) this._compactIfNeeded();
  }

  _restore() {
    this.records = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    let snapshotLoaded = false;
    let snapshotError = null;
    try {
      const snapshot = this._readSnapshot();
      if (snapshot) {
        this.sequence = snapshot.sequence;
        this.records = new Map(snapshot.records.map((record) => [record.id, record]));
        snapshotLoaded = true;
      }
    } catch (error) {
      snapshotError = error;
    }

    let text = "";
    try {
      const stats = fs.lstatSync(this.eventsPath);
      if (
        !stats.isFile()
        || stats.isSymbolicLink()
        || stats.size > this.maxReplayBytes
      ) {
        throw new TerminalSessionStoreError(
          "Terminal session journal exceeds its replay limit.",
          "TERMINAL_JOURNAL_OVERSIZED"
        );
      }
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (snapshotLoaded) return;
        if (snapshotError) {
          this.journalHealthy = false;
          this.journalError = snapshotError;
        }
        return;
      }
      this.journalHealthy = false;
      this.journalError = error;
      return;
    }

    const lines = text.split(/\r?\n/);
    let previousJournalSequence = null;
    let replayedAny = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxEventBytes) {
        this._markJournalUnhealthy(`event ${index + 1} exceeds its size limit`);
        break;
      }
      let event;
      try {
        event = normalizeEvent(JSON.parse(line));
        if (
          previousJournalSequence != null
          && event.sequence !== previousJournalSequence + 1
        ) {
          throw new TypeError("event sequence is not contiguous");
        }
        previousJournalSequence = event.sequence;
        replayedAny = true;
        if (snapshotLoaded && event.sequence <= this.sequence) continue;
        this._applyEvent(event, { replay: true });
      } catch (error) {
        this._markJournalUnhealthy(
          `event ${index + 1} is invalid: ${safeError(error)}`
        );
        break;
      }
    }
    if (!snapshotLoaded && snapshotError && !replayedAny && this.journalHealthy) {
      this.journalHealthy = false;
      this.journalError = snapshotError;
    }
  }

  _applyEvent(event, { replay = false } = {}) {
    if (event.sequence !== this.sequence + 1) {
      throw new TypeError("Terminal event sequence is not contiguous.");
    }
    if (event.op === "prune") {
      for (const id of event.ids) {
        const record = this.records.get(id);
        if (!record || !FINAL_STATUSES.has(record.status)) {
          throw new TypeError("Terminal prune event references a non-final session.");
        }
        this.records.delete(id);
      }
      this.sequence = event.sequence;
      return;
    }

    const current = this.records.get(event.id) ?? null;
    const next = event.state;
    if (event.op === "create") {
      if (current || next.revision !== 1) {
        throw new TypeError("Terminal create event conflicts with existing state.");
      }
    } else {
      if (!current || next.revision !== current.revision + 1) {
        throw new TypeError("Terminal update event has an invalid revision.");
      }
      assertImmutableIdentity(current, next);
      if (event.op === "transition" && current.status !== next.status) {
        const allowed = ALLOWED_TRANSITIONS.get(current.status);
        if (!allowed?.has(next.status)) {
          throw new TypeError("Terminal transition event has invalid topology.");
        }
      } else if (event.op === "activity" && current.status !== next.status) {
        throw new TypeError("Terminal activity event changed session status.");
      }
    }
    if (next.sequence !== event.sequence) {
      throw new TypeError("Terminal state sequence does not match its event.");
    }
    this.records.set(next.id, next);
    this.sequence = event.sequence;
    if (replay && this.records.size > this.maxRecords) {
      throw new TypeError("Terminal journal exceeds the record limit.");
    }
  }

  _ensureJournalCapacity(eventBytes) {
    let journalBytes = this._journalSize();
    if (
      journalBytes < this.compactAtBytes
      && journalBytes + eventBytes <= this.maxReplayBytes
    ) {
      return;
    }

    let snapshotWritten = false;
    try {
      this.writeSnapshot(this.snapshotPath, this._snapshotValue());
      snapshotWritten = this._snapshotIsCurrent();
    } catch {
      snapshotWritten = false;
    }
    if (snapshotWritten) {
      try {
        this.compactJournal(this.eventsPath);
      } catch {
        // Atomic replacement can report an uncertain result. Reload both
        // durable layers before deciding whether another append is safe.
        this._restore();
        this._assertHealthy();
      }
      journalBytes = this._journalSize();
    }
    if (journalBytes + eventBytes > this.maxReplayBytes) {
      throw new TerminalSessionStoreError(
        "Terminal session journal has no safe capacity for another event.",
        "TERMINAL_JOURNAL_CAPACITY"
      );
    }
  }

  _compactIfNeeded() {
    if (this._journalSize() < this.compactAtBytes) return;
    if (!this._snapshotIsCurrent()) return;
    try {
      this.compactJournal(this.eventsPath);
    } catch {
      // The JSONL remains valid if replacement failed before commit. If the
      // atomic replacement committed first, the verified snapshot is current.
    }
  }

  _journalSize() {
    try {
      const stats = fs.lstatSync(this.eventsPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new TerminalSessionStoreError(
          "Terminal session journal must be a regular file.",
          "TERMINAL_STORE_UNSAFE_PATH"
        );
      }
      return stats.size;
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }

  _readSnapshot() {
    let stats;
    try {
      stats = fs.lstatSync(this.snapshotPath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size > this.maxReplayBytes
    ) {
      throw new TerminalSessionStoreError(
        "Terminal session snapshot is unsafe or oversized.",
        "TERMINAL_SNAPSHOT_INVALID"
      );
    }
    return normalizeSnapshot(
      JSON.parse(fs.readFileSync(this.snapshotPath, "utf8")),
      this.maxRecords
    );
  }

  _snapshotIsCurrent() {
    try {
      const durable = this._readSnapshot();
      if (!durable || durable.sequence !== this.sequence) return false;
      return JSON.stringify(durable) === JSON.stringify(this._snapshotValue());
    } catch {
      return false;
    }
  }

  _snapshotValue() {
    return {
      version: SNAPSHOT_VERSION,
      sequence: this.sequence,
      records: [...this.records.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map(viewRecord)
    };
  }

  _mutate(operation) {
    return this._withLock(() => {
      this._restore();
      this._assertHealthy();
      return operation();
    });
  }

  _readFresh(operation) {
    return this._withLock(() => {
      this._restore();
      this._assertHealthy();
      return operation();
    });
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
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex")
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        acquired = true;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
        }
        if (error?.code !== "EEXIST") throw error;
        removeStaleMutationLock(this.lockPath, this.staleLockMs);
        if (Date.now() >= deadline) {
          throw new TerminalSessionStoreError(
            "Timed out waiting for the terminal session mutation lock.",
            "TERMINAL_STORE_LOCK_TIMEOUT"
          );
        }
        Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      try {
        const current = fs.readFileSync(this.lockPath, "utf8");
        if (current === token) fs.unlinkSync(this.lockPath);
      } catch {
        // Another process will recover a stale lock if cleanup is interrupted.
      }
    }
  }

  _removeStaleManagerLease() {
    let stats;
    let lease;
    let original;
    try {
      stats = fs.statSync(this.managerLeasePath);
      original = fs.readFileSync(this.managerLeasePath, "utf8");
      lease = parseLeaseText(original);
    } catch (error) {
      return error?.code === "ENOENT";
    }
    const age = Math.max(0, Date.now() - stats.mtimeMs);
    const live = lease && processIsAlive(lease.pid);
    if (live || (!lease && age < this.staleLockMs)) return false;
    try {
      const currentStats = fs.statSync(this.managerLeasePath);
      const current = fs.readFileSync(this.managerLeasePath, "utf8");
      if (
        current !== original
        || currentStats.size !== stats.size
        || currentStats.mtimeMs !== stats.mtimeMs
      ) {
        return false;
      }
      fs.unlinkSync(this.managerLeasePath);
      return true;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }

  _requireLoaded(id) {
    const normalized = normalizeTerminalId(id);
    const record = this.records.get(normalized);
    if (!record) throw new Error(`Unknown terminal session: ${normalized}`);
    return record;
  }

  _assertHealthy() {
    if (this.journalHealthy) return;
    throw new TerminalSessionStoreError(
      `Terminal session journal is unhealthy: ${safeError(this.journalError)}`,
      "TERMINAL_JOURNAL_UNHEALTHY"
    );
  }

  _markJournalUnhealthy(message) {
    this.journalHealthy = false;
    this.journalError = new Error(message);
  }

  _timestamp() {
    const value = this.now();
    return normalizeTimestamp(
      value instanceof Date ? value.toISOString() : value,
      "timestamp"
    );
  }
}

function normalizeSnapshot(value, maxRecords) {
  const source = plainRecord(value, "terminal snapshot");
  assertOnlyKeys(source, ["version", "sequence", "records"], "terminal snapshot");
  const version = exactInteger(source.version, SNAPSHOT_VERSION, "snapshot version");
  const sequence = nonNegativeInteger(source.sequence, "snapshot sequence");
  if (!Array.isArray(source.records) || source.records.length > maxRecords) {
    throw new TypeError("Terminal snapshot exceeds the record limit.");
  }
  const records = source.records.map(normalizeRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new TypeError("Terminal snapshot contains duplicate session ids.");
  }
  if (new Set(records.map((record) => record.sequence)).size !== records.length) {
    throw new TypeError("Terminal snapshot contains duplicate record sequences.");
  }
  if (records.some((record) => record.sequence > sequence)) {
    throw new TypeError("Terminal snapshot record exceeds the snapshot sequence.");
  }
  return {
    version,
    sequence,
    records: records.sort((left, right) => left.sequence - right.sequence)
  };
}

function normalizeEvent(value) {
  const source = plainRecord(value, "terminal event");
  const op = source.op;
  const common = ["version", "sequence", "op", "at"];
  if (op === "prune") {
    assertOnlyKeys(source, [...common, "ids"], "terminal prune event");
    const ids = uniqueArray(source.ids, "terminal prune ids", normalizeTerminalId, 1_000);
    return {
      version: exactInteger(source.version, EVENT_VERSION, "event version"),
      sequence: positiveInteger(source.sequence, "event sequence"),
      op,
      at: normalizeTimestamp(source.at, "event timestamp"),
      ids
    };
  }
  if (!["create", "activity", "transition"].includes(op)) {
    throw new TypeError("Terminal event operation is invalid.");
  }
  assertOnlyKeys(source, [...common, "id", "state"], "terminal event");
  const state = normalizeRecord(source.state);
  const id = normalizeTerminalId(source.id);
  if (state.id !== id) throw new TypeError("Terminal event identity mismatch.");
  return {
    version: exactInteger(source.version, EVENT_VERSION, "event version"),
    sequence: positiveInteger(source.sequence, "event sequence"),
    op,
    at: normalizeTimestamp(source.at, "event timestamp"),
    id,
    state
  };
}

function normalizeRecord(value) {
  const source = plainRecord(value, "terminal session record");
  assertOnlyKeys(source, RECORD_FIELDS, "terminal session record");
  const status = String(source.status ?? "");
  if (!ACTIVE_STATUSES.has(status) && !FINAL_STATUSES.has(status)) {
    throw new TypeError("Terminal session status is invalid.");
  }
  const createdAt = normalizeTimestamp(source.createdAt, "createdAt");
  const updatedAt = normalizeTimestamp(source.updatedAt, "updatedAt");
  const startedAt = normalizeOptionalTimestamp(source.startedAt, "startedAt");
  const finishedAt = normalizeOptionalTimestamp(source.finishedAt, "finishedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError("Terminal session timestamps are out of order.");
  }
  if (status === TERMINAL_SESSION_STATUSES.RUNNING && !startedAt) {
    throw new TypeError("Running terminal session is missing startedAt.");
  }
  if (FINAL_STATUSES.has(status) && !finishedAt) {
    throw new TypeError("Final terminal session is missing finishedAt.");
  }
  return Object.freeze({
    version: exactInteger(source.version, RECORD_VERSION, "record version"),
    id: normalizeTerminalId(source.id),
    revision: positiveInteger(source.revision, "record revision"),
    sequence: positiveInteger(source.sequence, "record sequence"),
    status,
    projectId: normalizeProjectId(source.projectId),
    sessionId: normalizeOwnerSessionId(source.sessionId),
    projectRevision: positiveInteger(source.projectRevision, "projectRevision"),
    profileIdentity: normalizeProfileIdentity(source.profileIdentity),
    containerName: normalizeContainerName(source.containerName),
    imageDigest: normalizeImageDigest(source.imageDigest),
    cwd: normalizeRelativeCwd(source.cwd),
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    lastActivityAt: normalizeTimestamp(source.lastActivityAt, "lastActivityAt"),
    lastCommandAt: normalizeOptionalTimestamp(source.lastCommandAt, "lastCommandAt"),
    commandCount: nonNegativeInteger(source.commandCount, "commandCount"),
    inputBytes: nonNegativeInteger(source.inputBytes, "inputBytes"),
    outputBytes: nonNegativeInteger(source.outputBytes, "outputBytes"),
    droppedOutputBytes: nonNegativeInteger(
      source.droppedOutputBytes,
      "droppedOutputBytes"
    ),
    exitCode: normalizeExitCode(source.exitCode),
    reason: normalizeReason(source.reason)
  });
}

function assertImmutableIdentity(current, next) {
  for (const key of [
    "version",
    "id",
    "projectId",
    "sessionId",
    "projectRevision",
    "profileIdentity",
    "containerName",
    "imageDigest",
    "cwd",
    "createdAt"
  ]) {
    if (current[key] !== next[key]) {
      throw new TypeError(`Terminal session immutable field changed: ${key}`);
    }
  }
}

function matchesScope(record, scope) {
  const source = plainRecord(scope, "terminal scope");
  if (source.projectId != null && record.projectId !== normalizeProjectId(source.projectId)) {
    return false;
  }
  if (source.sessionId != null && record.sessionId !== normalizeOwnerSessionId(source.sessionId)) {
    return false;
  }
  return true;
}

function assertExpectedRevision(record, expected) {
  if (expected == null) return;
  const revision = positiveInteger(expected, "expectedRevision");
  if (record.revision !== revision) {
    throw new TerminalSessionConflictError(
      `Terminal session '${record.id}' revision ${revision} is stale; current revision is ${record.revision}.`
    );
  }
}

function normalizeTerminalId(value) {
  const id = String(value ?? "").trim();
  if (!SESSION_ID_RE.test(id)) throw new TypeError("Invalid terminal session id.");
  return id;
}

function normalizeProjectId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid terminal project id.");
  return id;
}

function normalizeOwnerSessionId(value) {
  if (typeof value !== "string" || !OWNER_SESSION_RE.test(value)) {
    throw new TypeError("Terminal owner session id must be bounded printable ASCII.");
  }
  return value;
}

function normalizeContainerName(value) {
  const name = String(value ?? "").trim();
  if (!CONTAINER_RE.test(name)) throw new TypeError("Invalid terminal container name.");
  return name;
}

function normalizeImageDigest(value) {
  const image = String(value ?? "").trim();
  if (!SHA256_IMAGE_RE.test(image)) {
    throw new TypeError("Terminal image must be an explicit sha256 digest reference.");
  }
  return image;
}

function normalizeProfileIdentity(value) {
  if (value == null || value === "") return null;
  const identity = String(value).trim();
  if (!/^[a-f0-9]{64}$/.test(identity)) {
    throw new TypeError("Invalid terminal capability profile identity.");
  }
  return identity;
}

function normalizeRelativeCwd(value) {
  const raw = value == null || value === "" ? "." : String(value);
  if (raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw)) {
    throw new TypeError("Terminal cwd must be a relative POSIX path.");
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || normalized.length > 1024
  ) {
    throw new TypeError("Terminal cwd escapes the project workspace.");
  }
  return normalized === "" ? "." : normalized;
}

function normalizeReason(value) {
  if (value == null || value === "") return null;
  const reason = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  return reason || null;
}

function normalizeExitCode(value) {
  if (value == null || value === "") return null;
  const code = Number(value);
  if (!Number.isSafeInteger(code) || code < -1 || code > 255) {
    throw new TypeError("Terminal exit code is invalid.");
  }
  return code;
}

function normalizeTimestamp(value, field) {
  const parsed = new Date(value ?? "");
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be an ISO timestamp.`);
  return parsed.toISOString();
}

function normalizeOptionalTimestamp(value, field) {
  return value == null || value === "" ? null : normalizeTimestamp(value, field);
}

function boundedCounterDelta(value, field) {
  if (value == null) return 0;
  return nonNegativeInteger(value, field);
}

function safeCounterAdd(left, right) {
  const next = left + right;
  if (!Number.isSafeInteger(next)) throw new RangeError("Terminal counter limit reached.");
  return next;
}

function positiveInteger(value, field) {
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

function exactInteger(value, expected, field) {
  if (value !== expected) throw new TypeError(`${field} is unsupported.`);
  return value;
}

function integerInRange(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`Integer option must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function plainRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  return value;
}

function assertOnlyKeys(source, allowed, field) {
  const keys = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(source)) {
    if (!keys.has(key)) throw new TypeError(`${field} contains unsupported field '${key}'.`);
  }
}

function uniqueArray(value, field, normalize, maxItems) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new TypeError(`${field} must be a bounded non-empty array.`);
  }
  const items = value.map(normalize);
  if (new Set(items).size !== items.length) {
    throw new TypeError(`${field} must not contain duplicates.`);
  }
  return items;
}

function normalizeLeaseOwner(value) {
  const owner = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) {
    throw new TypeError("Invalid terminal manager lease owner.");
  }
  return owner;
}

function readLeaseFile(filePath) {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size > 4096) return null;
  return parseLeaseText(fs.readFileSync(filePath, "utf8"));
}

function parseLeaseText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    value?.version !== 1
    || typeof value.ownerId !== "string"
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.nonce !== "string"
  ) {
    return null;
  }
  return value;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeStaleMutationLock(lockPath, staleMs) {
  try {
    const stats = fs.statSync(lockPath);
    const original = fs.readFileSync(lockPath, "utf8");
    let lease = null;
    try { lease = JSON.parse(original); } catch { /* corrupt lock */ }
    if (lease?.pid && processIsAlive(lease.pid)) return false;
    if (!lease?.pid && Date.now() - stats.mtimeMs <= staleMs) return false;
    const currentStats = fs.statSync(lockPath);
    const current = fs.readFileSync(lockPath, "utf8");
    if (
      current !== original
      || currentStats.size !== stats.size
      || currentStats.mtimeMs !== stats.mtimeMs
    ) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function assertDirectoryNotLink(dir) {
  const stats = fs.lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TerminalSessionStoreError(
      "Terminal session storage must be a real directory.",
      "TERMINAL_STORE_UNSAFE_PATH"
    );
  }
}

function viewRecord(record) {
  return structuredClone(record);
}

function safeError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .slice(0, 500);
}

export function isTerminalSessionActive(status) {
  return ACTIVE_STATUSES.has(status);
}

export function isTerminalSessionFinal(status) {
  return FINAL_STATUSES.has(status);
}

export function isPinnedTerminalImage(value) {
  return SHA256_IMAGE_RE.test(String(value ?? "").trim());
}

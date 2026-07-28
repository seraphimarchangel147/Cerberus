import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { MemorySystem } from "./memory-system.js";
import { nowIso, stableHash } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const MEMORY_STATE_VERSION = 2;
const MAX_MEMORY_ITEMS = 10_000;
const MAX_MEMORY_STATE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_EVENT_BYTES = 8 * 1024 * 1024;
// _restore() refuses a journal past MAX_MEMORY_STATE_BYTES * 8 (64 MiB). Compact
// at 75% of that ceiling so the store heals itself with headroom to spare.
const MAX_MEMORY_JOURNAL_BYTES = MAX_MEMORY_STATE_BYTES * 8;
const DEFAULT_AUTO_COMPACT_BYTES = Math.floor(MAX_MEMORY_JOURNAL_BYTES * 0.75);
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Durable tiered memory. JSONL is the authority; the JSON snapshot is a
 * restart accelerator. Every v2 event carries the fully normalized state, so
 * an append that reaches disk before a later snapshot failure is recoverable
 * after restart instead of becoming a phantom write.
 */
export class FileBackedMemorySystem extends MemorySystem {
  constructor(options = {}) {
    super(options);
    this.dir = options.dir ?? path.join(resolveDataDir(), "memory");
    this.snapshotPath = options.snapshotPath ?? path.join(this.dir, "memory-state.json");
    this.eventsPath = options.eventsPath ?? path.join(this.dir, "memory-events.jsonl");
    this.lockPath = options.lockPath ?? path.join(this.dir, ".mutation.lock");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = positiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
    this.autoCompact = options.autoCompact !== false;
    this.autoCompactBytes = Math.min(
      positiveInteger(options.autoCompactBytes, DEFAULT_AUTO_COMPACT_BYTES),
      MAX_MEMORY_JOURNAL_BYTES
    );
    this.lockDepth = 0;
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;
    this.loaded = false;
    ensureDir(this.dir);
    if (options.autoLoad !== false) this.load();
  }

  load() {
    return this._withLock(() => {
      this._restore();
      this.loaded = true;
      return this.snapshot();
    });
  }

  remember(observation, context = {}) {
    return this._mutate(() => {
      this.deferMemTreeProjection += 1;
      let item;
      try {
        item = super.remember(observation, context);
      } finally {
        this.deferMemTreeProjection -= 1;
      }
      const correction = context.persistenceOp === "correct";
      this.persist(correction ? "correct" : "remember", correction
        ? {
            item,
            correctedId: item.id,
            superseded: item.metadata?.corrects ?? []
          }
          : { item });
      this.projectMemoryItem(item);
      return item;
    });
  }

  reinforce(id, amount = 0.1) {
    return this._mutate(() => {
      const item = super.reinforce(id, amount);
      if (item) this.persist("reinforce", { id, amount, item });
      return item;
    });
  }

  correct(input) {
    // MemorySystem.correct() routes the fully superseded state through the
    // overridden remember() above. The nested lock keeps lookup, correction,
    // event append, and snapshot refresh in one serialized mutation.
    return this._mutate(() => super.correct(input));
  }

  decay(now = new Date()) {
    return this._mutate(() => {
      const result = super.decay(now);
      if (result.removed.length > 0 || result.promoted.length > 0) {
        this.persist("decay", {
          removed: result.removed.map((item) => item.id),
          promoted: result.promoted.map((item) => item.id)
        });
      }
      return result;
    });
  }

  /**
   * Refresh the authority snapshot, then drop only events already covered by
   * it. Future events retain their monotonic sequence and replay correctly.
   */
  compactEventLog() {
    return this._mutate(() => {
      this.saveSnapshot();
      writeTextAtomic(this.eventsPath, "");
      return { sequence: this.sequence, compactedAt: nowIso() };
    });
  }

  persist(op, payload) {
    if (this.lockDepth < 1) {
      throw new Error("Memory persistence requires the mutation lock.");
    }
    this._assertJournalHealthy();

    const at = nowIso();
    const sequence = this.sequence + 1;
    const state = this._state(at, sequence);
    const event = {
      version: MEMORY_STATE_VERSION,
      sequence,
      op,
      at,
      payload: structuredClone(payload),
      state
    };
    if (jsonBytes(state) > MAX_MEMORY_STATE_BYTES || jsonBytes(event) > MAX_MEMORY_EVENT_BYTES) {
      this._restore();
      throw new RangeError("Memory state exceeds its durable persistence bound.");
    }

    let appendError = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      // Append can be uncertain on a filesystem fault. Reload the journal: if
      // the complete event made it to disk, keep the committed state; if not,
      // restore the prior state and surface the failure to the caller.
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

    let snapshotWritten = false;
    try {
      this.writeSnapshot(this.snapshotPath, state);
      snapshotWritten = true;
    } catch (error) {
      // The journal is authoritative. A snapshot cache refresh failure must
      // not roll back a completed memory write or produce a false error.
      try { console.warn(`[memory] snapshot refresh failed: ${error?.message ?? error}`); } catch { /* advisory */ }
    }

    this._maybeAutoCompact(snapshotWritten);
  }

  /**
   * Every v2 event embeds the full normalized state, so the journal grows
   * superlinearly with item count and reaches the replay ceiling in days, not
   * years. Once past it, `_restore()` marks the journal unhealthy and every
   * write fails — recovery then needs manual surgery.
   *
   * Self-compact well below that ceiling instead. This is only safe when the
   * snapshot that supersedes the journal actually reached disk, so a failed
   * snapshot write skips compaction and leaves the journal as sole authority
   * (fail-closed: prefer an oversized journal over a lost one).
   */
  _maybeAutoCompact(snapshotWritten) {
    if (!snapshotWritten || this.autoCompact === false) return null;
    let size;
    try {
      size = fs.statSync(this.eventsPath).size;
    } catch {
      return null;
    }
    if (size < this.autoCompactBytes) return null;
    try {
      // The snapshot already holds this exact sequence, so dropping the
      // superseded events preserves the restore path: snapshot supplies the
      // state, and future events continue from the same monotonic sequence.
      this.saveSnapshot();
      writeTextAtomic(this.eventsPath, "");
      try { console.warn(`[memory] event journal auto-compacted at ${size} bytes (sequence ${this.sequence})`); } catch { /* advisory */ }
      return { sequence: this.sequence, compactedAt: nowIso(), reclaimedBytes: size };
    } catch (error) {
      // A failed compaction must never break the write that triggered it.
      try { console.warn(`[memory] auto-compaction failed: ${error?.message ?? error}`); } catch { /* advisory */ }
      return null;
    }
  }

  saveSnapshot() {
    const state = this._state(nowIso(), this.sequence);
    this.writeSnapshot(this.snapshotPath, state);
    return state;
  }

  _mutate(operation) {
    return this._withLock(() => {
      if (this.loaded) this._restore();
      else this.loaded = true;
      this._assertJournalHealthy();
      return operation();
    });
  }

  _restore() {
    this.items = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this.journalError = null;

    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
      if (snapshot) this._applyState(snapshot, { legacyAllowed: true });
    } catch {
      // A valid journal can repair a stale or corrupt snapshot. Do not let the
      // cache layer become authority over a committed append-only event.
      this.items = new Map();
      this.sequence = 0;
    }

    let lines;
    try {
      lines = readEventLines(this.eventsPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      this._markJournalUnhealthy(error?.message ?? "memory event journal cannot be read");
      return;
    }

    let seenV2 = false;
    let previousJournalSequence = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_MEMORY_EVENT_BYTES) {
        this._markJournalUnhealthy("memory event exceeds its size limit");
        break;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this._markJournalUnhealthy("memory event is not valid JSON");
        break;
      }

      // v1 events predate state-bearing journal recovery. Existing v1 stores
      // remain readable through their atomic snapshot; only v2 events carry
      // the state necessary to replay a snapshot gap.
      if (event?.version === 1 && !Object.hasOwn(event, "sequence")) continue;
      seenV2 = true;
      if (!validEvent(event)) {
        this._markJournalUnhealthy("memory event has an invalid durable shape");
        break;
      }
      if (
        previousJournalSequence !== null
        && event.sequence !== previousJournalSequence + 1
      ) {
        this._markJournalUnhealthy("memory event sequence is not contiguous");
        break;
      }
      previousJournalSequence = event.sequence;
      if (event.sequence <= this.sequence) continue;
      if (event.sequence !== this.sequence + 1) {
        this._markJournalUnhealthy("memory event sequence does not continue from the snapshot");
        break;
      }
      try {
        this._applyState(event.state);
      } catch {
        this._markJournalUnhealthy("memory event state is invalid");
        break;
      }
    }

    if (snapshot?.version === MEMORY_STATE_VERSION && seenV2 && this.sequence === 0) {
      this._markJournalUnhealthy("memory snapshot and event journal disagree");
    }
  }

  _state(at = nowIso(), sequence = this.sequence) {
    return {
      version: MEMORY_STATE_VERSION,
      sequence,
      updatedAt: at,
      items: [...this.items.values()]
        .map((item) => structuredClone(item))
        .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) || String(left.id).localeCompare(String(right.id)))
    };
  }

  _applyState(value, { legacyAllowed = false } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Memory state must be an object.");
    }
    const version = Number(value.version ?? 1);
    if (version !== MEMORY_STATE_VERSION && !(legacyAllowed && version === 1)) {
      throw new TypeError("Unsupported memory state version.");
    }
    const sequence = version === 1 ? 0 : value.sequence;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError("Memory state sequence is invalid.");
    }
    if (version === MEMORY_STATE_VERSION && !validIso(value.updatedAt)) {
      throw new TypeError("Memory state timestamp is invalid.");
    }
    if (!Array.isArray(value.items) || value.items.length > MAX_MEMORY_ITEMS) {
      throw new TypeError("Memory state items are invalid.");
    }
    const next = new Map();
    for (const raw of value.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError("Memory item is invalid.");
      }
      const id = String(raw.id ?? "").trim();
      const tier = String(raw.tier ?? "").trim();
      if (!id || !tier || next.has(id)) throw new TypeError("Memory item identity is invalid.");
      next.set(id, structuredClone(raw));
    }
    const normalized = {
      version: MEMORY_STATE_VERSION,
      sequence,
      updatedAt: version === 1 ? nowIso() : value.updatedAt,
      items: [...next.values()].sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) || String(left.id).localeCompare(String(right.id)))
    };
    if (jsonBytes(normalized) > MAX_MEMORY_STATE_BYTES) {
      throw new RangeError("Memory state exceeds its durable persistence bound.");
    }
    this.items = next;
    this.sequence = sequence;
  }

  _assertJournalHealthy() {
    if (this.journalHealthy) return;
    throw new Error(`Memory journal is unhealthy: ${this.journalError ?? "unknown error"}`);
  }

  _markJournalUnhealthy(reason) {
    this.journalHealthy = false;
    this.journalError ??= String(reason || "memory journal is invalid");
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
    while (true) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        break;
      } catch (error) {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
        if (error?.code !== "EEXIST") throw error;
        removeStaleLock(this.lockPath, this.staleLockMs);
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the memory mutation lock.");
        Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === token) fs.unlinkSync(this.lockPath);
      } catch {
        // An interrupted cleanup becomes a stale lock; future callers verify
        // the owner before removing it.
      }
    }
  }
}

function validEvent(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === MEMORY_STATE_VERSION
    && Number.isSafeInteger(value.sequence)
    && value.sequence > 0
    && typeof value.op === "string"
    && validIso(value.at)
    && value.state
    && value.state.sequence === value.sequence
    && value.state.updatedAt === value.at
  );
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readEventLines(eventsPath) {
  const stat = fs.lstatSync(eventsPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Memory event journal must be a regular file.");
  }
  if (stat.size > MAX_MEMORY_STATE_BYTES * 8) {
    throw new RangeError("Memory event journal exceeds its replay limit.");
  }
  return fs.readFileSync(eventsPath, "utf8").split(/\r?\n/u);
}

function removeStaleLock(lockPath, staleLockMs) {
  let stat;
  let original;
  try {
    stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < staleLockMs) return false;
    original = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  let owner;
  try { owner = JSON.parse(original); } catch { owner = null; }
  if (processIsAlive(owner?.pid)) return false;
  try {
    if (fs.readFileSync(lockPath, "utf8") !== original) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
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

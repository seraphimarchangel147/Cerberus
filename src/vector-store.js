import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { cosine } from "./embeddings.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Namespaced cosine vector store. File-backed for persistence across restarts.
// Namespaces include principle, specialist, memory, and project recipe indexes.

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class VectorStore {
  constructor(options = {}) {
    this.embedder = options.embedder;
    this.dir = path.resolve(options.dir ?? path.join(resolveDataDir(), "vectors"));
    this.path = path.resolve(options.path ?? path.join(this.dir, "store.json"));
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS
    );
    this.staleLockMs = positiveInteger(
      options.staleLockMs,
      DEFAULT_STALE_LOCK_MS
    );
    this.lockDepth = 0;
    this.entries = new Map();
    this.dim = options.dim ?? this.embedder?.dim ?? 256;
    ensureDir(this.dir);
    this._withLock(() => this._load());
  }

  key(namespace, id) {
    return `${namespace}:${id}`;
  }

  async upsert(namespace, id, text, payload = {}) {
    if (!this.embedder) return null;
    let embedding;
    try {
      embedding = await this.embedder.embed(text);
    } catch (error) {
      // The vector index is derived state; preserve the authoritative write.
      return { error: error.message };
    }
    return this.upsertVector(namespace, id, text, embedding, payload);
  }

  upsertVector(namespace, id, text, embedding, payload = {}) {
    this._assertEmbedding(embedding, id);
    const entry = {
      namespace,
      id,
      text: String(text).slice(0, 600),
      embedding: [...embedding],
      payload: structuredClone(payload),
      at: nowIso()
    };
    this._withLock(() => {
      this._load();
      const before = new Map(this.entries);
      try {
        this.entries.set(this.key(namespace, id), entry);
        this._persistUnlocked();
      } catch (error) {
        this.entries = before;
        throw error;
      }
    });
    return entry;
  }

  delete(namespace, id) {
    return this._withLock(() => {
      this._load();
      const key = this.key(namespace, id);
      const had = this.entries.delete(key);
      if (!had) return false;
      try {
        this._persistUnlocked();
      } catch (error) {
        this._load();
        throw error;
      }
      return true;
    });
  }

  async search(namespace, queryText, { limit = 5, minScore = 0.05 } = {}) {
    if (!this.embedder) return [];
    let queryEmbedding;
    try {
      queryEmbedding = await this.embedder.embed(queryText);
    } catch {
      return [];
    }
    return this._withLock(() => {
      this._load();
      const output = [];
      for (const entry of this.entries.values()) {
        if (entry.namespace !== namespace) continue;
        const score = cosine(queryEmbedding, entry.embedding);
        if (score < minScore) continue;
        output.push({
          id: entry.id,
          score,
          text: entry.text,
          payload: structuredClone(entry.payload)
        });
      }
      return output
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    });
  }

  list(namespace) {
    return this._withLock(() => {
      this._load();
      return [...this.entries.values()]
        .filter((entry) => entry.namespace === namespace)
        .map(({ embedding, ...rest }) => structuredClone(rest));
    });
  }

  replaceNamespace(namespace, rows = []) {
    const target = String(namespace ?? "").trim();
    if (!target) throw new TypeError("Vector namespace is required.");
    if (!Array.isArray(rows)) throw new TypeError("Vector rows must be an array.");
    const replacements = new Map();
    for (const row of rows) {
      const id = String(row?.id ?? "").trim();
      if (!id) throw new TypeError("Vector row id is required.");
      const key = this.key(target, id);
      if (replacements.has(key)) throw new TypeError(`Duplicate vector row: ${id}`);
      if (
        !Array.isArray(row.embedding)
        || row.embedding.length === 0
        || row.embedding.some((component) => !Number.isFinite(component))
      ) {
        throw new TypeError(`Vector row '${id}' has an invalid embedding.`);
      }
      this._assertEmbedding(row.embedding, id);
      replacements.set(key, {
        namespace: target,
        id,
        text: String(row.text ?? "").slice(0, 600),
        embedding: [...row.embedding],
        payload: structuredClone(row.payload ?? {}),
        at: row.at ?? nowIso()
      });
    }

    return this._withLock(() => {
      this._load();
      const before = new Map(this.entries);
      try {
        for (const [key, entry] of this.entries) {
          if (entry.namespace === target) this.entries.delete(key);
        }
        for (const [key, entry] of replacements) this.entries.set(key, entry);
        this._persistUnlocked();
      } catch (error) {
        this.entries = before;
        throw error;
      }
      return replacements.size;
    });
  }

  persist() {
    this._withLock(() => {
      this._load();
      this._persistUnlocked();
    });
  }

  _load() {
    const snapshot = readJsonFile(this.path, { version: 1, entries: [] });
    const entries = new Map();
    for (const entry of snapshot.entries ?? []) {
      entries.set(this.key(entry.namespace, entry.id), entry);
    }
    this.entries = entries;
  }

  _persistUnlocked() {
    writeJsonAtomic(this.path, {
      version: 1,
      updatedAt: nowIso(),
      entries: [...this.entries.values()]
    });
  }

  _assertEmbedding(embedding, id) {
    if (
      !Array.isArray(embedding)
      || embedding.length === 0
      || embedding.some((component) => !Number.isFinite(component))
    ) {
      throw new TypeError(`Vector row '${id}' has an invalid embedding.`);
    }
    if (
      Number.isSafeInteger(this.dim)
      && this.dim > 0
      && embedding.length !== this.dim
    ) {
      throw new TypeError(
        `Vector row '${id}' has dimension ${embedding.length}; expected ${this.dim}.`
      );
    }
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
          throw new Error("Vector store is busy.");
        }
        Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
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
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
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
      // Never remove a lock whose ownership token cannot be verified.
    }
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
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

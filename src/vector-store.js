// Portions adapted from TencentDB Agent Memory
// (https://github.com/TencentCloud/TencentDB-Agent-Memory), MIT.
// Copyright (C) 2026 Tencent. Derived from commit 104e9d8:
// src/core/store/search-utils.ts (Reciprocal Rank Fusion) and
// src/offload/hooks/llm-input-l3.ts (substitutability score cascade).

import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { cosine } from "./embeddings.js";
import { nowIso, tokenOverlapScore } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Namespaced cosine vector store. File-backed for persistence across restarts.
// Namespaces include principle, specialist, memory, and project recipe indexes.

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion(rankedLists, { k = DEFAULT_RRF_K } = {}) {
  if (!Array.isArray(rankedLists)) return [];
  const offset = Number.isFinite(Number(k)) && Number(k) >= 0
    ? Number(k)
    : DEFAULT_RRF_K;
  const scores = new Map();
  const ranks = new Map();
  for (let listIndex = 0; listIndex < rankedLists.length; listIndex += 1) {
    const list = rankedLists[listIndex];
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = stableRrfId(list[rank]);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + (1 / (offset + rank + 1)));
      const itemRanks = ranks.get(id) ?? [];
      itemRanks.push({ list: listIndex, rank });
      ranks.set(id, itemRanks);
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({
      id,
      score,
      ranks: ranks.get(id) ?? []
    }))
    .sort((left, right) => (
      right.score - left.score
      || compareStableIds(left.id, right.id)
    ));
}

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
    const env = options.env ?? process.env;
    this.hybridSearch = enabledFlag(
      options.hybridSearch
        ?? env?.OPENAGI_VECTOR_HYBRID_SEARCH
    );
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

  async search(namespace, queryText, {
    limit = 5,
    minScore = 0.05,
    hybrid = this.hybridSearch
  } = {}) {
    if (!this.embedder) return [];
    let queryEmbedding;
    try {
      queryEmbedding = await this.embedder.embed(queryText);
    } catch {
      return [];
    }
    return this._withLock(() => {
      this._load();
      const legacySearch = () => {
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
      };
      if (hybrid !== true) return legacySearch();
      try {
        const entries = [...this.entries.values()]
          .filter((entry) => entry.namespace === namespace)
          .sort((left, right) => compareStableIds(left.id, right.id));
        const vectorRanked = entries
          .map((entry) => ({
            id: entry.id,
            score: cosine(queryEmbedding, entry.embedding)
          }))
          .filter((item) => item.score >= minScore)
          .sort((left, right) => (
            right.score - left.score
            || compareStableIds(left.id, right.id)
          ));
        const boundedQuery = String(queryText ?? "").slice(0, 4_096);
        const lexicalRanked = entries
          .map((entry) => ({
            id: entry.id,
            score: tokenOverlapScore(boundedQuery, entry.text)
          }))
          .filter((item) => item.score > 0)
          .sort((left, right) => (
            right.score - left.score
            || compareStableIds(left.id, right.id)
          ));
        const fused = reciprocalRankFusion([
          vectorRanked,
          lexicalRanked
        ]);
        const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
        const vectorScores = new Map(
          vectorRanked.map((item) => [String(item.id), item.score])
        );
        const lexicalScores = new Map(
          lexicalRanked.map((item) => [String(item.id), item.score])
        );
        const activeLists = [vectorRanked, lexicalRanked]
          .filter((list) => list.length > 0)
          .length;
        const maximumRrfScore = activeLists > 0
          ? activeLists / (DEFAULT_RRF_K + 1)
          : 1;
        // Fusion decides ORDER only. `score` stays the cosine similarity so it
        // remains magnitude-comparable across hybrid/legacy: callers such as
        // signal-axes (novelty = 1 - score) and specialist-router (blends score
        // against a keyword score, then gates on an absolute threshold) read it
        // as a similarity, not as a rank. Normalized fusion strength is exposed
        // separately as `fusedScore` for rank-aware consumers.
        return fused
          .slice(0, limit)
          .map((item) => {
            const entry = byId.get(item.id);
            if (!entry) throw new Error("Fused vector result lost its source entry.");
            return {
              id: entry.id,
              score: vectorScores.get(item.id) ?? 0,
              fusedScore: item.score / maximumRrfScore,
              rrfScore: item.score,
              vectorScore: vectorScores.get(item.id) ?? 0,
              lexicalScore: lexicalScores.get(item.id) ?? 0,
              text: entry.text,
              payload: structuredClone(entry.payload)
            };
          });
      } catch {
        return legacySearch();
      }
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

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  try {
    return ["1", "true", "yes", "on"].includes(
      String(value).trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

function stableRrfId(item) {
  try {
    if (!item || typeof item !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(item, "id");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    const value = descriptor.value;
    if (typeof value !== "string" && typeof value !== "number") return null;
    const id = String(value);
    return id ? id : null;
  } catch {
    return null;
  }
}

function compareStableIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
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

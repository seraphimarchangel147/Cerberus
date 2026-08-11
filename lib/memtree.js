/*
 * Clean-room implementation from docs/plans/upgrade-batch-2026-07.md.
 * No OptMem source code was inspected, copied, or used.
 *
 * Structural range and drill-down concepts are adapted from PageIndex:
 * https://github.com/VectifyAI/PageIndex/tree/190f8b378be58199ca993566a9214dba72089c54
 * Copyright (c) 2025 Vectify AI, licensed under the MIT License.
 * This implementation is original Node.js code; see THIRD_PARTY_NOTICES.md.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveDataDir } from "../src/data-dir.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../src/file-utils.js";

const MAX_TOTAL = 10_000_000;
const ALPHA_STEPS = 32;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const MAX_RECALL_PATTERN_CHARS = 200;
const MAX_RECALL_RESULTS = 100;
const MAX_ZOOM_BUDGET = 64;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 60_000;

export const LOG_RECORD_BYTES = 320;
export const TREE_RECORD_BYTES = 288;
export const DEFAULT_WAKE_BUDGET = 192;
export const DEFAULT_SPILL_BYTES = 24 * 1024;
export const DEFAULT_ENTRY_CHARS = 280;

export function memtreeEnabled(env = process.env) {
  return String(env?.OPENAGI_MEMTREE ?? "").trim() === "1";
}

export function cover(total, budget) {
  const T = positiveSafeInteger(total, "total");
  const limit = Math.min(T, positiveSafeInteger(budget, "budget"));
  if (limit === 1) return [block(0, T)];

  let low = Number.EPSILON;
  let high = T;
  let best = tilesForAlpha(T, low, limit);
  for (let step = 0; step < ALPHA_STEPS; step += 1) {
    const alpha = (low + high) / 2;
    const candidate = tilesForAlpha(T, alpha, limit);
    if (candidate.length <= limit && candidate[0]?.lo === 0) {
      best = candidate;
      low = alpha;
    } else {
      high = alpha;
    }
  }

  while (best.length < limit) {
    const index = mostRecentSplittableIndex(best);
    if (index < 0) break;
    const current = best[index];
    const rightSize = recentSplitSize(current.hi - current.lo);
    const cut = current.hi - rightSize;
    best.splice(index, 1, block(current.lo, cut), block(cut, current.hi));
  }
  return best;
}

function tilesForAlpha(total, alpha, budget) {
  const reversed = [];
  let cursor = total;
  let age = 0;
  const maxExponent = Math.ceil(Math.log2(total));
  while (cursor > 0) {
    const exponent = Math.min(
      maxExponent,
      Math.max(0, Math.floor(age / Math.max(Number.EPSILON, alpha)))
    );
    const width = Math.min(cursor, 2 ** exponent);
    reversed.push(block(cursor - width, cursor));
    cursor -= width;
    age += width;
    if (reversed.length > budget) return reversed;
  }
  reversed.reverse();
  return reversed;
}

function mostRecentSplittableIndex(blocks) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].hi - blocks[index].lo > 1) return index;
  }
  return -1;
}

function recentSplitSize(length) {
  const half = Math.max(1, Math.floor(length / 2));
  return 2 ** Math.floor(Math.log2(half));
}

function block(lo, hi) {
  const length = hi - lo;
  return Object.freeze({
    lo,
    hi,
    size: length,
    level: 2 ** Math.ceil(Math.log2(Math.max(1, length)))
  });
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > MAX_TOTAL
  ) {
    throw new RangeError(`${label} must be an integer from 1 through ${MAX_TOTAL}.`);
  }
  return parsed;
}

export class MemTree {
  constructor({
    dir,
    wakeBudget = DEFAULT_WAKE_BUDGET,
    entryChars = DEFAULT_ENTRY_CHARS,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS
  } = {}) {
    this.dir = path.resolve(dir ?? path.join(resolveDataDir(), "memory", "memtree", "main"));
    this.logPath = path.join(this.dir, "LOG.txt");
    this.treeDir = path.join(this.dir, "TREE");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.wakeBudget = boundedPositiveInteger(wakeBudget, DEFAULT_WAKE_BUDGET, 4096);
    this.entryChars = boundedPositiveInteger(entryChars, DEFAULT_ENTRY_CHARS, 300);
    this.lockTimeoutMs = boundedPositiveInteger(
      lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      60_000
    );
    this.staleLockMs = boundedPositiveInteger(
      staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      24 * 60 * 60 * 1000
    );
    this.lockDepth = 0;
    ensureDir(this.treeDir);
  }

  logLen() {
    let stat;
    try {
      stat = fs.lstatSync(this.logPath);
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    assertRegularFile(stat, "Memory log");
    if (stat.size % LOG_RECORD_BYTES !== 0) {
      throw new Error("Memory log has a partial fixed-width record.");
    }
    const length = stat.size / LOG_RECORD_BYTES;
    if (!Number.isSafeInteger(length) || length > MAX_TOTAL) {
      throw new RangeError("Memory log exceeds its record bound.");
    }
    return length;
  }

  note(text) {
    return this._withLock(() => {
      const index = this.logLen();
      if (index >= MAX_TOTAL) throw new RangeError("Memory log is full.");
      const normalized = normalizeEntryText(text, this.entryChars);
      const record = encodeTextRecord(normalized, LOG_RECORD_BYTES);
      const descriptor = fs.openSync(this.logPath, "a", 0o600);
      try {
        writeWholeRecord(descriptor, record);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return {
        index,
        text: normalized,
        merges: this.pending()
      };
    });
  }

  wake(budget = this.wakeBudget) {
    const total = this.logLen();
    if (total === 0) {
      return {
        total: 0,
        budget: boundedPositiveInteger(budget, this.wakeBudget, 4096),
        blocks: [],
        merges: [],
        text: ""
      };
    }
    const normalizedBudget = boundedPositiveInteger(budget, this.wakeBudget, 4096);
    const materialized = this._materialize(cover(total, normalizedBudget));
    return {
      total,
      budget: normalizedBudget,
      blocks: materialized.blocks,
      merges: materialized.merges,
      text: materialized.blocks.map(renderMemoryBlock).join("\n")
    };
  }

  pending(budget = this.wakeBudget) {
    const total = this.logLen();
    if (total === 0) return [];
    return this._materialize(
      cover(total, boundedPositiveInteger(budget, this.wakeBudget, 4096)),
      { includeText: false }
    ).merges;
  }

  merge(lo, hi, line) {
    return this._withLock(() => {
      const range = normalizeRange(lo, hi, this.logLen());
      const summary = normalizeSummaryLine(line);
      const level = nextPowerOfTwo(range.hi - range.lo);
      const record = encodeJsonRecord({
        lo: range.lo,
        hi: range.hi,
        line: summary
      }, TREE_RECORD_BYTES);
      const file = this._treePath(level);
      const descriptor = openForPositionedWrite(file);
      try {
        writeWholeRecord(descriptor, record, range.lo * TREE_RECORD_BYTES);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return {
        lo: range.lo,
        hi: range.hi,
        level,
        line: summary,
        merges: this.pending()
      };
    });
  }

  zoom(lo, hi, budget = 32) {
    const total = this.logLen();
    const range = normalizeRange(lo, hi, total);
    const normalizedBudget = boundedPositiveInteger(budget, 32, MAX_ZOOM_BUDGET);
    const local = cover(range.hi - range.lo, normalizedBudget)
      .map((item) => block(item.lo + range.lo, item.hi + range.lo));
    const materialized = this._materialize(local);
    return {
      lo: range.lo,
      hi: range.hi,
      blocks: materialized.blocks,
      merges: materialized.merges,
      text: materialized.blocks.map(renderMemoryBlock).join("\n")
    };
  }

  recall(pattern, { limit = 20 } = {}) {
    const expression = compileRecallPattern(pattern);
    const total = this.logLen();
    const maxResults = boundedPositiveInteger(limit, 20, MAX_RECALL_RESULTS);
    if (total === 0) return [];
    const descriptor = fs.openSync(this.logPath, "r");
    const matches = [];
    try {
      for (let index = 0; index < total && matches.length < maxResults; index += 1) {
        const text = readTextRecord(descriptor, index, LOG_RECORD_BYTES);
        expression.lastIndex = 0;
        if (expression.test(text)) matches.push({ index, text });
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return matches;
  }

  migrate(items = []) {
    if (!Array.isArray(items) || items.length === 0) {
      return { imported: 0, skipped: 0, merges: [] };
    }
    return this._withLock(() => {
      if (this.logLen() > 0) {
        return { imported: 0, skipped: items.length, merges: this.pending() };
      }
      const ordered = [...items]
        .filter((item) => item && typeof item === "object")
        .sort(compareMigratedMemory);
      if (ordered.length > MAX_TOTAL) {
        throw new RangeError("Memory migration exceeds the log record bound.");
      }
      const descriptor = fs.openSync(this.logPath, "a", 0o600);
      let imported = 0;
      try {
        for (const item of ordered) {
          const text = normalizeEntryText(item.content ?? item.text, this.entryChars);
          writeWholeRecord(
            descriptor,
            encodeTextRecord(text, LOG_RECORD_BYTES)
          );
          imported += 1;
        }
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return { imported, skipped: items.length - imported, merges: this.pending() };
    });
  }

  _materialize(blocks, { includeText = true } = {}) {
    const stats = this._treeStats(blocks);
    let logDescriptor;
    const materialized = [];
    const merges = [];
    try {
      for (const item of blocks) {
        if (item.size === 1) {
          if (includeText) {
            logDescriptor ??= fs.openSync(this.logPath, "r");
            materialized.push({
              ...item,
              detail: true,
              text: readTextRecord(logDescriptor, item.lo, LOG_RECORD_BYTES)
            });
          }
          continue;
        }
        const cached = this._readTreeBlock(item, stats.get(item.level));
        if (cached) {
          if (includeText) {
            materialized.push({ ...item, detail: false, text: cached.line });
          }
          continue;
        }
        const request = {
          lo: item.lo,
          hi: item.hi,
          level: item.level
        };
        merges.push(request);
        if (includeText) {
          materialized.push({
            ...item,
            detail: false,
            pending: true,
            text: "summary pending"
          });
        }
      }
    } finally {
      if (logDescriptor !== undefined) fs.closeSync(logDescriptor);
    }
    return { blocks: materialized, merges };
  }

  _treeStats(blocks) {
    const stats = new Map();
    for (const item of blocks) {
      if (item.size === 1 || stats.has(item.level)) continue;
      try {
        const stat = fs.lstatSync(this._treePath(item.level));
        assertRegularFile(stat, `Memory tree level ${item.level}`);
        stats.set(item.level, stat);
      } catch (error) {
        if (error?.code === "ENOENT") stats.set(item.level, null);
        else throw error;
      }
    }
    return stats;
  }

  _readTreeBlock(item, stat) {
    if (!stat) return null;
    const offset = item.lo * TREE_RECORD_BYTES;
    if (offset + TREE_RECORD_BYTES > stat.size) return null;
    const descriptor = fs.openSync(this._treePath(item.level), "r");
    try {
      // A tree file is extended to its level's width before every block in it
      // has been merged, so an unwritten slot is a SPARSE HOLE: the read
      // returns a full-width run of NULs rather than a terminated record.
      // That is a cache miss, not corruption -- every other unreadable case
      // here returns null so the caller re-queues the block for merge. Reading
      // it as a hard failure aborted memtree init for the whole process and
      // silently disabled the memory tree AND the spill store.
      let value;
      try {
        value = readJsonRecord(descriptor, item.lo, TREE_RECORD_BYTES);
      } catch {
        return null;
      }
      if (
        value?.lo !== item.lo
        || value?.hi !== item.hi
        || typeof value?.line !== "string"
      ) {
        return null;
      }
      return value;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  _treePath(level) {
    return path.join(this.treeDir, String(level));
  }

  _withLock(operation) {
    if (this.lockDepth > 0) return operation();
    ensureDir(this.treeDir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: randomBytes(16).toString("hex")
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      let descriptor;
      try {
        descriptor = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, token, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        break;
      } catch (error) {
        try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
        if (error?.code !== "EEXIST") throw error;
        breakStaleLock(this.lockPath, this.staleLockMs);
        if (Date.now() >= deadline) throw new Error("Memory tree is busy.");
        Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === token) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {}
    }
  }
}

export class ScopedMemTree {
  constructor({
    dir,
    env = process.env,
    wakeBudget,
    entryChars
  } = {}) {
    this.dir = path.resolve(dir ?? path.join(resolveDataDir(), "memory", "memtree"));
    this.env = env;
    this.wakeBudget = boundedPositiveInteger(
      wakeBudget ?? env?.OPENAGI_WAKE_BUDGET,
      DEFAULT_WAKE_BUDGET,
      4096
    );
    this.entryChars = boundedPositiveInteger(
      entryChars ?? env?.OPENAGI_MEMORY_ENTRY_CHARS,
      DEFAULT_ENTRY_CHARS,
      300
    );
    this.trees = new Map();
    ensureDir(this.dir);
  }

  note(text, { scope = "main" } = {}) {
    const normalizedScope = normalizeScope(scope);
    const result = this.tree(normalizedScope).note(text);
    return {
      ...result,
      scope: normalizedScope,
      merges: result.merges.map((item) => ({ ...item, scope: normalizedScope }))
    };
  }

  wake({
    scope = "main",
    profileScope = null,
    budget = this.wakeBudget
  } = {}) {
    const scopes = readableMemoryScopes(scope, profileScope);
    const totalBudget = boundedPositiveInteger(budget, this.wakeBudget, 4096);
    const allocations = allocateBudget(totalBudget, scopes.length);
    const sections = [];
    const blocks = [];
    const merges = [];
    let total = 0;
    for (let index = 0; index < scopes.length; index += 1) {
      const currentScope = scopes[index];
      if (allocations[index] < 1) continue;
      const result = this.tree(currentScope).wake(allocations[index]);
      total += result.total;
      if (result.text) {
        sections.push(`[memory-scope ${currentScope}]\n${result.text}`);
      }
      blocks.push(...result.blocks.map((item) => ({ ...item, scope: currentScope })));
      merges.push(...result.merges.map((item) => ({ ...item, scope: currentScope })));
    }
    if (merges.length > 0) {
      sections.push(
        `[memory-merge-requests]\n${merges.map((item) => (
          `- scope=${item.scope} lo=${item.lo} hi=${item.hi} level=${item.level}`
        )).join("\n")}`
      );
    }
    return {
      total,
      budget: totalBudget,
      scopes,
      blocks,
      merges,
      text: sections.join("\n")
    };
  }

  merge(scope, lo, hi, line) {
    const normalizedScope = normalizeScope(scope);
    const result = this.tree(normalizedScope).merge(lo, hi, line);
    return {
      ...result,
      scope: normalizedScope,
      merges: result.merges.map((item) => ({ ...item, scope: normalizedScope }))
    };
  }

  zoom(scope, lo, hi, budget) {
    const normalizedScope = normalizeScope(scope);
    const result = this.tree(normalizedScope).zoom(lo, hi, budget);
    return {
      ...result,
      scope: normalizedScope,
      merges: result.merges.map((item) => ({ ...item, scope: normalizedScope }))
    };
  }

  recall(pattern, {
    scope = "main",
    profileScope = null,
    limit = 20
  } = {}) {
    const scopes = readableMemoryScopes(scope, profileScope);
    const matches = [];
    for (const currentScope of scopes) {
      for (const item of this.tree(currentScope).recall(pattern, { limit })) {
        matches.push({ ...item, scope: currentScope });
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }

  migrate(items = []) {
    const grouped = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const scope = normalizeScope(item?.scope ?? "main");
      if (!grouped.has(scope)) grouped.set(scope, []);
      grouped.get(scope).push(item);
    }
    const results = [];
    for (const [scope, scopedItems] of grouped) {
      results.push({ scope, ...this.tree(scope).migrate(scopedItems) });
    }
    return results;
  }

  tree(scope) {
    const normalizedScope = normalizeScope(scope);
    if (this.trees.has(normalizedScope)) return this.trees.get(normalizedScope);
    const scopeDir = path.join(this.dir, scopeIdentity(normalizedScope));
    ensureDir(scopeDir);
    const markerPath = path.join(scopeDir, "scope.json");
    const marker = readJsonFile(markerPath, null);
    if (marker && (marker.version !== 1 || marker.scope !== normalizedScope)) {
      throw new Error("Memory tree scope marker does not match its directory.");
    }
    if (!marker) writeJsonAtomic(markerPath, { version: 1, scope: normalizedScope });
    const tree = new MemTree({
      dir: scopeDir,
      wakeBudget: this.wakeBudget,
      entryChars: this.entryChars
    });
    this.trees.set(normalizedScope, tree);
    return tree;
  }
}

export function readableMemoryScopes(scope = "main", profileScope = null) {
  const requested = normalizeScope(scope);
  const scopes = [];
  if (requested.startsWith("project:")) {
    const nestedAt = requested.indexOf(":", "project:".length);
    const root = nestedAt === -1 ? requested : requested.slice(0, nestedAt);
    scopes.push(root);
    if (requested !== root) scopes.push(requested);
  } else if (requested.startsWith("profile:")) {
    scopes.push(requested);
  } else {
    scopes.push("main");
    if (requested !== "main") scopes.push(requested);
  }
  if (profileScope) {
    const profile = normalizeScope(profileScope);
    if (profile.startsWith("profile:")) scopes.push(profile);
  }
  return [...new Set(scopes)];
}

function renderMemoryBlock(item) {
  const range = item.size === 1
    ? String(item.lo)
    : `${item.lo}-${item.hi}`;
  const status = item.pending ? " pending" : item.detail ? " detail" : " summary";
  return `- [${range}${status}] ${item.text}`;
}

function normalizeEntryText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Memory note must contain text.");
  return truncateUtf8(text.slice(0, maxChars), LOG_RECORD_BYTES - 1);
}

function normalizeSummaryLine(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Memory summary must contain text.");
  return truncateUtf8(text, TREE_RECORD_BYTES - 48);
}

function encodeTextRecord(value, bytes) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > bytes - 1) throw new RangeError("Fixed-width text record is too large.");
  const record = Buffer.alloc(bytes, 0x20);
  encoded.copy(record);
  record[bytes - 1] = 0x0a;
  return record;
}

function encodeJsonRecord(value, bytes) {
  return encodeTextRecord(JSON.stringify(value), bytes);
}

function readTextRecord(descriptor, index, bytes) {
  const buffer = Buffer.alloc(bytes);
  const count = fs.readSync(descriptor, buffer, 0, bytes, index * bytes);
  if (count !== bytes || buffer[bytes - 1] !== 0x0a) {
    throw new Error("Fixed-width memory record is missing or partial.");
  }
  return buffer.subarray(0, bytes - 1).toString("utf8").trimEnd();
}

function readJsonRecord(descriptor, index, bytes) {
  const text = readTextRecord(descriptor, index, bytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeWholeRecord(descriptor, record, position = null) {
  let written = 0;
  while (written < record.length) {
    const count = fs.writeSync(
      descriptor,
      record,
      written,
      record.length - written,
      position === null ? null : position + written
    );
    if (count < 1) throw new Error("Fixed-width memory record write made no progress.");
    written += count;
  }
}

function openForPositionedWrite(file) {
  try {
    return fs.openSync(file, "r+");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return fs.openSync(file, "w+", 0o600);
  }
}

function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(String(value ?? ""), "utf8");
  if (source.length <= maxBytes) return source.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function normalizeRange(lo, hi, total) {
  const start = Number(lo);
  const end = Number(hi);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > total
  ) {
    throw new RangeError(`Memory range must satisfy 0 <= lo < hi <= ${total}.`);
  }
  return { lo: start, hi: end };
}

function nextPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function compileRecallPattern(value) {
  const pattern = String(value ?? "");
  if (!pattern || pattern.length > MAX_RECALL_PATTERN_CHARS || pattern.includes("\0")) {
    throw new Error("Recall regex must contain 1 through 200 safe characters.");
  }
  if (
    /\\[1-9]/u.test(pattern)
    || /\(\?<[=!]/u.test(pattern)
    || /(?:\*|\+|\{\d+(?:,\d*)?\})(?:\s*)(?:\*|\+|\{)/u.test(pattern)
  ) {
    throw new Error("Recall regex contains a backreference, lookbehind, or nested quantifier.");
  }
  try {
    return new RegExp(pattern, "iu");
  } catch {
    throw new Error("Recall regex is invalid.");
  }
}

function allocateBudget(total, count) {
  if (count < 1) return [];
  if (total < count) {
    const allocations = Array.from({ length: count }, () => 0);
    for (let index = count - total; index < count; index += 1) {
      allocations[index] = 1;
    }
    return allocations;
  }
  const base = Math.max(1, Math.floor(total / count));
  const allocations = Array.from({ length: count }, () => base);
  let used = base * count;
  let index = allocations.length - 1;
  while (used < total) {
    allocations[index] += 1;
    used += 1;
    index = index === 0 ? allocations.length - 1 : index - 1;
  }
  return allocations;
}

function normalizeScope(value) {
  const scope = String(value ?? "main").trim();
  if (
    !scope
    || scope.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u.test(scope)
  ) {
    throw new Error("Memory tree scope is invalid.");
  }
  return scope;
}

function scopeIdentity(scope) {
  return createHash("sha256").update(scope).digest("hex").slice(0, 32);
}

function compareMigratedMemory(left, right) {
  const leftTime = migratedMemoryTime(left);
  const rightTime = migratedMemoryTime(right);
  return leftTime - rightTime
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function migratedMemoryTime(item) {
  const mtime = Number(item?.mtimeMs);
  if (Number.isFinite(mtime)) return mtime;
  const created = Date.parse(item?.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function assertRegularFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
}

function breakStaleLock(lockPath, staleMs) {
  let stat;
  let content;
  try {
    stat = fs.lstatSync(lockPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || Date.now() - stat.mtimeMs < staleMs
    ) {
      return false;
    }
    content = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  let owner;
  try { owner = JSON.parse(content); } catch { owner = null; }
  if (processIsAlive(owner?.pid)) return false;
  try {
    if (fs.readFileSync(lockPath, "utf8") !== content) return false;
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

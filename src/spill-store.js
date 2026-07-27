/*
 * Structured range indexing is adapted from PageIndex:
 * https://github.com/VectifyAI/PageIndex/tree/190f8b378be58199ca993566a9214dba72089c54
 * Copyright (c) 2025 Vectify AI, licensed under the MIT License.
 * This Node.js implementation is original; see THIRD_PARTY_NOTICES.md.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { DEFAULT_SPILL_BYTES } from "../lib/memtree.js";

const SPILL_ID_PATTERN = /^spill_[a-f0-9]{16}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const RANGE_PATTERN = /^([1-9]\d{0,8})-([1-9]\d{0,8})$/u;
const MAX_ENTRIES = 10_000;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_SEGMENTS = 32;
const FIXED_WINDOW_LINES = 200;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export class SpillStore {
  constructor({
    dir,
    spillBytes = DEFAULT_SPILL_BYTES,
    lockTimeoutMs = 2_000,
    staleLockMs = 60_000
  } = {}) {
    this.dir = path.resolve(dir ?? path.join(resolveDataDir(), "spill"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.spillBytes = boundedPositiveInteger(
      spillBytes,
      DEFAULT_SPILL_BYTES,
      MAX_CONTENT_BYTES
    );
    this.lockTimeoutMs = boundedPositiveInteger(lockTimeoutMs, 2_000, 60_000);
    this.staleLockMs = boundedPositiveInteger(
      staleLockMs,
      60_000,
      24 * 60 * 60 * 1000
    );
    this.entries = new Map();
    this.sequence = 0;
    this.lockDepth = 0;
    this.journalHealthy = true;
    ensureDir(this.dir);
    this._withLock(() => this._restore());
  }

  shouldSpill(value) {
    return Buffer.byteLength(serializeSpillValue(value), "utf8") > this.spillBytes;
  }

  put(value, { projectId = "default" } = {}) {
    const content = serializeSpillValue(value);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= this.spillBytes) return null;
    if (bytes > MAX_CONTENT_BYTES) {
      throw new RangeError("Tool spill exceeds its durable content bound.");
    }
    const normalizedProjectId = normalizeProjectId(projectId);
    return this._withLock(() => {
      this._restore();
      if (!this.journalHealthy) {
        throw new Error("Tool spill journal is corrupt.");
      }
      if (this.entries.size >= MAX_ENTRIES) {
        throw new RangeError("Tool spill entry limit reached.");
      }
      const id = this._uniqueId();
      const segments = segmentSpill(content, id);
      const entry = {
        id,
        projectId: normalizedProjectId,
        bytes,
        lines: lineIndex(content).length,
        sha256: digest(content),
        createdAt: new Date().toISOString(),
        segments
      };
      const event = {
        version: 1,
        sequence: this.sequence + 1,
        op: "put",
        entry
      };
      if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) {
        throw new RangeError("Tool spill index event exceeds its bound.");
      }
      const contentPath = this._contentPath(id);
      let committed = false;
      try {
        writeTextAtomic(contentPath, content);
        appendJsonLine(this.eventsPath, event);
        committed = true;
      } catch (error) {
        this._restore();
        committed = this.entries.has(id);
        if (!committed) {
          try { fs.unlinkSync(contentPath); } catch {}
          throw error;
        }
      }
      if (committed && !this.entries.has(id)) {
        this.entries.set(id, entry);
        this.sequence = event.sequence;
      }
      this._writeSnapshotBestEffort();
      return {
        spilled: true,
        id,
        bytes,
        lines: entry.lines,
        segments: structuredClone(segments)
      };
    });
  }

  read(id, range, { projectId = "default" } = {}) {
    const spillId = String(id ?? "");
    if (!SPILL_ID_PATTERN.test(spillId)) throw new Error("Invalid spill id.");
    const normalizedProjectId = normalizeProjectId(projectId);
    let entry = this.entries.get(spillId);
    if (!entry) {
      this._withLock(() => this._restore());
      entry = this.entries.get(spillId);
    }
    if (!entry) throw new Error("Tool spill is unavailable.");
    if (entry.projectId !== normalizedProjectId) {
      const error = new Error("Tool spill is outside the current project.");
      error.code = "PROJECT_BOUNDARY_VIOLATION";
      throw error;
    }
    const content = readBoundedRegularFile(this._contentPath(spillId), MAX_CONTENT_BYTES);
    if (
      Buffer.byteLength(content, "utf8") !== entry.bytes
      || digest(content) !== entry.sha256
    ) {
      throw new Error("Tool spill failed its integrity check.");
    }
    const lines = lineIndex(content);
    const selected = normalizeLineRange(range, lines.length);
    return {
      id: spillId,
      lines: `${selected.start}-${selected.end}`,
      totalLines: lines.length,
      bytes: Buffer.byteLength(
        exactLineSlice(content, lines, selected.start, selected.end),
        "utf8"
      ),
      content: exactLineSlice(content, lines, selected.start, selected.end)
    };
  }

  _restore() {
    const snapshot = normalizeSnapshot(readJsonFile(this.snapshotPath, null));
    let text = "";
    try {
      text = readBoundedRegularFile(this.eventsPath, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.entries = snapshot?.entries ?? new Map();
        this.sequence = snapshot?.sequence ?? 0;
        this.journalHealthy = false;
        return;
      }
    }
    if (!text.trim()) {
      this.entries = snapshot?.entries ?? new Map();
      this.sequence = snapshot?.sequence ?? 0;
      this.journalHealthy = !snapshot || snapshot.sequence === 0;
      return;
    }
    const entries = new Map();
    let sequence = 0;
    let healthy = true;
    for (const line of text.split(/\r?\n/u)) {
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
        healthy = false;
        break;
      }
      let value;
      try { value = JSON.parse(line); } catch {
        healthy = false;
        break;
      }
      const event = normalizeEvent(value);
      if (
        !event
        || event.sequence !== sequence + 1
        || entries.has(event.entry.id)
      ) {
        healthy = false;
        break;
      }
      entries.set(event.entry.id, event.entry);
      sequence = event.sequence;
    }
    if (!healthy && snapshot && snapshot.sequence >= sequence) {
      try {
        console.warn(`[spill] journal replay unhealthy — falling back to snapshot: snapshotSeq=${snapshot.sequence} replaySeq=${sequence} snapshotEntries=${snapshot.entries.size} replayEntries=${entries.size} events=${this.eventsPath}`);
      } catch {}
      this.entries = snapshot.entries;
      this.sequence = snapshot.sequence;
    } else {
      if (!healthy) {
        try {
          console.warn(`[spill] journal replay truncated at sequence=${sequence} and no newer snapshot exists — spill entries after that point are UNRECOVERABLE (${entries.size} entries retained): ${this.eventsPath}`);
        } catch {}
      }
      this.entries = entries;
      this.sequence = sequence;
    }
    this.journalHealthy = healthy;
  }

  _writeSnapshotBestEffort() {
    try {
      writeJsonAtomic(this.snapshotPath, {
        version: 1,
        sequence: this.sequence,
        entries: [...this.entries.values()]
      });
    } catch (error) {
      // Non-fatal: the journal is still authoritative. But a persistently
      // failing snapshot means a future _restore() has to replay the whole
      // journal and loses its corruption backstop — so log the stack.
      try {
        console.warn(`[spill] snapshot refresh failed seq=${this.sequence} entries=${this.entries.size} path=${this.snapshotPath} — journal remains authoritative but corruption recovery is degraded: ${error?.stack ?? error}`);
      } catch {}
    }
  }

  _uniqueId() {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = `spill_${randomBytes(8).toString("hex")}`;
      if (!this.entries.has(id) && !fs.existsSync(this._contentPath(id))) return id;
    }
    throw new Error("Unable to allocate a unique spill id.");
  }

  _contentPath(id) {
    return path.join(this.dir, id);
  }

  _withLock(operation) {
    if (this.lockDepth > 0) return operation();
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
        if (Date.now() >= deadline) throw new Error("Tool spill store is busy.");
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

export function segmentSpill(content, id) {
  const text = String(content ?? "");
  const lines = lineIndex(text);
  const ranges = boundedSegmentRanges(
    headingRanges(text, lines)
      ?? diffRanges(text, lines)
      ?? paragraphRanges(text, lines)
      ?? fixedRanges(lines.length),
    lines.length
  );
  return ranges.map(({ start, end, title }) => {
    const slice = exactLineSlice(text, lines, start, end);
    const firstLine = slice.split(/\r?\n/u)[0]?.trim() ?? "";
    return {
      id,
      title: boundedLabel(title || firstLine || `Lines ${start}-${end}`, 80),
      lines: `${start}-${end}`,
      bytes: Buffer.byteLength(slice, "utf8"),
      firstLine: boundedLabel(firstLine, 100)
    };
  });
}

function headingRanges(content, lines) {
  const headings = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lineText(content, lines[index]);
    if (/^\s*(```|~~~)/u.test(text)) {
      inFence = !inFence;
      continue;
    }
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(text) : null;
    if (match) headings.push({ line: index + 1, title: match[2] });
  }
  if (headings.length === 0) return null;
  const ranges = [];
  if (headings[0].line > 1) {
    ranges.push({ start: 1, end: headings[0].line - 1, title: "Preamble" });
  }
  for (let index = 0; index < headings.length; index += 1) {
    ranges.push({
      start: headings[index].line,
      end: (headings[index + 1]?.line ?? (lines.length + 1)) - 1,
      title: headings[index].title
    });
  }
  return ranges;
}

function diffRanges(content, lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lineText(content, lines[index]);
    if (text.startsWith("diff --git ")) {
      starts.push({ line: index + 1, title: text.slice("diff --git ".length) });
    }
  }
  if (starts.length === 0) return null;
  const ranges = [];
  if (starts[0].line > 1) {
    ranges.push({ start: 1, end: starts[0].line - 1, title: "Diff preamble" });
  }
  for (let index = 0; index < starts.length; index += 1) {
    ranges.push({
      start: starts[index].line,
      end: (starts[index + 1]?.line ?? (lines.length + 1)) - 1,
      title: starts[index].title
    });
  }
  return ranges;
}

function paragraphRanges(content, lines) {
  const ranges = [];
  let start = 1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lineText(content, lines[index]).trim() !== "") continue;
    if (index + 1 > start) {
      ranges.push({ start, end: index, title: "" });
    }
    start = index + 2;
  }
  if (start <= lines.length) ranges.push({ start, end: lines.length, title: "" });
  return ranges.length > 1 ? ranges : null;
}

function fixedRanges(totalLines, window = FIXED_WINDOW_LINES) {
  const ranges = [];
  for (let start = 1; start <= totalLines; start += window) {
    ranges.push({
      start,
      end: Math.min(totalLines, start + window - 1),
      title: `Lines ${start}-${Math.min(totalLines, start + window - 1)}`
    });
  }
  return ranges;
}

function boundedSegmentRanges(ranges, totalLines) {
  if (ranges.length <= MAX_SEGMENTS) return ranges;
  const window = Math.max(
    FIXED_WINDOW_LINES,
    Math.ceil(totalLines / MAX_SEGMENTS)
  );
  return fixedRanges(totalLines, window);
}

function lineIndex(content) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    const contentEnd = index > start && content[index - 1] === "\r"
      ? index - 1
      : index;
    lines.push({ start, contentEnd, next: index + 1 });
    start = index + 1;
  }
  if (start < content.length || lines.length === 0) {
    lines.push({ start, contentEnd: content.length, next: content.length });
  }
  return lines;
}

function exactLineSlice(content, lines, start, end) {
  const first = lines[start - 1];
  const last = lines[end - 1];
  if (!first || !last) return "";
  return content.slice(first.start, last.contentEnd);
}

function lineText(content, line) {
  return content.slice(line.start, line.contentEnd);
}

function normalizeLineRange(value, totalLines) {
  const range = String(value ?? `1-${Math.min(totalLines, FIXED_WINDOW_LINES)}`);
  const match = RANGE_PATTERN.exec(range);
  if (!match) throw new Error("Spill range must use inclusive start-end line numbers.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end > totalLines || end - start + 1 > 2_000) {
    throw new RangeError(`Spill range must select at most 2000 lines within 1-${totalLines}.`);
  }
  return { start, end };
}

function serializeSpillValue(value) {
  if (typeof value === "string") return value;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return typeof encoded === "string" ? encoded : String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function normalizeProjectId(value) {
  const projectId = String(value ?? "default").trim().toLowerCase();
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid spill project id.");
  return projectId;
}

function normalizeEvent(value) {
  const entry = normalizeEntry(value?.entry);
  if (
    value?.version !== 1
    || value?.op !== "put"
    || !Number.isSafeInteger(value?.sequence)
    || value.sequence < 1
    || !entry
  ) {
    return null;
  }
  return { version: 1, sequence: value.sequence, op: "put", entry };
}

function normalizeSnapshot(value) {
  if (
    value?.version !== 1
    || !Number.isSafeInteger(value?.sequence)
    || value.sequence < 0
    || !Array.isArray(value?.entries)
    || value.entries.length > MAX_ENTRIES
  ) {
    return null;
  }
  const entries = new Map();
  for (const raw of value.entries) {
    const entry = normalizeEntry(raw);
    if (!entry || entries.has(entry.id)) return null;
    entries.set(entry.id, entry);
  }
  if (entries.size !== value.sequence) return null;
  return { entries, sequence: value.sequence };
}

function normalizeEntry(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !SPILL_ID_PATTERN.test(value.id)
    || !PROJECT_ID_PATTERN.test(value.projectId)
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || value.bytes > MAX_CONTENT_BYTES
    || !Number.isSafeInteger(value.lines)
    || value.lines < 1
    || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.segments)
    || value.segments.length > MAX_SEGMENTS
  ) {
    return null;
  }
  return structuredClone(value);
}

function readBoundedRegularFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Spill path must be a regular non-symlink file.");
  }
  if (stat.size > maxBytes) throw new RangeError("Spill file exceeds its read bound.");
  return fs.readFileSync(file, "utf8");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedLabel(value, maxChars) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
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

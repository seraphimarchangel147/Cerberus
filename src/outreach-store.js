import fs from "node:fs";
import path from "node:path";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic
} from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Durable, cursor-indexed log of outreach items. Every mutation is appended
// to the authoritative JSONL journal before it becomes visible in memory.
// The atomic snapshot is only a bounded startup accelerator.
//   status: "unseen" | "seen" | "acted" | "dismissed" | "error"

const SNAPSHOT_VERSION = 2;
const MAX_ITEMS = 10_000;
const MAX_ITEM_SEQUENCE = 1_000_000_000;
const MAX_JOURNAL_SEQUENCE = 1_000_000_000;
const MAX_TITLE_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 32_000;
const MAX_ERROR_CHARS = 4_000;
const MAX_ACTIONS = 32;
const MAX_ACTION_CHARS = 64;
const MAX_DECISION_BYTES = 32 * 1024;
const MAX_STATE_BYTES = 12 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 13 * 1024 * 1024;
const JOURNAL_COMPACT_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_LOAD_BYTES = 30 * 1024 * 1024;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const ITEM_ID_RE = /^out_[a-f0-9]{16}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const STATUS_VALUES = new Set(["unseen", "seen", "acted", "dismissed", "error"]);
const ITEM_FIELDS = new Set([
  "actions",
  "createdAt",
  "decision",
  "error",
  "id",
  "lastNudgedAt",
  "needsDecision",
  "outcomeId",
  "projectId",
  "resolvedAt",
  "seq",
  "sourceRef",
  "status",
  "summary",
  "title",
  "type"
]);

export class OutreachStore {
  constructor({ dir, runtime } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "outreach");
    this.runtime = runtime ?? null;
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    ensureDir(this.dir);
    this.items = new Map();
    this.nextSeq = 1;
    this.journalSequence = 0;
    this.needsJournalBaseline = false;
    this._load();
  }

  bindRuntime(runtime) {
    this.runtime = runtime;
  }

  append({
    type,
    sourceRef = null,
    title,
    summary = "",
    needsDecision = false,
    actions = [],
    dedupeOpen = false,
    outcomeId = null,
    projectId = "default"
  }) {
    const normalizedProjectId = normalizeProjectId(projectId);
    const normalizedSourceRef = normalizeSourceRef(sourceRef);
    if (dedupeOpen && normalizedSourceRef?.id) {
      const existing = [...this.items.values()].find((item) => (
        itemProjectId(item) === normalizedProjectId
        && (item.status === "unseen" || item.status === "seen")
        && item.sourceRef?.kind === normalizedSourceRef.kind
        && item.sourceRef?.id === normalizedSourceRef.id
      ));
      if (existing) return existing;
    }
    if (this.items.size >= MAX_ITEMS) {
      throw new RangeError(`Outreach item limit reached (${MAX_ITEMS}).`);
    }
    if (this.nextSeq > MAX_ITEM_SEQUENCE) {
      throw new RangeError("Outreach sequence limit reached.");
    }
    const item = normalizeStoredItem({
      id: createId("out"),
      seq: this.nextSeq,
      projectId: normalizedProjectId,
      type,
      sourceRef: normalizedSourceRef,
      outcomeId,
      title: String(title ?? "").trim() || "(untitled)",
      summary,
      needsDecision: Boolean(needsDecision),
      actions,
      status: "unseen",
      decision: null,
      error: null,
      createdAt: nowIso(),
      resolvedAt: null
    });
    this._commitUpserts("append", [item], item.seq + 1);
    const stored = this.items.get(item.id);
    this.runtime?.events?.emit?.("outreach", stored);
    return stored;
  }

  get(id, { projectId = null } = {}) {
    const item = this.items.get(String(id ?? "")) ?? null;
    if (
      item
      && projectId !== null
      && itemProjectId(item) !== normalizeProjectId(projectId)
    ) {
      return null;
    }
    return item;
  }

  since(cursor = 0, { projectId = null } = {}) {
    const numeric = Number(cursor);
    const boundedCursor = Number.isFinite(numeric) && numeric >= 0
      ? Math.min(MAX_ITEM_SEQUENCE, Math.trunc(numeric))
      : 0;
    const normalizedProjectId = projectId === null ? null : normalizeProjectId(projectId);
    return [...this.items.values()]
      .filter((item) => (
        item.seq > boundedCursor
        && (
          normalizedProjectId === null
          || itemProjectId(item) === normalizedProjectId
        )
      ))
      .sort((left, right) => left.seq - right.seq);
  }

  list({ status, projectId = null } = {}) {
    if (status !== undefined && !STATUS_VALUES.has(status)) return [];
    const normalizedProjectId = projectId === null ? null : normalizeProjectId(projectId);
    const all = [...this.items.values()]
      .filter((item) => (
        normalizedProjectId === null
        || itemProjectId(item) === normalizedProjectId
      ))
      .sort((left, right) => right.seq - left.seq);
    return status ? all.filter((item) => item.status === status) : all;
  }

  markSeen(ids = [], { projectId = null } = {}) {
    const normalizedProjectId = projectId === null ? null : normalizeProjectId(projectId);
    const updates = new Map();
    for (const value of Array.isArray(ids) ? ids : []) {
      const item = this.items.get(String(value ?? ""));
      if (
        item
        && (
          normalizedProjectId === null
          || itemProjectId(item) === normalizedProjectId
        )
        && item.status === "unseen"
      ) {
        updates.set(item.id, normalizeStoredItem({ ...item, status: "seen" }));
      }
    }
    if (updates.size > 0) {
      this._commitUpserts("mark-seen", [...updates.values()], this.nextSeq);
    }
  }

  markNudged(ids = [], { now = new Date(), projectId = null } = {}) {
    const at = normalizeDate(now);
    const normalizedProjectId = projectId === null ? null : normalizeProjectId(projectId);
    const updates = new Map();
    for (const value of Array.isArray(ids) ? ids : []) {
      const item = this.items.get(String(value ?? ""));
      if (
        item
        && (
          normalizedProjectId === null
          || itemProjectId(item) === normalizedProjectId
        )
      ) {
        updates.set(
          item.id,
          normalizeStoredItem({ ...item, lastNudgedAt: at })
        );
      }
    }
    if (updates.size > 0) {
      this._commitUpserts("mark-nudged", [...updates.values()], this.nextSeq);
    }
  }

  resolve(id, decision, {
    status = "acted",
    error = null,
    projectId = null
  } = {}) {
    const item = this.get(id, { projectId });
    if (!item) return null;
    if (item.status === "acted" || item.status === "dismissed") return item;
    const next = normalizeStoredItem({
      ...item,
      status,
      decision: decision ?? null,
      error,
      resolvedAt: nowIso()
    });
    this._commitUpserts("resolve", [next], this.nextSeq);
    const stored = this.items.get(next.id);
    this.runtime?.events?.emit?.("outreach-resolved", stored);
    return stored;
  }

  // Public for existing maintenance/tests that intentionally adjust durable
  // item metadata. Record a full-state journal event so the JSONL remains
  // authoritative even for those direct in-memory adjustments.
  snapshot() {
    const normalized = [...this.items.values()].map(normalizeStoredItem);
    this._commitReplace(normalized, this.nextSeq);
  }

  _commitUpserts(op, updates, nextSeq) {
    const prospective = new Map(this.items);
    for (const item of updates) prospective.set(item.id, item);
    assertStateBounds(prospective, nextSeq);
    if (this.needsJournalBaseline) {
      this._commitReplace([...prospective.values()], nextSeq);
      return;
    }
    const sequence = this._nextJournalSequence();
    const event = {
      version: 1,
      sequence,
      op,
      nextSeq,
      items: updates
    };
    this._appendEvent(event, () => {
      for (const item of updates) this.items.set(item.id, item);
      this.nextSeq = nextSeq;
      this.journalSequence = sequence;
    });
  }

  _commitReplace(items, nextSeq) {
    const prospective = new Map();
    for (const item of items) {
      if (prospective.has(item.id)) throw new Error(`Duplicate outreach item: ${item.id}`);
      prospective.set(item.id, item);
    }
    assertStateBounds(prospective, nextSeq);
    const sequence = this._nextJournalSequence();
    const state = stateValue(prospective, nextSeq, sequence);
    const event = {
      version: 1,
      sequence,
      op: "replace",
      state
    };
    this._appendEvent(event, () => {
      this.items = prospective;
      this.nextSeq = nextSeq;
      this.journalSequence = sequence;
      this.needsJournalBaseline = false;
    });
  }

  _appendEvent(event, apply) {
    if (jsonByteLength(event) > MAX_EVENT_LINE_BYTES) {
      throw new RangeError("Outreach journal event exceeds its persistence bound.");
    }
    let appendError = null;
    try {
      appendJsonLine(this.eventsPath, event);
    } catch (error) {
      appendError = error;
      this._restoreDurableState();
      if (this.journalSequence < event.sequence) throw error;
    }
    if (!appendError) apply();
    this._writeSnapshotBestEffort();
    this._compactJournalBestEffort();
  }

  _nextJournalSequence() {
    if (this.journalSequence >= MAX_JOURNAL_SEQUENCE) {
      throw new RangeError("Outreach journal sequence limit reached.");
    }
    return this.journalSequence + 1;
  }

  _writeSnapshotBestEffort() {
    const state = stateValue(
      this.items,
      this.nextSeq,
      this.journalSequence
    );
    try {
      writeJsonAtomic(this.snapshotPath, {
        version: SNAPSHOT_VERSION,
        writtenAt: nowIso(),
        ...state
      });
    } catch (error) {
      console.warn(`[outreach] snapshot refresh failed: ${error?.message ?? error}`);
    }
  }

  _compactJournalBestEffort() {
    let size;
    try {
      size = fs.statSync(this.eventsPath).size;
    } catch {
      return;
    }
    if (size <= JOURNAL_COMPACT_BYTES) return;
    const event = {
      version: 1,
      sequence: this.journalSequence,
      op: "replace",
      state: stateValue(this.items, this.nextSeq, this.journalSequence)
    };
    try {
      if (jsonByteLength(event) > MAX_EVENT_LINE_BYTES) return;
      writeTextAtomic(this.eventsPath, `${JSON.stringify(event)}\n`);
    } catch (error) {
      console.warn(`[outreach] journal compaction failed: ${error?.message ?? error}`);
    }
  }

  _load() {
    this._loadSnapshot();
    this._replayJournal();
  }

  _restoreDurableState() {
    this.items = new Map();
    this.nextSeq = 1;
    this.journalSequence = 0;
    this.needsJournalBaseline = false;
    this._load();
  }

  _loadSnapshot() {
    let raw;
    try {
      const stat = fs.statSync(this.snapshotPath);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return;
      raw = readJsonFile(this.snapshotPath, null);
    } catch {
      return;
    }
    const state = decodeSnapshot(raw);
    if (!state) return;
    this.items = state.items;
    this.nextSeq = state.nextSeq;
    this.journalSequence = state.sequence;
    this.needsJournalBaseline = this.items.size > 0 && this.journalSequence === 0;
  }

  _replayJournal() {
    let text;
    try {
      const stat = fs.statSync(this.eventsPath);
      if (!stat.isFile() || stat.size > MAX_JOURNAL_LOAD_BYTES) return;
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch {
      return;
    }
    forEachLine(text, (line) => {
      if (!line || Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) return true;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      return this._applyJournalEvent(event);
    });
  }

  _applyJournalEvent(event) {
    if (
      !isPlainRecord(event)
      || event.version !== 1
      || !Number.isSafeInteger(event.sequence)
      || event.sequence < 1
      || event.sequence > MAX_JOURNAL_SEQUENCE
      || typeof event.op !== "string"
    ) {
      return true;
    }
    if (event.sequence <= this.journalSequence) return true;
    if (event.op === "replace") {
      const state = decodeState(event.state);
      if (!state || state.sequence !== event.sequence) return true;
      this.items = state.items;
      this.nextSeq = state.nextSeq;
      this.journalSequence = state.sequence;
      this.needsJournalBaseline = false;
      return true;
    }
    if (event.sequence !== this.journalSequence + 1) {
      return false;
    }
    if (
      !["append", "mark-seen", "mark-nudged", "resolve"].includes(event.op)
      || !Array.isArray(event.items)
      || event.items.length < 1
      || event.items.length > MAX_ITEMS
      || !Number.isSafeInteger(event.nextSeq)
      || event.nextSeq < 1
      || event.nextSeq > MAX_ITEM_SEQUENCE + 1
    ) {
      return true;
    }
    const prospective = new Map(this.items);
    try {
      for (const raw of event.items) {
        const item = normalizeStoredItem(raw);
        prospective.set(item.id, item);
      }
      assertStateBounds(prospective, event.nextSeq);
    } catch {
      return true;
    }
    this.items = prospective;
    this.nextSeq = event.nextSeq;
    this.journalSequence = event.sequence;
    this.needsJournalBaseline = false;
    return true;
  }
}

function decodeSnapshot(value) {
  if (!isPlainRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return null;
  }
  const sequence = value.version === 2 ? value.sequence : 0;
  return decodeState({
    sequence,
    nextSeq: value.nextSeq,
    items: value.items
  });
}

function decodeState(value) {
  if (
    !isPlainRecord(value)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || value.sequence > MAX_JOURNAL_SEQUENCE
    || !Array.isArray(value.items)
    || value.items.length > MAX_ITEMS
  ) {
    return null;
  }
  const items = new Map();
  const itemSequences = new Set();
  let highestItemSequence = 0;
  try {
    for (const raw of value.items) {
      const item = normalizeStoredItem(raw);
      if (items.has(item.id) || itemSequences.has(item.seq)) return null;
      items.set(item.id, item);
      itemSequences.add(item.seq);
      highestItemSequence = Math.max(highestItemSequence, item.seq);
    }
    if (highestItemSequence !== items.size) return null;
    const nextSeq = highestItemSequence + 1;
    if (
      value.nextSeq !== undefined
      && (
        !Number.isSafeInteger(value.nextSeq)
        || value.nextSeq !== nextSeq
      )
    ) {
      return null;
    }
    const effectiveNextSeq = value.nextSeq ?? nextSeq;
    assertStateBounds(items, effectiveNextSeq);
    return {
      sequence: value.sequence,
      nextSeq: effectiveNextSeq,
      items
    };
  } catch {
    return null;
  }
}

function normalizeStoredItem(value) {
  if (!isPlainRecord(value)) throw new TypeError("Invalid outreach item.");
  assertOnlyKeys(value, ITEM_FIELDS);
  const id = requiredPattern(value.id, ITEM_ID_RE, "item id");
  if (
    !Number.isSafeInteger(value.seq)
    || value.seq < 1
    || value.seq > MAX_ITEM_SEQUENCE
  ) {
    throw new TypeError("Invalid outreach item sequence.");
  }
  const status = requiredPattern(value.status, IDENTIFIER_RE, "status");
  if (!STATUS_VALUES.has(status)) throw new TypeError("Invalid outreach status.");
  if (typeof value.needsDecision !== "boolean") {
    throw new TypeError("Invalid outreach decision flag.");
  }
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS) {
    throw new TypeError("Invalid outreach actions.");
  }
  const actions = value.actions.map((action) => {
    const text = requiredText(action, MAX_ACTION_CHARS, "action");
    if (!IDENTIFIER_RE.test(text)) throw new TypeError("Invalid outreach action.");
    return text;
  });
  return {
    id,
    seq: value.seq,
    projectId: normalizeProjectId(value.projectId ?? "default"),
    type: requiredPattern(value.type, IDENTIFIER_RE, "type"),
    sourceRef: normalizeSourceRef(value.sourceRef ?? null),
    outcomeId: optionalIdentifier(value.outcomeId, SOURCE_ID_RE, "outcomeId"),
    title: requiredText(value.title, MAX_TITLE_CHARS, "title"),
    summary: optionalText(value.summary, MAX_SUMMARY_CHARS, "summary") ?? "",
    needsDecision: value.needsDecision,
    actions,
    status,
    decision: boundedDecision(value.decision ?? null),
    error: optionalText(value.error, MAX_ERROR_CHARS, "error"),
    createdAt: requiredIso(value.createdAt),
    resolvedAt: optionalIso(value.resolvedAt),
    ...(value.lastNudgedAt === undefined
      ? {}
      : { lastNudgedAt: optionalIso(value.lastNudgedAt) })
  };
}

function normalizeSourceRef(value) {
  if (value == null) return null;
  if (!isPlainRecord(value)) throw new TypeError("Invalid outreach sourceRef.");
  assertOnlyKeys(value, new Set(["id", "kind"]));
  return {
    kind: requiredPattern(value.kind, IDENTIFIER_RE, "source kind"),
    id: requiredPattern(value.id, SOURCE_ID_RE, "source id")
  };
}

function normalizeProjectId(value) {
  if (typeof value !== "string") throw new TypeError("projectId must be a string");
  const projectId = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new TypeError(`Invalid projectId: ${projectId || "(empty)"}`);
  }
  return projectId;
}

function itemProjectId(item) {
  if (item?.projectId === undefined || item?.projectId === null) return "default";
  try {
    return normalizeProjectId(item.projectId);
  } catch {
    return null;
  }
}

function stateValue(items, nextSeq, sequence) {
  return {
    sequence,
    nextSeq,
    items: [...items.values()].map((item) => structuredClone(item))
  };
}

function assertStateBounds(items, nextSeq) {
  if (items.size > MAX_ITEMS) {
    throw new RangeError(`Outreach item limit reached (${MAX_ITEMS}).`);
  }
  if (
    !Number.isSafeInteger(nextSeq)
    || nextSeq < 1
    || nextSeq > MAX_ITEM_SEQUENCE + 1
  ) {
    throw new RangeError("Outreach cursor is outside its persistence bound.");
  }
  const sequences = new Set();
  let highestSequence = 0;
  for (const item of items.values()) {
    if (sequences.has(item.seq)) {
      throw new RangeError("Outreach state contains duplicate cursors.");
    }
    sequences.add(item.seq);
    highestSequence = Math.max(highestSequence, item.seq);
  }
  if (highestSequence !== items.size || nextSeq !== highestSequence + 1) {
    throw new RangeError("Outreach state contains a cursor gap.");
  }
  if (
    jsonByteLength({
      sequence: 0,
      nextSeq,
      items: [...items.values()]
    }) > MAX_STATE_BYTES
  ) {
    throw new RangeError("Outreach state exceeds its persistence bound.");
  }
}

function requiredPattern(value, pattern, field) {
  const text = requiredText(value, 128, field);
  if (!pattern.test(text)) throw new TypeError(`Invalid outreach ${field}.`);
  return text;
}

function requiredText(value, maxLength, field) {
  if (typeof value !== "string") throw new TypeError(`Invalid outreach ${field}.`);
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new RangeError(`Invalid outreach ${field}.`);
  }
  return text;
}

function optionalText(value, maxLength, field) {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError(`Invalid outreach ${field}.`);
  if (value.length > maxLength) throw new RangeError(`Invalid outreach ${field}.`);
  return value;
}

function optionalIdentifier(value, pattern, field) {
  if (value == null) return null;
  const text = requiredText(value, 256, field);
  if (!pattern.test(text)) throw new TypeError(`Invalid outreach ${field}.`);
  return text;
}

function requiredIso(value) {
  const iso = optionalIso(value);
  if (!iso) throw new TypeError("Invalid outreach timestamp.");
  return iso;
}

function optionalIso(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 64) {
    throw new TypeError("Invalid outreach timestamp.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Invalid outreach timestamp.");
  return new Date(timestamp).toISOString();
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid outreach date.");
  return date.toISOString();
}

function boundedDecision(value) {
  if (value !== null && !isPlainRecord(value)) {
    throw new TypeError("Invalid outreach decision.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Invalid outreach decision.");
  }
  if (
    serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > MAX_DECISION_BYTES
  ) {
    throw new RangeError("Outreach decision exceeds its persistence bound.");
  }
  return JSON.parse(serialized);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported outreach field: ${key}`);
  }
}

function jsonByteLength(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Outreach value is not serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

function forEachLine(text, visitor) {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (visitor(line) === false) return;
    if (newline === -1) return;
    start = newline + 1;
  }
}

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
    this.dir = options.dir ?? path.join(dataDir, "checkpoints");
    this.blobsDir = path.join(this.dir, "blobs");
    this.indexPath = path.join(this.dir, "index.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.workspaceDir = path.resolve(options.workspaceDir ?? DEFAULT_WORKSPACE);
    this.allowedRoots = uniquePaths(options.allowedRoots ?? [this.workspaceDir, dataDir, os.tmpdir()]);
    this.enabled = options.enabled ?? checkpointsEnabled();
    this.now = typeof options.now === "function" ? options.now : nowIso;
    this.idFactory = typeof options.idFactory === "function" ? options.idFactory : () => createId("cp");
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.previewMaxChars = positiveInteger(options.previewMaxChars, DEFAULT_PREVIEW_CHARS);
    this.checkpoints = new Map();
    this.dedupe = new Map();
    this.nextSequence = 1;

    // Disabled mode is deliberately inert: no mkdir, stat, read, or replay.
    if (!this.enabled) return;
    ensureDir(this.dir);
    this._loadSnapshot();
    this._replayIndex();
    this._rebuildDedupe();
  }

  beforeToolCall({ toolName, args = {}, context = {} } = {}) {
    if (!this.enabled) return emptyCapture(false);
    const name = String(toolName ?? "");
    let destructive = false;
    let targets = [];

    if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
      destructive = true;
      if (!nonEmpty(args.path)) {
        throw new CheckpointTargetError(`${name} requires a concrete path before checkpointing`);
      }
      targets = [this._resolveOperand(args.path, this.workspaceDir)];
    } else if (name === "code_shell") {
      const extracted = extractShellMutationTargets(args.command, {
        cwd: args.cwd ? this._resolveOperand(args.cwd, this.workspaceDir) : this.workspaceDir
      });
      destructive = extracted.destructive;
      targets = extracted.targets.map((target) => this._resolveOperand(target, extracted.cwd));
    }

    if (!destructive) return emptyCapture(true);
    targets = [...new Set(targets)];
    if (targets.length === 0) {
      throw new CheckpointTargetError(`Destructive ${name} call had no safely resolvable targets`);
    }
    for (const target of targets) this._assertAllowed(target);
    const turnId = nonEmpty(context.__turnId ?? context.__checkpointTurnId ?? context.turnId)
      ? String(context.__turnId ?? context.__checkpointTurnId ?? context.turnId)
      : createId("turn");
    const checkpoints = this.capture({
      turnId,
      sessionId: context.sessionId ?? null,
      toolName: name,
      targets
    });
    return { enabled: true, destructive: true, targets, checkpoints };
  }

  capture({ turnId, sessionId = null, toolName = "unknown", targets } = {}) {
    if (!this.enabled) return [];
    if (!nonEmpty(turnId)) throw new TypeError("checkpoint capture requires turnId");
    const incoming = Array.isArray(targets) ? targets : [];
    if (incoming.length === 0) return [];

    const groups = new Map();
    for (const value of incoming) {
      const raw = typeof value === "object" && value !== null ? value.path : value;
      if (!nonEmpty(raw)) throw new CheckpointTargetError("checkpoint target path is required");
      const target = path.resolve(String(raw));
      this._assertAllowed(target);
      const kind = lstatKind(target);
      const directory = kind === "directory" ? target : path.dirname(target);
      if (!groups.has(directory)) groups.set(directory, []);
      groups.get(directory).push(target);
    }

    const out = [];
    for (const [directory, roots] of groups) {
      const key = dedupeKey(turnId, directory);
      const existing = this.dedupe.get(key) ? this.checkpoints.get(this.dedupe.get(key)) : null;
      const seen = new Set((existing?.targets ?? []).map((target) => target.path));
      const budget = {
        files: existing?.targets?.length ?? 0,
        bytes: existing?.capturedBytes ?? 0
      };
      const records = [];
      for (const root of [...new Set(roots)].sort()) {
        this._collectTarget(root, records, seen, budget, true);
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

  get(id) {
    if (!this.enabled || !nonEmpty(id)) return null;
    return this._view(this.checkpoints.get(String(id)) ?? null);
  }

  list({ limit = 10, sessionId, directory } = {}) {
    if (!this.enabled) return [];
    const bounded = Math.max(0, Math.min(100, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 10));
    const wantedDir = nonEmpty(directory) ? path.resolve(String(directory)) : null;
    const wantedSession = sessionId == null ? sessionId : String(sessionId);
    return [...this.checkpoints.values()]
      .filter((checkpoint) => sessionId === undefined || checkpoint.sessionId === wantedSession)
      .filter((checkpoint) => !wantedDir || checkpoint.directory === wantedDir)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, bounded)
      .map((checkpoint) => this._view(checkpoint));
  }

  preview(id, { path: selectedPath } = {}) {
    if (!this.enabled) return null;
    const checkpoint = this.checkpoints.get(String(id));
    if (!checkpoint) return null;
    const targets = this._selectTargets(checkpoint, selectedPath);
    const files = [];
    let remaining = this.previewMaxChars;
    let truncated = false;

    for (const target of targets) {
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

  rollback(id, { path: selectedPath, decidedBy = "system", sessionId } = {}) {
    if (!this.enabled) return null;
    const current = this.checkpoints.get(String(id));
    if (!current) return null;
    const wantedSession = sessionId == null ? sessionId : String(sessionId);
    if (sessionId !== undefined && current.sessionId !== wantedSession) {
      throw new Error(`Checkpoint ${current.id} does not belong to this session`);
    }
    const targets = this._selectTargets(current, selectedPath);
    if (targets.length === 0) throw new Error("checkpoint contains no matching targets");

    const blobs = new Map();
    for (const target of targets) {
      this._assertAllowed(target.path);
      if (target.kind === "file") blobs.set(target.path, this._readVerifiedBlob(target));
    }

    const removed = [];
    const restored = [];
    const missing = targets.filter((target) => target.kind === "missing")
      .sort((a, b) => b.path.length - a.path.length);
    for (const target of missing) {
      this._assertSafeRemoval(target.path);
      if (fs.existsSync(target.path) || isSymlink(target.path)) {
        fs.rmSync(target.path, { recursive: true, force: true });
        removed.push(target.path);
      }
    }

    const directories = targets.filter((target) => target.kind === "directory")
      .sort((a, b) => a.path.length - b.path.length);
    for (const target of directories) {
      if (fs.existsSync(target.path) && lstatKind(target.path) !== "directory") {
        fs.rmSync(target.path, { recursive: true, force: true });
      }
      ensureDir(target.path);
      safeChmod(target.path, target.mode);
      restored.push(target.path);
    }

    for (const target of targets.filter((entry) => entry.kind === "file")) {
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
      ensureDir(path.dirname(target.path));
      fs.rmSync(target.path, { recursive: true, force: true });
      fs.symlinkSync(target.linkTarget, target.path);
      restored.push(target.path);
    }

    const at = this._now();
    const event = {
      at,
      decidedBy: String(decidedBy ?? "system"),
      path: selectedPath == null ? null : String(selectedPath),
      restored: [...restored],
      removed: [...removed]
    };
    const next = {
      ...clone(current),
      revision: current.revision + 1,
      updatedAt: at,
      rollbacks: [...current.rollbacks, event]
    };
    this._persist("rollback", next, event);
    return { checkpointId: current.id, restored, removed, at };
  }

  _collectTarget(targetPath, records, seen, budget, root = false) {
    const target = path.resolve(targetPath);
    this._assertAllowed(target);
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
      for (const entry of entries) this._collectTarget(path.join(target, entry), records, seen, budget, false);
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
    if (fs.existsSync(blobPath)) return;
    writeBufferAtomic(blobPath, data, 0o600);
  }

  _readVerifiedBlob(target) {
    const data = fs.readFileSync(this._blobPath(target.hash));
    if (sha256(data) !== target.hash) {
      throw new Error(`Checkpoint blob failed integrity check for ${target.path}`);
    }
    return data;
  }

  _blobPath(hash) {
    return path.join(this.blobsDir, hash.slice(0, 2), hash);
  }

  _selectTargets(checkpoint, selectedPath) {
    if (!nonEmpty(selectedPath)) return checkpoint.targets.map(clone);
    const selected = path.isAbsolute(String(selectedPath))
      ? path.resolve(String(selectedPath))
      : path.resolve(checkpoint.directory, String(selectedPath));
    this._assertAllowed(selected);
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
    appendJsonLine(this.indexPath, event);
    this.checkpoints.set(checkpoint.id, clone(checkpoint));
    this._rebuildDedupe();
    writeCheckpointSnapshot(this.snapshotPath, {
      version: 1,
      updatedAt: this._now(),
      nextSequence: this.nextSequence,
      checkpoints: [...this.checkpoints.values()].sort((a, b) => a.sequence - b.sequence)
    });
  }

  _loadSnapshot() {
    let snapshot;
    try { snapshot = readJsonFile(this.snapshotPath, null); } catch { return; }
    if (!Array.isArray(snapshot?.checkpoints)) return;
    for (const checkpoint of snapshot.checkpoints) {
      if (!validCheckpoint(checkpoint)) continue;
      this.checkpoints.set(checkpoint.id, clone(checkpoint));
      this.nextSequence = Math.max(this.nextSequence, checkpoint.sequence + 1);
    }
    if (Number.isSafeInteger(snapshot.nextSequence)) {
      this.nextSequence = Math.max(this.nextSequence, snapshot.nextSequence);
    }
  }

  _replayIndex() {
    let text;
    try { text = fs.readFileSync(this.indexPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const checkpoint = event?.checkpoint;
      if (!validCheckpoint(checkpoint) || event.id !== checkpoint.id || event.revision !== checkpoint.revision) continue;
      const current = this.checkpoints.get(checkpoint.id);
      if (!current || checkpoint.revision >= current.revision) this.checkpoints.set(checkpoint.id, clone(checkpoint));
      this.nextSequence = Math.max(this.nextSequence, checkpoint.sequence + 1);
    }
  }

  _rebuildDedupe() {
    this.dedupe = new Map();
    for (const checkpoint of this.checkpoints.values()) {
      const key = dedupeKey(checkpoint.turnId, checkpoint.directory);
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

  _assertAllowed(value) {
    const target = path.resolve(value);
    const lexical = this.allowedRoots.some((root) => target === root || target.startsWith(root + path.sep));
    const realTarget = resolveThroughExistingAncestor(target);
    const real = this.allowedRoots.map(resolveThroughExistingAncestor)
      .some((root) => realTarget === root || realTarget.startsWith(root + path.sep));
    if (!lexical || !real) {
      throw new CheckpointTargetError(`Checkpoint target is outside allowed roots: ${target}`);
    }
  }

  _assertSafeRemoval(value) {
    const target = path.resolve(value);
    this._assertAllowed(target);
    if (this.allowedRoots.some((root) => target === root)) {
      throw new Error(`Refusing to remove checkpoint root path: ${target}`);
    }
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

function validCheckpoint(value) {
  return Boolean(
    value
    && typeof value === "object"
    && nonEmpty(value.id)
    && Number.isSafeInteger(value.sequence)
    && Number.isSafeInteger(value.revision)
    && nonEmpty(value.turnId)
    && nonEmpty(value.directory)
    && Array.isArray(value.toolNames)
    && Array.isArray(value.targets)
    && Array.isArray(value.rollbacks)
  );
}

function emptyCapture(enabled) {
  return { enabled, destructive: false, targets: [], checkpoints: [] };
}

function dedupeKey(turnId, directory) {
  return `${String(turnId)}\u0000${path.resolve(directory)}`;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
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

function clone(value) {
  return structuredClone(value);
}

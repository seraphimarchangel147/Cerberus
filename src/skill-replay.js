// Skill replay — parses a structured action list out of a SKILL.md
// (under a `replay:` YAML key in frontmatter or after a `---` separator)
// and routes it to the Mac app for execution. Mac picks up the request
// via SSE and runs the action vocabulary; results post back to
// POST /skills/replay-result/<jobId>.

import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const ALLOWED_ACTIONS = new Set([
  "open_app",
  "wait",
  "keyboard_shortcut",
  "type",
  "press",
  "applescript",
  "shortcut",
  "say",
  "browser",
  "comment"
]);
const REPLAY_JOB_ID_RE = /^rep_[a-f0-9]{16}$/;
const REPLAY_STATUSES = new Set([
  "queued",
  "completed",
  "dry-run-complete",
  "error",
  "interrupted",
  "timed-out"
]);
const DEFAULT_MAX_REPLAY_FILES = 1000;
const DEFAULT_MAX_REPLAY_JOB_BYTES = 1024 * 1024;
const DEFAULT_MAX_REPLAY_LIST_LIMIT = 200;
const DEFAULT_REPLAY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REPLAY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillReplay {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.replayDir = path.join(this.dataDir, "replay");
    ensureDir(this.replayDir);
    this.instanceId = options.instanceId ?? createId("rpi");
    this.maxReplayFiles = positiveInteger(
      options.maxReplayFiles,
      DEFAULT_MAX_REPLAY_FILES
    );
    this.maxReplayJobBytes = positiveInteger(
      options.maxReplayJobBytes,
      DEFAULT_MAX_REPLAY_JOB_BYTES
    );
    this.maxReplayListLimit = positiveInteger(
      options.maxReplayListLimit,
      DEFAULT_MAX_REPLAY_LIST_LIMIT
    );
    this.events = options.events ?? null; // EventEmitter from hosted-interface
    this.pendingResults = new Map(); // jobId → { resolve, reject, timeout }
    this._interruptRecoveredJobs();
  }

  bindEvents(emitter) {
    this.events = emitter;
  }

  /**
   * Read a skill's replay steps. Returns parsed actions or null if the skill
   * has no replay block (i.e. it's a prompt-style skill).
   */
  loadReplaySteps(skillName) {
    const normalizedSkill = normalizeSkillName(skillName);
    const skillDir = path.join(this.dataDir, "skills", normalizedSkill);
    const file = path.join(skillDir, "SKILL.md");
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size > this.maxReplayJobBytes
    ) {
      throw new Error(`Skill '${normalizedSkill}' replay source is not a bounded regular file.`);
    }
    const text = fs.readFileSync(file, "utf8");
    return parseReplayBlock(text);
  }

  /**
   * Trigger a replay. Returns a promise that resolves with the Mac-side
   * execution result, or rejects on timeout.
   *
   *   await replay.run({ skill: "morning-brief", dryRun: false })
   */
  async run({
    skill,
    steps,
    dryRun = false,
    confirm = "first-run",
    timeoutMs = DEFAULT_REPLAY_TIMEOUT_MS,
    projectId = "default"
  } = {}) {
    const normalizedSkill = skill == null ? null : normalizeSkillName(skill);
    const normalizedProjectId = normalizeProjectId(projectId);
    const boundedTimeoutMs = replayTimeoutMs(timeoutMs);
    if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean.");
    if (
      typeof confirm !== "string"
      || confirm.length === 0
      || confirm.length > 64
    ) {
      throw new TypeError("confirm must be a bounded string.");
    }
    if (!steps && normalizedSkill) steps = this.loadReplaySteps(normalizedSkill);
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`Skill '${skill ?? "(none)"}' has no replay steps to run.`);
    }
    const validation = validateSteps(steps);
    if (!validation.ok) throw new Error(`Invalid replay steps: ${validation.errors.join("; ")}`);

    if (!this.events) throw new Error("Replay needs the SSE events emitter; bind it from hosted-interface.");

    const jobId = createId("rep");
    const job = {
      id: jobId,
      projectId: normalizedProjectId,
      skill: normalizedSkill,
      steps,
      dryRun,
      confirm,
      createdAt: nowIso(),
      status: "queued",
      instanceId: this.instanceId
    };
    if (serializedBytes(job) > this.maxReplayJobBytes) {
      const error = new RangeError("Replay job exceeds the persistence size limit.");
      error.code = "REPLAY_JOB_TOO_LARGE";
      throw error;
    }
    writeJsonAtomic(path.join(this.replayDir, `${jobId}.json`), job);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(jobId);
        const message = `Replay timed out after ${boundedTimeoutMs}ms (no Mac client response)`;
        this._markTimedOut(jobId, message);
        reject(new Error(message));
      }, boundedTimeoutMs);
      this.pendingResults.set(jobId, { resolve, reject, timer });
      this.events.emit("replay", {
        op: "request",
        projectId: job.projectId,
        jobId,
        skill: normalizedSkill,
        steps,
        dryRun,
        confirm
      });
    });
  }

  /**
   * Called from POST /skills/replay-result/:jobId once the Mac side finishes.
   */
  resolveJob(jobId, result, { projectId = null } = {}) {
    const id = normalizeReplayJobId(jobId);
    const file = path.join(this.replayDir, `${id}.json`);
    const existing = this._readJobFile(file);
    if (!existing) return null;
    if (
      projectId != null
      && replayProjectId(existing) !== String(projectId)
    ) {
      return null;
    }
    if (existing.status !== "queued") return existing;
    existing.status = result?.error ? "error" : (result?.dryRun ? "dry-run-complete" : "completed");
    existing.result = result;
    existing.resolvedAt = nowIso();
    if (serializedBytes(existing) > this.maxReplayJobBytes) {
      const error = new RangeError("Replay result exceeds the persistence size limit.");
      error.code = "REPLAY_RESULT_TOO_LARGE";
      throw error;
    }
    writeJsonAtomic(file, existing);
    const pending = this.pendingResults.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResults.delete(id);
      if (result?.error) pending.reject(new Error(result.error));
      else pending.resolve(result);
    }
    // Outcome feedback for the propagation layer.
    if (this.runtime?.outcomes && existing.skill) {
      const outcome = this.runtime.outcomes.record({
        kind: "skill-replay",
        refId: jobId,
        metadata: { skill: existing.skill, dryRun: existing.dryRun }
      });
      this.runtime.outcomes.resolve(outcome.id, result?.error ? 0.0 : (result?.dryRun ? 0.5 : 0.9), "system-inferred");
    }
    return existing;
  }

  list({ status = null, limit = 50, projectId = null } = {}) {
    try {
      let entries = this._jobFiles()
        .map((file) => this._readJobFile(file))
        .filter(Boolean);
      if (projectId != null) {
        entries = entries.filter(
          (job) => replayProjectId(job) === String(projectId)
        );
      }
      if (status) entries = entries.filter((j) => j.status === status);
      const boundedLimit = Math.min(
        this.maxReplayListLimit,
        positiveInteger(limit, 50)
      );
      return entries
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, boundedLimit);
    } catch { return []; }
  }

  _jobFiles() {
    const files = [];
    let scanned = 0;
    let directory;
    try {
      directory = fs.opendirSync(this.replayDir);
      while (scanned < this.maxReplayFiles) {
        const entry = directory.readSync();
        if (!entry) break;
        scanned += 1;
        if (
          entry.isFile()
          && entry.name.endsWith(".json")
          && REPLAY_JOB_ID_RE.test(entry.name.slice(0, -5))
        ) {
          files.push(path.join(this.replayDir, entry.name));
        }
      }
    } catch {
      return [];
    } finally {
      try { directory?.closeSync(); } catch { /* best effort */ }
    }
    return files;
  }

  _readJobFile(file) {
    try {
      const stat = fs.statSync(file);
      if (
        !stat.isFile()
        || stat.size <= 0
        || stat.size > this.maxReplayJobBytes
      ) {
        return null;
      }
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      return validReplayJob(job, path.basename(file, ".json")) ? job : null;
    } catch {
      return null;
    }
  }

  _interruptRecoveredJobs() {
    const interruptedAt = nowIso();
    for (const file of this._jobFiles()) {
      const job = this._readJobFile(file);
      if (!job || job.status !== "queued") continue;
      job.status = "interrupted";
      job.error = "Replay was interrupted by a process restart; uncertain UI side effects were not replayed.";
      job.interruptedAt = interruptedAt;
      job.resolvedAt = interruptedAt;
      job.recoveredByInstanceId = this.instanceId;
      try {
        writeJsonAtomic(file, job);
      } catch {
        // A read-only or disappearing file is ignored rather than replayed.
      }
    }
  }

  _markTimedOut(jobId, message) {
    const file = path.join(this.replayDir, `${jobId}.json`);
    const job = this._readJobFile(file);
    if (!job || job.status !== "queued") return;
    const at = nowIso();
    const next = {
      ...job,
      status: "timed-out",
      error: message,
      resolvedAt: at
    };
    try {
      writeJsonAtomic(file, next);
    } catch {
      // The in-memory waiter still terminates; restart reconciliation marks
      // an uncertain queued record interrupted rather than replaying it.
    }
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function replayProjectId(job) {
  return String(job?.projectId ?? "default");
}

function normalizeProjectId(value) {
  const projectId = String(value ?? "default").trim().toLowerCase() || "default";
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new TypeError("Invalid replay project id.");
  }
  return projectId;
}

function normalizeSkillName(value) {
  if (typeof value !== "string") throw new TypeError("Invalid replay skill name.");
  const skill = value.trim();
  if (skill.length > 128 || !SKILL_SLUG_RE.test(skill)) {
    throw new TypeError("Invalid replay skill name.");
  }
  return skill;
}

function replayTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_REPLAY_TIMEOUT_MS;
  return Math.min(parsed, MAX_REPLAY_TIMEOUT_MS);
}

function validReplayJob(job, expectedId) {
  if (
    !job
    || typeof job !== "object"
    || Array.isArray(job)
    || job.id !== expectedId
    || !REPLAY_JOB_ID_RE.test(job.id)
    || !REPLAY_STATUSES.has(job.status)
    || typeof job.createdAt !== "string"
    || !Number.isFinite(Date.parse(job.createdAt))
    || (job.skill != null && (
      typeof job.skill !== "string"
      || job.skill.length > 128
      || !SKILL_SLUG_RE.test(job.skill)
    ))
    || typeof job.dryRun !== "boolean"
    || typeof job.confirm !== "string"
    || job.confirm.length === 0
    || job.confirm.length > 64
    || !Array.isArray(job.steps)
    || job.steps.length === 0
    || !validateSteps(job.steps).ok
  ) {
    return false;
  }
  if (
    job.projectId !== undefined
    && !PROJECT_ID_RE.test(job.projectId)
  ) {
    return false;
  }
  if (
    job.instanceId !== undefined
    && (
      typeof job.instanceId !== "string"
      || job.instanceId.length === 0
      || job.instanceId.length > 128
    )
  ) {
    return false;
  }
  return true;
}

function normalizeReplayJobId(value) {
  const id = String(value ?? "").trim();
  if (!REPLAY_JOB_ID_RE.test(id)) {
    const error = new TypeError("Invalid replay job id.");
    error.code = "INVALID_REPLAY_JOB_ID";
    throw error;
  }
  return id;
}

// MARK: — frontmatter parsing

/**
 * Extract a list of action steps from a SKILL.md. Looks for, in order:
 *   1. `replay:` key in YAML frontmatter (between `---` markers) with a list
 *   2. A fenced ```yaml (or ```replay) code block with a top-level `steps:` list
 * Returns null if no replay is defined (the skill is prompt-style only).
 */
export function parseReplayBlock(text) {
  if (!text) return null;

  // 1) frontmatter
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const block = fm[1];
    const idx = block.search(/^replay\s*:/m);
    if (idx >= 0) {
      // very small YAML-list parser — supports:
      //   replay:
      //     - open_app: "Linear"
      //     - wait: 1.5
      //     - keyboard_shortcut: "cmd+k"
      const rest = block.slice(idx);
      return parseYamlList(rest);
    }
  }

  // 2) fenced code block
  const fence = /```(?:yaml|replay)\s*\n([\s\S]*?)```/m.exec(text);
  if (fence) {
    return parseYamlList(`replay:\n${fence[1].split("\n").map((l) => "  " + l).join("\n")}`);
  }

  return null;
}

function parseYamlList(blockText) {
  const lines = blockText.split(/\r?\n/);
  const steps = [];
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "replay:") continue;
    if (!line.startsWith(" ")) break; // out of replay block
    if (!trimmed.startsWith("-")) continue;
    const inner = trimmed.replace(/^-\s*/, "");
    const colon = inner.indexOf(":");
    if (colon < 0) continue;
    const key = inner.slice(0, colon).trim();
    let value = inner.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (!isNaN(Number(value))) {
      value = Number(value);
    }
    steps.push({ [key]: value });
  }
  return steps.length ? steps : null;
}

function validateSteps(steps) {
  const errors = [];
  steps.forEach((step, i) => {
    if (typeof step !== "object" || step === null) {
      errors.push(`step ${i}: must be an object`);
      return;
    }
    const keys = Object.keys(step);
    if (keys.length !== 1) {
      errors.push(`step ${i}: must have exactly one action key, got ${keys.length}`);
      return;
    }
    if (!ALLOWED_ACTIONS.has(keys[0])) {
      errors.push(`step ${i}: unknown action '${keys[0]}' (allowed: ${[...ALLOWED_ACTIONS].join(", ")})`);
    }
  });
  return { ok: errors.length === 0, errors };
}

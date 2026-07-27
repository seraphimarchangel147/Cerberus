import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, writeJsonAtomic } from "./file-utils.js";

const DEFAULT_TTL_MS = 120_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 4;

export class DesktopLeaseContendedError extends Error {
  constructor({ holder, goal, ageMs }) {
    const agent = holder?.agent ?? "unknown";
    super(
      `Desktop lease is held by ${agent} (pid ${holder?.pid ?? "unknown"})`
      + ` for "${goal || "unspecified goal"}" (${Math.max(0, ageMs)} ms old).`
    );
    this.name = "DesktopLeaseContendedError";
    this.code = "DESKTOP_LEASE_CONTENDED";
    this.holder = holder ?? null;
    this.goal = goal ?? null;
    this.ageMs = Math.max(0, ageMs);
  }
}

export class DesktopLeaseLostError extends Error {
  constructor({ holder = null, sessionId = null } = {}) {
    super(
      holder
        ? `Desktop lease was taken over by ${holder.agent ?? "unknown"}; local session aborted.`
        : "Desktop lease disappeared or became invalid; local session aborted."
    );
    this.name = "DesktopLeaseLostError";
    this.code = "DESKTOP_LEASE_LOST";
    this.holder = holder;
    this.sessionId = sessionId;
  }
}

export class DesktopLease {
  constructor({
    runtime = null,
    log = runtime?.computerUseLog ?? null,
    env = process.env,
    leasePath = null,
    now = () => Date.now(),
    pid = process.pid,
    host = os.hostname(),
    processAlive = defaultProcessAlive
  } = {}) {
    this.runtime = runtime;
    this.log = log;
    this.env = env;
    this.now = now;
    this.pid = pid;
    this.host = normalizedHost(host);
    this.processAlive = processAlive;
    this.path = leasePath ?? resolveDesktopLeasePath(env);
    this.lockPath = `${this.path}.lock`;
    this.ttlMs = boundedTtl(env.OPENAGI_DESKTOP_LEASE_TTL_MS);
  }

  get enabled() {
    return String(this.env.OPENAGI_DESKTOP_LEASE ?? "").trim() !== "0";
  }

  acquire({
    sessionId,
    goal,
    projectId = null,
    agentSessionId = null
  } = {}) {
    if (!this.enabled) return { acquired: true, disabled: true, sessionId };
    const identity = agentIdentity({
      env: this.env,
      runtime: this.runtime,
      pid: this.pid,
      host: this.host,
      projectId,
      agentSessionId
    });
    return this._withLock(() => {
      const nowMs = this.now();
      const record = this._newRecord({
        identity,
        sessionId,
        goal,
        nowMs,
        generation: 1
      });
      try {
        writeExclusive(this.path, record);
        this._event("lease-acquired", { lease: record });
        return record;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const { record: current, malformed } = readLease(this.path);
      if (
        current
        && sameHolder(current.holder, identity)
      ) {
        const renewed = {
          ...current,
          sessionId: requiredSessionId(sessionId),
          goal: boundedGoal(goal),
          renewedAt: new Date(nowMs).toISOString(),
          ttlMs: this.ttlMs
        };
        writeJsonAtomic(this.path, renewed);
        this._event("lease-renewed", {
          lease: renewed,
          reentrant: true
        });
        return renewed;
      }

      const dead = current
        ? this._holderIsDead(current.holder)
        : false;
      const ageMs = current
        ? Math.max(0, nowMs - Date.parse(current.renewedAt))
        : Number.POSITIVE_INFINITY;
      const stale = !current || dead || ageMs > current.ttlMs;
      if (stale) {
        const replacement = this._newRecord({
          identity,
          sessionId,
          goal,
          nowMs,
          generation: (current?.generation ?? 0) + 1
        });
        writeJsonAtomic(this.path, replacement);
        this._event("lease-stolen", {
          lease: replacement,
          previousHolder: current?.holder ?? null,
          previousGoal: current?.goal ?? null,
          reason: malformed
            ? "malformed"
            : dead ? "dead-process" : "expired"
        });
        return replacement;
      }

      const contention = new DesktopLeaseContendedError({
        holder: current.holder,
        goal: current.goal,
        ageMs
      });
      this._event("lease-contended", {
        holder: current.holder,
        goal: current.goal,
        ageMs
      });
      throw contention;
    });
  }

  renew(sessionId) {
    if (!this.enabled) return { renewed: true, disabled: true };
    return this._withLock(() => {
      const { record } = readLease(this.path);
      const identity = agentIdentity({
        env: this.env,
        runtime: this.runtime,
        pid: this.pid,
        host: this.host,
        projectId: record?.holder?.projectId ?? null,
        agentSessionId: record?.holder?.agentSessionId ?? null
      });
      if (
        !record
        || record.sessionId !== sessionId
        || !sameHolder(record.holder, identity)
      ) {
        this._event("lease-stolen", {
          sessionId,
          detectedDuring: "renew",
          currentHolder: record?.holder ?? null,
          currentSessionId: record?.sessionId ?? null
        });
        throw new DesktopLeaseLostError({
          holder: record?.holder ?? null,
          sessionId
        });
      }
      const renewed = {
        ...record,
        renewedAt: new Date(this.now()).toISOString(),
        ttlMs: this.ttlMs
      };
      writeJsonAtomic(this.path, renewed);
      this._event("lease-renewed", { lease: renewed });
      return renewed;
    });
  }

  release(sessionId) {
    if (!this.enabled) return { released: true, disabled: true };
    try {
      return this._withLock(() => {
        const { record } = readLease(this.path);
        if (!record) return { released: false };
        const identity = agentIdentity({
          env: this.env,
          runtime: this.runtime,
          pid: this.pid,
          host: this.host,
          projectId: record.holder.projectId,
          agentSessionId: record.holder.agentSessionId
        });
        if (
          record.sessionId !== sessionId
          || !sameHolder(record.holder, identity)
        ) {
          return { released: false };
        }
        fs.rmSync(this.path, { force: true });
        this._event("lease-released", { lease: record });
        return { released: true };
      });
    } catch {
      return { released: false };
    }
  }

  _newRecord({ identity, sessionId, goal, nowMs, generation }) {
    const timestamp = new Date(nowMs).toISOString();
    return {
      holder: identity,
      sessionId: requiredSessionId(sessionId),
      goal: boundedGoal(goal),
      surface: "desktop",
      acquiredAt: timestamp,
      renewedAt: timestamp,
      ttlMs: this.ttlMs,
      generation
    };
  }

  _holderIsDead(holder) {
    if (
      normalizedHost(holder?.host) !== this.host
      || !Number.isSafeInteger(holder?.pid)
      || holder.pid <= 0
    ) {
      return false;
    }
    return !this.processAlive(holder.pid);
  }

  _event(kind, details) {
    try {
      this.log?.recordLeaseEvent?.(kind, details);
    } catch {
      // Audit persistence must not strand a lease operation midway.
    }
  }

  _withLock(operation) {
    ensureDir(path.dirname(this.path));
    const token = `${this.pid}:${randomUUID()}`;
    let fd = null;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        break;
      } catch (error) {
        if (fd != null) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
          fd = null;
        }
        if (error?.code !== "EEXIST") throw error;
        if (staleLock(this.lockPath, this.ttlMs)) {
          try { fs.rmSync(this.lockPath, { force: true }); } catch { /* retry */ }
        } else {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
        }
      }
    }
    if (fd == null) {
      throw new Error("Desktop lease coordination lock is busy.");
    }
    try {
      return operation();
    } finally {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === token) {
          fs.rmSync(this.lockPath, { force: true });
        }
      } catch {
        // A stale-lock recovery may already have removed it.
      }
    }
  }
}

export function resolveDesktopLeasePath(env = process.env) {
  const configured = String(env.OPENAGI_DESKTOP_LEASE_PATH ?? "").trim();
  if (!configured) return path.join(os.tmpdir(), "legion-desktop.lease.json");
  return configured.toLowerCase().endsWith(".json")
    ? path.resolve(configured)
    : path.join(path.resolve(configured), "legion-desktop.lease.json");
}

export function agentIdentity({
  env = process.env,
  runtime = null,
  pid = process.pid,
  host = os.hostname(),
  projectId = null,
  agentSessionId = null
} = {}) {
  const normalized = normalizedHost(host);
  const agent = [
    env.OPENAGI_AGENT_NAME,
    runtime?.config?.agentName,
    normalized,
    "unknown"
  ].map((value) => String(value ?? "").trim()).find(Boolean);
  return {
    agent: agent.slice(0, 128),
    pid,
    host: normalized || "unknown",
    projectId: projectId == null ? null : String(projectId).slice(0, 128),
    agentSessionId: agentSessionId == null
      ? null
      : String(agentSessionId).slice(0, 256)
  };
}

function readLease(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!validLease(parsed)) return { record: null, malformed: true };
    return { record: parsed, malformed: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { record: null, malformed: false };
    return { record: null, malformed: true };
  }
}

function validLease(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.holder
    && typeof value.holder.agent === "string"
    && Number.isSafeInteger(value.holder.pid)
    && typeof value.holder.host === "string"
    && typeof value.sessionId === "string"
    && Number.isFinite(Date.parse(value.renewedAt))
    && Number.isSafeInteger(value.ttlMs)
    && value.ttlMs > 0
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
  );
}

function writeExclusive(filePath, value) {
  ensureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sameHolder(left, right) {
  return left?.agent === right?.agent
    && left?.pid === right?.pid
    && left?.agentSessionId === right?.agentSessionId;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function normalizedHost(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 128);
}

function boundedTtl(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    && parsed >= MIN_TTL_MS
    && parsed <= MAX_TTL_MS
    ? parsed
    : DEFAULT_TTL_MS;
}

function boundedGoal(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function requiredSessionId(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(text)) {
    throw new TypeError("Desktop lease requires a valid sessionId.");
  }
  return text;
}

function staleLock(filePath, ttlMs) {
  try {
    const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
    return ageMs > Math.min(ttlMs, 10_000);
  } catch {
    return true;
  }
}

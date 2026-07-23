import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCatastrophicPreToolHook } from "./catastrophic-policy.js";
import { resolveDataDir } from "./data-dir.js";
import { buildSafeEnv } from "./mcp-client.js";
import { allowedStdioCommands, isAllowedStdioCommand } from "./mcp-registry.js";

const TIER_ORDER = Object.freeze({ gateway: 0, plugin: 1, shell: 2 });
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_PER_HOOK_TIMEOUT_MS = 500;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const MAX_SHELL_HOOKS = 64;

export const HOOK_TIERS = Object.freeze(Object.keys(TIER_ORDER));

/**
 * Event hooks are deliberately split into two paths:
 * - beforeToolCall()/runVeto() are awaited and may return a hard veto.
 * - notify() queues observers and returns immediately; flush() is a test and
 *   shutdown seam only.
 *
 * Shell hooks are configured in <dataDir>/hooks.json as:
 * { "hooks": [{ "name", "event", "command", "args": [], "timeoutMs" }] }
 * They receive one JSON event on stdin and may return one JSON verdict on
 * stdout. Processes never run through a shell and inherit only the MCP-safe
 * environment.
 */
export class HookRegistry {
  #hooks = [];
  #nextOrder = 0;
  #observerQueue = Promise.resolve();

  constructor(options = {}) {
    this.dataDir = path.resolve(
      options.dataDir
      ?? (options.configPath ? path.dirname(options.configPath) : null)
      ?? (options.loadConfig === false ? process.cwd() : resolveDataDir())
    );
    this.configPath = options.configPath ?? path.join(this.dataDir, "hooks.json");
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 50, 5_000);
    this.perHookTimeoutMs = boundedInteger(
      options.perHookTimeoutMs,
      Math.min(DEFAULT_PER_HOOK_TIMEOUT_MS, this.timeoutMs),
      10,
      this.timeoutMs
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      32,
      1024 * 1024
    );
    this.maxInputBytes = boundedInteger(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      32,
      1024 * 1024
    );
    this.log = normalizeLogger(options.log);
    this.spawn = options.spawn ?? spawn;
    this._register(createCatastrophicPreToolHook(), {
      builtin: true,
      source: "builtin"
    });
    if (options.loadConfig !== false) this.loadShellConfig();
  }

  register(spec) {
    return this._register(spec, { builtin: false, source: "runtime" });
  }

  unregister(name) {
    const index = this.#hooks.findIndex((hook) => hook.name === name);
    if (index < 0 || this.#hooks[index].builtin) return false;
    this.#hooks.splice(index, 1);
    return true;
  }

  list({ event, tier } = {}) {
    return this._matching(event ?? null)
      .filter((hook) => !tier || hook.tier === tier)
      .map(({ handler, ...hook }) => ({ ...hook }));
  }

  async beforeToolCall(payload = {}, options = {}) {
    return this.runVeto("pre_tool_call", payload, options);
  }

  /**
   * Await matching hooks inside one overall deadline. A timeout or exception
   * is logged and treated as allow. The deadline is shared fairly so one hung
   * hook cannot consume the entire budget before later hooks get a chance.
   */
  async runVeto(event, payload = {}, options = {}) {
    assertEventName(event, { wildcard: false });
    const hooks = this._matching(event);
    if (!hooks.length) return allowVerdict();

    const immutablePayload = freezeHookPayload(payload);
    const totalMs = boundedInteger(options.timeoutMs, this.timeoutMs, 1, 5_000);
    const deadline = Date.now() + totalMs;

    for (let index = 0; index < hooks.length; index += 1) {
      const hook = hooks[index];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this._warn(`event ${event} exhausted its ${totalMs}ms deadline; remaining hooks skipped`);
        break;
      }
      const hooksLeft = hooks.length - index;
      const fairShare = Math.max(1, Math.floor(remaining / hooksLeft));
      const requested = hook.timeoutMs ?? this.perHookTimeoutMs;
      const hookTimeoutMs = Math.max(1, Math.min(requested, remaining, fairShare));

      let raw;
      try {
        raw = await invokeWithTimeout(hook, immutablePayload, event, hookTimeoutMs);
      } catch (error) {
        this._warn(
          `${hookLabel(hook)} failed open for ${event}: ${safeErrorMessage(error)}`
        );
        continue;
      }

      let verdict;
      try {
        verdict = normalizeVerdict(raw, hook);
      } catch (error) {
        this._warn(
          `${hookLabel(hook)} returned an unreadable verdict for ${event}: ${safeErrorMessage(error)}`
        );
        continue;
      }
      if (verdict.action === "block") return verdict;
    }

    return allowVerdict();
  }

  /** Queue observer hooks without adding latency to the caller. */
  notify(event, payload = {}) {
    assertEventName(event, { wildcard: false });
    const immutablePayload = freezeHookPayload(payload);
    this.#observerQueue = this.#observerQueue
      .then(() => this._dispatchObservers(event, immutablePayload))
      .catch((error) => {
        this._warn(`observer queue failed open for ${event}: ${safeErrorMessage(error)}`);
      });
  }

  async flush() {
    await this.#observerQueue;
  }

  /**
   * Reload only config-backed shell hooks. A malformed file is fail-open and
   * leaves the last valid configuration active.
   */
  loadShellConfig(filePath = this.configPath) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#hooks = this.#hooks.filter((hook) => hook.source !== "config");
        return [];
      }
      this._warn(`could not load shell hook config: ${safeErrorMessage(error)}`);
      return this.list({ tier: "shell" }).filter((hook) => hook.source === "config");
    }

    const entries = Array.isArray(parsed) ? parsed : parsed?.hooks;
    if (!Array.isArray(entries)) {
      this._warn("could not load shell hook config: expected a hooks array");
      return this.list({ tier: "shell" }).filter((hook) => hook.source === "config");
    }

    const staged = [];
    const reservedNames = new Set(
      this.#hooks.filter((hook) => hook.source !== "config").map((hook) => hook.name)
    );
    for (const [index, entry] of entries.slice(0, MAX_SHELL_HOOKS).entries()) {
      if (entry?.enabled === false) continue;
      try {
        const normalized = normalizeShellSpec(entry, index, this.dataDir);
        if (reservedNames.has(normalized.name)) {
          throw new Error(`hook name '${normalized.name}' is already registered`);
        }
        reservedNames.add(normalized.name);
        staged.push(normalized);
      } catch (error) {
        this._warn(`shell hook ${index + 1} rejected: ${safeErrorMessage(error)}`);
      }
    }
    if (entries.length > MAX_SHELL_HOOKS) {
      this._warn(`shell hook config is capped at ${MAX_SHELL_HOOKS} entries`);
    }

    this.#hooks = this.#hooks.filter((hook) => hook.source !== "config");
    const registered = [];
    for (const spec of staged) {
      const shellSpec = Object.freeze({ ...spec, args: Object.freeze([...spec.args]) });
      registered.push(this._register({
        name: shellSpec.name,
        event: shellSpec.event,
        tier: "shell",
        timeoutMs: shellSpec.timeoutMs,
        handler: (payload, control) => runShellHook(shellSpec, payload, control, {
          spawnFn: this.spawn,
          maxInputBytes: this.maxInputBytes,
          maxOutputBytes: this.maxOutputBytes
        })
      }, { builtin: false, source: "config" }));
    }
    return registered.map(({ handler, ...hook }) => ({ ...hook }));
  }

  reloadShellHooks(filePath = this.configPath) {
    return this.loadShellConfig(filePath);
  }

  _register(spec, { builtin, source }) {
    if (!spec || typeof spec !== "object") throw new TypeError("Hook requires a specification.");
    const name = String(spec.name ?? "").trim();
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error("Hook name must contain only ASCII letters, digits, dot, underscore, or dash.");
    }
    if (this.#hooks.some((hook) => hook.name === name)) {
      throw new Error(`Hook '${name}' is already registered.`);
    }
    const event = String(spec.event ?? "").trim();
    assertEventName(event, { wildcard: true });
    const tier = String(spec.tier ?? "plugin").trim().toLowerCase();
    if (!(tier in TIER_ORDER)) throw new Error(`Unknown hook tier '${tier}'.`);
    if (typeof spec.handler !== "function") throw new TypeError(`Hook '${name}' requires a handler.`);

    const descriptor = Object.freeze({
      name,
      event,
      tier,
      handler: spec.handler,
      timeoutMs: spec.timeoutMs == null
        ? null
        : boundedInteger(spec.timeoutMs, this.perHookTimeoutMs, 1, 5_000),
      builtin: builtin === true,
      immutable: builtin === true,
      source,
      order: this.#nextOrder++
    });
    this.#hooks.push(descriptor);
    this.#hooks.sort(compareHooks);
    return descriptor;
  }

  _matching(event) {
    if (event == null) return [...this.#hooks].sort(compareHooks);
    return this.#hooks.filter((hook) => eventMatches(hook.event, event)).sort(compareHooks);
  }

  async _dispatchObservers(event, payload) {
    for (const hook of this._matching(event)) {
      const timeoutMs = Math.min(hook.timeoutMs ?? this.perHookTimeoutMs, this.timeoutMs);
      try {
        await invokeWithTimeout(hook, payload, event, timeoutMs);
      } catch (error) {
        this._warn(`${hookLabel(hook)} failed open for ${event}: ${safeErrorMessage(error)}`);
      }
    }
  }

  _warn(message) {
    try { this.log(`[hooks] ${message}`); } catch { /* logging must not wedge hooks */ }
  }
}

export function eventMatches(pattern, event) {
  if (pattern === event || pattern === "*") return true;
  if (!pattern.includes("*")) return false;
  const expression = pattern
    .split("*")
    .map(escapeRegExp)
    .join(".*");
  return new RegExp(`^${expression}$`).test(event);
}

function compareHooks(left, right) {
  if (left.builtin !== right.builtin) return left.builtin ? -1 : 1;
  return TIER_ORDER[left.tier] - TIER_ORDER[right.tier] || left.order - right.order;
}

function allowVerdict() {
  return Object.freeze({ action: "allow" });
}

function normalizeVerdict(raw, hook) {
  if (!raw || typeof raw !== "object" || raw.action !== "block") return allowVerdict();
  const trustedApproval = hook.builtin === true && raw.approvalRequired === true;
  const message = boundedText(raw.message, `Blocked by hook ${hook.name}.`, 1_000);
  const reason = boundedText(raw.reason, message, 1_000);
  return Object.freeze({
    action: "block",
    message,
    reason,
    code: trustedApproval ? boundedText(raw.code, "catastrophic", 80) : null,
    approvalRequired: trustedApproval,
    blockedBy: hook.name,
    blockedTier: hook.tier,
    builtin: hook.builtin === true
  });
}

function invokeWithTimeout(hook, payload, event, timeoutMs) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(reject, new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve()
      .then(() => hook.handler(payload, Object.freeze({
        event,
        signal: controller.signal,
        timeoutMs
      })))
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
  });
}

function normalizeShellSpec(entry, index, dataDir) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("entry must be an object");
  }
  const name = String(entry.name ?? `shell-hook-${index + 1}`).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("name contains unsupported characters");
  const event = String(entry.event ?? "").trim();
  assertEventName(event, { wildcard: true });
  const command = String(entry.command ?? "").trim();
  if (!command || command.includes("\0")) throw new Error("command is required");
  if (!isAllowedStdioCommand(command)) {
    throw new Error(
      `command '${command}' is not allowlisted (permitted: ${allowedStdioCommands().join(", ")})`
    );
  }
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be an array of at most 64 strings");
  }
  if (args.some((arg) => arg.length > 4_096 || arg.includes("\0"))) {
    throw new Error("hook arguments are too large or contain a NUL byte");
  }
  assertNoInlineEvaluation(command, args);

  let cwd = dataDir;
  if (entry.cwd != null) {
    if (typeof entry.cwd !== "string" || entry.cwd.includes("\0")) {
      throw new Error("cwd must be a string without NUL bytes");
    }
    cwd = path.resolve(dataDir, entry.cwd);
  }
  const env = entry.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("env must be an object");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || typeof value !== "string") {
      throw new Error("env keys must be identifiers and values must be strings");
    }
  }
  return {
    name,
    event,
    command,
    args: [...args],
    cwd,
    env: { ...env },
    timeoutMs: entry.timeoutMs == null
      ? null
      : boundedInteger(entry.timeoutMs, DEFAULT_PER_HOOK_TIMEOUT_MS, 1, 5_000)
  };
}

function assertNoInlineEvaluation(command, args) {
  const leaf = String(command).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  const has = (patterns) => args.some((arg) => patterns.some((pattern) => pattern.test(arg)));
  if ((leaf === "node" || leaf === "bun") && has([/^-e$/, /^--eval(?:=|$)/, /^-p$/, /^--print(?:=|$)/])) {
    throw new Error("inline JavaScript evaluation flags are not allowed");
  }
  if ((leaf === "python" || leaf === "python3") && has([/^-c$/])) {
    throw new Error("inline Python evaluation flags are not allowed");
  }
  if (leaf === "deno" && args[0]?.toLowerCase() === "eval") {
    throw new Error("inline Deno evaluation is not allowed");
  }
  if (leaf === "npx" && has([/^-c$/, /^--call(?:=|$)/])) {
    throw new Error("npx shell evaluation flags are not allowed");
  }
}

function runShellHook(spec, payload, control, { spawnFn, maxInputBytes, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let input;
    try {
      input = `${JSON.stringify({ event: control.event, payload })}\n`;
    } catch (error) {
      reject(new Error(`hook payload is not serializable: ${safeErrorMessage(error)}`));
      return;
    }
    if (Buffer.byteLength(input) > maxInputBytes) {
      reject(new Error(`hook payload exceeds ${maxInputBytes} bytes`));
      return;
    }

    let child;
    try {
      child = spawnFn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: buildSafeEnv(spec.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const cleanup = () => control.signal.removeEventListener("abort", onAbort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const failOutputLimit = () => {
      try { child.kill(); } catch { /* best effort */ }
      finish(reject, new Error(`shell hook output exceeds ${maxOutputBytes} bytes`));
    };
    const collect = (target, chunk) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        failOutputLimit();
        return target;
      }
      return target + text;
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* best effort */ }
      finish(reject, new Error("shell hook aborted"));
    };

    control.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(reject, error));
    child.stdout?.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.stdin?.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 500);
        finish(reject, new Error(
          `shell hook exited with code ${code}${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`
        ));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        finish(resolve, { action: "allow" });
        return;
      }
      try {
        finish(resolve, JSON.parse(text));
      } catch (error) {
        finish(reject, new Error(`shell hook returned invalid JSON: ${safeErrorMessage(error)}`));
      }
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      finish(reject, error);
    }
  });
}

function freezeHookPayload(value) {
  return deepFreeze(cloneHookValue(value, new WeakSet(), 0));
}

function cloneHookValue(value, seen, depth) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (depth >= 20) return "[Depth limit]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => cloneHookValue(item, seen, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 1_000)) {
    out[key] = cloneHookValue(item, seen, depth + 1);
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function assertEventName(event, { wildcard }) {
  if (!event || typeof event !== "string") throw new Error("Hook event is required.");
  const pattern = wildcard ? /^[a-zA-Z0-9._:*-]+$/ : /^[a-zA-Z0-9._:-]+$/;
  if (!pattern.test(event)) {
    throw new Error(`Hook event '${event}' contains unsupported characters.`);
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function boundedText(value, fallback, maximum) {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return String(text).slice(0, maximum);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hookLabel(hook) {
  return `${hook.tier} hook '${hook.name}'`;
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").slice(0, 1_000);
}

function normalizeLogger(log) {
  if (typeof log === "function") return log;
  if (typeof log?.warn === "function") return (message) => log.warn(message);
  return (message) => console.warn(message);
}

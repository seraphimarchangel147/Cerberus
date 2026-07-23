import { spawn } from "node:child_process";
import { appendJsonLine, ensureDir } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { redactKnownValues, safeRedactionMarker } from "./redact.js";
import { assertSafeMcpServerName, mcpNamedFilePath } from "./mcp-name.js";

const PROTOCOL_VERSION = "2024-11-05";
export const SAFE_ENV_KEYS = Object.freeze(["PATH", "HOME", "USER", "USERPROFILE", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_PATH"]);

export function buildSafeEnv(extraEnv = {}) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key]) out[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (typeof key !== "string") continue;
    if (/[^A-Z0-9_]/i.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

export class McpStdioClient {
  constructor(options = {}) {
    this.name = assertSafeMcpServerName(options.name ?? "mcp");
    this.command = options.command;
    this.args = options.args ?? [];
    this.displayArgs = options.displayArgs ?? this.args;
    this.env = options.env ?? {};
    this.redactValues = new Set(options.redactValues ?? []);
    this.sortedRedactValues = [...this.redactValues]
      .map(String)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    this.redactionMarker = safeRedactionMarker(this.sortedRedactValues);
    this.stderrPending = "";
    this.trustLevel = options.trustLevel ?? "untrusted";
    this.cwd = options.cwd;
    this.logDir = options.logDir;
    this.logPath = this.logDir
      ? mcpNamedFilePath(this.logDir, this.name, ".jsonl")
      : null;
    this.proc = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = null;
    this.connected = false;
    this.connecting = null;
    this.lastError = null;
  }

  status() {
    return {
      name: this.name,
      command: this.command,
      args: this.displayArgs,
      trustLevel: this.trustLevel,
      connected: this.connected,
      tools: this.tools.map((tool) => tool.name),
      serverInfo: this.serverInfo,
      lastError: this.lastError
    };
  }

  async connect() {
    if (this.connected) return { tools: this.tools, serverInfo: this.serverInfo };
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async doConnect() {
    if (!this.command) throw new Error(`MCP server ${this.name} is missing a command.`);
    if (this.logDir) ensureDir(this.logDir);
    this.proc = spawn(this.command, this.args, {
      env: this.buildEnv(),
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.proc.on("exit", (code, signal) => this.handleExit(code, signal));
    this.proc.on("close", () => this.flushStderr());
    this.proc.on("error", (error) => {
      this.lastError = this.redact(error.message);
    });

    try {
      this.serverInfo = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: { name: "openagi", version: "0.1.0" }
        },
        { timeoutMs: 300000 }
      );
      this.notify("notifications/initialized", {});
      const list = await this.request("tools/list", {}, { timeoutMs: 60000 });
      this.tools = list?.tools ?? [];
      this.connected = true;
      return { tools: this.tools, serverInfo: this.serverInfo };
    } catch (error) {
      this.lastError = this.redact(error.message);
      this.close();
      throw this.safeError(error);
    }
  }

  async callTool(toolName, args = {}) {
    if (!this.connected) await this.connect();
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    return result;
  }

  async listTools() {
    if (!this.connected) await this.connect();
    const list = await this.request("tools/list", {});
    this.tools = list?.tools ?? this.tools;
    return this.tools;
  }

  request(method, params, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error(`MCP server ${this.name} is not running.`));
        return;
      }
      const id = this.nextId++;
      const message = { jsonrpc: "2.0", id, method, params };
      const timeoutMs = options.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request '${method}' timed out`));
      }, timeoutMs);
      const wrapped = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method };
      this.pending.set(id, wrapped);
      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this.safeError(error));
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    const message = { jsonrpc: "2.0", method, params };
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // best-effort
    }
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.logStderr(`[bad json] ${this.redact(line)}\n`);
      }
    }
  }

  handleMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        const safeError = redactKnownValues(msg.error, this.redactValues);
        pending.reject(new Error(safeError.message ?? `MCP error in ${pending.method}`));
      } else {
        pending.resolve(redactKnownValues(msg.result, this.redactValues));
      }
      return;
    }
    if (this.logDir) {
      appendJsonLine(this.logPath, {
        at: nowIso(),
        op: "notify",
        msg: redactKnownValues(msg, this.redactValues)
      });
    }
  }

  logStderr(text) {
    if (!this.logDir) return;
    appendJsonLine(this.logPath, {
      at: nowIso(),
      op: "stderr",
      text: this.redact(String(text)).trim()
    });
  }

  handleExit(code, signal) {
    this.connected = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`MCP server ${this.name} exited (code=${code} signal=${signal})`));
    }
    this.pending.clear();
    if (this.logDir) {
      appendJsonLine(this.logPath, { at: nowIso(), op: "exit", code, signal });
    }
  }

  buildEnv() {
    return buildSafeEnv(this.env);
  }

  handleStderr(chunk) {
    const safe = this.redactStderrChunk(chunk);
    if (safe) this.logStderr(safe);
  }

  flushStderr() {
    const safe = this.redactStderrChunk("", { final: true });
    if (safe) this.logStderr(safe);
  }

  redactStderrChunk(chunk, { final = false } = {}) {
    if (this.sortedRedactValues.length === 0) return String(chunk ?? "");
    this.stderrPending += String(chunk ?? "");
    let safe = "";
    while (this.stderrPending.length > 0) {
      const complete = this.sortedRedactValues
        .find((secret) => this.stderrPending.startsWith(secret));
      const couldGrowIntoLongerSecret = !final && this.sortedRedactValues.some(
        (secret) => secret.length > this.stderrPending.length
          && secret.startsWith(this.stderrPending)
      );
      if (couldGrowIntoLongerSecret) break;
      if (complete) {
        safe += this.redactionMarker;
        this.stderrPending = this.stderrPending.slice(complete.length);
        continue;
      }
      safe += this.stderrPending[0];
      this.stderrPending = this.stderrPending.slice(1);
    }
    return safe;
  }

  redact(value) {
    return redactKnownValues(String(value ?? ""), this.redactValues);
  }

  safeError(error) {
    const safe = new Error(this.redact(error?.message ?? error));
    if (error?.code !== undefined) safe.code = error.code;
    return safe;
  }

  close() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.connected = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`MCP server ${this.name} closed.`));
    }
    this.pending.clear();
  }
}

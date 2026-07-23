import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile } from "./file-utils.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 1500;
const DEFAULT_DIAGNOSTIC_SETTLE_MS = 75;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export const DEFAULT_LSP_SERVERS = Object.freeze([
  Object.freeze({
    id: "pyright",
    commandCandidates: Object.freeze(["pyright-langserver", "pyright"]),
    args: Object.freeze(["--stdio"]),
    extensions: Object.freeze([".py", ".pyi"]),
    languageId: "python"
  }),
  Object.freeze({
    id: "typescript-language-server",
    commandCandidates: Object.freeze(["typescript-language-server"]),
    args: Object.freeze(["--stdio"]),
    extensions: Object.freeze([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]),
    languageIdByExtension: Object.freeze({
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript"
    })
  }),
  Object.freeze({
    id: "gopls",
    commandCandidates: Object.freeze(["gopls"]),
    args: Object.freeze([]),
    extensions: Object.freeze([".go"]),
    languageId: "go"
  }),
  Object.freeze({
    id: "rust-analyzer",
    commandCandidates: Object.freeze(["rust-analyzer"]),
    args: Object.freeze([]),
    extensions: Object.freeze([".rs"]),
    languageId: "rust"
  }),
  Object.freeze({
    id: "clangd",
    commandCandidates: Object.freeze(["clangd"]),
    args: Object.freeze([]),
    extensions: Object.freeze([".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]),
    languageIdByExtension: Object.freeze({
      ".c": "c",
      ".h": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".hh": "cpp",
      ".hpp": "cpp",
      ".hxx": "cpp"
    })
  })
]);

function pathExists(candidate, fsImpl = fs) {
  try {
    fsImpl.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }
}

export function findExecutable(command, env = process.env, fsImpl = fs) {
  const requested = String(command ?? "").trim();
  if (!requested) return null;
  if (path.isAbsolute(requested) || requested.includes("/") || requested.includes("\\")) {
    const resolved = path.resolve(requested);
    return pathExists(resolved, fsImpl) ? resolved : null;
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathValue) return null;
  const windows = process.platform === "win32";
  const extensions = windows
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  const hasExtension = Boolean(path.extname(requested));
  for (const directory of String(pathValue).split(path.delimiter)) {
    if (!directory) continue;
    const candidates = windows && !hasExtension
      ? extensions.map((extension) => path.join(directory, `${requested}${extension.toLowerCase()}`))
          .concat(extensions.map((extension) => path.join(directory, `${requested}${extension.toUpperCase()}`)))
      : [path.join(directory, requested)];
    for (const candidate of candidates) {
      if (pathExists(candidate, fsImpl)) return candidate;
    }
  }
  return null;
}

export function findGitWorkspace(filePath, fsImpl = fs) {
  let current = path.resolve(filePath);
  try {
    if (!fsImpl.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    try {
      const marker = fsImpl.statSync(path.join(current, ".git"));
      if (marker.isDirectory() || marker.isFile()) return current;
    } catch {
      // Keep walking. Git worktrees use a .git file, while ordinary clones
      // use a directory; both are accepted above.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function severityName(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (["ERROR", "WARNING", "INFORMATION", "HINT"].includes(normalized)) return normalized;
  }
  if (value === 1) return "ERROR";
  if (value === 2) return "WARNING";
  if (value === 3) return "INFORMATION";
  if (value === 4) return "HINT";
  return "ERROR";
}

function finitePosition(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeDiagnostic(diagnostic) {
  const start = diagnostic?.range?.start ?? {};
  const end = diagnostic?.range?.end ?? start;
  const line = diagnostic?.line !== undefined
    ? Math.max(1, finitePosition(diagnostic.line, 1))
    : finitePosition(start.line) + 1;
  const column = diagnostic?.column !== undefined
    ? Math.max(1, finitePosition(diagnostic.column, 1))
    : finitePosition(start.character) + 1;
  const endLine = diagnostic?.endLine !== undefined
    ? Math.max(line, finitePosition(diagnostic.endLine, line))
    : finitePosition(end.line, line - 1) + 1;
  const endColumn = diagnostic?.endColumn !== undefined
    ? Math.max(1, finitePosition(diagnostic.endColumn, column))
    : finitePosition(end.character, column - 1) + 1;
  const normalized = {
    severity: severityName(diagnostic?.severity),
    line,
    column,
    endLine,
    endColumn,
    message: String(diagnostic?.message ?? "Unknown language-server diagnostic")
      .replace(/\s+/g, " ")
      .trim()
  };
  if (diagnostic?.code !== undefined && diagnostic.code !== null) {
    normalized.code = String(diagnostic.code);
  }
  if (diagnostic?.source) normalized.source = String(diagnostic.source);
  return normalized;
}

export function diagnosticKey(diagnostic) {
  const normalized = normalizeDiagnostic(diagnostic);
  return JSON.stringify([
    normalized.severity,
    normalized.line,
    normalized.column,
    normalized.endLine,
    normalized.endColumn,
    normalized.message,
    normalized.code ?? "",
    normalized.source ?? ""
  ]);
}

export function filterNewDiagnostics(current, baseline = []) {
  const remaining = new Map();
  for (const diagnostic of baseline ?? []) {
    const key = diagnosticKey(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const introduced = [];
  for (const diagnostic of current ?? []) {
    const normalized = normalizeDiagnostic(diagnostic);
    const key = diagnosticKey(normalized);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      if (count === 1) remaining.delete(key);
      else remaining.set(key, count - 1);
    } else {
      introduced.push(normalized);
    }
  }
  return introduced;
}

function escapeXml(value, { attribute = false } = {}) {
  let escaped = String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (attribute) escaped = escaped.replaceAll('"', "&quot;");
  return escaped;
}

export function formatLspDiagnostics(filePath, diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const rows = diagnostics
    .map(normalizeDiagnostic)
    .sort((left, right) =>
      left.line - right.line
      || left.column - right.column
      || left.severity.localeCompare(right.severity)
      || left.message.localeCompare(right.message)
    )
    .map((diagnostic) =>
      `${diagnostic.severity} [${diagnostic.line}:${diagnostic.column}] ${escapeXml(diagnostic.message)}`
    );
  return `LSP diagnostics introduced by this edit:\n<diagnostics file="${escapeXml(filePath, { attribute: true })}">${rows.join("\n")}</diagnostics>`;
}

function safeProcessEnv(source = process.env) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "HOME", "USER", "USERPROFILE", "HOMEDRIVE",
    "HOMEPATH", "LANG", "LC_ALL", "TMP", "TEMP", "TMPDIR", "SystemRoot",
    "SYSTEMROOT", "ComSpec", "COMSPEC", "NODE_PATH"
  ];
  const result = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function cloneServer(server) {
  return {
    ...server,
    args: [...(server.args ?? [])],
    extensions: [...(server.extensions ?? [])],
    commandCandidates: [...(server.commandCandidates ?? [])],
    languageIdByExtension: server.languageIdByExtension
      ? { ...server.languageIdByExtension }
      : undefined,
    env: server.env ? { ...server.env } : undefined
  };
}

function configuredServers(config = {}) {
  const definitions = new Map(DEFAULT_LSP_SERVERS.map((server) => [server.id, cloneServer(server)]));
  const configured = config?.servers && typeof config.servers === "object"
    ? config.servers
    : config;

  for (const [id, rawOverride] of Object.entries(configured ?? {})) {
    if (["requestTimeoutMs", "diagnosticTimeoutMs", "diagnosticSettleMs", "idleTimeoutMs"].includes(id)) {
      continue;
    }
    if (rawOverride === false || rawOverride?.enabled === false) {
      definitions.delete(id);
      continue;
    }
    const override = typeof rawOverride === "string"
      ? { command: rawOverride }
      : rawOverride;
    if (!override || typeof override !== "object" || Array.isArray(override)) continue;
    const base = definitions.get(id) ?? {
      id,
      args: [],
      extensions: [],
      commandCandidates: []
    };
    const merged = {
      ...base,
      ...override,
      id,
      args: Array.isArray(override.args) ? override.args.map(String) : [...(base.args ?? [])],
      extensions: Array.isArray(override.extensions)
        ? override.extensions.map((extension) => {
            const value = String(extension).toLowerCase();
            return value.startsWith(".") ? value : `.${value}`;
          })
        : [...(base.extensions ?? [])],
      commandCandidates: override.command
        ? [String(override.command)]
        : Array.isArray(override.commandCandidates)
          ? override.commandCandidates.map(String)
          : [...(base.commandCandidates ?? [])],
      languageIdByExtension: {
        ...(base.languageIdByExtension ?? {}),
        ...(override.languageIdByExtension ?? {})
      },
      env: { ...(base.env ?? {}), ...(override.env ?? {}) }
    };
    definitions.set(id, merged);
  }
  return [...definitions.values()];
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

class LspProcess {
  constructor(options) {
    this.id = options.server.id;
    this.server = options.server;
    this.command = options.command;
    this.workspaceRoot = options.workspaceRoot;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.env = options.env;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.diagnosticTimeoutMs = options.diagnosticTimeoutMs;
    this.diagnosticSettleMs = options.diagnosticSettleMs;
    this.proc = null;
    this.starting = null;
    this.started = false;
    this.closed = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.openDocuments = new Map();
    this.queue = Promise.resolve();
    this.closePromise = null;
  }

  start() {
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async doStart() {
    if (this.closed) throw new Error("LSP process is closed");
    const child = this.spawnImpl(this.command, this.server.args ?? [], {
      cwd: this.workspaceRoot,
      env: { ...safeProcessEnv(this.env), ...(this.server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.proc = child;
    child.stdout?.on("data", (chunk) => this.handleStdout(chunk));
    // Language-server logs are intentionally discarded. They are optional
    // diagnostics and must not leak into agent output or break a code write.
    child.stderr?.on("data", () => {});
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(`LSP server exited (${code ?? signal ?? "unknown"})`));
    });
    child.unref?.();

    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "openagi", version: "0.0.6" },
      rootPath: this.workspaceRoot,
      rootUri: pathToFileURL(this.workspaceRoot).href,
      workspaceFolders: [{
        name: path.basename(this.workspaceRoot),
        uri: pathToFileURL(this.workspaceRoot).href
      }],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true },
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true
          },
          synchronization: {
            didSave: true,
            dynamicRegistration: false
          }
        }
      }
    });
    this.notify("initialized", {});
    this.started = true;
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  respond(id, result = null) {
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  writeMessage(message) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed || this.closed) {
      throw new Error("LSP server is not running");
    }
    const body = JSON.stringify(message);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  handleStdout(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, incoming]);
    while (this.stdoutBuffer.length > 0) {
      let headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      let separatorLength = 4;
      if (headerEnd < 0) {
        headerEnd = this.stdoutBuffer.indexOf("\n\n");
        separatorLength = 2;
      }
      if (headerEnd < 0) return;
      const header = this.stdoutBuffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r?\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + separatorLength);
        continue;
      }
      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + separatorLength;
      if (this.stdoutBuffer.length < bodyStart + contentLength) return;
      const body = this.stdoutBuffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart + contentLength);
      try {
        this.handleMessage(JSON.parse(body));
      } catch {
        // Malformed optional diagnostics are ignored.
      }
    }
  }

  handleMessage(message) {
    if (message?.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(String(message.error.message ?? "LSP request failed")));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.id !== undefined && message.method) {
      if (message.method === "workspace/configuration") {
        const items = Array.isArray(message.params?.items) ? message.params.items : [];
        this.respond(message.id, items.map(() => null));
      } else if (message.method === "workspace/workspaceFolders") {
        this.respond(message.id, [{
          name: path.basename(this.workspaceRoot),
          uri: pathToFileURL(this.workspaceRoot).href
        }]);
      } else {
        this.respond(message.id, null);
      }
      return;
    }
    if (message?.method === "textDocument/publishDiagnostics") {
      const uri = String(message.params?.uri ?? "");
      const diagnostics = Array.isArray(message.params?.diagnostics)
        ? message.params.diagnostics
        : [];
      for (const listener of this.listeners.get(uri) ?? []) listener(diagnostics);
    }
  }

  waitForDiagnostics(uri) {
    return new Promise((resolve) => {
      let latest = [];
      let settleTimer = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(totalTimer);
        clearTimeout(settleTimer);
        const listeners = this.listeners.get(uri);
        listeners?.delete(onDiagnostics);
        if (listeners?.size === 0) this.listeners.delete(uri);
        resolve(latest);
      };
      const onDiagnostics = (diagnostics) => {
        latest = diagnostics;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, this.diagnosticSettleMs);
      };
      const totalTimer = setTimeout(finish, this.diagnosticTimeoutMs);
      if (!this.listeners.has(uri)) this.listeners.set(uri, new Set());
      this.listeners.get(uri).add(onDiagnostics);
    });
  }

  diagnostics(filePath, content, languageId) {
    const task = this.queue.then(() => this.doDiagnostics(filePath, content, languageId));
    this.queue = task.catch(() => {});
    return task;
  }

  async doDiagnostics(filePath, content, languageId) {
    await this.start();
    const uri = pathToFileURL(filePath).href;
    const nextVersion = (this.openDocuments.get(uri) ?? 0) + 1;
    const publication = this.waitForDiagnostics(uri);
    if (!this.openDocuments.has(uri)) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: nextVersion,
          text: content
        }
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text: content }]
      });
      this.notify("textDocument/didSave", {
        textDocument: { uri },
        text: content
      });
    }
    this.openDocuments.set(uri, nextVersion);
    return (await publication).map(normalizeDiagnostic);
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener([]);
    }
    this.close();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.started = false;
    const child = this.proc;
    this.closePromise = new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      if (child?.stdin && !child.stdin.destroyed) {
        const body = JSON.stringify({ jsonrpc: "2.0", method: "exit", params: null });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      }
    } catch {
      // Best effort.
    }
    try { child?.kill(); } catch { /* best effort */ }
    for (const pending of this.pending.values()) {
      pending.reject(new Error("LSP server closed"));
    }
    this.pending.clear();
    this.listeners.clear();
    return this.closePromise;
  }
}

export class LspClient {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.configPath = options.configPath ?? path.join(this.dataDir, "lsp.json");
    if (options.config !== undefined) {
      this.config = options.config ?? {};
    } else {
      try {
        this.config = readJsonFile(this.configPath, {});
      } catch {
        // Configuration is advisory. A malformed file must not take down code
        // tool registration or turn an otherwise valid write into a failure.
        this.config = {};
      }
    }
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.fs = options.fs ?? fs;
    this.requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs ?? this.config?.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.diagnosticTimeoutMs = positiveDuration(
      options.diagnosticTimeoutMs ?? this.config?.diagnosticTimeoutMs,
      DEFAULT_DIAGNOSTIC_TIMEOUT_MS
    );
    this.diagnosticSettleMs = positiveDuration(
      options.diagnosticSettleMs ?? this.config?.diagnosticSettleMs,
      DEFAULT_DIAGNOSTIC_SETTLE_MS
    );
    this.idleTimeoutMs = positiveDuration(
      options.idleTimeoutMs ?? this.config?.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS
    );
    this.servers = configuredServers(this.config);
    this.processes = new Map();
    this.unavailable = new Set();
    this.idleTimers = new Map();
  }

  async getDiagnostics(filePath) {
    if (String(this.env.OPENAGI_LSP ?? "").trim() === "0") return [];
    const absolute = path.resolve(String(filePath ?? ""));
    const workspaceRoot = findGitWorkspace(absolute, this.fs);
    if (!workspaceRoot) return [];
    const extension = path.extname(absolute).toLowerCase();
    const server = this.servers.find((candidate) => candidate.extensions.includes(extension));
    if (!server) return [];
    let content;
    try {
      content = this.fs.readFileSync(absolute, "utf8");
    } catch {
      return [];
    }

    const key = `${workspaceRoot}\0${server.id}`;
    if (this.unavailable.has(key)) return [];
    let processClient = this.processes.get(key);
    if (!processClient) {
      const command = server.commandCandidates
        .map((candidate) => findExecutable(candidate, this.env, this.fs))
        .find(Boolean);
      if (!command) {
        this.unavailable.add(key);
        return [];
      }
      processClient = new LspProcess({
        server,
        command,
        workspaceRoot,
        spawnImpl: this.spawnImpl,
        env: this.env,
        requestTimeoutMs: this.requestTimeoutMs,
        diagnosticTimeoutMs: this.diagnosticTimeoutMs,
        diagnosticSettleMs: this.diagnosticSettleMs
      });
      this.processes.set(key, processClient);
    }

    this.armIdleTimer(key);
    try {
      const languageId = server.languageIdByExtension?.[extension]
        ?? server.languageId
        ?? extension.slice(1);
      const diagnostics = await processClient.diagnostics(absolute, content, languageId);
      this.armIdleTimer(key);
      return diagnostics;
    } catch {
      processClient.close();
      this.processes.delete(key);
      this.unavailable.add(key);
      this.clearIdleTimer(key);
      return [];
    }
  }

  armIdleTimer(key) {
    this.clearIdleTimer(key);
    const timer = setTimeout(() => {
      this.processes.get(key)?.close();
      this.processes.delete(key);
      this.idleTimers.delete(key);
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  clearIdleTimer(key) {
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);
  }

  close() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const closing = [...this.processes.values()].map((processClient) => processClient.close());
    this.processes.clear();
    return Promise.allSettled(closing);
  }
}

export function createLspClient(options = {}) {
  return new LspClient(options);
}

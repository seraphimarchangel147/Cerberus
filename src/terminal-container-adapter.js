import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isPinnedTerminalImage } from "./terminal-session-store.js";

const INSTALL_ID_RE = /^[a-f0-9]{64}$/;
const TERMINAL_ID_RE = /^terminal_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const CONTAINER_RE = /^openagi-term-[a-f0-9]{8}-[a-f0-9]{16}$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MANAGED_LABEL = "openagi.terminal.managed";
const INSTALL_LABEL = "openagi.terminal.install";
const SESSION_LABEL = "openagi.terminal.id";
const PROJECT_LABEL = "openagi.terminal.project";

export class TerminalContainerError extends Error {
  constructor(message, code = "TERMINAL_CONTAINER_ERROR", options = {}) {
    super(message, options);
    this.name = "TerminalContainerError";
    this.code = code;
  }
}

export class DockerTerminalAdapter {
  constructor(options = {}) {
    this.dockerPath = String(options.dockerPath ?? "docker").trim() || "docker";
    this.spawn = typeof options.spawn === "function" ? options.spawn : spawn;
    this.env = options.env ?? process.env;
    this.commandTimeoutMs = integerInRange(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      100,
      60_000
    );
    this.maxCommandOutputBytes = integerInRange(
      options.maxCommandOutputBytes,
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
      4096,
      8 * 1024 * 1024
    );
  }

  async verifyImage(image) {
    const pinned = normalizeImage(image);
    await this._verifyLocalDaemon();
    const result = await this._run([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      pinned
    ]);
    if (!result.ok) {
      throw new TerminalContainerError(
        "The configured terminal image is not available locally; automatic pulls are disabled.",
        "TERMINAL_IMAGE_UNAVAILABLE"
      );
    }
    const imageId = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new TerminalContainerError(
        "Docker returned an invalid image identity.",
        "TERMINAL_IMAGE_ID_INVALID"
      );
    }
    return Object.freeze({ image: pinned, imageId });
  }

  async start(options = {}) {
    const normalized = normalizeStartOptions(options);
    await this._verifyLocalDaemon();
    const args = buildDockerTerminalRunArgs(normalized);
    const child = this.spawn(this.dockerPath, args, {
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    bindChildEvents(child, normalized);
    await waitForSpawn(child);
    await this._waitUntilOwnedRunning(
      normalized.containerName,
      normalized.installId,
      child
    );
    return createDockerHandle({
      adapter: this,
      child,
      containerName: normalized.containerName,
      installId: normalized.installId
    });
  }

  async attach(options = {}) {
    const containerName = normalizeContainerName(options.containerName);
    const installId = normalizeInstallId(options.installId);
    await this._verifyLocalDaemon();
    const inspected = await this._inspectOwned(containerName, installId);
    if (!inspected.running) {
      throw new TerminalContainerError(
        "Managed terminal container is not running.",
        "TERMINAL_CONTAINER_NOT_RUNNING"
      );
    }
    const child = this.spawn(this.dockerPath, [
      "attach",
      "--sig-proxy=false",
      containerName
    ], {
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    bindChildEvents(child, options);
    await waitForSpawn(child);
    return createDockerHandle({
      adapter: this,
      child,
      containerName,
      installId
    });
  }

  async listManaged({ installId } = {}) {
    const owner = normalizeInstallId(installId);
    await this._verifyLocalDaemon();
    const listed = await this._run([
      "ps",
      "-a",
      "--filter",
      `label=${MANAGED_LABEL}=true`,
      "--filter",
      `label=${INSTALL_LABEL}=${owner}`,
      "--format",
      "{{.ID}}"
    ]);
    if (!listed.ok) {
      throw new TerminalContainerError(
        "Docker could not enumerate managed terminal containers.",
        "TERMINAL_CONTAINER_ENUM_FAILED"
      );
    }
    const ids = listed.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      ids.length > 64
      || ids.some((value) => !/^[a-f0-9]{12,64}$/.test(value))
      || new Set(ids).size !== ids.length
    ) {
      throw new TerminalContainerError(
        "Docker returned an invalid managed-container identifier collection.",
        "TERMINAL_CONTAINER_LIST_INVALID"
      );
    }
    if (ids.length === 0) return [];
    const inspected = await this._run(["inspect", ...ids]);
    if (!inspected.ok) {
      throw new TerminalContainerError(
        "Docker could not inspect managed terminal containers.",
        "TERMINAL_CONTAINER_INSPECT_FAILED"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(inspected.stdout);
    } catch {
      throw new TerminalContainerError(
        "Docker returned malformed managed-container metadata.",
        "TERMINAL_CONTAINER_INSPECT_INVALID"
      );
    }
    if (!Array.isArray(parsed) || parsed.length > 64) {
      throw new TerminalContainerError(
        "Docker returned an invalid managed-container collection.",
        "TERMINAL_CONTAINER_INSPECT_INVALID"
      );
    }
    const normalized = parsed.map((entry) => normalizeInspectedContainer(entry, owner));
    if (
      normalized.length !== ids.length
      || normalized.some((entry, index) => !entry.id.startsWith(ids[index]))
    ) {
      throw new TerminalContainerError(
        "Docker returned mismatched managed-container metadata.",
        "TERMINAL_CONTAINER_INSPECT_INVALID"
      );
    }
    return normalized;
  }

  async remove(containerName, { installId } = {}) {
    const name = normalizeContainerName(containerName);
    const owner = normalizeInstallId(installId);
    await this._verifyLocalDaemon();
    try {
      await this._inspectOwned(name, owner);
    } catch (error) {
      if (error?.code === "TERMINAL_CONTAINER_MISSING") return true;
      throw error;
    }
    const removed = await this._run(["rm", "--force", name]);
    if (!removed.ok && !/no such container/i.test(removed.stderr)) {
      throw new TerminalContainerError(
        "Managed terminal container could not be removed.",
        "TERMINAL_CONTAINER_REMOVE_FAILED"
      );
    }
    return true;
  }

  async _inspectOwned(containerName, installId) {
    const inspected = await this._run(["inspect", containerName]);
    if (!inspected.ok) {
      throw new TerminalContainerError(
        "Managed terminal container is unavailable.",
        "TERMINAL_CONTAINER_MISSING"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(inspected.stdout);
    } catch {
      throw new TerminalContainerError(
        "Docker returned malformed container metadata.",
        "TERMINAL_CONTAINER_INSPECT_INVALID"
      );
    }
    const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
    const normalized = normalizeInspectedContainer(entry, installId);
    if (normalized.name !== containerName) {
      throw new TerminalContainerError(
        "Container identity changed before terminal control.",
        "TERMINAL_CONTAINER_IDENTITY_CHANGED"
      );
    }
    return normalized;
  }

  async _waitUntilOwnedRunning(containerName, installId, child) {
    const deadline = Date.now() + Math.min(this.commandTimeoutMs, 5_000);
    let exited = child.exitCode != null || child.signalCode != null;
    child.once?.("exit", () => {
      exited = true;
    });
    while (true) {
      try {
        const inspected = await this._inspectOwned(containerName, installId);
        if (!inspected.running) {
          throw new TerminalContainerError(
            "Managed terminal container exited before it became ready.",
            "TERMINAL_CONTAINER_NOT_RUNNING"
          );
        }
        return inspected;
      } catch (error) {
        if (
          error?.code !== "TERMINAL_CONTAINER_MISSING"
          || exited
          || Date.now() >= deadline
        ) {
          throw error;
        }
        await delay(25);
      }
    }
  }

  async _verifyLocalDaemon() {
    const configuredHost = String(this.env.DOCKER_HOST ?? "").trim();
    if (configuredHost && !isLocalDockerEndpoint(configuredHost)) {
      throw new TerminalContainerError(
        "Persistent terminals refuse a remote Docker daemon.",
        "TERMINAL_REMOTE_DOCKER_BLOCKED"
      );
    }
    const context = String(this.env.DOCKER_CONTEXT ?? "default").trim() || "default";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context)) {
      throw new TerminalContainerError(
        "Docker context name is invalid.",
        "TERMINAL_DOCKER_CONTEXT_INVALID"
      );
    }
    const inspected = await this._run([
      "context",
      "inspect",
      context,
      "--format",
      "{{json .Endpoints.docker.Host}}"
    ]);
    if (!inspected.ok) {
      throw new TerminalContainerError(
        "Docker context could not be verified as local.",
        "TERMINAL_DOCKER_CONTEXT_UNAVAILABLE"
      );
    }
    let endpoint;
    try {
      endpoint = JSON.parse(inspected.stdout.trim());
    } catch {
      endpoint = inspected.stdout.trim().replace(/^"|"$/g, "");
    }
    if (!isLocalDockerEndpoint(endpoint)) {
      throw new TerminalContainerError(
        "Persistent terminals refuse a remote Docker context.",
        "TERMINAL_REMOTE_DOCKER_BLOCKED"
      );
    }
    return endpoint;
  }

  _run(args) {
    return runBoundedCommand({
      executable: this.dockerPath,
      args,
      env: this.env,
      spawnFn: this.spawn,
      timeoutMs: this.commandTimeoutMs,
      maxOutputBytes: this.maxCommandOutputBytes
    });
  }
}

export function buildDockerTerminalRunArgs(options = {}) {
  const source = normalizeStartOptions(options);
  const limits = source.limits;
  const user = source.user;
  return [
    "run",
    "--rm",
    "--interactive",
    "--tty",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--name",
    source.containerName,
    "--label",
    `${MANAGED_LABEL}=true`,
    "--label",
    `${INSTALL_LABEL}=${source.installId}`,
    "--label",
    `${SESSION_LABEL}=${source.terminalId}`,
    "--label",
    `${PROJECT_LABEL}=${source.projectId}`,
    "--workdir",
    source.containerCwd,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.tmpfsBytes}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    user,
    "--pids-limit",
    String(limits.processes),
    "--cpus",
    String(limits.cpus),
    "--memory",
    String(limits.memoryBytes),
    "--memory-swap",
    String(limits.memoryBytes),
    "--ulimit",
    `nofile=${limits.openFiles}:${limits.openFiles}`,
    "--stop-timeout",
    "2",
    "--mount",
    `type=bind,src=${source.workspaceRoot},dst=/workspace`,
    "--env",
    "HOME=/tmp",
    "--env",
    "TERM=xterm-256color",
    "--entrypoint",
    "/bin/sh",
    source.image,
    "-i"
  ];
}

function normalizeStartOptions(options) {
  const source = plainRecord(options, "terminal container options");
  const workspaceRoot = normalizeWorkspaceRoot(source.workspaceRoot);
  const cwd = normalizeRelativeCwd(source.cwd);
  const containerCwd = cwd === "." ? "/workspace" : `/workspace/${cwd}`;
  return {
    terminalId: normalizeTerminalId(source.terminalId),
    projectId: normalizeProjectId(source.projectId),
    containerName: normalizeContainerName(source.containerName),
    installId: normalizeInstallId(source.installId),
    image: normalizeImage(source.image),
    workspaceRoot,
    cwd,
    containerCwd,
    user: normalizeContainerUser(source.user),
    limits: normalizeContainerLimits(source.limits),
    onData: typeof source.onData === "function" ? source.onData : null,
    onExit: typeof source.onExit === "function" ? source.onExit : null,
    onError: typeof source.onError === "function" ? source.onError : null
  };
}

function normalizeContainerLimits(value) {
  const source = value == null ? {} : plainRecord(value, "terminal container limits");
  return Object.freeze({
    processes: integerInRange(source.processes, 32, 4, 256),
    cpus: numberInRange(source.cpus, 0.5, 0.1, 4),
    memoryBytes: integerInRange(
      source.memoryBytes,
      512 * 1024 * 1024,
      64 * 1024 * 1024,
      4 * 1024 * 1024 * 1024
    ),
    tmpfsBytes: integerInRange(
      source.tmpfsBytes,
      64 * 1024 * 1024,
      1024 * 1024,
      512 * 1024 * 1024
    ),
    openFiles: integerInRange(source.openFiles, 256, 64, 4096)
  });
}

function normalizeInspectedContainer(entry, installId) {
  const source = plainRecord(entry, "Docker inspect entry");
  const labels = source.Config?.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new TerminalContainerError(
      "Managed terminal container has no trusted labels.",
      "TERMINAL_CONTAINER_LABEL_INVALID"
    );
  }
  if (
    labels[MANAGED_LABEL] !== "true"
    || labels[INSTALL_LABEL] !== installId
  ) {
    throw new TerminalContainerError(
      "Container is not owned by this OpenAGI installation.",
      "TERMINAL_CONTAINER_NOT_OWNED"
    );
  }
  const name = normalizeContainerName(String(source.Name ?? "").replace(/^\/+/, ""));
  const terminalId = normalizeTerminalId(labels[SESSION_LABEL]);
  const projectId = normalizeProjectId(labels[PROJECT_LABEL]);
  const id = String(source.Id ?? "");
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new TerminalContainerError(
      "Managed terminal container identity is invalid.",
      "TERMINAL_CONTAINER_IDENTITY_INVALID"
    );
  }
  return Object.freeze({
    id,
    name,
    terminalId,
    projectId,
    running: source.State?.Running === true,
    exitCode: Number.isSafeInteger(source.State?.ExitCode)
      ? source.State.ExitCode
      : null
  });
}

function createDockerHandle({ adapter, child, containerName, installId }) {
  let closed = false;
  return Object.freeze({
    async write(value) {
      if (closed || child.stdin?.destroyed) {
        throw new TerminalContainerError(
          "Terminal container input is closed.",
          "TERMINAL_INPUT_CLOSED"
        );
      }
      const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      await writeToStream(child.stdin, data);
    },
    async interrupt() {
      if (closed || child.stdin?.destroyed) return false;
      await writeToStream(child.stdin, Buffer.from([3]));
      return true;
    },
    async close() {
      if (closed) return false;
      try {
        await adapter.remove(containerName, { installId });
        closed = true;
      } finally {
        if (closed) {
          try { child.stdin?.end?.(); } catch { /* best effort */ }
          try { child.kill?.(); } catch { /* best effort */ }
        }
      }
      return true;
    }
  });
}

function bindChildEvents(child, options) {
  child.stdout?.on?.("data", (chunk) => {
    try { options.onData?.(chunk); } catch { /* manager callbacks are isolated */ }
  });
  child.stderr?.on?.("data", (chunk) => {
    try { options.onData?.(chunk); } catch { /* manager callbacks are isolated */ }
  });
  child.once?.("error", (error) => {
    try { options.onError?.(error); } catch { /* manager callbacks are isolated */ }
  });
  child.once?.("exit", (code, signal) => {
    try { options.onExit?.({ code, signal }); } catch { /* manager callbacks are isolated */ }
  });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new TerminalContainerError(
        "Docker terminal process could not start.",
        "TERMINAL_DOCKER_START_FAILED",
        { cause: error }
      ));
    };
    const cleanup = () => {
      child.off?.("spawn", onSpawn);
      child.off?.("error", onError);
    };
    child.once?.("spawn", onSpawn);
    child.once?.("error", onError);
  });
}

function runBoundedCommand({
  executable,
  args,
  env,
  spawnFn,
  timeoutMs,
  maxOutputBytes
}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let settled = false;
    const append = (current, chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (current.length + data.length > maxOutputBytes) {
        overflow = true;
        return current;
      }
      return Buffer.concat([current, data]);
    };
    child.stdout?.on?.("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (overflow) child.kill?.();
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (overflow) child.kill?.();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.();
      reject(new TerminalContainerError(
        "Docker command timed out.",
        "TERMINAL_DOCKER_TIMEOUT"
      ));
    }, timeoutMs);
    timer.unref?.();
    child.once?.("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TerminalContainerError(
        "Docker command could not start.",
        "TERMINAL_DOCKER_UNAVAILABLE",
        { cause: error }
      ));
    });
    child.once?.("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) {
        reject(new TerminalContainerError(
          "Docker command output exceeded its limit.",
          "TERMINAL_DOCKER_OUTPUT_LIMIT"
        ));
        return;
      }
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      });
    });
  });
}

function writeToStream(stream, data) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      stream.off?.("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    stream.once?.("error", onError);
    try {
      stream.write(data, (error) => finish(error ?? null));
    } catch (error) {
      finish(error);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorkspaceRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("Terminal workspace root must be an absolute path.");
  }
  const resolved = fs.realpathSync(path.resolve(value));
  if (/[\r\n,]/.test(resolved)) {
    throw new TypeError("Terminal workspace root contains unsupported mount characters.");
  }
  const stats = fs.lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError("Terminal workspace root must be a real directory.");
  }
  return resolved;
}

function isLocalDockerEndpoint(value) {
  const endpoint = String(value ?? "").trim().toLowerCase();
  return endpoint.startsWith("unix://")
    || endpoint.startsWith("npipe://")
    || endpoint.startsWith("//./pipe/");
}

function normalizeRelativeCwd(value) {
  const raw = value == null || value === "" ? "." : String(value);
  if (raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw)) {
    throw new TypeError("Terminal cwd must be a relative POSIX path.");
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || normalized.length > 1024
  ) {
    throw new TypeError("Terminal cwd escapes the project workspace.");
  }
  return normalized || ".";
}

function normalizeImage(value) {
  const image = String(value ?? "").trim();
  if (!isPinnedTerminalImage(image)) {
    throw new TypeError("Terminal image must use an explicit sha256 digest.");
  }
  return image;
}

function normalizeInstallId(value) {
  const id = String(value ?? "").trim();
  if (!INSTALL_ID_RE.test(id)) throw new TypeError("Invalid terminal installation id.");
  return id;
}

function normalizeTerminalId(value) {
  const id = String(value ?? "").trim();
  if (!TERMINAL_ID_RE.test(id)) throw new TypeError("Invalid terminal session id.");
  return id;
}

function normalizeProjectId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) throw new TypeError("Invalid terminal project id.");
  return id;
}

function normalizeContainerName(value) {
  const name = String(value ?? "").trim();
  if (!CONTAINER_RE.test(name)) throw new TypeError("Invalid terminal container name.");
  return name;
}

function normalizeContainerUser(value) {
  const fallbackUid = typeof process.getuid === "function" && process.getuid() > 0
    ? process.getuid()
    : 65534;
  const fallbackGid = typeof process.getgid === "function" && process.getgid() > 0
    ? process.getgid()
    : 65534;
  const user = value == null || value === ""
    ? `${fallbackUid}:${fallbackGid}`
    : String(value).trim();
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(user)) {
    throw new TypeError("Terminal container user must be a non-root numeric uid:gid.");
  }
  return user;
}

function numberInRange(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new RangeError(`Numeric option must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function integerInRange(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`Integer option must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function plainRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  return value;
}

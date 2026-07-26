import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_CHECKS = 16;
const MAX_SYNTAX_FILES = 256;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const CHECK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".openagi",
  "node_modules",
  "coverage",
  "dist",
  "build"
]);

export class IsolatedCodeVerifier {
  constructor(options = {}) {
    this.spawn = options.spawn ?? spawn;
    this.execPath = options.execPath ?? process.execPath;
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      MAX_OUTPUT_BYTES,
      1024,
      1024 * 1024
    );
  }

  async verify({
    workspaceDir,
    checks,
    signal = null,
    env = process.env,
    redactValues = [],
    projectScoped = false
  } = {}) {
    const root = verifiedWorkspace(workspaceDir);
    const plan = normalizeChecks(checks, root);
    const startedAtMs = Date.now();
    const results = [];

    for (let index = 0; index < plan.length; index += 1) {
      if (signal?.aborted) {
        return verificationResult(results, {
          startedAtMs,
          cancelled: true,
          planned: plan.length
        });
      }
      const check = plan[index];
      if (check.type === "syntax") {
        const files = syntaxTargets(check.path, root);
        if (files.length === 0) {
          results.push(Object.freeze({
            index,
            id: check.id,
            type: check.type,
            path: relativePath(root, check.path),
            ok: false,
            code: "no_syntax_targets",
            checked: 0,
            durationMs: 0,
            tail: "No JavaScript files were found for syntax verification."
          }));
          continue;
        }
        const syntaxStartedAt = Date.now();
        let failure = null;
        let checked = 0;
        for (const file of files) {
          const execution = await runNode(
            this.spawn,
            this.execPath,
            ["--check", file],
            {
              cwd: root,
              env,
              signal,
              timeoutMs: check.timeoutMs,
              maxOutputBytes: this.maxOutputBytes,
              redactValues
            }
          );
          checked += 1;
          if (!execution.ok) {
            failure = execution;
            break;
          }
        }
        results.push(Object.freeze({
          index,
          id: check.id,
          type: check.type,
          path: relativePath(root, check.path),
          ok: failure === null,
          code: failure?.code ?? "ok",
          checked,
          durationMs: Date.now() - syntaxStartedAt,
          tail: failure?.tail ?? ""
        }));
        if (failure?.cancelled) {
          return verificationResult(results, {
            startedAtMs,
            cancelled: true,
            planned: plan.length
          });
        }
        continue;
      }

      const args = projectScoped
        ? [
            "--permission",
            `--allow-fs-read=${root}`,
            "--test-isolation=none",
            "--test",
            "--test-concurrency=1"
          ]
        : ["--test", "--test-concurrency=1"];
      if (check.path) args.push(check.path);
      const execution = await runNode(
        this.spawn,
        this.execPath,
        args,
        {
          cwd: root,
          env,
          signal,
          timeoutMs: check.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          redactValues
        }
      );
      results.push(Object.freeze({
        index,
        id: check.id,
        type: check.type,
        path: check.path ? relativePath(root, check.path) : null,
        ok: execution.ok,
        code: execution.code,
        checked: null,
        durationMs: execution.durationMs,
        tail: execution.tail
      }));
      if (execution.cancelled) {
        return verificationResult(results, {
          startedAtMs,
          cancelled: true,
          planned: plan.length
        });
      }
    }

    return verificationResult(results, {
      startedAtMs,
      cancelled: false,
      planned: plan.length
    });
  }
}

export function createIsolatedCodeVerifier(options = {}) {
  return new IsolatedCodeVerifier(options);
}

function normalizeChecks(value, root) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw new TypeError(`Verification requires 1-${MAX_CHECKS} checks.`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`Verification check ${index + 1} must be an object.`);
    }
    const type = String(raw.type ?? "").trim().toLowerCase();
    if (!["syntax", "test"].includes(type)) {
      throw new TypeError(`Verification check ${index + 1} has an unsupported type.`);
    }
    const id = String(raw.id ?? `check_${index + 1}`).trim();
    if (!CHECK_ID_RE.test(id)) {
      throw new TypeError(`Verification check ${index + 1} has an invalid ASCII id.`);
    }
    const timeoutMs = boundedInteger(
      raw.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS
    );
    if (type === "syntax" && !String(raw.path ?? "").trim()) {
      throw new TypeError(`Syntax check ${index + 1} requires a path.`);
    }
    const target = raw.path == null || String(raw.path).trim() === ""
      ? null
      : resolveInside(root, raw.path);
    if (target && !safeFileOrDirectory(target)) {
      throw new Error(`Verification target does not exist or is not a regular file/directory: ${target}`);
    }
    return Object.freeze({
      id,
      type,
      path: target,
      timeoutMs
    });
  });
}

function syntaxTargets(target, root) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("Verification targets cannot be symbolic links.");
  if (stat.isFile()) {
    return isJavaScriptPath(target) ? [target] : [];
  }
  if (!stat.isDirectory()) return [];
  const files = [];
  walkSyntaxFiles(target, root, files);
  return files.sort();
}

function walkSyntaxFiles(directory, root, files) {
  if (files.length >= MAX_SYNTAX_FILES) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (files.length >= MAX_SYNTAX_FILES) return;
    if (entry.isSymbolicLink()) continue;
    const candidate = resolveInside(root, path.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walkSyntaxFiles(candidate, root, files);
    } else if (entry.isFile() && isJavaScriptPath(candidate)) {
      files.push(candidate);
    }
  }
}

function runNode(spawnFn, executable, args, {
  cwd,
  env,
  signal,
  timeoutMs,
  maxOutputBytes,
  redactValues
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawnFn(executable, args, {
        cwd,
        env: { ...(env ?? {}) },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        ok: false,
        code: "spawn_error",
        cancelled: false,
        durationMs: Date.now() - startedAt,
        tail: boundedUtf8Tail(
          safeText(error?.message ?? error, redactValues),
          maxOutputBytes
        )
      });
      return;
    }

    let settled = false;
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    const collect = (chunk) => {
      if (settled || outputBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const buffer = Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      const accepted = buffer.subarray(0, remaining);
      output += accepted.toString("utf8");
      outputBytes += accepted.length;
      if (buffer.length > accepted.length) truncated = true;
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (details) => {
      if (settled) return;
      settled = true;
      cleanup();
      const suffix = truncated ? "\n[verification output truncated]" : "";
      resolve({
        ...details,
        durationMs: Date.now() - startedAt,
        tail: boundedUtf8Tail(
          safeText(`${output}${suffix}`, redactValues),
          maxOutputBytes
        )
      });
    };
    const terminate = () => {
      try { child.kill(); } catch { /* best effort */ }
    };
    const onAbort = () => {
      terminate();
      finish({ ok: false, code: "cancelled", cancelled: true });
    };
    const timer = setTimeout(() => {
      terminate();
      finish({ ok: false, code: "timeout", cancelled: false });
    }, timeoutMs);

    child.stdout?.on?.("data", collect);
    child.stderr?.on?.("data", collect);
    child.on?.("error", (error) => {
      collect(error?.message ?? error);
      finish({ ok: false, code: "spawn_error", cancelled: false });
    });
    child.on?.("close", (code, childSignal) => {
      finish({
        ok: code === 0,
        code: code === 0
          ? "ok"
          : Number.isInteger(code)
            ? `exit_${code}`
            : childSignal
              ? "terminated"
              : "failed",
        cancelled: false
      });
    });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function verificationResult(results, {
  startedAtMs,
  cancelled,
  planned
}) {
  const ok = !cancelled
    && results.length === planned
    && results.every((result) => result.ok);
  return Object.freeze({
    ok,
    status: cancelled ? "cancelled" : ok ? "passed" : "failed",
    checksPlanned: planned,
    checksCompleted: results.length,
    durationMs: Date.now() - startedAtMs,
    results: Object.freeze([...results])
  });
}

function verifiedWorkspace(value) {
  const root = path.resolve(String(value ?? ""));
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Verification workspace must be a real directory.");
  }
  return root;
}

function resolveInside(root, value) {
  const candidate = path.resolve(root, String(value ?? ""));
  const relative = path.relative(root, candidate);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Verification target is outside the project workspace.");
  }
  return candidate;
}

function safeFileOrDirectory(target) {
  try {
    const stat = fs.lstatSync(target);
    return !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory());
  } catch {
    return false;
  }
}

function isJavaScriptPath(value) {
  return value.endsWith(".js") || value.endsWith(".mjs") || value.endsWith(".cjs");
}

function relativePath(root, value) {
  return path.relative(root, value).replaceAll("\\", "/") || ".";
}

function safeText(value, redactValues) {
  let text = String(value ?? "");
  for (const secret of redactValues ?? []) {
    const token = String(secret ?? "");
    if (token) text = text.split(token).join("[REDACTED]");
  }
  return text;
}

function boundedUtf8Tail(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export const CODE_VERIFIER_LIMITS = Object.freeze({
  maxChecks: MAX_CHECKS,
  maxSyntaxFiles: MAX_SYNTAX_FILES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS
});

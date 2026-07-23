import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "./index.js";
import { loadEnvFile } from "./file-utils.js";
import { resolveDataDir, _resetDataDirCache } from "./data-dir.js";

// Read a single var from an env file WITHOUT importing the rest of its keys.
function peekEnvVar(file, key) {
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0 || line.slice(0, i).trim() !== key) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch { /* no file */ }
  return null;
}

// Resolve the data dir and load env files in the correct precedence, exactly
// as the hosted-server example does. Shared so the CLI (`openagi serve`), the
// example, and any other entry point boot identically.
//
// A cwd .env may set OPENAGI_DATA_DIR, which must be known BEFORE the data dir
// is resolved (resolveDataDir memoizes). We must NOT bulk-load the cwd .env
// first: its blank sample entries (OPENAI_API_KEY=, …) would shadow the real
// values in the canonical <dataDir>/.env, since loadEnvFile is first-wins. So:
// peek only OPENAGI_DATA_DIR, resolve, load the canonical file (authoritative),
// then let the cwd .env fill any remaining gaps.
export function loadBootEnv() {
  const cwdDataDir = peekEnvVar(".env", "OPENAGI_DATA_DIR");
  if (cwdDataDir && !process.env.OPENAGI_DATA_DIR) process.env.OPENAGI_DATA_DIR = cwdDataDir;
  _resetDataDirCache();
  const dataDir = resolveDataDir();
  loadEnvFile(path.join(dataDir, ".env")); // canonical — authoritative (first-wins)
  loadEnvFile(".env");                       // cwd .env fills only keys the canonical didn't set
  return dataDir;
}

// A misconfigured, unreachable, or reauth-needed MCP server rejects
// asynchronously during connect — a 401 (expired/invalid token), an OAuth
// callback timeout, a DNS failure. Those are recoverable: the server just needs
// to be reconnected or re-authed, and it already records its own lastError +
// surfaces "needs auth" via status/SSE. But Node 15+ TERMINATES the process on
// any unhandled rejection, so without a top-level guard one stray MCP error
// takes down the whole agent — and the supervisor restarts it straight into the
// same failure (a crash loop). Log and keep running instead. Installed once,
// before the runtime/MCP connects, so it covers every daemon launch (the CLI,
// this example, systemd, the Mac DaemonController) identically.
let crashGuardsInstalled = false;
export function installCrashGuards() {
  if (crashGuardsInstalled) return;
  crashGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error(`[openagi] unhandled rejection (kept alive): ${err.stack || err.message}`);
  });
  // An uncaught synchronous exception can leave state undefined, but for a
  // supervised, always-on daemon staying up beats crash-looping; the error is
  // logged loudly so it's still diagnosable in daemon.log / journald.
  process.on("uncaughtException", (err) => {
    console.error(`[openagi] uncaught exception (kept alive): ${err?.stack || err}`);
  });
}

export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 65_000;

// One daemon process should have one termination path, even when startServer()
// is exercised repeatedly in an embedding process or test. Replacing an older
// registration also prevents a signal from closing a stale app instance.
const gracefulShutdownByProcess = new WeakMap();

export function installGracefulShutdown(app, {
  processLike = process,
  timeoutMs = DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  log = (message) => console.warn(message)
} = {}) {
  if (!app || typeof app.close !== "function") {
    throw new TypeError("installGracefulShutdown requires an app with close()");
  }
  if (!processLike || typeof processLike.on !== "function"
      || typeof processLike.removeListener !== "function"
      || typeof processLike.exit !== "function") {
    throw new TypeError("installGracefulShutdown requires a process-like event emitter");
  }

  gracefulShutdownByProcess.get(processLike)?.dispose();

  const parsedTimeout = Number(timeoutMs);
  const boundedTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0
    ? parsedTimeout
    : DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  let disposed = false;
  let shutdownPromise = null;
  let controller;

  const onSigint = () => { void shutdown("SIGINT"); };
  const onSigterm = () => { void shutdown("SIGTERM"); };
  const report = (message) => {
    try { log(message); } catch { /* shutdown logging is advisory */ }
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    processLike.removeListener("SIGINT", onSigint);
    processLike.removeListener("SIGTERM", onSigterm);
    if (gracefulShutdownByProcess.get(processLike) === controller) {
      gracefulShutdownByProcess.delete(processLike);
    }
  }

  function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    // Keep the handlers installed while close is pending so a second OS
    // signal is coalesced here instead of falling back to Node's immediate
    // default termination path and cutting off the review flush.
    shutdownPromise = (async () => {
      let timeoutHandle;
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, boundedTimeoutMs);
      });

      try {
        await Promise.race([Promise.resolve().then(() => app.close()), timeout]);
        if (timedOut) {
          report(`[openagi] ${signal} shutdown timed out after ${boundedTimeoutMs}ms; exiting`);
        }
      } catch (error) {
        report(`[openagi] ${signal} shutdown close failed open: ${error?.message ?? String(error)}`);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        dispose();
        processLike.exit(0);
      }
    })();
    return shutdownPromise;
  }

  processLike.on("SIGINT", onSigint);
  processLike.on("SIGTERM", onSigterm);
  controller = {
    dispose,
    shutdown,
    get pending() { return shutdownPromise; }
  };
  gracefulShutdownByProcess.set(processLike, controller);
  return controller;
}

// Boot env + start the hosted interface. Returns the listen address.
// host/port fall back to HOST/PORT env then sane defaults; callers (the CLI)
// can override. Binding to 0.0.0.0 is safe because the HTTP interface enforces
// the bearer token — but we warn so it's a deliberate choice.
export async function startServer({ host, port } = {}) {
  installCrashGuards();
  const dataDir = loadBootEnv();
  const resolvedHost = host ?? process.env.HOST ?? "127.0.0.1";
  const resolvedPort = Number.parseInt(String(port ?? process.env.PORT ?? "43210"), 10);

  if ((resolvedHost === "0.0.0.0" || resolvedHost === "::") && !process.env.OPENAGI_AUTH_TOKEN) {
    // Fail closed (Tier-1 hardening, 2026-07): an unauthenticated daemon on
    // all interfaces is full remote control of the machine. Explicit escape
    // hatch for people who really mean it: OPENAGI_UNSAFE_BIND=1.
    if (process.env.OPENAGI_UNSAFE_BIND === "1") {
      console.warn(
        "⚠ OPENAGI_UNSAFE_BIND=1 — binding to " + resolvedHost + " with NO OPENAGI_AUTH_TOKEN.\n" +
        "  The dashboard and API are reachable UNAUTHENTICATED on your network."
      );
    } else {
      throw new Error(
        `Refusing to bind ${resolvedHost} without OPENAGI_AUTH_TOKEN — the dashboard and API would be ` +
        `reachable unauthenticated on your network. Run \`openagi setup\` (or set OPENAGI_AUTH_TOKEN), ` +
        `or set OPENAGI_UNSAFE_BIND=1 to override deliberately.`
      );
    }
  }

  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: resolvedHost, port: resolvedPort });
  const address = await app.listen();
  const shutdown = installGracefulShutdown(app);
  return { app, runtime, address, dataDir, host: resolvedHost, port: resolvedPort, shutdown };
}

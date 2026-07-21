import { Worker } from "node:worker_threads";
import { scanGhosts } from "../code-tools.js";
import { buildSafeEnv } from "../mcp-client.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TOOL_CALLS = 50;
const MAX_STDOUT_BYTES = 64 * 1024;
const WORKER_URL = new URL("./execute-code-worker.js", import.meta.url);

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(parsed)));
}

function appendCapped(output, value) {
  const chunk = Buffer.from(`${value}\n`, "utf8");
  const remaining = MAX_STDOUT_BYTES - output.bytes;
  if (remaining <= 0) {
    output.truncated = true;
    return;
  }
  if (chunk.length > remaining) {
    output.parts.push(chunk.subarray(0, remaining));
    output.bytes += remaining;
    output.truncated = true;
    return;
  }
  output.parts.push(chunk);
  output.bytes += chunk.length;
}

function safeEnvelope(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ ok: false, error: `Tool result could not cross the execute_code boundary: ${error.message}` });
  }
}

function nestedToolContext(context) {
  const nested = { ...(context ?? {}), __fromExecuteCode: true };
  // Approval is scoped to the wrapper call. Carrying it inward would let an
  // approved execute_code call silently authorize a catastrophic child call.
  delete nested.__confirmed;
  delete nested.__approval;
  return nested;
}

function finalizeOutput(output, details) {
  let stdout = Buffer.concat(output.parts, output.bytes).toString("utf8");
  let error = details.error ?? null;
  const ghost = scanGhosts(stdout);
  if (ghost) {
    stdout = "";
    error = `execute_code output rejected: suspicious character ${ghost.codePoint} at line ${ghost.line}`;
  }
  return {
    stdout,
    toolCallsMade: details.toolCallsMade,
    truncated: output.truncated,
    timedOut: Boolean(details.timedOut),
    ...(error ? { error } : {})
  };
}

export async function runExecuteCode(runtime, args = {}, context = {}) {
  const code = String(args.code ?? "");
  const timeoutMs = boundedTimeout(args.timeoutMs);
  const output = { parts: [], bytes: 0, truncated: false };
  let toolCallsMade = 0;

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, {
      type: "module",
      workerData: { code, timeoutMs },
      // The VM receives no process global, and the worker itself inherits only
      // the MCP-safe operational keys as defense in depth against VM escapes.
      env: buildSafeEnv(),
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4
      }
    });
    let finalizing = false;

    const finish = async (details) => {
      if (finalizing) return;
      finalizing = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      resolve(finalizeOutput(output, { toolCallsMade, ...details }));
    };

    const timer = setTimeout(() => {
      void finish({ timedOut: true, error: `execute_code timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    worker.on("message", async (message) => {
      if (finalizing || !message || typeof message !== "object") return;
      if (message.type === "log") {
        appendCapped(output, message.line ?? "");
        return;
      }
      if (message.type === "done") {
        void finish({ timedOut: Boolean(message.timedOut), error: message.error ?? null });
        return;
      }
      if (message.type !== "tool") return;

      const name = String(message.name ?? "");
      let envelope;
      if (!name) {
        envelope = safeEnvelope({ ok: false, error: "callTool requires a tool name" });
      } else if (name === "execute_code") {
        envelope = safeEnvelope({ ok: false, error: "execute_code cannot call itself recursively" });
      } else if (toolCallsMade >= MAX_TOOL_CALLS) {
        envelope = safeEnvelope({ ok: false, error: `execute_code tool-call cap reached (${MAX_TOOL_CALLS})` });
      } else {
        toolCallsMade += 1;
        try {
          const outcome = await runtime.tools.invoke(name, message.args ?? {}, nestedToolContext(context));
          envelope = outcome.ok
            ? safeEnvelope({ ok: true, result: outcome.result ?? null })
            : safeEnvelope({ ok: false, error: outcome.error ?? `Tool ${name} failed` });
        } catch (error) {
          envelope = safeEnvelope({ ok: false, error: error.message ?? String(error) });
        }
      }
      if (!finalizing) worker.postMessage({ type: "tool-result", id: message.id, envelope });
    });

    worker.on("error", (error) => {
      void finish({
        timedOut: false,
        error: `execute_code worker failed: ${error.message ?? String(error)}`
      });
    });
    worker.on("exit", (code) => {
      if (!finalizing) {
        void finish({
          timedOut: false,
          error: code === 0 ? "execute_code worker exited before returning a result" : `execute_code worker exited with code ${code}`
        });
      }
    });
  });
}

export function registerExecuteCodeTool(runtime) {
  runtime.tools.register({
    name: "execute_code",
    sideEffects: true,
    description: "Run a short JS script that can call your tools via await callTool(name, args). Use for 3+ dependent tool calls with logic between them, or to reduce large tool output before it reaches you. Print the final result with console.log.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript body. callTool and console.log are available; imports, require, process, fetch, timers, and filesystem globals are not." },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: `Wall-clock timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` }
      },
      required: ["code"],
      additionalProperties: false
    },
    summarize: ({ code }) => `Run execute_code script (${String(code ?? "").length} chars)`,
    handler: async (args, context) => runExecuteCode(runtime, args, context)
  });
}

export const EXECUTE_CODE_LIMITS = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxStdoutBytes: MAX_STDOUT_BYTES
});

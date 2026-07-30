import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

const pending = new Map();
let nextCallId = 1;

function postDone({ error = null, timedOut = false } = {}) {
  parentPort.postMessage({ type: "done", error, timedOut });
}

parentPort.on("message", (message) => {
  if (message?.type !== "tool-result") return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(String(message.envelope));
});

const bridge = (requestJson) => new Promise((resolve) => {
  let request;
  try {
    request = JSON.parse(String(requestJson));
  } catch (error) {
    resolve(JSON.stringify({ ok: false, error: `Invalid callTool request: ${error.message}` }));
    return;
  }
  const id = nextCallId;
  nextCallId += 1;
  pending.set(id, resolve);
  parentPort.postMessage({ type: "tool", id, name: request?.name, args: request?.args ?? {} });
});

const sink = (line) => parentPort.postMessage({ type: "log", line: String(line) });
const sandbox = Object.create(null);
const context = vm.createContext(sandbox, {
  name: "openagi-execute-code",
  codeGeneration: { strings: false, wasm: false }
});

// Build both exposed functions inside the context. The parent-port callbacks
// stay hidden in closures so user code never receives a host Function object.
const makeCallTool = new vm.Script(`
  (bridge) => async function callTool(name, args = {}) {
    let request;
    try {
      request = JSON.stringify({ name, args });
    } catch (error) {
      throw new Error("callTool arguments must be JSON-serializable: " + error.message);
    }
    const envelope = JSON.parse(await bridge(request));
    if (!envelope.ok) {
      // F3: a bare Error erased the advisory shape of inner failures, so a
      // blocked/repeated_no_progress outcome looked identical to a crash. Copy
      // the structured fields onto the thrown error so a script can branch on
      // err.status / err.code / err.nextSteps instead of parsing the message.
      const error = new Error(envelope.error);
      if (envelope.tool) error.tool = envelope.tool;
      if (envelope.outcome && typeof envelope.outcome === "object") {
        error.outcome = envelope.outcome;
        if (envelope.outcome.status) error.status = envelope.outcome.status;
        if (envelope.outcome.code) error.code = envelope.outcome.code;
        if (envelope.outcome.retryable !== undefined) {
          error.retryable = envelope.outcome.retryable;
        }
        if (Array.isArray(envelope.outcome.nextSteps)) {
          error.nextSteps = envelope.outcome.nextSteps.slice();
        }
      }
      if (envelope.blocked === true) error.blocked = true;
      if (envelope.code && !error.code) error.code = envelope.code;
      throw error;
    }
    return envelope.result;
  }
`).runInContext(context, { timeout: workerData.timeoutMs });
const makeConsole = new vm.Script(`
  (sink) => Object.freeze({
    log: (...values) => {
      const line = values.map((value) => {
        if (typeof value === "string") return value;
        try {
          const encoded = JSON.stringify(value);
          return encoded === undefined ? String(value) : encoded;
        } catch {
          return String(value);
        }
      }).join(" ");
      sink(line);
    }
  })
`).runInContext(context, { timeout: workerData.timeoutMs });

Object.defineProperties(sandbox, {
  callTool: { value: makeCallTool(bridge), writable: false, configurable: false },
  console: { value: makeConsole(sink), writable: false, configurable: false }
});

try {
  const script = new vm.Script(`"use strict";\n(async () => {\n${String(workerData.code ?? "")}\n})()`, {
    filename: "execute-code.vm.js"
  });
  const execution = script.runInContext(context, { timeout: workerData.timeoutMs });
  Promise.resolve(execution).then(
    () => postDone(),
    (error) => postDone({
      error: error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
        ? `execute_code timed out after ${workerData.timeoutMs}ms`
        : (error?.message ?? String(error)),
      timedOut: error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    })
  );
} catch (error) {
  postDone({
    error: error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
      ? `execute_code timed out after ${workerData.timeoutMs}ms`
      : (error?.message ?? String(error)),
    timedOut: error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  });
}

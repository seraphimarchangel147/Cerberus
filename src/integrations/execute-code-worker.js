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
    if (!envelope.ok) throw new Error(envelope.error);
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

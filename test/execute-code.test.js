// execute_code is valuable only if it compacts intermediate work without
// becoming a second, weaker invocation path around the registry's gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCodeTools } from "../src/code-tools.js";
import {
  EXECUTE_CODE_LIMITS,
  registerExecuteCodeTool
} from "../src/integrations/execute-code.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execute-code-"));
  const tools = new ToolRegistry();
  const pendingActions = new PendingActionStore({ dir: path.join(dir, "pending") });
  tools.bindPendingActions(pendingActions);
  const runtime = { tools };
  registerCodeTools(tools, runtime);
  registerExecuteCodeTool(runtime);
  return { dir, pendingActions, runtime, tools };
}

async function execute(tools, code, context = {}, timeoutMs) {
  const outcome = await tools.invoke("execute_code", { code, ...(timeoutMs ? { timeoutMs } : {}) }, context);
  assert.equal(outcome.ok, true, outcome.error);
  return outcome.result;
}

test("execute_code reduces several code_read calls to only the printed summary", async () => {
  const { dir, tools } = makeHarness();
  const files = ["alpha.txt", "beta.txt", "gamma.txt"].map((name, index) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `private-${index}\nsecond-line`, "utf8");
    return file;
  });
  const result = await execute(tools, `
    const files = ${JSON.stringify(files)};
    let lines = 0;
    for (const file of files) {
      const read = await callTool("code_read", { path: file });
      lines += read.totalLines;
    }
    console.log(files.length + " files / " + lines + " lines");
  `, { sessionId: "execute-summary" });

  assert.equal(result.stdout, "3 files / 6 lines\n");
  assert.equal(result.toolCallsMade, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.doesNotMatch(result.stdout, /private-/);
});

test("execute_code stops an infinite loop even after an async tool boundary", async () => {
  const { tools } = makeHarness();
  tools.register({ name: "unit_value", sideEffects: false, handler: async () => ({ value: 1 }) });
  const startedAt = Date.now();
  // Leave enough room for worker startup under the full suite's CPU load;
  // the loop itself still proves the main-thread wall clock can hard-stop it.
  const result = await execute(tools, "await callTool('unit_value', {}); while (true) {}", {}, 250);

  assert.equal(result.timedOut, true);
  assert.equal(result.toolCallsMade, 1);
  assert.match(result.error, /timed out after 250ms/);
  assert.ok(Date.now() - startedAt < 2_000, "the VM timeout must not leave the turn hanging");
});

test("execute_code stops at fifty nested tool calls with a clear error", async () => {
  const { tools } = makeHarness();
  tools.register({ name: "unit_value", sideEffects: false, handler: async () => ({ value: 1 }) });
  const result = await execute(tools, `
    for (let i = 0; i <= ${EXECUTE_CODE_LIMITS.maxToolCalls}; i += 1) {
      await callTool("unit_value", {});
    }
  `, { sessionId: "execute-cap" }, 2_000);

  assert.equal(result.toolCallsMade, EXECUTE_CODE_LIMITS.maxToolCalls);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /tool-call cap reached \(50\)/);
});

test("execute_code cannot carry wrapper approval past the catastrophic gate", async () => {
  const { pendingActions, tools } = makeHarness();
  let executions = 0;
  // Replace the real handler so the dangerous fixture is classified but can
  // never reach a shell, even if this regression itself fails.
  tools.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async () => { executions += 1; return { exitCode: 0 }; }
  });
  const result = await execute(tools, `
    const gated = await callTool("code_shell", { command: "rm -rf ~" });
    console.log(JSON.stringify(gated));
  `, {
    sessionId: "execute-catastrophic",
    // This approval belongs to execute_code itself and must not authorize the
    // nested shell call. The integration deliberately strips it on re-entry.
    __confirmed: true
  }, 2_000);

  const printed = JSON.parse(result.stdout);
  assert.equal(printed.status, "awaiting_confirmation");
  assert.equal(executions, 0, "auto-approve and wrapper approval must not bypass the catastrophic gate");
  const pending = pendingActions.list({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].severity, "catastrophic");
});

test("execute_code caps stdout at 64 KiB and marks truncation", async () => {
  const { tools } = makeHarness();
  const result = await execute(tools, "console.log(\"x\".repeat(70 * 1024));");

  assert.equal(Buffer.byteLength(result.stdout, "utf8"), EXECUTE_CODE_LIMITS.maxStdoutBytes);
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
});

test("execute_code rejects ghost characters before stdout reaches model context", async () => {
  const { tools } = makeHarness();
  const result = await execute(tools, "console.log(String.fromCodePoint(0x0430));");

  assert.equal(result.stdout, "");
  assert.match(result.error, /suspicious character U\+0430/);
});

test("execute_code exposes no process, module loader, network, timer, or filesystem globals", async () => {
  const { tools } = makeHarness();
  const result = await execute(tools, `
    let constructorEscape = false;
    for (const target of [callTool, console.log, globalThis]) {
      try {
        constructorEscape ||= Boolean(target.constructor.constructor("return process")());
      } catch {}
    }
    console.log(JSON.stringify({
      process: typeof process,
      require: typeof require,
      module: typeof module,
      fetch: typeof fetch,
      setTimeout: typeof setTimeout,
      Buffer: typeof Buffer,
      constructorEscape
    }));
  `);

  assert.deepEqual(JSON.parse(result.stdout), {
    process: "undefined",
    require: "undefined",
    module: "undefined",
    fetch: "undefined",
    setTimeout: "undefined",
    Buffer: "undefined",
    constructorEscape: false
  });
});

test("execute_code remains subject to scrutiny at its outer registry entry", async () => {
  const { tools } = makeHarness();
  const watch = await tools.invoke("execute_code", { code: "console.log('should not run')" }, {
    __scrutinyPolicy: "read-only"
  });
  const ignore = await tools.invoke("execute_code", { code: "console.log('should not run')" }, {
    __scrutinyPolicy: "none"
  });

  assert.equal(watch.ok, false);
  assert.match(watch.error, /read-only tools only/);
  assert.equal(ignore.ok, false);
  assert.match(ignore.error, /permits no tools/);
});

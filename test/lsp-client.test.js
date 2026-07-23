import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLspClient,
  diagnosticKey,
  filterNewDiagnostics,
  findGitWorkspace,
  formatLspDiagnostics
} from "../src/lsp-client.js";

function makeWorkspace({ git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lsp-"));
  if (git) fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function cleanWorkspace(t, root) {
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
}

function writeStubServer(root) {
  const serverPath = path.join(root, "stub-lsp.mjs");
  fs.writeFileSync(serverPath, `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function diagnostics(uri, text) {
  const rows = [];
  const lines = String(text).split(/\\r?\\n/);
  const baselineLine = lines.findIndex((line) => line.includes("BASELINE_ERROR"));
  const typeLine = lines.findIndex((line) => line.includes("TYPE_ERROR"));
  if (baselineLine >= 0) rows.push({
    range: { start: { line: baselineLine, character: 0 }, end: { line: baselineLine, character: 8 } },
    severity: 1,
    source: "stub",
    message: "existing problem"
  });
  if (typeLine >= 0) rows.push({
    range: { start: { line: typeLine, character: 4 }, end: { line: typeLine, character: 14 } },
    severity: 1,
    code: "type-mismatch",
    source: "stub",
    message: "string is not assignable to number"
  });
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: rows } });
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
  } else if (message.method === "textDocument/didOpen") {
    diagnostics(message.params.textDocument.uri, message.params.textDocument.text);
  } else if (message.method === "textDocument/didChange") {
    diagnostics(message.params.textDocument.uri, message.params.contentChanges[0].text);
  } else if (message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
`, "utf8");
  return serverPath;
}

test("LSP client filters baseline diagnostics and formats only introduced errors", async (t) => {
  const root = makeWorkspace();
  const serverPath = writeStubServer(root);
  const filePath = path.join(root, "sample.py");
  fs.writeFileSync(filePath, "BASELINE_ERROR = True\nvalue = 1\n", "utf8");
  const client = createLspClient({
    config: {
      servers: {
        pyright: {
          command: process.execPath,
          args: [serverPath],
          extensions: [".py"],
          languageId: "python"
        }
      }
    },
    diagnosticTimeoutMs: 1000,
    diagnosticSettleMs: 20,
    idleTimeoutMs: 10_000
  });
  t.after(() => client.close());
  cleanWorkspace(t, root);

  const baseline = await client.getDiagnostics(filePath);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].message, "existing problem");

  fs.writeFileSync(filePath, "BASELINE_ERROR = True\n    TYPE_ERROR\n", "utf8");
  const after = await client.getDiagnostics(filePath);
  const introduced = filterNewDiagnostics(after, baseline);
  assert.equal(introduced.length, 1);
  assert.equal(introduced[0].line, 2);
  assert.equal(introduced[0].column, 5);
  assert.equal(introduced[0].code, "type-mismatch");
  assert.match(diagnosticKey(introduced[0]), /string is not assignable/);
  assert.equal(
    formatLspDiagnostics(filePath, introduced),
    `LSP diagnostics introduced by this edit:\n<diagnostics file="${filePath}">ERROR [2:5] string is not assignable to number</diagnostics>`
  );
});

test("missing language server is a silent diagnostics-only fallback", async (t) => {
  const root = makeWorkspace();
  const filePath = path.join(root, "sample.py");
  fs.writeFileSync(filePath, "value = 1\n", "utf8");
  const client = createLspClient({
    env: { ...process.env, PATH: "" },
    config: {
      servers: {
        pyright: {
          command: "definitely-not-an-openagi-language-server",
          extensions: [".py"]
        }
      }
    }
  });
  t.after(() => client.close());
  cleanWorkspace(t, root);
  await assert.doesNotReject(() => client.getDiagnostics(filePath));
  assert.deepEqual(await client.getDiagnostics(filePath), []);
});

test("LSP remains dormant outside git workspaces", async (t) => {
  const root = makeWorkspace({ git: false });
  const filePath = path.join(root, "sample.py");
  fs.writeFileSync(filePath, "TYPE_ERROR\n", "utf8");
  let spawnCalls = 0;
  const client = createLspClient({
    config: {
      servers: {
        pyright: {
          command: process.execPath,
          args: ["unused.mjs"],
          extensions: [".py"]
        }
      }
    },
    spawnImpl() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    }
  });
  t.after(() => client.close());
  cleanWorkspace(t, root);
  assert.equal(findGitWorkspace(filePath), null);
  assert.deepEqual(await client.getDiagnostics(filePath), []);
  assert.equal(spawnCalls, 0);
});

test("OPENAGI_LSP=0 disables discovery and subprocess startup", async (t) => {
  const root = makeWorkspace();
  const filePath = path.join(root, "sample.py");
  fs.writeFileSync(filePath, "TYPE_ERROR\n", "utf8");
  let spawnCalls = 0;
  const client = createLspClient({
    env: { ...process.env, OPENAGI_LSP: "0" },
    config: {
      servers: {
        pyright: {
          command: process.execPath,
          args: ["unused.mjs"],
          extensions: [".py"]
        }
      }
    },
    spawnImpl() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    }
  });
  t.after(() => client.close());
  cleanWorkspace(t, root);
  assert.deepEqual(await client.getDiagnostics(filePath), []);
  assert.equal(spawnCalls, 0);
});

test("formatLspDiagnostics escapes file attributes and diagnostic text", () => {
  const formatted = formatLspDiagnostics('a&"b.py', [{
    severity: "warning",
    line: 3,
    column: 7,
    message: "x < y"
  }]);
  assert.equal(
    formatted,
    'LSP diagnostics introduced by this edit:\n<diagnostics file="a&amp;&quot;b.py">WARNING [3:7] x &lt; y</diagnostics>'
  );
  assert.equal(formatLspDiagnostics("sample.py", []), null);
});

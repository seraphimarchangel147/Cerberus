import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintTag, registerCodeTools } from "../src/code-tools.js";

function makeHarness(t, lspClient) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lsp-tools-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const definitions = new Map();
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, { dataDir }, { lspClient });
  return { dataDir, definitions };
}

function diagnostic(message, line, column) {
  return {
    severity: "ERROR",
    line,
    column,
    endLine: line,
    endColumn: column + 1,
    message,
    source: "stub"
  };
}

test("code_write reports only diagnostics introduced by the new content", async (t) => {
  const baseline = diagnostic("existing issue", 1, 1);
  const introduced = diagnostic("introduced type mismatch", 2, 7);
  const snapshots = [];
  const lspClient = {
    async getDiagnostics(filePath) {
      const content = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8")
        : "";
      snapshots.push(content);
      return content.includes("wrongType")
        ? [baseline, introduced]
        : [baseline];
    }
  };
  const { dataDir, definitions } = makeHarness(t, lspClient);
  const target = path.join(dataDir, "sample.ts");
  const before = "const stable: number = 1;\n";
  const after = `${before}const wrongType: number = "text";\n`;
  fs.writeFileSync(target, before, "utf8");

  const result = await definitions.get("code_write").handler({
    path: target,
    content: after
  });

  assert.deepEqual(snapshots, [before, after], "the baseline must be captured before the write");
  assert.equal(result.lint, null);
  assert.match(
    result.lsp_diagnostics,
    /^LSP diagnostics introduced by this edit:\n<diagnostics file="[^"]+">/
  );
  assert.match(result.lsp_diagnostics, /ERROR \[2:7\] introduced type mismatch/);
  assert.doesNotMatch(result.lsp_diagnostics, /existing issue/);
});

test("code_edit uses the same baseline filtering path", async (t) => {
  const baseline = diagnostic("existing issue", 1, 1);
  const introduced = diagnostic("new edit issue", 2, 1);
  const lspClient = {
    async getDiagnostics(filePath) {
      const content = fs.readFileSync(filePath, "utf8");
      return content.includes("changed")
        ? [baseline, introduced]
        : [baseline];
    }
  };
  const { dataDir, definitions } = makeHarness(t, lspClient);
  const target = path.join(dataDir, "edit.ts");
  const before = "stable\noriginal\n";
  fs.writeFileSync(target, before, "utf8");

  const result = await definitions.get("code_edit").handler({
    path: target,
    tag: mintTag(before),
    edits: [{ start: 2, end: 2, replace: "changed" }]
  });

  assert.match(result.lsp_diagnostics, /ERROR \[2:1\] new edit issue/);
  assert.doesNotMatch(result.lsp_diagnostics, /existing issue/);
});

test("syntax errors suppress the post-write LSP query", async (t) => {
  let calls = 0;
  const lspClient = {
    async getDiagnostics() {
      calls += 1;
      return [];
    }
  };
  const { dataDir, definitions } = makeHarness(t, lspClient);
  const target = path.join(dataDir, "broken.js");
  fs.writeFileSync(target, "const valid = true;\n", "utf8");

  const result = await definitions.get("code_write").handler({
    path: target,
    content: "const broken = ;\n"
  });

  assert.notEqual(result.lint, "ok");
  assert.equal(result.lsp_diagnostics, null);
  assert.equal(calls, 1, "only the pre-write baseline may run when syntax validation fails");
});

test("a flaky baseline never breaks a write or produces stale diagnostics", async (t) => {
  let calls = 0;
  const lspClient = {
    async getDiagnostics() {
      calls += 1;
      throw new Error("stub server unavailable");
    }
  };
  const { dataDir, definitions } = makeHarness(t, lspClient);
  const target = path.join(dataDir, "flaky.ts");

  const result = await definitions.get("code_write").handler({
    path: target,
    content: "export const value: number = 1;\n"
  });

  assert.equal(fs.readFileSync(target, "utf8"), "export const value: number = 1;\n");
  assert.equal(result.lsp_diagnostics, null);
  assert.equal(calls, 1);
});

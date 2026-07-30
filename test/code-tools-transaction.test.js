import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mintTag, registerCodeTools } from "../src/code-tools.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-code-transaction-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const definitions = new Map();
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, { dataDir }, {
    lspClient: { getDiagnostics: async () => [] },
    ...options
  });
  return { dataDir, definitions, root };
}

test("content tags are full exact-byte SHA-256 digests", () => {
  const tag = mintTag("alpha\n");
  assert.match(tag, /^[a-f0-9]{64}$/u);
  assert.equal(tag, mintTag("alpha\n"));
  assert.notEqual(tag, mintTag("alpha\r\n"));
  assert.notEqual(tag, mintTag("beta\n"));
});

test("code_write rejects blind and stale overwrites, then commits exact CAS", async (t) => {
  const { dataDir, definitions } = harness(t);
  const target = path.join(dataDir, "state.txt");
  const before = "before\n";
  const after = "after\n";
  fs.writeFileSync(target, before, { encoding: "utf8", mode: 0o640 });

  await assert.rejects(
    definitions.get("code_write").handler({ path: target, content: after }),
    /Blind overwrite rejected/u
  );
  assert.equal(fs.readFileSync(target, "utf8"), before);

  await assert.rejects(
    definitions.get("code_write").handler({
      path: target,
      content: after,
      expectedTag: "0".repeat(64)
    }),
    /Stale write/u
  );
  assert.equal(fs.readFileSync(target, "utf8"), before);

  const result = await definitions.get("code_write").handler({
    path: target,
    content: after,
    expectedTag: mintTag(before)
  });
  assert.equal(fs.readFileSync(target, "utf8"), after);
  assert.equal(result.previousTag, mintTag(before));
  assert.equal(result.tag, mintTag(after));
  assert.equal(result.atomic, true);
  assert.equal(result.created, false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  }
});

test("code_write creation loses safely when another writer creates the target", async (t) => {
  let target;
  let raced = false;
  const { dataDir, definitions } = harness(t, {
    beforeFsOperation({ operation }) {
      if (operation !== "write" || raced) return;
      raced = true;
      fs.writeFileSync(target, "external winner\n", "utf8");
    }
  });
  target = path.join(dataDir, "race.txt");

  await assert.rejects(
    definitions.get("code_write").handler({
      path: target,
      content: "agent candidate\n"
    }),
    /was created before commit/u
  );
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(target, "utf8"), "external winner\n");
});

test("code_edit detects a change after planning and preserves the winner", async (t) => {
  let target;
  let raced = false;
  const { dataDir, definitions } = harness(t, {
    beforeFsOperation({ operation }) {
      if (operation !== "edit-write" || raced) return;
      raced = true;
      fs.writeFileSync(target, "external winner\n", "utf8");
    }
  });
  target = path.join(dataDir, "edit-race.txt");
  const before = "first\nsecond\n";
  fs.writeFileSync(target, before, "utf8");

  await assert.rejects(
    definitions.get("code_edit").handler({
      path: target,
      tag: mintTag(before),
      edits: [{ start: 2, end: 2, replace: "agent candidate" }]
    }),
    /Stale write/u
  );
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(target, "utf8"), "external winner\n");
});

test("syntax-invalid JavaScript never replaces or creates a target", async (t) => {
  const { dataDir, definitions } = harness(t);
  const existing = path.join(dataDir, "existing.js");
  const missing = path.join(dataDir, "missing.js");
  const before = "export const value = 1;\n";
  fs.writeFileSync(existing, before, "utf8");

  await assert.rejects(
    definitions.get("code_write").handler({
      path: existing,
      content: "export const value = ;\n",
      expectedTag: mintTag(before)
    }),
    /Syntax validation failed.*no file was changed/su
  );
  await assert.rejects(
    definitions.get("code_write").handler({
      path: missing,
      content: "export const value = ;\n"
    }),
    /Syntax validation failed.*no file was changed/su
  );
  assert.equal(fs.readFileSync(existing, "utf8"), before);
  assert.equal(fs.existsSync(missing), false);
});

test("atomic writer failure leaves existing bytes untouched", async (t) => {
  const { dataDir, definitions } = harness(t, {
    writeTextAtomic() {
      throw new Error("simulated atomic writer failure");
    }
  });
  const target = path.join(dataDir, "failure.txt");
  const before = "before\n";
  fs.writeFileSync(target, before, "utf8");

  await assert.rejects(
    definitions.get("code_write").handler({
      path: target,
      content: "after\n",
      expectedTag: mintTag(before)
    }),
    /simulated atomic writer failure/u
  );
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("registry rejects legacy short edit tags before filesystem dispatch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-code-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registerCodeTools(registry, { dataDir: root }, {
    lspClient: { getDiagnostics: async () => [] }
  });
  const target = path.join(root, "state.txt");
  fs.writeFileSync(target, "before\n", "utf8");

  const result = await registry.invoke("code_edit", {
    path: target,
    tag: "abcd",
    edits: [{ start: 1, end: 1, replace: "after" }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome.code, "invalid_tool_arguments");
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
});

test("static tool guidance documents transactional code contracts", () => {
  const prompt = buildDefaultInstructions({ agent: { name: "Code Tester" } });
  for (const name of [
    "code_read",
    "code_search",
    "code_edit",
    "code_write",
    "code_lint",
    "code_test",
    "code_shell"
  ]) {
    assert.match(prompt, new RegExp(`\\b${name}\\b`, "u"));
  }
  assert.match(prompt, /SHA-256 expectedTag/u);
  assert.match(prompt, /Read before editing/u);
});

test("code_shell guidance requires exact PID cleanup and rejects broad pkill", (t) => {
  const { definitions } = harness(t);
  const description = definitions.get("code_shell").description;

  assert.match(description, /PID/u);
  assert.match(description, /pkill/u);
});

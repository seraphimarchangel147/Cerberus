import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { registerCodeTools } from "../src/code-tools.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-code-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, alpha, beta, dataDir };
}

function codeTools(runtime, options = {}) {
  const definitions = new Map();
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, runtime, options);
  return definitions;
}

function projectContext(projectId, workspaceDir) {
  return {
    __projectId: projectId,
    __projectWorkspaceDir: workspaceDir,
    __projectSecretRefs: []
  };
}

test("nondefault code tools resolve relative operands inside only their project workspace", async (t) => {
  const { alpha, beta, dataDir } = fixture(t);
  fs.writeFileSync(path.join(beta, "private.txt"), "beta-only", "utf8");
  const tools = codeTools({ dataDir });
  const alphaContext = projectContext("alpha", alpha);

  await tools.get("code_write").handler({
    path: "owned.txt",
    content: "alpha-only"
  }, alphaContext);
  assert.equal(fs.readFileSync(path.join(alpha, "owned.txt"), "utf8"), "alpha-only");

  await assert.rejects(
    tools.get("code_read").handler({ path: path.join(beta, "private.txt") }, alphaContext),
    /outside allowed roots|unsafe path/i
  );
  await assert.rejects(
    tools.get("code_write").handler({
      path: path.join("..", "beta", "escape.txt"),
      content: "blocked"
    }, alphaContext),
    /outside allowed roots|unsafe path/i
  );
  assert.equal(fs.existsSync(path.join(beta, "escape.txt")), false);

  const search = await tools.get("code_search").handler({
    pattern: "beta-only",
    dir: "."
  }, alphaContext);
  assert.deepEqual(search.matches, []);
});

test("code writes revalidate ancestor links immediately before mutation", async (t) => {
  const { alpha, beta, dataDir } = fixture(t);
  const pivot = path.join(alpha, "pivot");
  fs.mkdirSync(pivot);
  let swapped = false;
  const tools = codeTools({ dataDir }, {
    beforeFsOperation({ operation }) {
      if (operation !== "write" || swapped) return;
      swapped = true;
      fs.rmdirSync(pivot);
      fs.symlinkSync(
        beta,
        pivot,
        process.platform === "win32" ? "junction" : "dir"
      );
    }
  });

  await assert.rejects(
    tools.get("code_write").handler({
      path: path.join("pivot", "escape.txt"),
      content: "must-stay-contained"
    }, projectContext("alpha", alpha)),
    /outside allowed roots|unsafe path/i
  );
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(beta, "escape.txt")), false);
});

test("project shell calls fail closed because cwd is not a filesystem sandbox", async (t) => {
  const { alpha, dataDir } = fixture(t);
  const secrets = {
    listSecrets: () => [{ name: "PROJECT_TOKEN", configured: true }],
    exportEnv: () => ({ PROJECT_TOKEN: "secret-value" })
  };
  const tools = codeTools({ dataDir, secrets }, {
    runShell: async () => assert.fail("project shell runner must not execute")
  });

  await assert.rejects(
    tools.get("code_shell").handler({
      command: "cat ../beta/private.txt; printf \"$PROJECT_TOKEN\""
    }, projectContext("alpha", alpha)),
    /not a filesystem sandbox/i
  );
  assert.throws(
    () => tools.get("code_shell").preflight(
      { command: "pwd" },
      projectContext("alpha", alpha)
    ),
    /unavailable in isolated project/i
  );
});

test("project tests use Node permissions and cannot read sibling workspaces", async (t) => {
  const { alpha, beta, dataDir } = fixture(t);
  const secret = "beta-project-secret";
  fs.writeFileSync(path.join(beta, "private.txt"), secret, "utf8");
  fs.writeFileSync(
    path.join(alpha, "isolation.test.js"),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import test from "node:test";',
      'test("cannot read a sibling project", () => {',
      '  fs.readFileSync(path.join("..", "beta", "private.txt"), "utf8");',
      '});',
      'test("cannot mutate the project from a read-only test tool", () => {',
      '  fs.writeFileSync("escaped.txt", "mutated", "utf8");',
      '});'
    ].join("\n"),
    "utf8"
  );
  const tools = codeTools({ dataDir });
  const result = await tools.get("code_test").handler({
    file: "isolation.test.js"
  }, projectContext("alpha", alpha));

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(alpha, "escaped.txt")), false);
  assert.doesNotMatch(result.tail, new RegExp(secret));
  assert.match(result.tail, /restricted|access denied|ERR_ACCESS_DENIED/i);
});

test("checkpoints retain project ownership for list, preview, and rollback", (t) => {
  const { alpha, beta, dataDir } = fixture(t);
  const target = path.join(alpha, "state.txt");
  fs.writeFileSync(target, "before", "utf8");
  const checkpoints = new CheckpointStore({
    dataDir,
    workspaceDir: beta,
    allowedRoots: [beta],
    enabled: true
  });

  checkpoints.beforeToolCall({
    toolName: "code_write",
    args: { path: target, content: "after" },
    context: {
      ...projectContext("alpha", alpha),
      sessionId: "session-alpha",
      __turnId: "turn-alpha"
    }
  });
  fs.writeFileSync(target, "after", "utf8");

  const alphaRows = checkpoints.list({ projectId: "alpha" });
  assert.equal(alphaRows.length, 1);
  assert.deepEqual(checkpoints.list({ projectId: "beta" }), []);
  assert.throws(
    () => checkpoints.preview(alphaRows[0].id, { projectId: "beta" }),
    /outside the current project/i
  );
  assert.throws(
    () => checkpoints.rollback(alphaRows[0].id, { projectId: "beta" }),
    /not found|outside|project/i
  );
  assert.equal(
    checkpoints.preview(alphaRows[0].id, {
      projectId: "alpha",
      path: target
    }).files[0].status,
    "modified"
  );
  checkpoints.rollback(alphaRows[0].id, {
    projectId: "alpha",
    path: target,
    decidedBy: "test"
  });
  assert.equal(fs.readFileSync(target, "utf8"), "before");
});

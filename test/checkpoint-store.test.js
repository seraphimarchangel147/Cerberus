import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CheckpointStore,
  CheckpointTargetError,
  checkpointsEnabled,
  extractShellMutationTargets
} from "../src/checkpoint-store.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-checkpoints-"));
  const workspaceDir = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspaceDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true,
    ...options
  });
  return { root, workspaceDir, dataDir, store };
}

test("disabled checkpoints perform no filesystem reads or writes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-checkpoints-off-"));
  const dir = path.join(root, "must-not-exist");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore({ dir, enabled: false });

  assert.equal(checkpointsEnabled({ OPENAGI_CHECKPOINTS: "1" }), true);
  assert.equal(checkpointsEnabled({ OPENAGI_CHECKPOINTS: "0" }), false);
  assert.deepEqual(store.beforeToolCall({
    toolName: "code_write",
    args: { get path() { throw new Error("disabled store read args"); } }
  }), { enabled: false, destructive: false, targets: [], checkpoints: [] });
  assert.deepEqual(store.capture({}), []);
  assert.equal(store.get("anything"), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.preview("anything"), null);
  assert.equal(store.rollback("anything"), null);
  assert.equal(fs.existsSync(dir), false);
});

test("credential files and secret storage are rejected before blob capture", (t) => {
  const { root, workspaceDir, dataDir, store } = fixture(t, {
    allowedRoots: undefined
  });
  const envPath = path.join(workspaceDir, ".env");
  const secretPath = path.join(dataDir, "secrets", "secrets.json");
  const nodeConfigPath = path.join(dataDir, "node.json");
  const mcpConfigPath = path.join(dataDir, "mcp.json");
  const nodeCachePath = path.join(dataDir, "nodes", "cache.json");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.mkdirSync(path.dirname(nodeCachePath), { recursive: true });
  fs.writeFileSync(envPath, "API_KEY=checkpoint-canary\n", "utf8");
  fs.writeFileSync(secretPath, "{\"secret\":\"checkpoint-canary\"}\n", "utf8");
  fs.writeFileSync(nodeConfigPath, "{\"token\":\"checkpoint-canary\"}\n", "utf8");
  fs.writeFileSync(mcpConfigPath, "{\"apiKey\":\"checkpoint-canary\"}\n", "utf8");
  fs.writeFileSync(nodeCachePath, "{\"reflected\":\"checkpoint-canary\"}\n", "utf8");

  assert.throws(
    () => store.beforeToolCall({
      toolName: "code_write",
      args: { path: envPath },
      context: { __turnId: "turn-env" }
    }),
    /sensitive credential material/
  );
  assert.throws(
    () => store.beforeToolCall({
      toolName: "code_write",
      args: { path: path.join(workspaceDir, ".envrc") },
      context: { __turnId: "turn-envrc" }
    }),
    /sensitive credential material/
  );

  const dataStore = new CheckpointStore({
    dataDir,
    workspaceDir: root,
    allowedRoots: [root],
    enabled: true
  });
  assert.throws(
    () => dataStore.beforeToolCall({
      toolName: "code_edit",
      args: { path: secretPath },
      context: { __turnId: "turn-secret" }
    }),
    /sensitive credential material/
  );
  for (const [target, turnId] of [
    [nodeConfigPath, "turn-node-config"],
    [mcpConfigPath, "turn-mcp-config"],
    [nodeCachePath, "turn-node-cache"]
  ]) {
    assert.throws(
      () => dataStore.beforeToolCall({
        toolName: "code_edit",
        args: { path: target },
        context: { __turnId: turnId }
      }),
      /sensitive credential material/
    );
  }
  assert.equal(fs.existsSync(path.join(dataDir, "checkpoints", "blobs")), false);
});

test("raw bytes, mode, JSONL index, and atomic snapshot survive reload", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "binary.dat");
  const before = Buffer.from([0, 1, 2, 10, 13, 128, 255]);
  fs.writeFileSync(target, before, { mode: 0o640 });
  fs.chmodSync(target, 0o640);

  const [checkpoint] = store.capture({
    turnId: "turn-binary",
    sessionId: "session-binary",
    toolName: "code_write",
    targets: [target]
  });
  const hash = createHash("sha256").update(before).digest("hex");
  const blob = path.join(dataDir, "checkpoints", "blobs", hash.slice(0, 2), hash);
  assert.deepEqual(checkpoint.targets, [target]);
  assert.deepEqual(fs.readFileSync(blob), before);
  assert.ok(fs.existsSync(path.join(dataDir, "checkpoints", "index.jsonl")));
  assert.ok(fs.existsSync(path.join(dataDir, "checkpoints", "snapshot.json")));

  fs.writeFileSync(target, Buffer.from("changed"));
  fs.chmodSync(target, 0o600);
  const reloaded = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true
  });
  const result = reloaded.rollback(checkpoint.id, { decidedBy: "test" });
  assert.deepEqual(result.restored, [target]);
  assert.deepEqual(fs.readFileSync(target), before);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test("rollback removes a path that did not exist before code_write", (t) => {
  const { workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "created.txt");
  const [checkpoint] = store.capture({
    turnId: "turn-create",
    sessionId: "session-create",
    toolName: "code_write",
    targets: [target]
  });
  fs.writeFileSync(target, "new file", "utf8");

  const preview = store.preview(checkpoint.id);
  assert.equal(preview.files[0].status, "created");
  const result = store.rollback(checkpoint.id, { decidedBy: "test" });
  assert.deepEqual(result.removed, [target]);
  assert.equal(fs.existsSync(target), false);
});

test("same turn and directory dedupe while preserving first-seen bytes", (t) => {
  const { workspaceDir, store } = fixture(t);
  const first = path.join(workspaceDir, "first.txt");
  const second = path.join(workspaceDir, "second.txt");
  fs.writeFileSync(first, "first-original", "utf8");
  fs.writeFileSync(second, "second-original", "utf8");

  const [initial] = store.capture({
    turnId: "turn-one",
    sessionId: "session-one",
    toolName: "code_edit",
    targets: [first]
  });
  fs.writeFileSync(first, "first-mid-turn", "utf8");
  const [extended] = store.capture({
    turnId: "turn-one",
    sessionId: "session-one",
    toolName: "code_write",
    targets: [first, second]
  });

  assert.equal(extended.id, initial.id);
  assert.deepEqual([...extended.targets].sort(), [first, second].sort());
  assert.equal(store.list().length, 1);
  fs.writeFileSync(first, "first-final", "utf8");
  fs.writeFileSync(second, "second-final", "utf8");
  store.rollback(initial.id, { decidedBy: "test" });
  assert.equal(fs.readFileSync(first, "utf8"), "first-original");
  assert.equal(fs.readFileSync(second, "utf8"), "second-original");

  store.capture({ turnId: "turn-two", toolName: "code_edit", targets: [first] });
  assert.equal(store.list().length, 2, "a new turn creates a new directory checkpoint");
});

test("preview is bounded and rollback can restore one file or a whole checkpoint", (t) => {
  const { workspaceDir, store } = fixture(t, { previewMaxChars: 80 });
  const first = path.join(workspaceDir, "a.txt");
  const second = path.join(workspaceDir, "b.txt");
  fs.writeFileSync(first, "a\n".repeat(100), "utf8");
  fs.writeFileSync(second, "b-before\n", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-preview",
    sessionId: "session-preview",
    toolName: "code_edit",
    targets: [first, second]
  });
  fs.writeFileSync(first, "changed-a\n".repeat(100), "utf8");
  fs.writeFileSync(second, "b-after\n", "utf8");

  const preview = store.preview(checkpoint.id);
  assert.equal(preview.truncated, true);
  assert.ok(preview.files.reduce((sum, file) => sum + file.diff.length, 0) <= 80);
  assert.equal(preview.files[0].status, "modified");

  const one = store.rollback(checkpoint.id, { path: second, decidedBy: "test" });
  assert.deepEqual(one.restored, [second]);
  assert.equal(fs.readFileSync(second, "utf8"), "b-before\n");
  assert.match(fs.readFileSync(first, "utf8"), /changed-a/);
  fs.rmSync(first);
  fs.mkdirSync(first);
  const all = store.rollback(checkpoint.id, { decidedBy: "test" });
  assert.ok(all.restored.includes(first));
  assert.equal(fs.readFileSync(first, "utf8"), "a\n".repeat(100));
  assert.throws(
    () => store.rollback(checkpoint.id, { sessionId: "another-session" }),
    /does not belong to this session/
  );
});

test("index replay tolerates a corrupt tail and restores a missing snapshot", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "replay.txt");
  fs.writeFileSync(target, "before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-replay",
    sessionId: "session-replay",
    toolName: "code_write",
    targets: [target]
  });
  const storeDir = path.join(dataDir, "checkpoints");
  fs.unlinkSync(path.join(storeDir, "snapshot.json"));
  fs.appendFileSync(path.join(storeDir, "index.jsonl"), "{corrupt-tail", "utf8");

  const replayed = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true
  });
  assert.equal(replayed.get(checkpoint.id).id, checkpoint.id);
  assert.deepEqual(replayed.get(checkpoint.id).targets, [target]);
});

test("blob integrity failure blocks rollback before changing files", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "integrity.txt");
  fs.writeFileSync(target, "trusted-before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-integrity",
    toolName: "code_write",
    targets: [target]
  });
  const hash = checkpoint.entries[0].hash;
  fs.writeFileSync(path.join(dataDir, "checkpoints", "blobs", hash.slice(0, 2), hash), "tampered", "utf8");
  fs.writeFileSync(target, "current-must-survive", "utf8");

  assert.throws(() => store.rollback(checkpoint.id), /integrity check/);
  assert.equal(fs.readFileSync(target, "utf8"), "current-must-survive");
});

test("blob symlinks cannot make preview or rollback read outside checkpoint storage", (t) => {
  const { root, dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "symlink-blob.txt");
  const outside = path.join(root, "outside-blob.txt");
  fs.writeFileSync(target, "trusted-before", "utf8");
  fs.writeFileSync(outside, "trusted-before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-symlink-blob",
    toolName: "code_write",
    targets: [target]
  });
  const hash = checkpoint.entries[0].hash;
  const blobPath = path.join(dataDir, "checkpoints", "blobs", hash.slice(0, 2), hash);
  fs.rmSync(blobPath);
  try {
    fs.symlinkSync(outside, blobPath, "file");
  } catch {
    t.skip("file symlinks are unavailable on this platform");
    return;
  }
  fs.writeFileSync(target, "current-must-survive", "utf8");

  assert.throws(() => store.preview(checkpoint.id), /integrity check/);
  assert.throws(() => store.rollback(checkpoint.id), /integrity check/);
  assert.equal(fs.readFileSync(target, "utf8"), "current-must-survive");
});

test("shell extraction covers rm, mv, and sed -i and rejects ambiguous targets", (t) => {
  const { workspaceDir, store } = fixture(t);
  const spaced = path.join(workspaceDir, "space name.txt");
  const source = path.join(workspaceDir, "source.txt");
  const destination = path.join(workspaceDir, "destination.txt");
  const edited = path.join(workspaceDir, "edited.txt");
  for (const file of [spaced, source, destination, edited]) fs.writeFileSync(file, `before:${path.basename(file)}`, "utf8");

  const parsed = extractShellMutationTargets(
    'rm -f "space name.txt" && mv source.txt destination.txt; sed -i "s/before/after/" edited.txt',
    { cwd: workspaceDir }
  );
  assert.equal(parsed.destructive, true);
  assert.deepEqual(new Set(parsed.targets), new Set([spaced, source, destination, edited]));

  const prefixed = extractShellMutationTargets(
    "sudo -u root rm -f 'space name.txt'; sed -i '' 's/x/y/' edited.txt",
    { cwd: workspaceDir }
  );
  assert.deepEqual(new Set(prefixed.targets), new Set([spaced, edited]));

  const environmentPrefixed = extractShellMutationTargets(
    "KEEP=1 rm source.txt; env KEEP=1 mv destination.txt edited.txt; sudo command rm 'space name.txt'",
    { cwd: workspaceDir }
  );
  assert.deepEqual(
    new Set(environmentPrefixed.targets),
    new Set([source, destination, edited, spaced])
  );

  const captured = store.beforeToolCall({
    toolName: "code_shell",
    args: { command: "rm -f 'space name.txt'; sed -i 's/x/y/' edited.txt", cwd: workspaceDir },
    context: { sessionId: "session-shell", __turnId: "turn-shell" }
  });
  assert.equal(captured.destructive, true);
  assert.equal(captured.checkpoints.length, 1);
  assert.deepEqual(new Set(captured.targets), new Set([spaced, edited]));

  assert.throws(
    () => store.beforeToolCall({
      toolName: "code_shell",
      args: { command: "rm -f $TARGET", cwd: workspaceDir },
      context: { __turnId: "turn-ambiguous" }
    }),
    (error) => error instanceof CheckpointTargetError && error.code === "CHECKPOINT_TARGET_AMBIGUOUS"
  );
  assert.throws(
    () => extractShellMutationTargets("mv -t destination source.txt", { cwd: workspaceDir }),
    (error) => error instanceof CheckpointTargetError && error.code === "CHECKPOINT_TARGET_AMBIGUOUS"
  );
  for (const command of [
    "cd nested && rm victim.txt",
    "(rm victim.txt)",
    "bash -c 'rm victim.txt'"
  ]) {
    assert.throws(
      () => extractShellMutationTargets(command, { cwd: workspaceDir }),
      (error) => error instanceof CheckpointTargetError && error.code === "CHECKPOINT_TARGET_AMBIGUOUS"
    );
  }
  assert.deepEqual(
    store.beforeToolCall({ toolName: "code_shell", args: { command: "printf safe" }, context: {} }),
    { enabled: true, destructive: false, targets: [], checkpoints: [] }
  );
});

test("symlink ancestors cannot escape the configured roots", (t) => {
  const { root, workspaceDir, store } = fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside", "utf8");
  const link = path.join(workspaceDir, "escape");
  try { fs.symlinkSync(outside, link, "dir"); }
  catch { t.skip("symlinks are unavailable on this platform"); return; }

  assert.throws(
    () => store.capture({
      turnId: "turn-escape",
      toolName: "code_write",
      targets: [path.join(link, "secret.txt")]
    }),
    /outside allowed roots/
  );
});

test("project checkpoint roots are explicit, immutable, and disjoint", (t) => {
  const { workspaceDir, store } = fixture(t);
  const alpha = path.join(workspaceDir, "alpha");
  const beta = path.join(workspaceDir, "beta");
  fs.mkdirSync(alpha);
  fs.mkdirSync(beta);
  const alphaTarget = path.join(alpha, "state.txt");
  const betaTarget = path.join(beta, "state.txt");
  fs.writeFileSync(alphaTarget, "alpha", "utf8");
  fs.writeFileSync(betaTarget, "beta", "utf8");

  assert.throws(
    () => store.capture({
      turnId: "turn-no-root",
      projectId: "alpha",
      toolName: "code_edit",
      targets: [alphaTarget]
    }),
    (error) => (
      error?.code === "PROJECT_BOUNDARY_VIOLATION"
      && /no verified workspace/i.test(error.message)
    )
  );

  const [checkpoint] = store.capture({
    turnId: "turn-alpha",
    projectId: "alpha",
    workspaceRoot: alpha,
    toolName: "code_edit",
    targets: [alphaTarget],
    allowedRoots: [workspaceDir]
  });
  assert.equal(checkpoint.projectId, "alpha");
  assert.equal(store.get(checkpoint.id), null);
  assert.deepEqual(store.list(), []);
  assert.throws(
    () => store.preview(checkpoint.id),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => store.rollback(checkpoint.id),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION"
  );

  assert.throws(
    () => store.capture({
      turnId: "turn-alpha-escape",
      projectId: "alpha",
      workspaceRoot: alpha,
      toolName: "code_edit",
      targets: [betaTarget],
      allowedRoots: [workspaceDir]
    }),
    /outside allowed roots/i,
    "nondefault capture must ignore a caller-supplied broader root"
  );
  assert.throws(
    () => store.capture({
      turnId: "turn-alpha-rebind",
      projectId: "alpha",
      workspaceRoot: beta,
      toolName: "code_edit",
      targets: [betaTarget]
    }),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => store.capture({
      turnId: "turn-beta-overlap",
      projectId: "beta",
      workspaceRoot: path.join(alpha, "nested"),
      toolName: "code_edit",
      targets: [path.join(alpha, "nested", "state.txt")]
    }),
    (error) => error?.code === "PROJECT_BOUNDARY_VIOLATION"
  );
});

test("rollback writes a durable intent before mutation and reconciles an uncertain restart", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "intent.txt");
  fs.writeFileSync(target, "before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-intent",
    sessionId: "session-intent",
    toolName: "code_edit",
    targets: [target]
  });
  fs.writeFileSync(target, "after", "utf8");

  const persist = store._persist.bind(store);
  store._persist = (op, ...args) => {
    if (op === "rollback") throw new Error("simulated completion audit failure");
    return persist(op, ...args);
  };
  assert.throws(
    () => store.rollback(checkpoint.id, { decidedBy: "test" }),
    /simulated completion audit failure/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "before");

  const events = fs.readFileSync(
    path.join(dataDir, "checkpoints", "index.jsonl"),
    "utf8"
  ).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(events.at(-1).op, "rollback_intent");
  assert.equal(events.at(-1).checkpoint.rollbacks.at(-1).status, "pending");

  const reloaded = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true
  });
  const reconciled = reloaded.get(checkpoint.id);
  assert.equal(reconciled.rollbacks.at(-1).status, "outcome_unknown");
  assert.match(reconciled.rollbacks.at(-1).error, /before rollback completion/i);
});

test("rollback audit history remains bounded while completion stays durable", (t) => {
  const { workspaceDir, store } = fixture(t, { maxRollbacks: 2 });
  const target = path.join(workspaceDir, "bounded-rollbacks.txt");
  fs.writeFileSync(target, "before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-bounded-rollbacks",
    toolName: "code_edit",
    targets: [target]
  });

  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(target, `after-${index}`, "utf8");
    const result = store.rollback(checkpoint.id, { decidedBy: "test" });
    assert.equal(result.restored.length, 1);
  }
  const current = store.get(checkpoint.id);
  assert.equal(current.rollbacks.length, 2);
  assert.deepEqual(current.rollbacks.map((event) => event.status), ["complete", "complete"]);
});

test("bounded replay ignores an oversized prefix, event, and snapshot", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "bounded.txt");
  fs.writeFileSync(target, "before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-bounded",
    toolName: "code_edit",
    targets: [target]
  });
  const dir = path.join(dataDir, "checkpoints");
  const validLine = fs.readFileSync(path.join(dir, "index.jsonl"), "utf8").trim();
  const poison = JSON.parse(validLine);
  poison.id = "cp_poison";
  poison.checkpoint.id = "cp_poison";
  poison.details = { padding: "x".repeat(Buffer.byteLength(validLine, "utf8") + 200) };
  const poisonLine = JSON.stringify(poison);
  const maxEventBytes = Buffer.byteLength(validLine, "utf8") + 16;
  const maxReplayBytes = (
    Buffer.byteLength(poisonLine, "utf8")
    + Buffer.byteLength(validLine, "utf8")
    + 64
  );
  fs.writeFileSync(
    path.join(dir, "index.jsonl"),
    `${"ignored-prefix".repeat(1000)}\n${poisonLine}\n${validLine}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "snapshot.json"), "x".repeat(2048), "utf8");

  const reloaded = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true,
    maxReplayBytes,
    maxEventBytes,
    maxSnapshotBytes: 1024
  });
  assert.equal(reloaded.get(checkpoint.id).id, checkpoint.id);
  assert.equal(reloaded.get("cp_poison"), null);
});

test("legacy default-project checkpoints without project fields still reload and roll back", (t) => {
  const { dataDir, workspaceDir, store } = fixture(t);
  const target = path.join(workspaceDir, "legacy.txt");
  fs.writeFileSync(target, "before", "utf8");
  const [checkpoint] = store.capture({
    turnId: "turn-legacy",
    sessionId: "session-legacy",
    toolName: "code_edit",
    targets: [target]
  });
  fs.writeFileSync(target, "after", "utf8");

  const dir = path.join(dataDir, "checkpoints");
  const snapshotPath = path.join(dir, "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  delete snapshot.checkpoints[0].projectId;
  delete snapshot.checkpoints[0].workspaceRoot;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  fs.rmSync(path.join(dir, "index.jsonl"));

  const reloaded = new CheckpointStore({
    dataDir,
    workspaceDir,
    allowedRoots: [workspaceDir],
    enabled: true
  });
  assert.equal(reloaded.get(checkpoint.id, { projectId: "default" }).id, checkpoint.id);
  assert.equal(reloaded.list({ projectId: "default" }).length, 1);
  reloaded.rollback(checkpoint.id, {
    projectId: "default",
    sessionId: "session-legacy",
    decidedBy: "legacy-test"
  });
  assert.equal(fs.readFileSync(target, "utf8"), "before");
});

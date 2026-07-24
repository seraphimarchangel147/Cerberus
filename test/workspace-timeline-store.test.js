import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WorkspaceTimelineConflictError,
  WorkspaceTimelineHeadError,
  WorkspaceTimelineStore
} from "../src/workspace-timeline-store.js";
import { ProjectStore } from "../src/project-store.js";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-timeline-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspace, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  let snapshotSequence = 0;
  let operationSequence = 0;
  let clock = 0;
  const store = new WorkspaceTimelineStore({
    dataDir,
    projects,
    workspaceDir: workspace,
    idFactory: () => (
      `timeline_${(++snapshotSequence).toString(16).padStart(16, "0")}`
    ),
    operationIdFactory: () => (
      `timeline_op_${(++operationSequence).toString(16).padStart(16, "0")}`
    ),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    ...options
  });
  t.after(() => {
    try { store.close(); } catch { /* test may intentionally corrupt state */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { dataDir, projects, root, store, workspace };
}

function write(workspace, relative, content) {
  const destination = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return destination;
}

test("timeline snapshots are content-addressed, deduplicated, diffable, and durable", (t) => {
  const h = harness(t);
  write(h.workspace, "state.txt", "one\n");
  const first = h.store.captureNow({
    projectId: "default",
    reason: "first"
  });
  const duplicate = h.store.captureNow({
    projectId: "default",
    reason: "unchanged"
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.deduplicated, true);

  write(h.workspace, "state.txt", "two\n");
  write(h.workspace, "added.txt", "new\n");
  const second = h.store.captureNow({
    projectId: "default",
    reason: "second",
    toolNames: ["code_write"]
  });
  assert.notEqual(second.contentHash, first.contentHash);

  const diff = h.store.diff(first.id, second.id, {
    projectId: "default",
    includeText: true
  });
  assert.deepEqual(diff.counts, {
    added: 1,
    deleted: 0,
    modified: 1,
    unchanged: 0
  });
  assert.equal(diff.items.some((item) => item.diff?.includes("-one")), true);
  assert.equal(diff.leftContentHash, first.contentHash);
  assert.equal(diff.rightContentHash, second.contentHash);
  assert.equal(
    fs.existsSync(path.join(
      h.dataDir,
      "workspace-timeline",
      "manifests",
      `${first.contentHash}.json`
    )),
    true
  );

  const reloaded = new WorkspaceTimelineStore({
    dataDir: h.dataDir,
    projects: h.projects,
    workspaceDir: h.workspace
  });
  t.after(() => reloaded.close());
  assert.deepEqual(
    reloaded.list({ projectId: "default" }).map((snapshot) => snapshot.id),
    [second.id, first.id]
  );
  assert.equal(reloaded.head("default").id, second.id);
});

test("travel snapshots current state and restores only eligible workspace content", (t) => {
  const h = harness(t, {
    maxFileBytes: 32,
    maxBinaryBytes: 4
  });
  write(h.workspace, "tracked.txt", "old\n");
  write(h.workspace, ".env", "TOKEN=first\n");
  write(h.workspace, "large.txt", "x".repeat(64));
  write(h.workspace, "large.bin", Buffer.from([0, 1, 2, 3, 4]));
  write(h.workspace, "vendor/.git/config", "nested repo\n");
  write(h.workspace, "linked-target/keep.txt", "target\n");
  let linkCreated = false;
  try {
    fs.symlinkSync(
      path.join(h.workspace, "linked-target"),
      path.join(h.workspace, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    linkCreated = true;
  } catch {
    // Some Windows environments disallow all link creation.
  }

  const first = h.store.captureNow({
    projectId: "default",
    reason: "old"
  });
  assert.equal(first.skipped.sensitive >= 1, true);
  assert.equal(first.skipped.repository >= 1, true);
  assert.equal(first.skipped.largeFile >= 1, true);
  assert.equal(first.skipped.largeBinary >= 1, true);
  if (linkCreated) assert.equal(first.skipped.symlink, 1);

  write(h.workspace, "tracked.txt", "new\n");
  const second = h.store.captureNow({
    projectId: "default",
    reason: "new"
  });
  write(h.workspace, "tracked.txt", "unsaved\n");
  write(h.workspace, "transient.txt", "remove me\n");
  write(h.workspace, ".env", "TOKEN=preserve\n");

  const preview = h.store.preview(first.id, {
    projectId: "default",
    action: "travel"
  });
  assert.equal(preview.items.some((item) => item.path === "tracked.txt"), true);
  assert.equal(preview.items.some((item) => item.path === ".env"), false);

  const recovered = h.store.travel(first.id, {
    projectId: "default",
    expectedHead: second.id,
    decidedBy: "test"
  });
  assert.equal(fs.readFileSync(path.join(h.workspace, "tracked.txt"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(h.workspace, "transient.txt")), false);
  assert.equal(fs.readFileSync(path.join(h.workspace, ".env"), "utf8"), "TOKEN=preserve\n");
  assert.equal(fs.existsSync(path.join(h.workspace, "large.txt")), true);
  assert.equal(fs.existsSync(path.join(h.workspace, "vendor/.git/config")), true);
  if (linkCreated) {
    assert.equal(fs.lstatSync(path.join(h.workspace, "linked")).isSymbolicLink(), true);
  }
  assert.equal(recovered.operation.status, "complete");
  assert.equal(recovered.before.reason, "before-travel");
  assert.equal(recovered.result.parentId, recovered.before.id);
  assert.equal(h.store.head("default").id, recovered.result.id);
});

test("revert is inverse, conflict-safe, and guarded by the current head", (t) => {
  const h = harness(t);
  write(h.workspace, "state.txt", "one\n");
  const first = h.store.captureNow({ projectId: "default", reason: "base" });
  write(h.workspace, "state.txt", "two\n");
  const second = h.store.captureNow({ projectId: "default", reason: "change" });

  assert.throws(
    () => h.store.revert(second.id, {
      projectId: "default",
      expectedHead: first.id
    }),
    WorkspaceTimelineHeadError
  );
  write(h.workspace, "state.txt", "unrelated\n");
  assert.throws(
    () => h.store.revert(second.id, {
      projectId: "default",
      expectedHead: second.id
    }),
    WorkspaceTimelineConflictError
  );
  const conflictHead = h.store.head("default");
  assert.equal(conflictHead.reason, "before-revert");
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "state.txt"), "utf8"),
    "unrelated\n"
  );

  write(h.workspace, "state.txt", "two\n");
  write(h.workspace, "side.txt", "preserved\n");
  const reverted = h.store.revert(second.id, {
    projectId: "default",
    expectedHead: conflictHead.id,
    decidedBy: "test"
  });
  assert.equal(reverted.operation.status, "complete");
  assert.equal(fs.readFileSync(path.join(h.workspace, "state.txt"), "utf8"), "one\n");
  assert.equal(fs.readFileSync(path.join(h.workspace, "side.txt"), "utf8"), "preserved\n");
});

test("timeline quotas, garbage collection, and integrity checks fail closed", (t) => {
  const quota = harness(t, { maxBlobBytes: 2 });
  write(quota.workspace, "too-big.txt", "abc");
  assert.throws(
    () => quota.store.captureNow({ projectId: "default" }),
    { code: "WORKSPACE_TIMELINE_QUOTA" }
  );
  assert.deepEqual(quota.store.list({ projectId: "default" }), []);

  const h = harness(t, { maxSnapshots: 2 });
  write(h.workspace, "state.txt", "one\n");
  const first = h.store.captureNow({ projectId: "default" });
  write(h.workspace, "state.txt", "two\n");
  h.store.captureNow({ projectId: "default" });
  write(h.workspace, "state.txt", "three\n");
  const third = h.store.captureNow({ projectId: "default" });
  assert.equal(h.store.list({ projectId: "default" }).length, 2);
  assert.equal(
    h.store.list({ projectId: "default" }).some((item) => item.id === first.id),
    false
  );

  const manifest = JSON.parse(fs.readFileSync(
    path.join(
      h.dataDir,
      "workspace-timeline",
      "manifests",
      `${third.contentHash}.json`
    ),
    "utf8"
  ));
  const blob = manifest.entries.find((entry) => entry.kind === "file").hash;
  fs.writeFileSync(
    path.join(h.dataDir, "workspace-timeline", "blobs", blob),
    "tampered"
  );
  assert.throws(
    () => h.store.travel(third.id, {
      projectId: "default",
      expectedHead: third.id
    }),
    { code: "WORKSPACE_TIMELINE_INTEGRITY" }
  );
});

test("timeline journals reject gaps and snapshots cannot cross project roots", (t) => {
  const h = harness(t);
  const alpha = h.projects.create({ id: "alpha", name: "Alpha" });
  const beta = h.projects.create({ id: "beta", name: "Beta" });
  write(alpha.workspaceRoot, "alpha.txt", "alpha\n");
  write(beta.workspaceRoot, "beta.txt", "beta\n");
  const alphaSnapshot = h.store.captureNow({ projectId: "alpha" });
  const betaSnapshot = h.store.captureNow({ projectId: "beta" });
  assert.equal(h.store.list({ projectId: "alpha" })[0].id, alphaSnapshot.id);
  assert.equal(h.store.list({ projectId: "beta" })[0].id, betaSnapshot.id);
  assert.throws(
    () => h.store.diff(alphaSnapshot.id, betaSnapshot.id, {
      projectId: "alpha"
    }),
    { code: "WORKSPACE_TIMELINE_NOT_FOUND" }
  );
  assert.throws(
    () => h.store.captureNow({
      projectId: "alpha",
      workspaceRoot: beta.workspaceRoot
    }),
    { code: "PROJECT_BOUNDARY_VIOLATION" }
  );

  fs.appendFileSync(
    path.join(h.dataDir, "workspace-timeline", "events.jsonl"),
    `${JSON.stringify({
      version: 1,
      sequence: 999,
      op: "gc",
      at: new Date().toISOString(),
      projectId: "alpha",
      removedSnapshots: []
    })}\n`
  );
  const corrupt = new WorkspaceTimelineStore({
    dataDir: h.dataDir,
    projects: h.projects,
    workspaceDir: h.workspace
  });
  assert.throws(
    () => corrupt.list({ projectId: "alpha" }),
    { code: "WORKSPACE_TIMELINE_JOURNAL_CORRUPT" }
  );
});

test("post-mutation captures debounce tool names and close flushes pending work", async (t) => {
  const h = harness(t, { debounceMs: 5 });
  write(h.workspace, "state.txt", "one\n");
  h.store.schedulePostMutation({
    toolName: "code_write",
    tool: { sideEffects: true },
    context: {
      __projectId: "default",
      __projectWorkspaceDir: h.workspace,
      sessionId: "session-a"
    },
    dispatched: true
  });
  h.store.schedulePostMutation({
    toolName: "code_edit",
    tool: { sideEffects: true },
    context: {
      __projectId: "default",
      __projectWorkspaceDir: h.workspace,
      sessionId: "session-a"
    },
    dispatched: true
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshots = h.store.list({ projectId: "default" });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].toolNames, ["code_edit", "code_write"]);

  write(h.workspace, "state.txt", "two\n");
  h.store.schedulePostMutation({
    toolName: "code_write",
    tool: { sideEffects: true },
    context: {
      __projectId: "default",
      __projectWorkspaceDir: h.workspace
    },
    dispatched: true
  });
  const flushed = h.store.close();
  assert.equal(flushed.length, 1);
  assert.equal(h.store.list({ projectId: "default" }).length, 2);
});

test("travel preserves target-opaque paths across eligibility transitions", (t) => {
  const h = harness(t, { maxFileBytes: 8 });
  write(h.workspace, "opaque.txt", "x".repeat(16));
  write(h.workspace, ".npmrc", "token=must-not-persist\n");
  write(h.workspace, ".git", "gitdir: elsewhere\n");
  const opaque = h.store.captureNow({
    projectId: "default",
    reason: "opaque"
  });
  assert.equal(opaque.skipped.largeFile, 1);
  assert.equal(opaque.skipped.sensitive, 1);
  assert.equal(opaque.skipped.repository, 1);

  write(h.workspace, "opaque.txt", "small\n");
  const eligible = h.store.captureNow({
    projectId: "default",
    reason: "eligible"
  });
  const preview = h.store.preview(opaque.id, {
    projectId: "default",
    action: "travel"
  });
  assert.equal(preview.safe, true);
  assert.equal(
    preview.items.some((item) => item.path === "opaque.txt"),
    false
  );
  h.store.travel(opaque.id, {
    projectId: "default",
    expectedHead: eligible.id
  });
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "opaque.txt"), "utf8"),
    "small\n"
  );
  const persisted = fs.readFileSync(
    path.join(h.dataDir, "workspace-timeline", "events.jsonl"),
    "utf8"
  );
  assert.equal(persisted.includes("must-not-persist"), false);
});

test("preview reports when an opaque current path blocks tracked recovery", (t) => {
  const h = harness(t, { maxFileBytes: 8 });
  write(h.workspace, "state.txt", "old\n");
  const tracked = h.store.captureNow({ projectId: "default" });
  write(h.workspace, "state.txt", "x".repeat(16));
  const opaque = h.store.captureNow({ projectId: "default" });

  const preview = h.store.preview(tracked.id, {
    projectId: "default",
    action: "travel"
  });
  assert.equal(preview.safe, false);
  assert.deepEqual(preview.conflicts, ["state.txt"]);
  assert.throws(
    () => h.store.travel(tracked.id, {
      projectId: "default",
      expectedHead: opaque.id
    }),
    WorkspaceTimelineConflictError
  );
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "state.txt"), "utf8"),
    "x".repeat(16)
  );
});

test("opaque preservation treats case-only paths as one identity", (t) => {
  const h = harness(t, { maxFileBytes: 8 });
  write(h.workspace, "OPAQUE.TXT", "x".repeat(16));
  const opaque = h.store.captureNow({ projectId: "default" });
  fs.unlinkSync(path.join(h.workspace, "OPAQUE.TXT"));
  write(h.workspace, "opaque.txt", "small\n");
  const eligible = h.store.captureNow({ projectId: "default" });

  const recovered = h.store.travel(opaque.id, {
    projectId: "default",
    expectedHead: eligible.id
  });
  assert.equal(recovered.operation.status, "complete");
  assert.equal(fs.existsSync(path.join(h.workspace, "opaque.txt")), true);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "opaque.txt"), "utf8"),
    "small\n"
  );
});

test("JSONL remains authoritative over a valid but false equal-sequence snapshot", (t) => {
  const h = harness(t);
  write(h.workspace, "state.txt", "one\n");
  const first = h.store.captureNow({ projectId: "default" });
  const snapshotPath = path.join(
    h.dataDir,
    "workspace-timeline",
    "snapshot.json"
  );
  const falseCache = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  falseCache.snapshots = [];
  fs.writeFileSync(snapshotPath, `${JSON.stringify(falseCache)}\n`);

  const reloaded = new WorkspaceTimelineStore({
    dataDir: h.dataDir,
    projects: h.projects,
    workspaceDir: h.workspace
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.list({ projectId: "default" })[0].id, first.id);
  const repaired = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(repaired.snapshots[0].id, first.id);
});

test("project GC cannot remove another project's history and retains recovery-before state", (t) => {
  const h = harness(t, { maxSnapshots: 2 });
  const alpha = h.projects.create({ id: "alpha", name: "Alpha" });
  const beta = h.projects.create({ id: "beta", name: "Beta" });
  write(beta.workspaceRoot, "state.txt", "beta\n");
  const betaSnapshot = h.store.captureNow({ projectId: "beta" });

  write(alpha.workspaceRoot, "state.txt", "one\n");
  const first = h.store.captureNow({ projectId: "alpha" });
  write(alpha.workspaceRoot, "state.txt", "two\n");
  const second = h.store.captureNow({ projectId: "alpha" });
  const recovered = h.store.travel(first.id, {
    projectId: "alpha",
    expectedHead: second.id
  });
  const retained = h.store.list({ projectId: "alpha" });
  assert.equal(
    retained.some((snapshot) => snapshot.id === recovered.before.id),
    true
  );
  assert.equal(
    h.store.list({ projectId: "beta" })[0].id,
    betaSnapshot.id
  );
});

test("project revision changes while waiting on the timeline lock fail closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-timeline-auth-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let revision = 1;
  const projects = {
    authorize() {
      return {
        id: "default",
        revision: revision++,
        status: "active",
        workspaceRoot: workspace
      };
    }
  };
  const store = new WorkspaceTimelineStore({
    dataDir: path.join(root, "data"),
    projects,
    workspaceDir: workspace
  });
  assert.throws(
    () => store.captureNow({ projectId: "default" }),
    { code: "PROJECT_BOUNDARY_VIOLATION" }
  );
  assert.equal(
    fs.existsSync(path.join(root, "data", "workspace-timeline", "events.jsonl")),
    false
  );
});

test("journal replay rejects cross-project GC and invalid snapshot topology", (t) => {
  const h = harness(t);
  const alpha = h.projects.create({ id: "alpha", name: "Alpha" });
  const beta = h.projects.create({ id: "beta", name: "Beta" });
  write(alpha.workspaceRoot, "a.txt", "a\n");
  write(beta.workspaceRoot, "b.txt", "b\n");
  h.store.captureNow({ projectId: "alpha" });
  const betaSnapshot = h.store.captureNow({ projectId: "beta" });
  const eventsPath = path.join(
    h.dataDir,
    "workspace-timeline",
    "events.jsonl"
  );
  const lines = fs.readFileSync(eventsPath, "utf8").trim().split(/\r?\n/u);
  fs.appendFileSync(eventsPath, `${JSON.stringify({
    version: 1,
    sequence: lines.length + 1,
    op: "gc",
    at: new Date().toISOString(),
    projectId: "alpha",
    removedSnapshots: [betaSnapshot.id]
  })}\n`);
  const corrupt = new WorkspaceTimelineStore({
    dataDir: h.dataDir,
    projects: h.projects,
    workspaceDir: h.workspace
  });
  assert.throws(
    () => corrupt.list({ projectId: "alpha" }),
    { code: "WORKSPACE_TIMELINE_JOURNAL_CORRUPT" }
  );
});

test("exact travel safely handles tracked directory and file type transitions", (t) => {
  const h = harness(t);
  write(h.workspace, "shape", "file\n");
  const fileSnapshot = h.store.captureNow({ projectId: "default" });
  fs.unlinkSync(path.join(h.workspace, "shape"));
  write(h.workspace, "shape/child.txt", "child\n");
  const directorySnapshot = h.store.captureNow({ projectId: "default" });

  h.store.travel(fileSnapshot.id, {
    projectId: "default",
    expectedHead: directorySnapshot.id
  });
  assert.equal(fs.statSync(path.join(h.workspace, "shape")).isFile(), true);
  assert.equal(fs.readFileSync(path.join(h.workspace, "shape"), "utf8"), "file\n");

  const head = h.store.head("default");
  h.store.travel(directorySnapshot.id, {
    projectId: "default",
    expectedHead: head.id
  });
  assert.equal(fs.statSync(path.join(h.workspace, "shape")).isDirectory(), true);
  assert.equal(
    fs.readFileSync(path.join(h.workspace, "shape", "child.txt"), "utf8"),
    "child\n"
  );
});

test("recovery returns success when retaining its safety snapshot exceeds blob quota", (t) => {
  const h = harness(t, { maxBlobBytes: 10 });
  write(h.workspace, "state.txt", "AAAAAA");
  const first = h.store.captureNow({ projectId: "default" });
  write(h.workspace, "state.txt", "BBBB");
  const second = h.store.captureNow({ projectId: "default" });
  write(h.workspace, "state.txt", "CCCCCC");

  const recovered = h.store.travel(first.id, {
    projectId: "default",
    expectedHead: second.id
  });
  assert.equal(recovered.operation.status, "complete");
  assert.equal(recovered.quota.exceededForRecoverySafety, true);
  assert.equal(recovered.quota.retainedBlobBytes, 12);
  assert.equal(fs.readFileSync(path.join(h.workspace, "state.txt"), "utf8"), "AAAAAA");
  assert.equal(
    h.store.list({ projectId: "default" })
      .some((snapshot) => snapshot.id === recovered.before.id),
    true
  );
  assert.equal(h.store.history({ projectId: "default" })[0].status, "complete");
});

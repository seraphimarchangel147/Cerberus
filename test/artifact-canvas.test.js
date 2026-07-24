import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ArtifactCanvasStore,
  ArtifactRevisionError,
  artifactPinnedRef,
  parseArtifactPinnedRef
} from "../src/artifact-canvas.js";
import { ProjectStore } from "../src/project-store.js";

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-artifact-canvas-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspace
  });
  projects.create({ id: "alpha", name: "Alpha" });
  projects.create({ id: "beta", name: "Beta" });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const store = new ArtifactCanvasStore({
    dataDir,
    projects,
    now,
    ...options
  });
  return { dataDir, now, projects, root, store };
}

test("Canvas revisions reject stale writes and every version survives restart", (t) => {
  const h = harness(t, {
    idFactory: () => "artifact_0123456789abcdef"
  });
  const created = h.store.create({
    projectId: "alpha",
    kind: "markdown",
    title: "Plan",
    content: "# One\n"
  }, { actor: "test" });
  assert.equal(created.revision, 1);
  assert.equal(created.pinnedRef, "artifact:artifact_0123456789abcdef@1");
  assert.equal(h.projects.get("alpha").artifactIds.includes(created.id), true);

  const updated = h.store.update(created.id, {
    expectedRevision: 1,
    title: "Plan two",
    content: "# Two\n"
  }, { projectId: "alpha", actor: "test" });
  assert.equal(updated.revision, 2);
  assert.throws(
    () => h.store.update(created.id, {
      expectedRevision: 1,
      content: "# Stale\n"
    }, { projectId: "alpha" }),
    ArtifactRevisionError
  );
  assert.equal(h.store.get(created.id, {
    projectId: "alpha",
    revision: 1
  }).content, "# One\n");
  assert.deepEqual(
    h.store.versions(created.id, { projectId: "alpha" })
      .map((revision) => revision.revision),
    [2, 1]
  );

  const restored = h.store.restore(created.id, 1, {
    projectId: "alpha",
    expectedRevision: 2,
    actor: "test"
  });
  assert.equal(restored.revision, 3);
  assert.equal(restored.restoredFromRevision, 1);
  assert.equal(restored.content, "# One\n");

  const reloaded = new ArtifactCanvasStore({
    dataDir: h.dataDir,
    projects: h.projects
  });
  assert.equal(reloaded.get(created.id, { projectId: "alpha" }).revision, 3);
  assert.equal(
    reloaded.resolvePinnedRef(created.pinnedRef, { projectId: "alpha" }).content,
    "# One\n"
  );
  assert.deepEqual(
    reloaded.versions(created.id, {
      projectId: "alpha",
      includeContent: true
    }).map((revision) => [revision.revision, revision.content]),
    [[3, "# One\n"], [2, "# Two\n"], [1, "# One\n"]]
  );
});

test("Canvas data is cloned, bounded, and project-contained", (t) => {
  const h = harness(t, {
    idFactory: () => "artifact_fedcba9876543210"
  });
  const source = { nested: { answer: 42 }, rows: ["a", "b"] };
  const created = h.store.create({
    projectId: "alpha",
    kind: "data",
    title: "Metrics",
    content: source,
    metadata: { source: "test" }
  });
  source.nested.answer = 0;
  assert.equal(created.content.nested.answer, 42);
  created.content.nested.answer = -1;
  assert.equal(
    h.store.get(created.id, { projectId: "alpha" }).content.nested.answer,
    42
  );
  assert.throws(
    () => h.store.get(created.id, { projectId: "beta" }),
    { code: "ARTIFACT_NOT_FOUND" }
  );
  assert.deepEqual(h.store.list({ projectId: "beta" }), []);
  assert.throws(
    () => h.store.resolvePinnedRef(created.pinnedRef, { projectId: "beta" }),
    { code: "ARTIFACT_NOT_FOUND" }
  );
  assert.throws(
    () => h.store.update(created.id, {
      expectedRevision: 1,
      content: { value: Number.NaN }
    }, { projectId: "alpha" }),
    /finite/u
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => h.store.update(created.id, {
      expectedRevision: 1,
      content: cyclic
    }, { projectId: "alpha" }),
    /cyclic/u
  );
});

test("Canvas notifications contain metadata but never artifact content", (t) => {
  const notices = [];
  const h = harness(t, {
    idFactory: () => "artifact_1111111111111111",
    onEvent: (event) => notices.push(event)
  });
  const created = h.store.create({
    projectId: "alpha",
    kind: "markdown",
    title: "Secret title",
    content: "private artifact body"
  });
  h.store.update(created.id, {
    expectedRevision: 1,
    content: "second private body"
  }, { projectId: "alpha" });
  h.store.restore(created.id, 1, {
    projectId: "alpha",
    expectedRevision: 2
  });

  assert.deepEqual(
    notices.map((notice) => notice.type),
    ["artifact-created", "artifact-updated", "artifact-restored"]
  );
  assert.equal(JSON.stringify(notices).includes("private artifact body"), false);
  assert.equal(JSON.stringify(notices).includes("second private body"), false);
  assert.equal(JSON.stringify(notices).includes("Secret title"), false);
  assert.equal(notices.at(-1).restoredFromRevision, 1);
});

test("JSONL remains authoritative when snapshot refresh fails", (t) => {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });
  const h = harness(t, {
    idFactory: () => "artifact_2222222222222222",
    writeSnapshot() {
      throw new Error("snapshot unavailable");
    }
  });
  const created = h.store.create({
    projectId: "alpha",
    kind: "markdown",
    title: "Ledger copy",
    content: "durable event"
  });
  const reloaded = new ArtifactCanvasStore({
    dataDir: h.dataDir,
    projects: h.projects
  });
  assert.equal(
    reloaded.get(created.id, { projectId: "alpha" }).content,
    "durable event"
  );
});

test("failed event append rolls back the reserved project resource", (t) => {
  const h = harness(t, {
    idFactory: () => "artifact_3333333333333333",
    appendEvent() {
      throw new Error("ledger unavailable");
    }
  });
  assert.throws(
    () => h.store.create({
      projectId: "alpha",
      kind: "markdown",
      title: "Must fail",
      content: "not durable"
    }),
    /ledger unavailable/u
  );
  assert.equal(
    h.projects.get("alpha").artifactIds.includes("artifact_3333333333333333"),
    false
  );
  assert.deepEqual(h.store.list({ projectId: "alpha" }), []);
});

test("two store instances serialize revisions against the durable head", (t) => {
  const h = harness(t, {
    idFactory: () => "artifact_4444444444444444"
  });
  const created = h.store.create({
    projectId: "alpha",
    kind: "markdown",
    title: "Shared",
    content: "one"
  });
  const second = new ArtifactCanvasStore({
    dataDir: h.dataDir,
    projects: h.projects
  });
  second.update(created.id, {
    expectedRevision: 1,
    content: "two"
  }, { projectId: "alpha" });
  assert.throws(
    () => h.store.update(created.id, {
      expectedRevision: 1,
      content: "stale"
    }, { projectId: "alpha" }),
    ArtifactRevisionError
  );
  assert.equal(
    h.store.get(created.id, { projectId: "alpha" }).content,
    "two"
  );
});

test("pinned artifact references parse only exact safe identities", () => {
  const ref = artifactPinnedRef("artifact_0123456789abcdef", 12);
  assert.equal(ref, "artifact:artifact_0123456789abcdef@12");
  assert.deepEqual(parseArtifactPinnedRef(ref), {
    id: "artifact_0123456789abcdef",
    revision: 12
  });
  for (const invalid of [
    "artifact:artifact_0123456789abcdef",
    "artifact:artifact_0123456789abcdef@0",
    " artifact:artifact_0123456789abcdef@1",
    "artifact:artifact_0123456789abcdeg@1",
    "artifact:artifact_0123456789abcdef@9007199254740992"
  ]) {
    assert.equal(parseArtifactPinnedRef(invalid), null);
  }
});

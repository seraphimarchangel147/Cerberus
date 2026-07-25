import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeBufferAtomic } from "../src/file-utils.js";
import {
  QaArtifactStore,
  QaBaselineStore,
  QaRunStore
} from "../src/qa-store.js";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runInput(workspaceRoot) {
  return {
    id: "qa_0123456789abcdef",
    projectId: "alpha",
    sessionId: "session-alpha",
    workspaceRoot,
    sourceRevision: "a".repeat(64),
    manifest: {
      version: 1,
      path: "qa-manifest.json",
      digest: "b".repeat(64)
    },
    mode: "full"
  };
}

test("QA run journal and atomic snapshot survive restart", (t) => {
  const root = tempDir(t, "openagi-qa-store-");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const store = new QaRunStore({ dir: path.join(root, "runs") });
  let run = store.create(runInput(workspaceRoot));
  run = store.update(run.id, run.revision, {
    state: "passed",
    summary: {
      routes: 1,
      controls: 2,
      controlsCovered: 2,
      assertions: 3,
      passed: 3,
      failed: 0,
      warnings: 0
    }
  });

  const recovered = new QaRunStore({
    dir: path.join(root, "runs")
  }).get(run.id);
  assert.equal(recovered.state, "passed");
  assert.equal(recovered.revision, 2);
  assert.equal(recovered.summary.controlsCovered, 2);
  assert.ok(fs.existsSync(path.join(root, "runs", "events.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "runs", "snapshot.json")));
});

test("interrupted QA runs reconcile to blocked", (t) => {
  const root = tempDir(t, "openagi-qa-interrupted-");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const dir = path.join(root, "runs");
  const store = new QaRunStore({ dir });
  let run = store.create(runInput(workspaceRoot));
  run = store.update(run.id, run.revision, { state: "running" });

  const recovered = new QaRunStore({ dir }).get(run.id);
  assert.equal(recovered.state, "blocked");
  assert.equal(recovered.error.code, "qa_interrupted");
});

test("content-addressed QA artifacts enforce project and run ownership", (t) => {
  const root = tempDir(t, "openagi-qa-artifacts-");
  const store = new QaArtifactStore({ dir: root });
  const first = store.put(Buffer.from("image-bytes"), {
    projectId: "alpha",
    runId: "qa_0123456789abcdef",
    kind: "route_screenshot",
    mediaType: "image/png",
    retention: "success"
  });
  const duplicate = store.put(Buffer.from("image-bytes"), {
    projectId: "alpha",
    runId: "qa_0123456789abcdef",
    kind: "duplicate_screenshot",
    mediaType: "image/png",
    retention: "failure"
  });

  assert.equal(first.ref, duplicate.ref);
  const read = store.read(first.ref, {
    projectId: "alpha",
    runId: "qa_0123456789abcdef",
    includeData: true
  });
  assert.equal(read.encoding, "base64");
  assert.equal(
    Buffer.from(read.data, "base64").toString("utf8"),
    "image-bytes"
  );
  assert.throws(
    () => store.read(first.ref, {
      projectId: "beta",
      runId: "qa_0123456789abcdef"
    }),
    /outside/
  );

  const recovered = new QaArtifactStore({ dir: root });
  assert.equal(
    recovered.metadata(first.ref, {
      projectId: "alpha",
      runId: "qa_0123456789abcdef"
    }).sha256,
    first.sha256
  );
});

test("binary atomic writes preserve exact bytes", (t) => {
  const root = tempDir(t, "openagi-binary-atomic-");
  const target = path.join(root, "artifact.bin");
  const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  writeBufferAtomic(target, bytes);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(
    fs.readdirSync(root).some((name) => name.endsWith(".tmp")),
    false
  );
});

test("artifact retention prunes success and failure evidence but never baselines", (t) => {
  const root = tempDir(t, "openagi-qa-retention-");
  let now = "2026-01-01T00:00:00.000Z";
  const store = new QaArtifactStore({ dir: root, now: () => now });
  const input = {
    projectId: "alpha",
    runId: "qa_0123456789abcdef",
    mediaType: "image/png"
  };
  const success = store.put(Buffer.from("success"), {
    ...input,
    kind: "success_screenshot",
    retention: "success"
  });
  const failure = store.put(Buffer.from("failure"), {
    ...input,
    kind: "failure_screenshot",
    retention: "failure"
  });
  const baseline = store.put(Buffer.from("baseline"), {
    ...input,
    kind: "baseline_screenshot",
    retention: "baseline"
  });

  now = "2026-01-03T00:00:00.000Z";
  assert.deepEqual(store.prune(), {
    bindingsRemoved: 1,
    blobsRemoved: 1
  });
  assert.throws(
    () => store.metadata(success.ref, input),
    /outside/
  );
  assert.equal(store.metadata(failure.ref, input).retention, "failure");

  now = "2026-02-05T00:00:00.000Z";
  assert.deepEqual(store.prune(), {
    bindingsRemoved: 1,
    blobsRemoved: 1
  });
  assert.equal(store.metadata(baseline.ref, input).retention, "baseline");
  const recovered = new QaArtifactStore({ dir: root, now: () => now });
  assert.throws(
    () => recovered.metadata(success.ref, input),
    /outside/
  );
  assert.equal(recovered.metadata(baseline.ref, input).retention, "baseline");
});

test("visual baseline approvals are project-scoped, revisioned, and durable", (t) => {
  const root = tempDir(t, "openagi-qa-baselines-");
  const store = new QaBaselineStore({ dir: root });
  const input = {
    projectId: "alpha",
    manifestDigest: "b".repeat(64),
    resultId: "editor_desktop",
    screenshotRef: `qaart_${"c".repeat(64)}`,
    sourceRevision: "d".repeat(64),
    runId: "qa_0123456789abcdef",
    approvalId: "action_visual_1"
  };
  const first = store.approve(input);
  const second = store.approve({
    ...input,
    screenshotRef: `qaart_${"e".repeat(64)}`,
    approvalId: "action_visual_2"
  });

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(store.get(input).screenshotRef, `qaart_${"e".repeat(64)}`);
  assert.equal(store.list({ projectId: "alpha" }).length, 1);
  assert.equal(store.list({ projectId: "beta" }).length, 0);
  const recovered = new QaBaselineStore({ dir: root });
  assert.equal(recovered.get(input).revision, 2);
});

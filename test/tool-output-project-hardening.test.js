import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolOutputStore } from "../src/tool-output-store.js";

function fixture(t, label = "store") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-tool-output-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dir: path.join(root, "tool-outputs")
  };
}

function readEvents(dir) {
  return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
}

function runWorker(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source, ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`tool-output worker exited ${code}: ${stderr}`));
    });
  });
}

test("legacy content-only refs migrate once and remain default-project only", (t) => {
  const { dir } = fixture(t, "legacy");
  fs.mkdirSync(dir, { recursive: true });
  const legacyRef = "out_1111111111111111";
  fs.writeFileSync(path.join(dir, `${legacyRef}.txt`), "legacy evidence", "utf8");

  const store = new ToolOutputStore({ dir });
  assert.equal(
    store.read(legacyRef, { projectId: "default" }).content,
    "legacy evidence"
  );
  assert.throws(
    () => store.read(legacyRef, { projectId: "alpha" }),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  assert.ok(fs.existsSync(path.join(dir, `${legacyRef}.meta.json`)));

  const currentRef = store.put("current evidence", { projectId: "alpha" });
  const injectedRef = "out_2222222222222222";
  fs.writeFileSync(path.join(dir, `${injectedRef}.txt`), "unindexed", "utf8");
  const reloaded = new ToolOutputStore({ dir });
  assert.equal(
    reloaded.read(legacyRef, { projectId: "default" }).content,
    "legacy evidence"
  );
  assert.equal(
    reloaded.read(currentRef, { projectId: "alpha" }).content,
    "current evidence"
  );
  assert.throws(
    () => reloaded.read(injectedRef, { projectId: "default" }),
    (error) => error.code === "TOOL_OUTPUT_PERSISTENCE_ERROR"
  );
});

test("cross-process puts serialize sequences and retain project ownership", async (t) => {
  const { root, dir } = fixture(t, "race");
  const barrier = path.join(root, "go");
  const moduleUrl = new URL("../src/tool-output-store.js", import.meta.url).href;
  const worker = `
    import fs from "node:fs";
    import { ToolOutputStore } from ${JSON.stringify(moduleUrl)};
    const dir = process.argv[1];
    const index = Number(process.argv[2]);
    const barrier = process.argv[3];
    const ready = barrier + "." + index + ".ready";
    const store = new ToolOutputStore({ dir });
    fs.writeFileSync(ready, "ready");
    while (!fs.existsSync(barrier)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const projectId = index % 2 === 0 ? "alpha" : "beta";
    const ref = store.put("evidence-" + index, {
      projectId,
      ownerType: "job",
      ownerId: "job-" + index
    });
    process.stdout.write(ref);
  `;
  const workerCount = 4;
  const runs = Array.from({ length: workerCount }, (_, index) => (
    runWorker(worker, [dir, String(index), barrier])
  ));
  const deadline = Date.now() + 10_000;
  for (;;) {
    const ready = Array.from(
      { length: workerCount },
      (_, index) => fs.existsSync(`${barrier}.${index}.ready`)
    );
    if (ready.every(Boolean)) break;
    if (Date.now() >= deadline) throw new Error("tool-output workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier, "go", "utf8");
  const refs = await Promise.all(runs);

  const durable = new ToolOutputStore({ dir });
  for (let index = 0; index < refs.length; index += 1) {
    const projectId = index % 2 === 0 ? "alpha" : "beta";
    const otherProjectId = projectId === "alpha" ? "beta" : "alpha";
    assert.equal(
      durable.read(refs[index], { projectId }).content,
      `evidence-${index}`
    );
    assert.throws(
      () => durable.read(refs[index], { projectId: otherProjectId }),
      (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
    );
  }
  assert.deepEqual(
    readEvents(dir).map((event) => event.sequence),
    [1, 2, 3, 4]
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8")).sequence,
    4
  );
  assert.equal(fs.existsSync(path.join(dir, ".mutation.lock")), false);
});

test("duplicate journal sequences stop replay before later refs", (t) => {
  const { dir } = fixture(t, "duplicate");
  const store = new ToolOutputStore({ dir });
  const alphaRef = store.put("alpha evidence", { projectId: "alpha" });
  const betaRef = store.put("beta evidence", { projectId: "beta" });
  const [first, second] = readEvents(dir);
  fs.writeFileSync(path.join(dir, "snapshot.json"), "{corrupt", "utf8");
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    [
      JSON.stringify(first),
      JSON.stringify({
        ...first,
        entry: { ...first.entry, projectId: "beta" }
      }),
      JSON.stringify(second),
      ""
    ].join("\n"),
    "utf8"
  );

  const replayed = new ToolOutputStore({ dir });
  assert.equal(
    replayed.read(alphaRef, { projectId: "alpha" }).content,
    "alpha evidence"
  );
  assert.throws(
    () => replayed.read(betaRef, { projectId: "beta" }),
    (error) => error.code === "TOOL_OUTPUT_PERSISTENCE_ERROR"
  );
  assert.throws(
    () => replayed.put("must not append", { projectId: "alpha" }),
    /journal is corrupt or exceeds its replay bound/i
  );
});

test("a malformed journal suffix cannot smuggle later valid records", (t) => {
  const { dir } = fixture(t, "tail");
  const store = new ToolOutputStore({ dir });
  const alphaRef = store.put("alpha evidence", { projectId: "alpha" });
  const betaRef = store.put("beta evidence", { projectId: "beta" });
  const [first, second] = readEvents(dir);
  fs.writeFileSync(path.join(dir, "snapshot.json"), "{corrupt", "utf8");
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify(first)}\n{"incomplete":\n${JSON.stringify(second)}\n`,
    "utf8"
  );

  const replayed = new ToolOutputStore({ dir });
  assert.equal(
    replayed.read(alphaRef, { projectId: "alpha" }).content,
    "alpha evidence"
  );
  assert.throws(
    () => replayed.read(betaRef, { projectId: "beta" }),
    (error) => error.code === "TOOL_OUTPUT_PERSISTENCE_ERROR"
  );
});

test("sidecar ownership conflicts and content swaps fail closed", (t) => {
  const { dir } = fixture(t, "integrity");
  const store = new ToolOutputStore({ dir });
  const alphaRef = store.put("alpha secret", { projectId: "alpha" });
  const betaRef = store.put("beta secret", { projectId: "beta" });

  fs.copyFileSync(
    path.join(dir, `${betaRef}.txt`),
    path.join(dir, `${alphaRef}.txt`)
  );
  assert.throws(
    () => store.read(alphaRef, { projectId: "alpha" }),
    /integrity check/i
  );

  const sidecarPath = path.join(dir, `${betaRef}.meta.json`);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  sidecar.entry.projectId = "alpha";
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`, "utf8");
  const reloaded = new ToolOutputStore({ dir });
  assert.throws(
    () => reloaded.read(betaRef, { projectId: "beta" }),
    (error) => error.code === "TOOL_OUTPUT_PERSISTENCE_ERROR"
  );
  assert.throws(
    () => reloaded.read(betaRef, { projectId: "alpha" }),
    (error) => error.code === "TOOL_OUTPUT_PERSISTENCE_ERROR"
  );
});

test("snapshot, journal, and content reads enforce fixed byte bounds", (t) => {
  const snapshotFixture = fixture(t, "snapshot-bound");
  const snapshotStore = new ToolOutputStore({ dir: snapshotFixture.dir });
  const snapshotRef = snapshotStore.put("snapshot evidence", {
    projectId: "alpha"
  });
  fs.truncateSync(
    path.join(snapshotFixture.dir, "snapshot.json"),
    (8 * 1024 * 1024) + 1
  );
  const journalRecovered = new ToolOutputStore({ dir: snapshotFixture.dir });
  assert.equal(
    journalRecovered.read(snapshotRef, { projectId: "alpha" }).content,
    "snapshot evidence"
  );

  const journalFixture = fixture(t, "journal-bound");
  const journalStore = new ToolOutputStore({ dir: journalFixture.dir });
  const journalRef = journalStore.put("journal evidence", {
    projectId: "alpha"
  });
  fs.truncateSync(
    path.join(journalFixture.dir, "events.jsonl"),
    (16 * 1024 * 1024) + 1
  );
  const snapshotRecovered = new ToolOutputStore({ dir: journalFixture.dir });
  assert.equal(
    snapshotRecovered.read(journalRef, { projectId: "alpha" }).content,
    "journal evidence"
  );
  assert.throws(
    () => snapshotRecovered.put("must not append", { projectId: "alpha" }),
    /journal is corrupt or exceeds its replay bound/i
  );

  const contentFixture = fixture(t, "content-bound");
  const contentStore = new ToolOutputStore({ dir: contentFixture.dir });
  const contentRef = contentStore.put("bounded evidence", {
    projectId: "alpha"
  });
  fs.truncateSync(
    path.join(contentFixture.dir, `${contentRef}.txt`),
    (64 * 1024 * 1024) + 1
  );
  assert.throws(
    () => contentStore.read(contentRef, { projectId: "alpha" }),
    /exceeds its read bound/i
  );

  const missingJournalFixture = fixture(t, "missing-journal");
  const missingJournalStore = new ToolOutputStore({
    dir: missingJournalFixture.dir
  });
  const missingJournalRef = missingJournalStore.put("snapshot-only evidence", {
    projectId: "alpha"
  });
  fs.rmSync(path.join(missingJournalFixture.dir, "events.jsonl"));
  const snapshotOnly = new ToolOutputStore({ dir: missingJournalFixture.dir });
  assert.equal(
    snapshotOnly.read(missingJournalRef, { projectId: "alpha" }).content,
    "snapshot-only evidence"
  );
  assert.throws(
    () => snapshotOnly.put("would create a sequence gap", { projectId: "alpha" }),
    /journal is corrupt or exceeds its replay bound/i
  );
});

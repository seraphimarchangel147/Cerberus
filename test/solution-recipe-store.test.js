import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HashBagEmbedder } from "../src/embeddings.js";
import { appendJsonLine } from "../src/file-utils.js";
import { ProjectStore } from "../src/project-store.js";
import { SecretsStore } from "../src/secrets-store.js";
import {
  RecipeRevisionError,
  SolutionRecipeStore
} from "../src/solution-recipe-store.js";
import { VectorStore } from "../src/vector-store.js";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-recipes-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspaceDir
  });
  const embedder = options.embedder ?? recipeEmbedder("model-a");
  const vectorStore = options.vectorStore ?? new VectorStore({
    dir: path.join(dataDir, "vectors"),
    embedder
  });
  const runtime = {
    artifacts: null,
    checkpoints: null,
    secrets: options.secretsFactory?.(dataDir) ?? null,
    toolOutputs: null
  };
  const store = new SolutionRecipeStore({
    dataDir,
    projects,
    vectorStore,
    embedder,
    runtime,
    ...(options.storeOptions ?? {})
  });
  runtime.recipes = store;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    dataDir,
    embedder,
    projects,
    root,
    runtime,
    store,
    vectorStore,
    workspaceDir
  };
}

function recipeEmbedder(model) {
  const embedder = new HashBagEmbedder();
  embedder.model = model;
  return embedder;
}

function recipeInput(overrides = {}) {
  return {
    title: "Recover the build cache",
    summary: "Repair a stale build cache without deleting source files.",
    preconditions: [
      "The project test lane fails with a cache checksum mismatch."
    ],
    actions: [
      "Inspect the cache manifest and record the failing checksum.",
      "Remove only the project-owned cache entry.",
      "Run the focused build test and retain its durable output."
    ],
    evidence: [
      { ref: "human:case-001", kind: "human", summary: "Reviewed reproduction." }
    ],
    failureModes: [
      "Stop if the target resolves outside the project workspace."
    ],
    tags: ["build", "cache"],
    ...overrides
  };
}

test("recipe lifecycle keeps facts separate and only recalls verified procedures", async (t) => {
  const h = fixture(t);
  const candidate = h.store.propose(recipeInput(), {
    projectId: "default",
    actor: "test"
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.verification.status, "unverified");
  assert.deepEqual(h.projects.get("default").recipeIds, [candidate.id]);

  const before = await h.store.recall("repair cache", {
    projectId: "default"
  });
  assert.equal(before.count, 0);
  assert.equal(h.store.search("cache", {
    projectId: "default"
  })[0].status, "candidate");

  const verified = await h.store.verify(candidate.id, {
    expectedRevision: 1,
    method: "Focused test passed twice.",
    evidence: [{ ref: "human:verification-001" }]
  }, {
    projectId: "default",
    actor: "operator"
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.revision, 2);
  assert.equal(verified.embedding.status, "indexed");

  const recalled = await h.store.recall("repair build cache", {
    projectId: "default"
  });
  assert.equal(recalled.count, 1);
  assert.equal(recalled.items[0].id, candidate.id);
  assert.ok(recalled.items[0].actions.length >= 3);

  const edited = h.store.edit(candidate.id, {
    expectedRevision: 2,
    summary: "Repair a stale project build cache after confirming ownership."
  }, {
    projectId: "default",
    actor: "editor"
  });
  assert.equal(edited.status, "candidate");
  assert.equal(edited.verification.status, "unverified");
  assert.equal((await h.store.recall("repair build cache", {
    projectId: "default"
  })).count, 0);

  const failed = h.store.fail(candidate.id, {
    expectedRevision: 3,
    reason: "The focused build still failed.",
    evidence: [{ ref: "human:failure-001" }]
  }, {
    projectId: "default",
    actor: "tester"
  });
  assert.equal(failed.status, "failed");
  assert.equal((await h.store.recall("repair build cache", {
    projectId: "default"
  })).count, 0);

  const reloaded = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: h.vectorStore,
    embedder: h.embedder,
    runtime: h.runtime
  });
  assert.equal(reloaded.get(candidate.id, {
    projectId: "default"
  }).status, "failed");
});

test("supersession is atomic, revision-safe, exportable, and project-contained", async (t) => {
  const h = fixture(t);
  h.projects.create({ id: "alpha", name: "Alpha" });
  h.projects.create({ id: "beta", name: "Beta" });
  const first = h.store.propose(recipeInput({
    projectId: "alpha",
    title: "Old cache recovery"
  }), {
    projectId: "alpha",
    actor: "test"
  });
  const second = h.store.propose(recipeInput({
    projectId: "alpha",
    title: "Safer cache recovery",
    summary: "Recover only after matching the manifest to the project root."
  }), {
    projectId: "alpha",
    actor: "test"
  });
  const verifiedFirst = await h.store.verify(first.id, {
    expectedRevision: first.revision,
    method: "Operator replay passed.",
    evidence: [{ ref: "human:alpha-first" }]
  }, {
    projectId: "alpha",
    actor: "operator"
  });
  const verifiedSecond = await h.store.verify(second.id, {
    expectedRevision: second.revision,
    method: "Operator replay passed with ownership checks.",
    evidence: [{ ref: "human:alpha-second" }]
  }, {
    projectId: "alpha",
    actor: "operator"
  });

  const changed = h.store.supersede(first.id, second.id, {
    projectId: "alpha",
    expectedRevision: verifiedFirst.revision,
    replacementExpectedRevision: verifiedSecond.revision,
    actor: "operator"
  });
  assert.equal(changed.superseded.status, "superseded");
  assert.equal(changed.superseded.supersededBy, second.id);
  assert.deepEqual(changed.replacement.supersedes, [first.id]);
  const recalled = await h.store.recall("cache recovery", {
    projectId: "alpha"
  });
  assert.deepEqual(recalled.items.map((item) => item.id), [second.id]);

  assert.throws(
    () => h.store.get(first.id, { projectId: "beta" }),
    /Unknown recipe/
  );
  const betaExport = h.store.export({
    projectId: "beta",
    format: "json"
  });
  assert.equal(betaExport.count, 0);
  assert.equal(betaExport.content.includes("Safer cache recovery"), false);
  const markdown = h.store.export({
    projectId: "alpha",
    id: second.id,
    format: "markdown"
  });
  assert.match(markdown.content, /## Preconditions/);

  assert.throws(
    () => h.store.remove(second.id, {
      projectId: "alpha",
      expectedRevision: verifiedSecond.revision,
      actor: "stale"
    }),
    RecipeRevisionError
  );
});

test("embedding identity changes use lexical fallback until controlled reindex", async (t) => {
  const h = fixture(t);
  const candidate = h.store.propose(recipeInput(), {
    projectId: "default",
    actor: "test"
  });
  await h.store.verify(candidate.id, {
    expectedRevision: 1,
    method: "Passed.",
    evidence: [{ ref: "human:model-a" }]
  }, {
    projectId: "default",
    actor: "operator"
  });
  assert.equal(h.store.indexStatus({ projectId: "default" }).ready, true);

  const embedderB = recipeEmbedder("model-b");
  const vectorsB = new VectorStore({
    dir: path.join(h.dataDir, "vectors"),
    embedder: embedderB
  });
  const changed = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: vectorsB,
    embedder: embedderB,
    runtime: h.runtime
  });
  const stale = changed.indexStatus({ projectId: "default" });
  assert.equal(stale.ready, false);
  assert.equal(stale.stale, true);
  const lexical = await changed.recall("repair cache", {
    projectId: "default"
  });
  assert.equal(lexical.count, 1);
  assert.equal(lexical.items[0].semanticScore, 0);

  const rebuilt = await changed.reindex({
    projectId: "default",
    actor: "operator"
  });
  assert.equal(rebuilt.ready, true);
  const ready = changed.indexStatus({ projectId: "default" });
  assert.equal(ready.ready, true);
  assert.equal(ready.indexed, 1);
  assert.equal(ready.persisted.model, "model-b");
});

test("stale recipe-store instances reload under lock and reject lost updates", (t) => {
  const h = fixture(t);
  const first = h.store.propose(recipeInput(), {
    projectId: "default",
    actor: "test"
  });
  const stale = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: h.vectorStore,
    embedder: h.embedder,
    runtime: h.runtime
  });
  assert.equal(stale.get(first.id, {
    projectId: "default"
  }).revision, 1);
  const updated = h.store.edit(first.id, {
    expectedRevision: 1,
    summary: "The first writer committed this revision."
  }, {
    projectId: "default",
    actor: "first"
  });
  assert.equal(updated.revision, 2);
  assert.throws(
    () => stale.edit(first.id, {
      expectedRevision: 1,
      summary: "The stale writer must not overwrite revision two."
    }, {
      projectId: "default",
      actor: "stale"
    }),
    RecipeRevisionError
  );
  assert.equal(h.store.get(first.id, {
    projectId: "default"
  }).summary, "The first writer committed this revision.");
});

test("reindex aborts if a verified source revision changes during embedding", async (t) => {
  const h = fixture(t);
  const candidate = h.store.propose(recipeInput(), {
    projectId: "default",
    actor: "test"
  });
  const verified = await h.store.verify(candidate.id, {
    expectedRevision: 1,
    method: "Passed.",
    evidence: [{ ref: "human:before-reindex" }]
  }, {
    projectId: "default",
    actor: "operator"
  });

  const base = recipeEmbedder("model-b");
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = {
    name: base.name,
    model: base.model,
    dim: base.dim,
    embed: (text) => base.embed(text),
    async embedMany(texts) {
      started();
      await gate;
      return Promise.all(texts.map((text) => base.embed(text)));
    }
  };
  const delayedVectors = new VectorStore({
    dir: path.join(h.dataDir, "vectors"),
    embedder: delayed
  });
  const reindexingStore = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: delayedVectors,
    embedder: delayed,
    runtime: h.runtime
  });
  const reindex = reindexingStore.reindex({
    projectId: "default",
    actor: "operator"
  });
  await startedPromise;

  const concurrent = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: new VectorStore({
      dir: path.join(h.dataDir, "vectors"),
      embedder: delayed
    }),
    embedder: delayed,
    runtime: h.runtime
  });
  concurrent.edit(candidate.id, {
    expectedRevision: verified.revision,
    summary: "Changed while the remote embedding batch was running."
  }, {
    projectId: "default",
    actor: "editor"
  });
  release();
  await assert.rejects(reindex, (error) => {
    assert.equal(error.code, "RECIPE_REINDEX_STALE");
    return true;
  });
  assert.equal(reindexingStore.indexStatus({
    projectId: "default"
  }).ready, false);
});

test("journal append uncertainty reconciles and pre-append failure rolls back project binding", (t) => {
  const h = fixture(t);
  let throwAfterWrite = true;
  const postWrite = new SolutionRecipeStore({
    dataDir: h.dataDir,
    dir: path.join(h.dataDir, "post-write-recipes"),
    projects: h.projects,
    vectorStore: h.vectorStore,
    embedder: h.embedder,
    runtime: h.runtime,
    appendEvent(file, event) {
      appendJsonLine(file, event);
      if (throwAfterWrite) {
        throwAfterWrite = false;
        throw new Error("synthetic post-write failure");
      }
    }
  });
  const committed = postWrite.propose(recipeInput({
    title: "Committed after uncertain append"
  }), {
    projectId: "default",
    actor: "test"
  });
  assert.equal(postWrite.get(committed.id, {
    projectId: "default"
  }).status, "candidate");

  const beforeIds = h.projects.get("default").recipeIds;
  const preWrite = new SolutionRecipeStore({
    dataDir: h.dataDir,
    dir: path.join(h.dataDir, "pre-write-recipes"),
    projects: h.projects,
    vectorStore: h.vectorStore,
    embedder: h.embedder,
    runtime: h.runtime,
    appendEvent() {
      throw new Error("synthetic pre-write failure");
    }
  });
  assert.throws(
    () => preWrite.propose(recipeInput({
      title: "Must roll back"
    }), {
      projectId: "default",
      actor: "test"
    }),
    /synthetic pre-write failure/
  );
  assert.deepEqual(h.projects.get("default").recipeIds, beforeIds);
});

test("a corrupt recipe journal remains readable from snapshot but blocks later writes", (t) => {
  const h = fixture(t);
  const first = h.store.propose(recipeInput(), {
    projectId: "default",
    actor: "test"
  });
  fs.appendFileSync(
    path.join(h.dataDir, "memory", "recipes", "events.jsonl"),
    "{\"version\":1,\"broken\":\n"
  );
  const reloaded = new SolutionRecipeStore({
    dataDir: h.dataDir,
    projects: h.projects,
    vectorStore: h.vectorStore,
    embedder: h.embedder,
    runtime: h.runtime
  });
  assert.equal(reloaded.get(first.id, {
    projectId: "default"
  }).title, first.title);
  assert.throws(
    () => reloaded.propose(recipeInput({
      title: "Must not cross a corrupt journal suffix"
    }), {
      projectId: "default",
      actor: "test"
    }),
    (error) => error.code === "RECIPE_PERSISTENCE_CORRUPT"
  );
});

test("hostile recipe structures fail before mutation or accessor execution", (t) => {
  const h = fixture(t);
  let accessed = false;
  const evidence = [];
  Object.defineProperty(evidence, "0", {
    enumerable: true,
    get() {
      accessed = true;
      return { ref: "human:hostile" };
    }
  });
  evidence.length = 1;
  assert.throws(
    () => h.store.propose(recipeInput({ evidence }), {
      projectId: "default",
      actor: "test"
    }),
    /accessors/
  );
  assert.equal(accessed, false);
  assert.throws(
    () => h.store.propose(new Proxy(recipeInput(), {}), {
      projectId: "default",
      actor: "test"
    }),
    /plain object/
  );
  assert.equal(h.store.search("", {
    projectId: "default"
  }).length, 0);
});

test("configured and pattern-shaped credentials are rejected before persistence", (t) => {
  const secretValue = "recipe-private-value-7f31d0";
  const h = fixture(t, {
    secretsFactory(dataDir) {
      const secrets = new SecretsStore({
        dataDir,
        allowlist: ["RECIPE_TEST_SECRET"],
        env: {}
      });
      secrets.initialize({ decidedBy: "test" });
      secrets.setSecret("RECIPE_TEST_SECRET", secretValue, {
        decidedBy: "test"
      });
      return secrets;
    }
  });
  assert.throws(
    () => h.store.propose(recipeInput({
      summary: `Never persist ${secretValue} in recipe content.`
    }), {
      projectId: "default",
      actor: "test"
    }),
    (error) => error.code === "RECIPE_SECRET_CONTENT"
  );
  assert.throws(
    () => h.store.propose(recipeInput({
      summary: `Never persist sk-${"a".repeat(24)} either.`
    }), {
      projectId: "default",
      actor: "test"
    }),
    (error) => error.code === "RECIPE_SECRET_CONTENT"
  );
  const eventsPath = path.join(h.dataDir, "memory", "recipes", "events.jsonl");
  const snapshotPath = path.join(h.dataDir, "memory", "recipes", "snapshot.json");
  const durableText = [
    fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "",
    fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : ""
  ].join("\n");
  assert.equal(durableText.includes(secretValue), false);
});

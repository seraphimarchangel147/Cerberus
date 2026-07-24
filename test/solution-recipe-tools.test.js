import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HashBagEmbedder } from "../src/embeddings.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import { ProjectStore } from "../src/project-store.js";
import { SolutionRecipeStore } from "../src/solution-recipe-store.js";
import { findSuggestion } from "../src/suggestion-feed.js";
import {
  registerSolutionRecipeTools,
  ToolRegistry
} from "../src/tool-registry.js";
import { VectorStore } from "../src/vector-store.js";

const RECIPE_TOOL_NAMES = [
  "recipe_search",
  "recipe_get",
  "recipe_recall",
  "recipe_create_draft",
  "recipe_update",
  "recipe_verify",
  "recipe_fail",
  "recipe_supersede",
  "recipe_delete",
  "recipe_export",
  "recipe_skill_candidate",
  "recipe_reindex"
];

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-recipe-tools-"));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: workspaceDir
  });
  const embedder = new HashBagEmbedder();
  embedder.model = "recipe-tools";
  const vectorStore = new VectorStore({
    dir: path.join(dataDir, "vectors"),
    embedder
  });
  const runtime = {
    dataDir,
    events: new EventEmitter(),
    projects,
    vectorStore
  };
  runtime.recipes = new SolutionRecipeStore({
    dataDir,
    projects,
    vectorStore,
    embedder,
    runtime
  });
  const registry = new ToolRegistry();
  registry.bindProjects(projects);
  registerSolutionRecipeTools(registry, runtime);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    context(extra = {}) {
      return {
        __projectId: "default",
        __projectRevision: projects.get("default").revision,
        agentId: "main",
        sessionId: "recipe-tool-session",
        ...extra
      };
    },
    dataDir,
    projects,
    registry,
    runtime
  };
}

function draftArgs(overrides = {}) {
  return {
    title: "Repair package metadata",
    summary: "Repair package metadata and verify the focused test.",
    preconditions: ["The package metadata test fails."],
    actions: [
      "Inspect the package manifest.",
      "Apply the smallest project-contained edit.",
      "Run the focused metadata test."
    ],
    evidence: [{ ref: "human:tool-case" }],
    failureModes: ["Stop if the manifest is outside the project."],
    tags: ["package", "metadata"],
    ...overrides
  };
}

test("recipe tools are registered, deferred, prompt-visible, and verification is explicit", async (t) => {
  const h = harness(t);
  for (const name of RECIPE_TOOL_NAMES) {
    const tool = h.registry.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.metadata.toolSearch, "deferred");
  }
  const instructions = buildDefaultInstructions({
    agent: { name: "Recipe Agent" }
  });
  for (const name of RECIPE_TOOL_NAMES) {
    assert.match(instructions, new RegExp(`\\b${name}\\b`));
  }

  const created = await h.registry.invoke(
    "recipe_create_draft",
    draftArgs(),
    h.context()
  );
  assert.equal(created.ok, true);
  assert.equal(created.result.status, "candidate");
  const id = created.result.id;

  const hidden = await h.registry.invoke(
    "recipe_recall",
    { query: "package metadata" },
    h.context()
  );
  assert.equal(hidden.ok, true);
  assert.equal(hidden.result.count, 0);

  const forged = await h.registry.invoke(
    "recipe_verify",
    {
      id,
      expectedRevision: 1,
      method: "Claimed success.",
      evidence: [{ ref: "human:forged" }]
    },
    h.context({ __confirmed: true })
  );
  assert.equal(forged.ok, false);
  assert.match(forged.error, /explicit human approval/i);
  assert.equal(h.runtime.recipes.get(id, {
    projectId: "default"
  }).status, "candidate");

  const verified = await h.registry.invoke(
    "recipe_verify",
    {
      id,
      expectedRevision: 1,
      method: "Operator observed the focused test pass.",
      evidence: [{ ref: "human:operator-approval" }]
    },
    h.context({
      __confirmed: true,
      __approval: {
        via: "dashboard",
        decider: "operator-1"
      }
    })
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.result.status, "verified");

  const recalled = await h.registry.invoke(
    "recipe_recall",
    { query: "repair package metadata" },
    h.context()
  );
  assert.equal(recalled.ok, true);
  assert.equal(recalled.result.count, 1);
  assert.equal(recalled.result.items[0].id, id);
});

test("verified recipes stage review-only skill candidates with exact lineage", async (t) => {
  const h = harness(t);
  const created = await h.registry.invoke(
    "recipe_create_draft",
    draftArgs(),
    h.context()
  );
  const id = created.result.id;
  const verified = await h.registry.invoke(
    "recipe_verify",
    {
      id,
      expectedRevision: 1,
      method: "Operator replay passed.",
      evidence: [{ ref: "human:skill-candidate" }]
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "operator-1" }
    })
  );
  const staged = await h.registry.invoke(
    "recipe_skill_candidate",
    {
      id,
      expectedRevision: verified.result.revision
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "operator-1" }
    })
  );
  assert.equal(staged.ok, true);
  assert.equal(staged.result.source, "recipe-memory");
  const candidate = findSuggestion(h.runtime, staged.result.id);
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.source, "recipe-memory");
  assert.equal(candidate.recipe.id, id);
  assert.equal(candidate.recipe.revision, verified.result.revision);
  assert.equal(candidate.projectId, "default");
  assert.equal(
    fs.existsSync(path.join(h.dataDir, "skills", candidate.title, "SKILL.md")),
    false,
    "staging a candidate must not install executable skill content"
  );

  const edited = await h.registry.invoke(
    "recipe_update",
    {
      id,
      expectedRevision: verified.result.revision,
      summary: "A changed procedure must be verified again."
    },
    h.context()
  );
  assert.equal(edited.ok, true);
  const stalePromotion = await h.registry.invoke(
    "recipe_skill_candidate",
    {
      id,
      expectedRevision: verified.result.revision
    },
    h.context({
      __confirmed: true,
      __approval: { decider: "operator-1" }
    })
  );
  assert.equal(stalePromotion.ok, false);
});

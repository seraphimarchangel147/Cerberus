import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { redactKnownValues, sanitizeForAudit } from "./redact.js";
import { secretsStoreRedactionSnapshot } from "./secrets-store.js";
import {
  createId,
  nowIso,
  stableHash,
  tokenOverlapScore
} from "./utils.js";

export const RECIPE_STATUSES = Object.freeze([
  "candidate",
  "verified",
  "failed",
  "superseded",
  "deleted"
]);

const RECIPE_STATUS_SET = new Set(RECIPE_STATUSES);
const RECIPE_ID_RE = /^recipe_[a-f0-9]{16}$/;
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const EVIDENCE_REF_RE = /^[\x21-\x7E]{1,512}$/;
const ARTIFACT_EVIDENCE_RE = /^artifact:(artifact_[a-f0-9]{16})@([1-9][0-9]{0,15})$/;
const TOOL_OUTPUT_EVIDENCE_RE = /^out_[a-f0-9]{16}$/;
const CHECKPOINT_EVIDENCE_RE = /^cp_[a-f0-9]{16}$/;
const HUMAN_EVIDENCE_RE = /^human:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_RECIPES = 1024;
const MAX_REVISIONS = 256;
const MAX_TITLE_CHARS = 240;
const MAX_SUMMARY_CHARS = 4000;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_TEXT_CHARS = 1200;
const MAX_EVIDENCE = 64;
const MAX_EVIDENCE_SUMMARY_CHARS = 1000;
const MAX_TAGS = 64;
const MAX_TAG_CHARS = 100;
const MAX_ACTOR_CHARS = 200;
const MAX_EXPORT_CHARS = 2 * 1024 * 1024;
const MAX_EMBED_BATCH = 32;
const MAX_EMBED_DIMENSION = 8192;
const EMBED_ALGORITHM_VERSION = 1;
const RECIPE_TEXT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 24 * 1024 * 1024;
const MAX_STATE_BYTES = 20 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const RECIPE_FIELDS = new Set([
  "actions",
  "createdAt",
  "createdBy",
  "deletedAt",
  "evidence",
  "failureModes",
  "id",
  "preconditions",
  "projectId",
  "revision",
  "status",
  "summary",
  "supersededBy",
  "supersedes",
  "tags",
  "title",
  "updatedAt",
  "updatedBy",
  "verification",
  "version"
]);
const CREATE_FIELDS = new Set([
  "actions",
  "evidence",
  "failureModes",
  "preconditions",
  "projectId",
  "summary",
  "tags",
  "title"
]);
const EDIT_FIELDS = new Set([
  "actions",
  "evidence",
  "expectedRevision",
  "failureModes",
  "preconditions",
  "projectId",
  "summary",
  "tags",
  "title"
]);

export class SolutionRecipeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SolutionRecipeError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class RecipeRevisionError extends SolutionRecipeError {
  constructor(id, expectedRevision, actualRevision) {
    super(
      "RECIPE_REVISION_CONFLICT",
      `Recipe revision conflict for '${id}': expected ${expectedRevision}, found ${actualRevision}.`,
      { id, expectedRevision, actualRevision }
    );
    this.name = "RecipeRevisionError";
  }
}

export class SolutionRecipeStore {
  constructor(options = {}) {
    const source = plainRecord(options, "SolutionRecipeStore options");
    const dataDir = path.resolve(source.dataDir ?? resolveDataDir());
    this.dir = path.resolve(source.dir ?? path.join(dataDir, "memory", "recipes"));
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.lockPath = path.join(this.dir, ".mutation.lock");
    this.projects = source.projects ?? null;
    this.vectorStore = source.vectorStore ?? null;
    this.embedder = source.embedder ?? this.vectorStore?.embedder ?? null;
    this.runtime = source.runtime ?? null;
    this.onEvent = typeof source.onEvent === "function" ? source.onEvent : null;
    this.now = typeof source.now === "function" ? source.now : nowIso;
    this.idFactory = typeof source.idFactory === "function"
      ? source.idFactory
      : () => createId("recipe");
    this.appendEvent = typeof source.appendEvent === "function"
      ? source.appendEvent
      : appendJsonLine;
    this.writeSnapshot = typeof source.writeSnapshot === "function"
      ? source.writeSnapshot
      : writeJsonAtomic;
    this.lockTimeoutMs = positiveInteger(
      source.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      "lockTimeoutMs"
    );
    this.staleLockMs = positiveInteger(
      source.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
      "staleLockMs"
    );
    this.recipes = new Map();
    this.embeddingIdentities = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this.lockDepth = 0;
    ensureDir(this.dir);
    this._withLock(() => this._restore());
  }

  propose(input, context = {}) {
    const source = plainRecord(input, "recipe input");
    assertOnlyKeys(source, CREATE_FIELDS, "recipe input");
    const mutationContext = plainRecord(context, "recipe context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const actor = normalizeActor(mutationContext.actor);
    const normalized = normalizeRecipeBody(source);
    this._assertNoSecrets({ actor, ...normalized });
    this._authorizeProject(projectId);

    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      this._validateEvidenceOwnership(projectId, normalized.evidence);
      if (this.recipes.size >= MAX_RECIPES) {
        throw new RangeError(`Recipe limit reached (${MAX_RECIPES}).`);
      }
      const id = this._allocateId();
      let attached = false;
      try {
        this.projects?.attachResource?.(
          projectId,
          "recipeIds",
          id,
          { actor }
        );
        attached = Boolean(this.projects?.attachResource);
        const at = this._now();
        const recipe = normalizeStoredRecipe({
          version: 1,
          id,
          projectId,
          revision: 1,
          status: "candidate",
          ...normalized,
          verification: {
            status: "unverified",
            method: null,
            evidence: [],
            at: null,
            by: null,
            failure: null
          },
          supersedes: [],
          supersededBy: null,
          deletedAt: null,
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
          updatedBy: actor
        });
        this.recipes.set(id, recipe);
        const event = this._commit("propose", projectId, { recipeId: id });
        result = this._view(recipe);
        notice = recipeNotice("recipe-proposed", event, recipe);
      } catch (error) {
        if (attached) {
          try {
            this.projects?.detachResource?.(
              projectId,
              "recipeIds",
              id,
              { actor: "recipe:propose:rollback" }
            );
          } catch {
            // A dangling metadata reference is safer than hidden recipe state.
          }
        }
        throw error;
      }
    });
    this._notify(notice);
    return result;
  }

  get(id, options = {}) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(options, "recipe get options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    const recipe = this._requireRecipe(recipeId, projectId);
    this._assertNoSecrets(recipe);
    return this._view(recipe);
  }

  search(query = "", options = {}) {
    const source = plainRecord(options, "recipe search options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const text = boundedText(query, "query", MAX_SUMMARY_CHARS, {
      allowEmpty: true
    });
    const statuses = normalizeStatusFilter(source.statuses ?? source.status);
    const includeDeleted = source.includeDeleted === true;
    const limit = listLimit(source.limit);
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    for (const recipe of this.recipes.values()) {
      if (recipe.projectId === projectId) this._assertNoSecrets(recipe);
    }

    return [...this.recipes.values()]
      .filter((recipe) => (
        recipe.projectId === projectId
        && (includeDeleted || recipe.status !== "deleted")
        && (statuses == null || statuses.has(recipe.status))
      ))
      .map((recipe) => ({
        recipe,
        score: text
          ? tokenOverlapScore(text, recipeSearchText(recipe))
          : 1
      }))
      .filter((entry) => !text || entry.score > 0)
      .sort((left, right) => (
        right.score - left.score
        || right.recipe.updatedAt.localeCompare(left.recipe.updatedAt)
        || left.recipe.id.localeCompare(right.recipe.id)
      ))
      .slice(0, limit)
      .map(({ recipe, score }) => ({
        ...this._summary(recipe),
        score: Number(score.toFixed(3))
      }));
  }

  async recall(query, options = {}) {
    const source = plainRecord(options, "recipe recall options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const text = boundedText(query, "query", MAX_SUMMARY_CHARS);
    const limit = listLimit(source.limit, 8);
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    const candidates = [...this.recipes.values()]
      .filter((recipe) => (
        recipe.projectId === projectId
        && recipe.status === "verified"
        && recipe.supersededBy == null
        && recipe.deletedAt == null
      ));
    for (const recipe of candidates) this._assertNoSecrets(recipe);

    const indexStatus = this._indexStatus(projectId, candidates);
    const vectorScores = new Map();
    if (
      indexStatus.ready
      && typeof this.vectorStore?.search === "function"
    ) {
      let hits = [];
      try {
        hits = await this.vectorStore.search(
          recipeVectorNamespace(projectId),
          text,
          { limit: Math.min(MAX_LIST_ITEMS, limit * 4), minScore: 0 }
        );
      } catch {
        indexStatus.ready = false;
        indexStatus.unavailable = true;
      }
      for (const hit of hits ?? []) {
        const recipe = this.recipes.get(hit.id);
        if (!recipe || recipe.projectId !== projectId || recipe.status !== "verified") {
          continue;
        }
        const payload = hit.payload;
        if (
          !payload
          || payload.embeddingIdentityKey !== indexStatus.current?.key
          || payload.revision !== recipe.revision
          || payload.textHash !== recipeTextHash(recipe)
        ) {
          continue;
        }
        vectorScores.set(recipe.id, Number(hit.score) || 0);
      }
    }

    const items = candidates
      .map((recipe) => {
        const lexical = tokenOverlapScore(text, recipeSearchText(recipe));
        const semantic = vectorScores.get(recipe.id) ?? 0;
        return {
          recipe,
          lexical,
          semantic,
          score: Math.max(lexical, lexical * 0.55 + semantic * 0.45)
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => (
        right.score - left.score
        || right.recipe.updatedAt.localeCompare(left.recipe.updatedAt)
        || left.recipe.id.localeCompare(right.recipe.id)
      ))
      .slice(0, limit)
      .map(({ recipe, score, lexical, semantic }) => ({
        id: recipe.id,
        revision: recipe.revision,
        title: recipe.title,
        summary: recipe.summary,
        preconditions: [...recipe.preconditions],
        actions: [...recipe.actions],
        evidence: structuredClone(recipe.evidence),
        failureModes: [...recipe.failureModes],
        tags: [...recipe.tags],
        verification: structuredClone(recipe.verification),
        score: Number(score.toFixed(3)),
        lexicalScore: Number(lexical.toFixed(3)),
        semanticScore: Number(semantic.toFixed(3))
      }));
    return {
      query: text,
      count: items.length,
      index: indexStatus,
      items
    };
  }

  edit(id, patch, context = {}) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(patch, "recipe edit");
    assertOnlyKeys(source, EDIT_FIELDS, "recipe edit");
    const mutationContext = plainRecord(context, "recipe context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const expectedRevision = expectedRecipeRevision(
      source.expectedRevision ?? mutationContext.expectedRevision
    );
    const actor = normalizeActor(mutationContext.actor);
    const fields = Object.fromEntries(
      [...CREATE_FIELDS]
        .filter((key) => key !== "projectId" && source[key] !== undefined)
        .map((key) => [key, source[key]])
    );
    if (Object.keys(fields).length === 0) {
      throw new TypeError("Recipe edit requires at least one semantic field.");
    }
    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const current = this._requireMutableRecipe(recipeId, projectId);
      assertRecipeRevision(current, expectedRevision);
      const body = normalizeRecipeBody({
        title: fields.title ?? current.title,
        summary: fields.summary ?? current.summary,
        preconditions: fields.preconditions ?? current.preconditions,
        actions: fields.actions ?? current.actions,
        evidence: fields.evidence ?? current.evidence,
        failureModes: fields.failureModes ?? current.failureModes,
        tags: fields.tags ?? current.tags
      });
      this._assertNoSecrets({ actor, ...body });
      this._validateEvidenceOwnership(projectId, body.evidence);
      const at = this._now();
      const next = normalizeStoredRecipe({
        ...current,
        ...body,
        revision: nextRevision(current),
        status: "candidate",
        verification: {
          status: "unverified",
          method: null,
          evidence: [],
          at: null,
          by: null,
          failure: null
        },
        updatedAt: at,
        updatedBy: actor
      });
      this.recipes.set(recipeId, next);
      const event = this._commit("edit", projectId, { recipeId });
      result = this._view(next);
      notice = recipeNotice("recipe-edited", event, next);
    });
    this._dropRecipeVector(projectId, recipeId);
    this._notify(notice);
    return result;
  }

  async verify(id, verification, context = {}) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(verification, "recipe verification");
    assertOnlyKeys(
      source,
      new Set(["evidence", "expectedRevision", "method", "projectId"]),
      "recipe verification"
    );
    const mutationContext = plainRecord(context, "recipe context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const expectedRevision = expectedRecipeRevision(
      source.expectedRevision ?? mutationContext.expectedRevision
    );
    const actor = normalizeActor(mutationContext.actor);
    const method = boundedText(source.method, "verification.method", 1000);
    const verificationEvidence = normalizeEvidence(source.evidence);
    this._assertNoSecrets({ actor, method, evidence: verificationEvidence });
    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const current = this._requireMutableRecipe(recipeId, projectId);
      assertRecipeRevision(current, expectedRevision);
      const evidence = dedupeEvidence([
        ...current.evidence,
        ...verificationEvidence
      ]);
      if (evidence.length === 0) {
        throw new SolutionRecipeError(
          "RECIPE_VERIFICATION_EVIDENCE_REQUIRED",
          "A recipe cannot be verified without durable evidence references."
        );
      }
      this._validateEvidenceOwnership(projectId, evidence);
      const at = this._now();
      const next = normalizeStoredRecipe({
        ...current,
        revision: nextRevision(current),
        status: "verified",
        evidence,
        verification: {
          status: "verified",
          method,
          evidence,
          at,
          by: actor,
          failure: null
        },
        updatedAt: at,
        updatedBy: actor
      });
      this.recipes.set(recipeId, next);
      const event = this._commit("verify", projectId, { recipeId });
      result = this._view(next);
      notice = recipeNotice("recipe-verified", event, next);
    });
    this._notify(notice);
    const embedding = await this._maybeIndexRecipe(result);
    return { ...result, embedding };
  }

  fail(id, failure, context = {}) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(failure, "recipe failure");
    assertOnlyKeys(
      source,
      new Set(["evidence", "expectedRevision", "projectId", "reason"]),
      "recipe failure"
    );
    const mutationContext = plainRecord(context, "recipe context");
    const projectId = normalizeProjectId(
      source.projectId ?? mutationContext.projectId ?? "default"
    );
    const expectedRevision = expectedRecipeRevision(
      source.expectedRevision ?? mutationContext.expectedRevision
    );
    const actor = normalizeActor(mutationContext.actor);
    const reason = boundedText(source.reason, "failure.reason", 2000);
    const evidence = normalizeEvidence(source.evidence);
    this._assertNoSecrets({ actor, reason, evidence });
    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const current = this._requireMutableRecipe(recipeId, projectId);
      assertRecipeRevision(current, expectedRevision);
      this._validateEvidenceOwnership(projectId, evidence);
      const at = this._now();
      const next = normalizeStoredRecipe({
        ...current,
        revision: nextRevision(current),
        status: "failed",
        verification: {
          status: "failed",
          method: null,
          evidence,
          at,
          by: actor,
          failure: reason
        },
        updatedAt: at,
        updatedBy: actor
      });
      this.recipes.set(recipeId, next);
      const event = this._commit("fail", projectId, { recipeId });
      result = this._view(next);
      notice = recipeNotice("recipe-failed", event, next);
    });
    this._dropRecipeVector(projectId, recipeId);
    this._notify(notice);
    return result;
  }

  supersede(id, replacementId, context = {}) {
    const recipeId = normalizeRecipeId(id);
    const nextId = normalizeRecipeId(replacementId);
    if (recipeId === nextId) {
      throw new TypeError("A recipe cannot supersede itself.");
    }
    const source = plainRecord(context, "recipe supersession context");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const expectedRevision = expectedRecipeRevision(source.expectedRevision);
    const replacementExpectedRevision = expectedRecipeRevision(
      source.replacementExpectedRevision
    );
    const actor = normalizeActor(source.actor);
    this._assertNoSecrets({ actor });
    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const current = this._requireMutableRecipe(recipeId, projectId);
      const replacement = this._requireMutableRecipe(nextId, projectId);
      assertRecipeRevision(current, expectedRevision);
      assertRecipeRevision(replacement, replacementExpectedRevision);
      if (current.status !== "verified" || replacement.status !== "verified") {
        throw new SolutionRecipeError(
          "RECIPE_SUPERSESSION_REQUIRES_VERIFIED",
          "Only active verified recipes can participate in supersession."
        );
      }
      const at = this._now();
      const nextCurrent = normalizeStoredRecipe({
        ...current,
        revision: nextRevision(current),
        status: "superseded",
        supersededBy: replacement.id,
        updatedAt: at,
        updatedBy: actor
      });
      const nextReplacement = normalizeStoredRecipe({
        ...replacement,
        revision: nextRevision(replacement),
        supersedes: [...new Set([...replacement.supersedes, current.id])],
        updatedAt: at,
        updatedBy: actor
      });
      this.recipes.set(recipeId, nextCurrent);
      this.recipes.set(nextId, nextReplacement);
      const event = this._commit("supersede", projectId, {
        recipeId,
        replacementId: nextId
      });
      result = {
        superseded: this._view(nextCurrent),
        replacement: this._view(nextReplacement)
      };
      notice = recipeNotice("recipe-superseded", event, nextCurrent, {
        replacementId: nextId
      });
    });
    this._dropRecipeVector(projectId, recipeId);
    this._dropRecipeVector(projectId, nextId);
    this._notify(notice);
    return result;
  }

  remove(id, context = {}) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(context, "recipe delete context");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const expectedRevision = expectedRecipeRevision(source.expectedRevision);
    const actor = normalizeActor(source.actor);
    this._assertNoSecrets({ actor });
    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const current = this._requireRecipe(recipeId, projectId);
      assertRecipeRevision(current, expectedRevision);
      if (current.status === "deleted") {
        result = this._view(current);
        return;
      }
      const at = this._now();
      const next = normalizeStoredRecipe({
        ...current,
        revision: nextRevision(current),
        status: "deleted",
        deletedAt: at,
        updatedAt: at,
        updatedBy: actor
      });
      this.recipes.set(recipeId, next);
      const event = this._commit("delete", projectId, { recipeId });
      result = this._view(next);
      notice = recipeNotice("recipe-deleted", event, next);
    });
    this._dropRecipeVector(projectId, recipeId);
    this._notify(notice);
    return result;
  }

  export(options = {}) {
    const source = plainRecord(options, "recipe export options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const format = String(source.format ?? "json").trim().toLowerCase();
    if (!["json", "markdown"].includes(format)) {
      throw new TypeError("Recipe export format must be json or markdown.");
    }
    const id = source.id == null ? null : normalizeRecipeId(source.id);
    const statuses = normalizeStatusFilter(source.statuses ?? source.status);
    const includeDeleted = source.includeDeleted === true;
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    let recipes = id
      ? [this._requireRecipe(id, projectId)]
      : [...this.recipes.values()]
        .filter((recipe) => recipe.projectId === projectId)
        .filter((recipe) => includeDeleted || recipe.status !== "deleted")
        .filter((recipe) => statuses == null || statuses.has(recipe.status))
        .sort((left, right) => (
          left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id)
        ));
    recipes = recipes.map((recipe) => this._view(recipe));
    for (const recipe of recipes) this._assertNoSecrets(recipe);
    const content = format === "json"
      ? `${JSON.stringify({
          version: 1,
          projectId,
          exportedAt: this._now(),
          recipes
        }, null, 2)}\n`
      : recipes.map(renderRecipeMarkdown).join("\n\n---\n\n");
    if (content.length > MAX_EXPORT_CHARS) {
      throw new RangeError("Recipe export exceeds the response bound.");
    }
    return {
      format,
      filename: `recipes-${projectId}.${format === "json" ? "json" : "md"}`,
      count: recipes.length,
      content
    };
  }

  indexStatus(options = {}) {
    const source = plainRecord(options, "recipe index options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    this._authorizeProject(projectId);
    this._refresh();
    this._authorizeProject(projectId);
    const recipes = [...this.recipes.values()].filter((recipe) => (
      recipe.projectId === projectId
      && recipe.status === "verified"
      && recipe.supersededBy == null
      && recipe.deletedAt == null
    ));
    for (const recipe of recipes) this._assertNoSecrets(recipe);
    return this._indexStatus(projectId, recipes);
  }

  withVerifiedRecipe(id, options, operation) {
    const recipeId = normalizeRecipeId(id);
    const source = plainRecord(options, "verified recipe options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const expectedRevision = expectedRecipeRevision(source.expectedRevision);
    if (typeof operation !== "function") {
      throw new TypeError("Verified recipe operation must be a function.");
    }
    return this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      const recipe = this._requireRecipe(recipeId, projectId);
      this._assertNoSecrets(recipe);
      assertRecipeRevision(recipe, expectedRevision);
      if (
        recipe.status !== "verified"
        || recipe.supersededBy != null
        || recipe.deletedAt != null
      ) {
        throw new SolutionRecipeError(
          "RECIPE_NOT_VERIFIED",
          "Only the exact current verified recipe revision can be used."
        );
      }
      return operation(this._view(recipe));
    });
  }

  async reindex(options = {}) {
    const source = plainRecord(options, "recipe reindex options");
    const projectId = normalizeProjectId(source.projectId ?? "default");
    const actor = normalizeActor(source.actor);
    this._assertNoSecrets({ actor });
    const signal = source.signal ?? null;
    this._authorizeProject(projectId);
    if (!this.embedder || typeof this.embedder.embed !== "function") {
      throw new SolutionRecipeError(
        "RECIPE_EMBEDDER_UNAVAILABLE",
        "Recipe reindexing requires a configured embedder."
      );
    }
    if (typeof this.vectorStore?.replaceNamespace !== "function") {
      throw new SolutionRecipeError(
        "RECIPE_VECTOR_STORE_UNAVAILABLE",
        "Recipe reindexing requires namespace replacement support."
      );
    }
    this._refresh();
    const identity = currentEmbeddingIdentity(this.embedder);
    const recipes = [...this.recipes.values()]
      .filter((recipe) => (
        recipe.projectId === projectId
        && recipe.status === "verified"
        && recipe.supersededBy == null
        && recipe.deletedAt == null
      ))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((recipe) => this._view(recipe));
    for (const recipe of recipes) this._assertNoSecrets(recipe);
    const vectors = [];
    for (let offset = 0; offset < recipes.length; offset += MAX_EMBED_BATCH) {
      throwIfAborted(signal);
      const batch = recipes.slice(offset, offset + MAX_EMBED_BATCH);
      const texts = batch.map(recipeIndexText);
      let embeddings;
      if (typeof this.embedder.embedMany === "function") {
        embeddings = await this.embedder.embedMany(texts);
      } else {
        embeddings = [];
        for (const text of texts) {
          throwIfAborted(signal);
          embeddings.push(await this.embedder.embed(text));
        }
      }
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw new SolutionRecipeError(
          "RECIPE_EMBEDDING_INVALID",
          "The embedder returned an unexpected batch shape."
        );
      }
      for (let index = 0; index < batch.length; index += 1) {
        const recipe = batch[index];
        const embedding = normalizeEmbeddingVector(
          embeddings[index],
          identity.dimension
        );
        vectors.push({
          id: recipe.id,
          text: recipeIndexText(recipe),
          embedding,
          payload: {
            projectId,
            recipeId: recipe.id,
            revision: recipe.revision,
            textHash: recipeTextHash(recipe),
            embeddingIdentityKey: identity.key
          },
          at: this._now()
        });
      }
    }
    throwIfAborted(signal);

    let result;
    let notice;
    this._withLock(() => {
      this._restore();
      this._authorizeProject(projectId);
      for (const expected of recipes) {
        const current = this._requireRecipe(expected.id, projectId);
        if (
          current.status !== "verified"
          || current.supersededBy != null
          || current.deletedAt != null
          || current.revision !== expected.revision
          || recipeTextHash(current) !== recipeTextHash(expected)
        ) {
          throw new SolutionRecipeError(
            "RECIPE_REINDEX_STALE",
            "Recipe state changed while embeddings were being prepared; reindex again."
          );
        }
      }
      const currentIds = [...this.recipes.values()]
        .filter((recipe) => (
          recipe.projectId === projectId
          && recipe.status === "verified"
          && recipe.supersededBy == null
          && recipe.deletedAt == null
        ))
        .map((recipe) => recipe.id)
        .sort();
      if (
        currentIds.length !== recipes.length
        || currentIds.some((id, index) => id !== recipes[index].id)
      ) {
        throw new SolutionRecipeError(
          "RECIPE_REINDEX_STALE",
          "Recipe membership changed while embeddings were being prepared; reindex again."
        );
      }
      this.vectorStore.replaceNamespace(
        recipeVectorNamespace(projectId),
        vectors
      );
      this.embeddingIdentities.set(projectId, identity);
      const event = this._commit("reindex", projectId, {
        actor,
        count: vectors.length,
        embeddingIdentityKey: identity.key
      });
      result = {
        projectId,
        count: vectors.length,
        identity: structuredClone(identity),
        ready: true,
        stale: false
      };
      notice = {
        event: "recipe-reindexed",
        projectId,
        sequence: event.sequence,
        count: vectors.length,
        embeddingIdentityKey: identity.key,
        at: event.at
      };
    });
    this._notify(notice);
    return result;
  }

  _indexStatus(projectId, recipes) {
    const current = this.embedder
      ? currentEmbeddingIdentity(this.embedder)
      : null;
    const persisted = this.embeddingIdentities.get(projectId) ?? null;
    let ready = Boolean(
      current
      && persisted
      && current.key === persisted.key
      && typeof this.vectorStore?.search === "function"
    );
    let unavailable = false;
    let indexed = 0;
    if (ready && typeof this.vectorStore?.list === "function") {
      const valid = new Map(recipes.map((recipe) => [recipe.id, recipe]));
      try {
        for (const entry of this.vectorStore.list(recipeVectorNamespace(projectId))) {
          const recipe = valid.get(entry.id);
          if (
            recipe
            && entry.payload?.embeddingIdentityKey === current.key
            && entry.payload?.revision === recipe.revision
            && entry.payload?.textHash === recipeTextHash(recipe)
          ) {
            indexed += 1;
          }
        }
      } catch {
        ready = false;
        unavailable = true;
      }
    }
    return {
      ready,
      unavailable,
      stale: Boolean(persisted && current && persisted.key !== current.key),
      current: current ? structuredClone(current) : null,
      persisted: persisted ? structuredClone(persisted) : null,
      eligible: recipes.length,
      indexed,
      pending: Math.max(0, recipes.length - indexed)
    };
  }

  async _maybeIndexRecipe(recipe) {
    if (
      !this.embedder
      || typeof this.vectorStore?.upsert !== "function"
    ) {
      return { status: "disabled" };
    }
    const identity = currentEmbeddingIdentity(this.embedder);
    const persisted = this.embeddingIdentities.get(recipe.projectId) ?? null;
    if (persisted && persisted.key !== identity.key) {
      return {
        status: "stale",
        current: identity,
        persisted: structuredClone(persisted)
      };
    }
    try {
      const embedding = normalizeEmbeddingVector(
        await this.embedder.embed(recipeIndexText(recipe)),
        identity.dimension
      );
      if (typeof this.vectorStore.upsertVector === "function") {
        this.vectorStore.upsertVector(
          recipeVectorNamespace(recipe.projectId),
          recipe.id,
          recipeIndexText(recipe),
          embedding,
          {
            projectId: recipe.projectId,
            recipeId: recipe.id,
            revision: recipe.revision,
            textHash: recipeTextHash(recipe),
            embeddingIdentityKey: identity.key
          }
        );
      } else {
        const result = await this.vectorStore.upsert(
          recipeVectorNamespace(recipe.projectId),
          recipe.id,
          recipeIndexText(recipe),
          {
            projectId: recipe.projectId,
            recipeId: recipe.id,
            revision: recipe.revision,
            textHash: recipeTextHash(recipe),
            embeddingIdentityKey: identity.key
          }
        );
        if (!result || result.error) throw new Error("embedding unavailable");
      }
    } catch {
      return { status: "error", error: "recipe embedding failed" };
    }
    if (!persisted) {
      try {
        this._withLock(() => {
          this._restore();
          const current = this._requireRecipe(recipe.id, recipe.projectId);
          if (
            current.status !== "verified"
            || current.revision !== recipe.revision
            || recipeTextHash(current) !== recipeTextHash(recipe)
          ) {
            return;
          }
          this.embeddingIdentities.set(recipe.projectId, identity);
          this._commit("index-identity", recipe.projectId, {
            recipeId: recipe.id,
            embeddingIdentityKey: identity.key
          });
        });
      } catch {
        return { status: "pending-reindex" };
      }
    }
    return { status: "indexed", identity };
  }

  _dropRecipeVector(projectId, id) {
    try {
      this.vectorStore?.delete?.(recipeVectorNamespace(projectId), id);
    } catch {
      // Lexical recall and revision validation remain authoritative.
    }
  }

  _allocateId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = normalizeRecipeId(this.idFactory());
      if (!this.recipes.has(id)) return id;
    }
    throw new Error("Could not allocate a unique recipe id.");
  }

  _requireRecipe(id, projectId) {
    const recipe = this.recipes.get(id);
    if (!recipe || recipe.projectId !== projectId) {
      throw new SolutionRecipeError(
        "RECIPE_NOT_FOUND",
        "Unknown recipe.",
        { id }
      );
    }
    return recipe;
  }

  _requireMutableRecipe(id, projectId) {
    const recipe = this._requireRecipe(id, projectId);
    if (recipe.status === "deleted" || recipe.status === "superseded") {
      throw new SolutionRecipeError(
        "RECIPE_IMMUTABLE",
        `Recipe '${id}' is ${recipe.status} and cannot be changed.`
      );
    }
    return recipe;
  }

  _authorizeProject(projectId) {
    if (!this.projects) {
      if (projectId !== "default") {
        throw new SolutionRecipeError(
          "PROJECT_BOUNDARY_VIOLATION",
          "A project store is required for nondefault recipes."
        );
      }
      return null;
    }
    const project = typeof this.projects.authorize === "function"
      ? this.projects.authorize(projectId, { includeArchived: false })
      : this.projects.get?.(projectId, { includeArchived: false });
    if (!project || project.status !== "active") {
      throw new SolutionRecipeError(
        "PROJECT_BOUNDARY_VIOLATION",
        "Unknown or archived recipe project."
      );
    }
    return project;
  }

  _validateEvidenceOwnership(projectId, evidence) {
    for (const item of evidence) {
      const artifact = ARTIFACT_EVIDENCE_RE.exec(item.ref);
      if (artifact) {
        if (typeof this.runtime?.artifacts?.get === "function") {
          this.runtime.artifacts.get(artifact[1], {
            projectId,
            revision: Number(artifact[2])
          });
        }
        continue;
      }
      if (TOOL_OUTPUT_EVIDENCE_RE.test(item.ref)) {
        if (typeof this.runtime?.toolOutputs?.read === "function") {
          this.runtime.toolOutputs.read(item.ref, {
            projectId,
            maxChars: 1
          });
        }
        continue;
      }
      if (CHECKPOINT_EVIDENCE_RE.test(item.ref)) {
        if (typeof this.runtime?.checkpoints?.get === "function") {
          const checkpoint = this.runtime.checkpoints.get(item.ref, { projectId });
          if (!checkpoint) {
            throw new SolutionRecipeError(
              "RECIPE_EVIDENCE_NOT_FOUND",
              "Checkpoint evidence is unavailable in this project."
            );
          }
        }
        continue;
      }
      if (HUMAN_EVIDENCE_RE.test(item.ref)) continue;
      throw new TypeError(
        "Evidence refs must be pinned artifacts, tool outputs, checkpoints, or human attestations."
      );
    }
  }

  _assertNoSecrets(value) {
    let sanitized;
    try {
      sanitized = sanitizeForAudit(value);
    } catch {
      throw new SolutionRecipeError(
        "RECIPE_SECRET_CHECK_FAILED",
        "Recipe content could not be checked safely."
      );
    }
    if (stableHash(sanitized) !== stableHash(value)) {
      throw new SolutionRecipeError(
        "RECIPE_SECRET_CONTENT",
        "Recipe content resembles credential material; use a secret reference instead."
      );
    }
    const knownValues = this._knownSecretValues();
    const redacted = redactKnownValues(value, knownValues);
    if (stableHash(redacted) !== stableHash(value)) {
      throw new SolutionRecipeError(
        "RECIPE_SECRET_CONTENT",
        "Recipe content contains a configured secret value; use a secret reference instead."
      );
    }
  }

  _knownSecretValues() {
    const store = this.runtime?.secrets;
    if (!store) return [];
    let snapshot = secretsStoreRedactionSnapshot(store);
    if (!snapshot && typeof store.listSecretNames === "function") {
      try {
        store.listSecretNames({ decidedBy: "recipe:redaction-check" });
      } catch {
        throw new SolutionRecipeError(
          "RECIPE_SECRET_CHECK_FAILED",
          "The secret redaction witness is unavailable."
        );
      }
      snapshot = secretsStoreRedactionSnapshot(store);
    }
    if (!snapshot) return [];
    if (snapshot.overflow) {
      throw new SolutionRecipeError(
        "RECIPE_SECRET_CHECK_FAILED",
        "The secret redaction witness exceeded its safe bound."
      );
    }
    return snapshot.records.map((record) => record.value);
  }

  _refresh() {
    this._withLock(() => this._restore());
  }

  _commit(op, projectId, details = {}) {
    if (this.lockDepth < 1) {
      throw new Error("Recipe commits require the mutation lock.");
    }
    if (!this.journalHealthy) {
      this._restore();
      throw new SolutionRecipeError(
        "RECIPE_PERSISTENCE_CORRUPT",
        "Recipe journal is corrupt or incomplete; repair it before writing."
      );
    }
    const at = this._now();
    const sequence = this.sequence + 1;
    const state = this._state(at, sequence);
    const event = {
      version: 1,
      sequence,
      op,
      at,
      projectId,
      details,
      state
    };
    if (
      jsonBytes(state) > MAX_STATE_BYTES
      || jsonBytes(event) > MAX_EVENT_LINE_BYTES
    ) {
      this._restore();
      throw new RangeError("Recipe state exceeds its durable persistence bound.");
    }
    let appendFailed = null;
    try {
      this.appendEvent(this.eventsPath, event);
    } catch (error) {
      appendFailed = error;
      this._restore();
      if (
        this.sequence !== sequence
        || stableHash(this._state(state.updatedAt, this.sequence)) !== stableHash(state)
      ) {
        throw error;
      }
    }
    if (!appendFailed) this.sequence = sequence;
    try {
      this.writeSnapshot(this.snapshotPath, state);
    } catch (error) {
      console.warn(`[recipes] snapshot refresh failed: ${error?.message ?? error}`);
    }
    return event;
  }

  _state(at = this._now(), sequence = this.sequence) {
    return {
      version: 1,
      sequence,
      updatedAt: at,
      recipes: [...this.recipes.values()]
        .map((recipe) => structuredClone(recipe))
        .sort((left, right) => left.id.localeCompare(right.id)),
      embeddingIdentities: [...this.embeddingIdentities.entries()]
        .map(([projectId, identity]) => ({
          projectId,
          identity: structuredClone(identity)
        }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId))
    };
  }

  _restore() {
    this.recipes = new Map();
    this.embeddingIdentities = new Map();
    this.sequence = 0;
    this.journalHealthy = true;
    this._loadSnapshot();
    this._replayEvents();
  }

  _loadSnapshot() {
    let snapshot;
    try {
      if (fs.statSync(this.snapshotPath).size > MAX_SNAPSHOT_BYTES) return;
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      return;
    }
    try {
      this._applyState(snapshot);
    } catch {
      // The event log may still repair an invalid snapshot.
    }
  }

  _replayEvents() {
    let lines;
    try {
      lines = readEventTail(this.eventsPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (this.sequence > 0) this.journalHealthy = false;
        return;
      }
      throw error;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        this.journalHealthy = false;
        break;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.journalHealthy = false;
        break;
      }
      if (!Number.isSafeInteger(event?.sequence)) {
        this.journalHealthy = false;
        break;
      }
      if (event.sequence <= this.sequence) continue;
      if (
        event.version !== 1
        || event.sequence !== this.sequence + 1
        || event.state?.sequence !== event.sequence
        || event.state?.updatedAt !== event.at
        || typeof event.projectId !== "string"
        || !PROJECT_ID_RE.test(event.projectId)
      ) {
        this.journalHealthy = false;
        break;
      }
      try {
        this._applyState(event.state);
      } catch {
        this.journalHealthy = false;
        break;
      }
    }
  }

  _applyState(value) {
    const source = plainRecord(value, "recipe state");
    assertOnlyKeys(
      source,
      new Set([
        "embeddingIdentities",
        "recipes",
        "sequence",
        "updatedAt",
        "version"
      ]),
      "recipe state"
    );
    if (source.version !== 1) throw new TypeError("Invalid recipe state version.");
    if (!Number.isSafeInteger(source.sequence) || source.sequence < 0) {
      throw new TypeError("Invalid recipe state sequence.");
    }
    requiredIso(source.updatedAt, "updatedAt");
    const recipes = boundedArray(source.recipes, "recipes", MAX_RECIPES)
      .map(normalizeStoredRecipe);
    const recipeMap = new Map();
    for (const recipe of recipes) {
      if (recipeMap.has(recipe.id)) throw new TypeError("Duplicate recipe id.");
      recipeMap.set(recipe.id, recipe);
    }
    const identities = boundedArray(
      source.embeddingIdentities,
      "embeddingIdentities",
      MAX_RECIPES
    );
    const identityMap = new Map();
    for (const entry of identities) {
      const record = plainRecord(entry, "embedding identity entry");
      assertOnlyKeys(
        record,
        new Set(["identity", "projectId"]),
        "embedding identity entry"
      );
      const projectId = normalizeProjectId(record.projectId);
      if (identityMap.has(projectId)) {
        throw new TypeError("Duplicate recipe embedding identity.");
      }
      identityMap.set(projectId, normalizeEmbeddingIdentity(record.identity));
    }
    const normalizedState = {
      version: 1,
      sequence: source.sequence,
      updatedAt: source.updatedAt,
      recipes,
      embeddingIdentities: [...identityMap.entries()].map(
        ([projectId, identity]) => ({ projectId, identity })
      )
    };
    if (jsonBytes(normalizedState) > MAX_STATE_BYTES) {
      throw new RangeError("Recipe state exceeds its durable persistence bound.");
    }
    this.recipes = recipeMap;
    this.embeddingIdentities = identityMap;
    this.sequence = source.sequence;
  }

  _withLock(operation) {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return operation();
      } finally {
        this.lockDepth -= 1;
      }
    }
    ensureDir(this.dir);
    const token = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      nonce: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    });
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      let fd;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, token, "utf8");
        fs.fsyncSync(fd);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
            try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
          }
          throw error;
        }
        if (!this._breakStaleLock() && Date.now() >= deadline) {
          throw new Error("Recipe store is busy.");
        }
        waitSynchronously(LOCK_RETRY_MS);
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
    this.lockDepth = 1;
    try {
      return operation();
    } finally {
      this.lockDepth = 0;
      this._releaseLock(token);
    }
  }

  _breakStaleLock() {
    let stat;
    let content;
    try {
      stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
      content = fs.readFileSync(this.lockPath, "utf8");
    } catch {
      return false;
    }
    let owner;
    try { owner = JSON.parse(content); } catch { owner = null; }
    if (processIsAlive(owner?.pid)) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf8") !== content) return false;
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  _releaseLock(token) {
    try {
      if (fs.readFileSync(this.lockPath, "utf8") === token) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Never remove a lock whose ownership token cannot be verified.
    }
  }

  _now() {
    return requiredIso(this.now(), "timestamp");
  }

  _summary(recipe) {
    return {
      id: recipe.id,
      projectId: recipe.projectId,
      revision: recipe.revision,
      status: recipe.status,
      title: recipe.title,
      summary: recipe.summary,
      verificationStatus: recipe.verification.status,
      supersededBy: recipe.supersededBy,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt
    };
  }

  _view(recipe) {
    return structuredClone(recipe);
  }

  _notify(notice) {
    if (!notice) return;
    try { this.onEvent?.(structuredClone(notice)); } catch { /* advisory */ }
    try {
      this.runtime?.events?.emit?.(
        notice.event,
        structuredClone(notice)
      );
    } catch {
      // Persistence is authoritative; notification delivery is advisory.
    }
  }
}

export function currentEmbeddingIdentity(embedder) {
  if (!embedder || typeof embedder !== "object") return null;
  const provider = boundedText(
    embedder.name ?? embedder.constructor?.name ?? "unknown",
    "embedder.name",
    120
  );
  const model = embedder.model == null
    ? null
    : boundedText(embedder.model, "embedder.model", 240);
  const dimension = positiveInteger(
    embedder.dim,
    0,
    "embedder.dim",
    { allowZero: true, max: MAX_EMBED_DIMENSION }
  );
  const endpointIdentityHash = embedder.baseUrl == null
    ? null
    : stableHash(safeEndpointIdentity(embedder.baseUrl));
  const base = {
    version: 1,
    provider,
    model,
    dimension,
    endpointIdentityHash,
    embedAlgorithmVersion: EMBED_ALGORITHM_VERSION,
    recipeTextSchemaVersion: RECIPE_TEXT_SCHEMA_VERSION
  };
  return Object.freeze({
    ...base,
    key: stableHash(base)
  });
}

export function recipeIndexText(recipe) {
  return [
    recipe.title,
    recipe.summary,
    ...recipe.preconditions.map((item) => `precondition ${item}`),
    ...recipe.actions.map((item) => `action ${item}`),
    ...recipe.failureModes.map((item) => `failure ${item}`),
    ...recipe.tags.map((item) => `tag ${item}`)
  ].join("\n");
}

export function recipeTextHash(recipe) {
  return stableHash(recipeIndexText(recipe));
}

export function renderRecipeMarkdown(recipe) {
  const lines = [
    `# ${recipe.title}`,
    "",
    `- ID: ${recipe.id}`,
    `- Revision: ${recipe.revision}`,
    `- Status: ${recipe.status}`,
    `- Project: ${recipe.projectId}`,
    "",
    recipe.summary,
    "",
    "## Preconditions",
    "",
    ...recipe.preconditions.map((item) => `- ${item}`),
    "",
    "## Actions",
    "",
    ...recipe.actions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Evidence",
    "",
    ...recipe.evidence.map((item) => (
      `- ${item.ref}${item.summary ? ` - ${item.summary}` : ""}`
    )),
    "",
    "## Verification",
    "",
    `- Status: ${recipe.verification.status}`,
    `- Method: ${recipe.verification.method ?? "none"}`,
    "",
    "## Failure modes",
    "",
    ...recipe.failureModes.map((item) => `- ${item}`)
  ];
  return `${lines.join("\n").trim()}\n`;
}

function normalizeStoredRecipe(value) {
  const source = plainRecord(value, "stored recipe");
  assertOnlyKeys(source, RECIPE_FIELDS, "stored recipe");
  if (source.version !== 1) throw new TypeError("Invalid stored recipe version.");
  const id = normalizeRecipeId(source.id);
  const projectId = normalizeProjectId(source.projectId);
  const revision = expectedRecipeRevision(source.revision);
  const status = normalizeStatus(source.status);
  const body = normalizeRecipeBody(source);
  const verification = normalizeVerification(source.verification);
  const supersedes = boundedArray(
    source.supersedes,
    "supersedes",
    MAX_REVISIONS
  ).map(normalizeRecipeId);
  if (new Set(supersedes).size !== supersedes.length || supersedes.includes(id)) {
    throw new TypeError("Recipe supersedes must contain unique foreign ids.");
  }
  const supersededBy = source.supersededBy == null
    ? null
    : normalizeRecipeId(source.supersededBy);
  if (supersededBy === id) throw new TypeError("A recipe cannot supersede itself.");
  const createdAt = requiredIso(source.createdAt, "createdAt");
  const updatedAt = requiredIso(source.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError("Recipe updatedAt cannot precede createdAt.");
  }
  const deletedAt = source.deletedAt == null
    ? null
    : requiredIso(source.deletedAt, "deletedAt");
  if (
    (status === "deleted" && deletedAt == null)
    || (status !== "deleted" && deletedAt != null)
  ) {
    throw new TypeError("Recipe deletion state is inconsistent.");
  }
  if (
    (status === "verified" && verification.status !== "verified")
    || (status === "failed" && verification.status !== "failed")
    || (status === "candidate" && verification.status !== "unverified")
    || (status === "superseded" && supersededBy == null)
  ) {
    throw new TypeError("Recipe status and verification metadata are inconsistent.");
  }
  return {
    version: 1,
    id,
    projectId,
    revision,
    status,
    ...body,
    verification,
    supersedes,
    supersededBy,
    deletedAt,
    createdAt,
    updatedAt,
    createdBy: boundedText(source.createdBy, "createdBy", MAX_ACTOR_CHARS),
    updatedBy: boundedText(source.updatedBy, "updatedBy", MAX_ACTOR_CHARS)
  };
}

function normalizeRecipeBody(source) {
  return {
    title: boundedText(source.title, "title", MAX_TITLE_CHARS),
    summary: boundedText(source.summary, "summary", MAX_SUMMARY_CHARS),
    preconditions: boundedTextArray(
      source.preconditions,
      "preconditions",
      MAX_LIST_ITEMS,
      MAX_LIST_TEXT_CHARS
    ),
    actions: boundedTextArray(
      source.actions,
      "actions",
      MAX_LIST_ITEMS,
      MAX_LIST_TEXT_CHARS
    ),
    evidence: normalizeEvidence(source.evidence),
    failureModes: boundedTextArray(
      source.failureModes ?? [],
      "failureModes",
      MAX_LIST_ITEMS,
      MAX_LIST_TEXT_CHARS,
      { allowEmpty: true }
    ),
    tags: boundedTextArray(
      source.tags ?? [],
      "tags",
      MAX_TAGS,
      MAX_TAG_CHARS,
      { allowEmpty: true }
    )
  };
}

function normalizeEvidence(value) {
  return dedupeEvidence(
    boundedArray(value, "evidence", MAX_EVIDENCE, { allowMissing: true })
      .map((item) => {
        const source = plainRecord(item, "evidence item");
        assertOnlyKeys(
          source,
          new Set(["kind", "ref", "summary"]),
          "evidence item"
        );
        const ref = boundedText(source.ref, "evidence.ref", 512);
        if (!EVIDENCE_REF_RE.test(ref)) {
          throw new TypeError(
            "evidence.ref must be a printable ASCII durable reference without spaces."
          );
        }
        return {
          ref,
          kind: source.kind == null
            ? null
            : boundedText(source.kind, "evidence.kind", 80),
          summary: source.summary == null
            ? null
            : boundedText(
                source.summary,
                "evidence.summary",
                MAX_EVIDENCE_SUMMARY_CHARS
              )
        };
      })
  );
}

function dedupeEvidence(items) {
  const byRef = new Map();
  for (const item of items) byRef.set(item.ref, structuredClone(item));
  return [...byRef.values()].slice(0, MAX_EVIDENCE);
}

function normalizeVerification(value) {
  const source = plainRecord(value, "recipe verification");
  assertOnlyKeys(
    source,
    new Set(["at", "by", "evidence", "failure", "method", "status"]),
    "recipe verification"
  );
  const status = String(source.status ?? "").trim().toLowerCase();
  if (!["unverified", "verified", "failed"].includes(status)) {
    throw new TypeError("Invalid recipe verification status.");
  }
  const method = source.method == null
    ? null
    : boundedText(source.method, "verification.method", 1000);
  const evidence = normalizeEvidence(source.evidence);
  const at = source.at == null ? null : requiredIso(source.at, "verification.at");
  const by = source.by == null
    ? null
    : boundedText(source.by, "verification.by", MAX_ACTOR_CHARS);
  const failure = source.failure == null
    ? null
    : boundedText(source.failure, "verification.failure", 2000);
  if (
    status === "verified"
    && (!method || evidence.length === 0 || !at || !by || failure)
  ) {
    throw new TypeError("Verified recipes require method, evidence, time, and actor.");
  }
  if (status === "failed" && (!failure || !at || !by)) {
    throw new TypeError("Failed recipes require a reason, time, and actor.");
  }
  if (
    status === "unverified"
    && (method || evidence.length > 0 || at || by || failure)
  ) {
    throw new TypeError("Unverified recipe metadata must be empty.");
  }
  return { status, method, evidence, at, by, failure };
}

function normalizeEmbeddingIdentity(value) {
  const source = plainRecord(value, "embedding identity");
  assertOnlyKeys(
    source,
    new Set([
      "dimension",
      "embedAlgorithmVersion",
      "endpointIdentityHash",
      "key",
      "model",
      "provider",
      "recipeTextSchemaVersion",
      "version"
    ]),
    "embedding identity"
  );
  if (source.version !== 1) throw new TypeError("Invalid embedding identity version.");
  const provider = boundedText(source.provider, "embedding provider", 120);
  const model = source.model == null
    ? null
    : boundedText(source.model, "embedding model", 240);
  const dimension = positiveInteger(
    source.dimension,
    0,
    "embedding dimension",
    { allowZero: true, max: MAX_EMBED_DIMENSION }
  );
  const endpointIdentityHash = source.endpointIdentityHash == null
    ? null
    : boundedHash(source.endpointIdentityHash, "endpointIdentityHash");
  if (
    source.embedAlgorithmVersion !== EMBED_ALGORITHM_VERSION
    || source.recipeTextSchemaVersion !== RECIPE_TEXT_SCHEMA_VERSION
  ) {
    throw new TypeError("Unsupported recipe embedding schema version.");
  }
  const base = {
    version: 1,
    provider,
    model,
    dimension,
    endpointIdentityHash,
    embedAlgorithmVersion: EMBED_ALGORITHM_VERSION,
    recipeTextSchemaVersion: RECIPE_TEXT_SCHEMA_VERSION
  };
  const expected = stableHash(base);
  if (source.key !== expected) {
    throw new TypeError("Embedding identity key does not match its fields.");
  }
  return { ...base, key: expected };
}

function normalizeEmbeddingVector(value, expectedDimension = 0) {
  const vector = boundedArray(
    value,
    "embedding",
    MAX_EMBED_DIMENSION
  );
  if (vector.length === 0) throw new TypeError("Embedding cannot be empty.");
  const normalized = vector.map((component) => {
    const number = Number(component);
    if (!Number.isFinite(number)) {
      throw new TypeError("Embedding components must be finite numbers.");
    }
    return number;
  });
  if (
    Number.isSafeInteger(expectedDimension)
    && expectedDimension > 0
    && normalized.length !== expectedDimension
  ) {
    throw new TypeError(
      `Embedding dimension ${normalized.length} does not match identity ${expectedDimension}.`
    );
  }
  return normalized;
}

function recipeSearchText(recipe) {
  return [
    recipeIndexText(recipe),
    ...recipe.evidence.map((item) => `${item.ref} ${item.summary ?? ""}`),
    recipe.verification.method ?? "",
    recipe.verification.failure ?? ""
  ].join("\n");
}

function recipeVectorNamespace(projectId) {
  return `recipe:${projectId}`;
}

function recipeNotice(event, durableEvent, recipe, extra = {}) {
  return {
    event,
    projectId: recipe.projectId,
    recipeId: recipe.id,
    revision: recipe.revision,
    status: recipe.status,
    sequence: durableEvent.sequence,
    at: durableEvent.at,
    ...extra
  };
}

function normalizeRecipeId(value) {
  const id = String(value ?? "").trim();
  if (!RECIPE_ID_RE.test(id)) {
    throw new TypeError("Invalid recipe id.");
  }
  return id;
}

function normalizeProjectId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) {
    throw new TypeError("Invalid project id.");
  }
  return id;
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!RECIPE_STATUS_SET.has(status)) {
    throw new TypeError("Invalid recipe status.");
  }
  return status;
}

function normalizeStatusFilter(value) {
  if (value == null || value === "") return null;
  const values = Array.isArray(value) ? value : [value];
  if (values.length > RECIPE_STATUSES.length) {
    throw new RangeError("Too many recipe statuses.");
  }
  return new Set(values.map(normalizeStatus));
}

function normalizeActor(contextOrValue) {
  const raw = typeof contextOrValue === "string"
    ? contextOrValue
    : contextOrValue?.actor
      ?? contextOrValue?.from
      ?? contextOrValue?.agentId
      ?? "unknown";
  return boundedText(raw, "actor", MAX_ACTOR_CHARS);
}

function boundedTextArray(
  value,
  field,
  maxItems,
  maxChars,
  { allowEmpty = false } = {}
) {
  const items = boundedArray(value, field, maxItems);
  if (!allowEmpty && items.length === 0) {
    throw new TypeError(`${field} must contain at least one item.`);
  }
  const normalized = items.map((item, index) => (
    boundedText(item, `${field}[${index}]`, maxChars)
  ));
  return [...new Set(normalized)];
}

function boundedArray(
  value,
  field,
  maxItems,
  { allowMissing = false } = {}
) {
  if (value == null && allowMissing) return [];
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  if (value.length > maxItems) {
    throw new RangeError(`${field} exceeds ${maxItems} items.`);
  }
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${field} cannot be sparse.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new TypeError(`${field} cannot contain accessors.`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function plainRecord(value, field) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  const output = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${field} has invalid keys.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new TypeError(`${field} cannot contain accessors.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function assertOnlyKeys(source, allowed, field) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field} contains unsupported field '${key}'.`);
    }
  }
}

function boundedText(
  value,
  field,
  maxChars,
  { allowEmpty = false } = {}
) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string.`);
  const text = value.trim();
  if (!allowEmpty && !text) throw new TypeError(`${field} cannot be empty.`);
  if (text.length > maxChars) {
    throw new RangeError(`${field} exceeds ${maxChars} characters.`);
  }
  return text;
}

function expectedRecipeRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("expectedRevision must be a positive integer.");
  }
  return revision;
}

function assertRecipeRevision(recipe, expectedRevision) {
  if (recipe.revision !== expectedRevision) {
    throw new RecipeRevisionError(
      recipe.id,
      expectedRevision,
      recipe.revision
    );
  }
}

function nextRevision(recipe) {
  if (recipe.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Recipe revision limit reached.");
  }
  return recipe.revision + 1;
}

function listLimit(value, fallback = 20) {
  if (value == null) return fallback;
  return positiveInteger(value, fallback, "limit", { max: MAX_LIST_ITEMS });
}

function positiveInteger(
  value,
  fallback,
  field,
  { allowZero = false, max = Number.MAX_SAFE_INTEGER } = {}
) {
  if (value == null) return fallback;
  const number = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > max
  ) {
    throw new TypeError(`${field} must be an integer from ${minimum} to ${max}.`);
  }
  return number;
}

function requiredIso(value, field) {
  const text = String(value ?? "");
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${field} must be an ISO timestamp.`);
  }
  return new Date(text).toISOString();
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedHash(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new TypeError(`${field} must be a SHA-256 digest.`);
  }
  return text;
}

function safeEndpointIdentity(value) {
  const text = String(value ?? "").trim();
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "custom-endpoint";
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Recipe reindexing was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function waitSynchronously(ms) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readEventTail(filePath) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, MAX_EVENTS_BYTES);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  }
  return text.split(/\r?\n/);
}

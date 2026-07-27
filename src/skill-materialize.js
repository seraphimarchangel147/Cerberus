import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { appendSkillRevision } from "./skill-revisions.js";
import { nowIso, stableHash } from "./utils.js";

// Turn an accepted "skill" proactive-suggestion into a durable SKILL.md
// file under the user's skills directory. Pure function from suggestion
// + runtime → { slug, path }; the caller is expected to runtime.skills
// .reload() afterward so the new skill shows up immediately.
//
// Why a separate module: keeps hosted-interface.js focused on the HTTP
// surface, and makes the slug/dedupe/frontmatter logic individually
// testable.

export function createSkillFromSuggestion({ runtime, suggestion, lineage = {} }) {
  if (!suggestion?.title) throw new Error("suggestion has no title");
  if (!suggestion?.draftBody) throw new Error("suggestion has no draftBody — observer must have proposed an automation, not a skill");
  return writeSkillFile({
    runtime,
    title: suggestion.title,
    description: suggestion.rationale,
    body: suggestion.draftBody,
    lineage: {
      sourceSuggestionId: suggestion.id,
      createdBy: "proactive-observer",
      ...lineage
    }
  });
}

/// Story 6: miner candidates have a different shape than observer
/// suggestions — proposal.{name, body, scheduleHint} + sequence stats
/// — but produce the same end artifact: a runnable SKILL.md. Wraps
/// the shared writer with miner-specific lineage stamps. Returns
/// { slug, path, scheduleHint } so the caller can ask the user
/// whether to also create a cron job at the hinted time.
export function createSkillFromCandidate({ runtime, candidate, lineage = {} }) {
  const proposal = candidate?.proposal ?? null;
  if (!proposal?.name && !candidate?.title) throw new Error("candidate has no proposal.name or title");
  if (!proposal?.body && !candidate?.draftBody) throw new Error("candidate has no proposal.body — cannot materialize");

  const seq = candidate?.sequence ?? {};
  const summary = composeMinedDescription(candidate);
  const body = buildMinedBody(proposal, seq);

  const result = writeSkillFile({
    runtime,
    title: proposal?.name ?? candidate.title,
    description: summary,
    body,
    lineage: {
      sourceCandidateId: candidate.id,
      ...(candidate.recipe?.id
        ? {
            sourceRecipeId: candidate.recipe.id,
            sourceRecipeRevision: candidate.recipe.revision,
            sourceRecipeHash: candidate.recipe.hash
          }
        : {}),
      createdBy: candidate.source === "session-miner"
        ? "session-miner"
        : candidate.source === "recipe-memory"
          ? "recipe-memory"
          : "pattern-miner",
      observedCount: seq.count ?? null,
      observedConfidence: typeof seq.confidence === "number" ? seq.confidence : null,
      sequenceFingerprint: candidate.fingerprint ?? null,
      ...lineage
    }
  });
  return { ...result, scheduleHint: proposal?.scheduleHint ?? null };
}

export function createSkillCandidateFromRecipe({ runtime, recipe }) {
  if (!recipe || recipe.status !== "verified") {
    throw new Error("Only a verified recipe can become a skill candidate.");
  }
  if (recipe.supersededBy || recipe.deletedAt) {
    throw new Error("Superseded or deleted recipes cannot become skill candidates.");
  }
  const dataDir = runtime?.dataDir
    ?? runtime?.proactiveObserver?.dataDir
    ?? (runtime?.recipes?.dir
      ? path.dirname(path.dirname(runtime.recipes.dir))
      : null);
  if (!dataDir) throw new Error("Runtime data directory is unavailable.");
  const recipeHash = stableHash({
    id: recipe.id,
    projectId: recipe.projectId,
    revision: recipe.revision,
    title: recipe.title,
    summary: recipe.summary,
    preconditions: recipe.preconditions,
    actions: recipe.actions,
    failureModes: recipe.failureModes,
    verification: recipe.verification
  });
  const id = `rcp_${recipeHash.slice(0, 16)}`;
  const dir = path.join(dataDir, "skills-suggested");
  ensureDir(dir);
  const candidate = {
    id,
    proposedAt: nowIso(),
    status: "pending",
    source: "recipe-memory",
    category: "skill",
    projectId: recipe.projectId,
    fingerprint: recipeHash,
    recipe: {
      id: recipe.id,
      revision: recipe.revision,
      hash: recipeHash,
      verificationRef: recipe.verification.evidence[0]?.ref ?? null
    },
    proposal: {
      name: recipe.title,
      description: recipe.summary,
      body: renderRecipeSkillBody(recipe),
      scheduleHint: null
    }
  };
  const filePath = path.join(dir, `${id}.json`);
  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      existing?.recipe?.id !== recipe.id
      || existing?.recipe?.revision !== recipe.revision
      || existing?.recipe?.hash !== recipeHash
    ) {
      throw new Error("Recipe skill candidate identity collision.");
    }
    return { candidate: existing, path: filePath, created: false };
  }
  writeJsonAtomic(filePath, candidate);
  return { candidate, path: filePath, created: true };
}

// Compose a description string that includes the observed stats so the
// user (and the skill itself) has provenance — "this was learned from
// 10 observations between Slack and Linear at 21:00 every weekday."
function composeMinedDescription(candidate) {
  const proposal = candidate.proposal ?? {};
  const seq = candidate.sequence ?? {};
  const parts = [];
  if (proposal.description) parts.push(proposal.description.trim());
  if (seq.count) {
    const hour = typeof seq.startHour === "number" ? ` around ${String(seq.startHour).padStart(2, "0")}:00` : "";
    parts.push(`Detected from ${seq.count} occurrences${hour}.`);
  }
  return parts.join(" ").trim().slice(0, 1024);
}

// Mined skill body: lead with the proposal's prose, then append a
// "When this fires" outline of the app sequence so the agent has
// concrete steps to follow if the prose is vague.
function buildMinedBody(proposal, seq) {
  const body = String(proposal?.body ?? "").trim();
  const apps = Array.isArray(seq?.apps) ? seq.apps : [];
  if (apps.length === 0) return body;
  const appLines = apps.map((a, i) => `${i + 1}. ${a}`).join("\n");
  // Avoid duplicating if the model already wrote a step list.
  if (/^\d+\.\s/m.test(body)) return body;
  return body + "\n\n**Observed app sequence:**\n" + appLines + "\n";
}

function renderRecipeSkillBody(recipe) {
  const lines = [
    recipe.summary,
    "",
    "## Preconditions",
    ...recipe.preconditions.map((item) => `- ${item}`),
    "",
    "## Procedure",
    ...recipe.actions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Verification",
    `- ${recipe.verification.method}`,
    ...recipe.verification.evidence.map((item) => `- Evidence: ${item.ref}`),
    "",
    "## Failure modes",
    ...(recipe.failureModes.length > 0
      ? recipe.failureModes.map((item) => `- ${item}`)
      : ["- Stop and report the failed step; do not claim success."])
  ];
  return `${lines.join("\n").trim()}\n`;
}

// Shared writer for both shapes. Keeps slug + frontmatter logic in one
// place so observer-sourced + miner-sourced skills look identical
// after materialization (different lineage keys, same structure).
function writeSkillFile({ runtime, title, description, body, lineage = {} }) {
  const userDir = pickUserSkillsDir(runtime);
  if (!userDir) throw new Error("no user skills directory available (runtime not durable?)");
  ensureDir(userDir);

  const slug = dedupeSlug(userDir, slugify(title));
  const skillDir = path.join(userDir, slug);
  ensureDir(skillDir);
  const skillPath = path.join(skillDir, "SKILL.md");

  const desc = String(description ?? title ?? "").slice(0, 1024);
  const bodyText = String(body ?? "").trim();

  const lineageLines = [];
  for (const [key, value] of Object.entries(lineage)) {
    if (value === null || value === undefined) continue;
    lineageLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  const frontmatter = [
    "---",
    `name: ${slug}`,
    `description: ${jsonInlineString(desc)}`,
    ...lineageLines,
    `createdAt: ${new Date().toISOString()}`,
    "---"
  ].join("\n");

  // Keep the blank separator explicit. Filtering falsy array entries here
  // previously collapsed `---\n\n<body>` into an unparsable delimiter/body.
  const document = `${frontmatter}\n\n${bodyText}\n`;
  writeTextAtomic(skillPath, document);
  appendSkillRevision(skillDir, {
    skill: slug,
    action: "materialized",
    by: lineage.createdBy ?? "skill-materialize",
    after: document,
    metadata: lineage
  });
  return { slug, path: skillPath };
}

// runtime.skills.dirs is [bundled, userDir?] — bundled is read-only
// (lives under examples/skills in the install), so writes always go to
// the SECOND dir if present. If only bundled is configured, return null.
export function pickUserSkillsDir(runtime) {
  const dirs = runtime?.skills?.dirs ?? [];
  if (dirs.length < 2) return null;
  return dirs[dirs.length - 1];
}

// Conservative slug: lowercase, alnum + hyphen, collapsed, trimmed.
// Cap at 48 chars so directory names stay readable on macOS Finder.
export function slugify(text) {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "untitled-skill";
}

// If `<userDir>/<slug>/` exists, try `<slug>-2`, `<slug>-3`, … until free.
export function dedupeSlug(userDir, slug) {
  if (typeof slug !== "string" || slug.length > 48 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("invalid skill slug: expected lowercase kebab-case using only a-z, 0-9, and hyphens");
  }
  let candidate = slug;
  let n = 2;
  while (fs.existsSync(path.join(userDir, candidate))) {
    candidate = `${slug}-${n++}`;
    if (n > 100) throw new Error(`could not dedupe slug after 100 attempts: ${slug}`);
  }
  return candidate;
}

// agentskills.io spec allows up to 1024 chars for description; we
// inline-quote it to handle commas, colons, special chars cleanly.
function jsonInlineString(s) {
  const escaped = String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .trim();
  return `"${escaped}"`;
}

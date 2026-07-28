import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendJsonLine, writeTextAtomic } from "./file-utils.js";
import { scoreFromToolCalls } from "./outcome-store.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso, stableHash } from "./utils.js";
import { pickUserSkillsDir, slugify, dedupeSlug } from "./skill-materialize.js";
import { appendSkillRevision, loadSkillRevisions } from "./skill-revisions.js";
import { createOptionalDomainLearningStore } from "./domain-learnings.js";

// Subdirectories inside a skill dir that count as "linked files" — the
// Hermes convention: a skill can carry deep reference docs, runnable
// helper scripts, and fill-in templates alongside its SKILL.md, so one
// skill can hold a 500-line playbook without bloating the body.
const LINKED_DIRS = ["references", "templates", "scripts", "assets"];
export const MAX_LINKED_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_BODY_BYTES = 256 * 1024;
const MAX_SKILL_FILE_BYTES = MAX_SKILL_BODY_BYTES + (64 * 1024);
const MAX_SKILL_SLUG_LENGTH = 64;
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_LIKE_UNICODE_RE = /[\u2024\u2044\u2215\u29f8\u29f9\ufe52\uff0e\uff0f\uff3c]/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const SKILL_STATES = new Set(["active", "stale", "archived"]);

export const DEFAULT_CURATOR_STALE_DAYS = 30;
export const DEFAULT_CURATOR_ARCHIVE_DAYS = 90;

export function resolveCuratorThresholds(env = process.env) {
  const staleDays = positiveDays(env.OPENAGI_CURATOR_STALE_DAYS, DEFAULT_CURATOR_STALE_DAYS);
  const archiveDays = positiveDays(env.OPENAGI_CURATOR_ARCHIVE_DAYS, DEFAULT_CURATOR_ARCHIVE_DAYS);
  return { staleDays, archiveDays: Math.max(staleDays, archiveDays) };
}

export function resolveCuratorPolicy(env = process.env) {
  return {
    pruneBundled: enabledSetting(env.OPENAGI_CURATOR_PRUNE_BUNDLED, false),
    scope: String(env.OPENAGI_CURATOR_SCOPE ?? "all").trim().toLowerCase()
      === "agent-created"
      ? "agent-created"
      : "all"
  };
}

export function classifySkillAge({ state = "active", ageDays, staleDays, archiveDays }) {
  const current = normalizeSkillState(state);
  if (current === "archived") return "archived";
  if (!Number.isFinite(ageDays) || ageDays < 0) return current;
  if (ageDays >= archiveDays) return "archived";
  if (ageDays >= staleDays) return "stale";
  return "active";
}

export class SkillRegistry {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dirs = options.dirs ?? [];
    this.skills = new Map();
    this.diagnostics = [];
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.domainLearnings = Object.hasOwn(options, "domainLearnings")
      ? options.domainLearnings
      : createOptionalDomainLearningStore({
          env: options.env ?? process.env,
          dataDir: this.dataDir,
          root: options.learningsDir
        });
    // Durable telemetry (Hermes-style): every view/run bumps a usage
    // counter, every mutation lands in an append-only edit log. This is
    // what lets the dashboard answer "which skills does he actually use,
    // and when did he last improve them?"
    this.editLogPath = path.join(this.dataDir, "skill-edits.jsonl");
    this.usageLogPath = path.join(this.dataDir, "skill-usage.jsonl");
    this.curatorReportPath = options.curatorReportPath ?? path.join(this.dataDir, "curator", "REPORT.md");
    this.usage = loadUsage(this.usageLogPath);
    if (options.autoLoad !== false) this.reload();
  }

  reload() {
    this.skills.clear();
    this.diagnostics = [];
    for (const dir of this.dirs) this.loadFrom(dir);
    if (this.runtime?.tools) this.exposeAsTools(this.runtime.tools);
    return this.list();
  }

  loadFrom(dir) {
    try {
      ensureDir(dir);
    } catch (error) {
      this.recordDiagnostic(dir, error);
      return;
    }
    for (const entry of safeReadDir(dir)) {
      if (entry.startsWith(".")) continue; // skip .trash etc.
      const skillDir = path.join(dir, entry);
      if (!safeIsDir(skillDir)) continue;
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      let skill;
      try {
        skill = parseSkill(skillPath, skillDir);
      } catch (error) {
        this.recordDiagnostic(skillPath, error);
        continue;
      }
      if (skill) {
        skill.bundled = dir === this.dirs[0];
        this.skills.set(skill.name, skill);
      }
    }
  }

  recordDiagnostic(file, error) {
    const diagnostic = {
      // Diagnostics are display/audit values, not filesystem operands.
      // Keep them stable across Windows and POSIX hosts.
      file: String(file).replaceAll("\\", "/"),
      reason: error?.message ?? String(error)
    };
    this.diagnostics.push(diagnostic);
    try { this.warn(`[openagi] skipped invalid skill ${diagnostic.file}: ${diagnostic.reason}`); } catch { /* advisory */ }
    return diagnostic;
  }

  getDiagnostics() {
    return this.diagnostics.map((entry) => ({ ...entry }));
  }

  list() {
    return [...this.skills.values()].map(({ body, dir, ...rest }) => ({
      ...rest,
      stats: this.statsFor(rest.name)
    }));
  }

  has(name) {
    return isValidSkillSlug(name) && this.skills.has(name);
  }

  // Hermes-parity: a compact always-on catalog injected into the system
  // prompt. Without this the model only learns skills exist if it happens to
  // call list_skills — which it rarely does, so hand-authored procedural
  // knowledge sits unused. Archived skills are excluded; stale ones are
  // marked so the model prefers fresh procedures.
  promptIndex({ maxSkills = 60, maxDescription = 96 } = {}) {
    let rows;
    try {
      rows = [...this.skills.values()];
    } catch {
      return "";
    }
    const availableTools = availableSkillToolNames(this.runtime?.tools);
    const active = rows
      .filter((skill) => normalizeSkillState(skill?.state) !== "archived")
      // Conditional activation: a skill whose requires_tools are missing, or
      // whose primaries are present, is not advertised this session.
      .filter((skill) => this.isActivatedFor(skill, availableTools))
      .slice(0, maxSkills);
    if (active.length === 0) return "";
    const lines = active.map((skill) => {
      const desc = String(skill.description ?? "").replace(/\s+/g, " ").trim();
      const clipped = desc.length > maxDescription
        ? `${desc.slice(0, maxDescription - 1)}…`
        : desc;
      const stale = normalizeSkillState(skill?.state) === "stale" ? " (stale)" : "";
      const bundle = skill?.bundle?.length ? ` (bundle: ${skill.bundle.join(", ")})` : "";
      return `- ${skill.name}${stale}${bundle}: ${clipped || "no description"}`;
    });
    return [
      "",
      "",
      "## Skills (mandatory scan)",
      "Before acting, scan this list. If a skill matches or is even partially relevant to the task, you MUST load it with use_skill(name) and follow its instructions; err on the side of loading. Skills encode proven workflows, exact commands, and user preferences; they outperform improvising. If a skill you used was wrong, stale, or missing a step, patch it immediately with edit_skill. After completing a non-trivial task (5+ tool calls), fixing a tricky error, or discovering a workflow worth repeating, call create_skill to save numbered steps, exact commands, and the pitfalls you hit. If the user corrects your approach, save the corrected version. Skip simple one-offs.",
      ...lines
    ].join("\n");
  }

  domainGuidanceForUrl(url) {
    if (!this.domainLearnings || typeof this.domainLearnings.loadForUrl !== "function") {
      return null;
    }
    return this.domainLearnings.loadForUrl(url);
  }

  // MARK: — conditional activation (Hermes parity)

  // A skill is ACTIVE for this session when its hard dependencies are present
  // (`requires_tools`) and its primaries are absent (`fallback_for_tools`).
  // No declaration = always active, so every legacy skill is unaffected.
  // When the tool registry is unreadable we fail OPEN: hiding procedural
  // knowledge on a probe failure is worse than showing an extra skill.
  isActivatedFor(skill, available = availableSkillToolNames(this.runtime?.tools)) {
    if (!skill) return false;
    if (!(available instanceof Set)) return true;
    const requires = skill.requiresTools;
    if (requires && !requires.every((tool) => available.has(tool))) return false;
    const fallbackFor = skill.fallbackForTools;
    if (fallbackFor && fallbackFor.some((tool) => available.has(tool))) return false;
    return true;
  }

  // Why a skill is hidden — surfaced by list_skills so the model can tell
  // "no such skill" from "gated off this session".
  activationFor(skill, available = availableSkillToolNames(this.runtime?.tools)) {
    const active = this.isActivatedFor(skill, available);
    if (active) return { active: true, reason: null, missingTools: [], supersededBy: [] };
    const missingTools = (skill?.requiresTools ?? [])
      .filter((tool) => !(available instanceof Set) || !available.has(tool));
    const supersededBy = (skill?.fallbackForTools ?? [])
      .filter((tool) => available instanceof Set && available.has(tool));
    return {
      active: false,
      reason: missingTools.length > 0 ? "requires-missing-tools" : "primary-tools-available",
      missingTools,
      supersededBy
    };
  }

  // MARK: — bundles

  // Expand a bundle alias into its concrete member skills, depth-first, with
  // cycle detection and a hard depth cap so a self-referential bundle cannot
  // hang the load path.
  expandBundle(name, { maxDepth = 4, maxMembers = 24 } = {}) {
    const members = [];
    const seen = new Set();
    const cycles = [];
    const missing = [];
    const walk = (skillName, depth, trail) => {
      if (depth > maxDepth) {
        throw new Error(`bundle '${name}' exceeds max expansion depth of ${maxDepth}`);
      }
      if (trail.includes(skillName)) {
        cycles.push([...trail, skillName].join(" -> "));
        return;
      }
      const skill = this.skills.get(skillName);
      if (!skill) {
        missing.push(skillName);
        return;
      }
      const refs = skill.bundle;
      if (!refs || refs.length === 0) {
        if (!seen.has(skillName)) {
          seen.add(skillName);
          if (members.length >= maxMembers) {
            throw new Error(`bundle '${name}' expands past the ${maxMembers}-skill limit`);
          }
          members.push(skillName);
        }
        return;
      }
      for (const ref of refs) walk(ref, depth + 1, [...trail, skillName]);
    };
    walk(name, 0, []);
    return { bundle: name, members, cycles, missing };
  }

  isBundle(name) {
    const skill = this.skills.get(name);
    return Boolean(skill?.bundle?.length);
  }

  mustGet(name) {
    assertSkillSlug(name);
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }

  // MARK: — telemetry

  recordUse(name, mode, outcome = "ok", at = nowIso(), sessionId = null) {
    assertSkillSlug(name);
    if (mode !== "view" && mode !== "run") throw new Error(`Invalid skill usage mode: ${mode}`);
    if (outcome !== "ok" && outcome !== "error") {
      throw new Error(`Invalid skill usage outcome: ${outcome}`);
    }
    const entry = this.usage.get(name) ?? emptyUsage();
    if (mode === "view") entry.views += 1;
    else entry.runs += 1;
    entry.lastUsedAt = at;
    entry.events.push({ mode, outcome, at });
    this.usage.set(name, entry);
    try {
      appendJsonLine(this.usageLogPath, { skill: name, mode, outcome, at });
    } catch { /* telemetry must never break the skill itself */ }
    // Live observability lane: dashboard + Discord feed can show exactly
    // when a skill was loaded or executed. Advisory only — listeners must
    // never break the underlying skill action.
    try {
      this.runtime?.events?.emit?.("skill-use", {
        skill: name,
        mode,
        outcome,
        at,
        sessionId
      });
    } catch { /* advisory */ }
  }

  seedActivity(name, at) {
    assertSkillSlug(name);
    if (this.usage.has(name)) return false;
    const timestamp = validDate(at, "skill activity seed time").toISOString();
    const entry = emptyUsage();
    entry.lastUsedAt = timestamp;
    entry.events.push({ mode: "seed", outcome: "ok", at: timestamp });
    this.usage.set(name, entry);
    try {
      appendJsonLine(this.usageLogPath, {
        skill: name,
        mode: "seed",
        outcome: "ok",
        at: timestamp
      });
    } catch { /* telemetry must never break curation */ }
    return true;
  }

  reloadUsage() {
    this.usage = loadUsage(this.usageLogPath);
    return this.usage;
  }

  usageFor(name) {
    assertSkillSlug(name);
    const entry = this.usage.get(name) ?? emptyUsage();
    return {
      views: entry.views,
      runs: entry.runs,
      lastUsedAt: entry.lastUsedAt,
      events: entry.events.map((event) => ({ ...event }))
    };
  }

  logEdit(entry, sessionId = null) {
    const record = { at: nowIso(), ...entry };
    try {
      appendJsonLine(this.editLogPath, record);
    } catch { /* ignore */ }
    try {
      this.runtime?.events?.emit?.("skill-edit", {
        ...record,
        sessionId
      });
    } catch { /* advisory */ }
  }

  /**
   * Per-skill aggregate: usage counters + graded outcome scores. The
   * outcome store already records every skill-run with a qualityScore;
   * this rolls them up so /skills can show "12 runs · avg 0.74".
   */
  statsFor(name) {
    assertSkillSlug(name);
    const use = this.usage.get(name) ?? { views: 0, runs: 0, lastUsedAt: null };
    const outcomes = (this.runtime?.outcomes?.byRef?.(name) ?? [])
      .filter((o) => o.kind === "skill-run" && o.resolved && Number.isFinite(o.qualityScore))
      .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    const scores = outcomes.map((o) => o.qualityScore);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return {
      views: use.views,
      runs: use.runs,
      gradedRuns: scores.length,
      avgScore: avg,
      lastScore: scores.length ? scores[scores.length - 1] : null,
      lastUsedAt: use.lastUsedAt,
      recentRuns: outcomes.slice(-12).map((o) => ({
        at: o.resolvedAt ?? o.at,
        score: o.qualityScore,
        source: o.source ?? null
      }))
    };
  }

  /**
   * Edit history for one skill (or all when name is null), newest first.
   */
  history(name = null, limit = 50) {
    if (name !== null) assertSkillSlug(name);
    const edits = readJsonl(this.editLogPath)
      .filter((e) => !name || e.skill === name)
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
      .slice(0, limit);
    return { edits };
  }

  revisionHistory(name, limit = 20) {
    const skill = this.mustGet(name);
    const boundedLimit = positiveInteger(limit, 20, { min: 1, max: 100 });
    const currentHash = stableHash(fs.readFileSync(skill.path, "utf8"));
    const revisions = loadSkillRevisions(skill.dir);
    const head = revisions.at(-1) ?? null;
    return {
      skill: skill.name,
      currentHash,
      revisions: revisions
        .slice()
        .reverse()
        .slice(0, boundedLimit)
        .map((revision) => ({
          id: revision.id,
          at: revision.at,
          action: revision.action,
          by: revision.by ?? "system",
          beforeHash: revision.beforeHash,
          afterHash: revision.afterHash,
          isHead: revision.id === head?.id,
          rollbackEligible: revision.id === head?.id &&
            revision.before !== null &&
            revision.afterHash === currentHash
        }))
    };
  }

  capabilityReport(name, context = {}) {
    const skill = this.mustGet(name);
    const scope = resolveSkillToolScope(skill, context, this.runtime?.tools);
    return {
      skill: skill.name,
      state: skill.state,
      declaredTools: scope.declaredTools,
      effectiveTools: scope.advertisedTools,
      missingToolDefinitions: scope.missingToolDefinitions,
      deniedByBoundary: scope.deniedByBoundary,
      inheritedBoundary: scope.inheritedBoundary,
      willRunWithoutTools: scope.advertisedTools.length === 0,
      status: scope.missingToolDefinitions.length > 0 || scope.deniedByBoundary.length > 0
        ? "partial"
        : scope.advertisedTools.length > 0
          ? "ready"
          : "text-only"
    };
  }

  rollbackSkillRevision(name, revisionId, by = "agent", sessionId = null) {
    const skill = this.mustGet(name);
    const requestedId = String(revisionId ?? "").trim();
    if (!requestedId) throw new Error("rollbackSkillRevision requires a revisionId");
    const revisions = loadSkillRevisions(skill.dir);
    const head = revisions.at(-1);
    if (!head) throw new Error(`Skill '${name}' has no revision history to roll back.`);
    if (head.id !== requestedId) {
      throw new Error("Only the current skill revision can be rolled back; refresh list_skill_revisions first.");
    }
    if (head.before === null || head.after === null || !head.afterHash) {
      throw new Error(`Skill '${name}' revision '${requestedId}' has no recoverable prior document.`);
    }
    const current = fs.readFileSync(skill.path, "utf8");
    if (stableHash(current) !== head.afterHash) {
      throw new Error(`Skill '${name}' changed after this revision was recorded; refusing to overwrite it.`);
    }
    assertRollbackDocument(skill.name, head.before);
    writeTextAtomic(skill.path, head.before);
    appendSkillRevision(skill.dir, {
      skill: name,
      action: "rolled-back",
      by,
      before: current,
      after: head.before,
      metadata: {
        restoredRevisionId: head.id,
        restoredAction: head.action
      }
    });
    this.logEdit(
      { skill: name, action: "rolled-back", by, summary: `restored ${head.id}` },
      sessionId
    );
    this.reload();
    return {
      skill: name,
      rolledBackRevisionId: head.id,
      restoredAction: head.action,
      currentHash: stableHash(head.before)
    };
  }

  // MARK: — in-context loading (Hermes-style "view")

  /**
   * Load a skill for IN-CONTEXT use: full body + linked-file manifest.
   * Unlike run(), nothing is executed — the caller (model or dashboard)
   * reads the instructions and acts with its own conversation context.
   * Pass `file` to read one linked file's content instead.
   */
  view(name, file = null, sessionId = null) {
    const skill = this.mustGet(name);
    if (file) {
      try {
        const resolved = resolveLinkedFile(skill.dir, file);
        const result = {
          skill: name,
          file,
          content: readUtf8FileCapped(resolved, MAX_LINKED_FILE_BYTES, "linked file")
        };
        this.recordUse(name, "view", "ok", nowIso(), sessionId);
        return result;
      } catch (error) {
        this.recordUse(name, "view", "error", nowIso(), sessionId);
        throw error;
      }
    }
    this.recordUse(name, "view", "ok", nowIso(), sessionId);
    return {
      name: skill.name,
      description: skill.description,
      category: skill.category,
      pinned: skill.pinned,
      state: skill.state,
      bundled: skill.bundled ?? false,
      createdBy: skill.createdBy,
      createdAt: skill.createdAt,
      sourceSuggestionId: skill.sourceSuggestionId,
      sourceImportId: skill.sourceImportId,
      sourceImportHash: skill.sourceImportHash,
      sourceImportKind: skill.sourceImportKind,
      ownerProjectId: skill.ownerProjectId,
      allowedTools: skill.allowedTools,
      requiresTools: skill.requiresTools ?? null,
      fallbackForTools: skill.fallbackForTools ?? null,
      bundle: skill.bundle ?? null,
      meta: skill.meta ?? {},
      body: skill.body,
      linkedFiles: skill.linkedFiles ?? [],
      path: skill.path,
      stats: this.statsFor(name)
    };
  }

  // MARK: — curation (create / patch / edit / pin / delete)

  createSkill(
    { name, description = "", body = "", category = null, createdBy = "agent" } = {},
    sessionId = null
  ) {
    if (!name) throw new Error("createSkill requires a name/title");
    const slugBase = slugForCreate(name);
    const bodyText = String(body ?? "");
    if (!bodyText.trim()) throw new Error("createSkill requires a non-empty body");
    assertSkillBodySize(bodyText);
    const userDir = pickUserSkillsDir(this.runtime) ?? this.dirs[this.dirs.length - 1];
    if (!userDir) throw new Error("no writable skills directory configured");
    ensureDir(userDir);
    const slug = dedupeSlug(userDir, slugBase);
    assertSkillSlug(slug);
    const skillDir = path.join(userDir, slug);
    const fmLines = [
      "---",
      `name: ${slug}`,
      `description: ${JSON.stringify(String(description).slice(0, 1024))}`,
      category ? `category: ${JSON.stringify(String(category))}` : null,
      `createdBy: ${JSON.stringify(String(createdBy ?? "agent"))}`,
      `createdAt: ${nowIso()}`,
      "---"
    ].filter(Boolean);
    const document = fmLines.join("\n") + "\n\n" + bodyText.trim() + "\n";
    assertSkillDocumentSize(document);
    ensureDir(skillDir);
    writeTextAtomic(path.join(skillDir, "SKILL.md"), document);
    appendSkillRevision(skillDir, { skill: slug, action: "created", by: createdBy, after: document });
    this.logEdit(
      {
        skill: slug,
        action: "created",
        by: createdBy,
        summary: String(description).slice(0, 120)
      },
      sessionId
    );
    this.reload();
    return { slug, path: path.join(skillDir, "SKILL.md") };
  }

  /**
   * Targeted find-and-replace on a skill's SKILL.md — the Hermes patch
   * primitive. Requires a UNIQUE match so a sloppy old_string can't
   * silently rewrite the wrong section.
   */
  patchSkill(name, oldString, newString, by = "agent", sessionId = null) {
    const skill = this.mustGet(name);
    if (skill.pinned) {
      throw new Error(`Skill '${name}' is pinned; unpin it before editing.`);
    }
    if (typeof oldString !== "string" || !oldString) throw new Error("patchSkill requires old_string");
    const text = fs.readFileSync(skill.path, "utf8");
    const count = countOverlappingMatches(text, oldString);
    if (count === 0) throw new Error(`old_string not found in ${name}/SKILL.md`);
    if (count > 1) throw new Error(`old_string matches ${count} places — include surrounding context to make it unique`);
    const replacement = String(newString ?? "");
    const next = text.replace(oldString, replacement);
    assertSkillDocumentSize(next);
    writeTextAtomic(skill.path, next);
    appendSkillRevision(skill.dir, { skill: name, action: "patched", by, before: text, after: next });
    this.logEdit(
      {
        skill: name,
        action: "patched",
        by,
        summary: `-${oldString.slice(0, 60).replace(/\n/g, " ")} -> +${String(newString ?? "").slice(0, 60).replace(/\n/g, " ")}`
      },
      sessionId
    );
    this.reload();
    return { skill: name, patched: true };
  }

  /**
   * Full-field edit: replace body and/or frontmatter fields, preserving
   * lineage keys (sourceSuggestionId, createdBy, createdAt) untouched.
   */
  editSkill(
    name,
    { description, body, category, systemPrompt } = {},
    by = "agent",
    sessionId = null
  ) {
    const skill = this.mustGet(name);
    if (skill.pinned) {
      throw new Error(`Skill '${name}' is pinned; unpin it before editing.`);
    }
    const text = fs.readFileSync(skill.path, "utf8");
    const updates = {};
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category || null;
    if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt || null;
    if (body !== undefined) assertSkillBodySize(String(body ?? ""));
    const next = updateFrontmatter(text, updates, body);
    assertSkillDocumentSize(next);
    writeTextAtomic(skill.path, next);
    appendSkillRevision(skill.dir, { skill: name, action: "edited", by, before: text, after: next });
    const touched = [
      description !== undefined ? "description" : null,
      category !== undefined ? "category" : null,
      systemPrompt !== undefined ? "systemPrompt" : null,
      body !== undefined ? `body (${String(body ?? "").length} chars)` : null
    ].filter(Boolean).join(", ");
    this.logEdit(
      { skill: name, action: "edited", by, summary: touched || "no-op" },
      sessionId
    );
    this.reload();
    return { skill: name, edited: true, fields: touched };
  }

  /**
   * Pin/unpin. Pinned skills refuse deletion and edits until explicitly
   * unpinned.
   */
  setPinned(name, pinned = true, by = "agent", sessionId = null) {
    const skill = this.mustGet(name);
    const text = fs.readFileSync(skill.path, "utf8");
    const next = updateFrontmatter(text, { pinned: pinned ? true : null });
    writeTextAtomic(skill.path, next);
    appendSkillRevision(skill.dir, { skill: name, action: pinned ? "pinned" : "unpinned", by, before: text, after: next });
    this.logEdit(
      { skill: name, action: pinned ? "pinned" : "unpinned", by },
      sessionId
    );
    this.reload();
    return { skill: name, pinned: Boolean(pinned) };
  }

  /**
   * Soft delete: moves the skill dir into .trash/ under the user skills
   * dir (recoverable beats gone forever). Refuses pinned + bundled.
   */
  deleteSkill(name, by = "agent", sessionId = null) {
    const skill = this.mustGet(name);
    if (skill.pinned) throw new Error(`Skill '${name}' is pinned — unpin it first if you really mean to delete it.`);
    if (skill.bundled) throw new Error(`Skill '${name}' is bundled (read-only examples dir) — it cannot be deleted.`);
    const parent = path.dirname(skill.dir);
    const trashDir = path.join(parent, ".trash");
    ensureDir(trashDir);
    const dest = availableTrashPath(trashDir, `${name}-${Date.now()}`);
    appendSkillRevision(skill.dir, {
      skill: name,
      action: "deleted",
      by,
      before: fs.readFileSync(skill.path, "utf8"),
      after: null,
      metadata: { destination: dest }
    });
    fs.renameSync(skill.dir, dest);
    this.logEdit(
      { skill: name, action: "deleted", by, summary: `moved to ${dest}` },
      sessionId
    );
    this.reload();
    return { skill: name, deleted: true, trash: dest };
  }

  restoreSkill(name, by = "agent", now = new Date(), sessionId = null) {
    const skill = this.mustGet(name);
    const restoredAt = validDate(now, "restore time").toISOString();
    const text = fs.readFileSync(skill.path, "utf8");
    const next = updateFrontmatter(text, { state: "active", curatorRestoredAt: restoredAt });
    writeTextAtomic(skill.path, next);
    appendSkillRevision(skill.dir, {
      skill: name,
      action: "restored",
      by,
      before: text,
      after: next
    });
    this.logEdit({ skill: name, action: "restored", by }, sessionId);
    this.reload();
    return { skill: name, state: "active", restoredAt };
  }

  curate(options = {}) {
    const now = validDate(options.now ?? new Date(), "curator time");
    const env = options.env ?? process.env;
    const configured = resolveCuratorThresholds(env);
    const policy = resolveCuratorPolicy(env);
    const staleDays = options.staleDays === undefined
      ? configured.staleDays
      : positiveDays(options.staleDays, null);
    const archiveDays = options.archiveDays === undefined
      ? configured.archiveDays
      : positiveDays(options.archiveDays, null);
    if (staleDays === null || archiveDays === null || archiveDays < staleDays) {
      throw new Error("Curator thresholds must be positive days with archiveDays >= staleDays");
    }

    // Other processes can append telemetry after this registry was created.
    this.reloadUsage();
    const cronReferenced = collectCronReferencedSkills(this.runtime?.cron);
    const rows = [];
    const exemptions = {
      pinned: 0,
      bundled: 0,
      scope: 0,
      cron: 0
    };
    let changed = 0;
    let seeded = 0;
    for (const skill of this.skills.values()) {
      const before = normalizeSkillState(skill.state);
      const usage = this.usage.get(skill.name);
      const activityAt = latestActivityAt(skill, usage);
      const ageDays = activityAt ? Math.max(0, (now.getTime() - activityAt.getTime()) / DAY_MS) : null;
      let after = before;
      let result = "unchanged";

      if (skill.pinned) {
        exemptions.pinned += 1;
        result = "exempt: pinned";
      } else if (cronReferenced.has(skill.name)) {
        exemptions.cron += 1;
        result = "exempt: cron reference";
      } else if (skill.bundled && !policy.pruneBundled) {
        exemptions.bundled += 1;
        result = "exempt: bundled";
      } else if (policy.scope === "agent-created" && !isAgentCreated(skill)) {
        exemptions.scope += 1;
        result = "exempt: scope";
      } else if (!activityAt) {
        if (this.seedActivity(skill.name, now)) seeded += 1;
        result = "seeded: activity baseline";
      } else {
        const neverUsed = (usage?.views ?? 0) + (usage?.runs ?? 0) === 0;
        if (neverUsed && ageDays < staleDays) {
          after = before === "stale" ? "active" : before;
          result = "grace: never used";
        } else {
          after = classifySkillAge({ state: before, ageDays, staleDays, archiveDays });
        }
        if (after !== before) {
          const text = fs.readFileSync(skill.path, "utf8");
          const next = updateFrontmatter(text, { state: after });
          writeTextAtomic(skill.path, next);
          appendSkillRevision(skill.dir, {
            skill: skill.name,
            action: `curator-${after}`,
            by: "skill-curator",
            before: text,
            after: next,
            metadata: {
              ageDays,
              staleDays,
              archiveDays,
              scope: policy.scope,
              pruneBundled: policy.pruneBundled
            }
          });
          this.logEdit(
            { skill: skill.name, action: `curator-${after}`, by: "skill-curator" },
            null
          );
          changed += 1;
          result = "transitioned";
        }
      }

      rows.push({
        name: skill.name,
        before,
        after,
        ageDays: ageDays === null ? null : Math.floor(ageDays),
        result
      });
    }

    if (changed > 0) this.reload();
    writeTextAtomic(this.curatorReportPath, renderCuratorReport({
      now,
      staleDays,
      archiveDays,
      policy,
      rows,
      changed,
      seeded,
      exemptions
    }));
    return {
      at: now.toISOString(),
      staleDays,
      archiveDays,
      scope: policy.scope,
      pruneBundled: policy.pruneBundled,
      changed,
      seeded,
      skippedBundled: exemptions.bundled,
      exemptions,
      rows,
      reportPath: this.curatorReportPath
    };
  }

  // MARK: — model-facing tools

  /**
   * Fixed-cost tool surface (Hermes-style tool economy): instead of one
   * tool per skill (which eats the model's tool budget linearly — the
   * exact reason OPENAGI_MAX_MODEL_TOOLS exists), the model gets a
   * constant set: list/use/run + curation. Legacy per-skill skill_*
   * tools come back with OPENAGI_SKILLS_AS_TOOLS=1.
   */
  exposeAsTools(toolRegistry) {
    for (const name of [...toolRegistry.tools.keys()]) {
      if (name.startsWith("skill_")) toolRegistry.unregister(name);
    }
    if (process.env.OPENAGI_SKILLS_AS_TOOLS === "1") {
      for (const skill of this.skills.values()) {
        if (skill.state === "archived") continue;
        const toolName = `skill_${skill.name.replaceAll("-", "_")}`;
        toolRegistry.register({
          name: toolName,
          description: `Skill: ${skill.description ?? skill.name}`,
          source: "skill",
          parameters: skill.parameters ?? {
            type: "object",
            properties: {
              input: { type: "string", description: "Free-text input for the skill." },
              args: { type: "object", description: "Optional structured arguments.", additionalProperties: true }
            },
            additionalProperties: false
          },
          handler: (args, context) => this.run(skill.name, { input: args.input, args: args.args ?? {} }, context),
          metadata: { skill: skill.name }
        });
      }
    }

    toolRegistry.register({
      name: "list_skills",
      sideEffects: false,
      source: "skill",
      description: "List all available skills with name, description, category, and usage stats. Cheap — call this to discover what procedural knowledge exists before improvising.",
      parameters: {
        type: "object",
        properties: {
          include_archived: { type: "boolean", description: "Include archived skills so one can be restored." },
          include_inactive: { type: "boolean", description: "Include skills gated off this session by requires_tools / fallback_for_tools, with the reason they are hidden." }
        },
        additionalProperties: false
      },
      handler: (args = {}, context) => {
        const availableTools = availableSkillToolNames(this.runtime?.tools);
        return this.list()
          .filter((skill) => args.include_archived === true || skill.state !== "archived")
          .filter((skill) => projectAllowsSkill(context, skill.name))
          .map((skill) => ({ skill, activation: this.activationFor(skill, availableTools) }))
          .filter(({ activation }) => args.include_inactive === true || activation.active)
          .map(({ skill, activation }) => ({
            name: skill.name,
            description: skill.description,
            category: skill.category,
            pinned: skill.pinned,
            state: skill.state,
            bundle: skill.bundle ?? null,
            active: activation.active,
            inactiveReason: activation.reason,
            runs: skill.stats.runs,
            views: skill.stats.views,
            avgScore: skill.stats.avgScore,
            lastUsedAt: skill.stats.lastUsedAt
          }));
      }
    });

    toolRegistry.register({
      name: "use_skill",
      sideEffects: false,
      source: "skill",
      description: "Load a skill's full instructions (and optionally one of its linked files) into YOUR context, then follow the steps yourself with full conversation awareness. PREFER this over run_skill for multi-step procedures — you keep the user's context; run_skill starts blank.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from list_skills." },
          file: { type: "string", description: "Optional linked file path within the skill (e.g. 'references/api.md')." }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertProjectSkill(context, args.name);
        const skill = this.mustGet(args.name);
        if (skill.state === "archived") {
          throw new Error(`Skill '${args.name}' is archived; call restore_skill before using it.`);
        }
        // Bundle alias: one call loads every member skill in declared order.
        // A linked-file request is member-specific, so it stays single-skill.
        if (this.isBundle(args.name) && !args.file) {
          const expansion = this.expandBundle(args.name);
          const members = [];
          for (const member of expansion.members) {
            assertProjectSkill(context, member);
            const loaded = this.skills.get(member);
            if (!loaded || loaded.state === "archived") continue;
            members.push(this.view(member, null, context?.sessionId ?? null));
          }
          this.recordUse(args.name, "view", "ok", nowIso(), context?.sessionId ?? null);
          return {
            bundle: args.name,
            description: skill.description,
            memberCount: members.length,
            missing: expansion.missing,
            cycles: expansion.cycles,
            skills: members
          };
        }
        return this.view(
          args.name,
          args.file ?? null,
          context?.sessionId ?? null
        );
      }
    });

    toolRegistry.register({
      name: "run_skill",
      source: "skill",
      description: "Execute a skill as an isolated sub-generation (fresh context, tools available). Use for fire-and-forget skill runs where conversation context does not matter; otherwise prefer use_skill.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from list_skills." },
          input: { type: "string", description: "Free-text input for the skill." },
          args: { type: "object", description: "Optional structured arguments.", additionalProperties: true }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertProjectSkill(context, args.name);
        return this.run(
          args.name,
          { input: args.input ?? "", args: args.args ?? {} },
          context
        );
      }
    });

    toolRegistry.register({
      name: "create_skill",
      source: "skill",
      description: "Save a new reusable skill (SKILL.md) after completing a non-trivial task, fixing a tricky error, or when the user asks you to remember a procedure. Body should have numbered steps, exact commands, and pitfalls.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case name." },
          description: { type: "string", description: "One-line description: what it does and when to use it." },
          body: { type: "string", description: "Full markdown body: trigger conditions, numbered steps, pitfalls, verification." },
          category: { type: "string", description: "Optional grouping, e.g. 'devops', 'research'." }
        },
        required: ["name", "description", "body"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill creation"
      ),
      handler: (args, context) => {
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill creation");
        return this.createSkill(
          { ...args, createdBy: context?.agentId ?? "agent" },
          context?.sessionId ?? null
        );
      }
    });

    toolRegistry.register({
      name: "inspect_skill_capabilities",
      sideEffects: false,
      source: "skill",
      description: "Check a skill's declared tool contract against the current project boundary and registered tools before running it. Reports usable, denied, and missing tool names without executing the skill.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from list_skills." }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertProjectSkill(context, args.name);
        return this.capabilityReport(args.name, context);
      }
    });

    toolRegistry.register({
      name: "list_skill_revisions",
      sideEffects: false,
      source: "skill",
      description: "Inspect compact, hash-only revision history for one active skill. Use this before rollback_skill; only the current head can be rolled back.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from list_skills." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum newest-first revisions (default 20)." }
        },
        required: ["name"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertProjectSkill(context, args.name);
        return this.revisionHistory(args.name, args.limit ?? 20);
      }
    });

    toolRegistry.register({
      name: "rollback_skill",
      source: "skill",
      needsConfirmation: true,
      description: "Restore the immediately preceding document for the current skill revision. Requires a revision id from list_skill_revisions and human confirmation; stale or edited heads fail closed.",
      summarize: ({ name, revisionId }) => `Roll back skill '${String(name ?? "")}' revision '${String(revisionId ?? "")}'.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from list_skill_revisions." },
          revisionId: { type: "string", description: "Current head revision id returned by list_skill_revisions." }
        },
        required: ["name", "revisionId"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill rollback"
      ),
      handler: (args, context) => {
        assertProjectSkill(context, args.name);
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill rollback");
        return this.rollbackSkillRevision(
          args.name,
          args.revisionId,
          context?.agentId ?? "agent",
          context?.sessionId ?? null
        );
      }
    });

    toolRegistry.register({
      name: "edit_skill",
      source: "skill",
      description: "Improve an unpinned skill. Preferred: targeted patch via old_string/new_string (old_string must match exactly once). Or pass description/body/category to replace those fields. Patch skills IMMEDIATELY when you find them stale or wrong.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          old_string: { type: "string", description: "Exact unique text to replace (patch mode)." },
          new_string: { type: "string", description: "Replacement text (patch mode). Empty string deletes the match." },
          description: { type: "string", description: "New description (edit mode)." },
          body: { type: "string", description: "Full replacement body (edit mode)." },
          category: { type: "string", description: "New category (edit mode)." }
        },
        required: ["name"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill editing"
      ),
      handler: (args, context) => {
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill editing");
        const by = context?.agentId ?? "agent";
        const sessionId = context?.sessionId ?? null;
        if (args.old_string !== undefined) {
          return this.patchSkill(
            args.name,
            args.old_string,
            args.new_string ?? "",
            by,
            sessionId
          );
        }
        return this.editSkill(args.name, args, by, sessionId);
      }
    });

    toolRegistry.register({
      name: "delete_skill",
      source: "skill",
      needsConfirmation: true,
      description: "Soft-delete a skill (moves it to .trash, recoverable). Refuses pinned or bundled skills. Requires user approval.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill deletion"
      ),
      handler: (args, context) => {
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill deletion");
        return this.deleteSkill(
          args.name,
          context?.agentId ?? "agent",
          context?.sessionId ?? null
        );
      }
    });

    toolRegistry.register({
      name: "pin_skill",
      source: "skill",
      description: "Pin a skill to protect it from deletion (or unpin it). Pinned skills can still be edited/patched.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          pinned: { type: "boolean", description: "true to pin (default), false to unpin." }
        },
        required: ["name"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill pinning"
      ),
      handler: (args, context) => {
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill pinning");
        return this.setPinned(
          args.name,
          args.pinned !== false,
          context?.agentId ?? "agent",
          context?.sessionId ?? null
        );
      }
    });

    toolRegistry.register({
      name: "restore_skill",
      source: "skill",
      description: "Restore a stale or archived skill to active use without losing its files or history.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name to restore." } },
        required: ["name"],
        additionalProperties: false
      },
      preflight: (_args, context) => assertDefaultProjectSkillControl(
        this.runtime?.projects,
        context,
        "Skill restoration"
      ),
      handler: (args, context) => {
        assertDefaultProjectSkillControl(this.runtime?.projects, context, "Skill restoration");
        return this.restoreSkill(
          args.name,
          context?.agentId ?? "agent",
          new Date(),
          context?.sessionId ?? null
        );
      }
    });
  }

  async run(name, { input = "", args = {} } = {}, context = {}) {
    assertProjectSkill(context, name);
    const sessionId = context?.sessionId ?? null;
    const skill = this.mustGet(name);
    if (skill.state === "archived") {
      throw new Error(`Skill '${name}' is archived; call restore_skill before using it.`);
    }
    const rendered = renderTemplate(skill.body, { input, args });
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider) {
      this.recordUse(name, "run", "error", nowIso(), sessionId);
      throw new Error("No model provider available for skill execution.");
    }
    const agentName = `skill:${skill.name}`;
    const instructions = skill.systemPrompt ||
      `You are executing the "${skill.name}" skill. ${skill.description}\nReturn only the user-visible output. Use tools when helpful.`;
    const toolScope = resolveSkillToolScope(skill, context, this.runtime?.tools);
    if (toolScope.unboundedInheritedBoundary || (!toolScope.hasDeclaration && toolScope.inheritedBoundary === "none")) {
      try {
        this.warn(`[openagi] skill '${skill.name}' has no allowed_tools frontmatter or inherited tool boundary; it will run without tools. Prefer use_skill or declare the minimum tools.`);
      } catch { /* visibility must not break execution */ }
    }
    if (toolScope.missingToolDefinitions.length > 0) {
      try {
        this.warn(`[openagi] skill '${skill.name}' declares unavailable tools; only its available bounded tools will be advertised.`);
      } catch { /* visibility must not break execution */ }
    }
    const advertisedTools = this.runtime.tools?.toOpenAITools?.({ only: toolScope.advertisedTools }) ?? [];
    // Story 2: record outcome lineage for the skill run. If the skill
    // was materialized from a proactive-suggestion, the outcome carries
    // that suggestion id forward so /proactive/suggestions/:id/outcome
    // can later report "this proposal led to N runs at X% quality".
    let outcome = null;
    if (this.runtime?.outcomes?.record) {
      outcome = this.runtime.outcomes.record({
        kind: "skill-run",
        refId: skill.name,
        sessionId: context?.sessionId ?? null,
        agentId: agentName,
        channel: context?.channel ?? null,
        metadata: {
          skill: skill.name,
          sourceSuggestionId: skill.sourceSuggestionId ?? null,
          input: input.slice(0, 200)
        }
      });
    }
    try {
      const nestedContext = { ...(context ?? {}) };
      delete nestedContext.__confirmed;
      delete nestedContext.__approval;
      const result = await provider.generate({
        input: rendered,
        agent: { id: agentName, name: agentName, systemPrompt: skill.systemPrompt ?? "" },
        memoryHits: [],
        messages: [],
        tools: advertisedTools,
        toolRegistry: this.runtime.tools,
        instructions,
        context: {
          ...nestedContext,
          skill: skill.name,
          __advertisedTools: toolScope.advertisedTools,
          __allowedTools: toolScope.advertisedTools
        }
      });
      // Tool-using skill completions are graded by their per-call results.
      // Text-only completions keep the historical 0.7.
      if (outcome) {
        const calls = (result.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false }));
        const completionScore = calls.length > 0 ? scoreFromToolCalls(calls) : 0.7;
        this.runtime.outcomes.resolve(outcome.id, completionScore, "skill-completed");
      }
      this.recordUse(name, "run", "ok", nowIso(), sessionId);
      return {
        skill: skill.name,
        output: result.text,
        toolCalls: result.toolCalls ?? [],
        toolScope: publicSkillToolScope(toolScope)
      };
    } catch (error) {
      this.recordUse(name, "run", "error", nowIso(), sessionId);
      if (outcome) this.runtime.outcomes.resolve(outcome.id, 0.1, "skill-failed", error.message);
      throw error;
    }
  }
}

function isValidSkillSlug(name) {
  return typeof name === "string" &&
    name.length <= MAX_SKILL_SLUG_LENGTH &&
    SKILL_SLUG_RE.test(name);
}

function assertSkillSlug(name) {
  if (!isValidSkillSlug(name)) {
    throw new Error("Invalid skill name: expected a lowercase kebab-case slug using only a-z, 0-9, and hyphens");
  }
  return name;
}

function slugForCreate(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("createSkill requires a name/title");
  const title = name.trim();
  if (
    title === "." ||
    title === ".." ||
    title.includes("\0") ||
    title.includes("/") ||
    title.includes("\\") ||
    PATH_LIKE_UNICODE_RE.test(title) ||
    path.posix.isAbsolute(title) ||
    path.win32.isAbsolute(title)
  ) {
    throw new Error("Invalid skill name: path syntax is not allowed");
  }
  const slug = slugify(title).replace(/-+$/g, "");
  return assertSkillSlug(slug);
}

function assertSkillBodySize(body) {
  const bytes = Buffer.byteLength(String(body ?? ""), "utf8");
  if (bytes > MAX_SKILL_BODY_BYTES) {
    throw new Error(`Skill body is too large: ${bytes} bytes exceeds ${MAX_SKILL_BODY_BYTES}`);
  }
}

function assertSkillDocumentSize(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SKILL_FILE_BYTES) {
    throw new Error(`SKILL.md is too large: ${bytes} bytes exceeds ${MAX_SKILL_FILE_BYTES}`);
  }
  const match = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/.exec(text);
  if (match) assertSkillBodySize(match[1].trim());
}

function countOverlappingMatches(text, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const match = text.indexOf(needle, offset);
    if (match < 0) break;
    count += 1;
    offset = match + 1;
  }
  return count;
}

function availableTrashPath(trashDir, stem) {
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const name = suffix === 1 ? stem : `${stem}-${suffix}`;
    const candidate = path.join(trashDir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique trash destination for ${stem}`);
}

function readUtf8FileCapped(filePath, maxBytes, label) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > maxBytes) {
      throw new Error(`${label} is too large: ${stat.size} bytes exceeds ${maxBytes}`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > maxBytes) throw new Error(`${label} is too large: exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseSkill(filePath, dir) {
  const text = readUtf8FileCapped(filePath, MAX_SKILL_FILE_BYTES, "SKILL.md");
  const parsed = parseSkillDocument(text);
  return {
    ...parsed,
    linkedFiles: scanLinkedFiles(dir),
    dir,
    path: filePath
  };
}

function parseSkillDocument(text) {
  // Accept the historical one-newline form for existing hand-authored
  // skills, while every writer in this repo emits the canonical blank line.
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md must contain a complete frontmatter block");
  const meta = parseFrontmatter(match[1]);
  const body = match[2].trim();
  if (!isValidSkillSlug(meta.name)) throw new Error("frontmatter name must be a valid lowercase kebab-case skill slug");
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES) {
    throw new Error(`skill body exceeds ${MAX_SKILL_BODY_BYTES} bytes`);
  }
  return {
    name: meta.name,
    description: meta.description ?? "",
    systemPrompt: meta.systemPrompt ?? meta["system-prompt"] ?? "",
    parameters: meta.parameters ?? null,
    category: meta.category ?? null,
    pinned: meta.pinned === true || meta.pinned === "true",
    state: normalizeSkillState(meta.state),
    curatorRestoredAt: meta.curatorRestoredAt ?? null,
    allowedTools: normalizeAllowedTools(meta.allowed_tools),
    // Conditional activation (Hermes parity). `requires_tools` hides a skill
    // when its hard dependencies are absent from the session;
    // `fallback_for_tools` hides a skill while its PRIMARY tools are present,
    // surfacing it only when they are missing. Both default to null = always on.
    requiresTools: normalizeDeclaredToolList(meta.requires_tools, "requires_tools"),
    fallbackForTools: normalizeDeclaredToolList(
      meta.fallback_for_tools ?? meta.fallback_for_toolsets,
      "fallback_for_tools"
    ),
    // Skill bundles: one alias loads several skills. Expanded at view time
    // with cycle + depth guards (see expandBundle).
    bundle: normalizeBundleList(meta.bundle),
    // Generic frontmatter pass-through: any key we do not model explicitly is
    // preserved here instead of being dropped into the void, so new metadata
    // consumers do not need parser surgery.
    meta: collectExtraFrontmatter(meta),
    // Story 2: lineage back to the proactive-suggestion that birthed
    // this skill (set by skill-materialize.js when the user accepts
    // a category=skill proposal). null for hand-authored skills.
    sourceSuggestionId: meta.sourceSuggestionId ?? null,
    sourceImportId: meta.sourceImportId ?? null,
    sourceImportHash: meta.sourceImportHash ?? null,
    sourceImportKind: meta.sourceImportKind ?? null,
    ownerProjectId: meta.ownerProjectId ?? null,
    createdBy: meta.createdBy ?? null,
    createdAt: meta.createdAt ?? null,
    body
  };
}

function assertRollbackDocument(name, document) {
  if (typeof document !== "string") throw new Error("Rollback revision does not contain a skill document.");
  assertSkillDocumentSize(document);
  const parsed = parseSkillDocument(document);
  if (parsed.name !== name) {
    throw new Error(`Rollback revision belongs to '${parsed.name}', not '${name}'.`);
  }
}

// Hermes-style linked files: references/, templates/, scripts/, assets/
// subdirs hold supporting material the model can pull in on demand via
// use_skill(name, file). Returns relative paths like "references/api.md".
function scanLinkedFiles(dir) {
  const out = [];
  for (const sub of LINKED_DIRS) {
    const subDir = path.join(dir, sub);
    if (!safeIsDir(subDir)) continue;
    for (const f of walkFiles(subDir, 2)) {
      out.push(path.relative(dir, f));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function walkFiles(dir, depth) {
  if (depth < 0) return [];
  const out = [];
  for (const entry of safeReadDir(dir)) {
    const full = path.join(dir, entry);
    const stat = safeLstat(full);
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...walkFiles(full, depth - 1));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

// Resolve a linked-file request, refusing path escapes ("../../etc").
function resolveLinkedFile(skillDir, file) {
  if (typeof file !== "string" || !file || file.length > 1024 || file.includes("\0") || PATH_LIKE_UNICODE_RE.test(file)) {
    throw new Error("invalid linked file path");
  }
  if (path.isAbsolute(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
    throw new Error("absolute linked file paths are not allowed");
  }
  const root = path.resolve(skillDir);
  const resolved = path.resolve(root, file);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("linked file path escapes the skill directory");
  }
  const top = rel.split(path.sep)[0];
  if (!LINKED_DIRS.includes(top)) {
    throw new Error(`linked files must live under ${LINKED_DIRS.join("/, ")}/`);
  }

  let cursor = root;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      throw new Error(`no such linked file: ${file}`);
    }
    if (stat.isSymbolicLink()) throw new Error("linked file path contains a symbolic link");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error(`linked file is not a regular file: ${file}`);
  const realRoot = fs.realpathSync.native(root);
  const realResolved = fs.realpathSync.native(resolved);
  const realRel = path.relative(realRoot, realResolved);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
    throw new Error("linked file path escapes the skill directory");
  }
  return resolved;
}

/**
 * Rewrite frontmatter keys in-place (null value removes the key) and
 * optionally replace the body. Lineage keys the caller doesn't touch are
 * preserved verbatim.
 */
export function updateFrontmatter(text, updates = {}, newBody = undefined) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  let lines = match[1].split(/\r?\n/);
  for (const [key, value] of Object.entries(updates)) {
    const prefix = key + ":";
    if (value === null || value === undefined) {
      lines = lines.filter((l) => !l.trim().startsWith(prefix));
      continue;
    }
    const rendered = `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(prefix));
    if (idx >= 0) lines[idx] = rendered;
    else lines.push(rendered);
  }
  const body = newBody !== undefined ? String(newBody).trim() : match[2].trim();
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

function parseFrontmatter(text) {
  const out = {};
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) throw new Error(`invalid frontmatter line ${lineIndex + 1}: expected key: value`);
    const key = line.slice(0, idx).trim();
    if (Object.hasOwn(out, key)) throw new Error(`duplicate frontmatter key: ${key}`);
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length === 1) {
        throw new Error(`unterminated JSON string for frontmatter key ${key}`);
      }
      try {
        value = JSON.parse(value);
      } catch (error) {
        throw new Error(`invalid JSON string for frontmatter key ${key}: ${error.message}`);
      }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length === 1) {
        throw new Error(`unterminated quoted string for frontmatter key ${key}`);
      }
      value = value.slice(1, -1);
    } else if (value.startsWith("{") || value.startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch (error) {
        throw new Error(`invalid JSON value for frontmatter key ${key}: ${error.message}`);
      }
    }
    out[key] = value;
  }
  return out;
}

// Explicitly modelled frontmatter keys. Everything else is preserved on
// `skill.meta` by collectExtraFrontmatter so future features are metadata
// consumers rather than parser surgery.
const KNOWN_FRONTMATTER_KEYS = new Set([
  "name", "description", "systemPrompt", "system-prompt", "parameters",
  "category", "pinned", "state", "curatorRestoredAt", "allowed_tools",
  "requires_tools", "fallback_for_tools", "fallback_for_toolsets", "bundle",
  "sourceSuggestionId", "sourceImportId", "sourceImportHash", "sourceImportKind",
  "ownerProjectId", "createdBy", "createdAt"
]);

const MAX_EXTRA_FRONTMATTER_KEYS = 40;

function collectExtraFrontmatter(meta) {
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    if (++count > MAX_EXTRA_FRONTMATTER_KEYS) {
      throw new Error(`too many custom frontmatter keys: limit is ${MAX_EXTRA_FRONTMATTER_KEYS}`);
    }
    out[key] = value;
  }
  return out;
}

// Shared shape validator for requires_tools / fallback_for_tools. Accepts a
// JSON array or a single string; returns null when unset so "no declaration"
// stays distinguishable from "declared empty".
function normalizeDeclaredToolList(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length > 32) throw new Error(`${label} accepts at most 32 tool names`);
  const names = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 128) {
      throw new Error(`${label} entries must be non-empty tool-name strings up to 128 characters`);
    }
    const name = entry.trim();
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names : null;
}

function normalizeBundleList(value) {
  const names = normalizeDeclaredToolList(value, "bundle");
  if (!names) return null;
  for (const name of names) {
    if (!isValidSkillSlug(name)) {
      throw new Error(`bundle entries must be lowercase kebab-case skill slugs: got '${name}'`);
    }
  }
  return names;
}

function normalizeAllowedTools(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value)) throw new Error("allowed_tools must be a JSON array of tool names");
  const names = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 128 || raw.includes("\0")) {
      throw new Error("allowed_tools entries must be non-empty tool-name strings up to 128 characters");
    }
    names.push(raw.trim());
  }
  return [...new Set(names)];
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr) => {
    const path = expr.split(".");
    let cursor = vars;
    for (const segment of path) {
      if (cursor == null) return "";
      cursor = cursor[segment];
    }
    if (cursor == null) return "";
    return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
  });
}

function resolveSkillToolScope(skill, context, toolRegistry) {
  const declaredTools = Array.isArray(skill?.allowedTools)
    ? normalizeToolNameList(skill.allowedTools)
    : [];
  const hasDeclaration = Array.isArray(skill?.allowedTools);
  const rawInherited = Array.isArray(context?.__allowedTools)
    ? normalizeToolNameList(context.__allowedTools, { keepWildcard: true })
    : null;
  const inheritedBoundary = rawInherited === null
    ? "none"
    : rawInherited.includes("*")
      ? "unbounded"
      : "finite";
  const inheritedTools = inheritedBoundary === "finite" ? rawInherited : null;
  const boundedTools = hasDeclaration
    ? (inheritedTools
      ? declaredTools.filter((name) => inheritedTools.includes(name))
      : declaredTools)
    : inheritedTools ?? [];
  const knownTools = availableSkillToolNames(toolRegistry);
  const advertisedTools = knownTools === null
    ? boundedTools
    : boundedTools.filter((name) => knownTools.has(name));
  return {
    hasDeclaration,
    declaredTools,
    inheritedBoundary,
    unboundedInheritedBoundary: !hasDeclaration && inheritedBoundary === "unbounded",
    advertisedTools,
    missingToolDefinitions: knownTools === null
      ? []
      : declaredTools.filter((name) => !knownTools.has(name)),
    deniedByBoundary: hasDeclaration && inheritedTools
      ? declaredTools.filter((name) => !inheritedTools.includes(name))
      : []
  };
}

function publicSkillToolScope(scope) {
  return {
    declaredTools: [...scope.declaredTools],
    effectiveTools: [...scope.advertisedTools],
    missingToolDefinitions: [...scope.missingToolDefinitions],
    deniedByBoundary: [...scope.deniedByBoundary],
    inheritedBoundary: scope.inheritedBoundary,
    willRunWithoutTools: scope.advertisedTools.length === 0
  };
}

function normalizeToolNameList(value, { keepWildcard = false } = {}) {
  const values = Array.isArray(value) ? value : [];
  const names = values
    .filter((raw) => typeof raw === "string")
    .map((raw) => raw.trim())
    .filter((name) => name && (keepWildcard || name !== "*"));
  return [...new Set(names)].sort();
}

function availableSkillToolNames(toolRegistry) {
  if (!(toolRegistry?.tools instanceof Map)) return null;
  return new Set(toolRegistry.tools.keys());
}

function loadUsage(filePath) {
  const map = new Map();
  for (const e of readJsonl(filePath)) {
    if (
      !isValidSkillSlug(e.skill)
      || (e.mode !== "view" && e.mode !== "run" && e.mode !== "seed")
    ) {
      continue;
    }
    const entry = map.get(e.skill) ?? emptyUsage();
    if (e.mode === "view") entry.views += 1;
    else if (e.mode === "run") entry.runs += 1;
    const outcome = e.outcome === "error" ? "error" : "ok";
    if (typeof e.at === "string") {
      entry.events.push({ mode: e.mode, outcome, at: e.at });
      if (!entry.lastUsedAt || e.at > entry.lastUsedAt) entry.lastUsedAt = e.at;
    }
    map.set(e.skill, entry);
  }
  return map;
}

function emptyUsage() {
  return { views: 0, runs: 0, lastUsedAt: null, events: [] };
}

function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function projectAllowsSkill(context, skillName) {
  const grants = context?.__projectActiveSkills;
  if (!Array.isArray(grants)) return true;
  const name = String(skillName ?? "").trim();
  return Boolean(name && (grants.includes("*") || grants.includes(name)));
}

function assertProjectSkill(context, skillName) {
  if (projectAllowsSkill(context, skillName)) return;
  const error = new Error(
    `Skill '${String(skillName ?? "")}' is not active in project '${context?.__projectId ?? "default"}'.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertDefaultProjectSkillControl(projects, context, operation) {
  // Preserve the pre-ProjectStore embedding contract. Once the store exists,
  // only the registry-authenticated private identity may authorize a global
  // skill-definition mutation; a public projectId is not a control-plane
  // credential and deferred/aliased calls must be rechecked.
  if (!projects || typeof projects.get !== "function") return true;
  const projectId = String(context?.__projectId ?? "").trim();
  if (projectId === "default") return true;
  const error = new Error(
    projectId
      ? `${operation} is restricted to the default project control plane.`
      : `${operation} requires an authenticated project control context.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function safeIsDir(p) {
  try {
    const stat = fs.lstatSync(p);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function safeLstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function enabledSetting(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "on", "yes"].includes(String(value).trim().toLowerCase());
}

function positiveDays(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}`);
  return date;
}

function normalizeSkillState(value) {
  const state = String(value ?? "active").toLowerCase();
  return SKILL_STATES.has(state) ? state : "active";
}

function latestActivityAt(skill, usage) {
  const candidates = [usage?.lastUsedAt, skill.curatorRestoredAt, skill.createdAt]
    .map((value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((date) => date.getTime())));
}

function isAgentCreated(skill) {
  if (typeof skill.createdBy !== "string" || !skill.createdBy.trim()) return false;
  return !["user", "human", "dashboard"].includes(skill.createdBy.trim().toLowerCase());
}

export function collectCronReferencedSkills(cron) {
  const referenced = new Set();
  let jobs = [];
  try {
    jobs = cron?.listJobs?.() ?? [];
  } catch {
    return referenced;
  }
  let visited = 0;
  const seen = new Set();
  const visit = (value, key = "", depth = 0) => {
    if (depth > 12 || visited >= 10_000 || value === null || value === undefined) return;
    visited += 1;
    if (typeof value === "string") {
      if (
        (key === "skill" || key === "skillname" || key === "skill_name")
        && isValidSkillSlug(value)
      ) {
        referenced.add(value);
      }
      collectPromptSkillReferences(value, referenced);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey.toLowerCase(), depth + 1);
    }
  };
  for (const job of jobs) {
    try {
      collectPromptSkillReferences(JSON.stringify(job), referenced);
    } catch {
      // The bounded field walker below still handles non-serializable jobs.
    }
    visit(job);
  }
  return referenced;
}

function collectPromptSkillReferences(text, referenced) {
  const patterns = [
    /\b(?:use_skill|run_skill)\s*\(\s*(?:\{\s*)?(?:name\s*[:=]\s*)?["'`]?([a-z0-9]+(?:-[a-z0-9]+)*)/giu,
    /\b(?:use_skill|run_skill)\s+(?:name\s*[:=]\s*)?["'`]?([a-z0-9]+(?:-[a-z0-9]+)*)/giu,
    /\b(?:use_skill|run_skill)\b[\s\S]{0,160}?\bname\b\s*["']?\s*[:=]\s*["'`]?([a-z0-9]+(?:-[a-z0-9]+)*)/giu
  ];
  for (const pattern of patterns) {
    for (const match of String(text).matchAll(pattern)) {
      if (isValidSkillSlug(match[1])) referenced.add(match[1]);
    }
  }
}

function renderCuratorReport({
  now,
  staleDays,
  archiveDays,
  policy,
  rows,
  changed,
  seeded,
  exemptions
}) {
  return [
    "# Skill curator report",
    "",
    `Generated: ${now.toISOString()}`,
    `Thresholds: stale after ${staleDays} days; archived after ${archiveDays} days.`,
    `Policy: scope=${policy.scope}; prune bundled=${policy.pruneBundled}.`,
    `Skills checked: ${rows.length}; transitions: ${changed}.`,
    `Seeded activity baselines: ${seeded}.`,
    `Skipped bundled: ${exemptions.bundled}.`,
    `Exemptions: pinned=${exemptions.pinned}; bundled=${exemptions.bundled}; scope=${exemptions.scope}; cron=${exemptions.cron}.`,
    "",
    "| Skill | Before | After | Age (days) | Result |",
    "| --- | --- | --- | ---: | --- |",
    ...rows.map((row) => `| ${row.name} | ${row.before} | ${row.after} | ${row.ageDays ?? "n/a"} | ${row.result} |`),
    ""
  ].join("\n");
}

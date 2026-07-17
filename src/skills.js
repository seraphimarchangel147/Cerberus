import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendJsonLine, writeTextAtomic } from "./file-utils.js";
import { scoreFromToolCalls } from "./outcome-store.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { pickUserSkillsDir, slugify, dedupeSlug } from "./skill-materialize.js";

// Subdirectories inside a skill dir that count as "linked files" — the
// Hermes convention: a skill can carry deep reference docs, runnable
// helper scripts, and fill-in templates alongside its SKILL.md, so one
// skill can hold a 500-line playbook without bloating the body.
const LINKED_DIRS = ["references", "templates", "scripts", "assets"];

export class SkillRegistry {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dirs = options.dirs ?? [];
    this.skills = new Map();
    this.dataDir = options.dataDir ?? resolveDataDir();
    // Durable telemetry (Hermes-style): every view/run bumps a usage
    // counter, every mutation lands in an append-only edit log. This is
    // what lets the dashboard answer "which skills does he actually use,
    // and when did he last improve them?"
    this.editLogPath = path.join(this.dataDir, "skill-edits.jsonl");
    this.usageLogPath = path.join(this.dataDir, "skill-usage.jsonl");
    this.usage = loadUsage(this.usageLogPath);
    if (options.autoLoad !== false) this.reload();
  }

  reload() {
    this.skills.clear();
    for (const dir of this.dirs) this.loadFrom(dir);
    if (this.runtime?.tools) this.exposeAsTools(this.runtime.tools);
    return this.list();
  }

  loadFrom(dir) {
    try {
      ensureDir(dir);
    } catch {
      return;
    }
    for (const entry of safeReadDir(dir)) {
      if (entry.startsWith(".")) continue; // skip .trash etc.
      const skillDir = path.join(dir, entry);
      if (!safeIsDir(skillDir)) continue;
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const skill = parseSkill(skillPath, skillDir);
      if (skill) {
        skill.bundled = dir === this.dirs[0] && this.dirs.length > 1;
        this.skills.set(skill.name, skill);
      }
    }
  }

  list() {
    return [...this.skills.values()].map(({ body, dir, ...rest }) => ({
      ...rest,
      stats: this.statsFor(rest.name)
    }));
  }

  has(name) {
    return this.skills.has(name);
  }

  mustGet(name) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }

  // MARK: — telemetry

  recordUse(name, mode) {
    const entry = this.usage.get(name) ?? { views: 0, runs: 0, lastUsedAt: null };
    if (mode === "view") entry.views += 1;
    else entry.runs += 1;
    entry.lastUsedAt = nowIso();
    this.usage.set(name, entry);
    try {
      appendJsonLine(this.usageLogPath, { skill: name, mode, at: entry.lastUsedAt });
    } catch { /* telemetry must never break the skill itself */ }
  }

  logEdit(entry) {
    try {
      appendJsonLine(this.editLogPath, { at: nowIso(), ...entry });
    } catch { /* ignore */ }
  }

  /**
   * Per-skill aggregate: usage counters + graded outcome scores. The
   * outcome store already records every skill-run with a qualityScore;
   * this rolls them up so /skills can show "12 runs · avg 0.74".
   */
  statsFor(name) {
    const use = this.usage.get(name) ?? { views: 0, runs: 0, lastUsedAt: null };
    const outcomes = (this.runtime?.outcomes?.byRef?.(name) ?? [])
      .filter((o) => o.kind === "skill-run" && o.resolved && typeof o.qualityScore === "number")
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
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
    const edits = readJsonl(this.editLogPath)
      .filter((e) => !name || e.skill === name)
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .slice(0, limit);
    return { edits };
  }

  // MARK: — in-context loading (Hermes-style "view")

  /**
   * Load a skill for IN-CONTEXT use: full body + linked-file manifest.
   * Unlike run(), nothing is executed — the caller (model or dashboard)
   * reads the instructions and acts with its own conversation context.
   * Pass `file` to read one linked file's content instead.
   */
  view(name, file = null) {
    const skill = this.mustGet(name);
    if (file) {
      const resolved = resolveLinkedFile(skill.dir, file);
      return { skill: name, file, content: fs.readFileSync(resolved, "utf8") };
    }
    this.recordUse(name, "view");
    return {
      name: skill.name,
      description: skill.description,
      category: skill.category,
      pinned: skill.pinned,
      bundled: skill.bundled ?? false,
      createdBy: skill.createdBy,
      createdAt: skill.createdAt,
      sourceSuggestionId: skill.sourceSuggestionId,
      body: skill.body,
      linkedFiles: skill.linkedFiles ?? [],
      path: skill.path,
      stats: this.statsFor(name)
    };
  }

  // MARK: — curation (create / patch / edit / pin / delete)

  createSkill({ name, description = "", body = "", category = null, createdBy = "agent" } = {}) {
    if (!name) throw new Error("createSkill requires a name/title");
    if (!body.trim()) throw new Error("createSkill requires a non-empty body");
    const userDir = pickUserSkillsDir(this.runtime) ?? this.dirs[this.dirs.length - 1];
    if (!userDir) throw new Error("no writable skills directory configured");
    ensureDir(userDir);
    const slug = dedupeSlug(userDir, slugify(name));
    const skillDir = path.join(userDir, slug);
    ensureDir(skillDir);
    const fmLines = [
      "---",
      `name: ${slug}`,
      `description: ${JSON.stringify(String(description).slice(0, 1024))}`,
      category ? `category: ${category}` : null,
      `createdBy: ${createdBy}`,
      `createdAt: ${nowIso()}`,
      "---"
    ].filter(Boolean);
    writeTextAtomic(path.join(skillDir, "SKILL.md"), fmLines.join("\n") + "\n\n" + body.trim() + "\n");
    this.logEdit({ skill: slug, action: "created", by: createdBy, summary: String(description).slice(0, 120) });
    this.reload();
    return { slug, path: path.join(skillDir, "SKILL.md") };
  }

  /**
   * Targeted find-and-replace on a skill's SKILL.md — the Hermes patch
   * primitive. Requires a UNIQUE match so a sloppy old_string can't
   * silently rewrite the wrong section.
   */
  patchSkill(name, oldString, newString, by = "agent") {
    const skill = this.mustGet(name);
    if (!oldString) throw new Error("patchSkill requires old_string");
    const text = fs.readFileSync(skill.path, "utf8");
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${name}/SKILL.md`);
    if (count > 1) throw new Error(`old_string matches ${count} places — include surrounding context to make it unique`);
    writeTextAtomic(skill.path, text.replace(oldString, newString ?? ""));
    this.logEdit({
      skill: name,
      action: "patched",
      by,
      summary: `-${oldString.slice(0, 60).replace(/\n/g, " ")} → +${String(newString ?? "").slice(0, 60).replace(/\n/g, " ")}`
    });
    this.reload();
    return { skill: name, patched: true };
  }

  /**
   * Full-field edit: replace body and/or frontmatter fields, preserving
   * lineage keys (sourceSuggestionId, createdBy, createdAt) untouched.
   */
  editSkill(name, { description, body, category, systemPrompt } = {}, by = "agent") {
    const skill = this.mustGet(name);
    const text = fs.readFileSync(skill.path, "utf8");
    const updates = {};
    if (description !== undefined) updates.description = description;
    if (category !== undefined) updates.category = category || null;
    if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt || null;
    const next = updateFrontmatter(text, updates, body);
    writeTextAtomic(skill.path, next);
    const touched = [
      description !== undefined ? "description" : null,
      category !== undefined ? "category" : null,
      systemPrompt !== undefined ? "systemPrompt" : null,
      body !== undefined ? `body (${String(body ?? "").length} chars)` : null
    ].filter(Boolean).join(", ");
    this.logEdit({ skill: name, action: "edited", by, summary: touched || "no-op" });
    this.reload();
    return { skill: name, edited: true, fields: touched };
  }

  /**
   * Pin/unpin. Pinned skills refuse deletion — protection against
   * irrecoverable loss, not against improvement (patch/edit still work).
   */
  setPinned(name, pinned = true, by = "agent") {
    const skill = this.mustGet(name);
    const text = fs.readFileSync(skill.path, "utf8");
    writeTextAtomic(skill.path, updateFrontmatter(text, { pinned: pinned ? true : null }));
    this.logEdit({ skill: name, action: pinned ? "pinned" : "unpinned", by });
    this.reload();
    return { skill: name, pinned: Boolean(pinned) };
  }

  /**
   * Soft delete: moves the skill dir into .trash/ under the user skills
   * dir (recoverable beats gone forever). Refuses pinned + bundled.
   */
  deleteSkill(name, by = "agent") {
    const skill = this.mustGet(name);
    if (skill.pinned) throw new Error(`Skill '${name}' is pinned — unpin it first if you really mean to delete it.`);
    if (skill.bundled) throw new Error(`Skill '${name}' is bundled (read-only examples dir) — it cannot be deleted.`);
    const parent = path.dirname(skill.dir);
    const trashDir = path.join(parent, ".trash");
    ensureDir(trashDir);
    const dest = path.join(trashDir, `${name}-${Date.now()}`);
    fs.renameSync(skill.dir, dest);
    this.logEdit({ skill: name, action: "deleted", by, summary: `moved to ${dest}` });
    this.reload();
    return { skill: name, deleted: true, trash: dest };
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
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: () => this.list().map(({ name, description, category, pinned, stats }) => ({
        name, description, category, pinned,
        runs: stats.runs, views: stats.views, avgScore: stats.avgScore, lastUsedAt: stats.lastUsedAt
      }))
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
      handler: (args) => this.view(args.name, args.file ?? null)
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
      handler: (args, context) => this.run(args.name, { input: args.input ?? "", args: args.args ?? {} }, context)
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
      handler: (args, context) => this.createSkill({ ...args, createdBy: context?.agentId ?? "agent" })
    });

    toolRegistry.register({
      name: "edit_skill",
      source: "skill",
      description: "Improve an existing skill. Preferred: targeted patch via old_string/new_string (old_string must match exactly once). Or pass description/body/category to replace those fields. Patch skills IMMEDIATELY when you find them stale or wrong.",
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
      handler: (args, context) => {
        const by = context?.agentId ?? "agent";
        if (args.old_string !== undefined) return this.patchSkill(args.name, args.old_string, args.new_string ?? "", by);
        return this.editSkill(args.name, args, by);
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
      handler: (args, context) => this.deleteSkill(args.name, context?.agentId ?? "agent")
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
      handler: (args, context) => this.setPinned(args.name, args.pinned !== false, context?.agentId ?? "agent")
    });
  }

  async run(name, { input = "", args = {} } = {}, context = {}) {
    const skill = this.mustGet(name);
    this.recordUse(name, "run");
    const rendered = renderTemplate(skill.body, { input, args });
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider) throw new Error("No model provider available for skill execution.");
    const agentName = `skill:${skill.name}`;
    const instructions = skill.systemPrompt ||
      `You are executing the "${skill.name}" skill. ${skill.description}\nReturn only the user-visible output. Use tools when helpful.`;
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
      const result = await provider.generate({
        input: rendered,
        agent: { id: agentName, name: agentName, systemPrompt: skill.systemPrompt ?? "" },
        memoryHits: [],
        messages: [],
        tools: this.runtime.tools?.toOpenAITools?.() ?? [],
        toolRegistry: this.runtime.tools,
        instructions,
        context: { ...context, skill: skill.name }
      });
      // Tool-using skill completions are graded by their per-call results.
      // Text-only completions keep the historical 0.7.
      if (outcome) {
        const calls = (result.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false }));
        const completionScore = calls.length > 0 ? scoreFromToolCalls(calls) : 0.7;
        this.runtime.outcomes.resolve(outcome.id, completionScore, "skill-completed");
      }
      return { skill: skill.name, output: result.text, toolCalls: result.toolCalls ?? [] };
    } catch (error) {
      if (outcome) this.runtime.outcomes.resolve(outcome.id, 0.1, "skill-failed", error.message);
      throw error;
    }
  }
}

function parseSkill(filePath, dir) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const meta = parseFrontmatter(match[1]);
  const body = match[2].trim();
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description ?? "",
    systemPrompt: meta.systemPrompt ?? meta["system-prompt"] ?? "",
    parameters: meta.parameters ?? null,
    category: meta.category ?? null,
    pinned: meta.pinned === true || meta.pinned === "true",
    // Story 2: lineage back to the proactive-suggestion that birthed
    // this skill (set by skill-materialize.js when the user accepts
    // a category=skill proposal). null for hand-authored skills.
    sourceSuggestionId: meta.sourceSuggestionId ?? null,
    createdBy: meta.createdBy ?? null,
    createdAt: meta.createdAt ?? null,
    linkedFiles: scanLinkedFiles(dir),
    body,
    dir,
    path: filePath
  };
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
  return out;
}

function walkFiles(dir, depth) {
  if (depth < 0) return [];
  const out = [];
  for (const entry of safeReadDir(dir)) {
    const full = path.join(dir, entry);
    if (safeIsDir(full)) out.push(...walkFiles(full, depth - 1));
    else out.push(full);
  }
  return out;
}

// Resolve a linked-file request, refusing path escapes ("../../etc").
function resolveLinkedFile(skillDir, file) {
  const resolved = path.resolve(skillDir, file);
  if (!resolved.startsWith(path.resolve(skillDir) + path.sep)) {
    throw new Error("linked file path escapes the skill directory");
  }
  const rel = path.relative(skillDir, resolved);
  const top = rel.split(path.sep)[0];
  if (!LINKED_DIRS.includes(top)) {
    throw new Error(`linked files must live under ${LINKED_DIRS.join("/, ")}/`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`no such linked file: ${file}`);
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
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value.startsWith("{") || value.startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch {
        // leave as raw string
      }
    }
    out[key] = value;
  }
  return out;
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

function loadUsage(filePath) {
  const map = new Map();
  for (const e of readJsonl(filePath)) {
    if (!e?.skill) continue;
    const entry = map.get(e.skill) ?? { views: 0, runs: 0, lastUsedAt: null };
    if (e.mode === "view") entry.views += 1;
    else entry.runs += 1;
    if (!entry.lastUsedAt || (e.at ?? "") > entry.lastUsedAt) entry.lastUsedAt = e.at ?? null;
    map.set(e.skill, entry);
  }
  return map;
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
      out.push(JSON.parse(line));
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

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

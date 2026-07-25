import path from "node:path";
import fs from "node:fs";
import { appendJsonLine } from "./file-utils.js";
import { createId, nowIso, stableHash } from "./utils.js";

export const SKILL_REVISION_LOG = "revisions.jsonl";

export class SkillRevisionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkillRevisionError";
    this.code = "SKILL_REVISION_INVALID";
    Object.assign(this, details);
  }
}

// Store complete before/after documents, not just summaries. A revision log
// that cannot reconstruct the prior SKILL.md is an audit trail but not a
// usable rollback surface.
export function appendSkillRevision(skillDir, {
  skill,
  action,
  by = "system",
  before = null,
  after = null,
  metadata = null
} = {}) {
  const record = {
    id: createId("skillrev"),
    at: nowIso(),
    skill,
    action,
    by,
    before,
    after,
    beforeHash: before === null ? null : stableHash(before),
    afterHash: after === null ? null : stableHash(after),
    ...(metadata ? { metadata } : {})
  };
  appendJsonLine(path.join(skillDir, SKILL_REVISION_LOG), record);
  return record;
}

// Rollback is intentionally stricter than display/audit reads. A malformed
// history must not become a source of bytes that can overwrite a live skill.
// Older revision lines predate `id`; retain compatibility with a stable,
// line-position-derived identifier while validating their hashes the same way.
export function loadSkillRevisions(skillDir) {
  const filePath = path.join(skillDir, SKILL_REVISION_LOG);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SkillRevisionError("Skill revision history is malformed.", { filePath, line: lineIndex + 1 });
    }
    records.push(normalizeRevisionRecord(parsed, { filePath, line: lineIndex + 1, index: records.length }));
  }
  return records;
}

function normalizeRevisionRecord(value, { filePath, line, index }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRevisionError("Skill revision record must be an object.", { filePath, line });
  }
  const before = normalizeDocument(value.before, "before", { filePath, line });
  const after = normalizeDocument(value.after, "after", { filePath, line });
  const beforeHash = normalizeDocumentHash(value.beforeHash, before, "before", { filePath, line });
  const afterHash = normalizeDocumentHash(value.afterHash, after, "after", { filePath, line });
  if (typeof value.skill !== "string" || !value.skill.trim()) {
    throw new SkillRevisionError("Skill revision record is missing its skill name.", { filePath, line });
  }
  if (typeof value.action !== "string" || !value.action.trim()) {
    throw new SkillRevisionError("Skill revision record is missing its action.", { filePath, line });
  }
  if (typeof value.at !== "string" || !Number.isFinite(new Date(value.at).getTime())) {
    throw new SkillRevisionError("Skill revision record has an invalid timestamp.", { filePath, line });
  }
  const id = typeof value.id === "string" && /^skillrev_[a-z0-9]{16}$/u.test(value.id)
    ? value.id
    : `legacy_${stableHash({ index, at: value.at, skill: value.skill, action: value.action, beforeHash, afterHash }).slice(0, 24)}`;
  return Object.freeze({
    ...value,
    id,
    before,
    after,
    beforeHash,
    afterHash
  });
}

function normalizeDocument(value, label, { filePath, line }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new SkillRevisionError(`Skill revision ${label} document must be text or null.`, { filePath, line });
  }
  return value;
}

function normalizeDocumentHash(value, document, label, { filePath, line }) {
  if (document === null) {
    if (value === null || value === undefined) return null;
    throw new SkillRevisionError(`Skill revision ${label} hash exists without a document.`, { filePath, line });
  }
  const expected = stableHash(document);
  if (typeof value !== "string" || value !== expected) {
    throw new SkillRevisionError(`Skill revision ${label} hash does not match its document.`, { filePath, line });
  }
  return expected;
}

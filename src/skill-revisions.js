import path from "node:path";
import { appendJsonLine } from "./file-utils.js";
import { nowIso, stableHash } from "./utils.js";

export const SKILL_REVISION_LOG = "revisions.jsonl";

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

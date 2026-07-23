# Spec 10 — Skill pack: surface parse failures, per-skill tool allowlists, revision history

**Marker:** `SKILL PACK PHASE COMPLETE`
**Priority:** 10 (Azazel's #10, nice-to-have). **Risk:** Sm-Med. **SCAFFOLD.**
**Files:** `src/skills.js` (parseSkill :587, run_skill :353, parseFrontmatter :712).

## Items
1. **Surface skill parse failures.** `parseSkill` / `parseFrontmatter` swallow errors in
   `catch {}` (`:591`, `:724`, `:732`) — a malformed SKILL.md silently vanishes from the
   registry. Collect parse errors and surface them: a `skills_diagnostics` field / a
   dashboard warning / a `console.warn` per failed skill with the file + reason. Loading
   must still not crash on one bad skill, but it must not be SILENT.
2. **Per-skill tool allowlists (supply-chain hole).** `run_skill` (:353) hands
   sub-generations the ENTIRE tool registry. Auto-mined skills (from pattern-miner) are a
   supply-chain risk — a mined/edited skill shouldn't get unrestricted tools. Add optional
   frontmatter `allowed_tools: [...]`; when present, the skill's sub-generation advertises
   only those (reuse the `toOpenAITools({only:[...]})` option from tool-registry). Default
   (absent) preserves today's behavior but log that a skill ran with the full registry so
   the exposure is visible. Prefer `use_skill` (in-context, :339) messaging over `run_skill`
   for procedures per the existing description.
3. **Revision history.** When a skill is materialized/updated (materialize/replay
   pipeline), keep a revision log (JSONL under the skill dir or `~/.openagi/skills/`) so
   changes are auditable and revertible.

## Constraints
- Frontmatter pitfall: parser requires `---\n...\n---\n` + blank line before body; a
  `.filter(Boolean)` dropping the blank separator breaks parsing — preserve it.
- Writes go to `dirs[dirs.length-1]` (`~/.openagi/skills/`); bundled `examples/skills/` is
  read-only.
- Tests construct SkillRegistry with fake runtimes — default any new constructor deps.

## Tests
- A malformed SKILL.md is skipped BUT recorded in diagnostics (not silent).
- A skill with `allowed_tools` restricts its sub-generation's advertised tools; without it,
  behavior unchanged + an exposure log line.
- Revision log appends on update.

## DoD
Both lanes green + tests, homoglyph clean, `CHANGES.md` entry ending with the marker.

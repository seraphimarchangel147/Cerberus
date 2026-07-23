# Spec 06 — Plan mode

**Marker:** `PLAN MODE PHASE COMPLETE`
**Priority:** 6 (Azazel's #6). **Risk:** Med. **SCAFFOLD.**
**Files:** new bundled skill under `examples/skills/`, later `src/model-provider.js` /
`src/agent-host.js` for loop support.

## Note on existing `/plan`
`discord-commands.js:407` `/plan` already exists but is a DAILY PLANNER
(`computeDailyPlan` / `renderDailyPlanMarkdown` from `daily-planner.js`) — "what should
happen today," NOT a Hermes-style work-plan mode. Do NOT collide with it; name the new
capability distinctly (e.g. `work-plan` skill / `plan_task` tool, or a `/plan task:<...>`
subcommand).

## Direction (two stages, ship v0 first)
- **v0 — bundled skill.** Add a `work-plan` skill (`examples/skills/work-plan/SKILL.md`)
  that instructs the model to produce a structured, bite-sized implementation plan
  (numbered steps, file paths, verification per step) BEFORE executing — mirroring Hermes's
  `writing-plans`/`plan` skills. This needs no loop changes; it's procedural. Follow the
  frontmatter pitfall: end frontmatter with `---` then blank line then body (a `.filter(Boolean)`
  that drops the blank separator breaks parsing).
- **v1 — loop support.** A real plan MODE: a turn flag (`context.planMode`) that (a) makes
  the model draft a plan artifact, (b) optionally requires approval of the plan before
  execution, (c) persists the plan under `~/.openagi/plans/<id>.md` and tracks step status.
  Surface via a `/plan task:<goal>` subcommand and/or a `plan_task` tool. Keep it OFF the
  hot path when unused (byte-identical normal turns).

## Constraints
- Reuse persistence via `file-utils.js`. If plan approval is added, route through the same
  pending-actions suspend/resume from spec-05, not a new gate.
- Don't change tiering/model selection just for planning; base model is fine.

## Tests
- Skill parses and loads (SkillRegistry test with a fake runtime).
- v1: a planMode turn produces + persists a plan artifact; a normal turn is unchanged.

## DoD
v0 skill shipped + loadable (both lanes green, homoglyph clean); v1 loop support either
implemented or scaffolded-and-deferred with a note. `CHANGES.md` entry ending with the marker.

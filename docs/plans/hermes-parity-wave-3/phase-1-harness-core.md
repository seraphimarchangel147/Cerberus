# Parity Wave 3 — Phase 1: Harness Core (9 features)

> Read this file IN FULL before editing any source. Build each feature in order.
> After EACH feature: both test lanes green, homoglyph-scan the diff, commit, append the
> feature's marker line to CHANGES.md. If a feature blocks, commit what's done + note the
> blocker in CHANGES.md and CONTINUE to the next.

Per-feature markers (last line of each CHANGES.md entry):
`CURATOR LOOP COMPLETE` · `GOALS LOOP COMPLETE` · `CRON CONTROL VERIFIED` ·
`CHECKPOINTS COMPLETE` · `HOOKS COMPLETE` · `COMPRESSION COMPLETE` ·
`MEMORY DETAILS COMPLETE` · `HONCHO COMPLETE` · `SECRETS MANAGER COMPLETE`
Phase-final last line of CHANGES.md: `PARITY WAVE 3 PHASE 1 COMPLETE`

---

## F1 — Curator loop  (EXTEND)

**What exists:** `src/skills.js` already has curation verbs (create/patch/edit/pin/delete) and
per-skill telemetry (view/use/patch counts) — the MARK at `skills.js:200`, telemetry constant
set at ~`:334`. What's MISSING is the *automated background pass* that ages skills.

**Build:** a scheduled curator job (reuse `src/cron-scheduler.js`) that reads the usage sidecar,
transitions each agent-created skill `active → stale (30d unused) → archived (90d unused)`, NEVER
deletes, and writes a per-run `~/.openagi/curator/REPORT.md`. Thresholds env-configurable
(`OPENAGI_CURATOR_STALE_DAYS=30`, `OPENAGI_CURATOR_ARCHIVE_DAYS=90`). Archived skills are excluded
from the model tool surface but kept on disk and restorable.

**Wire-in:** register the job at boot in `src/abi-runtime.js` (the cron subsystem is already
constructed there). Skill state field lives in the skill's frontmatter or the `.usage.json` sidecar.

**DoD:** unit test drives the ageing function with synthetic timestamps (active/stale/archived
transitions + never-delete + restore); a REPORT.md is written; bundled/pinned skills are exempt.

---

## F2 — Persistent Goals loop  (EXTEND)

**What exists:** `add_goal`/`link_task_to_goal` are bookkeeping tools in `src/tool-registry.js`.
No *loop*.

**Build:** a goal-mode flag on the session. When a goal is active, after each turn a cheap judge
model call ("is this goal satisfied? yes/no + why") decides whether to auto-continue by feeding a
synthetic continuation prompt — reusing the EXISTING auto-continuation machinery in
`src/model-provider.js` (the iteration engine already injects synthetic "continue" user turns; do
NOT build a second loop — extend that one with a goal-judge exit condition). Turn budget
`OPENAGI_GOAL_MAX_TURNS=20`, fail-open (judge error → stop, never loop forever), any real user
message preempts. Pause/resume/clear via tools + `/goal` slash command (slash layer is
`src/discord-commands.js`).

**Wire-in:** judge model = the cheap tier from `src/model-router.js` TASK_PROFILES. Goal state
persists to `~/.openagi/goals/`.

**DoD:** unit test: judge says "not done" → one auto-continue fires; judge says "done" → stops;
turn budget caps the loop; a user message mid-goal preempts. LIVE probe: set a 2-step goal, confirm
it auto-continues once and stops.

---

## F3 — Cron job control  (VERIFY-ONLY)

**Already shipped** (Seraphim, commit 147d481): `set_cron_job_enabled(id|name, enabled)` at
`src/tool-registry.js:977`, `resolveCronJob` id/name resolver at `:939`, documented in the system
prompt at `src/model-provider.js:1382`. Fail-closed model pinning and `[SILENT]` suppression are
the two Hermes details to ADD if absent:
- **Fail-closed pinning:** an unpinned job snapshots provider+model at creation; if the global
  default changed since, the job SKIPS the run and alerts instead of silently spending on a new
  model. Check `src/cron-scheduler.js` for a `pinnedModel` field; add if missing.
- **`[SILENT]` suppression:** if a run's entire output is `[SILENT]`, skip delivery but persist the
  output for audit. Check the run-delivery path; add if missing.

**DoD:** confirm the toggle works via unit test (already exists: `test/cron-tool-toggle.test.js`);
add tests for pinning-skip + `[SILENT]` if you implement them. Append `CRON CONTROL VERIFIED`.

---

## F4 — Checkpoints & rollback  (VERIFIED-GAP)

**Build:** a shadow snapshot store `src/checkpoint-store.js` gated behind
`OPENAGI_CHECKPOINTS=1` (opt-in). Before any destructive tool op (`write_file`, `patch`,
`code_shell` rm/mv/sed -i) auto-snapshot the target file(s) — ONE checkpoint per directory per
turn (dedupe). A `rollback` tool + `/rollback <N>` slash command lists checkpoints with a diff
preview and restores single files or a whole checkpoint. Store snapshots under
`~/.openagi/checkpoints/` (content-addressed blobs + a JSONL index); do NOT require a real git repo
— a lightweight blob store is enough and avoids polluting user repos.

**Wire-in:** hook the snapshot call into `src/tool-registry.js` `invoke()` BEFORE the destructive
tool runs (same choke point the catastrophic gate uses). Reuse `file-utils.js` atomic writes.

**DoD:** unit test: write→snapshot→modify→rollback restores byte-identical; per-dir-per-turn
dedupe holds; disabled flag = no snapshots, zero overhead.

---

## F5 — Event hooks with veto  (EXTEND)

**What exists:** `src/catastrophic-policy.js` + the catastrophic gate in `src/tool-registry.js`
`invoke()` is effectively a hardcoded single `pre_tool_call` veto. Generalize it into a real hook
system.

**Build:** three hook tiers — gateway hooks (`agent:start/step/end`, `session:*`), plugin hooks,
and shell hooks. The killer piece: a `pre_tool_call` hook that returns
`{action:"block", message:"..."}` to veto ANY tool call before dispatch. Hooks are non-blocking
(async), errors are logged NOT fatal (fail-open — a broken hook can never wedge the loop). Keep the
existing catastrophic policy as the first built-in `pre_tool_call` hook rather than a special case.
Hook config in `~/.openagi/hooks.json` (allowlisted shell commands only, same anti-RCE discipline
as the MCP stdio allowlist).

**Wire-in:** emit points in `src/agent-host.js` (turn lifecycle) and `src/tool-registry.js`
`invoke()` (pre/post tool). A hook registry module `src/hook-registry.js`.

**DoD:** unit test: a `pre_tool_call` hook returning `block` prevents dispatch and surfaces the
message; a throwing hook is logged and the tool still runs (fail-open); the catastrophic gate still
fires as a built-in hook. BOTH test lanes unpinned (proves auto-approve can't bypass a blocking
hook).

---

## F6 — Dual-threshold compression + caching  (EXTEND)

**What exists:** `src/memory-condenser.js` condenses MEMORIES, not the live context window. The
gap is context compression + prompt-cache hygiene.

**Build:**
1. In-loop compressor at 50% of the model's real context window (use real token counts, not
   estimate) — summarize older turns into a digest, keep recent turns verbatim.
2. Gateway-level safety net at 85% (rough estimate is fine here) so overnight-accumulated sessions
   don't blow up before the agent even runs.
3. Prompt caching with a rolling 3-message breakpoint window.
4. Documented pitfall to ENFORCE: mid-session model/credential swaps invalidate the provider cache
   at full price — warn (log) when it happens; do NOT emit intermediate pressure warnings to the
   model (Hermes lesson: they cause models to give up prematurely).

**Wire-in:** `src/model-provider.js` request-assembly path; token counting via the provider's
tokenizer or a tiktoken-equivalent already in deps.

**DoD:** unit test: a synthetic over-50% history triggers compression and preserves recent turns;
the 85% net triggers independently; cache breakpoints roll correctly across 3 messages.

---

## F7 — Memory design details  (EXTEND)

**What exists:** `src/memory-system.js` + MEMORY.md/USER.md. Add the four Hermes refinements:

1. **Char-capped memory that ERRORS instead of silently dropping** when full — forces consolidation
   in the same turn (return an actionable error to the model, don't truncate).
2. **Frozen snapshot:** memory injected ONCE at session start, never mutated mid-session, to
   preserve the prefix cache (`src/model-provider.js` prompt assembly).
3. **Background review on a cheap aux model** replaying a warm-cache digest (~3-5x cheaper) to
   extract memories/skills AFTER sessions — reuse the cron/aux-model plumbing.
4. **Usage % in the header** (`[67% — 1,474/2,200 chars]`) so the model sees its own capacity.

**DoD:** unit test: over-cap add returns an error (not a silent drop); header renders the usage %;
snapshot is stable across a multi-turn session (byte-identical injection).

---

## F8 — Honcho / external memory provider  (VERIFIED-GAP)

**Build:** a pluggable external-memory provider interface `src/integrations/honcho-provider.js`
(dialectic reasoning + cross-session user modeling) that sits ALONGSIDE the built-in
MEMORY.md/USER.md, not replacing it. Provider registered in `src/abi-runtime.js` behind
`OPENAGI_MEMORY_PROVIDER=honcho` (default: built-in only). Define the provider contract as an
interface (get/set/query user model) so other providers can slot in later. Honcho API key via
`WIZARD_FIELDS` env allowlist.

**DoD:** unit test with a mock Honcho backend: writes reach the provider, queries return the model,
built-in memory still works when the provider is off. Do NOT hard-depend on a live Honcho account
for tests.

---

## F9 — Legion Secrets Manager  (EXTEND)  ⭐ Creator's addition

**What exists:** `src/setup-wizard.js` has `saveEnv({dataDir, values, clear})` at `:75` and a
`WIZARD_FIELDS` allowlist at `:13` — the whole Legion already stores secrets as flat `.env` keys
(the openAGI `.env`, Ziz's `~/.zeroclaw`, Seraphim's `~/.hermes`). The gap: no unified, safe,
audited secrets surface — keys are hand-edited, redactor-mangled, and duplicated across agents.

**Build:** `src/secrets-store.js` — a single secrets manager for openAGI that:
1. Stores secrets in `~/.openagi/secrets/` with an at-rest scheme (at minimum file perms 0600 +
   a `secrets.json` separate from `.env`; optional symmetric encryption behind
   `OPENAGI_SECRETS_KEY` if set).
2. Exposes `getSecret(name)`, `setSecret(name, value)`, `listSecrets()` (names + last-4 only,
   never full values), `removeSecret(name)` — with `setSecret` going through the WIZARD_FIELDS
   allowlist so unknown keys are rejected.
3. **Never returns full secret values over HTTP or to the model** — list/describe show
   name + masked preview (`sk-...abcd`) only; actual values are injected into subprocess env at
   spawn time (MCP servers, code_shell) exactly like the current `${VAR}` indirection.
4. Audit log (JSONL) of every set/remove/access with `decidedBy` + timestamp.
5. A `/secrets` slash command (list/set/remove, values entered via ephemeral Discord modal, NEVER
   echoed) and authed HTTP endpoints `GET /secrets` (masked), `POST /secrets` (set), `DELETE
   /secrets/<name>`.

**Wire-in:** migrate `saveEnv`/WIZARD_FIELDS to read/write through the store; MCP registry's
`permittedEnvKeys`/`allowEnvKey` (mcp-registry.js:48) resolves via the store. Keep `.env` working
for backward compat (store is the source of truth, `.env` is a projection).

**Design note for the Legion:** scope this to openAGI now, but define the secrets-store contract in
a way Seraphim can port to a shared cross-agent secrets service later (the Legion FS map has each
agent siloed today). Document the contract in the module header.

**DoD:** unit test: set→get roundtrips; list/describe never leak full values; unknown key rejected;
audit log records every op; 0600 perms enforced; `.env` projection stays in sync. HTTP endpoints
return masked data only (test asserts no full secret in any response body).

---

## Phase 1 close-out
After all 9: run both test lanes green, homoglyph-scan the full Phase-1 diff, ensure every
per-feature marker is present, then append `PARITY WAVE 3 PHASE 1 COMPLETE` as the final line of
CHANGES.md.

# Cerberus — Capability Changelog

Every Legion agent modifying this harness: append an entry here.

## 2026-07-17 — Skill system Hermes-grade upgrade (Seraphim)

- **`src/skills.js` (rewritten around the original core):**
  - `use_skill` — loads a skill's full instructions INTO the calling model's context (Hermes-style in-context execution; keeps conversation awareness) vs. `run_skill` (the original isolated sub-generation, still available and still outcome-graded).
  - **Fixed-cost tool surface**: `list_skills / use_skill / run_skill / create_skill / edit_skill / delete_skill / pin_skill` replace the per-skill `skill_*` tools (which ate the model tool budget linearly — the reason OPENAGI_MAX_MODEL_TOOLS exists). Legacy behavior returns with `OPENAGI_SKILLS_AS_TOOLS=1`.
  - **Linked files**: `references/ templates/ scripts/ assets/` subdirs inside a skill dir are scanned and readable via `use_skill(name, file)` — deep playbooks without bloating the body. Path-escape guarded.
  - **Curation**: `createSkill` (frontmatter + lineage), `patchSkill` (unique-match find/replace), `editSkill` (field edits, lineage preserved), `setPinned` (pinned skills refuse deletion but stay editable), `deleteSkill` (soft — moves to `.trash/`, refuses pinned + bundled).
  - **Telemetry**: every view/run appends to `skill-usage.jsonl`; every mutation appends to `skill-edits.jsonl`; `statsFor()` rolls up runs/views/avg quality/last-used from the outcome store's graded skill-runs.
- **`src/hosted-interface.js`:** new endpoints `GET /skills/:name/view` (`?file=`, `?count=0`), `GET /skills/history`, `POST /skills/create|:name/edit|:name/pin|:name/delete`. Skills tab rebuilt: sidebar ranked by usage with quality badges + 📌; detail pane shows stats row (runs/loads/avg/last/last-used), score **sparkline** of recent graded runs, lineage line (createdBy/date/source suggestion), linked-file chips (click to view), **edit-history timeline** (🌱 created / 🔧 patched / ✏️ edited / 📌 pinned), and an inline body **editor** with Save/Pin/Delete.
- **Tests:** `test/skill-registry-upgrade.test.js` (10 cases) + updated tool-surface expectation in `abi-runtime.test.js`. Full suite: 498 pass.
- Seeded + pinned `self-improve-skills` (meta) so the agent knows the maintenance loop.

## 2026-07-17 — Seraphim
- **Discord gateway adapter** (`src/discord-channel.js`, migration day): native-WS gateway, mention/role-ping gating, DM allowlist, chunking, typing.
- **Live status trace**: `LiveStatus` class — post + throttled-edit of a per-turn status message (scrutiny verdict, per-tool 🔄→✅/❌/⏸️ trace, duration/model footer). Trivial turns auto-delete their status.
- **Tool lifecycle events**: `ToolRegistry.invoke` → notify wrapper (`_invokeGated` holds the gates); `agent-host` threads `input.onToolEvent` and emits the scrutiny verdict pre-model.
- **Activity feed**: `bindActivityFeed(events)` mirrors proactive-suggestion / pending-action / skill-candidate / suggestion-resolved / self-update / task-reminder / daily-recap bus events to `DISCORD_ACTIVITY_CHANNEL`.
- **Approvals from Discord**: `!pending` / `!approve <id>` / `!deny <id>` (allowlist-gated), approve re-invokes with `__confirmed: true` — same path as the dashboard endpoint.
- **Slash-command surface** (`src/discord-commands.js`, 14 commands): `/status /provider /model /pending /tasks /memory /suggestions /budget /skills /recap /plan /observe /sessions /help`. `/provider` uses a native select-menu; `/pending` renders approve/deny buttons; registration is guild-scoped at READY; every interaction gated on `DISCORD_ALLOW_FROM`.
- **QA fixes found during source-verification**: memory API is `retrieve()` not `recall()`; `computeDailyRecap`/`computeDailyPlan` take `{date}` options objects; memory `snapshot()` returns `{short,medium,long}` arrays (status line now shows S/M/L split).

## 2026-07-17 — Visual + capability batch 2 (Seraphim)

- **`src/discord-embeds.js`** (new): shared embed builder, traffic-light color map, `▰▰▱` bar(), ANSI helpers.
- **`src/discord-chart.js`** (new): zero-dep PNG chart renderer (RGBA canvas → node:zlib), line + bar series — used for `/budget` spend history attachments.
- **Live status glow-up** (`discord-channel.js`): status message is now a color-coded EMBED (purple thinking → verdict color → green/red done) with an ```ansi``` step ladder (real terminal colors), per-step durations, and a `▰▰▱ N/M` progress bar. Heavy turns (≥6 tool calls) auto-spawn a **thread** off the status card and stream the full trace there (`DISCORD_THREAD_TASKS=0` disables).
- **Presence** (`discord-channel.js`): ambient dashboard in the member list — "Watching N pending approvals" / "Playing <model>", refreshed every 60s (`DISCORD_PRESENCE=0` disables).
- **Embeds for commands** (`discord-commands.js`): `/status` (color-coded fields), `/budget` (progress bar + PNG spend chart attachment), `/recap`, `/plan`.
- **Cron lane from Discord**: `/schedule prompt: when:` (`20m` one-shot · `every 2h` recurring · `daily 09:00`) delivering back to the channel via the existing prompt-job path, plus `/jobs` with cancel buttons.
- **Inline IDE lane** (`src/code-tools.js`, new — hashline-lite, inspired by oh-my-pi + zerohermes code_intel): `code_read`/`code_search` mint 4-hex content-hash tags; `code_edit` applies line-anchored edits ONLY against a fresh tag (stale anchors rejected — no string-match loops); `code_write`; `code_lint` (node --check); `code_test` (node --test); `code_shell` (approval-gated); `delegate_subtask` (isolated sub-agent turn, no nesting). Homoglyph/zero-width guard on all writes; writes fenced to repo/data/tmp roots; repo edits auto-append this changelog.
- **Nightly self-QA watchdog** (`abi-runtime.js`, cron `self-qa` @ 04:30): lint + full test suite, posts to the activity channel ONLY on failure.
- QA: node --check clean on all 6 touched files, homoglyph byte-scan clean, 488/488 tests pass, anchored-edit roundtrip + stale-tag + ghost-rejection + approval-gating smoke-verified.

## 2026-07-17 — Silent-turn fix (Seraphim)

**Bug (found live in #azazel-chat):** Azazel's QA turn ran 7 tool calls and ended in *total silence* — two empty-content messages, no findings. Root cause chain:
1. `model-provider.js` tool loop (`maxToolHops`, default **6**): when the budget exhausts while the model still wants tools, the final response contains only `tool_use` blocks → `text` = `"(no text)"`.
2. `agent-host.js` passes that through as `result.reply`.
3. `discord-channel.js` happily sent `"(no text)"`-adjacent emptiness; the truthy check let placeholder text through and empty replies vanish silently.

**Fixes:**
- `model-provider.js` (both Anthropic + OpenAI paths): on hop-budget exhaustion, append a `[system]` wrap-up instruction and make **one final no-tools call** so the model summarizes progress instead of going silent.
- `discord-channel.js`: reply send now rejects empty/`"(no text)"` replies and posts an explicit `⚠ Turn completed without a text reply (N tool calls ran…)` notice — a pinged turn can never end in silence.
- `openagi-azazel.service`: `OPENAGI_MAX_TOOL_HOPS=16` (6 was far too tight for multi-step QA/coding briefs).

QA: `node --check` clean both files, 488/488 tests pass, homoglyph/zero-width byte-scan clean, service restarted with env verified (`systemctl --user show -p Environment`).

## 2026-07-17 (Seraphim)
- `discord-channel.js:249` — serialized turn rejection no longer swallowed: logs `turn-rejected` + posts "⚠ Turn failed hard" to the channel (Azazel audit finding #1).
- Live-status embed disabled via `DISCORD_LIVE_STATUS=0` in openagi-azazel.service (Creator request: no visual tool-call replies).

## 2026-07-17 — Skills subsystem QA + hardening (Codex)

- Added adversarial coverage for traversal and symlink escapes, strict-name handling, size limits, patch ambiguity, pinned/bundled deletion, trash collisions, corrupt and concurrent JSONL, empty skills, and missing `use_skill` targets.
- Enforced strict slug boundaries, capped linked files at 1 MiB and skill bodies at 256 KiB, made telemetry reads line-tolerant, and hardened frontmatter and trash handling without changing the fixed-cost tool contracts.
- Escaped all stored skill metadata and edit-history text rendered by the Skills dashboard. Validation: `node --test` — 508/508 pass.
QA PHASE COMPLETE

## 2026-07-17 — Auto-approve mode for gated actions (by Seraphim)

- `src/tool-registry.js`: `autoApproveEnabled()` (env `OPENAGI_AUTO_APPROVE`, DEFAULT ON —
  only explicit `0`/`false`/`off` disables). When on, gated tools (needsConfirmation /
  scrutiny-confirm) run immediately; the action is still enqueued + resolved with
  `decidedBy:"auto-approve"` so the Approvals audit trail is preserved.
- `src/hosted-interface.js`: `GET /auto-approve` (state) and `POST /auto-approve {enable}` —
  live toggle, persists to `.env`, no restart needed.
- `src/discord-commands.js`: `/autoapprove [mode:on|off]` slash command (show/toggle).
- `src/setup-wizard.js`: `OPENAGI_AUTO_APPROVE` allowlisted in WIZARD_FIELDS.
- `test/auto-approve.test.js`: 3 tests (default-on semantics, run+audit path, off→queue path).
  `npm test` pins `OPENAGI_AUTO_APPROVE=0` so legacy queue-semantics tests stay valid.

## 2026-07-17 — Activity-feed notifications rerouted + decision events (by Seraphim)

- `.env`: `DISCORD_ACTIVITY_CHANNEL` → 1477780117496271030 (Azazel's working channel).
- `src/pending-actions.js`: `decide()` now emits `pending-action-decided` on the bus.
- `src/discord-channel.js` activity feed: (a) gated-action posts are auto-approve-aware
  (⚡ "running automatically" vs ⏸️ "awaiting approval"); (b) posts decisions
  (🤖✅ auto-approved / ✅ approved by user / ⛔ denied, with error if any);
  (c) announces auto-approve toggles (🟢/🔴).
- `src/discord-commands.js`: `/autoapprove` toggle also broadcasts on the bus.

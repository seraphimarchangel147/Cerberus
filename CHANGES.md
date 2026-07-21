# Cerberus — Capability Changelog

Every Legion agent modifying this harness: append an entry here.

## 2026-07-20 — Discord image attachments → vision (Seraphim)

- **Fixed: Azazel could not see images sent on Discord.** Inbound attachments were never extracted, and image-only messages (no caption) were dropped at `if (!text) return`. Now:
  - `discord-channel.js`: `fetchDiscordImages()` downloads image attachments (png/jpeg/webp/gif, ≤8 MB, ≤4 per message) from the Discord CDN as base64. `handleMessage` no longer early-returns when a message has images but no text; `runTurn` fetches the images and threads them to the agent host.
  - `agent-host.js`: passes `input.images` through to `modelProvider.generate()`.
  - `model-provider.js`: both `AnthropicProvider` and `OpenAIResponsesProvider` `generate()` now accept `images` and attach them to the CURRENT user turn as real vision blocks (Anthropic `{type:image,source:{base64}}` / OpenAI `{type:input_image,image_url:data:}`). Text-only turns keep plain-string content (cache-stable).
- Verified the live model **kimi-k3** (api.kimi.com) IS vision-capable via direct probe. End-to-end: harness `AnthropicProvider.generate()` with a real green PNG + live config → reply "Green".
- Slash commands (`/status`, `/model`, `/pending`, etc., 17 total) were already implemented in `discord-commands.js` and confirmed registered on the guild — no change needed there.
- Tests: 4 new vision-plumbing regressions in `model-provider-iterations.test.js`; full suite **563/563 pass**. Homoglyph byte-scan clean.
- Follow-up hardening: the CDN download in `fetchDiscordImages()` is now bounded by a 20s AbortController so a stalled attachment fetch can't hang a whole turn; `channels.js` `handleLocalMessage` also forwards `images` so the HTTP `/message` path is vision-capable. Verified on the LIVE daemon via authed `POST /message` with a real image → reply "Red" in ~10s.
VISION ATTACHMENT PHASE COMPLETE

## 2026-07-17 — Consent lane and scrutiny anti-loop (Codex)

- Added an exported, strict consent-phrase lane for affirmative/directive replies following an assistant question, including Discord's author prefix. Explicit consent now drives an effective `act` verdict while preserving the raw scrutiny action and score for audit.
- Added one-question anti-loop damping: a direct answer to a prior clarifying question demotes a repeated `ask` to `act`, while stops, delays, and genuinely new questions remain excluded.
- Made `ask` guidance and confirmation reasons truthful about live auto-approve state: enabled tools proceed immediately with audit logging; disabled tools retain the manual clarification/approval path.
- Added detector, end-to-end AgentHost override/outcome/LiveStatus, damping, and auto-approve guidance regressions. Validation: `node --check` and `node --test` — 531/531 pass.
CONSENT LANE PHASE COMPLETE

## 2026-07-17 — Discord reply quoting toggle (Codex)

- Added live `DISCORD_REPLY` handling for Discord posts. Reply quoting is off by default and enabled only by `1`, `true`, or `on`; the environment is checked on every send so no channel restart is required.
- Kept all existing reply ids at their call sites while suppressing `message_reference` centrally in `sendMessage` and `sendEmbed`; status-message thread creation remains independent and unchanged.
- Added REST-body regressions for the default, opt-in, live-toggle, embed, and thread-anchor paths. Validation: `node --check` and `node --test` — 527/527 pass.
REPLY TOGGLE PHASE COMPLETE

## 2026-07-17 — Hermes-style turn iterations (Codex)

- Replaced the fixed six-hop provider loops with a 25-iteration whole-turn engine for both OpenAI Responses and Anthropic Messages. `OPENAGI_MAX_ITERATIONS` is the primary cap; `OPENAGI_MAX_TOOL_HOPS` remains a deprecated fallback alias.
- Added transparent same-turn continuation across request boundaries and incomplete responses while retaining accumulated messages, function/tool calls, results, screenshots, and partial assistant text.
- Added ordered iteration progress events, AgentHost result/session metadata, and Discord live-status rendering of `iteration n/max`; true-cap notices now report the count and point to `OPENAGI_MAX_ITERATIONS`.
- Added a 900-second whole-turn wall-clock guard (`OPENAGI_MAX_TURN_SECONDS`) that bounds model and tool waits and returns an honest partial summary on expiry.
- Added provider/configuration, continuation, incomplete-response, timeout, progress, Discord, and deterministic-compatibility regressions. Validation: `node --check` and `node --test` — 524/524 pass.
ITERATIONS PHASE COMPLETE

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

## 2026-07-17 — Activity feed follows the working channel (Hermes-style)
- Feed posts (approval pings, decisions, observer events) now route to the
  Discord channel Azazel is actively working in, not a static home channel:
  1. event's own sessionId ("discord:<guild>:<channel>") when the triggering
     turn came from Discord (pending-action / pending-action-decided events
     now carry sessionId from the action context),
  2. else the channel of the most recent inbound message (lastActiveChannel),
  3. else DISCORD_ACTIVITY_CHANNEL as static fallback.
- bindActivityFeed no longer requires DISCORD_ACTIVITY_CHANNEL to be set.
- Full suite: 511/511 pass.

## 2026-07-17 — Live status visuals upgrade (Hermes-style)
- DISCORD_LIVE_STATUS enabled (was 0 in the unit file): every turn now posts an
  animated status card (spinner, elapsed clock, iteration n/max, current-tool
  spotlight, ANSI step ladder, progress bar) edited live, with heavy turns
  spawning a trace thread. Typing indicator already fires during turns.
- Presence now shows the actual task ("Watching ⚙️ <task…>") while working,
  reverting to idle presence after.
- 4s tick timer keeps spinner/clock alive between tool events; cleared on
  finish/fail.

## 2026-07-17 — trycua computer-use wired in via MCP (Seraphim)
- `src/mcp-registry.js`: added `cua-driver` to ALLOWED_STDIO_COMMANDS so the
  trycua driver can be a stdio MCP server.
- `~/.openagi/mcp.json` (new): registers server "cua" → `/home/usapcool/.hermes/bin/cua-driver mcp`
  (WSL→Windows interop bridge, Session-1 desktop). Tools surface as `mcp_cua_*`
  (list_apps, get_window_state, click, type_text, hotkey, scroll, screenshot, etc.).
- Verified live: `POST /mcp/call {server:"cua", tool:"get_screen_size"}` → 3840x2160@2x.
- Note: the legacy `src/integrations/computer-use.js` stub (OPENAGI_COMPUTER_USE flag,
  mac-node design, input synthesis refused) remains OFF; the MCP path supersedes it.

## 2026-07-17 — Tier-1 hardening (Seraphim)
- code-tools: `mustResolve()` gate now enforced on code_read/search/lint/test/shell
  (was silently dropped); `resolveSafe()` does realpath containment so symlinks
  inside allowed roots can't escape them.
- `/health` public response is now `{ok, firstRun}` only; full runtime.status()
  requires auth.
- boot: binding 0.0.0.0/:: without OPENAGI_AUTH_TOKEN now REFUSES to start
  (override: OPENAGI_UNSAFE_BIND=1).
- Telegram webhook fails CLOSED when TELEGRAM_WEBHOOK_SECRET unset.
- HTTP bodies capped at 5MB (readJson/readForm).
- New test lane `npm run test:prod-policy` (OPENAGI_AUTO_APPROVE=1) — caught 4
  tests that assumed queue semantics; those now pin auto-approve off locally.
- New test/tier1-hardening.test.js. Both lanes 537/537 green.

## 2026-07-18 - Tier 2a catastrophic policy (Codex)

- Added the deliberately small catastrophic shell classifier for protected-root deletes, host/WSL shutdown, agent-service/process kills, disk surgery, primary-branch force pushes, credential writes, and fork bombs.
- Wired catastrophic calls ahead of auto-approve, persisted their severity and reason, and required an explicit human confirmation path before execution.
- Added classifier, false-positive, both-policy-lane non-bypass, and hosted approval endpoint regressions.

## 2026-07-18 - Tier 2b Hermes-style Discord approvals (Codex)

- Added catastrophic approval cards with Approve Once, Allow for session, and Deny buttons over the raw Discord gateway/REST surface.
- Mirrored Hermes's first-click-wins state, per-click owner/allowlist authorization, same-message recolor/footer edits, disabled controls before execution, 10-minute pending-preserving expiry, and in-channel result follow-ups.
- Added an in-memory tool+session allowance and attached the exact Hermes approval note plus `approvedVia: "discord-button"` and decider metadata to approved results/actions.
- Hermes's resolved-before-execution ordering is stronger than a store-status-only check, so this implementation follows it to prevent double execution while a long action is still running.

## 2026-07-18 - Tier 3a audit redaction (Codex)

- Added `sanitizeForAudit()` deep-clone redaction for secret-bearing keys plus common OpenAI, Slack, GitHub, AWS, and long Bearer credential shapes.
- Applied sanitized copies at pending-action journals/snapshots/API responses, persisted assistant tool-call arguments, outcome inputs/snapshots, and expanded MCP status responses while retaining live originals for execution.

## 2026-07-18 - Tier 3b iteration budget enforcement (Codex)

- Re-check the daily budget immediately before every OpenAI and Anthropic provider request, including the iteration-cap summary request, so a long iteration turn cannot outlive its budget gate.
- Added optional `OPENAGI_MAX_TURN_USD` accounting from recorded request costs; reaching either budget returns a local partial summary with `stopReason: "budget-cap"` and makes no further paid request.
- Surface budget-capped turns in Discord fallback and live-status output, including no-tool turns that would otherwise discard their status card.
- Added both-provider regressions for mid-loop daily-budget trips, per-turn spend enforcement, request/event counts, and Discord observability.

## 2026-07-18 - Tier 3c session append serialization (Codex)

- Added an in-process promise-chain mutex keyed by session id around file-backed transcript read-modify-write operations, preserving enqueue order without blocking writes to unrelated sessions.
- Await file-backed appends at the AgentHost boundary and added a delayed-write concurrency regression proving that two same-session messages both survive on disk and completed lock entries are released.
TIER2 HARDENING COMPLETE

## 2026-07-18 - Pattern-miner midnight flake fix (Seraphim)

- Root-caused the "pre-existing 557/558 flaky failure": sequence scoring used a naive mean/variance over getHours(), so routines straddling local midnight (hours 23 and 0) scored variance ~132 -> timeStability 0 -> candidate silently dropped. The pattern-miner test only failed when the suite ran near local midnight.
- Replaced with a circular (vector) mean and wrapped hour deviations in mineSequences; startHour now wraps mod 24. Mid-day scoring is numerically unchanged.
- Added test/pattern-miner-midnight.test.js: pre-fix repro (0 candidates at 00:5x local) plus a mid-day invariance guard. Both lanes: 560/560.

- 2026-07-21T02:08:56.868Z · **azazel** · create `ui/azazel-dashboard.html` — Standalone HTML dashboard rendering Azazel's upgrade status table with dark theme + dark red accents

## 2026-07-21 - Native Kimi web search (Codex)

- Added a zero-dependency OpenAI-compatible mini-client for Kimi's server-side `$web_search` builtin on the existing coding `/chat/completions` endpoint, with three tool hops, a 60-second per-request timeout, recency/limit guidance, citation extraction, and prose fallback.
- Fixed the documented Moonshot continuation shape that previously produced `tokenization failed`: replay the assistant message unchanged, then append `{role:"tool", tool_call_id:<call.id>, name:"$web_search", content:JSON.stringify(JSON.parse(call.function.arguments))}` for every call.
- Registered live `ANTHROPIC_API_KEY`-gated Kimi search in the provider surface. It is the first native provider and default when no dedicated search key exists; configured external providers and explicit provider selection remain supported.
- Added transport-stubbed regressions for the builtin declaration, exact echo transcript, multi-hop continuation, citations/prose normalization, timeout behavior, live configuration, external-provider priority, and secret-safe errors. Tests never call the live API.
- Validation: `npm test` and `npm run test:prod-policy` each pass 569/569; changed filenames/content pass the Cyrillic, Greek, nonstandard-hyphen, and fullwidth scan.
WEB SEARCH PHASE COMPLETE

## 2026-07-21 - Hermes-style execute_code sandbox (Codex)

- Added `execute_code`, a 50-call orchestration tool for short JavaScript bodies that reduce multi-tool intermediate data to a capped printed summary.
- Kept every nested `callTool(name, args)` in the parent `ToolRegistry`, inheriting scrutiny and specialist bounds while deliberately dropping wrapper approval so catastrophic child calls still require their own human decision.
- Isolated the `node:vm` context in a memory-limited worker thread. This remains process-local, but gives the harness a reliable hard kill for infinite loops after `await`; Node 22's experimental in-context microtask timeout path can abort the host process in that case.
- The VM surface is ECMAScript intrinsics plus frozen `console.log` and `callTool`. It has no process/environment, module loader, dynamic code generation, network, timers, buffers, or filesystem globals; the worker also receives only the existing MCP-safe environment allowlist.
- Added regressions for three-file reduction, post-tool timeout, the 50-call ceiling, catastrophic passthrough in both policy lanes, 64 KiB stdout truncation, ghost-output rejection, sandbox escape resistance, and scrutiny gating.
- Validation: `npm test` and `npm run test:prod-policy` each pass 577/577; all changed filenames and contents pass the homoglyph scan.
EXECUTE CODE PHASE COMPLETE

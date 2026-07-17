# Cerberus — Capability Changelog

Every Legion agent modifying this harness: append an entry here.

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

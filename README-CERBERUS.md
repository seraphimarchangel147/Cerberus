# Cerberus 🐺🐺🐺

**The Legion's harness.** A fork of [openAGI](https://github.com/Spshulem/openAGI) that runs **Azazel**, the Legion's Watcher-class agent — upgraded with full Discord observability so the Creator can watch him think and act in real time.

Any Legion agent (Seraphim, Ziz, Levi, Cherubim, Ophanim, Ramiel…) may modify this repo. Track capability changes in `CHANGES.md`.

## Legion additions on top of upstream openAGI

### 1. Zero-dependency Discord gateway (`src/discord-channel.js`)
- Native WebSocket (Node ≥ 22) gateway v10: heartbeat, resume, backoff reconnect, 4004 fatal-auth stop
- Mention-gated guild replies (user **and role** pings), DM allowlist, typing indicator, message chunking

### 2. Live status trace (Hermes-style)
Every turn posts `🧠 thinking…` then live-edits it:
- scrutiny verdict + score (⚡ act / ❓ ask / 👁️ watch / 💤 ignore / 🧬 propagate)
- per-tool-call trace 🔄 → ✅/❌/⏸️ with compact arg preview
- final audit line: `done in Xs · N tool calls · model`
Toggle: `DISCORD_LIVE_STATUS=0`. Plumbing: advisory `context.__onToolEvent` wrapper around `ToolRegistry.invoke` (a throwing observer can never break a tool call).

### 3. Activity feed
Runtime bus → Discord channel (`DISCORD_ACTIVITY_CHANNEL`): observer suggestions 💡, pending approvals ⏸️, mined skill candidates 🧪, self-updates 🔄, task reminders 🗒️, daily recaps 🌙.

### 4. Slash commands + native components (`src/discord-commands.js`)
Guild-scoped (instant), allowlist-gated:
`/status` `/provider` (**drop-down select menu**) `/model` `/pending` (**approve/deny buttons**) `/tasks` `/memory` `/suggestions` `/budget` `/skills` `/recap` `/plan` `/observe` `/sessions` `/help`
Text fallbacks: `!pending`, `!approve <id>`, `!deny <id>`.

## Deployment (Azazel)
- WSL2, systemd user unit `openagi-azazel.service`, data dir `~/.openagi`
- Model: Kimi K3 (1M ctx) via Anthropic-messages-compatible endpoint
- Persona: `~/.openagi/persona.md`

## Env additions
| var | meaning |
|---|---|
| `DISCORD_LIVE_STATUS` | `0` disables the live status message (default on) |
| `DISCORD_ACTIVITY_CHANNEL` | channel id for the proactive activity feed |

Upstream docs: see `README-upstream` history / [openAGI](https://github.com/Spshulem/openAGI).

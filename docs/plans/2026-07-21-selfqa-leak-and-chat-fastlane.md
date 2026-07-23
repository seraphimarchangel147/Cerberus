# Spec: self-QA Discord leak fix + conversational fast-lane

**Branch:** `codex/selfqa-leak-chat-fastlane` (created from this commit)
**Repo:** Cerberus (openAGI, Node, zero-dep). Runtime: Kimi K3 base model, provider `anthropic`-shaped.
**Author of spec:** Seraphim (reviewed live against source 2026-07-21).
**Completion marker:** finish by writing the literal line `SELFQA + FASTLANE PHASE COMPLETE`
as the LAST line of your CHANGES.md entry.

Two independent, small changes. Do BOTH, each as its own commit, `node --test` green after each.
Do NOT touch model-tier selection for chat, the scrutiny judges, memory retrieval, or the embedder —
those are already cheap (local heuristics / hash embeddings, no network). This spec is deliberately
narrow: stop a test-suite Discord leak, and stop shipping the whole tool catalog + a huge iteration
ceiling on plain conversational turns. Preserve reasoning depth on real work.

---

## Phase 1 — Stop the nightly self-QA Discord leak

### The bug (measured live)
Azazel's `self-qa` cron (`dailyAt 04:30`) calls `runSelfQa()` (`src/abi-runtime.js:1138`), which invokes
`code_test` (`src/code-tools.js:340`). `code_test` runs:

```js
const r = await run(process.execPath, testArgs, { cwd: REPO_ROOT, timeoutMs: 300000 });
```

`run()` (`src/code-tools.js:117`) calls `execFile(cmd, args, { cwd, timeout, maxBuffer })` — with **no `env`
option**, so the spawned `node --test` process **inherits the live daemon's full environment**, including
`DISCORD_BOT_TOKEN` and `DISCORD_ACTIVITY_CHANNEL`. Several tests boot a real hosted interface
(`createHostedInterface` → `ChannelManager` (`src/channels.js:20`) → `new DiscordChannel({ token:
process.env.DISCORD_BOT_TOKEN })`) which **connects to Discord for real** and calls `bindActivityFeed`.
The test fixtures then emit real activity events — `sug_test1`/`sug_test2` skill suggestions, a
`wsl --shutdown` catastrophic-approval card, and `morning-brief`/`replay_skill` Mac-replay approval
prompts — all of which the live feed dutifully posts into the working Discord channel. Result: the
nightly QA run spams cherubim-chat with fake test fixtures that look like real catastrophic actions.

### The fix
Make the test subprocess incapable of binding any live channel. In `src/code-tools.js`, change the
`run()` helper (or just the `code_test` call site) to pass a **scrubbed env**:

1. Add an optional `env` param to `run(cmd, args, { cwd, timeoutMs, env })`, forwarded to `execFile`'s
   options as `env`. When `env` is omitted, keep current behavior (inherit) — do NOT change `code_shell`
   or `code_lint` behavior.
2. In the `code_test` handler, build the child env by cloning `process.env` and **deleting** every
   channel/credential key that could bind a live socket:
   - `DISCORD_BOT_TOKEN`, `DISCORD_ACTIVITY_CHANNEL`, `DISCORD_ALLOW_FROM`, `DISCORD_GUILDS`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`
   - any `*_WEBHOOK_SECRET` (BuildBetter etc.)
   Also set `OPENAGI_TEST=1` in the child env as a belt-and-suspenders signal.
   Pass that scrubbed object as the new `env` arg to `run()`.
3. Defense in depth (do this too, it's cheap and closes the class): in `ChannelManager`
   (`src/channels.js`), when `process.env.OPENAGI_TEST === "1"`, construct Discord/Telegram channels
   with a **null token** so they never open a gateway connection even if a token somehow leaks in.
   Verify `DiscordChannel` already no-ops cleanly with an empty/undefined token (it should — the
   `token ?? process.env.DISCORD_BOT_TOKEN` path just yields undefined; confirm `.start()`/connect
   guards on a falsy token and doesn't throw).

### Required test (Phase 1)
Add `test/selfqa-env-scrub.test.js`:
- Assert the `code_test` handler passes an `env` to the spawned process that has `DISCORD_BOT_TOKEN`
  and `TELEGRAM_BOT_TOKEN` **absent** and `OPENAGI_TEST=1` present. (Inject a fake `run`/`execFile`
  spy via the module's existing seam, or refactor `run` to accept an injected spawner for the test —
  keep the production default intact.)
- Assert `new ChannelManager({...})` with `OPENAGI_TEST=1` in env yields a Discord channel with no
  live token bound (no gateway connect attempt).

Do NOT weaken or delete the existing catastrophic/outreach/replay tests — they are correct; the fix is
to isolate their environment, not change their assertions.

---

## Phase 2 — Conversational fast-lane (token/latency win, no depth loss)

### The waste (measured live)
Every user turn, `agent-host.js` builds the model tool list at line ~230:
```js
toolRegistry?.toOpenAITools?.({ readOnly: toolPolicy === "read-only" })
```
The registry holds **57 tools**; their full JSON schemas are shipped on the request `body.tools`
(`model-provider.js:460`) on EVERY turn — including a plain "what's X" question that will call zero
tools. That is the dominant input-token cost per casual turn. Separately, the systemd unit sets
`OPENAGI_MAX_ITERATIONS=120` (default is 25 — `model-provider.js:3`), a 5x-inflated ceiling that lets a
misbehaving turn loop far longer than any chat needs.

### The fix — a "chat fast-lane" gate
Add a cheap, deterministic (NO extra LLM call) classifier that marks a turn as *conversational* and,
when so, (a) advertises only a small core tool set and (b) caps iterations low. Real work is untouched.

1. **Detect a conversational turn** in `agent-host.js handleMessage`, after scrutiny is computed.
   A turn is `conversational` when ALL hold:
   - `channel` is interactive (not `autopilot`/`cron`/`subagent`),
   - effective scrutiny verdict is `ignore` or `watch` (i.e. read-only/no-side-effect lane),
   - `detectTaskInChat(text)` returned nothing (no "remind me / todo / I need to"),
   - the message does not match an imperative/tool-intent heuristic. Reuse existing signal cues if
     present; otherwise a small regex over the leading verb is fine (e.g. matches things like
     "remind|schedule|search|run|open|send|remember|delete|fix|build|deploy|email|post" → NOT
     conversational). Keep it conservative: when in doubt, treat as NOT conversational (full lane).
   Expose the result as a boolean `conversational` on the turn.

2. **Trim the advertised tools for conversational turns.** Define a `CHAT_CORE_TOOLS` allowlist —
   the handful a chat answer might legitimately need: `recall`, `remember`, `list_sessions`,
   `schedule_message`, `run_skill`, `list_skills` (adjust to the real core names in the registry).
   When `conversational`, pass `toOpenAITools` a new option (e.g. `{ only: CHAT_CORE_TOOLS }` or an
   `allow` filter) so only those schemas are advertised. IMPORTANT: this is **advisory-list only** —
   the enforcement gate (`__allowedTools`, scrutiny policy) is unchanged, and the model can still
   escalate by calling `run_mcp_tool`/`list_mcp_tools` if it truly needs more. Do NOT remove tools from
   the registry or the invoke gate; only shrink what's *advertised* on the request.
   - Add the `only`/`allow` option to `_modelToolList` / `toOpenAITools` / `toAnthropicTools` in
     `tool-registry.js` (intersect with the existing cap logic; keep the "no silent caps" warning
     behavior for the non-chat path).

3. **Cap iterations for conversational turns.** When `conversational`, pass
   `maxIterations: CHAT_MAX_ITERATIONS` (default `4`) into `modelProvider.generate(...)` — it already
   accepts a `maxIterations` override (`model-provider.js:394,397`). This overrides the inflated 120
   ceiling *for chat only*; real tasks (autopilot/cron/non-conversational) keep the configured cap.
   Make `CHAT_MAX_ITERATIONS` overridable via `OPENAGI_CHAT_MAX_ITERATIONS` (default 4).

4. **Do NOT change the model/tier for chat.** Chat stays on the base model (Kimi K3) — the Creator
   explicitly wants no loss of depth or performance. This phase only trims *advertised tools* and the
   *iteration ceiling* for turns that provably don't need the full arsenal.

### Required tests (Phase 2)
Add `test/chat-fastlane.test.js`:
- A plain question ("what's the capital of France", scrutiny `watch`/`ignore`, no task) →
  `conversational === true`, the advertised tool list == `CHAT_CORE_TOOLS` (assert count and names),
  and `generate` is called with `maxIterations === 4` (spy the provider).
- An imperative/task turn ("remind me to call mom at 5") → `conversational === false`, full tool list
  advertised, `maxIterations` == the configured/default cap (NOT 4).
- A `read-only` scrutiny turn that IS a task request stays full-lane (conservative default holds).
- Registry: `toOpenAITools({ only: [...] })` returns exactly the intersection, and without `only`
  behaves byte-identically to today (guard against regressions in the hot non-chat path).

---

## Process constraints (both phases)
- WSL host, 12GB memory cap — but `node --test` is light; run it Linux-side, it's <1 min.
- Zero-dependency repo: no new npm packages. Node stdlib + existing modules only.
- Each phase = its own commit with `node --test` green (report the real `# pass N | # fail 0`).
- Homoglyph-clean: no Cyrillic/Greek/zero-width/fullwidth chars in any added line or filename.
- Update CHANGES.md per phase; the LAST line of the final entry must be exactly:
  `SELFQA + FASTLANE PHASE COMPLETE`
- Do not touch: scrutiny-panel.js judges, embeddings.js, model-router.js tiering, or the live daemon.
- Push the branch to origin when done (`git push -u origin codex/selfqa-leak-chat-fastlane`).

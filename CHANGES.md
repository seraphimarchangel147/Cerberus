# Cerberus — Capability Changelog

Every Legion agent modifying this harness: append an entry here.

## 2026-07-22 — Reversible cron job control from the agent loop (Seraphim)

- Added `set_cron_job_enabled(id, enabled)` tool: turns a scheduled cron job OFF (pause, reversible — preserved with `nextRunAt=null`) or ON (resume, recomputes `nextRunAt`) via the existing `runtime.cron.enableJob()`. This closes the gap where the only in-loop control was the destructive `cancel_cron_job` — "turn it off" now means pause, not delete.
- Added a shared `resolveCronJob()` helper so both `set_cron_job_enabled` and `cancel_cron_job` accept a job **id OR name** (exact → case-insensitive → unique-match; ambiguous matches refused with an actionable error, unknown ids return an error instead of a silent no-op). Motivated by a live `nightly-qa` job Azazel could create but not pause from his runtime.
- Documented `list_cron_jobs` / `set_cron_job_enabled` / `cancel_cron_job` in the model system prompt so the agent knows job control exists.
- Regression: `test/cron-tool-toggle.test.js` (off→preserved→on, resolve-by-name, delete-by-name, unknown-job error). Both lanes 682/682.

## 2026-07-21 — Remove the ungoverned legacy delegation path (Codex)

- Chose Spec 12 Option B after confirming `delegate_task` already covers both single and batched isolated children with side-effect classification, parent scrutiny ceilings, shared provider budget accounting, `OPENAGI_MAX_CHILDREN`, depth limits, cancellation, and bounded child turn settings.
- Removed redundant `delegate_subtask` registration from the code-tool lane so models cannot bypass those controls through a direct AgentHost call; cleaned the obsolete child-tool exclusion while retaining `send_message` and `schedule_message` isolation.
- Added a regression proving the legacy name is absent and a single governed `delegate_task` still carries scrutiny, depth, iteration, and wall-clock bounds into the child turn.
DELEGATE GOVERNANCE PHASE COMPLETE

## 2026-07-21 — Ranked and filtered session search (Codex)

- Changed the SQLite FTS5 path from recency-only ordering to `bm25(messages)` relevance with timestamp tie-breaking; the JSONL compatibility path remains explicitly recency-ordered because it has no FTS ranker.
- Added safely bound exact role/session filters and inclusive `since`/`until` ranges to SessionIndex and both transcript-search tool surfaces, with validation for roles, timestamps, and inverted ranges.
- Made fallback JSONL search tolerate isolated corrupt lines while applying the same filters, and added regressions for relevance, filter narrowing, SQL-shaped bound values, fallback behavior, and tool forwarding.
- Confirmed the registered read-only tool is exactly `searcmcp_sessions`, once, with no stale `searchmcp_sessions` duplicate. No typo was found; the existing name is intentional and was not renamed to avoid breaking callers.
SESSION SEARCH PHASE COMPLETE

## 2026-07-21 — Skill diagnostics, allowlists, and revisions (Codex)

- Skill reloads now skip malformed files without crashing while retaining structured diagnostics and warning once with the exact file and parse/size reason; malformed structured frontmatter is no longer silently treated as text.
- Added optional JSON frontmatter `allowed_tools`: isolated `run_skill` generations advertise only that subset on both provider shapes and carry the same invoke-time ceiling. Legacy skills remain compatible, with an explicit full-registry exposure warning that recommends `use_skill`.
- Added per-skill `revisions.jsonl` records containing complete before/after documents and hashes for creation, materialization, patch, edit, pin, and delete operations so prior content is auditable and reconstructable.
- Fixed materialized frontmatter to retain the canonical blank line before the body while keeping legacy one-newline skills loadable, and added regressions for diagnostics, restricted/default execution, revision appends, and real materialized-skill loading.
SKILL PACK PHASE COMPLETE

## 2026-07-21 — Fence-safe Discord streaming and bounded retries (Codex)

- Replaced fixed Discord slicing with an exported boundary-aware chunker that preserves short messages exactly, prefers paragraph/line/word breaks, and closes/reopens fenced code (including its language hint) across normal sends and streamed rollover.
- Flipped `DISCORD_STREAMING` to default ON now that rollover preserves fenced rendering; operators can still disable it live with `0`, `false`, or `off`.
- Bounded Discord REST rate-limit recovery to three total attempts, honoring `retry_after` with a capped delay and retrying only explicit 429 responses before a send succeeds.
- Added isolated regressions for short/plain/fenced chunks, streamed fences, a 429-then-success send, and graceful exhaustion after three 429s.
STREAMING CHUNKING PHASE COMPLETE

## 2026-07-21 — Optional post-turn background review (Codex)

- Added a default-off, best-effort review pass that yields the completed reply before asking the provider's nano-tier `review` task for strict structured memory and skill proposals. Reviews are bounded to two iterations and never recurse through AgentHost.
- Durable memory suggestions now follow confidence-based medium/long tiering and the condenser's symmetric near-duplicate merge behavior; invalid kinds and malformed model output are ignored without affecting the turn.
- Repeatable-workflow suggestions enter the existing proactive suggestion pipeline as pending skill candidates, never write a skill silently, and review results are persisted to `background-review/reviews.jsonl` plus surfaced on the runtime/Discord activity feed.
- Added the live `OPENAGI_BACKGROUND_REVIEW` setup field (default OFF) and regression coverage for substantive scheduling, conversational skipping, failure isolation, de-duplication, tiering, persistence, and pending-skill routing.
BACKGROUND REVIEW PHASE COMPLETE

## 2026-07-21 — Per-tool MCP advertisement and in-band discovery (Codex)

- Replaced whole-server MCP cap selection with deterministic per-tool round-robin selection. Core tools remain first and unrelated MCP servers each contribute useful representatives without letting a giant catalog monopolize the schema budget.
- The registry now exposes a compact overflow notice to AgentHost, which inserts it into the model's per-turn context only when truncation occurred. It reports omitted counts and directs the model to discovery plus `run_mcp_tool`; under-cap schema arrays remain byte-identical.
- Added the specified read-only `searcmcp_tools` tool over the complete uncapped MCP catalog, ranked by query overlap across server, names, and descriptions.
- Validation: `npm test` and `npm run test:prod-policy` both pass 659/659.
MCP PER-TOOL PHASE COMPLETE

## 2026-07-21 — Bundled work-plan mode v0 (Codex)

- Added a parser-safe bundled `work-plan` skill that directs the model to inspect real paths, write commit-sized numbered steps, state dependencies and risks, and attach focused verification to every step before execution.
- Kept the existing Discord `/plan` daily-planner command unchanged, avoiding a semantic collision. The v1 turn flag, persisted plan artifact, step-state tracking, and optional approval rail are deferred as the scaffold explicitly permits; they require a product choice for the command/tool surface.
- Added a real SkillRegistry load/view regression using a fake runtime and the bundled directory.
- Validation: `npm test` and `npm run test:prod-policy` both pass 656/656.
PLAN MODE PHASE COMPLETE

## 2026-07-21 — Memory recall rebalance and condenser hygiene (Codex)

- Replaced conflicting flat tier multipliers with one query-gated scoring model: strength is the base, matching principles/corrections/specific memories earn proportional boosts, and fresh short memory receives only a small overlap-weighted recency nudge. Unrelated principles no longer surface from an unconditional bonus.
- Condenser confidence now controls durability: high-confidence output may enter long memory, while medium and low—including deterministic fallback—land in decaying medium memory at calibrated strength with `critical:false`.
- Near-duplicate principles in the same scope are merged instead of duplicated. Their source ids and strength are combined, and every new source records the existing `condensedInto` id.
- The optional FTS/vector recall index is deferred; the confirmed ranking and permanent-fallback pollution bugs are fixed without adding a new persistence dependency. Validation: `npm test` and `npm run test:prod-policy` both pass 655/655; live daemon condensation was skipped under the isolation constraint.
MEMORY HOT PATH PHASE COMPLETE

## 2026-07-21 — Tool-output caps and context compaction (Codex)

- Both provider loops now cap serialized tool results at `OPENAGI_MAX_TOOL_OUTPUT_CHARS` (default 8000). Oversized values keep head/tail evidence plus an elision marker and are persisted under a strict `out_<hex>` ref; the read-only `read_tool_output` tool retrieves bounded chunks without path traversal.
- Added deterministic inherited-history and iteration-boundary compaction via `OPENAGI_CONTEXT_COMPACT_CHARS` (default 120000) and `OPENAGI_CONTEXT_KEEP_RECENT_HOPS` (default 4). Only an old prefix is recapped; the current user turn and recent hops remain verbatim, and pair-boundary adjustment prevents orphaned function/tool calls.
- Under-cap values and short request bodies remain byte-identical. Tests demonstrate a 220-character model payload retaining a retrievable 1,000-character result and a reduced transcript with intact recent pairs for both provider shapes.
- Validation: `npm test` and `npm run test:prod-policy` both pass 651/651. Live token-usage comparison was skipped to honor strict isolation from Azazel's daemon.
CONTEXT COMPRESSION PHASE COMPLETE

## 2026-07-21 — In-channel approval suspension and same-turn resume (Codex)

- Pending actions now carry non-serializable decision/completion promises. A gated invocation parks for up to `OPENAGI_APPROVAL_TIMEOUT_MS` (default 300000), emits `awaiting-approval`, and returns the real approved tool result—or a model-visible denial, cancellation, or timeout error—inside the original turn.
- Catastrophic approvals and auto-approve-off gates share the same suspension rail; default-on auto-approve remains byte-compatible. Approval metadata still appends the Hermes audit note to the tool result seen by the model.
- Discord buttons, text/slash approvals, HTTP approvals, and outreach approvals now use one first-click-wins resolver. Live suspended calls resume themselves, restart-era persisted actions execute through the same helper, completion is recorded, and concurrent approvals cannot double-run a side effect.
- The model stall watchdog needed no production change because it exists only inside the provider HTTP request and is cleared before tool execution. A regression holds an Anthropic tool approval beyond four stall windows and proves the same turn resumes; the overall turn abort signal still cancels a parked approval safely.
- Validation: `npm test` and `npm run test:prod-policy` both pass 645/645. Live Discord/HTTP probing was skipped under the operator's strict isolation from Azazel's daemon.
APPROVAL SUSPENSION PHASE COMPLETE

## 2026-07-21 — Provider retry resilience and tool transcript repair (Codex)

- Added a shared bounded provider-request retry layer for both OpenAI Responses and Anthropic Messages. Network failures and HTTP 429/500/502/503/504/529 use exponential full-jitter backoff, honor bounded `Retry-After`, emit advisory retry progress, and end as a typed `ProviderError`; 400/auth/caller-abort failures are never retried.
- Added `OPENAGI_PROVIDER_MAX_RETRIES` (default 3) and `OPENAGI_PROVIDER_RETRY_BASE_MS` (default 500) to both provider configurations and the setup allowlist. Exhausted retryable failures now preserve completed work through a graceful partial answer instead of discarding the turn.
- Forced-final requests now reconcile dangling OpenAI `function_call` and Anthropic `tool_use` entries. Completed Anthropic results are attached incrementally, while only unstarted calls receive synthetic error results.
- Same-endpoint fallback-model failover remains deferred: the spec marks it optional, while a correct key/base-url selection policy needs explicit operator configuration. Live fault injection was skipped to preserve the operator-mandated isolation from Azazel's daemon.
- Validation: `npm test` and `npm run test:prod-policy` both pass 637/637.
PROVIDER RESILIENCE PHASE COMPLETE

## 2026-07-21 — Discord per-user sessions and per-key concurrency (Codex)

- Replaced the global Discord turn promise with garbage-collected per-session promise tails, preserving message order within one conversation while allowing unrelated users and channels to run concurrently.
- Guild session ids now include the author id to prevent shared-channel context bleed; one-to-one DMs retain their historical channel key. Approval and activity routing accepts both key shapes.
- Added deterministic deferred-promise coverage for cross-key overlap, same-key serialization, lock cleanup, session identity, and four-segment activity routing.
- Validation: `npm test` and `npm run test:prod-policy` both pass 628/628. The live-daemon probe was deliberately skipped because the operator required strict isolation from `/home/usapcool/openagi`; no service was contacted or restarted.
DISCORD CONCURRENCY PHASE COMPLETE

## 2026-07-21 — Stall-aware timeout + force-an-answer on every early stop (Seraphim)

Creator's ask: the harness should check whether the LLM is **still trying** instead of
straight-up aborting — a model still producing output (Kimi is slow) shouldn't be killed for
taking long — and when a turn IS cut short it should **force the model to give an answer**
(like Hermes forcing a reply at the iteration cap) rather than returning nothing.

- **Stall detection replaces the blind per-request timeout while streaming** (`src/model-provider.js`).
  Confirmed the Kimi endpoint streams SSE token-by-token (incl. `thinking_delta`). The main loop
  now **streams internally even when Discord streaming/onDelta is off**, purely to get the "is the
  model still trying?" signal. `readAnthropicEventStream` fires a new `onActivity` callback on every
  streamed chunk; `postMessages` arms an **idle timer that resets on each chunk**. A model still
  emitting tokens is never aborted for being slow — only genuine silence past the stall window
  (`OPENAGI_STALL_TIMEOUT_MS`, default 120s) trips a typed `ModelStallError`. The fixed per-request
  timeout remains the absolute backstop; `stallTimeoutMs=0` disables stall detection and restores
  the pure non-streaming path.
- **Force-an-answer on every early stop.** The iteration-cap salvage (a final "stop, no tools,
  answer now" model call) is generalized to fire for **iteration-cap, stall, request-timeout, AND
  turn-timeout**. New `forceAnswerPrompt(reason,…)` tailors the nudge; the forced call carries no
  tools (can't loop again), a fresh short budget (`OPENAGI_FORCE_ANSWER_MS`, default 60s), and is
  non-streaming. If the forced answer itself fails, it falls back to the canned partial summary —
  the turn never dies silently. Applied symmetrically to both providers.
- New knobs (in `WIZARD_FIELDS`): `OPENAGI_STALL_TIMEOUT_MS`, `OPENAGI_FORCE_ANSWER_MS`.
  `ModelStallError` is classified recoverable alongside `RequestTimeoutError`; `stalled` gets its
  own `stopReason` + partial-summary text.
- Tests: 5 net-new in `model-provider-iterations.test.js` — silent stream → `stalled` + reply,
  **slow-but-alive stream (6 deltas 20ms apart, 120ms > 40ms window) completes, NOT aborted**,
  wall-clock now forces an answer, request-timeout with stall disabled. Updated the voice-streaming
  test to reflect internal streaming. **624/624 both lanes** (was 622).
- **Live-verified post-restart:** casual question → completed 7s; a 49s heavy-reasoning turn (well
  past the old 120s-per-request cap) → `completed` with a full 6-paragraph answer, NOT falsely
  stalled — proving the idle timer resets on tokens against the real Kimi endpoint. No daemon errors.
STALL-AWARE TIMEOUT + FORCE-ANSWER COMPLETE

## 2026-07-21 — Fix: heavy turns aborting with "This operation was aborted" / no reply (Seraphim)

- **Symptom (Creator-reported):** asking Azazel an open-ended heavy question ("do a deep dive on your harness…") produced NO reply and a cryptic `⚠ This operation was aborted`; turns "took forever" then died. Confirmed in `channels/discord/events.jsonl`: inbound 11:50:50 → `turn-error: "This operation was aborted"` at 11:56:48 (~358s later). Three such aborts (03:39, 03:42, 11:56) — a **pre-existing bug**, not the fast-lane change or the daemon restart (the restart came AFTER the abort).
- **Root cause (`src/model-provider.js`):** each single model request was capped by a **hard-coded 120s fetch timeout** (`this.timeoutMs = 120000`). When kimi reasons long on one hop, the fetch hits 120s and `controller.abort()` fires with no reason → undici throws the raw string `"This operation was aborted"`. That raw `AbortError` was only normalized to a graceful `TurnDeadlineError` when `deadlineLimited` was true (late in a turn); early on it was re-thrown, and the turn loop's `deadlineExpired()` didn't recognize it (120s ≪ 900s wall-clock), so it did `throw error` — **killing the entire turn, discarding all partial work, surfacing the raw string with no reply.**
- **Fix (both providers, symmetric):**
  1. New typed `RequestTimeoutError` — the per-request timer now sets a `timedOut` flag and the fetch catch converts its own abort into `RequestTimeoutError` instead of leaking undici's raw string. (Caller-initiated aborts and the wall-clock `TurnDeadlineError` paths are unchanged.)
  2. The turn loop (model-call catch + tool-invoke catch, both providers) treats `RequestTimeoutError` as a **recoverable** stop: `stopReason = "request-timeout"`, break, and emit a graceful `localPartialSummary()` (prior text + completed tool calls + "raise OPENAGI_REQUEST_TIMEOUT_MS"). A slow hop can no longer nuke the whole turn.
  3. Per-request timeout is now env-configurable via **`OPENAGI_REQUEST_TIMEOUT_MS`** and the default is **raised 120s → 300s** (a heavy first hop no longer aborts). Whole-turn ceiling `OPENAGI_MAX_TURN_SECONDS` (900s) is unchanged. Added to `WIZARD_FIELDS` so `/setup` can tune it.
- Tests: 3 new regressions in `model-provider-iterations.test.js` — per-request timeout stops gracefully & never leaks the raw abort string (both providers), and `OPENAGI_REQUEST_TIMEOUT_MS` override/default. **622/622 both lanes** (was 619). Homoglyph scan clean on all 3 changed files.
- **Live-verified post-restart:** the exact request that aborted before ("upgrades you'd make to your harness…") now returns a clean 4-bullet answer in ~15s, `stopReason:"completed"`. Health endpoint green.
- Honest note: my earlier fast-lane QA covered the casual-chat lane I built, NOT long heavyweight work-turns — this abort class was outside that test surface. Now covered.
REQUEST-TIMEOUT ABORT FIX COMPLETE

## 2026-07-21 — Chat fast-lane band-gate fix (Seraphim)

- **Fixed: the conversational fast lane never fired in production (inert feature).** The gate in `isConversationalTurn()` (`src/agent-host.js`) required scrutiny verdict `ignore`/`watch`, but a genuine casual question (`"what is the capital of France?"`) scores `act`@~0.57 on the live 3-judge panel — so the exact turns the fast lane was built to optimize never qualified. Live probe before fix: `conversational:false`, `maxIterations:120`, full ~57-tool catalog still sent.
- **Root cause:** `watch`/`ignore` are the LOW-signal/noise bands, not "casual chat." `act` on a plain question just means "answer it confidently" — that IS the fast-lane case. The real chat-vs-work separator is the task/imperative filter (`detectTaskInChat` + `hasImperativeToolIntent`), already in the code, not the verdict band.
- **Fix (small, no regression):** broadened the band gate from `verdict ∈ {ignore, watch}` to `verdict ∉ {ask, propagate}` (i.e. `act` now qualifies), keeping the task/imperative filters + low-risk check as the real guard. Escalation via `run_mcp_tool` unchanged, so no depth loss. Also excluded specialists from the fast lane (a latent bug the change surfaced: a scoped specialist turn would otherwise be trimmed to the generic `CHAT_CORE_TOOLS` allowlist, discarding its bounded scope).
- **Test discipline (anti over-fit-to-fixture):** the old `chat-fastlane.test.js` HARDCODED `scrutiny.action="watch"` in its fixture, proving the mechanism worked *if* the verdict was watch — never that a real input produces that verdict, which is why the dead feature passed 617/617. Added: an `act`-band fast-lane test, and a **band-independence** test driving the REAL `ScrutinyPanel` (documents that the same question scores `watch` cold / `act` warm depending on store state — proving the gate must not key on the band). Repaired two tests that legitimately began fast-laning (`verdict-consequences`, `specialist-bounds`) by feeding them imperative inputs so they exercise the pure verdict→policy path.
- Tests: **619/619 pass on BOTH lanes** (`npm test` + `npm run test:prod-policy`), up from 617. Homoglyph byte-scan clean on all 4 changed files.
- **Live-verified on the running daemon** (authed `POST /message`, post-restart): casual `"what is the capital of France?"` → `conversational:true`, `maxIterations:4`, reply "Paris"; work request `"please search the repo for TODO comments…"` → `conversational:false`, `maxIterations:120`. Both directions correct — pure token/latency win, zero reasoning loss.
CHAT FASTLANE BAND-GATE FIX COMPLETE

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

## 2026-07-21 - Hermes-style parallel subagents (Codex)

- Added `delegate_task` for one isolated goal or up to three concurrent child goals, using `Promise.allSettled` so one failed child cannot erase successful summaries.
- Child isolation is explicit: a fresh `subagent:<parent>:<uuid>` transcript, a unique memory scope carried through signal storage and the `remember`/`recall`/`correct_memory` tools, no parent conversation or ambient screen context, no automatic specialist routing/propagation, and only the final reply returned to the parent.
- Enforced parent-or-stricter scrutiny, parent allowlist intersection, leaf/orchestrator depth ceilings, removal of interactive and legacy delegation tools, and the existing catastrophic gate on every child tool call.
- Added per-call provider limits so concurrent children share one provider and daily budget without mutating it: 30 iterations and 600 seconds by default. Parent deadlines/cancellation now abort outstanding child requests through both provider paths.
- Added live Discord `delegating n/total` progress plus environment/wizard settings for child count, spawn depth, iterations, and wall-clock time.
- Added regressions for summary-only transcript isolation, private core-tool memory, disabled auto-propagation, concurrent partial failure, depth attacks, both-lane watch enforcement, shared budget accounting, per-provider caps, cancellation, live status, validation, and config persistence.
- Validation: `npm test` and `npm run test:prod-policy` each pass 588/588; all changed filenames and contents pass the homoglyph scan.
SUBAGENTS PHASE COMPLETE

## 2026-07-21 - Hermes-compatible session context search (Codex)

- Added the intentionally named read-only `searcmcp_sessions` ABI over the existing `SessionIndex`, returning bounded raw `{sessionId, ts, role, snippet}` hits without exposing full transcripts.
- Clamped result limits to 1..20, handled empty and missing-index cases safely, and preserved the existing `search_sessions` contract for current callers.
- Added SQLite and forced-JSONL-fallback regressions for result shape, no-hit behavior, limit handling, scrutiny enforcement, and invocation-runtime isolation.
- Validation: `npm test` and `npm run test:prod-policy` each pass 593/593.
CTX SEARCH PHASE COMPLETE

## 2026-07-21 - Voice replies with pluggable TTS (Codex)

- Added the side-effecting `speak` tool with private UUID-named audio caching and Discord MP3 attachment delivery; non-Discord turns degrade to returning the cached path.
- Added a zero-dependency provider layer for the `edge-tts` CLI plus env-gated OpenAI and ElevenLabs HTTP APIs, with live provider/voice configuration, a 4000-character cap, request timeouts, secret-safe errors, and clear missing-CLI guidance.
- Kept `speak` inside the normal tool registry so scrutiny, approval, audit, specialist bounds, and the catastrophic gate remain authoritative.
- Validation: `npm test` and `npm run test:prod-policy` each pass 601/601.

## 2026-07-21 - Kimi SSE and Discord streaming replies (Codex)

- Verified live before implementation: the configured `https://api.kimi.com/coding/v1/messages` endpoint with `kimi-k3` returned HTTP 200 and `text/event-stream;charset=utf-8` for `stream:true`, with ordered Anthropic message/content delta events assembling `STREAM_OK`.
- Added an Anthropic SSE parser that reconstructs complete messages for the existing iteration/budget/tool loop while forwarding only user-visible text deltas; thinking and tool-input JSON remain internal.
- Added opt-in, live-read `DISCORD_STREAMING` delivery (default off) with 1.2-second throttled edits, exact final-text reconciliation, and deterministic rollover before Discord's 2000-character limit.
- Validation: `npm test` and `npm run test:prod-policy` each pass 609/609.
VOICE STREAMING PHASE COMPLETE
ALL PARITY PHASES COMPLETE

## 2026-07-21 - Isolate nightly self-QA from live channels (Codex)

- Run `code_test` with a cloned, scrubbed child environment that removes Discord/Telegram credentials, channel routing, and every `*_WEBHOOK_SECRET`, while setting `OPENAGI_TEST=1`.
- Make `ChannelManager` bind explicit null Discord and Telegram tokens in test mode, and make an explicitly supplied null Discord token authoritative rather than falling back to the daemon environment.
- Preserve inherited environments for `code_shell`, `code_lint`, and every other subprocess path.
- Validation: `node --test` passes 611/611 (0 failed).

## 2026-07-21 - Add a conversational chat fast lane (Codex)

- Classify only interactive, low-scrutiny, non-task, non-imperative turns as conversational; expose that decision on the returned turn and outcome audit metadata.
- Advertise only `recall`, `remember`, `list_sessions`, `schedule_message`, `run_skill`, and `list_skills` on those turns in both OpenAI- and Anthropic-shaped requests, without changing scrutiny or invoke-time gates.
- Cap conversational turns at four iterations by default with a live `OPENAGI_CHAT_MAX_ITERATIONS` override; task, imperative, cron, autopilot, and subagent work retains its configured limit.
- Preserve legacy watch behavior for custom registries that contain none of the named chat-core tools, while leaving the normal unfiltered schema path unchanged.
- Validation: `node --test` passes 617/617 (0 failed).
SELFQA + FASTLANE PHASE COMPLETE

DISCORD LANE PARITY WAVE 2 COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: curator loop (Codex)

- Added a daily skill curator that ages agent-created skills from active to stale after 30 unused days and archives them after 90, with wizard-allowlisted threshold overrides.
- Kept bundled, pinned, and human-created skills exempt; archives remain on disk, leave the default model surface, and can be reactivated with restore_skill.
- Added an atomic per-run curator report, durable skill revision history for transitions and restores, boot-time cron wiring, and synthetic-time regression coverage.
CURATOR LOOP COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: persistent goals loop (Codex)

- Added durable per-session goal mode with JSONL journaling, atomic snapshots, monotonic revisions, turn budgets, and pause/resume/clear audit history.
- Extended both provider iteration engines with a cheap-tier completion judge, synthetic auto-continuation, fail-open judge handling, completion propagation, and CAS-guarded user preemption.
- Activated goal mode through add_goal, added four agent-facing control tools plus Discord /goal controls, and serialized resumed Discord work with normal message turns.
- Added provider, persistence, routing, tool, slash-command, schema-lane, turn-cap, completion, and mid-turn preemption regressions.
GOALS LOOP COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: cron control verification (Codex)

- Re-verified reversible cron enable/disable and destructive cancellation by job ID or name through the existing agent tools.
- Added durable provider/model snapshots for scheduled jobs, one-time legacy backfill, deliberate repinning on replacement, and fail-closed prompt/autopilot skips when the global default changes.
- Added structured mismatch alerts through runtime events, dashboard SSE, Discord activity, console diagnostics, and the durable outreach feed.
- Suppressed delivery only when the complete trimmed scheduled reply is exactly [SILENT], while preserving the assistant output in the durable session transcript.
- Added pinning, persistence, replacement, alert, toggle, exact-marker, near-miss, and transcript-audit regressions.
CRON CONTROL VERIFIED

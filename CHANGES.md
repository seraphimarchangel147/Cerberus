# Cerberus — Capability Changelog

Every Legion agent modifying this harness: append an entry here.

## 2026-07-26 — Wall-clock stops now report consumed checkpoint extensions (Azazel)

The soft-checkpoint guard worked invisibly: a turn that ran the base budget plus all
configured extensions ended with the same "wall-clock guard was reached" message as
the old hard stop, so from the outside the feature looked unshipped (Creator flagged
it after a long build turn ended with what looked like the legacy stop).

- `forceAnswerPrompt` and `localPartialSummary` now accept the turn's checkpoint
  state (`{ total, left }`); the turn-timeout text names the consumed extensions
  ("All N checkpoint extensions were consumed before this stop (the base window plus
  N extensions ran).") on both the forced-answer and canned-summary paths, in the
  OpenAI and Anthropic lanes alike.
- No behavior change to the guard itself: ping → extend → continue; exhaustion →
  graceful stop with a forced answer. Only the reporting changed.
- Regression: `checkpoint exhaustion summary names the consumed extensions` — the
  forced answer yields no text, so the canned summary must name the extension.
  Suite: 42/42 in `test/model-provider-iterations.test.js`, syntax gate green.

## 2026-07-27 - Upgrade batch work item D: skill-routing evals (Codex)

Added a deterministic, runtime-decoupled quality gate for the growing skill
catalog:

- Adapted only the MIT `addyosmani/agent-skills` Tier-2 evaluation design,
  pinned the inspected source commit in attribution headers, and included its
  full MIT notice. No upstream skill body or command file was imported.
- Added zero-dependency, description-only TF-IDF routing with light stemming,
  deterministic ordering, and tie-aware rank-1 scoring.
- Added strict one-case-per-skill coverage, realistic positive triggers,
  non-vacuous owner-labeled negatives, duplicate-prompt rejection, and
  configurable warning/error thresholds for description collisions.
- Added 65 trigger checks across all 13 bundled skills. The measured baseline
  is 87.2% unambiguous rank-1 (34/39), with no catalog collision warnings.
- Added a dedicated GitHub Actions ratchet at `--min-rank1 80`, with no package
  installation step, and the pre-I/O `OPENAGI_SKILL_ROUTING_EVAL=0` kill
  switch for manual/CI rollback.
- Added no dependency, behavioral model runner, runtime hook, upstream skill,
  or upstream command surface.

Verification: deterministic catalog gate 65 passed, 0 failed; focused harness
lane 13 passed, 0 failed; full isolated `node --test --test-concurrency=1`
lane on Node 25.5.0: 1867 passed, 0 failed.

## 2026-07-27 - Upgrade batch work item B.3: provider error classifier (Codex)

Made provider recovery distinguish congestion, exhausted quota, and silent
HTTP success without moving retries above the side-effecting tool loop:

- Added the MIT-attributed, zero-dependency provider outcome classifier using
  both HTTP status and bounded body text.
- Quota/billing 429s now carry a one-hour backoff, overridden by a valid reset
  header; other 429s carry a 60-second backoff.
- Credential pools persist those classified delays as per-key cooldowns and
  rotate immediately to another eligible key instead of retrying a cooled key.
- OpenAI and Anthropic HTTP 200 responses with no model content now retry
  below tool execution. `max_tokens` and `tool_use` empty stops remain valid.
- Added the setup-allowlisted `OPENAGI_ERROR_CLASSIFIER=0` kill switch. It
  restores the former jittered 429 retry and empty-response behavior.
- Added no dependency and did not change the package manifest.

Verification: focused error/provider lane 28 passed, 0 failed; full isolated
`node --test --test-concurrency=1` lane on Node 25.5.0: 1854 passed, 0 failed.

## 2026-07-27 - Upgrade batch work items B.1/B.2: complexity routing (Codex)

Added an opt-in, floor-only runtime complexity layer to model routing:

- Added the MIT-attributed OmniRoute-inspired additive classifier across code,
  context size, carried tools, reasoning, math, and domain vocabulary.
- Reproduced the specified defect red-first: the naive scorer routed a roughly
  50k-token plain payload to `nano` (0 passed, 1 failed) because context's
  additive contribution capped below the `mini` threshold.
- Added explicit 32k-token-class `base` and medium-context `mini` floors plus
  the mandatory any-tool `mini` floor. `escalateTier` is monotone and the
  classifier fails open to the static profile.
- Threaded the outgoing request shape through both paid provider loops.
  Explicit model/task pins remain authoritative; static task profiles are the
  baseline; runtime complexity may only choose a more capable tier.
- Added the setup-allowlisted `AGENT_ROUTING=static` default/kill switch.
  `AGENT_ROUTING=auto` is the only mode that enables runtime classification.
- Added an `OPENAGI_DEV_WARN=1` warning for genuine unknown router task names
  without changing the unrelated cron `task: "prompt"` discriminator.
- In auto mode, the model plan leaves Anthropic mini unset instead of
  recommending the nano model for memory-writing jobs. No model env was set
  because the source-listed IDs were not verified against a live API.
- Added no dependency and did not port OmniRoute's bandit, ELO, SLA, or
  questionable free-endpoint machinery.

Verification: focused classifier/router/provider lane 63 passed, 0 failed;
full isolated `node --test --test-concurrency=2` lane on Node 25.5.0:
1845 passed, 0 failed.

## 2026-07-27 - Upgrade batch work item B.0: routing ledger enrichment (Codex)

Made the per-provider-call budget ledger usable for later routing analysis:

- Added top-level `latencyMs`, `stopReason`, `task`, `attempt`, `inputTokens`,
  and `outputTokens` to new ledger rows while retaining the existing
  content-free efficiency and cost envelopes.
- Threaded task identity and one-based model-loop attempts through OpenAI,
  Anthropic, forced-answer, fallback, and goal-judge request paths.
- Input totals correctly include mutually exclusive cached-input buckets for
  OpenAI and the additive cache read/write buckets reported by Anthropic.
- Bounded every numeric field and restricted task labels to identifiers so
  user prompt text cannot enter the ledger.
- Added the setup-allowlisted `OPENAGI_LEDGER_ENRICHMENT=0` kill switch, which
  omits all six fields and preserves the previous JSONL row shape.
- Added no dependency and did not change the package manifest.

Verification: focused ledger/provider lane 62 passed, 0 failed, 1 skipped;
full isolated `node --test --test-concurrency=4` lane on Node 25.5.0:
1830 passed, 0 failed.

## 2026-07-27 - Upgrade batch work item A: Legion-wide desktop lease (Codex)

Closed the live correctness hazard where separate agent sessions could both
pass their local computer-use guard and drive one shared physical desktop:

- Added a host-wide, atomic desktop lease with actionable agent/session
  identity, TTL and same-host PID liveness recovery, re-entrant acquisition,
  generation-counted takeover, and structured contention/lost-lease errors.
- Desktop sessions acquire before their durable session record, renew before
  every controller action, abort immediately if ownership changed, and release
  idempotently on normal end or startup failure.
- Lease acquisition, renewal, release, takeover, and contention now use the
  existing `ComputerUseLog` JSONL event channel. Browser-only sessions retain
  their prior behavior.
- Added setup-allowlisted configuration for
  `OPENAGI_DESKTOP_LEASE`, `OPENAGI_DESKTOP_LEASE_TTL_MS`,
  `OPENAGI_DESKTOP_LEASE_PATH`, and `OPENAGI_AGENT_NAME`; setting the first to
  `0` is the exact-behavior kill switch.
- Documented cross-WSL/Windows shared-path requirements and added the seven
  required lease regressions plus a no-orphan/audit integration check.
- No package manifest changed and no dependency was added.

Verification: focused computer-use/lease/ABI lane 129 passed, 0 failed; full
isolated `node --test --test-concurrency=4` lane on Node 25.5.0: 1829 passed,
0 failed.

## 2026-07-26 — Changelog backfill: six undocumented commits (Seraphim)

Audited the last 30 commits against this file and found **six that shipped code with no entry**.
Recorded below so the ledger matches the tree. Method: for each commit,
`git show --stat | grep CHANGES.md` — anything answering NO is an undocumented change.

Also correcting a stale claim in Azazel's status report: the OAuth wave is **already live**, not
waiting on a restart. He was restarted twice on 2026-07-26 (PATH fix, then attribution), so the
runtime is current — `GET /providers` returns `"oauth": true` on the Anthropic preset and the env
resolves `OPENAGI_MAX_TURN_SECONDS=1200` / `OPENAGI_WALL_CLOCK_CHECKPOINTS=3`. Nothing pending.

### Discord `chunkText` infinite loop — daemon-wedging (05ed650, Seraphim, 2026-07-25)

A live hang, not a cosmetic bug. `preferredChunkCut()` used `text.lastIndexOf(needle, limit)`,
which **can match at `limit` itself** — so a boundary found there returned `limit+1`/`limit+2`, a
cut LARGER than the limit it was asked to respect. `chunkText`'s re-fit loop then requested
`min(limit, cut-1)`, got the same oversized cut back, and never converged: a hard infinite loop
pegging the event loop at 100% CPU and wedging the whole daemon. Triggered by any reply with a
blank line at exactly char 1990.

- Scan from `limit - 1` and clamp every branch so the result is always `<= limit`, guaranteeing
  the re-fit loop makes progress.
- Defense in depth: a guard counter in the re-fit loop falls back to a hard slice rather than spin,
  plus a `cut <= 0` floor so the outer loop's `rest` strictly shrinks.
- Regression: `test/discord-streaming-chunking.test.js`.

### QA harness kept zero-dependency at boot (f182f69, Codex, 2026-07-26)

The Playwright QA wave added `axe-core`, `pixelmatch`, `playwright`, `pngjs` as hard
`dependencies` — but `src/web-qa.js` imported `pixelmatch`/`pngjs` at module top level, so booting
the runtime would fail outright if the optional packages weren't installed. Cerberus's
zero-dependency boot guarantee is load-bearing.

- Moved all four to `optionalDependencies`; `dependencies` is `{}` again.
- Added `loadVisualComparator()` — lazy, memoised dynamic import that returns `null` instead of
  throwing when the packages are absent.
- Also fixed a Node permission-model bug in `code_test`: `node --permission
  --allow-fs-read=<dir> --test <dir>/x.test.js` reports "Could not find" even when the directory is
  readable. Resolve/validate the path absolutely (traversal still rejected), then hand the runner
  the workspace-relative form.

### Playwright QA skip-guard completed for `axe-core` (22a683e + merge 1391cc9, Seraphim, 2026-07-26)

Found by running Azazel's suite after the above. The guard above was incomplete: `axe-core` is
optional too, but when it alone is missing **the browser still works**, so the run gets far enough
to fail `accessibility_unavailable` rather than failing navigation — different code, same root
cause, guard didn't catch it. Added that code to `playwrightUnavailableReason()`. Verified both
directions: with deps the test genuinely **executes** (1 pass, 0 skipped — not silently skipping),
without them it skips cleanly. Post-merge suite: 1821 tests, 1797 pass, 0 fail.

### Cerberus pet evolution ladder — dashboard companion (Seraphim, 2026-07-25/26)

Four commits, all in `src/hosted-interface.js`, none previously logged. Purely cosmetic — no
runtime, API or agent-loop surface touched.

- **`19aeb1e` — PRIME CERBERUS + settings panel.** Second form (80x64, 24-bit palette, chest rune,
  gold pauldrons, horns) with its own idle/thinking/working animations. Gear panel toggles the pet,
  size, glow and auto-evolution; stage + XP persist via `localStorage`.
- **`279f9f4` — 4-tier ladder + evolution animation + form switcher.** PUP → PRIME (100 XP) →
  ULTRA (300, 96x76 lava-cracked obsidian, gold crown crest, starburst chest gem, spiked bracers,
  dual tails) → OMEGA (700, 112x88, the apex form). XP is awarded per tool-call type the harness
  actually reports, so the ladder tracks real work.
- **`7872883` — ULTRA/OMEGA detail pass.** Removed the box border; golden V-chevron breastplate
  drawn after the necks/heads so the arms read as a plate; OMEGA-only CRT scanline overlay.
- **`a012492` — OMEGA molten overhaul.** New `PAL4` palette (molten obsidian + gold inlay, ember
  veins beneath the hide), contained radial fire halo with rising embers, ornate gold breastplate
  with chain arcs converging on a white-hot gem core.

Pairs with the two entries already logged for this feature (`PET ACTIVITY LANE COMPLETE`,
`PET EVOLUTION HUD COMPLETE`), which covered the reactivity lane and HUD but not the artwork.

## 2026-07-26 — Per-agent commit attribution + Legion-wide gh PATH audit (Seraphim)

Follow-up to the PATH fix below. Two things, both env-only.

**1. The PATH trap was Legion-wide, not just Azazel's.** Audited every user unit by reading each
daemon's real `/proc/<mainpid>/environ`:

| daemon | `gh` before | `gh` after |
|---|---|---|
| openagi-azazel | missing | ✅ |
| zerohermes-gateway (Ziz) | missing (bare default PATH) | ✅ |
| hermes-gateway-levi | missing (PATH had brew's *Cellar/node* only, not `bin/`) | ✅ |
| hermes-gateway-ramiel | missing (same) | ✅ |
| hermes-gateway-seraphim | ✅ already | ✅ |

Levi and Ramiel are the subtle case: their units *did* reference linuxbrew, but pinned
`Cellar/node/25.5.0/bin` (node/npm/npx only) — `gh` lives in `.linuxbrew/bin`, which was absent.
Grepping for "linuxbrew" would have called them healthy; only resolving `gh` on the actual PATH
caught it.

**2. Commits are now attributed per agent.** Each unit sets `GIT_AUTHOR_NAME`/`EMAIL` +
`GIT_COMMITTER_NAME`/`EMAIL` (Azazel, Ziz, Levi, Ramiel; Seraphim keeps the base identity), using
Gmail `+tag` addresses so they all still route to one inbox. Env vars override repo-level
`user.name`, so `~/openagi`'s configured `Seraphim` no longer wins — verified with a real throwaway
commit from Azazel's environ: `Azazel <seraphimarchangel147+azazel@gmail.com>`. **Push credential is
unchanged** — one shared token in `~/.git-credentials`; attribution is cosmetic-but-honest, not an
auth boundary. A true per-agent auth boundary would need separate GitHub accounts or deploy keys.

Verified post-restart: all four daemons `active`, `gh api user` → `seraphimarchangel147` and
`.permissions.push` → `true` from every environ, Azazel `GET /` → 200, Ziz re-registered his
Discord commands.

## 2026-07-26 — GitHub access for Azazel: gh CLI now on the daemon PATH (Seraphim)

Azazel had `git` but **no `gh`**. The systemd user unit inherited the bare default
`PATH=/usr/local/sbin:...:/snap/bin`, which omits `/home/linuxbrew/.linuxbrew/bin` — where `gh`
(and brew's `node`) live. So every `gh` invocation from his shell tool died with
`command not found`, and he could push over HTTPS but could not open PRs, read issues, or touch
the GitHub API.

- **Fix (env only, no code):** added an explicit
  `Environment=PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:<defaults>`
  to `~/.config/systemd/user/openagi-azazel.service`, then `daemon-reload` + restart.
- **No token was copied or duplicated.** `gh` reads `~/.config/gh/hosts.yml` and git reads
  `~/.git-credentials` — both already present in the shared home the daemon runs as. Azazel
  inherits the same `seraphimarchangel147` credential; there is exactly one token on the box.
- **Verified from the daemon's own environment** (`/proc/<mainpid>/environ` replayed into a
  subprocess): `gh api user` → `seraphimarchangel147`, `repos/.../Cerberus .permissions.push` →
  `true`, `git ls-remote origin` → resolves. Daemon `active`, `GET /` → 200, authed
  `GET /pending-actions` → 200.

## 2026-07-25 — Provider OAuth: subscription sign-in for Anthropic + OpenAI (Azazel)

Closes the last gap in the Models & Providers lane: real OAuth login flows, requested by the
Creator ("oauth not added for xai anthropic and open ai"). xAI deliberately stays API-key-only —
there is no consumer OAuth app to authorize against (hard-won note preserved in
`provider-presets.js`).

- **New module `src/provider-oauth.js`.** Authorization-code + PKCE, paste-style so it works on
  headless boxes with no local callback listener. Anthropic: claude.ai shows a `code#state` pair on
  the console callback page. OpenAI: auth.openai.com redirects to the Codex CLI's registered
  localhost:1455 callback; the user copies the full URL from the address bar. Universal parser
  accepts `code#state`, full redirect URLs (with `error=` detection), and rejects bare codes
  (state must verify — CSRF hard-stop). Flows are single-use, 10-min TTL, 32 pending max. Client
  IDs default to the well-known public first-party CLI clients and are overridable via
  `OPENAGI_ANTHROPIC_OAUTH_CLIENT_ID` / `OPENAGI_OPENAI_OAUTH_CLIENT_ID`.
- **Credential-pool integration.** On completion, tokens persist through the audited saveEnv lane
  (`ANTHROPIC_OAUTH_TOKEN` / `OPENAI_OAUTH_TOKEN` + refresh secrets, now in WIZARD_FIELDS), and
  `upsertOAuthPoolEntry()` registers a `type: "oauth"` lease in `credential-pools.json` — the
  provider already honors `lease.type === "oauth"` by sending `authorization: Bearer`
  (model-provider.js). The env API key is appended as a rotation fallback, never deleted.
- **Token refresh.** `providerOAuthRefresh()` matches the credential-pool `refreshOAuth` hook
  signature and is wired into every provider rebuild path touched here (/setup/save,
  /providers/activate, /providers/oauth/complete); refreshed access tokens write back to the
  secrets store through the pool's existing persistence.
- **Routes.** `POST /providers/oauth/start` (authorize URL + instructions) and
  `POST /providers/oauth/complete` (exchange, persist, pool register, live provider rebuild when
  the lane is active). Default-project-only, same policy as the other provider routes.
  `GET /providers` now reports `oauthConnected` per preset.
- **Models tab UI.** OAuth-capable presets get a "Connect with <label> ↗" button (start → open
  vendor page → paste code → complete → live re-render), an `oauth` badge, and "Make active"
  enables for OAuth-connected presets. API-key paste remains untouched as the fallback.
- **Verification.** Lint clean on all touched files; smoke test green (both authorize URLs,
  all parser shapes incl. vendor-error URLs, pool upsert, secret-name mapping).


## 2026-07-24 — Cerberus dashboard: Hermes-style shell, no login, rebrand (Seraphim)

Overhauled the hosted web interface (`src/hosted-interface.js`) to match the Hermes dashboard
look, remove the local login wall, and rebrand OpenAGI → Cerberus. Requested by the Creator.

- **Login removed for local operators.** Added `isLoopbackPeer(req)`; the auth gate now bypasses
  sign-in when the TCP peer is loopback (127.0.0.1 / ::1). The daemon binds 127.0.0.1 by default,
  so the local dashboard opens straight to content — no Bearer-token page. The `OPENAGI_AUTH_TOKEN`
  still gates paired REMOTE nodes (non-loopback peers) and the secrets API, so the node fabric
  keeps its protection. `src/auth.js` untouched.
- **Layout → Hermes-style left rail.** Replaced the top header + "More ▾" dropdown with a fixed
  vertical navigation rail: Cerberus wolf brand at top, all 19 tabs grouped under
  Workspace / Build / Diagnostics labels (was 5 primary + 11 hidden behind a dropdown), each with
  an icon; Setup pinned to a bottom footer. Live status pills moved into a slim topbar in the
  content column. Added a narrow-viewport collapse (icons-only under 820px). Removed the now-dead
  `initNavMore` dropdown JS. Tab-switching keys off `nav button[data-tab]` as before, so all
  render/refresh wiring is unchanged.
- **Rebrand.** OpenAGI/openAGI → Cerberus across all 18 user-facing strings (title, brand, chat
  placeholder, welcome card, notifications, board copy, console logs). Left the real filesystem
  path `~/Library/Application Support/OpenAGI/inbox/` and all `OPENAGI_*` env vars / internal
  identifiers untouched.
- Verified: `node --check` clean; auth/hosted/moa test files green; live throwaway instance on a
  temp data dir served the full 191KB dashboard to a loopback client with no login, correct
  branding, and working Chat→Health→Memory tab switches (no page JS errors).

## 2026-07-23 — Self-declaring conversational fast lane (Seraphim)

Follow-up to the fast-lane work below. Azazel could see the trimmed toolset but had no way to
KNOW he was trimmed — so a hidden tool read as "I only see ~6 tools / I have no lane," and the
only remedies were a trigger word or nagging him to remember `searcmcp_tools`. Now the fast lane
announces itself, every trimmed turn, with no trigger word.

- **New exported `formatFastLaneNotice(fastLane)`** (`src/agent-host.js`). When a casual turn is
  trimmed to `CHAT_CORE_TOOLS`, `handleMessage` computes a `fastLane` descriptor
  `{advertised, hidden}` (hidden = `toolRegistry.list().length - advertised`) and threads it into
  `turnContextForAgent`, which renders a short `[context]` section: it states the turn is on the
  token-saving fast lane, how many tools are held back, that nothing was removed, that the trim is
  automatic and NOT gated on any trigger word, and that `searcmcp_tools` (or just phrasing a work
  request) restores the full arsenal. Closes with a "use judgment — don't over-expand, don't
  report yourself blocked" nudge so it stays awareness, not a reflex to escalate.
- **Fires only on a genuine trim.** Gated on `conversational && !chatCoreUnavailable` and
  `hidden > 0`, so a full-lane work turn and a genuinely small toolset both stay silent (no
  mislabeling). Pure/exported for testing; zero change to the invoke-time scrutiny gate.
- Regression: `test/chat-fastlane.test.js` +4 cases (helper silent-vs-declaring, trimmed turn
  injects the notice into the model `turnContext` with the right hidden count + `searcmcp_tools`,
  full-lane work turn omits it). Both lanes 1096/1096 green. Homoglyph-clean. Live-verified by
  importing the running-tree export and rendering the notice; daemon restarted 17:59 on the new code.

## 2026-07-23 — Discord/Legion awareness + sibling send lane (Seraphim)

Fixes Azazel reporting "I only see ~6 tools" and "no lane to Seraphim from this seat."

- **send_message now reaches Discord and siblings.** Widened the tool schema from `channel: [telegram, local]` to `[discord, sibling, telegram, local]`. `channel:"sibling"` resolves an agent NAME (e.g. `seraphim`) to the Discord channel where that sibling listens and delivers over Discord — the underlying `channels.deliver()` already routed Discord, the tool just never advertised it. Unknown sibling → actionable error listing known names (never a silent no-op).
- **New `src/legion-siblings.js`** — the Legion routing table (builtin defaults for Legion's server: seraphim/azazel/home), overridable via `OPENAGI_LEGION_SIBLINGS` env (JSON) or `<dataDir>/legion-siblings.json`. Malformed override falls through to builtins, never breaks routing.
- **Discord/Legion turn context.** Inbound Discord turns now inject a `formatLegionContextBlock` section telling the agent it's Azazel in a Discord server, which channel/server this turn arrived in, and that it CAN message siblings (with the exact tool call). Previously an inbound turn carried only `[author] text` — the agent had no idea it lived in Discord or that a send lane to Seraphim existed.
- **Chat-core fast-lane no longer hides the send lane.** Added `send_message` + `searcmcp_tools` to `CHAT_CORE_TOOLS`, so even a casual/QA turn (which the conversational fast-lane trims to the core set) keeps a way to reach out and to discover the full toolset on demand. This is the direct cause of the "only 6 tools visible" report: the fast-lane allowlist WAS the 6 tools. (Bridge names tool_search/tool_describe/tool_call are intentionally NOT hardcoded — they're injected dynamically and would falsely trip toolSearchBridgesActive().)
- **`runtime.dataDir`** now exposed on AbiRuntime so tool handlers can read per-agent config without threading subsystem options.
- **send_message returns a clear `{delivered, status}` envelope.** The Discord transport returns `{text, candidates, successfulCandidates}` where `candidates` are FILE ATTACHMENTS — a plain text message has zero, which the model misread as "nothing delivered" on the first live probe. The handler now wraps every send with an explicit `delivered` boolean + human `status` string (raw transport kept under `transport`).
- Regression: `test/legion-siblings.test.js` (9 cases: resolve case-insensitive/unknown/env-override/malformed, chat-core send lane present, context block fires only for discord + names channel/server/sibling lane + DM path). Both lanes 1084/1084 green. Homoglyph-clean.
- **Adjacent root-cause found + fixed (config regression, not from this change):** Azazel's model was dead — every turn 401'd because `ANTHROPIC_BASE_URL` (`https://api.kimi.com/coding/v1`, his Kimi coding endpoint) had been dropped from the secrets snapshot (`~/.openagi/secrets/secrets.json`, source of truth that projects `.env` on boot), so the AnthropicProvider defaulted to `api.anthropic.com` and his Kimi key was rejected. Restored via `POST /setup/save {ANTHROPIC_BASE_URL}` (persists to the snapshot, survives restart). Verified: Kimi online, and Azazel sent his first-ever sibling message to Seraphim's #seraphim-chat over the new lane.
## 2026-07-25 - Explainable governed tool decisions (Codex)

- Added a bounded, immutable `receipt.decision` to every finalized tool call, covering input snapshot and contracts, project/profile/capability scope, scrutiny, hooks, approval, checkpoints, authority refresh, resource leasing, dispatch, handler outcome, semantic verification, output contracts, and final outcome.
- Kept the representation token-efficient as one fixed-ASCII path with an explicit gate count and truncation bit, the decisive `blockedAt` gate, and only the slowest gate timing alongside the receipt's existing total duration.
- Preserved one receipt across tool-search forwarding and approval resume, while keeping pre-tool hooks and every authority boundary fresh.
- Kept pre-dispatch validation, scope, and preflight failures isolated from lifecycle observers while making their returned receipts explain the rejection.
- Extended Run Inspector with allowlisted decision path, decisive gate, gate count, truncation, and slowest-gate metadata; invalid or content-bearing fields are dropped rather than persisted.
- Preserved bounded decision provenance when oversized tool results are compacted for the next model hop, and taught the static system prompt to treat the receipt path as authoritative.
- Added policy-lane-independent regressions for success, handler failure, hook veto, invalid input, invalid output, forwarding, explicit manual approval, preflight observer isolation, immutability, redaction, durable Run Inspector projection, and compacted model output.
- Documented a clean-room comparison of Claude Code lifecycle hooks and isolated contexts, Hermes toolsets and progressive disclosure, Cursor diff review and remote-agent security, Agent Zero watchable surfaces, and Cerberus's internal enforcement gap.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1751/1752 tests with zero failures and one intentional platform skip; added lines are ASCII-clean, `git diff --check` passes, and `npm audit --audit-level=high` reports zero vulnerabilities.
EXPLAINABLE TOOL DECISIONS COMPLETE

## 2026-07-25 - Quality-preserving QA performance proof (Codex)

- Added exact per-result measurements for wall-clock duration, semantic actions, page loads, deterministic replay actions, blind retries, screenshot captures, decoded screenshot bytes, and screenshot capture duration.
- Added the read-only `qa_benchmark` tool and public performance-proof builder. Proofs are stable, project/session-scoped, content-free, and qualify only when terminal implementation, design, completeness, measurement, and owned-artifact evidence all pass.
- Compared actual semantic-first evidence with a clearly labeled screenshot-only pre/post-action counterfactual, while separating exact observations from estimated capture bytes and latency. Provider/model image tokens remain explicitly unavailable instead of being fabricated from bytes.
- Extended Run Inspector with allowlisted numeric QA efficiency counters only; page text, pixels, arguments, intent statements, and hidden reasoning remain excluded.
- Exercised bounded exploration across forms, navigation, dialogs, tables, accessible canvas controls, and desktop/mobile layouts, with successful completion and capture-reduction assertions.
- Tightened cancellation at route, control, state, candidate, and replay boundaries so no later semantic action starts after abort and partial evidence cannot qualify.
- Added durable exact-tuple visual approval claims with JSONL authority and atomic snapshots. Exact retries are idempotent, while project, manifest, source, run, or result substitution fails closed across restart.
- Isolated throwing Run Inspector and event observers from QA execution, and added hostile page-injection, cross-scope benchmark, path-traversing upload, unsafe filename, malicious download-adapter, approval-replay, restart, cancellation, and redaction regressions alongside existing stale-pixel and secret-reflection coverage.
- Documented Phase 2 acceptance around semantic-first perception, deterministic correctness, visible evidence, safe recovery, and quality-preserving speed.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1745/1746 tests with zero failures and one intentional platform skip; `npm audit --audit-level=high` reports zero vulnerabilities.
QUALITY PERFORMANCE PROOF COMPLETE

HIGH ASSURANCE HARNESS PHASE 2 COMPLETE

## 2026-07-25 - Revision-matched intent and differential QA (Codex)

- Added immutable manifest intent criteria for behavior, visual, accessibility, keyboard, diagnostic, and state-graph oracles, with explicit ASCII fixture revisions and exact route, viewport, and control scopes.
- Added `qa_compare` and `qa_comparison_status`, plus a `referenceRunId` fast path on `qa_run`, so the harness can reuse owned QA evidence without another browser pass or require comparison in the original governed call.
- Required distinct source revisions and exact manifest, mode, project, session, workspace, fixture contract, and browser execution epoch compatibility before comparison; references must be earlier passing runs and candidates must be terminal.
- Separated implementation evidence from product intent and classified each criterion as intended, regression, improvement candidate, or review required using deterministic structural metrics rather than model judgment.
- Kept behavior, visual, accessibility, keyboard, diagnostic, and graph metrics independent; compared salted state graphs without state IDs or raw page content; and emitted concise code-based bug hypotheses with owned screenshot, graph, replay, trace, and diagnostic refs.
- Extended manual baseline approval to otherwise-passing runs blocked only by missing or changed visuals; an intended visual change passes only when the exact candidate pixels and source revision have a real human approval.
- Persisted differential reports through bounded fsynced JSONL authority plus atomic snapshots, strict recovery normalization, corrupt-suffix append refusal, bounded journal compaction, project/session containment, and input-digest idempotency.
- Bound coder QA checks to exact comparison receipts, preserved comparison IDs in revision-matched acceptance evidence, and failed closed when a required comparison is missing, swapped, failed, or review-bound.
- Extended content-free Run Inspector progress with comparison identity, design status, criterion counts, and the owned report ref; added fake-browser and real Chromium coverage for preserved behavior, regressions, stable graph structure, missing intended changes, improvement review, human-approved visual changes, incompatible epochs, durable recovery, and redaction.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1740/1741 tests with zero failures and one intentional platform skip.
INTENT DIFFERENTIAL COMPLETE

## 2026-07-25 - Bounded semantic UI state exploration (Codex)

- Extended `qa_run` with an `explore` mode that first proves the route and then builds a bounded breadth-first semantic state graph from fresh-page shortest-path replays.
- Added configurable state, depth, action, and wall-time budgets; exhausted budgets fail closed as incomplete evidence, cancellation remains explicit, and exploration never presents partial coverage as a pass.
- Added randomly salted state identities over page and accessible-control signals while persisting only opaque state IDs, control IDs, action kinds, structural counts, status, and owned evidence refs; graph and replay artifacts omit raw page text, input values, and typed content.
- Added deterministic transition oracles for declared postconditions, route intent, diagnostics, accessibility, keyboard navigation, readiness, busy state, disabled controls, dead controls, unexpected navigation, and expectations that cannot discriminate an action.
- Excluded destructive controls by default and required both a declared fixture and an explicit exploration opt-in before executing them.
- Captured screenshots only for material states and failures, retained traces only for failures, and emitted replay artifacts with the shortest known BFS path and exact failure codes.
- Extended durable QA summaries, public exports, tool schema, static model guidance, and content-free Run Inspector progress with explored states, transitions, actions, failed transitions, truncation, depth, and graph evidence.
- Added fake-browser and real Chromium coverage for successful graphs, raw-content omission, inert controls, minimized replay, trace retention, destructive-action gating, budget exhaustion, non-discriminating expectations, prompt visibility, and inspector redaction.
- Stabilized the slow-active OpenAI stream regression under full-suite load while preserving its proof that repeated stream activity resets a shorter stall watchdog.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1731/1732 tests with zero failures and one intentional platform skip.
STATE SPACE QA COMPLETE

## 2026-07-25 - Unified governed computer use (Codex)

- Added one project/session-scoped computer-use controller over the semantic browser and optional remote desktop node, with approved goals, explicit surfaces, hard mutation budgets, exact observation revisions, generation preconditions, and automatic post-action observations.
- Added `computer_observe` and `computer_act` as the preferred semantic-first agent path while retaining legacy desktop names for compatibility; every new agent-facing tool is bounded, registry-governed, capability-described, approval-aware, and documented in the static system prompt.
- Added cryptographic browser screenshot receipts and fail-closed visual coordinate actions that require a fresh viewport capture, exact SHA-256, matching live generation, in-bounds coordinates, and an explicit semantic-fallback reason; full-page and stale captures cannot authorize clicks, and visual fallback cannot initiate top-level navigation.
- Made unavailable desktop input fail honestly after intent logging, added fresh desktop screenshot verification after real actions, and preserved native image attachment handling for both model providers.
- Rebuilt computer-use persistence around content-minimized JSONL authority plus atomic snapshots, scoped active sessions, restart-safe observation and action budgets, structural evidence only, and irreversible omission of typed text, selections, screenshot bytes, OCR, and page text.
- Redacted managed secrets from goals, rationales, errors, node responses, lifecycle events, and audit records; private tool input cannot enter pending-action persistence or live visibility, and low-entropy text hashes are deliberately not retained.
- Extended Run Inspector with content-free computer strategy, observation revision, and verification status; added setup allowlisting for the missing `OPENAGI_COMPUTER_NODE` endpoint and a measurable two-phase high-assurance harness plan.
- Added scope, generation, visual freshness, full-page rejection, action-budget replay, managed-secret, private-event, prompt, provider, runtime, approval, red-team, and legacy-compatibility regressions.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1725/1726 tests with zero failures and one intentional platform skip.
GOVERNED COMPUTER USE COMPLETE

## 2026-07-25 - Live governed Run Inspector (Codex)

- Added one project-scoped operational timeline for agent turns, provider iterations, tool receipts, durable jobs, coder transactions, Web QA progress, verification, acceptance, rollback, and artifact evidence.
- Persisted a strictly allowlisted content-free event journal through fsynced JSONL plus atomic cache snapshots, with journal-authoritative replay, bounded per-run and global retention, latest-per-run compaction, valid-suffix recovery, hostile snapshot normalization, and same-ID project isolation.
- Kept observability advisory and fail-open across AgentHost, jobs, coder, and QA so an inspector or listener failure can never change execution; prompts, tool arguments, raw results, error messages, and model reasoning never enter the inspector journal.
- Added authenticated project-contained list, detail, SSE, and integrity-checked QA artifact endpoints with no-store responses, plus a live dashboard for status, tokens, checks, acceptance contracts, rollback state, screenshots, visual diffs, accessibility, keyboard coverage, traces, and historical durable jobs.
- Added restart, redaction, observer-failure, project-collision, post-snapshot replay, durable-job discovery, AgentHost lifecycle, SSE, HTTP authorization, and artifact-ownership regressions.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1706/1707 tests with zero failures and one intentional platform skip; added-line ASCII review and `npm audit --audit-level=high` are clean.
RUN INSPECTOR COMPLETE

## 2026-07-25 - Proof-carrying web QA and visual evidence (Codex)

- Added an opt-in, project-scoped Playwright QA controller that loads bounded version-1 manifests, inventories every interactive control, executes fixture-safe declared behavior in fresh sessions, and rejects unclassified, missing, disabled, expired-exemption, stuck-loading, console, page, and network failures.
- Added strict axe accessibility and keyboard reachability/focus audits, exact-origin loopback protection for local development servers, fresh-session action isolation, real Chromium coverage, and failure-only Playwright traces.
- Added content-addressed screenshot, diagnostic, diff, and trace artifacts with project/run authorization, SHA-256 integrity checks, authoritative JSONL bindings, atomic snapshots, 24-hour success retention, 30-day failure retention, and non-expiring approved baselines.
- Added deterministic PNG comparison with bounded decoded pixels, configurable diff thresholds, capture and strict modes, visual diff artifacts, and a manual-only baseline approval tool that ordinary confirmation and auto-approve cannot satisfy.
- Extended coder transactions with revision-bound browser, screenshot, accessibility, keyboard, and approved-visual evidence oracles so web failures roll back controller-owned edits rather than being described as success.
- Wired `qa_run`, `qa_status`, `qa_artifact`, and `qa_approve_baseline` through the governed registry, runtime opt-in, setup allowlist, public exports, and static model guidance. Added Playwright, axe-core, pixelmatch, and pngjs with zero audit findings.
- Validation: both full policy lanes pass 1700/1701 tests with zero failures and one intentional platform skip; added-line ASCII scan and `npm audit --audit-level=high` are clean.
PROOF CARRYING WEB QA COMPLETE

## 2026-07-25 - Revision-bound acceptance evidence graph (Codex)

- Extended durable coder transactions with immutable acceptance criteria that carry stable ASCII identities, intent statements, evidence oracles, and exact proving check identities.
- Bound every accepted criterion to the exact post-edit source digest and canonical verification receipt; stale evidence, incomplete evidence, non-test claims, objective drift, and deterministic failures all fail closed.
- Added stable check identities throughout the isolated verifier and agent-facing schemas while preserving legacy stored runs through explicit compatibility criteria.
- Added regressions for exact-revision proof, deterministic failure precedence, homoglyph rejection, intent tampering, unprovable criteria, visual self-certification, persistence, and criterion immutability.
- Validation: both full policy lanes pass 1683/1684 tests with zero failures and one intentional platform skip.
ACCEPTANCE EVIDENCE COMPLETE

## 2026-07-25 - Checkpoint-backed autonomous coder controller (Codex)

- Added a durable `coder_start` -> `coder_apply` -> `coder_status` transaction protocol that binds an objective, plan, inspected SHA-256 baselines, and mandatory checks before editing begins.
- Persists bounded, content-free run state through authoritative JSONL events plus atomic snapshots, uses revision CAS, scopes runs to their exact project/session/workspace, and reconciles interrupted edits or verification to a blocked state.
- Applies only declared one-operation-per-file `code_edit` and `code_write` mutations through the governed registry, retaining canonical child receipts and exact controller-owned post-edit tags.
- Accepts completion only with complete per-check isolated evidence; failed or incomplete verification automatically restores captured baselines, while cancellation and ownership drift fail closed for explicit inspection.
- Added human-confirmed exact-version rollback, file-resource coordination, runtime wiring, static agent guidance, nested-test-context scrubbing, and passing, failure, false-evidence, restart, conflict, persistence, and prompt regressions.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test -- --test-concurrency=1` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy -- --test-concurrency=1` each pass 1676/1677 tests with zero failures and one intentional Windows permission-mode skip.
AUTONOMOUS CODER CONTROLLER COMPLETE

## 2026-07-25 - Isolated deterministic code verification (Codex)

- Added `code_verify`, a read-only evidence gate that combines up to 16 syntax and targeted test checks without a shell.
- Every check runs in a separate bounded Node subprocess with single-test concurrency, cancellation, a hard timeout, capped output, project path confinement, and the existing credential-scrubbed test environment.
- Syntax directory walks skip dependency/build/state trees, symbolic links, and out-of-project targets; verification output is secret-redacted before it reaches the model.
- Added focused coverage for combined success, deterministic failure, redaction, traversal/symlink rejection, pre-abort behavior, registry schema, and environment scrubbing.
ISOLATED CODE VERIFIER COMPLETE

## 2026-07-25 - End-to-end tool cancellation rail (Codex)

- Added abort checks before preflight, security hooks, approvals, checkpoints, and handler dispatch so a cancelled turn cannot start new work.
- A cancellation observed after handler dispatch now returns `tool_execution_cancelled` with `changed:null` for mutations, retains checkpoint evidence, schedules workspace inspection, and never reports semantic success.
- Read-only cancellation stays explicitly unchanged, while every pre-dispatch cancellation carries a receipt proving `dispatched:false`.
- Resource-aware batches stop launching later waves after cancellation and mark unstarted entries as rejected instead of silently invoking them.
- `execute_code` now terminates its worker on turn abort, reports cancellation separately from timeout, and preserves receipts already collected from nested calls.
CANCELLATION RAIL COMPLETE

## 2026-07-25 - Canonical tool execution receipts (Codex)

- Added one bounded receipt to every semantic tool envelope with an opaque operation id, real tool name, status/code, dispatch fact, change certainty, and wall-clock timing; argument values and secrets never enter the receipt.
- Preserved the same receipt through approval suspension, auto-approval, persistent pending-action completion, provider batching, lifecycle events, and duplicate-accounting recursion.
- `execute_code` now returns a bounded list of child receipts while preserving its compact `callTool` result API, so nested work is no longer invisible.
- Oversized model-facing tool output retains compact outcome and receipt identity alongside its durable output reference.
- Documented receipt interpretation in the static model prompt and added direct, vetoed, failed, approved, persisted, nested, batched, and truncated-output regressions.
EXECUTION RECEIPTS COMPLETE

## 2026-07-25 - Fail-closed built-in security vetoes (Codex)

- Assigned every hook an immutable failure mode: built-in gateway security vetoes fail closed, while runtime/plugin/shell extensions and asynchronous observers remain fail open.
- Built-in exceptions, deadlines, and malformed verdicts now return terminal, non-approvable block verdicts with bounded provenance instead of silently permitting the tool call.
- Added a registry-level defense: if the entire hook callback fails unexpectedly, mutating tools are blocked with `security_hook_unavailable`; declared read-only tools may continue.
- Added regressions for thrown, timed-out, invalid, optional-extension, and whole-registry failure paths.
SECURITY HOOK FAILURE MODES COMPLETE
## 2026-07-22 — Discord session-key migration: recover orphaned transcripts (Seraphim)

- Fixed Bug #1: when the guild session key gained a `:user` segment (`discord:<guild>:<channel>` → `discord:<guild>:<channel>:<user>`), the pre-existing transcript was orphaned. Measured on the live store: `discord_..._1496557186900431100.json` held **63 messages** (stranded on the old key) while the new key started a fresh 4-message history — 63 messages of context went dark with no alias, fallback, or migration anywhere.
- Added pure exported helper `legacyDiscordKey(sessionId)` in `src/agent-store.js`: anchored regex maps a 4-segment guild key to its 3-segment ancestor, returns `null` for DM keys, already-3-segment keys, and any non-discord key. Unit-testable, no side effects.
- Added `migrateLegacyKey(newId, legacyId)` on `FileBackedAgentStore`: one-time, idempotent, never-clobbering recovery — if the new key already has messages it's a no-op; else it copies the legacy transcript (preserving `createdAt`, tagging `metadata.migratedFrom`) and leaves the legacy file in place for recovery. Safe to run on every turn.
- Wired into `src/agent-host.js` right after the sessionId resolves and before the first `appendMessage`: best-effort, `typeof`-guarded (in-memory store unaffected), wrapped in try/catch so a migration failure degrades to a fresh session and never breaks the turn. `sessionKeyFor` in discord-channel.js is deliberately unchanged — the 4-segment key is the intended scheme; we recover the old lineage into it, not revert it.
- Regression: `test/session-key-migration.test.js` — legacyDiscordKey derivation cases, migrate copy/idempotency/never-clobber/no-crash, and an end-to-end append proving the handleMessage path sees recovered history (N+1). Suite green 692/692 (baseline 682 + 10).

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

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: checkpoints and rollback (Codex)

- Added opt-in pre-mutation checkpoints for whole-file writes, anchored edits, and destructive shell rm/mv/sed operations, with one evolving checkpoint per directory and turn.
- Persisted byte-exact, mode-aware snapshots as content-addressed blobs with a durable JSONL journal and atomic index snapshot; disabled mode performs no checkpoint filesystem work.
- Added bounded diff previews, session-scoped listing, selective or whole-checkpoint restoration, and confirmation-gated agent and Discord rollback surfaces.
- Kept approval and catastrophic gates ahead of capture, blocked ambiguous or unsafe targets before dispatch, and preserved turn identity across suspended approvals and multi-tool iterations.
- Added store, registry, AgentHost, persistence, shell parsing, integrity, containment, prompt, setup, and Discord confirmation regressions in both approval lanes.
CHECKPOINTS COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: event hooks with veto (Codex)

- Generalized the catastrophic policy into the immutable first gateway hook in a three-tier gateway, plugin, and shell hook registry with deterministic first-block semantics.
- Added bounded fail-open hook execution, non-blocking serialized lifecycle observers, frozen redacted payloads, wildcard events, and allowlisted JSON-over-stdio shell hooks with a scrubbed environment.
- Wired pre/post tool events around actual dispatch while preserving catastrophic human approval, ordinary confirmation, scrutiny, session allowances, and approval replay without duplicate hook calls.
- Added durable-agent session and turn lifecycle events, authenticated browser session resets, and gateway startup/shutdown events with shutdown flushing.
- Proved the veto through the live HTTP gateway and added registry, tool-policy, lifecycle, shell-safety, mutation, timeout, and both-lane approval regressions.
HOOKS COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: dual-threshold compression and caching (Codex)

- Replaced silent 12-message truncation and unconditional character compaction with provider-local live-context compression: an actual-token 50% next-hop trigger and an independent 85% pre-request safety estimate.
- Preserved recent turns and complete tool call/result pairs, kept durable transcripts immutable, and added bounded deterministic summaries without model-pressure language.
- Added Anthropic static-system plus rolling three-message cache breakpoints on request clones; OpenAI requests remain marker-free.
- Added runtime and session cache-identity warnings for model, provider, endpoint, or credential changes without logging secrets or placing warnings in prompts, and kept injected routers authoritative.
- Added verified context-window maps and a wizard-allowlisted override, adaptive fail-closed sizing, protocol, boundary, force-answer, cache, and preemption regressions, plus live HTTP proof at the exact 50% boundary.
COMPRESSION COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: memory design details (Codex)

- Added an exact 2,200-character curated-memory projection with visible usage headers, pre-mutation overflow errors, no truncation or silent eviction, and atomic replacement-based consolidation.
- Persisted one scope-and-agent keyed memory snapshot before a session's first signal mutation, then reused its byte-identical block in OpenAI and Anthropic static instructions while keeping retrieval context volatile.
- Moved optional nano-tier learning to session end with bounded warm-cache digests, durable review watermarks, retry-safe lifecycle handling, graceful shutdown flushing, and explicit per-turn opt-out preservation.
- Kept specialist snapshots consistent with inherited main memory, made correction persistence atomic, and exposed curated and replaceable recall metadata so capacity errors are actionable.
- Added exact-boundary, JSONL and snapshot immutability, provider cache, host restart, correction, lifecycle, HTTP validation, graceful shutdown, and both-policy regression coverage.
MEMORY DETAILS COMPLETE

## 2026-07-22 - Hermes Parity Wave 3 Phase 1: Honcho external memory provider (Codex)

- Added a provider-neutral get/set/query user-model contract and an opt-in Honcho v3 adapter alongside the authoritative built-in memory system.
- Mirrored successful local remembers and corrections through direct Honcho conclusions, and augmented recall with representation-backed dialectic queries while preserving exact built-in-only behavior when disabled.
- Added stable ASCII-safe identities, cached and retryable workspace and peer setup, cancellable bounded requests, schema-validated results, explicit correction supersession, minimal-reasoning queries, private bearer handling, and secret-safe failures.
- Wired explicit runtime injection and OPENAGI_MEMORY_PROVIDER selection, wizard-allowlisted Honcho configuration, public exports, agent-facing memory guidance, and mock-backend coverage with no live-account dependency.
HONCHO COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 1: Legion secrets manager (Codex)

- Added an allowlisted secrets store with a private atomic snapshot, backward-compatible `.env` projection, masked metadata, a value-free JSONL audit trail, and cross-process mutation serialization.
- Added authenticated HTTP and owner-only ephemeral Discord list/set/remove surfaces, hid existing setup credentials, installed HttpOnly setup sessions, and routed runtime configuration writes through one store.
- Kept MCP, code, node, and direct-integration credential injection ephemeral and placeholder-only, with protected persistence paths, strict name and URL confinement, exact output/error/log redaction, and one-time legacy migration.
- Added crash-consistent pairing, secret-safe atomic-write cleanup, and regressions for store/runtime/HTTP/Discord/MCP/subprocess/checkpoint/migration/boot/pairing boundaries in both approval lanes.
SECRETS MANAGER COMPLETE

PARITY WAVE 3 PHASE 1 COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: Kanban board (Codex)

- Added a local SQLite multi-board Kanban store with blocker-safe lifecycle transitions, trusted process identities, per-attempt runs, comments, dependency links, structured handoffs, gateway notifications, a JSONL journal, and an atomic snapshot.
- Registered and documented all nine agent tools, plus authenticated HTTP, CLI, dashboard, SSE, and Discord activity surfaces over the same store.
- Enforced cross-board and cyclic-link rejection, immutable terminal tasks and runs, worker-owned heartbeats, completed-parent unblocking, and status-change audit events.
- Added store, registry, prompt, persistence, HTTP, CLI, dashboard-escaping, identity, dependency, and live tool-to-GET probe coverage.
- Validation: `npm test` and `npm run test:prod-policy` each pass 934/934 with no environment pinning.
KANBAN COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: LSP diagnostics (Codex)

- Added a git-workspace-only LSP client with built-in server discovery, optional repository configuration, Content-Length JSON-RPC transport, subprocess reuse, idle cleanup, and fail-open behavior for absent or unhealthy servers.
- Extended anchored code edits and writes to capture pre-edit diagnostics, preserve syntax checking as the first post-edit gate, and return only newly introduced normalized diagnostics in the Hermes-compatible XML block.
- Added an explicit OPENAGI_LSP kill switch through the setup allowlist, deterministic diagnostic filtering and formatting, and process-stub coverage without requiring a language server installation.
- Added client, subprocess, configuration, workspace, code-tool integration, syntax-failure, and graceful-degradation regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 943/943 with no environment pinning.
LSP COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: credential pools (Codex)

- Added same-provider API-key and OAuth credential pools with round-robin, least-used, fill-first, and random selection over secret-name references resolved through the Phase 1 secrets store.
- Added sticky per-turn leases and exact recovery rules: plan-limit 429 rotates immediately, transient 429 retries once on the same key, 402 applies a durable 24-hour cooldown, and OAuth 401 refreshes before rotating.
- Persisted secret-free pool state through atomic snapshots and JSONL events, auto-discovered existing provider keys as one-key pools, and kept live provider credential changes backward compatible.
- Added first-hop-only native provider fallback after pool exhaustion while preventing fallback replay after a successful model hop or tool side effect.
- Credential rotation intentionally resets the provider prompt cache, so the next request is a full-price re-read; this trades cache cost for keeping the session alive.
- Added strategy, status, cooldown, refresh, redaction, config, cache-identity, auth-header, fallback, no-replay, setup, and provider regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 963/963 with no environment pinning.
CRED POOLS COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: Tool Search (Codex)

- Added progressive disclosure for MCP and non-core plugin schemas with auto, on, and off modes, an exact schema-byte threshold, explicit only/defer controls, and concurrency-safe per-call catalog planning.
- Registered and documented tool_search, tool_describe, and tool_call while keeping built-in, code, web, memory, and fixed skill tools on the direct core surface.
- Unwrapped tool_call before lifecycle dispatch so the real deferred tool name alone traverses scope, scrutiny, veto hooks, catastrophic policy, approvals, checkpoints, post hooks, and activity events.
- Preserved deferred discovery for bounded specialists and read-only turns without expanding their allowed scope, and kept conversational core-only turns bridge-free.
- Added controller, ranking, schema-budget, OpenAI, Anthropic, scope, veto, activity, checkpoint, setup, prompt, cap, and fast-lane regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 983/983 with no environment pinning.
TOOL SEARCH COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: Mixture of Agents (Codex)

- Added the virtual `moa` provider with named data-directory presets, parallel and isolated reference analyses, bounded untrusted-context injection, and a direct aggregator that retains the normal iteration and tool loop.
- Added credential-aware direct provider construction, exact per-role model overrides, recursion rejection, provider routing metadata, explicit-only selection, and native-provider auto behavior unchanged.
- Added permanent model selection plus a serialized one-shot Discord `/moa` turn that uses a provider override without mutating the shared host provider, including failure-safe restoration.
- Added setup, hosted administration, CLI, live provider-tool, and public export surfaces with the new preset environment field allowlisted through the setup wizard.
- Added parallelism, isolation, redaction, failure, cancellation, real tool-loop, provider-construction, Discord restoration, hosted API, setup, and model-picker regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1008/1008 with no environment pinning.
MOA COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: context references (Codex)

- Added bounded inbound expansion for file and line-range references, deterministic folder trees, unstaged and staged diffs, capped commit history with patches, and SSRF-guarded URL text.
- Kept raw user text authoritative for scrutiny, signals, memory, and transcripts while appending a clearly labeled untrusted context section only to the provider input after scrutiny.
- Enforced workspace and home containment, direct-symlink rejection, realpath revalidation, sensitive-path and binary-file denial, bounded reads and subprocesses, graceful per-reference failures, and abort propagation.
- Preserved byte-identical provider input when no reference is present and made invalid file ranges deliberately fall back to the full bounded file.
- Added parser, file, folder, git, URL, cap, safety, abort, and AgentHost integration regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1023/1023 with no environment pinning.
CONTEXT REFS COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: deliverable mode (Codex)

- Added automatic outbound detection for the complete Hermes image, video, audio, document, data, presentation, archive, and web extension table, with native inline, voice, and file routing.
- Added bounded regular-file loading, duplicate coalescing, symlink and sensitive-path rejection, native Windows and Unix absolute paths, home-relative paths, and exact success-only path removal.
- Protected fenced and inline code samples, relative paths, remote URLs, missing files, oversized files, and every non-allowlisted source extension from automatic upload or message mutation.
- Routed normal Discord turns, streamed final edits, Telegram replies, and generic Discord or Telegram outbound delivery through the shared mode while retaining failed-upload paths and redacting transport errors.
- Added classifier, scanner, cap, safety, Discord, Telegram, streaming, pairing, failure, and channel-manager regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1038/1038 with no environment pinning.
DELIVERABLE COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: batch processing (Codex)

- Added the intentionally named `batcmcp_runner.mjs` JSONL batch runner with strict Hermes-compatible flags, bounded worker pools, configurable batch sizing, and isolated runtime, provider, workspace, and data directories per prompt.
- Added ShareGPT trajectory export, tool-use and reasoning-coverage statistics, per-batch append-only records, atomic checkpoints and summaries, stable occurrence-aware item identities, and failure records safe for retry.
- Made completed batch JSONL records the resume source of truth, preventing duplicates while retrying unfinished items even when a checkpoint is stale.
- Kept batch sessions on the full AgentHost iteration path, honored the requested turn cap, and closed runtime SQLite and integration resources between items to control long-run memory use.
- Added parser, dataset, distribution-listing, helper, three-prompt bounded-concurrency, resume, recovery, isolation, and real durable-runtime regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1045/1045 with no environment pinning.
BATCH COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: provider routing (Codex)

- Added strict provider-routing configuration with price, throughput, and latency sorting; ordered only, ignore, and order lists; parameter support requirements; and data-collection policy.
- Loaded routing deterministically from explicit options, setup-wizard environment JSON, or the data-directory config snapshot, with empty explicit configuration disabling inherited policy.
- Attached a normalized top-level provider block only for official HTTPS OpenRouter and Nous Portal endpoints while leaving native OpenAI, Anthropic, Kimi, custom, and lookalike hosts byte-equivalent.
- Carried one immutable routing policy through primary, fallback, standalone direct, and default MoA provider construction without replacing injected model routers or custom MoA factories.
- Added public exports, setup allowlisting and escaped inputs for routing and provider base URLs, plus normalization, precedence, endpoint, serialization, non-mutation, fallback, and MoA regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1060/1060 with no environment pinning.
PROVIDER ROUTING COMPLETE

## 2026-07-23 - Hermes Parity Wave 3 Phase 2: subscription proxy and API server (Codex)

- Added a loopback OpenAI-compatible chat-completions server that runs unique ephemeral full AgentHost turns with tools, memory, skills, bounded request bodies, timing-safe bearer authentication, abort propagation, and OpenAI-shaped responses and errors.
- Added streaming completion chunks with visible sanitized tool state, provider text deltas, final fallback text, finish reasons, and a terminal DONE event without exposing tool inputs, outputs, error details, or credentials.
- Added a loopback raw subscription proxy that accepts any nonblank client bearer, resolves the configured managed credential from SecretsStore for every request, replaces inbound credential headers, and preserves method, path, query, bytes, status, and safe response headers without following redirects.
- Added fixed-upstream and header-injection validation, hop-by-hop and connection-nominated header stripping, bounded proxy bodies, secret-safe failures, provider-derived upstream and authentication settings, and partial-listener rollback.
- Wired flag-gated capability startup into the daemon's all-or-nothing boot and idempotent graceful shutdown, exported the public construction contract, and allowlisted escaped setup fields while never rendering the saved API server key.
- Added API shape, authentication, streaming, proxy substitution, raw forwarding, redirect, redaction, setup, lifecycle, rollback, and both-policy regressions; a live curl probe through a real AgentHost returned a valid chat completion.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1075/1075 with no environment pinning.
API SERVER COMPLETE

PARITY WAVE 3 PHASE 2 COMPLETE

## 2026-07-23 - Agent workspace upgrades: canonical provider requests (Codex)

- Added a clean-room two-phase roadmap for execution-intelligence and workspace-product improvements inspired by the Agent Zero architecture review.
- Made AgentHost keep the raw current message in durable session history while passing providers only prior messages plus one separately expanded current turn.
- Preserved repeated identical user turns, context-reference expansion, image forwarding, and ephemeral behavior without content-based deduplication.
- Added first-turn, multi-turn, repeated-text, ephemeral, context-reference, and image request-boundary regressions in both approval lanes.

## 2026-07-23 - Agent workspace upgrades: safe efficiency telemetry (Codex)

- Added content-free request-shape telemetry for prior-message bytes, one current turn, image count, instruction bytes, and visible/deferred tool-catalog weight.
- Aggregated provider usage across normal hops, goal judges, and forced answers; exposed it through AgentHost and the API server path without persisting prompts, arguments, results, credentials, or reasoning.
- Corrected OpenAI cached-token accounting so cached input is not also billed at the full input rate, while preserving Anthropic's additive cache semantics.
- Added provider, cache, request, schema, compression, latency, stop-reason, and deduplicated tool-outcome analytics; legacy ledger rows remain readable.
- Explicitly disabled provider-side storage for stateless OpenAI requests and replaced Anthropic thinking-only salvage with a bounded trace-free status.
- Fixed atomic snapshot flushing on Windows by opening the owned temporary file with a writable handle.
SAFE EFFICIENCY TELEMETRY COMPLETE

## 2026-07-23 - Agent workspace upgrades: typed tool capabilities (Codex)

- Added a normalized capability manifest for every registered tool covering domain, verbs, effect, idempotence, latency, cost, resources, requirements, examples, success criteria, and availability.
- Derived conservative defaults from the existing source, side-effect, and confirmation policy while keeping `sideEffects` authoritative and provider schemas backward compatible.
- Rejected malformed, executable, accessor-backed, circular, oversized, and policy-contradicting manifests with field-specific errors.
- Redacted and deeply froze internal manifests; public registry listings now return detached JSON-safe descriptors without execution callbacks.
- Added regressions for defaults, explicit normalization, redaction, confirmation, validation, immutability, callback isolation, and unchanged OpenAI/Anthropic schemas.
TYPED TOOL CAPABILITIES COMPLETE

## 2026-07-23 - Agent workspace upgrades: reachability-preserving tool radar (Codex)

- Replaced shared overflow state with immutable request-local provider plans that cap advertised tools while reserving search, describe, and call bridges whenever any eligible tool is omitted.
- Made every policy-eligible omitted internal, MCP, plugin, and skill tool searchable and invokable without widening specialist, scrutiny, read-only, confirmation, hook, checkpoint, or approval boundaries.
- Ranked matches across names, descriptions, schema properties, capability metadata, source, and availability; returned bounded, redacted match reasons, required arguments, effects, confirmation requirements, availability, and examples.
- Kept OpenAI and Anthropic on the exact same host-computed catalog and prevented bridge forwarding from bypassing or duplicating the real target's dispatch pipeline.
- Reduced the current full-core advertised schema from 31,227 to 7,918 bytes while preserving exact-name reachability for all 42 omitted tools.
- Added cap, reachability, ranking, scope, policy, immutability, provider-parity, and byte-reduction regressions in both approval lanes.
REACHABILITY TOOL RADAR COMPLETE

## 2026-07-23 - Agent workspace upgrades: semantic tool outcomes and repair (Codex)

- Added one provider-visible outcome contract for success, failure, blocked, and pending calls, including stable codes, mutation state, artifacts, evidence, verification, retryability, and concrete repair steps.
- Made raw tool failures monotonic, reserved verification for explicit verifiers, kept checkpoint receipts on every post-dispatch failure, and safely isolated domain statuses such as blocked Kanban cards from execution failures.
- Added descriptor-safe bounded argument fingerprints and result snapshots; accessors, proxies, cycles, BigInt values, malformed side-effect arguments, and unsafe callback results now fail closed without running attacker-controlled properties.
- Prevented unchanged non-idempotent retries, concurrent duplicate operations across turn cleanup and provider timeouts, duplicate pending calls, and repeated OpenAI or Anthropic call ids while propagating stable idempotency and operation receipts to handlers and hooks.
- Made oversized model-visible tool output valid bounded JSON with retrievable full-output references and compact semantic receipts instead of slicing JSON into an invalid fragment.
- Made approvals first-writer-wins across timeout races, terminal and non-replaying after uncertain restart recovery, and bound to the original tool/policy identity; redacted at-rest arguments can only execute through their live suspended owner.
- Added cross-platform test launchers plus semantic, provider, approval, concurrency, hostile-data, receipt, truncation, Kanban-domain, checkpoint, and policy regressions in both approval lanes.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1168/1168 in the canonical WSL clone with no environment pinning.
SEMANTIC TOOL OUTCOMES COMPLETE

## 2026-07-23 - Agent workspace upgrades: activity-aware OpenAI Responses streaming (Codex)

- Added a bounded Responses SSE state machine for fragmented UTF-8, LF/CRLF/bare-CR framing, visible text and refusals, usage snapshots, output items, multiple function calls, and exact argument assembly.
- Required a terminal protocol event and `output_item.done` before a native call can reach the iteration engine; sequence regressions, identity substitution, sparse indices, lifecycle mutations, malformed calls, and post-terminal data now fail closed.
- Kept reasoning and tool arguments internal while delivering only visible deltas, and reset the stall watchdog only after a meaningful event passes framing, size, sequence, and lifecycle validation.
- Added independent hard-request and activity-stall timers plus abort-raced reader settlement, so caller cancellation and non-cooperative transports cannot hang or be misclassified.
- Bounded wire bytes, events, frames, output items, content parts, visible output, per-call and aggregate arguments, and usage structure; streaming and blocking usage now share a descriptor-safe prototype-resistant accumulator.
- Added adversarial protocol, cancellation, refusal, encoding, framing, usage, bound, and zero-partial-dispatch regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1203/1203 in the canonical WSL clone with no environment pinning.
RESPONSES SSE COMPLETE

## 2026-07-23 - Agent workspace upgrades: safe provider continuation (Codex)

- Added fixed-size OpenAI prompt cache keys over the exact model, stable instructions, and ordered visible tool catalog without exposing prompt, user, or credential content.
- Kept Responses requests stateless and `store:false` by default, with an explicit setup-allowlisted continuation mode that remains disabled for ephemeral, ZDR, and data-collection-denied turns.
- Bound one-shot provider state to the session incarnation, transcript lineage and epoch, provider endpoint, model, process-keyed live credential identity, effective routing, project or memory scope, prompt identity, and tool identity.
- Delayed continuation commits until the assistant transcript and session-lineage CAS are durable; stale, concurrent, failed-append, synthetic, forced-answer, and compressed-prefix paths abandon or reseed provider state safely.
- Added narrow 4xx unsupported-state fallback before any tool dispatch, credential-rotation replay only before local effects, bounded descriptor-safe identities, TTL/LRU state, negative-capability isolation, and opaque non-serializing candidates.
- Added hostile-input, cache, lineage, concurrency, routing, credential, privacy, AgentHost, fallback, setup, and serialization regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1236/1236 in the canonical WSL clone with no environment pinning.
SAFE PROVIDER CONTINUATION COMPLETE

## 2026-07-24 - Agent workspace upgrades: structured asynchronous context ledger (Codex)

- Replaced unstructured live-context summaries with a reversible structured ledger of objective, authorization context, decisions, semantic tool receipts, state changes, evidence, artifacts, durable references, pending work, blockers, failures, and next actions while retaining exact current and recent tool pairs.
- Added immutable preview, private source-bound single-use install, and restore lifecycle; bounded hostile snapshots and fail-open aggregate fallback; retired the competing compaction path.
- Prepared candidates asynchronously but installed them only at exact usage-aware 50% and 85% thresholds, with cache bounds, live redaction revalidation, continuation invalidation, and stateless compression replay for OpenAI and Anthropic.
- Hardened reasoning and credential redaction, durable-reference extraction, legacy failure classification, marker budgeting, optional summarizer isolation, synthetic-turn provenance, credential-pool rotation, and oversized-history behavior.
- Added provider parity, lifecycle, TOCTOU, hostile-value, secret-rotation, reference, semantic receipt, continuation, threshold, and aggregate-bound regressions in both approval lanes.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1314/1314 in the canonical WSL clone with no environment pinning.
STRUCTURED CONTEXT LEDGER COMPLETE

AGENT WORKSPACE PHASE 1 COMPLETE

## 2026-07-24 - Agent workspace upgrades: project composition root (Codex)

- Added a durable ProjectStore composition root with append-only JSONL events, atomic snapshots, revision-safe create/update/archive operations, immutable session bindings, project-owned workspaces, instructions, memory roots, secret references, skills, model and routing profiles, MCP grants, policy, hooks, schedules, Kanban boards, and artifacts.
- Enforced project identity across AgentHost turns, provider requests, memory, context references, session discovery, code tools, checkpoints and rollback, cron execution, drafts, tool outputs, outreach, background review, skill replay, pending approvals, CLI, authenticated HTTP, SSE, and dashboard surfaces.
- Added authoritative cross-process authorization reads, canonical project memory scopes, durable transcript-based binding repair, current-revision approval identities, capability and catalog revocation, custom-hook grants, and fail-closed project session validation.
- Required independent project secret grants for native model credentials, MCP credential placeholders, code-shell exports, and secret administration; added deterministic symlink-swap revalidation and project-contained schedule identifiers.
- Preserved legacy default-project behavior while restricting global administration to the default control plane and keeping nondefault storage roots, tools, skills, hooks, schedules, sessions, drafts, outputs, and credentials disjoint.
- Added bounded persistence, append-uncertainty reconciliation, restart/corruption recovery, hostile-input validation, Windows-safe resource teardown, and per-process test data isolation that never touches the operator's live runtime tree.
- Added project store, memory, session, code, cron, checkpoint, draft, output, outreach, replay, approval, capability, CLI, HTTP, SSE, dashboard, restart, concurrency, credential, and red-team boundary regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1441/1441 with zero failures and one intentional Windows permission-mode skip.
PROJECT COMPOSITION ROOT COMPLETE

## 2026-07-24 - Agent workspace upgrades: durable policy-aware jobs (Codex)

- Added project-scoped durable direct-tool and subagent jobs with start, status, bounded wait, collect, cancel, authenticated HTTP, and status-only SSE surfaces.
- Added JSONL event persistence plus atomic snapshots, cross-process CAS, tuple idempotency, restart reconciliation without dispatched-work replay, explicit cancellation settlement, and a default concurrency limit of three.
- Added an exclusive live-scheduler witness so passive readers cannot reconcile work owned by another process, bounded restart-batch hydration, session-isolated controls, durable cancel-before-abort ordering, and project-revision cancellation.
- Bound canonical hierarchical locks to trusted live tool resources at submission and dispatch, coordinated foreground mutations with background leases, rejected tool-identity and operand TOCTOU, and quarantined non-cooperative handlers without releasing conflicting locks.
- Inherited allowed-tool and scrutiny ceilings, abort signals, shared atomic provider spend, aggregate iteration limits, wall-clock deadlines, and remaining iterations while stripping parent approval and operation authority from children.
- Kept credential-bearing payloads live-only, blocked restart-era job approvals from escaping the scheduler, and stored oversized redacted results behind project-owned tool-output references.
- Added durable-store, concurrency, lock, cancellation, restart, subagent, budget, approval, project, output-reference, HTTP, SSE, prompt, and hostile-input regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1477/1477 with zero failures and one intentional Windows permission-mode skip.
DURABLE JOBS COMPLETE

## 2026-07-24 - Agent workspace upgrades: semantic browser (Codex)

- Added an opt-in project/session-scoped semantic browser with a lazy optional Playwright/CDP adapter, compact accessibility/DOM snapshots, opaque generation-bound references, typed navigation/input/selection/scroll/transfer actions, and on-demand screenshots.
- Labeled every page-derived result as untrusted, invalidated references on live DOM changes and mutations, stripped fragment credentials, redacted entered-secret representations from later semantic output, and withheld untrusted adapter diagnostics.
- Routed navigation, activation, form input, selection, secret input, uploads, downloads, and screenshots through the existing approval rail; rejected embedded credentials before approval persistence and resolved credential values only from project-granted SecretsStore references.
- Added HTTP(S), DNS, private-network, redirect-origin, service-worker, and WebSocket guards; isolated every local or CDP browser context and prevented directly injected adapters from crossing project/session boundaries.
- Confined downloads to project-owned paths and converted uploads to bounded opened byte payloads with file-identity checks, closing symlink and validate-then-use path races.
- Added native screenshot attachment parity for OpenAI and Anthropic without retaining base64 in textual tool output, plus setup allowlisting and runtime lifecycle/public API wiring.
- Added lifecycle, stale-reference, scope, approval, secret, SSRF, redirect, CDP, path-race, provider-image, prompt, optional-dependency, and hostile-adapter regressions. The compact semantic benchmark is below 20 percent of the equivalent three-screenshot-loop context.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1507/1507 with zero failures and one intentional Windows permission-mode skip.
SEMANTIC BROWSER COMPLETE

## 2026-07-24 - Agent workspace upgrades: Artifact Canvas and session branching (Codex)

- Added a project-scoped Artifact Canvas for versioned Markdown and JSON-compatible data, with append-only JSONL revision events, atomic snapshots, cross-process mutation locking, strict size and structure bounds, stale-write rejection, recoverable restores, and pinned revision references.
- Reserved artifact identities through ProjectStore before persistence, rolled reservations back on failed appends, refreshed authorization at storage boundaries, and emitted content-free lifecycle notifications only after durable mutations.
- Added create, list, show, update, version-history, and restore agent tools; documented every tool in the system prompt; and exposed authenticated project-contained HTTP plus metadata-only SSE updates.
- Extended Deliverable Mode to attach exact pinned artifact revisions with deterministic Markdown or JSON serialization while retaining invalid, unpinned, fenced, and foreign references as text and confining nondefault filesystem attachments to the active project workspace.
- Added exact inclusive branch-from-message semantics without source mutation, fresh branch metadata, server-generated target sessions, durable project binding before transcript creation, metadata-only hooks and SSE, and composite session/message indexing.
- Replaced lossy transcript filenames with hash-addressed paths, exact-id legacy migration, corrupt-record fail-closed checks, and deduplicated session listing while preserving backward compatibility.
- Added persistence, stale-write, restore, project-boundary, HTTP, SSE, deliverable, transcript-collision, source-immutability, branch-indexing, prompt-visibility, hostile-data, and both-policy regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1537/1538 tests with zero failures and one intentional Windows permission-mode skip.
ARTIFACT CANVAS COMPLETE

## 2026-07-24 - Agent workspace upgrades: solution-recipe memory (Codex)

- Added a project-scoped procedural-memory domain, independent from factual recall, with preconditions, ordered actions, evidence, failure modes, verification, soft deletion, and atomic supersession.
- Persisted authoritative recipe state through append-only JSONL events and atomic snapshots with cross-process locking, global sequencing, revision CAS, append-uncertainty reconciliation, corruption fail-closed behavior, and project resource reservations.
- Required explicit durable evidence and human approval before verification, destructive lifecycle changes, reindexing, or skill-candidate staging; semantic edits reset trust and failed or unverified attempts remain excluded from procedural recall.
- Added embedding identities bound to provider, model, endpoint hash, dimension, algorithm, and text schema; identity drift marks indexes stale, verified recall falls back to lexical search, and bounded revision-checked reindexing atomically replaces only the active project namespace.
- Hardened the shared vector store against stale-writer namespace loss and mismatched dimensions, and rejected secret-shaped or configured credential material before persistence, export, or embedding.
- Added searchable agent tools, prompt guidance, authenticated CRUD, verification, supersession, deletion, export, reindex, metadata-only SSE, and review-only skill candidates with exact recipe lineage.
- Added persistence, concurrency, corruption, evidence, trust-reset, fact separation, stale-index, vector-isolation, secret-redaction, project-boundary, HTTP, SSE, prompt, and review-path regressions in both approval lanes.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1551/1552 tests with zero failures and one intentional Windows permission-mode skip.
SOLUTION RECIPES COMPLETE

## 2026-07-24 - Agent workspace upgrades: profiles and capability grants (Codex)

- Added durable project- and session-scoped profiles for persona instructions, model and routing choices, progressively disclosed active skills, exact tool grants, and disabled-by-default capability bundles.
- Bound every sensitive tool invocation to one enabled bundle that grants both the exact tool and its complete filesystem, network, secret, subprocess, API, UI, or hook access; unrelated grants cannot be combined to manufacture authority.
- Enforced fresh profile resolution in provider catalogs, direct and radar-dispatched calls, asynchronous hook and checkpoint boundaries, approval identities, project application, and session branches, with revoked or corrupt authority failing closed.
- Added revision-safe profile, bundle, and binding administration through deferred agent tools plus authenticated HTTP, metadata-only events, audit history, explicit-human escalation gates, and deny-all preservation for empty grants.
- Added inert ZIP and local-checkout skill quarantine with bounded static parsing, traversal, link, device, archive, credential, CRC, collision, Unicode, and decompression defenses; imported code cannot load before exact human-approved atomic materialization.
- Pinned import approvals to candidate and project revisions, stamped durable import lineage and finite tool allowlists, kept arbitrary function patching unsupported, and made both authority journals append-only with atomic snapshots and corruption-safe writes.
- Added profile, bundle, race, CAS, branch, catalog, prompt, HTTP auth, import, project-boundary, persistence, corruption, and hostile-package regressions in both approval lanes.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1573/1574 tests with zero failures and one intentional Windows permission-mode skip.
PROFILES AND GRANTS COMPLETE

## 2026-07-24 - Agent workspace upgrades: workspace timeline (Codex)

- Added a debounced project-scoped post-mutation workspace timeline with content-addressed manifests and blobs, append-only JSONL authority, atomic cache snapshots, cross-process locking, list, diff, preview, travel, and revert tools, and runtime lifecycle wiring.
- Kept CheckpointStore as the fast pre-mutation rail while capturing successful and partial-failure filesystem dispatches after debounce; recovery snapshots current state first, uses expected-head CAS and human confirmation, and records only verified observed results.
- Added deterministic opaque-path handling for sensitive files, symlinks, repositories, hardlinks, special files, ignored trees, oversized files, and large binaries without persisting excluded contents; case-folded and NFKC path identities prevent exclusion-to-absence deletion.
- Hardened project and revision authorization, descriptor-based reads, root, ancestor, and path identity checks, per-path restore verification, exact post-apply scans, conflict-safe inverse revert, file and directory transitions, strict journal topology, and corrupt-cache recovery.
- Added project-scoped quota and garbage collection with recovery-before retention and explicit bounded safety debt, plus hostile persistence, cross-project, integrity, TOCTOU, opaque-transition, Windows case-fold, runtime, prompt, and both-policy regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1593/1594 tests with zero failures and one intentional Windows permission-mode skip.
WORKSPACE TIMELINE COMPLETE

## 2026-07-24 - Agent workspace upgrades: sandboxed persistent terminals (Codex)

- Added opt-in project- and chat-scoped persistent terminal sessions for interactive shells, REPLs, debuggers, and bounded long-running work, with start, list, status, send, read, signal, and close agent tools documented in the system prompt.
- Required explicit human approval for every session start and exact one-shot human approval for every catastrophic command; public confirmation fields, inherited approvals, session allowances, nested skill calls, and both auto-approval modes cannot forge or reuse authority.
- Isolated sessions in digest-pinned local Docker containers with no image pulls, host networking, host fallback, added capabilities, writable root, or remote daemon; mounted only the authorized project workspace and enforced nonroot identity, process, CPU, memory, swap, file-descriptor, and temporary-storage limits.
- Bounded global and per-project sessions, queued input, command count, lifetime input and output, live output rings, callback floods, idle time, and total lifetime; sanitized terminal control sequences and labeled every output slice as untrusted.
- Kept raw commands off JSONL, snapshots, hooks, lifecycle events, transcripts, and pending-action persistence while rechecking managed and pattern-shaped secrets immediately before each serialized write and across fragmented output.
- Added durable metadata through JSONL events and verified atomic snapshots, bounded journal compaction, cross-process locks, manager ownership leases, exact container labels, restart cursor continuity, orphan cleanup, and fail-closed startup reconciliation before any mutating tool or hosted listener becomes available.
- Coordinated foreground, background-job, terminal, and workspace-timeline ownership; retained project quarantine until failed container removal is verified, rechecked live project and profile authority, and closed terminals before broader runtime teardown.
- Added adapter, store, manager, policy, approval, privacy, resource-bound, revocation, restart, corruption, shutdown, prompt, setup, and both-policy regressions.
- Validation: `npm test` and `npm run test:prod-policy` each pass 1611/1612 tests with zero failures and one intentional Windows permission-mode skip.
PERSISTENT TERMINALS COMPLETE

AGENT WORKSPACE PHASE 2 COMPLETE
## 2026-07-23 — Legion sibling roster + bot-to-bot mention discipline (Seraphim)
Root cause of Ziz↔Azazel plain-text "@Azazel" not pinging: Azazel's sibling
table only had seraphim/azazel/home (no `ziz` target), and the Legion context
block never told the model that a plain `@Name` doesn't notify — only a raw
`<@id>` does. Fixes (src/legion-siblings.js, src/agent-host.js):
- BUILTIN_SIBLINGS gains `ziz` (#ziz-chat 1488300124395540501).
- New LEGION_MEMBERS registry + legionUserId()/legionMember() exports: every
  family member's raw Discord user id + WSL home.
- formatLegionContextBlock now (a) warns plain @Name doesn't ping and lists every
  sibling as name → <@id> → where-they-run, and (b) advertises the off-Discord
  fallback lane (~/.legion/mailbox/<name>.jsonl, see ~/.legion/README.md).
- Tests: test/legion-siblings.test.js +4 cases. Both lanes 1088/1088 green.

## 2026-07-25 - Hermes-informed memory trust foundation (Codex)

- Made the durable memory journal authoritative over its cache snapshot, with replay after snapshot failures, cross-process mutation serialization, stale-instance refresh, and fail-closed malformed-journal handling.
- Added deterministic memory-intake screening for hidden controls, prompt-control attempts, credential-shaped values, and configured secret values; direct remember and correction writes now record explicit provenance.
- Changed post-session model review from silent memory mutation to a screened durable pending action. Only an exact, human-approved replay can materialize it, including when ordinary auto-approval is enabled.
- Kept proposal handlers out of model tool catalogs, preserved existing dashboard approval flows, and added provenance for pending and human-approved review memory.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1617/1618 tests with zero failures and one intentional Windows permission-mode skip.
MEMORY TRUST FOUNDATION COMPLETE

## 2026-07-25 - Hermes-informed profile memory separation (Codex)

- Added opaque, stable per-user profile memory scopes with a separate 800-character curated budget; profile scopes never inherit project, specialist, global, or other-user memory.
- Updated frozen session snapshots to include independently labeled user-profile and project-memory views, with profile identity included in snapshot and Responses-continuation isolation.
- Extended `remember` and `correct_memory` with an explicit `memoryClass='preference'` path, while recall merges only the current caller's profile with their project view.
- Routed post-session preference proposals to the caller's profile scope, while keeping non-preference review learning project-scoped and approval-gated.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1621/1622 tests with zero failures and one intentional Windows permission-mode skip.
PROFILE MEMORY COMPLETE

## 2026-07-25 - Hermes-informed skill safety and reversible curation (Codex)

- Changed isolated `run_skill` generations to fail closed: absent both declared `allowed_tools` and an inherited boundary, they receive no tool schemas and an invoke-time empty allowlist rather than the full registry.
- Added compact, hash-only `list_skill_revisions` and confirmation-gated `rollback_skill` tools. Rollback accepts only the exact current revision, verifies the current document hash, validates the restored document, and writes a new recoverable revision.
- Made curator state transitions immediately auditable and reversible through the same head-only rollback path; corrupt revision journals cannot supply rollback bytes.
- Documented the new agent-facing revision tools in the static system prompt.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1622/1623 tests with zero failures and one intentional Windows permission-mode skip.
SKILL SAFETY AND CURATION COMPLETE

## 2026-07-25 - Hermes-informed memory and skill awareness (Codex)

- Added read-only `memory_details`: it exposes bounded provenance, confidence, correction, and replacement state without reinforcing a memory or exposing raw internal metadata; project and profile boundaries are enforced before inspection.
- Added `inspect_skill_capabilities` so an agent can preflight an imported or uncertain skill and see its effective tool contract, missing registrations, and project-boundary denials before execution.
- Skill runs now return the same compact effective tool-scope receipt and treat a wildcard-only inherited scope as unbounded rather than silently using it as a capability grant.
- Documented both agent-facing tools and the epistemic-use guidelines in the static system prompt.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1626/1627 tests with zero failures and one intentional Windows permission-mode skip.
MEMORY AND SKILL AWARENESS COMPLETE

## 2026-07-25 - Hermes memory and skills deep dive (Codex)

- Added a source-linked comparison of Hermes' official memory, skills, curator, and external-provider design with the current Cerberus implementation.
- Recorded the original two-phase adoption work, the tool-calling and evidence-awareness improvements it delivered, and deliberately deferred follow-ups that require a separate privacy or authority design.
- Documented why Cerberus keeps Hermes' compact and progressive ergonomics while requiring durable provenance, caller-scoped isolation, finite skill grants, human-approved background writes, and revision-safe recovery.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1626/1627 tests with zero failures and one intentional Windows permission-mode skip.
HERMES MEMORY AND SKILLS DEEP DIVE COMPLETE

## 2026-07-25 - Unified Tool Kernel: Tool Contract V2 (Codex)

- Added bounded, side-effect-free JSON Schema normalization and runtime validation for every registered tool input, with local references, composition, formats, structural limits, and secret-safe path-only errors.
- Rejects invalid calls before project resolution, forwarding, preflight, hooks, approvals, checkpoints, leases, or handlers, so malformed mutating calls cannot consume authority or create false audit activity.
- Added optional output contracts that turn schema-invalid handler successes into explicit `invalid_tool_result` outcomes while retaining checkpoint evidence and conservative mutation state.
- Exposed output contracts through deferred discovery without sending them as provider input schemas, and rejected executable or accessor-bearing contracts at registration.
- Made normalization contracts explicit where tools intentionally clamp permissive input, and updated legacy test doubles to declare their accepted fixture arguments instead of relying on implicit open inputs.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test -- --test-concurrency=1` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy -- --test-concurrency=1` each pass 1634/1635 tests with zero failures and one intentional Windows permission-mode skip.
TOOL CONTRACT V2 COMPLETE

## 2026-07-25 - Unified Tool Kernel: transactional code edits (Codex)

- Replaced collision-prone four-hex edit tags with exact-byte full SHA-256 digests across reads, searches, edits, and whole-file writes.
- Required compare-and-swap `expectedTag` authority for every existing-file `code_write`; blind overwrites, stale edits, and create races now fail without replacing the winner.
- Syntax-checks JavaScript candidates in private temporary storage before commit, so invalid source neither replaces an existing file nor creates a new one.
- Uses the shared atomic text writer for exact replacement, preserves existing file modes, rechecks live content after asynchronous validation, and verifies the committed digest.
- Returns previous and committed digest receipts, rejects symbolic-link and non-regular targets, and documents all code tools plus read-before-edit discipline in the static system prompt.
- Added race, collision-strength, stale-write, syntax rollback, writer failure, schema, mode, LSP, project-isolation, and both-policy regressions.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test -- --test-concurrency=1` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy -- --test-concurrency=1` each pass 1642/1643 tests with zero failures and one intentional Windows permission-mode skip.
TRANSACTIONAL CODE EDITS COMPLETE

## 2026-07-25 - Unified Tool Kernel: resource-aware provider batching (Codex)

- Added an order-preserving tool batch executor with a hard concurrency cap of four and deterministic execution-wave receipts.
- Parallelizes read-only calls, never mixes reads with mutations, and parallelizes side effects only when trusted synchronous `jobResources` resolve to finite non-overlapping resources.
- Keeps approvals, goal controls, unknown tools, invalid resource resolvers, and unscoped mutations as exclusive sequential barriers.
- Wired both OpenAI Responses and Anthropic tool loops to the same scheduler while retaining duplicate-call identity checks, semantic outcomes, model-visible result ordering, deadlines, and goal-loop safety.
- Emits compact `tool-batch` progress events with call count, wave count, parallel-wave count, and maximum width for live harness awareness.
- Added scheduler, cap, conflict, rejection, provider-ordering, mutation-barrier, duplicate-security, approval-suspension, and both-policy regressions.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test -- --test-concurrency=1` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy -- --test-concurrency=1` each pass 1652/1653 tests with zero failures and one intentional Windows permission-mode skip.
RESOURCE AWARE TOOL BATCHING COMPLETE

## 2026-07-25 — Agent draft-action log (Azazel)

- 2026-07-25T13:00:23.438Z · **azazel** · create `drafts/dashboard-loop-verification-checklist.md` — Draft checklist for dashboard + loop verification (plan-action draft only)

- 2026-07-25T22:32:34.365Z · **azazel** · create `web/galactic-spiral.html` — Galactic spiral/vortex parametric particle effect — scalable canvas, DPR-aware, tab-hidden pause, reduced-motion fallback

## 2026-07-25 - Rail-footer gateway controls: Update + Restart (Seraphim)

Surfaced the gateway Update and Restart controls in the dashboard's left-rail
footer (`src/hosted-interface.js`), next to Setup. Requested by the Creator.

- **Problem.** The `/gateway/update` and `/gateway/restart` routes and their
  handlers already existed, but the only UI reaching them lived inside the
  Models tab (`gwUpdate` / `gwRestart`). An operator wanting a restart had to
  know which tab hid it. Backend was complete; the affordance was not.
- **Added `#railUpdate` / `#railRestart`** in `.rail-footer`, with a shared
  `#railGwResult` status line that self-hides when empty. Two new HUD glyphs
  (`update` download-tray, `restart` circular-arrow) so they are not another
  copy of the Setup gear.
- **Restart is gated on supervision.** On load the rail queries
  `/gateway/status` and disables Restart when `supervised` is false, moving the
  reason into the tooltip. Without a supervisor, exiting stops the agent rather
  than cycling it. The POST route keeps its own 409 guard, so the UI gate is a
  convenience, never the security boundary.
- **Restart resolves by polling, not by the response.** The process exits
  mid-request by design, so the socket drop is expected; the handler polls
  `/gateway/status` (40 attempts, 500ms) and reports the new pid, instead of
  reading the dropped request as a failure.
- Confirm dialog retained on Restart (in-flight turns are dropped), busy-state
  locking on both buttons, and a collapsed-rail (<=820px) rule that stacks them
  icon-only and hides the status line.
- Validation: `node --check` + module import clean; `OPENAGI_AUTO_APPROVE=0 npm
  test` passes 1731/1731 with zero failures. Live daemon verified: buttons
  render in served HTML, `/gateway/status` reports `supervised: true`, and
  `POST /gateway/update` returns `already up to date` end-to-end.
RAIL FOOTER GATEWAY CONTROLS COMPLETE

- 2026-07-25T23:07:02.001Z · **azazel** · edit `src/setup-wizard.js`

## Pet reactivity wired to the real harness activity lane
- Bug: the Cerberus pet only reacted to the dashboard composer submit handler
  (`cerbPetReact("thinking")`). Work driven from Discord, Telegram, or cron left
  the pet idle for the whole turn. Root cause: `__onToolEvent` was only attached
  when a channel supplied a callback, so most turns emitted no tool events at all.
- `src/agent-host.js` — `forwardToolEvent` now also mirrors every tool event onto
  the runtime bus as `agent-activity`, and `__onToolEvent` is always attached.
- `src/hosted-interface.js` — broadcast `agent-activity` over SSE; emit a
  `turn-end` beat on turn completion and on throw; client maps phases to pet
  states (start->working, iteration/verdict/subagent->thinking, end->working/error,
  turn-end->done) with a 45s watchdog back to idle.
- Verified on an isolated throwaway daemon (:43997, own data dir, Discord/Telegram
  tokens stripped) with real provider creds: a `channel:"discord"` message that
  forces a shell tool call produced 7 `agent-activity` SSE events —
  start x2, iteration x2, end x2, turn-end x1 — reaching a subscribed client.
PET ACTIVITY LANE COMPLETE

- 2026-07-25T23:20:10.056Z · **azazel** · edit `src/directional-adaptive-scrutiny.js` — Cautious fallback: hedge to 'ask' only when signal uncertainty >= 0.5, else defer to signal default; add askUncertaintyThreshold option
- 2026-07-25T23:26:10.805Z · **azazel** · edit `src/provider-presets.js` — Add validatePresetKey: advisory, fail-soft key ping (Anthropic x-api-key / OpenAI Bearer GET /models, 6s timeout, injectable fetch)

## Always-on evolution HUD
- The XP/stage readout only existed inside the gear panel. Added a permanent
  bottom-centre strip (`#cerbPetHud`) showing form (PUP / PRIME CERBERUS), the
  live reactive state (idle/thinking/working/done/error) with a colour-coded
  pulse dot, and an animated XP bar. Mirrors settings.xp/settings.stage — no
  second counter. Refreshed from setState, gainXP, evolve, reset, and toggles,
  so it moves in real time while any channel (Discord/Telegram/cron) drives work.
PET EVOLUTION HUD COMPLETE

- 2026-07-25T23:26:58.742Z · **azazel** · edit `src/hosted-interface.js` — Wire validatePresetKey into POST /providers/key (advisory, fail-soft) and surface invalid/unverified results in the Models tab save flow
- 2026-07-25T23:32:34.958Z · **azazel** · edit `src/scrutiny-panel.js` — Tune cautious judge: raise askUncertaintyThreshold 0.5→0.6 so it hedges only on genuinely ambiguous signals
- 2026-07-26T01:55:37.903Z · **azazel** · create `src/provider-oauth.js` — Add provider OAuth (PKCE paste-flow) for Anthropic + OpenAI with refresh hook
- 2026-07-26T01:59:13.059Z · **azazel** · edit `src/setup-wizard.js` — Allowlist provider OAuth token + client-id env names in the wizard save lane
- 2026-07-26T01:59:47.106Z · **azazel** · edit `src/provider-oauth.js` — Add credential-pool persistence helper for OAuth leases
- 2026-07-26T02:00:34.830Z · **azazel** · edit `src/hosted-interface.js` — Wire provider OAuth: routes, refresh hook, activation, Models-tab UI
- 2026-07-26T02:01:35.220Z · **azazel** · edit `CHANGES.md` — Changelog: provider OAuth for Anthropic + OpenAI
- 2026-07-26T02:22:01.282Z · **azazel** · edit `src/model-provider.js` — Soft wall-clock checkpoints: guard pings and extends the turn instead of hard-stopping (OPENAGI_WALL_CLOCK_CHECKPOINTS, default 3; 0 = legacy hard stop)
- 2026-07-26T04:10:56.544Z · **azazel** · edit `.env.example`
- 2026-07-26T04:10:56.602Z · **azazel** · edit `test/model-provider-iterations.test.js`
- 2026-07-26T04:10:56.609Z · **azazel** · edit `src/setup-wizard.js`
- 2026-07-26T12:05:48.463Z · **azazel** · create `~/.openagi/workspace/drafts/goal-mode-e2e-verification-checklist.md` — Draft checklist for goal-mode end-to-end verification (planner task, draft-only)
- 2026-07-26T12:06:20.503Z · **azazel** · create `drafts/goal-mode-e2e-verification-checklist.md` — Draft checklist for goal-mode end-to-end verification (planner task, draft-only)

## 2026-07-26 - Merge review: Azazel's + Zed's upgrade waves reconciled (Seraphim)

Reviewed the two uncommitted upgrade sets sitting on top of `main` together
(soft wall-clock checkpoints + provider OAuth + scrutiny/preset tuning from
Azazel; the Kanban `on-hold`/`kanban_move` column work from Zed) and fixed the
places where they conflicted with each other and with existing contracts.
Azazel reported "0 failures"; the real suite had **4**, all genuine.

- **`boardView().columns` silently lost `done`.** The Kanban work filtered
  terminal statuses out of the published `columns` array, which is read by the
  HTTP `/kanban` route, the CLI client, the dashboard renderer and the durable
  audit snapshot. That made "statuses that exist" disagree with the statuses
  the store accepts. `columns` is restored to the full board order; the
  active/terminal split now lives in a new `activeColumns` field, so new
  callers get a working board without old callers losing the vocabulary.
- **Filtering by `status: "done"` returned an empty list.** The active/completed
  partition was applied unconditionally, so an explicit status filter for a
  terminal column answered `tasks: []` — a silent lie that broke the HTTP route
  and the CLI. The partition is now skipped whenever the caller supplied a
  status filter, mirroring `listTasks()`'s own truthiness check so the two can
  never disagree.
- **`on-hold` was unreachable through the tools.** The new column was added to
  `KANBAN_COLUMNS` and to `kanban_move`, but the `kanban_list` and
  `kanban_create` status enums and the dashboard's fallback column list still
  carried the old five, so nothing could filter or create it. All three
  updated.
- **`kanban_move` was invisible to the model.** The tool was registered but
  absent from the system prompt, so the agent had a column-move verb it would
  never know to call. Documented alongside the other Kanban tools, including
  when NOT to use it (completion and blocking keep their own verbs).
- **Two salvage tests were failing, not stale.** `provider-resilience` pins the
  legacy mid-tool-batch salvage contract (completed results preserved, aborted
  call reconciled, `turn-timeout` + forced answer). Soft checkpoints extend past
  that deadline by design, making the salvage path unreachable, so both tests
  are pinned to `wallClockCheckpoints: 0` with a comment explaining that they
  cover the hard-stop lane on purpose.
- **Config actually landed.** `OPENAGI_MAX_TURN_SECONDS=1200` and
  `OPENAGI_WALL_CLOCK_CHECKPOINTS=3` written to `~/.openagi/.env` (the append
  that had been stuck behind an expired approval). 1200s x 3 extensions = up to
  80 minutes of autonomous runway, pinging at each leg instead of dying.
- Validation: `node --check` clean on every touched file; `OPENAGI_AUTO_APPROVE=0
  npm test` = **1736/1736 pass, 0 fail** (was 4 failing). Live smoke against the
  real `.env` values drove a turn past three consecutive guard firings: 3
  `wall-clock-checkpoint` events (extensionsLeft 2/1/0), the status-check ping
  reached the model each time, and the turn continued to a real finish with
  `stopReason: "completed"` instead of `turn-timeout`.
- **`kanban_move` had no HTTP surface.** The test it lives in asserts the tools,
  HTTP routes, CLI client and dashboard "form one safe surface", but the new
  verb was registered as a tool only — an agent could park work on hold while
  the dashboard and CLI could not. Added the `move` action to `POST /kanban`.
  The store still refuses terminal and blocked transitions, so the route cannot
  be used to skip the completion handoff or the blocker bookkeeping.
- **Config had to go through the daemon's own API.** `~/.openagi/.env` is a
  managed file — a hand append is discarded on the next boot, which is why the
  earlier attempt kept vanishing. Restarted first so the new allowlist was in
  memory, then `POST /setup/save` returned `keys: [OPENAGI_MAX_TURN_SECONDS,
  OPENAGI_WALL_CLOCK_CHECKPOINTS]` (previously `[]`) and the values survived the
  restart.
- Live verification on the running daemon (pid rotated, `supervised: true`):
  boot-time env resolves `maxTurnSeconds: 1200` / `wallClockCheckpoints: 3` =
  **80 minutes** of runway; and a real task walked
  backlog -> on-hold -> review -> done over HTTP, with `?status=on-hold` and
  `?status=done` both returning it, the unfiltered board correctly keeping it
  out of `tasks` and in `completed`, and moving a completed task still refused.
MERGE REVIEW COMPLETE
## 2026-07-25 - Evidence-aware routing and quality-preserving preparation (Codex)

- Added bounded completion contracts for code changes, UI changes, code verification, and UI verification while leaving explanation, research, ordinary chat, cron, and autopilot turns unchanged.
- Both paid provider loops now reject unsupported completion claims, issue at most one compact evidence retry, and label unresolved work incomplete; failed, blocked, pending, unrelated, or uncertain tool calls cannot satisfy the gate.
- Bound code completion to same-turn project mutation plus passing code evidence, and bound user-facing UI work to passing browser and visual QA. Deterministic and provider-unavailable fallbacks can no longer imply actionable work completed.
- Added request-local tool preferences that keep coder and QA schemas directly visible through progressive disclosure and model-tool caps without widening project, profile, specialist, read-only, or exact-tool boundaries.
- Started late-bound context expansion immediately after scrutiny and overlapped it with independent principle and ambient reads, preserving exact prompt bytes while removing avoidable serial latency.
- Added content-free completion status, evidence counts, and retry visibility to Run Inspector, persisted bounded evidence state with assistant outcomes, and kept MoA reference analysts outside the aggregator's completion contract.
- Validation: `OPENAGI_AUTO_APPROVE=0 npm test` and `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy` each pass 1717/1718 tests with zero failures and one intentional Windows permission-mode skip.
EVIDENCE ROUTING COMPLETE

- 2026-07-27T04:00:19.94Z · **azazel** · edit `src/skills.js` — Emit live skill-use and skill-edit observability events from the skill registry
- 2026-07-27T04:04:38.65Z · **azazel** · edit `src/discord-channel.js` — Prepare Discord channel for throttled rich activity cards
- 2026-07-27T04:07:38.2Z · **azazel** · edit `src/discord-channel.js` — Add rich Discord observability cards and tool-lane visuals for skills, learning, vision, computer-use, and debug activity
- 2026-07-27T04:07:50.9Z · **azazel** · edit `src/hosted-interface.js` — Broadcast skill, learning, and vision telemetry to the dashboard SSE lane
- 2026-07-27T04:08:36.96Z · **azazel** · edit `src/hosted-interface.js` — Add Ops tab structure, navigation, state, and styling to the dashboard
- 2026-07-27T04:12:09.262Z · **azazel** · edit `src/hosted-interface.js` — Implement the unified Ops dashboard feed and event classifier
- 2026-07-27T04:23:46.84Z · **azazel** · edit `src/model-provider.js`
- 2026-07-27T04:24:07.748Z · **azazel** · edit `src/model-provider.js`
- 2026-07-27T04:26:05.37Z · **azazel** · edit `test/model-provider-iterations.test.js`
- 2026-07-27T04:27:27.72Z · **azazel** · edit `CHANGES.md`
- 2026-07-27T04:49:48.20Z · **azazel** · edit `src/agent-host.js`
- 2026-07-27T04:49:48.26Z · **azazel** · edit `src/discord-channel.js`

## 2026-07-27 - Upgrade batch Item C: budgeted memory and structured spill (Codex)

- Added a clean-room, append-only memory tree with 320-byte log records,
  288-byte positional summary records, age-decayed budget covers, in-band merge
  requests, bounded wake/zoom/merge/regex-recall commands, and oldest-first
  migration from the existing durable memory state. No OptMem source was
  inspected, fetched, copied, or vendored.
- Preserved project, specialist, and profile isolation with one independently
  indexed tree per memory scope. Existing durable memory remains authoritative;
  the summary tree is a rebuildable cache and projection failures fail open.
- Added PageIndex-inspired, MIT-attributed structural spill indexing for tool
  results over the configured threshold. Markdown headings are code-fence
  aware, then diff boundaries, paragraphs, and bounded line windows provide
  exact `read_spill` retrieval without retaining oversized results in context.
- Added agent-visible `memory_wake`, `memory_zoom`, `memory_merge`,
  `memory_tree_recall`, and `read_spill` tools, including conditional prompt
  documentation and chat/specialist visibility only while the feature is on.
- Added per-request `memoryBytesInjected`, `spillCount`, `mergesRequested`, and
  `mergesCompleted` ledger counters without changing historical row shape when
  the feature is off.
- Kill switch: `OPENAGI_MEMTREE` is default-off; any value other than `1`
  restores the prior memory injection, tool-output truncation, tool catalog,
  and prompt bytes. `OPENAGI_WAKE_BUDGET`, `OPENAGI_SPILL_BYTES`, and
  `OPENAGI_MEMORY_ENTRY_CHARS` are setup-wizard allowlisted.
- Added zero npm dependencies. Added-line byte scan found zero non-ASCII lines;
  package manifests are unchanged.
- Validation: focused memory/provider/tool regressions pass 119/119. Required
  full `node --test --test-concurrency=1` passes 1883/1883 with zero failures
  and zero skips.
UPGRADE BATCH ITEM C COMPLETE

## 2026-07-27 - Upgrade batch Item E: per-domain browser learnings (Codex)

- Added a bounded, notes-only `learnings/<site>/manifest.json` plane that
  matches exact hostnames and `*.` subdomain patterns, then injects local
  procedural guidance only when the semantic browser's existing
  `domainChanged` result is true.
- Wired the store through `SkillRegistry` so browser guidance and reusable
  skills share one procedural-memory boundary. Open, explicit navigation, and
  activation-driven navigation use the same fail-open hook; ordinary inspect
  and same-origin navigation retain their prior response shape.
- Copied ego-lite's security-relevant `relativeSitePath()` helper verbatim and
  added its MIT attribution and full license notice. Manifest, directory,
  note-count, per-note, and aggregate-byte bounds are enforced; malformed
  files, traversal, absolute paths, symlinks, and containment escapes are
  skipped without breaking navigation.
- Deliberately excluded ego-lite's executable `nodeTools` and `browserTools`
  plane. Those fields are never imported, loaded, advertised, or returned, and
  a regression test proves a declared executable module cannot run.
- Kill switch: `OPENAGI_DOMAIN_LEARNINGS` is setup-wizard allowlisted and
  default-off. Any value other than `1` avoids store creation and preserves the
  previous semantic-browser output shape.
- Added zero npm dependencies. Added-line byte scan found zero non-ASCII lines;
  package manifests are unchanged.
- Validation: focused domain-learning, semantic-browser, and skill-registry
  coverage passes 43/43. Required fresh, isolated
  `node --test --test-concurrency=1` passes 1890/1890 with zero failures and
  zero skips.
UPGRADE BATCH ITEM E COMPLETE

## 2026-07-27 - Upgrade batch Item F: self-optimization safety patterns (Codex)

- Added a clean-room, Node-stdlib-only self-optimization controller from the
  four behavioral requirements in the local plan. No
  world-model-optimizer source was cloned, fetched, inspected, copied, or
  vendored.
- Generalized copy-not-guess preconditions into canonical SHA-256 surface
  snapshots and `applyDelta`: every target hash is verified synchronously
  before one commit callback can run, duplicate targets fail closed, and
  proposer-supplied identity fields are rejected in favor of resolver-owned
  ground truth.
- Applied the hash gate to the existing scrutiny fitter. Staged multi-judge
  weight changes now reject atomically when any live surface is stale, persist
  the complete verified set before changing live weights, and audit previous
  and successor hashes through the existing JSONL history.
- Wired completion-evidence reports into an objective optimization reward
  without preempting user feedback. Unsupported success claims score zero;
  honest incomplete work retains requirement-level partial credit; structured
  test summaries retain exact passed/total credit instead of collapsing to a
  binary result.
- Added deterministic failure signatures and bounded clustering from
  structured status, code, missing-evidence, test-count, and tool-receipt
  fields only. Assistant prose is never incorporated into a failure label.
- Added strict-improvement selection: equal-scoring successors cannot replace
  the incumbent, and equal better successors retain their earliest stable
  order, preventing neutral-score drift.
- Kill switch: `OPENAGI_SELF_OPTIMIZATION` is setup-wizard allowlisted and
  default-off. Any value other than `1` omits the controller, outcome reward,
  and fitter hash/reward paths.
- Added zero npm dependencies. The implementation adds no agent-facing tools,
  dynamic imports, external services, routing changes, or telemetry vendors.
- Validation: focused self-optimization, completion-evidence, outcome, and
  runtime coverage passes 135/135. Required isolated
  `node --test --test-concurrency=1` passes 1900/1900 with zero failures and
  zero skips.
UPGRADE BATCH ITEM F COMPLETE

## 2026-07-27 - Upgrade batch Phase 1 completion (Codex)

- Completed and independently committed work items A, B.0, B.1/B.2, B.3, D,
  C, E, and F in the required dependency order. No work item was skipped.
- Every implementation commit was full-suite green before push and was pushed
  to `origin/codex/upgrade-batch-2026-07`.
- The branch adds no npm dependency or package-manifest change, leaves the
  verified `task: "prompt"` cron discriminator untouched, and contains the
  required MIT notices plus explicit clean-room boundaries for both
  all-rights-reserved references.
- Final implementation-tree validation:
  `node --test --test-concurrency=1` passes 1900/1900 with zero failures and
  zero skips.
UPGRADE BATCH PHASE 1 COMPLETE

## 2026-07-27 - Autonomous skills and budget phase baseline (Codex)

- Required untouched Linux/WSL baseline:
  `node --test --test-concurrency=1` passed 1904/1904 with zero failures and
  zero skips in 373.98 seconds.
- The initial native-Windows `node --test` diagnostic passed 1898/1904 with
  four failures and two skips: two concurrent writers contended on the shared
  default outcome snapshot, one mailbox byte-count assertion observed CRLF
  sizing, and one checkpoint timing assertion flaked.
- A native serial diagnostic passed 1901/1904 with only the platform-specific
  mailbox byte-count assertion failing and two platform skips. The required
  implementation gates use the green, isolated Linux/WSL lane above.

## 2026-07-27 - Optional budget guard and live limit control (Codex)

- `OPENAGI_DAILY_USD_LIMIT` now has an explicit uncapped state. Its default is
  `10` USD/day when unset or blank. `off`, `none`, `unlimited`, and `disabled`
  disable enforcement while retaining complete spend accounting. Zero,
  negative, infinite, and nonnumeric values now throw with instructions to use
  `off`, preventing both a bricked daemon and an accidental NaN bypass.
- Added the published Kimi K3 rates as of 2026-07-27: $3/MTok cache-miss
  input, $0.30/MTok cache-hit input, and $15/MTok output.
- Unknown model ids now emit one estimate warning per model and are exposed as
  `unpricedModels` in budget status. Exact and longest-prefix price matches do
  not warn.
- Added authenticated `POST /budget/limit`, which shares the environment
  resolver, persists through the existing secrets-backed setup allowlist, and
  updates the running guard only after persistence succeeds.
- The Credits pane now has explicit Enabled and Disabled controls, shows
  uncapped spend safely, and surfaces estimated-pricing warnings. Dashboard
  health, Discord budget output, and introspection also understand the
  disabled state.
- No new environment variables and no npm dependencies were added. Focused
  syntax, budget, ledger, HTTP, and dashboard coverage passes 14/14. The
  required isolated `node --test --test-concurrency=1` gate passes 1910/1910
  with zero failures and zero skips.

## 2026-07-27 - Autonomous skill lifecycle (Codex)

- High-confidence mined skill candidates now materialize without a dashboard
  click through the existing candidate/suggestion writers. Every creation keeps
  revision history, records its gate values and `skill-autocurator` lineage,
  reloads the registry, honors a durable UTC daily cap, leaves failed gates
  pending, and emits `skill-autocreated` for visibility.
- The curator now defaults to useful coverage, seeds missing activity instead
  of exempting it forever, gives never-used skills a grace floor, protects
  every pinned or cron-referenced skill, and reports seeded and per-exemption
  counts. Bundled pruning and agent-only scope remain explicit overrides.
- Usage JSONL rows now record backward-compatible `ok` or `error` outcomes for
  both loaded and executed skills. Eligible unpinned skills receive at most one
  focused model patch per attempt; patches apply only through `patchSkill`, so
  `appendSkillRevision` and `rollback_skill` cover every autonomous edit.
  Invalid, ambiguous, and no-op patches leave the skill untouched and are
  logged rather than falling back to a rewrite.
- The daily curator task and Discord command now run and report the ordered
  materialize, curate, and improve lifecycle as one combined result.
- `OPENAGI_SKILL_AUTOCURATE` now defaults to `off`; when unset, mined
  candidates remain pending for owner review. Automatic materialization
  remains available only through an explicit `1`, `true`, `on`, or `yes`.
  This corrects the earlier agent-authorship design: the agent may author
  skills at will, while statistical pattern proposals remain human-reviewed.
- `OPENAGI_SKILL_AUTO_CONFIDENCE` defaults to `0.8`; when unset, candidates
  below 0.8 confidence stay pending.
- `OPENAGI_SKILL_AUTO_MIN_OCCURRENCES` defaults to `3`; when unset, patterns
  seen fewer than three times stay pending.
- `OPENAGI_SKILL_AUTO_MAX_PER_DAY` defaults to `3`; when unset, at most three
  candidates materialize per UTC day. `off`, `none`, or `unlimited` removes the
  cap; `0` now throws and directs operators to use `off`.
- `OPENAGI_CURATOR_PRUNE_BUNDLED` defaults to `off`; when unset, bundled skills
  are always exempt from transitions.
- `OPENAGI_CURATOR_SCOPE` defaults to `all`; when unset, every unpinned,
  non-exempt skill is curated. `agent-created` preserves the narrower scope.
- `OPENAGI_SKILL_IMPROVE_MIN_USES` defaults to `5`; when unset, five
  post-revision uses or one recorded failure makes a skill eligible.
- `OPENAGI_SKILL_IMPROVE_MAX_PER_RUN` defaults to `2`; when unset, at most two
  skills are attempted per pass. Setting it to `0` disables improvements.
- All eight fields use the setup allowlist. No npm dependency or package
  manifest changed. Focused lifecycle, registry, runtime, and Discord coverage
  passes 60/60. The required isolated
  `node --test --test-concurrency=1` gate passes 1925/1925 with zero failures
  and zero skips in 363.55 seconds.

## 2026-07-27 - Skill authorship and review queue phase baseline (Codex)

- The required untouched phase baseline is 1901 passing, zero failing, and 24
  skipped browser-dependent QA tests. Every implementation gate must retain at
  least 1901 passing tests with zero failures.
- This clone's isolated WSL baseline ran the optional browser lane and passed
  1925/1925 with zero failures and zero skips in 468.78 seconds.

## 2026-07-27 - Skill authorship at will (Codex)

- `create_skill` and `edit_skill` are now chat-core and always-direct through
  tool radar, so resolved conversational model requests retain both authoring
  schemas after fast-lane and model-tool-budget trimming. `delete_skill` and
  `pin_skill` remain outside the core surface.
- The always-on skill index now tells the model to create a reusable procedure
  after non-trivial work, tricky fixes, repeatable discoveries, or owner
  corrections; it retains the immediate `edit_skill` repair instruction and
  no longer encourages reflexive deletion.
- Agent-authored `create_skill` remains unlimited and keeps the existing
  default-project preflight and revision path. The changed
  `OPENAGI_SKILL_AUTO_MAX_PER_DAY` still defaults to `3`; when unset or blank,
  mined auto-materialization is capped at three per UTC day. `off`, `none`, and
  `unlimited` now mean no cap, while `0`, negatives, fractions, and invalid
  values throw with instructions to use `off`.
- Pinned skills now reject both targeted and full edits until explicitly
  unpinned. Successful creation and editing still use `appendSkillRevision`,
  preserving `rollback_skill`.
- No npm dependency or package manifest changed. Focused authorship, skill
  registry, project-boundary, tool-radar, and cap coverage passes 85/85. The
  isolated `node --test --test-concurrency=1` gate passes 1929/1929 with zero
  failures and zero skips in 353.97 seconds.

## 2026-07-27 - Human skill-candidate review queue (Codex)

- Pattern mining now proposes instead of writing by default. The changed
  `OPENAGI_SKILL_AUTOCURATE` defaults to `off`; unset, blank, `0`, `off`, and
  unrecognized values leave candidates pending. Explicit `1`, `true`, `on`,
  or `yes` preserves the opt-in automatic materialization path and its daily
  cron behavior.
- Candidate verdicts are validated and now include `deferred`, which is hidden
  from the default pending view but available through the deferred filter, and
  `edited`, which persists the owner's revised name and body before
  materializing it with `editedByOwner: true` lineage.
- Both dashboard skill surfaces expose Accept, Edit & Accept, Defer, and
  Discard controls with occurrence and confidence evidence. The Suggestions
  view can toggle between pending and deferred queues.
- Pattern proposals emit advisory `skill-candidate-proposed` events with their
  evidence. The dashboard event stream, durable outreach feed, and Discord
  activity lane surface the new review request.
- The legacy pattern-miner Accept endpoint now uses the shared skill
  materializer, so its writes also call `appendSkillRevision` and remain
  compatible with `rollback_skill`.
- No new environment variables, npm dependencies, or package manifest changes
  were added. Focused lifecycle, HTTP, dashboard-script, project-boundary,
  miner-event, outreach, and Discord coverage passes 166/166. The complete
  247-file Windows-compatible `node --test --test-concurrency=1` gate passes
  1930 tests with zero failures and two pre-existing skips, above the required
  1901-pass floor. Bare Windows discovery additionally ran the three compatible
  mailbox tests successfully; its only failure was the untouched POSIX
  directory-mode assertion (`0700` reads as `0666` on Windows).

## 2026-07-27 - Session-scoped trace routing phase baseline (Codex)

- The required untouched phase baseline is 1912 passing, zero failing, and 24
  skipped browser-dependent QA tests. Both workstream gates must retain at
  least 1912 passing tests with zero failures.

- 2026-07-27T09:34:01.345Z · **azazel** · edit `CHANGES.md` — Re-apply Azazel changelog additions onto origin/main version during rebase
- 2026-07-27T10:39:07.440Z · **azazel** · edit `src/pending-actions.js`
- 2026-07-27T10:39:40.489Z · **azazel** · edit `test/pending-actions-hardening.test.js`
- 2026-07-27T12:07:09.057Z · **azazel** · edit `drafts/goal-mode-e2e-verification-checklist.md` — Refresh header to cover 2026-07-27 planner re-issue of the goal-mode checklist task
- 2026-07-27T12:16:54.501Z · **azazel** · edit `src/agent-host.js` — memtree observability site 1: bind + rate-limit per-turn wake failures, log merge pressure on success
- 2026-07-27T12:16:54.517Z · **azazel** · edit `src/abi-runtime.js` — memtree observability site 2: log enabled state with dir/migrated/spill details; failure warn now carries stack and states the degradation
- 2026-07-27T12:52:00.000Z · **seraphim** · edit `src/memory-system.js` — memtree observability site 3: projection failures now name item id/scope/tier, carry the stack, and state the tiered-memory↔memory-tree divergence; successful projections log pending merge pressure
- 2026-07-27T12:52:00.000Z · **seraphim** · edit `src/spill-store.js` — memtree observability site 4: spill journal replay no longer falls back silently — snapshot fallback and unrecoverable-truncation paths both warn with sequences/entry counts; snapshot-write failure carries stack and names the degraded recovery posture

## 2026-07-27 - Session-scoped skill telemetry (Codex)

- Skill use and edit telemetry now retains the originating agent session from
  the tool, Discord command, and skill execution boundaries. Every authoring
  tool passes its session through the existing guarded revision path.
- Autonomous curator transitions, improvement patches, and skipped
  improvements pass an explicit null session. Dashboard operations also pass
  null rather than inventing a conversational identity.
- The curator-facing skill usage JSONL records are byte-schema compatible:
  session identity is present only on advisory runtime events.
- Discord skill deletion confirmations retain and verify their originating
  session before emitting the delete trace. Existing owner, project, pin, and
  revision guards remain intact.
- No environment variable, npm dependency, or package manifest changed.
  Focused session, authoring, curator, and Discord coverage passes 61/61.
  The serial Windows-compatible full lane passes 1930 tests with zero
  failures and two pre-existing skips; the three compatible mailbox tests
  pass separately. Raw serial discovery passes 1934 tests and reaches only
  the untouched POSIX mode assertion, where NTFS reports 0666 instead of
  0700. This remains above the required 1912-pass baseline.

## 2026-07-27 - Fail-safe Discord activity routing (Codex)

- Activity routing now resolves only from an event's Discord session or this
  adapter's configured activity channel. The mutable last-inbound-channel
  state and its assignment were deleted.
- Both text and embed feeds pass through one fail-closed destination guard.
  Configured guild and channel restrictions are cumulative, so two Legion
  agents in the same guild cannot post traces into each other's configured
  channels.
- Unresolved and out-of-allowlist feed items are dropped with a
  `feed-dropped` diagnostic naming the reason and feed kind.
- Catastrophic approval cards require a resolvable session and the same
  allowlist check. A sessionless card is dropped instead of falling back to a
  home or recently active channel.
- The owner-reported regression was reproduced before the fix: the required
  routing file passed 3 tests and failed 5, including the distinct
  last-active sentinel. The additional same-guild cross-agent test also
  failed red before the cumulative allowlist guard.
- No environment variable, npm dependency, or package manifest changed.
  All 76 Discord tests pass. The serial Windows-compatible full lane passes
  1939 tests with zero failures and two pre-existing skips; the three
  compatible mailbox tests pass separately. This remains above the required
  1912-pass baseline.

- 2026-07-28T10:48:17.500Z · **azazel** · edit `src/hosted-interface.js` — Cerberus pet: delta-time animation clock (fixes vsync judder at 15fps), time-scaled movement/timers, smoothed gaze easing
- 2026-07-28T12:18:59.561Z · **azazel** · edit `drafts/goal-mode-e2e-verification-checklist.md` — Cover 2026-07-28 re-issue of checklist draft
- 2026-07-28T13:16:22.769Z · **azazel** · edit `src/task-store.js` — Autopilot queue metrics: startedAt on claim, claimNextAgentTask pop-and-claim, stranded-claim reclaim after 2h
- 2026-07-28T13:16:39.729Z · **azazel** · edit `src/tool-registry.js` — Approvals: default decision-wait 300s to 30min; agent_pick_next claims the task for duration metrics
- 2026-07-28T13:18:02.468Z · **azazel** · edit `src/discord-channel.js` — Approvals to Discord: button cards for all suspended approvals (not just catastrophic), env-aware 30min card expiry; task-updated autopilot feed with queue/work
- 2026-07-28T13:20:38.431Z · **azazel** · create `test/autopilot-queue-visibility.test.js`
- 2026-07-29T02:32:01.635Z · **azazel** · rewrite `src/integrations/delegate-task.js` — delegation: waves auto-chunking, verify hints, per-child metrics, async mode with delegate_status/_steer/_cancel
- 2026-07-29T02:33:53.607Z · **azazel** · create `test/delegate-async.test.js` — tests for async delegation waves, verify hints, steer, cancel, and metrics
- 2026-07-29T02:37:15.401Z · **azazel** · edit `test/delegate-task.test.js`
- 2026-07-29T02:37:39.558Z · **azazel** · edit `test/delegate-task.test.js`
- 2026-07-29T03:48:39.879Z · **azazel** · edit `src/integrations/delegate-task.js`
- 2026-07-29T03:49:00.247Z · **azazel** · edit `test/delegate-task.test.js`
- 2026-07-29T04:16:32.041Z · **azazel** · edit `src/integrations/web-search-providers-kimi.js` — Remove hardcoded temperature:0.3 — Kimi coding endpoint rejects any temperature except 1
- 2026-07-29T04:16:46.742Z · **azazel** · edit `test/web-search-kimi.test.js` — Invert temperature assertion: field must now be absent (endpoint rejects temperature != 1)
- 2026-07-29T04:34:20.589Z · **azazel** · edit `src/integrations/web-search-providers-kimi.js` — Decouple web-search model from agent base model: KIMI_WEB_SEARCH_MODEL override, default kimi-for-coding (kimi-k3 breaks $web_search tokenization)
- 2026-07-29T04:34:20.610Z · **azazel** · edit `test/web-search-kimi.test.js` — Pin search-model override to KIMI_WEB_SEARCH_MODEL, add ANTHROPIC_MODEL isolation regression test
- 2026-07-29T05:20:03.587Z · **azazel** · edit `src/integrations/web-search-providers-kimi.js` — Remove url:null pseudo-result fallback so Kimi refusals trigger provider fall-through
- 2026-07-29T05:20:03.612Z · **azazel** · edit `test/web-search-kimi.test.js` — Invert multi-hop test: prose-only answer now asserts fail-closed empty answer instead of pseudo-result
- 2026-07-29T12:19:37.952Z · **azazel** · create `drafts/provider-auth-dashboard-outline.md` — Draft: provider-auth dashboard functional outline and wireframe (draft-only planner task)
- 2026-07-29T12:49:18.575Z · **azazel** · edit `drafts/goal-mode-e2e-verification-checklist.md` — Extend verification checklist with dashboard/auth/provider-state section for 2026-07-29 re-issue
- 2026-07-29T13:19:04.328Z · **azazel** · create `drafts/deep-work-block-provider-auth-dashboard.md` — Draft 3h deep-work calendar block proposal (draft-only, not scheduled)
- 2026-07-29T13:19:29.903Z · **azazel** · create `drafts/eod-progress-reminder-2026-07-29.md` — Draft 5:30 PM ET end-of-day progress reminder (draft-only, not scheduled)

## 2026-07-29 - Cline RSI port Wave 1 baseline (Codex)

- The verified Linux baseline is 2083 tests, 2059 passing, zero failing, and
  24 browser-dependent skips.
- Untouched Windows discovery ran the same 2083 tests with 2080 passing, one
  failing, and two skips. The sole failure is the pre-existing POSIX mailbox
  mode assertion: NTFS reports 0666 where the Linux contract requires 0700.
  Each fix will be gated with the complete Windows-compatible lane plus the
  three compatible mailbox tests, and final raw `npm test` counts will also
  be reported honestly.

## 2026-07-29 - Cline RSI Wave 1 Fix 1: safe shell lifecycle guidance (Codex)

- Extended the `code_shell` description at the verified
  `src/code-tools.js:1056` anchor without removing its existing approval and
  specific-tool guidance.
- The agent-facing contract now requires non-interactive commands, exact PID
  or process-group capture for background work, and rejects broad `pkill -f`
  or `killall` cleanup that can terminate the supervising harness.
- The new registry-description regression failed red at 8 passing and one
  failing, then passed 9/9 after the guidance was added.
- The complete Windows-compatible `npm test` lane passes 2081 tests with zero
  failures and two pre-existing skips. No environment variable, dependency,
  or package manifest changed.

## 2026-07-29 - Cline RSI Wave 1 Fix 3: direct unref regression guard (Codex)

- Added a zero-dependency repository scanner and test that reject direct
  `.unref()` calls anywhere under `src/**/*.js`. A future legitimate direct
  unref must add an explicit allowlist entry with a comment proving no
  foreground caller awaits the timer.
- Reality was narrower than the assessment wording: direct `.unref()` calls
  are absent as verified, but intentional optional `.unref?.()` calls already
  exist on background timers and child processes. The guard's synthetic
  cases lock that distinction instead of falsely failing existing explicit
  background lifecycle sites.
- The regression failed red because the guard module did not exist, then
  passed 2/2 after the scanner was added.
- The complete Windows-compatible `npm test` lane passes 2085 tests with zero
  failures and two pre-existing skips. No environment variable, dependency,
  or package manifest changed.

## 2026-07-29 - Cline RSI Wave 1 Fix 2: provider retry window (Codex)

- Updated the verified retry constants in `src/model-provider.js`: the
  default retry budget is now five and the maximum computed single delay is
  30 seconds. Retry classification, `Retry-After` precedence, request-only
  scope, and non-retryable behavior are unchanged.
- A four-consecutive-429 regression failed red because the old default
  exhausted before the fifth request. The computed-delay regression also
  failed red with 8/8-second waits instead of 20/30 seconds.
- The retry, error-classifier, and malformed Anthropic input lane passes
  23/23. It includes the existing single-attempt 400 and explicit
  `Retry-After` precedence locks.
- The complete Windows-compatible `npm test` lane passes 2083 tests with zero
  failures and two pre-existing skips. No environment variable, dependency,
  or package manifest changed.

## 2026-07-29 - Cline RSI Wave 1 Fix 4: reasoning-effort requests (Codex)

- Added the canonical `minimal | low | medium | high | xhigh | max` resolver
  and threaded optional reasoning configuration through every OpenAI
  Responses and Anthropic request path, including goal judges, forced
  answers, and context estimates.
- OpenAI reasoning-capable models receive `reasoning: { effort }`. Supported
  Anthropic models receive `thinking: { type: "enabled", budget_tokens }`
  using one model-independent proportional budget calculation rather than a
  per-model downgrade table. Unsupported routes omit the field and emit a
  deduplicated debug note.
- `OPENAGI_REASONING_EFFORT` is now setup-wizard persistable. Its default,
  unset, blank, invalid, and unreadable behaviors all omit reasoning fields
  entirely, preserving the pre-feature request bytes and prompt-cache keys.
- The first regression failed red because the exported canonical resolver
  did not exist. A separate hostile-value regression then failed red at
  provider construction and drove the fail-open configuration boundary.
  All seven reasoning tests now pass.
- Existing provider, prompt-cache, routing, iteration, compression, and
  context-ledger coverage passes 97/97. The complete Windows-compatible
  `npm test` lane passes 2092 tests with zero failures and two pre-existing
  skips. No dependency or package manifest changed.

## 2026-07-29 - Cline RSI Wave 1 Fix 5: output-aware progress (Codex)

- Extended the existing per-turn tool-call fingerprint entries with bounded
  successful-output signatures and independent repeated-success counters.
  Changing output resets its call's streak and emits a progress verdict;
  identical output emits one `repeated_no_progress` advisory exactly at the
  configured threshold without suppressing tool dispatch.
- The pure exported `evaluateRepeatedOutcome` comparison implements the Cline
  PR #12465 rule inside OpenAGI's existing tracker. `src/tool-registry.js`
  carries the required Apache-2.0 attribution header. Existing failure
  damping and `allowedAttempts` behavior are unchanged.
- Output hashing reuses `toolFailureFingerprint` after the existing semantic
  result snapshot bound. If comparison or hashing fails, the registry restores
  the prior delete-on-success behavior and never blocks the turn.
- `OPENAGI_REPEATED_SUCCESS_LIMIT` is now setup-wizard persistable. It defaults
  to 8 when unset; blank, non-integer, unsafe, or values below 2 also fail open
  to 8.
- The new test file failed red because the pure comparison export did not
  exist. The focused comparison, polling, failure, security, and outcome lane
  passes 41/41. The complete Windows-compatible `npm test` lane passes 2100
  tests with zero failures and two pre-existing skips. No dependency or
  package manifest changed.

## 2026-07-29 - Cline RSI Wave 1 Fix 6: progress-aware wall clock (Codex)

- Added one trusted per-turn progress counter fed by Fix 5's already-computed
  successful-output verdict. The provider does not hash or compare tool output
  a second time.
- A checkpoint with new progress now grants a free extension without
  decrementing the existing charged budget, up to a separate bounded cap.
  Once that cap is exhausted, or when output made no progress, charged
  checkpoints behave exactly as before. The absolute bound is
  `maxTurnSeconds * (1 + checkpoints + freeExtensions)`.
- Checkpoint prompts, lifecycle events, and Discord activity messages expose
  whether progress was observed and whether the extension was free or charged.
  Forced-answer guidance and local hard-stop summaries now distinguish a stop
  while making progress from a stop with no new output-aware progress.
- `OPENAGI_WALL_CLOCK_FREE_EXTENSIONS` is setup-wizard persistable. It defaults
  to 3 when unset, blank, invalid, unsafe, or unreadable. An explicit `0`
  disables progress-aware free extensions.
- The clock-injected regression file failed red at 0 passing and 3 failing
  before implementation. Its final OpenAI, Anthropic, no-progress, bounded
  forever-progress, Discord visibility, and fail-open coverage passes 5/5
  without sleeping. The broader related provider and registry lane passes
  78/78.
- The complete Windows-compatible `npm test` lane passes 2105 tests with zero
  failures and two pre-existing skips. No dependency or package manifest
  changed.

## 2026-07-29 - Cline RSI port Wave 1 completion (Codex)

- The final literal Linux `npm test` ran in this exact clone under WSL and
  passed all 2108 tests with zero failures and zero skips. This is 25 new
  passing tests above the verified 2059-pass Linux baseline.
- The literal Windows-native run continued to expose the baseline NTFS mailbox
  mode mismatch and also caught one load-sensitive 10ms wall-clock fixture.
  That timing fixture immediately passed 1/1 in isolation, while the complete
  Windows-compatible lane passed 2105 tests with zero failures. The Linux raw
  lane is authoritative for the POSIX permission assertion.
- All six independently revertable fix commits are pushed to
  `origin/codex/cline-rsi-wave-1`. No daemon was restarted or modified, no npm
  dependency was added, and no package manifest changed.

CLINE RSI PORT WAVE 1 COMPLETE

## 2026-07-29 - Mutation lease Wave 2 baseline (Codex)

- Untouched `codex/wave-2-mutation-lease` at `f5e1115` passed the literal
  Linux `npm test` lane with 2108 tests passing, zero failures, and zero skips.
  The available Node 25 runner executes the 24 tests skipped in the verified
  Node/browser-dependent baseline, so both measurements satisfy the required
  2084-pass floor.
- No daemon or process was restarted, no environment variable was pinned, and
  no package manifest changed.

## 2026-07-29 - Mutation lease Wave 2 Fix 1: lease metadata (Codex)

- Extended the verified foreground entry at `src/job-manager.js:386` with its
  stable lease ID, bounded tool owner ID, acquisition time, session/job IDs
  when available, an explicit non-persistent flag, and the existing normalized
  resource locks. Raw tool arguments are never stored.
- Persistent workspace reservations retain `persistent: true` and now carry
  the same safe metadata. A manager-level snapshot clones only diagnostic
  fields and is the foundation for the read-only status tool.
- Added an injected `now` seam without changing the existing release path.
  The regression failed red because `inspectMutationLeases` did not exist,
  then passed while proving foreground and persistent metadata, secret
  exclusion, removal, and idempotent release.
- The focused job, locking, receipt, and hostile-value lane passes 48/48. The
  literal Linux `npm test` lane passes 2109 tests with zero failures and zero
  skips. No environment variable, dependency, or package manifest changed.

## 2026-07-29 - Mutation lease Wave 2 Fix 2: unblockable status (Codex)

- Registered `mutation_lease_status` with `sideEffects: false` beside the
  durable job controls. It returns bounded, redacted foreground, active
  durable, and quarantined holders with owner, source, age, session/job,
  persistence, and normalized resource-lock metadata; raw arguments are never
  read or returned.
- Added the tool to the chat core, the tool-radar always-direct set, and the
  model-visible tool instructions. This keeps lease diagnosis directly
  advertised on a trimmed casual turn and callable while a conflicting write
  lease is held.
- The locking regression was written first and failed 0/2 because the tool and
  descriptor did not exist. It now proves two held foreground leases retain
  deterministic injected-clock ages, secret-shaped arguments stay absent,
  status dispatch succeeds through `ToolRegistry`, and durable/quarantined
  blockers also appear.
- The focused durable-job, chat-fastlane, and tool-search lane passes 35/35.
  The literal Linux `npm test` lane passes 2110 tests with zero failures and
  zero skips. No environment variable, dependency, or package manifest
  changed.

## 2026-07-29 - Mutation lease Wave 2 Fix 3: actionable conflicts (Codex)

- Replaced all six generic foreground, durable, and quarantined mutation and
  workspace-reservation conflict messages at the verified
  `src/job-manager.js` anchors with one bounded diagnostic formatter. Errors
  retain the built-in `Error` shape and recognizable conflict category while
  naming the safe holder, shortened lease ID, injected-clock age, bounded
  normalized locks, and `mutation_lease_status` recovery action.
- Quarantined entries now retain the same bounded holder/session metadata at
  quarantine time so diagnostics remain useful if their durable record can no
  longer supply it. No tool arguments are stored or interpolated.
- The regression was written first and failed 0/1 against the old generic
  message. It now proves an 18m4s holder is identified, secret-shaped lock
  content is redacted, the message is single-line and at most 700 characters,
  and the existing error class is unchanged.
- The focused durable-job lane passes 18/18. The literal Linux `npm test` lane
  passes 2111 tests with zero failures and zero skips. No environment variable,
  dependency, or package manifest changed.

## 2026-07-29 - Mutation lease Wave 2 Fix 4: lazy loud TTL reap (Codex)

- Added a 15-minute default TTL for non-persistent foreground mutation leases,
  evaluated synchronously and only when a conflicting mutation or workspace
  reservation scans that lease. No background timer was added, and the
  existing `ToolRegistry` release `finally` was not moved or restructured.
- `OPENAGI_MUTATION_LEASE_TTL_MS` is new and setup-wizard allowlisted. Unset or
  blank means the 900000ms default; `0` disables reaping; malformed, negative,
  accessor-failing, or unsafe-integer values also disable it fail-safe.
- Every successful reap emits a redacted warning with lease ID, owner, age,
  and bounded locks before deletion. Deletion is the final operation after the
  injected clock, redaction, warning sink, and bounded 64-entry status history
  all succeed. `mutation_lease_status` exposes that history with `reapedAt` and
  `reapedReason`.
- Persistent workspace leases are rejected before any TTL clock access and
  can never be reaped. Durable and quarantined blockers remain outside this
  reaper. Clock and warning failures retain the lease and preserve the prior
  conflict behavior.
- The required expiry regression was written first and failed 0/1 against the
  no-TTL implementation. Five injected-clock regressions now prove lazy
  unstick, loud diagnostics, persistent immunity, the `0` kill switch, and
  fail-safe throwing clock/logger behavior without sleeping.
- The focused durable-job, chat-fastlane, and tool-search lane passes 41/41.
  The literal Linux `npm test` lane passes 2116 tests with zero failures and
  zero skips. No dependency or package manifest changed.

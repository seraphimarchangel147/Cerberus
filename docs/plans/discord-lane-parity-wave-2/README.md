# Discord-Lane + Parity Wave 2 — Master Handoff (for Zed/Codex)

Owner: **Zed Codex agent** (heavy implementation). Reviewer/spec author: **Seraphim**.
Origin: Azazel's own deep-dive self-audit of `~/openagi` (draft `draft_0ec77a32daf541d1`),
file:line evidence spot-checked and corroborated by Seraphim against live source
2026-07-21. Creator directive: **"do 1/2/5 and scaffold the rest out for Zed to do
everything in one go — it's long agentic work."** So: run this whole wave as one
workhorse pass, phase by phase, in order.

## Standing Legion rules (read once, apply to EVERY phase)

- **Smart gates, not strict gates.** Auto-approve stays default-ON. Only the existing
  catastrophic class is hard-gated. Do NOT invent new approval friction. New tools are
  honestly side-effect-classified but not gratuitously gated.
- **House style:** plain Node ESM, zero framework. Comments explain WHY. Preserve
  `// Story N` lineage comments. New HTTP routes go in `src/hosted-interface.js` near the
  existing route group (`if (method && pathname.match(...))` chains, `sendJson` helper).
  New tools via `runtime.tools.register({...})`. Persist via `src/file-utils.js`
  (`appendJsonLine`, `writeJsonAtomic`, `writeTextAtomic`). Config knobs go in
  `WIZARD_FIELDS` so they're settable + documented.
- **Env pins live in the systemd unit, not just `.env`:**
  `~/.config/systemd/user/openagi-azazel.service` `Environment=` lines OVERRIDE
  `~/.openagi/.env`. Any new default you rely on being live must be checked there.
- **Test discipline:** `npm test` AND `npm run test:prod-policy` — BOTH green before a
  phase is done (currently ~617 each). Add a regression for every new module/behavior.
  Pin `OPENAGI_AUTO_APPROVE=0` ONLY in queue-semantics tests, NEVER in catastrophic-gate
  tests. Note: `npm test` while the daemon is LIVE can show ~18 spurious port-conflict
  failures on 43210 — re-run before concluding a regression.
- **Green tests ≠ feature fires.** Do NOT hardcode the gating condition in a fixture and
  call it proven (this bit us with the chat-fastlane band bug — 617/617 green while the
  feature was inert in prod). For any feature gated on a verdict / iteration cap /
  classifier / concurrency key: after both lanes pass, **LIVE-PROBE the running daemon**
  with a real representative input (authed `POST /message`, port 43210, Bearer token) and
  read the behavior metadata to prove it actually trips.
- **Homoglyph scan** every changed file AND filename before commit:
  `[\u0400-\u04ff\u2010-\u2011\uff00-\uffef]` (emoji in dashboard strings are legit — do
  not treat all non-ASCII as corruption).
- Log every capability change in `CHANGES.md`. Work on branch
  `codex/discord-lane-parity-wave-2` (one chained branch for the whole wave). **Do NOT
  push to main.** Hand back the final commit SHA + both-lane summaries for Seraphim review.

## Workhorse execution protocol (one pass, all phases)

Do the phases IN ORDER. After EACH phase: run both test lanes green, homoglyph-scan,
commit that phase with its own message, and append its **per-phase completion marker**
(below) as the last line of that phase's `CHANGES.md` entry. If a phase BLOCKS, commit
what's done, write the blocker into `CHANGES.md`, and CONTINUE to the next independent
phase — do not stall the whole wave on one snag. When ALL phases are done, add the FINAL
marker as the last line of `CHANGES.md`.

Per-phase markers (exact strings):
- P1 `DISCORD CONCURRENCY PHASE COMPLETE`
- P2 `PROVIDER RESILIENCE PHASE COMPLETE`
- P5 `APPROVAL SUSPENSION PHASE COMPLETE`
- P3 `CONTEXT COMPRESSION PHASE COMPLETE`
- P4 `MEMORY HOT PATH PHASE COMPLETE`
- P6 `PLAN MODE PHASE COMPLETE`
- P7 `MCP PER-TOOL PHASE COMPLETE`
- P8 `BACKGROUND REVIEW PHASE COMPLETE`
- P9 `STREAMING CHUNKING PHASE COMPLETE`
- P10 `SKILL PACK PHASE COMPLETE`
- P11 `SESSION SEARCH PHASE COMPLETE`
- P12 `DELEGATE GOVERNANCE PHASE COMPLETE`
- FINAL (last line of CHANGES.md) `DISCORD LANE PARITY WAVE 2 COMPLETE`

## Wave order

Do 1 → 2 → 5 first (the verified Discord-lane blockers Creator prioritized), then the
rest top-to-bottom. 1/2/5/3/4/6/7/8/12 are real-capability; 9/10/11 are polish.

| # | Spec file | Feature | Detail level | Risk |
|---|-----------|---------|--------------|------|
| 1 | `spec-01-discord-concurrency.md` | Per-user session keys + per-key concurrency (kill global busy-lock) | FULL | Med |
| 2 | `spec-02-provider-resilience.md` | Provider retry/backoff/failover + fix mid-batch orphaned function_call | FULL | Med |
| 5 | `spec-05-approval-suspension.md` | In-channel approval turn-suspension (resume after approve) | FULL | Med |
| 3 | `spec-03-context-compression.md` | Per-tool output caps + mid/cross-turn compaction | SCAFFOLD | Med-Lg |
| 4 | `spec-04-memory-hot-path.md` | FTS/BM25 recall, fix tier double-count, kill condenser pollution | SCAFFOLD | Med |
| 6 | `spec-06-plan-mode.md` | Plan mode (bundled `/plan`-work skill → loop support) | SCAFFOLD | Med |
| 7 | `spec-07-mcp-per-tool.md` | MCP per-TOOL selection + in-band overflow notice + tool search | SCAFFOLD | Med |
| 8 | `spec-08-background-review.md` | Post-turn self-improvement review on cheap aux model | SCAFFOLD | Med |
| 9 | `spec-09-streaming-chunking.md` | Streaming default-on + fence-aware chunker + bounded 429 retry | SCAFFOLD | Small |
| 10 | `spec-10-skill-pack.md` | Surface skill parse failures, per-skill tool allowlists, revision history | SCAFFOLD | Sm-Med |
| 11 | `spec-11-session-search.md` | bm25 rank + filters for session search; remove stale/typo tool alias | SCAFFOLD | Small |
| 12 | `spec-12-delegate-governance.md` | `delegate_subtask` governance parity (scrutiny/budget/audit) or delete | SCAFFOLD | Small |

## Corroboration notes (drift Seraphim already found — save Zed the rediscovery)

- **#7 is PARTLY BUILT.** `tool-registry.js:89-136` already has `options.only` filtering,
  per-server budget picking, and `_logToolCap()` that warns on overflow ("never silently
  drop tools"). So Azazel's "PostHog drops entirely, model never told" is STALE — the
  model IS told (via `console.warn`). #7 now = per-TOOL (not per-server) granularity +
  make the overflow notice in-band to the model + a `searcmcp_tools` tool. See spec-07.
- **#2 force-answer machinery EXISTS** (`forceAnswerPrompt()` at model-provider.js:365,
  used at :658/:910) but there is NO retry wrapping the two throw sites (:716 OpenAI,
  :1000 Anthropic). The retry/failover layer is genuinely absent. See spec-02.
- **#6 `/plan` already exists but is a DAILY PLANNER** (`discord-commands.js:407`
  computeDailyPlan), NOT a Hermes-style work-plan mode. Plan mode is genuinely missing.
- **#12 nesting guard EXISTS** (`code-tools.js` delegate_subtask checks
  `context?.channel === "subagent"`) but the handler bypasses the normal tool scrutiny /
  budget / audit path. It's a governance gap, not a nesting hole.
- **searcmcp_sessions "typo":** Seraphim could NOT corroborate a literal typo — grep shows
  it as an intentional name (`session-index.js`, CHANGES.md). Azazel to clarify; spec-11
  treats it as "confirm the tool name, remove any stale alias if one exists," not a
  guaranteed fix.

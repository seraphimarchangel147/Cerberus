# Hermes Parity Wave 3 — 19-Feature Upgrade Wave

> **Owner:** Seraphim (scaffold + review/QC)  **Implementer:** Zed / GPT-5.6-Soul (all coding, two phases)
> **Target repo:** Cerberus (openAGI) — Azazel's live harness at `~/openagi`
> **Base branch:** cut from the freshly-merged tip of `main` after `codex/session-key-migration` lands.
> **Policy:** smart-gates-not-strict (auto-approve ON; only catastrophic class hard-gated).

## What this wave is

The Creator asked Seraphim to crawl the full Hermes docs (hermesbible.com + the official
nousresearch docs), combine Azazel's own 8-item self-audit with Seraphim's 10-item gap analysis,
add a Legion secrets manager, and scaffold ALL 19 into a two-phase build that Zed executes and
Seraphim QCs. This README is the map; the two phase docs are the specs.

**Grep-first discipline already applied.** Before speccing, Seraphim inventoried the live `src/`
tree (85 files) against all 19 features. Each feature below is tagged:
- `VERIFIED-GAP` — confirmed absent in the current tree; greenfield build.
- `EXTEND` — a partial/foundation exists; build ON it, do not duplicate (exact anchor in the spec).
- `VERIFY-ONLY` — already shipped; the task is to confirm it works + document, not rebuild.

## Phase split (9 + 10 = 19)

### Phase 1 — Harness Core (Azazel's 8 + Secrets Manager)
Robustness, safety, memory, and coordination-adjacent internals. These harden the loop itself.

| # | Feature | Status | Primary anchors |
|---|---|---|---|
| 1 | Curator loop | EXTEND | `src/skills.js` (curation + telemetry), `src/cron-scheduler.js` |
| 2 | Persistent Goals loop | EXTEND | `src/tool-registry.js` (add_goal bookkeeping), `src/model-provider.js` (turn loop) |
| 3 | Cron job control | VERIFY-ONLY | `src/tool-registry.js:939-1000` (already shipped) |
| 4 | Checkpoints & rollback | VERIFIED-GAP | new `src/checkpoint-store.js`, `src/tool-registry.js` (write/patch/shell) |
| 5 | Event hooks with veto | EXTEND | `src/catastrophic-policy.js`, `src/tool-registry.js` `invoke()` |
| 6 | Dual-threshold compression + caching | EXTEND | `src/memory-condenser.js`, `src/model-provider.js` |
| 7 | Memory design details | EXTEND | `src/memory-system.js`, `src/model-provider.js` (prompt assembly) |
| 8 | Honcho / external memory provider | VERIFIED-GAP | new `src/integrations/honcho-provider.js`, `src/abi-runtime.js` |
| 9 | Legion Secrets Manager | EXTEND | `src/setup-wizard.js` (saveEnv/WIZARD_FIELDS), new `src/secrets-store.js` |

### Phase 2 — Capability Layer (Seraphim's 10)
Net-new capabilities that ride on top of a hardened core.

| # | Feature | Status | Primary anchors |
|---|---|---|---|
| 1 | Kanban multi-agent board | VERIFIED-GAP | new `src/kanban-store.js`, `src/tool-registry.js`, `src/hosted-interface.js` |
| 2 | LSP semantic diagnostics | VERIFIED-GAP | new `src/lsp-client.js`, `src/code-tools.js` (post-write lint) |
| 3 | Credential pools | VERIFIED-GAP | new `src/credential-pool.js`, `src/model-provider.js` (request path) |
| 4 | Tool Search | VERIFIED-GAP | new `src/tool-search.js`, `src/tool-registry.js` (toOpenAITools) |
| 5 | Mixture of Agents | VERIFIED-GAP | new `src/moa-provider.js`, `src/model-router.js` |
| 6 | Context References | VERIFIED-GAP | new `src/context-references.js`, `src/agent-host.js` (message pre-process) |
| 7 | Deliverable Mode | VERIFIED-GAP | `src/discord-channel.js` (outbound), new `src/deliverable.js` |
| 8 | Batch Processing | VERIFIED-GAP | new `scripts/batcmcp_runner.mjs`, reuse `src/abi-runtime.js` |
| 9 | Provider Routing | VERIFIED-GAP | `src/model-provider.js` (body assembly), `src/setup-wizard.js` (config) |
| 10 | Subscription Proxy + API Server | VERIFIED-GAP | new `src/api-server.js`, `src/index.js` (boot) |

## Hard constraints (apply to EVERY phase, every commit)

1. **WSL 12GB memory cap** — never run heavy parallel builds; `node --test` is fine (~10s).
2. **Do NOT edit `~/openagi` directly** — Zed works in an isolated Windows-side clone; the live
   daemon's tree is off-limits. (Seraphim enforces this in the delegation brief.)
3. **Both test lanes green before committing each feature**: `npm test` (auto-approve=0) AND
   `npm run test:prod-policy` (auto-approve=1). New catastrophic-gate/hook tests must pass in
   BOTH lanes WITHOUT env pinning — that's the proof auto-approve can't bypass the gate.
4. **Homoglyph discipline** — ASCII-only identifiers; emoji allowed only in dashboard display
   strings. Byte-scan added diff lines before committing.
5. **House style** — plain Node ESM, no framework; `registry.register({...})` for tools;
   JSONL append + atomic JSON snapshot via `file-utils.js` for persistence; document every new
   agent-facing tool in `buildSystemPrompt`'s tool list (`src/model-provider.js` ~line 1377) or
   the model won't know it exists.
6. **New env vars** go through `WIZARD_FIELDS` allowlist (setup-wizard.js) so `saveEnv` persists
   them; systemd unit `Environment=` OVERRIDES `.env` — note any unit-pinned knobs in CHANGES.md.
7. **Per-feature Definition of Done** is in each spec section; a feature is done only when its
   tests are green in both lanes AND (for anything gated on a verdict/threshold/classifier) a
   LIVE probe against the running daemon shows the feature actually fires — green tests != working
   feature (the chat-fastlane band bug shipped 617/617 green while inert in prod).

## Completion markers (watchdog + proof-of-read)

Each feature appends its unique marker line to `CHANGES.md` as the LAST line of its entry.
Phase-final markers are the watchdog DONE gates:

- Phase 1 final line: `PARITY WAVE 3 PHASE 1 COMPLETE`
- Phase 2 final line: `PARITY WAVE 3 PHASE 2 COMPLETE`
- Per-feature markers are listed at the top of each phase spec.

## Execution model

Two phases, workhorse mode (Creator: "let Zed cook, it's a workhorse"):
- **Phase 1**: one chained branch `codex/pw3-phase1`, brief lists all 9 spec sections IN ORDER
  each with its own marker; Seraphim arms a silent watchdog, disengages, reviews the whole stack
  at phase end (both test lanes + homoglyph scan + live probes).
- **Phase 2**: after Phase 1 merges to main + daemon restart + live probe, cut `codex/pw3-phase2`
  from the new main tip; same pattern.

Seraphim reviews/QCs each phase before merge to conserve Fable-5 tokens on the Creator's side —
Zed does the coding, Seraphim does spec + review + live verification.

# Parity Wave 3 — Phase 2: Capability Layer (10 features)

> Read this file IN FULL before editing. Phase 2 is cut from main AFTER Phase 1 is merged +
> daemon restarted + live-probed. Build each feature in order; after EACH: both test lanes green,
> homoglyph-scan the diff, commit, append the feature marker to CHANGES.md. Blocked feature →
> commit progress + note blocker + CONTINUE.

Per-feature markers (last line of each CHANGES.md entry):
`KANBAN COMPLETE` · `LSP COMPLETE` · `CRED POOLS COMPLETE` · `TOOL SEARCH COMPLETE` ·
`MOA COMPLETE` · `CONTEXT REFS COMPLETE` · `DELIVERABLE COMPLETE` · `BATCH COMPLETE` ·
`PROVIDER ROUTING COMPLETE` · `API SERVER COMPLETE`
Phase-final last line of CHANGES.md: `PARITY WAVE 3 PHASE 2 COMPLETE`

---

## F1 — Kanban multi-agent board  (VERIFIED-GAP)  ⭐ highest-value

**Why:** the Legion (Seraphim/Azazel/Ziz/Cherubim) currently coordinates via cron + Discord relays
and fragile subagent swarms. Kanban is the durable coordination substrate.

**Build:** `src/kanban-store.js` — a SQLite board at `~/.openagi/kanban.db` (deps already include a
sqlite binding used by session-index.js — reuse it). Every task is a row; every handoff a row;
every worker a full process identity. Two surfaces over ONE db layer:
- **Agent toolset** (register in tool-registry.js): `kanban_show`, `kanban_list`, `kanban_create`,
  `kanban_complete`, `kanban_block`, `kanban_unblock`, `kanban_comment`, `kanban_heartbeat`,
  `kanban_link`. Document all in `buildSystemPrompt`.
- **Human/CLI + HTTP**: `GET/POST /kanban`, `GET /kanban/<id>`, dashboard tab in
  `hosted-interface.js` (follow the tab plumbing rules: escaped template literals, `switchTab` →
  `refreshKanban` → `renderKanbanDetail`).

Columns: backlog / in-progress / blocked / review / done. Tasks carry: id, title, body, assignee
(agent name), status, blockedBy[], comments[], runs[] (one row per attempt), createdAt/updatedAt.
Multi-project "boards" as a top-level grouping. Gateway notifications on status change.

**Scope guard:** this is the openAGI-local board. It shares `~/.openagi/kanban.db`; a future
cross-agent shared board is out of scope for this wave (note it in the module header). Do NOT try
to unify with Seraphim's `~/.hermes/kanban.db` now.

**DoD:** unit test: create→assign→block→unblock→complete lifecycle; blockedBy prevents completion;
runs append per attempt; HTTP returns board JSON. LIVE probe: create a task via the tool, see it in
`GET /kanban`.

---

## F2 — LSP semantic diagnostics  (VERIFIED-GAP)

**Build:** `src/lsp-client.js` — run language servers (pyright, typescript-language-server, gopls,
rust-analyzer, clangd + whatever's installed) as background subprocesses; feed their diagnostics
into the post-write lint in `code_write`/`code_edit`/`patch` (`src/code-tools.js`). Gate on git
workspace detection: LSP runs only when the edited file is inside a git repo (dormant in the
home-dir gateway path). Layered check: existing in-process syntax check FIRST (microseconds), LSP
SECOND when syntax is clean. Baseline diagnostics → write → re-query → surface ONLY new
diagnostics that edit introduced. A missing/flaky server must NEVER break a write (fall back
silently to syntax-only).

**Output shape** (match Hermes): add an `lsp_diagnostics` field to the write result alongside the
existing `lint` field:
`"LSP diagnostics introduced by this edit:\n<diagnostics file=\"...\">ERROR [42:5] ... </diagnostics>"`.

**Wire-in:** `src/code-tools.js` write/edit/patch handlers. Server binaries discovered on PATH;
config `~/.openagi/lsp.json` for per-server overrides + `OPENAGI_LSP=0` kill switch.

**DoD:** unit test with a stub language server: introduce a type error → only the NEW diagnostic
surfaces; baseline errors are filtered; missing server → syntax-only result, no crash; non-git dir
→ LSP dormant.

---

## F3 — Credential pools  (VERIFIED-GAP)

**Why:** directly kills the Legion's Anthropic 529 / rate-limit storms.

**Build:** `src/credential-pool.js` — register multiple API keys/OAuth tokens per SAME provider.
On the request path in `src/model-provider.js`, pick a key (strategy: round_robin / least_used /
fill_first / random, default round_robin). Rotation triggers:
- `429` plan/usage-limit (e.g. "usage limit reached") → rotate immediately, no retry.
- generic/transient `429` → retry same key once, then rotate.
- `402` billing → rotate immediately + 24h cooldown on that key.
- `401` auth-expired → try OAuth refresh; refresh fails → rotate.
- all keys exhausted → fall through to the existing fallback-provider path (pools are tried FIRST,
  fallback SECOND).

Auto-discover a single existing `.env` key as a 1-key pool. Document the caveat in code + CHANGES:
rotation resets the provider prompt cache (full-price re-read) — that's acceptable, it keeps the
session alive.

**Wire-in:** pool config in `~/.openagi/credential-pools.json` (or WIZARD_FIELDS-allowlisted env);
integrate with the F9-secrets-store from Phase 1 so pool keys live in the secrets manager.

**DoD:** unit test: simulate 429/402/401 → correct rotation per rule; exhaustion → fallback fires;
single key → auto 1-key pool; least_used/round_robin selection is correct.

---

## F4 — Tool Search  (VERIFIED-GAP)

**Build:** `src/tool-search.js` — progressive-disclosure for MCP + non-core plugin tools. When
active (auto mode: engage when the deferred-tool schema budget exceeds a threshold), replace those
tools in the model-visible array with three bridge tools: `tool_search(query, limit?)`,
`tool_describe(name)`, `tool_call(name, arguments)`. Core openAGI tools NEVER defer (the equivalent
of Hermes `_HERMES_CORE_TOOLS` — terminal/read/write/patch/search/memory/etc). When `tool_call`
fires, unwrap and dispatch the real tool through the SAME `invoke()` path so hooks (Phase-1 F5),
catastrophic gate, approval, and post-tool hooks all run against the REAL tool name; the activity
feed unwraps too.

**Wire-in:** `src/tool-registry.js` `toOpenAITools()` — add an `only`/`defer` mode; the bridge
dispatch reuses `invoke()`. Config `OPENAGI_TOOL_SEARCH=auto|on|off`.

**DoD:** unit test: with N deferred tools, model sees 3 bridge tools + core; `tool_call` dispatches
the underlying tool and the hook/gate chain runs against the real name; core tools never deferred.

---

## F5 — Mixture of Agents  (VERIFIED-GAP)

**Build:** `src/moa-provider.js` — a virtual provider. Each named preset = a selectable "model"
under provider `moa`. On a turn: reference models run first (parallel) and produce analysis; the
aggregator model then writes the actual assistant response + emits tool calls, INSIDE the normal
agent loop (tool calls, iterations, transcript, interrupts — do not fork the loop). Presets in
`~/.openagi/moa.json` (`{preset: {aggregator, references[]}}`). Selectable via the model picker
(`/model <preset> --provider moa`) and a one-shot `/moa <prompt>` slash command that restores the
prior model after.

**Wire-in:** register `moa` as a provider in `src/model-router.js` / the provider construction in
`src/model-provider.js`; the aggregator is the acting model, references are extra pre-calls whose
outputs are injected into the aggregator's context.

**DoD:** unit test with stub models: references run, aggregator receives their analysis, aggregator
output is the turn result, tool calls still work; `/moa` restores the prior model. Cross-link:
this is the [[moa-vs-ramiel-hybrid]] comparison in Seraphim's wiki.

---

## F6 — Context References  (VERIFIED-GAP)

**Build:** `src/context-references.js` — preprocess inbound messages, expanding `@`-references and
appending an `--- Attached Context ---` section. Support: `@file:path`, `@file:path:10-25`
(1-indexed inclusive range), `@folder:path` (tree listing), `@diff` (unstaged), `@staged`,
`@git:N` (last N commits w/ patches, max 10), `@url:https://...` (fetch + inject page text). Strip
trailing punctuation from ref values. Multiple refs per message. Size caps per ref.

**Wire-in:** call the expander in `src/agent-host.js` `handleMessage` BEFORE the model turn (after
scrutiny, before generate). Keep the raw user text plain (append context as a separate section so
the cache prefix stays byte-stable for no-ref turns).

**DoD:** unit test: each ref type expands correctly; range slicing is 1-indexed inclusive; invalid
range → full file; missing file → graceful note; no-ref message is byte-identical to before.

---

## F7 — Deliverable Mode  (VERIFIED-GAP)

**Build:** `src/deliverable.js` — the gateway scans agent responses for absolute (`/...`) or
home-relative (`~/...`) paths ending in a supported extension and uploads them as native
attachments, removing the path from the visible message. Paths inside code blocks / inline code are
IGNORED (never mutilate code samples). Dispatch by type: images/video inline-embed, audio → voice
attachment, everything else → file upload. EXCLUDE source extensions (`.py`, `.log`, etc.) so
arbitrary source isn't auto-shipped. This generalizes the existing `MEDIA:` handling in
`src/discord-channel.js`.

Supported (match Hermes table): images png/jpg/jpeg/gif/webp/bmp/tiff/svg; video
mp4/mov/avi/mkv/webm; audio mp3/wav/ogg/m4a/flac; docs pdf/docx/doc/odt/rtf/txt/md; data
xlsx/xls/csv/tsv/json/xml/yaml/yml; presentations pptx/ppt/odp; archives zip/tar/gz/tgz/bz2/7z;
web html/htm.

**Wire-in:** outbound message path in `src/discord-channel.js` (and any other channel adapters).

**DoD:** unit test: a response mentioning `/tmp/chart.png` uploads it + strips the path; a path
inside a ``` fence is left intact; a `.py` path is NOT auto-shipped; type→delivery routing is
correct.

---

## F8 — Batch Processing  (VERIFIED-GAP)

**Build:** `scripts/batcmcp_runner.mjs` — process a JSONL dataset of prompts in parallel, each
through a full agent session (reuse `createDurableRuntime`/`abi-runtime.js` per prompt in an
isolated dataDir). Output ShareGPT-format trajectories + tool-call stats + reasoning coverage.
Flags: `--dataset_file`, `--batcmcp_size`, `--run_name`, `--model`, `--num_workers`, `--max_turns`,
`--resume` (checkpoint by run_name), `--list_distributions`. Dataset entries: `{prompt}` required,
optional `image`/`docker_image`/`cwd`.

**Why for the Legion:** this is a training-data generator for the gemma3n / QLoRA fine-tuning work.

**DoD:** unit/integration test: a 3-prompt JSONL runs to completion, emits valid ShareGPT
trajectories with tool stats; `--resume` skips completed prompts. Keep worker count low (WSL 12GB
cap) in the test.

---

## F9 — Provider Routing  (VERIFIED-GAP)

**Build:** provider-routing controls when the provider is OpenRouter/Portal-style. Add a
`provider_routing` config block (sort: price|throughput|latency; only[]; ignore[]; order[];
require_parameters; data_collection) that's attached to the request body in
`src/model-provider.js`. No-op for direct provider connections (e.g. the kimi coding endpoint).

**Wire-in:** config in the setup wizard / `~/.openagi/config` + request-body assembly.

**DoD:** unit test: routing block is attached for OpenRouter-shaped providers and omitted for
direct ones; only/ignore/order serialize correctly.

---

## F10 — Subscription Proxy + API Server  (VERIFIED-GAP)

**Build:** `src/api-server.js` — two distinct surfaces:
1. **API server** (agent-with-tools): OpenAI-compatible `POST /v1/chat/completions` that runs a
   full agent turn (tools, memory, skills) and returns the final response; streaming shows tool
   progress inline. Auth via `API_SERVER_KEY`. Enable with `API_SERVER_ENABLED=true`, port 8642.
2. **Subscription proxy** (raw passthrough): a local server that forwards to the managed provider,
   attaching real credentials (from the F9-secrets-store) so external apps use the sub without a
   static key. Any bearer accepted; port 8645.

**Wire-in:** boot both in `src/index.js` behind their enable flags; reuse the existing HTTP server
patterns in `hosted-interface.js`. The proxy resolves credentials via the Phase-1 secrets store.

**DoD:** unit test: `/v1/chat/completions` returns an OpenAI-shaped response from a stubbed agent
turn; auth rejects a bad key; the proxy attaches a credential and forwards. LIVE probe: curl the
API server with a real short prompt.

---

## Phase 2 close-out
After all 10: both test lanes green, homoglyph-scan the full Phase-2 diff, every per-feature marker
present, then append `PARITY WAVE 3 PHASE 2 COMPLETE` as the final line of CHANGES.md.

# Azazel → Hermes-Parity Upgrade Wave — Master Handoff (for Zed/Codex)

Owner: **Zed Codex agent** (heavy implementation). Reviewer/spec author: **Seraphim**.
Creator directive: "scaffold everything, ZED does the coding, make Azazel like Hermes."

Philosophy (standing Legion rules — read once, apply to every spec below):
- **Smart gates, not strict gates.** Auto-approve stays default-ON. Only the existing
  catastrophic class is hard-gated. New tools are side-effect-classified honestly but do
  NOT invent new approval friction.
- **House style:** plain Node ESM, zero framework, comments explain WHY, "Story N" lineage
  comments preserved. New HTTP routes go in `hosted-interface.js` near the existing group;
  new tools via `runtime.tools.register({...})`. Persist via `file-utils.js`
  (`appendJsonLine`, `writeJsonAtomic`).
- **Test discipline:** `npm test` AND `npm run test:prod-policy` (both green, 563+ each)
  before claiming done. Add regressions for every new module. Pin
  `OPENAGI_AUTO_APPROVE=0` only in queue-semantics tests, never in catastrophic-gate tests.
- **Homoglyph scan** every changed file + filename:
  `[\u0400-\u04ff\u2010-\u2011\uff00-\uffef]` (emoji in dashboard strings are legit — do
  not treat all non-ASCII as corruption).
- Log every capability change in `CHANGES.md`, commit, and hand back the commit SHA +
  both test-lane summaries for Seraphim review. Do NOT push to main; work on branches
  `codex/<feature>`.

---

## Wave order (priority — do them in this sequence)

| # | Spec file | Feature | Why it matters | Risk |
|---|-----------|---------|----------------|------|
| 1 | `spec-web-search.md` | Native Kimi web search | He literally can't search now (no external key). Kimi has it built in. | Low |
| 2 | `spec-execute-code.md` | Python tool-calling sandbox | Token-saver for multi-step mechanical work | Med |
| 3 | `spec-subagents.md` | `delegate_task` parallel workers | Biggest capability multiplier | Med-High |
| 4 | `spec-ctx-search.md` | Search own past sessions | "what did we do about X" recall | Low |
| 5 | `spec-voice-streaming.md` | TTS voice + streaming replies (UX) | Polish; do last | Med |

Each spec is self-contained. Ship one branch per feature, get it reviewed, then next.

---

## KEY RESEARCH FINDING — web search (settled by Seraphim, 2026-07-20)

The Creator asked whether web search should go "through the LLM (native Kimi), Firecrawl,
or Playwright." **Answer: native Kimi.** Verified live against the running config:

- Azazel's key is a **kimi.com CODING key** — it authenticates ONLY against
  `https://api.kimi.com/coding/v1`. It gets **401 Invalid Authentication** on
  `api.moonshot.ai/v1` and `api.moonshot.cn/v1`, so the general Moonshot API is NOT reachable.
- BUT the coding endpoint's **OpenAI-compatible** `/chat/completions` path supports
  Moonshot's **native server-side web search** via a `builtin_function` tool. Probe result:
  sending `tools:[{"type":"builtin_function","function":{"name":"$web_search"}}]` with an
  OpenAI-style chat body returned a real `tool_calls` entry:
  `{"type":"builtin_function","function":{"name":"$web_search",
  "arguments":"{\"searcmcp_result\":{\"searcmcp_id\":\"...\"},\"usage\":{\"total_tokens\":8978}}"}}`
  — the **search executed on Kimi's servers** (8,978 tokens consumed proves it ran).
- So: **no external provider, no Firecrawl, no Playwright needed.** Firecrawl/Playwright are
  the fallback ONLY if we ever want scraping/JS-rendered page extraction beyond search.
- **Caveat Zed must resolve:** the echo-back of the tool result currently 400s with
  `"tokenization failed"`. The exact reply shape is a Moonshot protocol quirk. Consult
  Moonshot's `$web_search` docs (platform.moonshot.ai / api docs "Use Web Search") for the
  correct `role:"tool"` echo format. The pattern is: model emits `$web_search` tool_call →
  you append the assistant turn AND a tool message echoing the `arguments` verbatim →
  re-POST → Kimi injects results and answers. Get this shape exactly right against their docs.
- **Endpoint note:** models available on the coding endpoint are
  `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3` (live `/models` call). The harness
  currently talks the **Anthropic** `/messages` shape (`ANTHROPIC_BASE_URL=.../coding/v1`).
  The builtin web search rides the **OpenAI `/chat/completions`** shape. So web_search needs
  its own small OpenAI-compat client (see spec 1), NOT the Anthropic path.

---

## Architecture cheat-sheet (from skill legion-operate-openagi-harness)

- Runtime assembly: `src/abi-runtime.js` (`createDurableRuntime`). Wire new subsystems here.
- Agent loop / providers: `src/model-provider.js` (AnthropicProvider is the LIVE path;
  OpenAIResponsesProvider exists but no OPENAI key set).
- HTTP + dashboard SPA: `src/hosted-interface.js` (~5000 lines; routes at top, inline HTML
  template below — escape backticks `\\\`` / `\\${` inside the dashboard JS template).
- Tool registry: `src/tool-registry.js` — `register({name,description,parameters,handler,
  sideEffects,needsConfirmation,metadata})`. `OPENAGI_MAX_MODEL_TOOLS` caps advertised tools.
- Sessions: `src/agent-store.js` (`appendMessage` returns a Promise — await it). Session JSON
  at `~/.openagi/agent-host/sessions/<sessionId>.json`.
- Config: env in the **systemd unit** `~/.config/systemd/user/openagi-azazel.service`
  OVERRIDES `~/.openagi/.env`. After editing the unit: `systemctl --user daemon-reload` +
  restart. Auth token: `OPENAGI_AUTH_TOKEN` (Bearer). Port 43210.
- Redactor pitfall: never inline secrets; build auth scripts via python3 string-concat or
  read tokens from .env in a script file (see skill Auth section).

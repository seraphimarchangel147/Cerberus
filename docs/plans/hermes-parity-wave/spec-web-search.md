# Spec 1 — Native Kimi Web Search

Branch: `codex/web-search`. Reviewer: Seraphim. Read `README.md` first (the research
finding on native Kimi search is the whole basis of this spec).

## Goal

Make Azazel's existing `web_search` tool actually work by routing it through **Kimi's
native server-side `$web_search` builtin_function** on the coding endpoint's
OpenAI-compatible `/chat/completions` path. No external API key, no Firecrawl, no
Playwright. `fetcmcp_url` already exists for plain page fetches — leave it.

## Current state

- `src/integrations/web-search.js` registers `web_search` but every provider
  (`exa/tavily/brave/serpapi/firecrawl/perplexity`) needs an API key, and NONE is set in
  `~/.openagi/.env`. So the tool always returns "No web search provider configured."
- The harness's live model path is Anthropic-shape (`/messages`). Kimi's builtin web search
  is on the **OpenAI-shape** `/chat/completions` path of the SAME base
  (`https://api.kimi.com/coding/v1`). Same Bearer key works for both.

## Implementation

### 1. New provider: `src/integrations/web-search-providers-kimi.js`

A self-contained OpenAI-compat mini-client that performs the `$web_search` round-trip:

```
kimiWebSearch(query, { numResults, recency }) -> { provider:"kimi", count, results:[{title,url,snippet}] }
```

Round-trip (get the EXACT echo shape from Moonshot's "Use Web Search" API docs —
platform.moonshot.ai docs; the probe proved the search fires but the tool-result echo shape
needs their doc to avoid the `"tokenization failed"` 400):

1. POST to `${ANTHROPIC_BASE_URL}/chat/completions` (base already ends in `/coding/v1`):
   ```json
   { "model": "<ANTHROPIC_MODEL or kimi-for-coding>",
     "messages": [{"role":"user","content":"<a search directive built from query>"}],
     "tools": [{"type":"builtin_function","function":{"name":"$web_search"}}],
     "temperature": 0.3 }
   ```
   Auth header: `Authorization: Bearer ${ANTHROPIC_API_KEY}`.
2. Response has `choices[0].message.tool_calls[0]` with
   `function.name === "$web_search"` and `function.arguments` = a JSON string carrying
   `searcmcp_result.searcmcp_id`.
3. Append the assistant message (verbatim, with its `tool_calls`) AND a tool-result message
   echoing the search per Moonshot's documented shape, then re-POST the full message array.
4. Kimi injects the fetched results server-side and returns a normal assistant message with
   the answer + (usually) citations. Parse citations/URLs into `results[]`. If the model
   only returns prose, return `results:[{title:"Kimi web answer", url:null, snippet:<prose>}]`
   as a graceful degrade — never throw on "no structured results."

Handle:
- Search may need MORE than one `$web_search` hop — loop up to 3 tool hops.
- Timeout 60s per POST (AbortController); on abort return `{error:"kimi web search timed out"}`.
- Never inline the token — read `ANTHROPIC_API_KEY` from `process.env` (loaded from .env).

### 2. Wire into the provider list

In `src/integrations/web-search-providers.js`, add a `kimi` provider object with
`name:"kimi"`, `isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY)`, and
`search: kimiWebSearch`. Put it **first** in the priority order so it's the default when no
external key is set. External providers still win if their key is present (keeps optionality).

### 3. No dashboard change required

`web_search` already appears in the tool list. Optionally add a `kimi` entry to the
`/provider`-style status so the operator can see search is live.

## Tests (`test/web-search-kimi.test.js`)

- Stub the OpenAI-compat POST (inject a fake `fetch` or a `postChat` seam like the existing
  providers use a `search` seam). Assert:
  - First POST advertises the `$web_search` builtin_function tool.
  - On a `tool_calls` response, a second POST is made with the echoed tool result appended.
  - Final prose/citations map into `results[]`.
  - Timeout path returns `{error}`, not a throw.
- Keep the existing `web-search` tests green (kimi added as a NON-breaking new provider).
- Do NOT hit the live network in tests — stub the transport.

## Manual verification (Seraphim will spot-check)

Live authed probe once merged + daemon restarted:
`POST /message {"channel":"api","from":"qa","sessionId":"qa:search","text":"search the web
for one news headline this week and cite the source"}` → real, current headline in the reply.

## Definition of done

Both test lanes green, homoglyph-clean, `CHANGES.md` entry, commit SHA reported. Do not push
main. Hand back: the exact working echo-back shape you found in Moonshot's docs (Seraphim
will file it in the wiki).

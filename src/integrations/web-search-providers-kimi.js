const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_MODEL = "kimi-for-coding";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_HOPS = 3;

const WEB_SEARCH_TOOLS = [{
  type: "builtin_function",
  function: { name: "$web_search" }
}];

// Kimi's built-in search is unusual: the server has already executed the
// search when it emits the tool call. We must echo its arguments through the
// documented tool message shape so the server can inject those results.
export async function kimiWebSearch(query, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return failed("kimi web search is not configured (missing ANTHROPIC_API_KEY)");

  const baseUrl = String(options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxToolHops = positiveInteger(options.maxToolHops, MAX_TOOL_HOPS);
  const numResults = Math.min(20, Math.max(1, positiveInteger(options.numResults, 5)));
  const postChat = options.postChat ?? defaultPostChat;
  const messages = [{ role: "user", content: searchDirective(query, { numResults, recency: options.recency }) }];
  let toolHops = 0;

  try {
    while (true) {
      const completion = await postWithTimeout(postChat, {
        model,
        messages,
        tools: WEB_SEARCH_TOOLS,
        temperature: 0.3
      }, {
        url,
        timeoutMs,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        }
      });

      const choice = completion?.choices?.[0];
      const message = choice?.message;
      if (!message || typeof message !== "object") {
        return failed("kimi web search returned no assistant message");
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const results = extractResults(completion, choice, message, numResults);
        if (results.length === 0) return failed("kimi web search returned an empty answer");
        return { provider: "kimi", count: results.length, results };
      }
      if (toolHops >= maxToolHops) {
        return failed(`kimi web search exceeded ${maxToolHops} tool hops`);
      }

      const echoes = [];
      for (const toolCall of toolCalls) {
        if (toolCall?.function?.name !== "$web_search" || !toolCall.id) {
          return failed("kimi web search returned an unexpected tool call");
        }
        let toolResult;
        try {
          toolResult = JSON.parse(toolCall.function.arguments);
        } catch {
          return failed("kimi web search returned malformed tool arguments");
        }
        // Moonshot requires all four fields. In particular, omitting `name`
        // can make the coding endpoint reject this continuation while trying
        // to tokenize the tool transcript.
        echoes.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: "$web_search",
          content: JSON.stringify(toolResult)
        });
      }

      // Keep the assistant object byte-for-byte equivalent at JSON encoding
      // time; Moonshot matches each echoed result to these original call ids.
      messages.push(message, ...echoes);
      toolHops += 1;
    }
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "KIMI_SEARCH_TIMEOUT") {
      return failed("kimi web search timed out");
    }
    return failed(`kimi web search failed: ${safeErrorMessage(error, apiKey)}`);
  }
}

async function defaultPostChat(body, { url, headers, signal }) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message ?? `Kimi chat completion failed with ${response.status}`);
  }
  return data;
}

async function postWithTimeout(postChat, body, request) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("kimi web search timed out");
      error.name = "AbortError";
      error.code = "KIMI_SEARCH_TIMEOUT";
      reject(error);
    }, request.timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => postChat(body, { ...request, signal: controller.signal })),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function searchDirective(query, { numResults, recency }) {
  const recencyText = {
    day: "Prefer sources published or updated in the past day.",
    week: "Prefer sources published or updated in the past week.",
    month: "Prefer sources published or updated in the past month.",
    year: "Prefer sources published or updated in the past year."
  }[recency] ?? "There is no recency restriction.";
  return [
    "Search the live web for the query enclosed in <query> tags.",
    `<query>${String(query ?? "").trim()}</query>`,
    recencyText,
    `Return up to ${numResults} distinct sources with a title, direct URL, and concise factual snippet.`,
    "Cite source URLs in the answer."
  ].join("\n");
}

function extractResults(completion, choice, message, limit) {
  const prose = messageText(message.content);
  const results = [];
  const seen = new Set();
  const structured = [
    completion?.search_results,
    completion?.citations,
    choice?.search_results,
    choice?.citations,
    message.search_results,
    message.citations,
    message.annotations
  ];

  for (const collection of structured) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) addStructuredResult(results, seen, item, prose);
  }
  addProseUrls(results, seen, prose);

  if (results.length === 0 && prose) {
    results.push({ title: "Kimi web answer", url: null, snippet: prose.slice(0, 400) });
  }
  return results.slice(0, limit);
}

function addStructuredResult(results, seen, item, prose) {
  if (typeof item === "string") {
    addResult(results, seen, { url: item, snippet: prose.slice(0, 400) });
    return;
  }
  if (!item || typeof item !== "object") return;
  const row = item.url_citation && typeof item.url_citation === "object" ? item.url_citation : item;
  addResult(results, seen, {
    title: row.title ?? row.name,
    url: row.url ?? row.link ?? row.source_url ?? row.href,
    snippet: row.snippet ?? row.description ?? row.text ?? row.content ?? prose.slice(0, 400)
  });
}

function addProseUrls(results, seen, prose) {
  const markdownUrls = new Set();
  for (const match of prose.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) {
    markdownUrls.add(match[2]);
    addResult(results, seen, {
      title: match[1],
      url: match[2],
      snippet: snippetAround(prose, match.index)
    });
  }
  for (const match of prose.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = trimUrlPunctuation(match[0]);
    if (markdownUrls.has(url)) continue;
    addResult(results, seen, { url, snippet: snippetAround(prose, match.index) });
  }
}

function addResult(results, seen, candidate) {
  const url = normalizedPublicUrl(candidate.url);
  if (!url || seen.has(url)) return;
  seen.add(url);
  results.push({
    title: cleanText(candidate.title) || titleFromUrl(url),
    url,
    snippet: cleanText(candidate.snippet).slice(0, 400)
  });
}

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function snippetAround(prose, index = 0) {
  const start = Math.max(0, prose.lastIndexOf("\n", Math.max(0, index - 1)) + 1);
  const endAt = prose.indexOf("\n", index);
  const end = endAt < 0 ? prose.length : endAt;
  return cleanText(prose.slice(start, end)).slice(0, 400) || cleanText(prose).slice(0, 400);
}

function normalizedPublicUrl(value) {
  const cleaned = trimUrlPunctuation(String(value ?? "").trim());
  try {
    const url = new URL(cleaned);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function trimUrlPunctuation(value) {
  return String(value).replace(/[),.;:!?]+$/, "");
}

function titleFromUrl(value) {
  try { return new URL(value).hostname; } catch { return "Web result"; }
}

function cleanText(value) {
  return typeof value === "string"
    ? value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim()
    : "";
}

function safeErrorMessage(error, apiKey) {
  const message = String(error?.message ?? error ?? "unknown error");
  return (apiKey ? message.split(apiKey).join("[REDACTED]") : message).slice(0, 500);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function failed(error) {
  return { provider: "kimi", count: 0, results: [], error };
}

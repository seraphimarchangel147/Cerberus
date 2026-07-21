// Kimi executes $web_search server-side, but Moonshot still requires a
// precise assistant/tool transcript before it will expose the final answer.
// These tests stub that transport so CI never spends tokens or touches the web.
import test from "node:test";
import assert from "node:assert/strict";
import { kimiWebSearch } from "../src/integrations/web-search-providers-kimi.js";
import { PROVIDERS } from "../src/integrations/web-search-providers.js";
import { registerWebSearchTools } from "../src/integrations/web-search.js";
import { ToolRegistry } from "../src/tool-registry.js";

const KIMI_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"];

function setKimiEnv(t, values = {}) {
  const saved = Object.fromEntries(KIMI_ENV.map((key) => [key, process.env[key]]));
  process.env.ANTHROPIC_API_KEY = values.apiKey ?? "unit-test-kimi-key";
  if (values.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = values.baseUrl;
  if (values.model === undefined) delete process.env.ANTHROPIC_MODEL;
  else process.env.ANTHROPIC_MODEL = values.model;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Kimi advertises $web_search and echoes Moonshot's exact tool-result shape", async (t) => {
  setKimiEnv(t, {
    baseUrl: "https://api.kimi.com/coding/v1/",
    model: "kimi-for-coding-highspeed"
  });
  const rawArguments = '{  "searcmcp_result": {"searcmcp_id":"search-1"}, "usage":{"total_tokens":8978} }';
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_search_1",
      type: "builtin_function",
      function: { name: "$web_search", arguments: rawArguments }
    }]
  };
  const calls = [];
  const postChat = async (body, request) => {
    calls.push({ body: structuredClone(body), request: { ...request, signal: undefined } });
    if (calls.length === 1) {
      return { choices: [{ finish_reason: "tool_calls", message: assistant }] };
    }
    return {
      choices: [{
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "Moonshot documents the protocol in [Use Web Search](https://platform.moonshot.ai/docs/guide/use-web-search)."
        }
      }]
    };
  };

  const result = await kimiWebSearch("Moonshot web search protocol", {
    numResults: 3,
    recency: "week",
    postChat
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.url, "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(calls[0].request.headers.authorization, "Bearer unit-test-kimi-key");
  assert.equal(calls[0].body.model, "kimi-for-coding-highspeed");
  assert.deepEqual(calls[0].body.tools, [{
    type: "builtin_function",
    function: { name: "$web_search" }
  }]);
  assert.equal(calls[0].body.temperature, 0.3);
  assert.match(calls[0].body.messages[0].content, /Moonshot web search protocol/);
  assert.match(calls[0].body.messages[0].content, /past week/);
  assert.match(calls[0].body.messages[0].content, /up to 3/);

  assert.deepEqual(calls[1].body.messages[1], assistant, "the assistant tool-call turn is replayed unchanged");
  assert.deepEqual(calls[1].body.messages[2], {
    role: "tool",
    tool_call_id: "call_search_1",
    name: "$web_search",
    content: JSON.stringify(JSON.parse(rawArguments))
  });
  assert.deepEqual(calls[1].body.tools, calls[0].body.tools, "the builtin declaration is sent on every hop");
  assert.equal(result.provider, "kimi");
  assert.equal(result.count, 1);
  assert.equal(result.results[0].title, "Use Web Search");
  assert.equal(result.results[0].url, "https://platform.moonshot.ai/docs/guide/use-web-search");
});

test("Kimi can make more than one builtin search hop before final prose", async (t) => {
  setKimiEnv(t);
  let calls = 0;
  const postChat = async () => {
    calls += 1;
    if (calls <= 2) {
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_${calls}`,
              type: "builtin_function",
              function: {
                name: "$web_search",
                arguments: JSON.stringify({ searcmcp_result: { searcmcp_id: `search-${calls}` } })
              }
            }]
          }
        }]
      };
    }
    return {
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "The searches completed, but Kimi returned prose without structured citations." }
      }]
    };
  };

  const result = await kimiWebSearch("multi-hop search", { postChat });

  assert.equal(calls, 3);
  assert.equal(result.count, 1);
  assert.deepEqual(result.results[0], {
    title: "Kimi web answer",
    url: null,
    snippet: "The searches completed, but Kimi returned prose without structured citations."
  });
});

test("Kimi timeout returns an error envelope instead of throwing", async (t) => {
  setKimiEnv(t);
  const result = await kimiWebSearch("slow search", {
    timeoutMs: 5,
    postChat: async () => new Promise(() => {})
  });

  assert.equal(result.error, "kimi web search timed out");
  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
});

test("Kimi is first priority, reads configuration live, and its envelope fits web_search", async (t) => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });
  const kimi = PROVIDERS[0];
  assert.equal(kimi.name, "kimi");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(kimi.isConfigured(), false);
  process.env.ANTHROPIC_API_KEY = "unit-test-kimi-key";
  assert.equal(kimi.isConfigured(), true);

  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [{
      name: "kimi",
      isConfigured: () => true,
      search: async () => ({
        provider: "kimi",
        count: 1,
        results: [{ title: "Native result", url: "https://example.com", snippet: "current" }]
      })
    }]
  });
  const invoked = await tools.invoke("web_search", { query: "current result", provider: "kimi" });
  assert.equal(invoked.ok, true);
  assert.equal(invoked.result.provider, "kimi");
  assert.equal(invoked.result.count, 1);
  assert.equal(invoked.result.results[0].title, "Native result");
});

test("a configured external provider keeps automatic priority over native Kimi", async (t) => {
  const savedDefault = process.env.WEB_SEARCH_PROVIDER;
  delete process.env.WEB_SEARCH_PROVIDER;
  t.after(() => {
    if (savedDefault === undefined) delete process.env.WEB_SEARCH_PROVIDER;
    else process.env.WEB_SEARCH_PROVIDER = savedDefault;
  });
  const calls = [];
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [
      {
        name: "kimi",
        isConfigured: () => true,
        search: async () => { calls.push("kimi"); return { provider: "kimi", count: 0, results: [] }; }
      },
      {
        name: "exa",
        isConfigured: () => true,
        search: async () => { calls.push("exa"); return [{ title: "External", url: "https://example.com", snippet: "configured" }]; }
      }
    ]
  });

  const invoked = await tools.invoke("web_search", { query: "configured provider" });
  assert.equal(invoked.result.provider, "exa");
  assert.deepEqual(calls, ["exa"]);
});

test("Kimi transport failures cannot echo the bearer credential", async (t) => {
  setKimiEnv(t, { apiKey: "unit-test-secret-bearing-key" });
  const result = await kimiWebSearch("safe errors", {
    postChat: async () => { throw new Error("rejected unit-test-secret-bearing-key"); }
  });

  assert.match(result.error, /\[REDACTED\]/);
  assert.doesNotMatch(result.error, /unit-test-secret-bearing-key/);
});

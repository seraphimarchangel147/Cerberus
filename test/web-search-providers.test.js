// test/web-search-providers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../src/integrations/web-search-providers.js";

function withMockFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });

test("exa adapter maps results", async () => {
  const exa = PROVIDERS.find((p) => p.name === "exa");
  await withMockFetch(async (url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(JSON.parse(init.body).query, "claude api");
    return jsonResponse({ results: [{ title: "Docs", url: "https://x", text: "body", publishedDate: "2026-01-01" }] });
  }, async () => {
    const out = await exa.search("claude api", { numResults: 3, apiKey: "k" });
    assert.equal(out[0].title, "Docs");
    assert.equal(out[0].url, "https://x");
    assert.equal(out[0].content, "body");
  });
});

test("tavily adapter maps results", async () => {
  const tav = PROVIDERS.find((p) => p.name === "tavily");
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.tavily.com/search");
    return jsonResponse({ results: [{ title: "T", url: "https://t", content: "snip" }] });
  }, async () => {
    const out = await tav.search("q", { apiKey: "k" });
    assert.equal(out[0].snippet, "snip");
  });
});

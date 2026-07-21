// searcmcp_sessions intentionally returns snippets only; full transcripts
// remain private in the SessionIndex source of truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clampSessionSearchLimit,
  registerSessionSearchTool
} from "../src/integrations/session-search-tool.js";
import { SessionIndex } from "../src/session-index.js";
import { ToolRegistry } from "../src/tool-registry.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTool(index) {
  const runtime = { sessionIndex: index, tools: new ToolRegistry() };
  registerSessionSearchTool(runtime);
  return runtime;
}

async function seed(index, count = 3) {
  for (let i = 0; i < count; i += 1) {
    await index.indexMessage(`session-${i}`, "main", {
      id: `message-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `We chose the heliotrope deployment plan ${i}. ${"private detail ".repeat(20)}`,
      createdAt: `2026-07-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`
    });
  }
}

test("searcmcp_sessions returns capped transcript hits under read-only scrutiny", async () => {
  const index = new SessionIndex({ dir: tempDir("session-tool-sqlite-") });
  await index.ready;
  await seed(index);
  const runtime = makeTool(index);
  const tool = runtime.tools.get("searcmcp_sessions");

  assert.equal(tool.sideEffects, false);
  assert.equal(runtime.tools.get("searchmcp_sessions"), undefined, "there is no stale typo alias beside the intentional name");
  assert.equal([...runtime.tools.tools.keys()].filter((name) => name === "searcmcp_sessions").length, 1);
  const outcome = await runtime.tools.invoke("searcmcp_sessions", {
    query: "heliotrope",
    limit: 8
  }, { __scrutinyPolicy: "read-only" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.query, "heliotrope");
  assert.equal(outcome.result.count, 3);
  assert.equal(outcome.result.hits.length, 3);
  assert.ok(outcome.result.hits.every((hit) => hit.snippet.length <= 160));
  assert.deepEqual(Object.keys(outcome.result.hits[0]).sort(), ["role", "sessionId", "snippet", "ts"]);

  const ignored = await runtime.tools.invoke("searcmcp_sessions", { query: "heliotrope" }, {
    __scrutinyPolicy: "none"
  });
  assert.equal(ignored.ok, false);
  assert.match(ignored.error, /permits no tools/);
});

test("searcmcp_sessions handles empty and unmatched queries without throwing", async () => {
  const index = new SessionIndex({ dir: tempDir("session-tool-empty-") });
  await index.ready;
  await seed(index, 1);
  const runtime = makeTool(index);

  for (const query of ["", "no-such-transcript-term"]) {
    const outcome = await runtime.tools.invoke("searcmcp_sessions", { query });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, { query, count: 0, hits: [] });
  }
});

test("searcmcp_sessions clamps limits to 1..20", async () => {
  const seen = [];
  const index = {
    async search(query, options) {
      seen.push(options.limit);
      return Array.from({ length: options.limit }, (_, i) => ({
        sessionId: `s-${i}`, ts: "2026-07-21T00:00:00.000Z", role: "user", snippet: query
      }));
    }
  };
  const runtime = makeTool(index);
  const low = await runtime.tools.invoke("searcmcp_sessions", { query: "x", limit: 0 });
  const high = await runtime.tools.invoke("searcmcp_sessions", { query: "x", limit: 999 });
  const invalid = await runtime.tools.invoke("searcmcp_sessions", { query: "x", limit: "invalid" });

  assert.deepEqual(seen, [1, 20, 8]);
  assert.equal(low.result.count, 1);
  assert.equal(high.result.count, 20);
  assert.equal(invalid.result.count, 8);
  assert.equal(clampSessionSearchLimit(4.9), 4);
});

test("searcmcp_sessions works through the forced JSONL fallback", async () => {
  const index = new SessionIndex({
    dir: tempDir("session-tool-fallback-"),
    fallback: true
  });
  await index.ready;
  assert.equal(index.fallback, true);
  await seed(index, 2);
  const runtime = makeTool(index);
  const outcome = await runtime.tools.invoke("searcmcp_sessions", { query: "heliotrope" });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.count, 2);
  assert.ok(outcome.result.hits.every((hit) => hit.snippet.length <= 160));
  assert.equal((await index.stats()).mode, "fallback-jsonl");
});

test("searcmcp_sessions prefers the invocation runtime index when supplied", async () => {
  const registered = makeTool({ search: async () => [] });
  const contextIndex = {
    search: async (query, options) => [{
      sessionId: "context-session",
      ts: "2026-07-21T12:00:00.000Z",
      role: "assistant",
      snippet: `${query}:${options.limit}`
    }]
  };
  const outcome = await registered.tools.invoke("searcmcp_sessions", { query: "decision", limit: 2 }, {
    runtime: { sessionIndex: contextIndex }
  });

  assert.equal(outcome.result.count, 1);
  assert.equal(outcome.result.hits[0].sessionId, "context-session");
  assert.equal(outcome.result.hits[0].snippet, "decision:2");
});

test("searcmcp_sessions forwards role, session, and time filters", async () => {
  const seen = [];
  const runtime = makeTool({
    async search(query, options) {
      seen.push({ query, options });
      return [];
    }
  });
  const outcome = await runtime.tools.invoke("searcmcp_sessions", {
    query: "release",
    role: "assistant",
    sessionId: "discord:guild:channel:user",
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-21T23:59:59Z",
    limit: 5
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [{
    query: "release",
    options: {
      limit: 5,
      role: "assistant",
      sessionId: "discord:guild:channel:user",
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-21T23:59:59Z"
    }
  }]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  compressLiveContext,
  contextCompressionTrigger,
  contextInputTokens,
  createContextLedgerCandidate,
  estimateContextTokens,
  previewContextLedger,
  restoreContextLedger
} from "../src/memory-condenser.js";

test("contextInputTokens keeps OpenAI totals whole and sums Anthropic cache fields", () => {
  assert.equal(contextInputTokens({ input_tokens: 80 }, { provider: "openai" }), 80);
  assert.equal(contextInputTokens({ prompt_tokens: 75 }, { provider: "openai" }), 75);
  assert.equal(contextInputTokens({ input_tokens: null, prompt_tokens: 70 }, { provider: "openai" }), 70);
  assert.equal(contextInputTokens({
    input_tokens: 5,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 25
  }, { provider: "anthropic" }), 50);
  assert.equal(contextInputTokens({
    input_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
    cache_read_input_tokens: 15
  }, { provider: "anthropic" }), 50);
  assert.equal(contextInputTokens(null, { provider: "anthropic" }), null);
  assert.equal(contextInputTokens({}, { provider: "openai" }), null);
});

test("contextCompressionTrigger uses inclusive 50 and 85 percent boundaries", () => {
  assert.deepEqual(contextCompressionTrigger({
    actualInputTokens: 500,
    estimatedInputTokens: 100,
    contextWindowTokens: 1000
  }), {
    triggered: true,
    reason: "actual-50",
    inputTokens: 500,
    thresholdTokens: 500,
    contextWindowTokens: 1000
  });
  assert.equal(contextCompressionTrigger({
    actualInputTokens: 499,
    estimatedInputTokens: 849,
    contextWindowTokens: 1000
  }).triggered, false);
  assert.deepEqual(contextCompressionTrigger({
    actualInputTokens: 499,
    estimatedInputTokens: 850,
    contextWindowTokens: 1000
  }), {
    triggered: true,
    reason: "estimated-85",
    inputTokens: 850,
    thresholdTokens: 850,
    contextWindowTokens: 1000
  });
  assert.equal(contextCompressionTrigger({
    actualInputTokens: 900,
    estimatedInputTokens: 900,
    contextWindowTokens: 1000
  }).reason, "actual-50", "exact provider usage has priority when both thresholds fire");
  assert.equal(contextCompressionTrigger({ actualInputTokens: 500 }).triggered, false);
});

test("estimateContextTokens is deterministic and fails safe on bounded overflow or cycles", () => {
  const value = { messages: [{ role: "user", content: "abcdefghij" }] };
  const first = estimateContextTokens(value, { charsPerToken: 4, maxChars: 1000 });
  const second = estimateContextTokens(value, { charsPerToken: 4, maxChars: 1000 });
  assert.equal(first, second);
  assert.ok(Number.isSafeInteger(first) && first > 0);
  assert.equal(
    estimateContextTokens({ content: "x".repeat(1000) }, { maxChars: 100 }),
    Number.MAX_SAFE_INTEGER
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(estimateContextTokens(cyclic, { maxChars: 1000 }), Number.MAX_SAFE_INTEGER);
});

test("compressLiveContext is immutable and retains a complete Anthropic tool pair", async () => {
  const conversation = [
    { role: "user", content: "old request" },
    { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: "inspect the workspace" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "use-1", name: "read_file", input: { path: "a.txt" } }]
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "use-1", content: "contents" }]
    },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    { role: "user", content: "newest request" }
  ];
  const before = structuredClone(conversation);
  deepFreeze(conversation);

  const result = await compressLiveContext(conversation, {
    format: "anthropic",
    keepRecentTurns: 3,
    maxDigestChars: 300
  });

  assert.equal(result.compressed, true);
  assert.equal(result.summarizedItems, 3);
  assert.equal(result.summarySource, "deterministic");
  assert.match(result.conversation[0].content, /^\[context summary\]/);
  assert.match(result.conversation[0].content, /\[\/context summary\]$/);
  assert.doesNotMatch(result.conversation[0].content, /\b(?:50|85)%|remaining tokens|finish soon/i);
  assert.deepEqual(result.conversation.slice(1), before.slice(3));
  assert.deepEqual(conversation, before, "the durable input remains unchanged");

  const blocks = result.conversation.slice(1).flatMap((message) => (
    Array.isArray(message.content) ? message.content : []
  ));
  assert.equal(blocks.filter((block) => block.type === "tool_use" && block.id === "use-1").length, 1);
  assert.equal(blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === "use-1").length, 1);
});

test("compressLiveContext keeps OpenAI call/output pairs together and never invents results", async () => {
  const conversation = [
    { type: "function_call", call_id: "old", name: "old_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "old", output: "old output" },
    { type: "function_call", call_id: "recent", name: "new_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "recent", output: "new output" },
    { type: "function_call", call_id: "missing", name: "unfinished", arguments: "{}" }
  ];
  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 240
  });

  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation.slice(1, 3), conversation.slice(2, 4));
  assert.deepEqual(result.conversation.at(-1), conversation.at(-1));
  assert.equal(
    result.conversation.filter((item) => item.type === "function_call_output" && item.call_id === "missing").length,
    0,
    "compression must not synthesize orphan results"
  );
});

test("compressLiveContext shrinks tool-heavy OpenAI turns with few role messages", async () => {
  const conversation = [{ role: "user", content: "initial request" }];
  for (let index = 0; index < 8; index += 1) {
    conversation.push(
      { type: "function_call", call_id: `call-${index}`, name: "step", arguments: JSON.stringify({ index }) },
      { type: "function_call_output", call_id: `call-${index}`, output: `result-${index}-${"x".repeat(120)}` }
    );
  }

  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 4,
    maxDigestChars: 120
  });

  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation[0], conversation[0], "the current user turn stays verbatim");
  assert.match(result.conversation[1].content, /^\[context summary\]/);
  assert.deepEqual(result.conversation.slice(2), conversation.slice(13));
  assert.equal(result.conversation.slice(2).filter((item) => item.type === "function_call").length, 2);
  assert.equal(result.conversation.slice(2).filter((item) => item.type === "function_call_output").length, 2);
});

test("compressLiveContext does not split a tool pair across the summary start", async () => {
  const conversation = [
    { role: "user", content: "current" },
    { type: "function_call", call_id: "a", name: "step", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "a" },
    { type: "function_call", call_id: "b", name: "step", arguments: "{}" },
    { role: "assistant", content: "interleaved role" },
    { type: "function_call_output", call_id: "b", output: "b" },
    { type: "function_call", call_id: "c", name: "step", arguments: "{}" },
    { type: "function_call_output", call_id: "c", output: `c-${"x".repeat(500)}` },
    { type: "function_call", call_id: "d", name: "step", arguments: "{}" },
    { type: "function_call_output", call_id: "d", output: "d" },
    { type: "function_call", call_id: "e", name: "step", arguments: "{}" },
    { type: "function_call_output", call_id: "e", output: "e" }
  ];

  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 4,
    maxDigestChars: 96
  });

  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation.slice(0, 6), conversation.slice(0, 6));
  assert.match(result.conversation[6].content, /^\[context summary\]/);
  assert.deepEqual(result.conversation.slice(7), conversation.slice(8));
});

test("compressLiveContext handles deeply nested content without overflowing the stack", async () => {
  let nested = { value: "leaf" };
  for (let depth = 0; depth < 12_000; depth += 1) nested = { next: nested };
  assert.equal(estimateContextTokens(nested), Number.MAX_SAFE_INTEGER);

  const conversation = [
    { role: "user", content: nested },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "old follow-up" },
    { role: "assistant", content: "recent answer" },
    { role: "user", content: "latest" }
  ];
  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 96
  });
  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation.slice(1), conversation.slice(3));
});

test("compressLiveContext rejects a replacement that would grow the transcript", async () => {
  const conversation = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
    { role: "user", content: "five" }
  ];
  const result = await compressLiveContext(conversation, { keepRecentTurns: 4 });
  assert.equal(result.compressed, false);
  assert.deepEqual(result.conversation, conversation);
});

test("compressLiveContext bounds provided summaries and falls back deterministically", async () => {
  const conversation = [
    { role: "user", content: `one-${"x".repeat(160)}` },
    { role: "assistant", content: `two-${"y".repeat(160)}` },
    { role: "user", content: `three-${"z".repeat(160)}` },
    { role: "assistant", content: "four" },
    { role: "user", content: "five" }
  ];
  const long = await compressLiveContext(conversation, {
    keepRecentTurns: 2,
    maxDigestChars: 96,
    summarizer: async () => "z".repeat(1000)
  });
  assert.equal(long.summarySource, "deterministic");
  assert.equal(long.digest.overview, undefined);
  assert.ok(long.marker.length <= 96);

  const failedA = await compressLiveContext(conversation, {
    keepRecentTurns: 2,
    maxDigestChars: 96,
    summarizer: async () => { throw new Error("offline"); }
  });
  const failedB = await compressLiveContext(conversation, { keepRecentTurns: 2, maxDigestChars: 96 });
  assert.equal(failedA.summarySource, "deterministic");
  assert.equal(failedA.marker, failedB.marker);
  assert.equal(long.marker, failedB.marker);
});

test("compressLiveContext returns an independent working copy when no prefix is eligible", async () => {
  const conversation = [
    { role: "assistant", content: { nested: ["a"] } },
    { role: "user", content: "latest" }
  ];
  const result = await compressLiveContext(conversation, { keepRecentTurns: 4 });
  assert.equal(result.compressed, false);
  assert.deepEqual(result.conversation, conversation);
  assert.notEqual(result.conversation, conversation);
  assert.notEqual(result.conversation[0], conversation[0]);
  result.conversation[0].content.nested.push("b");
  assert.deepEqual(conversation[0].content.nested, ["a"]);
});

test("user-authored summary tags retain normal recent-turn provenance", async () => {
  const current = {
    role: "user",
    content: "[context summary]\nThis is literal user content.\n[/context summary]"
  };
  const conversation = [current];
  for (let index = 0; index < 6; index += 1) {
    conversation.push(
      { type: "function_call", call_id: `literal-${index}`, name: "step", arguments: "{}" },
      { type: "function_call_output", call_id: `literal-${index}`, output: `value-${"x".repeat(120)}` }
    );
  }

  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 3,
    maxDigestChars: 96
  });

  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation[0], current);
  assert.match(result.conversation[1].content, /^\[context summary\]/);
});

test("user-authored continuation text retains normal recent-turn provenance", async () => {
  const current = {
    role: "user",
    content: [
      {
        type: "input_text",
        text: "[system] Continue the same task now. Use the accumulated tool results and conversation above. Do not repeat completed work; keep using tools if needed, then give the user a final answer."
      }
    ]
  };
  const conversation = [current];
  for (let index = 0; index < 6; index += 1) {
    conversation.push(
      { type: "function_call", call_id: `continue-${index}`, name: "step", arguments: "{}" },
      { type: "function_call_output", call_id: `continue-${index}`, output: `value-${"x".repeat(120)}` }
    );
  }

  const result = await compressLiveContext(conversation, {
    format: "openai",
    keepRecentTurns: 3,
    maxDigestChars: 96
  });

  assert.equal(result.compressed, true);
  assert.deepEqual(result.conversation[0], current);
  assert.match(result.conversation[1].content, /^\[context summary\]/);
});

test("context-ledger candidates structure and redact older execution state", async () => {
  const exactSecret = "context-ledger-exact-canary";
  const patternedSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const current = {
    role: "user",
    content: [{ type: "input_text", text: "Current input must remain byte-for-byte." }],
    metadata: { requestId: "current-1" }
  };
  const recentAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "Recent answer must remain exact." }]
  };
  const conversation = [
    {
      role: "user",
      content: `Build a verified report from the old data. api_key=${patternedSecret} ${"objective ".repeat(30)}`
    },
    {
      role: "user",
      content: `Approved: go ahead with the report. ${"authorization ".repeat(20)}`
    },
    {
      type: "reasoning",
      reasoning_summary: `private top-level reasoning ${exactSecret}`
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `private reasoning ${exactSecret}` },
        { type: "text", text: `I decided to write the report after checking the evidence. ${"decision ".repeat(20)}` },
        {
          type: "tool_use",
          id: "write-1",
          name: "write_file",
          input: {
            path: "/tmp/report.md",
            token: exactSecret,
            reasoning: `private tool rationale ${exactSecret}`
          }
        }
      ]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "write-1",
        content: {
          ok: true,
          path: "/tmp/report.md",
          authorization: `Bearer ${exactSecret}`
        }
      }]
    },
    {
      role: "assistant",
      content: `Next I will verify the saved report. ${"follow-up ".repeat(20)}`
    },
    recentAssistant,
    current
  ];
  const before = structuredClone(conversation);

  const candidate = await createContextLedgerCandidate(conversation, {
    format: "anthropic",
    keepRecentTurns: 2,
    maxDigestChars: 1600,
    redactValues: [exactSecret]
  });

  assert.equal(candidate.compressed, true);
  assert.equal(candidate.digest.version, 1);
  assert.ok(candidate.digest.objective.length > 0);
  assert.ok(candidate.digest.authorization.length > 0);
  assert.ok(candidate.digest.decisions.length > 0);
  assert.ok(candidate.digest.toolReceipts.some((item) => /write_file completed/.test(item)));
  assert.ok(candidate.digest.changes.some((item) => /write_file/.test(item)));
  assert.ok(candidate.digest.artifacts.includes("/tmp/report.md"));
  assert.ok(candidate.digest.next.some((item) => /Next I will verify/.test(item)));
  assert.deepEqual(candidate.conversation.slice(-2), [recentAssistant, current]);
  assert.deepEqual(conversation, before, "candidate preparation must not mutate durable history");

  const publicCandidate = JSON.stringify({
    digest: candidate.digest,
    marker: candidate.marker
  });
  assert.doesNotMatch(publicCandidate, /context-ledger-exact-canary/);
  assert.doesNotMatch(publicCandidate, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(publicCandidate, /private reasoning|private tool rationale|private top-level reasoning/);
  assert.match(publicCandidate, /\[REDACTED\]/);
});

test("optional summarizers receive redacted bounded input and cannot reintroduce known secrets", async () => {
  const secret = "summarizer-exact-secret";
  const conversation = [
    {
      role: "user",
      content: `Analyze this older payload: ${secret}. ${"x".repeat(500)}`
    },
    {
      role: "assistant",
      content: `Decision made. ${"y".repeat(500)}`
    },
    { role: "assistant", content: "recent" },
    { role: "user", content: "current" }
  ];

  const candidate = await previewContextLedger(conversation, {
    keepRecentTurns: 2,
    maxDigestChars: 600,
    redactValues: [secret],
    summarizer: async (prefix, metadata) => {
      const received = JSON.stringify({ prefix, metadata });
      return [
        metadata.ledger.version === 1 ? "version-one" : "version-mismatch",
        received.includes("summarizer-exact-secret")
          ? "SUMMARIZER_INPUT_LEAK"
          : "input-safe",
        "Auxiliary overview reflected summarizer-exact-secret"
      ].join(" ");
    }
  });

  assert.equal(candidate.compressed, true);
  assert.equal(candidate.summarySource, "provided");
  assert.match(candidate.digest.overview, /version-one/u);
  assert.match(candidate.digest.overview, /input-safe/u);
  assert.doesNotMatch(candidate.digest.overview, /SUMMARIZER_INPUT_LEAK/u);
  assert.doesNotMatch(candidate.digest.overview, /summarizer-exact-secret/);
  assert.match(candidate.digest.overview, /\[REDACTED\]/);
});

test("preview restore returns an independent byte-equivalent original", async () => {
  const current = {
    role: "user",
    content: [{ type: "input_text", text: "exact current input" }],
    metadata: { stable: true }
  };
  const conversation = [
    { role: "user", content: `old-${"a".repeat(400)}` },
    { role: "assistant", content: `old-${"b".repeat(400)}` },
    { role: "assistant", content: "recent answer" },
    current
  ];
  const before = structuredClone(conversation);
  const preview = await previewContextLedger(conversation, {
    keepRecentTurns: 2,
    maxDigestChars: 200
  });

  assert.equal(preview.compressed, true);
  assert.ok(preview.preview.savedChars > 0);
  assert.deepEqual(preview.conversation.at(-1), current);
  preview.conversation.at(-1).content[0].text = "mutated preview only";

  const restored = restoreContextLedger(preview);
  assert.deepEqual(restored, before);
  assert.notEqual(restored, conversation);
  assert.notEqual(restored.at(-1), conversation.at(-1));
  assert.equal(
    restoreContextLedger(JSON.parse(JSON.stringify(preview))),
    null,
    "the private restore snapshot never crosses JSON boundaries"
  );
});

test("context-ledger preparation fails open on hostile values", async () => {
  const hostile = { role: "user" };
  Object.defineProperty(hostile, "content", {
    enumerable: true,
    get() {
      throw new Error("hostile getter must not escape");
    }
  });
  const conversation = [
    hostile,
    { role: "assistant", content: "recent" },
    { role: "user", content: "current" }
  ];

  let candidate;
  await assert.doesNotReject(async () => {
    candidate = await createContextLedgerCandidate(conversation, {
      keepRecentTurns: 2
    });
  });
  assert.equal(candidate.compressed, false);
  assert.equal(candidate.failedOpen, true);
  assert.equal(candidate.conversation.length, conversation.length);
  assert.equal(candidate.conversation.at(-1).content, "current");
  assert.doesNotThrow(() => restoreContextLedger(candidate));
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

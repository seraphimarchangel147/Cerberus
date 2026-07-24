import assert from "node:assert/strict";
import test from "node:test";
import * as condenser from "../src/memory-condenser.js";

const {
  compressLiveContext,
  cooperativeContextLedgerSummarizer,
  createContextLedgerCandidate,
  previewContextLedger,
  restoreContextLedger
} = condenser;

const INSTALL_TIMEOUT_MS = 250;

function largeConversation(prefix = []) {
  return [
    {
      role: "user",
      content: `Build and verify the requested deliverable. ${"objective ".repeat(160)}`
    },
    ...prefix,
    {
      role: "assistant",
      content: `The most recent completed step remains exact. ${"recent ".repeat(30)}`
    },
    {
      role: "user",
      content: "Current user input must remain exact."
    }
  ];
}

function semanticOutput(status, {
  changed = null,
  artifacts = [],
  evidence = [],
  padding = "result ".repeat(80)
} = {}) {
  return JSON.stringify({
    outcome: {
      status,
      code: `${status}_fixture`,
      retryable: false,
      changed,
      artifacts,
      evidence,
      verification: {
        status: status === "succeeded" ? "passed" : "not_run",
        summary: "bounded fixture"
      },
      nextSteps: []
    },
    ok: status === "succeeded",
    body: padding
  });
}

function call(callId, name, input = {}) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(input)
  };
}

function output(callId, value) {
  return {
    type: "function_call_output",
    call_id: callId,
    output: value
  };
}

function serializedCandidate(candidate) {
  return JSON.stringify({
    digest: candidate.digest,
    marker: candidate.marker,
    conversation: candidate.conversation
  });
}

function assertDetachedSafeFailure(candidate, hostileValues = []) {
  assert.equal(candidate.compressed, false);
  assert.equal(candidate.failedOpen, true);
  assert.doesNotThrow(() => JSON.stringify(candidate.conversation));
  assert.ok(
    candidate.conversation === null || Array.isArray(candidate.conversation),
    "failed-open conversation is null or a safe detached array"
  );
  const safeConversation = Array.isArray(candidate.conversation)
    ? candidate.conversation
    : [];
  for (const hostile of hostileValues) {
    assert.equal(
      safeConversation.some((item) => item === hostile),
      false,
      "failed-open output must not retain hostile input references"
    );
  }
  const restored = restoreContextLedger(candidate);
  if (restored !== null) {
    assert.ok(Array.isArray(restored));
    assert.doesNotThrow(() => JSON.stringify(restored));
    for (const hostile of hostileValues) {
      assert.equal(restored.some((item) => item === hostile), false);
    }
  }
}

test("reasoning and redacted-thinking payloads never enter the ledger or summary", async () => {
  const canaries = [
    "private-top-level-reasoning-canary",
    "private-top-level-redacted-canary",
    "private-thinking-block-canary",
    "private-redacted-thinking-block-canary",
    "private-reasoning-field-canary",
    "private-scratchpad-canary",
    "private-rationale-canary",
    "private-monologue-canary",
    "private-cot-canary"
  ];
  const conversation = largeConversation([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: canaries[0] }]
    },
    {
      type: "redacted_thinking",
      data: canaries[1]
    },
    {
      role: "assistant",
      reasoning: canaries[4],
      scratchpad: canaries[5],
      rationale: canaries[6],
      internal_monologue: canaries[7],
      cot: canaries[8],
      content: [
        { type: "thinking", thinking: canaries[2] },
        { type: "redacted_thinking", data: canaries[3] },
        {
          type: "text",
          text: `I decided to retain only public evidence. ${"public ".repeat(100)}`
        }
      ]
    }
  ]);

  const candidate = await createContextLedgerCandidate(conversation, {
    format: "anthropic",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });

  assert.equal(candidate.compressed, true);
  const visible = serializedCandidate(candidate);
  for (const canary of canaries) assert.doesNotMatch(visible, new RegExp(canary));
  assert.match(visible, /public evidence/u);
});

test("private tool-result keys and nested reasoning blocks stay out of every summary surface", async () => {
  const keyCanary = "PRIVATE_REASONING_DETAILS_CANARY";
  const blockCanary = "PRIVATE_NESTED_REASONING_CANARY";
  const privateReference = "artifact:private_reasoning_canary";
  const conversation = largeConversation([
    call("private-result", "inspect_state"),
    output("private-result", JSON.stringify({
      ok: true,
      result: {
        reasoning_details: keyCanary,
        scratchpad: "PRIVATE_SCRATCHPAD_RESULT_CANARY",
        rationale: "PRIVATE_RATIONALE_RESULT_CANARY",
        internal_monologue: "PRIVATE_MONOLOGUE_RESULT_CANARY",
        cot: "PRIVATE_COT_RESULT_CANARY",
        cotTrace: "PRIVATE_COT_TRACE_RESULT_CANARY",
        nested: {
          type: "reasoning",
          text: `${blockCanary} ${privateReference}`
        },
        evidence: "public inspection evidence"
      }
    }))
  ]);

  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200,
    summarizer: async (prefix) => {
      const visible = JSON.stringify(prefix);
      const privateValues = [
        "PRIVATE_REASONING_DETAILS_CANARY",
        "PRIVATE_NESTED_REASONING_CANARY",
        "artifact:private_reasoning_canary",
        "PRIVATE_SCRATCHPAD_RESULT_CANARY",
        "PRIVATE_RATIONALE_RESULT_CANARY",
        "PRIVATE_MONOLOGUE_RESULT_CANARY",
        "PRIVATE_COT_RESULT_CANARY",
        "PRIVATE_COT_TRACE_RESULT_CANARY"
      ];
      return privateValues.some((value) => visible.includes(value))
        ? "SUMMARIZER_INPUT_LEAK"
        : "public overview";
    }
  });

  assert.equal(candidate.compressed, true);
  const visible = serializedCandidate(candidate);
  assert.doesNotMatch(visible, /SUMMARIZER_INPUT_LEAK/u);
  for (const canary of [
    keyCanary,
    blockCanary,
    privateReference,
    "PRIVATE_SCRATCHPAD_RESULT_CANARY",
    "PRIVATE_RATIONALE_RESULT_CANARY",
    "PRIVATE_MONOLOGUE_RESULT_CANARY",
    "PRIVATE_COT_RESULT_CANARY",
    "PRIVATE_COT_TRACE_RESULT_CANARY"
  ]) {
    assert.doesNotMatch(visible, new RegExp(canary));
  }
  assert.match(visible, /public inspection evidence/u);
});

test("hostile accessors, toJSON hooks, and proxies are rejected without invocation", async (t) => {
  await t.test("accessor", async () => {
    let reads = 0;
    const hostile = { role: "user" };
    Object.defineProperty(hostile, "content", {
      enumerable: true,
      get() {
        reads += 1;
        return "getter must not run";
      }
    });
    const candidate = await createContextLedgerCandidate(largeConversation([hostile]), {
      keepRecentTurns: 2
    });
    assert.equal(reads, 0);
    assertDetachedSafeFailure(candidate, [hostile]);
  });

  await t.test("toJSON", async () => {
    let calls = 0;
    const payload = {
      visible: "ordinary",
      toJSON() {
        calls += 1;
        return { leaked: "toJSON must not run" };
      }
    };
    const hostile = { role: "assistant", content: payload };
    const candidate = await createContextLedgerCandidate(largeConversation([hostile]), {
      keepRecentTurns: 2
    });
    assert.equal(calls, 0);
    assertDetachedSafeFailure(candidate, [hostile]);
  });

  await t.test("proxy", async () => {
    let traps = 0;
    const hostile = new Proxy(
      { role: "assistant", content: "proxy must not be inspected" },
      {
        get(target, property, receiver) {
          traps += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        }
      }
    );
    const candidate = await createContextLedgerCandidate(largeConversation([hostile]), {
      keepRecentTurns: 2
    });
    assert.equal(traps, 0);
    assertDetachedSafeFailure(candidate, [hostile]);
  });
});

test("sparse, cyclic, deep, and wide values fail open within structural bounds", async (t) => {
  const fixtures = [];

  const sparse = new Array(64);
  sparse[63] = "tail";
  fixtures.push(["sparse", { role: "assistant", content: sparse }]);

  const cycle = { label: "cycle" };
  cycle.self = cycle;
  fixtures.push(["cycle", { role: "assistant", content: cycle }]);

  let deep = { leaf: "bounded" };
  for (let depth = 0; depth < 20_000; depth += 1) deep = { child: deep };
  fixtures.push(["deep", { role: "assistant", content: deep }]);

  const wide = {};
  for (let index = 0; index < 100_001; index += 1) {
    wide[`field_${index}`] = index;
  }
  fixtures.push(["wide", { role: "assistant", content: wide }]);

  for (const [name, hostile] of fixtures) {
    await t.test(name, async () => {
      const source = largeConversation([hostile]);
      const started = Date.now();
      const candidate = await createContextLedgerCandidate(source, {
        keepRecentTurns: 2
      });
      assert.ok(Date.now() - started < 3000, `${name} input must remain bounded`);
      assertDetachedSafeFailure(candidate, [hostile]);
      assert.equal(source.includes(hostile), true, "durable source remains untouched");
    });
  }
});

test("semantic outcomes preserve status and changed:false without inventing mutations", async () => {
  const conversation = largeConversation([
    call("save", "save_draft", { name: "unchanged" }),
    output("save", semanticOutput("succeeded", { changed: false })),
    call("write", "write_file", { path: "/tmp/report.md" }),
    output("write", semanticOutput("succeeded", { changed: true })),
    call("read", "read_file", { path: "/tmp/missing.md" }),
    output("read", semanticOutput("failed", { changed: false })),
    call("delete", "delete_file", { path: "/tmp/protected.md" }),
    output("delete", semanticOutput("blocked", { changed: false })),
    call("send", "send_message", { channel: "review" }),
    output("send", semanticOutput("pending", { changed: false })),
    call("unpaired", "publish_report", { id: "report-1" })
  ]);

  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 4000
  });

  assert.equal(candidate.compressed, true);
  const receipts = candidate.digest.toolReceipts.join("\n");
  assert.match(receipts, /save_draft succeeded/u);
  assert.match(receipts, /write_file succeeded/u);
  assert.match(receipts, /read_file failed/u);
  assert.match(receipts, /delete_file blocked/u);
  assert.match(receipts, /send_message pending/u);
  assert.ok(candidate.digest.changes.some((item) => /write_file/u.test(item)));
  assert.equal(
    candidate.digest.changes.some((item) => /save_draft/u.test(item)),
    false,
    "an explicitly unchanged successful mutation is not a change"
  );
  assert.ok(candidate.digest.blockers.some((item) => /read_file/u.test(item)));
  assert.ok(candidate.digest.blockers.some((item) => /delete_file/u.test(item)));
  assert.ok(candidate.digest.pending.some((item) => /send_message/u.test(item)));
  assert.ok(candidate.digest.pending.some((item) => /publish_report/u.test(item)));
});

test("negated authorization is never promoted into a grant", async () => {
  const denied = [
    "Do not proceed with deletion.",
    "You are not authorized to send anything.",
    "Permission is denied and I did not approve this.",
    "I never gave permission to proceed.",
    "Nobody approved this operation.",
    "The phrase approved is shown as an example.",
    "Please proceed only after permission is granted.",
    "Please proceed after we approve it.",
    "You may proceed if the administrator approves.",
    "Go ahead subject to receiving permission.",
    "I haven't approved this.",
    "You may proceed pending approval.",
    "Go ahead contingent on authorization.",
    "Please proceed depending on permission.",
    "This action is unauthorized and not permitted.",
    "Approval was revoked, withdrawn, and refused.",
    "Should I go ahead?"
  ];
  const allowed = "You may create the local report.";
  for (const statement of denied) {
    const conversation = largeConversation([
      { role: "user", content: `${statement} ${"denied ".repeat(80)}` },
      { role: "user", content: `${allowed} ${"allowed ".repeat(80)}` }
    ]);
    const candidate = await createContextLedgerCandidate(conversation, {
      keepRecentTurns: 2,
      maxDigestChars: 1600
    });

    assert.equal(candidate.compressed, true, statement);
    assert.equal(candidate.digest.authorization.length, 1, statement);
    assert.match(
      candidate.digest.authorization[0],
      /You may create the local report/u,
      statement
    );
    assert.equal(candidate.digest.authorization[0].includes(statement), false);
  }
});

test("mandatory durable references survive minimum-size and repeated compression", async () => {
  const refs = Object.freeze([
    "artifact:artifact_report_7",
    "checkpoint:cp_report_7",
    "tool-output:out_1234567890abcdef"
  ]);
  const source = largeConversation([
    call("write-ref", "write_file", { path: "/tmp/report.md" }),
    output("write-ref", semanticOutput("succeeded", {
      changed: true,
      artifacts: [refs[0]],
      evidence: refs.slice(1),
      padding: "large durable output ".repeat(180)
    }))
  ]);
  const first = await compressLiveContext(source, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 600
  });

  assert.equal(first.compressed, true);
  assert.ok(first.preview.savedChars / first.preview.beforeChars >= 0.3);
  const firstDigest = JSON.stringify(first.digest);
  const firstWorking = JSON.stringify(first.conversation);
  for (const ref of refs) {
    assert.match(firstDigest, new RegExp(ref));
    assert.match(firstWorking, new RegExp(ref));
  }

  const repeatedSource = [
    ...first.conversation,
    { role: "assistant", content: `Intermediate result. ${"middle ".repeat(120)}` },
    { role: "user", content: `Continue from durable evidence. ${"follow ".repeat(120)}` },
    { role: "assistant", content: `Near-current result. ${"near ".repeat(120)}` },
    { role: "user", content: "Latest exact request." }
  ];
  const repeated = await compressLiveContext(repeatedSource, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 600
  });

  assert.equal(repeated.compressed, true);
  assert.ok(repeated.preview.savedChars / repeated.preview.beforeChars >= 0.3);
  const repeatedVisible = serializedCandidate(repeated);
  for (const ref of refs) assert.match(repeatedVisible, new RegExp(ref));

  const tooSmall = await compressLiveContext(source, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 40
  });
  assert.equal(tooSmall.compressed, false);
  assert.equal(tooSmall.marker, undefined);
  for (const ref of refs) {
    assert.ok(tooSmall.digest.references.includes(ref));
    assert.match(JSON.stringify(tooSmall.conversation), new RegExp(ref));
  }
});

test("repeated compression reapplies current redaction to prior ledgers", async () => {
  const rotatedSecret = "BECOMES_SECRET_AFTER_ROTATION";
  const first = await compressLiveContext(largeConversation([
    {
      role: "assistant",
      content: `I decided to retain ${rotatedSecret}. ${"decision ".repeat(140)}`
    }
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });
  assert.equal(first.compressed, true);
  assert.match(serializedCandidate(first), new RegExp(rotatedSecret, "u"));

  const repeatedSource = [
    ...first.conversation,
    {
      role: "assistant",
      content: `Additional completed work. ${"middle ".repeat(160)}`
    },
    {
      role: "user",
      content: `Continue with the current safe request. ${"current ".repeat(100)}`
    }
  ];
  const second = await compressLiveContext(repeatedSource, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200,
    redactValues: [rotatedSecret]
  });

  assert.equal(second.compressed, true);
  assert.doesNotMatch(serializedCandidate(second), new RegExp(rotatedSecret, "u"));
  assert.match(serializedCandidate(second), /\[REDACTED\]/u);
});

test("late durable refs survive while private and sensitive-key refs do not", async () => {
  const outputRef = "out_1234567890abcdef";
  const secret = "reference-secret-canary";
  const lateReference = "checkpoint:late_reference_after_wide_object";
  const result = {
    ok: true,
    result: `${"a".repeat(500)} ${outputRef} ${"b".repeat(500)}`,
    private: {
      type: "thinking",
      text: "artifact:private_thinking_reference"
    },
    reflected: `artifact:${secret}`,
    accessToken: "artifact:CAMEL_SECRET",
    authorization: "checkpoint:BOUNDARY_SECRET",
    password: "tool-output:out_aaaaaaaaaaaaaaaa",
    credential: "artifact:CREDENTIAL_SECRET",
    privateKey: "checkpoint:PRIVATE_KEY_SECRET",
    passcode: "draft:PASSCODE_SECRET",
    auth: "artifact:AUTH_ALIAS_SECRET",
    cookie: "checkpoint:COOKIE_SECRET",
    accessKey: "draft:ACCESS_KEY_SECRET",
    clientId: "artifact:CLIENT_ID_SECRET",
    serviceKey: "checkpoint:SERVICE_KEY_SECRET",
    accountSid: "draft:ACCOUNT_SID_SECRET",
    signature: "artifact:SIGNATURE_SECRET",
    sessionId: "checkpoint:SESSION_ID_SECRET",
    authValue: "draft:AUTH_VALUE_SECRET"
  };
  for (let index = 0; index < 30; index += 1) {
    result[`filler${index}`] = `ordinary-${index}`;
  }
  result.lateEvidence = lateReference;
  const conversation = largeConversation([
    call("large-output", "read_file"),
    output("large-output", JSON.stringify(result))
  ]);
  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 300,
    redactValues: [secret]
  });

  assert.equal(candidate.compressed, true);
  assert.ok(candidate.digest.references.includes(`tool-output:${outputRef}`));
  assert.ok(candidate.digest.references.includes(lateReference));
  const visible = serializedCandidate(candidate);
  assert.match(visible, new RegExp(`tool-output:${outputRef}`));
  assert.match(visible, new RegExp(lateReference));
  assert.doesNotMatch(
    visible,
    /private_thinking_reference|reference-secret-canary|CAMEL_SECRET|BOUNDARY_SECRET|out_aaaaaaaaaaaaaaaa|CREDENTIAL_SECRET|PRIVATE_KEY_SECRET|PASSCODE_SECRET|AUTH_ALIAS_SECRET|COOKIE_SECRET|ACCESS_KEY_SECRET|CLIENT_ID_SECRET|SERVICE_KEY_SECRET|ACCOUNT_SID_SECRET|SIGNATURE_SECRET|SESSION_ID_SECRET|AUTH_VALUE_SECRET/u
  );
});

test("large JSON reference scans retain public refs without bypassing private keys", async () => {
  const publicReference = "checkpoint:large_public_reference";
  const largeResult = JSON.stringify({
    publicEvidence: publicReference,
    authorization: "artifact:LARGE_AUTH_SECRET",
    scratchpad: "checkpoint:LARGE_PRIVATE_SECRET",
    privateTrace: {
      type: "thinking",
      text: "draft:LARGE_THINKING_SECRET"
    },
    padding: "x".repeat(300_000)
  });
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("large-json-reference", "inspect_large_json"),
    output("large-json-reference", largeResult)
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });

  assert.equal(candidate.compressed, true);
  assert.deepEqual(candidate.digest.references, [publicReference]);
  assert.doesNotMatch(
    serializedCandidate(candidate),
    /LARGE_AUTH_SECRET|LARGE_PRIVATE_SECRET|LARGE_THINKING_SECRET/u
  );

  const nestedPublic = "draft:nested_public";
  const nested = await createContextLedgerCandidate(largeConversation([
    call("nested-large-json", "inspect_large_json"),
    output("nested-large-json", JSON.stringify({
      payload: JSON.stringify({
        authorization: "artifact:NESTED_AUTH_SECRET",
        scratchpad: "checkpoint:NESTED_PRIVATE_SECRET",
        publicEvidence: nestedPublic
      }),
      padding: "x".repeat(300_000)
    }))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });
  assert.equal(nested.compressed, true);
  assert.deepEqual(nested.digest.references, [nestedPublic]);
  assert.doesNotMatch(
    serializedCandidate(nested),
    /NESTED_AUTH_SECRET|NESTED_PRIVATE_SECRET/u
  );

  const topLevelPublic = "draft:top_public";
  const topLevelEncoded = await createContextLedgerCandidate(largeConversation([
    call("top-level-encoded-json", "inspect_large_json"),
    output("top-level-encoded-json", JSON.stringify(JSON.stringify({
      authorization: "artifact:TOPLEVEL_AUTH_SECRET",
      scratchpad: "checkpoint:TOPLEVEL_PRIVATE_SECRET",
      publicEvidence: topLevelPublic,
      padding: "x".repeat(300_000)
    })))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });
  assert.equal(topLevelEncoded.compressed, true);
  assert.deepEqual(topLevelEncoded.digest.references, [topLevelPublic]);
  assert.doesNotMatch(
    serializedCandidate(topLevelEncoded),
    /TOPLEVEL_AUTH_SECRET|TOPLEVEL_PRIVATE_SECRET/u
  );

  const triplePublic = "draft:triple_public";
  const tripleEncoded = await createContextLedgerCandidate(largeConversation([
    call("triple-encoded-json", "inspect_large_json"),
    output("triple-encoded-json", JSON.stringify(JSON.stringify(JSON.stringify({
      authorization: "artifact:TRIPLE_AUTH_SECRET",
      scratchpad: "checkpoint:TRIPLE_PRIVATE_SECRET",
      publicEvidence: `${triplePublic} `,
      padding: "x".repeat(300_000)
    }))))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });
  assert.equal(tripleEncoded.compressed, true);
  assert.deepEqual(tripleEncoded.digest.references, [triplePublic]);
  assert.doesNotMatch(
    serializedCandidate(tripleEncoded),
    /TRIPLE_AUTH_SECRET|TRIPLE_PRIVATE_SECRET/u
  );

  const malformed = await createContextLedgerCandidate(largeConversation([
    call("malformed-large-json", "inspect_large_json"),
    output(
      "malformed-large-json",
      `{"authorization":"artifact:MALFORMED_PRIVATE","public":"checkpoint:MALFORMED_PUBLIC"${" ".repeat(300_000)}`
    )
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });
  assert.equal(malformed.compressed, true);
  assert.deepEqual(malformed.digest.references, []);
  assert.doesNotMatch(serializedCandidate(malformed), /MALFORMED_PRIVATE|MALFORMED_PUBLIC/u);
});

test("legacy structured failures survive without overriding canonical success", async () => {
  const conversation = largeConversation([
    call("nested-error", "read_file"),
    output("nested-error", JSON.stringify({ error: { message: "nested boom" } })),
    call("legacy-status", "write_file"),
    output("legacy-status", JSON.stringify({ status: "failed", message: "legacy boom" })),
    call("success-false", "publish_report"),
    output("success-false", JSON.stringify({ success: false, message: "publish failed" })),
    call("failed-true", "send_message"),
    output("failed-true", JSON.stringify({ failed: true, message: "send failed" })),
    call("error-code", "inspect_file"),
    output("error-code", JSON.stringify({ error: { code: "ENOENT" } })),
    call("text-denied", "write_file", { path: "/tmp/not-written.md" }),
    output("text-denied", "permission denied by host: /tmp/not-written.md"),
    call("canonical-success", "save_draft"),
    output("canonical-success", JSON.stringify({
      outcome: { status: "succeeded", changed: false },
      error: { message: "stale legacy field" }
    }))
  ]);
  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1600
  });

  assert.equal(candidate.compressed, true);
  const failures = candidate.digest.failures.join("\n");
  assert.match(failures, /read_file: nested boom/u);
  assert.match(failures, /write_file: legacy boom/u);
  assert.match(failures, /publish_report: publish failed/u);
  assert.match(failures, /send_message: send failed/u);
  assert.match(failures, /inspect_file: ENOENT/u);
  assert.match(failures, /write_file: permission denied by host/u);
  assert.doesNotMatch(failures, /save_draft/u);
  assert.match(candidate.digest.toolReceipts.join("\n"), /save_draft succeeded/u);
  assert.equal(
    candidate.digest.artifacts.some((item) => /not-written\.md/u.test(item)),
    false
  );
  assert.equal(
    candidate.digest.changes.some((item) => /not-written\.md/u.test(item)),
    false
  );
});

test("transport errors override contradictory semantic success receipts", async () => {
  const conflictedResult = output(
    "transport-conflict",
    semanticOutput("succeeded", {
      changed: true,
      artifacts: ["artifact:never_created"],
      evidence: ["tool-output:claimed_success"]
    })
  );
  conflictedResult.is_error = true;
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("transport-conflict", "write_file", { path: "/tmp/conflict.md" }),
    conflictedResult
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1200
  });

  assert.equal(candidate.compressed, true);
  assert.match(candidate.digest.toolReceipts.join("\n"), /write_file failed/u);
  assert.doesNotMatch(candidate.digest.toolReceipts.join("\n"), /write_file succeeded/u);
  assert.match(candidate.digest.failures.join("\n"), /write_file/u);
  assert.equal(
    candidate.digest.changes.some((item) => item.includes("write_file")),
    false
  );
  assert.deepEqual(candidate.digest.references, []);
  assert.equal(candidate.digest.artifacts.includes("artifact:never_created"), false);
  assert.doesNotMatch(
    candidate.digest.toolReceipts.join("\n"),
    /succeeded_fixture|changed state|verification passed|never_created|claimed_success/u
  );
  assert.match(candidate.digest.failures.join("\n"), /transport reported failure/u);
});

test("legacy failure detection requires a failure-shaped leading clause", async () => {
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("real-denial", "write_denied"),
    output("real-denial", "permission denied by host"),
    call("documented-denial", "write_documentation"),
    output(
      "documented-denial",
      "Successfully wrote the guide; documentation covers permission denied handling"
    ),
    call("documented-lock", "write_lock_guide"),
    output(
      "documented-lock",
      "Saved guide: users cannot edit locked records"
    ),
    call("tested-denial", "write_denial_test"),
    output(
      "tested-denial",
      "Write completed; access denied cases are now tested"
    )
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 2000
  });

  assert.equal(candidate.compressed, true);
  assert.match(candidate.digest.failures.join("\n"), /write_denied/u);
  assert.doesNotMatch(
    candidate.digest.failures.join("\n"),
    /write_documentation|write_lock_guide|write_denial_test/u
  );
  const receipts = candidate.digest.toolReceipts.join("\n");
  assert.match(receipts, /write_documentation completed/u);
  assert.match(receipts, /write_lock_guide completed/u);
  assert.match(receipts, /write_denial_test completed/u);
});

test("common leading legacy failure formats cannot become mutations", async () => {
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("fatal-denial", "write_fatal"),
    output("fatal-denial", "fatal: permission denied"),
    call("named-denial", "write_file"),
    output("named-denial", "write_file: permission denied"),
    call("npm-denial", "write_package"),
    output("npm-denial", "npm ERR! EACCES"),
    call("request-denial", "write_request"),
    output("request-denial", "Request could not be completed")
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 2000
  });

  assert.equal(candidate.compressed, true);
  for (const name of [
    "write_fatal",
    "write_file",
    "write_package",
    "write_request"
  ]) {
    assert.match(candidate.digest.failures.join("\n"), new RegExp(name, "u"));
    assert.equal(
      candidate.digest.changes.some((item) => item.includes(name)),
      false
    );
  }
});

test("reference extraction keeps the exact bounded set without clipped phantoms", async () => {
  const references = Array.from(
    { length: 32 },
    (_, index) => `artifact:${"r".repeat(175)}${String(index).padStart(2, "0")}`
  );
  const conversation = largeConversation([
    call("many-references", "publish_report"),
    output("many-references", semanticOutput("succeeded", {
      changed: true,
      evidence: references,
      padding: "large successful output ".repeat(5_000)
    }))
  ]);
  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 10_000
  });

  assert.equal(candidate.compressed, true);
  assert.equal(candidate.digest.references.length, references.length);
  assert.deepEqual(candidate.digest.references, references);
  assert.equal(
    candidate.digest.references.some((reference) => reference.endsWith("...")),
    false
  );
});

test("reference extraction never derives identifiers from clipped text", async () => {
  const exact = ["artifact:release...", "artifact:foo-"];
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("reference-boundaries", "inspect_report"),
    output("reference-boundaries", JSON.stringify({
      ok: true,
      note: `artifact:${"a".repeat(800)}`,
      exact
    }))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1600
  });

  assert.equal(candidate.compressed, true);
  assert.deepEqual(candidate.digest.references, exact);
});

test("large outputs retain real references without inventing embedded bare ids", async () => {
  const prefixed = "tool-output:out_1111111111111111";
  const bare = "out_2222222222222222";
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("large-reference-output", "inspect_large_result"),
    output(
      "large-reference-output",
      [
        prefixed,
        "x".repeat(300_000),
        "without_3333333333333333suffix",
        "out_4444444444444444extended",
        "out_5555555555555555-extra",
        "out_6666666666666666.json",
        "out_7777777777777777/path",
        bare
      ].join(" ")
    )
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1600
  });

  assert.equal(candidate.compressed, true);
  assert.deepEqual(candidate.digest.references, [
    prefixed,
    `tool-output:${bare}`
  ]);
});

test("plain-text reference scans stop after the bounded first set", async () => {
  const bareReferences = Array.from(
    { length: 50_000 },
    (_, index) => `out_${index.toString(16).padStart(16, "0")}`
  );
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("many-plain-references", "inspect_large_result"),
    output("many-plain-references", bareReferences.join(" "))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 4000
  });

  assert.equal(candidate.compressed, true);
  assert.deepEqual(
    candidate.digest.references,
    bareReferences.slice(0, 32).map((reference) => `tool-output:${reference}`)
  );
});

test("requested paths and completed prose do not invent artifacts or next work", async () => {
  const candidate = await createContextLedgerCandidate(largeConversation([
    {
      role: "user",
      content: `Please create /tmp/not-created-report.md. ${"request ".repeat(100)}`
    },
    {
      role: "assistant",
      content: `I cannot create that report. ${"refusal ".repeat(100)}`
    },
    {
      role: "assistant",
      content: `All requested work is complete and verified. ${"complete ".repeat(100)}`
    }
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1600
  });

  assert.equal(candidate.compressed, true);
  assert.equal(
    candidate.digest.artifacts.some((item) => /not-created-report\.md/u.test(item)),
    false
  );
  assert.deepEqual(candidate.digest.next, []);
});

test("semantic outcomes remain authoritative for artifact creation", async () => {
  const deletedPath = "/tmp/deleted-report.md";
  const candidate = await createContextLedgerCandidate(largeConversation([
    call("delete-semantic", "delete_file", { path: deletedPath }),
    output("delete-semantic", semanticOutput("succeeded", {
      changed: true,
      artifacts: [],
      evidence: [],
      padding: `Deleted ${deletedPath}. ${"verified ".repeat(100)}`
    }))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 1600
  });

  assert.equal(candidate.compressed, true);
  assert.equal(
    candidate.digest.artifacts.some((item) => item.includes(deletedPath)),
    false
  );
  assert.ok(
    candidate.digest.changedResources.some((item) => item.includes(deletedPath))
  );
});

test("model-visible marker keeps structured receipts changes and evidence", async () => {
  const conversation = largeConversation([
    { role: "user", content: "You may write and verify the report." },
    { role: "assistant", content: "I decided to use the verified local format." },
    call("write-visible", "write_file", { path: "/tmp/visible-report.md" }),
    output("write-visible", semanticOutput("succeeded", {
      changed: true,
      evidence: ["checkpoint:visible-report"],
      padding: "verified evidence ".repeat(120)
    }))
  ]);
  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 600
  });

  assert.equal(candidate.compressed, true);
  assert.match(candidate.marker, /Objective:/u);
  assert.match(candidate.marker, /Authorization context/u);
  assert.match(candidate.marker, /Decisions:/u);
  assert.match(candidate.marker, /Tool receipts:\n- write_file succeeded/u);
  assert.match(candidate.marker, /Changes:/u);
  assert.match(candidate.marker, /Evidence:/u);
  assert.equal(
    candidate.marker.match(/checkpoint:visible-report/gu)?.length,
    1,
    "exact references are not duplicated inside the structured body"
  );
});

test("reference-heavy markers never install without core ledger sections", async () => {
  const references = Array.from(
    { length: 12 },
    (_, index) => `checkpoint:${"r".repeat(115)}${String(index).padStart(2, "0")}`
  );
  const source = largeConversation([
    call("reference-heavy", "write_file", { path: "/tmp/reference-heavy.md" }),
    output("reference-heavy", semanticOutput("succeeded", {
      changed: true,
      evidence: references,
      padding: "verified reference-heavy output ".repeat(300)
    }))
  ]);
  const candidate = await createContextLedgerCandidate(source, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 2200
  });

  if (candidate.compressed) {
    assert.match(candidate.marker, /\nObjective:\n/u);
    assert.match(candidate.marker, /\nTool receipts:\n/u);
    assert.match(candidate.marker, /\b(?:succeeded|failed|blocked|pending|completed)\b/u);
  } else {
    assert.equal(candidate.marker, undefined);
    assert.deepEqual(candidate.conversation, source);
  }
});

test("marker admission binds every visible receipt to its actual tool and status", async () => {
  const crowdedSource = largeConversation([
    call("crowded-one", "inspect_alpha"),
    output("crowded-one", semanticOutput("succeeded", { changed: false })),
    call("crowded-two", "inspect_beta"),
    output("crowded-two", semanticOutput("succeeded", { changed: false }))
  ]);
  const crowded = await createContextLedgerCandidate(crowdedSource, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 140
  });
  assert.equal(crowded.compressed, false);
  assert.equal(crowded.marker, undefined);
  assert.deepEqual(crowded.conversation, crowdedSource);

  const spoofed = await createContextLedgerCandidate(largeConversation([
    call("status-in-name", "foo pending operation"),
    output("status-in-name", semanticOutput("succeeded", { changed: false }))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 300
  });
  assert.equal(spoofed.compressed, true);
  assert.match(
    spoofed.marker,
    /(?:foo pending operation succeeded|succeeded: foo pending operation)/u
  );

  const opposite = await createContextLedgerCandidate(largeConversation([
    call("opposite-status", "succeeded"),
    output("opposite-status", semanticOutput("failed"))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 240
  });
  assert.equal(opposite.compressed, true);
  assert.match(opposite.marker, /(?:succeeded failed|failed: succeeded)/u);

  const delimited = await createContextLedgerCandidate(largeConversation([
    call("delimiter-name", "evil failed; cover"),
    output("delimiter-name", semanticOutput("succeeded", { changed: false }))
  ]), {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 300
  });
  assert.equal(delimited.compressed, true);
  assert.match(delimited.marker, /evil failed, cover succeeded/u);
  assert.doesNotMatch(delimited.marker, /Tool receipts:\n- evil failed;/u);
});

test("model-visible marker retains every bounded receipt when budget permits", async () => {
  const conversation = largeConversation([
    call("receipt-one", "inspect_alpha"),
    output("receipt-one", semanticOutput("succeeded", {
      changed: false,
      padding: "alpha evidence ".repeat(50)
    })),
    call("receipt-two", "inspect_beta"),
    output("receipt-two", semanticOutput("succeeded", {
      changed: false,
      padding: "beta evidence ".repeat(50)
    })),
    call("receipt-three", "inspect_gamma"),
    output("receipt-three", semanticOutput("succeeded", {
      changed: false,
      padding: "gamma evidence ".repeat(50)
    }))
  ]);
  const candidate = await createContextLedgerCandidate(conversation, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 4000
  });

  assert.equal(candidate.compressed, true);
  assert.match(candidate.marker, /inspect_alpha succeeded/u);
  assert.match(candidate.marker, /inspect_beta succeeded/u);
  assert.match(candidate.marker, /inspect_gamma succeeded/u);
});

test("aggregate histories above the clone ceiling return a bounded failed-open snapshot", async () => {
  const source = Array.from({ length: 82 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `oversized-${index}-${"x".repeat(200_000)}`
  }));

  const candidate = await createContextLedgerCandidate(source, {
    format: "openai",
    keepRecentTurns: 2,
    maxDigestChars: 600
  });

  assertDetachedSafeFailure(candidate);
  assert.ok(
    JSON.stringify(candidate.conversation).length <= 1_000_000,
    "failed-open snapshots remain bounded in aggregate"
  );
});

test("a nonsettling optional summarizer times out into deterministic fallback", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  const timeout = Symbol("timeout");
  let timeoutHandle;
  const raced = await Promise.race([
    previewContextLedger(source, {
      keepRecentTurns: 2,
      maxDigestChars: 600,
      summarizerTimeoutMs: 20,
      summarizer: async () => new Promise(() => {})
    }),
    new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeout), INSTALL_TIMEOUT_MS);
    })
  ]);
  clearTimeout(timeoutHandle);

  assert.notEqual(raced, timeout, "optional summarizer must not wedge compression");
  assert.equal(raced.compressed, true);
  assert.equal(raced.summarySource, "deterministic");
});

test("post-await CPU work remains bounded in an isolated async summarizer", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  const started = Date.now();
  const candidate = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 600,
    summarizerTimeoutMs: 20,
    summarizer: async () => {
      await Promise.resolve();
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        // The worker must be terminated before this loop completes.
      }
      return "late async overview";
    }
  });

  assert.ok(Date.now() - started < INSTALL_TIMEOUT_MS);
  assert.equal(candidate.compressed, true);
  assert.equal(candidate.summarySource, "deterministic");
});

test("promise wrappers and bound async callbacks never run on the request thread", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  const promiseWrapper = () => (async () => {
    await Promise.resolve();
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      // Suspicious promise-producing wrappers are isolated by source shape.
    }
    return "late wrapper overview";
  })();
  const boundAsync = (async function summarizeBoundAsync() {
    await Promise.resolve();
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      // Bound async functions are rejected without invoking native-code text.
    }
    return "late bound overview";
  }).bind({});

  for (const summarizer of [promiseWrapper, boundAsync]) {
    const started = Date.now();
    const candidate = await previewContextLedger(source, {
      keepRecentTurns: 2,
      maxDigestChars: 600,
      summarizerTimeoutMs: 20,
      summarizer
    });
    assert.ok(Date.now() - started < INSTALL_TIMEOUT_MS);
    assert.equal(candidate.compressed, true);
    assert.equal(candidate.summarySource, "deterministic");
  }
});

test("optional summarizers preserve closure, method, and bound callback compatibility", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  const closureValue = "closure-backed overview";
  const objectValue = "object-method overview";
  const objectSummarizer = {
    summarize() {
      return objectValue;
    }
  };
  const boundSummarizer = function summarizeBound() {
    return this.overview;
  }.bind({ overview: "bound-method overview" });

  for (const [summarizer, expected] of [
    [
      cooperativeContextLedgerSummarizer(() => closureValue),
      closureValue
    ],
    [
      cooperativeContextLedgerSummarizer(objectSummarizer.summarize),
      objectValue
    ],
    [
      cooperativeContextLedgerSummarizer(boundSummarizer),
      "bound-method overview"
    ]
  ]) {
    const candidate = await previewContextLedger(source, {
      keepRecentTurns: 2,
      maxDigestChars: 1200,
      summarizer
    });
    assert.equal(candidate.compressed, true);
    assert.equal(candidate.summarySource, "provided");
    assert.match(candidate.digest.overview, new RegExp(expected, "u"));
    assert.match(candidate.marker, /\nOptional overview:\n/u);
  }
});

test("unmarked closure aliases stay in a killable worker", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  let launchCalls = 0;
  const launch = () => {
    launchCalls += 1;
    return Promise.resolve().then(() => {
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        // This work must never start on the request thread.
      }
      return "late alias overview";
    });
  };
  const started = Date.now();
  const candidate = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 600,
    summarizerTimeoutMs: 20,
    summarizer: () => launch()
  });

  assert.ok(Date.now() - started < INSTALL_TIMEOUT_MS);
  assert.equal(launchCalls, 0);
  assert.equal(candidate.compressed, true);
  assert.equal(candidate.summarySource, "deterministic");
});

test("optional overviews yield their budget before core receipt status", async () => {
  const source = largeConversation([
    call("tight-overview", "inspect"),
    output("tight-overview", `completed ${"result ".repeat(500)}`)
  ]);
  const baseline = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 120
  });
  const crowded = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 120,
    summarizer: () => "overview ".repeat(200)
  });

  assert.equal(baseline.compressed, true);
  assert.equal(crowded.compressed, true);
  assert.equal(crowded.summarySource, "deterministic");
  assert.equal(crowded.digest.overview, undefined);
  assert.equal(crowded.marker, baseline.marker);
  assert.match(crowded.marker, /\bcompleted\b/u);
  assert.doesNotMatch(crowded.marker, /Optional overview/u);

  const retained = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 180,
    summarizer: () => "overview ".repeat(200)
  });
  assert.equal(retained.compressed, true);
  assert.equal(retained.summarySource, "provided");
  assert.match(retained.marker, /\bcompleted\b/u);
  assert.match(retained.marker, /\nOptional overview:\n/u);
});

test("a CPU-bound optional summarizer cannot exceed its bounded request budget", async () => {
  const source = largeConversation([
    { role: "assistant", content: "Public decision. ".repeat(150) }
  ]);
  const started = Date.now();
  const candidate = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 600,
    summarizerTimeoutMs: 20,
    summarizer: () => {
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        // Deliberately occupy callback execution until the VM deadline fires.
      }
      return "late overview";
    }
  });

  assert.ok(
    Date.now() - started < INSTALL_TIMEOUT_MS,
    "CPU-bound optional work must be preempted outside the request event loop"
  );
  assert.equal(candidate.compressed, true);
  assert.equal(candidate.summarySource, "deterministic");
});

test("preview, restore, and install enforce private single-use source binding", async () => {
  const installContextLedgerCandidate = condenser.installContextLedgerCandidate;
  assert.equal(
    typeof installContextLedgerCandidate,
    "function",
    "memory-condenser must export installContextLedgerCandidate(candidate, currentConversation)"
  );

  const source = largeConversation([
    { role: "assistant", content: "A public older answer. ".repeat(120) }
  ]);
  const before = structuredClone(source);
  const preview = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 600
  });
  assert.equal(preview.compressed, true);
  assert.deepEqual(restoreContextLedger(preview), before);

  const foreign = structuredClone(source);
  const foreignAttempt = await installContextLedgerCandidate(preview, foreign);
  assert.equal(foreignAttempt.installed, false);
  assert.equal(typeof foreignAttempt.reason, "string");
  assert.deepEqual(foreign, before);

  const validPreview = await previewContextLedger(source, {
    keepRecentTurns: 2,
    maxDigestChars: 600
  });
  const installed = await installContextLedgerCandidate(validPreview, source);
  assert.equal(installed.installed, true);
  assert.deepEqual(installed.conversation, validPreview.conversation);
  assert.notEqual(installed.conversation, validPreview.conversation);
  assert.notEqual(installed.conversation, source);
  installed.conversation.at(-1).content = "installed copy only";
  assert.deepEqual(source, before);

  const repeated = await installContextLedgerCandidate(validPreview, source);
  assert.equal(repeated.installed, false);
  assert.equal(typeof repeated.reason, "string");
  assert.equal(
    (await installContextLedgerCandidate(
      JSON.parse(JSON.stringify(validPreview)),
      source
    )).installed,
    false,
    "serialized or forged candidates have no install capability"
  );
});

test("stale and concurrent candidates cannot cross source boundaries", async () => {
  const installContextLedgerCandidate = condenser.installContextLedgerCandidate;
  assert.equal(typeof installContextLedgerCandidate, "function");

  const staleSource = largeConversation([
    { role: "assistant", content: "Stale candidate fixture. ".repeat(100) }
  ]);
  const stale = await createContextLedgerCandidate(staleSource, {
    keepRecentTurns: 2,
    maxDigestChars: 500
  });
  staleSource[0].content += " mutated after preparation";
  const staleInstall = await installContextLedgerCandidate(stale, staleSource);
  assert.equal(staleInstall.installed, false);
  assert.equal(typeof staleInstall.reason, "string");

  const sourceA = largeConversation([
    { role: "assistant", content: "Source A. ".repeat(100) }
  ]);
  const sourceB = largeConversation([
    { role: "assistant", content: "Source B. ".repeat(100) }
  ]);
  sourceA.at(-1).content = "Latest exact request for A.";
  sourceB.at(-1).content = "Latest exact request for B.";
  const [candidateA, candidateB] = await Promise.all([
    createContextLedgerCandidate(sourceA, {
      keepRecentTurns: 2,
      maxDigestChars: 500
    }),
    createContextLedgerCandidate(sourceB, {
      keepRecentTurns: 2,
      maxDigestChars: 500
    })
  ]);
  assert.equal(
    (await installContextLedgerCandidate(candidateA, sourceB)).installed,
    false
  );
  assert.equal(
    (await installContextLedgerCandidate(candidateB, sourceA)).installed,
    false
  );

  const ownA = await createContextLedgerCandidate(sourceA, {
    keepRecentTurns: 2,
    maxDigestChars: 500
  });
  const ownB = await createContextLedgerCandidate(sourceB, {
    keepRecentTurns: 2,
    maxDigestChars: 500
  });
  const [installedA, installedB] = await Promise.all([
    installContextLedgerCandidate(ownA, sourceA),
    installContextLedgerCandidate(ownB, sourceB)
  ]);
  assert.equal(installedA.installed, true);
  assert.equal(installedB.installed, true);
  assert.match(JSON.stringify(installedA.conversation), /request for A/u);
  assert.doesNotMatch(JSON.stringify(installedA.conversation), /request for B/u);
  assert.match(JSON.stringify(installedB.conversation), /request for B/u);
  assert.doesNotMatch(JSON.stringify(installedB.conversation), /request for A/u);
});

test("candidate accessors cannot swap content between validation and install", async () => {
  const installContextLedgerCandidate = condenser.installContextLedgerCandidate;
  const source = largeConversation([
    { role: "assistant", content: "Prepared public ledger content. ".repeat(100) }
  ]);
  const before = structuredClone(source);
  const candidate = await createContextLedgerCandidate(source, {
    keepRecentTurns: 2,
    maxDigestChars: 500
  });
  assert.equal(candidate.compressed, true);

  const prepared = candidate.conversation;
  const injected = [{ role: "user", content: "INJECTED" }];
  let conversationReads = 0;
  Object.defineProperty(candidate, "conversation", {
    configurable: true,
    enumerable: true,
    get() {
      conversationReads += 1;
      return conversationReads === 1 ? prepared : injected;
    }
  });

  const rejected = installContextLedgerCandidate(candidate, source);
  assert.equal(rejected.installed, false);
  assert.equal(rejected.reason, "stale_candidate");
  assert.equal(conversationReads, 0, "install must inspect descriptors without invoking getters");
  assert.deepEqual(source, before);
  assert.doesNotMatch(JSON.stringify(rejected.conversation), /INJECTED/u);

  const compressedAccessor = await createContextLedgerCandidate(source, {
    keepRecentTurns: 2,
    maxDigestChars: 500
  });
  let compressedReads = 0;
  Object.defineProperty(compressedAccessor, "compressed", {
    configurable: true,
    enumerable: true,
    get() {
      compressedReads += 1;
      return true;
    }
  });
  const compressedRejected = installContextLedgerCandidate(
    compressedAccessor,
    source
  );
  assert.equal(compressedRejected.installed, false);
  assert.equal(compressedRejected.reason, "stale_candidate");
  assert.equal(compressedReads, 0);
});

test("duplicate provider call ids never leave an exact orphan across the ledger boundary", async () => {
  const source = [
    { role: "user", content: `Current objective ${"x".repeat(500)}` },
    call("x", "step", { occurrence: 1 }),
    output("x", `result-x-one-${"a".repeat(300)}`),
    call("y", "step", { occurrence: 1 }),
    output("y", `result-y-${"b".repeat(300)}`),
    call("x", "step", { occurrence: 2 }),
    output("x", `result-x-two-${"c".repeat(300)}`),
    call("z", "step", { occurrence: 1 }),
    output("z", `result-z-${"d".repeat(300)}`)
  ];
  const candidate = await createContextLedgerCandidate(source, {
    format: "openai",
    keepRecentTurns: 3,
    maxDigestChars: 300
  });

  assert.equal(candidate.compressed, true);
  const exact = candidate.conversation.filter((item) => item?.type);
  for (const id of ["x", "y", "z"]) {
    const calls = exact.filter((item) => item.type === "function_call" && item.call_id === id).length;
    const outputs = exact.filter((item) => item.type === "function_call_output" && item.call_id === id).length;
    assert.equal(calls, outputs, `exact suffix must keep every ${id} pair complete`);
  }
});

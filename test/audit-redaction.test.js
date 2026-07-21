// Redaction belongs only at audit/response boundaries: execution keeps the
// caller's real values, while every durable or externally returned clone is safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../src/agent-host.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { OutcomeStore } from "../src/outcome-store.js";
import { PendingActionStore, approvePendingAction } from "../src/pending-actions.js";
import { sanitizeForAudit } from "../src/redact.js";
import { ToolRegistry } from "../src/tool-registry.js";

const bearer = `Bearer ${"a".repeat(48)}`;
const openAiKey = `sk-${"A".repeat(24)}`;
const slackKey = "xoxb-1234567890-abcdefghij";
const githubKey = `ghp_${"b".repeat(30)}`;
const awsKey = `AKIA${"C".repeat(16)}`;

test("sanitizeForAudit deep-clones key and value secrets without mutating input", () => {
  const input = {
    token: "plain-token-value",
    nested: {
      password: { raw: "nested" },
      safe: "visible",
      note: `${openAiKey} ${slackKey} ${githubKey} ${awsKey} ${bearer}`
    },
    authorizationHeader: bearer,
    list: [{ api_key: openAiKey }, "ordinary"]
  };
  const safe = sanitizeForAudit(input);

  assert.notStrictEqual(safe, input);
  assert.notStrictEqual(safe.nested, input.nested);
  assert.equal(safe.token, "[REDACTED]");
  assert.equal(safe.nested.password, "[REDACTED]");
  assert.equal(safe.authorizationHeader, "[REDACTED]");
  assert.equal(safe.list[0].api_key, "[REDACTED]");
  assert.equal(safe.nested.safe, "visible");
  const serialized = JSON.stringify(safe);
  for (const secret of [openAiKey, slackKey, githubKey, awsKey, bearer]) {
    assert.doesNotMatch(serialized, new RegExp(secret), secret);
  }
  assert.equal(input.token, "plain-token-value", "the live input remains untouched");
  assert.equal(input.nested.note.includes(openAiKey), true);
});

test("pending-action persistence is masked while approved execution receives the real args", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-pending-"));
  const pending = new PendingActionStore({ dir });
  const tools = new ToolRegistry();
  const seen = [];
  tools.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async (args) => { seen.push(args); return { exitCode: 0 }; }
  });
  tools.bindPendingActions(pending);
  const args = { command: "wsl --shutdown", authorization: bearer, nested: { apiKey: openAiKey } };

  const gated = tools.invoke("code_shell", args, { sessionId: "audit-session" });
  await new Promise((resolve) => setImmediate(resolve));
  const action = pending.list({ status: "pending" })[0];
  const journal = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
  assert.doesNotMatch(journal, new RegExp("a".repeat(48)));
  assert.doesNotMatch(journal, new RegExp(openAiKey));
  assert.match(journal, /\[REDACTED\]/);
  assert.equal(action.args.authorization, bearer, "the in-memory action keeps executable args");

  const approval = approvePendingAction({ pendingActions: pending, tools }, action.id, { decidedBy: "test" });
  const executed = await gated;
  await approval;
  assert.equal(executed.ok, true);
  assert.equal(seen[0].authorization, bearer);
  assert.equal(seen[0].nested.apiKey, openAiKey);

  pending.snapshot();
  const snapshot = fs.readFileSync(path.join(dir, "snapshot.json"), "utf8");
  assert.doesNotMatch(snapshot, new RegExp(openAiKey));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the MCP status response masks expanded args, env, headers, and credential fields", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-mcp-"));
  const runtime = {
    pendingActions: {
      bindEvents() {},
      list: () => [{ id: "action-1", args: { authorization: bearer, safe: "visible" } }]
    },
    mcp: {
      listServers: () => [{
        name: "secret-server",
        transport: "stdio",
        args: ["--header", `Authorization: ${bearer}`, `--github=${githubKey}`],
        env: { SERVICE_TOKEN: "expanded-env-secret", NORMAL_VALUE: "visible" },
        headers: { authorization: bearer, "x-safe": "hello" },
        apiKey: githubKey,
        clientSecret: openAiKey,
        connected: false
      }],
      isConnecting: () => false
    }
  };
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "", dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  t.after(async () => {
    await app.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const response = await fetch(`${base}/mcp`);
  const [server] = await response.json();
  assert.equal(response.status, 200);
  assert.equal(server.env.SERVICE_TOKEN, "[REDACTED]");
  assert.equal(server.env.NORMAL_VALUE, "visible");
  assert.equal(server.headers.authorization, "[REDACTED]");
  assert.equal(server.headers["x-safe"], "hello");
  assert.equal(server.apiKey, "[REDACTED]");
  assert.equal(server.clientSecret, "[REDACTED]");
  const serialized = JSON.stringify(server);
  assert.doesNotMatch(serialized, new RegExp("a".repeat(48)));
  assert.doesNotMatch(serialized, new RegExp(githubKey));
  assert.match(serialized, /\[REDACTED\]/);

  const pending = await (await fetch(`${base}/pending-actions`)).json();
  assert.equal(pending.actions[0].args.authorization, "[REDACTED]");
  assert.equal(pending.actions[0].args.safe, "visible");
});

test("AgentHost sanitizes assistant tool-call arguments before session persistence", async () => {
  const store = new InMemoryAgentStore();
  const runtime = {
    tools: { toOpenAITools: () => [] },
    memory: { remember: () => ({ id: "memory-1" }) },
    outcomes: { resolveByUserFollowup() {}, record: () => ({ id: "outcome-1" }) },
    processSignal: () => ({
      id: "output-1",
      scrutiny: { action: "act", score: 0.9, reasons: [], dimensions: { novelty: 0.2, risk: 0.1, repetition: 0.1 } },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    store,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async () => ({
        text: "done",
        provider: "stub",
        model: "stub",
        id: "response-1",
        toolCalls: [{ name: "remote_call", arguments: { authorization: bearer, note: openAiKey }, result: { ok: true } }]
      })
    }
  });

  await host.handleMessage({ channel: "local", from: "creator", sessionId: "audit-host", text: "Do the work" });
  const assistant = store.getSession("audit-host").messages.at(-1);
  assert.equal(assistant.metadata.toolCalls[0].arguments.authorization, "[REDACTED]");
  assert.equal(assistant.metadata.toolCalls[0].arguments.note, "[REDACTED]");
});

test("OutcomeStore sanitizes its input clone before memory and disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-outcome-"));
  const store = new OutcomeStore({ dir });
  const input = {
    kind: "tool-call",
    toolCalls: [{ name: "remote", arguments: { password: slackKey }, ok: true }],
    metadata: { apiKey: githubKey, narrative: `used ${openAiKey}` }
  };
  const outcome = store.record(input);

  assert.equal(outcome.metadata.apiKey, "[REDACTED]");
  assert.equal(outcome.metadata.narrative, "used [REDACTED]");
  assert.equal(outcome.toolCalls[0].arguments.password, "[REDACTED]");
  assert.equal(input.metadata.apiKey, githubKey, "record() does not mutate its caller");
  const persisted = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
    + fs.readFileSync(path.join(dir, "snapshot.json"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(githubKey));
  assert.doesNotMatch(persisted, new RegExp(openAiKey));
  fs.rmSync(dir, { recursive: true, force: true });
});

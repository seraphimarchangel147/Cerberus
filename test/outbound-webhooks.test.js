import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  OutboundWebhookDispatcher,
  loadWebhookConfig,
  parseSubscription,
  registerOutboundWebhooks,
  QUEUE_CAPACITY,
  SIGNATURE_HEADER
} from "../src/outbound-webhooks.js";
import { HookRegistry } from "../src/hook-registry.js";

const SECRET = "hmac-key-do-not-log-8f3a";

// A real local receiver. Mocking fetch would not catch an encode-twice bug or a
// redirect being followed, which are the two failures this phase exists to avoid.
async function startReceiver(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const record = { headers: req.headers, raw, text: raw.toString("utf8") };
      received.push(record);
      handler(req, res, record, received.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    async close() { await new Promise((resolve) => server.close(resolve)); }
  };
}

function subscription(url, overrides = {}) {
  return {
    name: "test",
    url,
    secret: SECRET,
    events: ["post_tool_call"],
    allowPrivate: true, // loopback receiver in-test; guard is exercised separately
    ...overrides
  };
}

function makeDispatcher(subs, extra = {}) {
  return new OutboundWebhookDispatcher({
    subscriptions: subs,
    log: () => {},
    sleep: () => Promise.resolve(),
    ...extra
  });
}

test("signature is HMAC-SHA256 over the raw body bytes", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", { toolName: "terminal" });
    await dispatcher.flush();

    assert.equal(receiver.received.length, 1);
    const record = receiver.received[0];
    const expected = "sha256=" + createHmac("sha256", SECRET).update(record.raw).digest("hex");
    assert.equal(record.headers[SIGNATURE_HEADER.toLowerCase()], expected);
    assert.equal(record.headers["x-cerberus-event"], "post_tool_call");
    assert.equal(record.headers["user-agent"], "cerberus-webhooks/1");
    assert.ok(record.headers["x-cerberus-delivery"]);

    const body = JSON.parse(record.text);
    assert.equal(body.event, "post_tool_call");
    assert.equal(body.payload.toolName, "terminal");
    assert.ok(body.eventId && body.at && body.agent);
  } finally {
    await receiver.close();
  }
});

test("signature survives non-ASCII payload values (raw bytes, not re-encoded)", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", { note: "n\u00e3o-ASCII \u2014 caf\u00e9 \u2713 \ud83d\udd25" });
    await dispatcher.flush();

    const record = receiver.received[0];
    const expected = "sha256=" + createHmac("sha256", SECRET).update(record.raw).digest("hex");
    assert.equal(record.headers[SIGNATURE_HEADER.toLowerCase()], expected);
    assert.equal(JSON.parse(record.text).payload.note, "n\u00e3o-ASCII \u2014 caf\u00e9 \u2713 \ud83d\udd25");
  } finally {
    await receiver.close();
  }
});

test("4xx is not retried: exactly one attempt", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(422); res.end("nope"); });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", {});
    await dispatcher.flush();
    assert.equal(receiver.received.length, 1);
    assert.equal(dispatcher.stats().attempts, 1);
    assert.equal(dispatcher.stats().delivered, 0);
    assert.equal(dispatcher.stats().failed, 1);
  } finally {
    await receiver.close();
  }
});

test("5xx retries and gives up at the attempt cap", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(503); res.end("later"); });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", {});
    await dispatcher.flush();
    assert.equal(receiver.received.length, 3);
    assert.equal(dispatcher.stats().attempts, 3);
    assert.equal(dispatcher.stats().failed, 1);
    // Retries carry an increasing attempt counter so a receiver can dedupe.
    assert.deepEqual(
      receiver.received.map((r) => r.headers["x-cerberus-delivery-attempt"]),
      ["1", "2", "3"]
    );
    // Each attempt gets a fresh delivery id but a stable eventId.
    const ids = new Set(receiver.received.map((r) => r.headers["x-cerberus-delivery"]));
    assert.equal(ids.size, 3);
    const eventIds = new Set(receiver.received.map((r) => JSON.parse(r.text).eventId));
    assert.equal(eventIds.size, 1);
  } finally {
    await receiver.close();
  }
});

test("3xx is never followed and counts as a permanent failure", async () => {
  const redirected = [];
  const target = await startReceiver((req, res) => { redirected.push(1); res.writeHead(200); res.end("ok"); });
  const receiver = await startReceiver((req, res) => {
    res.writeHead(302, { Location: target.url });
    res.end();
  });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", {});
    await dispatcher.flush();
    assert.equal(receiver.received.length, 1, "one attempt, no retry");
    assert.equal(redirected.length, 0, "redirect target must never receive the signed body");
    assert.equal(dispatcher.stats().failed, 1);
    assert.equal(dispatcher.stats().delivered, 0);
  } finally {
    await receiver.close();
    await target.close();
  }
});

test("queue overflow drops the oldest, increments dropped, does not throw", () => {
  const dispatcher = makeDispatcher([subscription("https://example.com/hook")], {
    // Never resolve, so nothing drains while we overflow the queue.
    fetchImpl: () => new Promise(() => {})
  });
  for (let i = 0; i < QUEUE_CAPACITY + 20; i += 1) {
    assert.doesNotThrow(() => dispatcher.enqueue("post_tool_call", { i }));
  }
  const stats = dispatcher.stats();
  assert.ok(stats.queued <= QUEUE_CAPACITY, `queued ${stats.queued} exceeded capacity`);
  assert.ok(stats.dropped >= 19, `expected drops, got ${stats.dropped}`);
});

test("event filtering: session:* matches session:end but not post_tool_call", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url, { events: ["session:*"] })]);
    assert.equal(dispatcher.enqueue("session:end", {}), 1);
    assert.equal(dispatcher.enqueue("post_tool_call", {}), 0);
    await dispatcher.flush();
    assert.equal(receiver.received.length, 1);
    assert.equal(receiver.received[0].headers["x-cerberus-event"], "session:end");
  } finally {
    await receiver.close();
  }
});

test("flush resolves only after in-flight deliveries settle", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const receiver = await startReceiver(async (req, res) => {
    await gate;
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url)]);
    dispatcher.enqueue("post_tool_call", {});
    let settled = false;
    const flushed = dispatcher.flush().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, "flush resolved before the receiver answered");
    release();
    await flushed;
    assert.equal(settled, true);
    assert.equal(dispatcher.stats().delivered, 1);
    assert.equal(dispatcher.stats().queued, 0);
  } finally {
    await receiver.close();
  }
});

test("a hung receiver does not delay the enqueueing caller", async () => {
  const held = [];
  const receiver = await startReceiver((req, res) => { held.push(res); /* never respond */ });
  try {
    const dispatcher = makeDispatcher([subscription(receiver.url, { timeoutMs: 60_000 })]);
    const startedAt = Date.now();
    dispatcher.enqueue("post_tool_call", {});
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 50, `enqueue blocked for ${elapsed}ms`);
    for (const res of held) { try { res.destroy(); } catch { /* ignore */ } }
  } finally {
    await receiver.close();
  }
});

test("the secret never appears in logs, errors, or stats()", async () => {
  const lines = [];
  const receiver = await startReceiver((req, res) => { res.writeHead(500); res.end("boom"); });
  try {
    const dispatcher = new OutboundWebhookDispatcher({
      subscriptions: [subscription(receiver.url)],
      log: (message) => lines.push(String(message)),
      sleep: () => Promise.resolve()
    });
    dispatcher.enqueue("post_tool_call", {});
    await dispatcher.flush();
    const stats = dispatcher.stats();
    assert.ok(lines.length > 0, "expected at least one failure log line");
    for (const line of lines) assert.ok(!line.includes(SECRET), `secret leaked into log: ${line}`);
    assert.ok(!JSON.stringify(stats).includes(SECRET), "secret leaked into stats()");
    assert.equal(stats.subscriptions[0].signed, true, "stats should report signing status, not the key");
  } finally {
    await receiver.close();
  }
});

test("url guard rejects loopback targets unless allowPrivate is set", () => {
  const blocked = parseSubscription({ name: "ssrf", url: "http://169.254.169.254/latest/meta-data", events: ["*"] }, 0);
  assert.ok(blocked.error, "metadata address must be rejected");
  assert.match(blocked.error, /allowPrivate/);

  const allowed = parseSubscription({ name: "ssrf", url: "http://127.0.0.1:9/hook", events: ["*"], allowPrivate: true }, 0);
  assert.ok(allowed.subscription, allowed.error);
  assert.equal(allowed.subscription.allowPrivate, true);
});

test("malformed webhooks.json is fail-open and yields zero subscriptions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-webhooks-"));
  try {
    fs.writeFileSync(path.join(dir, "webhooks.json"), "{ not json");
    const result = loadWebhookConfig(dir, { log: () => {} });
    assert.deepEqual(result.subscriptions, []);

    fs.writeFileSync(path.join(dir, "webhooks.json"), JSON.stringify({ webhooks: "nope" }));
    const malformed = loadWebhookConfig(dir, { log: () => {} });
    assert.equal(malformed.malformed, true);
    assert.deepEqual(malformed.subscriptions, []);

    fs.writeFileSync(path.join(dir, "webhooks.json"), JSON.stringify({
      webhooks: [
        { name: "ok", url: "https://example.com/hook", events: ["*"], secret: SECRET },
        { name: "broken", events: ["*"] }
      ]
    }));
    const mixed = loadWebhookConfig(dir, { log: () => {} });
    assert.equal(mixed.subscriptions.length, 1, "one good entry survives a bad sibling");
    assert.equal(mixed.subscriptions[0].name, "ok");
    assert.equal(mixed.errors.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registering on a real HookRegistry delivers via notify with no call-site changes", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const hooks = new HookRegistry({ log: () => {} });
    const dispatcher = registerOutboundWebhooks(hooks, {
      subscriptions: [subscription(receiver.url, { events: ["session:*", "post_tool_call"] })],
      log: () => {},
      sleep: () => Promise.resolve()
    });
    assert.ok(dispatcher, "dispatcher should exist when subscriptions are configured");

    hooks.notify("session:end", { sessionId: "s1" });
    await hooks.flush();
    await dispatcher.flush();

    assert.equal(receiver.received.length, 1);
    assert.equal(receiver.received[0].headers["x-cerberus-event"], "session:end");
    assert.equal(JSON.parse(receiver.received[0].text).payload.sessionId, "s1");
  } finally {
    await receiver.close();
  }
});

test("registerOutboundWebhooks returns null when nothing is configured", () => {
  const hooks = new HookRegistry({ log: () => {} });
  assert.equal(registerOutboundWebhooks(hooks, { subscriptions: [], log: () => {} }), null);
});

test("approval:required is emitted without args and reaches a subscriber", async () => {
  const receiver = await startReceiver((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    const hooks = new HookRegistry({ log: () => {} });
    const dispatcher = registerOutboundWebhooks(hooks, {
      subscriptions: [subscription(receiver.url, { events: ["approval:required"] })],
      log: () => {},
      sleep: () => Promise.resolve()
    });

    // Mirrors the payload built in ToolRegistry._suspendForApproval.
    hooks.notify("approval:required", {
      actionId: "act_1",
      toolName: "code_shell",
      summary: "rm -rf /",
      severity: "catastrophic",
      sessionId: "s1"
    });
    await hooks.flush();
    await dispatcher.flush();

    const body = JSON.parse(receiver.received[0].text);
    assert.equal(body.event, "approval:required");
    assert.equal(body.payload.toolName, "code_shell");
    assert.equal(body.payload.severity, "catastrophic");
    assert.equal(body.payload.args, undefined, "args must never leave the machine");
  } finally {
    await receiver.close();
  }
});

test("event names used by the new emissions are registrable patterns", () => {
  const hooks = new HookRegistry({ log: () => {} });
  for (const event of ["turn:complete", "approval:required"]) {
    assert.doesNotThrow(() => hooks.notify(event, {}), `${event} must be a legal event name`);
  }
  assert.doesNotThrow(() => hooks.register({
    name: "wave4.turn", event: "turn:*", tier: "plugin", handler: () => {}
  }));
});

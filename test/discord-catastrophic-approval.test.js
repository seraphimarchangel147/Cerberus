// The catastrophic prompt is a stateful Hermes-style view implemented over
// raw Discord REST calls. These tests keep Discord fake but exercise the real
// gateway dispatch, pending store, registry gate, and session allowance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiscordChannel } from "../src/discord-channel.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ToolRegistry } from "../src/tool-registry.js";

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-catastrophic-"));
  const events = new EventEmitter();
  const pendingActions = new PendingActionStore({ dir: path.join(root, "pending") });
  const tools = new ToolRegistry();
  const executions = [];
  const restCalls = [];
  let nextMessage = 1;

  tools.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async ({ command }) => {
      executions.push(command);
      return { exitCode: 0, stdout: "safe stub output" };
    }
  });
  tools.bindPendingActions(pendingActions);
  pendingActions.bindEvents(events);

  const runtime = { tools, pendingActions };
  const channel = new DiscordChannel({
    agentHost: { runtime },
    token: "test-token",
    dir: path.join(root, "discord"),
    allowFrom: ["owner-1"],
    activityChannel: "10001",
    presence: false,
    liveStatus: false
  });
  channel.rest = async (pathname, options = {}) => {
    const call = { pathname, method: options.method ?? "GET", body: options.body ?? null };
    restCalls.push(call);
    if (pathname === "/channels/10001/messages" && call.method === "POST") {
      return { id: `message-${nextMessage++}`, channel_id: "10001" };
    }
    return {};
  };
  channel.bindActivityFeed(events);

  t.after(() => {
    channel.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { channel, tools, pendingActions, executions, restCalls };
}

async function enqueueCatastrophic(harness, sessionId = "discord:guild:10001") {
  const result = await harness.tools.invoke(
    "code_shell",
    { command: "wsl --shutdown" },
    { sessionId, channel: "discord" }
  );
  assert.equal(result.result.status, "awaiting_confirmation");
  await waitFor(() => approvalPosts(harness).length === 1);
  return harness.pendingActions.get(result.result.actionId);
}

function approvalPosts(harness) {
  return harness.restCalls.filter((call) =>
    call.pathname === "/channels/10001/messages" && call.method === "POST" && call.body?.embeds
  );
}

function interactionFor(harness, action, choice, userId = "owner-1", suffix = "1") {
  const card = approvalPosts(harness)[0].body;
  return {
    id: `interaction-${suffix}`,
    token: `token-${suffix}`,
    application_id: "app-1",
    type: 3,
    channel_id: "10001",
    data: { custom_id: `pa:${choice}:${action.id}` },
    member: { nick: userId === "owner-1" ? "Creator" : "Intruder", user: { id: userId, username: userId } },
    message: { id: "message-1", channel_id: "10001", embeds: card.embeds, components: card.components }
  };
}

async function dispatch(channel, interaction) {
  await channel.handleGatewayPayload({ op: 0, t: "INTERACTION_CREATE", s: 1, d: interaction });
}

async function waitFor(predicate) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for asynchronous activity-feed work");
}

test("catastrophic enqueue posts the exact three-button approval card", async (t) => {
  const harness = createHarness(t);
  const action = await enqueueCatastrophic(harness);
  const card = approvalPosts(harness)[0].body;

  assert.equal(harness.executions.length, 0);
  assert.match(card.embeds[0].title, /Catastrophic action/);
  assert.match(JSON.stringify(card.embeds[0]), /wsl --shutdown/);
  assert.match(JSON.stringify(card.embeds[0]), new RegExp(action.reason));
  assert.deepEqual(card.components[0].components.map(({ label, style, custom_id }) => ({ label, style, custom_id })), [
    { label: "Approve Once", style: 3, custom_id: `pa:approve:${action.id}` },
    { label: "Allow for session", style: 2, custom_id: `pa:session:${action.id}` },
    { label: "Deny", style: 4, custom_id: `pa:deny:${action.id}` }
  ]);
});

test("approve is first-click-wins, disables before execution, and records the Hermes note", async (t) => {
  const harness = createHarness(t);
  const action = await enqueueCatastrophic(harness);
  await dispatch(harness.channel, interactionFor(harness, action, "approve"));

  const callback = harness.restCalls.find((call) => call.pathname.includes("/interactions/interaction-1/"));
  assert.equal(callback.body.type, 6, "authorized click is acknowledged as a deferred update");
  const edits = harness.restCalls.filter((call) => call.pathname.includes("/webhooks/app-1/token-1/messages/@original"));
  assert.ok(edits.length >= 2, "card is edited before and after the action");
  assert.ok(edits[0].body.components[0].components.every((button) => button.disabled));
  assert.equal(edits[0].body.embeds[0].color, 0x2ecc71);
  assert.equal(edits[0].body.embeds[0].footer.text, "Approved once by Creator");
  assert.deepEqual(harness.executions, ["wsl --shutdown"]);

  const decided = harness.pendingActions.get(action.id);
  assert.equal(decided.status, "approved");
  assert.equal(decided.approvedVia, "discord-button");
  assert.equal(decided.decider, "owner-1");
  assert.equal(decided.deciderDisplayName, "Creator");
  assert.equal(
    decided.result.approvalNote,
    `Command required approval (${action.reason}) and was approved by the user.`
  );
  const followUp = harness.restCalls.find((call) => call.body?.content?.includes("exitCode: 0"));
  assert.match(followUp.body.content, /safe stub output/);

  await dispatch(harness.channel, interactionFor(harness, action, "approve", "owner-1", "2"));
  assert.equal(harness.executions.length, 1, "a later click cannot execute again");
  const secondReply = harness.restCalls.find((call) => call.pathname.includes("/interactions/interaction-2/"));
  assert.equal(secondReply.body.type, 4);
  assert.equal(secondReply.body.data.flags, 64);
  assert.match(secondReply.body.data.content, /already been resolved/);
});

test("authorization is checked on every click and an unauthorized click does not resolve", async (t) => {
  const harness = createHarness(t);
  const action = await enqueueCatastrophic(harness);
  await dispatch(harness.channel, interactionFor(harness, action, "deny", "stranger", "bad"));

  const refusal = harness.restCalls.find((call) => call.pathname.includes("/interactions/interaction-bad/"));
  assert.equal(refusal.body.type, 4);
  assert.equal(refusal.body.data.flags, 64);
  assert.match(refusal.body.data.content, /not authorized/);
  assert.equal(harness.pendingActions.get(action.id).status, "pending");

  await dispatch(harness.channel, interactionFor(harness, action, "deny", "owner-1", "good"));
  assert.equal(harness.pendingActions.get(action.id).status, "denied");
  assert.equal(harness.pendingActions.get(action.id).decider, "owner-1");
});

test("timeout disables the card but deliberately leaves the action pending", async (t) => {
  const harness = createHarness(t);
  const action = await enqueueCatastrophic(harness);
  assert.equal(await harness.channel.expireApprovalPrompt(action.id), true);

  assert.equal(harness.pendingActions.get(action.id).status, "pending");
  const timeoutEdit = harness.restCalls.find((call) =>
    call.pathname === "/channels/10001/messages/message-1" && call.method === "PATCH"
  );
  assert.equal(timeoutEdit.body.embeds[0].color, 0x95a5a6);
  assert.equal(timeoutEdit.body.embeds[0].footer.text, "\u23f1 Prompt expired \u2014 no action taken");
  assert.ok(timeoutEdit.body.components[0].components.every((button) => button.disabled));
});

test("Allow for session executes once and lets the same tool/session skip later cards", async (t) => {
  const harness = createHarness(t);
  const action = await enqueueCatastrophic(harness);
  await dispatch(harness.channel, interactionFor(harness, action, "session"));
  assert.deepEqual(harness.executions, ["wsl --shutdown"]);
  assert.equal(harness.tools.isAllowedForSession("discord:guild:10001", "code_shell"), true);

  const second = await harness.tools.invoke(
    "code_shell",
    { command: "wsl --shutdown" },
    { sessionId: "discord:guild:10001", channel: "discord" }
  );
  assert.equal(second.ok, true);
  assert.equal(second.result.exitCode, 0);
  assert.deepEqual(harness.executions, ["wsl --shutdown", "wsl --shutdown"]);
  assert.equal(approvalPosts(harness).length, 1, "session allowance suppresses a second card");
});

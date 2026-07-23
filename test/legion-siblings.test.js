import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSibling, siblingNames, siblingTable, BUILTIN_SIBLINGS, legionUserId, legionMember, LEGION_MEMBERS } from "../src/legion-siblings.js";
import { formatLegionContextBlock, CHAT_CORE_TOOLS } from "../src/agent-host.js";

test("resolveSibling resolves builtin names case-insensitively", () => {
  assert.equal(resolveSibling("seraphim"), BUILTIN_SIBLINGS.seraphim);
  assert.equal(resolveSibling("SERAPHIM"), BUILTIN_SIBLINGS.seraphim);
  assert.equal(resolveSibling("  Home  "), BUILTIN_SIBLINGS.home);
});

test("resolveSibling resolves ziz to his channel (was missing pre-2026-07-23)", () => {
  assert.equal(resolveSibling("ziz"), BUILTIN_SIBLINGS.ziz);
  assert.equal(resolveSibling("ZIZ"), "1488300124395540501");
});

test("legionUserId returns raw discord user id for a real ping", () => {
  // A plain-text @Name never pings; addressing a sibling needs <@userId>.
  assert.equal(legionUserId("ziz"), "1487563271753040063");
  assert.equal(legionUserId("azazel"), "1493089655531241634");
  assert.equal(legionUserId("Seraphim"), "1477373994578608238");
  assert.equal(legionUserId("nobody"), null);
  assert.equal(legionUserId(null), null);
});

test("legionMember carries the sibling's WSL home", () => {
  const ziz = legionMember("ziz");
  assert.match(ziz.home, /\.zeroclaw/);
  assert.match(ziz.label, /zerohermes/);
  assert.equal(legionMember("bogus"), null);
});

test("formatLegionContextBlock teaches raw-id mentions, homes, and the off-Discord lane", () => {
  const block = formatLegionContextBlock(
    { channel: "discord", metadata: { channelId: "C1", guildId: "G1" } },
    {}
  );
  // Emits Ziz's REAL ping form + where he runs.
  assert.match(block, /<@1487563271753040063>/);
  assert.match(block, /\.zeroclaw/);
  // Explicitly warns plain @Name doesn't notify.
  assert.match(block, /raw Discord user id/);
  // Off-Discord fallback lane is advertised.
  assert.match(block, /\.legion\/mailbox/);
});

test("resolveSibling returns null for unknown so callers can error", () => {
  assert.equal(resolveSibling("nobody"), null);
  assert.equal(resolveSibling(""), null);
  assert.equal(resolveSibling(null), null);
});

test("env override wins over builtin and file", () => {
  const env = { OPENAGI_LEGION_SIBLINGS: JSON.stringify({ seraphim: "999", newbie: { channel: "111" } }) };
  const t = siblingTable(env, "/nonexistent");
  assert.equal(t.seraphim.channel, "999");
  assert.equal(t.newbie.channel, "111");
  // Untouched builtins survive.
  assert.equal(t.home.channel, BUILTIN_SIBLINGS.home);
});

test("malformed env override does not break routing", () => {
  const env = { OPENAGI_LEGION_SIBLINGS: "{not json" };
  assert.equal(resolveSibling("seraphim", env, "/nonexistent"), BUILTIN_SIBLINGS.seraphim);
});

test("siblingNames is sorted and includes builtins", () => {
  const names = siblingNames({}, "/nonexistent");
  assert.ok(names.includes("seraphim"));
  assert.ok(names.includes("home"));
  assert.deepEqual(names, [...names].sort());
});

test("chat-core allowlist now carries a send lane + tool discovery", () => {
  // Regression for the "I only see 6 tools / no lane to Seraphim" failure:
  // even a casual turn must be able to reach out and find the rest.
  assert.ok(CHAT_CORE_TOOLS.includes("send_message"));
  assert.ok(CHAT_CORE_TOOLS.includes("searcmcp_tools"));
});

test("formatLegionContextBlock only fires for discord turns", () => {
  assert.equal(formatLegionContextBlock(null), "");
  assert.equal(formatLegionContextBlock({ channel: "telegram", metadata: {} }), "");
  assert.equal(formatLegionContextBlock({ channel: "local", metadata: {} }), "");
});

test("formatLegionContextBlock names the channel, server, and sibling lane", () => {
  const block = formatLegionContextBlock(
    { channel: "discord", metadata: { channelId: "C1", guildId: "G1" } },
    {}
  );
  assert.match(block, /Legion \/ Discord context/);
  assert.match(block, /channel C1 in server G1/);
  assert.match(block, /send_message\(channel:"sibling"/);
  assert.match(block, /send_message\(channel:"mailbox"/);
  assert.match(block, /prefixes the sibling's real raw-ID mention/);
  assert.match(block, /seraphim/);
});

test("formatLegionContextBlock handles a DM (no guild) without crashing", () => {
  const block = formatLegionContextBlock(
    { channel: "discord", metadata: { channelId: "D1" } },
    {}
  );
  assert.match(block, /channel D1/);
  assert.doesNotMatch(block, /in server/);
});

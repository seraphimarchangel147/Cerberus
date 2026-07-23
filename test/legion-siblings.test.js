import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSibling, siblingNames, siblingTable, BUILTIN_SIBLINGS } from "../src/legion-siblings.js";
import { formatLegionContextBlock, CHAT_CORE_TOOLS } from "../src/agent-host.js";

test("resolveSibling resolves builtin names case-insensitively", () => {
  assert.equal(resolveSibling("seraphim"), BUILTIN_SIBLINGS.seraphim);
  assert.equal(resolveSibling("SERAPHIM"), BUILTIN_SIBLINGS.seraphim);
  assert.equal(resolveSibling("  Home  "), BUILTIN_SIBLINGS.home);
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

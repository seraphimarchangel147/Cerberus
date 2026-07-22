// Discord session-key migration (Bug #1). When the guild session key gained a
// :user segment, the old 3-segment transcript was orphaned (measured incident:
// 63 messages went dark). These tests pin the pure legacy-key derivation and
// the idempotent, never-clobbering file-store migration that recovers it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBackedAgentStore, legacyDiscordKey } from "../src/agent-store.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-key-migrate-"));
  return new FileBackedAgentStore({ dir, ensureDefault: false });
}

test("legacyDiscordKey: 4-segment guild key returns its 3-segment ancestor", () => {
  assert.equal(legacyDiscordKey("discord:g:c:u"), "discord:g:c");
});

test("legacyDiscordKey: already-3-segment guild key has no ancestor", () => {
  assert.equal(legacyDiscordKey("discord:g:c"), null);
});

test("legacyDiscordKey: DM key is not migrated", () => {
  assert.equal(legacyDiscordKey("discord:dm:c"), null);
});

test("legacyDiscordKey: non-discord key returns null", () => {
  assert.equal(legacyDiscordKey("local:user:main"), null);
});

test("legacyDiscordKey: empty / undefined / non-string return null", () => {
  assert.equal(legacyDiscordKey(""), null);
  assert.equal(legacyDiscordKey(undefined), null);
  assert.equal(legacyDiscordKey(null), null);
  assert.equal(legacyDiscordKey(42), null);
});

test("migrateLegacyKey: copies legacy transcript to new key, legacy stays", () => {
  const store = freshStore();
  const legacyId = "discord:g:c";
  const newId = "discord:g:c:u";
  for (let i = 0; i < 3; i++) {
    store.saveSession({ id: legacyId, createdAt: "2026-01-01T00:00:00.000Z", messages: [] });
  }
  // Seed 3 real messages on the legacy key.
  const seeded = { id: legacyId, createdAt: "2026-01-01T00:00:00.000Z", messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" }
  ], metadata: {} };
  store.saveSession(seeded);

  const migrated = store.migrateLegacyKey(newId, legacyId);
  assert.equal(migrated, true, "first migration reports it copied");
  assert.equal(store.getSession(newId).messages.length, 3, "new key has the recovered history");
  assert.equal(store.getSession(newId).createdAt, "2026-01-01T00:00:00.000Z", "createdAt preserved");
  assert.equal(store.getSession(legacyId).messages.length, 3, "legacy file left intact for recovery");
});

test("migrateLegacyKey: second run is a no-op (idempotent, not doubled)", () => {
  const store = freshStore();
  const legacyId = "discord:g:c";
  const newId = "discord:g:c:u";
  store.saveSession({ id: legacyId, createdAt: "2026-01-01T00:00:00.000Z", messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" }
  ], metadata: {} });

  assert.equal(store.migrateLegacyKey(newId, legacyId), true);
  assert.equal(store.migrateLegacyKey(newId, legacyId), false, "second call migrates nothing");
  assert.equal(store.getSession(newId).messages.length, 2, "count stays N, not 2N");
});

test("migrateLegacyKey: never clobbers an existing new-key transcript", () => {
  const store = freshStore();
  const legacyId = "discord:g:c";
  const newId = "discord:g:c:u";
  store.saveSession({ id: legacyId, createdAt: "2026-01-01T00:00:00.000Z", messages: [
    { role: "user", content: "legacy-one" },
    { role: "user", content: "legacy-two" }
  ], metadata: {} });
  store.saveSession({ id: newId, createdAt: "2026-02-01T00:00:00.000Z", messages: [
    { role: "user", content: "new-real" }
  ], metadata: {} });

  assert.equal(store.migrateLegacyKey(newId, legacyId), false, "new history present -> no migration");
  const after = store.getSession(newId);
  assert.equal(after.messages.length, 1, "new-key history untouched");
  assert.equal(after.messages[0].content, "new-real", "not overwritten by legacy content");
});

test("migrateLegacyKey: neither file exists -> false, no crash", () => {
  const store = freshStore();
  assert.equal(store.migrateLegacyKey("discord:g:c:u", "discord:g:c"), false);
});

test("end-to-end: append after migration extends the recovered transcript", async () => {
  const store = freshStore();
  const legacyId = "discord:g:c";
  const newId = "discord:g:c:u";
  store.saveSession({ id: legacyId, createdAt: "2026-01-01T00:00:00.000Z", messages: [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" }
  ], metadata: {} });

  store.migrateLegacyKey(newId, legacyId);
  const session = await store.appendMessage(newId, { role: "assistant", content: "d" });
  assert.equal(session.messages.length, 4, "handleMessage path sees N+1 = recovered history plus new turn");
  assert.equal(session.messages.at(-1).content, "d");
});

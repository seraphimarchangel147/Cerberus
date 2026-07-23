// A transcript append is a read-modify-write of one JSON file. These tests
// force that write to yield so the regression is observable even though the
// production filesystem helpers are normally synchronous.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBackedAgentStore } from "../src/agent-store.js";

class DelayedAgentStore extends FileBackedAgentStore {
  async saveSession(session) {
    await new Promise((resolve) => setImmediate(resolve));
    return super.saveSession(session);
  }
}

test("same-session concurrent appends are serialized and both survive", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-agent-store-race-"));
  const store = new DelayedAgentStore({ dir, ensureDefault: false });

  const first = store.appendMessage("discord:guild:channel", {
    role: "user",
    content: "first"
  });
  const second = store.appendMessage("discord:guild:channel", {
    role: "assistant",
    content: "second"
  });

  assert.equal(typeof first.then, "function", "file-backed callers can await their place in the write chain");
  await Promise.all([first, second]);

  const reloaded = new FileBackedAgentStore({ dir, ensureDefault: false });
  assert.deepEqual(
    reloaded.getSession("discord:guild:channel").messages.map((message) => message.content),
    ["first", "second"],
    "enqueue order remains stable in the persisted transcript"
  );
  assert.equal(store.sessionWriteChains.size, 0, "completed session chains do not leak map entries");
});

test("concurrent frozen metadata initialization persists exactly one value", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-agent-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DelayedAgentStore({ dir, ensureDefault: false });
  let factories = 0;

  const [first, second] = await Promise.all([
    store.ensureSessionMetadata("same", "frozenMemoryV1", () => {
      factories += 1;
      return { text: "first" };
    }),
    store.ensureSessionMetadata("same", "frozenMemoryV1", () => {
      factories += 1;
      return { text: "second" };
    })
  ]);

  assert.equal(factories, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(store.getSession("same").metadata.frozenMemoryV1, first);
});

test("metadata updates share the transcript write chain without losing messages", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-agent-metadata-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DelayedAgentStore({ dir, ensureDefault: false });

  const append = store.appendMessage("same", { role: "user", content: "keep me" });
  const update = store.updateSessionMetadata("same", "backgroundReviewV1", () => ({
    version: 1,
    reviewedMessageCount: 1,
    reviewedLastMessageId: "message-1"
  }));
  await Promise.all([append, update]);

  const session = new FileBackedAgentStore({ dir, ensureDefault: false }).getSession("same");
  assert.deepEqual(session.messages.map((message) => message.content), ["keep me"]);
  assert.equal(session.metadata.backgroundReviewV1.reviewedMessageCount, 1);
  assert.equal(store.sessionWriteChains.size, 0);
});

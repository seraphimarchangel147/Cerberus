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

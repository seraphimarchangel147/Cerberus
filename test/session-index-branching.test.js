import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionIndex } from "../src/session-index.js";

function fixture(t, name) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    `openagi-session-index-branch-${name}-`
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sharedMessage(content = "shared branch evidence") {
  return {
    id: "msg_shared_0001",
    role: "user",
    content,
    createdAt: "2026-07-01T00:00:00.000Z"
  };
}

for (const fallback of [false, true]) {
  const label = fallback ? "jsonl" : "sqlite";
  test(`${label} dedupes by session and message together`, async (t) => {
    const dir = fixture(t, label);
    const index = new SessionIndex({ dir, fallback });
    await index.ready;

    const source = await index.indexMessage(
      "source-session",
      "main",
      sharedMessage()
    );
    const branch = await index.indexMessage(
      "branch-session",
      "main",
      sharedMessage()
    );
    const duplicate = await index.indexMessage(
      "source-session",
      "main",
      sharedMessage()
    );

    assert.equal(source.indexed, 1);
    assert.equal(branch.indexed, 1);
    assert.equal(duplicate.indexed, 0);
    assert.equal(duplicate.deduped, true);
    assert.equal(
      (await index.search("shared branch evidence", {
        sessionId: "source-session"
      })).length,
      1
    );
    assert.equal(
      (await index.search("shared branch evidence", {
        sessionId: "branch-session"
      })).length,
      1
    );
    await index.close();

    if (fallback) {
      const reloaded = new SessionIndex({ dir, fallback: true });
      await reloaded.ready;
      const durableDuplicate = await reloaded.indexMessage(
        "branch-session",
        "main",
        sharedMessage()
      );
      assert.equal(durableDuplicate.indexed, 0);
      assert.equal(durableDuplicate.deduped, true);
      await reloaded.close();
    }
  });
}

test("a failed SQLite rebuild cannot roll back a concurrently requested live row", async (t) => {
  const dir = fixture(t, "sqlite-rebuild-rollback");
  const index = new SessionIndex({ dir, fallback: false });
  await index.ready;
  let livePromise;
  const store = {
    listSessions() {
      queueMicrotask(() => {
        livePromise = index.indexMessage(
          "live-session",
          "main",
          {
            id: "msg_live",
            role: "user",
            content: "live row survives rebuild rollback",
            createdAt: "2026-07-01T00:00:01.000Z"
          }
        );
      });
      return [{ id: "source-session" }, { id: "broken-session" }];
    },
    getSession(id) {
      if (id === "broken-session") throw new Error("broken transcript");
      return {
        id,
        messages: [sharedMessage("rolled back source row")]
      };
    }
  };

  await assert.rejects(
    index.rebuildFromTranscripts(store),
    /broken transcript/u
  );
  await Promise.resolve();
  const live = await livePromise;
  assert.equal(live.indexed, 1);
  assert.equal(
    (await index.search("live row survives", {
      sessionId: "live-session"
    })).length,
    1
  );
  await index.close();
});

for (const fallback of [false, true]) {
  const label = fallback ? "jsonl" : "sqlite";
  test(`${label} rebuild indexes a shared prefix once per session`, async (t) => {
    const dir = fixture(t, `rebuild-${label}`);
    const sessions = new Map([
      ["source-session", {
        id: "source-session",
        messages: [sharedMessage("rebuild shared prefix")]
      }],
      ["branch-session", {
        id: "branch-session",
        messages: [sharedMessage("rebuild shared prefix")]
      }]
    ]);
    const store = {
      listSessions() {
        return [...sessions.keys()].map((id) => ({ id }));
      },
      getSession(id) {
        return sessions.get(id);
      }
    };
    const index = new SessionIndex({ dir, fallback });
    await index.ready;

    const first = await index.rebuildFromTranscripts(store);
    const second = await index.rebuildFromTranscripts(store);
    assert.deepEqual(first, { sessions: 2, indexed: 2 });
    assert.deepEqual(second, { sessions: 2, indexed: 0 });
    assert.equal((await index.stats()).messages, 2);
    await index.close();
  });
}

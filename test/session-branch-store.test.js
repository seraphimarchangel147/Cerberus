import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FileBackedAgentStore,
  InMemoryAgentStore
} from "../src/agent-store.js";

function fixture(t, Store = FileBackedAgentStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-session-branch-"));
  const dir = path.join(root, "agent-host");
  const store = new Store({ dir, ensureDefault: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dir, root, store };
}

function message(id, role, content, projectId = "alpha") {
  return {
    id,
    role,
    content,
    agentId: "main",
    channel: "local",
    from: role === "user" ? "tester" : "openagi",
    createdAt: `2026-07-01T00:00:0${id.at(-1)}.000Z`,
    metadata: { projectId }
  };
}

test("hash-derived paths separate legacy filename collisions", async (t) => {
  const { store } = fixture(t);
  assert.equal(store.legacySessionPath("a:b"), store.legacySessionPath("a_b"));
  assert.notEqual(store.sessionPath("a:b"), store.sessionPath("a_b"));

  await store.appendMessage("a:b", message("msg_1", "user", "colon"));
  await store.appendMessage("a_b", message("msg_2", "user", "underscore"));

  assert.equal(store.getSession("a:b").messages[0].content, "colon");
  assert.equal(store.getSession("a_b").messages[0].content, "underscore");
  assert.deepEqual(
    store.listSessions().map((entry) => entry.id).sort(),
    ["a:b", "a_b"]
  );
});

test("legacy sessions migrate only on an exact stored-id match", (t) => {
  const { store } = fixture(t);
  const legacyId = "legacy:exact";
  const legacyPath = store.legacySessionPath(legacyId);
  const hashedPath = store.sessionPath(legacyId);
  const legacy = {
    id: legacyId,
    projectId: "alpha",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    messages: [message("msg_1", "user", "legacy")],
    metadata: { projectId: "alpha" }
  };
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");

  assert.equal(fs.existsSync(hashedPath), false);
  assert.equal(store.hasSession(legacyId), true);
  assert.equal(fs.existsSync(hashedPath), false, "existence checks remain read-only");
  assert.equal(store.getSession(legacyId).messages[0].content, "legacy");
  assert.equal(fs.existsSync(hashedPath), true);
  assert.equal(store.listSessions().filter((entry) => entry.id === legacyId).length, 1);

  const collidingId = "legacy_exact";
  assert.equal(store.legacySessionPath(collidingId), legacyPath);
  assert.equal(store.hasSession(collidingId), false);
  assert.deepEqual(store.getSession(collidingId).messages, []);
});

test("hash-addressed records fail closed on stored-id disagreement", (t) => {
  const { store } = fixture(t);
  const requestedId = "victim";
  const filePath = store.sessionPath(requestedId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    id: "attacker",
    messages: [message("msg_1", "user", "must not leak")],
    metadata: {}
  }), "utf8");

  assert.throws(
    () => store.hasSession(requestedId),
    (error) => error.code === "SESSION_TRANSCRIPT_ID_MISMATCH"
  );
  assert.throws(
    () => store.getSession(requestedId),
    (error) => error.code === "SESSION_TRANSCRIPT_ID_MISMATCH"
  );
  assert.deepEqual(store.listSessions(), []);
});

for (const [label, Store] of [
  ["memory", InMemoryAgentStore],
  ["file", FileBackedAgentStore]
]) {
  test(`${label} branches copy only the exact prefix with fresh metadata`, async (t) => {
    const { store } = fixture(t, Store);
    const sourceId = `${label}:source`;
    for (const item of [
      message("msg_1", "user", "first"),
      message("msg_2", "assistant", "second"),
      message("msg_3", "tool", "suffix")
    ]) {
      await store.appendMessage(sourceId, item);
    }
    const source = store.getSession(sourceId);
    source.projectId = "alpha";
    source.metadata = {
      projectId: "alpha",
      responsesContinuationV1: { responseId: "private-continuation" },
      "frozenMemoryV1:alpha:main": { text: "source-local" },
      backgroundReviewV1: { reviewedMessageCount: 99 }
    };
    await store.saveSession(source);

    const targetId = `${label}:branch`;
    const branch = await store.createSessionBranch(sourceId, {
      targetSessionId: targetId,
      messageId: "msg_2",
      projectId: "alpha",
      createdAt: "2026-07-02T00:00:00.000Z"
    });
    assert.equal(store.hasSession(targetId), true);
    assert.deepEqual(
      branch.messages.map((item) => item.id),
      ["msg_1", "msg_2"]
    );
    assert.deepEqual(Object.keys(branch.metadata).sort(), [
      "branchV1",
      "projectId"
    ]);
    assert.deepEqual(branch.metadata.branchV1, {
      sourceSessionId: sourceId,
      messageId: "msg_2",
      messageCount: 2,
      createdAt: "2026-07-02T00:00:00.000Z"
    });
    assert.equal(JSON.stringify(branch).includes("private-continuation"), false);
    assert.equal(JSON.stringify(branch).includes("source-local"), false);

    branch.messages[0].content = "caller mutation";
    await store.appendMessage(targetId, message(
      "msg_4",
      "user",
      "branch-only"
    ));
    assert.deepEqual(
      store.getSession(sourceId).messages.map((item) => item.content),
      ["first", "second", "suffix"]
    );
  });
}

test("file branching leaves source transcript bytes unchanged", async (t) => {
  const { store } = fixture(t);
  const sourceId = "source:bytes";
  await store.appendMessage(sourceId, message("msg_1", "user", "first"));
  await store.appendMessage(sourceId, message("msg_2", "assistant", "second"));
  const before = fs.readFileSync(store.sessionPath(sourceId));

  await store.createSessionBranch(sourceId, {
    targetSessionId: "target:bytes",
    messageId: "msg_1",
    projectId: "alpha"
  });

  assert.deepEqual(fs.readFileSync(store.sessionPath(sourceId)), before);
});

test("branch failures are explicit and never overwrite a target", async (t) => {
  const { store } = fixture(t);
  await assert.rejects(
    store.createSessionBranch("missing", {
      targetSessionId: "target",
      messageId: "msg_1"
    }),
    (error) => error.code === "SESSION_NOT_FOUND"
  );

  await store.appendMessage("source", message("msg_1", "user", "source"));
  await store.appendMessage("target", message("msg_9", "user", "keep"));
  await assert.rejects(
    store.createSessionBranch("source", {
      targetSessionId: "target",
      messageId: "msg_1",
      projectId: "alpha"
    }),
    (error) => error.code === "SESSION_BRANCH_TARGET_EXISTS"
  );
  assert.equal(store.getSession("target").messages[0].content, "keep");

  await assert.rejects(
    store.createSessionBranch("source", {
      targetSessionId: "new-target",
      messageId: "msg_absent",
      projectId: "alpha"
    }),
    (error) => error.code === "SESSION_BRANCH_MESSAGE_NOT_FOUND"
  );
  await assert.rejects(
    store.createSessionBranch("source", {
      targetSessionId: "wrong-project",
      messageId: "msg_1",
      projectId: "beta"
    }),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );

  const duplicate = store.getSession("source");
  duplicate.messages.push(structuredClone(duplicate.messages[0]));
  await store.saveSession(duplicate);
  await assert.rejects(
    store.createSessionBranch("source", {
      targetSessionId: "ambiguous",
      messageId: "msg_1",
      projectId: "alpha"
    }),
    (error) => error.code === "SESSION_BRANCH_MESSAGE_AMBIGUOUS"
  );
});

class GatedAgentStore extends FileBackedAgentStore {
  constructor(options) {
    super(options);
    this.gate = null;
  }

  pauseNextSave(sessionId) {
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise((resolve) => {
      release = resolve;
    });
    this.gate = { entered, releasePromise, sessionId };
    return { entered: enteredPromise, release };
  }

  async saveSession(session) {
    if (this.gate?.sessionId === session.id) {
      const gate = this.gate;
      this.gate = null;
      gate.entered();
      await gate.releasePromise;
    }
    return super.saveSession(session);
  }
}

test("branching waits for source writes already queued", async (t) => {
  const { store } = fixture(t, GatedAgentStore);
  await store.appendMessage("source", message("msg_1", "user", "first"));
  const gate = store.pauseNextSave("source");
  const append = store.appendMessage(
    "source",
    message("msg_2", "assistant", "queued")
  );
  await gate.entered;
  const branch = store.createSessionBranch("source", {
    targetSessionId: "branch",
    messageId: "msg_2",
    projectId: "alpha"
  });
  gate.release();

  await append;
  assert.deepEqual(
    (await branch).messages.map((item) => item.id),
    ["msg_1", "msg_2"]
  );
  assert.equal(store.sessionWriteChains.size, 0);
});

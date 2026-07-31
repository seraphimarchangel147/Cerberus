import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJsonLine, writeJsonAtomic } from "../src/file-utils.js";
import { PendingActionStore } from "../src/pending-actions.js";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function actionRecord({
  id = "act_0000000000000001",
  toolName = "safe_tool",
  projectId = "alpha",
  projectRevision = 1
} = {}) {
  return {
    id,
    toolName,
    args: {},
    context: { __projectId: projectId, __projectRevision: projectRevision },
    summary: "Safe action",
    reason: null,
    severity: null,
    approvalIdentity: null,
    argsReplayable: true,
    status: "pending",
    createdAt: "2026-07-24T12:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    decidedBy: null,
    approvedVia: null,
    decider: null,
    deciderDisplayName: null,
    result: null,
    error: null,
    outcome: null
  };
}

test("append failures roll back live transitions and post-write failures reconcile", (t) => {
  const dir = tempDir(t, "openagi-pending-atomic-");
  let appendMode = "normal";
  const appendJournal = (file, event) => {
    if (appendMode === "before") throw new Error("append failed before write");
    appendJsonLine(file, event);
    if (appendMode === "after") throw new Error("append result uncertain");
  };
  const store = new PendingActionStore({
    dir,
    appendJournal,
    snapshotEvery: 100
  });

  appendMode = "before";
  assert.throws(
    () => store.enqueue({ toolName: "safe_tool" }),
    /before write/
  );
  assert.deepEqual(store.list(), []);

  appendMode = "after";
  const action = store.enqueue({ toolName: "safe_tool" });
  assert.equal(store.get(action.id).status, "pending");

  appendMode = "before";
  assert.throws(
    () => store.decide(action.id, {
      decision: "approve",
      decidedBy: "test"
    }),
    /before write/
  );
  assert.equal(store.get(action.id).status, "pending");

  appendMode = "after";
  const approved = store.decide(action.id, {
    decision: "approve",
    decidedBy: "test"
  });
  assert.equal(approved.status, "approved");
  assert.equal(store.get(action.id).completedAt, null);

  appendMode = "before";
  assert.throws(
    () => store.complete(action.id, { result: { changed: true } }),
    /before write/
  );
  assert.equal(store.get(action.id).completedAt, null);

  appendMode = "after";
  const completed = store.complete(action.id, {
    result: { changed: true }
  });
  assert.deepEqual(completed.result, { changed: true });
  assert.ok(completed.completedAt);

  const recovered = new PendingActionStore({ dir });
  assert.deepEqual(recovered.get(action.id).result, { changed: true });
  assert.ok(recovered.get(action.id).completedAt);
});

test("automatic snapshots capture each installed transition before truncation", (t) => {
  const dir = tempDir(t, "openagi-pending-snapshot-order-");
  const writes = [];
  const store = new PendingActionStore({
    dir,
    snapshotEvery: 1,
    writeSnapshot(file, payload) {
      writes.push(structuredClone(payload));
      writeJsonAtomic(file, payload);
    }
  });

  const action = store.enqueue({ toolName: "safe_tool" });
  assert.equal(writes.at(-1).actions[0].status, "pending");
  assert.equal(fs.statSync(path.join(dir, "journal.jsonl")).size, 0);

  store.decide(action.id, { decision: "approve", decidedBy: "test" });
  assert.equal(writes.at(-1).actions[0].status, "approved");
  assert.equal(writes.at(-1).actions[0].completedAt, null);
  assert.equal(fs.statSync(path.join(dir, "journal.jsonl")).size, 0);

  store.complete(action.id, { result: { ok: true } });
  assert.ok(writes.at(-1).actions[0].completedAt);
  assert.deepEqual(writes.at(-1).actions[0].result, { ok: true });
  assert.equal(fs.statSync(path.join(dir, "journal.jsonl")).size, 0);

  const recovered = new PendingActionStore({ dir });
  assert.deepEqual(recovered.get(action.id).result, { ok: true });
});

test("restart reconciliation is atomic across definite and uncertain append failure", (t) => {
  const beforeDir = tempDir(t, "openagi-pending-reconcile-before-");
  const original = new PendingActionStore({ dir: beforeDir });
  const action = original.enqueue({ toolName: "safe_tool" });
  original.decide(action.id, {
    decision: "approve",
    decidedBy: "test"
  });

  assert.throws(
    () => new PendingActionStore({
      dir: beforeDir,
      appendJournal() {
        throw new Error("reconciliation append failed");
      }
    }),
    /reconciliation append failed/
  );
  const reconciled = new PendingActionStore({ dir: beforeDir });
  assert.match(reconciled.get(action.id).error, /side effects are unknown/i);
  assert.ok(reconciled.get(action.id).completedAt);

  const afterDir = tempDir(t, "openagi-pending-reconcile-after-");
  const second = new PendingActionStore({ dir: afterDir });
  const secondAction = second.enqueue({ toolName: "safe_tool" });
  second.decide(secondAction.id, {
    decision: "approve",
    decidedBy: "test"
  });
  const uncertain = new PendingActionStore({
    dir: afterDir,
    appendJournal(file, event) {
      appendJsonLine(file, event);
      throw new Error("fsync result uncertain");
    }
  });
  assert.match(
    uncertain.get(secondAction.id).error,
    /side effects are unknown/i
  );
  assert.ok(uncertain.get(secondAction.id).completedAt);
});

test("persisted identifiers, project scope, context fields, and transitions fail closed", (t) => {
  const dir = tempDir(t, "openagi-pending-hostile-");
  const good = actionRecord();
  fs.writeFileSync(
    path.join(dir, "snapshot.json"),
    `${JSON.stringify({
      version: 1,
      actions: [
        good,
        actionRecord({
          id: "act_ABCDEF0000000001",
          projectId: "alpha"
        }),
        actionRecord({
          id: "act_0000000000000002",
          toolName: "safe_t\u043eol"
        }),
        actionRecord({
          id: "act_0000000000000003",
          projectId: "alph\u0430"
        }),
        {
          ...actionRecord({ id: "act_0000000000000004" }),
          context: {
            __projectId: "alpha",
            projectId: "beta",
            __projectRevision: 1
          }
        },
        {
          ...actionRecord({ id: "act_0000000000000005" }),
          context: {
            __projectId: "alpha",
            __projectRevision: 1,
            __confirmed: true
          }
        }
      ]
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "journal.jsonl"),
    [
      JSON.stringify({
        op: "complete",
        id: good.id,
        completedAt: "2026-07-24T12:01:00.000Z",
        result: { changed: true }
      }),
      JSON.stringify({
        op: "enqueue",
        action: {
          ...good,
          toolName: "replacement_tool"
        }
      }),
      JSON.stringify({
        op: "decide",
        id: good.id,
        status: "denied",
        decidedAt: "2026-07-24T12:02:00.000Z",
        completedAt: "2026-07-24T12:02:00.000Z",
        decidedBy: "hostile",
        error: "x".repeat(1500)
      }),
      JSON.stringify({
        op: "decide",
        id: good.id,
        status: "denied",
        decidedAt: "2026-07-24T12:03:00.000Z",
        completedAt: "2026-07-24T12:03:00.000Z",
        decidedBy: "test",
        error: "safe denial"
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  const recovered = new PendingActionStore({
    dir,
    maxActionBytes: 1024,
    maxEventBytes: 4096
  });
  assert.deepEqual(recovered.list().map((action) => action.id), [good.id]);
  assert.equal(recovered.get(good.id).toolName, "safe_tool");
  assert.equal(recovered.get(good.id).status, "denied");
  assert.equal(recovered.get(good.id).error, "safe denial");

  assert.throws(
    () => recovered.enqueue({ toolName: "safe_t\u043eol" }),
    /ASCII tool name/
  );
  assert.throws(
    () => recovered.enqueue({
      toolName: "safe_tool",
      context: { __projectId: "alpha" }
    }),
    /positive project revision/
  );
  assert.throws(
    () => recovered.enqueue({
      toolName: "safe_tool",
      context: {
        __projectId: "alpha",
        projectId: "beta",
        __projectRevision: 1
      }
    }),
    /project id is invalid/
  );
});

test("oversized decision and completion results truncate the durable record without failing the transition", async (t) => {
  const dir = tempDir(t, "openagi-pending-oversize-");
  const store = new PendingActionStore({ dir, maxActionBytes: 4096 });
  const bigResult = "x".repeat(20000);

  // Path 1: decide() carries the result (auto-approve shape).
  const decided = store.enqueue({ toolName: "safe_tool", summary: "Small action" });
  const waiter = store.waitForDecision(decided.id);
  const approved = store.decide(decided.id, {
    decision: "approve",
    decidedBy: "test",
    result: bigResult
  });
  assert.equal(approved.result, bigResult, "live caller keeps the full result");
  const resolution = await waiter;
  assert.equal(resolution.result, bigResult, "live waiter keeps the full result");
  const persistedDecision = store.get(decided.id);
  assert.match(persistedDecision.result, /truncated at persistence/);
  assert.match(persistedDecision.result, /4096-byte/);
  assert.equal(persistedDecision.status, "approved");

  // Path 2: approve first, then complete() with a big result (manual shape).
  const manual = store.enqueue({ toolName: "safe_tool", summary: "Manual action" });
  store.decide(manual.id, { decision: "approve", decidedBy: "test" });
  const completed = store.complete(manual.id, { result: bigResult });
  assert.equal(completed.result, bigResult, "completion caller keeps the full result");
  assert.match(store.get(manual.id).result, /truncated at persistence/);

  // The bounded records survive a journal/snapshot round-trip.
  const recovered = new PendingActionStore({ dir, maxActionBytes: 4096 });
  assert.match(recovered.get(decided.id).result, /truncated at persistence/);
  assert.match(recovered.get(manual.id).result, /truncated at persistence/);
});

test("small results persist untouched", (t) => {
  const dir = tempDir(t, "openagi-pending-small-");
  const store = new PendingActionStore({ dir, maxActionBytes: 4096 });
  const action = store.enqueue({ toolName: "safe_tool" });
  store.decide(action.id, { decision: "approve", decidedBy: "test", result: "ok" });
  assert.equal(store.get(action.id).result, "ok");
});

test("oversized enqueue arguments still fail closed with byte counts", (t) => {
  const dir = tempDir(t, "openagi-pending-oversize-args-");
  const store = new PendingActionStore({ dir, maxActionBytes: 4096 });
  assert.throws(
    () => store.enqueue({ toolName: "safe_tool", args: { data: "x".repeat(20000) } }),
    /exceeds the persistence size limit \(\d+ serialized bytes > 4096-byte cap\)/
  );
  assert.equal(store.list().length, 0);
});
// Regression: a tool's summarize() interpolates RAW arguments, so a multi-line
// shell command or a diff-shaped reason put \n / \t straight into the derived
// summary/reason. validBoundedString rejects every control character, so the
// action failed persistence validation and the TOOL NEVER RAN — real work died
// on a display-text formatting artifact. Derived text must be flattened, never
// fail the call closed.
test("control characters in derived summary/reason never fail the tool call", (t) => {
  const dir = tempDir(t, "openagi-pending-control-chars-");
  const store = new PendingActionStore({ dir });
  const action = store.enqueue({
    toolName: "code_shell",
    args: { command: "ls -la\ncat foo" },
    summary: "shell: ls -la ~/.openagi\ncat foo\tbar\r",
    reason: "scrutiny verdict 'ask'\n-removed\n+added",
    severity: "medium\n"
  });

  assert.equal(store.list().length, 1);
  assert.doesNotMatch(action.summary, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(action.reason, /[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(action.severity, /[\u0000-\u001f\u007f]/);
  // Content is preserved, only the control characters collapse to spaces.
  assert.match(action.summary, /ls -la ~\/\.openagi cat foo bar/);
  assert.match(action.reason, /scrutiny verdict 'ask' -removed \+added/);
  assert.equal(action.severity, "medium");

  // And it survives a reload — the durable record is what validation rejected.
  const reloaded = new PendingActionStore({ dir });
  assert.equal(reloaded.get(action.id)?.summary, action.summary);
});

test("derived summary/reason are bounded instead of failing validation", (t) => {
  const dir = tempDir(t, "openagi-pending-long-summary-");
  const store = new PendingActionStore({ dir });
  const action = store.enqueue({
    toolName: "code_shell",
    args: {},
    summary: "s".repeat(5000),
    reason: "r".repeat(9000)
  });
  assert.equal(action.summary.length, 1000);
  assert.equal(action.reason.length, 4000);
  assert.equal(store.list().length, 1);
});

test("whitespace-only derived summary falls back instead of failing closed", (t) => {
  const dir = tempDir(t, "openagi-pending-blank-summary-");
  const store = new PendingActionStore({ dir });
  const action = store.enqueue({
    toolName: "code_shell",
    args: {},
    summary: "\n\t  \r",
    reason: "\n"
  });
  assert.equal(action.summary, "Run code_shell");
  assert.equal(action.reason, null);
  assert.equal(store.list().length, 1);
});

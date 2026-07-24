import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PendingActionStore } from "../src/pending-actions.js";
import { SkillReplay } from "../src/skill-replay.js";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function persistedAction({
  id,
  projectId = "default",
  createdAt = "2026-07-24T12:00:00.000Z"
}) {
  return {
    id,
    toolName: "bounded_test_tool",
    args: {},
    context: { __projectId: projectId, __projectRevision: 1 },
    summary: "Bounded test action",
    reason: null,
    severity: null,
    approvalIdentity: null,
    argsReplayable: true,
    status: "pending",
    createdAt,
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

function replayJob({
  id,
  projectId,
  status = "queued",
  createdAt = "2026-07-24T12:00:00.000Z"
}) {
  return {
    id,
    projectId,
    skill: "open-notes",
    steps: [{ open_app: "Notes" }],
    dryRun: false,
    confirm: "first-run",
    createdAt,
    status,
    instanceId: "rpi_previous000000"
  };
}

test("PendingActionStore list/get fail closed across project boundaries", (t) => {
  const store = new PendingActionStore({
    dir: tempDir(t, "openagi-pending-project-")
  });
  const alpha = store.enqueue({
    toolName: "alpha_tool",
    context: { __projectId: "alpha", __projectRevision: 1 }
  });
  const beta = store.enqueue({
    toolName: "beta_tool",
    context: { __projectId: "beta", __projectRevision: 1 }
  });
  const legacyDefault = store.enqueue({
    toolName: "default_tool"
  });

  assert.deepEqual(
    store.list({ projectId: "alpha" }).map((action) => action.id),
    [alpha.id]
  );
  assert.equal(store.get(alpha.id, { projectId: "beta" }), null);
  assert.equal(store.get(beta.id, { projectId: "alpha" }), null);
  assert.equal(store.get(legacyDefault.id, { projectId: "default" })?.id, legacyDefault.id);
  assert.equal(store.get(legacyDefault.id, { projectId: "alpha" }), null);
  assert.equal(store.get(alpha.id)?.id, alpha.id);
});

test("PendingActionStore auto-snapshots and retains every pending action plus recent terminals", (t) => {
  const dir = tempDir(t, "openagi-pending-compact-");
  const options = {
    dir,
    snapshotEvery: 5,
    maxTerminalActions: 1
  };
  const store = new PendingActionStore(options);
  const pending = store.enqueue({
    toolName: "still_pending",
    context: { __projectId: "alpha", __projectRevision: 1 }
  });
  const oldTerminal = store.enqueue({
    toolName: "old_terminal",
    context: { __projectId: "alpha", __projectRevision: 1 }
  });
  store.decide(oldTerminal.id, {
    decision: "deny",
    decidedBy: "test",
    error: "old"
  });
  const recentTerminal = store.enqueue({
    toolName: "recent_terminal",
    context: { __projectId: "alpha", __projectRevision: 1 }
  });
  store.decide(recentTerminal.id, {
    decision: "deny",
    decidedBy: "test",
    error: "recent"
  });

  assert.equal(fs.existsSync(path.join(dir, "snapshot.json")), true);
  assert.equal(fs.statSync(path.join(dir, "journal.jsonl")).size, 0);
  assert.equal(store.get(pending.id)?.status, "pending");
  assert.equal(store.get(oldTerminal.id), null);
  assert.equal(store.get(recentTerminal.id)?.status, "denied");

  const recovered = new PendingActionStore(options);
  assert.deepEqual(
    new Set(recovered.list().map((action) => action.id)),
    new Set([pending.id, recentTerminal.id])
  );
});

test("PendingActionStore bounds and validates snapshot actions and journal events", (t) => {
  const dir = tempDir(t, "openagi-pending-validation-");
  fs.mkdirSync(dir, { recursive: true });
  const good = persistedAction({ id: "act_0000000000000001", projectId: "alpha" });
  const oversized = {
    ...persistedAction({ id: "act_0000000000000002", projectId: "alpha" }),
    args: { payload: "x".repeat(4096) }
  };
  fs.writeFileSync(
    path.join(dir, "snapshot.json"),
    JSON.stringify({
      version: 1,
      writtenAt: "2026-07-24T12:00:00.000Z",
      actions: [
        good,
        { ...good, id: "../escape", status: "owned" },
        oversized
      ]
    })
  );
  const invalidDecision = {
    op: "decide",
    id: good.id,
    status: "approved",
    decidedAt: "not-a-time",
    completedAt: null
  };
  const hugeDecision = {
    op: "decide",
    id: good.id,
    status: "denied",
    decidedAt: "2026-07-24T12:01:00.000Z",
    completedAt: "2026-07-24T12:01:00.000Z",
    padding: "z".repeat(4096)
  };
  fs.writeFileSync(
    path.join(dir, "journal.jsonl"),
    [
      "{malformed",
      JSON.stringify(invalidDecision),
      JSON.stringify(hugeDecision),
      ""
    ].join("\n")
  );

  const recovered = new PendingActionStore({
    dir,
    maxActionBytes: 1024,
    maxEventBytes: 1024,
    maxJournalEvents: 10
  });
  assert.equal(recovered.get(good.id)?.status, "pending");
  assert.equal(recovered.get(oversized.id), null);
  assert.equal(recovered.get("../escape"), null);
  assert.equal(recovered.list().length, 1);

  const oversizedDir = tempDir(t, "openagi-pending-snapshot-limit-");
  fs.writeFileSync(
    path.join(oversizedDir, "snapshot.json"),
    JSON.stringify({
      version: 1,
      actions: [persistedAction({
        id: "act_0000000000000003",
        projectId: "alpha"
      })],
      padding: "x".repeat(4096)
    })
  );
  const bounded = new PendingActionStore({
    dir: oversizedDir,
    maxSnapshotBytes: 512
  });
  assert.deepEqual(bounded.list(), []);
});

test("PendingActionStore journal replay processes only its configured event window", (t) => {
  const dir = tempDir(t, "openagi-pending-journal-window-");
  const events = [];
  for (let index = 0; index < 4; index += 1) {
    events.push(JSON.stringify({
      op: "enqueue",
      action: persistedAction({
        id: `act_000000000000000${index}`,
        createdAt: `2026-07-24T12:00:0${index}.000Z`
      })
    }));
  }
  fs.writeFileSync(path.join(dir, "journal.jsonl"), `${events.join("\n")}\n`);
  const recovered = new PendingActionStore({
    dir,
    maxJournalEvents: 2
  });
  assert.deepEqual(
    recovered.list().map((action) => action.id).sort(),
    ["act_0000000000000002", "act_0000000000000003"]
  );
});

test("SkillReplay terminalizes recovered queued UI work and scopes status by project", (t) => {
  const dataDir = tempDir(t, "openagi-replay-restart-");
  const replayDir = path.join(dataDir, "replay");
  fs.mkdirSync(replayDir, { recursive: true });
  const alphaId = "rep_0000000000000001";
  const betaId = "rep_0000000000000002";
  const completedId = "rep_0000000000000003";
  for (const job of [
    replayJob({ id: alphaId, projectId: "alpha" }),
    replayJob({ id: betaId, projectId: "beta" }),
    replayJob({ id: completedId, projectId: "alpha", status: "completed" })
  ]) {
    fs.writeFileSync(
      path.join(replayDir, `${job.id}.json`),
      JSON.stringify(job)
    );
  }

  const replay = new SkillReplay({
    dataDir,
    instanceId: "rpi_current0000000"
  });
  const alphaInterrupted = replay.list({
    projectId: "alpha",
    status: "interrupted"
  });
  assert.deepEqual(alphaInterrupted.map((job) => job.id), [alphaId]);
  assert.deepEqual(
    replay.list({ projectId: "beta", status: "interrupted" })
      .map((job) => job.id),
    [betaId]
  );
  assert.equal(
    replay.list({ projectId: "alpha", status: "completed" })[0].id,
    completedId
  );
  assert.match(alphaInterrupted[0].error, /uncertain UI side effects were not replayed/i);
  assert.equal(alphaInterrupted[0].recoveredByInstanceId, "rpi_current0000000");
  assert.equal(
    replay.resolveJob(alphaId, { ok: true }, { projectId: "beta" }),
    null
  );
  assert.equal(
    replay.resolveJob(alphaId, { ok: true }, { projectId: "alpha" }).status,
    "interrupted"
  );
});

test("SkillReplay bounds directory reads and ignores malformed or oversized jobs", (t) => {
  const dataDir = tempDir(t, "openagi-replay-bounds-");
  const replayDir = path.join(dataDir, "replay");
  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(
    path.join(replayDir, "rep_0000000000000001.json"),
    JSON.stringify(replayJob({
      id: "rep_0000000000000001",
      projectId: "alpha"
    }))
  );
  fs.writeFileSync(
    path.join(replayDir, "rep_0000000000000002.json"),
    JSON.stringify({
      ...replayJob({
        id: "rep_0000000000000002",
        projectId: "alpha"
      }),
      steps: []
    })
  );
  fs.writeFileSync(
    path.join(replayDir, "rep_0000000000000003.json"),
    JSON.stringify({
      ...replayJob({
        id: "rep_0000000000000003",
        projectId: "alpha"
      }),
      padding: "x".repeat(4096)
    })
  );

  const replay = new SkillReplay({
    dataDir,
    maxReplayFiles: 3,
    maxReplayJobBytes: 1024,
    maxReplayListLimit: 1
  });
  const jobs = replay.list({ projectId: "alpha", limit: 100 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "rep_0000000000000001");
  assert.equal(jobs[0].status, "interrupted");
});

test("SkillReplay validates scope operands and persists terminal timeout state", async (t) => {
  const dataDir = tempDir(t, "openagi-replay-timeout-");
  const replay = new SkillReplay({
    dataDir,
    events: new EventEmitter()
  });

  await assert.rejects(
    replay.run({
      steps: [{ wait: 1 }],
      projectId: "../foreign"
    }),
    /invalid replay project id/i
  );
  await assert.rejects(
    replay.run({ skill: "../foreign-skill", projectId: "alpha" }),
    /invalid replay skill name/i
  );

  const pending = replay.run({
    steps: [{ wait: 1 }],
    projectId: "alpha",
    timeoutMs: 10
  });
  await assert.rejects(pending, /timed out/i);
  const timedOut = replay.list({
    projectId: "alpha",
    status: "timed-out"
  });
  assert.equal(timedOut.length, 1);
  assert.match(timedOut[0].error, /timed out/i);
  assert.equal(
    replay.resolveJob(
      timedOut[0].id,
      { ok: true },
      { projectId: "alpha" }
    ).status,
    "timed-out",
    "a late UI result cannot rewrite a terminal timeout"
  );
});

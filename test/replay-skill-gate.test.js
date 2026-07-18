// test/replay-skill-gate.test.js
// E3: replay_skill (AppleScript/keyboard control of the Mac) must sit behind
// the pending-actions confirmation gate, and the gate must round-trip:
// invoke -> pending action persisted -> approve via endpoint -> handler runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// This file asserts QUEUE semantics (divert -> approve -> run). Pin
// auto-approve off so the suite also passes in the prod-policy lane
// (npm run test:prod-policy, OPENAGI_AUTO_APPROVE=1).
process.env.OPENAGI_AUTO_APPROVE = "0";

function makeRuntime() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-gate-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  return { runtime, dataDir };
}

async function bootApp() {
  const { runtime, dataDir } = makeRuntime();
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  // Stub the Mac-side replayer AFTER boot (the real one must exist at boot
  // for bindEvents); the tool handler reads runtime.skillReplay at call time.
  const replayCalls = [];
  runtime.skillReplay = {
    run: async ({ skill, dryRun }) => {
      replayCalls.push({ skill, dryRun });
      return { jobId: "rep_test", skill, dryRun: Boolean(dryRun), status: "completed" };
    }
  };
  return { runtime, app, base, dataDir, replayCalls };
}

test("replay_skill is registered with needsConfirmation, sideEffects, and a summarize fn", () => {
  const { runtime } = makeRuntime();
  const tool = runtime.tools.get("replay_skill");
  assert.ok(tool, "replay_skill must be registered");
  assert.equal(tool.needsConfirmation, true, "replay_skill must be confirmation-gated");
  assert.equal(tool.sideEffects, true, "replay_skill controls the Mac - side-effecting");
  assert.equal(typeof tool.summarize, "function", "approval cards need a human summary");
  assert.match(tool.summarize({ name: "morning-brief" }), /Replay skill 'morning-brief' on the Mac/);
});

test("gated replay_skill round-trips: invoke -> persisted pending action -> approve endpoint -> stub executes -> result recorded", async () => {
  const { runtime, app, base, dataDir, replayCalls } = await bootApp();

  const diverted = await runtime.tools.invoke(
    "replay_skill",
    { name: "morning-brief" },
    { sessionId: "s1", agentId: "main", channel: "local" }
  );
  assert.equal(diverted.ok, true);
  assert.equal(diverted.result.status, "awaiting_confirmation", "call must divert, not run");
  assert.equal(replayCalls.length, 0, "handler must NOT run before approval");
  const actionId = diverted.result.actionId;

  // Durably persisted (JSONL journal), not just in memory.
  const journal = fs.readFileSync(path.join(dataDir, "pending-actions", "journal.jsonl"), "utf8");
  assert.match(journal, new RegExp(actionId), "enqueue must be journaled to disk");

  // Visible on the existing pending list endpoint.
  const listJson = await (await fetch(`${base}/pending-actions?status=pending`)).json();
  assert.ok(
    listJson.actions.some((a) => a.id === actionId && a.toolName === "replay_skill"),
    "pending action must be listed"
  );

  // Approve via the existing endpoint -> handler executes exactly once.
  const approveRes = await fetch(`${base}/pending-actions/${actionId}/approve`, { method: "POST" });
  const approveJson = await approveRes.json();
  assert.equal(approveRes.status, 200);
  assert.equal(approveJson.ok, true);
  assert.deepEqual(replayCalls, [{ skill: "morning-brief", dryRun: false }], "stubbed replayer runs once on approve");

  // Outcome recorded on the action record.
  const action = runtime.pendingActions.get(actionId);
  assert.equal(action.status, "approved");
  assert.equal(action.result.jobId, "rep_test");
  assert.equal(action.error, null);

  // Journal now also carries the decide entry.
  const journalAfter = fs.readFileSync(path.join(dataDir, "pending-actions", "journal.jsonl"), "utf8");
  assert.match(journalAfter, /"op":"decide"/);
  await app.close?.();
});

test("denied replay_skill never executes", async () => {
  const { runtime, app, base, replayCalls } = await bootApp();
  const diverted = await runtime.tools.invoke("replay_skill", { name: "morning-brief" }, { channel: "local" });
  assert.equal(diverted.result.status, "awaiting_confirmation");
  const denyRes = await fetch(`${base}/pending-actions/${diverted.result.actionId}/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "not now" })
  });
  assert.equal(denyRes.status, 200);
  assert.equal(replayCalls.length, 0, "denied action must never run the handler");
  assert.equal(runtime.pendingActions.get(diverted.result.actionId).status, "denied");
  await app.close?.();
});

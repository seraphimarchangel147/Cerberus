// test/outreach-skill-accept.test.js
// Outreach "accept" on a type:"skill" item must route to the same
// materialization path as POST /proactive/suggestions/:id/accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-skill-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

// Same shape pattern-miner's persistCandidate writes (src/pattern-miner.js:188-201).
function seedCandidate(dataDir, id) {
  const dir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(dir, { recursive: true });
  const candidate = {
    id,
    fingerprint: "slack->linear->xcode",
    proposedAt: new Date().toISOString(),
    sequence: { apps: ["Slack", "Linear", "Xcode"], count: 6, startHour: 9, hourVariance: 0.5, occurrences: [] },
    proposal: {
      pass: false,
      name: "morning-triage",
      description: "Morning triage routine across Slack, Linear and Xcode",
      body: "When this routine kicks off, walk through Slack, Linear and Xcode in order.",
      scheduleHint: null
    },
    judgeBypass: false,
    status: "pending"
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(candidate, null, 2));
  return candidate;
}

function appendSkillItem(runtime, candidateId, title = "morning-triage") {
  return runtime.outreach.append({
    type: "skill",
    sourceRef: { kind: "skill-candidate", id: candidateId },
    title,
    needsDecision: false,
    actions: ["accept", "dismiss"]
  });
}

function act(base, id, action) {
  return fetch(`${base}/outreach/${id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action })
  });
}

test("accept on a skill item materializes SKILL.md and resolves the candidate", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  seedCandidate(dataDir, "sug_test1");
  const item = appendSkillItem(runtime, "sug_test1");
  const res = await act(base, item.id, "accept");
  assert.equal(res.status, 200);
  assert.equal(runtime.outreach.get(item.id).status, "acted");
  const skillPath = path.join(dataDir, "skills", "morning-triage", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), "SKILL.md must be materialized");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "skills-suggested", "sug_test1.json"), "utf8"));
  assert.equal(onDisk.status, "accepted");
  await app.close?.();
});

test("accepting a second item for an already-accepted candidate creates no duplicate skill", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  seedCandidate(dataDir, "sug_test2");
  const a = appendSkillItem(runtime, "sug_test2");
  const b = appendSkillItem(runtime, "sug_test2");
  assert.equal((await act(base, a.id, "accept")).status, 200);
  assert.equal((await act(base, b.id, "accept")).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, "skills", "morning-triage", "SKILL.md")));
  assert.equal(fs.existsSync(path.join(dataDir, "skills", "morning-triage-2")), false, "no duplicate skill dir");
  await app.close?.();
});

test("accept on a skill item whose candidate is gone returns 400 and marks the item error", async () => {
  const { runtime, app, base } = await bootApp();
  const item = appendSkillItem(runtime, "sug_missing", "ghost");
  const res = await act(base, item.id, "accept");
  assert.equal(res.status, 400);
  assert.equal(runtime.outreach.get(item.id).status, "error");
  await app.close?.();
});

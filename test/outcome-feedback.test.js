// B2.1 regression: user feedback must resolve outcomes on the turn it arrives.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, DeterministicModelProvider, OutcomeStore } from "../src/index.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("next user message in the same session resolves the prior turn as user-followup, not system-inferred", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "what is on my calendar today?" });
  const pendingBefore = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply");
  assert.equal(pendingBefore.length, 1, "turn 1 records one pending agent-reply outcome");
  const first = pendingBefore[0];

  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "thanks, perfect!" });

  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.resolved, true, "prior outcome resolves on the followup turn itself");
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.85);
});

test("negative followup tone scores low", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-neg-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "draft a reply to the vendor" });
  const first = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply")[0];
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "wrong, that is broken" });
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.2);
});

test("synthetic autopilot prompts do not count as user followups", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-ap-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  const first = runtime.outcomes.pending().find((o) => o.kind === "autopilot-fire");
  assert.ok(first, "autopilot turn records a pending autopilot-fire outcome");
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  const after = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.notEqual(after.source, "user-followup", "autopilot prompts are synthetic, not user feedback");
});

test("resolveSweep holds fresh cron/autopilot fires open for the followup window", () => {
  const store = new OutcomeStore({ dir: tmpDir("sweep-window-") });
  const o = store.record({ kind: "autopilot-fire", sessionId: "autopilot:agent-pulse", toolCalls: [{ name: "list_tasks", ok: true }] });

  const early = store.resolveSweep();
  assert.equal(early.length, 0, "a fresh fire must stay pending so feedback can land first");
  assert.equal(store.outcomes.get(o.id).resolved, false);

  const late = store.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.equal(late.length, 1, "past the window the sweep still scores productivity");
  assert.equal(late[0].source, "system-inferred");
  assert.equal(store.outcomes.get(o.id).qualityScore, 0.7);
});

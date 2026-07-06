// B2.2: explicit thumbs on outreach items resolve linked outcomes and teach
// suggestion feedback.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-fb-"));
  process.env.OPENAGI_AUTH_TOKEN = "";
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /outreach/:id/feedback down resolves the linked outcome at 0.15 explicit-rating", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({
    type: "draft",
    sourceRef: { kind: "draft", id: "draft_1" },
    title: "Reply to Acme",
    outcomeId: outcome.id,
    actions: ["approve", "edit", "dismiss", "up", "down"]
  });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.qualityScore, 0.15);
  assert.equal(resolved.source, "explicit-rating");
  const updated = runtime.outreach.get(item.id);
  assert.equal(updated.status, "acted");
  assert.equal(updated.decision.action, "down");
  await app.close?.();
});

test("POST /outreach/:id/feedback up with no linked outcome records a fresh explicit-feedback outcome", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "Standalone draft" });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "up" });
  assert.equal(res.status, 200);
  const fresh = runtime.outcomes.recent(10).find((o) => o.kind === "explicit-feedback" && o.refId === item.id);
  assert.ok(fresh, "a fresh outcome must be recorded so the verdict is never dropped");
  assert.equal(fresh.resolved, true);
  assert.equal(fresh.qualityScore, 0.9);
  assert.equal(fresh.source, "explicit-rating");
  await app.close?.();
});

test("POST /outreach/:id/feedback rejects verdicts other than up/down", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "D" });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "meh" });
  assert.equal(res.status, 400);
  assert.equal(runtime.outreach.get(item.id).status, "unseen");
  await app.close?.();
});

test("POST /outreach/:id/feedback is idempotent after the item is resolved", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "draft", title: "Once" });
  await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  const res2 = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "up" });
  assert.equal(res2.status, 200);
  assert.equal(runtime.outreach.get(item.id).decision.action, "down");
  const feedbackOutcomes = runtime.outcomes.recent(10).filter((o) => o.kind === "explicit-feedback" && o.refId === item.id);
  assert.equal(feedbackOutcomes.length, 1, "second POST must not record another outcome");
  await app.close?.();
});

test("thumbs on a suggestion item teaches SuggestionFeedback via the observer store", async () => {
  const { runtime, app, base, dataDir } = await bootApp();
  const suggestDir = path.join(dataDir, "proactive", "suggestions");
  fs.mkdirSync(suggestDir, { recursive: true });
  fs.writeFileSync(path.join(suggestDir, "prop_fb1.json"), JSON.stringify({
    id: "prop_fb1",
    proposedAt: new Date().toISOString(),
    status: "pending",
    category: "automation",
    title: "Automate the weekly export"
  }));
  const item = runtime.outreach.append({
    type: "suggestion",
    sourceRef: { kind: "suggestion", id: "prop_fb1" },
    title: "Automate the weekly export",
    actions: ["accept", "dismiss", "up", "down"]
  });
  const res = await postJson(`${base}/outreach/${item.id}/feedback`, { verdict: "down" });
  assert.equal(res.status, 200);
  const rejected = runtime.proactiveObserver.list({ status: "rejected" });
  assert.ok(rejected.some((c) => c.id === "prop_fb1"), "thumbs-down must mark the suggestion rejected");
  await app.close?.();
});

test("POST /outreach/:id/act with action up routes to feedback", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({ type: "draft", title: "Via act", outcomeId: outcome.id });
  const res = await postJson(`${base}/outreach/${item.id}/act`, { action: "up" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.qualityScore, 0.9);
  assert.equal(resolved.source, "explicit-rating");
  assert.equal(runtime.outreach.get(item.id).status, "acted");
  await app.close?.();
});

test("POST /outreach/:id/reply tone-resolves the linked outcome as user-followup", async () => {
  const { runtime, app, base } = await bootApp();
  const outcome = runtime.outcomes.record({ kind: "autopilot-fire", toolCalls: [{ name: "save_draft", ok: true }] });
  const item = runtime.outreach.append({ type: "draft", title: "Draft ready", outcomeId: outcome.id });
  const fakeChannels = { handleLocalMessage: async () => ({ reply: "ok" }) };
  app.__setChannels(fakeChannels);
  const res = await postJson(`${base}/outreach/${item.id}/reply`, { text: "thanks, that was perfect" });
  assert.equal(res.status, 200);
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === outcome.id);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.85);
  await app.close?.();
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  createDurableRuntime,
  createHostedInterface
} from "../src/index.js";
import { loadSkillRevisions } from "../src/skill-revisions.js";

function seedCandidate(dataDir, id, options = {}) {
  const dir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(dir, { recursive: true });
  const candidate = {
    id,
    fingerprint: `${id}-fingerprint`,
    proposedAt: "2026-07-27T12:00:00.000Z",
    status: "pending",
    sequence: {
      apps: ["Calendar", "Linear", "Slack"],
      count: options.count ?? 7,
      confidence: options.confidence ?? 0.93,
      startHour: 9
    },
    proposal: {
      pass: false,
      name: options.name ?? "morning-triage",
      description: options.description ?? "Review the morning work queues.",
      body: options.body ?? "1. Review Calendar.\n2. Review Linear.\n3. Review Slack.",
      scheduleHint: null
    }
  };
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(candidate, null, 2)}\n`);
  return { candidate, filePath };
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined
      ? undefined
      : { "content-type": "application/json" },
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // HTML callers inspect text directly.
  }
  return { response, text, json };
}

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-"));
  const oldAuth = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "skill-review-test-token";
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0
  });
  const listening = await app.listen();
  const base = listening.url ?? `http://127.0.0.1:${listening.port}`;
  t.after(async () => {
    await app.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (oldAuth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = oldAuth;
  });
  return { app, base, dataDir, runtime };
}

test("owner can defer, resurface, edit, and materialize a mined skill", async (t) => {
  const { base, dataDir } = await createHarness(t);
  const { filePath } = seedCandidate(dataDir, "sug_owner_review");

  const pendingBefore = await request(
    base,
    "/proactive/suggestions?status=pending"
  );
  assert.equal(pendingBefore.response.status, 200);
  assert.ok(pendingBefore.json.some((item) => item.id === "sug_owner_review"));

  const deferred = await request(
    base,
    "/proactive/suggestions/sug_owner_review/defer",
    { method: "POST", body: {} }
  );
  assert.equal(deferred.response.status, 200);
  assert.equal(deferred.json.status, "deferred");
  assert.ok(deferred.json.deferredAt);

  const pendingAfter = await request(
    base,
    "/proactive/suggestions?status=pending"
  );
  assert.equal(
    pendingAfter.json.some((item) => item.id === "sug_owner_review"),
    false
  );
  const deferredList = await request(
    base,
    "/proactive/suggestions?status=deferred"
  );
  assert.ok(deferredList.json.some((item) => item.id === "sug_owner_review"));

  const edited = await request(
    base,
    "/proactive/suggestions/sug_owner_review/edit",
    {
      method: "POST",
      body: {
        name: "owner-refined-triage",
        body: "1. Use the owner-refined checklist.\n2. Verify every queue."
      }
    }
  );
  assert.equal(edited.response.status, 200);
  assert.equal(edited.json.status, "edited");
  assert.equal(edited.json.editedByOwner, true);
  assert.equal(edited.json.skillSlug, "owner-refined-triage");

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.status, "edited");
  assert.equal(persisted.editedByOwner, true);
  assert.equal(persisted.proposal.name, "owner-refined-triage");
  assert.match(persisted.proposal.body, /owner-refined checklist/u);

  const skillPath = path.join(
    dataDir,
    "skills",
    "owner-refined-triage",
    "SKILL.md"
  );
  const document = fs.readFileSync(skillPath, "utf8");
  assert.match(document, /editedByOwner: true/u);
  assert.match(document, /owner-refined checklist/u);
  const revisions = loadSkillRevisions(path.dirname(skillPath));
  assert.equal(revisions.at(-1).action, "materialized");
  assert.equal(revisions.at(-1).metadata.editedByOwner, true);
});

test("invalid owner edits fail closed and leave the candidate pending", async (t) => {
  const { base, dataDir } = await createHarness(t);
  const { filePath } = seedCandidate(dataDir, "sug_invalid_edit");
  const result = await request(
    base,
    "/proactive/suggestions/sug_invalid_edit/edit",
    {
      method: "POST",
      body: { name: "still-valid", body: "   " }
    }
  );
  assert.equal(result.response.status, 400);
  assert.match(result.json.error, /body is required/u);
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.editedByOwner, undefined);
});

test("legacy pattern accept is revisioned through the shared materializer", async (t) => {
  const { base, dataDir } = await createHarness(t);
  const { filePath } = seedCandidate(dataDir, "sug_legacy_accept", {
    name: "legacy-reviewed-skill"
  });
  const result = await request(
    base,
    "/skills/suggested/sug_legacy_accept/accept",
    { method: "POST", body: {} }
  );
  assert.equal(result.response.status, 200);
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.status, "accepted");
  const skillDir = path.join(dataDir, "skills", "legacy-reviewed-skill");
  assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
  assert.equal(loadSkillRevisions(skillDir).at(-1).action, "materialized");
});

test("served dashboard exposes all review controls and proposal events", async (t) => {
  const { base } = await createHarness(t);
  const dashboard = await request(base, "/");
  assert.equal(dashboard.response.status, 200);
  assert.match(dashboard.text, /Edit & Accept/u);
  assert.match(dashboard.text, /data-action="defer"/u);
  assert.match(dashboard.text, /suggestionQueueToggle/u);
  assert.match(dashboard.text, /skill-candidate-proposed/u);
  const scripts = [...dashboard.text.matchAll(
    /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu
  )].map((match) => match[1]).filter(Boolean);
  assert.ok(scripts.length > 0, "dashboard contains an inline application script");
  for (const source of scripts) {
    assert.doesNotThrow(() => new vm.Script(source));
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  autoMaterializeCandidates,
  improveSkills,
  resolveAutoCreationLimit
} from "../src/skill-autocurator.js";
import { loadSkillRevisions } from "../src/skill-revisions.js";
import {
  collectCronReferencedSkills,
  SkillRegistry
} from "../src/skills.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function createHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-auto-"));
  const dataDir = path.join(root, "data");
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "skills");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  const emitted = [];
  const warnings = [];
  const runtime = {
    dataDir,
    tools: null,
    outcomes: null,
    cron: options.cron ?? { listJobs: () => [] },
    budget: options.budget ?? { check() {} },
    agentHost: options.provider
      ? { modelProvider: options.provider }
      : null,
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
      }
    }
  };
  runtime.skills = new SkillRegistry({
    runtime,
    dirs: [bundled, user],
    dataDir,
    autoLoad: false,
    warn: (message) => warnings.push(message)
  });
  runtime.skills.reload();
  return {
    root,
    dataDir,
    bundled,
    user,
    runtime,
    emitted,
    warnings
  };
}

function writeSkill(root, name, options = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fields = [
    `name: ${name}`,
    `description: "${options.description ?? name}"`,
    options.createdBy ? `createdBy: ${options.createdBy}` : null,
    options.createdAt ? `createdAt: ${options.createdAt}` : null,
    options.state ? `state: ${options.state}` : null,
    options.pinned ? "pinned: true" : null
  ].filter(Boolean);
  const body = options.body ?? "Do old thing.";
  const document = `---\n${fields.join("\n")}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), document);
  return { dir, path: path.join(dir, "SKILL.md"), document };
}

function writeCandidate(dataDir, id, options = {}) {
  const dir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(dir, { recursive: true });
  const candidate = {
    id,
    proposedAt: options.proposedAt ?? "2026-07-27T12:00:00.000Z",
    status: "pending",
    source: "pattern-miner",
    category: "skill",
    sequence: {
      confidence: options.confidence ?? 0.95,
      count: options.count ?? 5
    },
    proposal: {
      name: options.name ?? id.replace(/^sug_/u, "").replaceAll("_", " "),
      description: options.description ?? "A mined workflow.",
      body: options.body === undefined ? "1. Perform the workflow." : options.body,
      scheduleHint: null
    }
  };
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(candidate, null, 2)}\n`);
  return { candidate, filePath };
}

function appendUsage(dataDir, skill, events) {
  const filePath = path.join(dataDir, "skill-usage.jsonl");
  const text = events.map((event) => JSON.stringify({
    skill,
    mode: event.mode ?? "run",
    outcome: event.outcome ?? "ok",
    at: event.at
  })).join("\n");
  fs.appendFileSync(filePath, `${text}\n`);
}

test("auto-materialize accepts a fully gated candidate with auditable lineage", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const { filePath } = writeCandidate(harness.dataDir, "sug_release_check", {
    name: "Release Check"
  });

  const result = autoMaterializeCandidates({
    runtime: harness.runtime,
    now: new Date("2026-07-27T13:00:00.000Z"),
    env: {}
  });

  assert.equal(result.created, 1);
  assert.equal(result.materialized[0].slug, "release-check");
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).status, "accepted");
  const skill = harness.runtime.skills.mustGet("release-check");
  const document = fs.readFileSync(skill.path, "utf8");
  assert.match(document, /createdBy: skill-autocurator/u);
  assert.match(document, /autoAccepted: true/u);
  assert.match(document, /autoAcceptedConfidence: 0.95/u);
  const revisions = loadSkillRevisions(skill.dir);
  assert.equal(revisions.at(-1).by, "skill-autocurator");
  assert.ok(harness.emitted.some((event) => (
    event.name === "skill-autocreated"
    && event.payload.slug === "release-check"
  )));
});

test("auto-materialize leaves every failed gate pending", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "already-active", {
    createdBy: "agent",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
  harness.runtime.skills.reload();
  const candidates = [
    writeCandidate(harness.dataDir, "sug_low_confidence", {
      confidence: 0.79,
      name: "Low Confidence"
    }),
    writeCandidate(harness.dataDir, "sug_low_count", {
      count: 2,
      name: "Low Count"
    }),
    writeCandidate(harness.dataDir, "sug_empty_body", {
      body: "",
      name: "Empty Body"
    }),
    writeCandidate(harness.dataDir, "sug_duplicate", {
      name: "Already Active"
    })
  ];

  const result = autoMaterializeCandidates({
    runtime: harness.runtime,
    now: new Date("2026-07-27T13:00:00.000Z"),
    env: { OPENAGI_SKILL_AUTO_MAX_PER_DAY: "10" }
  });

  assert.equal(result.created, 0);
  assert.deepEqual(
    result.skipped.map((entry) => entry.reason).sort(),
    ["active-skill-exists", "confidence", "empty-body", "occurrences"]
  );
  for (const { filePath } of candidates) {
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).status, "pending");
  }
});

test("daily cap blocks the fourth skill and resets on the next UTC date", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const records = [];
  for (let index = 1; index <= 4; index += 1) {
    records.push(writeCandidate(harness.dataDir, `sug_daily_${index}`, {
      name: `Daily Skill ${index}`,
      proposedAt: `2026-07-27T12:00:0${index}.000Z`
    }));
  }
  const env = { OPENAGI_SKILL_AUTO_MAX_PER_DAY: "3" };

  const first = autoMaterializeCandidates({
    runtime: harness.runtime,
    now: new Date("2026-07-27T23:00:00.000Z"),
    env
  });
  assert.equal(first.created, 3);
  assert.equal(first.skipped.filter((entry) => entry.reason === "daily-cap").length, 1);
  assert.equal(records.filter(({ filePath }) => (
    JSON.parse(fs.readFileSync(filePath, "utf8")).status === "pending"
  )).length, 1);

  const next = autoMaterializeCandidates({
    runtime: harness.runtime,
    now: new Date("2026-07-28T00:01:00.000Z"),
    env
  });
  assert.equal(next.created, 1);
  assert.equal(records.filter(({ filePath }) => (
    JSON.parse(fs.readFileSync(filePath, "utf8")).status === "pending"
  )).length, 0);
});

test("auto-creation cap accepts explicit unlimited literals and rejects zero", () => {
  for (const value of ["off", "none", "unlimited"]) {
    assert.equal(resolveAutoCreationLimit(value), null, value);
  }
  assert.equal(resolveAutoCreationLimit(undefined), 3);
  assert.equal(resolveAutoCreationLimit("7"), 7);
  assert.throws(
    () => resolveAutoCreationLimit(0),
    /OPENAGI_SKILL_AUTO_MAX_PER_DAY.*greater than 0.*use 'off'/u
  );
});

test("an unlimited auto-creation cap does not block a fourth candidate", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  for (let index = 1; index <= 4; index += 1) {
    writeCandidate(harness.dataDir, `sug_unlimited_${index}`, {
      name: `Unlimited Skill ${index}`
    });
  }

  const result = autoMaterializeCandidates({
    runtime: harness.runtime,
    now: new Date("2026-07-27T23:00:00.000Z"),
    env: {
      OPENAGI_SKILL_AUTOCURATE: "on",
      OPENAGI_SKILL_AUTO_MAX_PER_DAY: "off"
    }
  });

  assert.equal(result.created, 4);
  assert.equal(result.remainingToday, null);
  assert.equal(result.skipped.some((entry) => entry.reason === "daily-cap"), false);
});

test("autocurate off preserves the fully manual pending lane", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const { filePath } = writeCandidate(harness.dataDir, "sug_manual_only", {
    name: "Manual Only"
  });
  const result = autoMaterializeCandidates({
    runtime: harness.runtime,
    env: { OPENAGI_SKILL_AUTOCURATE: "off" }
  });
  assert.equal(result.created, 0);
  assert.equal(result.reason, "disabled");
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).status, "pending");
});

test("scope all transitions an old non-agent-created skill", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "human-old", {
    createdBy: "user",
    createdAt: "2020-01-01T00:00:00.000Z"
  });
  harness.runtime.skills.reload();

  const report = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  assert.equal(report.changed, 1);
  assert.equal(harness.runtime.skills.mustGet("human-old").state, "archived");
});

test("first sight seeds missing activity and a later pass archives it", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "no-clock", { createdBy: "user" });
  harness.runtime.skills.reload();

  const first = harness.runtime.skills.curate({
    now: "2026-01-01T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  assert.equal(first.seeded, 1);
  assert.equal(first.changed, 0);
  assert.equal(harness.runtime.skills.mustGet("no-clock").state, "active");

  const second = harness.runtime.skills.curate({
    now: "2026-04-05T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  assert.equal(second.seeded, 0);
  assert.equal(second.changed, 1);
  assert.equal(harness.runtime.skills.mustGet("no-clock").state, "archived");
});

test("never-used grace floor reactivates a prematurely stale young skill", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "young-unused", {
    createdBy: "user",
    createdAt: "2026-07-20T00:00:00.000Z",
    state: "stale"
  });
  harness.runtime.skills.reload();

  const report = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  assert.equal(report.changed, 1);
  assert.equal(harness.runtime.skills.mustGet("young-unused").state, "active");
});

test("all cron jobs protect referenced skills including paused future prompts", (t) => {
  const cron = {
    listJobs: () => [
      {
        id: "future-paused",
        enabled: false,
        nextRunAt: "2099-01-01T00:00:00.000Z",
        task: "prompt",
        input: { prompt: 'Before replying, call use_skill("cron-kept").' }
      },
      {
        id: "structured-paused",
        enabled: false,
        nextRunAt: "2099-02-01T00:00:00.000Z",
        task: "prompt",
        input: {
          toolCall: {
            name: "run_skill",
            arguments: { name: "structured-kept" }
          }
        }
      }
    ]
  };
  const harness = createHarness({ cron });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "cron-kept", {
    createdBy: "user",
    createdAt: "2020-01-01T00:00:00.000Z"
  });
  writeSkill(harness.user, "structured-kept", {
    createdBy: "user",
    createdAt: "2020-01-01T00:00:00.000Z"
  });
  harness.runtime.skills.reload();

  assert.deepEqual(
    [...collectCronReferencedSkills(cron)].sort(),
    ["cron-kept", "structured-kept"]
  );
  const report = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  assert.equal(report.exemptions.cron, 2);
  assert.equal(harness.runtime.skills.mustGet("cron-kept").state, "active");
  assert.equal(harness.runtime.skills.mustGet("structured-kept").state, "active");
});

test("bundled pruning is configurable and skipped counts are explicit", (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.bundled, "bundled-old", {
    createdBy: "agent",
    createdAt: "2020-01-01T00:00:00.000Z"
  });
  harness.runtime.skills.reload();
  const skipped = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: {}
  });
  assert.equal(skipped.skippedBundled, 1);
  assert.equal(harness.runtime.skills.mustGet("bundled-old").state, "active");

  const pruned = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    staleDays: 30,
    archiveDays: 90,
    env: {
      OPENAGI_CURATOR_PRUNE_BUNDLED: "1",
      OPENAGI_CURATOR_SCOPE: "all"
    }
  });
  assert.equal(pruned.changed, 1);
  assert.equal(harness.runtime.skills.mustGet("bundled-old").state, "archived");
});

test("pinned skills are never transitioned or sent for improvement", async (t) => {
  let providerCalls = 0;
  const harness = createHarness({
    provider: {
      async generate() {
        providerCalls += 1;
        return { text: '{"old_string":"old","new_string":"new","reason":"test"}' };
      }
    }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const skill = writeSkill(harness.user, "pinned-old", {
    createdBy: "agent",
    createdAt: "2020-01-01T00:00:00.000Z",
    pinned: true
  });
  appendUsage(harness.dataDir, "pinned-old", Array.from({ length: 6 }, (_, index) => ({
    at: `2026-07-2${index}T00:00:00.000Z`,
    outcome: index === 5 ? "error" : "ok"
  })));
  harness.runtime.skills.reload();
  const before = fs.readFileSync(skill.path);

  const curated = harness.runtime.skills.curate({
    now: "2026-07-27T00:00:00.000Z",
    env: { OPENAGI_CURATOR_SCOPE: "all" }
  });
  const improved = await improveSkills({
    runtime: harness.runtime,
    now: "2026-07-27T01:00:00.000Z",
    env: { OPENAGI_SKILL_IMPROVE_MIN_USES: "1" }
  });
  assert.equal(curated.exemptions.pinned, 1);
  assert.equal(improved.candidates, 0);
  assert.equal(providerCalls, 0);
  assert.deepEqual(fs.readFileSync(skill.path), before);
});

test("failed improvement patch leaves SKILL.md byte-identical and logs the skip", async (t) => {
  let budgetChecks = 0;
  const harness = createHarness({
    budget: { check() { budgetChecks += 1; } },
    provider: {
      async generate() {
        return {
          text: JSON.stringify({
            old_string: "missing text",
            new_string: "replacement",
            reason: "repair failure"
          })
        };
      }
    }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const skill = writeSkill(harness.user, "patch-fails", {
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  appendUsage(harness.dataDir, "patch-fails", [{
    at: "2026-07-26T00:00:00.000Z",
    outcome: "error"
  }]);
  harness.runtime.skills.reload();
  const before = fs.readFileSync(skill.path);

  const result = await improveSkills({
    runtime: harness.runtime,
    now: "2026-07-27T00:00:00.000Z",
    env: {
      OPENAGI_SKILL_IMPROVE_MIN_USES: "5",
      OPENAGI_SKILL_IMPROVE_MAX_PER_RUN: "2"
    }
  });

  assert.equal(result.improved, 0);
  assert.equal(result.attempted, 1);
  assert.equal(budgetChecks, 1);
  assert.deepEqual(fs.readFileSync(skill.path), before);
  const edits = fs.readFileSync(path.join(harness.dataDir, "skill-edits.jsonl"), "utf8");
  assert.match(edits, /"action":"improvement-skipped"/u);
  assert.match(edits, /"by":"skill-autocurator"/u);
});

test("successful improvement uses patchSkill revision history and rolls back", async (t) => {
  let budgetChecks = 0;
  const harness = createHarness({
    budget: { check() { budgetChecks += 1; } },
    provider: {
      async generate() {
        return {
          text: JSON.stringify({
            old_string: "Do old thing.",
            new_string: "Do the verified new thing.",
            reason: "Repeated successful use exposed a clearer step."
          })
        };
      }
    }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const skill = writeSkill(harness.user, "patch-works", {
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  appendUsage(harness.dataDir, "patch-works", Array.from({ length: 5 }, (_, index) => ({
    at: `2026-07-${String(index + 20).padStart(2, "0")}T00:00:00.000Z`
  })));
  harness.runtime.skills.reload();
  const before = fs.readFileSync(skill.path, "utf8");

  const result = await improveSkills({
    runtime: harness.runtime,
    now: "2026-07-27T00:00:00.000Z",
    env: {
      OPENAGI_SKILL_IMPROVE_MIN_USES: "5",
      OPENAGI_SKILL_IMPROVE_MAX_PER_RUN: "1"
    }
  });
  assert.equal(result.improved, 1);
  assert.equal(budgetChecks, 1);
  assert.match(fs.readFileSync(skill.path, "utf8"), /verified new thing/u);
  const revision = loadSkillRevisions(skill.dir).at(-1);
  assert.equal(revision.action, "patched");
  assert.equal(revision.by, "skill-autocurator");

  harness.runtime.skills.rollbackSkillRevision(
    "patch-works",
    revision.id,
    "tester"
  );
  assert.equal(fs.readFileSync(skill.path, "utf8"), before);
});

test("run and view usage records default-compatible ok and error outcomes", async (t) => {
  let fail = false;
  const harness = createHarness({
    provider: {
      async generate() {
        if (fail) throw new Error("execution failed");
        return { text: "done", toolCalls: [] };
      }
    }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  writeSkill(harness.user, "usage-outcomes", {
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  harness.runtime.skills.reload();

  harness.runtime.skills.view("usage-outcomes");
  await harness.runtime.skills.run("usage-outcomes");
  fail = true;
  await assert.rejects(
    harness.runtime.skills.run("usage-outcomes"),
    /execution failed/u
  );

  const rows = fs.readFileSync(
    path.join(harness.dataDir, "skill-usage.jsonl"),
    "utf8"
  ).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map(({ mode, outcome }) => ({ mode, outcome })),
    [
      { mode: "view", outcome: "ok" },
      { mode: "run", outcome: "ok" },
      { mode: "run", outcome: "error" }
    ]
  );
});

test("all autonomous lifecycle environment fields are setup-allowlisted", () => {
  for (const key of [
    "OPENAGI_CURATOR_PRUNE_BUNDLED",
    "OPENAGI_CURATOR_SCOPE",
    "OPENAGI_SKILL_AUTOCURATE",
    "OPENAGI_SKILL_AUTO_CONFIDENCE",
    "OPENAGI_SKILL_AUTO_MIN_OCCURRENCES",
    "OPENAGI_SKILL_AUTO_MAX_PER_DAY",
    "OPENAGI_SKILL_IMPROVE_MIN_USES",
    "OPENAGI_SKILL_IMPROVE_MAX_PER_RUN"
  ]) {
    assert.ok(SETUP_FIELDS.includes(key), key);
  }
});

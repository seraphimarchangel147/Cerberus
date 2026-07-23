import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDailySkillCuratorJob } from "../src/cron-scheduler.js";
import { createDurableRuntime } from "../src/abi-runtime.js";
import {
  SkillRegistry,
  classifySkillAge,
  resolveCuratorThresholds
} from "../src/skills.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-curator-"));
}

function writeSkill(root, name, options = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fields = [
    `name: ${name}`,
    `description: "${name}"`,
    options.createdBy ? `createdBy: ${options.createdBy}` : null,
    options.createdAt ? `createdAt: ${options.createdAt}` : null,
    options.pinned ? "pinned: true" : null,
    options.state ? `state: ${options.state}` : null
  ].filter(Boolean);
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${fields.join("\n")}\n---\n\nKeep this body byte-identical.\n`);
  return dir;
}

test("curator age classifier has exact stale and archive boundaries", () => {
  const classify = (ageDays) => classifySkillAge({ state: "active", ageDays, staleDays: 30, archiveDays: 90 });
  assert.equal(classify(29), "active");
  assert.equal(classify(30), "stale");
  assert.equal(classify(89), "stale");
  assert.equal(classify(90), "archived");
  assert.equal(classifySkillAge({ state: "archived", ageDays: 0, staleDays: 30, archiveDays: 90 }), "archived");
});

test("skill curator ages agent-created skills without deleting and can restore archives", () => {
  const dataDir = makeTmp();
  const bundled = makeTmp();
  const user = makeTmp();
  const skillDir = writeSkill(user, "age-me", {
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  const runtime = { tools: null, outcomes: null, skills: { dirs: [bundled, user] } };
  const registry = new SkillRegistry({ runtime, dirs: [bundled, user], dataDir, autoLoad: false });
  registry.reload();

  const stale = registry.curate({ now: "2026-02-01T00:00:00.000Z", staleDays: 30, archiveDays: 90 });
  assert.equal(stale.changed, 1);
  assert.equal(registry.mustGet("age-me").state, "stale");
  assert.equal(registry.mustGet("age-me").body, "Keep this body byte-identical.");
  assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")), "curation never deletes the skill file");

  const archived = registry.curate({ now: "2026-04-05T00:00:00.000Z", staleDays: 30, archiveDays: 90 });
  assert.equal(archived.changed, 1);
  assert.equal(registry.mustGet("age-me").state, "archived");
  assert.match(fs.readFileSync(archived.reportPath, "utf8"), /age-me \| stale \| archived/);

  registry.restoreSkill("age-me", "tester", new Date("2026-04-05T01:00:00.000Z"));
  assert.equal(registry.mustGet("age-me").state, "active");
  registry.curate({ now: "2026-04-06T00:00:00.000Z", staleDays: 30, archiveDays: 90 });
  assert.equal(registry.mustGet("age-me").state, "active", "restoration resets the age baseline");
});

test("skill curator exempts bundled, pinned, and non-agent skills and honors recent usage", () => {
  const dataDir = makeTmp();
  const bundled = makeTmp();
  const user = makeTmp();
  const bundledDir = writeSkill(bundled, "bundled-old", { createdBy: "agent", createdAt: "2020-01-01T00:00:00.000Z" });
  const pinnedDir = writeSkill(user, "pinned-old", { createdBy: "agent", createdAt: "2020-01-01T00:00:00.000Z", pinned: true });
  writeSkill(user, "human-old", { createdBy: "user", createdAt: "2020-01-01T00:00:00.000Z" });
  writeSkill(user, "recently-used", { createdBy: "agent", createdAt: "2020-01-01T00:00:00.000Z" });
  const bundledBefore = fs.readFileSync(path.join(bundledDir, "SKILL.md"));
  const pinnedBefore = fs.readFileSync(path.join(pinnedDir, "SKILL.md"));
  fs.writeFileSync(
    path.join(dataDir, "skill-usage.jsonl"),
    `${JSON.stringify({ skill: "recently-used", mode: "run", at: "2026-04-04T00:00:00.000Z" })}\n`
  );
  const registry = new SkillRegistry({ dirs: [bundled, user], dataDir, autoLoad: false });
  registry.reload();
  const result = registry.curate({ now: "2026-04-05T00:00:00.000Z", staleDays: 30, archiveDays: 90 });

  assert.equal(result.changed, 0);
  for (const name of ["bundled-old", "pinned-old", "human-old", "recently-used"]) {
    assert.equal(registry.mustGet(name).state, "active", name);
  }
  assert.deepEqual(fs.readFileSync(path.join(bundledDir, "SKILL.md")), bundledBefore);
  assert.deepEqual(fs.readFileSync(path.join(pinnedDir, "SKILL.md")), pinnedBefore);
  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.match(report, /exempt: bundled/);
  assert.match(report, /exempt: pinned/);
});

test("archived skills leave the default model surface but remain restorable", () => {
  const dataDir = makeTmp();
  const bundled = makeTmp();
  const user = makeTmp();
  writeSkill(user, "sleeping", {
    createdBy: "agent",
    createdAt: "2020-01-01T00:00:00.000Z",
    state: "archived"
  });
  const tools = new Map();
  const toolRegistry = {
    tools,
    register(tool) { tools.set(tool.name, tool); },
    unregister(name) { tools.delete(name); }
  };
  const previous = process.env.OPENAGI_SKILLS_AS_TOOLS;
  process.env.OPENAGI_SKILLS_AS_TOOLS = "1";
  try {
    const registry = new SkillRegistry({ dirs: [bundled, user], dataDir, autoLoad: false });
    registry.reload();
    registry.exposeAsTools(toolRegistry);
    assert.ok(!tools.has("skill_sleeping"));
    assert.deepEqual(tools.get("list_skills").handler({}), []);
    assert.equal(tools.get("list_skills").handler({ include_archived: true })[0].state, "archived");
    assert.throws(() => tools.get("use_skill").handler({ name: "sleeping" }), /archived.*restore_skill/);
    assert.ok(tools.has("restore_skill"));
    tools.get("restore_skill").handler({ name: "sleeping" }, { agentId: "tester" });
    assert.equal(registry.mustGet("sleeping").state, "active");
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_SKILLS_AS_TOOLS;
    else process.env.OPENAGI_SKILLS_AS_TOOLS = previous;
  }
});

test("curator thresholds and scheduled job are configurable and wizard-allowlisted", () => {
  assert.deepEqual(resolveCuratorThresholds({
    OPENAGI_CURATOR_STALE_DAYS: "12",
    OPENAGI_CURATOR_ARCHIVE_DAYS: "40"
  }), { staleDays: 12, archiveDays: 40 });
  assert.deepEqual(createDailySkillCuratorJob({ dailyAt: "01:15" }), {
    id: "daily-skill-curator",
    name: "Daily skill curator",
    enabled: true,
    task: "skill-curator",
    dailyAt: "01:15"
  });
  assert.ok(SETUP_FIELDS.includes("OPENAGI_CURATOR_STALE_DAYS"));
  assert.ok(SETUP_FIELDS.includes("OPENAGI_CURATOR_ARCHIVE_DAYS"));
});

test("durable runtime registers and dispatches the curator job", async () => {
  const dataDir = makeTmp();
  const runtime = createDurableRuntime({ dataDir });
  const curatorJobs = runtime.cron.listJobs().filter((job) => job.id === "daily-skill-curator");
  assert.equal(curatorJobs.length, 1);

  const now = new Date("2026-04-05T00:00:00.000Z");
  for (const job of runtime.cron.listJobs()) {
    runtime.cron.updateJob(job.id, {
      enabled: job.id === "daily-skill-curator",
      nextRunAt: job.id === "daily-skill-curator" ? now.toISOString() : "2099-01-01T00:00:00.000Z"
    });
  }
  const results = await runtime.tick(now);
  assert.equal(results.length, 1);
  assert.equal(results[0].job.id, "daily-skill-curator");
  assert.ok(fs.existsSync(path.join(dataDir, "curator", "REPORT.md")));
});

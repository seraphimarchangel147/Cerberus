// Tests for the Hermes-style skill system upgrade: fixed-cost tool
// surface, in-context view with linked files, curation (create / patch /
// edit / pin / delete), usage telemetry, and the edit-history log.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillRegistry, updateFrontmatter } from "../src/skills.js";

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skilltest-"));
}

function writeSkill(dir, name, { description = "test skill", body = "Do the thing.\n\nUser asked: {{input}}", extraFm = "" } = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n${extraFm}---\n\n${body}\n`
  );
  return skillDir;
}

function makeRegistry({ withUser = true } = {}) {
  const bundled = makeTmp();
  const user = withUser ? makeTmp() : null;
  const dataDir = makeTmp();
  const dirs = withUser ? [bundled, user] : [bundled];
  const runtime = { skills: null, tools: null, outcomes: null };
  const reg = new SkillRegistry({ runtime, dirs, dataDir, autoLoad: false });
  runtime.skills = { dirs }; // pickUserSkillsDir reads runtime.skills.dirs
  return { reg, bundled, user, dataDir };
}

test("view() returns body + stats and bumps usage telemetry", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "demo");
  reg.reload();
  const v1 = reg.view("demo");
  assert.equal(v1.name, "demo");
  assert.match(v1.body, /Do the thing/);
  assert.equal(reg.statsFor("demo").views, 1);
  reg.view("demo");
  assert.equal(reg.statsFor("demo").views, 2);
});

test("linked files are scanned and readable; path escapes refused", () => {
  const { reg, user } = makeRegistry();
  const dir = writeSkill(user, "linked");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "api.md"), "# API notes\n");
  reg.reload();
  const v = reg.view("linked");
  assert.deepEqual(v.linkedFiles, [path.join("references", "api.md")]);
  const f = reg.view("linked", "references/api.md");
  assert.match(f.content, /API notes/);
  assert.throws(() => reg.view("linked", "../../../etc/passwd"), /escapes|linked files must live/);
  assert.throws(() => reg.view("linked", "SKILL.md"), /linked files must live/);
});

test("createSkill writes to the user dir and logs the edit", () => {
  const { reg, user } = makeRegistry();
  reg.reload();
  const { slug } = reg.createSkill({ name: "My New Skill", description: "does x", body: "1. step one", category: "testing" });
  assert.equal(slug, "my-new-skill");
  assert.ok(fs.existsSync(path.join(user, slug, "SKILL.md")));
  assert.ok(reg.has(slug));
  const skill = reg.mustGet(slug);
  assert.equal(skill.category, "testing");
  const { edits } = reg.history(slug);
  assert.equal(edits[0].action, "created");
});

test("patchSkill requires a unique match and records history", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "patchme", { body: "step A\nstep B" });
  reg.reload();
  assert.throws(() => reg.patchSkill("patchme", "nonexistent", "x"), /not found/);
  assert.throws(() => reg.patchSkill("patchme", "step", "x"), /matches 2 places/);
  reg.patchSkill("patchme", "step B", "step B improved");
  assert.match(reg.mustGet("patchme").body, /step B improved/);
  const { edits } = reg.history("patchme");
  assert.equal(edits[0].action, "patched");
});

test("editSkill replaces fields, preserves lineage frontmatter", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "editme", { extraFm: "sourceSuggestionId: sug-42\ncreatedBy: proactive-observer\n" });
  reg.reload();
  reg.editSkill("editme", { description: "new desc", body: "brand new body" });
  const s = reg.mustGet("editme");
  assert.equal(s.description, "new desc");
  assert.equal(s.body, "brand new body");
  assert.equal(s.sourceSuggestionId, "sug-42");
  assert.equal(s.createdBy, "proactive-observer");
});

test("pin blocks delete; unpin + delete moves to .trash", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "precious");
  reg.reload();
  reg.setPinned("precious", true);
  assert.equal(reg.mustGet("precious").pinned, true);
  assert.throws(() => reg.deleteSkill("precious"), /pinned/);
  reg.setPinned("precious", false);
  const { trash } = reg.deleteSkill("precious");
  assert.ok(!reg.has("precious"));
  assert.ok(fs.existsSync(path.join(trash, "SKILL.md")));
});

test("bundled skills refuse deletion", () => {
  const { reg, bundled } = makeRegistry();
  writeSkill(bundled, "builtin");
  reg.reload();
  assert.equal(reg.mustGet("builtin").bundled, true);
  assert.throws(() => reg.deleteSkill("builtin"), /bundled/);
});

test("fixed-cost tool surface registers; per-skill tools gated by env", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "toolcheck");
  const tools = new Map();
  const fakeRegistry = {
    tools,
    register(t) { tools.set(t.name, t); },
    unregister(n) { tools.delete(n); }
  };
  delete process.env.OPENAGI_SKILLS_AS_TOOLS;
  reg.reload();
  reg.exposeAsTools(fakeRegistry);
  for (const t of ["list_skills", "use_skill", "run_skill", "create_skill", "edit_skill", "delete_skill", "pin_skill"]) {
    assert.ok(tools.has(t), `expected ${t}`);
  }
  assert.ok(![...tools.keys()].some((n) => n.startsWith("skill_")));
  process.env.OPENAGI_SKILLS_AS_TOOLS = "1";
  reg.exposeAsTools(fakeRegistry);
  assert.ok(tools.has("skill_toolcheck"), "legacy per-skill tool should register when env flag set");
  delete process.env.OPENAGI_SKILLS_AS_TOOLS;
});

test("usage telemetry survives a registry reload (JSONL persistence)", () => {
  const { reg, user, dataDir } = makeRegistry();
  writeSkill(user, "durable");
  reg.reload();
  reg.view("durable");
  reg.view("durable");
  const reg2 = new SkillRegistry({ runtime: { skills: { dirs: reg.dirs } }, dirs: reg.dirs, dataDir, autoLoad: false });
  reg2.reload();
  assert.equal(reg2.statsFor("durable").views, 2);
});

test("updateFrontmatter adds, replaces, and removes keys", () => {
  const text = '---\nname: x\ndescription: "old"\n---\n\nbody here\n';
  const next = updateFrontmatter(text, { description: "new", pinned: true, category: null });
  assert.match(next, /description: "new"/);
  assert.match(next, /pinned: true/);
  assert.ok(!/category/.test(next));
  assert.match(next, /body here/);
  const removed = updateFrontmatter(next, { pinned: null });
  assert.ok(!/pinned/.test(removed));
});

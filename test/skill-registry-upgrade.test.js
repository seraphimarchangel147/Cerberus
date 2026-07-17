// Tests for the Hermes-style skill system upgrade: fixed-cost tool
// surface, in-context view with linked files, curation (create / patch /
// edit / pin / delete), usage telemetry, and the edit-history log.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  MAX_LINKED_FILE_BYTES,
  MAX_SKILL_BODY_BYTES,
  SkillRegistry,
  updateFrontmatter
} from "../src/skills.js";
import { dedupeSlug } from "../src/skill-materialize.js";

const execFileAsync = promisify(execFile);

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

  writeSkill(user, "overlap", { body: "aaa" });
  reg.reload();
  assert.throws(() => reg.patchSkill("overlap", "aa", "x"), /matches 2 places/);
  assert.equal(reg.mustGet("overlap").body, "aaa", "ambiguous overlapping matches leave the file untouched");
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
  reg.editSkill("precious", { body: "Pinned skills stay editable." });
  assert.equal(reg.mustGet("precious").body, "Pinned skills stay editable.");
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

test("a bundled-only registry still refuses deletion", () => {
  const { reg, bundled } = makeRegistry({ withUser: false });
  writeSkill(bundled, "builtin-only");
  reg.reload();
  assert.equal(reg.mustGet("builtin-only").bundled, true);
  assert.throws(() => reg.deleteSkill("builtin-only"), /bundled/);
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

test("linked-file reads reject traversal variants, symlink escapes, non-files, and oversized files", (t) => {
  const { reg, user } = makeRegistry();
  const skillDir = writeSkill(user, "linked-hardening");
  const references = path.join(skillDir, "references");
  const outside = makeTmp();
  const secret = path.join(outside, "secret.txt");
  fs.mkdirSync(references, { recursive: true });
  fs.writeFileSync(path.join(references, "ok.txt"), "safe\n");
  fs.writeFileSync(secret, "outside\n");
  fs.writeFileSync(path.join(references, "huge.txt"), Buffer.alloc(MAX_LINKED_FILE_BYTES + 1, 0x61));

  const symlinkPath = path.join(references, "outside-link");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outside, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    symlinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.diagnostic(`symlink assertion skipped on this host: ${error.code}`);
  }

  reg.reload();
  assert.equal(reg.view("linked-hardening", "references/ok.txt").content, "safe\n");
  assert.throws(() => reg.view("linked-hardening", secret), /absolute|escapes|linked file/i);
  assert.throws(() => reg.view("linked-hardening", "references\\..\\..\\secret.txt"), /escapes|linked files must live|invalid/i);
  assert.throws(() => reg.view("linked-hardening", "references/\0secret.txt"), /invalid|null/i);
  assert.throws(() => reg.view("linked-hardening", "references/\u2024\u2024\u2215secret.txt"), /invalid|linked file/i);
  assert.throws(() => reg.view("linked-hardening", "references"), /regular file/i);
  assert.throws(() => reg.view("linked-hardening", "references/huge.txt"), /too large|exceeds/i);
  if (symlinkCreated) {
    assert.throws(() => reg.view("linked-hardening", "references/outside-link/secret.txt"), /symbolic link|escapes/i);
    assert.ok(!reg.view("linked-hardening").linkedFiles.some((file) => file.includes("outside-link")));
  }
});

test("skill names are strict slugs at load and lookup boundaries", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "valid-skill");
  const invalidNames = [
    "../escape",
    "/tmp/escape",
    "C:\\temp\\escape",
    "bad\\name",
    "bad\0name",
    "safe\u2215escape",
    "Uppercase-Name"
  ];
  invalidNames.forEach((name, index) => {
    const dir = path.join(user, `invalid-meta-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: invalid\n---\n\nnope\n`);
  });

  reg.reload();
  assert.equal(reg.has("valid-skill"), true);
  assert.equal(reg.list().filter((skill) => skill.name !== "valid-skill").length, 0);
  for (const name of invalidNames) {
    assert.equal(reg.has(name), false);
    assert.throws(() => reg.mustGet(name), /valid skill slug|invalid skill name/i);
  }
  assert.throws(() => reg.statsFor("../valid-skill"), /valid skill slug|invalid skill name/i);
  assert.throws(() => reg.history("../valid-skill"), /valid skill slug|invalid skill name/i);
  assert.throws(() => reg.view("missing-skill"), /Unknown skill: missing-skill/);
});

test("createSkill dedupes valid titles and rejects path-like names", () => {
  const { reg, user } = makeRegistry();
  reg.reload();
  const first = reg.createSkill({ name: "Duplicate Skill", body: "first" });
  const second = reg.createSkill({ name: "Duplicate Skill", body: "second" });
  assert.equal(first.slug, "duplicate-skill");
  assert.equal(second.slug, "duplicate-skill-2");
  assert.match(first.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.match(second.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const boundary = reg.createSkill({ name: `${"a".repeat(47)} long suffix`, body: "bounded" });
  assert.equal(boundary.slug, "a".repeat(47), "length truncation cannot leave a trailing hyphen");
  const metadata = reg.createSkill({
    name: "Metadata Safe",
    description: '\"><img src=x onerror=alert(1)>',
    category: "ops\npinned: true",
    createdBy: "dashboard\npinned: true",
    body: "safe"
  });
  const metadataSkill = reg.mustGet(metadata.slug);
  assert.equal(metadataSkill.description, '\"><img src=x onerror=alert(1)>');
  assert.equal(metadataSkill.category, "ops\npinned: true");
  assert.equal(metadataSkill.createdBy, "dashboard\npinned: true");
  assert.equal(metadataSkill.pinned, false, "metadata values cannot inject frontmatter keys");

  for (const name of ["../escape", "/tmp/escape", "C:\\temp\\escape", "bad\\name", "bad\0name", "safe\u2215escape", ".."]) {
    assert.throws(() => reg.createSkill({ name, body: "nope" }), /invalid skill name|path syntax/i, name);
  }
  assert.throws(() => dedupeSlug(user, "../escape"), /invalid skill slug/i);
});

test("empty, malformed, and oversized skills are ignored; mutations enforce the body cap", () => {
  const { reg, user } = makeRegistry();
  fs.mkdirSync(path.join(user, "empty-dir"), { recursive: true });
  const malformedDir = path.join(user, "malformed");
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, "SKILL.md"), "not frontmatter");
  writeSkill(user, "oversized-on-disk", { body: "x".repeat(MAX_SKILL_BODY_BYTES + 1) });
  writeSkill(user, "size-edit", { body: "small body" });
  reg.reload();

  assert.equal(reg.has("empty-dir"), false);
  assert.equal(reg.has("malformed"), false);
  assert.equal(reg.has("oversized-on-disk"), false);
  assert.throws(
    () => reg.createSkill({ name: "oversized-create", body: "x".repeat(MAX_SKILL_BODY_BYTES + 1) }),
    /body.*too large|exceeds/i
  );
  assert.throws(
    () => reg.editSkill("size-edit", { body: "x".repeat(MAX_SKILL_BODY_BYTES + 1) }),
    /body.*too large|exceeds/i
  );
  assert.throws(
    () => reg.patchSkill("size-edit", "small body", "x".repeat(MAX_SKILL_BODY_BYTES + 1)),
    /body.*too large|exceeds/i
  );
  assert.equal(reg.mustGet("size-edit").body, "small body");
});

test("deleteSkill avoids existing .trash destination names", () => {
  const { reg, user } = makeRegistry();
  writeSkill(user, "discard-me");
  reg.reload();
  const fixedNow = 1_700_000_000_000;
  const collision = path.join(user, ".trash", `discard-me-${fixedNow}`);
  fs.mkdirSync(collision, { recursive: true });
  fs.writeFileSync(path.join(collision, "marker"), "keep");

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const result = reg.deleteSkill("discard-me");
    assert.equal(path.basename(result.trash), `discard-me-${fixedNow}-2`);
    assert.equal(fs.readFileSync(path.join(collision, "marker"), "utf8"), "keep");
    assert.ok(fs.existsSync(path.join(result.trash, "SKILL.md")));
  } finally {
    Date.now = originalNow;
  }
});

test("JSONL readers tolerate malformed and non-object records", () => {
  const { reg, user, dataDir } = makeRegistry();
  writeSkill(user, "durable");
  fs.writeFileSync(path.join(dataDir, "skill-usage.jsonl"), [
    JSON.stringify({ skill: "durable", mode: "view", at: "2026-01-01T00:00:00.000Z" }),
    "not-json",
    "null",
    "[]",
    "42",
    JSON.stringify({ skill: "durable", mode: "bogus", at: "later" }),
    '{"skill":"durable"'
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dataDir, "skill-edits.jsonl"), [
    "null",
    '"string"',
    "[]",
    "broken",
    JSON.stringify({ skill: "durable", action: "edited", summary: "safe", at: "2026-01-02T00:00:00.000Z" })
  ].join("\n") + "\n");

  const runtime = { skills: { dirs: reg.dirs }, tools: null, outcomes: null };
  const reloaded = new SkillRegistry({ runtime, dirs: reg.dirs, dataDir, autoLoad: false });
  reloaded.reload();
  assert.deepEqual(reloaded.statsFor("durable"), {
    views: 1,
    runs: 0,
    gradedRuns: 0,
    avgScore: null,
    lastScore: null,
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    recentRuns: []
  });
  assert.deepEqual(reloaded.history("durable").edits.map((edit) => edit.summary), ["safe"]);
  assert.equal(reloaded.history().edits.length, 1);
});

test("concurrent telemetry appends remain complete JSONL records", async () => {
  const dataDir = makeTmp();
  const moduleUrl = new URL("../src/skills.js", import.meta.url).href;
  const childScript = `
    import { SkillRegistry } from ${JSON.stringify(moduleUrl)};
    const registry = new SkillRegistry({ dirs: [], dataDir: process.argv[1], autoLoad: false });
    for (let i = 0; i < Number(process.argv[2]); i += 1) registry.recordUse("concurrent-skill", "view");
  `;
  const workers = 4;
  const perWorker = 25;
  await Promise.all(Array.from({ length: workers }, () => execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", childScript, dataDir, String(perWorker)]
  )));

  const lines = fs.readFileSync(path.join(dataDir, "skill-usage.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, workers * perWorker);
  assert.doesNotThrow(() => lines.forEach((line) => JSON.parse(line)));
  const registry = new SkillRegistry({ dirs: [], dataDir, autoLoad: false });
  assert.equal(registry.statsFor("concurrent-skill").views, workers * perWorker);
});

test("use_skill reports nonexistent and invalid names without changing the tool contract", () => {
  const { reg } = makeRegistry();
  const tools = new Map();
  const fakeRegistry = {
    tools,
    register(tool) { tools.set(tool.name, tool); },
    unregister(name) { tools.delete(name); }
  };
  const previous = process.env.OPENAGI_SKILLS_AS_TOOLS;
  delete process.env.OPENAGI_SKILLS_AS_TOOLS;
  try {
    reg.reload();
    reg.exposeAsTools(fakeRegistry);
    assert.throws(() => tools.get("use_skill").handler({ name: "not-there" }), /Unknown skill: not-there/);
    assert.throws(() => tools.get("use_skill").handler({ name: "../not-there" }), /valid skill slug|invalid skill name/i);
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_SKILLS_AS_TOOLS;
    else process.env.OPENAGI_SKILLS_AS_TOOLS = previous;
  }
});

test("Skills dashboard escapes stored skill strings at every rendering site", () => {
  const source = fs.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshSkills");
  const end = source.indexOf("let selectedMcpName", start);
  assert.ok(start >= 0 && end > start, "Skills dashboard source block is present");
  const skillsUi = source.slice(start, end);
  for (const escaped of [
    '\\${escapeHtml(s.name)}',
    '\\${escapeHtml(s.description ?? "")}',
    '\\${escapeHtml(full.name)}',
    '\\${escapeHtml(full.description ?? "")}',
    '\\${escapeHtml(full.category)}',
    '\\${escapeHtml(full.createdBy)}',
    '\\${escapeHtml(full.sourceSuggestionId)}',
    '\\${escapeHtml(full.body ?? "(body not loaded)")}',
    '\\${escapeHtml(e.action)}',
    '\\${escapeHtml(e.by ?? "?")}',
    '\\${escapeHtml(e.summary)}',
    '\\${escapeHtml(f)}'
  ]) {
    assert.ok(skillsUi.includes(escaped), `expected escaped Skills UI expression: ${escaped}`);
  }
  for (const unsafe of ['\\${s.name}', '\\${s.description}', '\\${full.description}', '\\${e.summary}']) {
    assert.ok(!skillsUi.includes(unsafe), `unexpected raw Skills UI interpolation: ${unsafe}`);
  }
  assert.ok(source.includes("replace(/[&<>\"']/g"), "HTML escaping covers quotes used by text and attributes");
});

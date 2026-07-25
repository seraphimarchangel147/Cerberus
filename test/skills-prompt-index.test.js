// Regression: skills must be VISIBLE to the model, not merely reachable.
//
// Before this, skills existed only behind list_skills — a tool the model had
// to think to call — so hand-authored procedural knowledge went unused. Hermes
// parity is an always-on index in the system prompt plus a mandatory-scan
// directive, and use_skill reachable on the chat lane.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillRegistry } from "../src/skills.js";
import { CHAT_CORE_TOOLS } from "../src/agent-host.js";

function tempSkillDir(skills) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-index-"));
  for (const [name, frontmatter] of Object.entries(skills)) {
    const skillDir = path.join(dir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${frontmatter.description}\n${frontmatter.state ? `state: ${frontmatter.state}\n` : ""}---\n\nBody for ${name}.\n`,
      "utf8"
    );
  }
  return dir;
}

function registryFor(dir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-data-"));
  return new SkillRegistry({ runtime: {}, dirs: [dir], dataDir });
}

test("promptIndex renders a mandatory-scan directive and every active skill", () => {
  const dir = tempSkillDir({
    "deploy-thing": { description: "Roll out new code and restart the daemon." },
    "recap-thing": { description: "Summarize recent activity." }
  });
  const index = registryFor(dir).promptIndex();

  assert.match(index, /## Skills \(mandatory scan\)/);
  assert.match(index, /you MUST load it with use_skill\(name\)/);
  assert.match(index, /- deploy-thing: Roll out new code and restart the daemon\./);
  assert.match(index, /- recap-thing: Summarize recent activity\./);
});

test("promptIndex tells the model to maintain its own library", () => {
  const dir = tempSkillDir({ keeper: { description: "A skill." } });
  const index = registryFor(dir).promptIndex();

  assert.match(index, /patch it immediately with edit_skill/);
  assert.match(index, /delete_skill/);
});

test("promptIndex clips long descriptions instead of flooding the prompt", () => {
  const dir = tempSkillDir({ verbose: { description: "x".repeat(400) } });
  const index = registryFor(dir).promptIndex({ maxDescription: 40 });

  const line = index.split("\n").find((row) => row.startsWith("- verbose:"));
  assert.ok(line, "expected the skill row to render");
  assert.ok(line.length < 80, `row should be clipped, got ${line.length} chars`);
  assert.match(line, /…$/);
});

test("promptIndex is empty when no skills exist, so the prompt stays clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-empty-"));
  assert.equal(registryFor(dir).promptIndex(), "");
});

test("promptIndex caps the number of skills it advertises", () => {
  const many = {};
  for (let i = 0; i < 25; i += 1) many[`skill-${i}`] = { description: `Skill ${i}.` };
  const index = registryFor(tempSkillDir(many)).promptIndex({ maxSkills: 5 });

  const rows = index.split("\n").filter((row) => row.startsWith("- skill-"));
  assert.equal(rows.length, 5);
});

test("use_skill is reachable on the chat lane the directive targets", () => {
  // The mandatory-scan directive names use_skill. If the chat lane strips it,
  // the instruction is unfollowable and the model reports phantom tool loss.
  assert.ok(
    CHAT_CORE_TOOLS.includes("use_skill"),
    "use_skill must be a chat core tool — the skill index instructs the model to call it"
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSkillCorpus,
  evaluateSkillRouting,
  loadRoutingCases,
  loadSkillCatalog,
  parseSkillDescription,
  rankSkillDescriptions,
  tokenizeRoutingText
} from "../scripts/skill-routing-eval.js";
import {
  parseSkillRoutingArgs,
  runSkillRoutingCli
} from "../scripts/run-skill-routing-evals.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_SKILLS = path.join(ROOT, "examples", "skills");
const ROUTING_CASES = path.join(ROOT, "evals", "skill-routing");
const CLI = path.join(ROOT, "scripts", "run-skill-routing-evals.js");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(root, directory, name, description) {
  const dir = path.join(root, directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nTest.\n`
  );
}

test("tokenization is case-insensitive, stop-word filtered, and lightly stemmed", () => {
  assert.deepEqual(
    tokenizeRoutingText("Replies, replying, and MESSAGES message for you."),
    ["reply", "reply", "messag", "messag"]
  );
});

test("skill frontmatter accepts quoted and folded descriptions", () => {
  assert.deepEqual(
    parseSkillDescription([
      "---",
      "name: quoted-skill",
      "description: \"Handle URLs: safely\"",
      "---",
      ""
    ].join("\n")),
    { name: "quoted-skill", description: "Handle URLs: safely" }
  );
  assert.deepEqual(
    parseSkillDescription([
      "---",
      "name: folded-skill",
      "description: >-",
      "  Guide a deployment",
      "  with verification.",
      "---",
      ""
    ].join("\n")),
    { name: "folded-skill", description: "Guide a deployment with verification." }
  );
});

test("catalog loading rejects mismatched directories without hiding valid skills", (t) => {
  const root = tempDir(t, "openagi-skill-routing-catalog-");
  writeSkill(root, "valid-skill", "valid-skill", "Connect remote tool servers");
  writeSkill(root, "wrong-dir", "other-name", "This should be rejected");

  const loaded = loadSkillCatalog(root);
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["valid-skill"]);
  assert.equal(loaded.errors.length, 1);
  assert.equal(loaded.errors[0].code, "skill-parse");
  assert.match(loaded.errors[0].message, /does not match directory/);
});

test("description-only TF-IDF ranks the matching skill deterministically", () => {
  const corpus = buildSkillCorpus([
    { name: "connect-tools", description: "Connect remote protocol tool servers with OAuth" },
    { name: "write-plan", description: "Draft implementation plans with files and verification" },
    { name: "daily-summary", description: "Summarize recent sessions and memory" }
  ]);
  const ranking = rankSkillDescriptions("Authenticate and connect an OAuth tool server", corpus);
  assert.equal(ranking[0].name, "connect-tools");
  assert.ok(ranking[0].score > ranking[1].score);
  assert.deepEqual(ranking.map((entry) => entry.name).sort(), [
    "connect-tools",
    "daily-summary",
    "write-plan"
  ]);
});

test("checked-in skill cases meet the CI rank floor with full coverage", () => {
  const catalog = loadSkillCatalog(EXAMPLE_SKILLS);
  const cases = loadRoutingCases(ROUTING_CASES);
  const report = evaluateSkillRouting({
    skills: catalog.skills,
    cases: cases.cases,
    minRank1: 80,
    preflightIssues: [...catalog.errors, ...cases.errors]
  });

  assert.equal(report.ok, true);
  assert.equal(report.skills, 13);
  assert.equal(report.cases, 13);
  assert.equal(report.checksPassed, 65);
  assert.equal(report.positiveTotal, 39);
  assert.equal(report.rank1, 34);
  assert.ok(report.rank1Percent > 87 && report.rank1Percent < 88);
  assert.deepEqual(report.collisions, []);
});

test("rank-1 ratchet fails above the measured baseline", () => {
  const catalog = loadSkillCatalog(EXAMPLE_SKILLS);
  const cases = loadRoutingCases(ROUTING_CASES);
  const report = evaluateSkillRouting({
    skills: catalog.skills,
    cases: cases.cases,
    minRank1: 90
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((entry) => entry.code === "rank1-floor"));
});

test("identical descriptions are both a collision and an ambiguous rank-1 tie", () => {
  const skills = [
    { name: "alpha-skill", description: "Review code changes for security" },
    { name: "beta-skill", description: "Review code changes for security" }
  ];
  const report = evaluateSkillRouting({
    skills,
    cases: [{
      file: "alpha-skill.json",
      data: {
        skill_name: "alpha-skill",
        trigger: {
          positive: [{ prompt: "Review code for security", top_k: 2 }],
          negative: []
        }
      }
    }]
  });

  assert.equal(report.rank1, 0);
  assert.ok(report.issues.some((entry) => entry.code === "rank-tie"));
  assert.ok(report.issues.some((entry) => entry.code === "description-collision"));
});

test("negative prompts cannot pass vacuously without a matching owner", () => {
  const skills = [
    { name: "alpha-skill", description: "Connect remote tool servers" },
    { name: "beta-skill", description: "Write deployment plans" }
  ];
  const report = evaluateSkillRouting({
    skills,
    cases: [{
      file: "alpha-skill.json",
      data: {
        skill_name: "alpha-skill",
        trigger: {
          positive: [],
          negative: [{
            prompt: "Discuss an unrelated weather forecast",
            owner: "beta-skill"
          }]
        }
      }
    }]
  });

  assert.ok(report.issues.some((entry) => entry.code === "negative-owner"));
});

test("missing case coverage is an error rather than an unattended warning", () => {
  const report = evaluateSkillRouting({
    skills: [
      { name: "alpha-skill", description: "Connect remote tool servers" },
      { name: "beta-skill", description: "Write deployment plans" }
    ],
    cases: []
  });
  assert.equal(report.ok, false);
  assert.equal(
    report.issues.filter((entry) => entry.code === "missing-case").length,
    2
  );
});

test("CLI parser supports explicit paths, inline floors, JSON, and rejects unknown flags", () => {
  const parsed = parseSkillRoutingArgs([
    "--skills-dir", "custom-skills",
    "--cases-dir=custom-cases",
    "--min-rank1=82.5",
    "--json"
  ], ROOT);
  assert.equal(parsed.skillsDir, path.join(ROOT, "custom-skills"));
  assert.equal(parsed.casesDir, path.join(ROOT, "custom-cases"));
  assert.equal(parsed.minRank1, 82.5);
  assert.equal(parsed.json, true);
  assert.throws(
    () => parseSkillRoutingArgs(["--behavioral"], ROOT),
    /Unknown option/
  );
});

test("kill switch no-ops before argument or filesystem processing", () => {
  let output = "";
  const code = runSkillRoutingCli({
    args: ["--unknown", "--skills-dir", "does-not-exist"],
    env: { OPENAGI_SKILL_ROUTING_EVAL: "0" },
    stdout: { write: (value) => { output += value; } },
    stderr: { write: () => assert.fail("disabled eval must not emit stderr") }
  });
  assert.equal(code, 0);
  assert.match(output, /disabled/);
});

test("standalone CLI enforces the green floor and exits nonzero above baseline", () => {
  const green = spawnSync(process.execPath, [CLI, "--min-rank1", "80"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(green.status, 0, green.stderr || green.stdout);
  assert.match(green.stdout, /65 trigger checks passed/);
  assert.match(green.stdout, /rank-1: 87\.2% \(34\/39\)/);

  const red = spawnSync(process.execPath, [CLI, "--min-rank1", "90"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(red.status, 1);
  assert.match(red.stdout, /rank-1 rate 87\.2% is below 90%/);
});

test("CI ratchet and complete upstream MIT notice remain checked in", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "skill-routing-evals.yml"),
    "utf8"
  );
  const notice = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(workflow, /run: node scripts\/run-skill-routing-evals\.js --min-rank1 80/);
  assert.doesNotMatch(workflow, /npm (?:install|ci)/);
  assert.match(notice, /Copyright \(c\) 2025 Addy Osmani/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
  assert.match(notice, /7829ffd90d973b6325f5f12f1b1226dcace74443/);
});

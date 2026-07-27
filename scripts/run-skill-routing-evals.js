#!/usr/bin/env node
// Derived from the deterministic Tier-2 routing eval design in
// addyosmani/agent-skills (MIT, commit 7829ffd). See THIRD_PARTY_NOTICES.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateSkillRouting,
  formatSkillRoutingReport,
  loadRoutingCases,
  loadSkillCatalog,
  skillRoutingEvalEnabled
} from "./skill-routing-eval.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSkillRoutingArgs(args, cwd = process.cwd()) {
  const options = {
    skillsDir: path.join(ROOT, "examples", "skills"),
    casesDir: path.join(ROOT, "evals", "skill-routing"),
    minRank1: 0,
    json: false,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const inline = /^--(skills-dir|cases-dir|min-rank1)=(.*)$/.exec(argument);
    const key = inline?.[1] ?? argument.replace(/^--/, "");
    if (!["skills-dir", "cases-dir", "min-rank1"].includes(key)) {
      throw new Error(`Unknown option "${argument}"`);
    }
    const value = inline ? inline[2] : args[++index];
    if (value === undefined || value === "") throw new Error(`--${key} requires a value`);
    if (key === "skills-dir") options.skillsDir = path.resolve(cwd, value);
    if (key === "cases-dir") options.casesDir = path.resolve(cwd, value);
    if (key === "min-rank1") options.minRank1 = numericFloor(value);
  }
  return options;
}

export function runSkillRoutingCli({
  args = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  if (!skillRoutingEvalEnabled(env)) {
    stdout.write("Skill-routing eval disabled by OPENAGI_SKILL_ROUTING_EVAL=0.\n");
    return 0;
  }
  let options;
  try {
    options = parseSkillRoutingArgs(args, cwd);
  } catch (error) {
    stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const catalog = loadSkillCatalog(options.skillsDir);
  const loadedCases = loadRoutingCases(options.casesDir);
  const report = evaluateSkillRouting({
    skills: catalog.skills,
    cases: loadedCases.cases,
    minRank1: options.minRank1,
    preflightIssues: [...catalog.errors, ...loadedCases.errors]
  });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatSkillRoutingReport(report)}\n`);
  return report.ok ? 0 : 1;
}

function numericFloor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--min-rank1 must be a number between 0 and 100");
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/run-skill-routing-evals.js [options]",
    "",
    "Options:",
    "  --skills-dir PATH   Skill catalog (default: examples/skills)",
    "  --cases-dir PATH    Routing cases (default: evals/skill-routing)",
    "  --min-rank1 PCT     Fail below this unambiguous rank-1 percentage",
    "  --json              Emit the structured report as JSON",
    "  --help              Show this help",
    "",
    "Kill switch: OPENAGI_SKILL_ROUTING_EVAL=0"
  ].join("\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runSkillRoutingCli();
}

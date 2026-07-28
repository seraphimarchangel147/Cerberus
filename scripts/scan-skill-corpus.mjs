// Real-corpus calibration for the skill threat scanner.
//
// Fixture tests prove a rule fires. They cannot tell you whether the rule
// ruins the scanner in practice. This runs the scanner over every SKILL.md on
// the machine — real, mostly-benign skills — and reports the verdict
// distribution and the rules driving it, so false-positive noise is measured
// rather than assumed.
//
// Usage: node scripts/scan-skill-corpus.mjs [rootDir ...]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanSkillPackage } from "../src/skill-threat-scan.js";

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0 ? roots : [os.homedir()];
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", "venv", ".venv", "__pycache__",
  "site-packages", "dist", "build", "target"
]);
const MAX_DEPTH = 8;

function findSkillDirs(root, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    out.push(root);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    findSkillDirs(path.join(root, entry.name), depth + 1, out);
  }
  return out;
}

function loadPackage(dir) {
  const files = [];
  const walk = (current, relBase = "") => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = relBase ? `${relBase}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolute);
        if (stat.size > 2 * 1024 * 1024) continue;
        files.push({ path: relative, content: fs.readFileSync(absolute) });
      } catch {
        // Unreadable file; skip it rather than abort the corpus run.
      }
      if (files.length > 200) return;
    }
  };
  walk(dir);
  return files;
}

function declaredTools(files) {
  const doc = files.find((file) => file.path === "SKILL.md");
  if (!doc) return [];
  const text = doc.content.toString("utf8");
  const match = /^allowed[_-]tools\s*:\s*(.+)$/mu.exec(text);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return match[1].split(/[,\s]+/).filter(Boolean);
  }
}

const dirs = [...new Set(searchRoots.flatMap((root) => findSkillDirs(path.resolve(root))))];
const verdicts = { safe: 0, caution: 0, dangerous: 0 };
const ruleHits = new Map();
const dangerousExamples = [];
let scanned = 0;
const started = Date.now();

for (const dir of dirs) {
  const files = loadPackage(dir);
  if (files.length === 0) continue;
  let scan;
  try {
    scan = scanSkillPackage(files, { allowedTools: declaredTools(files) });
  } catch (error) {
    console.error(`scan failed for ${dir}: ${error.message}`);
    continue;
  }
  scanned += 1;
  verdicts[scan.verdict] += 1;
  const seen = new Set();
  for (const finding of scan.findings) {
    if (seen.has(finding.ruleId)) continue;
    seen.add(finding.ruleId);
    const entry = ruleHits.get(finding.ruleId) ?? { skills: 0, severity: finding.severity };
    entry.skills += 1;
    ruleHits.set(finding.ruleId, entry);
  }
  if (scan.verdict === "dangerous" && dangerousExamples.length < 15) {
    dangerousExamples.push({
      skill: path.basename(dir),
      drivers: scan.findings
        .filter((finding) => finding.severity === "critical")
        .slice(0, 3)
        .map((finding) => `${finding.ruleId}@${finding.path}:${finding.line}`)
    });
  }
}

const elapsed = Date.now() - started;
console.log(`corpus: ${scanned} skills scanned in ${elapsed}ms (${(elapsed / Math.max(scanned, 1)).toFixed(1)}ms each)`);
console.log(`verdicts: safe=${verdicts.safe} caution=${verdicts.caution} dangerous=${verdicts.dangerous}`);
console.log(`clean rate: ${((verdicts.safe / Math.max(scanned, 1)) * 100).toFixed(1)}%`);
console.log("\ntop rules by number of skills hit:");
const ranked = [...ruleHits.entries()].sort((a, b) => b[1].skills - a[1].skills);
for (const [ruleId, entry] of ranked.slice(0, 30)) {
  const pct = ((entry.skills / Math.max(scanned, 1)) * 100).toFixed(1);
  console.log(`  ${String(entry.severity).padEnd(8)} ${ruleId.padEnd(34)} ${String(entry.skills).padStart(4)} skills (${pct}%)`);
}
console.log("\nsample dangerous verdicts:");
for (const example of dangerousExamples) {
  console.log(`  ${example.skill}: ${example.drivers.join(", ")}`);
}

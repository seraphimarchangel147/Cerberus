// Derived from the deterministic Tier-2 routing eval design in
// addyosmani/agent-skills (MIT, commit 7829ffd). See THIRD_PARTY_NOTICES.md.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_COLLISION_WARNING = 0.5;
export const DEFAULT_COLLISION_ERROR = 0.75;
export const MIN_POSITIVE_CASES = 3;
export const MIN_NEGATIVE_CASES = 2;
export const SKILL_ROUTING_EVAL_KILL_SWITCH = "OPENAGI_SKILL_ROUTING_EVAL";

const SCORE_EPSILON = 1e-12;
const MAX_SKILL_EVAL_BYTES = 512 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "before", "by",
  "can", "do", "for", "from", "how", "i", "in", "into", "is", "it",
  "its", "me", "my", "need", "of", "on", "or", "our", "please", "so",
  "that", "the", "them", "this", "to", "use", "want", "we", "when",
  "with", "you", "your"
]);

export function skillRoutingEvalEnabled(env = process.env) {
  return String(env?.[SKILL_ROUTING_EVAL_KILL_SWITCH] ?? "").trim() !== "0";
}

export function tokenizeRoutingText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map(stemToken)
    .filter(Boolean);
}

export function buildSkillCorpus(skills) {
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new TypeError("Skill corpus requires at least one skill");
  }
  const documents = new Map();
  for (const skill of skills) {
    const name = String(skill?.name ?? "").trim();
    const description = String(skill?.description ?? "").trim();
    if (!SKILL_NAME_RE.test(name)) throw new TypeError(`Invalid skill name "${name}"`);
    if (!description) throw new TypeError(`Skill "${name}" has no description`);
    if (documents.has(name)) throw new TypeError(`Duplicate skill name "${name}"`);
    documents.set(name, termFrequency(tokenizeRoutingText(description)));
  }

  const documentFrequency = new Map();
  for (const terms of documents.values()) {
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const count = documents.size;
  const inverseDocumentFrequency = new Map();
  for (const term of documentFrequency.keys()) {
    inverseDocumentFrequency.set(
      term,
      Math.log((count + 1) / (documentFrequency.get(term) + 1)) + 1
    );
  }
  const vectors = new Map();
  for (const [name, terms] of documents) {
    vectors.set(name, weightedVector(terms, inverseDocumentFrequency));
  }
  return Object.freeze({
    names: Object.freeze([...documents.keys()].sort()),
    documents,
    inverseDocumentFrequency,
    vectors
  });
}

export function rankSkillDescriptions(prompt, corpus) {
  const query = weightedVector(
    termFrequency(tokenizeRoutingText(prompt)),
    corpus.inverseDocumentFrequency
  );
  return corpus.names
    .map((name) => ({
      name,
      score: cosineSimilarity(query, corpus.vectors.get(name))
    }))
    .sort((left, right) => (
      right.score - left.score || left.name.localeCompare(right.name)
    ));
}

export function cosineSimilarity(left, right) {
  if (!(left instanceof Map) || !(right instanceof Map)) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const weight of left.values()) leftNorm += weight * weight;
  for (const weight of right.values()) rightNorm += weight * weight;
  if (leftNorm === 0 || rightNorm === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [term, weight] of small) dot += weight * (large.get(term) ?? 0);
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function loadSkillCatalog(skillsDir) {
  const root = path.resolve(skillsDir);
  const skills = [];
  const errors = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      skills,
      errors: [issue("error", "skills-dir", `Cannot read skills directory: ${error.message}`)]
    };
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("SKILL.md is not a regular file");
      if (stat.size > MAX_SKILL_EVAL_BYTES) {
        throw new Error(`SKILL.md exceeds ${MAX_SKILL_EVAL_BYTES} bytes`);
      }
      const parsed = parseSkillDescription(fs.readFileSync(file, "utf8"));
      if (parsed.name !== entry.name) {
        throw new Error(`frontmatter name "${parsed.name}" does not match directory`);
      }
      skills.push({ ...parsed, file });
    } catch (error) {
      errors.push(issue(
        "error",
        "skill-parse",
        `${entry.name}/SKILL.md: ${error.message}`,
        { skill: entry.name }
      ));
    }
  }
  return { skills, errors };
}

export function loadRoutingCases(casesDir) {
  const root = path.resolve(casesDir);
  const cases = [];
  const errors = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      cases,
      errors: [issue("error", "cases-dir", `Cannot read cases directory: ${error.message}`)]
    };
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(root, entry.name);
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_SKILL_EVAL_BYTES) {
        throw new Error(`case file exceeds ${MAX_SKILL_EVAL_BYTES} bytes`);
      }
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      cases.push({ file: entry.name, data });
    } catch (error) {
      errors.push(issue("error", "case-parse", `${entry.name}: ${error.message}`));
    }
  }
  return { cases, errors };
}

export function parseSkillDescription(source) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(source));
  if (!match) throw new Error("complete YAML-style frontmatter is required");
  const lines = match[1].split(/\r?\n/);
  const fields = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trimStart().startsWith("#") || /^\s/.test(raw)) continue;
    const field = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(raw);
    if (!field) throw new Error(`invalid frontmatter line ${index + 1}`);
    const [, key, rawValue] = field;
    if (fields.has(key)) throw new Error(`duplicate frontmatter key "${key}"`);
    if (/^[>|][+-]?$/.test(rawValue)) {
      const continuation = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        continuation.push(lines[index + 1].trim());
        index += 1;
      }
      fields.set(key, rawValue.startsWith(">")
        ? continuation.join(" ").trim()
        : continuation.join("\n").trim());
    } else {
      fields.set(key, parseScalar(rawValue));
    }
  }
  const name = String(fields.get("name") ?? "").trim();
  const description = String(fields.get("description") ?? "").trim();
  if (!SKILL_NAME_RE.test(name)) throw new Error("valid lowercase skill name is required");
  if (!description) throw new Error("non-empty description is required");
  return { name, description };
}

export function evaluateSkillRouting({
  skills,
  cases,
  minRank1 = 0,
  collisionWarning = DEFAULT_COLLISION_WARNING,
  collisionError = DEFAULT_COLLISION_ERROR,
  preflightIssues = []
} = {}) {
  const issues = [...preflightIssues];
  let corpus;
  try {
    corpus = buildSkillCorpus(skills);
  } catch (error) {
    issues.push(issue("error", "corpus", error.message));
    return reportResult({ issues, skills: skills?.length ?? 0 });
  }
  const thresholds = normalizeThresholds({
    minRank1,
    collisionWarning,
    collisionError
  });
  if (thresholds.error) {
    issues.push(issue("error", "threshold", thresholds.error));
    return reportResult({ issues, skills: skills.length });
  }

  const skillNames = new Set(corpus.names);
  const caseBySkill = new Map();
  const seenPrompts = new Map();
  let checksPassed = 0;
  let positiveTotal = 0;
  let rank1 = 0;

  for (const record of cases ?? []) {
    const filename = path.basename(String(record?.file ?? ""));
    const expected = filename.replace(/\.json$/i, "");
    const data = record?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      issues.push(issue("error", "case-schema", `${filename}: root must be an object`));
      continue;
    }
    if (String(data.skill_name ?? "") !== expected) {
      issues.push(issue(
        "error",
        "case-name",
        `${filename}: skill_name must match its filename`
      ));
    }
    if (!skillNames.has(expected)) {
      issues.push(issue("error", "unknown-skill", `${filename}: no matching skill`));
      continue;
    }
    if (caseBySkill.has(expected)) {
      issues.push(issue("error", "duplicate-case", `${expected}: duplicate case file`));
      continue;
    }
    caseBySkill.set(expected, record);
    const positive = Array.isArray(data.trigger?.positive) ? data.trigger.positive : [];
    const negative = Array.isArray(data.trigger?.negative) ? data.trigger.negative : [];
    if (positive.length < MIN_POSITIVE_CASES) {
      issues.push(issue(
        "error",
        "positive-coverage",
        `${expected}: requires at least ${MIN_POSITIVE_CASES} positive prompts`,
        { skill: expected }
      ));
    }
    if (negative.length < MIN_NEGATIVE_CASES) {
      issues.push(issue(
        "error",
        "negative-coverage",
        `${expected}: requires at least ${MIN_NEGATIVE_CASES} negative prompts`,
        { skill: expected }
      ));
    }

    for (const testCase of positive) {
      const prompt = validPrompt(testCase?.prompt);
      const topK = Number(testCase?.top_k ?? 3);
      positiveTotal += 1;
      if (!prompt || !Number.isInteger(topK) || topK < 1 || topK > skills.length) {
        issues.push(issue(
          "error",
          "positive-schema",
          `${expected}: positive prompts need text and a valid top_k`,
          { skill: expected }
        ));
        continue;
      }
      recordPrompt(seenPrompts, prompt, `${expected}:positive`, issues);
      const ranking = rankSkillDescriptions(prompt, corpus);
      const index = ranking.findIndex((entry) => entry.name === expected);
      const hit = ranking[index];
      if (!hit || hit.score <= 0) {
        issues.push(issue(
          "error",
          "positive-no-overlap",
          `${expected}: positive prompt shares no description vocabulary`,
          { skill: expected, prompt }
        ));
        continue;
      }
      if (index >= topK) {
        issues.push(issue(
          "error",
          "positive-rank",
          `${expected}: positive prompt ranked ${index + 1}, requires top ${topK}`,
          { skill: expected, prompt, ranking: compactRanking(ranking) }
        ));
        continue;
      }
      checksPassed += 1;
      if (index === 0 && unambiguousFirst(ranking)) rank1 += 1;
      else if (index === 0) {
        issues.push(issue(
          "warning",
          "rank-tie",
          `${expected}: positive prompt ties another skill at rank 1`,
          { skill: expected, prompt, ranking: compactRanking(ranking) }
        ));
      }
    }

    for (const testCase of negative) {
      const prompt = validPrompt(testCase?.prompt);
      const owner = String(testCase?.owner ?? "").trim();
      if (!prompt || !skillNames.has(owner) || owner === expected) {
        issues.push(issue(
          "error",
          "negative-schema",
          `${expected}: negative prompts require text and a different known owner`,
          { skill: expected }
        ));
        continue;
      }
      recordPrompt(seenPrompts, prompt, `${expected}:negative`, issues);
      const ranking = rankSkillDescriptions(prompt, corpus);
      const self = ranking.find((entry) => entry.name === expected);
      const ownerHit = ranking.find((entry) => entry.name === owner);
      if (
        ranking[0]?.name === expected
        || !ownerHit
        || ownerHit.score <= 0
        || ownerHit.score <= self.score + SCORE_EPSILON
      ) {
        issues.push(issue(
          "error",
          "negative-owner",
          `${expected}: declared owner "${owner}" does not outrank it`,
          { skill: expected, prompt, ranking: compactRanking(ranking) }
        ));
        continue;
      }
      checksPassed += 1;
    }
  }

  for (const name of corpus.names) {
    if (!caseBySkill.has(name)) {
      issues.push(issue(
        "error",
        "missing-case",
        `${name}: missing eval case file`,
        { skill: name }
      ));
    }
  }

  const collisions = [];
  for (let left = 0; left < corpus.names.length; left += 1) {
    for (let right = left + 1; right < corpus.names.length; right += 1) {
      const leftName = corpus.names[left];
      const rightName = corpus.names[right];
      const similarity = cosineSimilarity(
        corpus.vectors.get(leftName),
        corpus.vectors.get(rightName)
      );
      if (similarity < thresholds.collisionWarning) continue;
      const collision = { left: leftName, right: rightName, similarity };
      collisions.push(collision);
      issues.push(issue(
        similarity >= thresholds.collisionError ? "error" : "warning",
        similarity >= thresholds.collisionError ? "description-collision" : "description-overlap",
        `${leftName} and ${rightName} descriptions are ${Math.round(similarity * 100)}% similar`,
        collision
      ));
    }
  }

  const rank1Percent = positiveTotal === 0 ? 0 : (rank1 / positiveTotal) * 100;
  if (rank1Percent + SCORE_EPSILON < thresholds.minRank1) {
    issues.push(issue(
      "error",
      "rank1-floor",
      `rank-1 rate ${formatPercent(rank1Percent)}% is below ${formatPercent(thresholds.minRank1)}%`,
      { actual: rank1Percent, required: thresholds.minRank1 }
    ));
  }
  return reportResult({
    issues,
    skills: skills.length,
    cases: caseBySkill.size,
    checksPassed,
    positiveTotal,
    rank1,
    rank1Percent,
    collisions
  });
}

export function formatSkillRoutingReport(report) {
  const lines = [];
  for (const entry of report.issues) {
    lines.push(`[${entry.level}] ${entry.message}`);
    if (entry.prompt) lines.push(`  prompt: ${entry.prompt}`);
    if (entry.ranking) {
      lines.push(`  top: ${entry.ranking.map(
        (hit) => `${hit.name}=${hit.score.toFixed(3)}`
      ).join(", ")}`);
    }
  }
  lines.push(
    `${report.checksPassed} trigger checks passed; `
    + `${report.errors} error(s), ${report.warnings} warning(s)`
  );
  lines.push(
    `rank-1: ${formatPercent(report.rank1Percent)}% `
    + `(${report.rank1}/${report.positiveTotal}) across `
    + `${report.skills} skill(s), ${report.cases} case file(s)`
  );
  lines.push(report.ok ? "PASSED" : "FAILED");
  return lines.join("\n");
}

function reportResult({
  issues = [],
  skills = 0,
  cases = 0,
  checksPassed = 0,
  positiveTotal = 0,
  rank1 = 0,
  rank1Percent = 0,
  collisions = []
}) {
  const errors = issues.filter((entry) => entry.level === "error").length;
  const warnings = issues.filter((entry) => entry.level === "warning").length;
  return {
    ok: errors === 0,
    skills,
    cases,
    checksPassed,
    positiveTotal,
    rank1,
    rank1Percent,
    collisions,
    errors,
    warnings,
    issues
  };
}

function stemToken(token) {
  let value = token;
  if (value.length > 5 && value.endsWith("ies")) value = `${value.slice(0, -3)}y`;
  else if (value.length > 6 && value.endsWith("ingly")) value = value.slice(0, -5);
  else if (value.length > 5 && value.endsWith("ing")) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith("ed")) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith("es")) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) {
    value = value.slice(0, -1);
  }
  if (
    value.length > 4
    && value.at(-1) === value.at(-2)
    && !/[aeiou]/.test(value.at(-1))
  ) {
    value = value.slice(0, -1);
  }
  if (value.length > 4 && value.endsWith("e")) value = value.slice(0, -1);
  return value;
}

function termFrequency(tokens) {
  const frequencies = new Map();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function weightedVector(frequencies, inverseDocumentFrequency) {
  const vector = new Map();
  for (const [term, frequency] of frequencies) {
    const idf = inverseDocumentFrequency.get(term);
    if (!idf) continue;
    vector.set(term, (1 + Math.log(frequency)) * idf);
  }
  return vector;
}

function parseScalar(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.startsWith("\"")) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      throw new Error("invalid quoted frontmatter scalar");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function validPrompt(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordPrompt(seen, prompt, owner, issues) {
  const key = prompt.toLowerCase().replace(/\s+/g, " ");
  const previous = seen.get(key);
  if (previous) {
    issues.push(issue(
      "error",
      "duplicate-prompt",
      `${owner}: prompt duplicates ${previous}`,
      { prompt }
    ));
  } else {
    seen.set(key, owner);
  }
}

function unambiguousFirst(ranking) {
  return ranking[0]?.score > 0
    && (ranking.length < 2 || ranking[0].score > ranking[1].score + SCORE_EPSILON);
}

function compactRanking(ranking) {
  return ranking.slice(0, 3).map(({ name, score }) => ({ name, score }));
}

function normalizeThresholds({ minRank1, collisionWarning, collisionError }) {
  const rank = Number(minRank1);
  const warning = Number(collisionWarning);
  const error = Number(collisionError);
  if (!Number.isFinite(rank) || rank < 0 || rank > 100) {
    return { error: "minRank1 must be between 0 and 100" };
  }
  if (
    !Number.isFinite(warning)
    || !Number.isFinite(error)
    || warning < 0
    || error > 1
    || warning >= error
  ) {
    return { error: "collision thresholds must satisfy 0 <= warning < error <= 1" };
  }
  return { minRank1: rank, collisionWarning: warning, collisionError: error };
}

function issue(level, code, message, detail = {}) {
  return { level, code, message, ...detail };
}

function formatPercent(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

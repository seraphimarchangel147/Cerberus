import { clamp, tokenize, tokenOverlapScore } from "./utils.js";

// C2: measured scrutiny axes. Deterministic per-signal heuristics computed
// from the message text plus stores the runtime already maintains — the
// vector store (distilled principles), tiered memory, and outcome history.
// No LLM calls; every fallback path is deterministic so tests can assert
// exact values. Replaces the hardcoded constants in
// agent-host.messageToSignal (specificity 0.65, confidence 0.7, risk
// 0.35/0.75 keyword flip, ...) that left the scrutiny fitter training on
// near-constant inputs.

// Keyword baselines kept verbatim from the previous messageToSignal
// heuristic — they remain the fallback when no store is available and the
// floor for axes where declared intent ("every tuesday") outranks history.
export const REMEMBER_RE = /\bremember\b|\bsave\b|\bdon't forget\b/;
export const SCHEDULE_RE = /\bevery\b|\bdaily\b|\bweekly\b|\btomorrow\b|\bremind\b|\bschedule\b/;
export const SPECIALIZE_RE = /\bagent\b|\bspecialist\b|\bsub-?agent\b|\bdo this often\b|\bautomate\b/;
export const RISK_KEYWORDS_RE = /\bdelete\b|\bdeploy\b|\bpayment\b|\bproduction\b|\blegal\b|\bmedical\b|\bsecurity\b/;

// Verbs naming side-effecting tools in src/tool-registry.js (every tool that
// does NOT declare sideEffects: false): send_message, schedule_message,
// replay_skill, run_skill, register_mcp_server, connect_mcp_server,
// connect_catalog_mcp, disconnect_mcp_server, cancel_cron_job,
// restart_daemon, retire_specialist. Naming one of these actions bumps risk.
export const SIDE_EFFECT_VERBS_RE = /\bsend\b|\bschedule\b|\breplay\b|\brestart\b|\bretire\b|\bcancel\b|\bconnect\b|\bdisconnect\b|\bregister\b/;

// Specificity signals. URL_RE is applied first and URLs are stripped before
// path/number matching so one URL is not double-counted as a path.
export const NUMBER_RE = /\b\d[\d,.:]*\b/g;
export const URL_RE = /https?:\/\/[^\s)]+/gi;
export const PATH_RE = /(?:~?\/[\w.-]+(?:\/[\w.-]+)+)|\b[\w-]+\.(?:js|jsx|ts|tsx|py|md|json|swift|sh|yml|yaml|txt|html|css|sql|pdf|csv)\b/g;

// Function/structure words excluded from the content-word set. Schedule
// scaffolding ("every", "remind") is deliberately included so repetition
// matching compares WHAT repeats, not the ask-to-repeat phrasing.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "but", "not",
  "you", "your", "our", "his", "her", "its", "their", "them", "they", "this",
  "that", "these", "those", "with", "from", "into", "onto", "over", "under",
  "out", "off", "have", "has", "had", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "does", "did", "doing", "done",
  "what", "which", "who", "whom", "when", "where", "why", "how", "there",
  "here", "then", "than", "too", "very", "just", "also", "about", "please",
  "need", "want", "get", "got", "let", "make", "made", "some", "any", "all",
  "every", "daily", "weekly", "tomorrow", "today", "remind", "reminder",
  "schedule", "each", "per", "yet", "now", "don", "dont"
]);

// Specialization trigger words carry no scope information — every candidate
// message contains one, so they would dominate every derived scope.
const SCOPE_NOISE = new Set(["agent", "specialist", "sub-agent", "subagent", "automate", "often"]);

export function contentWords(text) {
  return tokenize(text).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

// Capitalized words that are not at a sentence start read as proper nouns.
export function countProperNouns(text) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  let count = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (/[.!?]$/.test(words[i - 1])) continue; // sentence start, not a proper-noun cue
    if (/^[A-Z][a-z]{2,}/.test(words[i])) count += 1;
  }
  return count;
}

// 0.2..0.95. Baseline 0.3 for plain prose; numbers, file paths, URLs, and
// proper nouns each raise it. Deterministic, text-only.
export function measureSpecificity(text) {
  const raw = String(text ?? "");
  const urls = (raw.match(URL_RE) ?? []).length;
  const withoutUrls = raw.replace(URL_RE, " ");
  const numbers = (withoutUrls.match(NUMBER_RE) ?? []).length;
  const paths = (withoutUrls.match(PATH_RE) ?? []).length;
  const properNouns = countProperNouns(withoutUrls);
  return clamp(0.3 + numbers * 0.08 + paths * 0.15 + urls * 0.15 + properNouns * 0.06, 0.2, 0.95);
}

// Bounded-scope text for a specialization candidate: the top two content-word
// stems by frequency (ties broken by first occurrence), plus the domain.
// Returns null when the message has no scope-bearing content words so the
// caller keeps the existing defaults.
export function deriveSpecialistScope(text, domain = "general") {
  const counts = new Map();
  for (const word of contentWords(text)) {
    if (SCOPE_NOISE.has(word)) continue;
    const stem = word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, "") : word;
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const stems = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([stem]) => stem);
  return `${stems.join(" ")} ${domain}`;
}

/**
 * Measure the scrutiny axes for a message. All inputs optional except text;
 * absent stores degrade to the previous keyword heuristics, never throw.
 *   novelty    — 1 - best similarity vs what the system already knows:
 *                principle vectors (the only memory-derived namespace with a
 *                writer — memory-condenser.js:71), then read-only token
 *                overlap over memory items (retrieve() would reinforce),
 *                then the old keyword values.
 *   repetition — min(1, similarPastCount / 8) over prior outcomes whose
 *                metadata.signalSummary shares >= 60% of this message's
 *                content-word set; schedule/automate keywords floor at 0.82.
 *   risk       — keyword list floor (0.35/0.75) + 0.25 when a side-effecting
 *                tool verb is named, capped at 0.95.
 *   specificity— measureSpecificity(text).
 *   impact     — max(keyword bump 0.72, 0.3 + 0.3 * specificity).
 *   confidence — 0.7 baseline, 0.5 when the message ends with a question mark.
 */
export async function measureAxes({ text, memorySystem = null, vectorStore = null, outcomeStore = null }) {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const asksToRemember = REMEMBER_RE.test(lower);
  const asksToSchedule = SCHEDULE_RE.test(lower);
  const asksToSpecialize = SPECIALIZE_RE.test(lower);

  let bestMatch = null;
  if (typeof vectorStore?.search === "function") {
    try {
      const hits = await vectorStore.search("principle", raw, { limit: 1, minScore: 0 });
      if (hits.length > 0) bestMatch = clamp(hits[0].score);
    } catch { /* fall through to the next novelty source */ }
  }
  if (bestMatch === null && memorySystem?.items instanceof Map && memorySystem.items.size > 0) {
    let top = 0;
    for (const item of memorySystem.items.values()) {
      const score = tokenOverlapScore(raw, item.content ?? "");
      if (score > top) top = score;
    }
    bestMatch = clamp(top);
  }
  const novelty = bestMatch === null
    ? (asksToRemember || asksToSpecialize ? 0.65 : 0.4)
    : clamp(1 - bestMatch);

  let similarPastCount = 0;
  if (typeof outcomeStore?.recent === "function") {
    const words = contentWords(raw).join(" ");
    if (words) {
      for (const outcome of outcomeStore.recent(200)) {
        const summary = outcome?.metadata?.signalSummary;
        if (typeof summary !== "string" || summary === "") continue;
        if (tokenOverlapScore(words, contentWords(summary).join(" ")) >= 0.6) similarPastCount += 1;
      }
    }
  }
  const measuredRepetition = Math.min(1, similarPastCount / 8);
  const repetition = Math.max(asksToSchedule || asksToSpecialize ? 0.82 : 0.2, measuredRepetition);

  const baseRisk = RISK_KEYWORDS_RE.test(lower) ? 0.75 : 0.35;
  const risk = SIDE_EFFECT_VERBS_RE.test(lower) ? Math.min(0.95, baseRisk + 0.25) : baseRisk;

  const specificity = measureSpecificity(raw);
  const impact = clamp(Math.max(asksToRemember || asksToSpecialize ? 0.72 : 0, 0.3 + 0.3 * specificity));
  const confidence = /\?\s*$/.test(raw) ? 0.5 : 0.7;

  return { novelty, repetition, risk, impact, specificity, confidence };
}

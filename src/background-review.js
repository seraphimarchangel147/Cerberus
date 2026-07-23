import path from "node:path";
import { appendJsonLine } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { MemoryCapacityError } from "./memory-system.js";
import { nowIso, tokenOverlapScore } from "./utils.js";

export const DEFAULT_BACKGROUND_REVIEW_MAX_ITERATIONS = 2;
export const DEFAULT_BACKGROUND_REVIEW_MAX_TURN_SECONDS = 60;

const REVIEW_INSTRUCTIONS = [
  "You are OpenAGI's post-session reviewer. Extract only durable, user-grounded learning from the completed session digest.",
  "Return STRICT JSON with this shape:",
  '{"memories":[{"content":"...","kind":"preference|correction|environment","confidence":"high|medium|low","tags":["..."]}],"skill":null}',
  "A repeatable successful workflow may replace null with a skill object: {\"title\":\"...\",\"rationale\":\"...\",\"draftBody\":\"...\"}.",
  "Do not invent facts, credentials, or critical safety rules. Omit transient details and one-off chat. Propose at most three memories and one skill."
].join("\n");

const ALLOWED_MEMORY_KINDS = new Set(["preference", "correction", "environment"]);
const CONFIDENCE_PROFILE = Object.freeze({
  high: { tier: "long", strength: 0.85 },
  medium: { tier: "medium", strength: 0.68 },
  low: { tier: "medium", strength: 0.48 }
});

export function backgroundReviewEnabled(env = process.env) {
  return /^(?:1|true|on)$/iu.test(String(env.OPENAGI_BACKGROUND_REVIEW ?? "").trim());
}

export class BackgroundReviewer {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.modelProvider = options.modelProvider ?? this.runtime?.agentHost?.modelProvider ?? null;
    this.dataDir = options.dataDir ?? this.runtime?.dataDir ?? resolveDataDir();
    this.reviewFile = options.reviewFile ?? path.join(this.dataDir, "background-review", "reviews.jsonl");
  }

  async review(turn) {
    const provider = this.modelProvider;
    if (!provider?.isConfigured?.() || typeof provider.generate !== "function") {
      return { skipped: true, reason: "no configured review model" };
    }
    // WHY: the deterministic fallback reflects input instead of judging it,
    // which would turn every ordinary turn into junk memory.
    if (provider.constructor?.name === "DeterministicModelProvider") {
      return { skipped: true, reason: "deterministic provider cannot review" };
    }

    const result = await provider.generate({
      input: buildReviewPrompt(turn),
      task: "review",
      agent: { id: "background-review", name: "background-review" },
      memoryHits: [],
      messages: [],
      tools: [],
      toolRegistry: null,
      instructions: REVIEW_INSTRUCTIONS,
      // An explicit empty advertised list prevents provider fallback from
      // exposing runtime tools to this read-only auxiliary pass.
      context: {
        channel: "background-review",
        sessionId: turn.sessionId,
        __advertisedTools: []
      },
      maxIterations: DEFAULT_BACKGROUND_REVIEW_MAX_ITERATIONS,
      maxTurnSeconds: DEFAULT_BACKGROUND_REVIEW_MAX_TURN_SECONDS
    });

    const proposal = parseBackgroundReview(result?.text);
    if (!proposal) {
      const record = persistReview(this.reviewFile, turn, { status: "invalid", proposal: null });
      return { skipped: true, reason: "review model returned invalid JSON", record };
    }

    const applied = applyBackgroundReviewProposal({ runtime: this.runtime, proposal, turn });
    const record = persistReview(this.reviewFile, turn, { status: "reviewed", proposal, applied });
    this.runtime?.events?.emit?.("background-review", {
      at: record.at,
      sessionId: turn.sessionId,
      memoriesAdded: applied.memories.length,
      duplicatesSkipped: applied.duplicatesSkipped,
      skillTitle: applied.skill?.candidate?.title ?? null,
      skillPending: Boolean(applied.skill)
    });
    return { skipped: false, proposal, applied, record };
  }
}

export function parseBackgroundReview(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(source);
  const candidate = fenced ? fenced[1] : source;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function applyBackgroundReviewProposal({ runtime, proposal, turn = {} }) {
  const memory = runtime?.memory;
  const scope = turn.memoryScope ?? "main";
  const memories = [];
  const memoryErrors = [];
  let duplicatesSkipped = 0;

  for (const raw of Array.isArray(proposal?.memories) ? proposal.memories.slice(0, 3) : []) {
    // Capacity-managed writes must reject over-limit proposals intact. A
    // pre-slice here would silently turn an invalid memory into a different
    // fact and bypass MemoryCapacityError.
    const content = String(raw?.content ?? "").trim();
    const kind = String(raw?.kind ?? "").toLowerCase();
    const confidence = String(raw?.confidence ?? "low").toLowerCase();
    const profile = CONFIDENCE_PROFILE[confidence] ?? CONFIDENCE_PROFILE.low;
    if (!content || !ALLOWED_MEMORY_KINDS.has(kind) || !memory?.remember) continue;

    const duplicate = findNearDuplicate(memory, content, scope);
    if (duplicate) {
      duplicate.metadata = {
        ...(duplicate.metadata ?? {}),
        backgroundReviewSessions: [...new Set([
          ...(duplicate.metadata?.backgroundReviewSessions ?? []),
          turn.sessionId
        ].filter(Boolean))],
        duplicateMergedAt: nowIso()
      };
      duplicate.strength = Math.min(1, (duplicate.strength ?? 0.5) + 0.03);
      try {
        memory.persist?.("background-review-duplicate", { id: duplicate.id, item: duplicate });
      } catch {
        // Duplicate reinforcement is best-effort; review remains non-blocking.
      }
      duplicatesSkipped += 1;
      continue;
    }

    try {
      const item = memory.remember({
        source: "background-review",
        scope,
        content,
        kind,
        tags: [...new Set(["background-review", kind, ...cleanTags(raw.tags)])],
        novelty: 0.55,
        risk: kind === "correction" ? 0.35 : 0.1,
        repetition: 0.25,
        specificity: 0.8,
        metadata: {
          sessionId: turn.sessionId ?? null,
          confidence,
          reviewedAt: nowIso()
        }
      }, {
        source: "background-review",
        strength: profile.strength,
        tier: profile.tier,
        critical: false,
        capacityManaged: true
      });
      memories.push(item);
    } catch (error) {
      if (!(error instanceof MemoryCapacityError)) throw error;
      memoryErrors.push(error.message);
    }
  }

  let skill = null;
  const rawSkill = proposal?.skill;
  if (rawSkill && typeof rawSkill === "object") {
    const title = String(rawSkill.title ?? "").trim().slice(0, 120);
    const rationale = String(rawSkill.rationale ?? "").trim().slice(0, 1000);
    const draftBody = String(rawSkill.draftBody ?? "").trim().slice(0, 12000);
    // Route through the existing suggestion pipeline. It persists a pending
    // candidate and emits the normal approval/activity event; it never writes
    // SKILL.md until the user accepts it.
    if (title && draftBody && runtime?.proactiveObserver?.persist) {
      skill = runtime.proactiveObserver.persist({
        source: "background-review",
        category: "skill",
        title,
        rationale,
        draftBody,
        context: { sessionId: turn.sessionId ?? null },
        status: "pending"
      });
    }
  }

  return { memories, memoryErrors, duplicatesSkipped, skill };
}

function findNearDuplicate(memory, content, scope, threshold = 0.72) {
  for (const existing of memory?.items?.values?.() ?? []) {
    if (existing.metadata?.capacityManaged !== true
      || existing.metadata?.supersededBy
      || existing.metadata?.condensedInto
      || (existing.scope ?? "main") !== scope) continue;
    const forward = tokenOverlapScore(content, existing.content);
    const reverse = tokenOverlapScore(existing.content, content);
    if ((forward + reverse) / 2 >= threshold) return existing;
  }
  return null;
}

function cleanTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function buildReviewPrompt(turn) {
  const digest = buildBackgroundReviewDigest(turn.messages);
  const toolSummary = (turn.toolCalls ?? [])
    .slice(0, 20)
    .map((call) => `${call.name}:${call.ok ? "ok" : "failed"}`)
    .join(", ") || "none";
  return [
    `Session: ${turn.sessionId ?? "unknown"}`,
    ...(digest
      ? [`Warm-cache session digest:\n${digest}`]
      : [
          `User: ${String(turn.userText ?? "").slice(0, 6000)}`,
          `Assistant: ${String(turn.assistantText ?? "").slice(0, 6000)}`
        ]),
    `Tools: ${toolSummary}`
  ].join("\n");
}

export function buildBackgroundReviewDigest(messages, { maxChars = 12_000 } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const limit = Math.max(500, Math.min(50_000, Number(maxChars) || 12_000));
  const retained = [];
  let used = 0;
  const bodyLimit = Math.max(1, limit - 48);
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    const role = message?.role === "assistant" ? "Assistant" : "User";
    const line = `${role}: ${String(message?.content ?? "").replace(/\s+/g, " ").trim()}`;
    const remaining = bodyLimit - used;
    if (remaining <= 0) break;
    const value = line.length <= remaining ? line : line.slice(line.length - remaining);
    retained.unshift(value);
    used += value.length + (retained.length > 1 ? 1 : 0);
  }
  if (retained.length === 0) return "";
  const omitted = Math.max(0, source.length - retained.length);
  const prefix = omitted ? `[${omitted} older messages omitted]\n` : "";
  const available = Math.max(0, limit - prefix.length);
  return `${prefix}${retained.join("\n").slice(-available)}`;
}

function persistReview(file, turn, details) {
  const record = {
    at: nowIso(),
    sessionId: turn.sessionId ?? null,
    agentId: turn.agentId ?? null,
    ...details
  };
  appendJsonLine(file, record);
  return record;
}

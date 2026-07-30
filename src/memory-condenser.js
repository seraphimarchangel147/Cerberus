// Portions adapted from TencentDB Agent Memory
// (https://github.com/TencentCloud/TencentDB-Agent-Memory), MIT.
// Copyright (C) 2026 Tencent. Derived from commit 104e9d8:
// src/core/store/search-utils.ts (Reciprocal Rank Fusion) and
// src/offload/hooks/llm-input-l3.ts (substitutability score cascade).

import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { createContext, runInContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { scoreContextSubstitutability } from "./context-value.js";
import { nowIso, tokenize, tokenOverlapScore } from "./utils.js";
import {
  isCredentialHeaderName,
  redactKnownValues,
  sanitizeForAudit
} from "./redact.js";

// Condenses raw memory items into distilled "principles" stored in long-tier.
// Sources keep their normal lifecycle and may decay; principles outlive them.
//
// Strategy:
//   1. Group medium-tier raw items by tag overlap.
//   2. For each group of >= MIN_GROUP_SIZE, ask the model provider to distill
//      into a 200–400 char principle. Fall back to extractive summary when no
//      LLM is configured (deterministic provider).
//   3. Write principle to long-tier with metadata { kind: 'principle', sources,
//      confidence, quarantineUntil }.
//   4. Quarantine principles for QUARANTINE_DAYS so contradictions can retire
//      them before they propagate. Promotion check is implicit: principles are
//      already in long-tier, but their `confidence` is read by recall ranking.

const MIN_GROUP_SIZE = 3;
const MAX_GROUPS_PER_RUN = 8;
const QUARANTINE_DAYS = 7;

export const CONTEXT_IN_LOOP_RATIO = 0.5;
export const CONTEXT_GATEWAY_RATIO = 0.85;
export const CONTEXT_VALUE_CASCADE_INITIAL_SCORE = 10;
export const CONTEXT_VALUE_CASCADE_FLOOR_SCORE = 3;

const DEFAULT_LIVE_CONTEXT_KEEP_RECENT_HOPS = 4;
const DEFAULT_LIVE_CONTEXT_DIGEST_CHARS = 4000;
const MIN_LIVE_CONTEXT_DIGEST_CHARS = 40;
const DEFAULT_CONTEXT_ESTIMATE_MAX_CHARS = 8_000_000;
const DEFAULT_CONTEXT_ESTIMATE_CHARS_PER_TOKEN = 4;
const CONTEXT_VALUE_MAX_CASCADE_UNITS = 2_048;
const LIVE_CONTEXT_SUMMARY = Symbol("liveContextSummary");
const LIVE_CONTEXT_SYNTHETIC_TURN = Symbol("liveContextSyntheticTurn");
const CONTEXT_LEDGER_CANDIDATES = new WeakMap();
const CONTEXT_LEDGER_VERSION = 1;
const CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION = 6;
const CONTEXT_LEDGER_MAX_REFERENCES = 32;
const CONTEXT_LEDGER_MAX_EXCERPT_CHARS = 360;
const CONTEXT_LEDGER_MAX_VALUE_DEPTH = 8;
const CONTEXT_LEDGER_MAX_VALUE_ITEMS = 24;
const CONTEXT_LEDGER_MAX_SNAPSHOT_DEPTH = 16_384;
const CONTEXT_LEDGER_MAX_SNAPSHOT_NODES = 100_000;
const CONTEXT_LEDGER_MAX_SNAPSHOT_CHARS = 16_000_000;
const CONTEXT_LEDGER_FAIL_OPEN_SNAPSHOT_CHARS = 1_000_000;
const CONTEXT_LEDGER_MAX_ARRAY_LENGTH = 100_000;
const CONTEXT_LEDGER_MAX_SUMMARIZER_ITEMS = 64;
const CONTEXT_LEDGER_MAX_SUMMARIZER_CHARS = 64_000;
const CONTEXT_LEDGER_MAX_EVENTS = 10_000;
const CONTEXT_LEDGER_MAX_RESULT_JSON_CHARS = 256_000;
const CONTEXT_LEDGER_MAX_OBJECT_KEYS = 1_024;
const CONTEXT_LEDGER_MAX_REFERENCE_SCAN_NODES = 4_096;
const CONTEXT_LEDGER_MAX_JSON_DECODE_DEPTH = 8;
const DEFAULT_CONTEXT_LEDGER_SUMMARIZER_TIMEOUT_MS = 250;
const MAX_CONTEXT_LEDGER_SUMMARIZER_TIMEOUT_MS = 1_000;
const MAX_CONTEXT_LEDGER_SUMMARIZER_SOURCE_CHARS = 32_000;
const CONTEXT_LEDGER_COOPERATIVE_SUMMARIZERS = new WeakSet();
const CONTEXT_LEDGER_OMITTED_ITEM = Object.freeze({
  role: "user",
  content: "[unsafe context item omitted from preview]"
});
const CONTEXT_LEDGER_PRIVATE_KEY = /(?:analysis|chain[_-]?of[_-]?thought|reasoning|thinking|thoughts?|scratchpad|rationale|internal[_-]?monologue|(?:^|[_-])cot(?:[_-]|$))/i;
const CONTEXT_LEDGER_PRIVATE_TYPE = /(?:^|[_-])(?:analysis|chain[_-]?of[_-]?thought|reasoning|thinking|thoughts?|scratchpad|rationale|internal[_-]?monologue|cot|redacted[_-]?thinking|signature)(?:[_-]|$)/i;
const CONTEXT_LEDGER_SENSITIVE_KEY = /(?:api.?key|access.?key|auth.?header|authorization|(?:^|[_-])auth(?:entication)?(?:[_-]|$)|bearer|cookie|credential|password|passcode|private.?key|token|secret)/i;
const CONTEXT_LEDGER_MUTATION_TOOL = /(?:^|_)(?:add|archive|cancel|clear|complete|connect|correct|create|delete|disconnect|edit|install|link|move|patch|publish|register|remember|remove|rename|restore|rollback|run|save|schedule|send|set|start|stop|type|unblock|update|write)(?:_|$)/i;
const CONTEXT_LEDGER_AUTHORIZATION = /\b(?:approved|I (?:approve|authorize|permit|grant|give permission)|you may|please proceed|go ahead|permission (?:is|has been) granted|authorization (?:is|has been) granted|allowed to)\b/i;
const CONTEXT_LEDGER_AUTHORIZATION_DENIAL = /\b(?:do not|don't|never|must not|may not|should not|cannot|can't|nobody|no one|no person|unauthoriz(?:ed|ation)|not (?:authorized|approved|permitted|allowed)|(?:has|have|had) not been (?:granted|approved|authorized)|(?:haven't|hasn't|hadn't) (?:granted|approved|authorized|permitted|allowed)|did not approve|didn't approve|no (?:approval|authorization|permission)|without (?:approval|authorization|permission)|(?:approval|authorization|permission) (?:is|was|has been) (?:denied|required|revoked|withdrawn|refused))\b/i;
const CONTEXT_LEDGER_AUTHORIZATION_REPORTING = /\b(?:example|phrase|quoted?|shown|word|documentation)\b.{0,80}\b(?:approved|authorized|go ahead|permission|you may)\b|\b(?:approved|authorized|go ahead|permission|you may)\b.{0,80}\b(?:example|phrase|quoted?|shown|word|documentation)\b/i;
const CONTEXT_LEDGER_AUTHORIZATION_CONDITIONAL = /\b(?:only|provided) (?:if|after|when)\b|\b(?:if|after|when|once|until)\b.{0,80}\b(?:approv(?:e|es|ed|al)|authorization|permission|permit(?:ted)?|grant(?:ed)?)\b|\b(?:subject to|pending|contingent on|depending on|awaiting)\b.{0,80}\b(?:approval|authorization|permission|permit(?:ted)?|grant(?:ed)?)\b/i;
const CONTEXT_LEDGER_DECISION = /\b(?:decid(?:e|ed)|chose|chosen|select(?:ed)?|will use|the plan is|we will)\b/i;
const CONTEXT_LEDGER_BLOCKER = /\b(?:block(?:ed|er)?|cannot|can't|failed|failure|error|denied|unavailable|missing|required)\b/i;
const CONTEXT_LEDGER_NEXT = /\b(?:next|remaining|todo|follow[- ]?up|still need|will now|then)\b/i;
const CONTEXT_LEDGER_LEGACY_FAILURE_TEXT = /^(?:(?:fatal|error|failed|blocked|denied|forbidden|unauthorized|enoent|eacces)(?:\b|[:!])|npm\s+err!\s+(?:eacces|enoent|eperm)\b|[a-z][a-z0-9_.-]{0,63}\s*:\s*(?:(?:permission|access)\s+denied|fatal|error|failed|blocked|forbidden|unauthorized|enoent|eacces)\b|(?:permission|access)\s+denied\b|(?:operation|request|command|write|read|tool)(?:\s+[a-z_-]+){0,4}\s+(?:failed|denied|could not|cannot|can't|was unable to)\b|(?:could not|cannot|can't|unable to)\b)/i;
const CONTEXT_LEDGER_REFERENCE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._/-]{1,200}$/;
const CONTEXT_LEDGER_EMBEDDED_REFERENCE = /(?:\b(?:artifact|checkpoint|draft|tool-output):[A-Za-z0-9._/-]{1,200}(?=$|[\s"'`,;:!?()[\]{}<>])|(?<![A-Za-z0-9._/-])out_[a-f0-9]{16}(?![A-Za-z0-9._/-]))/g;
const CONTEXT_LEDGER_CORE_SECTION_LABELS = new Set([
  "Objective",
  "Authorization context (not a policy grant)",
  "Decisions",
  "Tool receipts",
  "Changes",
  "Pending",
  "Blockers",
  "Failures",
  "Next"
]);
const LIVE_CONTEXT_LEDGER_REFERENCES = Symbol("liveContextLedgerReferences");
const LIVE_CONTEXT_LEDGER_DIGEST = Symbol("liveContextLedgerDigest");

export function markLiveContextSyntheticTurn(message) {
  if (message && typeof message === "object") {
    Object.defineProperty(message, LIVE_CONTEXT_SYNTHETIC_TURN, { value: true });
  }
  return message;
}

// Local closures cannot be force-stopped safely. Callers may explicitly mark a
// trusted synchronous callback as cooperative when closure or binding support
// matters more than worker isolation.
export function cooperativeContextLedgerSummarizer(summarizer) {
  if (typeof summarizer !== "function" || utilTypes.isProxy(summarizer)) {
    throw new TypeError("A cooperative context-ledger summarizer must be a non-proxy function.");
  }
  CONTEXT_LEDGER_COOPERATIVE_SUMMARIZERS.add(summarizer);
  return summarizer;
}

export class MemoryCondenser {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.minGroupSize = options.minGroupSize ?? MIN_GROUP_SIZE;
    this.maxGroupsPerRun = options.maxGroupsPerRun ?? MAX_GROUPS_PER_RUN;
    this.quarantineDays = options.quarantineDays ?? QUARANTINE_DAYS;
  }

  async condense({ now = new Date(), scope = null, writeScope = null, originSpecialistId = null } = {}) {
    if (!this.runtime?.memory) throw new Error("MemoryCondenser requires a runtime with memory.");
    let candidates = [...this.runtime.memory.byTier("medium"), ...this.runtime.memory.byTier("short")]
      .filter((item) => item.kind !== "principle" && !item.metadata?.condensedInto);
    if (scope) {
      candidates = candidates.filter((item) => item.scope === scope);
    } else {
      candidates = candidates.filter((item) => !item.scope || item.scope === "main");
    }
    if (candidates.length < this.minGroupSize) {
      return { groups: 0, principles: 0, reason: "not enough items in scope" };
    }
    const groups = clusterByTagOverlap(candidates, this.minGroupSize).slice(0, this.maxGroupsPerRun);
    const principles = [];
    let duplicatesSkipped = 0;

    for (const group of groups) {
      const principle = await this.distill(group);
      if (!principle) continue;
      const tags = [...new Set(group.flatMap((m) => m.tags ?? []).concat(["principle"]))];
      if (originSpecialistId) tags.push(`legacy:${originSpecialistId}`);
      const targetScope = writeScope ?? "main";
      const duplicate = findNearDuplicatePrinciple(this.runtime.memory, principle.text, targetScope);
      if (duplicate) {
        duplicate.metadata = {
          ...(duplicate.metadata ?? {}),
          sources: [...new Set([...(duplicate.metadata?.sources ?? []), ...group.map((m) => m.id)])],
          duplicateMergedAt: nowIso()
        };
        duplicate.strength = Math.min(1, (duplicate.strength ?? 0.5) + 0.03);
        markCondensedSources(this.runtime.memory, group, duplicate.id);
        duplicatesSkipped += 1;
        continue;
      }

      const quarantineUntil = new Date(now.getTime() + this.quarantineDays * 86400 * 1000).toISOString();
      const profile = confidenceProfile(principle.confidence);
      const item = this.runtime.memory.remember(
        {
          source: originSpecialistId ? "legacy" : "condenser",
          kind: "principle",
          scope: targetScope,
          content: principle.text,
          tags,
          risk: median(group.map((m) => m.risk ?? 0)),
          specificity: 0.7,
          repetition: 0.8,
          metadata: {
            sources: group.map((m) => m.id),
            confidence: principle.confidence,
            quarantineUntil,
            distilledAt: nowIso(),
            originSpecialistId: originSpecialistId ?? null
          }
        },
        {
          source: originSpecialistId ? "legacy" : "condenser",
          strength: profile.strength,
          tier: profile.tier,
          critical: false
        }
      );
      // Index for Lava intuition lookups.
      this.runtime.vectorStore?.upsert("principle", item.id, principle.text, {
        confidence: principle.confidence,
        tags: item.tags
      }).catch(() => {});
      // Mark sources so we don't re-condense them.
      markCondensedSources(this.runtime.memory, group, item.id);
      principles.push({ id: item.id, sources: group.map((m) => m.id), text: principle.text, confidence: principle.confidence });
    }

    if (typeof this.runtime.memory.persist === "function") this.runtime.memory.persist("condense", { count: principles.length });
    return { groups: groups.length, principles: principles.length, duplicatesSkipped, items: principles };
  }

  async distill(items) {
    const provider = this.runtime?.agentHost?.modelProvider;
    const prompt = buildDistillPrompt(items);

    // LLM path
    if (provider?.isConfigured?.() && typeof provider.generate === "function" && provider.constructor.name !== "DeterministicModelProvider") {
      try {
        const result = await provider.generate({
          input: prompt,
          task: "condense",
          agent: { id: "condenser", name: "memory-condenser" },
          memoryHits: [],
          messages: [],
          tools: [],
          toolRegistry: null,
          instructions: "You are a memory condenser. Read the raw notes and emit ONE distilled principle (200–400 chars, plain prose). Be specific where it matters; don't generalize danger away. End with `(confidence: high|medium|low)`. Output only the principle, no preamble.",
          context: {}
        });
        return parsePrinciple(result.text);
      } catch (error) {
        // fall through to extractive
      }
    }

    // Extractive fallback (deterministic)
    return extractive(items);
  }
}

// Return the provider-reported input-token total used for context pressure.
// Anthropic splits cached input away from input_tokens, while OpenAI's
// input_tokens is already the total and must not have cached tokens added.
export function contextInputTokens(usage, { provider } = {}) {
  if (!usage || typeof usage !== "object") return null;
  const providerName = String(provider ?? "").toLowerCase();
  const hasAnthropicCacheFields = Object.hasOwn(usage, "cache_creation_input_tokens")
    || Object.hasOwn(usage, "cache_read_input_tokens")
    || (usage.cache_creation && typeof usage.cache_creation === "object");
  const anthropic = providerName.includes("anthropic")
    || (!providerName && hasAnthropicCacheFields);

  if (!anthropic) {
    return firstTokenCount(usage.input_tokens, usage.prompt_tokens);
  }

  const input = tokenCount(usage.input_tokens) ?? 0;
  const cacheRead = tokenCount(usage.cache_read_input_tokens) ?? 0;
  const flatCacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const nestedCacheWrite = flatCacheWrite === null
    ? sumTokenCounts(Object.values(usage.cache_creation ?? {}))
    : 0;
  const hasAny = tokenCount(usage.input_tokens) !== null
    || tokenCount(usage.cache_read_input_tokens) !== null
    || flatCacheWrite !== null
    || nestedCacheWrite > 0;
  if (!hasAny) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, input + cacheRead + (flatCacheWrite ?? 0) + nestedCacheWrite);
}

// Estimate serialized request tokens without allocating an unbounded JSON
// string. Overflow and cyclic input return MAX_SAFE_INTEGER so the 85% safety
// gate fails safe instead of underestimating a request.
export function estimateContextTokens(value, options = {}) {
  const maxChars = liveBoundedInteger(
    options.maxChars,
    DEFAULT_CONTEXT_ESTIMATE_MAX_CHARS,
    1,
    64_000_000
  );
  const charsPerToken = liveBoundedNumber(
    options.charsPerToken,
    DEFAULT_CONTEXT_ESTIMATE_CHARS_PER_TOKEN,
    1,
    16
  );
  let chars;
  try {
    chars = boundedJsonChars(value, maxChars);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  if (chars > maxChars) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(chars / charsPerToken));
}

// The exact in-loop measurement wins when both thresholds fire. The reason is
// deliberately machine-facing metadata; it is never inserted into the digest.
export function contextCompressionTrigger({
  actualInputTokens,
  estimatedInputTokens,
  contextWindowTokens,
  inLoopRatio = CONTEXT_IN_LOOP_RATIO,
  gatewayRatio = CONTEXT_GATEWAY_RATIO
} = {}) {
  const windowTokens = positiveTokenCount(contextWindowTokens);
  if (windowTokens === null) {
    return {
      triggered: false,
      reason: null,
      inputTokens: null,
      thresholdTokens: null,
      contextWindowTokens: null
    };
  }

  const actual = tokenCount(actualInputTokens);
  const estimated = tokenCount(estimatedInputTokens);
  const actualRatio = liveBoundedNumber(inLoopRatio, CONTEXT_IN_LOOP_RATIO, Number.EPSILON, 1);
  const estimateRatio = liveBoundedNumber(gatewayRatio, CONTEXT_GATEWAY_RATIO, Number.EPSILON, 1);
  const actualThreshold = windowTokens * actualRatio;
  const estimateThreshold = windowTokens * estimateRatio;

  if (actual !== null && actual >= actualThreshold) {
    return {
      triggered: true,
      reason: "actual-50",
      inputTokens: actual,
      thresholdTokens: Math.ceil(actualThreshold),
      contextWindowTokens: windowTokens
    };
  }
  if (estimated !== null && estimated >= estimateThreshold) {
    return {
      triggered: true,
      reason: "estimated-85",
      inputTokens: estimated,
      thresholdTokens: Math.ceil(estimateThreshold),
      contextWindowTokens: windowTokens
    };
  }
  return {
    triggered: false,
    reason: null,
    inputTokens: actual ?? estimated,
    thresholdTokens: null,
    contextWindowTokens: windowTokens
  };
}

// Build a reversible compression candidate without mutating durable history.
// The returned `conversation` is the proposed compacted working copy; callers
// can inspect `digest` and `preview` before using it. The original working
// conversation is held in a module-private WeakMap so it cannot leak through
// JSON/logging/reflection boundaries and can be recovered with
// restoreContextLedger().
export async function createContextLedgerCandidate(conversation, options = {}) {
  const normalizedOptions = normalizeContextLedgerOptions(options);
  const source = Array.isArray(conversation) && !utilTypes.isProxy(conversation)
    ? conversation
    : null;
  if (!source) {
    return failOpenContextLedgerCandidate([], normalizedOptions);
  }
  try {
    const sourceIdentity = contextLedgerSourceIdentity(source);
    return await prepareContextLedgerCandidate(source, normalizedOptions, {
      sourceRef: source,
      sourceIdentity
    });
  } catch {
    // Compression is an optimization. A malformed value, hostile getter, or
    // optional summarizer must never wedge the model request path.
    return failOpenContextLedgerCandidate(source, normalizedOptions);
  }
}

function normalizedContextLedgerKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isContextLedgerPrivateKey(value) {
  const key = String(value ?? "");
  const normalized = normalizedContextLedgerKey(key);
  return CONTEXT_LEDGER_PRIVATE_KEY.test(key)
    || normalized.startsWith("cot")
    || normalized.includes("internalmonologue")
    || normalized.includes("scratchpad")
    || normalized.includes("rationale");
}

function isContextLedgerPrivateType(value) {
  const type = String(value ?? "");
  const normalized = normalizedContextLedgerKey(type);
  return CONTEXT_LEDGER_PRIVATE_TYPE.test(type)
    || normalized.startsWith("cot")
    || normalized.includes("internalmonologue")
    || normalized.includes("scratchpad")
    || normalized.includes("rationale");
}

function isContextLedgerSensitiveKey(value) {
  const key = String(value ?? "");
  const normalized = normalizedContextLedgerKey(key);
  return CONTEXT_LEDGER_SENSITIVE_KEY.test(key)
    || isCredentialHeaderName(key)
    || normalized === "auth"
    || normalized.includes("authvalue")
    || normalized.includes("clientid")
    || normalized.includes("servicekey")
    || normalized.includes("accountsid")
    || normalized.includes("sessionid")
    || normalized.includes("signature");
}

export async function previewContextLedger(conversation, options = {}) {
  return createContextLedgerCandidate(conversation, options);
}

export function restoreContextLedger(candidate) {
  const metadata = candidate && typeof candidate === "object"
    ? CONTEXT_LEDGER_CANDIDATES.get(candidate)
    : null;
  if (!metadata || metadata.used || !Array.isArray(metadata.original)) return null;
  try {
    return cloneContextValue(metadata.original);
  } catch {
    return null;
  }
}

export function installContextLedgerCandidate(candidate, currentConversation) {
  const metadata = candidate && typeof candidate === "object"
    ? CONTEXT_LEDGER_CANDIDATES.get(candidate)
    : null;
  if (!metadata) {
    return {
      installed: false,
      reason: "invalid_candidate",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  if (metadata.used) {
    return {
      installed: false,
      reason: "already_installed",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  if (metadata.compressed !== true) {
    return {
      installed: false,
      reason: "not_compressed",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  if (metadata.sourceRef !== currentConversation) {
    return {
      installed: false,
      reason: "foreign_source",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }

  let currentIdentity;
  let publicPreparedIdentity;
  try {
    currentIdentity = contextLedgerSourceIdentity(currentConversation);
    const compressedDescriptor = Object.getOwnPropertyDescriptor(candidate, "compressed");
    const conversationDescriptor = Object.getOwnPropertyDescriptor(candidate, "conversation");
    if (
      !compressedDescriptor
      || !Object.hasOwn(compressedDescriptor, "value")
      || compressedDescriptor.value !== metadata.compressed
      || !conversationDescriptor
      || !Object.hasOwn(conversationDescriptor, "value")
    ) {
      return {
        installed: false,
        reason: "stale_candidate",
        conversation: safeFailOpenContextSnapshot(currentConversation)
      };
    }
    publicPreparedIdentity = contextLedgerSourceIdentity(conversationDescriptor.value);
  } catch {
    return {
      installed: false,
      reason: "unsafe_source",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  if (currentIdentity !== metadata.sourceIdentity) {
    return {
      installed: false,
      reason: "stale_source",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  if (publicPreparedIdentity !== metadata.preparedIdentity) {
    return {
      installed: false,
      reason: "stale_candidate",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }

  let installedConversation;
  try {
    installedConversation = cloneContextValue(metadata.prepared);
  } catch {
    return {
      installed: false,
      reason: "unsafe_candidate",
      conversation: safeFailOpenContextSnapshot(currentConversation)
    };
  }
  metadata.used = true;
  metadata.sourceRef = null;
  metadata.original = null;
  metadata.prepared = null;
  return {
    installed: true,
    reason: "installed",
    conversation: installedConversation
  };
}

// Existing public hot-path API. It now returns the structured, reversible
// candidate while preserving every pre-existing result field.
export async function compressLiveContext(conversation, options = {}) {
  return createContextLedgerCandidate(conversation, options);
}

async function prepareContextLedgerCandidate(source, options, binding) {
  const original = cloneContextValue(source);
  const working = cloneContextValue(original);
  const format = resolveLiveContextFormat(working, options.format);
  const keepRecentRoleMessages = options.keepRecentHops !== undefined
    ? (liveBoundedInteger(options.keepRecentHops, DEFAULT_LIVE_CONTEXT_KEEP_RECENT_HOPS, 1, 499) * 2) + 1
    : liveBoundedInteger(
      options.keepRecentTurns,
      (DEFAULT_LIVE_CONTEXT_KEEP_RECENT_HOPS * 2) + 1,
      1,
      999
    );
  const maxDigestChars = liveBoundedInteger(
    options.maxDigestChars,
    DEFAULT_LIVE_CONTEXT_DIGEST_CHARS,
    MIN_LIVE_CONTEXT_DIGEST_CHARS,
    64_000
  );

  let boundary = liveContextRecentBoundary(working, keepRecentRoleMessages);
  boundary = adjustLiveToolPairBoundary(working, format, boundary);
  let summaryStart = liveContextSummaryStart(working, boundary);
  summaryStart = adjustLiveToolPairSummaryStart(working, format, summaryStart, boundary);
  if (options.valueAwareCompaction === true) {
    try {
      return await prepareValueAwareContextLedgerCandidate({
        original,
        working,
        format,
        summaryStart,
        boundary,
        maxDigestChars,
        options,
        binding
      });
    } catch {
      // Value-aware selection is an optimization. Any scorer or cascade fault
      // falls through to the exact positional implementation below.
    }
  }
  if (boundary <= summaryStart || boundary >= working.length) {
    return attachContextLedgerRestore({
      compressed: false,
      conversation: working,
      format,
      summarizedItems: 0,
      keptItems: working.length,
      summarySource: null,
      digest: null,
      preview: contextLedgerPreview(original, working, {
        summaryStart,
        boundary,
        summarizedItems: 0
      }),
      failedOpen: false
    }, original, binding);
  }

  const prefix = working.slice(summaryStart, boundary);
  const redactionOptions = contextLedgerRedactionOptions(options);
  if (redactionOptions.overflow) {
    throw new RangeError("Context ledger redaction values exceed the safe bound.");
  }
  const digest = buildStructuredContextLedger(prefix, {
    format,
    redactValues: redactionOptions.redactValues
  });
  let providedOverview = null;
  let summarySource = "deterministic";
  if (typeof options.summarizer === "function") {
    try {
      const proposed = await runBoundedContextLedgerSummarizer(
        options.summarizer,
        sanitizeContextLedgerPrefix(prefix, redactionOptions),
        {
          format,
          maxChars: maxDigestChars,
          ledger: cloneContextValue(digest)
        },
        options.summarizerTimeoutMs
      );
      if (typeof proposed === "string" && proposed.trim()) {
        providedOverview = sanitizeContextLedgerText(
          proposed,
          redactionOptions.redactValues
        );
        summarySource = "provided";
      }
    } catch {
      // A summarizer is optional. Deterministic fallback keeps compression live.
    }
  }
  if (providedOverview) digest.overview = providedOverview;
  const mandatoryReferences = contextLedgerReferences(digest);
  const fitDigest = () => {
    const markerDigest = freezeContextLedgerValue(cloneContextValue(digest));
    return fitContextLedgerReplacement(
      working,
      summaryStart,
      boundary,
      renderStructuredContextLedger(digest),
      maxDigestChars,
      mandatoryReferences,
      markerDigest
    );
  };
  const isUsableFit = (candidate, { requireOverview = false } = {}) => (
    candidate.referencesComplete
    && candidate.sectionsComplete
    && (
      !requireOverview
      || String(candidate.marker).includes("\nOptional overview:\n- ")
    )
    && liveContextSerializedChars(candidate.conversation)
      < liveContextSerializedChars(working)
  );
  let fitted = fitDigest();
  if (!isUsableFit(fitted, { requireOverview: Boolean(providedOverview) })
    && providedOverview) {
    // The auxiliary overview is strictly optional. Give the deterministic
    // ledger its full budget before declining an otherwise safe compression.
    delete digest.overview;
    summarySource = "deterministic";
    fitted = fitDigest();
  }
  const { marker, conversation: next } = fitted;
  if (!isUsableFit(fitted)) {
    return attachContextLedgerRestore({
      compressed: false,
      conversation: working,
      format,
      summarizedItems: 0,
      keptItems: working.length,
      summarySource: null,
      digest,
      preview: contextLedgerPreview(original, working, {
        summaryStart,
        boundary,
        summarizedItems: 0
      }),
      failedOpen: false
    }, original, binding);
  }

  return attachContextLedgerRestore({
    compressed: true,
    conversation: next,
    format,
    summarizedItems: prefix.length,
    keptItems: working.length - prefix.length,
    summarySource,
    marker,
    digest,
    preview: contextLedgerPreview(original, next, {
      summaryStart,
      boundary,
      summarizedItems: prefix.length
    }),
    failedOpen: false
  }, original, binding);
}

async function prepareValueAwareContextLedgerCandidate({
  original,
  working,
  format,
  summaryStart,
  boundary,
  maxDigestChars,
  options,
  binding
}) {
  const targetChars = positiveSafeInteger(options.valueAwareTargetChars);
  const emptyCandidate = (cascade = null, digest = null) => attachContextLedgerRestore({
    compressed: false,
    conversation: working,
    format,
    summarizedItems: 0,
    keptItems: working.length,
    summarySource: null,
    digest,
    preview: contextLedgerPreview(original, working, {
      summaryStart,
      boundary,
      summarizedItems: 0
    }),
    failedOpen: false,
    valueAware: true,
    cascade
  }, original, binding);

  if (boundary <= summaryStart || boundary >= working.length) {
    return emptyCandidate({
      targetChars,
      selectedIndexes: [],
      selectedScores: [],
      thresholdReached: null
    });
  }

  const units = buildContextValueUnits(
    working,
    format,
    summaryStart,
    boundary
  );
  if (units.length > CONTEXT_VALUE_MAX_CASCADE_UNITS) {
    throw new RangeError("Value-aware cascade exceeds its bounded unit count.");
  }

  const ordered = [];
  for (
    let threshold = CONTEXT_VALUE_CASCADE_INITIAL_SCORE;
    threshold >= CONTEXT_VALUE_CASCADE_FLOOR_SCORE;
    threshold -= 1
  ) {
    for (const unit of units) {
      if (unit.score === threshold) ordered.push(unit);
    }
  }

  const beforeChars = liveContextSerializedChars(working);
  const selected = new Set();
  const selectedScores = [];
  let selectedChars = 0;
  let thresholdReached = null;
  for (const unit of ordered) {
    for (const index of unit.indexes) {
      selected.add(index);
      selectedChars += liveContextSerializedChars(working[index]) + 1;
    }
    selectedScores.push(unit.score);
    thresholdReached = unit.score;
    if (targetChars !== null) {
      const markerReserve = Math.min(
        maxDigestChars + 64,
        Math.max(MIN_LIVE_CONTEXT_DIGEST_CHARS + 32, selectedChars)
      );
      const projectedChars = Math.max(
        0,
        beforeChars - selectedChars + markerReserve
      );
      if (projectedChars <= targetChars) break;
    }
  }

  const selectedIndexes = [...selected].sort((left, right) => left - right);
  const cascade = {
    targetChars,
    selectedIndexes,
    selectedScores,
    thresholdReached
  };
  if (selectedIndexes.length === 0) return emptyCandidate(cascade);

  const prefix = selectedIndexes.map((index) => working[index]);
  const redactionOptions = contextLedgerRedactionOptions(options);
  if (redactionOptions.overflow) {
    throw new RangeError("Context ledger redaction values exceed the safe bound.");
  }
  const digest = buildStructuredContextLedger(prefix, {
    format,
    redactValues: redactionOptions.redactValues
  });
  let providedOverview = null;
  let summarySource = "deterministic";
  if (typeof options.summarizer === "function") {
    try {
      const proposed = await runBoundedContextLedgerSummarizer(
        options.summarizer,
        sanitizeContextLedgerPrefix(prefix, redactionOptions),
        {
          format,
          maxChars: maxDigestChars,
          ledger: cloneContextValue(digest)
        },
        options.summarizerTimeoutMs
      );
      if (typeof proposed === "string" && proposed.trim()) {
        providedOverview = sanitizeContextLedgerText(
          proposed,
          redactionOptions.redactValues
        );
        summarySource = "provided";
      }
    } catch {
      // The deterministic digest remains authoritative and available.
    }
  }
  if (providedOverview) digest.overview = providedOverview;
  const mandatoryReferences = contextLedgerReferences(digest);
  const fitDigest = () => {
    const markerDigest = freezeContextLedgerValue(cloneContextValue(digest));
    return fitContextLedgerSelection(
      working,
      selected,
      renderStructuredContextLedger(digest),
      maxDigestChars,
      mandatoryReferences,
      markerDigest,
      targetChars
    );
  };
  const isUsableFit = (candidate, { requireOverview = false } = {}) => (
    candidate.referencesComplete
    && candidate.sectionsComplete
    && (
      !requireOverview
      || String(candidate.marker).includes("\nOptional overview:\n- ")
    )
    && candidate.afterChars < beforeChars
    && (targetChars === null || candidate.afterChars <= targetChars)
  );
  let fitted = fitDigest();
  if (!isUsableFit(fitted, { requireOverview: Boolean(providedOverview) })
    && providedOverview) {
    delete digest.overview;
    summarySource = "deterministic";
    fitted = fitDigest();
  }
  if (!isUsableFit(fitted)) return emptyCandidate(cascade, digest);

  const firstSelected = selectedIndexes[0];
  const lastSelected = selectedIndexes.at(-1);
  return attachContextLedgerRestore({
    compressed: true,
    conversation: fitted.conversation,
    format,
    summarizedItems: selectedIndexes.length,
    keptItems: working.length - selectedIndexes.length,
    summarySource,
    marker: fitted.marker,
    digest,
    preview: contextLedgerPreview(original, fitted.conversation, {
      summaryStart: firstSelected,
      boundary: lastSelected + 1,
      summarizedItems: selectedIndexes.length
    }),
    failedOpen: false,
    valueAware: true,
    cascade
  }, original, binding);
}

function buildContextValueUnits(conversation, format, summaryStart, boundary) {
  const parent = new Map();
  for (let index = summaryStart; index < boundary; index += 1) {
    parent.set(index, index);
  }
  const find = (index) => {
    let root = index;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(index) !== index) {
      const next = parent.get(index);
      parent.set(index, root);
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent.set(
      Math.max(leftRoot, rightRoot),
      Math.min(leftRoot, rightRoot)
    );
  };
  const pairs = liveContextToolPairs(conversation, format)
    .filter(([callIndex, resultIndex]) => (
      callIndex >= summaryStart
      && callIndex < boundary
      && resultIndex >= summaryStart
      && resultIndex < boundary
    ))
    .sort(([leftCall, leftResult], [rightCall, rightResult]) => (
      leftCall - rightCall || leftResult - rightResult
    ));
  for (const [callIndex, resultIndex] of pairs) union(callIndex, resultIndex);

  const grouped = new Map();
  for (let index = summaryStart; index < boundary; index += 1) {
    const root = find(index);
    const indexes = grouped.get(root) ?? [];
    indexes.push(index);
    grouped.set(root, indexes);
  }
  return [...grouped.values()]
    .map((indexes) => {
      const scored = indexes
        .map((index) => scoreContextSubstitutability(conversation[index]))
        .filter((value) => value.reason !== "invalid");
      const protectedScore = scored.length > 0
        ? scored.reduce((lowest, value) => (
            value.score < lowest.score ? value : lowest
          ))
        : { score: 0, reason: "invalid" };
      return {
        indexes,
        score: protectedScore.score,
        reason: protectedScore.reason
      };
    })
    .sort((left, right) => (
      left.indexes[0] - right.indexes[0]
      || left.indexes.length - right.indexes.length
    ));
}

function fitContextLedgerSelection(
  working,
  selected,
  summary,
  requestedMaxChars,
  mandatoryReferences = [],
  markerDigest = null,
  targetChars = null
) {
  const beforeChars = liveContextSerializedChars(working);
  const firstSelected = Math.min(...selected);
  const build = (markerLimit) => {
    const marker = liveContextSummaryMarker(
      summary,
      markerLimit,
      mandatoryReferences,
      markerDigest
    );
    const conversation = [];
    for (let index = 0; index < working.length; index += 1) {
      if (index === firstSelected) {
        conversation.push(
          createLiveContextSummaryMessage(marker, mandatoryReferences, markerDigest)
        );
      }
      if (!selected.has(index)) conversation.push(working[index]);
    }
    return {
      marker,
      conversation,
      afterChars: liveContextSerializedChars(conversation)
    };
  };
  const maximumAfterChars = targetChars === null
    ? beforeChars - 1
    : Math.min(beforeChars - 1, targetChars);
  let fitted = build(requestedMaxChars);
  if (fitted.afterChars > maximumAfterChars) {
    let low = MIN_LIVE_CONTEXT_DIGEST_CHARS;
    let high = Math.max(low, requestedMaxChars);
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = build(middle);
      if (candidate.afterChars <= maximumAfterChars) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fitted = best ?? build(MIN_LIVE_CONTEXT_DIGEST_CHARS);
  }
  return {
    ...fitted,
    referencesComplete: fitted.marker.length <= requestedMaxChars
      && mandatoryReferences.every((reference) => fitted.marker.includes(reference)),
    sectionsComplete: contextLedgerMarkerSectionsComplete(
      fitted.marker,
      markerDigest
    )
  };
}

function fitContextLedgerReplacement(
  working,
  summaryStart,
  boundary,
  summary,
  requestedMaxChars,
  mandatoryReferences = [],
  markerDigest = null
) {
  const beforeChars = liveContextSerializedChars(working);
  const build = (markerLimit) => {
    const marker = liveContextSummaryMarker(
      summary,
      markerLimit,
      mandatoryReferences,
      markerDigest
    );
    const conversation = [
      ...working.slice(0, summaryStart),
      createLiveContextSummaryMessage(marker, mandatoryReferences, markerDigest),
      ...working.slice(boundary)
    ];
    return {
      marker,
      conversation,
      afterChars: liveContextSerializedChars(conversation)
    };
  };

  // Marker size is monotonic. Binary search bounds the fitting work to at most
  // sixteen transcript measurements even for the public 64K digest ceiling.
  let fitted = build(requestedMaxChars);
  if (fitted.afterChars >= beforeChars) {
    let low = MIN_LIVE_CONTEXT_DIGEST_CHARS;
    let high = Math.max(low, requestedMaxChars);
    let best = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = build(middle);
      if (candidate.afterChars < beforeChars) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fitted = best ?? build(MIN_LIVE_CONTEXT_DIGEST_CHARS);
  }
  return {
    ...fitted,
    referencesComplete: fitted.marker.length <= requestedMaxChars
      && mandatoryReferences.every((reference) => fitted.marker.includes(reference)),
    sectionsComplete: contextLedgerMarkerSectionsComplete(
      fitted.marker,
      markerDigest
    )
  };
}

function contextLedgerMarkerSectionsComplete(marker, digest) {
  if (!digest || typeof digest !== "object") return true;
  for (const [label, items] of contextLedgerSections(digest, {
    includeReferences: false
  })) {
    if (
      CONTEXT_LEDGER_CORE_SECTION_LABELS.has(label)
      &&
      Array.isArray(items)
      && items.length > 0
      && !String(marker).includes(`\n${label}:\n`)
    ) {
      return false;
    }
  }
  if (
    Array.isArray(digest.toolReceipts)
    && digest.toolReceipts.length > 0
    && !contextLedgerMarkerReceiptStatusComplete(marker, digest.toolReceipts)
  ) {
    return false;
  }
  return true;
}

function contextLedgerMarkerReceiptStatusComplete(marker, receipts) {
  const lines = String(marker).split("\n");
  const visibleReceipts = [];
  let inReceipts = false;
  for (const line of lines) {
    if (line === "Tool receipts:") {
      inReceipts = true;
      continue;
    }
    if (!inReceipts) continue;
    if (!line.startsWith("- ")) break;
    visibleReceipts.push(line.slice(2));
  }
  const expected = receipts.map(contextLedgerReceiptCore);
  if (expected.some((receipt) => !receipt)) return false;
  const unmatched = [...visibleReceipts];
  for (const receipt of expected) {
    const index = unmatched.findIndex((line) => (
      line.startsWith(receipt.original)
      || line.startsWith(receipt.statusFirst)
    ));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function contextLedgerReceiptCore(value) {
  const prefix = String(value ?? "").split(";", 1)[0].trim();
  const match = /^(.*)\s+(succeeded|failed|blocked|pending|completed)$/i.exec(prefix);
  if (!match || !match[1].trim()) return null;
  const tool = match[1].trim();
  const status = match[2].toLowerCase();
  return {
    original: `${tool} ${status}`,
    statusFirst: `${status}: ${tool}`
  };
}

function attachContextLedgerRestore(candidate, original, binding = {}) {
  const prepared = cloneContextValue(candidate.conversation);
  CONTEXT_LEDGER_CANDIDATES.set(candidate, {
    sourceRef: binding.sourceRef ?? null,
    sourceIdentity: binding.sourceIdentity ?? null,
    preparedIdentity: contextLedgerSourceIdentity(prepared),
    prepared,
    compressed: candidate.compressed === true,
    original,
    used: false
  });
  return candidate;
}

function failOpenContextLedgerCandidate(source, options = {}) {
  const fallback = safeFailOpenContextSnapshot(source);
  const format = options.format === "anthropic" ? "anthropic" : "openai";
  const candidate = {
    compressed: false,
    conversation: fallback,
    format,
    summarizedItems: 0,
    keptItems: fallback.length,
    summarySource: null,
    digest: null,
    preview: {
      version: CONTEXT_LEDGER_VERSION,
      beforeItems: fallback.length,
      afterItems: fallback.length,
      beforeChars: null,
      afterChars: null,
      savedChars: 0,
      summaryStart: null,
      boundary: null,
      summarizedItems: 0
    },
    failedOpen: true
  };
  try {
    return attachContextLedgerRestore(candidate, fallback);
  } catch {
    // A failed-open result is an availability boundary. If even its bounded
    // private restore snapshot cannot be installed, return the detached public
    // snapshot without a restore capability rather than rejecting the turn.
    return candidate;
  }
}

function contextLedgerPreview(original, candidate, {
  summaryStart,
  boundary,
  summarizedItems
}) {
  const beforeChars = liveContextSerializedChars(original);
  const afterChars = liveContextSerializedChars(candidate);
  return {
    version: CONTEXT_LEDGER_VERSION,
    beforeItems: original.length,
    afterItems: candidate.length,
    beforeChars,
    afterChars,
    savedChars: Number.isSafeInteger(beforeChars) && Number.isSafeInteger(afterChars)
      ? Math.max(0, beforeChars - afterChars)
      : 0,
    summaryStart,
    boundary,
    summarizedItems
  };
}

function contextLedgerRedactionOptions(options = {}) {
  let values = [];
  let overflow = options.redactionOverflow === true;
  if (utilTypes.isSet(options.redactValues) && !utilTypes.isProxy(options.redactValues)) {
    values = [];
    for (const value of Set.prototype.values.call(options.redactValues)) {
      if (values.length >= 256) {
        overflow = true;
        break;
      }
      values.push(value);
    }
  } else if (Array.isArray(options.redactValues) && !utilTypes.isProxy(options.redactValues)) {
    try {
      const descriptors = safeContextLedgerDescriptors(options.redactValues);
      const sourceLength = safeContextLedgerArrayLength(descriptors);
      if (sourceLength > 256) overflow = true;
      const length = Math.min(sourceLength, 256);
      values = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
        values.push(descriptor.value);
      }
    } catch {
      values = [];
    }
  }
  return {
    redactValues: [...new Set(
      values
        .filter((value) => (
          typeof value === "string"
          || typeof value === "number"
          || typeof value === "boolean"
          || typeof value === "bigint"
        ))
        .map((value) => String(value))
        .filter((value) => value.length > 0 && value.length <= 16_384)
    )].slice(0, 256),
    overflow
  };
}

function sanitizeContextLedgerPrefix(prefix, options = {}) {
  const source = Array.isArray(prefix) ? prefix : [];
  const indexes = source.length <= CONTEXT_LEDGER_MAX_SUMMARIZER_ITEMS
    ? Array.from({ length: source.length }, (_, index) => index)
    : [
        ...Array.from({ length: 8 }, (_, index) => index),
        ...Array.from(
          { length: CONTEXT_LEDGER_MAX_SUMMARIZER_ITEMS - 8 },
          (_, index) => source.length - (CONTEXT_LEDGER_MAX_SUMMARIZER_ITEMS - 8) + index
        )
      ];
  const sanitized = [];
  let chars = 0;
  for (const index of indexes) {
    const item = sanitizeContextLedgerValue(
      source[index],
      options.redactValues
    );
    const serialized = safeLiveJson(item);
    if (chars + serialized.length > CONTEXT_LEDGER_MAX_SUMMARIZER_CHARS) break;
    chars += serialized.length;
    sanitized.push(item);
  }
  return sanitized;
}

function sanitizeContextLedgerValue(value, redactValues = [], depth = 0, ancestors = new Set()) {
  if (typeof value === "string") {
    const decoded = decodeContextLedgerJsonValue(value);
    if (decoded.status === "overflow") {
      return "[structured content omitted]";
    }
    if (decoded.status === "malformed") {
      return "[malformed structured content omitted]";
    }
    if (decoded.status === "decoded") {
      return typeof decoded.value === "string"
        ? sanitizeContextLedgerText(decoded.value, redactValues)
        : sanitizeContextLedgerValue(decoded.value, redactValues, depth, ancestors);
    }
    return sanitizeContextLedgerText(value, redactValues);
  }
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return sanitizeContextLedgerText(value.toString(), redactValues);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "[unsupported content omitted]";
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    return "[unsafe content omitted]";
  }
  let typeDescriptor;
  try {
    typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  } catch {
    return "[unsafe content omitted]";
  }
  if (
    typeDescriptor
    && Object.hasOwn(typeDescriptor, "value")
    && typeof typeDescriptor.value === "string"
    && isContextLedgerPrivateType(typeDescriptor.value)
  ) {
    return "[private reasoning omitted]";
  }
  if (depth >= CONTEXT_LEDGER_MAX_VALUE_DEPTH) return "[nested content omitted]";
  if (ancestors.has(value)) return "[circular content omitted]";

  ancestors.add(value);
  let bounded;
  if (Array.isArray(value)) {
    bounded = [];
    const descriptors = safeContextLedgerDescriptors(value);
    const length = safeContextLedgerArrayLength(descriptors);
    for (let index = 0; index < Math.min(length, CONTEXT_LEDGER_MAX_VALUE_ITEMS); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        bounded.push("[unsafe content omitted]");
        continue;
      }
      bounded.push(sanitizeContextLedgerValue(
        descriptor.value,
        redactValues,
        depth + 1,
        ancestors
      ));
    }
  } else {
    bounded = {};
    for (const [key, item] of safeContextLedgerDataEntries(value)
      .slice(0, CONTEXT_LEDGER_MAX_VALUE_ITEMS)) {
      if (isContextLedgerPrivateKey(key)) continue;
      if (isContextLedgerSensitiveKey(key)) {
        defineContextLedgerData(bounded, key, "[REDACTED]");
        continue;
      }
      defineContextLedgerData(bounded, key, sanitizeContextLedgerValue(
        item,
        redactValues,
        depth + 1,
        ancestors
      ));
    }
  }
  ancestors.delete(value);

  let sanitized = bounded;
  try {
    sanitized = sanitizeForAudit(bounded);
  } catch {
    // The bounded clone above is already stripped of private reasoning keys.
  }
  try {
    return redactKnownValues(sanitized, redactValues);
  } catch {
    return sanitized;
  }
}

function sanitizeContextLedgerText(value, redactValues = []) {
  let safe;
  if (typeof value === "string") safe = value;
  else if (
    value === null
    || value === undefined
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
  ) safe = String(value ?? "");
  else safe = "[unsafe content omitted]";
  try {
    safe = String(sanitizeForAudit(safe));
  } catch {
    // Continue with the bounded string scrub below.
  }
  safe = safe
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|password|passcode|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  try {
    safe = String(redactKnownValues(safe, redactValues));
  } catch {
    // Known-value redaction is best-effort; pattern redaction still applies.
  }
  return clipLiveText(safe, CONTEXT_LEDGER_MAX_EXCERPT_CHARS * 2);
}

function buildStructuredContextLedger(prefix, { format, redactValues = [] } = {}) {
  const digest = {
    version: CONTEXT_LEDGER_VERSION,
    objective: [],
    authorization: [],
    decisions: [],
    toolReceipts: [],
    changes: [],
    changedResources: [],
    evidence: [],
    artifacts: [],
    references: [],
    pending: [],
    blockers: [],
    failures: [],
    next: []
  };
  const events = contextLedgerEvents(prefix, { format, redactValues });
  const calls = new Map();
  const results = new Map();

  for (const event of events) {
    if (event.kind === "prior-ledger") {
      mergePriorContextLedger(digest, event.digest, redactValues);
      for (const reference of event.references) {
        pushContextLedgerReference(
          digest,
          sanitizeContextLedgerText(reference, redactValues)
        );
      }
    } else if (event.kind === "user") {
      pushContextLedgerItem(digest.objective, event.text, { retainLatest: true });
      if (isExplicitContextLedgerAuthorization(event.text)) {
        pushContextLedgerItem(
          digest.authorization,
          `User statement only; policy approval is not inferred: ${event.text}`,
          { retainLatest: true }
        );
      }
    } else if (event.kind === "assistant") {
      if (CONTEXT_LEDGER_DECISION.test(event.text)) {
        pushContextLedgerItem(digest.decisions, event.text, { retainLatest: true });
      }
      if (CONTEXT_LEDGER_BLOCKER.test(event.text)) {
        pushContextLedgerItem(digest.blockers, event.text, { retainLatest: true });
      }
      if (CONTEXT_LEDGER_NEXT.test(event.text)) {
        pushContextLedgerItem(digest.pending, event.text, { retainLatest: true });
        pushContextLedgerItem(digest.next, event.text, { retainLatest: true });
      }
    } else if (event.kind === "tool-call") {
      const queue = calls.get(event.id) ?? [];
      queue.push(event);
      calls.set(event.id, queue);
    } else if (event.kind === "tool-result") {
      const queue = results.get(event.id) ?? [];
      queue.push(event);
      results.set(event.id, queue);
    }
  }

  for (const [id, callQueue] of calls) {
    const resultQueue = results.get(id) ?? [];
    for (const call of callQueue) {
      const result = resultQueue.shift();
      if (!result) {
        pushContextLedgerItem(
          digest.pending,
          `${call.name}: result not present in condensed prefix`,
          { retainLatest: true }
        );
        continue;
      }
      addContextLedgerToolReceipt(digest, call, result);
    }
    results.set(id, resultQueue);
  }

  for (const [id, resultQueue] of results) {
    for (const result of resultQueue) {
      for (const reference of result.receipt.references) {
        pushContextLedgerReference(digest, reference);
      }
      const label = result.receipt.failed
        ? "orphaned failed tool result"
        : result.receipt.pending
          ? "orphaned pending tool result"
          : "orphaned tool evidence";
      pushContextLedgerItem(
        result.receipt.failed ? digest.failures : digest.evidence,
        `${label}: ${result.receipt.summary || id}`
      );
    }
  }

  return digest;
}

function isExplicitContextLedgerAuthorization(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.includes("?")) return false;
  return CONTEXT_LEDGER_AUTHORIZATION.test(text)
    && !CONTEXT_LEDGER_AUTHORIZATION_DENIAL.test(text)
    && !CONTEXT_LEDGER_AUTHORIZATION_REPORTING.test(text)
    && !CONTEXT_LEDGER_AUTHORIZATION_CONDITIONAL.test(text);
}

function contextLedgerEvents(prefix, { redactValues = [] } = {}) {
  const events = [];
  for (let index = 0; index < prefix.length; index += 1) {
    if (events.length >= CONTEXT_LEDGER_MAX_EVENTS) {
      throw new RangeError("Context ledger event bound exceeded.");
    }
    const item = prefix[index];
    if (!item || typeof item !== "object") {
      const text = sanitizeContextLedgerText(item, redactValues);
      if (text) events.push({ kind: "event", text });
      continue;
    }
    if (isLiveContextSummaryMessage(item)) {
      const storedDigest = liveContextLedgerDigest(item);
      const references = (storedDigest
        ? contextLedgerReferences(storedDigest)
        : liveContextLedgerReferences(item))
        .map((reference) => sanitizeContextLedgerText(reference, redactValues))
        .filter((reference) => CONTEXT_LEDGER_REFERENCE.test(reference));
      events.push({
        kind: "prior-ledger",
        text: "",
        digest: storedDigest,
        references
      });
      continue;
    }
    if (isSyntheticContinueMessage(item)) continue;
    if (isContextLedgerPrivateType(item.type)) continue;
    if (item.type === "function_call") {
      events.push({
        kind: "tool-call",
        id: safeContextLedgerId(item.call_id, index, redactValues),
        name: safeContextLedgerName(item.name, redactValues),
        detail: renderContextLedgerValue(item.arguments, redactValues),
        text: ""
      });
      continue;
    }
    if (item.type === "function_call_output") {
      const text = renderContextLedgerValue(item.output, redactValues);
      events.push({
        kind: "tool-result",
        id: safeContextLedgerId(item.call_id, index, redactValues),
        text,
        receipt: parseContextLedgerToolReceipt(item.output, item, text, redactValues)
      });
      continue;
    }

    const role = item.role === "assistant"
      ? "assistant"
      : item.role === "user"
        ? "user"
        : null;
    if (!role) continue;
    if (typeof item.content === "string") {
      const text = sanitizeContextLedgerText(item.content, redactValues);
      if (text) events.push({ kind: role, text });
      continue;
    }
    if (!Array.isArray(item.content)) {
      const text = renderContextLedgerValue(item.content, redactValues);
      if (text) events.push({ kind: role, text });
      continue;
    }
    for (let blockIndex = 0; blockIndex < item.content.length; blockIndex += 1) {
      const block = item.content[blockIndex];
      if (events.length >= CONTEXT_LEDGER_MAX_EVENTS) {
        throw new RangeError("Context ledger event bound exceeded.");
      }
      if (!block || typeof block !== "object") {
        const text = sanitizeContextLedgerText(block, redactValues);
        if (text) events.push({ kind: role, text });
        continue;
      }
      if (isContextLedgerPrivateType(block.type)) continue;
      if (block.type === "text" || block.type === "input_text" || block.type === "output_text") {
        const text = sanitizeContextLedgerText(block.text, redactValues);
        if (text) events.push({ kind: role, text });
        continue;
      }
      if (block.type === "tool_use") {
        events.push({
          kind: "tool-call",
          id: safeContextLedgerId(block.id, `${index}-${blockIndex}`, redactValues),
          name: safeContextLedgerName(block.name, redactValues),
          detail: renderContextLedgerValue(block.input, redactValues),
          text: ""
        });
        continue;
      }
      if (block.type === "tool_result") {
        const text = renderContextLedgerValue(block.content, redactValues);
        events.push({
          kind: "tool-result",
          id: safeContextLedgerId(
            block.tool_use_id,
            `${index}-${blockIndex}`,
            redactValues
          ),
          text,
          receipt: parseContextLedgerToolReceipt(
            block.content,
            block,
            text,
            redactValues
          )
        });
        continue;
      }
      if (block.type === "image" || block.type === "input_image") {
        events.push({ kind: role, text: "[image omitted from older context]" });
        continue;
      }
      // Unknown provider blocks are not visible content. Skipping them is the
      // only forward-compatible way to ensure a new reasoning/signature block
      // cannot silently enter the ledger.
    }
  }
  return events;
}

function addContextLedgerToolReceipt(digest, call, result) {
  const receipt = result.receipt;
  const receiptName = String(call.name)
    .replace(/;/g, ",")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
  const status = receipt.failed
    ? receipt.semantic && receipt.status === "blocked"
      ? "blocked"
      : "failed"
    : receipt.pending
      ? "pending"
      : receipt.semantic
        ? receipt.status
        : "completed";
  const details = [
    receipt.code ? `code ${receipt.code}` : "",
    receipt.changed === true ? "changed state" : receipt.changed === false ? "no state change" : "",
    receipt.verification ? `verification ${receipt.verification}` : "",
    ...receipt.references
  ].filter(Boolean);
  pushContextLedgerItem(
    digest.toolReceipts,
    `${receiptName} ${status}${details.length > 0 ? `; ${details.join("; ")}` : ""}`,
    { retainLatest: true }
  );

  for (const reference of receipt.references) {
    pushContextLedgerReference(digest, reference);
    if (reference.startsWith("artifact:") || reference.startsWith("draft:")) {
      pushContextLedgerItem(digest.artifacts, reference);
    } else {
      pushContextLedgerItem(digest.evidence, reference);
    }
  }
  for (const artifact of receipt.artifacts) {
    pushContextLedgerItem(digest.artifacts, artifact);
  }

  if (receipt.pending) {
    pushContextLedgerItem(
      digest.pending,
      `${call.name}: ${receipt.summary || "tool result is pending"}`,
      { retainLatest: true }
    );
    for (const nextStep of receipt.nextSteps) {
      pushContextLedgerItem(digest.pending, nextStep, { retainLatest: true });
    }
    return;
  }
  if (receipt.failed) {
    const failure = `${call.name}: ${receipt.summary || receipt.code || "tool reported failure"}`;
    pushContextLedgerItem(digest.failures, failure, { retainLatest: true });
    pushContextLedgerItem(digest.blockers, failure, { retainLatest: true });
    return;
  }

  if (!receipt.semantic) {
    for (const artifact of [
      ...extractContextLedgerArtifacts(call.detail),
      ...extractContextLedgerArtifacts(result.text)
    ]) {
      pushContextLedgerItem(digest.artifacts, artifact);
    }
  }

  const legacyMutation = !receipt.semantic
    && CONTEXT_LEDGER_MUTATION_TOOL.test(call.name);
  if (receipt.changed === true || legacyMutation) {
    const resources = uniqueContextLedgerStrings([
      ...receipt.changedResources,
      ...extractContextLedgerResources(call.detail)
    ]);
    if (resources.length === 0) resources.push(call.name);
    for (const resource of resources) {
      pushContextLedgerItem(digest.changedResources, resource);
      pushContextLedgerItem(digest.changes, `${call.name}: ${resource}`);
    }
  } else {
    pushContextLedgerItem(
      digest.evidence,
      `${call.name}: ${receipt.summary || "completed"}`
    );
  }
}

function parseContextLedgerToolReceipt(value, item, text, redactValues) {
  const parsed = parseContextLedgerResultValue(value, redactValues);
  const outcome = contextLedgerObjectValue(parsed, "outcome");
  const status = contextLedgerStringValue(outcome, "status").toLowerCase();
  const semantic = ["succeeded", "failed", "blocked", "pending"].includes(status);
  const legacyStatus = contextLedgerStringValue(parsed, "status").toLowerCase();
  const nestedError = contextLedgerObjectValue(parsed, "error");
  const explicitError = contextLedgerStringValue(parsed, "error")
    || contextLedgerStringValue(nestedError, "message")
    || contextLedgerStringValue(nestedError, "error")
    || contextLedgerStringValue(nestedError, "code");
  const legacyFailureFlag = contextLedgerOwnValue(parsed, "success") === false
    || contextLedgerOwnValue(parsed, "failed") === true;
  const transportFailed = item?.is_error === true
    || item?.error === true
    || item?.ok === false;
  const contradictoryTransportFailure = transportFailed
    && semantic
    && status !== "failed"
    && status !== "blocked";
  const failed = transportFailed
    || (!semantic && contextLedgerOwnValue(parsed, "ok") === false)
    || status === "failed"
    || status === "blocked"
    || (!semantic && (
      ["error", "failed", "blocked", "denied"].includes(legacyStatus)
      || legacyFailureFlag
      || Boolean(explicitError)
      || CONTEXT_LEDGER_LEGACY_FAILURE_TEXT.test(String(text ?? ""))
    ));
  const pending = !failed && (
    status === "pending"
    || (!semantic && legacyStatus === "pending")
  );
  const changedValue = contextLedgerOwnValue(outcome, "changed");
  const changed = contradictoryTransportFailure
    ? null
    : changedValue === true
    ? true
    : changedValue === false
      ? false
      : null;
  const code = contradictoryTransportFailure
    ? ""
    : clipLiveText(contextLedgerStringValue(outcome, "code"), 64);
  const verification = contradictoryTransportFailure
    ? ""
    : clipLiveText(
      contextLedgerStringValue(contextLedgerObjectValue(outcome, "verification"), "status"),
      32
    );
  const collectedReferences = uniqueContextLedgerStrings([
    ...collectRawContextLedgerReferences(value, redactValues)
  ]);
  const references = contradictoryTransportFailure
    ? []
    : collectedReferences;
  const artifacts = uniqueContextLedgerStrings([
    ...references.filter((reference) => (
      reference.startsWith("artifact:") || reference.startsWith("draft:")
    ))
  ]);
  const changedResources = contradictoryTransportFailure
    ? []
    : extractContextLedgerChangedResources(parsed);
  const nextSteps = contradictoryTransportFailure
    ? []
    : contextLedgerStringArray(
      contextLedgerOwnValue(outcome, "nextSteps"),
      CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION
    );
  const summary = contradictoryTransportFailure
    ? "transport reported failure"
    : failed
    ? sanitizeContextLedgerText(
        explicitError
          || contextLedgerStringValue(parsed, "message")
          || code
          || clipLiveText(text, 160)
          || "tool reported failure",
        redactValues
      )
    : pending
      ? sanitizeContextLedgerText(
          contextLedgerStringValue(parsed, "message") || "tool result is pending",
          redactValues
        )
      : references[0] || (semantic ? code || "completed" : clipLiveText(text, 160));
  return {
    semantic,
    status: semantic ? status : failed ? "failed" : "completed",
    failed,
    pending,
    transportFailed,
    changed,
    code,
    verification,
    references,
    artifacts,
    changedResources,
    nextSteps,
    summary
  };
}

function parseContextLedgerResultValue(value, redactValues) {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > CONTEXT_LEDGER_MAX_RESULT_JSON_CHARS) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || utilTypes.isProxy(parsed)) return null;
  return sanitizeContextLedgerValue(parsed, redactValues);
}

function contextLedgerOwnValue(value, key) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function contextLedgerObjectValue(value, key) {
  const item = contextLedgerOwnValue(value, key);
  return item && typeof item === "object" && !Array.isArray(item) && !utilTypes.isProxy(item)
    ? item
    : null;
}

function contextLedgerStringValue(value, key) {
  const item = contextLedgerOwnValue(value, key);
  return typeof item === "string"
    ? item
    : typeof item === "number" || typeof item === "boolean" || typeof item === "bigint"
      ? String(item)
      : "";
}

function contextLedgerStringArray(value, maximum, redactValues = []) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return [];
  const descriptors = safeContextLedgerDescriptors(value);
  const length = Math.min(safeContextLedgerArrayLength(descriptors), maximum);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const text = sanitizeContextLedgerText(descriptor.value, redactValues);
    if (text) result.push(clipLiveText(text, CONTEXT_LEDGER_MAX_EXCERPT_CHARS));
  }
  return uniqueContextLedgerStrings(result);
}

function collectRawContextLedgerReferences(value, redactValues = []) {
  const references = [];
  let parsedNodes = 0;
  let scannedChars = 0;
  const addCandidate = (candidate, impliedKind = null) => {
    const normalized = normalizeContextLedgerReference(
      sanitizeContextLedgerText(candidate, redactValues),
      impliedKind
    );
    if (
      CONTEXT_LEDGER_REFERENCE.test(normalized)
      && !references.includes(normalized)
    ) {
      references.push(normalized);
    }
  };
  const addText = (text) => {
    if (typeof text !== "string") return;
    const matcher = new RegExp(
      CONTEXT_LEDGER_EMBEDDED_REFERENCE.source,
      CONTEXT_LEDGER_EMBEDDED_REFERENCE.flags
    );
    let match;
    while (
      references.length < CONTEXT_LEDGER_MAX_REFERENCES
      && (match = matcher.exec(text)) !== null
    ) {
      addCandidate(match[0]);
    }
  };
  if (
    typeof value !== "string"
    && (!value || typeof value !== "object" || utilTypes.isProxy(value))
  ) {
    return references;
  }

  const stack = [{ value, depth: 0, decodeDepth: 0, key: "" }];
  let visited = 0;
  while (
    stack.length > 0
    && visited < CONTEXT_LEDGER_MAX_REFERENCE_SCAN_NODES
    && references.length < CONTEXT_LEDGER_MAX_REFERENCES
  ) {
    const entry = stack.pop();
    visited += 1;
    if (typeof entry.value === "string") {
      scannedChars += entry.value.length;
      if (scannedChars > CONTEXT_LEDGER_MAX_SNAPSHOT_CHARS) {
        throw new RangeError("Context ledger reference scan exceeds the character bound.");
      }
      if (contextLedgerLooksLikeJsonValue(entry.value)) {
        if (entry.decodeDepth >= CONTEXT_LEDGER_MAX_JSON_DECODE_DEPTH) {
          throw new RangeError("Context ledger reference scan exceeds the JSON decode bound.");
        }
        const shape = contextLedgerJsonParseShape(entry.value);
        if (!shape.withinBounds) continue;
        parsedNodes += shape.nodes;
        if (parsedNodes > CONTEXT_LEDGER_MAX_SNAPSHOT_NODES) {
          throw new RangeError("Context ledger reference scan exceeds the node bound.");
        }
        let nested;
        try {
          nested = JSON.parse(entry.value);
        } catch {
          // Encoded structured values are never scanned as untrusted raw text.
          continue;
        }
        if (
          typeof nested === "string"
          || (nested && typeof nested === "object" && !utilTypes.isProxy(nested))
        ) {
          stack.push({
            value: nested,
            depth: entry.depth,
            decodeDepth: entry.decodeDepth + 1,
            key: typeof nested === "string" ? entry.key : ""
          });
        }
        continue;
      }
      if (entry.key === "ref" || entry.key === "outputRef") {
        addCandidate(entry.value, "tool-output");
      } else if (entry.key === "checkpointId") {
        addCandidate(entry.value, "checkpoint");
      } else if (entry.key === "artifactId") {
        addCandidate(entry.value, "artifact");
      } else if (entry.key === "draftId") {
        addCandidate(entry.value, "draft");
      } else {
        addText(entry.value);
      }
      continue;
    }
    if (
      !entry.value
      || typeof entry.value !== "object"
      || utilTypes.isProxy(entry.value)
      || entry.depth >= CONTEXT_LEDGER_MAX_VALUE_DEPTH
    ) {
      continue;
    }
    const type = contextLedgerStringValue(entry.value, "type");
    if (type && isContextLedgerPrivateType(type)) continue;
    for (const [key, child] of safeContextLedgerDataEntries(entry.value)
      .filter(([key]) => (
        !isContextLedgerPrivateKey(key)
        && !isContextLedgerSensitiveKey(key)
      ))
      .reverse()) {
      stack.push({
        value: child,
        depth: entry.depth + 1,
        decodeDepth: 0,
        key
      });
    }
  }
  if (
    stack.length > 0
    && references.length < CONTEXT_LEDGER_MAX_REFERENCES
  ) {
    throw new RangeError("Context ledger reference scan exceeds the traversal bound.");
  }
  return references;
}

function contextLedgerLooksLikeJsonValue(value) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (
      character === " "
      || character === "\t"
      || character === "\r"
      || character === "\n"
      || character === "\uFEFF"
    ) {
      continue;
    }
    return character === "{" || character === "[" || character === "\"";
  }
  return false;
}

function decodeContextLedgerJsonValue(value) {
  let decoded = value;
  let decodedLayers = 0;
  let parsedNodes = 0;
  let scannedChars = 0;
  while (
    typeof decoded === "string"
    && contextLedgerLooksLikeJsonValue(decoded)
  ) {
    if (decodedLayers >= CONTEXT_LEDGER_MAX_JSON_DECODE_DEPTH) {
      return { status: "overflow", value: null };
    }
    scannedChars += decoded.length;
    if (scannedChars > CONTEXT_LEDGER_MAX_SNAPSHOT_CHARS) {
      return { status: "overflow", value: null };
    }
    const shape = contextLedgerJsonParseShape(decoded);
    parsedNodes += shape.nodes;
    if (
      !shape.withinBounds
      || parsedNodes > CONTEXT_LEDGER_MAX_SNAPSHOT_NODES
    ) {
      return { status: "overflow", value: null };
    }
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return { status: "malformed", value: null };
    }
    decodedLayers += 1;
  }
  return {
    status: decodedLayers > 0 ? "decoded" : "plain",
    value: decoded
  };
}

function contextLedgerJsonParseShape(value) {
  let depth = 0;
  let nodes = 1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      nodes += 1;
      if (depth > CONTEXT_LEDGER_MAX_VALUE_DEPTH) {
        return { withinBounds: false, nodes };
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return { withinBounds: false, nodes };
    } else if (character === ",") {
      nodes += 1;
    }
    if (nodes > CONTEXT_LEDGER_MAX_SNAPSHOT_NODES) {
      return { withinBounds: false, nodes };
    }
  }
  return {
    withinBounds: !inString && depth === 0,
    nodes
  };
}

function normalizeContextLedgerReference(candidate, impliedKind = null) {
  let normalized = typeof candidate === "string" ? candidate.trim() : "";
  if (!normalized) return "";
  if (impliedKind && !normalized.includes(":")) normalized = `${impliedKind}:${normalized}`;
  if (/^out_[a-f0-9]{16}$/.test(normalized)) normalized = `tool-output:${normalized}`;
  return normalized;
}

function extractContextLedgerChangedResources(value) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return [];
  const resources = [];
  const resourceKeys = new Set([
    "path",
    "paths",
    "file",
    "files",
    "resource",
    "resources",
    "changedFiles",
    "restored",
    "removed"
  ]);
  for (const [key, item] of safeContextLedgerDataEntries(value)) {
    if (!resourceKeys.has(key)) continue;
    if (typeof item === "string") {
      resources.push(sanitizeContextLedgerText(item));
    } else if (Array.isArray(item)) {
      resources.push(...contextLedgerStringArray(item, CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION));
    }
  }
  return uniqueContextLedgerStrings(resources);
}

function extractContextLedgerResources(value) {
  const text = String(value ?? "");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A legacy textual call can still contribute a bounded file resource.
  }
  return uniqueContextLedgerStrings([
    ...extractContextLedgerChangedResources(parsed),
    ...extractContextLedgerArtifacts(text)
  ]);
}

function uniqueContextLedgerStrings(values) {
  const unique = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const text = clipLiveText(value, CONTEXT_LEDGER_MAX_EXCERPT_CHARS);
    if (text && !unique.includes(text)) unique.push(text);
  }
  return unique;
}

function pushContextLedgerReference(digest, value) {
  const reference = typeof value === "string" ? value.trim() : "";
  if (!CONTEXT_LEDGER_REFERENCE.test(reference)) return;
  if (digest.references.includes(reference)) return;
  if (digest.references.length >= CONTEXT_LEDGER_MAX_REFERENCES) {
    throw new RangeError("Context ledger reference bound exceeded.");
  }
  digest.references.push(reference);
}

function contextLedgerReferences(digest) {
  if (!digest || typeof digest !== "object") return [];
  const references = [];
  for (const value of [
    ...(Array.isArray(digest.references) ? digest.references : []),
    ...(Array.isArray(digest.artifacts) ? digest.artifacts : []),
    ...(Array.isArray(digest.evidence) ? digest.evidence : [])
  ]) {
    if (
      typeof value === "string"
      && CONTEXT_LEDGER_REFERENCE.test(value)
      && !references.includes(value)
    ) references.push(value);
  }
  return references.slice(0, CONTEXT_LEDGER_MAX_REFERENCES);
}

function mergePriorContextLedger(target, prior, redactValues = []) {
  if (!prior || typeof prior !== "object" || utilTypes.isProxy(prior)) return;
  const sections = [
    "objective",
    "authorization",
    "decisions",
    "toolReceipts",
    "changes",
    "changedResources",
    "evidence",
    "artifacts",
    "pending",
    "blockers",
    "failures",
    "next"
  ];
  for (const section of sections) {
    const values = contextLedgerOwnValue(prior, section);
    if (!Array.isArray(values)) continue;
    for (const value of contextLedgerStringArray(
      values,
      CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION,
      redactValues
    )) {
      pushContextLedgerItem(target[section], value, {
        retainLatest: ["objective", "authorization", "decisions", "pending", "blockers", "failures", "next"]
          .includes(section)
      });
    }
  }
  for (const reference of contextLedgerReferences(prior)) {
    pushContextLedgerReference(
      target,
      sanitizeContextLedgerText(reference, redactValues)
    );
  }
}

function renderContextLedgerValue(value, redactValues = []) {
  if (typeof value === "string") {
    const decoded = decodeContextLedgerJsonValue(value);
    if (decoded.status === "overflow") {
      return "[structured result omitted]";
    }
    if (decoded.status === "malformed") {
      return "[malformed structured result omitted]";
    }
    if (decoded.status === "decoded") {
      const sanitized = typeof decoded.value === "string"
        ? sanitizeContextLedgerText(decoded.value, redactValues)
        : sanitizeContextLedgerValue(decoded.value, redactValues);
      return clipLiveText(
        safeLiveJson(sanitized),
        CONTEXT_LEDGER_MAX_EXCERPT_CHARS
      );
    }
    return clipLiveText(
      sanitizeContextLedgerText(value, redactValues),
      CONTEXT_LEDGER_MAX_EXCERPT_CHARS
    );
  }
  return clipLiveText(
    safeLiveJson(sanitizeContextLedgerValue(value, redactValues)),
    CONTEXT_LEDGER_MAX_EXCERPT_CHARS
  );
}

function safeContextLedgerId(value, fallback, redactValues = []) {
  const safeValue = typeof value === "string" || typeof value === "number"
    ? value
    : fallback;
  const text = sanitizeContextLedgerText(safeValue, redactValues);
  return clipLiveText(text || String(fallback), 128);
}

function safeContextLedgerName(value, redactValues = []) {
  const text = sanitizeContextLedgerText(
    typeof value === "string" ? value : "unknown",
    redactValues
  );
  return clipLiveText(text || "unknown", 128);
}

function pushContextLedgerItem(target, value, { retainLatest = false } = {}) {
  const text = clipLiveText(value, CONTEXT_LEDGER_MAX_EXCERPT_CHARS);
  if (!text || target.includes(text)) return;
  if (target.length >= CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION) {
    if (!retainLatest) return;
    target.shift();
  }
  target.push(text);
}

function extractContextLedgerArtifacts(value) {
  const text = typeof value === "string" ? value : "";
  const pattern = /(?:[A-Za-z]:[\\/]|\/|~\/)[^\s"'`<>]{1,240}\.(?:bmp|csv|docx?|gif|html?|jpe?g|json|md|odt|ods|odp|pdf|png|pptx?|rtf|svg|tsv|txt|webp|xlsx?|xml|ya?ml|zip)\b/gi;
  return (text.match(pattern) ?? [])
    .map((item) => sanitizeContextLedgerText(item))
    .slice(0, CONTEXT_LEDGER_MAX_ITEMS_PER_SECTION);
}

function renderStructuredContextLedger(
  digest,
  { includeReferences = true } = {}
) {
  const lines = [`Context ledger v${CONTEXT_LEDGER_VERSION}.`];
  for (const [label, items] of contextLedgerSections(digest, {
    includeReferences
  })) {
    if (!Array.isArray(items) || items.length === 0) continue;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`- ${item}`);
  }
  if (digest.overview) {
    lines.push("Optional overview:");
    lines.push(`- ${clipLiveText(digest.overview, CONTEXT_LEDGER_MAX_EXCERPT_CHARS * 2)}`);
  }
  return lines.join("\n");
}

function contextLedgerSections(digest, { includeReferences = true } = {}) {
  const sections = [
    ["Objective", digest.objective],
    ["Authorization context (not a policy grant)", digest.authorization],
    ["Decisions", digest.decisions],
    ["Tool receipts", digest.toolReceipts],
    ["Changes", digest.changes],
    ["Changed resources", digest.changedResources],
    ["Evidence", digest.evidence],
    ["Artifacts", digest.artifacts],
    ["Pending", digest.pending],
    ["Blockers", digest.blockers],
    ["Failures", digest.failures],
    ["Next", digest.next]
  ];
  if (includeReferences) {
    sections.unshift(["Durable references", digest.references]);
  }
  return sections;
}

function liveContextSerializedChars(value) {
  const maxChars = 64_000_000;
  let chars;
  try {
    chars = boundedJsonChars(value, maxChars);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  return chars > maxChars ? Number.MAX_SAFE_INTEGER : chars;
}

function firstTokenCount(...values) {
  for (const value of values) {
    const parsed = tokenCount(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tokenCount(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

function positiveTokenCount(value) {
  const parsed = tokenCount(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function positiveSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sumTokenCounts(values) {
  let total = 0;
  for (const value of values) {
    const parsed = tokenCount(value);
    if (parsed !== null) total = Math.min(Number.MAX_SAFE_INTEGER, total + parsed);
  }
  return total;
}

function liveBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function liveBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boundedJsonChars(value, maxChars) {
  const overflow = maxChars + 1;
  const ancestors = new Set();

  const visit = (node, remaining, arraySlot = false) => {
    if (remaining < 0) return overflow;
    if (node === null) return remaining >= 4 ? 4 : overflow;
    if (typeof node === "string") {
      if (node.length + 2 > remaining) return overflow;
      const length = JSON.stringify(node).length;
      return length <= remaining ? length : overflow;
    }
    if (typeof node === "number") {
      const length = Number.isFinite(node) ? String(node).length : 4;
      return length <= remaining ? length : overflow;
    }
    if (typeof node === "boolean") return remaining >= (node ? 4 : 5) ? (node ? 4 : 5) : overflow;
    if (typeof node === "bigint") return overflow;
    if (typeof node === "undefined" || typeof node === "function" || typeof node === "symbol") {
      return arraySlot ? (remaining >= 4 ? 4 : overflow) : 0;
    }
    if (ancestors.has(node)) return overflow;
    ancestors.add(node);
    let total = 2;
    if (total > remaining) {
      ancestors.delete(node);
      return overflow;
    }

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (index > 0) total += 1;
        const child = visit(node[index], remaining - total, true);
        if (child === overflow || total + child > remaining) {
          ancestors.delete(node);
          return overflow;
        }
        total += child;
      }
    } else {
      let emitted = 0;
      for (const [key, childValue] of Object.entries(node)) {
        if (["undefined", "function", "symbol"].includes(typeof childValue)) continue;
        if (emitted > 0) total += 1;
        const keyLength = JSON.stringify(key).length + 1;
        if (total + keyLength > remaining) {
          ancestors.delete(node);
          return overflow;
        }
        total += keyLength;
        const child = visit(childValue, remaining - total, false);
        if (child === overflow || total + child > remaining) {
          ancestors.delete(node);
          return overflow;
        }
        total += child;
        emitted += 1;
      }
    }
    ancestors.delete(node);
    return total <= remaining ? total : overflow;
  };

  return visit(value, maxChars, false);
}

function cloneContextValue(value) {
  const state = {
    nodes: 0,
    chars: 0,
    seen: new WeakSet()
  };
  const root = createContextCloneContainer(value, state, 0);
  if (!root.pending) return root.value;

  const pending = [{
    source: value,
    target: root.value,
    descriptors: root.descriptors,
    depth: 0
  }];
  while (pending.length > 0) {
    const { source, target, descriptors, depth } = pending.pop();
    for (const [key, descriptor] of enumerableContextLedgerDescriptors(descriptors)) {
      const child = descriptor.value;
      const clone = createContextCloneContainer(child, state, depth + 1);
      defineContextLedgerData(target, key, clone.value);
      if (clone.pending) {
        pending.push({
          source: child,
          target: clone.value,
          descriptors: clone.descriptors,
          depth: depth + 1
        });
      }
    }
    copyLiveContextMetadata(source, target);
  }
  return root.value;
}

function createContextCloneContainer(value, state, depth) {
  if (depth > CONTEXT_LEDGER_MAX_SNAPSHOT_DEPTH) {
    throw new RangeError("Context snapshot exceeds the depth bound.");
  }
  state.nodes += 1;
  if (state.nodes > CONTEXT_LEDGER_MAX_SNAPSHOT_NODES) {
    throw new RangeError("Context snapshot exceeds the node bound.");
  }
  if (value === null) return { value: null, pending: false };
  if (typeof value === "string") {
    state.chars += value.length;
    if (state.chars > CONTEXT_LEDGER_MAX_SNAPSHOT_CHARS) {
      throw new RangeError("Context snapshot exceeds the character bound.");
    }
    return { value, pending: false };
  }
  if (typeof value === "boolean") return { value, pending: false };
  if (typeof value === "number") {
    return { value: Number.isFinite(value) ? value : null, pending: false };
  }
  if (
    value === undefined
    || typeof value === "bigint"
    || typeof value === "function"
    || typeof value === "symbol"
  ) {
    throw new TypeError("Context snapshots require plain JSON values.");
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("Context snapshots reject unsafe objects.");
  }
  if (state.seen.has(value)) {
    throw new TypeError("Context snapshots reject cycles and shared object references.");
  }
  state.seen.add(value);

  if (utilTypes.isDate(value)) {
    return {
      value: new Date(Date.prototype.getTime.call(value)),
      pending: false
    };
  }
  if (ArrayBuffer.isView(value)) {
    throw new TypeError("Context snapshots reject binary views.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Context snapshots require plain objects.");
  }
  const descriptors = safeContextLedgerDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "string") {
      state.chars += key.length;
      if (state.chars > CONTEXT_LEDGER_MAX_SNAPSHOT_CHARS) {
        throw new RangeError("Context snapshot exceeds the character bound.");
      }
    }
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Context snapshots reject accessors.");
    }
    if (typeof descriptor.value === "function" || typeof descriptor.value === "symbol") {
      throw new TypeError("Context snapshots reject executable values.");
    }
  }

  if (Array.isArray(value)) {
    const length = safeContextLedgerArrayLength(descriptors);
    if (length > CONTEXT_LEDGER_MAX_ARRAY_LENGTH) {
      throw new RangeError("Context snapshot array exceeds the length bound.");
    }
    for (let index = 0; index < length; index += 1) {
      if (!descriptors[String(index)]) {
        throw new TypeError("Context snapshots reject sparse arrays.");
      }
    }
    return {
      value: new Array(length),
      pending: true,
      descriptors
    };
  }
  return {
    value: {},
    pending: true,
    descriptors
  };
}

function contextLedgerSourceIdentity(value) {
  const snapshot = cloneContextValue(value);
  const hash = createHash("sha256");
  const pending = [{ kind: "value", value: snapshot }];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry.kind === "token") {
      hash.update(entry.value);
      continue;
    }
    const item = entry.value;
    nodes += 1;
    if (nodes > CONTEXT_LEDGER_MAX_SNAPSHOT_NODES) {
      throw new RangeError("Context identity exceeds the node bound.");
    }
    if (item === null) {
      hash.update("N;");
    } else if (typeof item === "string") {
      hash.update(`S${Buffer.byteLength(item, "utf8")}:`);
      hash.update(item);
      hash.update(";");
    } else if (typeof item === "boolean") {
      hash.update(item ? "B1;" : "B0;");
    } else if (typeof item === "number") {
      hash.update(`D${Object.is(item, -0) ? "-0" : String(item)};`);
    } else if (utilTypes.isDate(item)) {
      hash.update(`T${Date.prototype.getTime.call(item)};`);
    } else if (Array.isArray(item)) {
      const descriptors = safeContextLedgerDescriptors(item);
      const length = safeContextLedgerArrayLength(descriptors);
      hash.update(`A${length}[`);
      pending.push({ kind: "token", value: "]" });
      for (let index = length - 1; index >= 0; index -= 1) {
        pending.push({ kind: "value", value: descriptors[String(index)].value });
      }
    } else if (typeof item === "object") {
      const descriptors = safeContextLedgerDescriptors(item);
      const entries = enumerableContextLedgerDescriptors(descriptors);
      hash.update(`O${entries.length}{`);
      pending.push({ kind: "token", value: "}" });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, descriptor] = entries[index];
        pending.push({ kind: "value", value: descriptor.value });
        pending.push({ kind: "token", value: `K${Buffer.byteLength(key, "utf8")}:${key};` });
      }
      if (isLiveContextSummaryMessage(item)) hash.update("M1;");
      if (isSyntheticContinueMessage(item)) hash.update("C1;");
    } else {
      throw new TypeError("Context identity encountered an unsupported value.");
    }
  }
  return hash.digest("hex");
}

function safeFailOpenContextSnapshot(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return [];
  let descriptors;
  let length;
  try {
    descriptors = safeContextLedgerDescriptors(value);
    length = safeContextLedgerArrayLength(descriptors);
  } catch {
    return [];
  }
  const maximum = Math.min(length, 1_024);
  const start = Math.max(0, length - maximum);
  const reverseSnapshot = [];
  let snapshotChars = 2;
  for (let index = length - 1; index >= start; index -= 1) {
    const descriptor = descriptors[String(index)];
    let item;
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      item = { ...CONTEXT_LEDGER_OMITTED_ITEM };
    } else {
      try {
        item = cloneContextValue(descriptor.value);
      } catch {
        item = { ...CONTEXT_LEDGER_OMITTED_ITEM };
      }
    }
    let itemChars = liveContextSerializedChars(item);
    if (
      itemChars === Number.MAX_SAFE_INTEGER
      || itemChars > CONTEXT_LEDGER_FAIL_OPEN_SNAPSHOT_CHARS
    ) {
      item = { ...CONTEXT_LEDGER_OMITTED_ITEM };
      itemChars = liveContextSerializedChars(item);
    }
    const separatorChars = reverseSnapshot.length > 0 ? 1 : 0;
    if (
      snapshotChars + separatorChars + itemChars
      > CONTEXT_LEDGER_FAIL_OPEN_SNAPSHOT_CHARS
    ) {
      break;
    }
    reverseSnapshot.push(item);
    snapshotChars += separatorChars + itemChars;
  }
  return reverseSnapshot.reverse();
}

function normalizeContextLedgerOptions(options) {
  if (!options || typeof options !== "object" || utilTypes.isProxy(options)) return {};
  const normalized = {};
  for (const key of [
    "format",
    "keepRecentHops",
    "keepRecentTurns",
    "maxDigestChars",
    "redactValues",
    "redactionOverflow",
    "summarizer",
    "summarizerTimeoutMs",
    "valueAwareCompaction",
    "valueAwareTargetChars"
  ]) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(options, key);
    } catch {
      return {};
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const value = descriptor.value;
    if (key === "summarizer") {
      if (typeof value === "function" && !utilTypes.isProxy(value)) {
        normalized[key] = value;
      }
      continue;
    }
    if (key === "redactValues") {
      if (
        !utilTypes.isProxy(value)
        && (Array.isArray(value) || utilTypes.isSet(value))
      ) normalized[key] = value;
      continue;
    }
    if (key === "redactionOverflow") {
      if (typeof value === "boolean") normalized[key] = value;
      continue;
    }
    if (key === "valueAwareCompaction") {
      if (typeof value === "boolean") normalized[key] = value;
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function runBoundedContextLedgerSummarizer(
  summarizer,
  prefix,
  metadata,
  requestedTimeoutMs
) {
  const timeoutMs = liveBoundedInteger(
    requestedTimeoutMs,
    DEFAULT_CONTEXT_LEDGER_SUMMARIZER_TIMEOUT_MS,
    1,
    MAX_CONTEXT_LEDGER_SUMMARIZER_TIMEOUT_MS
  );
  if (!CONTEXT_LEDGER_COOPERATIVE_SUMMARIZERS.has(summarizer)) {
    return runWorkerContextLedgerSummarizer(
      summarizer,
      prefix,
      metadata,
      timeoutMs
    );
  }
  const controller = new AbortController();
  const sandbox = Object.create(null);
  Object.defineProperties(sandbox, {
    summarizer: {
      value: summarizer,
      enumerable: true
    },
    prefix: {
      value: prefix,
      enumerable: true
    },
    metadata: {
      value: {
        ...metadata,
        signal: controller.signal
      },
      enumerable: true
    }
  });

  let proposed;
  try {
    proposed = runInContext(
      "summarizer(prefix, metadata)",
      createContext(sandbox, {
        codeGeneration: {
          strings: false,
          wasm: false
        }
      }),
      {
        timeout: timeoutMs,
        displayErrors: false
      }
    );
  } catch {
    try {
      controller.abort();
    } catch {
      // Optional cancellation must not replace deterministic fallback.
    }
    return null;
  }
  try {
    if (utilTypes.isPromise(proposed)) {
      try {
        Promise.prototype.then.call(proposed, undefined, () => {});
      } catch {
        // A cross-realm or hostile promise is ignored.
      }
      return null;
    }
    return typeof proposed === "string"
      ? proposed.slice(0, 4096)
      : null;
  } finally {
    try {
      controller.abort();
    } catch {
      // The summarizer is optional and cancellation is best effort.
    }
  }
}

function runWorkerContextLedgerSummarizer(
  summarizer,
  prefix,
  metadata,
  timeoutMs
) {
  let source;
  try {
    source = Function.prototype.toString.call(summarizer);
  } catch {
    return Promise.resolve(null);
  }
  if (
    !source
    || source.length > MAX_CONTEXT_LEDGER_SUMMARIZER_SOURCE_CHARS
    || /\[native code\]/u.test(source)
  ) {
    return Promise.resolve(null);
  }
  source = source.replace(
    /^async\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/u,
    "async function $1("
  );

  const workerSource = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  let summarize;
  try {
    summarize = (0, eval)("(" + workerData.source + ")");
  } catch {
    parentPort.postMessage({ status: "rejected", value: null });
    return;
  }
  if (typeof summarize !== "function") {
    parentPort.postMessage({ status: "rejected", value: null });
    return;
  }
  try {
    const controller = new AbortController();
    const value = await summarize(workerData.prefix, {
      ...workerData.metadata,
      signal: controller.signal
    });
    parentPort.postMessage({
      status: "fulfilled",
      value: typeof value === "string" ? value.slice(0, 4096) : null
    });
  } catch {
    parentPort.postMessage({ status: "rejected", value: null });
  }
})();
`;

  let worker;
  try {
    worker = new Worker(workerSource, {
      eval: true,
      env: {},
      argv: [],
      execArgv: [],
      workerData: {
        source,
        prefix,
        metadata
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 4,
        stackSizeMb: 1
      }
    });
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      try {
        const termination = worker.terminate();
        if (termination && typeof termination.catch === "function") {
          termination.catch(() => {});
        }
      } catch {
        // The worker may already have exited.
      }
      resolve(value);
    };
    worker.once("message", (message) => {
      finish(
        message?.status === "fulfilled" && typeof message.value === "string"
          ? message.value
          : null
      );
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function freezeContextLedgerValue(value) {
  if (!value || typeof value !== "object") return value;
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const descriptors = safeContextLedgerDescriptors(item);
    for (const descriptor of Object.values(descriptors)) {
      if (Object.hasOwn(descriptor, "value")
        && descriptor.value
        && typeof descriptor.value === "object") {
        pending.push(descriptor.value);
      }
    }
    Object.freeze(item);
  }
  return value;
}

function safeContextLedgerDescriptors(value) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("Context ledger values must be non-proxy objects.");
  }
  const descriptors = Object.create(null);
  const remember = (key, descriptor) => {
    if (!descriptor) return;
    Object.defineProperty(descriptors, key, {
      value: descriptor,
      enumerable: true,
      configurable: true,
      writable: true
    });
  };

  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    remember("length", length);
    const boundedLength = safeContextLedgerArrayLength(descriptors);
    for (let index = 0; index < boundedLength; index += 1) {
      remember(String(index), Object.getOwnPropertyDescriptor(value, String(index)));
    }
  } else {
    let keys = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      keys += 1;
      if (keys > CONTEXT_LEDGER_MAX_OBJECT_KEYS) {
        throw new RangeError("Context ledger object exceeds the key bound.");
      }
      remember(key, Object.getOwnPropertyDescriptor(value, key));
    }
  }

  for (const symbol of [
    LIVE_CONTEXT_SUMMARY,
    LIVE_CONTEXT_SYNTHETIC_TURN,
    LIVE_CONTEXT_LEDGER_REFERENCES,
    LIVE_CONTEXT_LEDGER_DIGEST
  ]) {
    remember(symbol, Object.getOwnPropertyDescriptor(value, symbol));
  }
  return descriptors;
}

function safeContextLedgerArrayLength(descriptors) {
  const length = descriptors.length;
  if (
    !length
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > CONTEXT_LEDGER_MAX_ARRAY_LENGTH
  ) {
    throw new RangeError("Context ledger array length is invalid.");
  }
  return length.value;
}

function enumerableContextLedgerDescriptors(descriptors) {
  const entries = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || key === "length") continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Context ledger values must not contain accessors.");
    }
    entries.push([key, descriptor]);
  }
  return entries;
}

function safeContextLedgerDataEntries(value) {
  return enumerableContextLedgerDescriptors(safeContextLedgerDescriptors(value))
    .map(([key, descriptor]) => [key, descriptor.value]);
}

function defineContextLedgerData(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function resolveLiveContextFormat(conversation, requested) {
  if (requested === "openai" || requested === "anthropic") return requested;
  return conversation.some((message) => (
    Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "tool_use" || block?.type === "tool_result")
  )) ? "anthropic" : "openai";
}

function liveContextRecentBoundary(conversation, keepRecentRoleMessages) {
  let rolesSeen = 0;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if ((conversation[index]?.role === "user" || conversation[index]?.role === "assistant")
      && !isLiveContextSummaryMessage(conversation[index])
      && !isSyntheticContinueMessage(conversation[index])) {
      rolesSeen += 1;
      if (rolesSeen >= keepRecentRoleMessages) return index;
    }
  }
  // OpenAI response transcripts can contain many function call/output items
  // after only one role message. Fall back to an item suffix so those turns
  // can still shrink; the pair-boundary pass below keeps completed hops whole.
  return Math.max(0, conversation.length - keepRecentRoleMessages);
}

function liveContextSummaryStart(conversation, boundary) {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role !== "user" && conversation[index]?.role !== "assistant") continue;
    if (isLiveContextSummaryMessage(conversation[index])) continue;
    if (isSyntheticContinueMessage(conversation[index])) continue;
    // A tool-heavy Responses transcript can have its only/current user turn
    // before the item suffix. Keep that role object verbatim and summarize the
    // completed tool hops that follow it instead of moving the user turn into
    // the digest.
    return index < boundary ? index + 1 : 0;
  }
  return 0;
}

function isLiveContextSummaryMessage(message) {
  return message?.[LIVE_CONTEXT_SUMMARY] === true;
}

function createLiveContextSummaryMessage(content, references = [], digest = null) {
  const message = { role: "user", content };
  Object.defineProperty(message, LIVE_CONTEXT_SUMMARY, { value: true });
  Object.defineProperty(message, LIVE_CONTEXT_LEDGER_REFERENCES, {
    value: Object.freeze([...references]),
    enumerable: false
  });
  if (digest) {
    Object.defineProperty(message, LIVE_CONTEXT_LEDGER_DIGEST, {
      value: digest,
      enumerable: false
    });
  }
  return message;
}

function copyLiveContextMetadata(source, target) {
  const summary = Object.getOwnPropertyDescriptor(source, LIVE_CONTEXT_SUMMARY);
  if (summary && Object.hasOwn(summary, "value") && summary.value === true) {
    Object.defineProperty(target, LIVE_CONTEXT_SUMMARY, { value: true });
  }
  const synthetic = Object.getOwnPropertyDescriptor(source, LIVE_CONTEXT_SYNTHETIC_TURN);
  if (synthetic && Object.hasOwn(synthetic, "value") && synthetic.value === true) {
    Object.defineProperty(target, LIVE_CONTEXT_SYNTHETIC_TURN, { value: true });
  }
  const references = Object.getOwnPropertyDescriptor(source, LIVE_CONTEXT_LEDGER_REFERENCES);
  if (references && Object.hasOwn(references, "value") && Array.isArray(references.value)) {
    Object.defineProperty(target, LIVE_CONTEXT_LEDGER_REFERENCES, {
      value: references.value,
      enumerable: false
    });
  }
  const digest = Object.getOwnPropertyDescriptor(source, LIVE_CONTEXT_LEDGER_DIGEST);
  if (digest && Object.hasOwn(digest, "value") && digest.value) {
    Object.defineProperty(target, LIVE_CONTEXT_LEDGER_DIGEST, {
      value: digest.value,
      enumerable: false
    });
  }
}

function liveContextLedgerReferences(message) {
  const descriptor = message && typeof message === "object"
    ? Object.getOwnPropertyDescriptor(message, LIVE_CONTEXT_LEDGER_REFERENCES)
    : null;
  if (descriptor && Object.hasOwn(descriptor, "value") && Array.isArray(descriptor.value)) {
    return descriptor.value.filter((value) => (
      typeof value === "string" && CONTEXT_LEDGER_REFERENCE.test(value)
    ));
  }
  const content = typeof message?.content === "string" ? message.content : "";
  const references = [];
  const matcher = new RegExp(
    CONTEXT_LEDGER_EMBEDDED_REFERENCE.source,
    CONTEXT_LEDGER_EMBEDDED_REFERENCE.flags
  );
  let match;
  while (
    references.length < CONTEXT_LEDGER_MAX_REFERENCES
    && (match = matcher.exec(content)) !== null
  ) {
    const reference = normalizeContextLedgerReference(match[0]);
    if (reference && !references.includes(reference)) references.push(reference);
  }
  return references;
}

function liveContextLedgerDigest(message) {
  const descriptor = message && typeof message === "object"
    ? Object.getOwnPropertyDescriptor(message, LIVE_CONTEXT_LEDGER_DIGEST)
    : null;
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : null;
}

function isSyntheticContinueMessage(message) {
  return message?.[LIVE_CONTEXT_SYNTHETIC_TURN] === true;
}

function adjustLiveToolPairBoundary(conversation, format, initialBoundary) {
  let boundary = initialBoundary;
  if (boundary <= 0) return boundary;
  const pairs = liveContextToolPairs(conversation, format);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [callIndex, resultIndex] of pairs) {
      if ((callIndex < boundary) !== (resultIndex < boundary)) {
        const nextBoundary = Math.min(boundary, callIndex, resultIndex);
        if (nextBoundary < boundary) {
          boundary = nextBoundary;
          changed = true;
        }
      }
    }
  }
  return boundary;
}

function adjustLiveToolPairSummaryStart(conversation, format, initialStart, boundary) {
  let start = initialStart;
  if (start <= 0 || start >= boundary) return start;
  const pairs = liveContextToolPairs(conversation, format);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [callIndex, resultIndex] of pairs) {
      if ((callIndex < start) !== (resultIndex < start)) {
        const nextStart = Math.max(start, callIndex + 1, resultIndex + 1);
        if (nextStart > start) {
          start = nextStart;
          changed = true;
        }
      }
    }
  }
  return start;
}

function liveContextToolPairs(conversation, format) {
  const calls = new Map();
  const results = new Map();
  const push = (target, id, index) => {
    if (!id) return;
    const queue = target.get(id) ?? [];
    queue.push(index);
    target.set(id, queue);
  };
  if (format === "anthropic") {
    conversation.forEach((message, index) => {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === "tool_use") push(calls, block.id, index);
        if (block?.type === "tool_result") push(results, block.tool_use_id, index);
      }
    });
  } else {
    conversation.forEach((item, index) => {
      if (item?.type === "function_call") push(calls, item.call_id, index);
      if (item?.type === "function_call_output") push(results, item.call_id, index);
    });
  }

  const pairs = [];
  for (const [id, callQueue] of calls) {
    const resultQueue = results.get(id) ?? [];
    const pairCount = Math.min(callQueue.length, resultQueue.length);
    for (let index = 0; index < pairCount; index += 1) {
      pairs.push([callQueue[index], resultQueue[index]]);
    }
  }
  return pairs;
}

function safeLiveJson(value) {
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}

function liveContextSummaryMarker(
  summary,
  maxChars,
  mandatoryReferences = [],
  digest = null
) {
  const open = "[context summary]\n";
  const close = "\n[/context summary]";
  const references = mandatoryReferences.length > 0
    ? `\nDurable references (exact):\n${mandatoryReferences
      .map((reference) => `- ${reference}`)
      .join("\n")}`
    : "";
  // Exact durable references count against the requested marker budget. The
  // candidate installer rejects this transient marker if the exact block alone
  // cannot fit, retaining the uncompressed source instead.
  const bodyLimit = Math.max(
    0,
    maxChars - open.length - close.length - references.length
  );
  const body = digest
    ? renderBoundedContextLedger(digest, bodyLimit, mandatoryReferences)
    : clipContextLedgerLines(String(summary ?? "").trim(), bodyLimit);
  return `${open}${body}${references}${close}`;
}

function renderBoundedContextLedger(
  digest,
  maxChars,
  mandatoryReferences = []
) {
  const header = `Context ledger v${CONTEXT_LEDGER_VERSION}.`;
  if (maxChars <= header.length) return clipContextLedgerLines(header, maxChars);
  const exactReferences = new Set(mandatoryReferences);
  const availableSections = contextLedgerSections(digest, { includeReferences: false })
    .map(([label, items]) => {
      if (!Array.isArray(items)) return [label, items];
      const cleaned = items.map((item) => {
            let text = String(item ?? "");
            for (const reference of exactReferences) {
              text = text.split(reference).join("");
            }
            return text
              .replace(/;\s*;/g, ";")
              .replace(/;\s*$/g, "")
              .trim();
          }).filter(Boolean);
      if (
        cleaned.length === 0
        && items.some((item) => exactReferences.has(String(item ?? "")))
      ) {
        cleaned.push("See exact durable references below.");
      }
      return [label, cleaned];
    })
    .filter(([, items]) => Array.isArray(items) && items.length > 0);
  if (digest.overview) {
    let overview = String(digest.overview);
    for (const reference of exactReferences) {
      overview = overview.split(reference).join("");
    }
    if (overview.trim()) {
      availableSections.push(["Optional overview", [overview.trim()]]);
    }
  }
  if (availableSections.length === 0) return header;

  const minimumItemChars = 12;
  const initialCount = ([label, items]) => (
    label === "Tool receipts" ? items.length : 1
  );
  const minimumCharsForItem = (label, item) => {
    const text = String(item ?? "");
    const core = label === "Tool receipts"
      ? contextLedgerReceiptCore(text)
      : null;
    return Math.min(
      text.length,
      core ? core.original.length : minimumItemChars
    );
  };
  const fixedCharsFor = (sections, counts) => header.length + sections.reduce(
    (sum, [label], index) => sum + label.length + 2 + (counts[index] * 3),
    0
  );
  const minimumCharsFor = (sections, counts) => sections.reduce(
    (sum, [label, items], sectionIndex) => {
      for (let index = 0; index < counts[sectionIndex]; index += 1) {
        sum += minimumCharsForItem(label, items[index]);
      }
      return sum;
    },
    0
  );
  const fitsLayout = (sections, counts) => (
    fixedCharsFor(sections, counts) + minimumCharsFor(sections, counts)
    <= maxChars
  );
  const fallback = () => {
    const sectionPriority = new Map([
      ["Tool receipts", 0],
      ["Objective", 1],
      ["Authorization context (not a policy grant)", 2],
      ["Decisions", 3],
      ["Changes", 4],
      ["Failures", 5],
      ["Pending", 6],
      ["Blockers", 7],
      ["Next", 8]
    ]);
    const fallbackLines = [header];
    const prioritized = availableSections
      .map((section, index) => ({ section, index }))
      .sort((left, right) => (
        (sectionPriority.get(left.section[0]) ?? 100 + left.index)
        - (sectionPriority.get(right.section[0]) ?? 100 + right.index)
      ));
    for (const { section: [label, items] } of prioritized) {
      fallbackLines.push(`${label}:`);
      for (const item of items) {
        fallbackLines.push(
          `- ${contextLedgerStatusFirstReceipt(label, item)}`
        );
      }
    }
    return clipContextLedgerLines(fallbackLines.join("\n"), maxChars);
  };

  const mandatorySections = availableSections.filter(([label]) => (
    CONTEXT_LEDGER_CORE_SECTION_LABELS.has(label)
  ));
  const optionalSections = availableSections.filter(([label]) => (
    !CONTEXT_LEDGER_CORE_SECTION_LABELS.has(label)
  ));
  const active = [...mandatorySections];
  let selectedCounts = active.map(initialCount);
  if (!fitsLayout(active, selectedCounts)) {
    return fallback();
  }
  for (const section of optionalSections) {
    const proposedSections = [...active, section];
    const proposedCounts = [...selectedCounts, initialCount(section)];
    if (!fitsLayout(proposedSections, proposedCounts)) continue;
    active.push(section);
    selectedCounts = proposedCounts;
  }

  const maximumItems = Math.max(...active.map(([, items]) => items.length));
  for (let itemIndex = 1; itemIndex < maximumItems; itemIndex += 1) {
    for (let sectionIndex = 0; sectionIndex < active.length; sectionIndex += 1) {
      if (active[sectionIndex][1].length <= itemIndex) continue;
      if (active[sectionIndex][0] === "Tool receipts") continue;
      const proposedCounts = [...selectedCounts];
      proposedCounts[sectionIndex] += 1;
      if (!fitsLayout(active, proposedCounts)) continue;
      selectedCounts = proposedCounts;
    }
  }

  const selected = [];
  active.forEach(([label, items], sectionIndex) => {
    for (let itemIndex = 0; itemIndex < selectedCounts[sectionIndex]; itemIndex += 1) {
      const text = String(items[itemIndex] ?? "");
      selected.push({
        label,
        minimum: minimumCharsForItem(label, text),
        text
      });
    }
  });
  const fixedChars = fixedCharsFor(active, selectedCounts);
  const allocations = selected.map((item) => item.minimum);
  let remaining = maxChars
    - fixedChars
    - allocations.reduce((sum, value) => sum + value, 0);
  let pending = selected
    .map((item, index) => ({ index, item }))
    .filter(({ index, item }) => allocations[index] < item.text.length)
    .map(({ index }) => index);
  while (pending.length > 0 && remaining > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length));
    for (const index of pending) {
      if (remaining <= 0) break;
      const added = Math.min(
        share,
        remaining,
        selected[index].text.length - allocations[index]
      );
      allocations[index] += added;
      remaining -= added;
    }
    pending = pending.filter((index) => (
      allocations[index] < selected[index].text.length
    ));
  }

  const lines = [header];
  let selectedIndex = 0;
  active.forEach(([label, items], sectionIndex) => {
    lines.push(`${label}:`);
    for (let itemIndex = 0; itemIndex < selectedCounts[sectionIndex]; itemIndex += 1) {
      const allocation = allocations[selectedIndex];
      const item = String(items[itemIndex] ?? "");
      const visibleItem = label === "Tool receipts"
        ? renderContextLedgerReceipt(item, allocation)
        : clipContextLedgerLines(item, allocation);
      lines.push(
        `- ${visibleItem}`
      );
      selectedIndex += 1;
    }
  });
  return clipContextLedgerLines(lines.join("\n"), maxChars);
}

function renderContextLedgerReceipt(value, maxChars) {
  const text = String(value ?? "");
  const core = contextLedgerReceiptCore(text);
  if (!core || text.length <= maxChars) {
    return clipContextLedgerLines(text, maxChars);
  }
  if (maxChars < core.original.length) {
    return clipContextLedgerLines(core.statusFirst, maxChars);
  }
  const separator = text.indexOf(";");
  if (separator < 0 || maxChars === core.original.length) return core.original;
  const details = text.slice(separator);
  const remaining = maxChars - core.original.length;
  if (remaining <= 3) return core.original;
  return `${core.original}${clipContextLedgerLines(details, remaining)}`;
}

function contextLedgerStatusFirstReceipt(label, value) {
  const text = String(value ?? "");
  if (label !== "Tool receipts") return text;
  const core = contextLedgerReceiptCore(text);
  if (!core) return text;
  const separator = text.indexOf(";");
  const details = separator >= 0 ? text.slice(separator) : "";
  return `${core.statusFirst}${details}`;
}

function clipContextLedgerLines(value, maxChars) {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function clipLiveText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  const marker = "...";
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`;
}

function clusterByTagOverlap(items, minGroupSize) {
  const groups = [];
  const used = new Set();
  // Greedy: pick each unused item, gather everything that shares >=2 tags.
  for (const seed of items) {
    if (used.has(seed.id)) continue;
    const seedTags = new Set((seed.tags ?? []).map((t) => String(t).toLowerCase()));
    const cluster = [seed];
    used.add(seed.id);
    for (const candidate of items) {
      if (used.has(candidate.id)) continue;
      const cTags = new Set((candidate.tags ?? []).map((t) => String(t).toLowerCase()));
      let overlap = 0;
      for (const t of cTags) if (seedTags.has(t)) overlap += 1;
      if (overlap >= 2) {
        cluster.push(candidate);
        used.add(candidate.id);
      }
    }
    if (cluster.length >= minGroupSize) groups.push(cluster);
  }
  return groups;
}

function buildDistillPrompt(items) {
  const lines = items.map((m, i) => `(${i + 1}) [tags: ${(m.tags ?? []).join(", ")}] ${m.content}`).join("\n");
  return `Distill the following ${items.length} related notes into ONE durable principle (200–400 chars). Preserve specifics that matter for safety or correctness. Plain prose, no markdown. End with "(confidence: high|medium|low)".

${lines}`;
}

function parsePrinciple(text) {
  const match = /\(confidence:\s*(high|medium|low)\s*\)\s*$/i.exec(text);
  const confidence = match ? match[1].toLowerCase() : "medium";
  const cleaned = match ? text.slice(0, match.index).trim() : text.trim();
  if (!cleaned) return null;
  return { text: cleaned, confidence };
}

function extractive(items) {
  // Pick the most-shared salient phrase via token frequency; fallback to longest item.
  const tokenCounts = new Map();
  for (const item of items) {
    for (const t of tokenize(item.content)) {
      if (t.length < 4) continue;
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }
  const longest = items.slice().sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0))[0];
  return {
    text: `Pattern across ${items.length} notes: ${longest.content.slice(0, 320)}`,
    confidence: "low"
  };
}

function confidenceProfile(confidence) {
  if (confidence === "high") return { tier: "long", strength: 0.85 };
  if (confidence === "medium") return { tier: "medium", strength: 0.68 };
  return { tier: "medium", strength: 0.48 };
}

function findNearDuplicatePrinciple(memory, text, scope, threshold = 0.72) {
  for (const existing of memory.items?.values?.() ?? []) {
    if (existing.kind !== "principle" || (existing.scope ?? "main") !== scope) continue;
    const forward = tokenOverlapScore(text, existing.content);
    const reverse = tokenOverlapScore(existing.content, text);
    if ((forward + reverse) / 2 >= threshold) return existing;
  }
  return null;
}

function markCondensedSources(memory, group, principleId) {
  for (const src of group) {
    const existing = memory.items.get(src.id);
    if (existing) existing.metadata = { ...(existing.metadata ?? {}), condensedInto: principleId };
  }
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

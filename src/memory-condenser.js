import { nowIso, tokenize, tokenOverlapScore } from "./utils.js";

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

const DEFAULT_LIVE_CONTEXT_KEEP_RECENT_HOPS = 4;
const DEFAULT_LIVE_CONTEXT_DIGEST_CHARS = 4000;
const MIN_LIVE_CONTEXT_DIGEST_CHARS = 40;
const DEFAULT_CONTEXT_ESTIMATE_MAX_CHARS = 8_000_000;
const DEFAULT_CONTEXT_ESTIMATE_CHARS_PER_TOKEN = 4;
const LIVE_CONTEXT_SUMMARY = Symbol("liveContextSummary");
const LIVE_CONTEXT_SYNTHETIC_TURN = Symbol("liveContextSyntheticTurn");

export function markLiveContextSyntheticTurn(message) {
  if (message && typeof message === "object") {
    Object.defineProperty(message, LIVE_CONTEXT_SYNTHETIC_TURN, { value: true });
  }
  return message;
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

// Compress only old context and return a fresh working conversation. The
// caller's durable history is never mutated. Complete tool call/result pairs
// move across the boundary together, and missing results are never invented.
export async function compressLiveContext(conversation, options = {}) {
  const source = Array.isArray(conversation) ? conversation : [];
  const working = cloneContextValue(source);
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
  if (boundary <= summaryStart || boundary >= working.length) {
    return {
      compressed: false,
      conversation: working,
      format,
      summarizedItems: 0,
      keptItems: working.length,
      summarySource: null
    };
  }

  const prefix = working.slice(summaryStart, boundary);
  let summary = null;
  let summarySource = "deterministic";
  if (typeof options.summarizer === "function") {
    try {
      const proposed = await options.summarizer(cloneContextValue(prefix), {
        format,
        maxChars: maxDigestChars
      });
      if (String(proposed ?? "").trim()) {
        summary = String(proposed).trim();
        summarySource = "provided";
      }
    } catch {
      // A summarizer is optional. Deterministic fallback keeps compression live.
    }
  }
  if (!summary) summary = deterministicLiveContextSummary(prefix);
  const marker = liveContextSummaryMarker(summary, maxDigestChars);
  const next = [
    ...working.slice(0, summaryStart),
    createLiveContextSummaryMessage(marker),
    ...working.slice(boundary)
  ];
  if (liveContextSerializedChars(next) >= liveContextSerializedChars(working)) {
    return {
      compressed: false,
      conversation: working,
      format,
      summarizedItems: 0,
      keptItems: working.length,
      summarySource: null
    };
  }

  return {
    compressed: true,
    conversation: next,
    format,
    summarizedItems: prefix.length,
    keptItems: working.length - prefix.length,
    summarySource,
    marker
  };
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
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (ArrayBuffer.isView(value)) return value.slice?.() ?? value;

  const root = Array.isArray(value) ? [] : {};
  copyLiveContextMetadata(value, root);
  const seen = new Map([[value, root]]);
  const pending = [[value, root]];
  while (pending.length > 0) {
    const [source, target] = pending.pop();
    for (const [key, child] of Object.entries(source)) {
      if (child === null || typeof child !== "object") {
        target[key] = child;
        continue;
      }
      if (seen.has(child)) {
        target[key] = seen.get(child);
        continue;
      }
      if (child instanceof Date) {
        target[key] = new Date(child.getTime());
        continue;
      }
      if (ArrayBuffer.isView(child)) {
        target[key] = child.slice?.() ?? child;
        continue;
      }
      const clone = Array.isArray(child) ? [] : {};
      copyLiveContextMetadata(child, clone);
      seen.set(child, clone);
      target[key] = clone;
      pending.push([child, clone]);
    }
  }
  return root;
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

function createLiveContextSummaryMessage(content) {
  const message = { role: "user", content };
  Object.defineProperty(message, LIVE_CONTEXT_SUMMARY, { value: true });
  return message;
}

function copyLiveContextMetadata(source, target) {
  if (source?.[LIVE_CONTEXT_SUMMARY] === true) {
    Object.defineProperty(target, LIVE_CONTEXT_SUMMARY, { value: true });
  }
  if (source?.[LIVE_CONTEXT_SYNTHETIC_TURN] === true) {
    Object.defineProperty(target, LIVE_CONTEXT_SYNTHETIC_TURN, { value: true });
  }
}

function isSyntheticContinueMessage(message) {
  return message?.[LIVE_CONTEXT_SYNTHETIC_TURN] === true;
}

function adjustLiveToolPairBoundary(conversation, format, initialBoundary) {
  let boundary = initialBoundary;
  if (boundary <= 0) return boundary;
  const calls = new Map();
  const results = new Map();
  if (format === "anthropic") {
    conversation.forEach((message, index) => {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === "tool_use" && block.id && !calls.has(block.id)) calls.set(block.id, index);
        if (block?.type === "tool_result" && block.tool_use_id && !results.has(block.tool_use_id)) {
          results.set(block.tool_use_id, index);
        }
      }
    });
  } else {
    conversation.forEach((item, index) => {
      if (item?.type === "function_call" && item.call_id && !calls.has(item.call_id)) calls.set(item.call_id, index);
      if (item?.type === "function_call_output" && item.call_id && !results.has(item.call_id)) {
        results.set(item.call_id, index);
      }
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, callIndex] of calls) {
      const resultIndex = results.get(id);
      if (resultIndex === undefined) continue;
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
  const calls = new Map();
  const results = new Map();
  if (format === "anthropic") {
    conversation.forEach((message, index) => {
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block?.type === "tool_use" && block.id && !calls.has(block.id)) calls.set(block.id, index);
        if (block?.type === "tool_result" && block.tool_use_id && !results.has(block.tool_use_id)) {
          results.set(block.tool_use_id, index);
        }
      }
    });
  } else {
    conversation.forEach((item, index) => {
      if (item?.type === "function_call" && item.call_id && !calls.has(item.call_id)) calls.set(item.call_id, index);
      if (item?.type === "function_call_output" && item.call_id && !results.has(item.call_id)) {
        results.set(item.call_id, index);
      }
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, callIndex] of calls) {
      const resultIndex = results.get(id);
      if (resultIndex === undefined) continue;
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

function deterministicLiveContextSummary(prefix) {
  const lines = prefix.map((item, index) => {
    const label = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "event";
    return `${index + 1}. ${label}: ${clipLiveText(renderLiveContextItem(item), 700)}`;
  });
  return lines.filter((line) => !line.endsWith(": ")).join("\n")
    || "Older conversation details were condensed.";
}

function renderLiveContextItem(item) {
  if (!item || typeof item !== "object") return String(item ?? "");
  if (item.type === "function_call") {
    return `tool call ${item.name ?? "unknown"} (${item.call_id ?? "no-id"}): ${String(item.arguments ?? "")}`;
  }
  if (item.type === "function_call_output") {
    return `tool result ${item.call_id ?? "no-id"}: ${String(item.output ?? "")}`;
  }
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return safeLiveJson(item);
  return item.content.map((block) => {
    if (!block || typeof block !== "object") return String(block ?? "");
    if (block.type === "text") return String(block.text ?? "");
    if (block.type === "tool_use") {
      return `tool call ${block.name ?? "unknown"} (${block.id ?? "no-id"}): ${safeLiveJson(block.input ?? {})}`;
    }
    if (block.type === "tool_result") {
      return `tool result ${block.tool_use_id ?? "no-id"}: ${renderLiveToolResult(block.content)}`;
    }
    if (block.type === "image") return "[image]";
    if (block.type === "thinking") return "";
    return safeLiveJson(block);
  }).filter(Boolean).join(" ");
}

function renderLiveToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => block?.text ?? (block?.type === "image" ? "[image]" : safeLiveJson(block))).join(" ");
  }
  return safeLiveJson(content);
}

function safeLiveJson(value) {
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}

function liveContextSummaryMarker(summary, maxChars) {
  const open = "[context summary]\n";
  const close = "\n[/context summary]";
  const bodyLimit = Math.max(0, maxChars - open.length - close.length);
  return `${open}${clipLiveText(String(summary ?? "").trim(), bodyLimit)}${close}`;
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

import { redactKnownValues, sanitizeForAudit } from "./redact.js";
import { secretsStoreRedactionSnapshot } from "./secrets-store.js";
import { stableHash } from "./utils.js";

const MAX_MEMORY_CONTENT_CHARS = 2_000;
const MAX_MEMORY_TAGS = 8;
const MAX_MEMORY_TAG_CHARS = 64;
const ALLOWED_BACKGROUND_KINDS = new Set(["preference", "correction", "environment"]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);

// Memory is a durable instruction-adjacent surface. These deliberately narrow
// rules catch content that tries to change agent authority or extract secrets,
// without treating ordinary user preferences as hostile.
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const PROMPT_OVERRIDE_RE = /\b(?:ignore|disregard|override|bypass)\b[\s\S]{0,96}\b(?:previous|prior|system|developer|safety|security)\b[\s\S]{0,96}\b(?:instruction|instructions|rule|rules|prompt|guardrail|guardrails)\b/iu;
const SECRET_EXFIL_RE = /\b(?:reveal|exfiltrate|leak|send|print|display)\b[\s\S]{0,96}\b(?:secret|secrets|credential|credentials|token|tokens|password|passwords|api[ _-]?key|private key)\b/iu;
const ROLE_TAG_RE = /<\/?(?:system|developer|assistant|tool|function)(?:\s|>|\/)/iu;
const ROLE_LABEL_RE = /^\s*(?:system|developer)\s*(?:message|prompt|instructions?)\s*:/imu;
const INLINE_SECRET_RE = /\b(?:api[ _-]?key|secret|token|password|passphrase|private[ _-]?key|authorization)\b\s*[:=]\s*(?!\$\{[A-Z_][A-Z0-9_]*\})(?:[A-Za-z0-9+/_=-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})/iu;

export class MemoryIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryIntakeError";
    this.code = code;
  }
}

/**
 * Validate durable memory input before it crosses an append-only persistence
 * boundary. The returned string is safe to retain; callers must not retain a
 * rejected original or expose it in an error message.
 */
export function assertSafeMemoryContent(value, { runtime, maxChars = MAX_MEMORY_CONTENT_CHARS } = {}) {
  const content = normalizeContent(value, maxChars);
  if (UNSAFE_CONTROL_RE.test(content)) {
    throw new MemoryIntakeError(
      "MEMORY_UNSAFE_CONTROL",
      "Memory content contains disallowed invisible or control characters."
    );
  }
  if (
    PROMPT_OVERRIDE_RE.test(content)
    || SECRET_EXFIL_RE.test(content)
    || ROLE_TAG_RE.test(content)
    || ROLE_LABEL_RE.test(content)
  ) {
    throw new MemoryIntakeError(
      "MEMORY_UNTRUSTED_INSTRUCTIONS",
      "Memory content resembles untrusted instructions or a secret-extraction request."
    );
  }
  if (INLINE_SECRET_RE.test(content) || auditSanitizationChanges(content)) {
    throw new MemoryIntakeError(
      "MEMORY_SECRET_CONTENT",
      "Memory content resembles credential material; store a secret reference instead."
    );
  }
  assertNoConfiguredSecret(content, runtime);
  return content;
}

/**
 * Convert a post-session model proposal into a bounded data-only payload.
 * Provenance is created by trusted runtime code, never supplied by the model.
 */
export function prepareBackgroundMemoryProposal(raw, { runtime, turn = {}, scope } = {}) {
  const kind = String(raw?.kind ?? "").trim().toLowerCase();
  if (!ALLOWED_BACKGROUND_KINDS.has(kind)) {
    throw new MemoryIntakeError("MEMORY_PROPOSAL_KIND", "Background memory proposal has an invalid kind.");
  }
  const confidence = String(raw?.confidence ?? "low").trim().toLowerCase();
  if (!ALLOWED_CONFIDENCE.has(confidence)) {
    throw new MemoryIntakeError("MEMORY_PROPOSAL_CONFIDENCE", "Background memory proposal has an invalid confidence.");
  }
  const content = assertSafeMemoryContent(raw?.content, { runtime, maxChars: MAX_MEMORY_CONTENT_CHARS });
  const memoryScope = cleanScope(scope ?? turn.memoryScope ?? "main");
  const tags = normalizeTags(raw?.tags);
  return Object.freeze({
    content,
    kind,
    confidence,
    scope: memoryScope,
    tags,
    provenance: Object.freeze({
      sourceType: "background-review",
      trust: "model-proposal-pending-human",
      sessionId: cleanOptionalId(turn.sessionId),
      projectId: cleanOptionalId(turn.projectId)
    })
  });
}

export function normalizeMemoryTags(value) {
  return normalizeTags(value);
}

export function backgroundMemoryProvenance(proposal, { approvedBy, approvedAt, actionId } = {}) {
  return {
    sourceType: "background-review",
    trust: "human-approved-model-proposal",
    sessionId: proposal?.provenance?.sessionId ?? null,
    projectId: proposal?.provenance?.projectId ?? null,
    approvalActionId: cleanOptionalId(actionId),
    approvedBy: cleanOptionalId(approvedBy),
    approvedAt: cleanOptionalId(approvedAt)
  };
}

export function sameBackgroundMemoryProposal(left, right) {
  if (!left || !right) return false;
  return stableHash(normalizeComparableProposal(left)) === stableHash(normalizeComparableProposal(right));
}

function normalizeComparableProposal(value) {
  return {
    content: String(value.content ?? ""),
    kind: String(value.kind ?? ""),
    confidence: String(value.confidence ?? ""),
    scope: String(value.scope ?? ""),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    provenance: {
      sourceType: String(value.provenance?.sourceType ?? ""),
      trust: String(value.provenance?.trust ?? ""),
      sessionId: value.provenance?.sessionId ?? null,
      projectId: value.provenance?.projectId ?? null
    }
  };
}

function normalizeContent(value, maxChars) {
  if (typeof value !== "string") {
    throw new MemoryIntakeError("MEMORY_CONTENT_INVALID", "Memory content must be plain text.");
  }
  const content = value.replace(/\r\n?/gu, "\n").trim();
  if (!content) {
    throw new MemoryIntakeError("MEMORY_CONTENT_EMPTY", "Memory content must not be empty.");
  }
  if (content.length > maxChars) {
    throw new MemoryIntakeError(
      "MEMORY_CONTENT_TOO_LARGE",
      `Memory content exceeds the ${maxChars}-character safety limit.`
    );
  }
  return content;
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : [];
  const cleaned = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase();
    if (!tag || tag.length > MAX_MEMORY_TAG_CHARS || UNSAFE_CONTROL_RE.test(tag)) continue;
    if (!cleaned.includes(tag)) cleaned.push(tag);
    if (cleaned.length >= MAX_MEMORY_TAGS) break;
  }
  return Object.freeze(cleaned);
}

function cleanScope(value) {
  const scope = String(value ?? "").trim();
  if (!scope || scope.length > 256 || UNSAFE_CONTROL_RE.test(scope)) {
    throw new MemoryIntakeError("MEMORY_SCOPE_INVALID", "Memory proposal has an invalid scope.");
  }
  return scope;
}

function cleanOptionalId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.length > 512 || UNSAFE_CONTROL_RE.test(text)) return null;
  return text;
}

function auditSanitizationChanges(content) {
  try {
    return stableHash(sanitizeForAudit(content)) !== stableHash(content);
  } catch {
    throw new MemoryIntakeError(
      "MEMORY_SECRET_CHECK_FAILED",
      "Memory content could not be checked safely."
    );
  }
}

function assertNoConfiguredSecret(content, runtime) {
  const store = runtime?.secrets;
  if (!store) return;
  let snapshot = secretsStoreRedactionSnapshot(store);
  if (!snapshot && typeof store.listSecretNames === "function") {
    try {
      store.listSecretNames({ decidedBy: "memory:intake-check" });
    } catch {
      throw new MemoryIntakeError(
        "MEMORY_SECRET_CHECK_FAILED",
        "The configured-secret safety check is unavailable."
      );
    }
    snapshot = secretsStoreRedactionSnapshot(store);
  }
  if (!snapshot) return;
  if (snapshot.overflow) {
    throw new MemoryIntakeError(
      "MEMORY_SECRET_CHECK_FAILED",
      "The configured-secret safety check exceeded its safe bound."
    );
  }
  const values = snapshot.records?.map((record) => record.value).filter(Boolean) ?? [];
  if (values.length === 0) return;
  let redacted;
  try {
    redacted = redactKnownValues(content, values);
  } catch {
    throw new MemoryIntakeError(
      "MEMORY_SECRET_CHECK_FAILED",
      "Memory content could not be checked against configured secrets."
    );
  }
  if (stableHash(redacted) !== stableHash(content)) {
    throw new MemoryIntakeError(
      "MEMORY_SECRET_CONTENT",
      "Memory content contains a configured secret value; store a secret reference instead."
    );
  }
}

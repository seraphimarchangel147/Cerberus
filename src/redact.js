const MASK = "[REDACTED]";
const SENSITIVE_KEY = /token|secret|password|api[_-]?key|authorization|bearer/i;
const STRING_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[bp]-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g
];
const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSCODE|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|CLIENT_SECRET|CLIENT_ID|AUTH|AUTHORIZATION|CREDENTIALS?|ACCOUNT_SID)(?:_|$)/;
const CREDENTIAL_HEADER_NAME = /authorization|proxy-authorization|(?:^|[-_])(?:api[-_]?(?:key|token)|access[-_]?(?:key|token)|refresh[-_]?token|auth(?:[-_]?token)?|bearer[-_]?token|client[-_]?(?:id|secret)|service[-_]?key|webhook[-_]?secret|account[-_]?sid|private[-_]?key|signature|credentials?|token|secret|password|passcode)(?:$|[-_])/i;

// Audit records must be safe to persist or return without mutating the live
// objects that execution paths still need. The clone is intentionally JSON-
// shaped because every call site is a JSONL, snapshot, or HTTP boundary.
export function sanitizeForAudit(value) {
  return sanitize(value, new WeakSet());
}

export function isCredentialEnvName(name) {
  return CREDENTIAL_ENV_NAME.test(String(name ?? "").toUpperCase());
}

export function isCredentialHeaderName(name) {
  return CREDENTIAL_HEADER_NAME.test(String(name ?? ""));
}

// Remove exact secret values at an execution boundary. Pattern-based
// redaction cannot cover provider-specific tokens, and subprocesses or remote
// services may reflect a credential in otherwise valid output. This helper
// clones JSON-shaped values so callers never mutate the transport payload.
export function redactKnownValues(value, knownValues, replacement = MASK) {
  const needles = [...new Set(
    [...(knownValues ?? [])]
      .filter((item) => item !== null && item !== undefined && String(item).length > 0)
      .map(String)
  )].sort((left, right) => right.length - left.length);
  if (needles.length === 0) return value;
  return redactExact(
    value,
    needles,
    safeRedactionMarker(needles, replacement),
    new WeakSet()
  );
}

export function safeRedactionMarker(knownValues, preferred = MASK) {
  const needles = [...(knownValues ?? [])]
    .filter((item) => item !== null && item !== undefined && String(item).length > 0)
    .map(String);
  for (const candidate of [String(preferred), "[HIDDEN]", "***", ""]) {
    if (needles.every((needle) => !candidate.includes(needle))) return candidate;
  }
  return "";
}

function sanitize(value, ancestors) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = sanitizeArray(value, ancestors);
  } else {
    clone = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = SENSITIVE_KEY.test(key) ? MASK : sanitize(item, ancestors);
    }
  }
  ancestors.delete(value);
  return clone;
}

const AUDIT_CREDENTIAL_FLAG = /^--(?:api[-_]?key|token|bearer[-_]?token|access[-_]?token|auth[-_]?token|service[-_]?key|webhook[-_]?secret|account[-_]?sid|credentials?|secret|client[-_]?(?:secret|id)|password|passcode|private[-_]?key|access[-_]?key(?:[-_]?id)?)$/i;
const AUDIT_AUTHORIZATION_FLAG = /^--(?:authorization|proxy[-_]?authorization)$/i;
const AUDIT_HEADER_FLAG = /^(?:--header|-H)$/;

function sanitizeArray(items, ancestors) {
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item !== "string") {
      out.push(sanitize(item, ancestors));
      continue;
    }

    const inline = /^(--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+)([\s\S]*)$/.exec(item);
    if (inline && AUDIT_CREDENTIAL_FLAG.test(inline[1])) {
      out.push(
        looksLikeAuditSecretPlaceholder(inline[2])
          ? sanitize(item, ancestors)
          : `${inline[1]}=${MASK}`
      );
      continue;
    }
    if (inline && AUDIT_AUTHORIZATION_FLAG.test(inline[1])) {
      out.push(
        looksLikeAuditHeaderPlaceholder(inline[2])
          ? sanitize(item, ancestors)
          : `${inline[1]}=${MASK}`
      );
      continue;
    }
    if (inline && AUDIT_HEADER_FLAG.test(inline[1])) {
      const safeHeader = sanitizeAuditHeader(inline[2]);
      out.push(
        safeHeader === null
          ? sanitize(item, ancestors)
          : `${inline[1]}=${safeHeader}`
      );
      continue;
    }

    if (AUDIT_CREDENTIAL_FLAG.test(item) || AUDIT_AUTHORIZATION_FLAG.test(item)) {
      out.push(item);
      if (index + 1 < items.length) {
        const value = items[index + 1];
        if (isAuditCredentialFlagToken(value)) continue;
        const safe = AUDIT_AUTHORIZATION_FLAG.test(item)
          ? looksLikeAuditHeaderPlaceholder(value)
          : looksLikeAuditSecretPlaceholder(value);
        out.push(safe ? sanitize(value, ancestors) : MASK);
        index += 1;
      }
      continue;
    }
    if (AUDIT_HEADER_FLAG.test(item)) {
      out.push(item);
      if (index + 1 < items.length) {
        const value = items[index + 1];
        if (isAuditCredentialFlagToken(value)) continue;
        const safeHeader = sanitizeAuditHeader(value);
        out.push(
          safeHeader === null
            ? sanitize(value, ancestors)
            : safeHeader
        );
        index += 1;
      }
      continue;
    }

    const safeHeader = sanitizeAuditHeader(item);
    out.push(safeHeader === null ? sanitize(item, ancestors) : safeHeader);
  }
  return out;
}

function isAuditCredentialFlagToken(value) {
  if (typeof value !== "string") return false;
  const flag = /^(--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+|$)/.exec(value)?.[1];
  return Boolean(
    flag
    && (
      AUDIT_CREDENTIAL_FLAG.test(flag)
      || AUDIT_AUTHORIZATION_FLAG.test(flag)
      || AUDIT_HEADER_FLAG.test(flag)
    )
  );
}

function sanitizeAuditHeader(value) {
  if (typeof value !== "string") return null;
  const colon = /^([^:]+):(.*)$/s.exec(value);
  if (colon && isCredentialHeaderName(colon[1].trim())) {
    const headerValue = colon[2].trim();
    return looksLikeAuditHeaderPlaceholder(headerValue)
      ? value
      : `${colon[1].trim()}: ${MASK}`;
  }
  const scheme = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value);
  if (!scheme) return null;
  return looksLikeAuditHeaderPlaceholder(value)
    ? value
    : `${scheme[1]} ${MASK}`;
}

function looksLikeAuditSecretPlaceholder(value) {
  return typeof value === "string"
    && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

function looksLikeAuditHeaderPlaceholder(value) {
  return looksLikeAuditSecretPlaceholder(value)
    || (
      typeof value === "string"
      && /^[A-Za-z][A-Za-z0-9._-]* \$\{[A-Z_][A-Z0-9_]*\}$/.test(value)
    );
}

function redactExact(value, needles, replacement, ancestors) {
  if (typeof value === "string") {
    let safe = value;
    for (const needle of needles) safe = safe.split(needle).join(replacement);
    return safe;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return needles.includes(String(value)) ? replacement : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  const clone = Array.isArray(value)
    ? value.map((item) => redactExact(item, needles, replacement, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [
        redactExact(key, needles, replacement, ancestors),
        redactExact(item, needles, replacement, ancestors)
      ]));
  ancestors.delete(value);
  return clone;
}

function redactString(value) {
  let safe = value.replace(/\bBearer\s+[A-Za-z0-9_-]{40,}/gi, `Bearer ${MASK}`);
  for (const pattern of STRING_PATTERNS) safe = safe.replace(pattern, MASK);
  return safe;
}

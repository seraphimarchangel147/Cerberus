const MASK = "[REDACTED]";
const SENSITIVE_KEY = /token|secret|password|api[_-]?key|authorization|bearer/i;
const STRING_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[bp]-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g
];

// Audit records must be safe to persist or return without mutating the live
// objects that execution paths still need. The clone is intentionally JSON-
// shaped because every call site is a JSONL, snapshot, or HTTP boundary.
export function sanitizeForAudit(value) {
  return sanitize(value, new WeakSet());
}

function sanitize(value, ancestors) {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item) => sanitize(item, ancestors));
  } else {
    clone = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = SENSITIVE_KEY.test(key) ? MASK : sanitize(item, ancestors);
    }
  }
  ancestors.delete(value);
  return clone;
}

function redactString(value) {
  let safe = value.replace(/\bBearer\s+[A-Za-z0-9_-]{40,}/gi, `Bearer ${MASK}`);
  for (const pattern of STRING_PATTERNS) safe = safe.replace(pattern, MASK);
  return safe;
}

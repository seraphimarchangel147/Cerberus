// LSS adapter for openAGI (Legion Secure Secrets, SPEC v1).
//
// The destination-pinned choke point between the secrets store and the
// provider transport layer. Implements SPEC.md §2 (resolve with scope +
// destination + verified gates), §3 (destination pinning mechanics), §5.3
// (secret:requested audit events), plus install/rotate/probe for the
// conformance suite's S5/S6 scenarios.
//
// Hard rules enforced here:
// - NO ambient fallback: when LSS is enabled, key material comes from the
//   store via resolveViaLss or the turn fails. process.env is never read
//   for secret material on this path.
// - Fail closed: absent destinations[] denies every destination; absent
//   scopes[] permits any agent (v1 back-compat) but any PRESENT scope list
//   requires an explicit intersection.
// - Secret values never appear in errors, audit lines, or return metadata.
//   Only the SPEC fingerprint (first4…last4) may cross those boundaries.
import { appendJsonLine } from "./file-utils.js";
import { secretFingerprint } from "./secrets-store.js";
import { listProviderPresets, validatePresetKey } from "./provider-presets.js";

export class LssError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LssError";
    this.code = code;
  }
}

export function lssEnabled(env = process.env) {
  return String(env?.OPENAGI_LSS ?? "").trim() === "1";
}

export function urlHost(url) {
  try {
    return new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Exact-host match, or the SPEC wildcard suffix rule: "*.kimi.com" matches
// "api.kimi.com" and "kimi.com" but never "evil-kimi.com" or "kimi.com.evil.io".
export function destinationMatches(host, pattern) {
  const h = String(host ?? "").trim().toLowerCase();
  const p = String(pattern ?? "").trim().toLowerCase();
  if (!h || !p) return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === p;
}

function auditRequest(store, event) {
  // Deliberately NOT try/caught: an audit write failure is a loud error, not
  // a silent pass. Values are never written -- fingerprint only (SPEC §1).
  appendJsonLine(store.auditPath, {
    timestamp: new Date().toISOString(),
    action: "secret:requested",
    ...event
  }, 0o600);
}

function scopeAllowed(scopes, agent, project) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true; // v1 records: unpinned
  return scopes.includes(`agent:${agent}`)
    || scopes.includes("agent:*")
    || scopes.includes(`project:${project}`)
    || scopes.includes("project:*");
}

/**
 * SPEC §2 resolve(). Returns { name, material, fingerprint } on success;
 * throws LssError otherwise. `material` must be dropped by the caller as soon
 * as the request is signed.
 */
export function resolveViaLss(store, name, {
  agent = "azazel",
  project = "default",
  destination,
  requireVerified = true,
  decidedBy
} = {}) {
  if (!store || typeof store.getSecretWithRecord !== "function") {
    throw new LssError("LSS_STORE_UNSAFE", "LSS resolve requires a SecretsStore with getSecretWithRecord");
  }
  const actor = String(agent ?? "").trim() || "unknown";
  const event = {
    agent: `agent:${actor}`,
    name,
    destination: String(destination ?? "").toLowerCase()
  };
  const pair = store.getSecretWithRecord(name, {
    decidedBy: decidedBy ?? `lss:${actor}`
  });
  if (!pair) {
    auditRequest(store, { ...event, outcome: "denied", reason: "not-found" });
    throw new LssError("LSS_SCOPE_DENIED", `${name} is not in the secrets store`);
  }
  const { value, record } = pair;
  if (!scopeAllowed(record.scopes, actor, project)) {
    auditRequest(store, { ...event, outcome: "denied", reason: "scope" });
    throw new LssError("LSS_SCOPE_DENIED", `agent:${actor} is not in scope for ${name}`);
  }
  const destinations = record.destinations ?? [];
  const destHost = event.destination;
  if (!destHost || !destinations.some((pattern) => destinationMatches(destHost, pattern))) {
    auditRequest(store, { ...event, outcome: "denied", reason: "destination" });
    throw new LssError(
      "LSS_DESTINATION_DENIED",
      `${name} is not pinned to destination ${destHost || "(unknown-host)"}`
    );
  }
  if (requireVerified && record.verifiedStatus && record.verifiedStatus !== "ok") {
    auditRequest(store, { ...event, outcome: "unverified", reason: record.verifiedStatus });
    throw new LssError("LSS_UNVERIFIED", `${name} is ${record.verifiedStatus}`);
  }
  const fingerprint = record.fingerprint || secretFingerprint(value);
  auditRequest(store, { ...event, outcome: "ok", fingerprint });
  return { name, material: value, fingerprint };
}

function presetForKeyName(name) {
  return listProviderPresets().find((preset) => preset.keyEnv === name) ?? null;
}

/**
 * Live HTTP health check against the secret's pinned destination (SPEC §2
 * probe). Uses the owning preset's validation semantics; the outcome is
 * persisted as verifiedStatus + lastVerifiedAt. Never throws on network
 * failure -- "unverified" is a status, not an exception.
 */
export async function lssProbe(store, name, { fetchImpl, timeoutMs, decidedBy = "lss:probe" } = {}) {
  const pair = store.getSecretWithRecord(name, { decidedBy });
  if (!pair) throw new LssError("LSS_SCOPE_DENIED", `${name} is not in the secrets store`);
  const preset = presetForKeyName(name);
  let status = "unverified";
  if (preset) {
    const result = await validatePresetKey(preset.id, pair.value, { fetchImpl, timeoutMs });
    if (result.status === "valid") status = "ok";
    else if (result.status === "invalid") status = "dead";
  }
  store.setSecretMeta(name, {
    verifiedStatus: status,
    lastVerifiedAt: new Date().toISOString()
  }, { decidedBy });
  return status;
}

/**
 * File-to-file install (SPEC §2 install): writes the record, then probes.
 * A failed probe leaves the record present but "unverified" -- it is NOT
 * active, because resolve(requireVerified) refuses it. The --unverified
 * override is recorded by passing verify:false with an explicit decidedBy.
 */
export async function lssInstall(store, name, value, {
  destinations = [],
  scopes = [],
  verify = true,
  fetchImpl,
  decidedBy = "lss:install"
} = {}) {
  store.setSecret(name, value, { decidedBy, destinations, scopes });
  let status = "unverified";
  if (verify) {
    status = await lssProbe(store, name, { fetchImpl, decidedBy: `${decidedBy}:probe` });
  } else {
    store.setSecretMeta(name, { verifiedStatus: "unverified" }, { decidedBy });
  }
  return { name, fingerprint: secretFingerprint(value), verifiedStatus: status };
}

/**
 * SPEC §2 rotate: new value, old fingerprint preserved in history, policy
 * metadata (destinations/scopes) carried forward by the store itself.
 */
export function lssRotate(store, name, newValue, { decidedBy = "lss:rotate" } = {}) {
  const prior = store.getSecretWithRecord(name, { decidedBy });
  if (!prior) throw new LssError("LSS_SCOPE_DENIED", `${name} is not in the secrets store`);
  const oldFingerprint = prior.record.fingerprint || secretFingerprint(prior.value);
  const rotatedAt = new Date().toISOString();
  store.setSecret(name, newValue, { decidedBy });
  const history = [...(prior.record.history ?? []), { fingerprint: oldFingerprint, rotatedAt }];
  store.setSecretMeta(name, {
    history,
    rotatedAt,
    verifiedStatus: "unverified" // a fresh key has not earned "ok" yet
  }, { decidedBy });
  return {
    name,
    fingerprint: secretFingerprint(newValue),
    previousFingerprint: oldFingerprint
  };
}

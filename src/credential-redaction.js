import fs from "node:fs";
import path from "node:path";
import { isCredentialEnvName, isCredentialHeaderName } from "./redact.js";

const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const OAUTH_CREDENTIAL_KEY = /^(?:access_token|refresh_token|id_token|registration_access_token|client_secret)$/;
const MCP_CREDENTIAL_FLAG = /^--(?:api[-_]?key|token|bearer[-_]?token|access[-_]?token|auth[-_]?token|service[-_]?key|webhook[-_]?secret|account[-_]?sid|credentials?|secret|client[-_]?(?:secret|id)|password|passcode|private[-_]?key|access[-_]?key(?:[-_]?id)?)$/i;
const MCP_AUTHORIZATION_FLAG = /^--(?:authorization|proxy[-_]?authorization)$/i;
const MCP_HEADER_FLAG = /^(?:--header|-H)$/;
const CREDENTIAL_URL_PARAMETER = new Set([
  "key",
  "apikey",
  "servicekey",
  "accesskey",
  "privatekey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "secret",
  "clientsecret",
  "webhooksecret",
  "password",
  "passcode",
  "auth",
  "authorization",
  "signature",
  "credential",
  "credentials",
  "accountsid"
]);

export function secretRedactionSpellings(value) {
  if (value === null || value === undefined) return [];
  const raw = String(value);
  if (raw.length === 0) return [];
  const json = JSON.stringify(raw).slice(1, -1);
  return json === raw ? [raw] : [raw, json];
}

export function addSecretRedactionSpellings(target, value) {
  for (const spelling of secretRedactionSpellings(value)) target.add(spelling);
  return target;
}

// Read only bounded, regular JSON files from the internal MCP OAuth cache.
// This is a redaction-only source: collected values are never injected into
// subprocesses or returned directly.
export function addMcpAuthCacheRedactions(target, dataDir, options = {}) {
  const maxFiles = positiveCap(options.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = positiveCap(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = positiveCap(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const authDir = path.resolve(dataDir, "mcp", "auth");
  let dirStat;
  try {
    dirStat = fs.lstatSync(authDir);
  } catch {
    return target;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return target;

  let entries;
  try {
    entries = fs.readdirSync(authDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, maxFiles);
  } catch {
    return target;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const file = path.join(authDir, entry.name);
    let fd;
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) continue;
      if (totalBytes + before.size > maxTotalBytes) break;
      fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size !== before.size || opened.size > maxFileBytes) continue;
      totalBytes += opened.size;
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
      collectOAuthCredentialFields(parsed, target);
    } catch {
      // Redaction collection is best-effort; an unreadable or malformed cache
      // must not break an otherwise unrelated tool call.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
      }
    }
  }
  return target;
}

export function addNodeConfigRedactions(target, dataDir, options = {}) {
  const maxFileBytes = positiveCap(options.maxFileBytes, 64 * 1024);
  const file = path.resolve(dataDir, "node.json");
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) {
      return target;
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size || opened.size > maxFileBytes) {
      return target;
    }
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    addSecretRedactionSpellings(target, parsed?.token);
  } catch {
    // Same best-effort boundary as the OAuth cache collector.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
    }
  }
  return target;
}

export function addLegacyMcpConfigRedactions(target, dataDir, options = {}) {
  const maxFileBytes = positiveCap(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxServers = positiveCap(options.maxServers, DEFAULT_MAX_FILES);
  const parsed = readBoundedRegularJson(path.resolve(dataDir, "mcp.json"), maxFileBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return target;
  const servers = parsed.servers ?? parsed.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return target;
  for (const spec of Object.values(servers).slice(0, maxServers)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    addCredentialValue(target, spec.apiKey);
    addCredentialValue(target, spec.clientSecret);
    collectCredentialMap(spec.env, target, isCredentialEnvName);
    collectCredentialMap(spec.headers, target, isCredentialHeaderName, true);
    collectCredentialArgs(spec.args, target);
    collectCredentialUrl(spec.url, target);
    collectCredentialUrl(spec.resourceUrl, target);
  }
  return target;
}

export function addInternalCredentialFileRedactions(target, dataDir, options = {}) {
  addMcpAuthCacheRedactions(target, dataDir, options.oauth);
  addNodeConfigRedactions(target, dataDir, options.node);
  addLegacyMcpConfigRedactions(target, dataDir, options.mcp);
  return target;
}

function collectCredentialMap(values, target, isCredentialName, header = false) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return;
  for (const [name, value] of Object.entries(values)) {
    if (!isCredentialName(name)) continue;
    addCredentialValue(target, value, { header });
  }
}

function collectCredentialArgs(values, target) {
  if (!Array.isArray(values)) return;
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (typeof raw !== "string") continue;
    collectCredentialUrl(raw, target);
    const inline = /^(--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+)([\s\S]*)$/.exec(raw);
    if (inline) collectCredentialUrl(inline[2], target);
    if (inline && MCP_CREDENTIAL_FLAG.test(inline[1])) {
      addCredentialValue(target, inline[2]);
      continue;
    }
    if (inline && MCP_AUTHORIZATION_FLAG.test(inline[1])) {
      addCredentialValue(target, inline[2], { header: true });
      continue;
    }
    if (inline && MCP_HEADER_FLAG.test(inline[1])) {
      collectHeaderArgument(inline[2], target);
      continue;
    }
    if (MCP_CREDENTIAL_FLAG.test(raw) || MCP_AUTHORIZATION_FLAG.test(raw)) {
      if (index + 1 < values.length) {
        const next = values[index + 1];
        if (isMcpCredentialFlagToken(next)) continue;
        addCredentialValue(target, next, {
          header: MCP_AUTHORIZATION_FLAG.test(raw)
        });
        index += 1;
      }
      continue;
    }
    if (MCP_HEADER_FLAG.test(raw) && index + 1 < values.length) {
      const next = values[index + 1];
      if (isMcpCredentialFlagToken(next)) continue;
      collectHeaderArgument(next, target);
      index += 1;
    }
  }
}

function isMcpCredentialFlagToken(value) {
  if (typeof value !== "string") return false;
  const flag = /^(--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+|$)/.exec(value)?.[1];
  return Boolean(
    flag
    && (
      MCP_CREDENTIAL_FLAG.test(flag)
      || MCP_AUTHORIZATION_FLAG.test(flag)
      || MCP_HEADER_FLAG.test(flag)
    )
  );
}

function collectHeaderArgument(value, target) {
  if (typeof value !== "string") return;
  const colon = value.indexOf(":");
  if (colon >= 0) {
    const name = value.slice(0, colon).trim();
    if (isCredentialHeaderName(name)) {
      addCredentialValue(target, value.slice(colon + 1).trim(), { header: true });
    }
    return;
  }
  if (/^(?:Bearer|Basic|Token)\s+/i.test(value)) {
    addCredentialValue(target, value, { header: true });
  }
}

function addCredentialValue(target, value, { header = false } = {}) {
  if (typeof value !== "string" || looksLikePlaceholder(value)) return;
  addSecretRedactionSpellings(target, value);
  if (header) {
    const scheme = /^[A-Za-z][A-Za-z0-9._-]*\s+(.+)$/.exec(value);
    if (scheme && !looksLikePlaceholder(scheme[1])) {
      addSecretRedactionSpellings(target, scheme[1]);
    }
  }
}

function collectCredentialUrl(value, target) {
  if (typeof value !== "string") return;
  let parsed;
  try { parsed = new URL(value); } catch { return; }
  addCredentialValue(target, parsed.username);
  addCredentialValue(target, parsed.password);
  for (const [name, item] of parsed.searchParams) {
    if (isCredentialUrlParameter(name)) addSecretRedactionSpellings(target, item);
  }
}

export function isCredentialUrlParameter(name) {
  const lower = String(name ?? "").toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_URL_PARAMETER.has(collapsed)
    || /(?:^|[_-])(?:api[_-]?key|token|secret|password|passcode|auth|authorization|key|signature|credentials?)(?:$|[_-])/i
      .test(lower);
}

function looksLikePlaceholder(value) {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)
    || /^[A-Za-z][A-Za-z0-9._-]* \$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

function readBoundedRegularJson(file, maxFileBytes) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== before.size || opened.size > maxFileBytes) return null;
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
    }
  }
}

function collectOAuthCredentialFields(value, target, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectOAuthCredentialFields(item, target, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (OAUTH_CREDENTIAL_KEY.test(key) && item !== null && item !== undefined) {
      addSecretRedactionSpellings(target, item);
    } else {
      collectOAuthCredentialFields(item, target, depth + 1);
    }
  }
}

function positiveCap(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

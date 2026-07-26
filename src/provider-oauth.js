// Provider OAuth — authorization-code + PKCE flows for model providers.
//
// Scope: Anthropic and OpenAI are the only presets with a real consumer OAuth
// app to authorize against (xAI is API-key-only by design — see
// provider-presets.js). Both flows are "paste" style so they work on headless
// boxes with no local callback listener:
//
//   Anthropic — claude.ai shows a `code#state` pair on the console callback
//   page; the user copies it into the dashboard.
//   OpenAI    — auth.openai.com redirects to localhost:1455 (Codex CLI's
//   registered redirect); the browser fails to connect and the user copies
//   the full URL out of the address bar. We parse code+state from it.
//
// Client IDs default to the well-known PUBLIC first-party CLI clients (same
// pattern opencode/claude-code-router/codex-headless use) and are overridable
// via env so the Creator can register dedicated apps later without a code
// change:
//   OPENAGI_ANTHROPIC_OAUTH_CLIENT_ID, OPENAGI_OPENAI_OAUTH_CLIENT_ID
//
// Tokens are never logged, never returned to the client beyond a masked
// preview, and are persisted by the CALLER (hosted-interface) through
// saveEnv/SecretsStore, which owns redaction and the audit trail.

import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_FLOWS = 32;

const OAUTH_FLOWS = Object.freeze({
  anthropic: Object.freeze({
    id: "anthropic",
    label: "Anthropic (Claude subscription)",
    lane: "anthropic",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    clientIdEnv: "OPENAGI_ANTHROPIC_OAUTH_CLIENT_ID",
    defaultClientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    scope: "org:create_api_key user:profile user:inference",
    tokenStyle: "json",
    extraAuthorizeParams: { code: "true" },
    tokenSecret: "ANTHROPIC_OAUTH_TOKEN",
    refreshSecret: "ANTHROPIC_OAUTH_REFRESH_TOKEN",
    instructions:
      "Sign in with your Claude account. The console page shows a code in the form 'code#state' — paste the whole thing here."
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI (ChatGPT subscription)",
    lane: "openai",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientIdEnv: "OPENAGI_OPENAI_OAUTH_CLIENT_ID",
    defaultClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    tokenStyle: "form",
    extraAuthorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true"
    },
    tokenSecret: "OPENAI_OAUTH_TOKEN",
    refreshSecret: "OPENAI_OAUTH_REFRESH_TOKEN",
    instructions:
      "Sign in with your ChatGPT account. The browser will try to reach localhost:1455 and fail — copy the FULL URL from the address bar and paste it here."
  })
});

// flowId -> { provider, verifier, state, createdAt }
const pendingFlows = new Map();

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function sweepExpired(now = Date.now()) {
  for (const [id, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) pendingFlows.delete(id);
  }
}

export function isOAuthProviderId(value) {
  return Object.hasOwn(OAUTH_FLOWS, String(value ?? "").trim().toLowerCase());
}

export function getOAuthFlowConfig(id, env = process.env) {
  const key = String(id ?? "").trim().toLowerCase();
  const flow = OAUTH_FLOWS[key];
  if (!flow) throw new Error(`No OAuth flow for provider: ${key || "(empty)"}`);
  const clientId = String(env[flow.clientIdEnv] ?? "").trim() || flow.defaultClientId;
  return { ...flow, clientId };
}

/** Secret names a completed flow writes, so routes/UI never hard-code them. */
export function oauthSecretNames(id) {
  const flow = OAUTH_FLOWS[String(id ?? "").trim().toLowerCase()];
  if (!flow) return null;
  return Object.freeze({ token: flow.tokenSecret, refresh: flow.refreshSecret, lane: flow.lane });
}

/**
 * Start a flow. Returns everything the dashboard needs to send the user to
 * the vendor and later complete the exchange. The verifier never leaves the
 * process except through completeOAuthFlow.
 */
export function startOAuthFlow(id, { env = process.env, now = Date.now } = {}) {
  const flow = getOAuthFlowConfig(id, env);
  sweepExpired(now);
  if (pendingFlows.size >= MAX_PENDING_FLOWS) {
    throw new Error("Too many pending OAuth flows — complete or wait for one to expire.");
  }
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const flowId = base64url(randomBytes(12));
  pendingFlows.set(flowId, { provider: flow.id, verifier, state, createdAt: now });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    scope: flow.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...flow.extraAuthorizeParams
  });
  return {
    flowId,
    provider: flow.id,
    label: flow.label,
    authorizeUrl: `${flow.authorizeUrl}?${params.toString()}`,
    instructions: flow.instructions,
    expiresInSec: Math.floor(FLOW_TTL_MS / 1000)
  };
}

/**
 * Parse whatever the user pastes: a full redirect URL, a `code#state` pair
 * (Anthropic console), or a bare code. Returns { code, state|null }.
 */
export function parseAuthorizationInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) throw new Error("Paste the authorization code first.");

  // Full URL (OpenAI localhost redirect, or a pasted callback link).
  if (/^https?:\/\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error("That doesn't look like a valid URL — paste the full address from the browser bar.");
    }
    const error = parsed.searchParams.get("error");
    if (error) throw new Error(`Vendor returned an error: ${error}`);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code) throw new Error("No 'code' parameter in that URL — copy the complete address.");
    return { code, state: state || null };
  }

  // Anthropic console format: code#state
  if (input.includes("#")) {
    const [code, state] = input.split("#", 2);
    if (!code?.trim()) throw new Error("No code before the '#' — paste the whole 'code#state' value.");
    return { code: code.trim(), state: state?.trim() || null };
  }

  // Bare code: acceptable only when the caller can tolerate a missing state
  // (we can't verify it) — completeOAuthFlow enforces state when it has one.
  if (/^[A-Za-z0-9_\-.]{8,}$/u.test(input)) return { code: input, state: null };
  throw new Error("Unrecognized format — paste 'code#state' or the full redirect URL.");
}

async function postTokenRequest(flow, fields, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isJson = flow.tokenStyle === "json";
    const response = await fetch(flow.tokenUrl, {
      method: "POST",
      signal: controller.signal,
      headers: isJson
        ? { "content-type": "application/json" }
        : { "content-type": "application/x-www-form-urlencoded" },
      body: isJson ? JSON.stringify(fields) : new URLSearchParams(fields).toString()
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body?.error_description === "string"
        ? body.error_description
        : typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`Token exchange failed: ${detail}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finish a flow: validate state, exchange the code, return tokens. The flow
 * is single-use — consumed whether the exchange succeeds or not.
 */
export async function completeOAuthFlow(flowId, pasted, { env = process.env, now = Date.now } = {}) {
  sweepExpired(now);
  const pending = pendingFlows.get(flowId);
  if (!pending) throw new Error("OAuth flow expired or unknown — start again.");
  pendingFlows.delete(flowId);

  const flow = getOAuthFlowConfig(pending.provider, env);
  const { code, state } = parseAuthorizationInput(pasted);
  if (state && state !== pending.state) {
    throw new Error("State mismatch — the pasted code belongs to a different flow. Start again.");
  }
  if (!state) {
    throw new Error("The pasted value has no state parameter — paste the full 'code#state' or redirect URL.");
  }

  const fields = flow.tokenStyle === "json"
    ? {
        grant_type: "authorization_code",
        code,
        state,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: pending.verifier
      }
    : {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: pending.verifier
      };
  const body = await postTokenRequest(flow, fields);
  const accessToken = String(body?.access_token ?? "").trim();
  if (!accessToken) throw new Error("Token exchange returned no access_token.");
  return {
    provider: flow.id,
    lane: flow.lane,
    accessToken,
    refreshToken: String(body?.refresh_token ?? "").trim() || null,
    expiresIn: Number.isFinite(body?.expires_in) ? body.expires_in : null,
    tokenSecret: flow.tokenSecret,
    refreshSecret: flow.refreshSecret
  };
}

/**
 * Credential-pool refresh hook (signature matches refreshOAuth in
 * credential-pool.js): given a stale oauth lease, trade its refresh token for
 * a new access token. Returns { accessToken, refreshToken } or throws; the
 * pool treats a throw as "not refreshed" and keeps its normal failure path.
 */
export async function providerOAuthRefresh({ provider, refreshToken } = {}) {
  const lane = String(provider ?? "").trim().toLowerCase();
  const flow = OAUTH_FLOWS[lane];
  if (!flow) throw new Error(`No OAuth refresh for provider: ${lane || "(empty)"}`);
  const token = String(refreshToken ?? "").trim();
  if (!token) throw new Error("OAuth credential has no refresh token.");
  const clientId = String(process.env[flow.clientIdEnv] ?? "").trim() || flow.defaultClientId;
  const fields = flow.tokenStyle === "json"
    ? { grant_type: "refresh_token", refresh_token: token, client_id: clientId }
    : { grant_type: "refresh_token", refresh_token: token, client_id: clientId };
  const body = await postTokenRequest(flow, fields);
  const accessToken = String(body?.access_token ?? "").trim();
  if (!accessToken) throw new Error("OAuth refresh returned no access_token.");
  return {
    accessToken,
    refreshToken: String(body?.refresh_token ?? "").trim() || token
  };
}


/**
 * Register (or replace) an oauth credential-pool entry for a lane in
 * credential-pools.json, so the provider sends the token as a Bearer lease
 * (credential-pool.js type "oauth") with the env API key kept as a rotation
 * fallback. Atomic write; merges with whatever is already on disk. The file
 * shape matches loadCredentialPoolConfig: { version, providers: { [lane]:
 * { strategy, credentials: [{ id, type, secretName, refreshTokenSecretName? }] } } }.
 */
export function upsertOAuthPoolEntry({
  dataDir = resolveDataDir(),
  lane,
  tokenSecret,
  refreshSecret = null,
  envKeyFallback = null
} = {}) {
  const normalizedLane = String(lane ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/u.test(normalizedLane)) throw new TypeError("lane is invalid");
  const file = path.join(dataDir, "credential-pools.json");
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* missing or malformed file starts fresh */ }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
  const providers = doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
    ? { ...doc.providers }
    : {};
  const existing = providers[normalizedLane] && typeof providers[normalizedLane] === "object"
    ? providers[normalizedLane]
    : {};
  const credentials = Array.isArray(existing.credentials) ? [...existing.credentials] : [];

  const oauthEntry = { id: "oauth-dashboard", type: "oauth", secretName: tokenSecret };
  if (refreshSecret) oauthEntry.refreshTokenSecretName = refreshSecret;
  const next = [oauthEntry, ...credentials.filter((entry) => entry?.id !== "oauth-dashboard")];
  if (envKeyFallback && !next.some((entry) => entry?.secretName === envKeyFallback)) {
    next.push({ id: "env", type: "api_key", secretName: envKeyFallback });
  }
  providers[normalizedLane] = {
    strategy: typeof existing.strategy === "string" ? existing.strategy : "round_robin",
    credentials: next
  };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { file, lane: normalizedLane, credentials: next.length };
}
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
import http from "node:http";
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
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    tokenStyle: "form",
    extraAuthorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      // auth.openai.com validates `originator` against a whitelist tied to
      // the Codex CLI client_id; omitting it (or sending a non-whitelisted
      // value) fails with a misleading `missing_required_parameter`.
      originator: "codex_cli_rs"
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

/** Find a pending flow's id by its OAuth state (loopback callbacks carry
 * state but arrive on whichever listener holds the port). */
export function findPendingFlowByState(state) {
  const wanted = String(state ?? "");
  if (!wanted) return null;
  for (const [id, flow] of pendingFlows) {
    if (flow.state === wanted) return id;
  }
  return null;
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
    // Codex CLI percent-encodes (%20 for spaces); URLSearchParams would emit
    // '+', which auth.openai.com's validator rejects for the scope param.
    authorizeUrl: `${flow.authorizeUrl}?${params.toString().replace(/\+/g, "%20")}`,
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
/**
 * Loopback callback capture — the fix for the "localhost refused to connect"
 * dead-end. OpenAI's flow redirects to http://localhost:1455/auth/callback
 * (Codex CLI's registered redirect URI, unchangeable on our side). Instead of
 * asking the user to copy a failed URL out of the address bar, we bind
 * 127.0.0.1:1455 for the lifetime of the flow and capture the code directly:
 * the browser lands on a friendly "you're signed in" page and the dashboard
 * polls /providers/oauth/status until the exchange finishes server-side.
 * If the port is taken (real Codex CLI login running), startOAuthFlow still
 * works — the paste path remains as fallback.
 */
const loopbackServers = new Map(); // flowId -> { server, result }

export function startLoopbackCapture(flowId, { port = 1455, onCode = null } = {}) {
  return new Promise((resolve) => {
    const entry = { server: null, result: { status: "waiting" } };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (error || !code) {
        res.end("<h2>Sign-in was not completed</h2><p>You can close this tab and try again from the dashboard.</p>");
        entry.result = { status: "error", error: error || "no code in callback" };
      } else {
        res.end("<h2>&#10003; Signed in</h2><p>You can close this tab — the dashboard is finishing up.</p>");
        entry.result = { status: "captured", code, state };
        if (typeof onCode === "function") {
          // Fire-and-forget: token exchange happens outside the request cycle.
          Promise.resolve(onCode({ code, state })).then(
            (r) => { entry.result = { status: "done", ...r }; },
            (e) => { entry.result = { status: "error", error: e?.message ?? String(e) }; }
          );
        }
      }
      // One callback is all a flow gets: free the port quickly, but keep the
      // terminal result around long enough for the dashboard's poll loop.
      setTimeout(() => { try { entry.server?.close(); } catch { /* closed */ } }, 2000).unref?.();
      setTimeout(() => stopLoopbackCapture(flowId), 120_000).unref?.();
    });
    server.once("error", () => {
      loopbackServers.delete(flowId);
      resolve({ listening: false });
    });
    server.listen(port, "127.0.0.1", () => {
      entry.server = server;
      loopbackServers.set(flowId, entry);
      // Auto-expire with the flow TTL so an abandoned login can't squat the port.
      setTimeout(() => stopLoopbackCapture(flowId), FLOW_TTL_MS).unref?.();
      resolve({ listening: true, port });
    });
  });
}

export function loopbackCaptureStatus(flowId) {
  const entry = loopbackServers.get(flowId);
  return entry ? entry.result : null;
}

export function stopLoopbackCapture(flowId) {
  const entry = loopbackServers.get(flowId);
  if (!entry) return;
  try { entry.server?.close(); } catch { /* already closed */ }
  if (entry.result?.status === "waiting") entry.result = { status: "closed" };
  loopbackServers.delete(flowId);
}

/**
 * Best-effort account model sync: after a ChatGPT-plan sign-in, ask the
 * backend which models this account can actually run and persist them so the
 * dashboard picker reflects the real entitlement instead of a hardcoded list.
 * Every failure path returns null — sync is a bonus, never a blocker.
 */
export async function fetchAccountModels({ lane, accessToken, dataDir = resolveDataDir() } = {}) {
  if (lane !== "openai" || !accessToken) return null;
  const attempts = [
    // The codex backend requires client + client_version and gates the list
    // on the version; 1.2.0 unlocks the gpt-6/5.6 families (astra, sol,
    // terra, luna, reserve, daybreak). Bump when new families 400 out.
    "https://chatgpt.com/backend-api/codex/models?client=codex_cli&client_version=1.2.0",
    "https://api.openai.com/v1/models"
  ];
  for (const url of attempts) {
    try {
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          originator: "codex_cli_rs",
          "content-type": "application/json"
        }
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : null;
      if (!raw) continue;
      const ids = [...new Set(
        raw.map((m) => String(m?.slug ?? m?.id ?? m?.model ?? "").trim()).filter(Boolean)
      )];
      if (!ids.length) continue;
      // Keep the capability metadata alongside bare ids: reasoning levels and
      // speed tiers drive the dashboard's per-model pickers.
      const details = {};
      for (const m of raw) {
        const id = String(m?.slug ?? m?.id ?? m?.model ?? "").trim();
        if (!id || typeof m !== "object") continue;
        const levels = Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.map((l) => String(l?.effort ?? l ?? "").trim()).filter(Boolean)
          : [];
        const entry = {};
        if (levels.length) entry.reasoningLevels = levels;
        if (m.default_reasoning_level) entry.defaultReasoningLevel = String(m.default_reasoning_level);
        if (Array.isArray(m.additional_speed_tiers) && m.additional_speed_tiers.length) {
          entry.speedTiers = m.additional_speed_tiers.map((t) => String(t?.tier ?? t ?? "").trim()).filter(Boolean);
        }
        if (m.display_name) entry.displayName = String(m.display_name);
        if (m.description) entry.description = String(m.description);
        if (Number.isFinite(m.context_window)) entry.contextWindow = m.context_window;
        if (Object.keys(entry).length) details[id] = entry;
      }
      const file = path.join(dataDir, "provider-account-models.json");
      let doc = {};
      try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
      doc[lane] = { models: ids, details, source: url, syncedAt: new Date().toISOString() };
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return { models: ids, details, source: url };
    } catch { /* try next */ }
  }
  return null;
}

/** Read synced account models (dashboard merges these into preset pickers). */
export function loadAccountModels(lane, { dataDir = resolveDataDir() } = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, "provider-account-models.json"), "utf8"));
    const entry = doc?.[String(lane ?? "").trim().toLowerCase()];
    return Array.isArray(entry?.models) && entry.models.length ? entry.models : null;
  } catch {
    return null;
  }
}

/** Read synced per-model capability metadata (reasoning levels, speed tiers). */
export function loadAccountModelDetails(lane, { dataDir = resolveDataDir() } = {}) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, "provider-account-models.json"), "utf8"));
    const entry = doc?.[String(lane ?? "").trim().toLowerCase()];
    return entry?.details && typeof entry.details === "object" ? entry.details : null;
  } catch {
    return null;
  }
}

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
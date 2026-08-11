# Draft — Provider OAuth Patterns: Auth/Linking Steps & Gotchas
**Date:** 2026-07-30
**Task:** `task_093afe94314b4d3c` (daily-plan, 2026-07-30 — draft only, for user review)
**Status:** DRAFT — not sent, published, or scheduled externally.
**Context:** Supports the provider-auth dashboard goal (see `drafts/provider-auth-dashboard-outline.md`, `drafts/provider-auth-dashboard-requirements-checklist.md`).

---

## 1. Standard Authorization Code Flow (the baseline)

Canonical linking sequence for connecting a third-party provider account:

1. **Register the app** with the provider → obtain `client_id` / `client_secret`; configure **exact redirect URIs** (most providers now require exact-match, no wildcards).
2. **Initiate:** redirect user to provider's authorize URL with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`.
3. **User consent** on the provider's page (account picker → scope consent).
4. **Callback:** provider redirects back with `code` (+ `state`).
5. **Exchange:** server-side POST `code` + `client_secret` + `redirect_uri` → token endpoint → `access_token`, often `refresh_token`, `expires_in`, `id_token` (OIDC).
6. **Store & link:** persist tokens encrypted, keyed to the internal user + provider account identity (issuer + subject for OIDC).
7. **Use & maintain:** call APIs with access token; refresh before/after expiry; handle revocation.

## 2. PKCE (RFC 7636) — now the default everywhere

- Generate `code_verifier` (43–128 chars); send `code_challenge = BASE64URL(SHA256(verifier))` with `code_challenge_method=S256` at authorize time; send `code_verifier` at exchange.
- **Gotcha:** some providers *require* PKCE even for confidential clients (e.g., X/Twitter OAuth 2.0). Assume required; always implement.
- Plain `code_challenge_method=plain` is deprecated — don't offer it.

## 3. State & CSRF

- `state` must be a high-entropy, single-use value bound to the session; verify on callback.
- **Gotcha:** storing `state` only in a cookie breaks multi-tab flows and mobile app-redirect flows. Store server-side keyed by the state value, with a short TTL (~10 min).
- Use `nonce` for OIDC `id_token` replay protection — distinct from `state`.

## 4. Scopes & Consent

- Request **minimal scopes at link time**; use **incremental authorization** (Google) to request elevated scopes only when a feature needs them.
- **Gotcha:** some providers (GitHub classic OAuth, Slack) grant the full scope set the *app* requests regardless of what the user wants; others (Google) let the user deselect scopes — your code must handle *partial grants* (`scope` in the token response can differ from what you asked).
- **Gotcha:** removing a scope from your app's config can invalidate existing tokens on some providers (Google revokes on certain changes) — test downgrade paths.

## 5. Token Lifecycle

| Item | Typical behavior | Gotcha |
|---|---|---|
| Access token | 1h (Google), 8h (GitHub), varies | Never assume lifetime — read `expires_in`; some omit it |
| Refresh token | Long-lived or rotating | **Rotation:** many providers issue a *new* refresh token per use; failing to persist the new one = silent account unlink later |
| Revocation | Provider-side or user-side | Dashboard must handle 401/`invalid_grant` as "needs re-link", not as an error to retry |
| Introspection | RFC 7662 where supported | Not universal — GitHub has no introspection; validate via a cheap API call instead |

- **Clock skew:** allow 60–120s leeway when validating `exp`/`iat`.
- **Store expiry as absolute UTC**, not relative seconds.

## 6. Provider Quirks Worth a Dashboard Field

- **OIDC vs. proprietary:** OIDC providers give `iss`+`sub` (stable identity). Proprietary (GitHub, Slack, Discord) require a `/user`-style call to get the account id — and the id format differs (numeric vs. string vs. scoped-per-app).
- **Slack:** tokens are per-workspace; one user can link N workspaces → model as N connections, not one.
- **Google:** refresh tokens only returned on **first** consent unless `prompt=consent&access_type=offline` — re-linking can silently return *no* refresh token.
- **GitHub:** OAuth App tokens don't expire (until revoked); GitHub App user tokens expire in 8h with rotation — know which one you're integrating.
- **Microsoft:** `common` vs. tenant-specific endpoints change token validation; personal vs. work accounts differ in consent behavior.

## 7. Dashboard Implications (feeding the requirements checklist)

The dashboard must surface, per provider connection:
- Link state machine: `linked / needs-reauth / revoked / unknown` (derived from last token event, not a stored boolean).
- Scopes actually granted (from last token response/introspection), not scopes requested.
- Token health: access-token expiry, refresh-token presence, last refresh result, last successful API call.
- Provider account identity (display name + stable id) and, where applicable, workspace/tenant.
- Failure surface: `invalid_grant`, `invalid_client` (config broken), `insufficient_scope`, rate-limit — each needs a distinct remediation hint.

## 8. Security Baseline

- `client_secret` and stored tokens only in env/secrets store, encrypted at rest; never in Notepad/CUA-visible windows (per harness policy).
- Redirect URI: HTTPS only, exact match; loopback with ephemeral port for desktop flows (RFC 8252).
- Token exchange and refresh always server-side; never expose refresh tokens to the browser.
- Log auth events (initiate, callback, exchange success/fail, refresh, revoke) with correlation ids — the dashboard's audit view depends on this.

---
**End of draft. Awaiting user review.**

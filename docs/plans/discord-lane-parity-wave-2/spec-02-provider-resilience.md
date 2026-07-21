# Spec 02 — Provider retry / backoff / failover + mid-batch corruption fix

**Marker:** `PROVIDER RESILIENCE PHASE COMPLETE`
**Priority:** 2 (Azazel's #2). **Risk:** Med.
**Files:** `src/model-provider.js`.

## The bugs (verified 2026-07-21)

1. **Zero retry/backoff on provider errors.** Both providers just throw:
   - OpenAI path `:716`: `if (!response.ok) throw new Error(json?.error?.message ?? ...)`
   - Anthropic path `:1000`: `if (!response.ok) { ... throw new Error(...) }`
   A transient 429/500/502/503/529 or a network blip kills the whole turn and discards all
   tool work already done that turn. No backoff, no failover.

2. **Mid-batch tool corruption → forced-final 400 → canned summary.** When a tool call in
   a batch times out (`request-timeout`/`turn-timeout`, caught at :601-606), the loop
   `break`s. The assistant's `function_call` items were already appended to
   `conversationInput` (:584-591) but the matching `function_call_output` items for the
   un-run calls are NOT — leaving ORPHANED function_calls. The subsequent forced-final
   answer request (:658 sets the prompt, :665 re-calls) then 400s because the provider
   rejects function_calls without their outputs, and the turn silently degrades to the
   canned partial summary.

## Required behavior

### A. Retry/backoff wrapper (both providers)
Add a single helper that wraps ONE provider HTTP request with bounded retry on RETRYABLE
failures only:
```js
// Retryable: network errors, HTTP 429, 500, 502, 503, 504, 529.
// NOT retryable: 400 (bad request — retrying re-sends the same bad body),
//   401/403 (auth), 404, or any typed abort we already handle
//   (RequestTimeoutError / ModelStallError — those have their own graceful path).
async function requestWithRetry(doRequest, { retries, baseDelayMs, onRetry }) { ... }
```
- Config: `OPENAGI_PROVIDER_MAX_RETRIES` (default 3), `OPENAGI_PROVIDER_RETRY_BASE_MS`
  (default 500). Add both to `WIZARD_FIELDS`.
- Backoff: exponential with full jitter — `delay = random(0, baseDelayMs * 2^attempt)`,
  capped (e.g. 8s). Honor a `Retry-After` header if present (429/529) over the computed
  delay.
- Wrap the `fetch(...)` + `!response.ok` check at BOTH throw sites so a retryable status
  re-enters the loop instead of throwing. On exhausting retries, throw a typed
  `ProviderError` carrying the last status so the turn loop can decide (see C).
- Do NOT retry a request whose body includes already-committed tool outputs in a way that
  would double-execute side effects — retry is at the HTTP-request layer only (the model
  call itself is idempotent; tools already ran and their outputs are in the body).

### B. Failover (optional within this phase — implement if cheap, else scaffold)
`OPENAGI_FALLBACK_MODEL` (and optional `OPENAGI_FALLBACK_BASE_URL`/key): after retries are
exhausted on a 5xx/429, try ONE fallback model before giving up. Azazel is single-provider
(kimi coding endpoint) today, so a same-endpoint fallback model
(`kimi-for-coding-highspeed`) is the realistic target. If wiring a second provider is more
than S effort, land retry/backoff (A) solidly and leave failover as a documented follow-up
in CHANGES.md rather than block the phase.

### C. Fix mid-batch orphaned function_call
Before issuing the forced-final-answer request (around :658), RECONCILE the conversation:
for every `function_call` appended this iteration that does NOT have a corresponding
`function_call_output`, append a synthetic output so the transcript is well-formed:
```js
{ type: "function_call_output", call_id: <id>,
  output: JSON.stringify({ error: "tool aborted: turn ended before completion" }) }
```
Do the equivalent on the Anthropic path (`tool_result` block with `is_error: true` for any
`tool_use` lacking a result) before the forced answer at :910. This makes the forced-final
request well-formed → it returns a real answer instead of 400→canned summary.
Add a helper `reconcileOrphanedToolCalls(conversationInput)` used on both early-stop paths
(iteration-cap, request-timeout, turn-timeout, stall).

## Tests (`test/provider-resilience.test.js`)
- `requestWithRetry`: 429 then 200 → succeeds after 1 retry; 3×500 → throws typed
  ProviderError after `retries` attempts; 400 → throws immediately (no retry); honors
  `Retry-After`. Use a fake fetch returning a scripted sequence; assert attempt count and
  that delays are invoked (inject a fake sleep to keep the test fast).
- Orphan reconcile: given a conversationInput with a dangling `function_call`,
  `reconcileOrphanedToolCalls` appends a matching `function_call_output` (and the Anthropic
  variant appends an error `tool_result`); a well-formed transcript is unchanged.
- Regression: a normal successful turn is byte-identical to before (no extra retries, no
  spurious synthetic outputs when all tools ran).

## Live proof
Point `OPENAGI_PROVIDER_MAX_RETRIES` at a stub/booth that returns one 503 then success (or
temporarily add a fault-injection env) and confirm via events.jsonl the turn survives the
transient error instead of dying. Confirm a turn whose tool batch is interrupted still
returns a real forced answer (not the canned string).

## Definition of Done
Both lanes green + new tests, homoglyph clean, retry + orphan-fix demonstrated, `CHANGES.md`
entry ending with the marker. Failover either implemented or explicitly deferred in the
entry.

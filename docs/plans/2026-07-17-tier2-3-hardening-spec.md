# Tier 2/3 Hardening — Implementation Spec (for Zed/Codex agent)

Owner: Zed Codex agent. Reviewer: Seraphim. Philosophy per Creator: **smart gates,
not strict gates** — auto-approve stays default-on; only a small CATASTROPHIC class
is hard-gated, with a Hermes-style Discord approval menu.

Tier 1 (already merged, commit 2cfb883): code-tool sandbox enforcement, /health
minimization, fail-closed 0.0.0.0 bind + telegram webhook, 5MB body caps,
`npm run test:prod-policy` lane. Do not redo.

Run BOTH lanes before claiming done: `npm test` AND `npm run test:prod-policy`
(537+ each, 0 fail). Byte-scan changed files for homoglyphs
(`[\u0400-\u04ff\u2010-\u2011\uff00-\uffef]`).

---

## T2a — Catastrophic-class blocklist (auto-approve can NEVER bypass)

New file: `src/catastrophic-policy.js` (stub exists). Export:

```js
classifyCommand(command: string) -> { catastrophic: boolean, reason: string|null }
isCatastrophicToolCall({ toolName, args }) -> { catastrophic, reason }
```

Patterns (regex on the shell command, normalized whitespace, after stripping
`bash -lc` wrapping) — start with exactly this list, keep it SMALL:
- `rm -rf` (or `rm -r`/`rm -f` combos) targeting `/`, `~`, `$HOME`, `/home/*`, `/mnt/c`, or any path shorter than 6 chars after resolution
- `wsl --shutdown` / `wsl.exe --shutdown` / `shutdown` / `reboot` / `poweroff`
- `systemctl (--user)? (stop|disable|kill|mask)` against units matching `zerohermes|hermes|openagi|cua`
- `pkill|killall` against `zerohermes|hermes-gateway|openagi|node.*hosted-server`
- `mkfs|fdisk|parted|dd\s+.*of=/dev/`
- `git push --force` (any remote) to `main|master`
- writes to credential files: `.env` under ~/.openagi or ~/.zeroclaw or ~/.hermes, `id_rsa`, `*.pem` (write/append redirection or `cp/mv` onto them)
- `:(){ :|:& };:` and fork-bomb shapes

Wire-in point: `src/tool-registry.js` `invoke()` — BEFORE the auto-approve check.
If `catastrophic`, force-divert to PendingActionStore with
`severity: "catastrophic"` even when `autoApproveEnabled()`. Include `reason` in
the action record + summary. Also apply to `code_shell` args.command.

Tests (`test/catastrophic-policy.test.js`): each pattern classifies; benign
lookalikes don't (`rm -rf node_modules`, `git push origin feature`, `systemctl
--user status openagi-azazel`); auto-approve=1 still diverts catastrophic;
approve endpoint still executes after human decision. MUST pass in both lanes
WITHOUT pinning env (this is the whole point).

## T2b — Discord approval menu (Hermes-style)

**REFERENCE IMPLEMENTATION (STUDY FIRST — Creator's standing rule: "always
reference hermes"):** Hermes's own Discord approval flow lives at
`~/.hermes/hermes-agent/plugins/platforms/discord/adapter.py` (Windows path
for Zed: NOT accessible — Seraphim will paste key excerpts below). Mirror its
UX semantics exactly:

- **Buttons: "Approve Once" (green/success), "Always Approve" (blurple ->
  ours = "Allow for session", secondary), "Cancel"/"Deny" (red/danger).**
- View object holds `session_key` + `confirm_id`; `resolved` flag makes the
  first click win — later clicks get an ephemeral "already resolved" reply.
- Auth check per click (`_check_auth` against allowed user/role ids) — ours:
  only the Creator's Discord user id (env `DISCORD_OWNER_ID` or the id list
  the daemon already trusts) may decide; others get an ephemeral refusal.
- On decision: edit the SAME message — recolor embed (green approved /
  red denied / grey expired), set footer `"<label> by <display name>"`,
  disable ALL buttons, THEN run the action and post the result (exitCode,
  stdout tail) as a follow-up in-channel.
- On timeout (Hermes uses 300s; use 600s for catastrophic): mark resolved,
  disable buttons, footer "⏱ Prompt expired — no action taken", and the
  pending action stays pending (dashboard can still decide it).
- Hermes appends an approval NOTE to the tool result so the model knows the
  action was human-gated ("Command required approval (<desc>) and was
  approved by the user") — replicate: openAGI's approve path should append
  `approvedVia: "discord-button"` + decider to the action record and surface
  the same sentence in the tool result the model sees.

openAGI is raw-gateway (no discord.js views) — implement with REST components
(`components: [{type:1, components:[{type:2, style:3, label:"Approve",
custom_id:"pa:approve:<id>"}, ...]}]`) and handle `INTERACTION_CREATE`
(gateway op 0, t=INTERACTION_CREATE) for `custom_id` shapes `pa:approve:<id>`,
`pa:deny:<id>`, `pa:session:<id>`. ACK with type 6 (deferred update) then
PATCH the original message via webhook edit; long approvals: edit again with
the result when done.

Post the card to the session's channel (reuse activity-feed routing:
sessionId -> lastActiveChannel -> DISCORD_ACTIVITY_CHANNEL). Card = embed
with tool name, full summary (the dangerous fields — Hermes shows args
open-by-default; we already pin `<details open>` on the dashboard), reason
from the catastrophic classifier, and the 3 buttons.

"Allow for session" = approve AND record `sessionAllow:{sessionId, toolName}`
(in-memory map in tool-registry, cleared on restart) so the same tool+session
skips the gate — mirrors Hermes's "Always Approve" scope semantics but
bounded to the session.

Tests: LiveStatus-style class tests with a fake REST poster — enqueue -> embed
posted with 3 buttons; interaction approve -> store resolved, buttons disabled;
session-allow -> second identical call runs without a new card.

## T3a — Secret redaction (`sanitizeForAudit`)

New `src/redact.js`: `sanitizeForAudit(obj)` deep-clones and masks values whose
keys match `/token|secret|password|api[_-]?key|authorization|bearer/i` and
string values matching common key shapes (`sk-[A-Za-z0-9]{20,}`, `xox[bp]-`,
`ghp_`, `AKIA[0-9A-Z]{16}`, base64url >= 40 chars following "Bearer ").
Apply at: pending-actions serialize (args), agent-host assistant metadata
toolCalls args, /mcp status endpoint (expanded args/env), outcome store inputs.
Keep originals in memory for execution — redact ONLY at persistence/response
boundaries. Tests: a gated call with a bearer in args persists masked but
executes with the real value; /mcp response masks expanded env.

## T3b — Budget check inside the iteration loop

`src/model-provider.js` (both OpenAI + Anthropic paths): call
`budgetGuard.check()` before EVERY provider request inside the iteration loop,
not just turn start. On breach mid-turn: stop iterating, run the existing
partial-summary path with stopReason `"budget-cap"`. Add per-turn ceiling
`OPENAGI_MAX_TURN_USD` (default unset = off). Surface stopReason in result
envelope + LiveStatus. Tests: fake provider + fake budgetGuard that trips on
iteration N -> loop stops, stopReason correct, no further provider calls.

## T3c — Session write race (cheap version)

`src/agent-store.js` FileBackedAgentStore: add per-sessionId in-process mutex
(promise chain map) around read-modify-write in the message append path. NOT
the full TurnCoordinator — just the keyed mutex. Test: two concurrent
appendMessage calls to the same session both survive in the file, order stable.

---

## Explicitly OUT of scope (Creator decision)
- No "auto-approve only for reversible writes" policy — auto-approve stays as is.
- No SQLite turn lifecycle / TurnCoordinator kernel / hosted-interface split.
- No full CSP/renderer rewrite (a later pass may textContent-harden worst sinks).

## Definition of done (per task)
1. Both test lanes green, no pinned env in NEW catastrophic tests.
2. CHANGES.md entry appended.
3. Homoglyph byte-scan clean.
4. Seraphim reviews diff before restart of openagi-azazel.

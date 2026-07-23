# Spec 2 — `execute_code` Tool-Calling Sandbox

Branch: `codex/execute-code`. Reviewer: Seraphim. Read `README.md` first.

## Goal

Give Azazel a Hermes-style `execute_code` tool: run a short Python script that can call his
OWN harness tools programmatically (loop, filter, branch, reduce large tool output before it
hits his context). This is the token-saver for mechanical multi-step work — instead of 12
model round-trips, one script does the orchestration and returns a small printed result.

## What Hermes does (the target behavior)

A Python script runs in the session's workdir with the active venv. It can
`from hermes_tools import read_file, write_file, searcmcp_files, patch, terminal` and call them
as functions. Between calls it uses stdlib for logic. It prints its final result to stdout,
capped at ~50KB, 5-min timeout, max ~50 tool calls. The MODEL never sees the intermediate
tool output — only the printed summary.

## openAGI implementation

The harness is Node; his tools live in `runtime.tools` (JS). Cleanest approach: a **Node
subprocess** running the user's script in an isolated context, NOT Python (avoids a Python
dep + a JS↔Python tool bridge). The script is JavaScript with a preloaded `tools` object.

### 1. New file: `src/integrations/execute-code.js`

Register tool `execute_code`:
```
parameters: { code: string (JS, ESM or CJS body), timeoutMs?: number (default 120000, cap 300000) }
sideEffects: true   // it can call side-effecting tools
```

Handler:
1. Path-guard + resource caps mirror `code-tools.js` (`allowedRoots()`, `/tmp` writable).
2. Write the user code to a temp file under `resolveDataDir()/execute-code/<uuid>.mjs`
   WRAPPED in a harness that injects a `tools` proxy and a `callTool(name,args)` helper.
3. Spawn `node <tmpfile>` as a child process (`child_process.spawn`) with:
   - a scrubbed env (SAFE_ENV_KEYS only — reuse the MCP env-scrub allowlist so the script
     can't read `ANTHROPIC_API_KEY`/`OPENAGI_AUTH_TOKEN`),
   - cwd = REPO_ROOT,
   - a hard timeout (kill on expiry → return `{error:"execute_code timed out", stdout}`),
   - stdout cap 64KB (truncate + flag `truncated:true`).
4. The `tools` bridge: the child can't hold `runtime` directly (separate process). Two options —
   pick **B**:
   - (A) rewrite tools to be process-portable — too invasive.
   - (B) **In-process VM instead of subprocess.** Use `node:vm` with a fresh context that
     exposes an async `callTool(name, args)` bound to `runtime.tools.invoke(name, args,
     context)` and a small stdlib surface (`console.log`, `JSON`, `fetch` optional-OFF by
     default). Enforce the timeout with a wall-clock check + `vm` `timeout` option on sync
     spans, and a max-tool-call counter (default 50) incremented in `callTool`. This keeps
     the real tool registry, honors the SAME scrutiny/catastrophic gate on every `callTool`
     (route through `runtime.tools.invoke` so auto-approve + catastrophic policy still apply),
     and needs no IPC. Prefer this.
5. Every `callTool` goes through `runtime.tools.invoke(name, args, { ...context,
   __fromExecuteCode:true })` so the catastrophic gate and read-only/watch policy still hold.
   A script CANNOT escalate past the turn's scrutiny verdict.
6. Return `{ stdout, toolCallsMade, truncated, timedOut }`.

### 2. Safety (non-negotiable)

- `execute_code` is itself gated by the normal tool policy: under a `watch` verdict it is
  read-only (its `callTool` must reject side-effecting tools); under `ignore` it's unavailable.
- The injected `callTool` re-enters `runtime.tools.invoke` — it MUST NOT bypass the
  catastrophic-policy check. Add a test proving a script calling `code_shell` with `rm -rf ~`
  still diverts to the catastrophic queue.
- No raw `process.env` exposure inside the VM context. No `require`/dynamic `import` of
  arbitrary modules (whitelist: none needed for v1 — stdlib globals only).
- Reuse `scanGhosts()` on the returned stdout before it enters context (defense in depth).

### 3. Model-facing description

Make it clear when to reach for it: "Run a short JS script that can call your tools via
`await callTool(name, args)`. Use for 3+ dependent tool calls with logic between them, or to
reduce large tool output before it reaches you. Print the final result."

## Tests (`test/execute-code.test.js`)

- A script that loops `callTool("code_read", ...)` over 3 files and prints a reduced summary
  → assert only the summary returns, toolCallsMade === 3.
- Timeout: an infinite loop → returns `timedOut:true`, no hang.
- Tool-call cap: a script exceeding 50 `callTool`s → stops at the cap with a clear error.
- **Catastrophic passthrough**: a script issuing a catastrophic `code_shell` still diverts to
  the queue (prove auto-approve + VM can't bypass). This test must pass in BOTH lanes unpinned.
- stdout truncation at 64KB flagged.

## Definition of done

Both lanes green, homoglyph-clean, CHANGES.md, commit SHA. Branch only. Report the VM-context
surface you exposed so Seraphim can review the sandbox boundary.

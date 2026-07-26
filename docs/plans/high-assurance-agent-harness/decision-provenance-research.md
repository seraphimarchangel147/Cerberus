# Decision Provenance Research

Date: 2026-07-25

This is a clean-room capability comparison. External projects informed the
requirements, but no external implementation code was copied.

## Primary-source observations

### Claude Code

Sources:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents

Claude Code exposes named lifecycle events around tool execution, including
pre-use, permission, success, failure, and batch completion. Matchers make the
active policy surface understandable. Its subagents use isolated context
windows and return a summary so exploratory data does not automatically fill
the main context.

Useful principle: policy and execution should have visible lifecycle
boundaries, while large exploratory context should stay out of the main loop.

### Hermes Agent

Sources:

- https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/

Hermes groups a broad registry into selectable toolsets. Its skills follow
progressive disclosure: list metadata first, load one full skill only when
needed, and load a particular reference file only when needed.

Useful principle: capability breadth does not require sending every schema or
instruction on every turn.

### Cursor

Sources:

- https://docs.cursor.com/bugbot
- https://docs.cursor.com/background-agent

Bugbot reviews pull-request diffs on updates and resolves repository and
directory-specific review rules near changed files. Background agents expose
status, follow-up, and takeover surfaces in isolated machines. Cursor also
documents the prompt-injection and exfiltration risk created by combining
internet access with automatic command execution.

Useful principle: review should be change-scoped and observable, and remote
autonomy must not silently erase policy boundaries.

### Agent Zero

Sources:

- https://github.com/agent0ai/agent-zero/blob/main/docs/guides/usage.md
- https://github.com/agent0ai/agent-zero/blob/main/docs/developer/extensions.md

Agent Zero emphasizes watchable browser and desktop surfaces, project-scoped
files, memory, secrets, and instructions, plus small lifecycle-specific
extensions when plugins or skills are insufficient.

Useful principle: users need a surface for watching and steering work, while
extensions should stay narrow and explainable.

## Internal audit

Cerberus already had stronger enforcement than a simple tool runner:

- one registry owns input contracts, project and capability scope, scrutiny,
  hooks, approvals, checkpoints, dispatch, semantic verification, and output
  contracts;
- canonical receipts distinguish dispatch from outcome and change certainty;
- Run Inspector persists only allowlisted structural metadata;
- tool search, prompt caching, context compression, isolated jobs, and
  specialist scopes reduce unnecessary context;
- coder transactions and Web QA require deterministic evidence.

The missing property was decision provenance. A receipt said what happened,
but not which gates were evaluated or where execution stopped. Pre-dispatch
validation failures intentionally finalize before the ordinary start event so
secret-bearing input cannot cross an observer surface. When a large tool
result was compacted, the receipt retained dispatch identity but no policy
path.

## Selected upgrade

Every finalized tool call now carries a versioned `receipt.decision`:

- `path` is a bounded ASCII sequence of fixed gate and status names;
- `gateCount` and `truncated` make the bound explicit;
- `blockedAt` identifies the decisive failed, blocked, or cancelled gate;
- `slowestGate` and `slowestMs` expose one useful latency signal without
  serializing every timing;
- no arguments, results, prompts, hook output, policy rationale, page text,
  pixels, or secrets are retained.

The same compact path survives ordinary provider truncation and is projected
through Run Inspector's metadata allowlist after observer-safe execution
starts. Pre-dispatch contract, scope, and preflight failures remain invisible
to lifecycle observers, but their returned receipts explain the rejection.
Successful tool-search forwarding still reports the real target and traverses
the governed kernel once.

This improves on raw debug logging by making the explanation safe to persist,
safe to show the model, bounded in tokens, and tied to the canonical receipt.

## Rejected designs

- Raw hook stdout or policy reasons: too easy to persist secrets or untrusted
  content.
- Hidden reasoning or chain-of-thought capture: unnecessary for a
  deterministic execution explanation and inappropriate for an audit record.
- A separate `tool_explain` store: duplicated receipt authority and added a
  lookup round trip.
- Unbounded per-gate timing objects: too expensive in model context. One
  slowest-gate signal plus total receipt duration gives useful performance
  visibility at much lower cost.
- Automatic parallel specialists for every task: external systems document
  context benefits, but unnecessary agents increase cost and coordination
  risk. Cerberus keeps bounded jobs for genuinely independent work.

## Verification requirements

- Success, handler failure, hook veto, input failure, output-contract failure,
  forwarding, cancellation, and explicit manual approval produce truthful
  paths without weakening preflight observer isolation.
- Manual approval behaves identically with either auto-approval policy lane.
- Receipts and decision records are immutable and bounded.
- Invalid or content-bearing decision fields are rejected by provider
  compaction and Run Inspector projection.
- An observer failure cannot affect the tool result.
- Both complete policy lanes, the added-line ASCII scan, diff check, and
  dependency audit must pass before merge.

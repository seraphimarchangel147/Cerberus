# Agent Workspace Upgrades - Clean-Room Two-Phase Plan

This plan adapts useful design ideas found during the Agent Zero review without
copying its implementation. Cerberus remains a plain Node ESM system and keeps
its existing deterministic policy, approval, checkpoint, budget, secret, and
persistence boundaries.

The goal is not feature parity. Every adopted idea must improve on the source
design in at least one measurable way: safety, durability, token use, tool
reachability, failure recovery, or operator visibility.

## Phase-wide rules

- Agent-facing tools use `registry.register`.
- Durable state uses JSONL append plus an atomic JSON snapshot through
  `src/file-utils.js`.
- New environment variables are added to the setup-wizard allowlist.
- New agent-facing tools are documented in `buildDefaultInstructions`.
- Tool aliases and discovery bridges unwrap before the real tool traverses
  scope, scrutiny, hooks, approvals, checkpoints, dispatch, and telemetry.
- No raw model reasoning is exposed, logged, or persisted.
- Identifiers are ASCII-only.
- Targeted tests run for each feature. Both `npm test` and
  `npm run test:prod-policy` must pass before a phase is complete.
- Every feature is reviewed for secret leakage, concurrent-session isolation,
  restart behavior, and bounded resource use.

## Phase 1 - Execution Intelligence and Token Efficiency

Phase 1 improves the harness hot path. It does not add a new product shell.

### F1 - Canonical provider request assembly

Persist the raw user message once, but send providers prior history plus exactly
one current turn. Context-reference expansion and image attachments belong only
to that current provider turn.

Definition of Done:

- OpenAI and Anthropic receive current user content exactly once.
- Expanded references do not also expose the raw reference message as history.
- First, repeated-text, multi-turn, ephemeral, and image turns remain correct.
- Durable session transcripts remain unchanged.
- Request-shape telemetry contains counts and sizes, never content.

### F2 - Safe efficiency telemetry

Extend the existing credit ledger with content-free request-efficiency facts:
provider, model, request count, input/output/cache tokens, visible and deferred
schema bytes, compression activity, tool success/failure counts, latency, and
stop reason. Remove reasoning-trace salvage and expose only bounded runtime
progress facts.

Definition of Done:

- Ledger rows contain no prompts, tool arguments/results, credentials, or
  reasoning.
- Existing cost totals remain authoritative and backward compatible.
- Cache and schema efficiency can be summarized deterministically.
- Truncated reasoning produces a safe status message without trace text.

### F3 - Typed tool capability manifest

Extend tool registration with an additive, normalized capability manifest:
domain, verbs, effect, idempotence, latency class, cost class, resources,
requirements, examples, and success criteria. Conservative defaults derive
from existing source, side-effect, and confirmation fields.

Definition of Done:

- Existing tools work unchanged when no manifest is supplied.
- `sideEffects` remains authoritative for policy.
- Manifests contain no secret values or executable callbacks.
- Invalid manifests fail registration with field-specific errors.
- Provider tool schemas remain backward compatible.

### F4 - Reachability-preserving tool radar

Upgrade progressive disclosure so every eligible omitted tool remains
searchable, describable, and invokable. Rank on name, description, schema
property names, capability metadata, source, and availability. Reserve all
three discovery bridges whenever deferral or the model-tool cap is active.

Definition of Done:

- Advertised tools never exceed the configured cap.
- Discovery bridges cannot be evicted while tools are omitted.
- Every eligible omitted tool is reachable through the bridges.
- Search results show why a tool matched, required arguments, effect,
  confirmation, availability, and a bounded example.
- Scope, specialist, and read-only restrictions apply to search, describe, and
  call resolution.
- Real targets traverse policy and hooks exactly once.
- A full core registry shows a material schema-byte reduction.

### F5 - Semantic tool outcomes and loop repair

Add a backward-compatible semantic outcome envelope with status, code,
retryability, changed state, artifacts, evidence, verification, and next-step
hints. Add optional per-tool normalization and verification. Detect repeated
identical failures within one turn and return a repair hint instead of spending
unbounded model hops.

Definition of Done:

- Legacy `{ ok, result | error }` consumers keep working.
- A semantic failure cannot be presented as a successful mutation.
- Automatic retry is possible only for explicitly idempotent, retryable calls.
- Repeated identical failures stop with safe alternatives.
- Mutation receipts can identify checkpoint and artifact references.

### F6 - OpenAI Responses SSE

Add an activity-aware Responses SSE parser. Accumulate visible text, usage,
output items, and function arguments separately. Dispatch a native call only
after the protocol marks the item complete.

Definition of Done:

- Fragmented UTF-8, JSON arguments, multiple calls, errors, and usage assemble
  deterministically.
- Partial or malformed calls never execute.
- Any meaningful event resets the stall timer.
- Cancellation closes the stream and propagates through the turn.
- Visible deltas never contain reasoning or tool arguments.

### F7 - Provider cache identity and opt-in continuation

Add a stable OpenAI `prompt_cache_key` based on model, stable instructions, and
the visible tool catalog. Add optional Responses continuation with stateless
behavior as the default.

Definition of Done:

- Stable prefixes produce stable keys; model, instructions, or tool changes
  produce different keys.
- Keys contain no prompt text, user identity, or credential material.
- Stateless mode remains the default and remains ZDR-compatible.
- Opt-in continuation is isolated by session, provider, endpoint, model,
  credential lease, project/scope, prompt, and tool identity.
- Unsupported or ZDR continuation falls back to local replay before any side
  effect is duplicated.

### F8 - Structured asynchronous context ledger

Improve `compressLiveContext` instead of adding a competing compressor. Build a
structured digest of objective, authorization, decisions, evidence, changed
resources, tool receipts, artifacts, pending work, blockers, failures, and next
action. Prepare candidates early, but install them only through the existing
usage-aware thresholds.

Definition of Done:

- Current input and recent tool call/result pairs remain exact.
- Secret values and model reasoning never enter a digest.
- Durable evidence, tool-output, artifact, and checkpoint references survive.
- Failed background preparation never blocks a request.
- Manual preview and restore are possible before replacement.
- The older competing compaction path is retired after compatibility tests.

## Phase 2 - Projects, Orchestration, and Workspace Product Layer

Phase 2 builds on the metadata, telemetry, streaming, and context foundations
from Phase 1.

### F1 - Project composition root

Add a durable ProjectStore binding workspace root, instructions, memory scope,
secret references, active skills, model/routing profile, MCP grants, policy,
hooks, schedules, Kanban board, sessions, and artifacts.

Definition of Done:

- Project identity is enforced at storage and tool boundaries, not only in a
  prompt.
- Workspace paths, memory, secrets, and capabilities cannot cross projects.
- Existing sessions map to a backward-compatible default project.
- Create, select, update, archive, CLI, HTTP, and dashboard surfaces exist.

### F2 - Durable policy-aware jobs

Add bounded start, status, wait, collect, and cancel operations for direct tools
and subagents.

Definition of Done:

- Default concurrency is three.
- Every child inherits policy, approval, budget, abort, checkpoint, and
  redaction boundaries.
- Parallel mutations require declared disjoint resource locks.
- State survives restart through JSONL and atomic snapshots.
- Large results use tool-output references.

### F3 - Semantic browser

Add an optional Playwright/CDP service with compact accessibility and DOM
snapshots, generation-scoped element references, and screenshots on demand.

Definition of Done:

- Navigation, inspection, input, selection, scrolling, download, upload, and
  screenshots are supported.
- Stale references fail after navigation or DOM-generation changes.
- Page content is labeled untrusted.
- Domain changes, credentials, uploads, and submissions use current approval
  policy.
- Benchmarks show lower context use than equivalent screenshot loops.

### F4 - Artifact Canvas and session branching

Build a versioned Markdown/data artifact surface on DraftStore and Deliverable
Mode. Add branch-from-message without mutating the source transcript.

Definition of Done:

- Artifacts use revisions and reject stale writes.
- Every version is recoverable and project-contained.
- Session branches share only the selected prefix.
- Canvas updates are available through authenticated HTTP and SSE.

### F5 - Solution-recipe memory

Add procedural memories with preconditions, actions, evidence, verification,
failure modes, and supersession. Verified recipes can become skill candidates.

Definition of Done:

- Facts and recipes are recalled independently.
- Failed or unverified attempts cannot silently become recipes.
- Embedding identity is persisted and model changes trigger controlled
  reindexing.
- Human search, edit, delete, supersede, and export are supported.

### F6 - Profiles, active skills, and capability grants

Add named project/session profiles for persona, model choices, active skills,
and tool grants. Stage ZIP/Git skill imports for review. Capability bundles are
disabled by default and declare filesystem, network, secret, subprocess, API,
UI, and hook access.

Definition of Done:

- Imported code cannot execute before explicit approval.
- Grants are project-scoped, revocable, and auditable.
- Skill bodies remain progressively loaded.
- Arbitrary function patching is unsupported.

### F7 - Workspace timeline

Add a debounced, post-mutation timeline alongside the existing pre-mutation
CheckpointStore.

Definition of Done:

- Content-addressed snapshots support list, diff, preview, travel, and revert.
- Current state is snapshotted before travel or revert.
- Sensitive paths, symlinks, repositories, large binaries, quotas, and garbage
  collection have deterministic rules.
- Existing checkpoints remain the fast pre-mutation safety gate.

### F8 - Sandboxed persistent terminal sessions

Add explicit PTY sessions for REPLs, debuggers, and long-running commands.

Definition of Done:

- Starting a session requires approval.
- Every submitted command crosses catastrophic policy.
- Session count, process count, CPU, memory, output, idle time, and lifetime are
  bounded.
- Sessions are project-confined or containerized and reconcile cleanly after a
  restart.

## Explicit non-goals

- No Python, LiteLLM, Flask, or FAISS port.
- No full XFCE or LibreOffice desktop.
- No default-enabled arbitrary plugins.
- No LLM-based security gate.
- No raw chain-of-thought display or persistence.
- No A2A layer without a concrete interoperability requirement.

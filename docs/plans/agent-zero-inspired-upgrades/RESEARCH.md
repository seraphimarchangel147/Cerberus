# Agent Zero Clean-Room Research Report

This report records the research behind the
[two-phase Agent Zero-inspired upgrade plan](./README.md). It is a behavioral
and architectural comparison, not a porting guide.

## Research scope

- Upstream reviewed: [agent0ai/agent-zero](https://github.com/agent0ai/agent-zero)
- Upstream snapshot: `391fab94691d68956269b509e342ae1e1b876864`
- Review date: 2026-07-23
- Upstream license at that snapshot: MIT
- Evidence reviewed: public documentation, repository layout, plugin and tool
  manifests, API inventory, and focused tests and implementation boundaries.
- Cerberus evidence reviewed: current Node ESM runtime, existing tests, Hermes
  Parity Wave 3 plans, and the safety, persistence, provider, memory, and tool
  paths that the new work must extend.

No Agent Zero source code, test fixture, prompt text, documentation prose, UI
asset, or distinctive implementation structure is reproduced here. Feature
names below identify observable product behavior only.

## Executive findings

Agent Zero's strongest ideas for Cerberus are not its desktop shell or its
Python stack. They are the smaller mechanisms inside the harness:

1. Provider continuation and stable prompt prefixes can reduce repeated input.
2. Streaming tool protocols can improve responsiveness without dispatching
   incomplete calls.
3. Dynamic skills, plugins, and project scope improve capability awareness.
4. Focused subordinate contexts, parallel jobs, and persistent terminals make
   long tasks practical.
5. Projects, browser semantics, editable artifacts, chat branches, and workspace
   history turn an agent loop into a usable work environment.

Cerberus should adopt these ideas only where it can make them safer or more
measurable. It should retain stateless and fail-closed defaults, deterministic
policy gates, bounded persistence, content-free telemetry, and its plain Node
ESM architecture. Feature parity is not the objective.

## Upstream feature inventory by subsystem

| Subsystem | Observed Agent Zero capabilities | Clean-room signal for Cerberus |
| --- | --- | --- |
| Agent loop | Iterative model and tool loop, streamed response handling, goal support, subordinate agents, parallel work, wait and user notification | Keep focused contexts and live progress, but expose runtime facts rather than model reasoning |
| Provider and token path | Multi-provider model layer, OpenAI Responses support, provider response continuation, prompt-cache identity, usage handling, model presets, OAuth-backed plans | Add native, bounded provider optimizations without adopting the provider abstraction stack |
| Tools and execution | Code execution, persistent shell sessions, Python and Node runtimes, search, vision, document query, scheduler, browser, MCP, and A2A | Improve tool reachability, outcome semantics, and bounded jobs before expanding execution surface |
| Context and memory | Vector recall, knowledge import, memory fragments and solutions, consolidation, chat compaction, loaded-skill reattachment, human memory curation | Build a structured evidence ledger on Cerberus memory tiers and thresholds instead of adding a second memory system |
| Orchestration | Hierarchical subagents, parallel jobs, external coding-agent adapters, scheduled tasks, and status surfaces | Make delegation durable and policy-inheriting, with explicit concurrency and resource locks |
| Projects and profiles | Project-scoped files, instructions, memory, secrets, model settings, Git workspaces, agent profiles, and active skills | Use a project composition root that enforces isolation in storage and dispatch, not only in prompt context |
| Browser and desktop | Playwright browser, DOM annotation, screenshot history, host-browser bridge, container desktop, and GUI application control | Prefer a compact semantic browser first; a general desktop is too broad for the current threat and resource model |
| Documents and artifacts | Live Markdown editing, LibreOffice cowork, uploads, file browser, and document parsing with bounded OCR and indexing | Build versioned text and data artifacts first; do not import a desktop office stack |
| Extensibility | Editable prompts, tools, skills, lifecycle extensions, project configuration, MCP, and a plugin hub | Preserve reviewable skills and registry tools; use capability grants rather than arbitrary function patching |
| Recovery and persistence | Chat branching, backups, workspace time travel, history compaction, and persisted project state | Combine post-mutation history with Cerberus pre-mutation checkpoints and atomic event-backed stores |
| Product and operations | Web chat, Canvas panels, dashboard settings, REST APIs, WebSockets, notifications, voice, channels, tunnels, launcher, and self-update | Add only authenticated surfaces that reuse the same runtime policy and redaction paths |
| Safety posture | Docker isolation, project secrets, stream masking, plugin validation and scanning, and user warnings for powerful host access | Useful defense-in-depth, but not a replacement for deterministic per-action policy, approval, and rollback |

The upstream README also advertises a community catalog of more than 100
plugins. That is an ecosystem claim, not a reason to make arbitrary third-party
code executable by default in Cerberus.

## Where Cerberus is already stronger

These are advantages for Cerberus's local proactive-agent threat model, not a
claim that it has the broader product surface.

| Area | Existing Cerberus advantage |
| --- | --- |
| Action safety | Catastrophic classification, approval suspension and resume, URL guards, hook vetoes, and pre-mutation checkpoints sit on the real dispatch path and remain effective in the production auto-approve lane |
| Durability | Core stores use append-only JSONL plus atomic snapshots, with restart replay and reconciliation rather than relying on prompt state |
| Proactivity | Directional scrutiny, observations, outreach, planners, pattern and session mining, persistent goals, skill curation, and bounded specialists are native loops rather than chat-only features |
| Memory design | Short, medium, and durable memory tiers include correction handling, decay, promotion and demotion, dual-threshold compression, and an optional external provider |
| Provider control | Native OpenAI and Anthropic paths already include budgets, cost attribution, request and turn guards, stall handling, bounded retries, credential pools, routing, and zero-retention-friendly request behavior |
| Tool governance | Registry dispatch, MCP normalization, specialist and read-only scope, approvals, hooks, checkpoints, and telemetry form one policy pipeline |
| Code-change safety | File edits can be followed by LSP diagnostics and rollback-aware handling instead of treating a successful write as a successful change |
| Secret handling | The secrets store, setup allowlist, redaction, and scoped injection avoid using prompts as a credential transport |
| Verification discipline | Every safety-sensitive feature must pass both non-auto-approve and production-policy test lanes; raw model reasoning is neither a required output nor a persisted diagnostic |
| Runtime footprint | Plain Node ESM is smaller and easier to audit for this daemon than adopting Python, LiteLLM, FAISS, Flask, a desktop environment, and a large plugin runtime together |

The most important deliberate divergence is reasoning visibility. Agent Zero has
surfaces for reasoning streams. Cerberus should retain only bounded operational
progress such as iteration count, tool phase, latency, usage, and stop reason.
Raw model reasoning must not enter UI streams, logs, ledgers, memory, or error
recovery.

## Gaps and selected opportunities

Detailed Definitions of Done are in the [two-phase plan](./README.md). The
selection below explains why each item survived the audit.

### Phase 1: execution intelligence and token efficiency

| Feature | Upstream idea worth adapting | Cerberus improvement |
| --- | --- | --- |
| Canonical provider request assembly | Rich project and per-turn context composition | Persist the raw turn once, construct one canonical provider turn, and measure shape without logging content |
| Safe efficiency telemetry | Provider usage, streaming, and cache-aware behavior | Extend the authoritative cost ledger with content-free request, schema, cache, compression, latency, and tool-outcome facts |
| Typed capability manifest | Extensible tool and plugin metadata | Normalize domain, effect, requirements, cost, latency, examples, and success criteria while keeping `sideEffects` authoritative |
| Reachability-preserving tool radar | Dynamic tools, skills, MCP, and plugin discovery | Enforce a hard advertised-tool cap while reserving search, describe, and call bridges so every eligible omitted tool remains reachable |
| Semantic tool outcomes | Loop repair and reusable working patterns | Add typed status, evidence, artifacts, verification, retryability, and mutation receipts without breaking legacy tool results |
| OpenAI Responses SSE | Native streaming and structured provider output | Parse fragmented events incrementally, stream only visible text, reset on activity, and dispatch only protocol-complete valid calls |
| Cache identity and continuation | Prompt caching and provider response chaining | Use a deterministic secret-free key, default continuation off, isolate bounded RAM state by all security identities, and replay statelessly once before side effects |
| Structured asynchronous context ledger | Compaction, memory recall, and loaded-skill continuity | Prepare structured summaries early but install only at existing thresholds; preserve exact recent tool pairs and durable evidence references |

Phase 1 begins with request correctness and telemetry because later efficiency
claims are meaningless without a trustworthy baseline. Capability metadata then
supports search and semantic outcomes. Streaming, caching, and continuation can
be added after the tool boundary is explicit. The context ledger comes last
because it consumes the metadata, outcomes, usage, and evidence produced by the
earlier work.

### Phase 2: projects, orchestration, and workspace product layer

| Feature | Upstream idea worth adapting | Cerberus improvement |
| --- | --- | --- |
| Project composition root | Project-scoped workspaces, memory, secrets, skills, models, and Git | Enforce project identity in stores, paths, tools, policy, jobs, sessions, and artifacts, with a backward-compatible default project |
| Durable policy-aware jobs | Parallel work, subordinate agents, and scheduler tasks | Persist bounded jobs and make every child inherit policy, approvals, budgets, cancellation, checkpoints, and redaction |
| Semantic browser | Browser automation, DOM inspection, annotation, and screenshots | Use compact accessibility and DOM snapshots with generation-scoped references and approval on sensitive transitions |
| Artifact Canvas and branching | Live documents, Canvas surfaces, and chat branching | Build revisioned Markdown and data artifacts with stale-write rejection and prefix-only session branches |
| Solution-recipe memory | Solution memory and learned reusable procedures | Separate facts from verified recipes and require preconditions, evidence, verification, failure modes, and supersession |
| Profiles, skills, and grants | Agent profiles, active skills, and plugin ecosystem | Stage imports for review and grant explicit project-scoped filesystem, network, secret, process, API, UI, and hook capabilities |
| Workspace timeline | Time travel and diff inspection | Add content-addressed post-mutation history beside, not instead of, the existing fast pre-mutation checkpoint gate |
| Sandboxed terminal sessions | Persistent local or remote shells | Require approval per session, policy-check every command, confine the workspace, and bound process, CPU, memory, output, idle time, and lifetime |

Phase 2 starts with project identity because every later feature needs an
isolation key. Jobs establish inheritance and cancellation before browser or
terminal work can run asynchronously. Artifacts, recipes, profiles, and history
then share the same project boundary. Persistent terminals are last because
they have the widest execution and resource surface.

## Proposed benchmark and acceptance matrix

All efficiency comparisons should use a fixed task corpus, the same provider
and model, cold and warm runs, and at least 30 samples for median and p95
reporting. A candidate fails if it saves tokens but reduces end-to-end task
success by more than two percentage points.

| Area | Baseline and measure | Initial acceptance gate |
| --- | --- | --- |
| Provider assembly | Count current-turn text, references, and images in serialized requests | Exactly one current turn in every first, repeated, multi-turn, ephemeral, and image case; durable transcript unchanged |
| Telemetry privacy | Seed prompts, tool data, and credentials with unique sentinels, then inspect every ledger field | Zero sentinel leakage; existing cost totals remain byte-for-byte authoritative |
| Tool radar | Compare full core registry with capped advertised catalog | Cap never exceeded, 100 percent eligible-tool reachability, at least 90 percent top-five retrieval on a labeled query set, and at least 40 percent schema-byte reduction |
| Tool outcomes | Run success, semantic failure, verifier failure, retry, and repeated-failure cases | Zero false-success mutations; zero retry of non-idempotent calls; repeated identical failure stops within two repair cycles |
| Responses SSE | Randomly fragment Unicode, events, JSON arguments, multiple calls, failures, usage, and cancellation across 1,000 seeds | Exact reconstruction and usage, zero partial or malformed executions, zero private deltas, and cancellation p95 below 250 ms after signal |
| Cache and continuation | Compare ten-turn stateless and opt-in runs | Stable identity in 100 percent of equal-prefix cases, at least 20 percent lower median repeated-input tokens on the corpus, and zero duplicate side effects during fallback |
| Context ledger | Compare full replay with compressed long tasks | At least 30 percent lower median provider input, exact current turn and recent tool pairs, 100 percent durable-reference retention, zero secret or reasoning leakage |
| Project isolation | Attempt path, memory, secret, skill, MCP, job, session, and artifact crossover | Zero cross-project reads or writes in positive, negative, restart, and concurrent-session tests |
| Durable jobs | Saturate, cancel, restart, and race direct-tool and subagent jobs | Active children never exceed three by default; state reconciles after restart; conflicting mutations serialize or fail before dispatch |
| Semantic browser | Run matched form, navigation, extraction, and review tasks using semantic snapshots and screenshot loops | At least 40 percent lower median context input with no material loss in action success; every stale reference fails |
| Artifacts and branching | Race revisions and branch at every message type | 100 percent stale-write rejection; every version recoverable; source transcript hash unchanged by branching |
| Recipes | Seed verified, failed, stale, and superseded procedures | Only verified procedures become recallable recipes or skill candidates; embedding changes trigger controlled reindexing |
| Timeline and rollback | Mutate, travel, diff, and restore text, binary, symlink, ignored, and sensitive paths | Eligible files restore byte-identically; sensitive and unsupported paths fail closed; current state is captured before travel |
| Terminal sessions | Exercise approval, destructive commands, runaway output, process trees, idle, lifetime, and restart | 100 percent of commands cross policy; caps are enforced; termination closes the process tree and leaves no reusable orphan |

Every feature also runs `npm test` with `OPENAGI_AUTO_APPROVE=0` and
`npm run test:prod-policy` with `OPENAGI_AUTO_APPROVE=1`. Safety gates must pass
without environment pinning. Benchmarks record only counts, timings, usage, and
outcomes, never prompts, reasoning, credentials, or tool payloads.

## Clean-room and licensing hygiene

The upstream MIT license is permissive, but this project has chosen a stricter
non-copy path. Permissive licensing does not erase provenance, attribution,
trademark, security-review, or maintenance concerns.

Rules for this program:

1. Treat upstream as behavioral research only.
2. Record the reviewed repository, commit, date, and license, as this report
   does.
3. Do not copy source, prompts, fixtures, documentation, UI assets, file layout,
   class layout, or distinctive names and wording.
4. Write independent Cerberus requirements against its own policy, persistence,
   provider, and registry abstractions.
5. Build independent tests from the Definitions of Done and benchmark corpus,
   not by translating upstream tests.
6. Do not use Agent Zero branding, screenshots, icons, or imply compatibility
   or endorsement.
7. If literal reuse is ever proposed, stop the clean-room path and perform a
   separate license, notice, provenance, security, and maintenance review
   before any code enters the repository.

The temporary research checkout is not a dependency, submodule, vendored
component, or implementation input. The implementation plan is self-contained
in this repository.

## Explicit non-goals

- No feature-parity target or UI clone.
- No Python, LiteLLM, Flask, FAISS, or upstream plugin-runtime port.
- No XFCE, general desktop, or LibreOffice stack.
- No default-enabled arbitrary plugin execution or function patching.
- No weakening of catastrophic policy, approvals, checkpoints, budgets,
  redaction, secret scoping, or production-policy tests for convenience.
- No LLM-based security gate.
- No raw chain-of-thought display, salvage, logging, persistence, or memory.
- No A2A layer without a concrete interoperability requirement.
- No provider continuation as a required or persisted default.
- No token optimization accepted without task-success and side-effect-safety
  measurements.

## Decision

Proceed with the [two-phase plan](./README.md). Phase 1 is authorized as the
measurable harness-improvement layer. Phase 2 remains contingent on Phase 1
correctness, privacy, reachability, task-success, and token-efficiency results.

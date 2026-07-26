# High-Assurance Agent Harness - Two-Phase Upgrade Map

This map turns the informal "god tier" target into properties that can be
tested. The harness is not considered exceptional because it can call many
tools. It is exceptional only when it can act quickly, show what happened,
prove the result, recover from failure, and refuse to manufacture certainty.

The design is clean-room and implementation-specific to Cerberus. Ideas from
other coding agents and harnesses are treated as research inputs, not source
code.

## Non-negotiable properties

- One governed tool kernel owns validation, scope, policy, hooks, approval,
  checkpoints, dispatch, receipts, verification, and telemetry.
- State-changing work uses compare-and-swap or revision authority.
- Completion claims require same-turn execution and verification evidence.
- UI correctness requires deterministic browser checks; screenshots alone are
  never a correctness oracle.
- Browser and desktop control is semantic-first. Coordinate fallback requires
  fresh, exact visual evidence.
- Persisted visibility is content-free unless the user explicitly opens an
  owned artifact.
- Speed improvements may overlap independent reads, reuse stable prefixes, or
  reduce schemas. They may not lower the model, skip checks, or weaken policy.
- Every loop has finite iterations, time, output, concurrency, and mutation
  budgets.
- Durable stores use append-only JSONL authority plus atomic JSON snapshots.
- All identifiers and protocol fields are ASCII.

## Phase 1 - Evidence-Carrying Execution Core

Status: complete.

Phase 1 made coding actions transactional and made claimed completion depend on
evidence instead of model confidence.

Delivered:

1. Tool Contract V2 validates bounded inputs before any policy surface and
   validates declared outputs after dispatch.
2. Canonical receipts distinguish dispatch, change certainty, semantic
   outcome, timing, and evidence without retaining arguments.
3. Fail-closed security hooks prevent a broken built-in veto from becoming an
   allow decision.
4. End-to-end cancellation prevents new dispatch after abort and reports
   uncertain post-dispatch mutation honestly.
5. Resource-aware batching overlaps only independent work and preserves result
   order.
6. Transactional code edits use full SHA-256 compare-and-swap authority and
   syntax validation before atomic replacement.
7. Isolated verification runs bounded syntax and test checks in scrubbed
   subprocesses.
8. The coder controller binds inspected baselines, immutable acceptance
   criteria, checks, rollback checkpoints, and exact post-edit evidence.
9. Web QA inventories controls, checks behavior, accessibility, keyboard
   navigation, console/network health, screenshots, visual baselines, and
   failure traces.
10. Run Inspector exposes content-free live execution, verification,
    acceptance, rollback, cost, and artifacts.
11. Completion routing keeps the relevant coder and QA tools visible and
    rejects unsupported "done" claims.

Phase 1 acceptance:

- A failed or blocked tool cannot satisfy completion evidence.
- A code mutation cannot be called complete without passing verification.
- A user-facing UI mutation cannot be called complete without browser and
  visual QA.
- Independent preparation reads overlap without changing provider prompt
  bytes.
- Both approval-policy test lanes pass with zero failures.

## Phase 2 - Governed Perception and Autonomous QA

Status: active.

Phase 2 connects perception, interaction, exhaustive UI exploration, and bug
discovery to the Phase 1 evidence kernel.

### F1 - Unified semantic-first computer use

Status: complete.

One project/session-scoped control plane serves isolated browser control and an
optional remote desktop node.

Required properties:

- A user-approved goal opens one bounded session with a hard mutation budget.
- Every action cites the exact latest observation revision and generation.
- Browser actions prefer opaque semantic refs.
- A coordinate click requires a recent viewport screenshot, exact SHA-256,
  matching live generation, in-bounds coordinates, and a recorded reason that
  semantic control was unavailable.
- Every action records a fresh post-action observation or reports
  `executed-unverified`; it never encourages a blind retry.
- Typed text and screenshot bytes never enter JSONL, snapshots, lifecycle
  events, Run Inspector, or ordinary transcripts.
- Desktop execution without a real node fails honestly after recording intent.
- Run Inspector shows strategy, observation revision, and verification status
  without content.

### F2 - Bounded UI state-space explorer

Status: complete.

Extend Web QA with deterministic state-graph exploration rather than an
unbounded screenshot-click loop.

Required properties:

- Normalize route, DOM generation, visible control state, URL, focus, and
  application signals into a bounded state identity.
- Explore with configurable maximum states, depth, actions, and wall time.
  Replay is deliberately single-lane until independently isolated fixture
  contexts can be proven not to race shared application state.
- Prefer fixture-safe semantic actions and require explicit exemptions for
  destructive, outbound, credential, payment, or publish controls.
- Capture transition receipts with source state, action, target state, and
  deterministic oracles.
- Detect dead controls, missing feedback, stuck loading, focus loss, keyboard
  traps, unexpected navigation, console/page/network errors, accessibility
  regressions, and visual changes.
- Save screenshots at failures and material state transitions, not every
  iteration.
- Minimize a failing path and emit a replayable trace.

Delivered:

- `qa_run` accepts `mode='explore'` and runs the ordinary route proof before
  bounded breadth-first exploration.
- Each branch starts from a fresh page and replays the shortest known semantic
  control path, so sibling actions cannot accidentally inherit browser state.
- Randomly salted state identities include URL target, page readiness, busy
  state, body signal, and accessible control state without persisting those
  raw values.
- The stored graph contains only opaque state IDs, control IDs, action kinds,
  structural counts, transition status, and owned evidence refs. Raw page
  text, control values, and typed input are absent.
- Deterministic postconditions, route assertions, diagnostics, accessibility,
  keyboard navigation, loading state, disabled controls, dead controls, and
  action discrimination are checked on transitions.
- Destructive controls are excluded by default and can run only when both the
  manifest declares a fixture and its exploration policy explicitly opts in.
- Material states receive screenshots; failed transitions receive screenshots,
  traces, failure codes, and a replay artifact using the shortest known BFS
  path.
- Exhausted state, depth, action, or wall-time budgets fail closed as
  incomplete evidence. Run Inspector exposes only structural progress and
  owned artifact refs.

### F3 - Intent and differential oracle

Status: complete.

Compare observed behavior against immutable acceptance criteria and, when
available, a human-approved visual baseline or reference revision.

Required properties:

- Convert each user-visible criterion into one or more deterministic oracles.
- Keep implementation success separate from design review and product intent.
- Compare old and new revisions under the same manifest, viewport, fixtures,
  browser, and action path.
- Classify changed behavior as intended, regression, improvement candidate, or
  review-required; the model cannot self-approve a baseline.
- Produce a concise bug hypothesis with evidence refs and a minimized replay,
  never hidden reasoning.

Delivered:

- QA manifests can declare up to 32 immutable intent criteria over behavior,
  visuals, accessibility, keyboard navigation, diagnostics, and state-graph
  structure, plus an explicit ASCII `fixtureRevision`.
- `qa_run(referenceRunId=...)` executes and compares in one governed call;
  `qa_compare` reuses existing evidence without another browser pass, and
  `qa_comparison_status` retrieves the durable report.
- Comparisons require distinct source revisions and exact manifest, mode,
  project, session, workspace, fixture contract, and browser execution epoch.
  A passing reference must predate the terminal candidate.
- Structural metrics deliberately exclude randomly salted state IDs and raw
  page content. Behavior, visual, accessibility, keyboard, diagnostic, and
  graph oracles remain separate so one kind of delta cannot impersonate
  another.
- Each criterion is classified as intended, regression, improvement candidate,
  or review required. Required regressions fail; improvements and neutral
  design deltas pause for review instead of being auto-accepted.
- Visual intent changes become intended only when the candidate pixels and
  exact source revision have a manual human baseline approval. The model and
  ordinary tool confirmation cannot self-approve them.
- Concise bug hypotheses contain criterion IDs, classification, deterministic
  basis codes, and owned evidence refs, never hidden reasoning or page text.
- Differential reports use fsynced JSONL authority plus atomic snapshots,
  bounded compaction, corrupt-suffix refusal, strict recovery normalization,
  and input-digest idempotency.
- Coder QA checks can require a reference run. Completion evidence retains the
  exact comparison ID and fails closed if the QA tool omits, swaps, or fails
  that comparison.
- Run Inspector shows only comparison ID, design status, classification counts,
  and the owned report ref.

### F4 - Final hardening and performance proof

Status: next.

- Benchmark semantic observation against screenshot-only loops for tokens,
  latency, retries, and successful task completion.
- Benchmark state exploration on representative forms, navigation, dialogs,
  tables, canvas controls, and responsive layouts.
- Red-team stale pixels, prompt injection in page text, cross-project refs,
  secret reflection, malicious downloads/uploads, approval replay, restart,
  cancellation, and observer failure.
- Run both full test lanes, added-line ASCII scanning, `git diff --check`, and
  dependency audit.

## Definition of "god tier"

The term is earned only if the final system demonstrates all of the following:

- capability: it can inspect, edit, run, browse, interact, test, and recover;
- judgment: it selects the lowest-risk effective tool and knows when evidence
  is insufficient;
- correctness: deterministic checks outrank confident language;
- visibility: users can inspect progress and evidence without exposing private
  content;
- resilience: cancellation, restart, stale state, partial failure, and
  unavailable dependencies fail safely;
- efficiency: equivalent quality uses fewer serial waits, fewer schema tokens,
  and fewer blind visual iterations.

Anything less is a capable agent harness, not a high-assurance one.

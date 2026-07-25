# Hermes Memory and Skills Deep Dive

## Scope and method

This is a design comparison, not a source port. It compares the checked-out
Cerberus harness with Hermes' official documentation and a pinned upstream
source snapshot (`e0dfcf275a22dfd1253c71074c5b6be780e3c965`). The useful
patterns were reimplemented in this repository's Node ESM architecture and
were not copied from Hermes.

Primary Hermes sources:

- [Memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Skills documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Memory-provider documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/)
- [Memory store implementation](https://github.com/NousResearch/hermes-agent/blob/e0dfcf275a22dfd1253c71074c5b6be780e3c965/tools/memory_tool.py)
- [Background-review implementation](https://github.com/NousResearch/hermes-agent/blob/e0dfcf275a22dfd1253c71074c5b6be780e3c965/agent/background_review.py)
- [Skill-manager implementation](https://github.com/NousResearch/hermes-agent/blob/e0dfcf275a22dfd1253c71074c5b6be780e3c965/tools/skill_manager_tool.py)
- [Curator implementation](https://github.com/NousResearch/hermes-agent/blob/e0dfcf275a22dfd1253c71074c5b6be780e3c965/agent/curator.py)
- [External-memory provider contract](https://github.com/NousResearch/hermes-agent/blob/e0dfcf275a22dfd1253c71074c5b6be780e3c965/agent/memory_provider.py)

The factual statements below are tied to those sources. The recommendations
are Cerberus-specific engineering judgments.

## Executive conclusion

Hermes is particularly good at making an agent feel continuously useful: small
frozen memory files, progressive skill disclosure, a practical file layout,
and background curation keep the context compact. Cerberus already had a
stronger policy and durability substrate, so the right adoption was to retain
Hermes' ergonomics while making writes, authority, provenance, and recovery
more explicit.

The resulting Cerberus design is intentionally more conservative in the two
places where an autonomous harness can cause durable harm:

1. A model-generated observation does not become durable memory merely because
   a background reviewer found it plausible.
2. A skill never receives an implicit, unbounded tool grant because its
   metadata is missing or vague.

That tradeoff costs a small amount of automation. It materially improves audit,
rollback, tenant isolation, and resistance to prompt-injected or stale state.

## Memory architecture comparison

| Concern | Hermes | Cerberus now | Design decision |
| --- | --- | --- | --- |
| Prompt footprint | Curated `MEMORY.md` and `USER.md` are bounded (documented defaults: 2200 and 1375 characters) and frozen at session start. | A frozen runtime snapshot separates project memory from a caller-specific profile view; profile memory has its own 800-character budget. | Keep bounded, stable context rather than a growing transcript. |
| Durable representation | Small Markdown files managed through memory tools. | JSONL event authority plus atomic JSON snapshot cache, replay, corruption checks, and cross-process mutation serialization. | Favor recoverable event history where concurrent processes and crash recovery matter. |
| Normal writes | The memory tool supports targeted add, replace, and remove operations. | `remember` and `correct_memory` record provenance and correction or replacement state. | Treat a correction as a relationship, not an untraceable overwrite. |
| Model-generated review | The upstream background-review path can write directly to the memory and skill stores after its constrained review. | Background review emits a screened pending action. Only an exact human-approved replay can apply it. | Preserve learning suggestions while preventing silent durable policy changes. |
| Injection and secret defense | Hermes documents scanning memory content for injection, exfiltration, and invisible Unicode patterns. | Intake rejects prompt-control patterns, invisible or bidi controls, secret-shaped values, and configured secrets before persistence. | Keep a deterministic gate at the persistence boundary. |
| Personal information | Hermes separates user memory from general memory. | Opaque per-caller profile scopes never inherit project, specialist, global, or other-user memory. | Make privacy isolation enforced by scope lookup, rather than a prompt convention. |
| Retrieval confidence | The user sees the bounded curated files in the session prompt. | `memory_details(id)` exposes bounded provenance, confidence, active or superseded state, and correction links without reinforcing the item. | Give the agent a tool-callable reason to verify uncertain memory before external action. |
| External provider | Hermes keeps built-in memory active and permits one external provider with prefetch and lifecycle hooks. | Existing provider wiring remains bounded and policy-gated; this pass did not change synchronization or external retention semantics. | Do not broaden external data flow as a side effect of a local-memory improvement. |

### What Hermes does especially well

The two-file model is a good human interface. It makes the most important
memory visible, predictable, and cheap in tokens. Freezing it at session start
also avoids a moving target while a long turn is in progress. The external
provider abstraction is similarly clean: an integration can augment retrieval
without replacing local memory.

### Why Cerberus differs

The harness has multiple projects, approval gates, background jobs, and durable
operations. A plain mutable file is not enough evidence when two processes can
write it or when an agent must explain why it trusted a fact. Cerberus therefore
uses the event journal as authority and derives a fast atomic snapshot from it.
It also separates factual project knowledge from caller preferences, which
prevents a preference in one chat identity from becoming a project-wide fact.

The practical result is that Cerberus can still inject a compact frozen memory
view, but it can answer four questions that a simple Markdown store cannot
reliably answer: who or what proposed this, whether a person approved it,
whether it was corrected, and whether it belongs to this caller.

## Skills and curation comparison

| Concern | Hermes | Cerberus now | Design decision |
| --- | --- | --- | --- |
| Skill shape | A `SKILL.md` file supports progressive disclosure and may reference templates, scripts, assets, examples, and other support files. | Skills use a registry and validated linked files with an import quarantine and project-bound approval path. | Keep progressive disclosure, but treat imported files as untrusted until approved. |
| Agent editing | Hermes' skill manager can create, edit, patch, delete, and manage support files, subject to its guardrails. | Candidate and active skill changes have revision lineage, bounded static validation, and explicit approval gates. | Make a useful mutation recoverable and attributable. |
| Curation | The Hermes curator periodically classifies, consolidates, pins, archives, and can patch skills; it takes a pre-run backup. | Curator transitions are journaled and reversible through an exact-head, confirmation-gated rollback. | A backup is useful; a verified revision chain is stronger because it detects stale heads and preserves an audit trail. |
| Tool authority | Skill instructions can describe the tools they expect. | An isolated `run_skill` receives only a finite declared or inherited allowlist. Missing both means no tool schemas and an invoke-time empty allowlist. | A missing declaration must fail closed, never default to the full registry. |
| Preflight awareness | Hermes emphasizes readable skill files and progressive disclosure. | `inspect_skill_capabilities(name)` reports the effective tool contract, missing registrations, and boundary denials before execution. | Let the model inspect its authority before it starts a blank-context sub-run. |
| Recovery | Curator backup and skill-management controls protect normal workflows. | `list_skill_revisions` returns compact hash-only history; `rollback_skill` accepts only the current head and requires human confirmation. | Reject guessed or stale recovery targets. |

### What Hermes does especially well

Hermes treats skills as an understandable project structure rather than an
opaque database row. Its support-file model is practical for real work: a skill
can have templates, scripts, references, and examples without putting all of
them in every prompt. Its curator also turns skill maintenance into a normal
runtime behavior rather than an occasional administrator task.

### Why Cerberus differs

Cerberus must assume that a skill can be imported, stale, malformed, or
prompt-injected. The active skill therefore cannot acquire tools merely by
omitting a field. The new capability report makes the effective authority
visible to the model, while revision tools make changes reversible without
quietly restoring obsolete content over a newer human edit.

## Tool-calling and agent awareness lessons

The most useful pattern is not "more tools". It is giving the model compact,
truthful tools for questions it otherwise guesses at:

| Need before an action | Cerberus tool or behavior | Safety property |
| --- | --- | --- |
| Is this remembered fact current and trustworthy? | `memory_details(id)` | Read-only inspection; no strength or recency mutation; scope boundary checked first. |
| Can this imported skill actually use the required tools? | `inspect_skill_capabilities(name)` | Reports finite effective scope, unavailable registrations, and boundary denials. |
| Can I undo this curation change? | `list_skill_revisions` then `rollback_skill` | Hash-linked exact-head recovery plus human confirmation. |
| Should a background observation become memory? | Pending-action review followed by the hidden exact replay handler | The model cannot call the materialization handler directly. |

These tools are documented in `buildDefaultInstructions` so they are in the
model's actual operating contract, not only in server-side code. The prompt also
instructs the model to inspect uncertain memory before using it to justify an
external or irreversible action, and to preflight uncertain skills before
running them.

## Improvements delivered in two phases

### Phase 1: trusted, durable, and reversible state

- Made the file-backed memory journal authoritative and its snapshot cache
  atomic, replayable, serialized across processes, and fail-closed on malformed
  history.
- Added a deterministic memory-intake policy and provenance fields.
- Replaced direct background-review memory writes with screened,
  human-approved pending actions.
- Added caller-isolated profile memory and frozen project/profile snapshots.
- Made isolated skill execution fail closed and added revision-safe curation
  rollback.

### Phase 2: inspectable authority and evidence

- Added `memory_details` for non-mutating provenance and correction inspection.
- Added `inspect_skill_capabilities` for tool-contract preflight.
- Returned the effective tool-scope receipt from skill runs.
- Added explicit system-prompt guidance for evidence-aware memory use and skill
  preflight.

Both phases are original Cerberus implementations using the repository's Node
ESM, registry registration, JSONL, atomic snapshot, and approval conventions.

## Deliberately deferred follow-ups

These are worthwhile ideas, but they should be separately designed rather than
silently folded into a memory or skill patch:

1. A durable external-memory outbox with delivery receipts, replay policy,
   retention controls, and per-scope export consent. It would change external
   data handling and needs a focused privacy review.
2. A signed portable skill bundle format. It should extend the existing
   quarantine and approval lineage instead of assuming that a signature makes
   executable support files safe.
3. A curator recommendation dashboard that ranks stale memories and skills but
   keeps material changes confirmation-gated. This can restore more of Hermes'
   maintenance ergonomics without reinstating autonomous state mutation.
4. A compact capability digest in the initial prompt for only the active skill
   set. It should be measured against token budget before being enabled, with
   `inspect_skill_capabilities` remaining the detailed on-demand path.

## Verification

The implementation was validated in both approval modes after each feature:

- `OPENAGI_AUTO_APPROVE=0 npm test`
- `OPENAGI_AUTO_APPROVE=1 npm run test:prod-policy`

The final repository validation is recorded with this research note's commit.

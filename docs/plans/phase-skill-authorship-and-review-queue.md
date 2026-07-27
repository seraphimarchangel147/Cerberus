# Phase: skill authorship at will + pattern-miner as a human review queue

**Read this document in full BEFORE editing any implementation file.**
Anchors are file:line at baseline `6a1f4bc`. This phase CORRECTS a design
decision from the previous phase — read the "What changed and why" section
first so you do not reintroduce it.

---

## What changed and why (owner decision, 2026-07-27)

The previous phase (`docs/plans/phase-autonomous-skills-and-budget-off.md`)
made the pattern miner auto-create skills behind confidence gates and a
3-per-day cap. The owner rejected that split. His instruction, verbatim:

> "I want it to create and use skills like Hermes at will when it learns
> something new it wants to remember after doing something hard like you, and
> I want it to be able to actively use relevant skills. I think a better idea
> is to keep the pattern miner for manually approvable skills that I can
> choose to be learnt or discarded or left to be determined or edited and
> refined."

This is a cleaner separation than what shipped, and it inverts the autonomy:

- **Agent judgment → unlimited and immediate.** When the agent itself
  finishes something hard and decides the procedure is worth keeping, it
  writes the skill. No cap, no confidence score, no queue. This is exactly how
  Hermes works: there is **no daily creation limit anywhere** in Hermes'
  `skill_manager_tool.py` — creation is gated by the agent's judgment alone.
- **Statistical mining → always a human queue.** The pattern miner is a
  correlation detector, not a judgment. Its output is a *proposal* for the
  owner to accept, discard, defer, or edit. It must never write a skill by
  itself.

The previous phase got this backwards: it capped the trustworthy lane
(judgment) and automated the untrustworthy one (statistics).

---

## Measured findings — verify these yourself, then fix them

All three were confirmed against the LIVE daemon on 2026-07-27, by asking the
running agent directly. Re-verify before relying on them.

### Finding 1 — the agent CANNOT create or edit skills (the core bug)

`CHAT_CORE_TOOLS` at `src/agent-host.js:51-76` includes `use_skill`,
`run_skill`, and `list_skills`, but **not** `create_skill`, `edit_skill`,
`pin_skill`, or `delete_skill`.

Asked "from your current tool list, is use_skill available, is create_skill
available, is edit_skill available", the live agent answered:
`(1) yes (2) no (3) no`.

So the agent can *read* its library but cannot *write* to it on the chat lane.
The whole "learn something after doing something hard" behaviour is
unreachable — which is the single biggest gap between him and Hermes.

### Finding 2 — the system prompt promises tools that are not there

`promptIndex()` at `src/skills.js:168-170` injects a mandatory-scan directive
ending with: *"If a skill you used was wrong, stale, or missing a step, patch
it immediately with edit_skill. Delete irrelevant skills with delete_skill."*

Asked whether those tools were reachable, the live agent said:
*"Yes — the system prompt says to patch stale skills with edit_skill... Neither
tool is in my current tool list."*

The prompt is instructing him to call tools he does not have. That is the same
class of defect the comment at `src/agent-host.js:57-59` already identifies for
`use_skill` ("that directive is a lie if use_skill isn't reachable") — the fix
was applied to `use_skill` and not to the authoring tools named in the same
paragraph.

### Finding 3 — the skill index itself works, leave it alone

`promptIndex()` IS wired (`src/agent-host.js:2119-2125`) and IS live: the agent
recited all 15 skill names from its prompt with zero tool calls. Do not rebuild
this. It is the "actively use relevant skills" half of the request and it
already functions.

---

## Workstream A — the agent authors its own skills, at will

### A1. Make the authoring tools reachable

**Anchor:** `CHAT_CORE_TOOLS`, `src/agent-host.js:51-76`.

Add `create_skill` and `edit_skill` to the core set, with a comment matching
the existing `use_skill` rationale: the prompt index explicitly orders the
model to create and patch skills, so those tools must be reachable on the same
lane or the directive is a lie.

Do **not** add `delete_skill` or `pin_skill` to core. Deletion is destructive
and already carries `needsConfirmation: true`
(`src/skills.js:823`); it stays behind `searcmcp_tools`. Instead, **remove the
"Delete irrelevant skills with delete_skill" sentence** from the `promptIndex`
directive at `src/skills.js:170` — it is the one instruction there that should
not be reflexive. Keep the `edit_skill` patch instruction; that one becomes
true once A1 lands.

Check the tool-budget interaction before committing: `OPENAGI_MAX_MODEL_TOOLS`
(`src/tool-registry.js:2570`) caps how many tools reach the model. Adding two
core tools must not silently push the radar bridges out. Verify the core set
still fits and add a test asserting `create_skill` and `edit_skill` survive
tool-budget trimming on the chat lane.

### A2. No cap on agent-authored skills

**Anchor:** `DEFAULT_AUTO_MAX_PER_DAY = 3`, `src/skill-autocurator.js:19`.

The cap only ever applied to the auto-materializer, but the semantics are
wrong and the setting is about to change meaning. Per the owner: agent-authored
skills are unlimited, like Hermes. Two concrete changes:

1. `create_skill` (`src/skills.js:698-720`) must have **no rate limit of any
   kind** — confirm none is introduced anywhere, including in
   `assertDefaultProjectSkillControl`.
2. In `resolveAutoMaterializeConfig` (`src/skill-autocurator.js:303`), make
   `OPENAGI_SKILL_AUTO_MAX_PER_DAY` accept `"off"`/`"none"`/`"unlimited"` ⇒ no
   cap (represent as `null`, short-circuit the check — do NOT use `Infinity`
   or a sentinel), and make `0` **throw** naming `off`, exactly like
   `resolveDailyLimit` in `src/budget-guard.js:26-46`. Reuse that function's
   shape so the codebase has ONE meaning for "no limit". Today `0` silently
   means "create nothing", which is the same zero-means-brick trap that was
   just removed from the budget guard.

### A3. Prompt the behaviour, don't just enable it

**Anchor:** the directive string at `src/skills.js:168-171`.

Enabling a tool is not the same as producing the behaviour. Hermes gets skill
authorship because its system prompt explicitly tells it *when* to create one.
Extend the `promptIndex` directive with a creation trigger, phrased close to
Hermes' own wording:

> After completing a non-trivial task (5+ tool calls), fixing a tricky error,
> or discovering a workflow you would want to repeat, call create_skill to save
> the procedure — numbered steps, exact commands, and the pitfalls you hit. If
> the user corrects your approach, save the corrected version. Skip this for
> simple one-offs.

Keep it tight; this string is in EVERY system prompt and long additions cost
tokens on every turn. Add a test asserting both the creation trigger and the
`edit_skill` patch instruction are present, and that `delete_skill` is no
longer mentioned.

---

## Workstream B — pattern miner becomes a real review queue

The miner keeps running and keeps proposing. It stops writing.

### B1. Auto-materialization off by default

**Anchor:** `resolveAutoMaterializeConfig`, `src/skill-autocurator.js:303-307`.

`OPENAGI_SKILL_AUTOCURATE` currently defaults **on**. Flip the default to
**off**. Mined candidates stay `pending` for the owner. Keep the env var and
all its gates working so the automatic mode remains available for anyone who
opts in — do not delete `autoMaterializeCandidates`, just stop it running
unbidden. Update the `CHANGES.md` entry from the previous phase to state the
new default and why it changed.

The daily cron handler (`src/abi-runtime.js:1144-1152`) must still call it, so
an opt-in user gets identical behaviour; it will simply return
`{ enabled: false, reason: "disabled" }`.

### B2. The four owner verdicts

The owner asked for candidates he can "choose to be learnt or discarded or
left to be determined or edited and refined". Today
`resolveSuggestion` (`src/suggestion-feed.js:44`) supports accept/reject only.
Add the missing two:

- **accepted** → materialize now (existing path,
  `src/hosted-interface.js:3777-3790`). Unchanged.
- **rejected** → existing path. Unchanged.
- **deferred** (NEW) → "left to be determined". Stays in the queue but is
  hidden from the default pending view so it stops nagging. Record
  `deferredAt`. It must be resurfacable — add a filter so the dashboard can
  list deferred candidates explicitly.
- **edited** (NEW) → "edited and refined". Accept a modified
  `proposal.body`/`proposal.name` supplied by the owner, persist the edit onto
  the candidate, then materialize from the EDITED content. Stamp lineage
  `editedByOwner: true` alongside the existing source stamps so an edited
  skill is distinguishable from a verbatim one.

Route both through the existing status validation — do not let arbitrary
status strings through. Extend `ENVELOPE_FIELDS` (`src/suggestion-feed.js:18`)
with the new fields so they survive the normalize round-trip.

### B3. Dashboard controls

**Anchor:** the suggestion card UI in `src/hosted-interface.js` (grep the
accept/reject handlers near line 3777).

Each pending skill candidate gets four controls: **Accept**, **Edit & Accept**
(opens the proposed body in an editable textarea, submits the edited version),
**Defer**, **Discard**. Show the miner's evidence on the card — occurrence
count and confidence from `candidate.sequence` — so the owner is deciding on
data, not vibes. Add a toggle to view deferred candidates.

### B4. Notify, don't silently queue

A review queue nobody looks at is the same as no queue. When the miner
produces a new skill candidate, emit a runtime event (mirror the
`skill-autocreated` emit at `src/skill-autocurator.js:~132`, name this one
`skill-candidate-proposed`) carrying id, title, occurrences and confidence, so
the Discord lane can surface "I noticed a pattern N times — want me to learn
it?" Keep the emit advisory and wrapped in try/catch like the existing one.

---

## Hard constraints (environment — you cannot discover these yourself)

- Node repo, **zero runtime dependencies**. Do not add a package.
- Gate with `node --test`. Baseline is **1901 passing, 0 failing, 24 skipped**
  (the 24 are pre-existing browser-dependent QA tests). Record the count in
  `CHANGES.md` before you start; do not finish below it.
- A live daemon runs from a DIFFERENT checkout under systemd. **Do not
  restart, kill, or touch any running process.** Work in this clone only.
- ASCII only in identifiers and filenames. No Cyrillic/fullwidth lookalikes
  anywhere in the diff — it will be byte-scanned on review.
- Commit each workstream separately. Workstream A first.
- Every new/changed env var documented in `CHANGES.md` with its default and
  unset behaviour, including the CHANGED default of
  `OPENAGI_SKILL_AUTOCURATE`.
- Do not weaken any existing guard: pinned skills stay untouchable, every
  mutation still goes through `appendSkillRevision` so `rollback_skill` works,
  and project-boundary preflights (`assertDefaultProjectSkillControl`) stay in
  place on every authoring tool you expose.

## Required verification before you claim done

Beyond unit tests, prove Finding 1 is actually fixed by reasoning about the
resolved chat-lane tool list in a test: assert that a chat-lane turn advertises
`create_skill` and `edit_skill`. A green unit test on `CHAT_CORE_TOOLS`
membership alone is NOT sufficient — the tool budget could still trim them.

## Completion marker

When both workstreams are committed, tested green, and pushed, append the
literal line below as the **last line of this file** and include it in the
final commit:

SKILL AUTHORSHIP AND REVIEW QUEUE PHASE COMPLETE

SKILL AUTHORSHIP AND REVIEW QUEUE PHASE COMPLETE

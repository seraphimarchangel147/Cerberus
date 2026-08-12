# Phase: Memory-Write Suppression for System Sources + Durable Harness Counters

**Spec author:** Seraphim
**For:** Codex (Zed)
**Repo:** `openagi` (Node, **zero runtime dependencies**)
**Basis:** Wave 1.2 + 1.3 of `docs/research/HARNESS-IMPROVEMENT-PLAN.md`
**Predecessor:** `3a61554` (Wave 1.1, merged and live — same review bar applies here)

READ THIS FILE IN FULL BEFORE EDITING ANYTHING. Two independent tasks; do them in order and commit
them **separately** (two commits on one branch).

---

# TASK 1 — Suppress memory writes for system-originated turns

## 1.1 The defect

Every completed turn writes the raw user prompt + reply into memory at
**`src/agent-host.js:1665`**:

```js
if (!ephemeral) {
  this.runtime.memory.remember(
    {
      source: "agent-host",
      scope: memoryScope,
      content: `Session ${sessionId} user asked: ${text}\nAgent replied: ${modelResult.text}`,
      tags: ["agent-turn", channel, agentId],
```

There is **no filter on the originating channel**. Cron jobs, scheduled goal-loop runs and internal
job turns all fire this path, so the identical machine-generated prompt is written to memory on
every run. Azazel's medium tier saturated with five near-identical copies of the same cron prompt,
crowding out real recall.

Confirmed absent: `grep -rn 'source.*cron|isSystemSource|skipMemory' src/memory-intake-policy.js`
returns nothing. No suppression exists anywhere.

## 1.2 The signal to filter on (already in scope — do not invent a new one)

`channel` is declared at **`src/agent-host.js:515`**:

```js
const channel = input.channel ?? "local";
```

and is already passed into the `tags` array at the `remember()` call. Verified system channel values
in this codebase:

| value | set at |
|---|---|
| `"job"` | `src/job-manager.js:739` |
| `"cron"` | `src/abi-runtime.js:1712` (`input.channel ?? "cron"`) |
| `"autopilot"` | `src/abi-runtime.js:1645` |

Human channels seen live: `discord`, `local`.

## 1.3 What to build

Add an exported predicate — put it in **`src/memory-intake-policy.js`** (that is the memory *policy*
module; this is a policy decision, not host logic):

```js
export const SYSTEM_MEMORY_CHANNELS = new Set(["cron", "job", "autopilot", "heartbeat", "system"]);
export function isSystemOriginatedTurn(channel) { ... }
export function shouldWriteTurnMemory({ channel, explicit = false }) { ... }
```

At `agent-host.js:1665`, skip the `remember()` call when `shouldWriteTurnMemory` returns false.

**Escape hatch (required):** an explicit opt-in still writes. If the caller passes
`input.memory === true` (or an equivalent explicit flag you define and document), the write proceeds
even on a system channel. A cron job that genuinely needs to record something must be able to.

**Kill switch (required):** `OPENAGI_SYSTEM_MEMORY_SUPPRESSION=0` restores today's
write-everything behaviour exactly. Follow the convention already used by
`ERROR_CLASSIFIER_KILL_SWITCH` in `src/error-classifier.js` and register the new variable in
`src/setup-wizard.js` the same way `OPENAGI_TOOL_ERROR_CLASSIFIER` was.

**Do not silently drop the data.** A suppressed turn must still be observable — emit it to the
counters journal from Task 2 (`kind: "memory-write-suppressed"`). Silent suppression is how you get
a second week-long mystery.

## 1.4 Tests — `test/system-memory-suppression.test.js`

1. A `cron` channel turn writes **no** memory item.
2. A `job` channel turn writes none.
3. An `autopilot` channel turn writes none.
4. A `discord` channel turn **still writes** (the human path must be untouched).
5. A `local` channel turn still writes.
6. Explicit opt-in on a `cron` turn **does** write.
7. Kill switch `=0` restores writing on `cron`.
8. A suppressed turn emits exactly one `memory-write-suppressed` counter event.
9. Unknown/undefined channel defaults to **writing** (never silently lose a human turn).

---

# TASK 2 — Durable harness counters journal

## 2.1 The defect

`TurnSteering.stats()` (`src/turn-steering.js`, `stats()` near the end of the class) returns
`{ pending, inFlight, stranded, carried, awaitingCarry }` from **in-process** state only. It resets
to zero on every restart, and this daemon restarts often. Nobody can answer "how many steers were
stranded this week" — which is exactly the question that justifies the feature.

Confirmed absent: there is no `~/.openagi/metrics/` directory.

## 2.2 What to build

An append-only JSONL journal, module **`src/harness-counters.js`**:

- Path: `~/.openagi/metrics/harness-counters.jsonl` (derive the base from the same env/dir helper
  the rest of the runtime uses — do **not** hardcode `$HOME`).
- One JSON object per line: `{ ts, kind, ...meta }`.
- Append-only. **Never** rewrite or truncate the file.
- Writes must be **fire-and-forget and never throw into the caller** — wrap in
  `try { ... } catch {}`, same discipline as `classifyProviderOutcome`.
- Export a read-side aggregator, e.g. `aggregateCounters({ since })`, returning per-`kind` totals.
- Kill switch `OPENAGI_HARNESS_COUNTERS=0` disables writing.

**Wire these existing events** (do not invent new semantics, just record what already happens):
- `steer-carried` and `steer-undelivered` — both already logged via `this.log?.()` in
  `src/agent-host.js`; that logger is wired to the RunInspector by `src/host-logger.js`. Record to
  the journal **in addition**, do not remove the existing call.
- `memory-write-suppressed` from Task 1.

**Rotation:** if the file exceeds ~5 MB, roll to `harness-counters.1.jsonl` and start fresh. An
unbounded journal on a long-lived daemon is a disk leak.

## 2.3 Tests — `test/harness-counters.test.js`

1. Append writes one parseable JSON line per event.
2. Appends survive a fresh module instance (durability — that's the whole point).
3. `aggregateCounters` totals correctly per kind.
4. `since` filtering works.
5. A malformed/corrupt line is skipped by the aggregator, not fatal.
6. Kill switch `=0` writes nothing.
7. A write failure (e.g. unwritable dir) does **not** throw into the caller.
8. Rotation triggers past the size threshold.

---

# Hard constraints (both tasks)

- **ZERO RUNTIME DEPENDENCIES.** `package.json` `dependencies` must stay `{}`. Node stdlib only.
- **Do not touch** `src/model-provider.js` or `lib/memtree.js`.
- You **may** edit `src/agent-host.js` and `src/turn-steering.js` for the wiring described above —
  but keep those edits minimal and additive. Do not refactor them.
- `CHANGES.md` is an auto-appended live journal. **Never** `git checkout --` it.
- Baseline `node --test`: **2324 pass / 3 fail / 1 cancelled**. Those 4 are pre-existing
  (`model-provider-iterations` ×2, `watchdog-progress-fix` ×1, load-flaky `cron-job-timeout`).
  Do not fix them; do not let the pass count drop. Paste before/after `ℹ pass` / `ℹ fail` lines in
  each commit message.
- Branch `codex/memory-suppress-counters`. **Two commits** (Task 1, then Task 2). Never merge to
  `main`.

# Definition of done

- Both new test files green; full suite pass count ≥ 2324, fail ≤ 3 (+1 flaky cancelled).
- Both kill switches verified to restore prior behaviour.
- Pushed to `codex/memory-suppress-counters`.
- Finish by appending this literal line as the last line of THIS file, in the final commit:

MEMORY SUPPRESS AND COUNTERS PHASE COMPLETE

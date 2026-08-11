# Harness Improvement Plan — Scaffold

**Date:** 2026-08-11
**Author:** Azazel
**Basis:** `docs/research/EXTERNAL-HARNESS-INTEL-2026-08.md` (Metatron intel × current-state audit)
**Ordering principle:** ratchet engineering — known defects become permanent rules before any new capability. Each wave lists files, tests, and the rollback path. No wave starts without the previous wave's receipts.

---

## Wave 1 — Ratchet the known defects (small, high-certainty)

Theme: every item below is a *confirmed live defect* with an external consensus fix. No invention.

### 1.1 Retry-guard: reset on intervening success + error classification
- **Defect:** identical-args dedupe has no reset; a blocked call stays blocked for the session even after state changes (burned 18 min during watcher ops).
- **External anchor:** Nexu error-handling — classify Transient/Permanent/Model/Resource; reset dedupe on any non-identical successful call.
- **Files:** `src/tool-registry.js` (dedupe table), new classifier helper.
- **Tests:** `test/` — retry-guard suite: blocked→intervening-success→same-args-succeeds; identical-args-still-blocked-without-intervening-success; classification unit tests for the four classes.
- **Rollback:** single-commit revert; checkpoint before edit.

### 1.2 Memory write suppression for system sources
- **Defect:** cron/watcher prompts echo into medium tier (100% saturated; recall surface is five identical prompt echoes).
- **External anchor:** Utah — agent ephemeral, skills durable; suppress memory write when `source ∈ {cron, system, heartbeat}` unless explicit `memory:true`; optionally journal to `events.jsonl`.
- **Files:** memory write path (entry-point filter), `events.jsonl` sink.
- **Tests:** system-source prompt produces no memory record; explicit opt-in still writes; events journal receives the suppressed entry.
- **Note:** the nightly consolidation cron stays paused until memtree revives (see 1.4); this fix stops the bleeding at the source.

### 1.3 Append-only stats journal
- **Defect:** `stats()` for carried/stranded/retry classes is volatile.
- **External anchor:** Hankweave event journal.
- **Files:** stats emitter → `~/.openagi/events.jsonl` append-only; readers aggregate.
- **Tests:** journal append on each class event; aggregate read matches fixture.

### 1.4 Memtree store repair + revive
- **Defect:** `OPENAGI_MEMTREE` dropped from env ~2 weeks ago; tools unregistered; fixed-width record partial at offset 144 blocks merges even when tools were live.
- **External anchor:** treat partial record as RESOURCE-class → repair or **degrade loud**, never silent-fail.
- **Steps:** (a) add `OPENAGI_MEMTREE=1` to the **systemd unit** (not just `.env` — unit wins at boot); (b) restart; (c) verify tools register; (d) repair/repair-path for record 144; (e) re-enable `memory-consolidation` cron; (f) manual catch-up sweep (~27 ranges).
- **Tests:** memtree suite with flag on (was 72/72 when healthy); merge on repaired range succeeds.

### 1.5 Boot SHA line + post-restart eval gate
- **Defect:** staged env flags regress silently (Claude Code postmortem lesson; our own staged-but-inert flags prove it).
- **Build:** daemon logs `boot: sha=<short> flags=<resolved key set>` at startup; a post-restart smoke cron asserts the expected flag set and alerts on mismatch.
- **Files:** daemon boot path, new smoke cron prompt.
- **Tests:** flag flip → mismatch alert fires; matching set → silent.

**Wave 1 gate:** full suite green + each fix's regression test green + changelog entries. Then restart once to activate everything at once.

---

## Wave 2 — Structural contracts (medium)

### 2.1 Resource-scoped mutation lease
- **Anchor:** Utah singleton-per-chat; lease scope = resource key (file/workspace), not process-global.
- **Files:** lease manager; keep fail-closed semantics and the Wave 4 re-entrancy handles.
- **Tests:** two sessions editing different files proceed in parallel; same file still serializes; stuck lease still reapable; the 18-minute-freeze repro from the QA battery becomes a passing test.

### 2.2 Disk-state handoff contract (initializer pattern)
- **Anchor:** Anthropic two-role — `feature_list.json` with `passes: true` only after e2e.
- **Build:** wave/goal completion writes a machine-readable status file (feature, state, evidence refs); session-start reads it before trusting memory narrative. Memory becomes annotation, not contract.
- **Files:** goal-store completion path, session-start loader.
- **Tests:** handoff round-trip; a "premature victory" fixture (prose says done, JSON says partial) resolves to partial.

### 2.3 Worktree-per-run primitive
- **Anchor:** Archon. We proved the pattern manually; make it a tool-level primitive (`run_in_worktree` wrapper for coder/QA lanes) so parallel fix waves stop contending on the main checkout.
- **Tests:** two concurrent governed runs, zero lease conflicts, both merge.

### 2.4 Legion mailbox roster + push-based completion
- **Anchor:** Metatron's coordination pass — roster knows 4/13 agents; lease-poll thrash.
- **Files:** roster loader (`~/.legion/roster.json` full 13), completion push on delegate/coder finish.
- **Tests:** all 13 resolve; push delivered without polling.

**Wave 2 gate:** battery-style QA per item (one variable at a time), receipts filed in `docs/qa/`.

---

## Wave 3 — New capability, cherry-picked (only after Waves 1–2)

1. **Sentinels as mid-run eval** (Hankweave) — hook lane gains a verifier that fires mid-turn on high-risk sequences, not just pre/post.
2. **Generalized clean-stop lifecycle** — steer-carry's consumer pattern extended to any "turn died cleanly" subscriber (jobs, goals, QA runs).
3. **Archon/Hankweave adversarial QA** — clone read-only, one-page checklist each, extract any missed primitives.
4. **X-native virality refresh** — blocked on `xurl` + tokens on the Metatron path; re-run `agent harness` / `durable agents` / `langgraph temporal` queries when available.
5. **Entropy-management cron** (Fowler) — cheap aux-model pass auditing `CHANGES.md` against git reality; reports drift, never edits silently.

---

## Explicitly rejected

- **More bespoke tools** (Azure SRE: 100+ tools underperformed readable state — Intent Met 45%→75% when simplified). Hot path stays small.
- **Swarm/meta-harness adoption** (ruflo/deer-flow) — star noise, wrong problem.
- **Temporal-class durable execution** — steer-carry covers our actual failure modes; full run-survival is cost without payoff at our scale.
- **Any feature work before Wave 1 lands.** Ratchet first.

---

## Standing activation checklist (one restart carries Wave 1)

- [ ] `OPENAGI_MEMTREE=1` in systemd unit (not only `.env`)
- [ ] `OPENAGI_WALL_CLOCK_IDLE_STRIKES=150`, `OPENAGI_MAX_TURN_SECONDS=2500` in unit (Creator directive)
- [ ] `OPENAGI_MAX_ITERATIONS=153→333` unit line (already hot-applied; unit still stale)
- [ ] Gateway restart → post-restart smoke (1.5) verifies the full flag set
- [ ] Re-enable `memory-consolidation` cron after memtree tools register

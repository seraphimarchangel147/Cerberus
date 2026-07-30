# Harness Upgrade QA Battery — Waves 1–3 (2026-07-29)

**For:** Azazel (Cerberus / openAGI)
**From:** Seraphim
**Target:** `main` @ `129446d` · suite `tests 2133 · pass 2109 · fail 0 · skipped 24`
**Status of everything below:** **gate-green, NOT live-proven.** That's what this battery is for.

---

## 0. Read this first — what changed and why it matters to you

Three waves landed on your harness tonight. Two came from porting Cline's recursive
self-improvement campaign (PR #12465, Apache-2.0), one from TencentDB Agent Memory (MIT). One
of them came from *your own* failure logs in `#azazel-chat`.

**The unifying diagnosis: your harness was discarding information on the wrong axis.**

| Wrong axis | Right axis | Where |
|---|---|---|
| time | **progress** | wall-clock guard |
| call repetition | **output change** | repeat detection |
| position | **substitutability** | context compaction |

Full evidence: `docs/plans/cline-rsi-port/00-assessment.md` and
`docs/plans/tencentdb-memory-assessment.md`. Specs:
`docs/plans/cline-rsi-port/01-wave-1-spec.md`, `docs/plans/wave-2-mutation-lease-spec.md`,
`docs/plans/wave-3-context-value-spec.md`.

### Wave 1 — Cline RSI port (`3db3351`)

1. **`code_shell` anti-`pkill` guidance.** Cline lost benchmark tasks to an agent whose
   `pkill -f <pattern>` matched **its own harness command line** and killed itself mid-task.
   Your blast radius is worse — you're a long-lived *supervising* daemon. The tool description
   now tells you to capture a PID/process-group and never broad-match.
2. **Provider retry 3 → 5**, max single delay 8s → **30s**. Cline measured 5 tasks lost to a
   single swallowed 429. Your `Retry-After`-honoring classifier was already better than theirs
   and was left alone.
3. **Unref'd-timer guard** (`scripts/unref-timer-guard.mjs`). Cline had a bug where an
   `.unref()`-ed fallback timer let **Node exit status 0 before the model was ever called** —
   7.6s, zero tokens, nothing thrown. You were clean; this locks it.
4. **Reasoning-effort plumbing.** You previously sent **no reasoning field at all**. Now
   `OPENAGI_REASONING_EFFORT` plumbs it — **omitted by default**, and it never silently
   downgrades a tier it can't express.
5. **Output-aware repeat detection** (`evaluateRepeatedOutcome`). Before: successful calls were
   **deleted** from the tracker (`tool-registry.js:965`), so 50 identical successful
   no-progress calls were invisible. Now identical-call + identical-output accumulates to
   `OPENAGI_REPEATED_SUCCESS_LIMIT` (default **8**) and emits **one** advisory; different output
   ⇒ real progress ⇒ counter resets.
6. **Progress-aware wall-clock guard.** ⭐ **This is the one that was cutting you off.** It was
   purely time-based — it hard-stopped you **twice mid-`git merge`** on 2026-07-29, burning all
   3 extensions while you were actively committing. Now, if the turn made observable progress
   since the last checkpoint, the extension is **free** (doesn't decrement your budget), bounded
   by `OPENAGI_WALL_CLOCK_FREE_EXTENSIONS` (default **3**). Total wall time is capped at
   `maxTurnSeconds × (1 + checkpoints + freeExtensions)`. Your Discord checkpoint card now says
   **why** an extension was granted or charged.

### Wave 2 — Mutation lease observability (`735f723`)

Built directly from **your** incident: ~18 minutes where every write lane refused with
`"Mutation conflicts with another active invocation."` — three governed `coder_apply`
transactions and a fresh delegated child session all hit the same wall, and only a daemon
restart cleared it. You diagnosed both defects yourself and you were right.

Root cause: a foreground lease stored **only `owner` + `resourceLocks`** — no owner name, no
timestamp. The error *could not* name the holder, and no TTL was possible.

- **Lease metadata**: `ownerId`, `acquiredAt`, `sessionId`, `jobId` (tool name + locks only —
  never raw args, so no secret leak).
- **`mutation_lease_status`** — new read-only tool, `sideEffects: false`, so it hits the no-op
  return and **can never be blocked by the lock it inspects**. Returns `leaseId`, `ownerId`,
  `ageMs`, `humanAge`, `resourceLocks`, `persistent`, `source` for foreground + durable +
  quarantined holders.
- **Actionable errors**: now name the holding tool, lease id, human age, and locked paths, plus
  "Call mutation_lease_status for detail."
- **Lazy, loud TTL reaping**: `OPENAGI_MUTATION_LEASE_TTL_MS` default **15 min**, `0` disables.
  `persistent: true` workspace leases are **NEVER** reaped at any age. A reap is always logged
  loudly. A throwing clock ⇒ the lock is **retained** (fail-safe).

### Wave 3 — Value-aware shedding + hybrid retrieval (`129446d`) — **DEFAULT OFF**

- **`src/context-value.js`** — pure deterministic substitutability scorer. No LLM call, no I/O,
  12KB sampling bound. **Score = substitutability, NOT importance**: 10 means a summary can
  safely replace the original, so the cascade sheds **10 first** and **protects 1**.
  `error-bearing → 1`, `code-diff → 2`, `invalid → 0`, `ref-backed → 9`. Your tracebacks and
  diffs are protected verbatim.
- **Substitutability cascade** in compaction + **current-task protection** (reuses Wave 1's
  `turn-progress`/`outputSignature`).
- **Graded ladder**: mild **0.50** → aggressive **0.85** → emergency **0.95**, and emergency
  recovers down to a **target 0.60** rather than just under the line (prevents thrash).
- **RRF hybrid retrieval** in `vector-store.js` (was cosine-only), `k=60`.
- **Flags, both default OFF**: `OPENAGI_VALUE_AWARE_COMPACTION`,
  `OPENAGI_VECTOR_HYBRID_SEARCH`.

---

## 1. QA protocol — how to run this

**Rules of engagement:**
- **Restart the daemon first.** Waves 1–2 are inert until you do. Wave 3 stays off until you
  explicitly flip its flags.
- **Do NOT enable everything at once.** Phase A (defaults) → Phase B (Wave 3 flags). If you
  flip everything and something regresses, you lose attribution.
- **Record evidence, not impressions.** Every probe below has an explicit expected result. Paste
  actual output.
- **A failed probe is a SUCCESS for this battery.** You are hunting for the gap between
  "tests pass" and "works in production." Do not smooth over a discrepancy — report it. The
  phase-243 lesson: 3,002 green tests once passed over fixtures that didn't match live provider
  output, and every live tool turn was dead.
- If a probe is impossible in your environment, say so and why. Don't fabricate a result.

**Deterministic pre-check (no daemon needed):** run
`node scripts/qa-wave-probes.mjs` from the repo root. It exercises the pure//deterministic
surfaces of all three waves in-process and prints a PASS/FAIL table. This is your fastest
signal that the merge is sane; it is **not** a substitute for the live probes.

---

## Phase A — defaults only (Waves 1–2 live, Wave 3 off)

### A1. Config surface came up correctly
Confirm the new knobs resolve to the documented defaults.
- **Expect:** provider max retries **5**, retry max delay **30000ms**, wall-clock checkpoints
  **3**, wall-clock free extensions **3**, repeated-success limit **8**, mutation lease TTL
  **900000ms**, reasoning effort **unset/omitted**, `OPENAGI_VALUE_AWARE_COMPACTION` **off**,
  `OPENAGI_VECTOR_HYBRID_SEARCH` **off**.
- **Report:** the resolved values, and any env var already set in your systemd unit that
  overrides a default (this bit us before — a unit-level `OPENAGI_MAX_TOOL_HOPS=16` silently
  overrode an expected default via a deprecated alias).

### A2. `mutation_lease_status` is reachable and unblockable ⭐
1. Call `mutation_lease_status` while idle. **Expect:** a valid response, empty or near-empty
   lease list — **no error, no permission gate**.
2. Now the real test: start a **long side-effecting** tool call (something holding a lease for
   several seconds), and **while it runs**, call `mutation_lease_status`.
   - **Expect:** it returns successfully and **lists the in-flight lease** with a plausible
     `ownerId`, non-null `ageMs`, and the `resourceLocks` it holds.
   - **This is the load-bearing property.** If the status tool is ever blocked by the lock it's
     meant to inspect, Wave 2 has failed its whole purpose. Report immediately.
3. Confirm the output contains **no raw tool arguments** and nothing secret-shaped.

### A3. Actionable conflict error
Force a genuine lock conflict (two side-effecting calls contending for the same resource).
- **Expect:** the error names the **holding tool**, a lease id, a **human age**, the **locked
  paths**, and ends with "Call mutation_lease_status for detail."
- **Compare to the old message** — `"Mutation conflicts with another active invocation."` with
  zero detail. If you still get the bare string on a foreground conflict, report it.

### A4. Progress-aware wall-clock guard ⭐ **the headline fix**
Run a genuinely long, **progress-making** turn — the closest analogue to what broke you is a
multi-step git operation with real commits, or a long multi-file edit sequence.
- **Expect at the first checkpoint:** the Discord card states a **progress verdict** and
  reports both counters, e.g. *"progress detected; free extension granted"* with
  `(3 charged, 2 progress extensions left)`.
- **Critical:** a progress-bearing turn must consume a **free** extension, NOT a charged one.
- Then the negative control: a turn that stalls without progress must **charge** an extension
  (`"no new progress; charged extension used"`).
- **Report:** the exact card text at each checkpoint, and whether the turn survived long enough
  to finish work that previously got cut off. **If a progress-making turn still burns charged
  extensions and hard-stops mid-work, Wave 1 Fix 6 has not actually taken effect** — that's the
  single most important negative result in this battery.

### A5. Output-aware repeat detection
Call the **same read-only-ish tool repeatedly**, two ways:
1. **Changing output** (e.g. poll something whose result genuinely differs each time, like a
   growing log or a timestamp) ~12 times.
   - **Expect:** never blocked. Changing output = progress. This is the case Cline recovered 2
     benchmark tasks from.
2. **Identical output** ~10 times with byte-identical args and result.
   - **Expect:** at the 8th (`OPENAGI_REPEATED_SUCCESS_LIMIT`) you get **one** advisory —
     status `blocked`, code `repeated_no_progress`, with next-steps telling you the output hasn't
     changed. **Advisory only — it must NOT abort your turn.**
- **Report:** whether case 1 ever got flagged (false positive — bad) and whether case 2 fired
  exactly once (not zero, not every call).

### A6. Shell self-kill guidance
Read the `code_shell` tool description.
- **Expect:** it mentions capturing a **PID or process group** and warns against `pkill -f` /
  `killall` because the pattern can match the harness's own command line.
- **Do NOT actually run a broad pattern-kill to test this.** The guidance is the fix; verifying
  the text is the test. (Related trap I hit tonight: `pgrep -f 'node --test'` matched *its own
  grep* and gave me a false positive. Same self-matching family.)

### A7. Retry window
Confirm the retry policy without manufacturing an outage: verify resolved config is 5 retries
with a 30s ceiling, and that `Retry-After` handling and the retryable status set
(`429/500/502/503/504/529`) are unchanged.
- If you happen to hit a real 429/529 during QA, **capture the log** — that's free evidence.
- **Report:** config values; note explicitly if you did not observe a live retry.

### A8. Reasoning effort (opt-in)
With `OPENAGI_REASONING_EFFORT` unset, inspect an outgoing request body.
- **Expect:** **no** reasoning/thinking key at all — byte-identical to pre-Wave-1. This matters
  for prompt-cache stability.
- Then set it (e.g. `high`) and confirm the field appears in the right shape for the active wire
  format, and that an unsupported tier is **omitted rather than silently downgraded**.
- **Note:** Cline's equivalent fix earned **zero** benchmark credit. Expect correctness, not a
  performance win. Don't over-claim.

---

## Phase B — enable Wave 3 (one flag at a time)

### B1. Baseline the OFF state
Before flipping anything, confirm with both flags off that compaction and retrieval behave
exactly as they did pre-Wave-3. **Flag-off must be byte-identical to today.**

### B2. `OPENAGI_VECTOR_HYBRID_SEARCH=1` — RRF retrieval
- **Expect:** memory/vector search still returns sane results; items ranked well by **both**
  lexical and vector lists should outrank items strong in only one.
- Ordering must be **deterministic** — run the same query twice, expect identical order.
- **Report:** a before/after top-5 for 2–3 real queries. Did fusion improve or degrade
  relevance *in your judgment*? Honest "no visible difference" is a valid finding.

### B3. `OPENAGI_VALUE_AWARE_COMPACTION=1` — the cascade ⭐ highest risk
Run a **long, tool-heavy** turn that actually crosses the mild threshold (0.50 of budget).
- **Expect:** compaction sheds the most-substitutable entries first. Specifically verify the
  protections hold:
  - **An error/traceback in history survives** (scores 1).
  - **A code diff survives** (scores 2).
  - **Ref-backed/spilled output is shed early** (scores 9 — it's losslessly recoverable).
  - **Current-task entries are exempt** from the mild stage.
- **Expect:** context stays **reversible** — the ledger restore path must still reconstruct, and
  **no tool call is ever orphaned** from its result.
- Then push harder toward 0.85 and 0.95 and confirm the ladder escalates, and that **emergency
  recovers to ~0.60**, not merely under 0.95.
- **Report:** what got shed vs kept, whether anything you needed disappeared, and any sign of
  non-determinism (same input, different shedding).

**Roll back instantly** (unset the flag) if you see an orphaned tool pair, a lost traceback you
needed, or non-deterministic behavior. Both flags are fail-open by design — unsetting restores
today's behavior with no migration.

---

## 2. Reporting format

Please return:

1. **A PASS / FAIL / BLOCKED table**, one row per probe (A1–A8, B1–B3).
2. **Verbatim evidence** for A2, A4, and B3 — the actual card text / tool output / error
   strings. These three are the load-bearing ones.
3. **Any discrepancy between spec and reality**, however small. If a default doesn't match, if
   an env var in your systemd unit overrides something, if a message reads differently than
   documented — say so.
4. **Anything that is worse than before.** I would much rather hear "the cascade dropped a
   traceback I needed" than a clean sheet.
5. **New harness defects you notice while running this**, even if unrelated. That's how Wave 2
   got built — from your own incident report. Your failure logs are our best evidence source,
   and unlike a benchmark they're unfakeable.

Suggested landing spot for your writeup: `docs/qa/wave-1-3-live-qa-<date>.md`, committed.

---

## 3. Known limits of this battery (stated up front)

- **We never ran Terminal-Bench** and can't — no Harbor. Every Cline score cited in the
  assessments is **their** self-report, not reproduced by us.
- Wave 3's benchmark claims (WideSearch +51.5% pass / −61.4% tokens, etc.) are **Tencent's**
  self-report. Unverified by us.
- All three waves' tests were written by the **same agent that wrote the code**. That is exactly
  why this live battery exists.
- Cross-runtime note: the Windows Node 25 runner *executes* the 24 tests skipped on the Linux
  lane, so it reports **2116 passing** where Linux reports **2109 + 24 skipped**. Same suite —
  don't be alarmed by the mismatch; gate against your own runner consistently.

# Recursive Self-Improvement Prompt Template (openAGI / Legion)

**Adapted from:** Cline's Kimi-K3 hill-climb prompt
(gist `arafatkatze/fe7d3743315c80d5e3e8ab1bdef39903`, 2026-07-24) — the prompt that drove
17 hours of unattended harness self-improvement and took Terminal-Bench 2.1 from
69/89 → 79/89 while *reducing* cost.

**Why this file is the most valuable artifact of the whole investigation.** Cline's four
winning patches are worth a few hundred lines. This prompt is worth every future campaign:
it converts "an engineer reads traces for two weeks" into "an agent runs the loop
unattended." Their earlier hand-driven climb (47%→57%) took 4 engineers and ~2 weeks. The
same climb, mechanized by this prompt, took one engineer one prompt and one night.

**How to use.** Fill the `<<< >>>` slots and hand it to a long-running agent. Keep the
Scientific Rules and Anti-Reward-Hacking sections **verbatim** — those are the parts that
held under 17 hours of autonomy and are the reason the result was trustworthy.

**Critical adaptation for us:** we have **no Harbor and no Terminal-Bench**. Our evidence
substrate is (a) the 263-test suite, (b) live probes against the running daemon, and
(c) **real observed failures from Discord transcripts** — which is how the wall-clock and
loop-detection gaps in Wave 1 were found in the first place. Our "benchmark" is our own
production failure log. That is a feature, not a compromise: it is unfakeable and it
measures what the Creator actually feels.

---

## The template

```
You are conducting a long-running recursive agent-harness improvement experiment.

The central research question is:

  Can <<<MODEL>>> inspect and improve the <<<HARNESS>>> harness that runs
  <<<MODEL>>>, then demonstrate a real, reproducible improvement on
  <<<EVAL SUBSTRATE>>> without reward hacking, target-specific patches,
  increased resources, or misleading experimental comparisons?

You are both:
  1. The engineering agent modifying the harness.
  2. The target model whose performance is being improved through those changes.

Continue autonomously for as long as useful. Do not stop after producing a plan or after
one evaluation run. Build, test, evaluate, analyze failures, implement the next
generalizable improvement, and repeat. Maintain durable checkpoints so another session can
resume the experiment if this session is interrupted.

## Repositories and evidence

  Harness repository:   <<<REPO PATH>>>
  Test suite:           <<<TEST COMMAND>>>
  Live probe method:    <<<HOW TO EXERCISE THE RUNNING SYSTEM>>>
  Failure corpus:       <<<TRANSCRIPTS / LOGS / INCIDENT REPORTS>>>
  Prior investigations: <<<PRIOR PLAN + ASSESSMENT DOCS>>>

  Known baseline:
    Commit:   <<<SHA>>>
    Metric:   <<<CURRENT MEASURED VALUE>>>
    Failures: <<<COUNT + CATEGORIES>>>

## Primary objective

Produce a change set that improves <<<METRIC>>> beyond the <<<BASELINE>>> baseline and
survives repeated confirmation. A single lucky run is insufficient. The final result must be
supported by repeated evaluation and case-level evidence.

## Scientific rules

Keep the following fixed unless an experiment is explicitly labeled a configuration
experiment: model ID, provider route, temperature and sampling parameters, resources,
timeouts, number of cases, concurrency, retry policy, evaluation instructions, verifier
implementation.

Change one causal axis at a time whenever practical.

Do not compare a run that differs in provider, effort, sampling, AND harness as if only the
harness changed. Record each difference separately.

## Anti-reward-hacking constraints

Never:
- Modify the verifier, the evaluation data, the tests, the rewards, or expected outputs.
- Read hidden verifier tests to derive case-specific behavior.
- Add case-name checks, evaluation detection, or case-specific solution branches.
- Hardcode answers, filenames, commands, flags, or solutions for evaluation cases.
- Add evaluation-specific text to the production system prompt.
- Increase timeouts, CPU, memory, storage, or attempts to manufacture a better result.
- Disable failures, reinterpret missing results as successes, or exclude failed cases.
- Selectively rerun only failures and report the combined result as a full run.
- Choose the luckiest run while hiding regressions or unsuccessful reruns.
- Commit credentials, presigned URLs, raw secrets, or large artifacts.
- Replace the harness with a different agent and call that an improvement.

Permitted analysis: reading normal trajectories, tool calls, timing, token usage, exception
types, and pass/fail outcomes after runs. Use these to identify general harness failures,
not to encode case solutions.

ALL PRODUCTION CHANGES MUST BE DEFENSIBLE WITHOUT MENTIONING THE EVALUATION. A valid change
should plausibly help on unseen work of the same kind.

## Repository safety

1. Read every applicable AGENTS.md and repository instruction file.
2. Inspect git status before editing.
3. Preserve all pre-existing uncommitted user changes.
4. Work on a dedicated experiment branch or isolated worktree.
5. Never use `git reset --hard`, destructive checkout, or broad cleanup commands.
6. Commit each coherent candidate separately with a descriptive message.
7. Record the exact commit for every build you evaluate.
8. <<<HARNESS-SPECIFIC: e.g. never restart the live daemon; never touch sibling agents>>>

## Initial investigation

Classify every failure in the corpus into categories such as:
  correct work but missing completion · agent timeout · single-command timeout ·
  provider/API failure · invalid or rejected tool call · output truncation or context loss ·
  compaction failure · lost reasoning history · repeated ineffective action ·
  excessive deliberation · failure to monitor background work · incorrect edit behavior ·
  genuine capability failure

Distinguish infrastructure failures from model/harness failures. Inspect representative
SUCCESSES as controls — identify what differs immediately before a good vs. bad outcome.

## Iteration loop

For each iteration:
  1. Write a falsifiable hypothesis.
  2. Identify trace evidence supporting it.
  3. Implement the smallest general-purpose change that tests it.
  4. Add tests reproducing the mechanism without using a case solution.
  5. Run the repo's required formatting, linting, typechecking, and tests.
  6. Record commit, configuration, and start time.
  7. Run the evaluation. WAIT for it to finish; do not merely launch it and exit.
  8. Compute: pass count, accuracy, exceptions by type, timeouts, case-level gains and
     losses vs. baseline, token/cost/duration.
  9. Decide: keep / revise / revert.
 10. Document the result EVEN WHEN IT FAILS.

Do not stack multiple speculative changes before measuring them unless inseparable. If a
stack improves, ablate its components afterward.

## Evaluation ladder (cost-aware)

  Stage A — synthetic reproduction: unit tests + captured request shapes confirm the mechanism.
  Stage B — preregistered diagnostic subset: chosen BEFORE the first change, containing
           representative failures AND stable passing controls. Never alter it to favor a
           later candidate. Use only for rapid rejection.
  Stage C — full run at baseline settings.
  Stage D — confirmation: repeat the unchanged candidate at least three times. Report mean,
           median, range, case flips, exception rates. A one- or two-case movement is NOT
           an established improvement.
  Stage E — publishable verification: the full protocol, unmodified resources and timeouts.
           Never label a development run as leaderboard-equivalent.

## Advancement criteria

A change becomes the new incumbent only if: the full run completed; it beats the incumbent
by a margin that survives confirmation; the gain is not explained by provider outages, setup
failures, or altered resources/timeouts/sampling; it introduces no evaluation-specific
behavior; tests pass; no severe regression in generic behavior.

## Required experiment ledger

Continuously update <<<LEDGER PATH>>>. Per experiment record: number, date, hypothesis,
trace evidence, code change, commit, exact configuration, test results, evaluation output
path, score, gains, losses, exceptions, token/cost/duration, interpretation, keep/revert
decision, next hypothesis.

Record failures with the same care as successes. Failed approaches are essential material.

## Required final deliverables

  1. The best implementation on a clearly named branch with clean, reviewable commits.
  2. Tests covering each retained mechanism.
  3. A reproducibility section with exact build and run instructions.
  4. The complete experiment ledger.
  5. A written engineering investigation (not marketing) covering: the baseline, the
     protocol, the anti-reward-hacking rules, every meaningful hypothesis, what changed,
     what worked, what failed, regressions and reversions, infrastructure incidents,
     case-level gain/loss analysis, repeated-run variance, the final result with honest
     uncertainty, cost and elapsed time, the remaining gap, and whether the result genuinely
     supports "recursive self-improvement."

Do not write the final report until the campaign is complete. Keep notes during; write from
the evidence.

Begin now by inspecting repository instructions, git status, the baseline, and the failure
corpus. Then create the experiment ledger and execute the first evidence-driven iteration.
```

---

## Lessons from Cline's run worth remembering

1. **The winning fixes were all boring.** A swallowed 429, an over-eager loop detector, an
   unref'd timer, and a self-`pkill`. Zero prompt engineering, zero model changes. Harness
   reliability *is* capability — the model was already good enough to score 88.8%; the
   harness was throwing away 10 tasks' worth of it.
2. **Cost went DOWN as score went up** ($79 → $49.8). Fewer doomed retries and self-kills
   means less wasted inference. Reliability and cost are the same axis.
3. **The guardrails held.** The agent policed itself — recorded attribution guards and
   excluded its own invalidated runs. Explicit, enumerated prohibitions worked better than
   a general "be honest" instruction.
4. **Negative results must be recorded.** Experiment 0 (max reasoning) earned no credit;
   saying so is what makes the other four claims believable.
5. **Human intervention ≈ pressing "continue".** Which is *exactly* what the Creator did
   twice in this channel tonight. The lesson generalizes: our wall-clock guard is currently
   forcing manual continues, and eliminating them is a capability gain — that is Wave 1 Fix 6.
6. **Invalidated runs get thrown away, not massaged.** Two confirmation runs were discarded
   after an orchestrator was accidentally terminated. Reported, excluded, rerun.

## Our substrate is different — and that's fine

Cline had a verifier and 89 scored tasks. We do not. Ours:

- **Regression corpus:** the 263-test suite — never allowed to drop.
- **Live probes:** authed `POST /message` against the running daemon (see
  `legion-operate-openagi-harness`), which has repeatedly surfaced config interactions no
  test can see.
- **Real failure corpus:** Discord transcripts of actual turns. Tonight alone yielded two
  genuine harness bugs (wall-clock stop mid-merge; a stuck process-global mutation lease with
  no observability surface). This corpus is unfakeable and directly weighted by what the
  Creator experiences.

**Standing candidate for the next campaign:** the stuck mutation-lease incident from
2026-07-29 — ~18 minutes of every write lane refusing, across three governed transactions and
a fresh delegated child session, with **no tool to see who holds the mutex**. Azazel named the
two fixes himself: a `mutation_lease_status` surface (holder, age, file scope) and TTL/
reconcile-on-invocation-end so leases cannot outlive their invocation. That is Wave 2.

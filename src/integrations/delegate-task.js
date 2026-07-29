import { randomUUID } from "node:crypto";
import {
  DELEGATE_KINDS,
  DELEGATE_KIND_GUIDANCE,
  delegateTaskForKind
} from "../model-router.js";

const DEFAULT_MAX_CHILDREN = 3;
const DEFAULT_MAX_SPAWN_DEPTH = 1;
const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_MAX_TURN_SECONDS = 600;
const MAX_SUMMARY_CHARS = 16_000;
const MAX_ASYNC_DELEGATIONS = 32;
const MAX_STEERS_PER_TASK = 5;
const FINISHED_RETENTION_MS = 60 * 60 * 1000;

// Headless workers cannot ask the user or schedule a later conversation.
// Every nested spawn uses this module's audited depth and scrutiny ceilings.
export const SUBAGENT_INTERACTIVE_TOOLS = Object.freeze([
  "send_message",
  "schedule_message",
  "job_start",
  "job_status",
  "job_wait",
  "job_collect",
  "job_cancel"
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveSubagentConfig(env = process.env) {
  return {
    maxChildren: positiveInteger(env.OPENAGI_MAX_CHILDREN, DEFAULT_MAX_CHILDREN),
    maxSpawnDepth: nonNegativeInteger(env.OPENAGI_MAX_SPAWN_DEPTH, DEFAULT_MAX_SPAWN_DEPTH),
    maxIterations: positiveInteger(env.OPENAGI_SUBAGENT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS),
    maxTurnSeconds: positiveInteger(env.OPENAGI_SUBAGENT_MAX_TURN_SECONDS, DEFAULT_MAX_TURN_SECONDS)
  };
}

function normalizeTask(task, index) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { error: `tasks[${index}] must be an object` };
  }
  const goal = String(task.goal ?? "").trim();
  if (!goal) return { error: `tasks[${index}].goal is required` };
  const role = task.role ?? "leaf";
  if (role !== "leaf" && role !== "orchestrator") {
    return { error: `tasks[${index}].role must be leaf or orchestrator` };
  }
  // `kind` describes the WORK, which is what picks the child's model. An
  // unknown kind is rejected rather than silently coerced: a typo that quietly
  // downgraded a reasoning task to the cheapest model would be invisible in the
  // result and very expensive to debug.
  const rawKind = task.kind;
  const verify = String(task.verify ?? "").trim() || null;
  if (rawKind !== undefined && rawKind !== null && rawKind !== "") {
    const normalizedKind = String(rawKind).trim().toLowerCase();
    if (!Object.hasOwn(DELEGATE_KINDS, normalizedKind)) {
      return {
        error: `tasks[${index}].kind must be one of ${Object.keys(DELEGATE_KINDS).join(", ")}`
      };
    }
    return {
      task: { goal, context: String(task.context ?? "").trim(), role, kind: normalizedKind, verify }
    };
  }
  return { task: { goal, context: String(task.context ?? "").trim(), role, kind: null, verify } };
}

function normalizeRequest(args) {
  const hasGoal = args?.goal !== undefined;
  const hasTasks = args?.tasks !== undefined;
  if (hasGoal === hasTasks) return { error: "Provide exactly one of goal or tasks." };

  if (hasGoal) {
    const normalized = normalizeTask(
      { goal: args.goal, context: args.context, role: args.role, kind: args.kind, verify: args.verify },
      0
    );
    return normalized.task
      ? { tasks: [normalized.task] }
      : { error: normalized.error.replace("tasks[0].", "") };
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return { error: "tasks must be a non-empty array" };
  }
  // Batches larger than maxChildren are no longer rejected: the handler runs
  // them in sequential waves of maxChildren so the caller never has to chunk
  // by hand. The cap still bounds CONCURRENCY, which is what it exists for.
  const tasks = [];
  for (let index = 0; index < args.tasks.length; index += 1) {
    const normalized = normalizeTask(args.tasks[index], index);
    if (normalized.error) return normalized;
    tasks.push(normalized.task);
  }
  return { tasks };
}

function childPrompt(task, steeringNote = null) {
  const contextBlock = task.context || "(No background context was provided.)";
  const verifyBlock = task.verify
    ? `\n\n<verification>\nThe caller will check your work against this expectation: ${task.verify}\nMake sure your final summary satisfies it.\n</verification>`
    : "";
  const steerBlock = steeringNote
    ? `\n\n<steering>\nThe delegator interrupted an earlier attempt and redirected you:\n${steeringNote}\n</steering>`
    : "";
  return `[delegated_task]\nGoal:\n${task.goal}\n\n<background_context>\n${contextBlock}\n</background_context>${verifyBlock}${steerBlock}\n\nWork independently. You have no access to the parent conversation beyond the block above. Do not ask the user questions or send messages. Use tools as needed, then return only a concise final summary of findings, completed work, blockers, and any remaining action.\n[/delegated_task]`;
}

function childAllowedTools(runtime, parentContext, role, childDepth, maxSpawnDepth) {
  const interactive = new Set(SUBAGENT_INTERACTIVE_TOOLS);
  let names = runtime.tools.list().map((tool) => tool.name).filter((name) => !interactive.has(name));
  if (role !== "orchestrator" || childDepth >= maxSpawnDepth) {
    names = names.filter((name) => name !== "delegate_task");
  }
  if (Array.isArray(parentContext?.__allowedTools)) {
    const parentAllowed = new Set(parentContext.__allowedTools);
    names = names.filter((name) => parentAllowed.has(name));
  }
  return [...new Set(names)];
}

function notify(context, event) {
  try { context?.__onToolEvent?.(event); } catch { /* advisory */ }
}

function errorText(error) {
  return String(error?.message ?? error ?? "subagent failed").slice(0, 1_000);
}

function chunk(items, size) {
  const waves = [];
  for (let index = 0; index < items.length; index += size) {
    waves.push(items.slice(index, index + size));
  }
  return waves;
}

// ── Async delegation registry ────────────────────────────────────────────────
// Synchronous delegate_task awaits its children inside the same call, so there
// is no window to steer or stop them. Async mode (`async: true`) registers the
// batch here and returns a delegationId immediately; delegate_status,
// delegate_steer and delegate_cancel operate on the record while it runs.
// In-memory by design: a daemon restart kills the children too, so persisting
// handles would only mint zombie records. Fractal (plasma-ai) tracks the same
// lifecycle as "signals" in SQLite; the states here mirror that model.
const ASYNC_DELEGATIONS = new Map();

function pruneAsyncDelegations() {
  const now = Date.now();
  for (const [id, record] of ASYNC_DELEGATIONS) {
    if (record.status !== "running" && now - record.finishedAt > FINISHED_RETENTION_MS) {
      ASYNC_DELEGATIONS.delete(id);
    }
  }
  while (ASYNC_DELEGATIONS.size > MAX_ASYNC_DELEGATIONS) {
    const oldestFinished = [...ASYNC_DELEGATIONS.entries()]
      .filter(([, record]) => record.status !== "running")
      .sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
    if (!oldestFinished) break; // everything is running; never evict live work
    ASYNC_DELEGATIONS.delete(oldestFinished[0]);
  }
}

function snapshotDelegation(record) {
  return {
    id: record.id,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : null,
    durationMs: record.finishedAt ? record.finishedAt - record.createdAt : Date.now() - record.createdAt,
    tasks: record.tasks.map((entry, index) => ({
      index,
      goal: entry.spec.goal,
      kind: entry.spec.kind,
      verify: entry.spec.verify,
      state: entry.state,
      steerCount: entry.steerCount,
      steerNotes: entry.steerNotes.length ? [...entry.steerNotes] : undefined,
      iterations: entry.result?.iterations ?? null,
      durationMs: entry.result?.durationMs ?? null,
      model: entry.result?.model ?? null,
      summary: entry.result?.summary ?? undefined,
      error: entry.error ?? undefined
    }))
  };
}

function refreshRecordStatus(record) {
  record.status = record.tasks.some((entry) => entry.state === "queued" || entry.state === "running")
    ? "running"
    : "done";
  if (record.status === "done" && !record.finishedAt) record.finishedAt = Date.now();
}

export function registerDelegateTaskTool(runtime) {
  async function runChild({ context, config, parentDepth, task, index, total, controller, steeringNote }) {
    const host = runtime.agentHost;
    const childDepth = parentDepth + 1;
    const parentSessionId = String(context.sessionId ?? "unknown");
    const n = index + 1;
    const effectiveRole = task.role === "orchestrator" && childDepth < config.maxSpawnDepth
      ? "orchestrator"
      : "leaf";
    const childId = randomUUID();
    const sessionId = `subagent:${parentSessionId}:${childId}`;
    const inheritedIterations = Number(context.__remainingIterations);
    const maxIterations = Number.isSafeInteger(inheritedIterations)
      ? Math.min(config.maxIterations, Math.max(0, inheritedIterations))
      : config.maxIterations;
    const inheritedDeadline = Number(context.__turnDeadline);
    const remainingTurnSeconds = Number.isFinite(inheritedDeadline)
      ? Math.floor((inheritedDeadline - Date.now()) / 1000)
      : config.maxTurnSeconds;
    const maxTurnSeconds = Math.min(config.maxTurnSeconds, remainingTurnSeconds);
    const allowedTools = childAllowedTools(runtime, context, effectiveRole, childDepth, config.maxSpawnDepth);
    const childEvent = (event) => {
      if (event?.phase === "iteration") {
        notify(context, { phase: "subagent", n, total, state: "running", iteration: event.n, maxIterations: event.max });
      }
    };
    notify(context, { phase: "subagent", n, total, state: "starting" });
    const startedAt = Date.now();
    try {
      const result = await host.handleMessage({
        channel: "subagent",
        from: context.from ?? "delegator",
        agentId: "main",
        sessionId,
        projectId: context.__projectId ?? "default",
        text: childPrompt(task, steeringNote),
        origin: context.__jobId ? "job" : "subagent",
        jobId: context.__jobId ?? null,
        routeTo: false,
        metadata: {
          delegatedBy: parentSessionId,
          projectId: context.__projectId ?? "default",
          role: effectiveRole,
          spawnDepth: childDepth
        },
        // Route the child by the KIND of work it was given. Without this
        // every subagent inherited the `chat` task and ran on the base
        // model, so a mechanical lookup cost the same as deep reasoning.
        // An absent/unknown kind resolves to the conservative `delegate`
        // profile, which is base — never a silent downgrade.
        routingTask: delegateTaskForKind(task.kind),
        memoryScope: `subagent:${childId}`,
        allowedTools,
        scrutinyPolicyCeiling: context.__scrutinyPolicy ?? "full",
        spawnDepth: childDepth,
        maxIterations,
        maxTurnSeconds,
        budgetEnvelope: context.__budgetEnvelope ?? null,
        turnDeadline: Number.isFinite(inheritedDeadline)
          ? inheritedDeadline
          : null,
        abortSignal: controller.signal,
        onToolEvent: childEvent
      });
      notify(context, { phase: "subagent", n, total, state: "completed" });
      return {
        goal: task.goal,
        ok: true,
        summary: String(result?.reply ?? "").slice(0, MAX_SUMMARY_CHARS),
        iterations: result?.model?.iterations ?? null,
        stopReason: result?.model?.stopReason ?? "completed",
        // Report what the routing decision actually produced. Without the
        // resolved model, a tiering change looks identical to no change and
        // a silent fallback to the base model is invisible.
        kind: task.kind,
        routedTask: delegateTaskForKind(task.kind),
        model: result?.model?.model ?? null,
        // Per-child cost observability: cheap lanes must be MEASURED cheap,
        // not assumed. Null when the provider did not report usage.
        durationMs: Date.now() - startedAt,
        usage: result?.model?.usage ?? null,
        verify: task.verify
      };
    } catch (error) {
      notify(context, { phase: "subagent", n, total, state: "failed" });
      throw Object.assign(new Error(errorText(error)), { goal: task.goal });
    }
  }

  function failureResult(task, error) {
    return {
      goal: task.goal,
      ok: false,
      summary: "",
      iterations: null,
      stopReason: "error",
      error: errorText(error)
    };
  }

  async function runSyncWave({ context, config, parentDepth, waveTasks, offset, total }) {
    const controllers = waveTasks.map(() => new AbortController());
    const abortChildren = () => {
      for (const controller of controllers) controller.abort(context.__abortSignal?.reason);
    };
    if (context.__abortSignal?.aborted) abortChildren();
    else context.__abortSignal?.addEventListener?.("abort", abortChildren, { once: true });
    try {
      const runs = waveTasks.map((task, waveIndex) => runChild({
        context,
        config,
        parentDepth,
        task,
        index: offset + waveIndex,
        total,
        controller: controllers[waveIndex],
        steeringNote: null
      }));
      const settled = await Promise.allSettled(runs);
      return settled.map((item, waveIndex) => item.status === "fulfilled"
        ? item.value
        : failureResult(waveTasks[waveIndex], item.reason));
    } finally {
      context.__abortSignal?.removeEventListener?.("abort", abortChildren);
    }
  }

  async function runAsyncTask(record, entry, runArgs) {
    if (entry.state === "cancelled") return;
    entry.state = "running";
    entry.controller = new AbortController();
    const steeringNote = entry.steerNotes.length ? entry.steerNotes.join("\n") : null;
    try {
      entry.result = await runChild({
        ...runArgs,
        task: entry.spec,
        controller: entry.controller,
        steeringNote
      });
      entry.state = "completed";
      entry.error = null;
    } catch (error) {
      if (entry.cancelRequested) {
        entry.state = "cancelled";
        entry.error = "cancelled by delegate_cancel";
      } else if (entry.steerRequested && entry.steerCount < MAX_STEERS_PER_TASK) {
        // Steering a running child = interrupt + respawn with the redirect in
        // its prompt. Subagent loops have no mid-turn message injection, so a
        // clean restart with full steering context is the honest mechanism.
        entry.steerRequested = false;
        entry.steerCount += 1;
        return runAsyncTask(record, entry, runArgs);
      } else if (entry.steerRequested) {
        entry.steerRequested = false;
        entry.state = "failed";
        entry.error = `steer limit reached (${MAX_STEERS_PER_TASK}); last error: ${errorText(error)}`;
      } else {
        entry.state = "failed";
        entry.error = errorText(error);
      }
    }
  }

  async function runAsyncDelegation(record, runArgs) {
    const waves = chunk(record.tasks, runArgs.config.maxChildren);
    for (const wave of waves) {
      await Promise.all(wave.map((entry) => runAsyncTask(record, entry, runArgs)));
    }
    refreshRecordStatus(record);
    pruneAsyncDelegations();
    notify(runArgs.context, {
      phase: "subagent",
      state: "delegation-complete",
      delegationId: record.id,
      total: record.tasks.length
    });
  }

  runtime.tools.register({
    name: "delegate_task",
    sideEffects: true,
    description: "Delegate one isolated task, or a batch of independent tasks, to parallel subagents. Each child knows only the supplied goal/context and returns only its final summary. Use for parallel research or bounded work that does not need the parent conversation. Set `kind` to say what the work IS (reason/code/debug/research/extract) and the child is matched to a model of appropriate strength — cheap mechanical work does not need the top model. Omitting kind keeps the strongest model. Batches larger than OPENAGI_MAX_CHILDREN (default 3) run in sequential waves of that size — pass as many tasks as you have. Set `verify` to declare how a child's work should be checked; it is injected into the child prompt and echoed in the result. Set `async: true` to detach: returns a delegationId immediately and the children run in the background — manage them with delegate_status, delegate_steer and delegate_cancel.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Single-task goal. Mutually exclusive with tasks." },
        context: { type: "string", description: "Background the child needs; it cannot see the parent chat." },
        role: { type: "string", enum: ["leaf", "orchestrator"], description: "Single-task role (default leaf)." },
        kind: {
          type: "string",
          enum: Object.keys(DELEGATE_KINDS),
          description: "Kind of work, which selects the child's model. 'reason': Strongest model. Architecture, design tradeoffs, ambiguous or open-ended problems. 'code': Strongest model. Writing or refactoring code that must compile and pass tests. 'debug': Mid model. Running tests, reading failures, bisecting. 'research': Mid model. Reading sources and summarizing. 'extract': Cheapest model. Mechanical lookup: find a value, list files, pull one field. Omit when unsure — an unlabelled task keeps the strongest model."
        },
        verify: {
          type: "string",
          description: "Optional pass/fail expectation for the work (e.g. 'summary must list exactly 3 files'). Injected into the child prompt and echoed in the result so mechanical fan-out gets a checkable contract."
        },
        async: {
          type: "boolean",
          description: "Detach the batch: returns a delegationId immediately instead of awaiting results. Children run in the background and are NOT aborted when your turn ends — manage them with delegate_status, delegate_steer and delegate_cancel."
        },
        tasks: {
          type: "array",
          description: "Batch tasks. Mutually exclusive with goal. Any size — runs in waves of OPENAGI_MAX_CHILDREN (default 3) at a time.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string" },
              context: { type: "string" },
              role: { type: "string", enum: ["leaf", "orchestrator"] },
              kind: {
                type: "string",
                enum: Object.keys(DELEGATE_KINDS),
                description: "Per-task work kind; selects that child's model. See the top-level kind."
              },
              verify: {
                type: "string",
                description: "Per-task pass/fail expectation. See the top-level verify."
              }
            },
            required: ["goal"],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    summarize: (args) => `Delegate ${Array.isArray(args.tasks) ? `${args.tasks.length} tasks` : String(args.goal ?? "task").slice(0, 100)}`,
    handler: async (args, context = {}) => {
      const config = resolveSubagentConfig();
      const parentDepth = nonNegativeInteger(context.__spawnDepth, 0);
      if (parentDepth >= config.maxSpawnDepth) {
        return { error: `max spawn depth reached (${config.maxSpawnDepth})` };
      }

      const normalized = normalizeRequest(args);
      if (normalized.error) return { error: normalized.error };
      const host = runtime.agentHost;
      if (!host?.handleMessage) return { error: "Agent host unavailable for delegation." };
      if (context.__abortSignal?.aborted) return { error: "delegation cancelled" };
      const inheritedIterations = Number(context.__remainingIterations);
      const maxIterations = Number.isSafeInteger(inheritedIterations)
        ? Math.min(config.maxIterations, Math.max(0, inheritedIterations))
        : config.maxIterations;
      if (maxIterations < 1) {
        return { error: "parent iteration budget is exhausted" };
      }
      const inheritedDeadline = Number(context.__turnDeadline);
      const remainingTurnSeconds = Number.isFinite(inheritedDeadline)
        ? Math.floor((inheritedDeadline - Date.now()) / 1000)
        : config.maxTurnSeconds;
      const maxTurnSeconds = Math.min(
        config.maxTurnSeconds,
        remainingTurnSeconds
      );
      if (maxTurnSeconds < 1) {
        return { error: "parent turn deadline is exhausted" };
      }

      if (args.async === true) {
        pruneAsyncDelegations();
        if (ASYNC_DELEGATIONS.size >= MAX_ASYNC_DELEGATIONS) {
          return { error: `async delegation registry is full (${MAX_ASYNC_DELEGATIONS}); wait for running delegations to finish` };
        }
        const record = {
          id: randomUUID(),
          status: "running",
          createdAt: Date.now(),
          finishedAt: null,
          tasks: normalized.tasks.map((spec) => ({
            spec,
            state: "queued",
            controller: null,
            result: null,
            error: null,
            steerNotes: [],
            steerCount: 0,
            steerRequested: false,
            cancelRequested: false
          }))
        };
        ASYNC_DELEGATIONS.set(record.id, record);
        const runArgs = { context, config, parentDepth, total: record.tasks.length };
        // Detached by design: async children are deliberately NOT tied to the
        // parent's abort signal — the point of async mode is outliving the
        // call. delegate_cancel is the kill switch.
        void runAsyncDelegation(record, runArgs).catch((error) => {
          for (const entry of record.tasks) {
            if (entry.state === "queued" || entry.state === "running") {
              entry.state = "failed";
              entry.error = errorText(error);
            }
          }
          record.status = "done";
          record.finishedAt = Date.now();
        });
        return {
          delegationId: record.id,
          async: true,
          tasks: record.tasks.length,
          status: "running"
        };
      }

      const total = normalized.tasks.length;
      const waves = chunk(normalized.tasks, config.maxChildren);
      const results = [];
      for (const wave of waves) {
        const waveResults = await runSyncWave({
          context,
          config,
          parentDepth,
          waveTasks: wave,
          offset: results.length,
          total
        });
        results.push(...waveResults);
      }
      return waves.length > 1 ? { results, waves: waves.length } : { results };
    }
  });

  runtime.tools.register({
    name: "delegate_status",
    sideEffects: false,
    description: "Inspect async delegations started with delegate_task(async:true). With an id, returns the full record: per-task state (queued/running/completed/failed/cancelled), model, iterations, durationMs, steer history, and summaries. Without an id, lists every live and recently finished delegation.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Delegation id returned by delegate_task. Omit to list all." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      pruneAsyncDelegations();
      if (args?.id) {
        const record = ASYNC_DELEGATIONS.get(String(args.id));
        if (!record) return { error: "unknown delegation id (finished delegations are retained for 1h)" };
        return snapshotDelegation(record);
      }
      return {
        delegations: [...ASYNC_DELEGATIONS.values()].map((record) => ({
          id: record.id,
          status: record.status,
          tasks: record.tasks.length,
          completed: record.tasks.filter((entry) => entry.state === "completed").length,
          createdAt: new Date(record.createdAt).toISOString()
        }))
      };
    }
  });

  runtime.tools.register({
    name: "delegate_steer",
    sideEffects: true,
    description: "Redirect a task inside a running async delegation. If the child is still running it is interrupted and respawned with your note in its prompt (max 5 steers per task); if it already finished it is re-run as a refinement with the note; if it is queued the note is waiting when it starts. Use for course corrections — 'focus on X instead', 'stop researching and summarize what you have'.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Delegation id returned by delegate_task." },
        taskIndex: { type: "integer", description: "Which task to steer (0-based, from delegate_status). Omit to steer every unfinished task." },
        note: { type: "string", description: "The steering instruction injected into the child's prompt." }
      },
      required: ["id", "note"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      const record = ASYNC_DELEGATIONS.get(String(args?.id ?? ""));
      if (!record) return { error: "unknown delegation id" };
      const note = String(args?.note ?? "").trim();
      if (!note) return { error: "note is required" };
      const targets = args?.taskIndex === undefined
        ? record.tasks.filter((entry) => entry.state === "queued" || entry.state === "running")
        : [record.tasks[Number(args.taskIndex)]];
      if (!targets.length || targets.some((entry) => !entry)) {
        return { error: "no matching task at that index (or nothing left to steer)" };
      }
      const steered = [];
      for (const entry of targets) {
        entry.steerNotes.push(note.slice(0, 2_000));
        const index = record.tasks.indexOf(entry);
        if (entry.state === "running" && entry.controller) {
          entry.steerRequested = true;
          entry.controller.abort(new Error("steered"));
          steered.push({ index, action: "interrupted; respawning with steering note" });
        } else if (entry.state === "queued") {
          steered.push({ index, action: "note queued; applied when the task starts" });
        } else {
          // Finished task: re-run as a refinement with the steering note.
          entry.state = "queued";
          entry.result = null;
          entry.error = null;
          entry.steerCount += 1;
          record.status = "running";
          record.finishedAt = null;
          const config = resolveSubagentConfig();
          const runArgs = {
            context,
            config,
            parentDepth: nonNegativeInteger(context.__spawnDepth, 0),
            total: record.tasks.length
          };
          void runAsyncTask(record, entry, runArgs).then(() => refreshRecordStatus(record));
          steered.push({ index, action: "re-running as refinement with steering note" });
        }
      }
      notify(context, { phase: "subagent", state: "steered", delegationId: record.id, steered: steered.length });
      return { delegationId: record.id, steered };
    }
  });

  runtime.tools.register({
    name: "delegate_cancel",
    sideEffects: true,
    description: "Stop a running async delegation, or one task inside it. Running children are aborted immediately; queued tasks are marked cancelled and never start. Finished tasks are unaffected. The record stays readable via delegate_status.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Delegation id returned by delegate_task." },
        taskIndex: { type: "integer", description: "Cancel only this task (0-based). Omit to cancel the whole delegation." }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      const record = ASYNC_DELEGATIONS.get(String(args?.id ?? ""));
      if (!record) return { error: "unknown delegation id" };
      const targets = args?.taskIndex === undefined
        ? record.tasks
        : [record.tasks[Number(args.taskIndex)]];
      if (!targets.length || targets.some((entry) => !entry)) {
        return { error: "no task at that index" };
      }
      const cancelled = [];
      for (const entry of targets) {
        const index = record.tasks.indexOf(entry);
        if (entry.state === "running" && entry.controller) {
          entry.cancelRequested = true;
          entry.controller.abort(new Error("cancelled by delegate_cancel"));
          cancelled.push({ index, action: "aborting running child" });
        } else if (entry.state === "queued") {
          entry.state = "cancelled";
          entry.error = "cancelled before start";
          cancelled.push({ index, action: "cancelled before start" });
        }
      }
      refreshRecordStatus(record);
      notify(context, { phase: "subagent", state: "cancelled", delegationId: record.id, cancelled: cancelled.length });
      return { delegationId: record.id, status: record.status, cancelled };
    }
  });
}

export const SUBAGENT_DEFAULTS = Object.freeze({
  maxChildren: DEFAULT_MAX_CHILDREN,
  maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  maxTurnSeconds: DEFAULT_MAX_TURN_SECONDS
});

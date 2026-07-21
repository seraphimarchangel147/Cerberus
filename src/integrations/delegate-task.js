import { randomUUID } from "node:crypto";

const DEFAULT_MAX_CHILDREN = 3;
const DEFAULT_MAX_SPAWN_DEPTH = 1;
const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_MAX_TURN_SECONDS = 600;
const MAX_SUMMARY_CHARS = 16_000;

// Headless workers cannot ask the user or schedule a later conversation. The
// legacy delegation tool is also removed so every nested spawn uses this
// module's audited depth and scrutiny ceilings.
export const SUBAGENT_INTERACTIVE_TOOLS = Object.freeze([
  "send_message",
  "schedule_message",
  "delegate_subtask"
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
  return { task: { goal, context: String(task.context ?? "").trim(), role } };
}

function normalizeRequest(args, maxChildren) {
  const hasGoal = args?.goal !== undefined;
  const hasTasks = args?.tasks !== undefined;
  if (hasGoal === hasTasks) return { error: "Provide exactly one of goal or tasks." };

  if (hasGoal) {
    const normalized = normalizeTask({ goal: args.goal, context: args.context, role: args.role }, 0);
    return normalized.task
      ? { tasks: [normalized.task] }
      : { error: normalized.error.replace("tasks[0].", "") };
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return { error: "tasks must be a non-empty array" };
  }
  if (args.tasks.length > maxChildren) {
    return { error: `Too many child tasks (${args.tasks.length}); OPENAGI_MAX_CHILDREN is ${maxChildren}.` };
  }
  const tasks = [];
  for (let index = 0; index < args.tasks.length; index += 1) {
    const normalized = normalizeTask(args.tasks[index], index);
    if (normalized.error) return normalized;
    tasks.push(normalized.task);
  }
  return { tasks };
}

function childPrompt(task) {
  const contextBlock = task.context || "(No background context was provided.)";
  return `[delegated_task]\nGoal:\n${task.goal}\n\n<background_context>\n${contextBlock}\n</background_context>\n\nWork independently. You have no access to the parent conversation beyond the block above. Do not ask the user questions or send messages. Use tools as needed, then return only a concise final summary of findings, completed work, blockers, and any remaining action.\n[/delegated_task]`;
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

export function registerDelegateTaskTool(runtime) {
  runtime.tools.register({
    name: "delegate_task",
    sideEffects: true,
    description: "Delegate one isolated task, or a batch of independent tasks, to parallel subagents. Each child knows only the supplied goal/context and returns only its final summary. Use for parallel research or bounded work that does not need the parent conversation.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Single-task goal. Mutually exclusive with tasks." },
        context: { type: "string", description: "Background the child needs; it cannot see the parent chat." },
        role: { type: "string", enum: ["leaf", "orchestrator"], description: "Single-task role (default leaf)." },
        tasks: {
          type: "array",
          description: "Batch tasks. Mutually exclusive with goal.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string" },
              context: { type: "string" },
              role: { type: "string", enum: ["leaf", "orchestrator"] }
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

      const normalized = normalizeRequest(args, config.maxChildren);
      if (normalized.error) return { error: normalized.error };
      const host = runtime.agentHost;
      if (!host?.handleMessage) return { error: "Agent host unavailable for delegation." };
      if (context.__abortSignal?.aborted) return { error: "delegation cancelled" };

      const childDepth = parentDepth + 1;
      const parentSessionId = String(context.sessionId ?? "unknown");
      const controllers = normalized.tasks.map(() => new AbortController());
      const abortChildren = () => {
        for (const controller of controllers) controller.abort(context.__abortSignal?.reason);
      };
      if (context.__abortSignal?.aborted) abortChildren();
      else context.__abortSignal?.addEventListener?.("abort", abortChildren, { once: true });

      const runs = normalized.tasks.map(async (task, index) => {
        const n = index + 1;
        const effectiveRole = task.role === "orchestrator" && childDepth < config.maxSpawnDepth
          ? "orchestrator"
          : "leaf";
        const childId = randomUUID();
        const sessionId = `subagent:${parentSessionId}:${childId}`;
        const allowedTools = childAllowedTools(runtime, context, effectiveRole, childDepth, config.maxSpawnDepth);
        const childEvent = (event) => {
          if (event?.phase === "iteration") {
            notify(context, { phase: "subagent", n, total: normalized.tasks.length, state: "running", iteration: event.n, maxIterations: event.max });
          }
        };
        notify(context, { phase: "subagent", n, total: normalized.tasks.length, state: "starting" });
        try {
          const result = await host.handleMessage({
            channel: "subagent",
            from: context.from ?? "delegator",
            agentId: "main",
            sessionId,
            text: childPrompt(task),
            origin: "subagent",
            routeTo: false,
            metadata: { delegatedBy: parentSessionId, role: effectiveRole, spawnDepth: childDepth },
            memoryScope: `subagent:${childId}`,
            allowedTools,
            scrutinyPolicyCeiling: context.__scrutinyPolicy ?? "full",
            spawnDepth: childDepth,
            maxIterations: config.maxIterations,
            maxTurnSeconds: config.maxTurnSeconds,
            abortSignal: controllers[index].signal,
            onToolEvent: childEvent
          });
          notify(context, { phase: "subagent", n, total: normalized.tasks.length, state: "completed" });
          return {
            goal: task.goal,
            ok: true,
            summary: String(result?.reply ?? "").slice(0, MAX_SUMMARY_CHARS),
            iterations: result?.model?.iterations ?? null,
            stopReason: result?.model?.stopReason ?? "completed"
          };
        } catch (error) {
          notify(context, { phase: "subagent", n, total: normalized.tasks.length, state: "failed" });
          throw Object.assign(new Error(errorText(error)), { goal: task.goal });
        }
      });

      try {
        const settled = await Promise.allSettled(runs);
        const results = settled.map((item, index) => item.status === "fulfilled"
          ? item.value
          : {
              goal: normalized.tasks[index].goal,
              ok: false,
              summary: "",
              iterations: null,
              stopReason: "error",
              error: errorText(item.reason)
            });
        return { results };
      } finally {
        context.__abortSignal?.removeEventListener?.("abort", abortChildren);
      }
    }
  });
}

export const SUBAGENT_DEFAULTS = Object.freeze({
  maxChildren: DEFAULT_MAX_CHILDREN,
  maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  maxTurnSeconds: DEFAULT_MAX_TURN_SECONDS
});

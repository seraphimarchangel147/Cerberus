function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

function sessionProjectId(projects, sessionId) {
  if (typeof projects?.projectForSession !== "function") return null;
  try {
    return projects.projectForSession(sessionId, { includeArchived: false })?.id ?? null;
  } catch {
    return null;
  }
}

export function registerSessionSearchTool(runtime) {
  runtime.tools.register({
    name: "searcmcp_sessions",
    sideEffects: false,
    description: "Search your OWN past conversations (full-text over session transcripts). Use to recall prior decisions, context, or 'what did we do about X'. Returns matching snippets with their session id and timestamp.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find across your persisted conversation messages." },
        limit: {
          type: ["integer", "string"],
          description: "Maximum snippets to return. Values are normalized and clamped to 1..20 (default 8)."
        },
        role: { type: "string", enum: ["user", "assistant", "tool"], description: "Optional exact message-role filter." },
        sessionId: { type: "string", description: "Optional exact session id filter." },
        since: { type: "string", description: "Optional inclusive ISO timestamp lower bound." },
        until: { type: "string", description: "Optional inclusive ISO timestamp upper bound." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const query = String(args?.query ?? "").trim();
      const invocationRuntime = context?.runtime ?? runtime;
      const index = invocationRuntime?.sessionIndex ?? runtime.sessionIndex;
      if (!index?.search) return { query, count: 0, hits: [] };
      const projects = invocationRuntime?.projects ?? runtime.projects ?? null;
      const projectScoped = typeof projects?.projectForSession === "function";
      const projectId = String(context?.__projectId ?? "default").trim() || "default";
      if (
        projectScoped
        && args?.sessionId
        && sessionProjectId(projects, args.sessionId) !== projectId
      ) {
        throw new Error("Session is outside the current project.");
      }
      const limit = clampLimit(args?.limit ?? 8);
      const hits = await index.search(query, {
        // The legacy index has no project column. Fetch a bounded surplus
        // before filtering so foreign hits cannot usually crowd the current
        // project's requested page. Unscoped runtimes keep the old limit.
        limit: projectScoped ? Math.min(100, limit * 8) : limit,
        role: args?.role ?? null,
        sessionId: args?.sessionId ?? null,
        since: args?.since ?? null,
        until: args?.until ?? null
      });
      const visible = projectScoped
        ? hits
            .filter((hit) => sessionProjectId(projects, hit.sessionId) === projectId)
            .slice(0, limit)
        : hits;
      return { query, count: visible.length, hits: visible };
    }
  });
}

export { clampLimit as clampSessionSearchLimit };

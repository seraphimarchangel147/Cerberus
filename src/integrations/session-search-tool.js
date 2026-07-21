function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
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
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum snippets to return (default 8)." },
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
      const index = context?.runtime?.sessionIndex ?? runtime.sessionIndex;
      if (!index?.search) return { query, count: 0, hits: [] };
      const hits = await index.search(query, {
        limit: clampLimit(args?.limit ?? 8),
        role: args?.role ?? null,
        sessionId: args?.sessionId ?? null,
        since: args?.since ?? null,
        until: args?.until ?? null
      });
      return { query, count: hits.length, hits };
    }
  });
}

export { clampLimit as clampSessionSearchLimit };

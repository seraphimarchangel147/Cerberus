const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

export const DEFAULT_TOOL_SEARCH_THRESHOLD_BYTES = 24 * 1024;
export const TOOL_SEARCH_BRIDGE_NAMES = Object.freeze([
  "tool_search",
  "tool_describe",
  "tool_call"
]);

const BRIDGE_NAME_SET = new Set(TOOL_SEARCH_BRIDGE_NAMES);
const VALID_MODES = new Set(["auto", "on", "off"]);

export function resolveToolSearchMode(envOrOptions = process.env) {
  let value;
  if (typeof envOrOptions === "string") {
    value = envOrOptions;
  } else if (envOrOptions && typeof envOrOptions === "object") {
    value = envOrOptions.mode
      ?? envOrOptions.OPENAGI_TOOL_SEARCH
      ?? envOrOptions.env?.OPENAGI_TOOL_SEARCH;
  }
  const normalized = String(value ?? "auto").trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : "auto";
}

export function isToolSearchDeferrable(tool) {
  if (!tool || BRIDGE_NAME_SET.has(String(tool.name ?? ""))) return false;
  const rawOverride = tool.metadata?.toolSearch;
  const override = typeof rawOverride === "string"
    ? rawOverride.trim().toLowerCase()
    : rawOverride;
  if (override === "core" || override === false) return false;
  if (override === "deferred" || override === true) return true;

  const source = String(tool.source ?? "internal").trim().toLowerCase();
  if (source === "mcp" || source === "plugin") return true;
  return source === "skill" && String(tool.name ?? "").startsWith("skill_");
}

export function toolSchemaBytes(tools = []) {
  const schemas = asToolArray(tools).map((tool) => ({
    name: String(tool.name ?? ""),
    description: String(tool.description ?? ""),
    parameters: toolParameters(tool)
  }));
  return Buffer.byteLength(JSON.stringify(schemas), "utf8");
}

export const calculateToolSchemaBytes = toolSchemaBytes;

export function rankToolSearch(tools, query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const boundedLimit = boundedSearchLimit(limit);
  const queryTokens = tokens(normalizedQuery);
  const ranked = [];

  for (const tool of asToolArray(tools)) {
    const name = String(tool.name ?? "");
    if (!name) continue;
    const normalizedName = name.toLowerCase();
    const server = String(tool.metadata?.server ?? "");
    const originalName = String(tool.metadata?.originalName ?? "");
    const description = String(tool.description ?? "");
    const haystack = `${normalizedName} ${server} ${originalName} ${description}`.toLowerCase();
    let score = 0;

    if (!normalizedQuery) {
      score = 1;
    } else {
      if (normalizedName === normalizedQuery) score += 1000;
      else if (normalizedName.startsWith(normalizedQuery)) score += 700;
      else if (normalizedName.includes(normalizedQuery)) score += 500;
      if (haystack.includes(normalizedQuery)) score += 180;

      const nameTokens = new Set(tokens(`${normalizedName} ${originalName}`));
      const serverTokens = new Set(tokens(server));
      const descriptionTokens = new Set(tokens(description));
      for (const token of queryTokens) {
        if (nameTokens.has(token)) score += 90;
        else if (normalizedName.includes(token)) score += 55;
        if (serverTokens.has(token)) score += 35;
        if (descriptionTokens.has(token)) score += 20;
        else if (description.toLowerCase().includes(token)) score += 8;
      }
    }

    if (score > 0) ranked.push({ tool, score });
  }

  return ranked
    .sort((left, right) => right.score - left.score
      || String(left.tool.name).localeCompare(String(right.tool.name)))
    .slice(0, boundedLimit);
}

export class ToolSearchController {
  constructor(options = {}) {
    this.registry = options.registry ?? null;
    this.env = options.env ?? process.env;
    const configuredThreshold = options.thresholdBytes
      ?? options.schemaThresholdBytes
      ?? DEFAULT_TOOL_SEARCH_THRESHOLD_BYTES;
    this.thresholdBytes = nonNegativeInteger(
      configuredThreshold,
      DEFAULT_TOOL_SEARCH_THRESHOLD_BYTES
    );
  }

  bindRegistry(registry) {
    this.registry = registry ?? null;
    return this;
  }

  planModelTools(tools, options = {}) {
    const all = asToolArray(tools);
    const only = nameSet(options.only);
    const contextAllowed = nameSet(options.context?.__allowedTools);
    const readOnly = options.readOnly === true
      || options.context?.__scrutinyPolicy === "read-only";
    const noTools = options.context?.__scrutinyPolicy === "none";

    let eligible = noTools ? [] : all.filter((tool) => !BRIDGE_NAME_SET.has(tool.name));
    if (only) eligible = eligible.filter((tool) => only.has(tool.name));
    if (contextAllowed) eligible = eligible.filter((tool) => contextAllowed.has(tool.name));
    if (readOnly) eligible = eligible.filter((tool) => tool.sideEffects === false);

    const candidates = eligible.filter(isToolSearchDeferrable);
    const schemaBytes = toolSchemaBytes(candidates);
    const mode = resolveToolSearchMode(
      options.mode === undefined ? this.env : { mode: options.mode }
    );
    const thresholdBytes = options.thresholdBytes === undefined
      ? this.thresholdBytes
      : nonNegativeInteger(options.thresholdBytes, this.thresholdBytes);
    const deferredNames = selectDeferredNames(candidates, {
      defer: options.defer,
      mode,
      schemaBytes,
      thresholdBytes
    });
    const active = deferredNames.size > 0;

    if (!active) {
      return {
        active: false,
        mode,
        schemaBytes,
        thresholdBytes,
        deferredNames: [],
        tools: eligible
      };
    }

    const visible = eligible.filter((tool) => !deferredNames.has(tool.name));
    for (const name of TOOL_SEARCH_BRIDGE_NAMES) {
      const bridge = all.find((tool) => tool.name === name) ?? this.registry?.get?.(name);
      if (bridge && !visible.some((tool) => tool.name === name)) visible.push(bridge);
    }

    return {
      active: true,
      mode,
      schemaBytes,
      thresholdBytes,
      deferredNames: [...deferredNames],
      tools: visible
    };
  }

  shapeModelTools(tools, options = {}) {
    return this.planModelTools(tools, options).tools;
  }

  eligibleDeferredTools({ context = {}, only, readOnly } = {}) {
    const allowed = nameSet(context?.__allowedTools);
    const onlyNames = nameSet(only);
    const requireReadOnly = readOnly === true || context?.__scrutinyPolicy === "read-only";
    if (context?.__scrutinyPolicy === "none") return [];

    return this._registryTools().filter((tool) => {
      if (!isToolSearchDeferrable(tool)) return false;
      if (allowed && !allowed.has(tool.name)) return false;
      if (onlyNames && !onlyNames.has(tool.name)) return false;
      if (requireReadOnly && tool.sideEffects !== false) return false;
      return true;
    });
  }

  search(query, { limit = DEFAULT_SEARCH_LIMIT, context = {} } = {}) {
    const normalizedQuery = String(query ?? "").trim();
    if (!normalizedQuery) throw new Error("tool_search query must be a non-empty string.");
    const matches = rankToolSearch(
      this.eligibleDeferredTools({ context }),
      normalizedQuery,
      { limit }
    );
    return {
      query: normalizedQuery,
      count: matches.length,
      items: matches.map(({ tool, score }) => ({
        name: tool.name,
        description: truncateDescription(tool.description),
        source: tool.source ?? "internal",
        server: tool.metadata?.server ?? null,
        score
      }))
    };
  }

  describe(name, { context = {} } = {}) {
    const normalizedName = String(name ?? "").trim();
    const tool = this.eligibleDeferredTools({ context })
      .find((candidate) => candidate.name === normalizedName);
    if (!tool) {
      throw new Error(`Unknown or unavailable deferred tool: ${normalizedName || "(empty)"}`);
    }
    return {
      name: tool.name,
      description: String(tool.description ?? ""),
      parameters: toolParameters(tool),
      source: tool.source ?? "internal",
      server: tool.metadata?.server ?? null,
      originalName: tool.metadata?.originalName ?? null
    };
  }

  resolveCall(name, args, { context: _context = {} } = {}) {
    const normalizedName = String(name ?? "").trim();
    const tool = this._registryTools()
      .find((candidate) => candidate.name === normalizedName);
    if (!tool || !isToolSearchDeferrable(tool)) {
      return {
        error: `tool_call target must be a registered deferred tool: ${normalizedName || "(empty)"}`
      };
    }
    const invocationArgs = args ?? {};
    if (!isPlainArguments(invocationArgs)) {
      return { error: "tool_call arguments must be an object." };
    }
    return { name: tool.name, args: invocationArgs };
  }

  _registryTools() {
    if (typeof this.registry?.list === "function") {
      return asToolArray(this.registry.list());
    }
    if (this.registry?.tools instanceof Map) {
      return [...this.registry.tools.values()];
    }
    return [];
  }
}

export function registerToolSearchTools(registry, options = {}) {
  if (!registry?.register) throw new TypeError("Tool search requires a tool registry.");
  const controller = options.controller instanceof ToolSearchController
    ? options.controller.bindRegistry(registry)
    : new ToolSearchController({ ...options, registry });

  registry.register({
    name: "tool_search",
    source: "internal",
    sideEffects: false,
    description: "Search deferred MCP and plugin tools by name or description. Use tool_describe before calling an unfamiliar result.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing the capability to find." },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT }
      },
      required: ["query"],
      additionalProperties: false
    },
    metadata: {
      toolSearch: "core",
      scopeBridge: true
    },
    handler: (args = {}, context = {}) => controller.search(args.query, {
      limit: args.limit,
      context
    })
  });

  registry.register({
    name: "tool_describe",
    source: "internal",
    sideEffects: false,
    description: "Return the complete input schema for one deferred tool found by tool_search.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact deferred tool name." }
      },
      required: ["name"],
      additionalProperties: false
    },
    metadata: {
      toolSearch: "core",
      scopeBridge: true
    },
    handler: (args = {}, context = {}) => controller.describe(args.name, { context })
  });

  registry.register({
    name: "tool_call",
    source: "internal",
    sideEffects: false,
    description: "Invoke one deferred tool by its exact name. The real tool retains its own hooks, policy gates, approval rules, and activity identity.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact deferred tool name." },
        arguments: {
          type: "object",
          description: "Arguments matching the schema returned by tool_describe.",
          additionalProperties: true
        }
      },
      required: ["name"],
      additionalProperties: false
    },
    metadata: {
      toolSearch: "core",
      scopeBridge: true,
      forwardInvocation: (args = {}, context = {}) => (
        controller.resolveCall(args.name, args.arguments, { context })
      )
    },
    handler: async (args = {}, context = {}) => {
      const forwarded = controller.resolveCall(args.name, args.arguments, { context });
      if (forwarded.error) throw new Error(forwarded.error);
      if (typeof registry.invoke !== "function") throw new Error("Tool registry cannot invoke tools.");
      return registry.invoke(forwarded.name, forwarded.args, context);
    }
  });

  if (typeof registry.bindToolSearch === "function") registry.bindToolSearch(controller);
  registry.toolSearchController = controller;
  return controller;
}

function selectDeferredNames(candidates, {
  defer,
  mode,
  schemaBytes,
  thresholdBytes
}) {
  if (defer === false) return new Set();
  if (defer === true) return new Set(candidates.map((tool) => tool.name));

  const explicit = nameSet(defer);
  if (explicit) {
    return new Set(
      candidates
        .filter((tool) => explicit.has(tool.name))
        .map((tool) => tool.name)
    );
  }

  if (mode === "off") return new Set();
  if (mode === "on") return new Set(candidates.map((tool) => tool.name));
  if (schemaBytes <= thresholdBytes) return new Set();
  return new Set(candidates.map((tool) => tool.name));
}

function toolParameters(tool) {
  return tool?.parameters
    ?? tool?.input_schema
    ?? { type: "object", properties: {}, additionalProperties: false };
}

function asToolArray(tools) {
  return Array.isArray(tools) ? tools.filter(Boolean) : [];
}

function nameSet(value) {
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return null;
}

function boundedSearchLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed)));
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function tokens(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function truncateDescription(value) {
  const text = String(value ?? "");
  return text.length <= 280 ? text : `${text.slice(0, 277)}...`;
}

function isPlainArguments(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

import { createId, nowIso, tokenOverlapScore } from "./utils.js";
import { HookRegistry } from "./hook-registry.js";
import { sanitizeForAudit } from "./redact.js";
import { validateMcpServerSpec } from "./mcp-registry.js";
import { MODEL_PROVIDER_IDS, isModelProviderId } from "./model-router.js";
import { assertSafeBrowserUrlShape } from "./semantic-browser.js";
import {
  DEFAULT_PROJECT_ID,
  projectAllows,
  projectMemoryScope
} from "./project-store.js";
import { profileCapabilityBoundaryError } from "./capability-profile-store.js";
import {
  TOOL_SEARCH_BRIDGE_NAMES,
  ToolSearchController,
  isToolSearchDeferrable,
  registerToolSearchTools,
  toolSchemaBytes
} from "./tool-search.js";
import {
  ensureSemanticToolEnvelope,
  repeatedFailureEnvelope,
  safeToolErrorDetails,
  safeToolErrorMessage,
  semanticToolError,
  semanticToolResult,
  snapshotToolValue,
  toolFailureFingerprint
} from "./tool-outcome.js";
import {
  formatToolContractIssues,
  normalizeToolInputSchema,
  normalizeToolOutputSchema,
  validateToolContractValue
} from "./tool-contract.js";
import { createSkillCandidateFromRecipe } from "./skill-materialize.js";
import {
  assertSafeMemoryContent,
  backgroundMemoryProvenance,
  normalizeMemoryTags,
  prepareBackgroundMemoryProposal,
  sameBackgroundMemoryProposal
} from "./memory-intake-policy.js";
import { isProfileMemoryScope } from "./memory-system.js";

const PRE_TOOL_HOOKS_PASSED = Symbol("pre-tool-hooks-passed");
const INTERNAL_INVOCATION = Symbol("internal-invocation");
const EXACT_CATASTROPHIC_APPROVAL = Symbol("exact-catastrophic-approval");
const EXACT_MANUAL_APPROVAL = Symbol("exact-manual-approval");
const SEMANTIC_OUTCOME_TRACKED = Symbol("semantic-outcome-tracked");
const EXECUTION_RECEIPT_STATE = Symbol("execution-receipt-state");
const REGISTRY_FAILURE_STATE = new WeakMap();
const EXTERNAL_MEMORY_TIMEOUT_MS = 5000;
const EXTERNAL_MEMORY_MAX_TIMEOUT_MS = 30000;
const MAX_TURN_FAILURE_SCOPES = 256;
const TOOL_SEARCH_DISCOVERY_BRIDGES = new Set(["tool_search", "tool_describe"]);
const TOOL_SEARCH_BRIDGE_SET = new Set(TOOL_SEARCH_BRIDGE_NAMES);
const CAPABILITY_FIELDS = new Set([
  "domain",
  "verbs",
  "effect",
  "idempotent",
  "latency",
  "cost",
  "resources",
  "requirements",
  "examples",
  "successCriteria",
  "availability"
]);
const CAPABILITY_EFFECTS = new Set(["read", "write"]);
const CAPABILITY_LATENCIES = new Set(["instant", "low", "medium", "high", "unknown"]);
const CAPABILITY_COSTS = new Set(["none", "low", "medium", "high", "unknown"]);
const CAPABILITY_AVAILABILITIES = new Set(["available", "conditional", "unavailable", "unknown"]);
const CAPABILITY_MAX_EXAMPLES = 8;
const CAPABILITY_MAX_EXAMPLE_BYTES = 8192;
const KANBAN_DOMAIN_STATUSES = Object.freeze([
  "backlog",
  "in-progress",
  "blocked",
  "review",
  "done"
]);
const TASK_DOMAIN_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled"
]);
const GOAL_DOMAIN_STATUSES = Object.freeze([
  "active",
  "paused",
  "completed",
  "cancelled",
  "deferred",
  "cleared",
  "none"
]);
const DRAFT_DOMAIN_STATUSES = Object.freeze([
  "pending",
  "approved",
  "discarded",
  "sent"
]);

export class ToolRegistry {
  constructor(options = {}) {
    this.tools = new Map();
    // Hermes's "always" choice is intentionally bounded to one live session.
    // Keeping it in memory guarantees a daemon restart clears every allowance.
    this.sessionAllows = new Set();
    this.hooks = options.hooks ?? new HookRegistry({ loadConfig: false });
    this.toolSearchController = options.toolSearchController ?? null;
    this.projects = options.projects ?? null;
    this.profiles = options.profiles ?? null;
    this.timeline = options.timeline ?? null;
    this.startupBarrier = null;
    REGISTRY_FAILURE_STATE.set(this, {
      contextFailures: new WeakMap(),
      turnFailures: new Map(),
      activeOperations: new Map()
    });
  }

  register(tool) {
    if (!tool?.name) throw new Error("Tool requires a name.");
    if (typeof tool.handler !== "function") throw new Error(`Tool ${tool.name} requires a handler.`);
    const metadata = { ...(tool.metadata ?? {}) };
    const source = normalizedToolSource(tool.source);
    const needsConfirmation = Boolean(tool.needsConfirmation);
    const manualApproval = Boolean(tool.manualApproval);
    if (manualApproval && !needsConfirmation) {
      throw new TypeError(
        `Tool ${tool.name} manualApproval requires needsConfirmation.`
      );
    }
    const sideEffects = tool.sideEffects !== false;
    const forwardInvocation = typeof tool.forwardInvocation === "function"
      ? tool.forwardInvocation
      : typeof metadata.forwardInvocation === "function"
        ? metadata.forwardInvocation
        : null;
    const jobResources = typeof tool.jobResources === "function"
      ? tool.jobResources
      : null;
    const jobResourceRevision = jobResources
      ? String(tool.jobResourceRevision ?? "").trim()
      : null;
    if (
      jobResources
      && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(jobResourceRevision)
    ) {
      throw new TypeError(
        `Tool ${tool.name} with jobResources requires a stable jobResourceRevision.`
      );
    }
    delete metadata.forwardInvocation;
    const normalized = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: normalizeToolInputSchema(tool.parameters, tool.name),
      outputSchema: normalizeToolOutputSchema(tool.outputSchema, tool.name),
      source,
      handler: tool.handler,
      // Synchronous bridge unwrapping happens before activity, hooks, gates,
      // approvals, and checkpoints. It is intentionally omitted from list()
      // so executable functions never leak into model schema serialization.
      forwardInvocation,
      // Synchronous input validation that runs before observers, hooks,
      // summaries, or durable approval records can see the arguments.
      preflight: typeof tool.preflight === "function" ? tool.preflight : null,
      // Optional trusted resolver for the concrete resources a durable
      // mutating job can touch. This callback is internal-only and lets the
      // scheduler bind locks to actual operands instead of trusting
      // model-supplied lock labels.
      jobResources,
      jobResourceRevision,
      // When true, invoke() queues a pending action and suspends until the
      // user approves, denies, or the bounded approval window expires.
      needsConfirmation,
      // Manual approval is stronger than the ordinary confirmation rail:
      // auto-approve, caller-supplied __confirmed, and session-wide grants
      // cannot satisfy it. Only the private suspended-action resume token can.
      manualApproval,
      // Short human-readable summary used in the approval UI when the args
      // alone don't describe the action well. Optional fn(args) -> string.
      summarize: typeof tool.summarize === "function" ? tool.summarize : null,
      // Optional agent-loop semantics. These callbacks stay inside the
      // registry and are never serialized into provider tool definitions.
      normalizeOutcome: typeof tool.normalizeOutcome === "function"
        ? tool.normalizeOutcome
        : null,
      verifyOutcome: typeof tool.verifyOutcome === "function"
        ? tool.verifyOutcome
        : null,
      // Some tools expose a business-domain `status` field whose values can
      // overlap with semantic execution states (for example a blocked Kanban
      // card). Such values must be explicitly declared; undeclared
      // `status: "blocked"` remains a failed/blocked execution.
      domainResultStatuses: normalizeDomainResultStatuses(tool.domainResultStatuses),
      approvalRevision: createId("tool_revision"),
      // Whether invoking this tool changes state anywhere (memory, tasks,
      // cron, outbound messages, external services). Defaults to TRUE — a
      // tool must explicitly declare sideEffects: false to count as
      // read-only. Scrutiny verdicts gate on this: 'watch' turns allow only
      // read-only tools; 'ask' turns divert side-effecting calls to the
      // approval queue.
      sideEffects,
      metadata,
      capability: normalizeToolCapability(tool.capability, {
        toolName: tool.name,
        source,
        sideEffects,
        needsConfirmation
      })
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  bindPendingActions(pendingActions) {
    this.pendingActions = pendingActions;
  }

  bindCheckpoints(checkpoints) {
    this.checkpoints = checkpoints;
  }

  bindHooks(hooks) {
    this.hooks = hooks ?? new HookRegistry({ loadConfig: false });
  }

  bindToolSearch(controller) {
    this.toolSearchController = controller ?? null;
  }

  bindProjects(projects) {
    this.projects = projects ?? null;
  }

  bindProfiles(profiles) {
    this.profiles = profiles ?? null;
  }

  bindTimeline(timeline) {
    this.timeline = timeline ?? null;
  }

  bindStartupBarrier(barrier) {
    this.startupBarrier = barrier ? Promise.resolve(barrier) : null;
  }

  bindJobCoordinator(coordinator) {
    this.jobCoordinator = coordinator ?? null;
  }

  approvalIdentity(name, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) return null;
    const projectId = String(context?.__projectId ?? "").trim() || null;
    let currentProject = null;
    if (projectId && (
      typeof this.projects?.authorize === "function"
      || typeof this.projects?.get === "function"
    )) {
      try {
        currentProject = typeof this.projects.authorize === "function"
          ? this.projects.authorize(projectId, { includeArchived: true })
          : this.projects.get(projectId, { includeArchived: true });
      } catch {
        currentProject = null;
      }
    }
    let currentProfile = null;
    if (
      currentProject
      && typeof this.profiles?.resolve === "function"
    ) {
      try {
        currentProfile = this.profiles.resolve(
          currentProject.id,
          context?.sessionId ?? null
        );
      } catch {
        currentProfile = {
          active: true,
          locked: true,
          identity: "unavailable"
        };
      }
    }
    return toolFailureFingerprint("tool_approval", {
      name: tool.name,
      source: tool.source,
      parameters: tool.parameters,
      sideEffects: tool.sideEffects,
      needsConfirmation: tool.needsConfirmation,
      manualApproval: tool.manualApproval,
      capability: tool.capability,
      approvalRevision: tool.approvalRevision,
      policy: {
        scrutiny: context?.__scrutinyPolicy ?? null,
        allowedTools: Array.isArray(context?.__allowedTools)
          ? [...context.__allowedTools].map(String).sort()
          : null,
        projectId,
        projectStatus: currentProject?.status
          ?? (projectId && this.projects ? "missing" : null),
        projectRevision: currentProject?.revision
          ?? context?.__projectRevision
          ?? null,
        projectWorkspace: currentProject?.workspaceRoot
          ?? context?.__projectWorkspaceDir
          ?? null,
        projectKanbanBoard: currentProject?.kanbanBoardId
          ?? context?.__projectKanbanBoardId
          ?? null,
        projectMcpGrants: sortedProjectGrants(
          currentProject?.mcpGrants ?? context?.__projectMcpGrants
        ),
        projectActiveSkills: sortedProjectGrants(
          currentProject?.activeSkills ?? context?.__projectActiveSkills
        ),
        projectSecretRefs: sortedProjectGrants(
          currentProject?.secretRefs ?? context?.__projectSecretRefs
        ),
        projectHookIds: sortedProjectGrants(
          currentProject?.hookIds ?? context?.__projectHookIds
        ),
        capabilityProfileActive: currentProfile?.active ?? false,
        capabilityProfileLocked: currentProfile?.locked ?? false,
        capabilityProfileIdentity: currentProfile?.identity ?? null
      }
    });
  }

  allowForSession(sessionId, toolName) {
    if (!sessionId || !toolName) return false;
    this.sessionAllows.add(sessionAllowKey(sessionId, toolName));
    return true;
  }

  isAllowedForSession(sessionId, toolName) {
    return Boolean(sessionId && toolName && this.sessionAllows.has(sessionAllowKey(sessionId, toolName)));
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  list({ readOnly = false } = {}) {
    const all = [...this.tools.values()].map(publicToolDescriptor);
    return readOnly ? all.filter((tool) => !tool.sideEffects) : all;
  }

  // Tools advertised to the model, bounded so the array doesn't blow past the
  // provider's limit. A handful of large MCP servers (e.g. PostHog ~118 tools)
  // can push the total past ~250, which makes the OpenAI Responses API reject
  // EVERY call with a server_error. Core/internal tools are always advertised;
    // MCP tools fill the remaining budget at per-tool granularity, rotating
    // across servers so one giant integration cannot crowd out every peer. Anything not
  // advertised is STILL invokable via run_mcp_tool + discoverable via
  // list_mcp_tools — no capability is lost, just the direct function affordance.
  modelToolPlan(options = {}) {
    const projectContext = authorizeToolPlanContext(
      this.projects,
      this.profiles,
      options.context ?? {}
    );
    const listed = this.list({ readOnly: options.readOnly === true })
      // Internal replay handlers are callable only by a trusted runtime path
      // (for example, a durable approval action). They are not model tools,
      // so an agent cannot turn an auto-approved ordinary call into a bypass.
      .filter((tool) => tool.metadata?.internal !== true)
      .filter((tool) => !projectToolBoundaryError(tool, projectContext))
      .filter((tool) => !profileCapabilityBoundaryError(
        tool,
        projectContext.__capabilityProfileResolution
      ));
    const only = Array.isArray(options.only) ? new Set(options.only.map(String)) : null;
    const narrowed = only
      ? listed.filter((tool) => only.has(tool.name))
      : listed;
    const searchPlan = this.toolSearchController?.planModelTools
      ? this.toolSearchController.planModelTools(listed, {
          ...options,
          context: options.context ?? {}
        })
      : {
          active: false,
          mode: "off",
          schemaBytes: 0,
          eligibleSchemaBytes: toolSchemaBytes(narrowed),
          deferredNames: [],
          eligibleNames: narrowed.map((tool) => tool.name),
          tools: narrowed
        };
    const max = modelToolCap();
    const bridgeTools = TOOL_SEARCH_BRIDGE_NAMES
      .map((name) => listed.find((tool) => tool.name === name))
      .filter(Boolean);
    const plannedDirect = searchPlan.tools.filter((tool) => (
      !TOOL_SEARCH_BRIDGE_SET.has(tool.name)
    ));
    const omittedNames = new Set(searchPlan.deferredNames ?? []);
    let selectedDirect = plannedDirect;
    let capOmitted = [];
    let radarActive = Boolean(searchPlan.active);
    const wouldOverflow = plannedDirect.length
      + (radarActive ? TOOL_SEARCH_BRIDGE_NAMES.length : 0) > max;

    if (wouldOverflow) {
      if (this.toolSearchController && bridgeTools.length === TOOL_SEARCH_BRIDGE_NAMES.length) {
        radarActive = true;
        if (max < TOOL_SEARCH_BRIDGE_NAMES.length) {
          throw new Error(
            `OPENAGI_MAX_MODEL_TOOLS must be at least ${TOOL_SEARCH_BRIDGE_NAMES.length} when tool radar is required.`
          );
        }
        selectedDirect = selectCappedModelTools(
          plannedDirect,
          max - TOOL_SEARCH_BRIDGE_NAMES.length
        );
      } else {
        selectedDirect = selectCappedModelTools(plannedDirect, max);
      }
      const selectedNames = new Set(selectedDirect.map((tool) => tool.name));
      capOmitted = plannedDirect.filter((tool) => !selectedNames.has(tool.name));
      for (const tool of capOmitted) omittedNames.add(tool.name);
    }

    if (radarActive && bridgeTools.length !== TOOL_SEARCH_BRIDGE_NAMES.length) {
      throw new Error("Tool radar cannot omit tools unless all three discovery bridges are registered.");
    }
    const tools = radarActive
      ? [...selectedDirect, ...bridgeTools]
      : selectedDirect;
    if (tools.length > max) {
      throw new Error(`Model tool plan exceeds configured cap ${max}.`);
    }

    const capOmittedNames = new Set(capOmitted.map((tool) => tool.name));
    const deferredCount = [...omittedNames]
      .filter((name) => !capOmittedNames.has(name))
      .length;
    const omitted = [...omittedNames];
    const notice = omitted.length > 0
      ? radarActive
        ? `Tool radar: ${omitted.length} eligible tools are omitted from direct schemas (${deferredCount} deferred, ${capOmitted.length} capped). Use tool_search, then tool_describe and tool_call.`
        : legacyToolCapNotice(plannedDirect, selectedDirect)
      : null;

    return Object.freeze({
      active: radarActive,
      mode: searchPlan.mode,
      max,
      tools: Object.freeze(tools),
      advertisedNames: Object.freeze(tools.map((tool) => tool.name)),
      omittedNames: Object.freeze(omitted),
      deferredNames: Object.freeze([...(searchPlan.deferredNames ?? [])]),
      capOmittedNames: Object.freeze(capOmitted.map((tool) => tool.name)),
      schemaBytes: toolSchemaBytes(tools),
      eligibleSchemaBytes: searchPlan.eligibleSchemaBytes ?? toolSchemaBytes(narrowed),
      omittedSchemaBytes: toolSchemaBytes(
        listed.filter((tool) => omittedNames.has(tool.name))
      ),
      notice
    });
  }

  modelToolOverflowNotice(options = {}) {
    return this.modelToolPlan(options).notice;
  }

  // Surface what got capped (once per distinct overflow set) — never silently
  // drop tools, per the "no silent caps" rule.
  toOpenAIToolPlan(options = {}) {
    const plan = this.modelToolPlan(options);
    return Object.freeze({
      ...plan,
      tools: Object.freeze(plan.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })))
    });
  }

  toAnthropicToolPlan(options = {}) {
    const plan = this.modelToolPlan(options);
    return Object.freeze({
      ...plan,
      tools: Object.freeze(plan.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      })))
    });
  }

  toOpenAITools(options = {}) {
    return this.toOpenAIToolPlan(options).tools;
  }

  toAnthropicTools(options = {}) {
    return this.toAnthropicToolPlan(options).tools;
  }

  // Public entry: wraps the gated invocation with per-tool lifecycle
  // notifications so channels (Discord live status) can render what the
  // agent is doing in real time. context.__onToolEvent is advisory and
  // best-effort — a throwing observer must never break a tool call.
  async invoke(name, args, context = {}, internalToken = null) {
    const internal = normalizeInternalInvocation(internalToken);
    const receiptState = internal.failureTracking?.receiptState
      ?? createExecutionReceiptState(name);
    context = {
      ...(context ?? {}),
      [EXECUTION_RECEIPT_STATE]: receiptState
    };
    const tool = this.tools.get(name);
    try {
      const safeArgs = snapshotToolValue(args ?? {});
      if (!safeArgs || typeof safeArgs !== "object" || Array.isArray(safeArgs)) {
        throw new TypeError("Tool arguments must be a plain JSON object.");
      }
      args = deepFreeze(safeArgs);
    } catch (error) {
      return this._finalizeInvocation(tool, name, null, context, {
        ok: false,
        blocked: tool?.sideEffects !== false,
        code: "invalid_tool_arguments",
        error: safeToolErrorMessage(error, "Tool arguments are not safe JSON.")
      });
    }
    if (tool) {
      const inputValidation = validateToolContractValue(tool.parameters, args);
      if (!inputValidation.ok) {
        return this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          blocked: tool.sideEffects !== false,
          code: "invalid_tool_arguments",
          error: `Tool ${name} arguments do not match its declared schema: ${formatToolContractIssues(inputValidation)}.`
        });
      }
    }
    const projectScope = validateProjectScope(
      this.projects,
      context,
      this.profiles
    );
    if (projectScope.error) {
      return this._finalizeInvocation(tool, name, args, context, {
        ok: false,
        blocked: true,
        code: "project_scope_invalid",
        error: projectScope.error
      });
    }
    context = authorizedProjectContext(context, projectScope.project);
    const profileScope = authorizeProfileContext(
      this.profiles,
      context,
      projectScope.project
    );
    if (profileScope.error) {
      return this._finalizeInvocation(tool, name, args, context, {
        ok: false,
        blocked: true,
        code: "capability_profile_invalid",
        error: profileScope.error
      });
    }
    context = profileScope.context;
    const forwardInvocation = tool?.forwardInvocation;
    if (typeof forwardInvocation === "function") {
      let forwarded;
      try {
        forwarded = forwardInvocation(args ?? {}, context);
        if (forwarded && typeof forwarded.then === "function") {
          throw new TypeError(`Tool ${name} forwarding must be synchronous.`);
        }
      } catch (error) {
        return this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          code: "forwarding_error",
          error: safeToolErrorMessage(error, `Tool ${name} forwarding failed.`)
        });
      }
      if (forwarded?.error) {
        return this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          code: "forwarding_error",
          error: String(forwarded.error)
        });
      }
      const targetName = String(forwarded?.name ?? "").trim();
      const targetArgs = forwarded?.args;
      const target = this.tools.get(targetName);
      const reachableThroughRadar = this.toolSearchController?.isReachableTarget
        ? this.toolSearchController.isReachableTarget(targetName, { context })
        : isToolSearchDeferrable(target);
      if (
        !targetName
        || targetName === name
        || !target
        || typeof target.forwardInvocation === "function"
        || !reachableThroughRadar
      ) {
        return this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          code: "forward_target_unavailable",
          error: `Tool ${targetName || "(missing)"} is not available through tool_call.`
        });
      }
      if (!targetArgs || typeof targetArgs !== "object" || Array.isArray(targetArgs)) {
        return this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          code: "invalid_tool_arguments",
          error: "tool_call arguments must resolve to an object."
        });
      }
      // Unwrap before the bridge emits activity or crosses any policy rail.
      // The real tool name now traverses scope, scrutiny, hooks, approvals,
      // checkpoints, dispatch, post hooks, and activity exactly once. Reset
      // the internal hook token so a bridge can never smuggle a prior pass.
      return this.invoke(targetName, targetArgs, context, null);
    }
    const inheritedTracking = internal.failureTracking;
    const tracking = inheritedTracking
      ?? this._beginFailureTracking(name, args, context, tool);
    if (tracking?.reserved && !tracking.receiptState) {
      receiptState.id = tracking.operationReceipt;
      tracking.receiptState = receiptState;
    }
    const ownsTracking = !inheritedTracking && tracking?.reserved === true;
    if (tracking?.blocked) {
      return this._finalizeInvocation(
        tool,
        name,
        args,
        context,
        tracking.blocked,
        { tracking: null, markTracked: true }
      );
    }
    if (tool?.preflight) {
      try {
        const result = tool.preflight(args ?? {}, context);
        if (result && typeof result.then === "function") {
          throw new TypeError(`Tool ${name} preflight must be synchronous.`);
        }
      } catch (error) {
        const outcome = await this._finalizeInvocation(tool, name, args, context, {
          ok: false,
          code: "preflight_error",
          error: safeToolErrorMessage(error, `Tool ${name} preflight failed.`)
        }, { tracking, markTracked: true });
        if (ownsTracking) this._releaseFailureTracking(tracking);
        return outcome;
      }
    }
    const operationContext = tracking?.operationReceipt
      ? {
          ...(context ?? {}),
          __operationReceipt: tracking.operationReceipt
        }
      : context;
    const notify = typeof operationContext?.__onToolEvent === "function"
      ? operationContext.__onToolEvent
      : null;
    if (notify) {
      try {
        notify({
          phase: "start",
          name,
          args: privateToolEventArgs(tool, args)
        });
      } catch { /* observer must not break tools */ }
    }
    let outcome;
    try {
      const rawOutcome = await this._invokeGated(
        name,
        args,
        operationContext,
        {
          preToolHooksPassed: internal.preToolHooksPassed,
          failureTracking: tracking,
          manualApprovalPassed: internal.manualApprovalPassed,
          catastrophicApprovalPassed: internal.catastrophicApprovalPassed
        }
      );
      outcome = await this._finalizeInvocation(
        tool,
        name,
        args,
        operationContext,
        rawOutcome,
        {
          tracking: ownsTracking ? tracking : null,
          markTracked: ownsTracking
        }
      );
    } finally {
      if (ownsTracking) this._releaseFailureTracking(tracking);
    }
    if (notify) {
      try {
        notify({
          phase: "end",
          name,
          ok: outcome.ok,
          error: outcome.ok ? null : (outcome.error ?? null),
          pending: Boolean(outcome.outcome?.status === "pending"),
          receipt: outcome.receipt ?? null,
          outcome: outcome.outcome
            ? {
                status: outcome.outcome.status,
                code: outcome.outcome.code,
                changed: outcome.outcome.changed,
                artifacts: outcome.outcome.artifacts,
                evidence: outcome.outcome.evidence,
                verification: outcome.outcome.verification?.status ?? null
              }
            : null
        });
      } catch { /* observer must not break tools */ }
    }
    return outcome;
  }

  async _finalizeInvocation(
    tool,
    name,
    args,
    context,
    value,
    { tracking = null, markTracked = true } = {}
  ) {
    if (value?.[SEMANTIC_OUTCOME_TRACKED]) return value;
    let semantic = await ensureSemanticToolEnvelope(
      tool,
      value,
      args,
      context,
      classifyLegacyToolFailure(value)
    );
    semantic = attachExecutionReceipt(
      semantic,
      name,
      context?.[EXECUTION_RECEIPT_STATE]
    );
    if (tracking?.reserved) {
      this._recordFailureOutcome(tracking, semantic);
    }
    try {
      if (!markTracked) return semantic;
      Object.defineProperty(semantic, SEMANTIC_OUTCOME_TRACKED, {
        value: true,
        enumerable: false
      });
    } catch {
      // A custom frozen envelope still remains safe; it may only lose the
      // nested-invocation duplicate-accounting optimization.
    }
    return semantic;
  }

  _failureScope(context) {
    const state = REGISTRY_FAILURE_STATE.get(this);
    if (!state) return null;
    const turnId = String(context?.__turnId ?? context?.turnId ?? "").trim();
    if (turnId) {
      const key = failureTurnKey(context?.sessionId, turnId);
      let scope = state.turnFailures.get(key);
      if (!scope) {
        scope = createFailureScope({ turnKey: key });
        state.turnFailures.set(key, scope);
        this._evictSettledFailureScopes(state);
      } else {
        state.turnFailures.delete(key);
        state.turnFailures.set(key, scope);
      }
      return scope;
    }
    if (!context || typeof context !== "object") return null;
    let scope = state.contextFailures.get(context);
    if (!scope) {
      scope = createFailureScope({ context });
      state.contextFailures.set(context, scope);
    }
    return scope;
  }

  _failureFingerprint(name, args, tool) {
    try {
      return toolFailureFingerprint(name, args);
    } catch (error) {
      if (tool?.sideEffects !== false) {
        throw new TypeError(
          `Tool ${name} arguments cannot be safely fingerprinted: ${safeToolErrorMessage(error, "invalid arguments")}`
        );
      }
      return null;
    }
  }

  _beginFailureTracking(name, args, context, tool) {
    let fingerprint;
    try {
      fingerprint = this._failureFingerprint(name, args, tool);
    } catch (error) {
      return {
        blocked: semanticToolError(tool, error, {
          code: "arguments_not_fingerprintable",
          status: "blocked",
          nextSteps: ["Send a bounded plain JSON object as the tool arguments."]
        })
      };
    }
    const state = REGISTRY_FAILURE_STATE.get(this);
    const activeKey = fingerprint && tool?.sideEffects !== false
      ? failureActiveKey(context, fingerprint)
      : null;
    if (activeKey && state?.activeOperations.has(activeKey)) {
      return {
        blocked: semanticToolError(tool, "An identical side-effecting tool call is already running.", {
          code: "duplicate_in_flight",
          status: "blocked",
          nextSteps: ["Wait for the active operation receipt to settle before retrying."]
        })
      };
    }
    const scope = fingerprint ? this._failureScope(context) : null;
    const prior = scope?.entries.get(fingerprint);
    if (!scope || !fingerprint) return null;
    if (scope.retired && !prior?.inFlight) {
      return {
        blocked: semanticToolError(tool, "This tool-call scope has already ended.", {
          code: "turn_scope_closed",
          status: "blocked",
          nextSteps: ["Start a new turn before attempting another tool call."]
        })
      };
    }
    if (prior?.inFlight) {
      return {
        blocked: semanticToolError(tool, "An identical tool call is already running in this turn.", {
          code: "duplicate_in_flight",
          status: "blocked",
          nextSteps: ["Wait for the active call or change the arguments."]
        })
      };
    }
    const resumingPending = prior?.envelope?.outcome?.status === "pending"
      && context?.__confirmed === true;
    if (prior?.envelope?.outcome?.status === "pending" && !resumingPending) {
      return {
        blocked: semanticToolError(tool, "An identical tool call is already pending.", {
          code: "duplicate_pending",
          status: "blocked",
          nextSteps: ["Wait for the pending action to complete before retrying."]
        })
      };
    }
    const allowedAttempts = prior?.envelope?.outcome?.retryable === true ? 2 : 1;
    if (prior && prior.attempts >= allowedAttempts && !resumingPending) {
      return {
        blocked: repeatedFailureEnvelope(prior.envelope, prior.attempts + 1)
      };
    }
    scope.entries.set(fingerprint, {
      attempts: prior?.attempts ?? 0,
      envelope: prior?.envelope ?? null,
      inFlight: true
    });
    const tracking = {
      scope,
      fingerprint,
      reserved: true,
      operationReceipt: createOperationReceipt(scope, fingerprint),
      activeKey
    };
    if (activeKey) state.activeOperations.set(activeKey, tracking);
    return tracking;
  }

  _recordFailureOutcome(tracking, envelope) {
    const { scope, fingerprint } = tracking;
    if (envelope?.ok === true && envelope?.outcome?.status !== "pending") {
      scope.entries.delete(fingerprint);
      return;
    }
    const previous = scope.entries.get(fingerprint);
    scope.entries.set(fingerprint, {
      attempts: (previous?.attempts ?? 0) + 1,
      envelope: failureTrackerEnvelope(envelope),
      inFlight: false
    });
  }

  _releaseFailureTracking(tracking) {
    if (!tracking?.reserved) return;
    const state = REGISTRY_FAILURE_STATE.get(this);
    if (
      tracking.activeKey
      && state?.activeOperations.get(tracking.activeKey) === tracking
    ) {
      state.activeOperations.delete(tracking.activeKey);
    }
    const current = tracking.scope.entries.get(tracking.fingerprint);
    if (!current?.inFlight) {
      if (tracking.scope.retired && !scopeHasInFlight(tracking.scope)) {
        this._deleteFailureScope(tracking.scope);
      }
      return;
    }
    if ((current.attempts ?? 0) === 0 && !current.envelope) {
      tracking.scope.entries.delete(tracking.fingerprint);
    } else {
      tracking.scope.entries.set(tracking.fingerprint, {
        ...current,
        inFlight: false
      });
    }
    if (tracking.scope.retired && !scopeHasInFlight(tracking.scope)) {
      this._deleteFailureScope(tracking.scope);
    }
  }

  clearFailureScope(context = {}) {
    const state = REGISTRY_FAILURE_STATE.get(this);
    if (!state) return false;
    const turnId = String(context?.__turnId ?? context?.turnId ?? "").trim();
    const scopes = new Set();
    if (turnId) {
      const key = failureTurnKey(context?.sessionId, turnId);
      const scope = state.turnFailures.get(key);
      if (scope) scopes.add(scope);
    }
    if (context && typeof context === "object") {
      const scope = state.contextFailures.get(context);
      if (scope) scopes.add(scope);
    }
    for (const scope of scopes) {
      scope.retired = true;
      if (!scopeHasInFlight(scope)) this._deleteFailureScope(scope);
    }
    return scopes.size > 0;
  }

  _deleteFailureScope(scope) {
    const state = REGISTRY_FAILURE_STATE.get(this);
    if (!state || !scope) return false;
    let deleted = false;
    if (scope.turnKey) {
      deleted = state.turnFailures.get(scope.turnKey) === scope
        ? state.turnFailures.delete(scope.turnKey)
        : false;
    }
    if (scope.context && state.contextFailures.get(scope.context) === scope) {
      deleted = state.contextFailures.delete(scope.context) || deleted;
    }
    return deleted;
  }

  _evictSettledFailureScopes(state) {
    if (state.turnFailures.size <= MAX_TURN_FAILURE_SCOPES) return;
    for (const [key, scope] of state.turnFailures) {
      if (state.turnFailures.size <= MAX_TURN_FAILURE_SCOPES) break;
      if (scopeHasInFlight(scope)) continue;
      state.turnFailures.delete(key);
    }
  }

  async _suspendForApproval(
    action,
    name,
    args,
    context,
    { preToolHooksPassed = false, failureTracking = null } = {}
  ) {
    const tool = this.tools.get(name);
    // Lightweight store doubles used by embedders may only implement the old
    // queue API. Preserve that contract while the real store provides the
    // Hermes-style suspend/resume rail.
    if (typeof this.pendingActions?.waitForDecision !== "function") {
      return {
        ok: true,
        result: {
          status: "awaiting_confirmation",
          actionId: action.id,
          summary: action.summary,
          message: "Queued for human approval."
        }
      };
    }

    try {
      context?.__onToolEvent?.({
        phase: "awaiting-approval",
        actionId: action.id,
        toolName: name,
        summary: action.summary
      });
    } catch {
      // Approval progress is advisory; the durable queue is authoritative.
    }

    const configured = Number(process.env.OPENAGI_APPROVAL_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 300000;
    const decision = await this.pendingActions.waitForDecision(action.id, {
      timeoutMs,
      signal: context?.__abortSignal
    });
    if (decision.decision === "approve") {
      // A legacy approval surface may already have executed before deciding.
      // Honor its recorded completion rather than replaying the side effect.
      if (decision.completed) {
        return decision.error
          ? {
              ok: false,
              error: decision.error,
              ...(decision.outcome ? { outcome: decision.outcome } : {}),
              ...(decision.receipt ? { receipt: decision.receipt } : {})
            }
          : {
              ok: true,
              result: decision.result,
              ...(decision.outcome ? { outcome: decision.outcome } : {}),
              ...(decision.receipt ? { receipt: decision.receipt } : {})
            };
      }
      if (
        action.approvalIdentity
        && action.approvalIdentity !== this.approvalIdentity(name, context)
      ) {
        const blocked = semanticToolError(
          tool,
          "The tool or approval policy changed while this action was pending.",
          {
            code: "approval_identity_changed",
            status: "blocked",
            nextSteps: ["Create a new approval request under the current runtime."]
          }
        );
        this.pendingActions.complete?.(action.id, {
          result: null,
          error: blocked.error,
          outcome: blocked.outcome
        });
        return blocked;
      }
      if (context?.__abortSignal?.aborted) {
        const error = "turn ended before the approved action could resume";
        this.pendingActions.complete?.(action.id, { result: null, error });
        return { ok: false, error };
      }
      const decisionActor = String(
        decision.decider ?? decision.decidedBy ?? ""
      ).trim();
      if (
        tool?.manualApproval === true
        && (!decisionActor || decisionActor === "auto-approve")
      ) {
        const blocked = semanticToolError(
          tool,
          "This action requires an explicit human approval; auto-approve is insufficient.",
          {
            code: "manual_approval_required",
            status: "blocked",
            nextSteps: ["Create a new approval request and have a human approve it."]
          }
        );
        this.pendingActions.complete?.(action.id, {
          result: null,
          error: blocked.error,
          outcome: blocked.outcome
        });
        return blocked;
      }
      const invokeResult = await this.invoke(
        name,
        args,
        {
          ...(context ?? {}),
          __confirmed: true,
          // Bind replay-only handlers to the exact durable action that a
          // human approved. Model arguments cannot create this context field.
          __pendingActionId: action.id,
          __approval: {
            description: action.reason ?? "flagged as dangerous",
            via: decision.approvedVia ?? "pending-action",
            decider: decision.decider ?? decision.decidedBy ?? "user"
          }
        },
        makeInternalInvocation({
          preToolHooksPassed,
          failureTracking,
          manualApprovalPassed: tool?.manualApproval === true,
          catastrophicApprovalPassed: action.severity === "catastrophic"
        })
      );
      this.pendingActions.complete?.(action.id, {
        result: invokeResult.ok ? invokeResult.result : null,
        error: invokeResult.ok ? null : invokeResult.error,
        outcome: invokeResult.outcome ?? null,
        receipt: invokeResult.receipt ?? null
      });
      return invokeResult;
    }
    if (decision.decision === "timeout") {
      this.pendingActions.decide?.(action.id, {
        decision: "deny",
        decidedBy: "timeout",
        error: "approval timed out"
      });
      return {
        ok: false,
        error: `Action ${action.id} timed out awaiting approval after ${Math.round(timeoutMs / 1000)}s.`
      };
    }
    if (decision.decision === "cancelled") {
      this.pendingActions.decide?.(action.id, {
        decision: "deny",
        decidedBy: "turn-cancelled",
        error: "turn ended while awaiting approval"
      });
      return { ok: false, error: `Action ${action.id} cancelled because the turn ended while awaiting approval.` };
    }
    return {
      ok: false,
      error: `Action ${action.id} denied by ${decision.decidedBy ?? "human"}${decision.error ? `: ${decision.error}` : "."}`
    };
  }

  async _invokeGated(
    name,
    args,
    context = {},
    {
      preToolHooksPassed = false,
      failureTracking = null,
      manualApprovalPassed = false,
      catastrophicApprovalPassed = false
    } = {}
  ) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    if (tool.sideEffects && this.startupBarrier) {
      try {
        await this.startupBarrier;
      } catch {
        return semanticToolError(
          tool,
          "Runtime startup ownership reconciliation did not complete; mutating tools remain blocked.",
          {
            code: "runtime_startup_unreconciled",
            status: "blocked",
            changed: false
          }
        );
      }
    }
    const projectScope = validateProjectScope(
      this.projects,
      context,
      this.profiles
    );
    if (projectScope.error) {
      return {
        ok: false,
        blocked: true,
        code: "project_scope_invalid",
        error: projectScope.error
      };
    }
    context = authorizedProjectContext(context, projectScope.project);
    const profileScope = authorizeProfileContext(
      this.profiles,
      context,
      projectScope.project
    );
    if (profileScope.error) {
      return {
        ok: false,
        blocked: true,
        code: "capability_profile_invalid",
        error: profileScope.error
      };
    }
    context = profileScope.context;
    const freshProfileBoundaryError = profileCapabilityBoundaryError(
      tool,
      context?.__capabilityProfileResolution
    );
    if (freshProfileBoundaryError) {
      return {
        ok: false,
        blocked: true,
        code: "capability_profile_denied",
        error: freshProfileBoundaryError
      };
    }
    // Specialist bounds: a propagated specialist may only call tools inside
    // its allowlist (its scoped MCP tools + the core set agent-host grants).
    // Same advisory-list / enforced-gate split as the scrutiny policies.
    if (
      Array.isArray(context?.__allowedTools)
      && !context.__allowedTools.includes(name)
      && !(
        TOOL_SEARCH_DISCOVERY_BRIDGES.has(name)
        && tool.metadata?.toolSearch === "core"
      )
    ) {
      return {
        ok: false,
        error: `Tool ${name} is outside this specialist's bounded scope. Recommend the user take this to the main agent.`
      };
    }
    const projectBoundaryError = projectToolBoundaryError(tool, context);
    if (projectBoundaryError) {
      return {
        ok: false,
        blocked: true,
        code: "project_capability_denied",
        error: projectBoundaryError
      };
    }
    // Scrutiny 'none' policy (ignore verdict): hard-block EVERY tool. An empty
    // advertised tool list is NOT enough — OpenAI/Anthropic providers treat an
    // empty `tools` array as "fall back to the full registry", and the
    // deterministic provider calls invoke() directly. This gate is the actual
    // guarantee that an ignored turn runs no tools.
    if (context?.__scrutinyPolicy === "none") {
      return {
        ok: false,
        error: `Tool ${name} is blocked this turn: scrutiny verdict 'ignore' permits no tools.`
      };
    }
    // Scrutiny 'watch' policy: read-only turns hard-block side-effecting
    // tools (defense in depth — the filtered tool list is advisory to the
    // model, this gate is not).
    if (context?.__scrutinyPolicy === "read-only" && tool.sideEffects) {
      return {
        ok: false,
        error: `Tool ${name} is blocked this turn: scrutiny verdict 'watch' permits read-only tools only.`
      };
    }
    const sessionAllowed = this.isAllowedForSession(context?.sessionId, name);
    if (!preToolHooksPassed) {
      let hookDecision = { action: "allow" };
      try {
        hookDecision = await this.hooks?.beforeToolCall?.(
          buildHookPayload({
            name,
            args,
            context,
            tool,
            sessionAllowed,
            catastrophicApprovalPassed
          })
        ) ?? hookDecision;
      } catch (error) {
        const detail = safeToolErrorMessage(error, "hook callback failed");
        if (tool.sideEffects !== false) {
          console.warn(`[hooks] pre_tool_call registry failed closed: ${detail}`);
          hookDecision = {
            action: "block",
            message: "Built-in security policy was unavailable; mutating tool execution was blocked.",
            blockedBy: "builtin-security-hooks",
            failure: "registry_error"
          };
        } else {
          console.warn(`[hooks] pre_tool_call registry failed open for read-only tool: ${detail}`);
        }
      }
      if (hookDecision?.action === "block") {
        if (isTrustedCatastrophicBlock(hookDecision)) {
          const reason = hookDecision.reason ?? hookDecision.message ?? "catastrophic policy veto";
          if (!this.pendingActions) {
            return {
              ok: false,
              blocked: true,
              code: "catastrophic_approval_required",
              error: `Catastrophic tool call requires human approval: ${reason}`
            };
          }
          const baseSummary = tool.summarize ? safeSummarize(tool.summarize, args) : `Run ${name}`;
          const summary = `${baseSummary ?? `Run ${name}`} [CATASTROPHIC: ${reason}]`;
          const action = this.pendingActions.enqueue({
            toolName: name,
            args,
            context,
            summary,
            reason,
            severity: "catastrophic",
            approvalIdentity: this.approvalIdentity(name, context),
            privateInput: tool.metadata?.privateInput === true
          });
          return this._suspendForApproval(action, name, args, context, {
            preToolHooksPassed: false,
            failureTracking
          });
        }
        const unavailable = hookDecision.failure === "registry_error";
        const code = unavailable ? "security_hook_unavailable" : "hook_blocked";
        const error = hookDecision.message ?? `Tool ${name} was blocked by a pre_tool_call hook.`;
        const blocked = await ensureSemanticToolEnvelope(tool, {
          ok: false,
          error,
          blocked: true,
          code
        }, args, context, {
          code,
          status: "blocked"
        });
        this._notifyPostToolCall({ name, args, context, tool, sessionAllowed }, {
          ...blocked,
          blocked: true,
          dispatched: false,
          blockedBy: hookDecision.blockedBy ?? null
        });
        return blocked;
      }
      preToolHooksPassed = true;
    }

    // Confirmation gate. When set, divert the call into the pending-action
    // queue UNLESS context.__confirmed is true (which the approve endpoint
    // sets after a human OKs the action). Scrutiny 'ask' turns extend this
    // to EVERY side-effecting tool, not just the always-gated ones.
    const scrutinyConfirm = context?.__scrutinyPolicy === "confirm" && tool.sideEffects;
    const manualConfirm = tool.manualApproval === true && !manualApprovalPassed;
    const ordinaryConfirm = (
      (tool.needsConfirmation || scrutinyConfirm)
      && !context?.__confirmed
      && !sessionAllowed
    );
    if (manualConfirm && !this.pendingActions) {
      return semanticToolError(
        tool,
        "This tool requires an explicit human approval, but no approval store is available.",
        {
          code: "manual_approval_unavailable",
          status: "blocked",
          changed: false
        }
      );
    }
    if ((manualConfirm || ordinaryConfirm) && this.pendingActions) {
      const summary = tool.summarize ? safeSummarize(tool.summarize, args) : `Run ${name}`;
      // Auto-approve mode (Story: hands-free operation). When enabled the
      // gate still records the action for the audit trail, but runs the
      // handler immediately instead of parking it in the queue. Toggle via
      // POST /auto-approve, /autoapprove Discord command, or
      // OPENAGI_AUTO_APPROVE in .env. Default is ON — only an explicit
      // "0"/"false" disables it.
      if (autoApproveEnabled() && !manualConfirm) {
        const action = this.pendingActions.enqueue({
          toolName: name,
          args,
          context,
          summary,
          reason: context.__reason ?? null,
          approvalIdentity: this.approvalIdentity(name, context),
          privateInput: tool.metadata?.privateInput === true
        });
        const invokeResult = await this.invoke(
          name,
          args,
          { ...(context ?? {}), __confirmed: true },
          makeInternalInvocation({
            preToolHooksPassed: true,
            failureTracking
          })
        );
        this.pendingActions.decide?.(action.id, {
          decision: "approve",
          decidedBy: "auto-approve",
          result: invokeResult.ok ? invokeResult.result : null,
          error: invokeResult.ok ? null : invokeResult.error,
          outcome: invokeResult.outcome ?? null,
          receipt: invokeResult.receipt ?? null
        });
        return invokeResult;
      }
      const action = this.pendingActions.enqueue({
        toolName: name,
        args,
        context,
        summary,
        reason: context.__reason ?? null,
        approvalIdentity: this.approvalIdentity(name, context),
        privateInput: tool.metadata?.privateInput === true
      });
      return this._suspendForApproval(action, name, args, context, {
        preToolHooksPassed,
        failureTracking
      });
    }
    const startedAt = Date.now();
    let dispatched = false;
    let checkpointCapture = null;
    let releaseJobLease = null;
    try {
      const dispatchAuthority = refreshToolInvocationAuthority(
        this.projects,
        this.profiles,
        tool,
        context
      );
      if (dispatchAuthority.error) return dispatchAuthority.error;
      context = dispatchAuthority.context;
      if (context?.__abortSignal?.aborted) {
        return semanticToolError(tool, "Turn ended before tool dispatch.", {
          code: "tool_dispatch_cancelled",
          status: "blocked",
          changed: false
        });
      }
      checkpointCapture = await this.checkpoints?.beforeToolCall?.({
        toolName: name,
        args: args ?? {},
        context
      });
      if (context?.__abortSignal?.aborted) {
        const semantic = semanticToolError(tool, "Turn ended before tool dispatch.", {
          code: "tool_dispatch_cancelled",
          status: "blocked",
          changed: false,
          evidence: checkpointEvidence(checkpointCapture)
        });
        this._notifyPostToolCall({ name, args, context, tool, sessionAllowed }, {
          ...semantic,
          dispatched: false,
          durationMs: Date.now() - startedAt
        });
        return semantic;
      }
      const postCheckpointAuthority = refreshToolInvocationAuthority(
        this.projects,
        this.profiles,
        tool,
        context
      );
      if (postCheckpointAuthority.error) {
        const blocked = {
          ...postCheckpointAuthority.error,
          evidence: checkpointEvidence(checkpointCapture)
        };
        this._notifyPostToolCall({ name, args, context, tool, sessionAllowed }, {
          ...blocked,
          dispatched: false,
          durationMs: Date.now() - startedAt
        });
        return blocked;
      }
      context = postCheckpointAuthority.context;
      if (catastrophicApprovalPassed) {
        context = bindExactCatastrophicApproval(
          context,
          name,
          args,
          this.approvalIdentity(name, context)
        );
      }
      if (manualApprovalPassed) {
        context = bindExactManualApproval(
          context,
          name,
          args,
          this.approvalIdentity(name, context)
        );
      }
      if (tool.sideEffects && this.jobCoordinator?.acquireToolInvocation) {
        releaseJobLease = this.jobCoordinator.acquireToolInvocation(
          tool,
          args ?? {},
          context
        );
      }
      dispatched = true;
      const receiptState = context?.[EXECUTION_RECEIPT_STATE];
      if (receiptState) receiptState.dispatched = true;
      const result = await tool.handler(args ?? {}, context);
      let semantic = await semanticToolResult(
        tool,
        result,
        args,
        context,
        {
          evidence: checkpointEvidence(checkpointCapture)
        }
      );
      if (semantic.ok && tool.outputSchema) {
        const outputValidation = validateToolContractValue(
          tool.outputSchema,
          semantic.result
        );
        if (!outputValidation.ok) {
          semantic = semanticToolError(
            tool,
            `Tool ${name} returned a result that does not match its declared output schema: ${formatToolContractIssues(outputValidation)}.`,
            {
              code: "invalid_tool_result",
              changed: tool.sideEffects === false ? false : null,
              evidence: checkpointEvidence(checkpointCapture)
            }
          );
        }
      }
      if (semantic.ok && context?.__approval) {
        semantic.result = appendApprovalNote(semantic.result, context.__approval);
      }
      this._scheduleTimelineCapture({
        name,
        context,
        tool,
        dispatched
      });
      this._notifyPostToolCall({ name, args, context, tool, sessionAllowed }, {
        ...semantic,
        dispatched,
        durationMs: Date.now() - startedAt
      });
      return semantic;
    } catch (error) {
      const errorDetails = safeToolErrorDetails(error);
      const semantic = semanticToolError(tool, errorDetails.message, {
        code: errorDetails.code === "CHECKPOINT_TARGET_AMBIGUOUS"
          ? "checkpoint_target_ambiguous"
          : "handler_error",
        retryable: errorDetails.retryable,
        changed: dispatched && tool?.sideEffects !== false ? null : false,
        evidence: checkpointEvidence(checkpointCapture)
      });
      this._scheduleTimelineCapture({
        name,
        context,
        tool,
        dispatched
      });
      this._notifyPostToolCall({ name, args, context, tool, sessionAllowed }, {
        ...semantic,
        dispatched,
        durationMs: Date.now() - startedAt
      });
      return semantic;
    } finally {
      try { releaseJobLease?.(); } catch { /* fail closed until invocation end */ }
    }
  }

  _notifyPostToolCall(base, outcome) {
    try {
      this.hooks?.notify?.("post_tool_call", {
        ...buildHookPayload(base),
        ...sanitizeForAudit(outcome)
      });
    } catch {
      // Observer hooks are advisory and never alter a tool result.
    }
  }

  _scheduleTimelineCapture({ name, context, tool, dispatched }) {
    if (!dispatched || tool?.sideEffects === false) return;
    try {
      this.timeline?.schedulePostMutation?.({
        toolName: name,
        tool,
        context,
        dispatched
      });
    } catch (error) {
      console.warn(
        `[workspace-timeline] capture scheduling failed: ${safeToolErrorMessage(error, "timeline scheduling failed")}`
      );
    }
  }
}

function normalizeInternalInvocation(token) {
  if (token === PRE_TOOL_HOOKS_PASSED) {
    return {
      preToolHooksPassed: true,
      failureTracking: null,
      manualApprovalPassed: false,
      catastrophicApprovalPassed: false
    };
  }
  if (!token || token[INTERNAL_INVOCATION] !== true) {
    return {
      preToolHooksPassed: false,
      failureTracking: null,
      manualApprovalPassed: false,
      catastrophicApprovalPassed: false
    };
  }
  return {
    preToolHooksPassed: token.preToolHooksPassed === true,
    failureTracking: token.failureTracking ?? null,
    manualApprovalPassed: token.manualApprovalPassed === true,
    catastrophicApprovalPassed: token.catastrophicApprovalPassed === true
  };
}

function makeInternalInvocation({
  preToolHooksPassed = false,
  failureTracking = null,
  manualApprovalPassed = false,
  catastrophicApprovalPassed = false
} = {}) {
  return Object.freeze({
    [INTERNAL_INVOCATION]: true,
    preToolHooksPassed: preToolHooksPassed === true,
    failureTracking,
    manualApprovalPassed: manualApprovalPassed === true,
    catastrophicApprovalPassed: catastrophicApprovalPassed === true
  });
}

function normalizeDomainResultStatuses(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const statuses = [];
  for (const item of value) {
    const status = String(item ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(status)) {
      throw new TypeError("Tool domainResultStatuses must contain bounded ASCII status names.");
    }
    if (!statuses.includes(status)) statuses.push(status);
  }
  return Object.freeze(statuses);
}

function failureTurnKey(sessionId, turnId) {
  return JSON.stringify([String(sessionId ?? ""), String(turnId ?? "")]);
}

function failureActiveKey(context, fingerprint) {
  const owner = String(
    context?.sessionId
    ?? context?.from
    ?? context?.agentId
    ?? ""
  );
  return JSON.stringify([owner, fingerprint]);
}

function createFailureScope({ turnKey = null, context = null } = {}) {
  return {
    entries: new Map(),
    retired: false,
    turnKey,
    context,
    operationNamespace: createId("operation")
  };
}

function createOperationReceipt(scope, fingerprint) {
  return `${scope.operationNamespace}_${fingerprint.slice(0, 24)}`;
}

function createExecutionReceiptState(toolName) {
  return Object.seal({
    id: createId("receipt"),
    tool: boundedReceiptText(toolName, "unknown_tool"),
    startedAtMs: Date.now(),
    dispatched: false
  });
}

function attachExecutionReceipt(envelope, toolName, state) {
  const safeState = state ?? createExecutionReceiptState(toolName);
  if (
    envelope?.receipt?.id === safeState.id
    && envelope.receipt.tool === boundedReceiptText(toolName, safeState.tool ?? "unknown_tool")
    && envelope.receipt.status === envelope?.outcome?.status
    && envelope.receipt.code === envelope?.outcome?.code
    && envelope.receipt.dispatched === (safeState.dispatched === true)
  ) {
    return envelope;
  }
  const finishedAtMs = Date.now();
  const outcome = envelope?.outcome ?? {};
  const receipt = Object.freeze({
    id: boundedReceiptText(safeState.id, createId("receipt")),
    tool: boundedReceiptText(toolName, safeState.tool ?? "unknown_tool"),
    status: boundedReceiptText(outcome.status, envelope?.ok ? "succeeded" : "failed"),
    code: boundedReceiptText(outcome.code, envelope?.ok ? "ok" : "tool_error"),
    dispatched: safeState.dispatched === true,
    changed: outcome.changed === true
      ? true
      : outcome.changed === false
        ? false
        : null,
    startedAt: new Date(safeState.startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - safeState.startedAtMs)
  });
  return {
    ...envelope,
    receipt
  };
}

function boundedReceiptText(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(text)) {
    return fallback;
  }
  return text;
}

function scopeHasInFlight(scope) {
  for (const entry of scope?.entries?.values?.() ?? []) {
    if (entry?.inFlight) return true;
  }
  return false;
}

function normalizedToolSource(value) {
  const source = String(value ?? "internal").trim();
  return source || "internal";
}

function sortedProjectGrants(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].sort()
    : null;
}

function validateProjectScope(projects, context, profiles = null) {
  let projectId = String(context?.__projectId ?? "").trim();
  let inferredDefault = false;
  if (!projectId && typeof profiles?.hasBinding === "function") {
    try {
      if (profiles.hasBinding(DEFAULT_PROJECT_ID, context?.sessionId ?? null)) {
        projectId = DEFAULT_PROJECT_ID;
        inferredDefault = true;
      }
    } catch (error) {
      return {
        project: null,
        error: `Default capability profile cannot be verified: ${
          error?.message ?? String(error)
        }`
      };
    }
  }
  if (!projectId) return { project: null, error: null };
  if (!projects || (
    typeof projects.authorize !== "function"
    && typeof projects.get !== "function"
  )) {
    return {
      project: null,
      error: `Project '${projectId}' cannot be verified by this tool registry.`
    };
  }
  let project;
  try {
    if (typeof projects.authorize === "function") {
      project = projects.authorize(projectId, {
        includeArchived: true,
        sessionId: context?.sessionId ?? null
      });
    } else {
      project = projects.get(projectId, { includeArchived: true });
      if (context?.sessionId && typeof projects.assertSession === "function") {
        projects.assertSession(projectId, context.sessionId);
      }
    }
  } catch (error) {
    return {
      project: null,
      error: error?.code === "PROJECT_BOUNDARY_VIOLATION"
        ? String(error.message)
        : `Project '${projectId}' is not a valid project scope.`
    };
  }
  if (!project) {
    return { project: null, error: `Project '${projectId}' does not exist.` };
  }
  if (project.status !== "active") {
    return { project: null, error: `Project '${projectId}' is archived.` };
  }
  const expectedRevision = context?.__projectRevision;
  if (inferredDefault && expectedRevision == null) {
    return { project, error: null };
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return {
      project: null,
      error: `Project '${projectId}' requires a current integer project revision.`
    };
  }
  if (project.revision !== expectedRevision) {
    return {
      project: null,
      error: `Project '${projectId}' revision ${expectedRevision} is stale; current revision is ${project.revision}.`
    };
  }
  return { project, error: null };
}

function authorizeToolPlanContext(projects, profiles, context) {
  if (!profiles || typeof profiles.resolve !== "function") return context;
  const projectScope = validateProjectScope(projects, context, profiles);
  if (projectScope.error) {
    return {
      ...(context ?? {}),
      __allowedTools: [],
      __scrutinyPolicy: "none",
      __capabilityProfileResolution: {
        active: true,
        locked: true,
        reason: projectScope.error,
        toolGrants: []
      }
    };
  }
  const authorized = authorizedProjectContext(context, projectScope.project);
  const profileScope = authorizeProfileContext(
    profiles,
    authorized,
    projectScope.project
  );
  if (!profileScope.error) return profileScope.context;
  return {
    ...authorized,
    __allowedTools: [],
    __scrutinyPolicy: "none",
    __capabilityProfileResolution: {
      active: true,
      locked: true,
      reason: profileScope.error,
      toolGrants: []
    }
  };
}

function refreshToolInvocationAuthority(projects, profiles, tool, context) {
  const projectScope = validateProjectScope(projects, context, profiles);
  if (projectScope.error) {
    return {
      context,
      error: {
        ok: false,
        blocked: true,
        code: "project_scope_invalid",
        error: projectScope.error
      }
    };
  }
  let authorized = authorizedProjectContext(context, projectScope.project);
  const profileScope = authorizeProfileContext(
    profiles,
    authorized,
    projectScope.project
  );
  if (profileScope.error) {
    return {
      context: authorized,
      error: {
        ok: false,
        blocked: true,
        code: "capability_profile_invalid",
        error: profileScope.error
      }
    };
  }
  authorized = profileScope.context;
  const boundaryError = profileCapabilityBoundaryError(
    tool,
    authorized?.__capabilityProfileResolution
  );
  if (boundaryError) {
    return {
      context: authorized,
      error: {
        ok: false,
        blocked: true,
        code: "capability_profile_denied",
        error: boundaryError
      }
    };
  }
  const projectBoundary = projectToolBoundaryError(tool, authorized);
  if (projectBoundary) {
    return {
      context: authorized,
      error: {
        ok: false,
        blocked: true,
        code: "project_capability_denied",
        error: projectBoundary
      }
    };
  }
  return { context: authorized, error: null };
}

function authorizedProjectContext(context, project) {
  if (!project) return context;
  const agentId = String(context?.agentId ?? "main").trim() || "main";
  const specialistId = agentId === "main" ? null : agentId;
  const canonicalMemoryScope = projectMemoryScope(project, specialistId);
  const requestedMemoryScope = String(context?.__memoryScope ?? "").trim();
  let memoryScope = canonicalMemoryScope;
  if (requestedMemoryScope) {
    if (project.id === DEFAULT_PROJECT_ID && !specialistId) {
      memoryScope = requestedMemoryScope.startsWith("project:")
        ? canonicalMemoryScope
        : requestedMemoryScope;
    } else if (
      requestedMemoryScope === canonicalMemoryScope
      || requestedMemoryScope.startsWith(`${canonicalMemoryScope}:`)
    ) {
      memoryScope = requestedMemoryScope;
    }
  }
  const projectAllowed = Array.isArray(project.policy?.allowedTools)
    && !project.policy.allowedTools.includes("*")
    ? project.policy.allowedTools
    : null;
  const inheritedAllowed = Array.isArray(context?.__allowedTools)
    ? context.__allowedTools
    : null;
  const allowedTools = projectAllowed
    ? inheritedAllowed
      ? projectAllowed.filter((name) => inheritedAllowed.includes(name))
      : [...projectAllowed]
    : inheritedAllowed;
  return {
    ...(context ?? {}),
    __projectId: project.id,
    __projectRevision: project.revision,
    __memoryScope: memoryScope,
    __projectWorkspaceDir: project.workspaceRoot,
    __projectSecretRefs: [...(project.secretRefs ?? [])],
    __projectMcpGrants: [...(project.mcpGrants ?? [])],
    __projectActiveSkills: [...(project.activeSkills ?? [])],
    __projectHookIds: [...(project.hookIds ?? [])],
    __projectKanbanBoardId: project.kanbanBoardId ?? "default",
    __projectModelProfile: structuredClone(project.modelProfile ?? {}),
    __projectRoutingProfile: structuredClone(project.routingProfile ?? {}),
    ...(allowedTools ? { __allowedTools: allowedTools } : {}),
    __scrutinyPolicy: stricterProjectToolPolicy(
      context?.__scrutinyPolicy,
      project.policy?.toolPolicy
    )
  };
}

function authorizeProfileContext(profiles, context, project) {
  if (!project || !profiles || typeof profiles.resolve !== "function") {
    return { context, error: null };
  }
  let resolution;
  try {
    resolution = profiles.resolve(project.id, context?.sessionId ?? null);
  } catch (error) {
    return {
      context,
      error: `Capability profile for project '${project.id}' cannot be verified: ${
        error?.message ?? String(error)
      }`
    };
  }
  if (!resolution?.active) {
    return {
      context: {
        ...(context ?? {}),
        __capabilityProfileResolution: resolution ?? null,
        __capabilityProfileIdentity: null
      },
      error: null
    };
  }
  const profileTools = Array.isArray(resolution.toolGrants)
    ? resolution.toolGrants
    : [];
  const inheritedTools = Array.isArray(context?.__allowedTools)
    ? context.__allowedTools
    : null;
  const allowedTools = inheritedTools
    ? intersectGrantLists(inheritedTools, profileTools)
    : [...profileTools];
  const projectSkills = Array.isArray(project.activeSkills)
    ? project.activeSkills
    : [];
  const profileSkills = Array.isArray(resolution.activeSkills)
    ? resolution.activeSkills
    : [];
  const activeSkills = intersectGrantLists(projectSkills, profileSkills);
  return {
    context: {
      ...(context ?? {}),
      __allowedTools: allowedTools,
      __projectActiveSkills: activeSkills,
      __projectModelProfile: {
        ...structuredClone(project.modelProfile ?? {}),
        ...structuredClone(resolution.modelProfile ?? {})
      },
      __projectRoutingProfile: {
        ...structuredClone(project.routingProfile ?? {}),
        ...structuredClone(resolution.routingProfile ?? {})
      },
      __capabilityProfileResolution: structuredClone(resolution),
      __capabilityProfileIdentity: resolution.identity ?? null
    },
    error: null
  };
}

function intersectGrantLists(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  const aWildcard = a.includes("*");
  const bWildcard = b.includes("*");
  if (aWildcard && bWildcard) return ["*"];
  if (aWildcard) return [...new Set(b)].sort();
  if (bWildcard) return [...new Set(a)].sort();
  const allowed = new Set(b);
  return [...new Set(a.filter((item) => allowed.has(item)))].sort();
}

function stricterProjectToolPolicy(left, right) {
  const rank = new Map([
    ["full", 0],
    ["confirm", 1],
    ["read-only", 2],
    ["none", 3]
  ]);
  const a = rank.has(left) ? left : "full";
  const b = rank.has(right) ? right : "full";
  return rank.get(a) >= rank.get(b) ? a : b;
}

function requireProjectControlIdentity(projects, context, operation) {
  // Runtimes created before ProjectStore remain compatible. Once a project
  // store exists, management calls must carry the registry-authenticated
  // private project identity; a missing public context must not become an
  // implicit administrator.
  if (!projects || typeof projects.get !== "function") return null;
  const projectId = String(context?.__projectId ?? "").trim();
  if (projectId) return projectId;
  const error = new Error(
    `${operation} requires an authenticated project control context.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertDefaultProjectControl(projects, context, operation) {
  const projectId = requireProjectControlIdentity(projects, context, operation);
  if (projectId === null || projectId === "default") return true;
  const error = new Error(
    `${operation} is restricted to the default project control plane.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertDefaultProjectRead(projects, context, operation) {
  if (!projects || typeof projects.get !== "function") return true;
  const projectId = String(
    context?.__projectId ?? context?.projectId ?? ""
  ).trim();
  // Context-free direct invocations are the legacy default-project API.
  if (!projectId || projectId === "default") return true;
  const error = new Error(
    `${operation} is restricted to the default project control plane.`
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function assertProjectReadBoundary(projects, context, targetProjectId) {
  const currentProjectId = requireProjectControlIdentity(
    projects,
    context,
    "Project inspection"
  );
  if (
    currentProjectId === null
    || currentProjectId === "default"
    || String(targetProjectId ?? "").trim().toLowerCase() === currentProjectId
  ) {
    return true;
  }
  const error = new Error(
    "Project inspection is limited to the current project."
  );
  error.code = "PROJECT_BOUNDARY_VIOLATION";
  throw error;
}

function projectGrantSet(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean));
}

function projectGrantAllows(value, capability) {
  const grants = projectGrantSet(value);
  if (!grants || grants.has("*")) return true;
  const name = String(capability ?? "").trim();
  return Boolean(name) && grants.has(name);
}

function projectRequiredSecretsAllowed(context, requiredSecretRefs) {
  if (!Array.isArray(requiredSecretRefs) || requiredSecretRefs.length === 0) return true;
  if (!context?.__projectId) return true;
  return requiredSecretRefs.every((name) => (
    projectGrantAllows(context?.__projectSecretRefs, name)
  ));
}

function assertProjectRequiredSecrets(context, requiredSecretRefs, label) {
  if (projectRequiredSecretsAllowed(context, requiredSecretRefs)) return;
  const denied = requiredSecretRefs.find((name) => (
    !projectGrantAllows(context?.__projectSecretRefs, name)
  ));
  const project = String(context?.__projectId ?? "").trim() || "current project";
  throw new Error(
    `${label} requires secret reference '${denied}' which is not granted to project '${project}'.`
  );
}

function assertProjectGrant(value, capability, label, projectId) {
  if (projectGrantAllows(value, capability)) return;
  const name = String(capability ?? "").trim() || "(missing)";
  const project = String(projectId ?? "").trim() || "current project";
  throw new Error(`${label} '${name}' is not granted to project '${project}'.`);
}

function projectToolBoundaryError(tool, context) {
  if (
    tool?.metadata?.projectScope === "default"
    && context?.__projectId
    && context.__projectId !== "default"
  ) {
    return `Tool '${tool.name}' is restricted to the default project control plane.`;
  }
  if (tool?.source === "mcp" && !projectGrantAllows(
    context?.__projectMcpGrants,
    tool.metadata?.server
  )) {
    const server = String(tool.metadata?.server ?? "").trim() || "(unscoped)";
    const project = String(context?.__projectId ?? "").trim() || "current project";
    return `MCP server '${server}' is not granted to project '${project}'.`;
  }
  if (
    tool?.source === "mcp"
    && !projectRequiredSecretsAllowed(context, tool.metadata?.requiredSecretRefs)
  ) {
    const denied = tool.metadata.requiredSecretRefs.find((name) => (
      !projectGrantAllows(context?.__projectSecretRefs, name)
    ));
    const project = String(context?.__projectId ?? "").trim() || "current project";
    return `MCP tool '${tool.name}' requires secret reference '${denied}' which is not granted to project '${project}'.`;
  }
  if (tool?.source === "skill" && tool.metadata?.skill !== undefined && !projectGrantAllows(
    context?.__projectActiveSkills,
    tool.metadata.skill
  )) {
    const skill = String(tool.metadata?.skill ?? "").trim() || "(unscoped)";
    const project = String(context?.__projectId ?? "").trim() || "current project";
    return `Skill '${skill}' is not active for project '${project}'.`;
  }
  return null;
}

function projectKanbanBoard(context) {
  return String(context?.__projectKanbanBoardId ?? "default");
}

function scopedCronJobs(runtime, context) {
  const projectId = String(context?.__projectId ?? "default").trim() || "default";
  let project = null;
  if (
    typeof runtime.projects?.authorize === "function"
    || typeof runtime.projects?.get === "function"
  ) {
    try {
      project = typeof runtime.projects.authorize === "function"
        ? runtime.projects.authorize(projectId, { includeArchived: false })
        : runtime.projects.get(projectId, { includeArchived: false });
    } catch {
      project = null;
    }
  }
  if (projectId !== "default" && !project) {
    return { jobs: [], project: null, projectId };
  }
  const scheduleIds = projectId === "default"
    ? null
    : new Set(project?.scheduleIds ?? []);
  const jobs = (runtime.cron?.listJobs?.() ?? []).filter((job) => (
    (job?.input?.projectId ?? "default") === projectId
    && (scheduleIds == null || scheduleIds.has(job.id))
  ));
  return { jobs, project, projectId };
}

function projectOwnsSession(projects, sessionId, projectId) {
  if (typeof projects?.projectForSession !== "function") return true;
  try {
    return projects.projectForSession(
      sessionId,
      { includeArchived: false }
    )?.id === projectId;
  } catch {
    // Corrupt, archived, or hostile session identities are never visible
    // through another project's session surfaces.
    return false;
  }
}

function assertProjectBoardArgument(value, context) {
  if (value == null || String(value) === projectKanbanBoard(context)) return;
  throw new Error("Kanban board is outside the current project.");
}

function createProjectDraft(runtime, args, projectId) {
  const draftId = createId("draft");
  let attached = false;
  try {
    runtime.projects?.attachResource?.(
      projectId,
      "artifactIds",
      draftId,
      { actor: "tool:save_draft" }
    );
    attached = Boolean(runtime.projects?.attachResource);
    return runtime.drafts.add({ ...args, id: draftId, projectId });
  } catch (error) {
    if (attached) {
      try {
        runtime.projects?.detachResource?.(
          projectId,
          "artifactIds",
          draftId,
          { actor: "tool:save_draft:rollback" }
        );
      } catch {
        // A dangling non-secret reference is safer than an untracked draft.
      }
    }
    throw error;
  }
}

function artifactMutationResult(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    kind: artifact.kind,
    title: artifact.title,
    revision: artifact.revision,
    pinnedRef: artifact.pinnedRef,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
}

async function requireProjectKanbanTask(runtime, taskId, context) {
  if (!runtime.kanban?.getTask) throw new Error("Kanban store is unavailable.");
  const task = await runtime.kanban.getTask(taskId);
  if (!task) throw new Error(`Unknown Kanban task: ${taskId}`);
  if (task.board !== projectKanbanBoard(context)) {
    throw new Error("Kanban task is outside the current project.");
  }
  return task;
}

function modelToolCap(env = process.env) {
  const parsed = Number(env.OPENAGI_MAX_MODEL_TOOLS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 128;
}

function selectCappedModelTools(tools, max) {
  if (tools.length <= max) return tools;
  if (max <= 0) return [];

  const core = tools.filter((tool) => tool.source !== "mcp");
  const mcp = tools.filter((tool) => tool.source === "mcp");
  const selectedCore = core.slice(0, max);
  const budget = Math.max(0, max - selectedCore.length);
  if (budget === 0) return selectedCore;

  const byServer = new Map();
  for (const tool of mcp) {
    const server = String(tool.metadata?.server ?? "?");
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server).push(tool);
  }
  const servers = [...byServer.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]));
  const picked = [];
  let cursor = 0;
  while (
    picked.length < budget
    && servers.some(([, serverTools]) => cursor < serverTools.length)
  ) {
    for (const [, serverTools] of servers) {
      if (picked.length >= budget) break;
      if (cursor < serverTools.length) picked.push(serverTools[cursor]);
    }
    cursor += 1;
  }
  return [...selectedCore, ...picked];
}

function legacyToolCapNotice(all, selected) {
  const selectedNames = new Set(selected.map((tool) => tool.name));
  const omitted = all.filter((tool) => !selectedNames.has(tool.name));
  if (omitted.length === 0) return null;
  const byServer = new Map();
  let omittedCore = 0;
  for (const tool of omitted) {
    if (tool.source !== "mcp") {
      omittedCore += 1;
      continue;
    }
    const server = String(tool.metadata?.server ?? "?");
    byServer.set(server, (byServer.get(server) ?? 0) + 1);
  }
  const servers = [...byServer.entries()]
    .slice(0, 6)
    .map(([server, count]) => `${server}:${count}`)
    .join(", ");
  const core = omittedCore ? `; ${omittedCore} core tools also omitted` : "";
  return `Tool catalog cap: ${omitted.length} tools are not advertised directly (${servers || "MCP overflow"}${core}). Use searcmcp_tools to find them, then run_mcp_tool to invoke them.`;
}

function normalizeToolCapability(input, {
  toolName,
  source,
  sideEffects,
  needsConfirmation
}) {
  if (input !== undefined && !isPlainRecord(input)) {
    throw capabilityError(toolName, null, "must be a plain object.");
  }
  const supplied = input ?? {};
  assertCapabilityDataProperties(supplied, toolName, "capability");
  for (const field of Object.keys(supplied)) {
    if (!CAPABILITY_FIELDS.has(field)) {
      throw capabilityError(toolName, field, "is not a supported field.");
    }
  }

  const expectedEffect = sideEffects ? "write" : "read";
  const effect = supplied.effect === undefined
    ? expectedEffect
    : capabilityEnum(toolName, "effect", supplied.effect, CAPABILITY_EFFECTS);
  if (effect !== expectedEffect) {
    throw capabilityError(
      toolName,
      "effect",
      `must be "${expectedEffect}" because sideEffects is ${sideEffects}.`
    );
  }
  const declaredRequirements = supplied.requirements === undefined
    ? []
    : capabilityStringArray(toolName, "requirements", supplied.requirements, {
        maxItems: 32,
        maxLength: 256
      });
  const requirements = needsConfirmation
    ? [...new Set([...declaredRequirements, "human_confirmation"])]
    : declaredRequirements;

  const capability = {
    domain: supplied.domain === undefined
      ? capabilityString(toolName, "domain", source, { maxLength: 128 })
      : capabilityString(toolName, "domain", supplied.domain, { maxLength: 128 }),
    verbs: supplied.verbs === undefined
      ? []
      : capabilityStringArray(toolName, "verbs", supplied.verbs, {
          maxItems: 32,
          maxLength: 64
        }),
    effect,
    idempotent: supplied.idempotent === undefined
      ? !sideEffects
      : capabilityBoolean(toolName, "idempotent", supplied.idempotent),
    latency: supplied.latency === undefined
      ? (source === "internal" ? "low" : "unknown")
      : capabilityEnum(toolName, "latency", supplied.latency, CAPABILITY_LATENCIES),
    cost: supplied.cost === undefined
      ? "unknown"
      : capabilityEnum(toolName, "cost", supplied.cost, CAPABILITY_COSTS),
    resources: supplied.resources === undefined
      ? (source === "internal" ? [] : [source])
      : capabilityStringArray(toolName, "resources", supplied.resources, {
          maxItems: 32,
          maxLength: 128
        }),
    requirements,
    examples: supplied.examples === undefined
      ? []
      : capabilityExamples(toolName, supplied.examples),
    successCriteria: supplied.successCriteria === undefined
      ? []
      : capabilityStringArray(toolName, "successCriteria", supplied.successCriteria, {
          maxItems: 16,
          maxLength: 512
        }),
    availability: supplied.availability === undefined
      ? (source === "internal" ? "available" : "conditional")
      : capabilityEnum(
          toolName,
          "availability",
          supplied.availability,
          CAPABILITY_AVAILABILITIES
        )
  };

  // Capability metadata can reach prompts, HTTP surfaces, and durable
  // telemetry. Apply the same key- and token-based masking as audit records
  // before freezing it into the registry.
  return deepFreeze(sanitizeForAudit(capability));
}

function capabilityString(toolName, field, value, { maxLength }) {
  if (typeof value !== "string") {
    throw capabilityError(toolName, field, "must be a string.");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw capabilityError(toolName, field, "must be a non-empty string.");
  }
  if (normalized.length > maxLength) {
    throw capabilityError(toolName, field, `must be at most ${maxLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw capabilityError(toolName, field, "must not contain control characters.");
  }
  return normalized;
}

function capabilityBoolean(toolName, field, value) {
  if (typeof value !== "boolean") {
    throw capabilityError(toolName, field, "must be a boolean.");
  }
  return value;
}

function capabilityEnum(toolName, field, value, allowed) {
  const normalized = capabilityString(toolName, field, value, { maxLength: 32 }).toLowerCase();
  if (!allowed.has(normalized)) {
    throw capabilityError(
      toolName,
      field,
      `must be one of: ${[...allowed].join(", ")}.`
    );
  }
  return normalized;
}

function capabilityStringArray(toolName, field, value, {
  maxItems,
  maxLength
}) {
  if (!Array.isArray(value)) {
    throw capabilityError(toolName, field, "must be an array of strings.");
  }
  assertCapabilityDataProperties(value, toolName, `capability.${field}`);
  if (value.length > maxItems) {
    throw capabilityError(toolName, field, `must contain at most ${maxItems} items.`);
  }
  const normalized = value.map((item, index) => (
    capabilityString(toolName, `${field}[${index}]`, item, { maxLength })
  ));
  return [...new Set(normalized)];
}

function capabilityExamples(toolName, value) {
  if (!Array.isArray(value)) {
    throw capabilityError(toolName, "examples", "must be an array of JSON-serializable values.");
  }
  assertCapabilityDataProperties(value, toolName, "capability.examples");
  if (value.length > CAPABILITY_MAX_EXAMPLES) {
    throw capabilityError(
      toolName,
      "examples",
      `must contain at most ${CAPABILITY_MAX_EXAMPLES} items.`
    );
  }
  const examples = value.map((example, index) => (
    cloneCapabilityJson(example, toolName, `examples[${index}]`, new WeakSet())
  ));
  const encoded = JSON.stringify(examples);
  if (Buffer.byteLength(encoded, "utf8") > CAPABILITY_MAX_EXAMPLE_BYTES) {
    throw capabilityError(
      toolName,
      "examples",
      `must encode to at most ${CAPABILITY_MAX_EXAMPLE_BYTES} bytes.`
    );
  }
  return examples;
}

function cloneCapabilityJson(value, toolName, field, ancestors) {
  if (
    value === undefined
    || typeof value === "function"
    || typeof value === "symbol"
    || typeof value === "bigint"
  ) {
    throw capabilityError(toolName, field, "must contain only JSON-serializable values.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw capabilityError(toolName, field, "must contain only finite numbers.");
    }
    return value;
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw capabilityError(toolName, field, "must contain only plain JSON values.");
  }
  assertCapabilityDataProperties(value, toolName, `capability.${field}`);
  if (ancestors.has(value)) {
    throw capabilityError(toolName, field, "must not contain circular references.");
  }

  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((item, index) => (
      cloneCapabilityJson(item, toolName, `${field}[${index}]`, ancestors)
    ));
  } else {
    clone = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__") {
        throw capabilityError(toolName, `${field}.${key}`, "is not an allowed example key.");
      }
      defineOwnData(
        clone,
        key,
        cloneCapabilityJson(item, toolName, `${field}.${key}`, ancestors)
      );
    }
  }
  ancestors.delete(value);
  return clone;
}

function capabilityError(toolName, field, message) {
  const location = field ? `capability.${field}` : "capability";
  return new TypeError(`Tool ${toolName} ${location} ${message}`);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCapabilityDataProperties(value, toolName, location) {
  if (!value || typeof value !== "object") return;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length") continue;
    if (!Object.hasOwn(descriptor, "value")) {
      const field = location === "capability"
        ? key
        : `${location.replace(/^capability\./u, "")}.${key}`;
      throw capabilityError(toolName, field, "must not use getters or setters.");
    }
  }
}

function publicToolDescriptor(tool) {
  const {
    handler: _handler,
    preflight: _preflight,
    jobResources: _jobResources,
    jobResourceRevision: _jobResourceRevision,
    forwardInvocation: _forwardInvocation,
    summarize: _summarize,
    normalizeOutcome: _normalizeOutcome,
    verifyOutcome: _verifyOutcome,
    domainResultStatuses: _domainResultStatuses,
    approvalRevision: _approvalRevision,
    ...descriptor
  } = tool;
  return clonePublicValue(descriptor, new WeakSet());
}

function clonePublicValue(value, ancestors) {
  if (
    value === undefined
    || typeof value === "function"
    || typeof value === "symbol"
    || typeof value === "bigint"
  ) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
      const safe = clonePublicValue(descriptor.value, ancestors);
      if (safe !== undefined) clone.push(safe);
    }
  } else {
    clone = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, "value")) continue;
      const safe = clonePublicValue(descriptor.value, ancestors);
      if (safe !== undefined) defineOwnData(clone, key, safe);
    }
  }
  ancestors.delete(value);
  return clone;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function defineOwnData(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function buildHookPayload({
  name,
  args,
  context = {},
  tool,
  sessionAllowed,
  catastrophicApprovalPassed = false
}) {
  return {
    toolName: name,
    args: sanitizeForAudit(args ?? {}),
    sessionId: context?.sessionId ?? null,
    turnId: context?.__turnId ?? context?.turnId ?? null,
    providerToolCallId: context?.__providerToolCallId ?? null,
    operationReceipt: context?.__operationReceipt ?? context?.__idempotencyKey ?? null,
    agentId: context?.agentId ?? null,
    projectId: context?.__projectId ?? "default",
    projectRevision: context?.__projectRevision ?? null,
    projectHookIds: Array.isArray(context?.__projectHookIds)
      ? [...context.__projectHookIds]
      : null,
    jobId: context?.__jobId ?? null,
    channel: context?.channel ?? null,
    from: context?.from ?? null,
    cwd: args?.cwd ?? null,
    sideEffects: tool?.sideEffects !== false,
    needsConfirmation: Boolean(tool?.needsConfirmation),
    privateInput: tool?.metadata?.privateInput === true,
    confirmed: context?.__confirmed === true,
    catastrophicApproved: catastrophicApprovalPassed === true,
    sessionAllowed: Boolean(sessionAllowed)
  };
}

function bindExactCatastrophicApproval(context, toolName, args, policyIdentity) {
  const bound = cloneInvocationContext(context);
  Object.defineProperty(bound, EXACT_CATASTROPHIC_APPROVAL, {
    value: {
      toolName,
      args,
      projectId: String(context?.__projectId ?? "default"),
      sessionId: String(context?.sessionId ?? ""),
      policyIdentity: String(policyIdentity ?? ""),
      used: false
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return bound;
}

function bindExactManualApproval(context, toolName, args, policyIdentity) {
  const bound = cloneInvocationContext(context);
  Object.defineProperty(bound, EXACT_MANUAL_APPROVAL, {
    value: {
      toolName,
      args,
      projectId: String(context?.__projectId ?? "default"),
      sessionId: String(context?.sessionId ?? ""),
      policyIdentity: String(policyIdentity ?? ""),
      used: false
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return bound;
}

function cloneInvocationContext(context) {
  const source = context && typeof context === "object" ? context : {};
  return Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(source)
  );
}

export function consumeExactCatastrophicApproval(context, toolName, args) {
  const proof = context?.[EXACT_CATASTROPHIC_APPROVAL];
  if (!exactApprovalMatches(proof, context, toolName, args)) return false;
  proof.used = true;
  return true;
}

export function hasExactCatastrophicApproval(context, toolName, args) {
  return exactApprovalMatches(
    context?.[EXACT_CATASTROPHIC_APPROVAL],
    context,
    toolName,
    args
  );
}

export function consumeExactManualApproval(context, toolName, args) {
  const proof = context?.[EXACT_MANUAL_APPROVAL];
  if (!exactApprovalMatches(proof, context, toolName, args)) return false;
  proof.used = true;
  return true;
}

function exactApprovalMatches(proof, context, toolName, args) {
  return Boolean(
    proof
    && !proof.used
    && proof.toolName === toolName
    && proof.args === args
    && proof.projectId === String(context?.__projectId ?? "default")
    && proof.sessionId === String(context?.sessionId ?? "")
    && proof.policyIdentity
  );
}

function isTrustedCatastrophicBlock(decision) {
  return decision?.blockedBy === "catastrophic-policy"
    && decision?.blockedTier === "gateway"
    && decision?.builtin === true;
}

function safeSummarize(fn, args) {
  try { return String(fn(args ?? {})).slice(0, 240); } catch { return null; }
}

function sessionAllowKey(sessionId, toolName) {
  return `${String(sessionId)}\u0000${String(toolName)}`;
}

function appendApprovalNote(result, approval) {
  if (!approval) return result;
  const description = approval.description ?? "flagged as dangerous";
  const approvalNote = `Command required approval (${description}) and was approved by the user.`;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, approvalNote };
  }
  return { value: result ?? null, approvalNote };
}

function privateToolEventArgs(tool, args) {
  if (tool?.metadata?.privateInput !== true) return args;
  const safe = sanitizeForAudit(args ?? {});
  if (
    safe
    && typeof safe === "object"
    && !Array.isArray(safe)
    && Object.hasOwn(safe, "command")
  ) {
    safe.command = "[TERMINAL INPUT OMITTED]";
  }
  return safe;
}

function checkpointEvidence(capture) {
  const checkpoints = Array.isArray(capture?.checkpoints)
    ? capture.checkpoints
    : [];
  return checkpoints
    .map((checkpoint) => String(checkpoint?.id ?? "").trim())
    .filter(Boolean)
    .map((id) => `checkpoint:${id}`);
}

function classifyLegacyToolFailure(value) {
  if (value?.code) {
    return {
      code: String(value.code),
      status: value?.blocked === true ? "blocked" : "failed"
    };
  }
  const message = String(value?.error ?? "").toLowerCase();
  if (message.startsWith("unknown tool:")) {
    return { code: "unknown_tool", status: "failed" };
  }
  if (message.includes("outside this specialist")) {
    return { code: "specialist_scope_blocked", status: "blocked" };
  }
  if (message.includes("scrutiny verdict")) {
    return { code: "scrutiny_blocked", status: "blocked" };
  }
  if (message.includes("pre_tool_call hook")) {
    return { code: "hook_blocked", status: "blocked" };
  }
  if (message.includes("awaiting approval") || message.includes("requires human approval")) {
    return { code: "approval_required", status: "blocked" };
  }
  if (
    message.includes("denied by")
    || message.includes("timed out awaiting approval")
    || message.includes("cancelled because the turn ended")
  ) {
    return { code: "approval_not_granted", status: "blocked" };
  }
  return { code: "tool_error", status: value?.blocked === true ? "blocked" : "failed" };
}

function failureTrackerEnvelope(value) {
  const outcome = value?.outcome ?? {};
  return {
    ok: false,
    error: "The previous identical tool call failed.",
    outcome: {
      status: ["failed", "blocked", "pending"].includes(outcome.status)
        ? outcome.status
        : "failed",
      code: String(outcome.code ?? "tool_error").slice(0, 64),
      retryable: outcome.retryable === true,
      changed: outcome.changed === true ? true : outcome.changed === false ? false : null,
      artifacts: [],
      evidence: Array.isArray(outcome.evidence)
        ? outcome.evidence.filter((item) => String(item).startsWith("checkpoint:")).slice(0, 16)
        : [],
      verification: {
        status: String(outcome.verification?.status ?? "not_requested").slice(0, 32),
        summary: null
      },
      nextSteps: []
    }
  };
}

function externalMemoryIdentity(context = {}) {
  const channel = identityPart(context?.channel, "agent");
  const owner = identityPart(
    context?.from ?? context?.userId ?? context?.agentId,
    "default"
  );
  const projectId = identityPart(
    context?.__projectId ?? context?.projectId,
    "default"
  );
  const prefix = projectId === "default" ? "" : `project:${projectId}:`;
  return {
    userId: `${prefix}${channel}:${owner}`,
    observerId: `${prefix}${identityPart(context?.agentId, "main")}`
  };
}

function memoryScopeForClass(context = {}, memoryClass = "fact") {
  if (memoryClass === "preference") {
    if (!isProfileMemoryScope(context?.__profileMemoryScope)) {
      throw new Error("A user-profile memory scope is unavailable for this request.");
    }
    return context.__profileMemoryScope;
  }
  if (typeof context?.__memoryScope === "string" && context.__memoryScope) {
    return context.__memoryScope;
  }
  return context?.agentId && context.agentId !== "main"
    ? `specialist:${context.agentId}`
    : "main";
}

function mergeMemoryHits(projectHits, profileHits, limit) {
  const byId = new Map();
  for (const entry of [...(projectHits ?? []), ...(profileHits ?? [])]) {
    if (!entry?.item?.id) continue;
    const previous = byId.get(entry.item.id);
    if (!previous || entry.score > previous.score) byId.set(entry.item.id, entry);
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || String(left.item.id).localeCompare(String(right.item.id)))
    .slice(0, limit);
}

function memoryDetailsView(item) {
  const metadata = item?.metadata ?? {};
  const provenance = metadata?.provenance ?? {};
  const supersededBy = boundedMemoryDetailId(metadata?.supersededBy);
  const condensedInto = boundedMemoryDetailId(metadata?.condensedInto);
  const status = supersededBy
    ? "superseded"
    : condensedInto
      ? "condensed"
      : "active";
  return {
    id: String(item.id),
    content: String(item.content ?? ""),
    scope: String(item.scope ?? "main"),
    memoryClass: item.metadata?.memoryClass ?? (isProfileMemoryScope(item.scope) ? "preference" : "fact"),
    status,
    confidence: {
      tier: String(item.tier ?? "short"),
      fidelity: String(item.fidelity ?? "normal"),
      strength: Number(Number(item.strength ?? 0).toFixed(2)),
      locked: Boolean(item.locked)
    },
    provenance: {
      sourceType: boundedMemoryDetailText(provenance?.sourceType ?? item.source ?? "runtime", 96),
      trust: boundedMemoryDetailText(provenance?.trust ?? "unspecified", 96),
      humanApproved: provenance?.trust === "human-approved-model-proposal"
    },
    relationships: {
      supersededBy,
      condensedInto,
      replaces: boundedMemoryDetailIds(metadata?.replaces),
      corrects: boundedMemoryDetailIds(metadata?.corrects)
    },
    createdAt: boundedMemoryDetailText(item.createdAt, 64),
    lastAccessedAt: boundedMemoryDetailText(item.lastAccessedAt, 64)
  };
}

function boundedMemoryDetailIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map(boundedMemoryDetailId).filter(Boolean).slice(0, 20);
}

function boundedMemoryDetailId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

function boundedMemoryDetailText(value, maxChars) {
  return String(sanitizeForAudit(String(value ?? ""))).slice(0, maxChars);
}

function approvedBackgroundMemoryProposal(runtime, rawProposal, context = {}) {
  const actionId = String(context?.__pendingActionId ?? "").trim();
  const approval = context?.__approval;
  const decider = String(approval?.decider ?? "").trim();
  if (!actionId || !decider || decider === "auto-approve") {
    throw new Error("Background memory proposals require an explicit human approval.");
  }
  const action = runtime?.pendingActions?.get?.(actionId, {
    projectId: context?.__projectId ?? context?.projectId
  });
  if (
    !action
    || action.status !== "approved"
    || action.toolName !== "apply_background_memory_proposal"
  ) {
    throw new Error("The approved background memory action is unavailable or no longer valid.");
  }
  const proposal = prepareBackgroundMemoryProposal(rawProposal, {
    runtime,
    turn: {
      sessionId: action.context?.sessionId ?? context?.sessionId,
      projectId: action.context?.__projectId ?? action.context?.projectId,
      memoryScope: action.context?.__memoryScope
    },
    scope: action.context?.__memoryScope
  });
  if (
    !sameBackgroundMemoryProposal(action.args?.proposal, proposal)
    || action.context?.__memoryScope !== proposal.scope
  ) {
    throw new Error("The background memory proposal no longer matches its approved action.");
  }
  return { action, proposal, decider };
}

function backgroundMemoryConfidenceProfile(confidence) {
  if (confidence === "high") return { tier: "long", strength: 0.85 };
  if (confidence === "medium") return { tier: "medium", strength: 0.68 };
  return { tier: "medium", strength: 0.48 };
}

async function invokeExternalMemory(provider, method, args, upstreamSignal = null) {
  if (!provider) {
    return {
      enabled: false,
      value: null,
      status: null
    };
  }

  const providerName = externalMemoryProviderName(provider);
  if (typeof provider[method] !== "function") {
    return {
      enabled: true,
      value: null,
      status: {
        status: "error",
        provider: providerName,
        error: `External memory provider does not implement ${method}.`
      }
    };
  }

  const configuredTimeout = Number(provider.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(Math.floor(configuredTimeout), EXTERNAL_MEMORY_MAX_TIMEOUT_MS)
    : EXTERNAL_MEMORY_TIMEOUT_MS;
  const timeoutCode = "EXTERNAL_MEMORY_TIMEOUT";
  const cancelledCode = "EXTERNAL_MEMORY_CANCELLED";
  const controller = new AbortController();
  if (upstreamSignal?.aborted) {
    return {
      enabled: true,
      value: null,
      status: {
        status: "cancelled",
        provider: providerName,
        error: "External memory request was cancelled."
      }
    };
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`External memory request timed out after ${timeoutMs}ms.`);
      error.code = timeoutCode;
      reject(error);
    }, timeoutMs);
  });
  let onUpstreamAbort;
  const cancelled = upstreamSignal
    ? new Promise((_, reject) => {
      onUpstreamAbort = () => {
        controller.abort(upstreamSignal.reason);
        const error = new Error("External memory request was cancelled.");
        error.code = cancelledCode;
        reject(error);
      };
      upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    })
    : null;

  try {
    const requests = [
      Promise.resolve().then(() => provider[method]({
        ...args,
        signal: controller.signal
      })),
      timeout
    ];
    if (cancelled) requests.push(cancelled);
    const value = await Promise.race(requests);
    return {
      enabled: true,
      value,
      status: {
        status: "ok",
        provider: externalMemoryProviderName(provider, value)
      }
    };
  } catch (error) {
    const timedOut = error?.code === timeoutCode;
    const cancelledRequest = error?.code === cancelledCode;
    return {
      enabled: true,
      value: null,
      status: {
        status: timedOut ? "timeout" : cancelledRequest ? "cancelled" : "error",
        provider: providerName,
        error: timedOut
          ? `External memory request timed out after ${timeoutMs}ms.`
          : cancelledRequest
            ? "External memory request was cancelled."
            : "External memory provider request failed."
      }
    };
  } finally {
    clearTimeout(timer);
    if (onUpstreamAbort) {
      upstreamSignal.removeEventListener("abort", onUpstreamAbort);
    }
  }
}

function identityPart(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function externalMemoryProviderName(provider, result = null) {
  const name = result?.provider ?? provider?.provider ?? provider?.name ?? "external";
  const safe = String(sanitizeForAudit(String(name))).trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(safe) ? safe : "external";
}

function externalUserModelValue(result) {
  if (result == null) return null;
  if (typeof result !== "object") return result;
  return result.answer ?? result.model ?? result.userModel ?? null;
}

// Auto-approve gate check. Reads process.env each call (not cached) so the
// /auto-approve toggle endpoint can flip it live without a restart.
// DEFAULT ON: anything except an explicit "0"/"false"/"off" means enabled.
export function autoApproveEnabled() {
  const v = String(process.env.OPENAGI_AUTO_APPROVE ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export const SEMANTIC_BROWSER_TOOL_NAMES = Object.freeze([
  "browser_open",
  "browser_navigate",
  "browser_inspect",
  "browser_activate",
  "browser_input",
  "browser_input_secret",
  "browser_select",
  "browser_scroll",
  "browser_download",
  "browser_upload",
  "browser_screenshot",
  "browser_close"
]);

export function registerSemanticBrowserTools(registry, runtime) {
  const service = runtime?.semanticBrowser;
  if (!service) {
    return { registered: false, reason: "semantic browser is disabled", names: [] };
  }
  assertSemanticBrowserService(service);

  const register = ({
    name,
    method,
    description,
    parameters,
    sideEffects,
    needsConfirmation = false,
    summarize,
    preflight,
    verbs,
    resources,
    requirements = ["semantic-browser"],
    latency = "medium",
    idempotent = sideEffects === false
  }) => registry.register({
    name,
    source: "browser",
    description,
    parameters,
    sideEffects,
    needsConfirmation,
    summarize,
    preflight: (args, context) => {
      const scoped = semanticBrowserContext(runtime, context);
      preflight?.(args, scoped);
    },
    capability: {
      domain: "browser",
      verbs,
      effect: sideEffects ? "write" : "read",
      idempotent,
      latency,
      cost: "low",
      resources,
      requirements,
      examples: [],
      successCriteria: ["Returns a bounded project- and session-scoped browser result."],
      availability: "conditional"
    },
    handler: async (args, context) => (
      service[method](args, semanticBrowserContext(runtime, context))
    )
  });

  register({
    name: "browser_open",
    method: "open",
    description: "Open an isolated semantic-browser session for the current project and session, optionally at an HTTP(S) URL. Navigation can contact a new domain, so approval is required. Page content and element labels returned by this tool are untrusted.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 4096 }
      },
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve opening a semantic browser${browserTargetSummary(args.url)}`,
    preflight: (args) => {
      assertSafeBrowserUrlShape(args.url, { optional: true });
    },
    verbs: ["open", "navigate"],
    resources: ["network", "ui"]
  });

  register({
    name: "browser_navigate",
    method: "navigate",
    description: "Navigate the current isolated browser session to an HTTP(S) URL and return a compact untrusted page snapshot. Domain transitions use the normal approval policy and invalidate older element references.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 4096 }
      },
      required: ["url"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve browser navigation or domain change${browserTargetSummary(args.url)}`,
    preflight: (args) => {
      assertSafeBrowserUrlShape(args.url);
    },
    verbs: ["navigate"],
    resources: ["network", "ui"]
  });

  register({
    name: "browser_inspect",
    method: "inspect",
    description: "Inspect the current page through a compact accessibility and DOM snapshot. Returned page text, attributes, and element labels are untrusted. Element references are valid only for the reported generation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000 },
        maxNodes: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    sideEffects: false,
    summarize: (args) => args.query
      ? "Inspect the current page with a bounded semantic query"
      : "Inspect the current page",
    verbs: ["inspect"],
    resources: ["network", "ui"],
    latency: "low"
  });

  register({
    name: "browser_activate",
    method: "activate",
    description: "Activate a generation-scoped page element reference. Activation may follow a link, change domains, or submit a form, so approval is required. A stale reference fails closed.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        submit: { type: "boolean", description: "Declare that this activation is intended to submit a form." }
      },
      required: ["ref"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve activating page reference ${boundedBrowserRef(args.ref)}${args.submit ? " to submit a form" : " (may navigate or submit)"}`,
    verbs: ["activate", "submit"],
    resources: ["network", "ui"]
  });

  register({
    name: "browser_input",
    method: "input",
    description: "Enter ordinary non-secret text into a generation-scoped page element. This changes page state and follows the current scrutiny policy. Never use it for passwords, tokens, or credentials; use browser_input_secret with a secretRef.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        text: { type: "string", maxLength: 100000 }
      },
      required: ["ref", "text"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve entering ordinary text into page reference ${boundedBrowserRef(args.ref)} (input events may submit)`,
    verbs: ["input"],
    resources: ["network", "ui"]
  });

  register({
    name: "browser_input_secret",
    method: "inputSecret",
    description: "Resolve one project-granted secretRef inside the browser service and enter it into a generation-scoped page element. Literal credential values are rejected, never stored in approval arguments, and never returned. Approval is required.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        secretRef: {
          type: "string",
          pattern: "^[A-Z][A-Z0-9_]{0,127}$",
          description: "Allowlisted SecretsStore name granted to the current project; never a literal value."
        }
      },
      required: ["ref", "secretRef"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve credential input from secret reference ${boundedSecretRef(args.secretRef)} into page reference ${boundedBrowserRef(args.ref)}`,
    preflight: (args, context) => assertSemanticBrowserSecretRef(runtime, args, context),
    verbs: ["input", "authenticate"],
    resources: ["network", "ui", "secrets"],
    requirements: ["semantic-browser", "project-secret-grant", "human-approval"]
  });

  register({
    name: "browser_select",
    method: "select",
    description: "Choose one or more values in a generation-scoped page select control. This changes page state and follows the current scrutiny policy.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        value: { type: "string", maxLength: 10000 },
        values: {
          type: "array",
          maxItems: 100,
          items: { type: "string", maxLength: 10000 }
        }
      },
      required: ["ref"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve selecting a value in page reference ${boundedBrowserRef(args.ref)} (change events may submit)`,
    preflight: (args) => {
      const one = typeof args.value === "string";
      const many = Array.isArray(args.values) && args.values.length > 0;
      if (one === many) {
        throw new TypeError("browser_select requires exactly one of value or non-empty values.");
      }
    },
    verbs: ["select"],
    resources: ["network", "ui"]
  });

  register({
    name: "browser_scroll",
    method: "scroll",
    description: "Scroll the current page or one generation-scoped scroll container. This is treated as a harmless read/navigation aid and does not bypass stale-reference checks.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        deltaY: { type: "integer", minimum: -100000, maximum: 100000 }
      },
      additionalProperties: false
    },
    sideEffects: false,
    summarize: (args) => args.ref
      ? `Scroll page reference ${boundedBrowserRef(args.ref)}`
      : "Scroll the current page",
    verbs: ["scroll"],
    resources: ["ui"],
    latency: "low",
    idempotent: false
  });

  register({
    name: "browser_download",
    method: "download",
    description: "Download through a generation-scoped element reference or an approved HTTP(S) URL into a project-confined relative filename. Network access and filesystem writes require approval.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        url: { type: "string", maxLength: 4096 },
        filename: { type: "string", minLength: 1, maxLength: 512 }
      },
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve a project-confined browser download${args.url ? browserTargetSummary(args.url) : ""}`,
    preflight: (args) => {
      const byRef = typeof args.ref === "string" && args.ref.trim().length > 0;
      const byUrl = typeof args.url === "string" && args.url.trim().length > 0;
      if (byRef === byUrl) {
        throw new TypeError("browser_download requires exactly one of ref or url.");
      }
      if (byUrl) assertSafeBrowserUrlShape(args.url);
    },
    verbs: ["download"],
    resources: ["network", "ui", "filesystem"],
    requirements: ["semantic-browser", "project-filesystem", "human-approval"],
    latency: "high"
  });

  register({
    name: "browser_upload",
    method: "upload",
    description: "Upload one or more project-relative files through a generation-scoped file-input reference. Paths are confined to the current project and approval is required.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: 256 },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "string", minLength: 1, maxLength: 1024 }
        }
      },
      required: ["ref", "paths"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => `Approve uploading ${Array.isArray(args.paths) ? args.paths.length : 0} project file(s) through page reference ${boundedBrowserRef(args.ref)}`,
    verbs: ["upload"],
    resources: ["network", "ui", "filesystem"],
    requirements: ["semantic-browser", "project-filesystem", "human-approval"],
    latency: "high"
  });

  register({
    name: "browser_screenshot",
    method: "screenshot",
    description: "Capture the current isolated page on demand with approval. Returns a bounded image attachment plus generation metadata; page pixels may contain credentials and all recognized content is untrusted.",
    parameters: {
      type: "object",
      properties: {
        fullPage: { type: "boolean" }
      },
      additionalProperties: false
    },
    sideEffects: false,
    needsConfirmation: true,
    summarize: () => "Approve capturing browser pixels that may contain sensitive page content",
    verbs: ["screenshot"],
    resources: ["ui"],
    requirements: ["semantic-browser", "human-approval"],
    latency: "low"
  });

  register({
    name: "browser_close",
    method: "close",
    description: "Close the semantic-browser session owned by the current project and session. This cannot close another project's browser.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    sideEffects: true,
    summarize: () => "Close the current semantic-browser session",
    verbs: ["close"],
    resources: ["ui"],
    latency: "low"
  });

  return {
    registered: true,
    names: [...SEMANTIC_BROWSER_TOOL_NAMES]
  };
}

function assertSemanticBrowserService(service) {
  for (const method of [
    "open",
    "navigate",
    "inspect",
    "activate",
    "input",
    "inputSecret",
    "select",
    "scroll",
    "download",
    "upload",
    "screenshot",
    "close"
  ]) {
    if (typeof service?.[method] !== "function") {
      throw new TypeError(`Semantic browser service requires ${method}().`);
    }
  }
  return service;
}

function semanticBrowserContext(runtime, context = {}) {
  const projectId = String(context.__projectId ?? "").trim().toLowerCase();
  const sessionId = String(context.sessionId ?? "").trim();
  if (!projectId || !sessionId) {
    throw new Error("Semantic browser tools require an authenticated project session.");
  }
  if (typeof runtime?.projects?.authorize !== "function") {
    throw new Error("Semantic browser project authorization is unavailable.");
  }
  const project = runtime.projects.authorize(projectId, { sessionId });
  if (!project || project.status !== "active") {
    throw new Error(`Semantic browser project '${projectId}' is unavailable.`);
  }
  const revision = Number(context.__projectRevision);
  if (!Number.isSafeInteger(revision) || revision !== project.revision) {
    throw new Error(`Semantic browser project '${projectId}' revision is stale.`);
  }
  return {
    ...context,
    projectId: project.id,
    projectRevision: project.revision,
    workspaceRoot: project.workspaceRoot,
    scrutinyPolicy: context.__scrutinyPolicy ?? project.policy?.toolPolicy ?? "full",
    __projectId: project.id,
    __projectRevision: project.revision,
    __projectWorkspaceDir: project.workspaceRoot,
    __projectSecretRefs: [...(project.secretRefs ?? [])],
    sessionId
  };
}

function assertSemanticBrowserSecretRef(runtime, args, context) {
  const keys = Object.keys(args ?? {});
  if (keys.some((key) => key !== "ref" && key !== "secretRef")) {
    throw new TypeError("browser_input_secret accepts only ref and secretRef.");
  }
  const ref = String(args?.ref ?? "").trim();
  const secretRef = String(args?.secretRef ?? "").trim();
  if (!ref) throw new TypeError("browser_input_secret requires ref.");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(secretRef)) {
    throw new TypeError("browser_input_secret requires an allowlisted secretRef name.");
  }
  const project = runtime.projects.authorize(context.__projectId, {
    sessionId: context.sessionId
  });
  if (!projectAllows(project.secretRefs, secretRef)) {
    throw new Error(
      `Secret reference '${secretRef}' is not granted to project '${project.id}'.`
    );
  }
  if (typeof runtime.secrets?.getSecret !== "function") {
    throw new Error("Semantic browser secret resolution is unavailable.");
  }
  const allowed = typeof runtime.secrets.listAllowedNames === "function"
    ? runtime.secrets.listAllowedNames()
    : null;
  if (allowed && !allowed.includes(secretRef)) {
    throw new Error(`Secret reference '${secretRef}' is not allowlisted.`);
  }
}

function browserTargetSummary(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) return " to an invalid target";
    return ` to ${parsed.origin}`;
  } catch {
    return " to an invalid target";
  }
}

function boundedBrowserRef(value) {
  const ref = String(value ?? "").trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(ref) ? ref : "[invalid-ref]";
}

function boundedSecretRef(value) {
  const ref = String(value ?? "").trim();
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(ref) ? ref : "[invalid-secret-ref]";
}

export function registerCoreTools(registry, runtime) {
  const toolSearch = registry.toolSearchController ?? new ToolSearchController({ registry });
  registry.bindToolSearch(toolSearch);
  registerToolSearchTools(registry, { controller: toolSearch });

  registry.register({
    name: "read_tool_output",
    description: "Read a chunk of a large tool result that was elided from model context. Pass the ref shown in the truncation marker and increase offset to continue.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^out_[a-f0-9]{16}$" },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 50000 }
      },
      required: ["ref"],
      additionalProperties: false
    },
    handler: async ({ ref, offset, maxChars }, context) => {
      if (!runtime.toolOutputs) throw new Error("Tool-output store is unavailable.");
      return runtime.toolOutputs.read(ref, {
        offset,
        maxChars,
        projectId: context?.__projectId ?? "default"
      });
    }
  });

  registry.register({
    name: "project_list",
    sideEffects: false,
    description: "List active projects and their bounded composition metadata. Project records contain secret references, never secret values.",
    parameters: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean" }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => requireProjectControlIdentity(
      runtime.projects,
      context,
      "Project listing"
    ),
    handler: async (args, context) => {
      const currentProjectId = requireProjectControlIdentity(
        runtime.projects,
        context,
        "Project listing"
      );
      if (currentProjectId && currentProjectId !== "default") {
        const project = runtime.projects?.get?.(currentProjectId, {
          includeArchived: args.includeArchived === true
        });
        return { projects: project ? [project] : [] };
      }
      return {
        projects: runtime.projects?.list?.({
          includeArchived: args.includeArchived === true
        }) ?? []
      };
    }
  });

  registry.register({
    name: "project_show",
    sideEffects: false,
    description: "Show one project's composition metadata and immutable session bindings.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" }
      },
      required: ["projectId"],
      additionalProperties: false
    },
    preflight: ({ projectId }, context) => assertProjectReadBoundary(
      runtime.projects,
      context,
      projectId
    ),
    handler: async ({ projectId }, context) => {
      assertProjectReadBoundary(runtime.projects, context, projectId);
      const project = runtime.projects?.get?.(projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      return project;
    }
  });

  registry.register({
    name: "project_create",
    metadata: { projectScope: "default" },
    description: "Create an isolated project workspace and its explicit memory, secret, skill, MCP, policy, hook, schedule, Kanban, session, and artifact boundaries.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        instructions: { type: "string" },
        secretRefs: { type: "array", items: { type: "string" } },
        activeSkills: { type: "array", items: { type: "string" } },
        mcpGrants: { type: "array", items: { type: "string" } },
        hookIds: { type: "array", items: { type: "string" } },
        modelProfile: { type: "object", additionalProperties: true },
        routingProfile: { type: "object", additionalProperties: true },
        policy: { type: "object", additionalProperties: true }
      },
      required: ["name"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Project creation"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Project creation");
      if (!runtime.projects?.create) throw new Error("Project store is unavailable.");
      return runtime.projects.create(args, {
        actor: context?.from ?? context?.agentId ?? "agent"
      });
    }
  });

  registry.register({
    name: "project_select",
    metadata: { projectScope: "default" },
    description: "Set the local presentation preference to an active project. This never rebinds the current session; authenticated requests must still carry the selected project id.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" }
      },
      required: ["projectId"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Project selection"
    ),
    handler: async ({ projectId }, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Project selection");
      if (!runtime.projects?.select) throw new Error("Project store is unavailable.");
      return runtime.projects.select(projectId, {
        actor: context?.from ?? context?.agentId ?? "agent"
      });
    }
  });

  registry.register({
    name: "project_update",
    metadata: { projectScope: "default" },
    description: "Update a project using compare-and-swap revision protection. Capability and policy changes invalidate stale tool contexts.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        patch: {
          type: "object",
          properties: {
            name: { type: "string" },
            instructions: { type: "string" },
            secretRefs: { type: "array", items: { type: "string" } },
            activeSkills: { type: "array", items: { type: "string" } },
            mcpGrants: { type: "array", items: { type: "string" } },
            hookIds: { type: "array", items: { type: "string" } },
            modelProfile: { type: "object", additionalProperties: true },
            routingProfile: { type: "object", additionalProperties: true },
            policy: { type: "object", additionalProperties: true }
          },
          additionalProperties: false
        }
      },
      required: ["projectId", "expectedRevision", "patch"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Project update"
    ),
    handler: async ({ projectId, expectedRevision, patch }, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Project update");
      if (!runtime.projects?.update) throw new Error("Project store is unavailable.");
      return runtime.projects.update(projectId, patch, {
        expectedRevision,
        actor: context?.from ?? context?.agentId ?? "agent"
      });
    }
  });

  registry.register({
    name: "project_archive",
    metadata: { projectScope: "default" },
    needsConfirmation: true,
    description: "Soft-archive a non-default project. Archived projects immediately reject new turns, tools, schedules, and deferred approvals.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["projectId", "expectedRevision"],
      additionalProperties: false
    },
    summarize: ({ projectId }) => `Archive project ${projectId}`,
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Project archive"
    ),
    handler: async ({ projectId, expectedRevision }, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Project archive");
      if (!runtime.projects?.archive) throw new Error("Project store is unavailable.");
      return runtime.projects.archive(projectId, {
        expectedRevision,
        actor: context?.__approval?.decider
          ?? context?.from
          ?? context?.agentId
          ?? "agent"
      });
    }
  });

  registry.register({
    name: "remember",
    description: "Save a piece of information to capacity-managed long-lived memory so it can be recalled in future turns. Use memoryClass='preference' only for stable user preferences; facts remain project-scoped. The built-in memory is always written first and, when configured, the fact is also mirrored to the external user model. If memory is full, use recall and retry with replaceIds from results marked replaceable to atomically replace overlapping items with one consolidated note.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to remember, in plain prose." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for retrieval."
        },
        importance: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Higher importance items resist decay and may promote to long-term memory."
        },
        memoryClass: {
          type: "string",
          enum: ["fact", "preference"],
          description: "Use preference only for a stable user-specific preference; defaults to fact in the active project memory scope."
        },
        replaceIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          uniqueItems: true,
          description: "Optional active curated memory IDs to atomically supersede with this consolidated note. Use after a capacity error."
        }
      },
      required: ["content"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const importance = args.importance ?? "normal";
      const memoryClass = args.memoryClass === "preference" ? "preference" : "fact";
      const replaceIds = validateReplaceIds(args.replaceIds);
      const risk = importance === "high" ? 0.8 : importance === "low" ? 0.2 : 0.45;
      const scope = memoryScopeForClass(context, memoryClass);
      const content = assertSafeMemoryContent(args.content, { runtime });
      const tags = normalizeMemoryTags(args.tags);
      const item = runtime.memory.remember(
        {
          source: context.channel ?? "tool",
          scope,
          content,
          tags: ["tool:remember", `memory:${memoryClass}`, ...tags],
          risk,
          repetition: 0.4,
          novelty: 0.55,
          metadata: {
            agentId: context.agentId,
            sessionId: context.sessionId,
            memoryClass,
            provenance: {
              sourceType: "explicit-memory-tool",
              trust: "direct-tool-request",
              sessionId: context.sessionId ?? null,
              projectId: context.__projectId ?? context.projectId ?? null
            }
          }
        },
        {
          source: "remember-tool",
          strength: importance === "high" ? 0.85 : 0.6,
          capacityManaged: true,
          replaceIds
        }
      );
      const external = await invokeExternalMemory(
        runtime.externalMemoryProvider,
        "setUserModel",
        {
          ...externalMemoryIdentity(context),
          content: item.content,
          metadata: {
            type: "memory",
            action: "remember",
            tags: item.tags ?? [],
            importance,
            memoryClass,
            localMemoryId: item.id,
            scope,
            sessionId: context.sessionId ?? null
          }
        },
        context?.__abortSignal
      );
      return {
        id: item.id,
        tier: item.tier,
        content: item.content,
        memoryClass,
        replaced: item.metadata?.replaces ?? [],
        ...(external.enabled ? { externalMemory: external.status } : {})
      };
    }
  });

  registry.register({
    name: "recall",
    sideEffects: false,
    description: "Search built-in memory for items related to a query and, when configured, query the external cross-session user model too. Local items are always returned even if the external provider is unavailable. Only replaceable IDs are valid in remember.replaceIds.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results to return." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const scope = typeof context?.__memoryScope === "string" && context.__memoryScope
        ? context.__memoryScope
        : context?.agentId && context.agentId !== "main" ? `specialist:${context.agentId}` : null;
      const effectiveScope = scope ?? "main";
      const query = String(args.query ?? "");
      const limit = args.limit ?? 5;
      const projectHits = runtime.memory.retrieve(query, { limit, scope });
      const profileScope = isProfileMemoryScope(context?.__profileMemoryScope)
        ? context.__profileMemoryScope
        : null;
      const profileHits = profileScope
        ? runtime.memory.retrieve(query, { limit, scope: profileScope, exactScope: true })
        : [];
      const hits = mergeMemoryHits(projectHits, profileHits, limit);
      const external = await invokeExternalMemory(
        runtime.externalMemoryProvider,
        "queryUserModel",
        { ...externalMemoryIdentity(context), query },
        context?.__abortSignal
      );
      const response = {
        count: hits.length,
        items: hits.map(({ item, score }) => ({
          id: item.id,
          tier: item.tier,
          score: Number(score.toFixed(3)),
          tags: item.tags,
          content: item.content,
          kind: item.kind ?? "raw",
          scope: item.scope ?? "main",
          curated: item.metadata?.capacityManaged === true,
          replaceable: item.metadata?.capacityManaged === true
            && ((item.scope ?? "main") === effectiveScope || (item.scope ?? "main") === profileScope),
          memoryClass: item.metadata?.memoryClass ?? (isProfileMemoryScope(item.scope) ? "preference" : "fact"),
          // Confidence signals: fidelity ("specific" = precise, trust details),
          // strength (decays unless reinforced), locked (a user correction).
          fidelity: item.fidelity ?? "normal",
          strength: Number((item.strength ?? 0).toFixed(2)),
          locked: Boolean(item.locked)
        }))
      };
      if (!external.enabled) return response;
      return {
        ...response,
        externalUserModel: external.status.status === "ok"
          ? externalUserModelValue(external.value)
          : null,
        externalMemory: external.status
      };
    }
  });

  registry.register({
    name: "memory_details",
    sideEffects: false,
    description: "Inspect one local memory without reinforcing it. Returns bounded provenance, confidence, correction, and replacement status so you can assess whether it is safe to rely on before taking action.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact memory id returned by recall." }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: (args, context = {}) => {
      if (typeof runtime.memory?.inspect !== "function") {
        throw new Error("The active memory system does not support read-only inspection.");
      }
      const projectScope = typeof context.__memoryScope === "string" && context.__memoryScope
        ? context.__memoryScope
        : context.agentId && context.agentId !== "main"
          ? `specialist:${context.agentId}`
          : "main";
      const profileScope = isProfileMemoryScope(context.__profileMemoryScope)
        ? context.__profileMemoryScope
        : null;
      const item = runtime.memory.inspect(args.id, { scope: projectScope })
        ?? (profileScope
          ? runtime.memory.inspect(args.id, { scope: profileScope, exactScope: true })
          : null);
      if (!item) return { found: false, id: String(args.id ?? "") };
      return {
        found: true,
        ...memoryDetailsView(item)
      };
    }
  });

  registry.register({
    name: "correct_memory",
    description: "Replace a stored memory that turned out to be WRONG. The built-in correction commits first and, when configured, the corrected fact is mirrored to the external user model. Hides the stale version from all future recall and locks in the corrected fact so the mistake never repeats. Use when the user corrects something previously stored or stated (a time, name, decision, preference) - do NOT just call remember with a second conflicting fact.",
    parameters: {
      type: "object",
      properties: {
        correction: { type: "string", description: "The corrected fact, stated fully and standalone (e.g. 'The Acme review meeting is at 4pm, not 3pm')." },
        query: { type: "string", description: "What the stale memory was about — used to find it (e.g. 'Acme review meeting time')." },
        id: { type: "string", description: "Exact memory id to supersede, when known (from a recall result). Takes precedence over query." },
        tags: { type: "array", items: { type: "string" }, description: "Optional extra tags for the correction." },
        memoryClass: {
          type: "string",
          enum: ["fact", "preference"],
          description: "Use preference only when correcting a user-profile memory returned by recall."
        }
      },
      required: ["correction"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.memory?.correct) return { error: "memory system does not support corrections" };
      const memoryClass = args.memoryClass === "preference" ? "preference" : "fact";
      const scope = memoryScopeForClass(context, memoryClass);
      const content = assertSafeMemoryContent(args.correction, { runtime });
      const result = runtime.memory.correct({
        id: args.id ?? null,
        query: args.query ?? null,
        content,
        tags: normalizeMemoryTags(args.tags),
        scope,
        source: "correct-memory-tool",
        metadata: {
          agentId: context.agentId,
          sessionId: context.sessionId,
          memoryClass,
          provenance: {
            sourceType: "explicit-memory-correction",
            trust: "direct-tool-request",
            sessionId: context.sessionId ?? null,
            projectId: context.__projectId ?? context.projectId ?? null
          }
        }
      });
      const external = await invokeExternalMemory(
        runtime.externalMemoryProvider,
        "setUserModel",
        {
          ...externalMemoryIdentity(context),
          content: result.item.content,
          metadata: {
            type: "memory",
            action: "correct",
            memoryClass,
            tags: result.item.tags ?? [],
            localMemoryId: result.item.id,
            supersededIds: result.superseded.map((item) => item.id),
            scope,
            sessionId: context.sessionId ?? null
          }
        },
        context?.__abortSignal
      );
      return {
        id: result.item.id,
        tier: result.item.tier,
        content: result.item.content,
        memoryClass,
        supersededCount: result.superseded.length,
        superseded: result.superseded.map((item) => ({ id: item.id, content: item.content.slice(0, 120) })),
        ...(external.enabled ? { externalMemory: external.status } : {})
      };
    }
  });

  registry.register({
    name: "schedule_message",
    description: "Schedule a future prompt that will be run through this agent. When fired, the result is delivered back to the originating channel (or a target you specify). Use for reminders, recurring check-ins, or scheduled work.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt the agent should run when this fires." },
        delaySeconds: { type: "integer", minimum: 30, description: "One-shot: fire this many seconds from now." },
        intervalSeconds: { type: "integer", minimum: 30, description: "Recurring: fire every N seconds." },
        dailyAt: { type: "string", description: "Recurring HH:MM (24h) daily fire time, e.g. '09:00'." },
        channel: { type: "string", description: "Channel to deliver to: local, telegram. Defaults to the originating channel." },
        target: { type: "string", description: "Channel target (phone number, chat id, etc). Defaults to the originating sender." },
        name: { type: "string", description: "Optional human-readable name." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.cron) throw new Error("Cron scheduler is not available.");
      const jobId = createId("job");
      const projectId = context?.__projectId ?? "default";
      const job = {
        id: jobId,
        name: args.name ?? `prompt-${nowIso()}`,
        enabled: true,
        task: "prompt",
        replace: true,
        input: {
          prompt: String(args.prompt ?? "").trim(),
          channel: args.channel ?? context.channel ?? "local",
          target: args.target ?? context.from ?? context.target ?? null,
          agentId: context.agentId ?? "main",
          sessionId: context.sessionId,
          projectId,
          projectRevision: context?.__projectRevision ?? 1,
          oneShot: Boolean(args.delaySeconds && !args.intervalSeconds && !args.dailyAt)
        }
      };
      if (args.delaySeconds) {
        job.intervalMs = args.delaySeconds * 1000;
        job.nextRunAt = new Date(Date.now() + args.delaySeconds * 1000).toISOString();
      } else if (args.intervalSeconds) {
        job.intervalMs = args.intervalSeconds * 1000;
      } else if (args.dailyAt) {
        job.dailyAt = args.dailyAt;
      } else {
        throw new Error("Provide one of delaySeconds, intervalSeconds, or dailyAt.");
      }
      let created = runtime.cron.addJob(job);
      if (runtime.projects?.attachResource) {
        let attachedByThisCall = true;
        try {
          const currentProject = runtime.projects.get?.(projectId, {
            includeArchived: false
          });
          attachedByThisCall = !currentProject?.scheduleIds?.includes(created.id);
          const attachedProject = runtime.projects.attachResource(
            projectId,
            "scheduleIds",
            created.id,
            { actor: context?.from ?? "tool:schedule_message" }
          );
          const pinnedRevision = attachedProject?.revision
            ?? context?.__projectRevision
            ?? 1;
          if (created.input?.projectRevision !== pinnedRevision) {
            const patch = {
              input: {
                ...created.input,
                projectRevision: pinnedRevision
              }
            };
            created = typeof runtime.cron.updateJob === "function"
              ? runtime.cron.updateJob(created.id, patch)
              : runtime.cron.addJob({ ...created, ...patch, replace: true });
          }
        } catch (error) {
          if (attachedByThisCall) {
            try {
              runtime.projects.detachResource?.(
                projectId,
                "scheduleIds",
                created.id,
                { actor: context?.from ?? "tool:schedule_message:rollback" }
              );
            } catch {
              // Best effort: the orphaned attachment has no runnable job.
            }
          }
          runtime.cron.removeJob?.(created.id);
          throw error;
        }
      }
      return { id: created.id, name: created.name, nextRunAt: created.nextRunAt, task: created.task };
    }
  });

  registry.register({
    name: "send_message",
    description: "Proactively send a message to a user via a channel (telegram or local). Use during autopilot pulses or when you decide to reach out unprompted. Returns delivery status.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["telegram", "local"], description: "Channel to deliver via." },
        target: { type: "string", description: "Channel target — chat id for Telegram." },
        text: { type: "string", description: "Message body. Keep it short and useful." }
      },
      required: ["channel", "target", "text"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.channels?.deliver) throw new Error("Channels are not bound to runtime.");
      return runtime.channels.deliver({
        channel: args.channel,
        target: args.target,
        text: args.text,
        sessionId: context.sessionId ?? null,
        projectId: context.__projectId ?? "default"
      });
    }
  });

  registry.register({
    name: "recall_activity",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Search the user-global ambient capture log (window titles + app focus events + OCR text from screen frames). Ambient capture belongs to the default project control plane and is unavailable inside isolated nondefault projects. Use this when the user asks what they were doing at a specific time. Returns rows with timestamp, app, window, and matching snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across OCR text and window titles. Empty returns recent activity." },
        since: { type: "string", description: "ISO 8601 lower bound (inclusive)." },
        until: { type: "string", description: "ISO 8601 upper bound (inclusive)." },
        app: { type: "string", description: "Filter to a specific app (e.g. 'com.apple.Safari' or 'Linear')." },
        machine: { type: "string", description: "Filter to observations captured on one machine (its sourceMachineId). Omit to search every machine." },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Ambient activity recall"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(
        runtime.projects,
        context,
        "Ambient activity recall"
      );
      if (!runtime.observations) return { error: "no observation store" };
      const results = await runtime.observations.search({
        query: args.query ?? null,
        since: args.since ?? null,
        until: args.until ?? null,
        app: args.app ?? null,
        machine: args.machine ?? null,
        limit: args.limit ?? 25
      });
      return { count: results.length, results };
    }
  });

  registry.register({
    name: "recall_spend",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Summarize LLM credit (USD) usage: how much has been spent, on what activity/model, and the costliest recent calls. Use to answer questions about cost/credits/budget — e.g. 'why did I spend $4 today?'.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30, description: "Look-back window in days (default 1 = today; the local ledger retains 30 days)." }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Credit ledger recall"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Credit ledger recall");
      const ledger = runtime.budget?.ledger;
      if (!ledger) return { error: "no credit ledger available" };
      // Clamp to the retained window so the reported `days` matches the data.
      const days = Math.min(args.days ?? 1, ledger.retentionDays ?? 30);
      const analytics = ledger.analytics({ days });
      const top = ledger.query({ days })
        .slice()
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
        .slice(0, 10)
        .map((r) => ({ at: r.at, model: r.model, activity: r.channel, agentId: r.agentId, usd: Number((r.usd ?? 0).toFixed(4)), tools: r.tools ?? [] }));
      return { days, totalUsd: analytics.totalUsd, calls: analytics.totalCalls, byActivity: analytics.byActivity, byModel: analytics.byModel, top };
    }
  });

  registry.register({
    name: "list_sessions",
    sideEffects: false,
    description: "List recent conversations across channels.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      const projectId = context?.__projectId ?? "default";
      const sessions = (runtime.agentHost?.store.listSessions() ?? [])
        .filter((session) => projectOwnsSession(
          runtime.projects,
          session.id,
          projectId
        ));
      return sessions.slice(0, args.limit ?? 10);
    }
  });

  registry.register({
    name: "search_sessions",
    sideEffects: false,
    description: "Full-text search your own past conversations (chat transcripts across all sessions and channels). Use when the user asks what was said, decided, or promised earlier — e.g. 'what did we decide about X last week?'. Returns matching messages with session id, timestamp (UTC), role, and a short snippet; use list_sessions for session metadata. The raw transcript is ground truth — prefer this over recall when the user references a specific past exchange.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across past conversation messages." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum results to return (default 8)." },
        role: { type: "string", enum: ["user", "assistant", "tool"], description: "Optional exact message-role filter." },
        sessionId: { type: "string", description: "Optional exact session id filter." },
        since: { type: "string", description: "Optional inclusive ISO timestamp lower bound." },
        until: { type: "string", description: "Optional inclusive ISO timestamp upper bound." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.sessionIndex) return { error: "no session index" };
      const projectId = context?.__projectId ?? "default";
      if (
        args.sessionId
        && !projectOwnsSession(runtime.projects, args.sessionId, projectId)
      ) {
        throw new Error("Session is outside the current project.");
      }
      const requestedLimit = args.limit ?? 8;
      const results = await runtime.sessionIndex.search(String(args.query ?? ""), {
        limit: Math.min(100, requestedLimit * 8),
        role: args.role ?? null,
        sessionId: args.sessionId ?? null,
        since: args.since ?? null,
        until: args.until ?? null
      });
      const visible = results
        .filter((result) => projectOwnsSession(
          runtime.projects,
          result.sessionId,
          projectId
        ))
        .slice(0, requestedLimit);
      return {
        count: visible.length,
        results: visible.map((r) => ({
          sessionId: r.sessionId,
          at: r.ts,
          when: String(r.ts ?? "").slice(0, 16).replace("T", " "),
          role: r.role,
          snippet: r.snippet
        }))
      };
    }
  });

  registry.register({
    name: "list_skills",
    sideEffects: false,
    description: "List the skills (named prompts) available to this agent.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => {
      const skills = (runtime.skills?.list?.() ?? [])
        .filter((skill) => projectGrantAllows(context?.__projectActiveSkills, skill.name));
      return { count: skills.length, items: skills.map((s) => ({ name: s.name, description: s.description })) };
    }
  });

  registry.register({
    name: "replay_skill",
    // Drives the user's Mac (AppleScript / keyboard / app control) — always
    // route through the pending-actions approval queue, same as
    // register_mcp_server and restart_daemon. sideEffects is the default but
    // is declared explicitly so an audit of gate flags reads unambiguously.
    needsConfirmation: true,
    sideEffects: true,
    preflight: (args, context) => assertProjectGrant(
      context?.__projectActiveSkills,
      args.name,
      "Skill",
      context?.__projectId
    ),
    summarize: (args) =>
      `Replay skill '${args.name}' on the Mac${args.dryRun ? " (dry run — logs only)" : " (AppleScript/keyboard control)"}`,
    description: "Trigger a skill's structured replay steps (open_app, keyboard_shortcut, type, applescript, etc.) on the user's Mac. Use only for skills with a `replay:` block in their SKILL.md. Set dryRun:true to log actions without executing — recommended for first-time use. THIS REQUIRES USER APPROVAL — calls return {status:'awaiting_confirmation'} and run only after the user approves via the dashboard's Approvals tab.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        dryRun: { type: "boolean", description: "Log what would happen without doing it." }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.skillReplay) throw new Error("Skill replay not available.");
      assertProjectGrant(
        context?.__projectActiveSkills,
        args.name,
        "skill",
        context?.__projectId
      );
        return runtime.skillReplay.run({
          skill: args.name,
          dryRun: args.dryRun ?? false,
          projectId: context?.__projectId ?? "default"
        });
    }
  });

  registry.register({
    name: "run_skill",
    description: "Run a named skill with the given input. Returns the skill's output.",
    preflight: (args, context) => assertProjectGrant(
      context?.__projectActiveSkills,
      args.name,
      "Skill",
      context?.__projectId
    ),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (see list_skills)." },
        input: { type: "string", description: "Free-text input the skill should operate on." },
        args: { type: "object", description: "Optional structured arguments the skill expects.", additionalProperties: true }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.skills) throw new Error("Skills are not configured.");
      assertProjectGrant(
        context?.__projectActiveSkills,
        args.name,
        "skill",
        context?.__projectId
      );
      return runtime.skills.run(args.name, { input: args.input, args: args.args ?? {} }, context);
    }
  });

  registry.register({
    name: "list_mcp_tools",
    sideEffects: false,
    description: "List tools exposed by connected MCP servers — INCLUDING ones not advertised directly as functions (large servers are capped to keep the tool list within provider limits). Use this to discover a tool, then call it with run_mcp_tool.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => {
      const tools = (runtime.mcp?.listTools?.() ?? [])
        .filter((tool) => (
          projectGrantAllows(context?.__projectMcpGrants, tool.server)
          && projectRequiredSecretsAllowed(context, tool.requiredSecretRefs)
        ));
      return { count: tools.length, items: tools };
    }
  });

  registry.register({
    name: "searcmcp_tools",
    sideEffects: false,
    description: "Search the complete MCP tool catalog by server, name, or description, including tools omitted from the direct model-tool cap.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or short phrase to search for." },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async ({ query, limit = 20 }, context) => {
      const text = String(query ?? "").trim();
      if (!text) return { query: text, count: 0, items: [] };
      const items = (runtime.mcp?.listTools?.() ?? [])
        .filter((tool) => (
          projectGrantAllows(context?.__projectMcpGrants, tool.server)
          && projectRequiredSecretsAllowed(context, tool.requiredSecretRefs)
        ))
        .map((tool) => ({
          tool,
          score: tokenOverlapScore(text, `${tool.server} ${tool.name} ${tool.registeredName ?? ""} ${tool.description ?? ""}`)
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || String(a.tool.registeredName ?? a.tool.name).localeCompare(String(b.tool.registeredName ?? b.tool.name)))
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
        .map(({ tool, score }) => ({
          server: tool.server,
          name: tool.name,
          registeredName: tool.registeredName,
          description: tool.description ?? "",
          connected: Boolean(tool.connected),
          score
        }));
      return { query: text, count: items.length, items };
    }
  });

  registry.register({
    name: "run_mcp_tool",
    description: "Invoke a tool on a connected MCP server. Use this for any MCP tool that isn't available as a direct function (large servers like PostHog are reached this way). Call list_mcp_tools first if unsure of the exact server/tool name.",
    preflight: (args, context) => assertProjectGrant(
      context?.__projectMcpGrants,
      args.server,
      "MCP server",
      context?.__projectId
    ) ?? assertProjectRequiredSecrets(
      context,
      runtime.mcp?.requiredSecretRefs?.(args.server) ?? [],
      `MCP server '${args.server}'`
    ),
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name." },
        tool: { type: "string", description: "Tool name (must exist on that server)." },
        args: { type: "object", description: "Arguments to pass to the tool.", additionalProperties: true }
      },
      required: ["server", "tool"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.mcp?.callTool) throw new Error("MCP execution is not available.");
      assertProjectGrant(
        context?.__projectMcpGrants,
        args.server,
        "MCP server",
        context?.__projectId
      );
      assertProjectRequiredSecrets(
        context,
        runtime.mcp?.requiredSecretRefs?.(args.server) ?? [],
        `MCP server '${args.server}'`
      );
      return runtime.mcp.callTool(args.server, args.tool, args.args ?? {});
    }
  });

  // ─── Admin tools — let the agent manage its own setup ───────────────────

  registry.register({
    name: "register_mcp_server",
    metadata: { projectScope: "default" },
    description: "Add a new MCP server to the registry. Three transport+auth shapes: stdio (spawn a local process), http+bearer (URL with a ${VAR} secret reference), http+oauth (URL with browser-based OAuth). Store credentials through the authenticated secrets surface first; never pass a literal secret to this tool. After registering, the user typically needs to call connect_mcp_server. THIS REQUIRES USER APPROVAL - registering an MCP can mean spawning an arbitrary process or contacting an arbitrary host. Prefer connect_catalog_mcp when the server is already in the curated catalog.",
    needsConfirmation: true,
    preflight: (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP registration");
      return preflightRegisterMcpServer(args);
    },
    // Summary is what shows in the menu-bar notification and dashboard
    // approval card header. Critically include the fields that determine
    // whether the action is dangerous: the stdio command + first few args,
    // or the http URL. Hiding these in the args details would let a prompt-
    // injected agent slip a malicious `docker run -v $HOME:/host …` past a
    // user who only glances at the notification.
    summarize: (args) => summarizeRegisterMcpServer(args),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique server name." },
        transport: { type: "string", enum: ["stdio", "http"], description: "stdio or http." },
        // stdio
        command: { type: "string", description: "stdio: command to spawn (e.g. 'npx')." },
        args: { type: "array", items: { type: "string" }, description: "stdio: command arguments." },
        // http
        url: { type: "string", description: "http: MCP endpoint URL." },
        auth: { type: "string", enum: ["none", "bearer", "oauth"], description: "http: auth mode." },
        apiKey: {
          type: "string",
          pattern: "^\\$\\{[A-Z_][A-Z0-9_]*\\}$",
          description: "http+bearer: exact ${ENV_VAR} reference only. Add the value through /secrets or authenticated setup; never put the value here."
        },
        clientId: { type: "string", description: "http+oauth: pre-registered client ID for servers without dynamic registration." },
        scope: { type: "string", description: "http+oauth: requested scopes." },
        trustLevel: { type: "string", enum: ["trusted", "untrusted"], description: "Default trusted." }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP registration");
      if (!runtime.mcp?.registerServer) throw new Error("MCP registry not available.");
      const server = runtime.mcp.registerServer({
        name: args.name,
        transport: args.transport,
        command: args.command,
        args: args.args ?? [],
        url: args.url,
        auth: args.auth,
        apiKey: args.apiKey,
        clientId: args.clientId,
        scope: args.scope,
        trustLevel: args.trustLevel ?? "trusted"
      });
      return { name: server.name, transport: server.transport, auth: server.auth };
    }
  });

  registry.register({
    name: "connect_mcp_server",
    metadata: { projectScope: "default" },
    description: "Spawn / connect to a registered MCP server and discover its tools. For OAuth servers, this triggers the browser-based auth flow; the user will need to complete it in their browser. Returns immediately; check list_mcp_tools afterward to see what's available.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Registered server name." } },
      required: ["name"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "MCP connection"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP connection");
      if (!runtime.mcp?.connect) throw new Error("MCP registry not available.");
      // Fire and forget — OAuth can take minutes.
      runtime.mcp.connect(args.name).catch(() => { /* surfaced via SSE */ });
      return { name: args.name, status: "connecting", note: "If this server uses OAuth, an auth URL will appear in the dashboard's MCP tab." };
    }
  });

  registry.register({
    name: "disconnect_mcp_server",
    metadata: { projectScope: "default" },
    description: "Close the connection to an MCP server (kills the stdio child or drops the HTTP session).",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "MCP disconnection"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP disconnection");
      if (!runtime.mcp?.disconnect) throw new Error("MCP registry not available.");
      const ok = await runtime.mcp.disconnect(args.name);
      return { name: args.name, disconnected: ok };
    }
  });

  registry.register({
    name: "list_cron_jobs",
    sideEffects: false,
    description: "List scheduled jobs owned by the current project.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => scopedCronJobs(runtime, context).jobs
  });

  // Resolve a cron job by exact id first, then by exact name, then by a
  // unique case-insensitive name match. Returns { job } or { error } so the
  // LLM gets an actionable message (e.g. "turn off nightly-qa" by name) rather
  // than a silent no-op. Ambiguous name matches are refused, not guessed.
  const resolveCronJob = (idOrName, context) => {
    if (!runtime.cron) return { error: "Cron scheduler is not available." };
    const needle = String(idOrName ?? "").trim();
    if (!needle) return { error: "Provide a cron job id or name." };
    const scope = scopedCronJobs(runtime, context);
    const jobs = scope.jobs;
    const byId = jobs.find((j) => j.id === needle);
    if (byId) return { job: byId, scope };
    const exactName = jobs.filter((j) => j.name === needle);
    if (exactName.length === 1) return { job: exactName[0], scope };
    const lower = needle.toLowerCase();
    const ci = jobs.filter((j) => (j.name ?? "").toLowerCase() === lower || j.id.toLowerCase() === lower);
    if (ci.length === 1) return { job: ci[0], scope };
    if (ci.length > 1 || exactName.length > 1) {
      return { error: `Ambiguous: "${needle}" matches ${(ci.length || exactName.length)} jobs. Use the exact id from list_cron_jobs.` };
    }
    return { error: `No cron job matches "${needle}". Use list_cron_jobs to see valid ids/names.` };
  };

  registry.register({
    name: "cancel_cron_job",
    description: "Permanently DELETE a scheduled cron job by id or name. This is irreversible — to temporarily turn a job off (and keep the option to turn it back on), use set_cron_job_enabled instead. Use list_cron_jobs first to find the id/name.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The cron job id (preferred) or its exact name." }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const found = resolveCronJob(args.id, context);
      if (found.error) return { id: args.id, removed: false, error: found.error };
      if (
        found.scope.project
        && runtime.projects?.detachResource
      ) {
        runtime.projects.detachResource(
          found.scope.projectId,
          "scheduleIds",
          found.job.id,
          { actor: context?.from ?? "tool:cancel_cron_job" }
        );
      }
      const removed = runtime.cron.removeJob(found.job.id);
      return { id: found.job.id, name: found.job.name, removed };
    }
  });

  registry.register({
    name: "set_cron_job_enabled",
    description: "Turn a scheduled cron job OFF or ON without deleting it. Set enabled=false to pause a job (it stops firing but is preserved and can be re-enabled later); set enabled=true to resume it. This is the right tool when asked to 'turn off', 'pause', 'disable', 'stop', or 're-enable' a recurring job. Accepts the job id or its exact name. Use list_cron_jobs to see current jobs and their enabled state.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The cron job id (preferred) or its exact name." },
        enabled: { type: "boolean", description: "false = turn off/pause; true = turn on/resume." }
      },
      required: ["id", "enabled"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const found = resolveCronJob(args.id, context);
      if (found.error) return { id: args.id, enabled: null, ok: false, error: found.error };
      const job = runtime.cron.enableJob(found.job.id, Boolean(args.enabled));
      return {
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        nextRunAt: job.nextRunAt,
        ok: true
      };
    }
  });

  registry.register({
    name: "get_audit",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Get a structural health snapshot of the runtime: specialist counts, memory tier saturation, outcome quality (7d/30d), upcoming cron jobs, MCP servers, and any actionable findings (warn/err severity). Use this when the user asks 'how are you doing' or 'what's wrong'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Runtime audit"
    ),
    handler: async (_args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Runtime audit");
      return runtime.introspector?.audit() ?? { error: "no introspector" };
    }
  });

  registry.register({
    name: "list_checkpoints",
    sideEffects: false,
    description: "List recent file checkpoints for this session, including bounded diff previews. Checkpoints exist only when OPENAGI_CHECKPOINTS=1.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20 },
        directory: { type: "string", description: "Optional directory filter." }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.checkpoints) return { enabled: false, checkpoints: [] };
      const checkpoints = await runtime.checkpoints.list({
        limit: args.limit ?? 10,
        sessionId: context?.sessionId ?? null,
        directory: args.directory ?? null,
        ...(context?.__projectId ? { projectId: context.__projectId } : {})
      });
      const withPreviews = await Promise.all(checkpoints.map(async (checkpoint) => ({
        ...checkpoint,
        preview: context?.__projectId
          ? await runtime.checkpoints.preview(checkpoint.id, {
              projectId: context.__projectId
            })
          : await runtime.checkpoints.preview(checkpoint.id)
      })));
      return {
        enabled: true,
        count: checkpoints.length,
        checkpoints: withPreviews
      };
    }
  });

  registry.register({
    name: "rollback",
    needsConfirmation: true,
    description: "Restore one file or every file in a checkpoint. Always inspect list_checkpoints first; rollback requires human confirmation.",
    parameters: {
      type: "object",
      properties: {
        checkpointId: { type: "string", description: "Checkpoint id from list_checkpoints." },
        path: { type: "string", description: "Optional single file to restore; omit to restore the whole checkpoint." }
      },
      required: ["checkpointId"],
      additionalProperties: false
    },
    summarize: (args) => `Rollback checkpoint ${args.checkpointId}${args.path ? ` file ${args.path}` : ""}`,
    handler: async (args, context) => {
      if (!runtime.checkpoints) throw new Error("Checkpoints are disabled. Set OPENAGI_CHECKPOINTS=1 and restart.");
      const result = await runtime.checkpoints.rollback(args.checkpointId, {
        path: args.path ?? null,
        decidedBy: context?.__approval?.decider
          ?? context?.__approval?.decidedBy
          ?? context?.from
          ?? "user",
        ...(context?.__projectId ? { projectId: context.__projectId } : {}),
        ...(context?.sessionId != null ? { sessionId: context.sessionId } : {})
      });
      if (!result) throw new Error(`Checkpoint not found: ${args.checkpointId}`);
      return result;
    }
  });

  registry.register({
    name: "get_budget",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Get today's LLM spend, daily limit, calls, and token counts. Returns 14 days of history.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Global budget inspection"
    ),
    handler: async (_args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Global budget inspection");
      return runtime.budget?.status?.() ?? { error: "no budget" };
    }
  });

  registry.register({
    name: "set_provider",
    metadata: { projectScope: "default" },
    description: "Switch the primary model provider live. 'auto' picks a configured direct provider, while 'anthropic', 'openai', and 'moa' select that provider explicitly. MoA uses OPENAGI_MOA_PRESET. Use this if the user wants to switch models mid-conversation or you detect repeated failures with the current one.",
    parameters: {
      type: "object",
      properties: {
        preference: { type: "string", enum: ["auto", ...MODEL_PROVIDER_IDS] }
      },
      required: ["preference"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Model provider selection"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(
        runtime.projects,
        context,
        "Model provider selection"
      );
      if (!isModelProviderId(args.preference, { includeAuto: true })) {
        throw new Error(`Invalid model provider: ${args.preference}`);
      }
      const { createModelProvider } = await import("./model-provider.js");
      const nextProvider = createModelProvider({
        preferred: args.preference,
        moa: { preset: process.env.OPENAGI_MOA_PRESET },
        budgetGuard: runtime.budget,
        secrets: runtime.secrets,
        dataDir: runtime.secrets?.dataDir
      });
      process.env.OPENAGI_PROVIDER = args.preference;
      if (runtime.agentHost) {
        runtime.agentHost.modelProvider = nextProvider;
      }
      // Persist
      try {
        const { saveEnv } = await import("./setup-wizard.js");
        saveEnv({
          values: { OPENAGI_PROVIDER: args.preference },
          store: runtime.secrets,
          decidedBy: "agent:set_provider"
        });
      } catch { /* ignore */ }
      return {
        preference: args.preference,
        current: runtime.agentHost?.modelProvider?.constructor?.name,
        model: runtime.agentHost?.modelProvider?.model
      };
    }
  });

  // ─── Tasks (user todo list + agent queue) ──────────────────────────────

  // Kanban is the local multi-agent coordination board. Every mutation
  // remains inside the normal registry path so scrutiny, hooks, approvals,
  // checkpoints, and activity observers see the real tool name.

  registry.register({
    name: "kanban_show",
    sideEffects: false,
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Show one local Kanban task with blockers, comments, run attempts, handoffs, links, and timestamps.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Kanban task id." }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async ({ taskId }, context) => {
      return requireProjectKanbanTask(runtime, taskId, context);
    }
  });

  registry.register({
    name: "kanban_list",
    sideEffects: false,
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "List local Kanban boards and tasks. Filter by board, status, or assignee.",
    parameters: {
      type: "object",
      properties: {
        board: { type: "string", description: "Optional board id." },
        status: {
          type: "string",
          enum: ["backlog", "in-progress", "blocked", "review", "done"]
        },
        assignee: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.kanban?.boardView) throw new Error("Kanban store is unavailable.");
      assertProjectBoardArgument(args.board, context);
      return runtime.kanban.boardView({
        ...args,
        board: projectKanbanBoard(context)
      });
    }
  });

  registry.register({
    name: "kanban_create",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Create a task on the local multi-agent Kanban board. Assign it now when the intended worker is known; parent task ids become blockers.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        body: { type: "string", description: "Optional detailed task body." },
        board: { type: "string", description: "ASCII board id. Defaults to 'default'." },
        boardName: { type: "string", description: "Display name when creating a new board." },
        assignee: { type: "string", description: "Agent or worker name." },
        status: {
          type: "string",
          enum: ["backlog", "in-progress", "blocked", "review", "done"]
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          maxItems: 100,
          description: "Parent task ids that must finish before this task can complete."
        },
        reason: { type: "string", description: "Optional initial blocking reason." }
      },
      required: ["title"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.kanban?.createTask) throw new Error("Kanban store is unavailable.");
      assertProjectBoardArgument(args.board, context);
      for (const blockerId of args.blockedBy ?? []) {
        await requireProjectKanbanTask(runtime, blockerId, context);
      }
      return runtime.kanban.createTask({
        ...args,
        board: projectKanbanBoard(context)
      }, context);
    }
  });

  registry.register({
    name: "kanban_complete",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Complete a Kanban task and write its structured completion handoff. Tasks with unresolved blockers cannot complete.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        summary: { type: "string", description: "What was delivered or learned." },
        handoffTo: { type: "string", description: "Optional next owner or reviewer." },
        metadata: {
          type: "object",
          description: "Optional structured handoff metadata.",
          additionalProperties: true
        }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async ({ taskId, ...input }, context) => {
      if (!runtime.kanban?.completeTask) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, taskId, context);
      return runtime.kanban.completeTask(taskId, input, context);
    }
  });

  registry.register({
    name: "kanban_block",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Move a Kanban task to blocked. Optionally record parent task ids and a reason.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          maxItems: 100
        },
        reason: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async ({ taskId, ...input }, context) => {
      if (!runtime.kanban?.blockTask) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, taskId, context);
      for (const blockerId of input.blockedBy ?? []) {
        await requireProjectKanbanTask(runtime, blockerId, context);
      }
      return runtime.kanban.blockTask(taskId, input, context);
    }
  });

  registry.register({
    name: "kanban_unblock",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Remove a Kanban task's blocking state. Pass blockerId to remove one dependency; omit it to clear every blocker.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        blockerId: { type: "string" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async ({ taskId, blockerId }, context) => {
      if (!runtime.kanban?.unblockTask) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, taskId, context);
      if (blockerId) await requireProjectKanbanTask(runtime, blockerId, context);
      return runtime.kanban.unblockTask(taskId, { blockerId }, context);
    }
  });

  registry.register({
    name: "kanban_comment",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Add a comment to a Kanban task. The author is derived from the trusted agent identity.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        body: { type: "string" }
      },
      required: ["taskId", "body"],
      additionalProperties: false
    },
    handler: async ({ taskId, body }, context) => {
      if (!runtime.kanban?.commentTask) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, taskId, context);
      return runtime.kanban.commentTask(taskId, body, context);
    }
  });

  registry.register({
    name: "kanban_heartbeat",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Claim a Kanban task or update a worker run. state='start' appends a new attempt; later heartbeats update that run by runId.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        runId: { type: "string" },
        state: {
          type: "string",
          enum: ["start", "heartbeat", "review", "succeeded", "failed"]
        },
        assignee: { type: "string" },
        reason: { type: "string" },
        detail: {
          description: "Short string or structured liveness/progress detail.",
          anyOf: [
            { type: "string" },
            { type: "object", additionalProperties: true }
          ]
        }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async ({ taskId, ...input }, context) => {
      if (!runtime.kanban?.heartbeatTask) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, taskId, context);
      return runtime.kanban.heartbeatTask(taskId, input, context);
    }
  });

  registry.register({
    name: "kanban_link",
    domainResultStatuses: KANBAN_DOMAIN_STATUSES,
    description: "Link a parent Kanban task to a child dependency. The child stays blocked until every parent task is done.",
    parameters: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "Task that must finish first." },
        childId: { type: "string", description: "Task that depends on the parent." }
      },
      required: ["parentId", "childId"],
      additionalProperties: false
    },
    handler: async ({ parentId, childId }, context) => {
      if (!runtime.kanban?.linkTasks) throw new Error("Kanban store is unavailable.");
      await requireProjectKanbanTask(runtime, parentId, context);
      await requireProjectKanbanTask(runtime, childId, context);
      return runtime.kanban.linkTasks(parentId, childId, context);
    }
  });

  registry.register({
    name: "add_task",
    metadata: { projectScope: "default" },
    domainResultStatuses: TASK_DOMAIN_STATUSES,
    description: "Add a task to the user's todo list (default) or the agent's own queue. Use queue='agent' when YOU are committing to do this task yourself; use queue='user' when the human should do it. Buckets: today, this_week, this_month, this_quarter, this_year, someday, done — pick the one matching the realistic horizon.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (max 200 chars)." },
        description: { type: "string", description: "Optional longer description / notes." },
        queue: { type: "string", enum: ["user", "agent"], description: "Default 'user'. Use 'agent' to enqueue work for yourself." },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"], description: "Default 'today'." },
        priority: { type: "integer", minimum: 0, maximum: 100, description: "0-100, higher is more urgent. Default 50." },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        dueDate: { type: "string", description: "ISO 8601 due date (optional)." },
        sourceMeta: { type: "object", description: "Where this task came from — e.g. {sessionId, snippet}." },
        parentGoalId: { type: "string", description: "Optional — link the task to a parent goal. Use list_goals first to find the right id." },
        dependsOn: { type: "array", items: { type: "string" }, description: "Optional — task ids that must complete before this one is actionable. Task starts in 'blocked' status until all deps complete, then auto-flips to 'pending' and the daily recap surfaces it as 'Unblocked'." }
      },
      required: ["title"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Task creation"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Task creation");
      if (!runtime.tasks?.add) throw new Error("task store not available");
      const queue = args.queue === "agent" ? "agent" : "user";
      const sourceMeta = args.sourceMeta ?? (context.sessionId ? { sessionId: context.sessionId } : null);
      const task = runtime.tasks.add({ ...args, sourceMeta }, { source: "agent", queue });
      return { id: task.id, queue: task.queue, bucket: task.bucket, title: task.title };
    }
  });

  registry.register({
    name: "list_tasks",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "List tasks. Filter by queue (user/agent), bucket (today / this_week / this_month / this_quarter / this_year / someday / done), or status (pending/in_progress/blocked/completed/cancelled).",
    parameters: {
      type: "object",
      properties: {
        queue: { type: "string", enum: ["user", "agent"] },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"] },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Task listing"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Task listing");
      if (!runtime.tasks?.list) return { error: "task store not available" };
      const tasks = runtime.tasks.list(args);
      return { count: tasks.length, tasks };
    }
  });

  registry.register({
    name: "complete_task",
    metadata: { projectScope: "default" },
    domainResultStatuses: TASK_DOMAIN_STATUSES,
    description: "Mark a task as completed. Moves it to the 'done' bucket.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        completedVia: { type: "string", description: "Why/how it was completed (e.g. 'manual', 'observed-rize-activity', 'linear-webhook')." }
      },
      required: ["id"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Task completion"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Task completion");
      const task = runtime.tasks.complete(args.id, args.completedVia ?? "agent");
      return task ? { id: task.id, status: task.status } : { error: "unknown task" };
    }
  });

  registry.register({
    name: "move_task",
    metadata: { projectScope: "default" },
    domainResultStatuses: TASK_DOMAIN_STATUSES,
    description: "Update a task — change bucket, priority, status, due date, etc. without completing it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"] },
        priority: { type: "integer", minimum: 0, maximum: 100 },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        dueDate: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["id"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Task update"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Task update");
      const { id, ...patch } = args;
      const task = runtime.tasks.update(id, patch);
      return task ? task : { error: "unknown task" };
    }
  });

  registry.register({
    name: "add_goal",
    metadata: { projectScope: "default" },
    domainResultStatuses: GOAL_DOMAIN_STATUSES,
    description: "Create a Goal that tasks can be grouped under for rollup tracking. Goals have a title, optional description, optional dueDate, and optional parentGoalId (goals can nest, e.g. a quarter goal contains monthly goals).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        dueDate: { type: "string", description: "ISO 8601 date." },
        parentGoalId: { type: "string", description: "Optional — links this goal under a parent goal for nested rollups." }
      },
      required: ["title"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Goal creation"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Goal creation");
      const goal = runtime.tasks.addGoal(args);
      const sessionId = context?.sessionId;
      if (!sessionId || typeof runtime.goals?.activate !== "function") return goal;
      const objective = goal.description
        ? `${goal.title}: ${goal.description}`
        : goal.title;
      const goalMode = runtime.goals.activate(sessionId, { goalId: goal.id, objective });
      return { ...goal, goalMode };
    }
  });

  registry.register({
    name: "list_goals",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "List goals with optional status filter. Use to see what longer-term threads exist before adding more tasks — a task linked to an existing goal is more useful than a free-floating one.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "completed", "cancelled", "deferred"] },
        includeProgress: { type: "boolean", description: "If true, include rollup {done, total, percent} per goal. Default false for cheaper calls." }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Goal listing"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Goal listing");
      const goals = runtime.tasks.listGoals({ status: args.status });
      if (args.includeProgress) {
        return goals.map((g) => ({ ...g, progress: runtime.tasks.goalProgress(g.id) }));
      }
      return goals;
    }
  });

  registry.register({
    name: "link_task_to_goal",
    metadata: { projectScope: "default" },
    domainResultStatuses: TASK_DOMAIN_STATUSES,
    description: "Link an existing task to a goal so it counts toward that goal's rollup progress. Pass goalId=null to unlink. Use after creating a related task without specifying parentGoalId at creation time.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        goalId: { type: "string", description: "Goal id to link to. null to unlink." }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Task goal linking"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Task goal linking");
      return runtime.tasks.linkTaskToGoal(args.taskId, args.goalId);
    }
  });

  registry.register({
    name: "goal_status",
    sideEffects: false,
    domainResultStatuses: GOAL_DOMAIN_STATUSES,
    description: "Show the persistent goal-mode state for this session, including status, turn budget, and the latest judge result.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, context) => {
      const sessionId = context?.sessionId;
      if (!sessionId) return { error: "goal_status requires a session" };
      if (typeof runtime.goals?.get !== "function") return { error: "goal store not available" };
      const goal = runtime.goals.get(sessionId);
      return goal ?? { sessionId, status: "none" };
    }
  });

  registry.register({
    name: "pause_goal",
    domainResultStatuses: GOAL_DOMAIN_STATUSES,
    description: "Pause automatic work on the active goal for this session without deleting its state.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason recorded in the goal audit trail." }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      const sessionId = context?.sessionId;
      if (!sessionId) return { error: "pause_goal requires a session" };
      if (typeof runtime.goals?.pause !== "function") return { error: "goal store not available" };
      return runtime.goals.pause(sessionId, args.reason ?? "paused-by-agent")
        ?? { error: "no goal for this session" };
    }
  });

  registry.register({
    name: "resume_goal",
    domainResultStatuses: GOAL_DOMAIN_STATUSES,
    description: "Resume automatic work on the paused goal for this session, subject to its remaining turn budget.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason recorded in the goal audit trail." }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      const sessionId = context?.sessionId;
      if (!sessionId) return { error: "resume_goal requires a session" };
      if (typeof runtime.goals?.resume !== "function") return { error: "goal store not available" };
      return runtime.goals.resume(sessionId, args.reason ?? "resumed-by-agent")
        ?? { error: "no goal for this session" };
    }
  });

  registry.register({
    name: "clear_goal",
    domainResultStatuses: GOAL_DOMAIN_STATUSES,
    description: "Clear goal mode for this session and stop automatic continuation. The persisted audit history is retained.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason recorded in the goal audit trail." }
      },
      additionalProperties: false
    },
    handler: async (args, context) => {
      const sessionId = context?.sessionId;
      if (!sessionId) return { error: "clear_goal requires a session" };
      if (typeof runtime.goals?.clear !== "function") return { error: "goal store not available" };
      return runtime.goals.clear(sessionId, args.reason ?? "cleared-by-agent")
        ?? { error: "no goal for this session" };
    }
  });

  registry.register({
    name: "agent_pick_next",
    metadata: { projectScope: "default" },
    description: "Pop the next task from the agent's own queue. Returns the highest-priority pending task in the agent queue, or null if the queue is empty.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Agent task queue mutation"
    ),
    handler: async (_args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Agent task queue mutation");
      const task = runtime.tasks.agentPickNext?.() ?? null;
      return task ? { task } : { task: null, reason: "agent queue empty" };
    }
  });

  registry.register({
    name: "daily_recap",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Answer 'what did I get done today?' Returns a structured summary of completed tasks, skills run, agent actions approved, time tracked, and themes. Pass a date (YYYY-MM-DD) to recap a specific day; defaults to today in the user's local timezone. format='markdown' returns a human-readable chat reply; format='json' returns the raw structure for further processing.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today (user's local timezone)." },
        format: { type: "string", enum: ["markdown", "json"], description: "Output format. Default 'markdown'." }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Daily recap"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Daily recap");
      const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
      const date = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const recap = computeDailyRecap(runtime, { date });
      if (args.format === "json") return recap;
      return { markdown: renderDailyRecapMarkdown(recap), counts: recap.counts };
    }
  });

  registry.register({
    name: "daily_plan",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "Answer 'what should I do today?' Returns a forward-looking plan synthesized from the user's calendar, pending + carried-over tasks, recent call commitments, and active goals: a focus list, what the agent can take off their plate, and time-sensitive items. Pass a date (YYYY-MM-DD) to plan a specific day; defaults to today. format='markdown' for a chat reply, 'json' for the raw structure.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today (user's local timezone)." },
        format: { type: "string", enum: ["markdown", "json"], description: "Output format. Default 'markdown'." }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "Daily planning"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "Daily planning");
      const { computeDailyPlan, renderDailyPlanMarkdown } = await import("./daily-planner.js");
      const date = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const plan = await computeDailyPlan(runtime, { date });
      if (args.format === "json") return plan;
      return { markdown: renderDailyPlanMarkdown(plan), counts: plan.counts };
    }
  });

  registry.register({
    name: "artifact_create",
    description: "Create a versioned Markdown or JSON-compatible data artifact in the current project's Canvas. Returns a pinned artifact reference that can be delivered or cited without copying the content into chat.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["markdown", "data"] },
        title: { type: "string", description: "Short human-readable artifact title." },
        content: {
          oneOf: [
            { type: "string" },
            { type: "object", additionalProperties: true },
            { type: "array", items: {} },
            { type: "number" },
            { type: "boolean" },
            { type: "null" }
          ],
          description: "Markdown text for kind=markdown, or a JSON-compatible value for kind=data."
        }
      },
      required: ["kind", "title", "content"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.create) throw new Error("Artifact Canvas is unavailable.");
      const artifact = runtime.artifacts.create({
        ...args,
        projectId: context.__projectId ?? "default"
      }, {
        projectId: context.__projectId ?? "default",
        actor: context.agentId ?? "agent"
      });
      return artifactMutationResult(artifact);
    }
  });

  registry.register({
    name: "artifact_list",
    sideEffects: false,
    description: "List bounded summaries of versioned Canvas artifacts in the current project.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["markdown", "data"] },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.list) throw new Error("Artifact Canvas is unavailable.");
      return {
        artifacts: runtime.artifacts.list({
          ...args,
          projectId: context.__projectId ?? "default"
        })
      };
    }
  });

  // This replay-only handler is deliberately omitted from model catalogs. A
  // BackgroundReviewer creates a durable pending action directly; the handler
  // verifies its exact action identity and a human decision before any memory
  // mutation. Ordinary auto-approval therefore cannot promote a model review
  // into a durable fact.
  registry.register({
    name: "apply_background_memory_proposal",
    metadata: { internal: true },
    needsConfirmation: true,
    description: "Internal durable replay handler for a human-approved background memory proposal.",
    parameters: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          properties: {
            content: { type: "string" },
            kind: { type: "string", enum: ["preference", "correction", "environment"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            scope: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            provenance: { type: "object" }
          },
          required: ["content", "kind", "confidence", "scope", "tags", "provenance"],
          additionalProperties: false
        }
      },
      required: ["proposal"],
      additionalProperties: false
    },
    handler: async ({ proposal }, context) => {
      if (!runtime.memory?.remember) throw new Error("Memory system is unavailable.");
      const approved = approvedBackgroundMemoryProposal(runtime, proposal, context);
      const confidence = approved.proposal.confidence;
      const profile = backgroundMemoryConfidenceProfile(confidence);
      const memoryClass = approved.proposal.kind === "preference"
        && isProfileMemoryScope(approved.proposal.scope)
        ? "preference"
        : "fact";
      const item = runtime.memory.remember({
        source: "background-review-approved",
        scope: approved.proposal.scope,
        content: approved.proposal.content,
        kind: approved.proposal.kind,
        tags: [
          "background-review",
          "human-approved",
          `memory:${memoryClass}`,
          approved.proposal.kind,
          ...approved.proposal.tags
        ],
        novelty: 0.55,
        risk: approved.proposal.kind === "correction" ? 0.35 : 0.1,
        repetition: 0.25,
        specificity: 0.8,
        metadata: {
          confidence,
          memoryClass,
          reviewedAt: approved.action.createdAt ?? nowIso(),
          provenance: backgroundMemoryProvenance(approved.proposal, {
            approvedBy: approved.decider,
            approvedAt: approved.action.decidedAt ?? nowIso(),
            actionId: approved.action.id
          })
        }
      }, {
        source: "background-review-approved",
        strength: profile.strength,
        tier: profile.tier,
        critical: false,
        capacityManaged: true
      });
      const external = await invokeExternalMemory(
        runtime.externalMemoryProvider,
        "setUserModel",
        {
          ...externalMemoryIdentity(context),
          content: item.content,
          metadata: {
            type: "memory",
            action: "background-review-approved",
            memoryClass,
            tags: item.tags ?? [],
            localMemoryId: item.id,
            scope: item.scope,
            sessionId: context.sessionId ?? null
          }
        },
        context?.__abortSignal
      );
      return {
        id: item.id,
        tier: item.tier,
        content: item.content,
        memoryClass,
        approvalActionId: approved.action.id,
        ...(external.enabled ? { externalMemory: external.status } : {})
      };
    }
  });

  registry.register({
    name: "artifact_show",
    sideEffects: false,
    description: "Read one exact Canvas artifact revision from the current project. Omit revision for the latest version.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^artifact_[a-f0-9]{16}$" },
        revision: { type: "integer", minimum: 1 }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.get) throw new Error("Artifact Canvas is unavailable.");
      return runtime.artifacts.get(args.id, {
        projectId: context.__projectId ?? "default",
        ...(args.revision == null ? {} : { revision: args.revision })
      });
    }
  });

  registry.register({
    name: "artifact_update",
    description: "Append a new Canvas artifact revision. expectedRevision is mandatory; stale writes are rejected instead of overwriting newer work.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^artifact_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string" },
        content: {
          oneOf: [
            { type: "string" },
            { type: "object", additionalProperties: true },
            { type: "array", items: {} },
            { type: "number" },
            { type: "boolean" },
            { type: "null" }
          ]
        }
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.update) throw new Error("Artifact Canvas is unavailable.");
      const { id, ...patch } = args;
      const artifact = runtime.artifacts.update(id, patch, {
        projectId: context.__projectId ?? "default",
        actor: context.agentId ?? "agent"
      });
      return artifactMutationResult(artifact);
    }
  });

  registry.register({
    name: "artifact_versions",
    sideEffects: false,
    description: "List recoverable revisions for one Canvas artifact in the current project. Content is omitted by default to conserve context.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^artifact_[a-f0-9]{16}$" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        includeContent: { type: "boolean" }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.versions) throw new Error("Artifact Canvas is unavailable.");
      return {
        versions: runtime.artifacts.versions(args.id, {
          projectId: context.__projectId ?? "default",
          limit: args.limit,
          includeContent: args.includeContent === true
        })
      };
    }
  });

  registry.register({
    name: "artifact_restore",
    description: "Restore a prior Canvas revision by appending it as a new head. expectedRevision protects against stale rollback requests.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^artifact_[a-f0-9]{16}$" },
        revision: { type: "integer", minimum: 1, description: "Prior revision to restore." },
        expectedRevision: { type: "integer", minimum: 1, description: "Current head revision." }
      },
      required: ["id", "revision", "expectedRevision"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.artifacts?.restore) throw new Error("Artifact Canvas is unavailable.");
      const artifact = runtime.artifacts.restore(args.id, args.revision, {
        projectId: context.__projectId ?? "default",
        expectedRevision: args.expectedRevision,
        actor: context.agentId ?? "agent"
      });
      return artifactMutationResult(artifact);
    }
  });

  registry.register({
    name: "save_draft",
    domainResultStatuses: DRAFT_DOMAIN_STATUSES,
    description: "Save a draft artifact (email, message, doc, outline, reply) for the user to review — instead of sending or publishing it. THIS IS HOW YOU COMPLETE DRAFT-ONLY WORK: produce the content, save it here, and the user reviews/approves/edits it later. Never send, publish, or schedule the content yourself; saving a draft does NOT send it. Link it to the originating task via taskId.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the draft, e.g. 'Follow-up to Acme re pricing'." },
        body: { type: "string", description: "The full draft content." },
        kind: { type: "string", enum: ["email", "message", "doc", "outline", "reply", "other"], description: "What kind of artifact this is." },
        recipient: { type: "string", description: "Intended recipient, if applicable (display only — nothing is sent)." },
        taskId: { type: "string", description: "The task this draft fulfills, if any." }
      },
      required: ["title", "body"],
      additionalProperties: false
    },
    handler: async (args, context = {}) => {
      if (!runtime.drafts?.add) throw new Error("no draft store available");
      const projectId = context.__projectId ?? context.projectId ?? "default";
      const draft = createProjectDraft(runtime, args, projectId);
      return { draftId: draft.id, status: draft.status, note: "Draft saved for review. It has NOT been sent — the user will review and approve it." };
    }
  });

  // ─── Catalog-aware integration tools (require user approval) ───────────

  registry.register({
    name: "list_mcp_catalog",
    metadata: { projectScope: "default" },
    sideEffects: false,
    description: "List the MCP servers in OpenAGI's curated catalog — names, descriptions, auth mode (api-key vs oauth), availability (available vs coming-soon), and required env-var name for bearer-auth entries. Use BEFORE connect_catalog_mcp to confirm an entry exists and learn what credentials it needs.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional filter: project-management, analytics, developer-tools, crm, design-docs, communication, calls-meetings, filesystem." },
        availableOnly: { type: "boolean", description: "If true, only return entries with status='available' (skip OAuth-pending ones)." }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectRead(
      runtime.projects,
      context,
      "MCP catalog inspection"
    ),
    handler: async (args, context) => {
      assertDefaultProjectRead(runtime.projects, context, "MCP catalog inspection");
      const { MCP_CATALOG } = await import("./mcp-catalog.js");
      let entries = MCP_CATALOG;
      if (args.category) entries = entries.filter((e) => e.category === args.category);
      if (args.availableOnly) entries = entries.filter((e) => e.status === "available" && Boolean(e.register));
      const registered = new Set((runtime.mcp?.listServers?.() ?? []).map((s) => s.name?.toLowerCase()));
      return {
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          category: e.category,
          authType: e.authType,
          status: e.status,
          apiKeyEnvVar: e.apiKeyEnvVar ?? null,
          apiKeyHelp: e.apiKeyHelp ?? null,
          alreadyRegistered: registered.has(e.id),
          connectable: e.status === "available" && Boolean(e.register)
        }))
      };
    }
  });

  registry.register({
    name: "connect_catalog_mcp",
    metadata: { projectScope: "default" },
    description: "One-click register an MCP server from the curated catalog by id. Bearer credentials must already be stored through the authenticated /secrets, Discord modal, or setup surface; this tool never accepts or returns secret values. For OAuth entries (Linear, Notion, GitHub), the handshake will surface in the dashboard's MCP tab. THIS REQUIRES USER APPROVAL - the user must approve through the normal approval surface before registration runs.",
    preflight: (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP catalog connection");
      return preflightConnectCatalogMcp(args);
    },
    parameters: {
      type: "object",
      properties: {
        catalogId: { type: "string", description: "Catalog entry id (see list_mcp_catalog)." }
      },
      required: ["catalogId"],
      additionalProperties: false
    },
    needsConfirmation: true,
    summarize: (args) => `Connect MCP: ${args.catalogId}`,
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "MCP catalog connection");
      const { MCP_CATALOG } = await import("./mcp-catalog.js");
      const entry = MCP_CATALOG.find((e) => e.id === args.catalogId);
      if (!entry) throw new Error(`Catalog entry '${args.catalogId}' not found. Use list_mcp_catalog to see what's available.`);
      if (!entry.register) throw new Error(`Catalog entry '${entry.id}' has no register info (likely status=coming-soon).`);
      if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
        const decidedBy = context?.agentId
          ? `agent:${context.agentId}:connect_catalog_mcp`
          : "agent:connect_catalog_mcp";
        const hasSecretStore = typeof runtime.secrets?.listSecretNames === "function";
        let storedNames;
        try {
          storedNames = hasSecretStore
            ? runtime.secrets.listSecretNames({ decidedBy })
            : [];
        } catch {
          throw new Error("Secret store unavailable for catalog connection.");
        }
        const configured = hasSecretStore
          ? storedNames.includes(entry.apiKeyEnvVar)
          : Boolean(process.env[entry.apiKeyEnvVar]);
        if (!configured) {
          throw new Error(`Catalog entry '${entry.id}' requires ${entry.apiKeyEnvVar}. Ask the user to add it through /secrets or setup, then retry without putting the value in chat.`);
        }
        runtime.mcp.allowEnvKey?.(entry.apiKeyEnvVar);
      }
      const spec = { name: entry.id, ...entry.register };
      if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
        spec.apiKey = `\${${entry.apiKeyEnvVar}}`;
      }
      const server = runtime.mcp.registerServer(spec);
      if (runtime.mcp?.connect) runtime.mcp.connect(server.name).catch(() => { /* OAuth surfaces via SSE */ });
      return {
        name: server.name,
        transport: server.transport,
        note: entry.register.auth === "oauth"
          ? "OAuth handshake initiated — user should complete it in the dashboard's MCP tab."
          : "Registered. Use list_mcp_tools to see what's available."
      };
    }
  });

  registry.register({
    name: "restart_daemon",
    metadata: { projectScope: "default" },
    description: "Bounce the OpenAGI process so .env changes (new credentials, providers, etc) take effect. Existing integration constructors only re-read env at boot, so this is required after save_integration_credentials or a credentials change. THIS REQUIRES USER APPROVAL — restart drops in-flight chat connections briefly. Use sparingly; only when an integration won't work otherwise.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a restart is needed — surfaced in the approval UI so the user understands the trigger." }
      },
      additionalProperties: false
    },
    needsConfirmation: true,
    summarize: (args) => args.reason ? `Restart daemon (reason: ${args.reason})` : "Restart daemon",
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Daemon restart"
    ),
    handler: async (_args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Daemon restart");
      // Same pattern as /control/restart — schedule exit so the response can flush.
      setTimeout(() => process.exit(0), 200);
      return { restarting: true };
    }
  });

  registry.register({
    name: "retire_specialist",
    metadata: { projectScope: "default" },
    description: "Retire a propagated specialist by id. Use this when the user explicitly says a specialist isn't useful, or when get_audit shows a low-quality specialist.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string", description: "Short reason logged with the retirement." }
      },
      required: ["id"],
      additionalProperties: false
    },
    preflight: (_args, context) => assertDefaultProjectControl(
      runtime.projects,
      context,
      "Specialist retirement"
    ),
    handler: async (args, context) => {
      assertDefaultProjectControl(runtime.projects, context, "Specialist retirement");
      const sp = runtime.propagation?.retire?.(args.id, args.reason ?? "agent-initiated");
      if (!sp) return { error: "unknown specialist" };
      return { id: sp.id, status: sp.status, reason: sp.retirementReason };
    }
  });

  return registry;
}

export function registerCapabilityProfileTools(registry, runtime) {
  if (!runtime?.profiles) return registry;
  const deferred = { toolSearch: "deferred" };
  const profileProperties = {
    name: { type: "string", minLength: 1, maxLength: 200 },
    persona: {
      type: "string",
      maxLength: 24000,
      description: "Optional stable persona instructions. Plain data only."
    },
    modelProfile: {
      type: "object",
      additionalProperties: true,
      description: "Credential-free model choices."
    },
    routingProfile: {
      type: "object",
      additionalProperties: true,
      description: "Credential-free routing choices."
    },
    activeSkills: capabilityGrantArraySchema(
      "Skills made visible by this profile; bodies remain unloaded until use_skill."
    ),
    toolGrants: capabilityGrantArraySchema(
      "Exact tools granted directly by this profile."
    ),
    capabilityBundleIds: {
      type: "array",
      maxItems: 256,
      uniqueItems: true,
      items: capabilityIdSchema("Capability bundle id.")
    }
  };
  const bundleProperties = {
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
    toolGrants: capabilityGrantArraySchema(
      "Exact tools contributed while this bundle is enabled."
    ),
    access: capabilityAccessToolSchema()
  };

  registry.register({
    name: "profile_list",
    metadata: deferred,
    sideEffects: false,
    description: "List named capability profiles in the current project without loading any skill bodies.",
    parameters: {
      type: "object",
      properties: {
        includeRevoked: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: (args, context) => ({
      profiles: runtime.profiles.listProfiles({
        projectId: capabilityProjectId(runtime, context, "Profile listing"),
        includeRevoked: args.includeRevoked === true
      })
    })
  });

  registry.register({
    name: "profile_get",
    metadata: deferred,
    sideEffects: false,
    description: "Inspect one named project profile, its skill and tool grants, and its project/session bindings.",
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Profile id."),
        includeRevoked: { type: "boolean" }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: (args, context) => runtime.profiles.getProfile(
      capabilityProjectId(runtime, context, "Profile inspection"),
      args.id,
      { includeRevoked: args.includeRevoked !== false }
    )
  });

  registry.register({
    name: "profile_create",
    metadata: deferred,
    needsConfirmation: true,
    description: "Create a named project profile. Creation does not activate it or enable any capability bundle.",
    summarize: ({ id }) => `Create capability profile ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Profile id."),
        ...profileProperties
      },
      required: [
        "id",
        "name",
        "activeSkills",
        "toolGrants",
        "capabilityBundleIds"
      ],
      additionalProperties: false
    },
    handler: (args, context) => runtime.profiles.createProfile(
      capabilityProjectId(runtime, context, "Profile creation"),
      args,
      { actor: capabilityActor(context) }
    )
  });

  registry.register({
    name: "profile_update",
    metadata: deferred,
    needsConfirmation: true,
    description: "Revision-safely edit a named profile. It remains inactive until separately bound, and revoked profiles cannot be edited.",
    summarize: ({ id }) => `Update capability profile ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Profile id."),
        expectedRevision: { type: "integer", minimum: 1 },
        ...profileProperties
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    handler: ({ id, ...patch }, context) => runtime.profiles.updateProfile(
      capabilityProjectId(runtime, context, "Profile update"),
      id,
      patch,
      { actor: capabilityActor(context) }
    )
  });

  registry.register({
    name: "profile_activate",
    metadata: deferred,
    needsConfirmation: true,
    description: "Bind or clear an active profile for the current project or one project-owned session. Explicit human approval is required because this changes live authority.",
    summarize: ({ id, scope }) => (
      `${id ? "Activate" : "Clear"} ${scope ?? "session"} capability profile ${boundedCapabilityId(id)}`
    ),
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          maxLength: 64,
          description: "Profile id, or an empty string to clear the binding."
        },
        scope: { type: "string", enum: ["project", "session"] },
        sessionId: {
          type: "string",
          maxLength: 512,
          description: "Required for session scope; defaults to the current session."
        },
        expectedBindingProfileId: {
          type: "string",
          maxLength: 64,
          description: "Current bound profile id, or empty when unbound. Prevents lost updates."
        },
        expectedProfileRevision: {
          type: "integer",
          minimum: 1,
          description: "Required when activating a profile; its current revision."
        }
      },
      required: ["id", "scope", "expectedBindingProfileId"],
      additionalProperties: false
    },
    handler: (args, context) => {
      assertManualCapabilityApproval(context, "Profile activation");
      if (
        String(args.id ?? "").trim()
        && (!Number.isSafeInteger(args.expectedProfileRevision)
          || args.expectedProfileRevision < 1)
      ) {
        throw new Error(
          "expectedProfileRevision is required when activating a profile."
        );
      }
      const projectId = capabilityProjectId(runtime, context, "Profile activation");
      if (args.scope === "project") {
        return runtime.profiles.bindProjectProfile(projectId, args.id, {
          expectedBindingProfileId: args.expectedBindingProfileId,
          expectedProfileRevision: args.expectedProfileRevision,
          actor: capabilityActor(context)
        });
      }
      const sessionId = String(args.sessionId ?? context?.sessionId ?? "").trim();
      if (!sessionId) throw new Error("sessionId is required for session profile activation.");
      return runtime.profiles.bindSessionProfile(
        projectId,
        sessionId,
        args.id,
        {
          expectedBindingProfileId: args.expectedBindingProfileId,
          expectedProfileRevision: args.expectedProfileRevision,
          actor: capabilityActor(context)
        }
      );
    }
  });

  registry.register({
    name: "profile_revoke",
    metadata: deferred,
    needsConfirmation: true,
    description: "Permanently revoke a profile revision. Existing bindings become deny-all until an operator explicitly selects or clears a profile.",
    summarize: ({ id }) => `Revoke capability profile ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Profile id."),
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    handler: (args, context) => {
      assertManualCapabilityApproval(context, "Profile revocation");
      return runtime.profiles.revokeProfile(
        capabilityProjectId(runtime, context, "Profile revocation"),
        args.id,
        {
          expectedRevision: args.expectedRevision,
          actor: capabilityActor(context)
        }
      );
    }
  });

  registry.register({
    name: "capability_bundle_list",
    metadata: deferred,
    sideEffects: false,
    description: "List reusable project-scoped capability bundles and whether each is disabled, enabled, or revoked.",
    parameters: {
      type: "object",
      properties: {
        includeRevoked: { type: "boolean" }
      },
      additionalProperties: false
    },
    handler: (args, context) => ({
      bundles: runtime.profiles.listBundles({
        projectId: capabilityProjectId(runtime, context, "Capability bundle listing"),
        includeRevoked: args.includeRevoked === true
      })
    })
  });

  registry.register({
    name: "capability_bundle_create",
    metadata: deferred,
    needsConfirmation: true,
    description: "Create a disabled capability bundle with explicit filesystem, network, secret, subprocess, API, UI, and hook declarations.",
    summarize: ({ id }) => `Create disabled capability bundle ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Capability bundle id."),
        ...bundleProperties
      },
      required: ["id", "name", "toolGrants", "access"],
      additionalProperties: false
    },
    handler: (args, context) => runtime.profiles.createBundle(
      capabilityProjectId(runtime, context, "Capability bundle creation"),
      args,
      { actor: capabilityActor(context) }
    )
  });

  registry.register({
    name: "capability_bundle_update",
    metadata: deferred,
    needsConfirmation: true,
    description: "Revision-safely edit a capability bundle. Every permission edit automatically disables it for fresh review.",
    summarize: ({ id }) => `Update and disable capability bundle ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Capability bundle id."),
        expectedRevision: { type: "integer", minimum: 1 },
        ...bundleProperties
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    handler: ({ id, ...patch }, context) => runtime.profiles.updateBundle(
      capabilityProjectId(runtime, context, "Capability bundle update"),
      id,
      patch,
      { actor: capabilityActor(context) }
    )
  });

  registry.register({
    name: "capability_bundle_enable",
    metadata: deferred,
    needsConfirmation: true,
    description: "Enable or disable one exact capability bundle revision. Explicit human approval is required; hands-free auto-approval cannot grant authority.",
    summarize: ({ id, enabled }) => (
      `${enabled ? "Enable" : "Disable"} capability bundle ${boundedCapabilityId(id)}`
    ),
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Capability bundle id."),
        expectedRevision: { type: "integer", minimum: 1 },
        enabled: { type: "boolean" }
      },
      required: ["id", "expectedRevision", "enabled"],
      additionalProperties: false
    },
    handler: (args, context) => {
      assertManualCapabilityApproval(context, "Capability bundle activation");
      return runtime.profiles.setBundleEnabled(
        capabilityProjectId(runtime, context, "Capability bundle activation"),
        args.id,
        args.enabled,
        {
          expectedRevision: args.expectedRevision,
          actor: capabilityActor(context)
        }
      );
    }
  });

  registry.register({
    name: "capability_bundle_revoke",
    metadata: deferred,
    needsConfirmation: true,
    description: "Permanently revoke a capability bundle so every referencing profile loses its tools and declared access on the next gate check.",
    summarize: ({ id }) => `Revoke capability bundle ${boundedCapabilityId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: capabilityIdSchema("Capability bundle id."),
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    handler: (args, context) => {
      assertManualCapabilityApproval(context, "Capability bundle revocation");
      return runtime.profiles.revokeBundle(
        capabilityProjectId(runtime, context, "Capability bundle revocation"),
        args.id,
        {
          expectedRevision: args.expectedRevision,
          actor: capabilityActor(context)
        }
      );
    }
  });

  registry.register({
    name: "capability_audit",
    metadata: deferred,
    sideEffects: false,
    description: "Read the bounded project-scoped audit trail for profile and capability-grant mutations.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    handler: (args, context) => ({
      events: runtime.profiles.history({
        projectId: capabilityProjectId(runtime, context, "Capability audit"),
        limit: args.limit ?? 100
      })
    })
  });

  if (runtime.skillImports) {
    registry.register({
      name: "skill_import_list",
      metadata: deferred,
      sideEffects: false,
      description: "List review-only ZIP or local-Git skill import candidates. Quarantined code is not loaded or executable.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "approved", "rejected"]
          },
          includeResolved: { type: "boolean" }
        },
        additionalProperties: false
      },
      handler: (args, context) => ({
        imports: runtime.skillImports.list({
          projectId: capabilityProjectId(runtime, context, "Skill import listing"),
          status: args.status ?? null,
          includeResolved: args.includeResolved !== false
        })
      })
    });

    registry.register({
      name: "skill_import_stage",
      metadata: deferred,
      needsConfirmation: true,
      capability: {
        resources: ["filesystem"]
      },
      description: "Copy a ZIP or already-present local Git checkout from the default-project workspace into inert review quarantine. This never runs Git, hooks, filters, package managers, or imported scripts.",
      summarize: ({ kind, sourcePath }) => (
        `Stage ${String(kind ?? "").slice(0, 8)} skill import from ${String(sourcePath ?? "").slice(0, 160)}`
      ),
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["zip", "git"] },
          sourcePath: { type: "string", minLength: 1, maxLength: 4096 },
          sourceLabel: { type: "string", maxLength: 500 }
        },
        required: ["kind", "sourcePath"],
        additionalProperties: false
      },
      handler: (args, context) => runtime.skillImports.stage({
        ...args,
        projectId: capabilityProjectId(runtime, context, "Skill import staging")
      }, {
        actor: capabilityActor(context)
      })
    });

    registry.register({
      name: "skill_import_review",
      metadata: deferred,
      sideEffects: false,
      capability: {
        resources: ["filesystem"]
      },
      description: "Inspect inert import metadata or one bounded quarantined file as explicitly untrusted review data.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^skill_import_[a-f0-9]{16}$" },
          file: { type: "string", maxLength: 1024 }
        },
        required: ["id"],
        additionalProperties: false
      },
      handler: (args, context) => runtime.skillImports.review(args.id, {
        projectId: capabilityProjectId(runtime, context, "Skill import review"),
        file: args.file ?? null
      })
    });

    registry.register({
      name: "skill_import_approve",
      metadata: deferred,
      needsConfirmation: true,
      capability: {
        resources: ["filesystem"]
      },
      description: "Approve one exact quarantined import revision and atomically materialize it as a user skill. A real human approval is mandatory; auto-approve cannot load imported code.",
      summarize: ({ id }) => `Approve quarantined skill import ${boundedImportId(id)}`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^skill_import_[a-f0-9]{16}$" },
          expectedRevision: { type: "integer", minimum: 1 }
        },
        required: ["id", "expectedRevision"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertManualCapabilityApproval(context, "Skill import approval");
        return runtime.skillImports.approve(args.id, {
          projectId: capabilityProjectId(runtime, context, "Skill import approval"),
          expectedRevision: args.expectedRevision
        }, {
          actor: capabilityActor(context)
        });
      }
    });

    registry.register({
      name: "skill_import_reject",
      metadata: deferred,
      needsConfirmation: true,
      description: "Reject an exact quarantined skill import revision while retaining its audit record and inert bytes.",
      summarize: ({ id }) => `Reject quarantined skill import ${boundedImportId(id)}`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^skill_import_[a-f0-9]{16}$" },
          expectedRevision: { type: "integer", minimum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 2000 }
        },
        required: ["id", "expectedRevision", "reason"],
        additionalProperties: false
      },
      handler: (args, context) => {
        assertManualCapabilityApproval(context, "Skill import rejection");
        return runtime.skillImports.reject(args.id, {
          projectId: capabilityProjectId(runtime, context, "Skill import rejection"),
          expectedRevision: args.expectedRevision,
          reason: args.reason
        }, {
          actor: capabilityActor(context)
        });
      }
    });
  }

  return registry;
}

function capabilityGrantArraySchema(description) {
  return {
    type: "array",
    maxItems: 256,
    uniqueItems: true,
    description,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9*][A-Za-z0-9_.:/*-]{0,127}$"
    }
  };
}

function capabilityIdSchema(description) {
  return {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$",
    description
  };
}

function capabilityAccessToolSchema() {
  return {
    type: "object",
    description: "Every access class must be explicitly declared.",
    properties: {
      filesystem: { type: "string", enum: ["none", "read", "write"] },
      network: { type: "boolean" },
      secrets: { type: "boolean" },
      subprocess: { type: "boolean" },
      api: { type: "boolean" },
      ui: { type: "boolean" },
      hooks: { type: "boolean" }
    },
    required: [
      "filesystem",
      "network",
      "secrets",
      "subprocess",
      "api",
      "ui",
      "hooks"
    ],
    additionalProperties: false
  };
}

function capabilityProjectId(runtime, context, operation) {
  return requireProjectControlIdentity(runtime.projects, context, operation)
    ?? DEFAULT_PROJECT_ID;
}

function capabilityActor(context) {
  return context?.__approval?.decider
    ?? context?.__approval?.decidedBy
    ?? context?.from
    ?? context?.agentId
    ?? "agent";
}

function assertManualCapabilityApproval(context, operation) {
  const approval = context?.__approval;
  const decider = String(
    approval?.decider ?? approval?.decidedBy ?? ""
  ).trim();
  if (!approval || !decider || decider === "auto-approve") {
    const error = new Error(
      `${operation} requires an explicit human approval; auto-approve is insufficient.`
    );
    error.code = "CAPABILITY_MANUAL_APPROVAL_REQUIRED";
    throw error;
  }
}

function boundedCapabilityId(value) {
  const id = String(value ?? "").trim();
  return /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(id)
    ? id
    : "[invalid-id]";
}

function boundedImportId(value) {
  const id = String(value ?? "").trim();
  return /^skill_import_[a-f0-9]{16}$/.test(id)
    ? id
    : "[invalid-import]";
}

export function registerSolutionRecipeTools(registry, runtime) {
  if (!runtime?.recipes) return registry;
  const deferred = { toolSearch: "deferred" };
  const recipeBody = recipeBodyToolProperties();

  registry.register({
    name: "recipe_search",
    metadata: deferred,
    sideEffects: false,
    description: "Search recipe metadata in the current project, including candidates, failed attempts, verified procedures, and audit states. This never searches factual memory and omits full action bodies.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 4000 },
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["candidate", "verified", "failed", "superseded", "deleted"]
          },
          uniqueItems: true
        },
        includeDeleted: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 64 }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe search"),
    handler: async (args, context) => {
      const projectId = recipeProjectId(runtime, context, "Recipe search");
      const items = runtime.recipes.search(args.query ?? "", {
        projectId,
        statuses: args.statuses,
        includeDeleted: args.includeDeleted === true,
        limit: args.limit
      });
      return { count: items.length, items };
    }
  });

  registry.register({
    name: "recipe_get",
    metadata: deferred,
    sideEffects: false,
    description: "Load one full project-scoped procedural recipe after recipe_search or recipe_recall returns its id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" }
      },
      required: ["id"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe read"),
    handler: async ({ id }, context) => runtime.recipes.get(id, {
      projectId: recipeProjectId(runtime, context, "Recipe read")
    })
  });

  registry.register({
    name: "recipe_recall",
    metadata: deferred,
    sideEffects: false,
    description: "Recall only active verified procedural recipes for a task. Facts remain in recall; candidates, failed attempts, superseded recipes, and deleted recipes are never returned here.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4000 },
        limit: { type: "integer", minimum: 1, maximum: 64 }
      },
      required: ["query"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe recall"),
    handler: async ({ query, limit }, context) => runtime.recipes.recall(query, {
      projectId: recipeProjectId(runtime, context, "Recipe recall"),
      limit
    })
  });

  registry.register({
    name: "recipe_create_draft",
    metadata: deferred,
    description: "Create an unverified procedural recipe candidate in the current project. This never makes the procedure recallable as verified, even when evidence is supplied.",
    parameters: {
      type: "object",
      properties: recipeBody,
      required: ["title", "summary", "preconditions", "actions"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe creation"),
    handler: async (args, context) => runtime.recipes.propose(args, {
      projectId: recipeProjectId(runtime, context, "Recipe creation"),
      actor: recipeActor(context)
    })
  });

  registry.register({
    name: "recipe_update",
    metadata: deferred,
    description: "Edit a recipe with revision protection. Any semantic edit resets a previously verified recipe to an unverified candidate and removes it from procedural recall.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        ...recipeBody
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe edit"),
    handler: async ({ id, ...patch }, context) => runtime.recipes.edit(id, patch, {
      projectId: recipeProjectId(runtime, context, "Recipe edit"),
      actor: recipeActor(context)
    })
  });

  registry.register({
    name: "recipe_verify",
    metadata: deferred,
    needsConfirmation: true,
    description: "Mark the exact current recipe revision verified using project-owned durable evidence. A real human approval is required; hands-free auto-approval cannot establish verification.",
    summarize: ({ id }) => `Verify procedural recipe ${boundedRecipeId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        method: { type: "string", minLength: 1, maxLength: 1000 },
        evidence: recipeEvidenceToolSchema()
      },
      required: ["id", "expectedRevision", "method", "evidence"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe verification"),
    handler: async ({ id, expectedRevision, method, evidence }, context) => {
      assertManualRecipeApproval(context, "Recipe verification");
      return runtime.recipes.verify(id, {
        expectedRevision,
        method,
        evidence
      }, {
        projectId: recipeProjectId(runtime, context, "Recipe verification"),
        actor: recipeActor(context)
      });
    }
  });

  registry.register({
    name: "recipe_fail",
    metadata: deferred,
    description: "Record that a candidate or active recipe attempt failed. Failed recipes remain auditable but immediately leave verified procedural recall.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        evidence: recipeEvidenceToolSchema()
      },
      required: ["id", "expectedRevision", "reason"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe failure recording"),
    handler: async ({ id, expectedRevision, reason, evidence }, context) => (
      runtime.recipes.fail(id, {
        expectedRevision,
        reason,
        evidence
      }, {
        projectId: recipeProjectId(runtime, context, "Recipe failure recording"),
        actor: recipeActor(context)
      })
    )
  });

  registry.register({
    name: "recipe_supersede",
    metadata: deferred,
    needsConfirmation: true,
    description: "Atomically supersede one verified recipe with another verified recipe in the same project using revision checks on both.",
    summarize: ({ id, replacementId }) => (
      `Supersede recipe ${boundedRecipeId(id)} with ${boundedRecipeId(replacementId)}`
    ),
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        replacementId: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        replacementExpectedRevision: { type: "integer", minimum: 1 }
      },
      required: [
        "id",
        "expectedRevision",
        "replacementId",
        "replacementExpectedRevision"
      ],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe supersession"),
    handler: async (args, context) => {
      assertManualRecipeApproval(context, "Recipe supersession");
      return runtime.recipes.supersede(args.id, args.replacementId, {
        projectId: recipeProjectId(runtime, context, "Recipe supersession"),
        expectedRevision: args.expectedRevision,
        replacementExpectedRevision: args.replacementExpectedRevision,
        actor: recipeActor(context)
      });
    }
  });

  registry.register({
    name: "recipe_delete",
    metadata: deferred,
    needsConfirmation: true,
    description: "Soft-delete one recipe revision so its audit trail survives while recall and promotion remain disabled.",
    summarize: ({ id }) => `Delete recipe ${boundedRecipeId(id)}`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe deletion"),
    handler: async ({ id, expectedRevision }, context) => {
      assertManualRecipeApproval(context, "Recipe deletion");
      return runtime.recipes.remove(id, {
        projectId: recipeProjectId(runtime, context, "Recipe deletion"),
        expectedRevision,
        actor: recipeActor(context)
      });
    }
  });

  registry.register({
    name: "recipe_export",
    metadata: deferred,
    sideEffects: false,
    description: "Export one recipe or the current project's bounded recipe collection as deterministic JSON or Markdown.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        format: { type: "string", enum: ["json", "markdown"] },
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["candidate", "verified", "failed", "superseded", "deleted"]
          },
          uniqueItems: true
        },
        includeDeleted: { type: "boolean" }
      },
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe export"),
    handler: async (args, context) => runtime.recipes.export({
      ...args,
      projectId: recipeProjectId(runtime, context, "Recipe export")
    })
  });

  registry.register({
    name: "recipe_skill_candidate",
    metadata: deferred,
    needsConfirmation: true,
    description: "Stage the exact current verified recipe revision as a review-only skill candidate. No skill code is created or executed until a separate human acceptance.",
    summarize: ({ id }) => `Stage recipe ${boundedRecipeId(id)} as a skill candidate`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^recipe_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["id", "expectedRevision"],
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe promotion"),
    handler: async ({ id, expectedRevision }, context) => {
      assertManualRecipeApproval(context, "Recipe promotion");
      const projectId = recipeProjectId(runtime, context, "Recipe promotion");
      const staged = runtime.recipes.withVerifiedRecipe(
        id,
        { projectId, expectedRevision },
        (recipe) => createSkillCandidateFromRecipe({ runtime, recipe })
      );
      runtime.events?.emit?.("skill-candidate", {
        source: "recipe-memory",
        id: staged.candidate.id,
        recipeId: id,
        recipeRevision: expectedRevision,
        projectId
      });
      return {
        id: staged.candidate.id,
        source: "recipe-memory",
        recipeId: id,
        recipeRevision: expectedRevision,
        projectId,
        created: staged.created,
        status: staged.candidate.status
      };
    }
  });

  registry.register({
    name: "recipe_reindex",
    metadata: deferred,
    needsConfirmation: true,
    description: "Rebuild the current project's derived recipe embeddings after an embedder identity change. Stale vectors are never searched; lexical recall remains available during rebuild.",
    summarize: () => "Rebuild verified recipe embeddings for the current project",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    preflight: (_args, context) => recipeProjectId(runtime, context, "Recipe reindex"),
    handler: async (_args, context) => {
      assertManualRecipeApproval(context, "Recipe reindex");
      return runtime.recipes.reindex({
        projectId: recipeProjectId(runtime, context, "Recipe reindex"),
        actor: recipeActor(context),
        signal: context?.__abortSignal
      });
    }
  });

  return registry;
}

function recipeBodyToolProperties() {
  return {
    title: { type: "string", minLength: 1, maxLength: 240 },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    preconditions: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1200 }
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1200 }
    },
    evidence: recipeEvidenceToolSchema(),
    failureModes: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 1200 }
    },
    tags: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 }
    }
  };
}

function recipeEvidenceToolSchema() {
  return {
    type: "array",
    maxItems: 64,
    items: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Pinned artifact, tool-output, checkpoint, or human-attestation reference."
        },
        kind: { type: "string", maxLength: 80 },
        summary: { type: "string", maxLength: 1000 }
      },
      required: ["ref"],
      additionalProperties: false
    }
  };
}

function recipeProjectId(runtime, context, operation) {
  return requireProjectControlIdentity(runtime.projects, context, operation)
    ?? "default";
}

function recipeActor(context) {
  return context?.__approval?.decider
    ?? context?.__approval?.decidedBy
    ?? context?.from
    ?? context?.agentId
    ?? "agent";
}

function assertManualRecipeApproval(context, operation) {
  const approval = context?.__approval;
  const decider = String(
    approval?.decider ?? approval?.decidedBy ?? ""
  ).trim();
  if (!approval || !decider || decider === "auto-approve") {
    const error = new Error(
      `${operation} requires an explicit human approval; auto-approve is insufficient.`
    );
    error.code = "RECIPE_MANUAL_APPROVAL_REQUIRED";
    throw error;
  }
}

function boundedRecipeId(value) {
  const id = String(value ?? "").trim();
  return /^recipe_[a-f0-9]{16}$/.test(id) ? id : "[invalid-recipe]";
}

function validateReplaceIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("replaceIds must be an array of active curated-memory ids.");
  if (value.length > 20) throw new Error("replaceIds accepts at most 20 ids.");
  const ids = value.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("replaceIds must contain only non-empty string ids.");
    }
    return id.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error("replaceIds must not contain duplicate ids.");
  return ids;
}

// Builds the human-readable summary shown on register_mcp_server approval
// cards. Always includes the fields that determine whether the call is
// dangerous (stdio command + first 3 args, or http URL + auth mode) so the
// user can't approve a hidden `docker run -v /:/host` based on the name
// alone. Exported for testing.
export function summarizeRegisterMcpServer(args = {}) {
  // Direct callers must not turn this UI helper into a reflection surface.
  // The invocation path runs the same validator even earlier, before any
  // observer, hook, or pending-action journal receives the arguments.
  validateMcpServerSpec(args);
  const transport = args.transport ?? (args.url ? "http" : args.command ? "stdio" : "config");
  const name = args.name ?? "(unnamed)";
  if (transport === "stdio") {
    const cmd = args.command ?? "?";
    const firstArgs = (args.args ?? []).slice(0, 3).join(" ");
    const more = (args.args?.length ?? 0) > 3 ? " …" : "";
    return `Register stdio MCP '${name}' → ${cmd} ${firstArgs}${more}`.trim();
  }
  if (transport === "http") {
    const auth = args.auth ?? (args.apiKey ? "bearer" : "oauth");
    return `Register http MCP '${name}' → ${args.url ?? "(no url)"} (auth=${auth})`;
  }
  return `Register MCP '${name}' (${transport})`;
}

const REGISTER_MCP_SERVER_FIELDS = new Set([
  "name",
  "transport",
  "command",
  "args",
  "url",
  "auth",
  "apiKey",
  "clientId",
  "scope",
  "trustLevel"
]);

export function preflightRegisterMcpServer(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid MCP server registration request.");
  }
  if (Object.keys(args).some((key) => !REGISTER_MCP_SERVER_FIELDS.has(key))) {
    throw new Error("Invalid MCP server registration request.");
  }
  if (
    args.args !== undefined
    && (!Array.isArray(args.args) || args.args.some((value) => typeof value !== "string"))
  ) {
    throw new Error("Invalid MCP server registration request.");
  }
  try {
    validateMcpServerSpec(args);
  } catch {
    // This error crosses model/channel boundaries. Never include any supplied
    // field value, even when the underlying validator has a useful local
    // diagnostic.
    throw new Error("Invalid MCP server registration request.");
  }
  return true;
}

export function preflightConnectCatalogMcp(args) {
  if (
    !args
    || typeof args !== "object"
    || Array.isArray(args)
    || Object.keys(args).length !== 1
    || !Object.hasOwn(args, "catalogId")
    || typeof args.catalogId !== "string"
  ) {
    throw new Error("Invalid MCP catalog connection request.");
  }
  return true;
}

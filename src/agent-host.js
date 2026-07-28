import path from "node:path";
import { types as utilTypes } from "node:util";
import { InMemoryAgentStore, legacyDiscordKey } from "./agent-store.js";
import { createModelProvider } from "./model-provider.js";
import { createId, nowIso } from "./utils.js";
import { detectTaskInChat } from "./task-store.js";
import { deriveSpecialistScope, measureAxes, REMEMBER_RE, SCHEDULE_RE, SPECIALIZE_RE } from "./signal-axes.js";
import { autoApproveEnabled } from "./tool-registry.js";
import { sanitizeForAudit } from "./redact.js";
import { BackgroundReviewer, backgroundReviewEnabled } from "./background-review.js";
import { TOOL_SEARCH_BRIDGE_NAMES } from "./tool-search.js";
import { expandContextReferences } from "./context-references.js";
import { siblingNames, legionUserId, legionMember, LEGION_MEMBERS } from "./legion-siblings.js";
import { TASK_PROFILES } from "./model-router.js";
import {
  createConversationContentIdentity,
  createConversationLineageIdentity
} from "./responses-continuation.js";
import {
  DEFAULT_PROJECT_ID,
  ProjectBoundaryError,
  projectAllows,
  projectMemoryScope
} from "./project-store.js";
import { profileMemoryScope } from "./memory-system.js";
import { turnInspectorMetadata } from "./run-inspector.js";
import {
  completionToolPreferences,
  createCompletionContract
} from "./completion-evidence.js";
import {
  incrementMemoryRequestMetric,
  initializeMemoryRequestMetrics
} from "./memory-request-metrics.js";

// Internal tools every specialist gets regardless of scope: its own memory
// and the task queue it drains. Everything else comes from the specialist's
// scoped allowlist (selected at propagation from the bounded scope).
const SPECIALIST_CORE_TOOLS = [
  "recall", "remember",
  "list_tasks", "agent_pick_next", "complete_task", "move_task", "save_draft"
];
const BUDGETED_MEMORY_CORE_TOOLS = Object.freeze([
  "memory_wake",
  "memory_zoom",
  "memory_merge",
  "memory_tree_recall",
  "read_spill"
]);

export const CHAT_CORE_TOOLS = Object.freeze([
  "recall",
  "remember",
  "list_sessions",
  "schedule_message",
  "run_skill",
  "list_skills",
  // The system prompt now carries an always-on skill index that instructs the
  // model to load matching skills with use_skill. That directive is a lie if
  // use_skill isn't reachable on the chat lane — so it is core.
  "use_skill",
  // The same prompt tells the model when to author and repair skills. Keep both
  // authoring tools on this lane so those instructions remain actionable.
  "create_skill",
  "edit_skill",
  "goal_status",
  "pause_goal",
  "resume_goal",
  "clear_goal",
  "list_checkpoints",
  // Even on a casual turn the agent must be able to reach out and to discover
  // the rest of its toolset — otherwise it looks (to itself) like it has no
  // send lane and no way to escalate, which is exactly the "I can't reach
  // Seraphim / I only see 6 tools" failure. send_message covers Discord +
  // sibling routing; searcmcp_tools lets it pull the full arsenal on demand.
  // NOTE: do NOT list the tool_search/tool_describe/tool_call bridge names here
  // — those are injected dynamically by the tool-search controller, and baking
  // them in falsely trips toolSearchBridgesActive() on plain chat turns.
  "send_message",
  "searcmcp_tools"
]);
export const DEFAULT_CHAT_MAX_ITERATIONS = 4;
const TOOL_SEARCH_BRIDGE_NAME_SET = new Set(TOOL_SEARCH_BRIDGE_NAMES);
const DEFAULT_BACKGROUND_REVIEW_SNAPSHOT_WAIT_MS = 5000;
const DEFAULT_BACKGROUND_REVIEW_FLUSH_MS = 60_000;
const BACKGROUND_REVIEW_WATERMARK_KEY = "backgroundReviewV1";
const RESPONSES_CONTINUATION_METADATA_KEY = "responsesContinuationV1";

// This intentionally errs toward the full lane. It recognizes concrete work
// verbs, including polite request wrappers, without trying to infer intent
// from every ordinary question.
export const CHAT_TOOL_INTENT_RE = /^(?:[!/]|(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:need|want)\s+(?:you\s+)?to|i(?:'d| would)\s+like\s+you\s+to)\s+(?:please\s+)?)?(?:remind|schedule|search|find|look\s+up|use|run|open|send|remember|delete|remove|fix|build|create|deploy|email|post|execute|install|update|edit|write|save|move|upload|download|call|message|book|buy|set|configure|test|check|fetch|browse|commit|push|merge|rollback|restart|reboot|shut\s+down|turn\s+(?:on|off)|approve|cancel|pause|resume|clear|complete|analyze|inspect|review|read|summarize|compare|explain|show|tell|give|draft|plan|research|calculate|translate|help)\b)/iu;

// Intentionally narrow, anchored phrases: consent should be explicit, not
// inferred from a sentence that merely contains "yes" or "continue". The
// list is exported so additions remain visible and regression-tested.
export const CONSENT_PHRASE_PATTERNS = Object.freeze([
  /^(?:yes|yep|yeah|yup|sure|absolutely|affirmative)(?:\s*,?\s*(?:please|go ahead|do it|proceed|continue))?[.!]*$/iu,
  /^(?:ok|okay)(?:\s*,?\s*(?:go(?:\s+ahead)?|do it|proceed|continue))?[.!]*$/iu,
  /^(?:please\s+)?(?:go ahead|go for it|do it|proceed|continue|full send|make it so)(?:\s+please)?[.!]*$/iu,
  /^(?:approved|sounds good|works for me|fine by me|all good|looks good|whatever you (?:want|prefer)|either(?: one| way)?|you (?:choose|pick)(?: one)?|your call|let'?s do it)[.!]*$/iu
]);

const STOP_OR_DELAY_RE = /\b(?:stop|wait|hold on|pause|cancel|not yet|do not|don't|never mind)\b/iu;
const CHAT_AUTHOR_PREFIX_RE = /^\[[^\]\r\n]{1,100}\]\s*/u;

export function toolSearchBridgesActive(tools, _env = process.env) {
  const names = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => String(tool?.name ?? ""))
      .filter((name) => TOOL_SEARCH_BRIDGE_NAME_SET.has(name))
  );
  return TOOL_SEARCH_BRIDGE_NAMES.every((name) => names.has(name));
}

export async function prepareTurnHints({
  runtime,
  text,
  projectId = DEFAULT_PROJECT_ID,
  channel = "chat",
  memoryScope = "main"
} = {}) {
  const principlePromise = channel !== "subagent" && runtime?.vectorStore
    ? Promise.resolve()
        .then(() => runtime.vectorStore.search(
          "principle",
          text,
          { limit: 10, minScore: 0.1 }
        ))
        .then((rawHits) => filterPrincipleHits(rawHits, runtime.memory, {
          limit: 3,
          scope: memoryScope
        }))
        .catch(() => [])
    : Promise.resolve([]);
  const ambientPromise = (
    projectId === DEFAULT_PROJECT_ID
    && channel !== "autopilot"
    && channel !== "cron"
    && channel !== "subagent"
    && runtime?.observations?.getRecentContext
  )
    ? Promise.resolve()
        .then(() => runtime.observations.getRecentContext({
          minutes: 10,
          maxChars: 1500,
          maxSnippets: 6
        }))
        .catch(() => null)
    : Promise.resolve(null);
  const [intuitions, ambientContext] = await Promise.all([
    principlePromise,
    ambientPromise
  ]);
  return { intuitions, ambientContext };
}

function openAIToolPlan(toolRegistry, options = {}) {
  if (typeof toolRegistry?.toOpenAIToolPlan === "function") {
    return toolRegistry.toOpenAIToolPlan(options);
  }
  const tools = toolRegistry?.toOpenAITools?.(options) ?? [];
  return {
    active: toolSearchBridgesActive(tools),
    tools,
    omittedNames: Object.freeze([]),
    notice: toolRegistry?.modelToolOverflowNotice?.(options) ?? null
  };
}

function normalizedDirectReply(value) {
  return String(value ?? "").trim().replace(CHAT_AUTHOR_PREFIX_RE, "").trim();
}

export function hasImperativeToolIntent(value) {
  return CHAT_TOOL_INTENT_RE.test(normalizedDirectReply(value));
}

export function resolveChatMaxIterations(env = process.env) {
  const parsed = Number(env.OPENAGI_CHAT_MAX_ITERATIONS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHAT_MAX_ITERATIONS;
}

export function providerHistoryBeforeCurrentTurn(messages, currentMessageId) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const lastIndex = messages.length - 1;
  const matchedIndex = messages.findIndex(
    (message) => message?.id && message.id === currentMessageId
  );
  if (matchedIndex >= 0 && matchedIndex !== lastIndex) {
    throw new Error("Current user turn is not the final session message.");
  }
  const current = messages[lastIndex];
  if (matchedIndex < 0 && current?.role !== "user") {
    throw new Error("Session append did not return the current user turn last.");
  }
  return messages.slice(0, lastIndex);
}

function freshResponsesContinuationMetadata({
  lineageId = createConversationLineageIdentity([]),
  headMessageId = null
} = {}) {
  return {
    version: 1,
    incarnation: createId("continuation"),
    epoch: 0,
    headMessageId: typeof headMessageId === "string" && headMessageId
      ? headMessageId
      : null,
    lineageId
  };
}

function validResponsesContinuationMetadata(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const read = (key) => {
      const descriptor = descriptors[key];
      return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    };
    const version = read("version");
    const incarnation = read("incarnation");
    const epoch = read("epoch");
    const headMessageId = read("headMessageId");
    const lineageId = read("lineageId");
    return Boolean(
      version === 1
      && typeof incarnation === "string"
      && incarnation.length > 0
      && Number.isSafeInteger(epoch)
      && epoch >= 0
      && (headMessageId === null || typeof headMessageId === "string")
      && typeof lineageId === "string"
      && /^[a-f0-9]{64}$/u.test(lineageId)
    );
  } catch {
    return false;
  }
}

function sameResponsesContinuationMetadata(left, right) {
  return Boolean(
    validResponsesContinuationMetadata(left)
    && validResponsesContinuationMetadata(right)
    && left.incarnation === right.incarnation
    && left.epoch === right.epoch
    && left.headMessageId === right.headMessageId
    && left.lineageId === right.lineageId
  );
}

function jsonUtf8Bytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function requestShapeTelemetry({
  history,
  currentInput,
  images,
  instructions,
  visibleTools,
  toolRegistry,
  allowedToolNames,
  readOnly,
  toolsEligible
}) {
  const visible = Array.isArray(visibleTools) ? visibleTools : [];
  const visibleNames = new Set(visible.map((tool) => tool?.name).filter(Boolean));
  const allowed = Array.isArray(allowedToolNames)
    ? new Set(allowedToolNames)
    : null;
  const eligible = toolsEligible && typeof toolRegistry?.list === "function"
    ? toolRegistry.list({ readOnly }).filter((tool) => !allowed || allowed.has(tool.name))
    : [];
  const deferred = eligible.filter((tool) => !visibleNames.has(tool.name));
  const deferredSchemas = deferred.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
  return Object.freeze({
    historyMessageCount: Array.isArray(history) ? history.length : 0,
    historyBytes: jsonUtf8Bytes(history),
    currentTurnCount: 1,
    currentInputBytes: Buffer.byteLength(String(currentInput ?? ""), "utf8"),
    imageCount: Array.isArray(images) ? images.length : 0,
    instructionBytes: Buffer.byteLength(String(instructions ?? ""), "utf8"),
    visibleToolCount: visible.length,
    visibleSchemaBytes: jsonUtf8Bytes(visible),
    deferredToolCount: deferred.length,
    deferredSchemaBytes: jsonUtf8Bytes(deferredSchemas)
  });
}

export function isConversationalTurn({ channel, verdict, detectedTask, text, isSpecialist = false }) {
  const interactive = channel !== "autopilot"
    && channel !== "cron"
    && channel !== "subagent"
    && channel !== "batch";
  // The band gate is NOT the chat-vs-work separator — a plain factual question
  // ("what is the capital of France?") scores ~0.58 → verdict `act`, so keying on
  // {ignore, watch} left the fast lane inert in prod. The real separator is the
  // task/imperative filters below; here we only exclude the verdicts that mean the
  // model itself wants to gate the turn (`ask` = clarify first, `propagate` = escalate).
  const bandAllowsFastLane = verdict !== "ask" && verdict !== "propagate";
  return Boolean(
    interactive
    // Specialists carry a bounded scoped allowlist that IS the point of the
    // turn — never trim them to the generic chat-core set.
    && !isSpecialist
    && bandAllowsFastLane
    && !detectedTask
    && !hasImperativeToolIntent(text)
  );
}

export function isExplicitConsent(value) {
  const reply = normalizedDirectReply(value);
  if (!reply || /[?\uFF1F]/u.test(reply) || STOP_OR_DELAY_RE.test(reply)) return false;
  return CONSENT_PHRASE_PATTERNS.some((pattern) => pattern.test(reply));
}

export function assistantMessageEndsWithQuestion(message) {
  if (message?.role !== "assistant") return false;
  const visibleEnd = String(message.content ?? "")
    .trim()
    .replace(/[*_`"'”’)\]}]+$/u, "")
    .trim();
  return /[?\uFF1F]$/u.test(visibleEnd);
}

function isDirectReplyToQuestion(value) {
  const reply = normalizedDirectReply(value);
  return Boolean(reply) && !/[?\uFF1F]/u.test(reply) && !STOP_OR_DELAY_RE.test(reply);
}

const TOOL_POLICY_RANK = Object.freeze({ full: 0, confirm: 1, "read-only": 2, none: 3 });

function policyForVerdict(action) {
  if (action === "watch") return "read-only";
  if (action === "ask") return "confirm";
  if (action === "ignore") return "none";
  return "full";
}

function verdictForPolicy(policy) {
  if (policy === "read-only") return "watch";
  if (policy === "confirm") return "ask";
  if (policy === "none") return "ignore";
  return "act";
}

export function stricterToolPolicy(localPolicy, ceilingPolicy) {
  const local = Object.hasOwn(TOOL_POLICY_RANK, localPolicy) ? localPolicy : "full";
  const ceiling = Object.hasOwn(TOOL_POLICY_RANK, ceilingPolicy) ? ceilingPolicy : "full";
  return TOOL_POLICY_RANK[local] >= TOOL_POLICY_RANK[ceiling] ? local : ceiling;
}

export class AgentHost {
  constructor(options = {}) {
    this.runtime = options.runtime;
    if (!this.runtime) throw new Error("AgentHost requires a runtime.");
    this.store = options.store ?? new InMemoryAgentStore(options.storeOptions);
    const modelProviderOptions = {
      ...(options.modelProviderOptions ?? {}),
      secrets: options.modelProviderOptions?.secrets ?? this.runtime.secrets,
      dataDir: options.modelProviderOptions?.dataDir ?? this.runtime.secrets?.dataDir
    };
    this.workspaceDir = path.resolve(
      options.workspaceDir
      ?? this.runtime.checkpoints?.workspaceDir
      ?? process.cwd()
    );
    this.modelProvider = options.modelProvider ?? createModelProvider(modelProviderOptions);
    this.backgroundReviewer = options.backgroundReviewer ?? new BackgroundReviewer({
      runtime: this.runtime,
      modelProvider: this.modelProvider
    });
    this.backgroundReviewLog = options.backgroundReviewLog ?? ((error) => {
      console.warn(`[openagi] background review failed: ${error?.message ?? String(error)}`);
    });
    this.lastBackgroundReview = null;
    this.activeHookSessions = new Map();
    this.sessionMemorySnapshots = new Map();
    this.backgroundReviewPromises = new Map();
    this.backgroundReviewRescanSessions = new Set();
    this.sessionReviewDependencies = new Map();
    this.backgroundReviewSnapshotWaitMs = positiveDuration(
      options.backgroundReviewSnapshotWaitMs,
      DEFAULT_BACKGROUND_REVIEW_SNAPSHOT_WAIT_MS
    );
    this.backgroundReviewFlushMs = positiveDuration(
      options.backgroundReviewFlushMs,
      DEFAULT_BACKGROUND_REVIEW_FLUSH_MS
    );
  }

  async handleMessage(input) {
    if (input?.ephemeral === true) return this._handleMessage(input, null);
    const lifecycle = { agentStarted: false, startedAt: Date.now(), result: null, error: null };
    try {
      lifecycle.result = await this._handleMessage(input, lifecycle);
      return lifecycle.result;
    } catch (error) {
      lifecycle.error = error;
      throw error;
    } finally {
      if (lifecycle.agentStarted) {
        this._notifyHook("agent:end", {
          ...lifecycle.base,
          completed: lifecycle.error == null,
          interrupted: Boolean(input?.abortSignal?.aborted || lifecycle.error?.name === "AbortError"),
          response: lifecycle.result?.reply ?? null,
          error: lifecycle.error?.message ?? null,
          iterations: lifecycle.result?.model?.iterations ?? null,
          stopReason: lifecycle.result?.model?.stopReason ?? null,
          durationMs: Math.max(0, Date.now() - lifecycle.startedAt)
        });
      }
    }
  }

  async _handleMessage(input, lifecycle = null) {
    const channel = input.channel ?? "local";
    const from = input.from ?? "user";
    let agentId = input.agentId ?? "main";
    const text = String(input.text ?? input.message ?? "").trim();
    if (!text) throw new Error("Message text is required.");
    const turnProvider = input.modelProviderOverride ?? this.modelProvider;
    if (!turnProvider || typeof turnProvider.generate !== "function") {
      throw new Error("A model provider with generate() is required.");
    }
    // Ephemeral turns (setup-wizard "say hi" test) must leave no trace:
    // no session in the dashboard list, no auto-task, no memory write,
    // no outcome — they're a connectivity check, not a conversation.
    const ephemeral = input.ephemeral === true;

    // Specialist routing: see if any active specialist's bounded scope matches.
    // The caller can opt out by passing input.routeTo === false (used by sub-agents to avoid loops).
    let routing = null;
    if (input.routeTo !== false && this.runtime.specialistRouter && agentId === "main") {
      const tags = ["message", channel];
      const specialists = this.runtime.propagation?.list?.() ?? [];
      const decision = await this.runtime.specialistRouter.decide(text, tags, specialists);
      routing = decision;
      if (decision.route && decision.candidate) {
        agentId = decision.candidate.specialist.id;
      }
    }

    const sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId });
    const agent = this.store.getAgent(agentId);
    const isSpecialist = agent.role === "specialist";
    let requestedProjectId = input.projectId ?? input.metadata?.projectId ?? null;
    if (
      !this.runtime.projects
      && requestedProjectId != null
      && String(requestedProjectId).trim()
      && String(requestedProjectId).trim().toLowerCase() !== DEFAULT_PROJECT_ID
    ) {
      throw new ProjectBoundaryError(
        `Project '${String(requestedProjectId).trim()}' cannot be used because the project store is unavailable.`,
        { requestedProjectId: String(requestedProjectId).trim() }
      );
    }
    let legacySession = false;
    let hasProjectBinding = false;
    if (!ephemeral && this.runtime.projects) {
      try {
        hasProjectBinding = Boolean(
          this.runtime.projects.hasSessionBinding?.(sessionId)
        );
      } catch (error) {
        throw new ProjectBoundaryError(
          `Project binding for session '${sessionId}' cannot be verified.`,
          { sessionId, cause: error?.message ?? String(error) }
        );
      }
    }
    if (!ephemeral && this.runtime.projects && !hasProjectBinding) {
      let existingSession;
      try {
        existingSession = this.store.getSession(sessionId);
      } catch (error) {
        throw new ProjectBoundaryError(
          `Transcript project for session '${sessionId}' cannot be verified.`,
          { sessionId, cause: error?.message ?? String(error) }
        );
      }
      const transcriptProject = projectIdentityFromTranscript(
        existingSession?.messages,
        sessionId
      );
      if (transcriptProject.projectId) {
        const explicitProjectId = requestedProjectId == null
          || (typeof requestedProjectId === "string" && requestedProjectId.trim() === "")
          ? null
          : normalizeAgentHostProjectId(requestedProjectId, "requested project");
        if (explicitProjectId && explicitProjectId !== transcriptProject.projectId) {
          throw new ProjectBoundaryError(
            `Session '${sessionId}' transcript belongs to project '${transcriptProject.projectId}', not '${explicitProjectId}'.`,
            {
              sessionId,
              projectId: transcriptProject.projectId,
              requestedProjectId: explicitProjectId
            }
          );
        }
        // The durable message tag is authoritative after a binding record is
        // lost. resolveForSession validates that the project still exists and
        // is active before atomically restoring the binding.
        requestedProjectId = transcriptProject.projectId;
      } else {
        legacySession = transcriptProject.legacySession;
      }
    }
    let project = this.runtime.projects?.resolveForSession
      ? this.runtime.projects.resolveForSession(sessionId, {
          requestedProjectId,
          legacySession,
          bind: !ephemeral,
          actor: `${channel}:${from}`
        })
      : {
          id: DEFAULT_PROJECT_ID,
          name: "Default",
          workspaceRoot: this.workspaceDir,
          instructions: "",
          policy: { toolPolicy: "full", allowedTools: ["*"] },
          secretRefs: ["*"],
          activeSkills: ["*"],
          mcpGrants: ["*"],
          hookIds: ["*"],
          kanbanBoardId: "default",
          modelProfile: {},
          routingProfile: {}
        };
    let capabilityProfileResolution = null;
    if (
      this.runtime.profiles
      && typeof this.runtime.profiles.applyToProject === "function"
    ) {
      const applied = this.runtime.profiles.applyToProject(project, sessionId);
      project = applied.project;
      capabilityProfileResolution = applied.resolution;
    }
    assertProjectProviderSecrets(project, turnProvider);
    const durableJobId = verifyAgentHostJobContext(
      this.runtime,
      input,
      project,
      channel
    );
    const requestedMemoryScope = String(input.memoryScope ?? "").trim();
    const baseMemoryScope = projectMemoryScope(
      project,
      isSpecialist ? agent.id : null
    );
    const projectMemoryRoot = `project:${project.id}`;
    if (
      requestedMemoryScope
      && project.id === DEFAULT_PROJECT_ID
      && requestedMemoryScope.startsWith("project:")
    ) {
      throw new ProjectBoundaryError(
        "The default project cannot enter a nondefault project memory scope.",
        { projectId: project.id, requestedMemoryScope }
      );
    }
    const memoryScope = !requestedMemoryScope
      ? baseMemoryScope
      : project.id === DEFAULT_PROJECT_ID
        ? requestedMemoryScope
        : (
            requestedMemoryScope === projectMemoryRoot
            || requestedMemoryScope.startsWith(`${projectMemoryRoot}:`)
          )
          ? requestedMemoryScope
          : `${projectMemoryRoot}:${requestedMemoryScope}`;
    const profileScope = profileMemoryScope({ channel, from, sessionId });
    const turnId = String(input.__turnId ?? input.turnId ?? createId("turn"));
    let continuationSessionMetadata = null;
    if (!ephemeral && typeof this.store.ensureSessionMetadata === "function") {
      try {
        continuationSessionMetadata = await this.store.ensureSessionMetadata(
          sessionId,
          RESPONSES_CONTINUATION_METADATA_KEY,
          () => freshResponsesContinuationMetadata()
        );
      } catch {
        // Continuation metadata is an optimization; chat remains stateless.
      }
    }
    const frozenSessionMemorySnapshot = await this.sessionMemorySnapshotFor(
      sessionId,
      memoryScope,
      agentId,
      { ephemeral, profileScope }
    );
    let sessionMemorySnapshot = frozenSessionMemorySnapshot;
    let memoryWake = null;
    if (this.runtime.memtree?.wake) {
      try {
        memoryWake = this.runtime.memtree.wake({
          scope: memoryScope,
          profileScope
        });
        if (memoryWake.text) sessionMemorySnapshot = memoryWake.text;
        if (this._memtreeWakeWarn) this._memtreeWakeWarn.suppressed = 0;
        if (memoryWake.merges?.length > 0) {
          console.log(`[memtree] wake scope=${memoryScope} total=${memoryWake.total} pending=${memoryWake.merges.length}`);
        }
      } catch (error) {
        memoryWake = null;
        sessionMemorySnapshot = frozenSessionMemorySnapshot;
        // Hot path: log the first failure, then at most once per 60s, carrying
        // the suppressed-repeat count so a persistently failing wake (lock
        // contention, corrupt TREE record, disk full) stays visible without
        // emitting one line per turn forever.
        const warnState = this._memtreeWakeWarn ?? (this._memtreeWakeWarn = { lastAt: 0, suppressed: 0 });
        const now = Date.now();
        if (now - warnState.lastAt >= 60000) {
          const suppressedNote = warnState.suppressed > 0 ? ` (suppressed ${warnState.suppressed} repeated failure(s) since last log)` : "";
          warnState.lastAt = now;
          warnState.suppressed = 0;
          try {
            console.warn(`[memtree] wake failed scope=${memoryScope} — falling back to frozen session memory snapshot${suppressedNote}: ${error?.stack ?? error}`);
          } catch {}
        } else {
          warnState.suppressed += 1;
        }
      }
    }

    // A real inbound user message always wins over an automated goal loop.
    // Discord also performs this at enqueue time so a queued message can stop
    // an in-flight judge before same-session serialization reaches this point.
    if (
      !ephemeral
      && input.goalContinuation !== true
      && input.metadata?.authorBot !== true
      && !["autopilot", "cron", "subagent"].includes(channel)
    ) {
      try {
        if (this.runtime.goals?.get?.(sessionId)?.status === "active") {
          this.runtime.goals.preempt(sessionId, "real user message");
        }
      } catch {
        // Goal control is advisory to accepting a real user message.
      }
    }

    // Recover an orphaned pre-upgrade Discord transcript on first resolve. When
    // the guild session key gained a :user segment, the old 3-segment history
    // was stranded. Copy it into the new key once, idempotently, best-effort --
    // a failure degrades to a fresh session, never breaks the turn.
    const legacyId = legacyDiscordKey(sessionId);
    if (legacyId && typeof this.store.migrateLegacyKey === "function") {
      try { this.store.migrateLegacyKey(sessionId, legacyId); }
      catch (err) { this.log?.({ op: "session-migrate-failed", sessionId, legacyId, error: err?.message ?? String(err) }); }
    }

    const detectedTask = detectTaskInChat(text);

    // Auto-task detection — if the user said "remind me to X" / "todo: X" /
    // "I need to X", create a task in the user queue without requiring them
    // to invoke add_task. Best-effort; failures don't block the chat reply.
    if (
      !ephemeral
      && project.id === DEFAULT_PROJECT_ID
      && this.runtime?.tasks?.add
      && agentId === "main"
      && channel !== "autopilot"
      && channel !== "subagent"
    ) {
      if (detectedTask) {
        try {
          this.runtime.tasks.add(
            {
              title: detectedTask.title,
              sourceMeta: {
                sessionId,
                projectId: project.id,
                snippet: text.slice(0, 200),
                trigger: detectedTask.trigger
              }
            },
            { source: "chat", queue: "user" }
          );
        } catch { /* swallow */ }
      }
    }

    const currentMessageId = createId("msg");
    const sessionBefore = ephemeral
      ? {
          id: sessionId,
          messages: [{
            id: currentMessageId,
            role: "user",
            content: text,
            agentId,
            channel,
            from,
            metadata: {
              ...(input.metadata ?? {}),
              projectId: project.id,
              profileMemoryScope: profileScope
            }
          }]
        }
      : await this.store.appendMessage(sessionId, {
          id: currentMessageId,
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: {
            ...(input.metadata ?? {}),
            projectId: project.id,
            profileMemoryScope: profileScope
          }
        });
    const providerHistory = providerHistoryBeforeCurrentTurn(
      sessionBefore.messages,
      currentMessageId
    );
    let continuationHistoryIdentity = null;
    let continuationCurrentContentIdentity = null;
    if (!ephemeral) {
      try {
        continuationHistoryIdentity = createConversationLineageIdentity(providerHistory);
        continuationCurrentContentIdentity = createConversationContentIdentity(text);
        const historyHeadMessageId = providerHistory.at(-1)?.id ?? null;
        if (
          !validResponsesContinuationMetadata(continuationSessionMetadata)
          || continuationSessionMetadata.headMessageId !== historyHeadMessageId
          || continuationSessionMetadata.lineageId !== continuationHistoryIdentity
        ) {
          const observed = continuationSessionMetadata;
          const replacement = freshResponsesContinuationMetadata({
            lineageId: continuationHistoryIdentity,
            headMessageId: historyHeadMessageId
          });
          if (typeof this.store.updateSessionMetadata === "function") {
            continuationSessionMetadata = await this.store.updateSessionMetadata(
              sessionId,
              RESPONSES_CONTINUATION_METADATA_KEY,
              (current) => {
                if (sameResponsesContinuationMetadata(current, observed)) {
                  return replacement;
                }
                if (
                  !validResponsesContinuationMetadata(current)
                  && !validResponsesContinuationMetadata(observed)
                ) {
                  return replacement;
                }
                return current;
              }
            );
          } else {
            continuationSessionMetadata = null;
          }
        }
        if (
          !validResponsesContinuationMetadata(continuationSessionMetadata)
          || continuationSessionMetadata.headMessageId !== historyHeadMessageId
          || continuationSessionMetadata.lineageId !== continuationHistoryIdentity
        ) {
          continuationSessionMetadata = null;
        }
      } catch {
        // Continuation is an optimization. Unsafe or unbounded transcript
        // identity input falls back to the existing stateless request path.
        continuationSessionMetadata = null;
      }
    }

    if (lifecycle) {
      lifecycle.base = {
        channel,
        platform: channel,
        userId: from,
        sessionId,
        sessionKey: sessionId,
        turnId,
        agentId,
        projectId: project.id,
        projectRevision: project.revision ?? 1,
        projectHookIds: [...(project.hookIds ?? [])],
        message: text
      };
      this.activeHookSessions.set(sessionId, {
        projectId: project.id,
        projectRevision: project.revision ?? 1,
        projectHookIds: [...(project.hookIds ?? [])]
      });
      if (sessionBefore.messages.length === 1) {
        this._notifyHook("session:start", lifecycle.base);
      }
      this._notifyHook("session:message", { ...lifecycle.base, role: "user", content: text });
      lifecycle.agentStarted = true;
      this._notifyHook("agent:start", lifecycle.base);
    }

    // Incremental session indexing (search_sessions): every persisted message
    // is added to the FTS index as it lands. Best-effort — an indexing failure
    // must never block a chat reply. Ephemeral turns leave no trace anywhere,
    // including here.
    if (!ephemeral && this.runtime.sessionIndex) {
      this.runtime.sessionIndex.indexMessage(sessionId, agentId, sessionBefore.messages.at(-1)).catch(() => {});
    }

    if (!ephemeral && channel !== "autopilot" && channel !== "cron" && channel !== "subagent") {
      try { this.runtime.outcomes?.resolveByUserFollowup?.(sessionId, text); } catch { /* best effort */ }
    }

    const signal = await this.messageToSignal({
      text,
      channel,
      from,
      agent,
      sessionId,
      memoryScope,
      projectId: project.id,
      metadata: {
        ...(input.metadata ?? {}),
        projectId: project.id
      },
      scrutinyOverrides: input.scrutinyOverrides ?? null
    });
    const output = this.runtime.processSignal(signal, {
      scope: memoryScope,
      parentSpecialistId: isSpecialist ? agent.id : null,
      allowPropagation: channel !== "subagent",
      ephemeral
    });
    const referenceOptions = {
      workspaceDir: project.workspaceRoot ?? this.workspaceDir,
      signal: input.abortSignal
    };
    if (project.id !== DEFAULT_PROJECT_ID) {
      referenceOptions.homeDir = project.workspaceRoot;
    }
    // Scrutiny may safely prepare late-bound files, so expansion starts only
    // after processSignal. From here it can overlap independent policy, tool
    // catalog, principle, and ambient-context preparation without changing
    // the exact model input.
    const providerInputPreparation = expandContextReferences(
      text,
      referenceOptions
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );

    if (output.propagation?.specialist) {
      this.ensureSpecialistAgent(output.propagation.specialist, agentId);
    }

    // The effective scrutiny verdict has consequences, not just prompt flavor:
    //   act       → full tool access
    //   ask       → side-effecting calls pass through the confirmation/audit
    //               lane (auto-approve may execute them immediately)
    //   watch     → read-only tools only (filtered list + invoke-time gate)
    //   ignore    → no tools; the user still gets a (brief) reply — a direct
    //               human message is never silently dropped
    //   propagate → full access (the specialist spawn already happened above)
    const rawVerdict = output.scrutiny.action;
    const interactiveTurn = channel !== "autopilot" && channel !== "cron";
    const previousAssistantAsked = interactiveTurn
      && assistantMessageEndsWithQuestion(sessionBefore.messages.at(-2));
    const consentOverride = Boolean(previousAssistantAsked && isExplicitConsent(text));
    // WHY: one clarification is enough. If the Creator directly answers it,
    // another low-evidence `ask` would recreate the live infinite loop even
    // when the answer is not one of the explicit consent phrases.
    const askDamped = Boolean(
      !consentOverride
      && previousAssistantAsked
      && rawVerdict === "ask"
      && isDirectReplyToQuestion(text)
    );
    const localVerdict = consentOverride || askDamped ? "act" : rawVerdict;
    const localToolPolicy = policyForVerdict(localVerdict);
    // Delegated/headless turns receive the parent policy as a ceiling. Taking
    // the stricter rank lets a child become more cautious, never less cautious.
    const delegatedCeiling = stricterToolPolicy(
      input.scrutinyPolicyCeiling,
      project.policy?.toolPolicy
    );
    const toolPolicy = stricterToolPolicy(localToolPolicy, delegatedCeiling);
    const scrutinyCeilingApplied = toolPolicy !== localToolPolicy;
    const verdict = scrutinyCeilingApplied ? verdictForPolicy(toolPolicy) : localVerdict;
    const overrideReasons = [];
    if (consentOverride) overrideReasons.push("explicit consent after an assistant question");
    else if (askDamped) overrideReasons.push("repeated ask damped after one clarifying question");
    if (scrutinyCeilingApplied) overrideReasons.push(`parent scrutiny ceiling enforced as ${toolPolicy}`);
    const verdictOverrideReason = overrideReasons.length > 0 ? overrideReasons.join("; ") : null;
    const addedReasons = [];
    if (consentOverride) {
      addedReasons.push("Consent lane: the user explicitly authorized the work after the assistant's question; proceed now.");
    } else if (askDamped) {
      addedReasons.push("Anti-loop damping: one clarifying question was already answered; proceed using that answer.");
    }
    if (scrutinyCeilingApplied) {
      addedReasons.push(`Delegation ceiling: the parent turn permits ${toolPolicy} access at most; the child cannot escalate it.`);
    }
    // Keep output.scrutiny untouched for outcome/audit consumers. Only the
    // model/tool lane receives the effective verdict selected above.
    const effectiveScrutiny = verdict === rawVerdict && addedReasons.length === 0
      ? output.scrutiny
      : {
          ...output.scrutiny,
          action: verdict,
          reasons: [
            ...(output.scrutiny.reasons ?? []),
            ...addedReasons
          ]
        };
    const effectiveOutput = effectiveScrutiny === output.scrutiny
      ? output
      : { ...output, scrutiny: effectiveScrutiny };
    // Tell the live-progress observer (Discord status line) what the
    // scrutiny gate decided before any model/tool work starts.
    recordRunInspector(this.runtime, {
      runId: turnId,
      projectId: project.id,
      sessionId,
      phase: "turn_start",
      status: "running",
      metadata: {
        agentId,
        scrutinyScore: output.scrutiny.score
      }
    });
    if (typeof input.onToolEvent === "function") {
      try { input.onToolEvent({ phase: "verdict", action: verdict, score: output.scrutiny.score }); } catch { /* advisory */ }
    }
    const conversational = isConversationalTurn({ channel, verdict, detectedTask, text, isSpecialist });
    const resumedGoalTurn = input.goalContinuation === true
      && this.runtime.goals?.get?.(sessionId)?.status === "active";
    const toolRegistry = this.runtime.tools;
    const chatCoreTools = this.runtime.memtree
      ? [...CHAT_CORE_TOOLS, ...BUDGETED_MEMORY_CORE_TOOLS]
      : CHAT_CORE_TOOLS;
    const specialistCoreTools = this.runtime.memtree
      ? [...SPECIALIST_CORE_TOOLS, ...BUDGETED_MEMORY_CORE_TOOLS]
      : SPECIALIST_CORE_TOOLS;
    const completionContract = createCompletionContract(text, {
      channel,
      referenceOnly: input.metadata?.moaReference === true
    });
    const preferredToolNames = completionToolPreferences(completionContract);
    const preferencePlan = preferredToolNames.length > 0
      ? { prefer: preferredToolNames }
      : {};

    // Specialist bounds: a bounded specialist sees (and may invoke) only its
    // scoped allowlist + the core set every specialist needs. Without this,
    // "bounded" was advisory prompt text and any specialist could call any
    // tool in the system.
    const requestedAllowedToolNames = Array.isArray(input.allowedTools)
      ? [...new Set(input.allowedTools.filter((name) => typeof name === "string" && name))]
      : null;
    const projectAllowedToolNames = Array.isArray(project.policy?.allowedTools)
      && !project.policy.allowedTools.includes("*")
      ? [...project.policy.allowedTools]
      : null;
    let allowedToolNames = projectAllowedToolNames
      ? requestedAllowedToolNames
        ? projectAllowedToolNames.filter((name) => requestedAllowedToolNames.includes(name))
        : projectAllowedToolNames
      : requestedAllowedToolNames;
    if (isSpecialist) {
      const scoped = agent.metadata?.specialist?.allowedTools ?? [];
      const specialistAllowed = [...new Set([...specialistCoreTools, ...scoped])];
      // Project, request, and specialist restrictions are cumulative. The
      // specialist scope must never replace a narrower project allowlist.
      allowedToolNames = allowedToolNames
        ? specialistAllowed.filter((name) => allowedToolNames.includes(name))
        : specialistAllowed;
    }

    // The fast lane trims schemas only. Side-effect and scope enforcement
    // below remains authoritative even for core tools advertised on a watch
    // or ignore turn. Project capability context must also shape the initial
    // wildcard plan so ungranted MCP/skill metadata never reaches the model.
    const projectToolPlanContext = this.runtime.projects
      ? {
          __projectId: project.id,
          __projectRevision: project.revision ?? 1,
          __projectMcpGrants: [...(project.mcpGrants ?? [])],
          __projectActiveSkills: [...(project.activeSkills ?? [])],
          __capabilityProfileResolution: capabilityProfileResolution
            ? structuredClone(capabilityProfileResolution)
            : null,
          __capabilityProfileIdentity:
            capabilityProfileResolution?.identity ?? null
        }
      : {};
    const planScrutinyPolicy = toolPolicy === "read-only"
      ? "read-only"
      : toolPolicy === "none"
        ? "none"
        : null;
    let toolPlan = toolPolicy === "none" && !conversational
      ? { active: false, tools: [], omittedNames: Object.freeze([]), notice: null }
      : openAIToolPlan(
          toolRegistry,
          conversational
            ? {
                ...preferencePlan,
                only: chatCoreTools,
                readOnly: toolPolicy === "read-only",
                context: {
                  ...projectToolPlanContext,
                  __scrutinyPolicy: planScrutinyPolicy
                }
              }
            : {
                ...preferencePlan,
                readOnly: toolPolicy === "read-only",
                context: {
                  ...projectToolPlanContext,
                  __scrutinyPolicy: planScrutinyPolicy
                }
              }
        );
    let tools = toolPlan.tools;
    // Embedders may supply a custom registry with none of OpenAGI's named
    // chat-core tools. Preserve their historical watch behavior rather than
    // silently advertising nothing; the production registry never needs this
    // fallback because it owns every name in CHAT_CORE_TOOLS.
    const chatCoreUnavailable = conversational && tools.length === 0 && toolPolicy === "read-only";
    if (chatCoreUnavailable) {
      toolPlan = openAIToolPlan(toolRegistry, {
        ...preferencePlan,
        readOnly: true,
        context: {
          ...projectToolPlanContext,
          __scrutinyPolicy: "read-only"
        }
      });
      tools = toolPlan.tools;
    }

    if (allowedToolNames) {
      const scopedNames = conversational && !chatCoreUnavailable
        ? chatCoreTools.filter((name) => allowedToolNames.includes(name))
        : allowedToolNames;
      toolPlan = toolPolicy === "none" && !conversational
        ? { active: false, tools: [], omittedNames: Object.freeze([]), notice: null }
        : openAIToolPlan(toolRegistry, {
            ...preferencePlan,
            only: scopedNames,
            readOnly: toolPolicy === "read-only",
            context: {
              ...projectToolPlanContext,
              __allowedTools: allowedToolNames,
              __scrutinyPolicy: planScrutinyPolicy
            }
          });
      tools = toolPlan.tools;
    }
    const toolOverflowNotice = toolPlan.notice ?? null;
    const toolSearchActive = toolSearchBridgesActive(
      tools,
      toolRegistry?.toolSearchController?.env ?? process.env
    );

    // Self-declaring fast lane: when a casual turn is trimmed to CHAT_CORE_TOOLS
    // the agent should KNOW it is on the trimmed lane, how many tools are held
    // back, and how to pull them — no trigger word, just awareness. Only fires
    // when the trim actually happened (conversational + core list served), so a
    // full-arsenal work turn never sees it.
    const fastLane = (conversational && !chatCoreUnavailable)
      ? {
          advertised: tools.length,
          hidden: Math.max(0, (toolRegistry?.list?.().length ?? tools.length) - tools.length)
        }
      : null;

    // Lava intuition (C2): top principles from the vector store inserted into
    // the prompt as soft hints — distinct from explicit memoryHits.
    const preparedHints = prepareTurnHints({
      runtime: this.runtime,
      text,
      projectId: project.id,
      channel,
      memoryScope
    });

    // Ambient on-screen context: top apps + most recent OCR snippets from
    // the last 10 minutes. Lets the agent ground its replies in what the
    // user is actually doing, not just what they typed. Best-effort —
    // failures fall through silently so chat keeps working without capture.
    // Ambient capture is user-global rather than project-owned. Only the
    // default control plane may place OCR/window text in a model prompt.
    const { intuitions, ambientContext } = await preparedHints;

    const memoryHitsForModel = output.customContext.map((entry) => ({
      score: entry.score,
      item: {
        id: entry.id,
        tier: entry.tier,
        content: entry.content
      }
    }));

    const turnAbortController = new AbortController();
    const inputAbortSignal = input.abortSignal;
    const onInputAbort = () => turnAbortController.abort(inputAbortSignal.reason);
    if (inputAbortSignal?.aborted) onInputAbort();
    else inputAbortSignal?.addEventListener?.("abort", onInputAbort, { once: true });
    const parsedSpawnDepth = Number(input.spawnDepth);
    const forwardToolEvent = (event) => {
      const inspected = turnInspectorMetadata(event);
      recordRunInspector(this.runtime, {
        runId: turnId,
        projectId: project.id,
        sessionId,
        ...inspected,
        metadata: {
          agentId,
          ...inspected.metadata
        }
      });
      if (typeof input.onToolEvent === "function") {
        try { input.onToolEvent(event); } catch { /* advisory */ }
      }
      // Mirror live tool activity onto the runtime event bus so dashboard
      // surfaces (SSE -> pixel pet, holo avatar) react to turns driven by ANY
      // channel — Discord, Telegram, cron, API — not just the web composer.
      // Best-effort and advisory: never let a listener fault break the turn.
      try {
        this.runtime.events?.emit?.("agent-activity", {
          projectId: project.id,
          sessionId,
          channel,
          agentId,
          phase: event?.phase ?? null,
          name: event?.name ?? event?.toolName ?? null,
          ok: event?.ok ?? null,
          n: event?.n ?? null,
          max: event?.max ?? null,
          // Extra advisory fields so bus consumers (Discord activity feed,
          // dashboard Ops tab) can render delegate progress and wall-clock
          // checkpoint state instead of only bare tool start/end.
          state: event?.state ?? null,
          total: event?.total ?? null,
          extensionsLeft: event?.extensionsLeft ?? null
        });
      } catch { /* advisory */ }
      if (lifecycle && event?.phase === "iteration") {
        this._notifyHook("agent:step", {
          ...lifecycle.base,
          iteration: event.n ?? null,
          maxIterations: event.max ?? null,
          toolNames: []
        });
      }
    };
    const modelContext = {
      channel,
      from,
      target: from,
      agentId,
      sessionId,
      projectId: project.id,
      // Channel-native tools such as speak need the destination selected by
      // the inbound adapter, not the user's id stored in `from`.
      channelId: input.metadata?.channelId ?? null,
      runtime: this.runtime,
      // Enforced in ToolRegistry.invoke — the filtered tool list above is
      // advisory to the model; this gate is not.
      // 'none' (ignore) and 'read-only' (watch) are ENFORCED in
      // ToolRegistry.invoke — the advertised tool list is advisory only
      // (providers treat an empty list as "use everything"), so the gate is
      // what actually holds.
      __scrutinyPolicy: toolPolicy === "none" ? "none" : toolPolicy === "read-only" ? "read-only" : toolPolicy === "confirm" ? "confirm" : null,
      __reason: toolPolicy === "confirm" ? confirmPolicyReason(output.scrutiny.score) : null,
      __allowedTools: allowedToolNames,
      // Provider-side schema shaping only; ToolRegistry.invoke deliberately
      // does not read this field.
      __advertisedTools: conversational && !chatCoreUnavailable ? chatCoreTools : null,
      __toolSearchActive: toolSearchActive,
      __completionContract: completionContract,
      // Exact request-local radar universe used to build `tools` above.
      // Discovery and forwarding intersect it with enforced policy/scope.
      __toolRadarOmitted: toolPlan.omittedNames,
      __memoryScope: memoryScope,
      __profileMemoryScope: profileScope,
      ...(this.runtime.projects ? {
        __projectId: project.id,
        __projectRevision: project.revision ?? 1,
        __projectWorkspaceDir: project.workspaceRoot,
        __projectSecretRefs: [...(project.secretRefs ?? [])],
        __projectActiveSkills: [...(project.activeSkills ?? [])],
        __projectMcpGrants: [...(project.mcpGrants ?? [])],
        __projectHookIds: [...(project.hookIds ?? [])],
        __projectKanbanBoardId: project.kanbanBoardId ?? "default",
        __projectModelProfile: structuredClone(project.modelProfile ?? {}),
        __projectRoutingProfile: structuredClone(project.routingProfile ?? {}),
        __capabilityProfileResolution: capabilityProfileResolution
          ? structuredClone(capabilityProfileResolution)
          : null,
        __capabilityProfileIdentity:
          capabilityProfileResolution?.identity ?? null
      } : {}),
      __continuationEligible: Boolean(
        !ephemeral
        && continuationHistoryIdentity
        && continuationCurrentContentIdentity
        && validResponsesContinuationMetadata(continuationSessionMetadata)
      ),
      __continuationHistoryIdentity: continuationHistoryIdentity,
      __continuationCurrentContentIdentity: continuationCurrentContentIdentity,
      __continuationContextEpoch: continuationSessionMetadata?.epoch ?? null,
      __continuationSessionIncarnation: continuationSessionMetadata?.incarnation ?? null,
      __continuationHeadMessageId: continuationSessionMetadata?.headMessageId ?? null,
      __turnId: turnId,
      __jobId: durableJobId,
      __budgetEnvelope: input.budgetEnvelope ?? null,
      __turnDeadline: Number.isFinite(input.turnDeadline)
        ? input.turnDeadline
        : null,
      __spawnDepth: Number.isInteger(parsedSpawnDepth) && parsedSpawnDepth >= 0 ? parsedSpawnDepth : 0,
      __abortSignal: turnAbortController.signal,
      __turnAbortController: turnAbortController,
      // Live-progress observer: channels (Discord) pass a callback so the
      // user can watch tool activity in real time. Best-effort, advisory.
      // Always attached now — even with no channel callback, forwardToolEvent
      // mirrors activity onto the runtime bus for dashboard/pet reactivity.
      __onToolEvent: forwardToolEvent
    };
    if (memoryWake) {
      initializeMemoryRequestMetrics(modelContext, {
        memoryBytesInjected: Buffer.byteLength(sessionMemorySnapshot, "utf8")
      });
      incrementMemoryRequestMetric(
        modelContext,
        "mergesRequested",
        memoryWake.merges.length
      );
    }

    let modelResult;
    try {
      const preparedInput = await providerInputPreparation;
      if (!preparedInput.ok) throw preparedInput.error;
      const providerInput = preparedInput.value;
      const providerInstructions = this.instructionsForAgent(
        agent,
        project,
        capabilityProfileResolution
      );
      const providerImages = Array.isArray(input.images) ? input.images : [];
      modelContext.__requestShape = requestShapeTelemetry({
        history: providerHistory,
        currentInput: providerInput,
        images: providerImages,
        instructions: providerInstructions,
        visibleTools: tools,
        toolRegistry,
        allowedToolNames,
        readOnly: toolPolicy === "read-only",
        toolsEligible: toolPolicy !== "none" || conversational
      });
      const defaultTask = (channel === "autopilot" || channel === "cron")
        ? "autopilot"
        : "chat";
      // A delegated child states the KIND of work it was handed, which routes it
      // to a model matched to that work. It sits below an explicit project
      // routing profile (an operator pin still wins) but above the channel
      // default, which would otherwise send every subagent to the base model.
      const requestedTask = cleanRoutingTask(input.routingTask);
      const profileModel = cleanProfileString(project.modelProfile?.model);
      const profileTier = cleanProfileString(
        project.routingProfile?.tier ?? project.modelProfile?.tier
      );
      const profileTask = cleanProfileString(project.routingProfile?.task)
        ?? requestedTask
        ?? defaultTask;
      modelResult = await turnProvider.generate({
        input: providerInput,
        agent,
        // Route by what the call IS, so model tiering applies: autonomous pulses
        // (autopilot/cron) are cheap "anything to do?" work; everything else is
        // user-facing chat. Both default to the base model until tiers/pins are set.
        task: profileTask,
        ...(profileModel ? { model: profileModel } : {}),
        ...(profileTier ? { tier: profileTier } : {}),
        scrutiny: effectiveScrutiny,
        memoryHits: memoryHitsForModel,
        // The current message is already carried by `input` after context
        // reference expansion. Provider history must contain only earlier
        // turns or both paid paths serialize the current user content twice.
        messages: providerHistory,
        images: providerImages,
        instructions: providerInstructions,
        sessionMemorySnapshot,
        turnContext: this.turnContextForAgent(effectiveOutput, memoryHitsForModel, intuitions, ambientContext, input.metadata?.screenContext ?? null, toolOverflowNotice, { channel, metadata: input.metadata ?? null }, fastLane),
        tools,
        toolRegistry,
        context: modelContext,
        onDelta: typeof input.onDelta === "function" ? input.onDelta : null,
        maxIterations: conversational && !resumedGoalTurn ? resolveChatMaxIterations() : input.maxIterations,
        maxTurnSeconds: input.maxTurnSeconds
      });
    } catch (error) {
      turnAbortController.abort(error);
      recordRunInspector(this.runtime, {
        runId: turnId,
        projectId: project.id,
        sessionId,
        phase: "turn_failed",
        status: "failed",
        metadata: {
          agentId,
          errorCode: error?.code ?? error?.name ?? "provider_error"
        }
      });
      throw error;
    } finally {
      toolRegistry?.clearFailureScope?.(modelContext);
      inputAbortSignal?.removeEventListener?.("abort", onInputAbort);
    }

    let selfOptimizationReward = null;
    if (!ephemeral && this.runtime.selfOptimization?.judgeCompletion) {
      try {
        selfOptimizationReward = this.runtime.selfOptimization.judgeCompletion({
          completionEvidence: modelResult.completionEvidence ?? null,
          assistantText: modelResult.text,
          toolCalls: modelResult.toolCalls ?? []
        });
      } catch {
        // Optimization telemetry must never turn a completed user turn into a failure.
        selfOptimizationReward = null;
      }
    }

    const outcomeRecord = ephemeral ? null : this.runtime.outcomes?.record({
      kind: input.origin === "autopilot" ? "autopilot-fire" : input.origin === "cron" ? "cron-fire" : "agent-reply",
      refId: null, // patched after we know assistant message id
      signalId: signal.id,
      sessionId,
      agentId,
      channel,
      scrutinyAction: output.scrutiny.action,
      scrutinyDimensions: output.scrutiny.dimensions,
      toolCalls: (modelResult.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false })),
      metadata: {
        projectId: project.id,
        specialistId: agent.role === "specialist" ? agent.id : null,
        signalSummary: signal.summary,
        scrutinyScore: output.scrutiny.score,
        consentOverride,
        askDamped,
        conversational,
        completionEvidence: modelResult.completionEvidence ?? null,
        ...(selfOptimizationReward
          ? { selfOptimization: selfOptimizationReward }
          : {}),
        scrutinyCeilingApplied,
        effectiveScrutinyAction: verdict,
        verdictOverrideReason,
        routing: routing ? {
          mode: routing.mode,
          routed: routing.route,
          candidateId: routing.candidate?.specialist?.id ?? null,
          score: routing.candidate?.score ?? null,
          threshold: routing.threshold
        } : null
      }
    }) ?? null;

    const continuationCandidate = modelResult.__responsesContinuationCandidate ?? null;
    let sessionAfter;
    try {
      sessionAfter = ephemeral
        ? { id: sessionId, messages: [{ role: "user", content: text }, { role: "assistant", content: modelResult.text }] }
        : await this.store.appendMessage(sessionId, {
            role: "assistant",
            content: modelResult.text,
            agentId,
            channel,
            from: "openagi",
            metadata: {
              provider: modelResult.provider,
              model: modelResult.model,
              responseId: modelResult.id,
              usage: modelResult.usage ?? null,
              requestShape: modelContext.__requestShape,
              iterations: modelResult.iterations ?? null,
              maxIterations: modelResult.maxIterations ?? null,
              stopReason: modelResult.stopReason ?? null,
              completionEvidence: modelResult.completionEvidence ?? null,
              outputId: output.id,
              outcomeId: outcomeRecord?.id ?? null,
              conversational,
              backgroundReview: input.backgroundReview !== false,
              projectId: project.id,
              memoryScope,
              profileMemoryScope: profileScope,
              toolCalls: (modelResult.toolCalls ?? []).map((call) => ({
                name: call.name,
                arguments: sanitizeForAudit(call.arguments),
                ok: call.result?.ok ?? false
              }))
            }
          });
    } catch (error) {
      turnProvider.abandonResponsesContinuation?.(continuationCandidate);
      throw error;
    }

    if (
      !ephemeral
      && validResponsesContinuationMetadata(continuationSessionMetadata)
      && typeof this.store.updateSessionMetadata === "function"
    ) {
      let nextContinuationMetadata = null;
      try {
        const assistantMessageId = sessionAfter.messages.at(-1)?.id ?? null;
        const nextLineageId = createConversationLineageIdentity(sessionAfter.messages);
        const proposed = {
          ...continuationSessionMetadata,
          epoch: continuationSessionMetadata.epoch + 1,
          headMessageId: assistantMessageId,
          lineageId: nextLineageId
        };
        const updated = await this.store.updateSessionMetadata(
          sessionId,
          RESPONSES_CONTINUATION_METADATA_KEY,
          (current) => {
            const latestHead = this.store.getSession(sessionId).messages.at(-1)?.id ?? null;
            if (
              latestHead === assistantMessageId
              && sameResponsesContinuationMetadata(current, continuationSessionMetadata)
            ) {
              return proposed;
            }
            return current;
          }
        );
        if (sameResponsesContinuationMetadata(updated, proposed)) {
          nextContinuationMetadata = updated;
        }
      } catch {
        // A stale or failed metadata update keeps the provider continuation
        // uncommitted. The durable transcript remains authoritative.
      }
      if (nextContinuationMetadata && continuationCandidate) {
        turnProvider.commitResponsesContinuation?.(continuationCandidate, {
          messages: sessionAfter.messages,
          contextEpoch: nextContinuationMetadata.epoch,
          sessionIncarnation: nextContinuationMetadata.incarnation,
          headMessageId: nextContinuationMetadata.headMessageId
        });
      } else {
        turnProvider.abandonResponsesContinuation?.(continuationCandidate);
      }
    } else {
      turnProvider.abandonResponsesContinuation?.(continuationCandidate);
    }

    if (outcomeRecord) outcomeRecord.refId = sessionAfter.messages.at(-1)?.id ?? null;

    if (!ephemeral && this.runtime.sessionIndex) {
      this.runtime.sessionIndex.indexMessage(sessionId, agentId, sessionAfter.messages.at(-1)).catch(() => {});
    }

    if (lifecycle) {
      this._notifyHook("session:message", {
        ...lifecycle.base,
        role: "assistant",
        content: modelResult.text
      });
    }

    if (!ephemeral) {
      this.runtime.memory.remember(
        {
          source: "agent-host",
          scope: memoryScope,
          content: `Session ${sessionId} user asked: ${text}\nAgent replied: ${modelResult.text}`,
          tags: ["agent-turn", channel, agentId],
          novelty: output.scrutiny.dimensions.novelty,
          risk: output.scrutiny.dimensions.risk,
          repetition: output.scrutiny.dimensions.repetition,
          specificity: 0.6,
          metadata: {
            sessionId,
            agentId,
            projectId: project.id,
            outputId: output.id
          }
        },
        {
          source: "agent-host",
          strength: output.scrutiny.score
        }
      );
    }

    recordRunInspector(this.runtime, {
      runId: turnId,
      projectId: project.id,
      sessionId,
      phase: "turn_complete",
      status: modelResult.completionEvidence?.status === "incomplete"
        ? "failed"
        : "succeeded",
      metadata: {
        agentId,
        provider: modelResult.provider,
        model: modelResult.model,
        iteration: modelResult.iterations,
        maxIterations: modelResult.maxIterations,
        stopReason: modelResult.stopReason,
        evidenceKind: modelResult.completionEvidence?.kind,
        evidenceStatus: modelResult.completionEvidence?.status,
        mutationEvidence: modelResult.completionEvidence?.mutationCount,
        verificationEvidence: modelResult.completionEvidence?.verificationCount,
        visualEvidence: modelResult.completionEvidence?.visualCount,
        evidenceNudges: modelResult.completionEvidence?.nudges,
        inputTokens: inspectorUsageValue(
          modelResult.usage,
          "inputTokens",
          "input_tokens",
          "prompt_tokens"
        ),
        outputTokens: inspectorUsageValue(
          modelResult.usage,
          "outputTokens",
          "output_tokens",
          "completion_tokens"
        ),
        cachedTokens: inspectorUsageValue(
          modelResult.usage,
          "cachedTokens",
          "cached_tokens",
          "cache_read_input_tokens"
        )
      }
    });

    return {
      id: turnId,
      createdAt: nowIso(),
      agent,
      session: {
        id: sessionAfter.id,
        messageCount: sessionAfter.messages.length,
        projectId: project.id
      },
      project: {
        id: project.id,
        name: project.name
      },
      reply: modelResult.text,
      toolCalls: (modelResult.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false })),
      model: {
        id: modelResult.id ?? null,
        provider: modelResult.provider,
        model: modelResult.model,
        usage: modelResult.usage ?? null,
        configured: turnProvider.isConfigured?.() ?? true,
        iterations: modelResult.iterations ?? null,
        maxIterations: modelResult.maxIterations ?? null,
        stopReason: modelResult.stopReason ?? null
      },
      conversational,
      output
    };
  }

  resetSession(options = {}) {
    const input = typeof options === "string" ? { sessionId: options } : options;
    const previousSessionId = String(input.sessionId ?? "").trim();
    if (!previousSessionId) throw new Error("resetSession requires sessionId");
    const sessionId = String(input.nextSessionId ?? createId("session"));
    const activeProject = this.activeHookSessions.get(previousSessionId) ?? null;
    const base = {
      channel: input.channel ?? "local",
      platform: input.channel ?? "local",
      userId: input.from ?? "user",
      agentId: input.agentId ?? "main",
      projectId: input.projectId ?? activeProject?.projectId ?? "default",
      projectRevision: input.projectRevision ?? activeProject?.projectRevision ?? 1,
      projectHookIds: Array.isArray(input.projectHookIds)
        ? [...input.projectHookIds]
        : [...(activeProject?.projectHookIds ?? [])]
    };
    const review = this.queueBackgroundReviewForSession(previousSessionId, base);
    if (review) this.trackSessionReviewDependency(sessionId, review);
    this._notifyHook("session:end", { ...base, sessionId: previousSessionId, reason: "reset" });
    this.activeHookSessions.delete(previousSessionId);
    this._notifyHook("session:reset", { ...base, previousSessionId, sessionId });
    return { previousSessionId, sessionId };
  }

  async branchSession(options = {}) {
    const input = plainBranchRequest(options);
    const sourceSessionId = boundedBranchIdentifier(
      input.sourceSessionId,
      "sourceSessionId",
      2048
    );
    const messageId = boundedBranchIdentifier(
      input.messageId ?? input.throughMessageId,
      "messageId",
      512
    );

    const selectedProjectId = input.projectId == null
      ? this.runtime.projects?.projectForSession?.(sourceSessionId)?.id ?? DEFAULT_PROJECT_ID
      : input.projectId;
    const projectId = normalizeAgentHostProjectId(
      selectedProjectId,
      "branch project id"
    );
    const project = typeof this.runtime.projects?.authorize === "function"
      ? this.runtime.projects.authorize(projectId, {
          sessionId: sourceSessionId,
          includeArchived: false
        })
      : projectId === DEFAULT_PROJECT_ID
        ? {
            id: DEFAULT_PROJECT_ID,
            revision: 1,
            hookIds: []
          }
        : null;
    if (!project) {
      throw new ProjectBoundaryError("Unknown session.", {
        sourceSessionId,
        projectId
      });
    }

    if (typeof this.store?.createSessionBranch !== "function") {
      throw new Error("Agent session store does not support branching.");
    }
    let targetSessionId = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = createId("session");
      if (typeof this.store.hasSession === "function" && this.store.hasSession(candidate)) {
        continue;
      }
      if (this.runtime.projects?.hasSessionBinding?.(candidate)) continue;
      targetSessionId = candidate;
      break;
    }
    if (!targetSessionId) {
      throw new Error("Unable to allocate a unique branch session id.");
    }

    const createdAt = nowIso();
    let targetBound = false;
    let targetProfileBound = false;
    let sourceSessionProfile = null;
    if (typeof this.runtime.profiles?.resolve === "function") {
      const resolution = this.runtime.profiles.resolve(
        project.id,
        sourceSessionId
      );
      if (
        resolution?.active
        && !resolution.locked
        && resolution.binding === "session"
      ) {
        sourceSessionProfile = resolution;
      }
    }
    let branched;
    try {
      if (typeof this.runtime.projects?.resolveForSession === "function") {
        this.runtime.projects.resolveForSession(targetSessionId, {
          requestedProjectId: project.id,
          legacySession: false,
          bind: true,
          actor: "session:branch"
        });
        targetBound = true;
      }
      if (
        sourceSessionProfile
        && typeof this.runtime.profiles?.bindSessionProfile === "function"
      ) {
        this.runtime.profiles.bindSessionProfile(
          project.id,
          targetSessionId,
          sourceSessionProfile.profileId,
          {
            expectedBindingProfileId: null,
            expectedProfileRevision: sourceSessionProfile.profileRevision,
            actor: "session:branch"
          }
        );
        targetProfileBound = true;
      }
      branched = await this.store.createSessionBranch(sourceSessionId, {
        messageId,
        targetSessionId,
        projectId: project.id,
        createdAt
      });
    } catch (error) {
      let targetPersisted = true;
      if (typeof this.store?.hasSession === "function") {
        try {
          targetPersisted = this.store.hasSession(targetSessionId);
        } catch {
          // A corrupt or unverifiable transcript must retain its binding.
        }
      }
      if (
        targetProfileBound
        && !targetPersisted
        && typeof this.runtime.profiles?.bindSessionProfile === "function"
      ) {
        try {
          this.runtime.profiles.bindSessionProfile(
            project.id,
            targetSessionId,
            null,
            {
              expectedBindingProfileId: sourceSessionProfile.profileId,
              actor: "session:branch:rollback"
            }
          );
        } catch {
          // The original branch failure remains authoritative.
        }
      }
      if (
        targetBound
        && !targetPersisted
        && typeof this.runtime.projects?.unbindSession === "function"
      ) {
        try {
          this.runtime.projects.unbindSession(project.id, targetSessionId, {
            actor: "session:branch:rollback"
          });
        } catch {
          // The original branch failure remains authoritative.
        }
      }
      throw error;
    }
    const target = branched?.session ?? branched;
    const messages = Array.isArray(target?.messages)
      ? target.messages
      : this.store.getSession(targetSessionId).messages;
    if (this.runtime.sessionIndex?.indexMessage) {
      await Promise.allSettled(messages.map((message) => (
        this.runtime.sessionIndex.indexMessage(
          targetSessionId,
          message?.agentId ?? input.agentId ?? "main",
          message
        )
      )));
    }
    const event = {
      projectId: project.id,
      sourceSessionId,
      sessionId: targetSessionId,
      messageId,
      messageCount: messages.length,
      at: createdAt
    };
    try { this.runtime.events?.emit?.("session-branched", event); } catch { /* advisory */ }
    this._notifyHook("session:branch", event);
    return {
      ...event,
      projectRevision: this.runtime.projects?.authorize?.(project.id, {
        sessionId: targetSessionId,
        includeArchived: false
      })?.revision ?? project.revision ?? 1
    };
  }

  async endActiveHookSessions(reason = "gateway-close") {
    const pending = new Set(this.backgroundReviewPromises.values());
    for (const [sessionId, projectScope] of this.activeHookSessions) {
      const review = this.queueBackgroundReviewForSession(sessionId, projectScope);
      if (review) pending.add(review);
      this._notifyHook("session:end", { sessionId, reason, ...projectScope });
    }
    this.activeHookSessions.clear();
    return boundedAllSettled([...pending], this.backgroundReviewFlushMs);
  }

  _notifyHook(event, payload) {
    try { this.runtime.hooks?.notify?.(event, sanitizeForAudit(payload)); } catch { /* hooks are advisory */ }
  }

  queueBackgroundReview(turn) {
    if (!backgroundReviewEnabled() || typeof this.backgroundReviewer?.review !== "function") return null;
    // WHY: yield the completed turn back to the channel first. The auxiliary
    // review is best-effort and must never delay or replace the user reply.
    const pending = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.backgroundReviewer.review(turn))
      .catch((error) => {
        try { this.backgroundReviewLog(error); } catch { /* logging is advisory */ }
        return { skipped: true, reason: `review failed: ${error?.message ?? String(error)}` };
      });
    this.lastBackgroundReview = pending;
    return pending;
  }

  queueBackgroundReviewForSession(sessionId, defaults = {}) {
    if (!backgroundReviewEnabled() || typeof this.backgroundReviewer?.review !== "function") return null;
    const existing = this.backgroundReviewPromises.get(sessionId);
    if (existing) {
      this.backgroundReviewRescanSessions.add(sessionId);
      return existing;
    }

    const initial = this.prepareBackgroundReviewForSession(sessionId, defaults);
    if (!initial) return null;

    const run = async () => {
      let prepared = initial;
      let result = null;
      do {
        this.backgroundReviewRescanSessions.delete(sessionId);
        prepared = prepared ?? this.prepareBackgroundReviewForSession(sessionId, defaults);
        if (prepared) {
          result = await this.queueBackgroundReview(prepared.turn);
          if (result?.skipped === false) {
            await this.advanceBackgroundReviewWatermark(sessionId, prepared.watermark);
          }
        }
        prepared = null;
      } while (this.backgroundReviewRescanSessions.delete(sessionId));
      return result;
    };

    let pending;
    pending = run()
      .catch((error) => {
        try { this.backgroundReviewLog(error); } catch { /* logging is advisory */ }
        return { skipped: true, reason: `review failed: ${error?.message ?? String(error)}` };
      })
      .finally(() => {
        if (this.backgroundReviewPromises.get(sessionId) === pending) {
          this.backgroundReviewPromises.delete(sessionId);
        }
      });
    this.backgroundReviewPromises.set(sessionId, pending);
    this.lastBackgroundReview = pending;
    return pending;
  }

  prepareBackgroundReviewForSession(sessionId, defaults = {}) {
    let session;
    try { session = this.store.getSession(sessionId); } catch { return null; }
    let project = null;
    if (this.runtime.projects?.projectForSession) {
      try {
        project = this.runtime.projects.projectForSession(sessionId);
      } catch {
        // Archived, corrupt, or otherwise unresolved bindings fail closed:
        // auxiliary review must never fall back into the default project.
        return null;
      }
      if (!project) return null;
    }
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const start = backgroundReviewStartIndex(messages, session?.metadata?.[BACKGROUND_REVIEW_WATERMARK_KEY]);
    const lastAssistantIndex = findLastIndex(messages, (message, index) => (
      index >= start && message?.role === "assistant"
    ));
    if (lastAssistantIndex < start) return null;

    const delta = cloneMessages(messages.slice(start, lastAssistantIndex + 1));
    const reviewable = reviewableBackgroundMessages(delta);
    const substantive = reviewable.some((message) => (
      message?.role === "assistant"
      && message.metadata?.conversational === false
    ));
    if (!substantive) return null;

    const users = reviewable.filter((message) => message?.role === "user");
    const assistants = reviewable.filter((message) => message?.role === "assistant");
    const toolCalls = assistants.flatMap((message) => (
      Array.isArray(message.metadata?.toolCalls) ? message.metadata.toolCalls : []
    ));
    const lastAssistant = assistants.at(-1);
    const reviewedMessageCount = lastAssistantIndex + 1;
    const reviewedLastMessageId = messages[lastAssistantIndex]?.id ?? null;
    const agentId = lastAssistant?.agentId ?? defaults.agentId ?? "main";
    let specialistId = null;
    try {
      if (this.store.getAgent(agentId)?.role === "specialist") specialistId = agentId;
    } catch {
      // A missing agent record keeps the project root as the safe fallback.
    }
    return {
      turn: {
        sessionId,
        agentId,
        memoryScope: lastAssistant?.metadata?.memoryScope
          ?? (project ? projectMemoryScope(project, specialistId) : "main"),
        profileMemoryScope: lastAssistant?.metadata?.profileMemoryScope
          ?? users.at(-1)?.metadata?.profileMemoryScope
          ?? null,
        channel: users.at(-1)?.channel ?? lastAssistant?.channel ?? null,
        from: users.at(-1)?.from ?? null,
        ...(project ? {
          projectId: project.id,
          projectRevision: project.revision ?? 1,
          modelProfile: structuredClone(project.modelProfile ?? {}),
          routingProfile: structuredClone(project.routingProfile ?? {})
        } : {}),
        userText: users.at(-1)?.content ?? "",
        assistantText: lastAssistant?.content ?? "",
        toolCalls,
        messages: reviewable
      },
      watermark: {
        version: 1,
        reviewedMessageCount,
        reviewedLastMessageId,
        reviewedAt: nowIso()
      }
    };
  }

  async advanceBackgroundReviewWatermark(sessionId, watermark) {
    if (typeof this.store.updateSessionMetadata === "function") {
      return this.store.updateSessionMetadata(sessionId, BACKGROUND_REVIEW_WATERMARK_KEY, (current) => {
        const currentCount = Number(current?.reviewedMessageCount);
        return Number.isSafeInteger(currentCount) && currentCount >= watermark.reviewedMessageCount
          ? current
          : watermark;
      });
    }
    const session = this.store.getSession(sessionId);
    session.metadata = { ...(session.metadata ?? {}), [BACKGROUND_REVIEW_WATERMARK_KEY]: watermark };
    await this.store.saveSession(session);
    return watermark;
  }

  trackSessionReviewDependency(sessionId, review) {
    this.sessionReviewDependencies.set(sessionId, review);
    const cleanup = () => {
      if (this.sessionReviewDependencies.get(sessionId) === review) {
        this.sessionReviewDependencies.delete(sessionId);
      }
    };
    Promise.resolve(review).then(cleanup, cleanup);
  }

  async messageToSignal({
    text,
    channel,
    from,
    agent,
    sessionId,
    memoryScope = "main",
    projectId = DEFAULT_PROJECT_ID,
    metadata,
    scrutinyOverrides = null
  }) {
    const lower = text.toLowerCase();
    const asksToRemember = REMEMBER_RE.test(lower);
    const asksToSchedule = SCHEDULE_RE.test(lower);
    const asksToSpecialize = SPECIALIZE_RE.test(lower);

    // C2: measured axes replace the old per-signal constants. Deterministic
    // heuristics over the text plus the runtime's stores; absent stores
    // degrade to the previous keyword values (see src/signal-axes.js).
    const axes = await measureAxes({
      text,
      memorySystem: this.runtime.memory ?? null,
      vectorStore: this.runtime.vectorStore ?? null,
      outcomeStore: this.runtime.outcomes ?? null,
      memoryScope,
      projectId
    });

    const taskType = asksToSpecialize ? "specialization-candidate" : "adaptation-review";

    const signal = {
      id: createId("sig"),
      source: channel,
      type: "message",
      domain: "general",
      taskType,
      summary: text.slice(0, 240),
      content: text,
      citations: [`session:${sessionId}`, `agent:${agent.id}`, `from:${from}`],
      tags: ["message", channel, agent.id],
      urgency: metadata.urgent ? 0.85 : 0.45,
      impact: axes.impact,
      externalPressure: 0.55,
      internalPressure: asksToSchedule ? 0.7 : 0.5,
      novelty: axes.novelty,
      repetition: axes.repetition,
      risk: axes.risk,
      ambiguity: 0.35,
      confidence: axes.confidence,
      specificity: axes.specificity,
      conflict: 0,
      goalAlignment: 0.75,
      strategicFit: 0.7,
      requiresSpecialist: asksToSpecialize || asksToSchedule,
      scrutinyOverrides,
      receivedAt: nowIso(),
      metadata
    };

    // C2/G2: specialization candidates carry a content-derived bounded scope
    // and success metric (propagation-controller.js:99-100 consumes them),
    // plus a scope-derived goal — the dedupe signature hashes
    // {workflow, domain, taskType, goal} (propagation-controller.js:177-184),
    // so without a distinct goal every scope would still collapse into one
    // general-specialization-candidate specialist.
    if (taskType === "specialization-candidate") {
      const scope = deriveSpecialistScope(text, signal.domain);
      if (scope) {
        signal.specialistScope = scope;
        signal.successMetric = "outcome quality >= 0.6 over next 10 activations";
        signal.goal = `Handle ${scope} tasks within a bounded scope.`;
      }
    }

    return signal;
  }

  // Capture the curated projection before processSignal can write on turn
  // one. File-backed stores persist these exact bytes in session metadata.
  async sessionMemorySnapshotFor(sessionId, scope, agentId = "main", {
    ephemeral = false,
    profileScope = null
  } = {}) {
    const render = () => {
      try {
        return String(this.runtime.memory?.renderSessionMemorySnapshot?.({ scope, profileScope }) ?? "");
      } catch {
        return "";
      }
    };
    if (ephemeral) return render();

    const reviewDependency = this.sessionReviewDependencies.get(sessionId);
    if (reviewDependency) {
      await waitBounded(reviewDependency, this.backgroundReviewSnapshotWaitMs);
    }

    const identity = {
      version: 2,
      sessionId: String(sessionId),
      scope: String(scope),
      agentId: String(agentId),
      profileScope: typeof profileScope === "string" ? profileScope : null
    };
    const metadataKey = frozenMemoryMetadataKey(
      identity.scope,
      identity.agentId,
      identity.profileScope
    );
    const createFrozen = () => ({ ...identity, text: render() });
    if (typeof this.store.ensureSessionMetadata === "function") {
      let stored = await this.store.ensureSessionMetadata(sessionId, metadataKey, createFrozen);
      if (!validFrozenMemory(stored, identity) && typeof this.store.updateSessionMetadata === "function") {
        stored = await this.store.updateSessionMetadata(sessionId, metadataKey, (current) => (
          validFrozenMemory(current, identity) ? current : createFrozen()
        ));
      }
      return validFrozenMemory(stored, identity) ? stored.text : "";
    }

    const cacheKey = JSON.stringify([
      identity.sessionId,
      identity.scope,
      identity.agentId,
      identity.profileScope
    ]);
    if (!this.sessionMemorySnapshots.has(cacheKey)) {
      if (this.sessionMemorySnapshots.size >= 1000) {
        this.sessionMemorySnapshots.delete(this.sessionMemorySnapshots.keys().next().value);
      }
      this.sessionMemorySnapshots.set(cacheKey, render());
    }
    return this.sessionMemorySnapshots.get(cacheKey) ?? "";
  }

  // STATIC persona + standing instructions only. The provider appends the
  // separately frozen session memory block; volatile retrieval hits and
  // scrutiny remain in turnContextForAgent() below.
  instructionsForAgent(agent, project = null, capabilityProfile = null) {
    const projectInstructions = String(project?.instructions ?? "").trim();
    const projectBlock = projectInstructions
      ? `\n\nProject instructions for ${project.name} (${project.id}):\n${projectInstructions}`
      : "";
    const persona = String(capabilityProfile?.persona ?? "").trim();
    const profileBlock = capabilityProfile?.active
      ? capabilityProfile.locked
        ? `\n\nCapability profile '${capabilityProfile.profileId ?? "missing"}' is locked. Do not attempt tool use until an operator selects an active profile.`
        : [
            `\n\nActive capability profile: ${capabilityProfile.profileName} (${capabilityProfile.profileId}, ${capabilityProfile.binding}-scoped).`,
            persona ? `Profile persona:\n${persona}` : ""
          ].filter(Boolean).join("\n")
      : "";
    const skillBlock = (() => {
      try {
        return this.runtime?.skills?.promptIndex?.() ?? "";
      } catch {
        return "";
      }
    })();
    const budgetedMemoryBlock = this.runtime?.memtree
      ? "\n\nBudgeted memory tools: use memory_wake to refresh the age-decayed cover, memory_zoom and memory_merge to satisfy in-band summary requests, memory_tree_recall for exact regex lookup, and read_spill for exact line ranges from oversized tool results."
      : "";
    return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

Your job is to help through the ABI loop:
1. Apply directional adaptive scrutiny.
2. Use memory deliberately. When the user CORRECTS something you previously stored or said (a time, a name, a decision, a preference), call correct_memory with the corrected fact — never just remember a second conflicting version.
3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

Answer the user plainly. If a specialist was created, mention its name and scope.${projectBlock}${profileBlock}${skillBlock}${budgetedMemoryBlock}`;
  }

  // Per-turn [context] block prepended to the latest user message (see
  // buildTurnContext in model-provider.js for the provider-side fallback).
  // Carries everything that used to make the system prompt churn per turn.
  turnContextForAgent(output, memoryHits = [], intuitions = [], ambientContext = null, screenContext = null, toolOverflowNotice = null, channelContext = null, fastLane = null) {
    const sections = [];

    sections.push(`Current decision: ${output.scrutiny.action}`);
    const guidance = verdictGuidance(output.scrutiny.action);
    if (guidance) sections.push(guidance.trimEnd());
    if (output.scrutiny.reasons?.length) {
      sections.push(`Reasons:\n${output.scrutiny.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    }

    const memory = (memoryHits ?? [])
      .slice(0, 5)
      .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
      .join("\n");
    if (memory) sections.push(`Top memory hits:\n${memory}`);

    if (intuitions.length > 0) {
      sections.push(`Intuitions (distilled long-term principles, may apply):\n${intuitions.map((i) => `- (${i.score.toFixed(2)}) ${i.text}`).join("\n")}`);
    }

    if (toolOverflowNotice) sections.push(toolOverflowNotice);

    if (ambientContext && (ambientContext.apps?.length || ambientContext.snippets?.length)) {
      const lines = ["Recent on-screen activity (last ~10 minutes — opt-in screen capture, on-device OCR):"];
      if (ambientContext.apps?.length) {
        lines.push(`Active apps: ${ambientContext.apps.map((a) => `${a.app} (${a.n})`).join(", ")}`);
      }
      if (ambientContext.snippets?.length) {
        lines.push("Recent screen snippets:");
        for (const s of ambientContext.snippets) {
          const stamp = (s.at || "").slice(11, 16); // HH:MM
          const where = s.window ? `${s.app} · ${s.window}` : s.app;
          lines.push(`- [${stamp} ${where}] ${s.text}`);
        }
      }
      lines.push("Use this to ground your reply in what the user is actually doing. Don't quote the snippets back verbatim — refer to them naturally if relevant.");
      sections.push(lines.join("\n"));
    }

    const screenBlock = formatScreenContextBlock(screenContext);
    if (screenBlock) sections.push(screenBlock.trim());

    const legionBlock = formatLegionContextBlock(channelContext);
    if (legionBlock) sections.push(legionBlock);

    const fastLaneNotice = formatFastLaneNotice(fastLane);
    if (fastLaneNotice) sections.push(fastLaneNotice);

    return `[context]\nPer-turn background assembled by the runtime — not typed by the user.\n${sections.join("\n")}\n[/context]`;
  }

  ensureSpecialistAgent(specialist, parentId) {
    // Matches the enforced allowlist in handleMessage: core set + scoped tools.
    const coreTools = this.runtime.memtree
      ? [...SPECIALIST_CORE_TOOLS, ...BUDGETED_MEMORY_CORE_TOOLS]
      : SPECIALIST_CORE_TOOLS;
    const allowedToolList = [...new Set([...coreTools, ...(specialist.allowedTools ?? [])])].join(", ");
    return this.store.ensureAgent({
      id: specialist.id,
      name: specialist.name,
      role: "specialist",
      parentId,
      scope: specialist.boundedScope,
      systemPrompt: `You are ${specialist.name}, a propagated specialist agent.

**Bounded scope:** ${specialist.boundedScope}
**Parent goal:** ${specialist.parentGoal}
**Success metric:** ${specialist.successMetric}
**Tools you can call:** ${allowedToolList}

Stay inside the bounded scope. If the user's request falls outside it, say so and recommend they go back to the main agent. Be concise — your job is to do this one thing well, repeatedly.`,
      metadata: { specialist }
    });
  }

  status() {
    return {
      provider: friendlyProviderLabel(this.modelProvider),
      providerConfigured: this.modelProvider.isConfigured(),
      providerModel: this.modelProvider.model ?? null,
      agents: this.store.listAgents(),
      sessions: this.store.listSessions()
    };
  }
}

function positiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function frozenMemoryMetadataKey(scope, agentId, profileScope = null) {
  return `frozenMemoryV2:${encodeURIComponent(String(scope))}:${encodeURIComponent(String(agentId))}:${encodeURIComponent(String(profileScope ?? ""))}`;
}

function validFrozenMemory(value, identity) {
  return Boolean(
    value
    && typeof value === "object"
    && value.version === identity.version
    && value.sessionId === identity.sessionId
    && value.scope === identity.scope
    && value.agentId === identity.agentId
    && value.profileScope === identity.profileScope
    && typeof value.text === "string"
  );
}

function backgroundReviewStartIndex(messages, watermark) {
  if (!watermark || watermark.version !== 1) return 0;
  const count = Number(watermark.reviewedMessageCount);
  const id = String(watermark.reviewedLastMessageId ?? "");
  if (!Number.isSafeInteger(count) || count <= 0 || count > messages.length || !id) return 0;
  if (messages[count - 1]?.id === id) return count;
  const recovered = messages.findIndex((message) => message?.id === id);
  return recovered >= 0 ? recovered + 1 : 0;
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function cloneMessages(messages) {
  try {
    return structuredClone(messages);
  } catch {
    return messages.map((message) => ({
      ...message,
      metadata: message?.metadata && typeof message.metadata === "object"
        ? { ...message.metadata }
        : {}
    }));
  }
}

function reviewableBackgroundMessages(messages) {
  const reviewable = [];
  let pending = [];
  for (const message of messages) {
    if (message?.role !== "assistant") {
      pending.push(message);
      continue;
    }
    if (message.metadata?.backgroundReview !== false) {
      reviewable.push(...pending, message);
    }
    pending = [];
  }
  return reviewable;
}

async function waitBounded(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve(promise).catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedAllSettled(promises, timeoutMs) {
  if (promises.length === 0) return [];
  const outcomes = new Array(promises.length);
  const settled = Promise.all(promises.map((promise, index) => (
    Promise.resolve(promise).then(
      (value) => {
        outcomes[index] = { status: "fulfilled", value };
      },
      (reason) => {
        outcomes[index] = { status: "rejected", reason };
      }
    )
  )));
  let timer = null;
  const timedOut = Symbol("background-review-timeout");
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (result !== timedOut) return outcomes;
  return Array.from({ length: outcomes.length }, (_, index) => (
    outcomes[index] ?? {
      status: "rejected",
      reason: new Error(`Background review flush exceeded ${timeoutMs}ms.`)
    }
  ));
}

export function filterPrincipleHits(
  hits,
  memory,
  { limit = 3, now = Date.now(), scope = null } = {}
) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const hit of hits ?? []) {
    const item = memory?.items?.get?.(hit.id);
    if (!item) continue;
    if (scope && item.scope !== scope) continue;
    if (item.metadata?.supersededBy) continue;
    const quarantineUntil = item.metadata?.quarantineUntil;
    if (quarantineUntil && new Date(quarantineUntil).getTime() > nowMs) continue;
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

// What each scrutiny verdict means for THIS turn — matches the enforcement
// in agent-host.handleMessage / ToolRegistry.invoke, so the model's
// expectations line up with what will actually happen to its tool calls.
export function verdictGuidance(action) {
  if (action === "ask") {
    if (autoApproveEnabled()) {
      return "This turn: proceed with the requested work. Auto-approve is enabled, so side-effecting tools WILL run immediately and will still be logged in the approval audit trail. Do not ask another clarifying question unless a concrete missing fact makes the work unsafe.\n";
    }
    return "This turn: clarify before acting. Ask ONE focused clarifying question. Any side-effecting tool you call now will be queued for the user's approval instead of executing immediately — prefer to ask first, act next turn.\n";
  }
  if (action === "watch") {
    return "This turn: observation mode. Only read-only tools are available; side-effecting calls will be rejected. Answer from what you can read and note what you'd do once confidence is higher.\n";
  }
  if (action === "ignore") {
    return "This turn: low-signal. No tools are available. Reply briefly and move on.\n";
  }
  return "";
}

export function confirmPolicyReason(score) {
  const numericScore = Number(score);
  const renderedScore = Number.isFinite(numericScore) ? numericScore.toFixed(2) : "unknown";
  const base = `scrutiny verdict 'ask' (score ${renderedScore})`;
  return autoApproveEnabled()
    ? `${base}; auto-approve enabled, so side-effecting tools execute immediately and remain logged for audit`
    : `${base}; auto-approve disabled, so side-effecting tools are queued for user approval`;
}

// Format the fresh focused-window context the floating widget attaches to a
// message (metadata.screenContext = { app, window, text }) into a labeled
// prompt block. Returns "" when absent/empty. Pure + exported for testing.
export function formatScreenContextBlock(screenContext) {
  if (!screenContext || typeof screenContext.text !== "string" || !screenContext.text.trim()) return "";
  const where = screenContext.window
    ? `${screenContext.app || "?"} · ${screenContext.window}`
    : (screenContext.app || "active window");
  const body = screenContext.text.slice(0, 4000);
  return `\nActive window the user is looking at right now (${where}):\n${body}\nGround your answer in this if it's relevant; don't quote it back verbatim.\n`;
}

// Self-declaring conversational fast lane. On a casual turn the runtime trims
// the advertised tool schema to CHAT_CORE_TOOLS to save tokens; without this
// the agent can't tell a trim from a genuinely small toolset and reports "I
// only see ~6 tools / I have no lane to X". This block tells it, every trimmed
// turn, that it is on the fast lane, how many tools are held back, and how to
// pull them — so it stays AWARE and can self-escalate with judgment, no magic
// trigger word required. Returns "" when the turn was not trimmed. Pure +
// exported for testing.
export function formatFastLaneNotice(fastLane) {
  if (!fastLane || !Number.isFinite(fastLane.hidden) || fastLane.hidden <= 0) return "";
  return [
    "Conversational fast lane (token-saving trim):",
    `- This casual turn advertises only ${fastLane.advertised} core tools; ${fastLane.hidden} more are registered but held back to save tokens. Nothing was removed — the full toolset is still invokable.`,
    "- This trim fires automatically on chat-shaped turns. It is NOT a bug or a lost capability, and it is NOT gated on any trigger word.",
    "- When the turn is actually WORK (edit/read files, run code, control cron/jobs, drive the desktop, anything beyond the core set), call searcmcp_tools to pull the tool you need, or just proceed — a work-shaped request auto-restores the full arsenal on the next turn.",
    "- Use judgment: don't reflexively expand on every message, but don't report yourself as blocked or tool-less either. If you need a hidden tool, searcmcp_tools is always available on this lane."
  ].join("\n");
}

// Tells the agent WHERE it is when a turn arrives over Discord: which server /
// channel, that it's part of the Legion family, and that it CAN reach siblings.
// Without this the agent has no idea it lives in a Discord server or that a
// send lane to Seraphim exists. Returns "" for non-Discord turns. Pure +
// exported for testing.
export function formatLegionContextBlock(channelContext, env = process.env) {
  if (!channelContext || channelContext.channel !== "discord") return "";
  const meta = channelContext.metadata ?? {};
  const lines = ["Legion / Discord context:"];
  lines.push("- You are Azazel, a member of the Legion family of agents, active in a Discord server.");
  if (meta.channelId) {
    const scope = meta.guildId ? `channel ${meta.channelId} in server ${meta.guildId}` : `channel ${meta.channelId}`;
    lines.push(`- This turn arrived in ${scope}.`);
  }
  let siblings = [];
  try { siblings = siblingNames(env); } catch { siblings = []; }
  if (siblings.length) {
    lines.push(`- You can message a sibling through Discord with send_message(channel:"sibling", target:"<name>", text:...). The runtime prefixes the sibling's real raw-ID mention automatically. Known siblings: ${siblings.join(", ")}.`);
    lines.push("- For a Discord-independent async WSL delivery, use send_message(channel:\"mailbox\", target:\"<name>\", text:...).");
    lines.push("- To reach a specific Discord channel directly, use send_message(channel:\"discord\", target:\"<channelId>\", text:...).");
  }
  // MENTION DISCIPLINE — a plain-text "@Name" NEVER pings on Discord; siblings
  // (esp. Ziz) only respond when they get a REAL mention. Always address a
  // sibling with the raw <@userId> form. This is the exact miss that dropped
  // Ziz↔Azazel bot-to-bot contact on 2026-07-23.
  lines.push("- IMPORTANT: to actually ping a sibling you MUST use their raw Discord user id `<@id>` in the text — a plain `@Name` does not notify them. Roster (name → <@id> → where they run on the box):");
  for (const [name, m] of Object.entries(LEGION_MEMBERS)) {
    if (name === "azazel" || name === "creator") continue;
    const where = m.home ? ` — runs at ${m.home}` : "";
    lines.push(`    • ${name}: <@${m.userId}> — ${m.label}${where}`);
  }
  lines.push("- Off-Discord lane (works even if Discord is down): call send_message(channel:\"mailbox\", target:\"<sibling>\", text:...) to append a structured, ID-bearing JSON record to `~/.legion/mailbox/<sibling>.jsonl`; read your own `~/.legion/mailbox/azazel.jsonl`. Canonical roster: `~/.legion/roster.json`; protocol: `~/.legion/README.md`. Never put secrets there.");
  lines.push("- If a task needs another agent (e.g. Seraphim runs the Hermes gateway, Ziz runs the Rust zerohermes harness), reach out over the sibling lane instead of saying you have no way to contact them.");
  return lines.join("\n");
}

function plainBranchRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("branchSession requires an options object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("branchSession options must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value"))) {
    throw new TypeError("branchSession options cannot contain accessors.");
  }
  const allowed = new Set([
    "sourceSessionId",
    "messageId",
    "throughMessageId",
    "projectId",
    "agentId"
  ]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new TypeError("branchSession options contain an unsupported field.");
  }
  if (
    Object.hasOwn(descriptors, "messageId")
    && Object.hasOwn(descriptors, "throughMessageId")
  ) {
    throw new TypeError("branchSession accepts only one message selector.");
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  );
}

function boundedBranchIdentifier(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  const text = value.trim();
  if (
    text.length < 1
    || text.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function cleanProfileString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

// A routing task arrives from a caller (a delegating agent), so it is only
// honored when it names a task the router actually knows. An unknown string
// resolves to the base model inside ModelRouter anyway, but accepting it here
// would let a typo look like a deliberate routing decision in the audit trail.
function cleanRoutingTask(value) {
  const normalized = cleanProfileString(value);
  if (!normalized) return null;
  return Object.hasOwn(TASK_PROFILES, normalized) ? normalized : null;
}

function assertProjectProviderSecrets(project, provider) {
  if (!project || project.id === DEFAULT_PROJECT_ID) return;
  const required = new Set();
  const direct = String(provider?.credentialEnvSecretName ?? "").trim();
  if (direct) required.add(direct);
  try {
    for (const credential of provider?.credentialPool?.snapshot?.().credentials ?? []) {
      const name = String(credential?.secretName ?? "").trim();
      if (name) required.add(name);
    }
  } catch {
    throw new ProjectBoundaryError(
      `Model credentials for project '${project.id}' cannot be verified.`,
      { projectId: project.id }
    );
  }
  for (const secretName of required) {
    if (projectAllows(project.secretRefs, secretName)) continue;
    throw new ProjectBoundaryError(
      `Model provider requires secret reference '${secretName}' which is not granted to project '${project.id}'.`,
      { projectId: project.id, secretName }
    );
  }
}

const AGENT_HOST_PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

function verifyAgentHostJobContext(runtime, input, project, channel) {
  if (input?.jobId == null || input.jobId === "") return null;
  if (channel !== "subagent" || input.origin !== "job") {
    throw new ProjectBoundaryError("Durable job identity is invalid for this turn.");
  }
  const id = String(input.jobId);
  if (!/^job_[a-f0-9]{16}$/.test(id)) {
    throw new ProjectBoundaryError("Durable job identity is malformed.");
  }
  let record;
  try {
    record = runtime.jobStore?.get?.(id, {
      projectId: project.id
    });
  } catch {
    throw new ProjectBoundaryError("Durable job identity is outside this project.");
  }
  if (
    !record
    || record.kind !== "subagent"
    || !["running", "cancel_requested"].includes(record.status)
  ) {
    throw new ProjectBoundaryError("Durable job identity is not an active subagent job.");
  }
  return id;
}

function normalizeAgentHostProjectId(value, field = "project id") {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }
  const projectId = value.trim().toLowerCase();
  if (!AGENT_HOST_PROJECT_ID_RE.test(projectId)) {
    throw new ProjectBoundaryError(`Invalid ${field}: ${projectId || "(empty)"}.`);
  }
  return projectId;
}

function projectIdentityFromTranscript(messages, sessionId) {
  if (!Array.isArray(messages)) {
    throw new ProjectBoundaryError(
      `Transcript project for session '${sessionId}' cannot be verified.`,
      { sessionId }
    );
  }
  const projectIds = new Set();
  let tagged = false;
  for (const message of messages) {
    const metadata = message?.metadata;
    if (
      !metadata
      || typeof metadata !== "object"
      || !Object.hasOwn(metadata, "projectId")
    ) {
      continue;
    }
    tagged = true;
    try {
      projectIds.add(
        normalizeAgentHostProjectId(metadata.projectId, "persisted transcript project id")
      );
    } catch (error) {
      throw new ProjectBoundaryError(
        `Session '${sessionId}' has an invalid persisted project tag.`,
        { sessionId, cause: error?.message ?? String(error) }
      );
    }
  }
  if (projectIds.size > 1) {
    throw new ProjectBoundaryError(
      `Session '${sessionId}' has mixed persisted project tags.`,
      { sessionId, projectIds: [...projectIds].sort() }
    );
  }
  return {
    projectId: projectIds.values().next().value ?? null,
    legacySession: messages.length > 0 && !tagged
  };
}

function recordRunInspector(runtime, event) {
  try {
    runtime?.runInspector?.recordTurn?.(event);
  } catch {
    // Operational visibility is advisory and cannot break an agent turn.
  }
}

function inspectorUsageValue(usage, ...keys) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

// Maps a provider class to a short user-facing label. Avoids leaking
// "AnthropicProvider" / "OpenAIResponsesProvider" class names into the
// dashboard header.
function friendlyProviderLabel(provider) {
  if (!provider) return "—";
  const providerId = String(provider.provider ?? provider.name ?? "").toLowerCase();
  if (providerId === "moa" || provider.constructor?.name === "MoaProvider") return "MoA";
  const cls = provider.constructor?.name ?? "";
  if (cls === "AnthropicProvider") return "Anthropic";
  if (cls === "OpenAIResponsesProvider") return "OpenAI";
  if (cls === "DeterministicModelProvider") return provider.name ?? "deterministic";
  return cls.replace(/Provider$/, "") || "—";
}

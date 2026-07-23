import { InMemoryAgentStore } from "./agent-store.js";
import { createModelProvider } from "./model-provider.js";
import { createId, nowIso } from "./utils.js";
import { detectTaskInChat } from "./task-store.js";
import { deriveSpecialistScope, measureAxes, REMEMBER_RE, SCHEDULE_RE, SPECIALIZE_RE } from "./signal-axes.js";
import { autoApproveEnabled } from "./tool-registry.js";
import { sanitizeForAudit } from "./redact.js";
import { BackgroundReviewer, backgroundReviewEnabled } from "./background-review.js";
import { TOOL_SEARCH_BRIDGE_NAMES, resolveToolSearchMode } from "./tool-search.js";

// Internal tools every specialist gets regardless of scope: its own memory
// and the task queue it drains. Everything else comes from the specialist's
// scoped allowlist (selected at propagation from the bounded scope).
const SPECIALIST_CORE_TOOLS = [
  "recall", "remember",
  "list_tasks", "agent_pick_next", "complete_task", "move_task", "save_draft"
];

export const CHAT_CORE_TOOLS = Object.freeze([
  "recall",
  "remember",
  "list_sessions",
  "schedule_message",
  "run_skill",
  "list_skills",
  "goal_status",
  "pause_goal",
  "resume_goal",
  "clear_goal",
  "list_checkpoints"
]);
export const DEFAULT_CHAT_MAX_ITERATIONS = 4;
const TOOL_SEARCH_BRIDGE_NAME_SET = new Set(TOOL_SEARCH_BRIDGE_NAMES);
const DEFAULT_BACKGROUND_REVIEW_SNAPSHOT_WAIT_MS = 5000;
const DEFAULT_BACKGROUND_REVIEW_FLUSH_MS = 60_000;
const BACKGROUND_REVIEW_WATERMARK_KEY = "backgroundReviewV1";

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

export function toolSearchBridgesActive(tools, env = process.env) {
  if (resolveToolSearchMode(env) === "off") return false;
  const names = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => String(tool?.name ?? ""))
      .filter((name) => TOOL_SEARCH_BRIDGE_NAME_SET.has(name))
  );
  return TOOL_SEARCH_BRIDGE_NAMES.every((name) => names.has(name));
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

export function isConversationalTurn({ channel, verdict, detectedTask, text, isSpecialist = false }) {
  const interactive = channel !== "autopilot" && channel !== "cron" && channel !== "subagent";
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
    this.modelProvider = options.modelProvider ?? createModelProvider(modelProviderOptions);
    this.backgroundReviewer = options.backgroundReviewer ?? new BackgroundReviewer({
      runtime: this.runtime,
      modelProvider: this.modelProvider
    });
    this.backgroundReviewLog = options.backgroundReviewLog ?? ((error) => {
      console.warn(`[openagi] background review failed: ${error?.message ?? String(error)}`);
    });
    this.lastBackgroundReview = null;
    this.activeHookSessions = new Set();
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

    const agent = this.store.getAgent(agentId);
    const isSpecialist = agent.role === "specialist";
    const requestedMemoryScope = String(input.memoryScope ?? "").trim();
    const memoryScope = requestedMemoryScope || (isSpecialist ? `specialist:${agent.id}` : "main");
    const sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId });
    const turnId = String(input.__turnId ?? input.turnId ?? createId("turn"));
    const sessionMemorySnapshot = await this.sessionMemorySnapshotFor(
      sessionId,
      memoryScope,
      agentId,
      { ephemeral }
    );

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

    const detectedTask = detectTaskInChat(text);

    // Auto-task detection — if the user said "remind me to X" / "todo: X" /
    // "I need to X", create a task in the user queue without requiring them
    // to invoke add_task. Best-effort; failures don't block the chat reply.
    if (!ephemeral && this.runtime?.tasks?.add && agentId === "main" && channel !== "autopilot" && channel !== "subagent") {
      if (detectedTask) {
        try {
          this.runtime.tasks.add(
            { title: detectedTask.title, sourceMeta: { sessionId, snippet: text.slice(0, 200), trigger: detectedTask.trigger } },
            { source: "chat", queue: "user" }
          );
        } catch { /* swallow */ }
      }
    }

    const sessionBefore = ephemeral
      ? { id: sessionId, messages: [{ role: "user", content: text }] }
      : await this.store.appendMessage(sessionId, {
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: input.metadata ?? {}
        });

    if (lifecycle) {
      lifecycle.base = {
        channel,
        platform: channel,
        userId: from,
        sessionId,
        sessionKey: sessionId,
        turnId,
        agentId,
        message: text
      };
      this.activeHookSessions.add(sessionId);
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

    const signal = await this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {}, scrutinyOverrides: input.scrutinyOverrides ?? null });
    const output = this.runtime.processSignal(signal, {
      scope: memoryScope,
      parentSpecialistId: isSpecialist ? agent.id : null,
      allowPropagation: channel !== "subagent",
      ephemeral
    });

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
    const toolPolicy = stricterToolPolicy(localToolPolicy, input.scrutinyPolicyCeiling);
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
    if (typeof input.onToolEvent === "function") {
      try { input.onToolEvent({ phase: "verdict", action: verdict, score: output.scrutiny.score }); } catch { /* advisory */ }
    }
    const conversational = isConversationalTurn({ channel, verdict, detectedTask, text, isSpecialist });
    const resumedGoalTurn = input.goalContinuation === true
      && this.runtime.goals?.get?.(sessionId)?.status === "active";
    const toolRegistry = this.runtime.tools;

    // Specialist bounds: a bounded specialist sees (and may invoke) only its
    // scoped allowlist + the core set every specialist needs. Without this,
    // "bounded" was advisory prompt text and any specialist could call any
    // tool in the system.
    const requestedAllowedToolNames = Array.isArray(input.allowedTools)
      ? [...new Set(input.allowedTools.filter((name) => typeof name === "string" && name))]
      : null;
    let allowedToolNames = requestedAllowedToolNames;
    if (isSpecialist) {
      const scoped = agent.metadata?.specialist?.allowedTools ?? [];
      const specialistAllowed = [...new Set([...SPECIALIST_CORE_TOOLS, ...scoped])];
      allowedToolNames = requestedAllowedToolNames
        ? specialistAllowed.filter((name) => requestedAllowedToolNames.includes(name))
        : specialistAllowed;
    }

    // The fast lane trims schemas only. Side-effect and scope enforcement
    // below remains authoritative even for core tools advertised on a watch
    // or ignore turn.
    let tools = toolPolicy === "none" && !conversational
      ? []
      : (toolRegistry?.toOpenAITools?.(
          conversational ? { only: CHAT_CORE_TOOLS } : { readOnly: toolPolicy === "read-only" }
        ) ?? []);
    // Embedders may supply a custom registry with none of OpenAGI's named
    // chat-core tools. Preserve their historical watch behavior rather than
    // silently advertising nothing; the production registry never needs this
    // fallback because it owns every name in CHAT_CORE_TOOLS.
    const chatCoreUnavailable = conversational && tools.length === 0 && toolPolicy === "read-only";
    if (chatCoreUnavailable) {
      tools = toolRegistry?.toOpenAITools?.({ readOnly: true }) ?? [];
    }
    const toolOverflowNotice = toolPolicy === "none" && !conversational
      ? null
      : toolRegistry?.modelToolOverflowNotice?.() ?? null;

    if (allowedToolNames) {
      const scopedNames = conversational && !chatCoreUnavailable
        ? CHAT_CORE_TOOLS.filter((name) => allowedToolNames.includes(name))
        : allowedToolNames;
      tools = toolPolicy === "none" && !conversational
        ? []
        : (toolRegistry?.toOpenAITools?.({
            only: scopedNames,
            readOnly: toolPolicy === "read-only"
          }) ?? []);
    }
    const toolSearchActive = toolSearchBridgesActive(
      tools,
      toolRegistry?.toolSearchController?.env ?? process.env
    );

    // Lava intuition (C2): top principles from the vector store inserted into
    // the prompt as soft hints — distinct from explicit memoryHits.
    let intuitions = [];
    if (channel !== "subagent" && this.runtime.vectorStore) {
      try {
        const rawHits = await this.runtime.vectorStore.search("principle", text, { limit: 10, minScore: 0.1 });
        intuitions = filterPrincipleHits(rawHits, this.runtime.memory, { limit: 3 });
      } catch { /* best effort */ }
    }

    // Ambient on-screen context: top apps + most recent OCR snippets from
    // the last 10 minutes. Lets the agent ground its replies in what the
    // user is actually doing, not just what they typed. Best-effort —
    // failures fall through silently so chat keeps working without capture.
    let ambientContext = null;
    if (channel !== "autopilot" && channel !== "cron" && channel !== "subagent" && this.runtime.observations?.getRecentContext) {
      try {
        ambientContext = await this.runtime.observations.getRecentContext({ minutes: 10, maxChars: 1500, maxSnippets: 6 });
      } catch { /* swallow */ }
    }

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
      if (typeof input.onToolEvent === "function") {
        try { input.onToolEvent(event); } catch { /* advisory */ }
      }
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
      __advertisedTools: conversational && !chatCoreUnavailable ? CHAT_CORE_TOOLS : null,
      __toolSearchActive: toolSearchActive,
      __memoryScope: memoryScope,
      __turnId: turnId,
      __spawnDepth: Number.isInteger(parsedSpawnDepth) && parsedSpawnDepth >= 0 ? parsedSpawnDepth : 0,
      __abortSignal: turnAbortController.signal,
      __turnAbortController: turnAbortController,
      // Live-progress observer: channels (Discord) pass a callback so the
      // user can watch tool activity in real time. Best-effort, advisory.
      __onToolEvent: lifecycle || typeof input.onToolEvent === "function" ? forwardToolEvent : null
    };

    let modelResult;
    try {
      modelResult = await turnProvider.generate({
        input: text,
        agent,
        // Route by what the call IS, so model tiering applies: autonomous pulses
        // (autopilot/cron) are cheap "anything to do?" work; everything else is
        // user-facing chat. Both default to the base model until tiers/pins are set.
        task: (channel === "autopilot" || channel === "cron") ? "autopilot" : "chat",
        scrutiny: effectiveScrutiny,
        memoryHits: memoryHitsForModel,
        messages: sessionBefore.messages,
        images: Array.isArray(input.images) ? input.images : [],
        instructions: this.instructionsForAgent(agent),
        sessionMemorySnapshot,
        turnContext: this.turnContextForAgent(effectiveOutput, memoryHitsForModel, intuitions, ambientContext, input.metadata?.screenContext ?? null, toolOverflowNotice),
        tools,
        toolRegistry,
        context: modelContext,
        onDelta: typeof input.onDelta === "function" ? input.onDelta : null,
        maxIterations: conversational && !resumedGoalTurn ? resolveChatMaxIterations() : input.maxIterations,
        maxTurnSeconds: input.maxTurnSeconds
      });
    } catch (error) {
      turnAbortController.abort(error);
      throw error;
    } finally {
      inputAbortSignal?.removeEventListener?.("abort", onInputAbort);
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
        specialistId: agent.role === "specialist" ? agent.id : null,
        signalSummary: signal.summary,
        scrutinyScore: output.scrutiny.score,
        consentOverride,
        askDamped,
        conversational,
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

    const sessionAfter = ephemeral
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
            iterations: modelResult.iterations ?? null,
            maxIterations: modelResult.maxIterations ?? null,
            stopReason: modelResult.stopReason ?? null,
            outputId: output.id,
            outcomeId: outcomeRecord?.id ?? null,
            conversational,
            backgroundReview: input.backgroundReview !== false,
            memoryScope,
            toolCalls: (modelResult.toolCalls ?? []).map((call) => ({
              name: call.name,
              arguments: sanitizeForAudit(call.arguments),
              ok: call.result?.ok ?? false
            }))
          }
        });

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
            outputId: output.id
          }
        },
        {
          source: "agent-host",
          strength: output.scrutiny.score
        }
      );
    }

    return {
      id: turnId,
      createdAt: nowIso(),
      agent,
      session: {
        id: sessionAfter.id,
        messageCount: sessionAfter.messages.length
      },
      reply: modelResult.text,
      toolCalls: (modelResult.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false })),
      model: {
        provider: modelResult.provider,
        model: modelResult.model,
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
    const base = {
      channel: input.channel ?? "local",
      platform: input.channel ?? "local",
      userId: input.from ?? "user",
      agentId: input.agentId ?? "main"
    };
    const review = this.queueBackgroundReviewForSession(previousSessionId, base);
    if (review) this.trackSessionReviewDependency(sessionId, review);
    this._notifyHook("session:end", { ...base, sessionId: previousSessionId, reason: "reset" });
    this.activeHookSessions.delete(previousSessionId);
    this._notifyHook("session:reset", { ...base, previousSessionId, sessionId });
    return { previousSessionId, sessionId };
  }

  async endActiveHookSessions(reason = "gateway-close") {
    const pending = new Set(this.backgroundReviewPromises.values());
    for (const sessionId of this.activeHookSessions) {
      const review = this.queueBackgroundReviewForSession(sessionId, {});
      if (review) pending.add(review);
      this._notifyHook("session:end", { sessionId, reason });
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
    return {
      turn: {
        sessionId,
        agentId: lastAssistant?.agentId ?? defaults.agentId ?? "main",
        memoryScope: lastAssistant?.metadata?.memoryScope ?? "main",
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

  async messageToSignal({ text, channel, from, agent, sessionId, metadata, scrutinyOverrides = null }) {
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
      outcomeStore: this.runtime.outcomes ?? null
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
  async sessionMemorySnapshotFor(sessionId, scope, agentId = "main", { ephemeral = false } = {}) {
    const render = () => {
      try {
        return String(this.runtime.memory?.renderSessionMemorySnapshot?.({ scope }) ?? "");
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
      version: 1,
      sessionId: String(sessionId),
      scope: String(scope),
      agentId: String(agentId)
    };
    const metadataKey = frozenMemoryMetadataKey(identity.scope, identity.agentId);
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

    const cacheKey = JSON.stringify([identity.sessionId, identity.scope, identity.agentId]);
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
  instructionsForAgent(agent) {
    return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

Your job is to help through the ABI loop:
1. Apply directional adaptive scrutiny.
2. Use memory deliberately. When the user CORRECTS something you previously stored or said (a time, a name, a decision, a preference), call correct_memory with the corrected fact — never just remember a second conflicting version.
3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

Answer the user plainly. If a specialist was created, mention its name and scope.`;
  }

  // Per-turn [context] block prepended to the latest user message (see
  // buildTurnContext in model-provider.js for the provider-side fallback).
  // Carries everything that used to make the system prompt churn per turn.
  turnContextForAgent(output, memoryHits = [], intuitions = [], ambientContext = null, screenContext = null, toolOverflowNotice = null) {
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

    return `[context]\nPer-turn background assembled by the runtime — not typed by the user.\n${sections.join("\n")}\n[/context]`;
  }

  ensureSpecialistAgent(specialist, parentId) {
    // Matches the enforced allowlist in handleMessage: core set + scoped tools.
    const allowedToolList = [...new Set([...SPECIALIST_CORE_TOOLS, ...(specialist.allowedTools ?? [])])].join(", ");
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

function frozenMemoryMetadataKey(scope, agentId) {
  return `frozenMemoryV1:${encodeURIComponent(String(scope))}:${encodeURIComponent(String(agentId))}`;
}

function validFrozenMemory(value, identity) {
  return Boolean(
    value
    && typeof value === "object"
    && value.version === identity.version
    && value.sessionId === identity.sessionId
    && value.scope === identity.scope
    && value.agentId === identity.agentId
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

export function filterPrincipleHits(hits, memory, { limit = 3, now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const hit of hits ?? []) {
    const item = memory?.items?.get?.(hit.id);
    if (!item) continue;
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

import { ModelRouter } from "./model-router.js";

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_MAX_REQUEST_HOPS = 6;
const DEFAULT_MAX_TURN_SECONDS = 900;
const SYNTHETIC_CONTINUE = [
  "[system] Continue the same task now.",
  "Use the accumulated tool results and conversation above.",
  "Do not repeat completed work; keep using tools if needed, then give the user a final answer."
].join(" ");

class TurnDeadlineError extends Error {
  constructor() {
    super("The turn wall-clock deadline was reached.");
    this.name = "TurnDeadlineError";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveMaxIterations(options) {
  if (options.maxIterations !== undefined) {
    return positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  }
  // Preserve programmatic callers that still pass the former option.
  if (options.maxToolHops !== undefined) {
    return positiveInteger(options.maxToolHops, DEFAULT_MAX_ITERATIONS);
  }
  // The deprecated environment alias is consulted only when the new name is
  // genuinely unset, so a stale service setting cannot override the new knob.
  if (process.env.OPENAGI_MAX_ITERATIONS?.trim()) {
    return positiveInteger(process.env.OPENAGI_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS);
  }
  return positiveInteger(process.env.OPENAGI_MAX_TOOL_HOPS, DEFAULT_MAX_ITERATIONS);
}

function applyIterationSettings(provider, options) {
  provider.maxIterations = resolveMaxIterations(options);
  // Tests and embedders may provide both names while migrating: in that case
  // maxIterations is the outer cap and the old option remains the inner hop
  // boundary. With only maxToolHops present it is the deprecated outer alias.
  const requestHops = options.maxRequestHops
    ?? (options.maxIterations !== undefined ? options.maxToolHops : undefined);
  provider.maxRequestHops = positiveInteger(requestHops, DEFAULT_MAX_REQUEST_HOPS);
  provider.maxTurnSeconds = positiveNumber(
    options.maxTurnSeconds ?? process.env.OPENAGI_MAX_TURN_SECONDS,
    DEFAULT_MAX_TURN_SECONDS
  );
  provider.maxTurnUsd = optionalPositiveNumber(
    options.maxTurnUsd ?? process.env.OPENAGI_MAX_TURN_USD
  );
  provider.now = options.now ?? Date.now;
  // Keep this readable for integrations that inspect the old property. The
  // value now represents the whole-turn iteration cap.
  provider.maxToolHops = provider.maxIterations;
}

function emitIteration(context, n, max) {
  try {
    context?.__onToolEvent?.({ phase: "iteration", n, max });
  } catch {
    // Progress observers are advisory and must never break a turn.
  }
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The turn was cancelled.");
  error.name = "AbortError";
  return error;
}

async function withinTurn(provider, deadline, task, context = {}) {
  const remainingMs = deadline - provider.now();
  if (remainingMs <= 0) throw new TurnDeadlineError();
  const signal = context?.__abortSignal;
  if (signal?.aborted) throw abortReason(signal);

  let timer;
  let onAbort;
  try {
    const contenders = [
      Promise.resolve().then(() => task(remainingMs)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new TurnDeadlineError();
          context?.__turnAbortController?.abort?.(error);
          reject(error);
        }, Math.max(1, Math.ceil(remainingMs)));
      })
    ];
    if (signal) {
      contenders.push(new Promise((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }));
    }
    return await Promise.race(contenders);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function deadlineExpired(provider, deadline, error) {
  return error instanceof TurnDeadlineError || provider.now() >= deadline;
}

function budgetExceeded(error) {
  return error?.code === "BUDGET_EXCEEDED";
}

function checkRequestBudget(provider, turnBudget) {
  provider.budgetGuard?.check();
  if (turnBudget.limitUsd !== null && turnBudget.spentUsd >= turnBudget.limitUsd) {
    const error = new Error(
      `Turn budget reached: $${turnBudget.spentUsd.toFixed(4)} of $${turnBudget.limitUsd.toFixed(4)}. ` +
      "Raise OPENAGI_MAX_TURN_USD to allow more model requests in one turn."
    );
    error.code = "BUDGET_EXCEEDED";
    throw error;
  }
}

function recordTurnSpend(turnBudget, record) {
  const added = Number(record?.added);
  if (Number.isFinite(added) && added > 0) turnBudget.spentUsd += added;
}

function openAIWantsContinuation(response, calls) {
  return calls.length > 0
    || response?.status === "incomplete"
    || response?.status === "in_progress"
    || Boolean(response?.incomplete_details);
}

function anthropicWantsContinuation(response, toolUses) {
  return toolUses.length > 0
    || ["tool_use", "max_tokens", "pause_turn"].includes(response?.stop_reason);
}

function extractAnthropicText(response) {
  return (response?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Anthropic's SSE stream is a delta protocol, while the existing iteration
// engine consumes complete message objects. Reconstructing that same object
// here keeps tool calls, usage accounting, budgets, and continuation behavior
// on one path. Only user-visible text deltas leave this parser; thinking and
// tool-input JSON remain internal to the agent loop.
export async function readAnthropicEventStream(response, { onDelta } = {}) {
  if (!response?.body?.getReader) throw new Error("Anthropic streaming response has no readable body.");

  const message = { type: "message", role: "assistant", content: [], usage: {} };
  const toolJson = new Map();

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "error") {
      throw new Error(event.error?.message ?? "Anthropic stream returned an error event.");
    }
    if (event.type === "message_start") {
      const started = event.message ?? {};
      Object.assign(message, started, { content: [] });
      message.usage = { ...(started.usage ?? {}) };
      return;
    }
    if (event.type === "content_block_start") {
      const index = Number(event.index);
      if (!Number.isInteger(index) || index < 0) return;
      const block = structuredClone(event.content_block ?? {});
      message.content[index] = block;
      if (block.type === "tool_use") toolJson.set(index, "");
      return;
    }
    if (event.type === "content_block_delta") {
      const index = Number(event.index);
      if (!Number.isInteger(index) || index < 0) return;
      const delta = event.delta ?? {};
      const block = message.content[index] ?? (message.content[index] = {});
      if (delta.type === "text_delta") {
        block.type = block.type ?? "text";
        block.text = `${block.text ?? ""}${delta.text ?? ""}`;
        if (delta.text && typeof onDelta === "function") {
          try { onDelta(delta.text); } catch { /* presentation callbacks are advisory */ }
        }
      } else if (delta.type === "thinking_delta") {
        block.type = block.type ?? "thinking";
        block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
      } else if (delta.type === "signature_delta") {
        block.signature = `${block.signature ?? ""}${delta.signature ?? ""}`;
      } else if (delta.type === "input_json_delta") {
        toolJson.set(index, `${toolJson.get(index) ?? ""}${delta.partial_json ?? ""}`);
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const index = Number(event.index);
      const block = message.content[index];
      if (block?.type === "tool_use" && toolJson.has(index)) {
        const raw = toolJson.get(index);
        try {
          block.input = raw ? JSON.parse(raw) : (block.input ?? {});
        } catch {
          throw new Error("Anthropic stream returned malformed tool input JSON.");
        }
      }
      return;
    }
    if (event.type === "message_delta") {
      Object.assign(message, event.delta ?? {});
      message.usage = { ...(message.usage ?? {}), ...(event.usage ?? {}) };
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    handleEvent(JSON.parse(data));
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (done) break;
  }
  if (pending) consumeLine(pending);

  // A well-formed stream closes every tool block, but finalizing here makes
  // split/stub transports deterministic without weakening malformed JSON.
  for (const [index, raw] of toolJson.entries()) {
    const block = message.content[index];
    if (block?.type !== "tool_use" || block.input !== undefined) continue;
    try {
      block.input = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("Anthropic stream returned malformed tool input JSON.");
    }
  }
  message.content = message.content.filter(Boolean);
  return message;
}

function appendOpenAIAssistantText(conversationInput, response) {
  const hasMessage = (response?.output ?? []).some((item) => item.type === "message" || item.role === "assistant");
  if (hasMessage) {
    for (const item of response.output ?? []) {
      if (item.type === "message" || item.role === "assistant") conversationInput.push(item);
    }
    return;
  }
  const text = extractResponseText(response);
  if (text) conversationInput.push({ role: "assistant", content: text });
}

function appendOpenAIContinue(conversationInput) {
  conversationInput.push({
    role: "user",
    content: [{ type: "input_text", text: SYNTHETIC_CONTINUE }]
  });
}

function appendAnthropicUserText(convo, text) {
  const last = convo.at(-1);
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text });
  } else if (last?.role === "user" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${text}`;
  } else {
    convo.push({ role: "user", content: text });
  }
}

function localPartialSummary({ reason, iterations, maxIterations, toolCalls, lastText }) {
  const completed = toolCalls.length;
  const recent = toolCalls.slice(-5).map((call) => call.name).join(", ");
  const detail = completed > 0
    ? `${completed} tool call${completed === 1 ? "" : "s"} completed${recent ? ` (most recent: ${recent})` : ""}.`
    : "No tool calls completed.";
  const prior = lastText ? `\n\nPartial model output:\n${lastText.slice(0, 1500)}` : "";
  if (reason === "turn-timeout") {
    return `Turn stopped gracefully after ${iterations} iteration${iterations === 1 ? "" : "s"} because the wall-clock guard was reached. ${detail} Raise OPENAGI_MAX_TURN_SECONDS if this task needs more time.${prior}`;
  }
  if (reason === "budget-cap") {
    return `Turn stopped gracefully after ${iterations} iteration${iterations === 1 ? "" : "s"} because a budget cap was reached. ${detail} Raise OPENAGI_MAX_TURN_USD for a larger per-turn budget, or OPENAGI_DAILY_USD_LIMIT for the daily budget.${prior}`;
  }
  return `Turn reached the iteration cap after ${iterations}/${maxIterations} iterations. ${detail} Raise OPENAGI_MAX_ITERATIONS if this task needs more steps.${prior}`;
}

export class DeterministicModelProvider {
  constructor(options = {}) {
    this.name = options.name ?? "deterministic";
  }

  isConfigured() {
    return true;
  }

  async generate({ input, scrutiny, memoryHits = [], agent, messages = [], tools = [], toolRegistry, context = {} }) {
    const text = String(input ?? "").trim();
    const lower = text.toLowerCase();
    const lines = [];

    if (/^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(lower)) {
      lines.push(`Hey — I'm ${agent?.name ?? "OpenAGI"}, running locally. I can remember things, recall them later, schedule prompts, and call MCP tools when configured.`);
    } else if (/\bremember\b|\bsave (this|that)\b|\bdon't forget\b/.test(lower)) {
      const result = await maybeInvoke(toolRegistry, "remember", { content: text, importance: "normal" }, context);
      if (result?.ok) {
        lines.push(`Saved to memory (tier: ${result.result.tier}).`);
      } else {
        lines.push(`I'd save this to memory but the remember tool isn't available right now.`);
      }
    } else if (/\bremind me\b|\bevery (day|monday|week)\b|\bschedule\b|\bdaily\b/.test(lower)) {
      lines.push(`I detected a scheduling request, but without an OPENAI_API_KEY I can't parse the time precisely. Try POST /cron with a {prompt, delaySeconds | intervalSeconds | dailyAt} body, or set OPENAI_API_KEY to let the agent schedule it for you.`);
    } else if (/\bwhat (was|did) (i|you)\b|\blast message\b|\bprevious\b/.test(lower)) {
      const previous = messages.filter((m) => m.role === "user").slice(-2, -1)[0];
      lines.push(previous ? `Your previous message was: "${previous.content}"` : `I don't see a previous message in this session.`);
    } else {
      lines.push(`Heard: "${text}".`);
    }

    if (memoryHits.length > 0) {
      const top = memoryHits.slice(0, 3).map(({ item, score }) => `- [${item.tier} · ${score.toFixed(2)}] ${truncate(item.content, 160)}`).join("\n");
      lines.push(`\nRelated from memory:\n${top}`);
    }

    if (!process.env.OPENAI_API_KEY) {
      lines.push(`\n(Running without OPENAI_API_KEY — set it in .openagi/.env to enable real reasoning and tool use.)`);
    }

    return {
      provider: this.name,
      model: "deterministic",
      text: lines.join("\n"),
      toolCalls: []
    };
  }
}

export class OpenAIResponsesProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5";
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 120000;
    applyIterationSettings(this, options);
    this.budgetGuard = options.budgetGuard ?? null;
    // Per-task model tiering. Defaults to base for everything until tier env
    // vars are set, so this is a no-op until the user opts in.
    this.router = options.router ?? new ModelRouter({ envPrefix: "OPENAI", baseModel: this.model });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  // Resolve which model a call should use: explicit `model` wins, then a named
  // `task` (routed via the configured tiers), then a raw `tier`, else the base.
  resolveModel({ model, tier, task } = {}) {
    if (model) return model;
    if (task) return this.router.resolve(task);
    if (tier) return this.router.tierModel(tier);
    return this.model;
  }

  async generate({ input, instructions, turnContext, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {}, model: modelOverride, tier, task, images = [], maxIterations: maxIterationsOverride, maxTurnSeconds: maxTurnSecondsOverride }) {
    const model = this.resolveModel({ model: modelOverride, tier, task });
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
    const maxIterations = positiveInteger(maxIterationsOverride, this.maxIterations);
    const maxTurnSeconds = positiveNumber(maxTurnSecondsOverride, this.maxTurnSeconds);

    // Stateless tool loop — accumulates the full conversation in `input` each
    // hop instead of chaining via `previous_response_id`. Required for orgs
    // with Zero Data Retention enabled (which reject previous_response_id).
    // Per-turn context (memory hits, scrutiny) rides the latest user turn so
    // `instructions` stays byte-stable across turns (mirrors the Anthropic
    // path; no cache markers here — OpenAI caching is implicit).
    const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
    // Inbound images (e.g. Discord attachments) ride the CURRENT user turn as
    // real input_image blocks so the model can actually see them. Text-only
    // turns keep the plain-string content (byte-stable, cache-friendly).
    const finalText = contextBlock ? `${contextBlock}\n\n${input}` : input;
    const finalUserTurn = Array.isArray(images) && images.length > 0
      ? {
          role: "user",
          content: [
            { type: "input_text", text: finalText },
            ...images.map((im) => ({ type: "input_image", image_url: `data:${im.mediaType};base64,${im.data}` }))
          ]
        }
      : { role: "user", content: finalText };
    const conversationInput = [
      ...messages.slice(-12).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      })),
      finalUserTurn
    ];

    const baseInstructions = instructions ?? buildDefaultInstructions({ agent });
    const toolList = tools.length > 0
      ? tools
      : Array.isArray(context.__advertisedTools)
        ? []
        : toolRegistry?.toOpenAITools?.() ?? [];
    const toolCalls = [];

    const deadline = this.now() + (maxTurnSeconds * 1000);
    const turnBudget = { limitUsd: this.maxTurnUsd, spentUsd: 0 };
    let response;
    let iterations = 0;
    let stopReason = "completed";
    let lastText = "";

    iterationLoop: while (iterations < maxIterations) {
      if (this.now() >= deadline) {
        stopReason = "turn-timeout";
        break;
      }
      // Iterations can span many paid requests. Re-check immediately before
      // each one so a cap reached by an earlier hop cannot be bypassed.
      try {
        checkRequestBudget(this, turnBudget);
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopReason = "budget-cap";
        break;
      }
      iterations += 1;
      emitIteration(context, iterations, maxIterations);
      const body = {
        model,
        instructions: baseInstructions,
        input: conversationInput
      };
      if (toolList.length > 0) body.tools = toolList;

      try {
        response = await withinTurn(this, deadline, (remainingMs) => (
          this.postResponses(body, context, { timeoutMs: remainingMs, turnBudget })
        ), context);
      } catch (error) {
        if (!deadlineExpired(this, deadline, error)) throw error;
        stopReason = "turn-timeout";
        break;
      }

      const calls = extractFunctionCalls(response);
      const responseText = extractResponseText(response);
      if (responseText) lastText = responseText;
      const wantsContinuation = openAIWantsContinuation(response, calls);
      if (!wantsContinuation) break;

      // Preserve any partial assistant prose before asking the model to resume.
      // This matters for Responses API `incomplete` results with no tool call.
      appendOpenAIAssistantText(conversationInput, response);

      // Append the assistant's function_call items so the model can see its own
      // last turn on the next hop (replaces what previous_response_id would've done).
      for (const item of response.output ?? []) {
        if (item.type === "function_call") {
          conversationInput.push({
            type: "function_call",
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments
          });
        }
      }

      for (const call of calls) {
        const parsedArgs = safeParseJson(call.arguments) ?? {};
        let invocation;
        try {
          invocation = await withinTurn(this, deadline, () => (
            toolRegistry?.invoke?.(call.name, parsedArgs, context)
              ?? Promise.resolve({ ok: false, error: "no toolRegistry" })
          ), context);
        } catch (error) {
          if (!deadlineExpired(this, deadline, error)) throw error;
          stopReason = "turn-timeout";
          break iterationLoop;
        }
        toolCalls.push({ name: call.name, arguments: parsedArgs, result: invocation });
        const result = invocation.ok ? invocation.result : { error: invocation.error };
        // A tool that returns a screenshot (computer_screenshot) carries the PNG
        // as base64. function_call_output is text-only, so the model can't see
        // it there — strip the bytes from the JSON output and re-attach them as
        // a real input_image in a following user turn so the model can ground on it.
        const image = invocation.ok && result && typeof result === "object" && result.image && result.format ? result : null;
        if (image) {
          const { image: bytes, ...meta } = result;
          conversationInput.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ ...meta, image: "[attached as image below]" })
          });
          conversationInput.push({
            role: "user",
            content: [
              { type: "input_text", text: `Screenshot (${meta.width}×${meta.height}, click coordinates are in this image's space):` },
              { type: "input_image", image_url: `data:image/${image.format};base64,${bytes}` }
            ]
          });
        } else {
          conversationInput.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(result)
          });
        }
      }

      if (iterations >= maxIterations) {
        stopReason = "iteration-cap";
        break;
      }

      // The old hop ceiling becomes an internal request boundary. A synthetic
      // user turn gives the model the Hermes-style nudge while retaining every
      // prior response and tool result in this same outer turn.
      if (calls.length === 0 || iterations % this.maxRequestHops === 0) {
        appendOpenAIContinue(conversationInput);
      }
    }

    let text;
    if (stopReason === "iteration-cap") {
      appendOpenAIContinue(conversationInput);
      conversationInput.at(-1).content[0].text = `[system] The turn reached its true limit after ${iterations} iterations. Do not call tools. Give a concise partial summary of completed work, findings, and what remains. Mention that OPENAGI_MAX_ITERATIONS can be raised.`;
      try {
        checkRequestBudget(this, turnBudget);
        response = await withinTurn(this, deadline, (remainingMs) => this.postResponses({
          model,
          instructions: baseInstructions,
          input: conversationInput
        }, context, { timeoutMs: remainingMs, turnBudget }), context);
        text = extractResponseText(response);
      } catch (error) {
        if (budgetExceeded(error)) stopReason = "budget-cap";
        else if (deadlineExpired(this, deadline, error)) stopReason = "turn-timeout";
        else throw error;
      }
    }

    if (stopReason === "turn-timeout" || stopReason === "budget-cap") {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (stopReason === "iteration-cap" && !text) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (text === undefined) {
      text = extractResponseText(response) || "(no text)";
    }

    return {
      provider: "openai",
      model,
      id: response?.id,
      text,
      toolCalls,
      iterations,
      maxIterations,
      stopReason
    };
  }

  async postResponses(body, context = {}, options = {}) {
    const controller = new AbortController();
    const externalSignal = context?.__abortSignal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const requestedTimeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
    const deadlineLimited = options.timeoutMs !== undefined && requestedTimeoutMs <= this.timeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, requestedTimeoutMs));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.error?.message ?? `OpenAI request failed with ${response.status}`);
      const callTools = (json.output ?? []).filter((item) => item.type === "function_call").map((item) => item.name);
      const budgetRecord = this.budgetGuard?.record(json.usage, body.model, {
        channel: context.channel,
        agentId: context.agentId,
        sessionId: context.sessionId,
        from: context.from,
        tools: callTools
      });
      if (options.turnBudget) recordTurnSpend(options.turnBudget, budgetRecord);
      return json;
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      // The outer deadline and fetch abort timers race. Normalize the fetch
      // winner so deadline expiry still returns a partial summary, while a
      // provider's ordinary shorter request timeout keeps its old error path.
      if (deadlineLimited && error?.name === "AbortError") throw new TurnDeadlineError();
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export class AnthropicProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    this.baseUrl = options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
    this.version = options.version ?? "2023-06-01";
    this.maxTokens = options.maxTokens ?? (Number(process.env.OPENAGI_MAX_TOKENS) || 8192);
    this.timeoutMs = options.timeoutMs ?? 120000;
    applyIterationSettings(this, options);
    this.budgetGuard = options.budgetGuard ?? null;
    this.router = options.router ?? new ModelRouter({ envPrefix: "ANTHROPIC", baseModel: this.model });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  resolveModel({ model, tier, task } = {}) {
    if (model) return model;
    if (task) return this.router.resolve(task);
    if (tier) return this.router.tierModel(tier);
    return this.model;
  }

  async generate({ input, instructions, turnContext, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {}, model: modelOverride, tier, task, images = [], maxIterations: maxIterationsOverride, maxTurnSeconds: maxTurnSecondsOverride, onDelta }) {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
    const model = this.resolveModel({ model: modelOverride, tier, task });
    const maxIterations = positiveInteger(maxIterationsOverride, this.maxIterations);
    const maxTurnSeconds = positiveNumber(maxTurnSecondsOverride, this.maxTurnSeconds);

    const advertisedTools = Array.isArray(context.__advertisedTools) ? context.__advertisedTools : null;
    let tools = advertisedTools
      ? (toolRegistry?.toAnthropicTools?.({ only: advertisedTools }) ?? [])
      : context.__scrutinyPolicy === "none"
        ? []
        : (toolRegistry?.toAnthropicTools?.({ readOnly: context.__scrutinyPolicy === "read-only" }) ?? []);
    if (Array.isArray(context.__allowedTools)) {
      const allowed = new Set(context.__allowedTools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
    // The system block is STATIC (persona + standing instructions) so this
    // cache_control prefix is byte-identical every turn and actually hits.
    // Per-turn context (memory hits, scrutiny) rides the latest user turn.
    const system = [
      {
        type: "text",
        text: instructions ?? buildDefaultInstructions({ agent }),
        cache_control: { type: "ephemeral" }
      }
    ];

    const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
    // Inbound images (Discord attachments) attach to the CURRENT user turn as
    // Anthropic image blocks (base64 source) so a vision model can see them.
    const finalText = contextBlock ? `${contextBlock}\n\n${input}` : input;
    const finalUserContent = Array.isArray(images) && images.length > 0
      ? [
          { type: "text", text: finalText },
          ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }))
        ]
      : finalText;
    const convo = [
      ...messages.slice(-12).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      })),
      { role: "user", content: finalUserContent }
    ];

    const toolCalls = [];
    const deadline = this.now() + (maxTurnSeconds * 1000);
    const turnBudget = { limitUsd: this.maxTurnUsd, spentUsd: 0 };
    let response;
    let iterations = 0;
    let stopReason = "completed";
    let lastText = "";

    iterationLoop: while (iterations < maxIterations) {
      if (this.now() >= deadline) {
        stopReason = "turn-timeout";
        break;
      }
      try {
        checkRequestBudget(this, turnBudget);
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopReason = "budget-cap";
        break;
      }
      iterations += 1;
      emitIteration(context, iterations, maxIterations);
      try {
        response = await withinTurn(this, deadline, (remainingMs) => this.postMessages({
          model,
          max_tokens: this.maxTokens,
          system,
          messages: convo,
          ...(typeof onDelta === "function" ? { stream: true } : {}),
          ...(tools.length > 0 ? { tools } : {})
        }, context, { timeoutMs: remainingMs, turnBudget, onDelta }), context);
      } catch (error) {
        if (!deadlineExpired(this, deadline, error)) throw error;
        stopReason = "turn-timeout";
        break;
      }

      convo.push({ role: "assistant", content: response.content ?? [] });

      const toolUses = (response.content ?? []).filter((c) => c.type === "tool_use");
      const responseText = extractAnthropicText(response);
      if (responseText) lastText = responseText;
      const wantsContinuation = anthropicWantsContinuation(response, toolUses);
      if (!wantsContinuation) break;

      const toolResults = [];
      for (const use of toolUses) {
        let invocation;
        try {
          invocation = await withinTurn(this, deadline, () => (
            toolRegistry?.invoke?.(use.name, use.input ?? {}, context)
              ?? Promise.resolve({ ok: false, error: "no toolRegistry" })
          ), context);
        } catch (error) {
          if (!deadlineExpired(this, deadline, error)) throw error;
          stopReason = "turn-timeout";
          break iterationLoop;
        }
        toolCalls.push({ name: use.name, arguments: use.input, result: invocation });
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(invocation.ok ? invocation.result : { error: invocation.error }),
          is_error: !invocation.ok
        });
      }
      if (toolResults.length > 0) convo.push({ role: "user", content: toolResults });

      if (iterations >= maxIterations) {
        stopReason = "iteration-cap";
        break;
      }

      // A max_tokens/pause response has no tool result to carry the next turn,
      // while the former hop boundary does. Both receive the same resume nudge.
      if (toolUses.length === 0 || iterations % this.maxRequestHops === 0) {
        appendAnthropicUserText(convo, SYNTHETIC_CONTINUE);
      }
    }

    let text;
    if (stopReason === "iteration-cap") {
      appendAnthropicUserText(
        convo,
        `[system] The turn reached its true limit after ${iterations} iterations. Do not call tools. Give a concise partial summary of completed work, findings, and what remains. Mention that OPENAGI_MAX_ITERATIONS can be raised.`
      );
      try {
        checkRequestBudget(this, turnBudget);
        response = await withinTurn(this, deadline, (remainingMs) => this.postMessages({
          model,
          max_tokens: this.maxTokens,
          system,
          messages: convo,
          ...(typeof onDelta === "function" ? { stream: true } : {})
        }, context, { timeoutMs: remainingMs, turnBudget, onDelta }), context);
        text = extractAnthropicText(response);
      } catch (error) {
        if (budgetExceeded(error)) stopReason = "budget-cap";
        else if (deadlineExpired(this, deadline, error)) stopReason = "turn-timeout";
        else throw error;
      }
    }

    if (stopReason === "turn-timeout" || stopReason === "budget-cap") {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (stopReason === "iteration-cap" && !text) {
      text = localPartialSummary({ reason: stopReason, iterations, maxIterations, toolCalls, lastText });
    } else if (text === undefined) {
      text = extractAnthropicText(response);
    }

    // Last-resort salvage: a reasoning model that hit max_tokens mid-think
    // returns only `thinking` blocks. Surface a trimmed slice of the trace
    // rather than the "(no text)" placeholder.
    const salvage = !text
      ? (response?.content ?? [])
          .filter((c) => c.type === "thinking" && typeof c.thinking === "string")
          .map((c) => c.thinking)
          .join("\n")
          .trim()
          .slice(0, 1500)
      : "";

    return {
      provider: "anthropic",
      model,
      id: response?.id,
      text: text || (salvage ? `⚠ Reply truncated mid-reasoning (max_tokens). Reasoning trace excerpt:\n${salvage}` : "(no text)"),
      toolCalls,
      iterations,
      maxIterations,
      stopReason
    };
  }

  async postMessages(body, context = {}, options = {}) {
    const controller = new AbortController();
    const externalSignal = context?.__abortSignal;
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const requestedTimeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs);
    const deadlineLimited = options.timeoutMs !== undefined && requestedTimeoutMs <= this.timeoutMs;
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, requestedTimeoutMs));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody?.error?.message ?? `Anthropic request failed with ${response.status}`);
      }
      const contentType = response.headers?.get?.("content-type") ?? "";
      const json = body.stream === true && /text\/event-stream/i.test(contentType)
        ? await readAnthropicEventStream(response, { onDelta: options.onDelta })
        : await response.json().catch(() => ({}));
      const callTools = (json.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name);
      const budgetRecord = this.budgetGuard?.record(json.usage, body.model, {
        channel: context.channel,
        agentId: context.agentId,
        sessionId: context.sessionId,
        from: context.from,
        tools: callTools
      });
      if (options.turnBudget) recordTurnSpend(options.turnBudget, budgetRecord);
      return json;
    } catch (error) {
      if (externalSignal?.aborted) throw abortReason(externalSignal);
      if (deadlineLimited && error?.name === "AbortError") throw new TurnDeadlineError();
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function createModelProvider(options = {}) {
  if (options.forceDeterministic === true) return new DeterministicModelProvider();
  const budgetGuard = options.budgetGuard ?? null;
  const anthropic = new AnthropicProvider({ ...(options.anthropic ?? {}), budgetGuard });
  const openai = new OpenAIResponsesProvider({ ...(options.openai ?? {}), budgetGuard });

  // Explicit preference wins. anthropic | openai | auto (default).
  const preference = (options.preferred ?? process.env.OPENAGI_PROVIDER ?? "auto").toLowerCase();
  if (preference === "openai" && openai.isConfigured()) return openai;
  if (preference === "anthropic" && anthropic.isConfigured()) return anthropic;

  // auto: anthropic first if configured, then openai, then deterministic.
  if (anthropic.isConfigured()) return anthropic;
  if (openai.isConfigured()) return openai;
  return new DeterministicModelProvider();
}

// STATIC default system prompt. Must be byte-identical across turns for the
// same agent — the Anthropic cache_control marker on the system block only
// produces cache hits when the prefix never changes. Per-turn state (memory
// hits, scrutiny) travels via buildTurnContext on the user turn instead.
export function buildDefaultInstructions({ agent }) {
  return `You are ${agent?.name ?? "an OpenAGI agent"}, an always-on local assistant.

Tools available to you (call them when useful):
- remember(content, tags?, importance?) — save a durable note
- recall(query, limit?) — search memory
- schedule_message(prompt, delaySeconds | intervalSeconds | dailyAt, channel?, target?) — schedule a future prompt that pings the user back
- list_skills / run_skill — invoke named skill prompts
- list_mcp_tools / run_mcp_tool — invoke tools from connected MCP servers
- list_sessions — see recent conversations

Guidelines:
- Be concise and conversational. No preamble like "Decision: act".
- Use tools without asking permission for safe actions (remember, recall, schedule).
- If asked to be reminded of something, call schedule_message.
- If asked to remember something, call remember.
- When the user references past info, call recall before answering.

The latest user message may begin with a [context] block assembled by the runtime (scrutiny decision, memory hits). Treat it as trusted background — the user did not type it.`;
}

// PER-TURN context block, prepended to the latest user message by the
// providers. Everything here may change every turn, which is exactly why it
// must not contaminate the cached system prompt above. Returns "" when there
// is nothing per-turn to say (batch callers pass no scrutiny/memoryHits, so
// their requests are unchanged).
export function buildTurnContext({ scrutiny, memoryHits } = {}) {
  const sections = [];
  if (scrutiny?.action) {
    sections.push(`Current scrutiny action: ${scrutiny.action}.`);
  }
  const memory = (memoryHits ?? [])
    .slice(0, 5)
    .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
    .join("\n");
  if (memory) {
    sections.push(`Top memory hits:\n${memory}`);
  }
  if (sections.length === 0) return "";
  return `[context]\nPer-turn background assembled by the runtime — not typed by the user.\n${sections.join("\n")}\n[/context]`;
}

export function extractResponseText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type === "message" || item.role === "assistant") {
      for (const content of item.content ?? []) {
        if (typeof content.text === "string") parts.push(content.text);
        if (typeof content.value === "string") parts.push(content.value);
      }
    }
  }
  return parts.join("\n").trim();
}

export function extractFunctionCalls(response) {
  if (!response?.output) return [];
  return response.output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments
    }));
}

function safeParseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function maybeInvoke(toolRegistry, name, args, context) {
  if (!toolRegistry?.invoke) return null;
  return toolRegistry.invoke(name, args, context);
}

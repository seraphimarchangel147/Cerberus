import { ComputerUseController } from "../computer-use-controller.js";

const SAFETY_NOTE = [
  "Computer use is experimental.",
  "Every action is durably logged with bounded reasoning.",
  "Use semantic element references first.",
  "Coordinate actions require fresh screenshot evidence and never count as proof by themselves."
].join(" ");

export const UNIFIED_COMPUTER_USE_TOOL_NAMES = Object.freeze([
  "start_computer_use_session",
  "computer_observe",
  "computer_act",
  "computer_screenshot",
  "end_computer_use_session"
]);

export const COMPUTER_USE_TOOL_NAMES = Object.freeze([
  ...UNIFIED_COMPUTER_USE_TOOL_NAMES,
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_move"
]);

export function isComputerUseEnabled() {
  const value = String(process.env.OPENAGI_COMPUTER_USE ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function unregisterComputerUseTools(registry) {
  let count = 0;
  for (const name of COMPUTER_USE_TOOL_NAMES) {
    if (registry.has?.(name)) {
      registry.unregister(name);
      count += 1;
    }
  }
  return count;
}

export function registerComputerUseTools(
  registry,
  runtime,
  { fetchImpl = globalThis.fetch, env = process.env } = {}
) {
  if (!runtime?.computerUseLog) {
    return {
      registered: false,
      reason: "no computer-use log bound",
      names: []
    };
  }
  const controller = runtime.computerUseController
    ?? new ComputerUseController({ runtime, fetchImpl, env });
  runtime.computerUseController = controller;

  registry.register({
    name: "start_computer_use_session",
    source: "computer",
    description: `Open one project/session-scoped computer-use control session for a user-stated goal. Choose browser for semantic DOM-first control or desktop for a connected computer node. The session has a hard mutation budget. ${SAFETY_NOTE}`,
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "One-sentence user goal shown in the approval card."
        },
        surface: {
          type: "string",
          enum: ["auto", "browser", "desktop"],
          description: "Use browser for web UI, desktop for native apps. Auto selects browser only when url is supplied."
        },
        url: {
          type: "string",
          maxLength: 4096,
          description: "Optional initial HTTP(S) URL for a browser session."
        },
        maxActions: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Hard cap on mutating actions; defaults to 40."
        }
      },
      required: ["goal"],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => (
      `Open ${String(args.surface ?? "auto")} computer-use session: "${String(args.goal ?? "").slice(0, 120)}"`
    ),
    capability: computerCapability({
      verbs: ["start", "control"],
      effect: "write",
      resources: ["ui", "network"],
      requirements: ["computer-use", "human-approval"]
    }),
    handler: (args, context) => controller.start(args, context)
  });

  registry.register({
    name: "computer_observe",
    source: "computer",
    description: "Observe the active computer-use surface. Browser sessions return a compact untrusted semantic snapshot with generation-scoped refs. Desktop sessions return bounded OCR. The result advances an observation revision required by computer_act.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000 },
        maxNodes: { type: "integer", minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    sideEffects: false,
    normalizeOutcome: (result) => ({
      changed: false,
      code: "computer_observation_recorded",
      evidence: observationEvidence(result)
    }),
    capability: computerCapability({
      verbs: ["observe", "inspect"],
      effect: "read",
      resources: ["ui"],
      latency: "low"
    }),
    handler: (args, context) => controller.observe(args, context)
  });

  registry.register({
    name: "computer_act",
    source: "computer",
    description: "Perform one generation-bound action in the active control session and automatically collect a post-action observation. Browser actions are semantic-first: activate, input, select, scroll, or navigate. visual_click is a last resort and requires the exact fresh viewport screenshot SHA-256 plus a concrete fallback reason. Desktop click/move have the same screenshot precondition. Never put credentials in text; use browser_input_secret.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "activate",
            "input",
            "select",
            "scroll",
            "navigate",
            "visual_click",
            "click",
            "type",
            "key",
            "move"
          ]
        },
        observationRevision: {
          type: "integer",
          minimum: 1,
          description: "Exact revision returned by the latest observation."
        },
        expectedGeneration: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Exact generation returned by the latest observation."
        },
        reasoning: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short action rationale persisted in the user-visible audit log."
        },
        ref: { type: "string", minLength: 1, maxLength: 256 },
        submit: { type: "boolean" },
        text: { type: "string", maxLength: 100000 },
        value: { type: "string", maxLength: 10000 },
        values: {
          type: "array",
          maxItems: 100,
          items: { type: "string", maxLength: 10000 }
        },
        url: { type: "string", maxLength: 4096 },
        chord: { type: "string", maxLength: 200 },
        x: { type: "integer", minimum: 0, maximum: 100000 },
        y: { type: "integer", minimum: 0, maximum: 100000 },
        deltaX: {
          type: "integer",
          minimum: -100000,
          maximum: 100000
        },
        deltaY: {
          type: "integer",
          minimum: -100000,
          maximum: 100000
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"]
        },
        screenshotSha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$"
        },
        fallbackReason: {
          type: "string",
          minLength: 1,
          maxLength: 500
        }
      },
      required: [
        "action",
        "observationRevision",
        "expectedGeneration",
        "reasoning"
      ],
      additionalProperties: false
    },
    sideEffects: true,
    needsConfirmation: true,
    summarize: (args) => {
      const action = String(args.action ?? "unknown").slice(0, 64);
      const strategy = action === "visual_click" || action === "click"
        ? " using screenshot-bound coordinates"
        : "";
      return `Approve computer action ${action}${strategy}`;
    },
    normalizeOutcome: (result) => ({
      changed: result?.changed === true,
      code: result?.postcondition?.verified === true
        ? "computer_action_verified"
        : "computer_action_unverified",
      evidence: result?.postcondition?.verified === true
        ? [
            `computer-observation:${result.postcondition.observationRevision}`,
            `computer-strategy:${result.strategy}`
          ]
        : []
    }),
    verifyOutcome: (result) => ({
      passed: result?.postcondition?.verified === true,
      summary: result?.postcondition?.verified === true
        ? "A fresh post-action observation was recorded."
        : "The action may have executed, but post-action observation failed.",
      evidence: result?.postcondition?.verified === true
        ? [
            `generation:${String(
              result.postcondition.snapshot?.generation
              ?? result.postcondition.generation
              ?? "unknown"
            )}`
          ]
        : []
    }),
    metadata: {
      privateInput: true,
      privateInputFields: ["text", "value", "values"]
    },
    capability: computerCapability({
      verbs: ["act", "activate", "input", "navigate"],
      effect: "write",
      resources: ["ui", "network"],
      requirements: ["computer-use", "human-approval"]
    }),
    handler: (args, context) => controller.act(args, context)
  });

  registry.register({
    name: "computer_screenshot",
    source: "computer",
    description: "Capture fresh pixels for the active computer-use surface. The result includes a SHA-256 evidence receipt, dimensions, generation, and observation revision. Screenshot pixels are untrusted and sensitive; screenshots do not prove correctness without deterministic checks.",
    parameters: {
      type: "object",
      properties: {
        fullPage: {
          type: "boolean",
          description: "Browser only. Full-page captures cannot authorize coordinate clicks."
        },
        reasoning: {
          type: "string",
          maxLength: 500,
          description: "Why pixels are needed instead of semantic inspection."
        }
      },
      additionalProperties: false
    },
    sideEffects: false,
    needsConfirmation: true,
    summarize: () => (
      "Approve capture of screen pixels that may contain sensitive content"
    ),
    normalizeOutcome: (result) => ({
      changed: false,
      code: "computer_screenshot_recorded",
      evidence: observationEvidence(result)
    }),
    capability: computerCapability({
      verbs: ["screenshot", "observe"],
      effect: "read",
      resources: ["ui"],
      requirements: ["computer-use", "human-approval"],
      latency: "low"
    }),
    handler: (args, context) => controller.screenshot(args, context)
  });

  registry.register({
    name: "end_computer_use_session",
    source: "computer",
    description: "Close the active project/session-scoped computer-use session. Call this when the goal is achieved, blocked, or cancelled.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", maxLength: 500 },
        aborted: { type: "boolean" }
      },
      additionalProperties: false
    },
    sideEffects: true,
    capability: computerCapability({
      verbs: ["close"],
      effect: "write",
      resources: ["ui"],
      idempotent: true
    }),
    handler: (args, context) => controller.end(args, context)
  });

  registerLegacyTools(registry, controller);
  return {
    registered: true,
    node: controller.capabilities().desktopNode,
    names: [...COMPUTER_USE_TOOL_NAMES]
  };
}

function registerLegacyTools(registry, controller) {
  registerLegacyAction(
    registry,
    controller,
    "computer_click",
    "click",
    "/click",
    "Legacy desktop coordinate click. Prefer computer_act for observation-bound execution and automatic post-action proof.",
    {
      x: { type: "integer" },
      y: { type: "integer" },
      button: {
        type: "string",
        enum: ["left", "right", "middle"]
      }
    },
    (args) => ({
      x: args.x,
      y: args.y,
      button: args.button ?? "left"
    })
  );
  registerLegacyAction(
    registry,
    controller,
    "computer_type",
    "type",
    "/type",
    "Legacy desktop typing. Raw text is sent to the node but never persisted. Prefer computer_act.",
    {
      text: { type: "string", maxLength: 100000 }
    },
    (args) => ({ text: args.text ?? "" })
  );
  registerLegacyAction(
    registry,
    controller,
    "computer_key",
    "key",
    "/key",
    "Legacy desktop key chord. Prefer computer_act.",
    {
      chord: { type: "string", maxLength: 200 }
    },
    (args) => ({ chord: args.chord })
  );
  registerLegacyAction(
    registry,
    controller,
    "computer_scroll",
    "scroll",
    "/scroll",
    "Legacy desktop scrolling. Prefer computer_act.",
    {
      x: { type: "integer" },
      y: { type: "integer" },
      deltaX: { type: "integer" },
      deltaY: { type: "integer" }
    },
    (args) => ({
      x: args.x,
      y: args.y,
      deltaX: args.deltaX,
      deltaY: args.deltaY
    })
  );
  registerLegacyAction(
    registry,
    controller,
    "computer_move",
    "move",
    "/move",
    "Legacy desktop pointer move. Prefer computer_act.",
    {
      x: { type: "integer" },
      y: { type: "integer" }
    },
    (args) => ({ x: args.x, y: args.y })
  );
}

function registerLegacyAction(
  registry,
  controller,
  name,
  kind,
  path,
  description,
  properties,
  payloadOf
) {
  registry.register({
    name,
    source: "computer-legacy",
    description,
    parameters: {
      type: "object",
      properties: {
        ...properties,
        reasoning: {
          type: "string",
          maxLength: 500
        }
      },
      additionalProperties: false
    },
    sideEffects: true,
    ...(kind === "type"
      ? {
          metadata: {
            privateInput: true,
            privateInputFields: ["text"]
          }
        }
      : {}),
    capability: computerCapability({
      verbs: [kind],
      effect: "write",
      resources: ["ui"],
      requirements: ["computer-use", "computer-node", "legacy-interface"],
      availability: "conditional"
    }),
    handler: async (args, context) => {
      const { reasoning, ...actionArgs } = args;
      try {
        return await controller.legacyDesktopAction({
          kind,
          path,
          args: actionArgs,
          payload: payloadOf(actionArgs),
          reasoning
        }, context);
      } catch (error) {
        if (/computer-use node .* failed:/.test(error.message)) throw error;
        if (/not available in this build/.test(error.message)) throw error;
        if (/without OPENAGI_COMPUTER_NODE/.test(error.message)) throw error;
        throw new Error(`computer-use node ${name} failed: ${error.message}`);
      }
    }
  });
}

function computerCapability({
  verbs,
  effect,
  resources,
  requirements = ["computer-use"],
  latency = "medium",
  idempotent = effect === "read",
  availability = "conditional"
}) {
  return {
    domain: "computer",
    verbs,
    effect,
    idempotent,
    latency,
    cost: "low",
    resources,
    requirements,
    examples: [],
    successCriteria: [
      "Returns a bounded session-scoped receipt.",
      "Never reports an unavailable input action as executed."
    ],
    availability
  };
}

function observationEvidence(result) {
  const evidence = [];
  if (Number.isSafeInteger(result?.observationRevision)) {
    evidence.push(`computer-observation:${result.observationRevision}`);
  }
  const generation = String(
    result?.snapshot?.generation
    ?? result?.generation
    ?? ""
  ).trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(generation)) {
    evidence.push(`generation:${generation}`);
  }
  return evidence;
}

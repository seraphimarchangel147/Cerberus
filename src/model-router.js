// Model tiering / routing.
import {
  classifyTaskComplexity,
  escalateTier
} from "./task-complexity.js";
//
// One "base" model handles everything by default. Lighter, cheaper models can
// take the small, frequent background jobs — you do NOT need a top model for
// every internal task. Out of the box every task still resolves to the base
// model (no behavior change), so tiering is strictly opt-in: set the tier env
// vars and the recommended tasks shift automatically. Any task can also be
// pinned to an exact model.
//
// Two knobs:
//   • Tiers   — name a cheaper model once, reuse it.  e.g. OPENAI_MODEL_NANO=gpt-5-nano
//   • Tasks   — pin one job to an exact model.        e.g. OPENAI_MODEL_TASK_OBSERVER=gpt-5-mini
//
// Resolution for a task:  task pin  >  task's recommended tier  >  base model.

// The "where" — every internal job that calls the model, with a recommended
// tier and the reason it's safe to shrink. `chat` and `autopilot` intentionally
// stay on base (real reasoning + tool use); the rest are small and/or frequent,
// which is exactly where a mini/nano model saves the most money.
export const MODEL_PROVIDER_IDS = Object.freeze([
  "anthropic",
  "openai",
  "moa"
]);

export function isModelProviderId(value, { includeAuto = false } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (includeAuto && normalized === "auto")
    || MODEL_PROVIDER_IDS.includes(normalized);
}

export function normalizeModelProviderId(value, {
  fallback = "auto",
  includeAuto = true
} = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (isModelProviderId(normalized, { includeAuto })) return normalized;
  return fallback;
}

export const TASK_PROFILES = {
  chat:      { tier: "base", label: "User chat",            why: "Real reasoning, user-facing replies — keep this on your best model." },
  autopilot: { tier: "base", label: "Autopilot task work", why: "Plans and executes real work with tools — needs the strong model." },
  observer:  { tier: "nano", label: "Proactive observer",  why: "Mostly 'suggest one thing or stay quiet', runs often — nano is plenty." },
  review:    { tier: "nano", label: "Background review",    why: "Extracts a few structured memories or proposals after a turn — nano is plenty." },
  goal:      { tier: "nano", label: "Goal completion judge", why: "Short yes/no completion checks after goal turns are bounded and frequent." },
  scrutiny:  { tier: "nano", label: "Scrutiny judges",     why: "Short act/ask/watch/ignore classification, very frequent — nano is plenty." },
  condense:  { tier: "mini", label: "Memory condensing",   why: "Summarize a cluster of notes into one — a mini model handles it." },
  mine:      { tier: "mini", label: "Session mining",      why: "Cluster intents out of a transcript — mini is enough." },
  plan:      { tier: "mini", label: "Daily plan / recap",  why: "Summarize the day — mini is enough." },
  extract:   { tier: "nano", label: "iMessage extraction", why: "Pull follow-ups/events from a batch of texts, runs often — nano is plenty." },
  sweep:     { tier: "mini", label: "Task list hygiene",    why: "Classify queue + dedupe/stale-judge the task list — mini has the judgment for it." },

  // ── Delegation ────────────────────────────────────────────────────────────
  // A delegated subagent used to inherit the `chat` task, so EVERY child ran on
  // the base model whether it was deep architectural reasoning or a one-line
  // grep. These profiles let the delegator say what KIND of work the child is
  // doing and get a model matched to it. `delegate` itself is the conservative
  // default for an unclassified task and deliberately stays on base — an
  // unlabelled delegation must never get silently downgraded.
  delegate:        { tier: "base", label: "Delegated task (unclassified)", why: "Kind not stated — assume real reasoning and keep the strong model." },
  delegate_reason: { tier: "base", label: "Delegated deep reasoning",      why: "Architecture, tradeoff analysis, ambiguous problems — needs the strongest model." },
  delegate_code:   { tier: "base", label: "Delegated code writing",        why: "Writing/refactoring real code that must compile and pass tests — keep it strong." },
  delegate_debug:  { tier: "mini", label: "Delegated debugging / testing", why: "Run tests, read failures, bisect. Bounded and verifiable — mini is enough, and the test result is the ground truth, not the model's confidence." },
  delegate_research:{ tier: "mini", label: "Delegated research",           why: "Gather, read, and summarize sources. Volume work with a checkable output — mini is enough." },
  delegate_extract:{ tier: "nano", label: "Delegated extraction / lookup", why: "Find a value, list files, pull a field. Mechanical and high-frequency — nano is plenty." }
};

// The delegator names WORK, not a model. This is the only mapping from a
// task-shaped word to a routing task, so the tool schema and the router cannot
// drift apart. Keys are what a caller may pass as `kind`.
export const DELEGATE_KINDS = Object.freeze({
  reason:   "delegate_reason",
  code:     "delegate_code",
  debug:    "delegate_debug",
  research: "delegate_research",
  extract:  "delegate_extract"
});

// Human-facing capability guidance, surfaced in the delegate_task schema so the
// model choosing a `kind` knows what each one COSTS it in capability. Without
// this the model picks a label by vibes and either overpays or under-powers a
// task that needed real reasoning.
export const DELEGATE_KIND_GUIDANCE = Object.freeze({
  reason:   "Strongest model. Architecture, design tradeoffs, ambiguous or open-ended problems.",
  code:     "Strongest model. Writing or refactoring code that must actually compile and pass tests.",
  debug:    "Mid model. Running tests, reading failures, bisecting — the test result verifies the work.",
  research: "Mid model. Reading sources and summarizing; the output is checkable against the sources.",
  extract:  "Cheapest model. Mechanical lookup: find a value, list files, pull one field."
});

// Resolve a caller-supplied `kind` to a routing task. Unknown or absent kinds
// fall back to the conservative `delegate` profile (base model) rather than
// guessing — a mislabelled task must degrade toward MORE capability, never less.
export function delegateTaskForKind(kind) {
  const normalized = String(kind ?? "").trim().toLowerCase();
  return DELEGATE_KINDS[normalized] ?? "delegate";
}

// Order matters for display (strongest → cheapest).
export const TIERS = ["base", "mini", "nano"];

export class ModelRouter {
  // envPrefix: "OPENAI" | "ANTHROPIC". baseModel: the already-resolved base model.
  // overrides (optional, for tests/programmatic config):
  //   { tiers: { mini, nano }, tasks: { observer: "<model>" } }
  constructor({ envPrefix = "OPENAI", baseModel, env = process.env, overrides = {} } = {}) {
    this.envPrefix = envPrefix;
    this.baseModel = baseModel;
    this.env = env;
    this.overrides = overrides;
  }

  // Model for a tier name. Unset tiers fall back to base, so an undefined
  // tier is always safe (you just don't save until you configure it).
  tierModel(tier) {
    if (!tier || tier === "base") return this.baseModel;
    const fromOverride = this.overrides.tiers?.[tier];
    if (fromOverride) return fromOverride;
    const fromEnv = this.env[`${this.envPrefix}_MODEL_${tier.toUpperCase()}`];
    return fromEnv || this.baseModel;
  }

  // Model for a named task: explicit task pin > task's recommended tier > base.
  resolve(task, request = null) {
    if (!task) return this.baseModel;
    const taskPin =
      this.overrides.tasks?.[task] ||
      this.env[`${this.envPrefix}_MODEL_TASK_${task.toUpperCase()}`];
    if (taskPin) return taskPin;
    const profile = TASK_PROFILES[task];
    if (!profile && this.env.OPENAGI_DEV_WARN === "1") {
      console.warn(
        `[model-router] unknown task "${task}" -> falling back to base model`
      );
    }
    const staticTier = profile?.tier ?? "base";
    if (String(this.env.AGENT_ROUTING ?? "static").trim().toLowerCase() !== "auto") {
      return this.tierModel(staticTier);
    }
    try {
      const runtimeFloor = classifyTaskComplexity(request ?? {});
      return this.tierModel(escalateTier(staticTier, runtimeFloor));
    } catch {
      return this.tierModel(staticTier);
    }
  }

  // Which models are actually wired up (base + any configured tiers).
  tierModels() {
    const out = { base: this.baseModel };
    for (const tier of TIERS) {
      if (tier === "base") continue;
      out[tier] = this.tierModel(tier);
    }
    return out;
  }

  // Human-readable plan: every task, its recommended tier, the model it resolves
  // to right now, and why. `onBase` flags tasks that are NOT yet saving (still
  // on the base model because their tier isn't configured).
  describe() {
    return Object.entries(TASK_PROFILES).map(([task, p]) => {
      const model = this.resolve(task);
      return {
        task,
        label: p.label,
        tier: p.tier,
        model,
        why: p.why,
        onBase: model === this.baseModel
      };
    });
  }
}

// Pretty multi-line summary for the CLI (`openagi models`).
export function renderModelPlan(router, { provider } = {}) {
  const lines = [];
  const models = router.tierModels();
  lines.push(`Provider: ${provider ?? "?"}   Base model: ${models.base}`);
  const configured = TIERS.filter((t) => t !== "base" && models[t] !== models.base);
  if (configured.length === 0) {
    lines.push("Tiers:    (none configured — everything runs on the base model)");
  } else {
    lines.push(`Tiers:    ${configured.map((t) => `${t}=${models[t]}`).join("   ")}`);
  }
  lines.push("");
  lines.push("Where each job runs (→ = recommended smaller model):");
  for (const row of router.describe()) {
    const arrow = row.onBase && row.tier !== "base" ? "  ⚠ still on base" : "";
    const tag = row.tier === "base" ? "[base]" : `[${row.tier}]`;
    lines.push(`  ${tag.padEnd(7)} ${row.label.padEnd(22)} ${row.model}${arrow}`);
    lines.push(`          ${row.why}`);
  }
  const onBase = router.describe().filter((r) => r.onBase && r.tier !== "base");
  if (onBase.length > 0) {
    const prefix = router.envPrefix;
    const autoRouting = String(
      router.env?.AGENT_ROUTING ?? "static"
    ).trim().toLowerCase() === "auto";
    lines.push("");
    lines.push("Recommended savings — set these to use cheaper models for small jobs:");
    if (router.describe().some((r) => r.tier === "nano" && r.onBase)) {
      const nano = prefix === "OPENAI"
        ? "gpt-5-nano"
        : "claude-haiku-4-5";
      const verification = prefix === "ANTHROPIC" && autoRouting
        ? " (verify the live model id first)"
        : "";
      lines.push(`  ${prefix}_MODEL_NANO=${nano}   # observer, scrutiny judges${verification}`);
    }
    if (router.describe().some((r) => r.tier === "mini" && r.onBase)) {
      if (prefix === "ANTHROPIC" && autoRouting) {
        lines.push(
          "  ANTHROPIC_MODEL_MINI=(leave unset)"
          + "   # memory-writing jobs stay on base until a distinct model is verified"
        );
      } else {
        lines.push(`  ${prefix}_MODEL_MINI=${prefix === "OPENAI" ? "gpt-5-mini" : "claude-haiku-4-5"}   # condensing, mining, daily recap`);
      }
    }
  }
  return lines.join("\n");
}

// Discord slash-command + component layer for OpenAGI.
// Zero-dependency, mirrors the hosted-interface HTTP surface so everything
// the dashboard can do is reachable from Discord: status, provider/model
// switching (native drop-down select menus), approvals (buttons), tasks,
// memory, suggestions, budget, skills, recap, plan, observer pulse.
//
// Wiring: DiscordChannel registers the commands at READY (guild-scoped so
// they appear instantly) and forwards INTERACTION_CREATE payloads here.
//
// Security: every interaction is gated on DISCORD_ALLOW_FROM — the same
// allowlist that gates DMs. Non-allowlisted users get an ephemeral refusal.

const T = {
  // Interaction types
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  // Response types
  REPLY: 4,
  DEFERRED_REPLY: 5,
  UPDATE_MESSAGE: 7
};

const EPHEMERAL = 64;

// ── Command definitions (registered against the guild at READY) ──────
export const COMMAND_DEFS = [
  { name: "status", description: "Agent health: provider, model, channels, uptime" },
  { name: "provider", description: "Show / switch model provider (drop-down)" },
  {
    name: "model",
    description: "Show or set the active model id",
    options: [{ type: 3, name: "name", description: "Model id (e.g. kimi-k3, claude-sonnet-4-6). Omit to show current.", required: false }]
  },
  { name: "pending", description: "Actions awaiting approval (approve/deny buttons)" },
  {
    name: "tasks",
    description: "List tasks",
    options: [{
      type: 3, name: "queue", description: "Which queue", required: false,
      choices: [{ name: "user", value: "user" }, { name: "agent", value: "agent" }]
    }]
  },
  {
    name: "memory",
    description: "Search the agent's tiered memory",
    options: [{ type: 3, name: "query", description: "What to look for", required: true }]
  },
  { name: "suggestions", description: "Pending proactive-observer suggestions" },
  { name: "budget", description: "Token/cost budget status" },
  { name: "skills", description: "List installed skills" },
  { name: "recap", description: "Daily recap (what got done today)" },
  { name: "plan", description: "Daily plan (what should happen today)" },
  { name: "observe", description: "Force a proactive-observer pulse now" },
  { name: "sessions", description: "Recent conversation sessions" },
  { name: "help", description: "List available commands" }
];

export class DiscordCommands {
  constructor(channel) {
    this.channel = channel; // DiscordChannel — rest(), log(), agentHost, allowFrom
    this.registered = false;
  }

  get runtime() {
    return this.channel.agentHost?.runtime ?? null;
  }

  // Called once at READY. Guild-scoped registration is instant (global takes
  // up to an hour to propagate), so register per configured guild.
  async register(applicationId) {
    if (this.registered || !applicationId) return;
    const guilds = this.channel.guilds ?? [];
    try {
      if (guilds.length > 0) {
        for (const guildId of guilds) {
          await this.channel.rest(`/applications/${applicationId}/guilds/${guildId}/commands`, {
            method: "PUT", body: COMMAND_DEFS
          });
        }
      } else {
        await this.channel.rest(`/applications/${applicationId}/commands`, { method: "PUT", body: COMMAND_DEFS });
      }
      this.registered = true;
      this.channel.log({ op: "commands-registered", count: COMMAND_DEFS.length, guilds });
    } catch (error) {
      this.channel.log({ op: "commands-register-error", error: error.message });
    }
  }

  // ── Interaction entry point ─────────────────────────────────────────
  async handle(interaction) {
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? null;
    const allow = this.channel.allowFrom ?? [];
    if (allow.length > 0 && !allow.includes(userId)) {
      return this.respond(interaction, { content: "⛔ You're not on this agent's allowlist.", flags: EPHEMERAL });
    }
    try {
      if (interaction.type === T.APPLICATION_COMMAND) {
        return await this.handleCommand(interaction);
      }
      if (interaction.type === T.MESSAGE_COMPONENT) {
        return await this.handleComponent(interaction, userId);
      }
    } catch (error) {
      this.channel.log({ op: "interaction-error", error: error.message });
      return this.respond(interaction, { content: `⚠ ${error.message}`.slice(0, 500), flags: EPHEMERAL }).catch(() => {});
    }
  }

  async handleCommand(interaction) {
    const name = interaction.data?.name;
    const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
    switch (name) {
      case "status": return this.cmdStatus(interaction);
      case "provider": return this.cmdProvider(interaction);
      case "model": return this.cmdModel(interaction, opts);
      case "pending": return this.cmdPending(interaction);
      case "tasks": return this.cmdTasks(interaction, opts);
      case "memory": return this.cmdMemory(interaction, opts);
      case "suggestions": return this.cmdSuggestions(interaction);
      case "budget": return this.cmdBudget(interaction);
      case "skills": return this.cmdSkills(interaction);
      case "recap": return this.cmdRecap(interaction);
      case "plan": return this.cmdPlan(interaction);
      case "observe": return this.cmdObserve(interaction);
      case "sessions": return this.cmdSessions(interaction);
      case "help": return this.cmdHelp(interaction);
      default: return this.respond(interaction, { content: `Unknown command: ${name}`, flags: EPHEMERAL });
    }
  }

  async handleComponent(interaction, userId) {
    const id = interaction.data?.custom_id ?? "";
    if (id === "provider-select") {
      const choice = interaction.data?.values?.[0];
      const result = await this.switchProvider(choice);
      return this.respond(interaction, { content: result, components: [] }, T.UPDATE_MESSAGE);
    }
    if (id.startsWith("pa-approve:") || id.startsWith("pa-deny:")) {
      const [verb, actionId] = id.split(":");
      const outcome = await this.decidePendingAction(actionId, verb === "pa-approve" ? "approve" : "deny", userId);
      return this.respond(interaction, { content: outcome, components: [] }, T.UPDATE_MESSAGE);
    }
    return this.respond(interaction, { content: `Unknown component: ${id}`, flags: EPHEMERAL });
  }

  // ── Commands ────────────────────────────────────────────────────────

  async cmdStatus(interaction) {
    const host = this.channel.agentHost;
    const provider = host?.modelProvider;
    const channels = this.runtime?.channels?.status?.() ?? null;
    const memStats = this.runtime?.memory?.snapshot?.();
    const memCount = memStats ? (memStats.short?.length ?? 0) + (memStats.medium?.length ?? 0) + (memStats.long?.length ?? 0) : "?";
    const pending = this.runtime?.pendingActions?.list?.({ status: "pending" })?.length ?? 0;
    const lines = [
      "**Azazel — openAGI status**",
      `Provider: **${provider?.constructor?.name?.replace(/Provider$/, "") ?? "?"}** · model: \`${provider?.model ?? "?"}\` · configured: ${provider?.isConfigured?.() ? "✅" : "❌"}`,
      `Preference: \`${process.env.OPENAGI_PROVIDER ?? "auto"}\``,
      `Discord: ${channels?.discord?.connected ? "🟢 connected" : "🔴 down"} as ${channels?.discord?.user ?? "?"}`,
      `Memory items: ${memCount} (S/M/L ${memStats?.short?.length ?? 0}/${memStats?.medium?.length ?? 0}/${memStats?.long?.length ?? 0}) · pending approvals: ${pending}`,
      `Uptime: ${formatUptime(process.uptime())}`
    ];
    return this.respond(interaction, { content: lines.join("\n") });
  }

  async cmdProvider(interaction) {
    const current = process.env.OPENAGI_PROVIDER ?? "auto";
    const available = {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY)
    };
    const options = [
      { label: "auto (anthropic → openai → deterministic)", value: "auto", default: current === "auto" },
      { label: `anthropic${available.anthropic ? "" : " (no key!)"}`, value: "anthropic", default: current === "anthropic" },
      { label: `openai${available.openai ? "" : " (no key!)"}`, value: "openai", default: current === "openai" }
    ];
    return this.respond(interaction, {
      content: `Current provider preference: **${current}** · model: \`${this.channel.agentHost?.modelProvider?.model ?? "?"}\`\nPick a provider:`,
      components: [{
        type: 1,
        components: [{ type: 3, custom_id: "provider-select", placeholder: "Select provider…", options }]
      }]
    });
  }

  async switchProvider(choice) {
    if (!["auto", "anthropic", "openai"].includes(choice)) return `⚠ invalid choice: ${choice}`;
    process.env.OPENAGI_PROVIDER = choice;
    try {
      const { createModelProvider } = await import("./model-provider.js");
      if (this.channel.agentHost) {
        this.channel.agentHost.modelProvider = createModelProvider({ budgetGuard: this.runtime?.budget ?? null });
      }
    } catch (error) {
      return `⚠ provider rebuild failed: ${error.message}`;
    }
    try {
      const { saveEnv } = await import("./setup-wizard.js");
      saveEnv({ values: { OPENAGI_PROVIDER: choice } });
    } catch { /* runtime-only */ }
    const p = this.channel.agentHost?.modelProvider;
    return `✅ Provider set to **${choice}** → active: **${p?.constructor?.name?.replace(/Provider$/, "")}** · model \`${p?.model ?? "?"}\`${p?.isConfigured?.() ? "" : " ⚠ NOT configured (missing key)"}`;
  }

  async cmdModel(interaction, opts) {
    const provider = this.channel.agentHost?.modelProvider;
    if (!opts.name) {
      return this.respond(interaction, {
        content: `Active model: \`${provider?.model ?? "?"}\` on **${provider?.constructor?.name?.replace(/Provider$/, "") ?? "?"}**\nSet with \`/model name:<id>\``
      });
    }
    const model = String(opts.name).trim();
    if (!/^[\w.\-:/]{2,80}$/.test(model)) {
      return this.respond(interaction, { content: `⚠ that doesn't look like a model id`, flags: EPHEMERAL });
    }
    if (!provider) return this.respond(interaction, { content: "⚠ no model provider active", flags: EPHEMERAL });
    provider.model = model;
    // Persist so it survives restart, matching whichever provider is live.
    const envKey = provider.constructor?.name === "OpenAIResponsesProvider" ? "OPENAI_MODEL" : "ANTHROPIC_MODEL";
    try {
      const { saveEnv } = await import("./setup-wizard.js");
      saveEnv({ values: { [envKey]: model } });
    } catch { /* runtime-only */ }
    return this.respond(interaction, { content: `✅ Model set to \`${model}\` (persisted as ${envKey})` });
  }

  async cmdPending(interaction) {
    const store = this.runtime?.pendingActions;
    const pending = store?.list?.({ status: "pending" }) ?? [];
    if (pending.length === 0) return this.respond(interaction, { content: "✅ No actions awaiting approval." });
    const first = pending.slice(0, 4);
    const lines = ["**Pending actions:**", ...first.map((a) => `- \`${a.id}\` · **${a.toolName}** — ${a.summary ?? ""}`)];
    if (pending.length > first.length) lines.push(`…and ${pending.length - first.length} more (\`!pending\` for full list)`);
    // One row of approve/deny buttons per action (max 5 rows per message → cap 2 actions with buttons).
    const components = first.slice(0, 2).map((a) => ({
      type: 1,
      components: [
        { type: 2, style: 3, label: `Approve ${a.id.slice(-6)}`, custom_id: `pa-approve:${a.id}` },
        { type: 2, style: 4, label: `Deny ${a.id.slice(-6)}`, custom_id: `pa-deny:${a.id}` }
      ]
    }));
    return this.respond(interaction, { content: lines.join("\n"), components });
  }

  async decidePendingAction(id, decision, userId) {
    const store = this.runtime?.pendingActions;
    const action = store?.get?.(id);
    if (!action) return `⚠ No pending action \`${id}\``;
    if (action.status !== "pending") return `⚠ Action \`${id}\` already ${action.status}`;
    if (decision === "deny") {
      store.decide(id, { decision: "deny", decidedBy: `discord:${userId}` });
      return `🚫 Denied \`${id}\` (**${action.toolName}**)`;
    }
    const r = await this.runtime.tools.invoke(action.toolName, action.args, { ...(action.context ?? {}), __confirmed: true });
    store.decide(id, { decision: "approve", decidedBy: `discord:${userId}`, result: r.ok ? r.result : null, error: r.ok ? null : r.error });
    return `👍 Approved \`${id}\` (**${action.toolName}**) — ${r.ok ? "✅ executed" : `❌ ${r.error}`}`;
  }

  async cmdTasks(interaction, opts) {
    const tasks = this.runtime?.tasks?.list?.({ status: "pending", queue: opts.queue, limit: 12 }) ?? [];
    if (tasks.length === 0) return this.respond(interaction, { content: "🗒️ No pending tasks." });
    const lines = ["**Pending tasks:**", ...tasks.map((t) => `- [${t.queue}/${t.bucket}] ${t.title}`)];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  async cmdMemory(interaction, opts) {
    const memory = this.runtime?.memory;
    if (!memory?.retrieve) return this.respond(interaction, { content: "⚠ memory system unavailable", flags: EPHEMERAL });
    const hits = memory.retrieve(String(opts.query ?? ""), { limit: 5 });
    if (!hits || hits.length === 0) return this.respond(interaction, { content: `🧠 Nothing in memory for “${opts.query}”` });
    const lines = [`🧠 **Memory hits for “${opts.query}”:**`, ...hits.map((h) => {
      const item = h.item ?? h;
      return `- [${item.tier ?? "?"}${h.score != null ? ` · ${Number(h.score).toFixed(2)}` : ""}] ${String(item.content ?? "").slice(0, 200)}`;
    })];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  async cmdSuggestions(interaction) {
    const list = this.runtime?.proactiveObserver?.list?.({ status: "pending" }) ?? [];
    if (list.length === 0) return this.respond(interaction, { content: "💡 No pending suggestions." });
    const lines = ["💡 **Pending suggestions:**", ...list.slice(0, 8).map((s) => `- \`${s.id}\` [${s.category}] **${s.title}** — ${String(s.rationale ?? "").slice(0, 120)}`)];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  async cmdBudget(interaction) {
    const status = this.runtime?.budget?.status?.() ?? null;
    if (!status) return this.respond(interaction, { content: "💰 No budget guard configured." });
    return this.respond(interaction, { content: `💰 **Budget**\n\`\`\`json\n${JSON.stringify(status, null, 2).slice(0, 1800)}\n\`\`\`` });
  }

  async cmdSkills(interaction) {
    const skills = this.runtime?.skills?.list?.() ?? [];
    if (skills.length === 0) return this.respond(interaction, { content: "🧪 No skills installed." });
    const lines = ["🧪 **Skills:**", ...skills.slice(0, 15).map((s) => `- **${s.name ?? s.id}** — ${String(s.description ?? "").slice(0, 100)}`)];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  async cmdRecap(interaction) {
    await this.defer(interaction);
    try {
      const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
      const recap = await computeDailyRecap(this.runtime, {});
      const md = renderDailyRecapMarkdown(recap);
      return this.followUp(interaction, { content: `🌙 **Daily recap**\n${String(md).slice(0, 1800)}` });
    } catch (error) {
      return this.followUp(interaction, { content: `⚠ recap failed: ${error.message}` });
    }
  }

  async cmdPlan(interaction) {
    await this.defer(interaction);
    try {
      const { computeDailyPlan, renderDailyPlanMarkdown } = await import("./daily-planner.js");
      const plan = await computeDailyPlan(this.runtime, {});
      const md = renderDailyPlanMarkdown(plan);
      return this.followUp(interaction, { content: `📋 **Daily plan**\n${String(md).slice(0, 1800)}` });
    } catch (error) {
      return this.followUp(interaction, { content: `⚠ plan failed: ${error.message}` });
    }
  }

  async cmdObserve(interaction) {
    await this.defer(interaction);
    const observer = this.runtime?.proactiveObserver;
    if (!observer?.observe) return this.followUp(interaction, { content: "⚠ proactive observer unavailable" });
    try {
      const result = await observer.observe({ force: true });
      if (result?.candidate) {
        return this.followUp(interaction, { content: `💡 Observer proposed: **${result.candidate.title}** [${result.candidate.category}]\n${String(result.candidate.rationale ?? "").slice(0, 400)}` });
      }
      return this.followUp(interaction, { content: `👁️ Observer pulse ran — ${result?.reason ?? "no proposal"}` });
    } catch (error) {
      return this.followUp(interaction, { content: `⚠ observer failed: ${error.message}` });
    }
  }

  async cmdSessions(interaction) {
    const sessions = this.channel.agentHost?.store?.listSessions?.() ?? [];
    if (sessions.length === 0) return this.respond(interaction, { content: "No sessions yet." });
    const lines = ["🗂️ **Recent sessions:**", ...sessions.slice(0, 10).map((s) => `- \`${s.id}\` · ${s.messageCount ?? s.messages?.length ?? "?"} msgs`)];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  async cmdHelp(interaction) {
    const lines = ["**Commands:**", ...COMMAND_DEFS.map((c) => `- \`/${c.name}\` — ${c.description}`),
      "", "Text fallbacks: `!pending`, `!approve <id>`, `!deny <id>`"];
    return this.respond(interaction, { content: lines.join("\n") });
  }

  // ── Interaction response plumbing ───────────────────────────────────

  async respond(interaction, data, type = T.REPLY) {
    return this.channel.rest(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: { type, data }
    });
  }

  async defer(interaction) {
    return this.respond(interaction, {}, T.DEFERRED_REPLY);
  }

  async followUp(interaction, data) {
    const appId = interaction.application_id;
    return this.channel.rest(`/webhooks/${appId}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      body: data
    });
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : null, h ? `${h}h` : null, `${m}m`].filter(Boolean).join(" ");
}

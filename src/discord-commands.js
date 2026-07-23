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
  MODAL_SUBMIT: 5,
  // Response types
  REPLY: 4,
  DEFERRED_REPLY: 5,
  UPDATE_MESSAGE: 7,
  MODAL: 9
};

import { bar, COLORS, embed } from "./discord-embeds.js";
import { renderChart } from "./discord-chart.js";
import { approvePendingAction } from "./pending-actions.js";

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
    name: "autoapprove",
    description: "Show or toggle auto-approval of gated agent actions",
    options: [{
      type: 3, name: "mode", description: "on / off — omit to show current state", required: false,
      choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }]
    }]
  },
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
  {
    name: "goal",
    description: "Inspect or control persistent goal mode for this conversation",
    options: [
      { type: 1, name: "status", description: "Show the current persistent goal" },
      { type: 1, name: "pause", description: "Pause automatic goal continuation" },
      { type: 1, name: "resume", description: "Resume a paused persistent goal" },
      { type: 1, name: "clear", description: "Clear the current persistent goal" }
    ]
  },
  {
    name: "rollback",
    description: "List recent checkpoints or preview one for rollback",
    options: [{
      type: 4,
      name: "number",
      description: "Checkpoint number from the newest-first list",
      required: false,
      min_value: 1
    }]
  },
  {
    name: "schedule",
    description: "Schedule a prompt: one-shot delay, recurring interval, or daily time",
    options: [
      { type: 3, name: "prompt", description: "What the agent should run when it fires", required: true },
      { type: 3, name: "when", description: "e.g. '20m' (one-shot), 'every 2h' (recurring), 'daily 09:00'", required: true },
      { type: 3, name: "name", description: "Optional job name", required: false }
    ]
  },
  {
    name: "jobs",
    description: "List scheduled cron jobs (with cancel buttons)"
  },
  {
    name: "secrets",
    description: "List, set, or remove configured secrets",
    options: [
      { type: 1, name: "list", description: "List masked secret previews" },
      {
        type: 1,
        name: "set",
        description: "Set a secret through a private modal",
        options: [{
          type: 3,
          name: "name",
          description: "Allowlisted environment variable name",
          required: true,
          min_length: 1,
          max_length: 64
        }]
      },
      {
        type: 1,
        name: "remove",
        description: "Remove a configured secret",
        options: [{
          type: 3,
          name: "name",
          description: "Allowlisted environment variable name",
          required: true,
          min_length: 1,
          max_length: 64
        }]
      }
    ]
  },
  { name: "help", description: "List available commands" }
];

export class DiscordCommands {
  constructor(channel) {
    this.channel = channel; // DiscordChannel — rest(), log(), agentHost, allowFrom
    this.registered = false;
    this.rollbackConfirmations = new Map();
    this.rollbackConfirmationSeq = 0;
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
      if (interaction.type === T.MODAL_SUBMIT) {
        return await this.handleModalSubmit(interaction, userId);
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
      case "autoapprove": return this.cmdAutoApprove(interaction, opts);
      case "tasks": return this.cmdTasks(interaction, opts);
      case "memory": return this.cmdMemory(interaction, opts);
      case "suggestions": return this.cmdSuggestions(interaction);
      case "budget": return this.cmdBudget(interaction);
      case "skills": return this.cmdSkills(interaction);
      case "recap": return this.cmdRecap(interaction);
      case "plan": return this.cmdPlan(interaction);
      case "observe": return this.cmdObserve(interaction);
      case "sessions": return this.cmdSessions(interaction);
      case "goal": return this.cmdGoal(interaction);
      case "rollback": return this.cmdRollback(interaction, opts);
      case "schedule": return this.cmdSchedule(interaction, opts);
      case "jobs": return this.cmdJobs(interaction);
      case "secrets": return this.cmdSecrets(interaction);
      case "help": return this.cmdHelp(interaction);
      default: return this.respond(interaction, { content: `Unknown command: ${name}`, flags: EPHEMERAL });
    }
  }

  async handleComponent(interaction, userId) {
    const id = interaction.data?.custom_id ?? "";
    if (id === "provider-select") {
      const choice = interaction.data?.values?.[0];
      const result = await this.switchProvider(choice, userId);
      return this.respond(interaction, { content: result, components: [] }, T.UPDATE_MESSAGE);
    }
    if (id.startsWith("pa-approve:") || id.startsWith("pa-deny:")) {
      const [verb, actionId] = id.split(":");
      const outcome = await this.decidePendingAction(actionId, verb === "pa-approve" ? "approve" : "deny", userId);
      return this.respond(interaction, { content: outcome, components: [] }, T.UPDATE_MESSAGE);
    }
    if (id.startsWith("rollback-confirm:")) {
      const pending = this.rollbackConfirmations.get(id);
      if (!pending) {
        return this.respond(interaction, {
          content: "This rollback confirmation is expired or was already used.",
          flags: EPHEMERAL
        });
      }
      const sessionId = this.goalSessionId(interaction);
      if (pending.userId !== userId || pending.sessionId !== sessionId) {
        return this.respond(interaction, {
          content: "This rollback confirmation belongs to another session.",
          flags: EPHEMERAL
        });
      }
      if (typeof this.runtime?.tools?.invoke !== "function") {
        return this.respond(interaction, { content: "Rollback is unavailable.", flags: EPHEMERAL });
      }

      // Delete before awaiting so simultaneous or replayed clicks cannot run
      // the destructive restore more than once.
      this.rollbackConfirmations.delete(id);
      const outcome = await this.runtime.tools.invoke(
        "rollback",
        { checkpointId: pending.checkpointId },
        {
          channel: "discord",
          sessionId,
          __confirmed: true,
          __approval: { approvedVia: "discord-button", decidedBy: userId }
        }
      );
      const content = outcome?.ok
        ? `Rollback complete for checkpoint ${pending.checkpointId}.`
        : `Rollback failed: ${outcome?.error ?? "unknown error"}`;
      return this.respond(interaction, { content: content.slice(0, 1900), components: [] }, T.UPDATE_MESSAGE);
    }
    if (id.startsWith("job-cancel:")) {
      const jobId = id.slice("job-cancel:".length);
      const removed = this.runtime?.cron?.removeJob?.(jobId);
      return this.respond(interaction, { content: removed ? `🗑️ Cancelled job \`${jobId}\`` : `⚠ No job \`${jobId}\``, components: [] }, T.UPDATE_MESSAGE);
    }
    return this.respond(interaction, { content: `Unknown component: ${id}`, flags: EPHEMERAL });
  }

  async handleModalSubmit(interaction, userId) {
    const id = String(interaction.data?.custom_id ?? "");
    if (!id.startsWith("secret-set:")) {
      return this.respond(interaction, {
        content: "Unknown modal submission.",
        flags: EPHEMERAL
      });
    }
    if (!this.secretOwnerAllowed(userId)) {
      return this.respond(interaction, {
        content: "Secrets commands require a configured Discord owner allowlist.",
        flags: EPHEMERAL
      });
    }
    const store = this.runtime?.secrets;
    if (typeof store?.setSecret !== "function") {
      return this.respond(interaction, {
        content: "Secrets manager is unavailable.",
        flags: EPHEMERAL
      });
    }
    const name = id.slice("secret-set:".length);
    const value = modalTextValue(interaction, "secret-value");
    if (!value) {
      return this.respond(interaction, {
        content: "Secret value must not be blank.",
        flags: EPHEMERAL
      });
    }
    try {
      const saved = store.setSecret(name, value, {
        decidedBy: discordDecisionActor(userId)
      });
      const publicSecret = discordSecretMetadata(saved, name);
      return this.respond(interaction, {
        content: `Saved ${publicSecret.name} (${publicSecret.preview}).`,
        flags: EPHEMERAL
      });
    } catch {
      return this.respond(interaction, {
        content: "Secret could not be saved. Check that the name is allowlisted.",
        flags: EPHEMERAL
      });
    }
  }

  // ── Commands ────────────────────────────────────────────────────────

  secretOwnerAllowed(userId) {
    const allow = this.channel.allowFrom ?? [];
    return Boolean(userId && allow.length > 0 && allow.includes(userId));
  }

  async cmdSecrets(interaction) {
    const userId = discordUserId(interaction);
    if (!this.secretOwnerAllowed(userId)) {
      return this.respond(interaction, {
        content: "Secrets commands require a configured Discord owner allowlist.",
        flags: EPHEMERAL
      });
    }
    const store = this.runtime?.secrets;
    const option = interaction.data?.options?.[0];
    const action = option?.type === 1 ? option.name : "list";
    const name = String(option?.options?.find((item) => item.name === "name")?.value ?? "").trim();
    const decidedBy = discordDecisionActor(userId);

    if (action === "list") {
      if (typeof store?.listSecrets !== "function") {
        return this.respond(interaction, {
          content: "Secrets manager is unavailable.",
          flags: EPHEMERAL
        });
      }
      try {
        const listed = store.listSecrets({ decidedBy })
          .map((entry) => discordSecretMetadata(entry))
          .filter((entry) => entry.name);
        const lines = listed.length === 0
          ? ["No configured secrets."]
          : ["Configured secrets:", ...listed.map((item) => `- ${item.name}: ${item.preview}`)];
        return this.respond(interaction, {
          content: lines.join("\n").slice(0, 1900),
          flags: EPHEMERAL
        });
      } catch {
        return this.respond(interaction, {
          content: "Secrets could not be listed.",
          flags: EPHEMERAL
        });
      }
    }

    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      return this.respond(interaction, {
        content: "Provide a valid allowlisted secret name.",
        flags: EPHEMERAL
      });
    }
    let allowed = null;
    try {
      allowed = typeof store?.listAllowedNames === "function"
        ? store.listAllowedNames()
        : null;
    } catch {
      return this.respond(interaction, {
        content: "Secrets manager policy is unavailable.",
        flags: EPHEMERAL
      });
    }
    if (allowed && !allowed.includes(name)) {
      return this.respond(interaction, {
        content: "Secret name is not allowlisted.",
        flags: EPHEMERAL
      });
    }

    if (action === "set") {
      if (typeof store?.setSecret !== "function") {
        return this.respond(interaction, {
          content: "Secrets manager is unavailable.",
          flags: EPHEMERAL
        });
      }
      return this.respond(interaction, {
        custom_id: `secret-set:${name}`,
        title: `Set ${name}`.slice(0, 45),
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: "secret-value",
            label: "Secret value",
            style: 1,
            min_length: 1,
            max_length: 4000,
            required: true
          }]
        }]
      }, T.MODAL);
    }

    if (action === "remove") {
      if (typeof store?.removeSecret !== "function") {
        return this.respond(interaction, {
          content: "Secrets manager is unavailable.",
          flags: EPHEMERAL
        });
      }
      if (name === "OPENAGI_AUTH_TOKEN") {
        return this.respond(interaction, {
          content: "The dashboard auth token cannot be removed while running. Set a replacement to rotate it.",
          flags: EPHEMERAL
        });
      }
      try {
        const removed = store.removeSecret(name, { decidedBy });
        return this.respond(interaction, {
          content: removed ? `Removed ${name}.` : `${name} was not configured.`,
          flags: EPHEMERAL
        });
      } catch {
        return this.respond(interaction, {
          content: "Secret could not be removed.",
          flags: EPHEMERAL
        });
      }
    }

    return this.respond(interaction, {
      content: `Unknown secrets action: ${action}`,
      flags: EPHEMERAL
    });
  }

  async cmdStatus(interaction) {
    const host = this.channel.agentHost;
    const provider = host?.modelProvider;
    const channels = this.runtime?.channels?.status?.() ?? null;
    const memStats = this.runtime?.memory?.snapshot?.();
    const s = memStats?.short?.length ?? 0, m = memStats?.medium?.length ?? 0, l = memStats?.long?.length ?? 0;
    const pending = this.runtime?.pendingActions?.list?.({ status: "pending" })?.length ?? 0;
    const configured = provider?.isConfigured?.();
    const color = !configured ? COLORS.err : pending > 0 ? COLORS.warn : COLORS.ok;
    return this.respond(interaction, {
      embeds: [embed({
        title: "🐺 Azazel — openAGI status",
        color,
        fields: [
          { name: "Provider", value: `**${provider?.constructor?.name?.replace(/Provider$/, "") ?? "?"}** ${configured ? "✅" : "❌ not configured"}`, inline: true },
          { name: "Model", value: `\`${provider?.model ?? "?"}\``, inline: true },
          { name: "Preference", value: `\`${process.env.OPENAGI_PROVIDER ?? "auto"}\``, inline: true },
          { name: "Discord", value: channels?.discord?.connected ? `🟢 ${channels.discord.user ?? "connected"}` : "🔴 down", inline: true },
          { name: "Memory S/M/L", value: `${s} / ${m} / ${l} (${s + m + l})`, inline: true },
          { name: "Pending approvals", value: pending > 0 ? `⏸️ **${pending}**` : "0", inline: true }
        ],
        footer: `uptime ${formatUptime(process.uptime())}`
      })]
    });
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

  async switchProvider(choice, userId = null) {
    if (!["auto", "anthropic", "openai"].includes(choice)) return `⚠ invalid choice: ${choice}`;
    process.env.OPENAGI_PROVIDER = choice;
    try {
      const { createModelProvider } = await import("./model-provider.js");
      if (this.channel.agentHost) {
        this.channel.agentHost.modelProvider = createModelProvider({
          budgetGuard: this.runtime?.budget ?? null,
          secrets: this.runtime?.secrets,
          dataDir: this.runtime?.secrets?.dataDir
        });
      }
    } catch (error) {
      return `⚠ provider rebuild failed: ${error.message}`;
    }
    try {
      const { saveEnv } = await import("./setup-wizard.js");
      saveEnv({
        values: { OPENAGI_PROVIDER: choice },
        store: this.runtime?.secrets,
        decidedBy: discordDecisionActor(userId)
      });
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
      saveEnv({
        values: { [envKey]: model },
        store: this.runtime?.secrets,
        decidedBy: discordDecisionActor(discordUserId(interaction))
      });
    } catch { /* runtime-only */ }
    return this.respond(interaction, { content: `✅ Model set to \`${model}\` (persisted as ${envKey})` });
  }

  async cmdAutoApprove(interaction, opts) {
    // Show or flip the auto-approve gate. Mirrors the /auto-approve HTTP
    // endpoint: persists to .env via saveEnv (allowlisted key) and mutates
    // process.env so the live tool-registry check sees it immediately.
    const { autoApproveEnabled } = await import("./tool-registry.js");
    const mode = String(opts?.mode ?? "").toLowerCase();
    if (mode !== "on" && mode !== "off") {
      const on = autoApproveEnabled();
      return this.respond(interaction, {
        content: on
          ? "🟢 Auto-approve is **ON** — gated actions run immediately (still logged to the approval history). `/autoapprove mode:off` to require manual approval."
          : "🔴 Auto-approve is **OFF** — gated actions wait in the approval queue. `/autoapprove mode:on` to run them automatically."
      });
    }
    const enable = mode === "on";
    try {
      const { saveEnv } = await import("./setup-wizard.js");
      saveEnv({
        values: { OPENAGI_AUTO_APPROVE: enable ? "1" : "0" },
        store: this.runtime?.secrets,
        decidedBy: discordDecisionActor(discordUserId(interaction))
      });
    } catch { /* runtime-only if .env write fails */ }
    process.env.OPENAGI_AUTO_APPROVE = enable ? "1" : "0";
    // Mirror the HTTP toggle: broadcast on the runtime bus so the activity
    // feed announces the state change in the home channel too.
    this.runtime?.pendingActions?.events?.emit?.("auto-approve", { enabled: enable });
    return this.respond(interaction, {
      content: enable
        ? "🟢 Auto-approve **enabled** — gated agent actions now run without manual approval (audit trail preserved in the Approvals history)."
        : "🔴 Auto-approve **disabled** — gated agent actions will queue for manual approval again."
    });
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
    const r = await approvePendingAction(this.runtime, id, {
      decidedBy: `discord:${userId}`,
      approvedVia: "discord-command",
      decider: userId
    });
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
    await this.defer(interaction);
    const frac = status.dailyUsdLimit > 0 ? status.spentUsd / status.dailyUsdLimit : 0;
    const color = frac >= 0.9 ? COLORS.err : frac >= 0.6 ? COLORS.warn : COLORS.ok;
    const budgetEmbed = embed({
      title: "💰 Budget",
      color,
      fields: [
        { name: "Today", value: `$${status.spentUsd} / $${status.dailyUsdLimit}\n${bar(frac)} ${(frac * 100).toFixed(0)}%` },
        { name: "Calls", value: String(status.calls), inline: true },
        { name: "Tokens in/out", value: `${status.tokens?.input ?? 0} / ${status.tokens?.output ?? 0}`, inline: true },
        { name: "Remaining", value: `$${status.remainingUsd}`, inline: true }
      ],
      footer: "spend per day, last 14 days →"
    });
    // Chart: daily spend history (oldest → newest).
    try {
      const history = [...(status.history ?? [])].reverse();
      const png = renderChart({ series: [{ points: history.map((h) => h.usd), kind: "bar" }] });
      return await this.followUpFile(interaction, png, "budget.png", { embeds: [budgetEmbed] });
    } catch {
      return this.followUp(interaction, { embeds: [budgetEmbed] });
    }
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
      return this.followUp(interaction, {
        embeds: [embed({ title: "🌙 Daily recap", description: String(md).slice(0, 3900), color: COLORS.think })]
      });
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
      return this.followUp(interaction, {
        embeds: [embed({ title: "📋 Daily plan", description: String(md).slice(0, 3900), color: COLORS.info })]
      });
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

  goalSessionId(interaction) {
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
    return this.channel.sessionKeyFor({
      guild_id: interaction.guild_id ?? null,
      channel_id: interaction.channel_id,
      author: { id: userId }
    });
  }

  async cmdGoal(interaction) {
    const goals = this.runtime?.goals;
    if (!goals?.get) {
      return this.respond(interaction, { content: "Goal mode is unavailable.", flags: EPHEMERAL });
    }

    const option = interaction.data?.options?.[0];
    const action = option?.type === 1 ? option.name : "status";
    const sessionId = this.goalSessionId(interaction);
    const current = goals.get(sessionId);

    if (action === "status") {
      if (!current) return this.respond(interaction, { content: "No persistent goal is set for this conversation." });
      const turns = Number.isFinite(current.turns) ? current.turns : 0;
      const maxTurns = Number.isFinite(current.maxTurns) ? current.maxTurns : "?";
      return this.respond(interaction, {
        content: [
          `Goal mode: **${current.status ?? "unknown"}**`,
          `Objective: ${String(current.objective ?? "(not set)").slice(0, 1500)}`,
          `Turns: ${turns}/${maxTurns}`
        ].join("\n")
      });
    }

    if (!current) {
      return this.respond(interaction, { content: "No persistent goal is set for this conversation." });
    }
    if (action === "pause") {
      goals.pause(sessionId);
      return this.respond(interaction, { content: "Persistent goal paused." });
    }
    if (action === "resume") {
      if (current.status !== "paused") {
        const message = current.status === "active"
          ? "Persistent goal is already active."
          : `Persistent goal cannot resume from status ${current.status}.`;
        return this.respond(interaction, { content: message });
      }
      const resumed = goals.resume(sessionId);
      if (resumed && resumed.status !== "active") {
        return this.respond(interaction, {
          content: "Persistent goal cannot resume because its turn budget is exhausted. Clear it and create a new goal."
        });
      }
      if (typeof this.channel.agentHost?.handleMessage !== "function" || !resumed) {
        return this.respond(interaction, { content: "Persistent goal resumed." });
      }
      await this.defer(interaction);
      try {
        const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
        const runContinuation = () => this.channel.agentHost.handleMessage({
            channel: "discord",
            from: userId,
            agentId: "main",
            sessionId,
            text: `Continue the active persistent goal from saved progress. Objective: ${resumed.objective}`,
            goalContinuation: true,
            metadata: {
              channelId: interaction.channel_id,
              guildId: interaction.guild_id ?? null,
              goalContinuation: true
            }
          });
        const result = typeof this.channel.enqueueSessionTask === "function"
          ? await this.channel.enqueueSessionTask(sessionId, runContinuation)
          : await runContinuation();
        const reply = String(result?.reply ?? "").trim();
        return this.followUp(interaction, {
          content: (reply || "Persistent goal resumed.").slice(0, 1900)
        });
      } catch (error) {
        return this.followUp(interaction, { content: `Goal resume failed: ${error?.message ?? String(error)}`.slice(0, 1900) });
      }
    }
    if (action === "clear") {
      goals.clear(sessionId);
      return this.respond(interaction, { content: "Persistent goal cleared." });
    }
    return this.respond(interaction, { content: `Unknown goal action: ${action}`, flags: EPHEMERAL });
  }

  async cmdRollback(interaction, opts = {}) {
    const store = this.runtime?.checkpoints;
    if (typeof store?.list !== "function") {
      return this.respond(interaction, { content: "Checkpoints are unavailable.", flags: EPHEMERAL });
    }
    const sessionId = this.goalSessionId(interaction);
    const listed = await store.list({ sessionId, limit: 10 });
    const checkpoints = (Array.isArray(listed) ? listed : listed?.checkpoints ?? [])
      .filter((checkpoint) => checkpointIdOf(checkpoint));
    const requested = opts.number;

    if (requested === undefined) {
      if (checkpoints.length === 0) {
        return this.respond(interaction, {
          content: "No checkpoints are available for this session.",
          flags: EPHEMERAL
        });
      }
      const previews = await Promise.all(checkpoints.map(async (checkpoint) => ({
        checkpoint,
        preview: await this.checkpointPreview(checkpoint)
      })));
      const lines = ["Recent checkpoints for this session (newest first):"];
      for (let index = 0; index < previews.length; index += 1) {
        const { checkpoint, preview } = previews[index];
        const summary = compactCheckpointPreview(checkpoint, preview, 180).replace(/\s*\n\s*/g, " / ");
        lines.push(`${index + 1}. ${checkpointLabel(checkpoint)}${summary ? ` - ${summary}` : ""}`);
      }
      lines.push("Run /rollback number:<N> to preview and confirm a restore.");
      return this.respond(interaction, { content: lines.join("\n").slice(0, 1900), flags: EPHEMERAL });
    }

    if (!Number.isInteger(requested) || requested < 1) {
      return this.respond(interaction, {
        content: "Rollback number must be a positive integer from the newest-first list.",
        flags: EPHEMERAL
      });
    }
    const checkpoint = checkpoints[requested - 1];
    if (!checkpoint) {
      return this.respond(interaction, {
        content: `Checkpoint number ${requested} is out of range for this session.`,
        flags: EPHEMERAL
      });
    }

    const checkpointId = checkpointIdOf(checkpoint);
    const preview = await this.checkpointPreview(checkpoint);
    const previewText = compactCheckpointPreview(checkpoint, preview, 1200) || "No diff preview is available.";
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
    const confirmationId = `rollback-confirm:${(++this.rollbackConfirmationSeq).toString(36)}`;
    if (this.rollbackConfirmations.size >= 50) {
      const oldest = this.rollbackConfirmations.keys().next().value;
      if (oldest) this.rollbackConfirmations.delete(oldest);
    }
    this.rollbackConfirmations.set(confirmationId, {
      checkpointId,
      sessionId,
      userId
    });
    return this.respond(interaction, {
      content: [
        `Confirm rollback to checkpoint ${requested}: ${checkpointLabel(checkpoint)}`,
        "Preview:",
        previewText
      ].join("\n").slice(0, 1900),
      flags: EPHEMERAL,
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 4,
          label: `Confirm rollback ${requested}`,
          custom_id: confirmationId
        }]
      }]
    });
  }

  async checkpointPreview(checkpoint) {
    if (typeof this.runtime?.checkpoints?.preview !== "function") return null;
    try {
      return await this.runtime.checkpoints.preview(checkpointIdOf(checkpoint));
    } catch (error) {
      return { error: error?.message ?? String(error) };
    }
  }

  async cmdSessions(interaction) {
    const sessions = this.channel.agentHost?.store?.listSessions?.() ?? [];
    if (sessions.length === 0) return this.respond(interaction, { content: "No sessions yet." });
    const lines = ["🗂️ **Recent sessions:**", ...sessions.slice(0, 10).map((s) => `- \`${s.id}\` · ${s.messageCount ?? s.messages?.length ?? "?"} msgs`)];
    return this.respond(interaction, { content: lines.join("\n").slice(0, 1900) });
  }

  // ── Cron lane: /schedule + /jobs ────────────────────────────────────

  // "20m" → one-shot; "every 2h" → recurring; "daily 09:00" → daily.
  parseWhen(when) {
    const s = String(when ?? "").trim().toLowerCase();
    const daily = /^daily\s+(\d{1,2}:\d{2})$/.exec(s);
    if (daily) return { dailyAt: daily[1] };
    const unit = { s: 1, m: 60, h: 3600, d: 86400 };
    const every = /^every\s+(\d+)\s*([smhd])$/.exec(s);
    if (every) return { intervalSeconds: Number(every[1]) * unit[every[2]] };
    const once = /^(\d+)\s*([smhd])$/.exec(s);
    if (once) return { delaySeconds: Number(once[1]) * unit[once[2]] };
    return null;
  }

  async cmdSchedule(interaction, opts) {
    const cron = this.runtime?.cron;
    if (!cron) return this.respond(interaction, { content: "⚠ cron scheduler unavailable", flags: EPHEMERAL });
    const parsed = this.parseWhen(opts.when);
    if (!parsed) {
      return this.respond(interaction, { content: "⚠ Couldn't parse `when`. Use `20m` (one-shot), `every 2h` (recurring), or `daily 09:00`.", flags: EPHEMERAL });
    }
    if ((parsed.delaySeconds ?? parsed.intervalSeconds ?? 30) < 30) {
      return this.respond(interaction, { content: "⚠ Minimum delay/interval is 30s.", flags: EPHEMERAL });
    }
    const job = {
      id: `job-${Date.now().toString(36)}`,
      name: opts.name ?? `discord-${(opts.prompt ?? "").slice(0, 30)}`,
      enabled: true,
      task: "prompt",
      replace: true,
      input: {
        prompt: String(opts.prompt ?? "").trim(),
        channel: "discord",
        target: interaction.channel_id,
        agentId: "main",
        sessionId: `discord:${interaction.guild_id ?? "dm"}:${interaction.channel_id}`,
        oneShot: Boolean(parsed.delaySeconds)
      }
    };
    if (parsed.delaySeconds) {
      job.intervalMs = parsed.delaySeconds * 1000;
      job.nextRunAt = new Date(Date.now() + parsed.delaySeconds * 1000).toISOString();
    } else if (parsed.intervalSeconds) {
      job.intervalMs = parsed.intervalSeconds * 1000;
    } else {
      job.dailyAt = parsed.dailyAt;
    }
    const created = cron.addJob(job);
    const kind = parsed.delaySeconds ? "one-shot" : parsed.intervalSeconds ? "recurring" : `daily at ${parsed.dailyAt}`;
    return this.respond(interaction, {
      embeds: [embed({
        title: "⏰ Scheduled",
        color: COLORS.ok,
        fields: [
          { name: "Job", value: `\`${created.id}\` · ${created.name}`, inline: false },
          { name: "Kind", value: kind, inline: true },
          { name: "Next fire", value: created.nextRunAt ? `<t:${Math.floor(new Date(created.nextRunAt).getTime() / 1000)}:R>` : "?", inline: true }
        ],
        footer: "results deliver back to this channel · /jobs to manage"
      })]
    });
  }

  async cmdJobs(interaction) {
    const jobs = this.runtime?.cron?.listJobs?.() ?? [];
    if (jobs.length === 0) return this.respond(interaction, { content: "⏰ No scheduled jobs." });
    const rows = jobs.slice(0, 12).map((j) => {
      const next = j.nextRunAt ? `<t:${Math.floor(new Date(j.nextRunAt).getTime() / 1000)}:R>` : "—";
      return `${j.enabled ? "🟢" : "⚪"} \`${j.id}\` **${j.name}** · ${j.task} · next ${next}`;
    });
    // Cancel buttons for the first few user-created prompt jobs (5-row cap).
    const cancellable = jobs.filter((j) => j.task === "prompt").slice(0, 5);
    const components = cancellable.length > 0 ? [{
      type: 1,
      components: cancellable.map((j) => ({
        type: 2, style: 4, label: `✕ ${String(j.id).slice(-8)}`, custom_id: `job-cancel:${j.id}`
      }))
    }] : [];
    return this.respond(interaction, {
      embeds: [embed({ title: "⏰ Scheduled jobs", description: rows.join("\n").slice(0, 3900), color: COLORS.info })],
      components
    });
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

  // Deferred follow-up with a file attachment (charts).
  async followUpFile(interaction, buffer, filename, { content = "", embeds = null } = {}) {
    const appId = interaction.application_id;
    const payload = { content, attachments: [{ id: 0, filename }] };
    if (embeds) payload.embeds = embeds;
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([buffer]), filename);
    const response = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      body: form
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json?.message ?? `Discord webhook upload failed with ${response.status}`);
    }
    return response.json();
  }
}

function checkpointIdOf(checkpoint) {
  return String(checkpoint?.id ?? checkpoint?.checkpointId ?? "").trim();
}

function checkpointLabel(checkpoint) {
  const parts = [`\`${checkpointIdOf(checkpoint)}\``];
  const createdAt = checkpoint?.createdAt ?? checkpoint?.at ?? null;
  const target = checkpoint?.directory ?? checkpoint?.root ?? checkpoint?.path ?? null;
  if (createdAt) parts.push(String(createdAt));
  if (target) parts.push(String(target));
  return parts.join(" | ");
}

function compactCheckpointPreview(checkpoint, preview, maxChars) {
  const candidates = [];
  if (typeof preview === "string") candidates.push(preview);
  if (preview && typeof preview === "object") {
    for (const key of ["summary", "preview", "diff", "diffPreview", "message", "error"]) {
      if (typeof preview[key] === "string") candidates.push(preview[key]);
    }
    for (const collection of [preview.files, preview.changes]) {
      if (!Array.isArray(collection)) continue;
      for (const item of collection.slice(0, 5)) {
        if (typeof item === "string") {
          candidates.push(item);
          continue;
        }
        const name = item?.path ?? item?.file ?? item?.name ?? "file";
        const detail = item?.diffPreview ?? item?.diff ?? item?.summary ?? item?.status ?? "changed";
        candidates.push(`${name}: ${detail}`);
      }
    }
  }
  if (candidates.length === 0) {
    if (typeof checkpoint?.summary === "string") candidates.push(checkpoint.summary);
    else if (Array.isArray(checkpoint?.files)) {
      candidates.push(checkpoint.files.slice(0, 5).map((item) => item?.path ?? item?.file ?? item).join(", "));
    } else if (preview != null) {
      try { candidates.push(JSON.stringify(preview)); } catch { /* bounded fallback below */ }
    }
  }
  return candidates
    .filter(Boolean)
    .join("\n")
    .replace(/```/g, "'''")
    .trim()
    .slice(0, maxChars);
}

function discordUserId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function discordDecisionActor(userId) {
  const normalized = String(userId ?? "").trim();
  return normalized ? `discord:${normalized}` : "discord:unknown";
}

function modalTextValue(interaction, customId) {
  for (const row of interaction.data?.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id === customId) return String(component.value ?? "").trim();
    }
  }
  return "";
}

function discordSecretMetadata(entry, fallbackName = "") {
  const name = fallbackName || (
    typeof entry?.name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.name)
      ? entry.name
      : ""
  );
  const last4 = typeof entry?.last4 === "string" && entry.last4.length <= 4
    ? entry.last4
    : null;
  return {
    name,
    preview: last4 ? `****${last4}` : "****"
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : null, h ? `${h}h` : null, `${m}m`].filter(Boolean).join(" ");
}

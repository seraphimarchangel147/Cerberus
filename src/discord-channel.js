// Discord channel for OpenAGI — gateway (WSS) inbound + REST outbound.
// Zero-dependency: uses Node's native WebSocket (Node >= 22) and fetch.
//
// Config (env or options):
//   DISCORD_BOT_TOKEN     — bot token (required to enable)
//   DISCORD_ALLOW_FROM    — comma-separated user ids allowed to DM the agent
//   DISCORD_GUILDS        — comma-separated guild ids to serve (empty = all)
//   DISCORD_REQUIRE_MENTION — "1" (default) only reply in guilds when pinged
//   DISCORD_REPLY         — "1"/"true"/"on" enables quoted replies (default off)
//   DISCORD_STREAMING     — "0"/"false"/"off" disables live token edits (default on)
//
// Behavior mirrors the hermesagent wiring this agent migrated from:
//   * guild messages require a mention (user OR role ping counts)
//   * bot-authored messages only count when they mention us
//   * DMs gated by the allowFrom id list
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
import { DiscordCommands } from "./discord-commands.js";
import { ANSI, COLORS, embed } from "./discord-embeds.js";
import { approvePendingAction } from "./pending-actions.js";

const API = "https://discord.com/api/v10";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const EPHEMERAL = 64;
const EXPIRED_COLOR = 0x95a5a6;
const DISCORD_REST_MAX_ATTEMPTS = 3;
const DISCORD_RETRY_MAX_MS = 10_000;

// Reply quoting is deliberately opt-in and checked at send time. Operators
// can flip DISCORD_REPLY live without rebuilding the channel or changing the
// many call sites that still pass the originating message id.
export function discordReplyEnabled() {
  const value = String(process.env.DISCORD_REPLY ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function discordStreamingEnabled() {
  const value = String(process.env.DISCORD_STREAMING ?? "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

export function formatEmptyTurnFallback(result = {}) {
  const toolCount = result?.toolCalls?.length ?? result?.output?.toolCalls?.length ?? 0;
  const suffix = `${toolCount} tool call${toolCount === 1 ? "" : "s"} ran`;
  const iterations = result?.model?.iterations;
  const stopReason = result?.model?.stopReason;

  if (stopReason === "iteration-cap") {
    const count = Number.isInteger(iterations) ? iterations : result?.model?.maxIterations;
    return `⚠ Turn reached the true iteration cap after ${count ?? "the configured number of"} iterations (${suffix}). Raise OPENAGI_MAX_ITERATIONS to allow more work in one turn.`;
  }
  if (stopReason === "turn-timeout") {
    return `⚠ Turn stopped at the wall-clock guard after ${iterations ?? "several"} iterations (${suffix}). Raise OPENAGI_MAX_TURN_SECONDS if this task needs more time.`;
  }
  if (stopReason === "budget-cap") {
    return `⚠ Turn stopped at a budget cap after ${iterations ?? "several"} iterations (${suffix}). Raise OPENAGI_MAX_TURN_USD for a larger per-turn budget, or OPENAGI_DAILY_USD_LIMIT for the daily budget.`;
  }
  return `⚠ Turn completed without a text reply (${suffix}).`;
}

export class DiscordChannel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    // An explicit null is how ChannelManager hard-disables live transports in
    // OPENAGI_TEST mode. Preserve the historical env fallback for undefined,
    // but never let nullish coalescing resurrect a deliberately disabled token.
    this.token = options.token === null ? null : (options.token ?? process.env.DISCORD_BOT_TOKEN);
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels", "discord");
    ensureDir(this.dir);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.statePath = path.join(this.dir, "state.json");
    this.state = readJsonFile(this.statePath, {});
    this.allowFrom = splitIds(options.allowFrom ?? process.env.DISCORD_ALLOW_FROM);
    this.guilds = splitIds(options.guilds ?? process.env.DISCORD_GUILDS);
    this.requireMention = (options.requireMention ?? process.env.DISCORD_REQUIRE_MENTION ?? "1") !== "0";
    this.ws = null;
    this.heartbeatTimer = null;
    this.heartbeatAcked = true;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.botUser = null;
    this.memberRoles = new Map(); // guildId -> Set(roleIds of our member)
    this.stopped = true;
    this.reconnectDelay = 1000;
    // Turns in one conversation must stay ordered, but unrelated users must
    // not wait behind each other. Settled tails are removed by enqueueTurn.
    this.turnLocks = new Map();
    // ── Hermes-style observability ──────────────────────────────────
    // Live status: a message we post + edit while a turn runs so the user
    // can watch scrutiny verdicts and tool calls in real time.
    this.liveStatus = (options.liveStatus ?? process.env.DISCORD_LIVE_STATUS ?? "1") !== "0";
    // Activity feed: runtime bus events (observer suggestions, approvals,
    // skill candidates, self-updates) posted to a home channel.
    this.activityChannel = options.activityChannel ?? process.env.DISCORD_ACTIVITY_CHANNEL ?? null;
    this.feedBound = false;
    // Slash commands + component interactions (/status, /provider drop-down,
    // approve/deny buttons). Registered at READY.
    this.applicationId = null;
    this.commands = new DiscordCommands(this);
    // One state object per catastrophic prompt mirrors Hermes's View.resolved
    // flag. Store status alone is too late because approval execution is async.
    this.approvalPrompts = new Map();
    // Presence: live activity in the member list ("Watching N pending
    // approvals" / "Playing kimi-k3"). DISCORD_PRESENCE=0 disables.
    this.presence = (options.presence ?? process.env.DISCORD_PRESENCE ?? "1") !== "0";
    this.presenceTimer = null;
    this.restFetch = options.fetch ?? globalThis.fetch;
    this.restSleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status() {
    return {
      configured: Boolean(this.token),
      connected: Boolean(this.ws && this.ws.readyState === 1),
      user: this.botUser ? `${this.botUser.username}#${this.botUser.discriminator}` : null,
      guilds: this.guilds,
      requireMention: this.requireMention
    };
  }

  log(entry) {
    try { appendJsonLine(this.eventsPath, { at: nowIso(), ...entry }); } catch { /* ignore */ }
  }

  start() {
    if (!this.token || this.ws) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    for (const state of this.approvalPrompts.values()) clearTimeout(state.timer);
    this.approvalPrompts.clear();
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.ws = null;
  }

  connect() {
    const url = (this.resumeUrl ?? "wss://gateway.discord.gg") + "/?v=10&encoding=json";
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.log({ op: "connect-error", error: error.message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      this.handleGatewayPayload(payload).catch((error) => this.log({ op: "handler-error", error: error.message }));
    });
    ws.addEventListener("close", (ev) => {
      this.log({ op: "gateway-close", code: ev.code });
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.ws = null;
      // 4004 = bad token: don't loop forever hammering Discord.
      if (ev.code === 4004) { this.log({ op: "fatal-auth", note: "invalid token, not reconnecting" }); return; }
      if (!this.stopped) this.scheduleReconnect();
    });
    ws.addEventListener("error", () => { /* close event follows */ });
  }

  scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  async handleGatewayPayload({ op, t, s, d }) {
    if (s != null) this.seq = s;
    if (op === 10) { // HELLO
      this.reconnectDelay = 1000;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatAcked = true;
      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAcked) { try { this.ws?.close(4000); } catch { /* */ } return; }
        this.heartbeatAcked = false;
        this.send(1, this.seq);
      }, d.heartbeat_interval);
      if (this.sessionId && this.seq != null) {
        this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq }); // RESUME
      } else {
        this.identify();
      }
      return;
    }
    if (op === 11) { this.heartbeatAcked = true; return; } // HEARTBEAT ACK
    if (op === 1) { this.send(1, this.seq); return; }       // server asked for heartbeat
    if (op === 7) { try { this.ws?.close(4001); } catch { /* */ } return; } // RECONNECT
    if (op === 9) { // INVALID SESSION
      this.sessionId = null;
      setTimeout(() => this.identify(), 2000 + Math.random() * 3000);
      return;
    }
    if (op !== 0) return;

    if (t === "READY") {
      this.botUser = d.user;
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url ?? this.resumeUrl;
      this.applicationId = d.application?.id ?? this.applicationId;
      this.log({ op: "ready", user: d.user?.username, id: d.user?.id });
      // Register slash commands (guild-scoped → instant). Fire-and-forget.
      this.commands.register(this.applicationId).catch(() => {});
      // Ambient presence dashboard, refreshed every 60s.
      this.refreshIdlePresence();
      if (this.presenceTimer) clearInterval(this.presenceTimer);
      this.presenceTimer = setInterval(() => this.refreshIdlePresence(), 60000);
      return;
    }
    if (t === "RESUMED") { this.log({ op: "resumed" }); return; }
    if (t === "INTERACTION_CREATE") {
      if (isPendingApprovalInteraction(d)) await this.handlePendingApprovalInteraction(d);
      else await this.commands.handle(d);
      return;
    }
    if (t === "MESSAGE_CREATE") await this.handleMessage(d);
  }

  identify() {
    this.send(2, {
      token: this.token,
      intents: INTENTS,
      properties: { os: "linux", browser: "openagi", device: "openagi" }
    });
  }

  isDirectedAtMe(message) {
    const me = this.botUser?.id;
    if (!me) return false;
    if ((message.mentions ?? []).some((u) => u.id === me)) return true;
    // Role pings render blue and are directed at us too — check our member
    // roles in this guild against mention_roles.
    const roles = this.memberRoles.get(message.guild_id);
    if (roles && (message.mention_roles ?? []).some((r) => roles.has(r))) return true;
    return false;
  }

  async ensureMemberRoles(guildId) {
    if (!guildId || this.memberRoles.has(guildId) || !this.botUser) return;
    try {
      const member = await this.rest(`/guilds/${guildId}/members/${this.botUser.id}`);
      this.memberRoles.set(guildId, new Set(member.roles ?? []));
    } catch (error) {
      this.memberRoles.set(guildId, new Set());
      this.log({ op: "member-roles-error", guildId, error: error.message });
    }
  }

  async handleMessage(message) {
    const me = this.botUser?.id;
    if (!me || message.author?.id === me) return;               // never answer ourselves
    const isDm = !message.guild_id;
    const text = (message.content ?? "").trim();
    const hasImages = Array.isArray(message.attachments)
      && message.attachments.some((a) => {
        const ct = String(a?.content_type ?? "").split(";")[0].trim().toLowerCase();
        return SUPPORTED_IMAGE_TYPES.has(ct) || /\.(png|jpe?g|webp|gif)$/i.test(String(a?.filename ?? ""));
      });
    if (!text && !hasImages) return;                            // nothing to act on

    if (isDm) {
      if (this.allowFrom.length > 0 && !this.allowFrom.includes(message.author?.id)) {
        this.log({ op: "ignored-dm", from: message.author?.id });
        return;
      }
    } else {
      if (this.guilds.length > 0 && !this.guilds.includes(message.guild_id)) return;
      await this.ensureMemberRoles(message.guild_id);
      const directed = this.isDirectedAtMe(message);
      if (message.author?.bot && !directed) return;             // bots only via mention
      if (this.requireMention && !directed) return;             // humans: mention-gated
    }

    // Strip our own mention tokens so the model sees clean text.
    const cleaned = text
      .replace(new RegExp(`<@!?${me}>`, "g"), "")
      .trim() || (hasImages ? "(image attached — no caption)" : text);

    this.log({ op: "inbound", from: message.author?.id, channel: message.channel_id, guild: message.guild_id ?? null, len: text.length });
    // Track where Azazel is actively working so the activity feed can follow
    // him (Hermes-style): feed posts route to the channel of the current
    // conversation, not just the static home channel.
    this.lastActiveChannel = message.channel_id;

    // Approvals from Discord: "!approve <id>" / "!deny <id>" from an
    // allowFrom user decides a pending action without opening the dashboard.
    if (this.allowFrom.includes(message.author?.id)) {
      const cmd = /^!(approve|deny|pending)\b\s*(\S+)?/i.exec(cleaned);
      if (cmd) {
        await this.handleApprovalCommand(message, cmd[1].toLowerCase(), cmd[2] ?? null);
        return;
      }
    }

    // Dispatch without awaiting the shared gateway handler. enqueueTurn keeps
    // same-session ordering while allowing unrelated conversations to overlap.
    this.enqueueTurn(message, cleaned);
  }

  sessionKeyFor(message) {
    const guild = message.guild_id ?? "dm";
    const channel = message.channel_id;
    // Guild channels are multi-user, so include the author to prevent context
    // bleed. DMs are already one-to-one and retain their historical key.
    const user = message.guild_id ? (message.author?.id ?? "unknown") : null;
    return user
      ? `discord:${guild}:${channel}:${user}`
      : `discord:${guild}:${channel}`;
  }

  enqueueTurn(message, cleaned) {
    const key = this.sessionKeyFor(message);
    // This must happen before chaining onto the session lock. A real user
    // message stops goal-mode continuation immediately, even when an earlier
    // turn for the same session is still running.
    if (!message.author?.bot) {
      const goals = this.agentHost?.runtime?.goals;
      try {
        if (goals?.get?.(key)?.status === "active") {
          goals.preempt?.(key, "discord-user-message");
        }
      } catch (error) {
        this.log({ op: "goal-preempt-error", key, error: error?.message ?? String(error) });
      }
    }
    const previous = this.turnLocks.get(key) ?? Promise.resolve();
    // runTurn normally catches its own failures. This final boundary prevents
    // a failed error path from poisoning every later turn for the same key.
    const next = previous.then(() => this.runTurn(message, cleaned)).catch((err) => {
      this.log({ op: "turn-rejected", key, error: err?.message ?? String(err) });
      return this.sendMessage(
        message.channel_id,
        `⚠ Turn failed hard: ${(err?.message ?? String(err)).slice(0, 400)}`,
        message.id
      ).catch((sendErr) => this.log({ op: "turn-rejected-notify-failed", key, error: sendErr?.message ?? String(sendErr) }));
    });
    this.turnLocks.set(key, next);
    next.finally(() => {
      if (this.turnLocks.get(key) === next) this.turnLocks.delete(key);
    });
    return next;
  }

  enqueueSessionTask(key, task) {
    const previous = this.turnLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.turnLocks.set(key, next);
    const cleanup = () => {
      if (this.turnLocks.get(key) === next) this.turnLocks.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  // ── Discord-side approvals (mirrors /pending-actions endpoints) ────
  async handleApprovalCommand(message, verb, id) {
    const runtime = this.agentHost?.runtime;
    const store = runtime?.pendingActions;
    if (!store) {
      await this.sendMessage(message.channel_id, "⚠ pending-actions store unavailable", message.id);
      return;
    }
    if (verb === "pending") {
      const pending = store.list({ status: "pending" }).slice(0, 10);
      const lines = pending.length === 0
        ? ["✅ No actions awaiting approval."]
        : ["**Pending actions:**", ...pending.map((a) => `- \`${a.id}\` · **${a.toolName}** — ${a.summary ?? ""}${a.reason ? ` _(${a.reason})_` : ""}`),
           "", "Use `!approve <id>` or `!deny <id>`."];
      await this.sendMessage(message.channel_id, lines.join("\n"), message.id);
      return;
    }
    if (!id) {
      await this.sendMessage(message.channel_id, `Usage: \`!${verb} <action-id>\` (see \`!pending\`)`, message.id);
      return;
    }
    const action = store.get(id);
    if (!action) {
      await this.sendMessage(message.channel_id, `⚠ No pending action with id \`${id}\``, message.id);
      return;
    }
    if (action.status !== "pending") {
      await this.sendMessage(message.channel_id, `⚠ Action \`${id}\` already ${action.status}`, message.id);
      return;
    }
    if (verb === "deny") {
      store.decide(id, { decision: "deny", decidedBy: `discord:${message.author?.id}` });
      await this.sendMessage(message.channel_id, `🚫 Denied \`${id}\` (**${action.toolName}**)`, message.id);
      return;
    }
    // A live suspended turn resumes through decide(); persisted actions with
    // no waiter still execute exactly once inside this shared helper.
    const r = await approvePendingAction(runtime, id, {
      decidedBy: `discord:${message.author?.id}`,
      approvedVia: "discord-command",
      decider: message.author?.id
    });
    const tail = r.ok ? "✅ executed" : `❌ failed: ${r.error}`;
    await this.sendMessage(message.channel_id, `👍 Approved \`${id}\` (**${action.toolName}**) — ${tail}`, message.id);
  }

  async runTurn(message, text) {
    let typingTimer = null;
    const status = new LiveStatus(this, message.channel_id, this.liveStatus);
    const replyStream = new DiscordReplyStream(
      this,
      message.channel_id,
      message.id,
      discordStreamingEnabled()
    );
    try {
      await this.rest(`/channels/${message.channel_id}/typing`, { method: "POST" }).catch(() => {});
      typingTimer = setInterval(() => {
        this.rest(`/channels/${message.channel_id}/typing`, { method: "POST" }).catch(() => {});
      }, 8000);
      await status.begin(message.id, text.slice(0, 60));
      const authorName = message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? "user";
      // Download any image attachments so a vision model can see them.
      const images = await fetchDiscordImages(message, (e) => this.log(e));
      if (images.length > 0) this.log({ op: "inbound-images", count: images.length, channel: message.channel_id });
      const result = await this.agentHost.handleMessage({
        channel: "discord",
        from: message.author?.id ?? "unknown",
        agentId: "main",
        sessionId: this.sessionKeyFor(message),
        text: message.guild_id ? `[${authorName}] ${text}` : text,
        images,
        onToolEvent: (ev) => status.onEvent(ev),
        onDelta: replyStream.enabled ? (chunk) => replyStream.onDelta(chunk) : null,
        metadata: {
          discordMessageId: message.id,
          channelId: message.channel_id,
          guildId: message.guild_id ?? null,
          username: message.author?.username,
          authorBot: message.author?.bot === true
        }
      });
      await status.finish(result);
      const replyText = String(result?.reply ?? "").trim();
      if (replyText && replyText !== "(no text)") {
        const delivered = await replyStream.finish(replyText);
        if (!delivered) await this.sendMessage(message.channel_id, replyText, message.id);
      } else {
        // Never end a pinged turn in silence — surface the actual stop reason.
        await replyStream.stop();
        await this.sendMessage(message.channel_id, formatEmptyTurnFallback(result), message.id);
      }
    } catch (error) {
      this.log({ op: "turn-error", error: error.message });
      await replyStream.stop().catch(() => {});
      await status.fail(error).catch(() => {});
      await this.sendMessage(message.channel_id, `⚠ ${error.message}`.slice(0, 500), message.id).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  }

  async sendMessage(channelId, text, replyToId = null, extra = null) {
    const chunks = chunkText(String(text ?? ""), 1990);
    let last = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const body = { content: chunks[i] };
      if (i === 0 && replyToId && discordReplyEnabled()) {
        body.message_reference = { message_id: replyToId, fail_if_not_exists: false };
      }
      if (i === chunks.length - 1 && extra?.embeds) body.embeds = extra.embeds;
      if (i === chunks.length - 1 && extra?.components) body.components = extra.components;
      last = await this.rest(`/channels/${channelId}/messages`, { method: "POST", body });
    }
    return last;
  }

  // Embed-first send: no plain content, just a rich embed (+ optional reply).
  async sendEmbed(channelId, embedObj, replyToId = null) {
    const body = { embeds: [embedObj] };
    if (replyToId && discordReplyEnabled()) {
      body.message_reference = { message_id: replyToId, fail_if_not_exists: false };
    }
    return this.rest(`/channels/${channelId}/messages`, { method: "POST", body });
  }

  // Attachment upload (charts). Node 22 fetch speaks multipart via FormData.
  async sendFile(channelId, buffer, filename, { content = "", embeds = null } = {}) {
    const payload = { content, attachments: [{ id: 0, filename }] };
    if (embeds) payload.embeds = embeds;
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([buffer]), filename);
    const response = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.token}` },
      body: form
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json?.message ?? `Discord upload failed with ${response.status}`);
    }
    return response.json();
  }

  // Spawn a public thread off a message (thread-per-task live traces).
  async createThread(channelId, messageId, name) {
    return this.rest(`/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      body: { name: String(name).slice(0, 100), auto_archive_duration: 60 }
    });
  }

  // ── Presence: ambient dashboard in the member list ─────────────────
  // "Watching 2 pending approvals" / "Playing kimi-k3" — free observability.
  setPresence(text, type = 3) { // 0=Playing 3=Watching 4=Custom
    if (!this.presence) return;
    this.send(3, {
      since: null,
      activities: text ? [{ name: String(text).slice(0, 100), type }] : [],
      status: "online",
      afk: false
    });
  }

  refreshIdlePresence() {
    if (!this.presence) return;
    try {
      const pending = this.agentHost?.runtime?.pendingActions?.list?.({ status: "pending" })?.length ?? 0;
      if (pending > 0) this.setPresence(`${pending} pending approval${pending === 1 ? "" : "s"}`, 3);
      else this.setPresence(this.agentHost?.modelProvider?.model ?? "the desert", 0);
    } catch { /* advisory */ }
  }

  async editMessage(channelId, messageId, text) {
    return this.rest(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: { content: String(text).slice(0, 1990) }
    });
  }

  async deleteMessage(channelId, messageId) {
    return this.rest(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
  }

  async postCatastrophicApproval(actionLike) {
    const runtime = this.agentHost?.runtime;
    const action = runtime?.pendingActions?.get?.(actionLike?.id) ?? actionLike;
    const channelId = this.activityChannelFor(action?.context?.sessionId ?? actionLike?.sessionId);
    if (!action?.id || !channelId || this.approvalPrompts.has(action.id)) return null;

    const card = catastrophicApprovalEmbed(action);
    const components = approvalComponents(action.id);
    const message = await this.rest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: { embeds: [card], components }
    });
    const state = {
      actionId: action.id,
      channelId,
      messageId: message?.id ?? null,
      embed: card,
      components,
      resolved: false,
      timer: null
    };
    state.timer = setTimeout(() => {
      this.expireApprovalPrompt(action.id).catch((error) => {
        this.log({ op: "approval-expire-error", actionId: action.id, error: error.message });
      });
    }, APPROVAL_TIMEOUT_MS);
    state.timer.unref?.();
    this.approvalPrompts.set(action.id, state);
    return message;
  }

  async handlePendingApprovalInteraction(interaction) {
    const match = /^pa:(approve|deny|session):(.+)$/.exec(String(interaction?.data?.custom_id ?? ""));
    if (!match) return;
    const [, choice, actionId] = match;
    const runtime = this.agentHost?.runtime;
    const store = runtime?.pendingActions;
    const action = store?.get?.(actionId);
    const state = this.approvalPrompts.get(actionId) ?? promptStateFromInteraction(actionId, interaction);

    // Hermes checks resolved before auth, so stale double-clicks always get
    // the same answer and can never leak into a second execution path.
    if (!action || action.status !== "pending" || state.resolved) {
      return this.replyToInteraction(interaction, "This prompt has already been resolved~");
    }

    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? null;
    if (!this.isAuthorizedApprovalUser(userId)) {
      return this.replyToInteraction(interaction, "You're not authorized to answer this prompt~");
    }
    if (choice === "session" && !action.context?.sessionId) {
      return this.replyToInteraction(interaction, "This action has no session to allow.");
    }

    const displayName = approvalDisplayName(interaction);
    const label = choice === "deny" ? "Denied" : choice === "session" ? "Allowed for session" : "Approved once";
    const color = choice === "deny" ? COLORS.err : COLORS.ok;
    state.resolved = true;
    clearTimeout(state.timer);
    state.embed = resolvedApprovalEmbed(interaction.message?.embeds?.[0] ?? state.embed, color, `${label} by ${displayName}`);
    state.components = disableComponents(interaction.message?.components ?? state.components);
    this.approvalPrompts.set(actionId, state);

    // Type 6 acknowledges immediately without replacing the card. The webhook
    // edit that follows disables every button before any tool code can run.
    await this.rest(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: { type: 6 }
    });
    await this.editApprovalInteraction(interaction, state);

    if (choice === "deny") {
      store.decide(actionId, {
        decision: "deny",
        decidedBy: `discord:${userId}`,
        decider: userId,
        deciderDisplayName: displayName,
        error: "denied by user"
      });
      await this.sendMessage(state.channelId, `Denied \`${actionId}\` (**${action.toolName}**) by ${displayName}.`);
      return;
    }

    if (choice === "session") runtime.tools.allowForSession(action.context.sessionId, action.toolName);
    let invokeResult;
    try {
      invokeResult = await approvePendingAction(runtime, actionId, {
        decidedBy: `discord:${userId}`,
        approvedVia: "discord-button",
        decider: userId,
        deciderDisplayName: displayName
      });
    } catch (error) {
      invokeResult = { ok: false, error: error.message ?? String(error) };
    }
    const resultText = approvalResultText(action, invokeResult);
    state.embed = resolvedApprovalEmbed(state.embed, color, `${label} by ${displayName}`, resultText);
    await this.editApprovalInteraction(interaction, state);
    await this.sendMessage(state.channelId, resultText);
  }

  async expireApprovalPrompt(actionId) {
    const state = this.approvalPrompts.get(actionId);
    if (!state || state.resolved) return false;
    state.resolved = true;
    clearTimeout(state.timer);
    state.embed = resolvedApprovalEmbed(state.embed, EXPIRED_COLOR, "\u23f1 Prompt expired \u2014 no action taken");
    state.components = disableComponents(state.components);
    if (state.channelId && state.messageId) {
      await this.rest(`/channels/${state.channelId}/messages/${state.messageId}`, {
        method: "PATCH",
        body: { embeds: [state.embed], components: state.components }
      });
    }
    return true;
  }

  isAuthorizedApprovalUser(userId) {
    if (!userId) return false;
    // Re-read the owner env on every click. This is an authorization decision,
    // not a convenience cache, and must reflect a live operator correction.
    const allowed = new Set([...this.allowFrom, ...splitIds(process.env.DISCORD_OWNER_ID)]);
    return allowed.has(String(userId));
  }

  activityChannelFor(sessionId) {
    const match = /^discord:[^:]+:(\d+)(?::.+)?$/.exec(String(sessionId ?? ""));
    return match?.[1] ?? this.lastActiveChannel ?? this.activityChannel ?? null;
  }

  async replyToInteraction(interaction, content) {
    return this.rest(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: { type: 4, data: { content, flags: EPHEMERAL } }
    });
  }

  async editApprovalInteraction(interaction, state) {
    return this.rest(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      body: { embeds: [state.embed], components: state.components }
    });
  }

  // ── Activity feed: runtime bus → Discord home channel ─────────────
  // Mirrors Hermes's observability: proactive-observer suggestions, actions
  // awaiting approval, mined skill candidates, and self-updates land in the
  // configured channel so the Creator can SEE what Azazel is thinking of
  // doing — not just what he replies with.
  bindActivityFeed(events) {
    if (this.feedBound || !events?.on) return;
    this.feedBound = true;
    // Route each feed post to the channel the agent is actually WORKING in
    // (Hermes-style): prefer the event's own session channel (events carry
    // sessionId "discord:<guild>:<channel>[:<user>]" when a Discord turn
    // triggered them), then the channel of the most recent inbound message,
    // then the configured home channel as the static fallback.
    const post = (text, d = null) => {
      const chan = this.activityChannelFor(d?.sessionId);
      if (!chan) return;
      // Fire-and-forget: the feed must never break the runtime.
      this.sendMessage(chan, text).catch((error) => this.log({ op: "feed-error", error: error.message }));
    };
    events.on("proactive-suggestion", (d) => {
      post(`💡 **Observer suggestion** _(scrutiny-gated, nothing fired)_\n**${d.title ?? "(untitled)"}** · category: \`${d.category ?? "?"}\`\n${(d.rationale ?? "").slice(0, 400)}`);
    });
    events.on("pending-action", (d) => {
      if (d.severity === "catastrophic") {
        this.postCatastrophicApproval(d).catch((error) => {
          this.log({ op: "approval-card-error", actionId: d.id, error: error.message });
        });
        return;
      }
      // With auto-approve ON the action runs immediately after this event —
      // label it accordingly instead of asking the Creator to approve.
      import("./tool-registry.js").then(({ autoApproveEnabled }) => {
        if (autoApproveEnabled()) {
          post(`⚡ **Gated action (auto-approve ON)** — \`${d.id}\`\n**${d.toolName}** — ${d.summary ?? ""}${d.reason ? `\n_reason: ${d.reason}_` : ""}\n_Running automatically; result will follow._`, d);
        } else {
          post(`⏸️ **Action awaiting approval** — \`${d.id}\`\n**${d.toolName}** — ${d.summary ?? ""}${d.reason ? `\n_reason: ${d.reason}_` : ""}\nApprove with \`!approve ${d.id}\` · deny with \`!deny ${d.id}\``, d);
        }
      }).catch(() => {
        post(`⏸️ **Action awaiting approval** — \`${d.id}\`\n**${d.toolName}** — ${d.summary ?? ""}`, d);
      });
    });
    events.on("pending-action-decided", (d) => {
      // The button flow owns its result follow-up and same-message update.
      if (d.approvedVia === "discord-button") return;
      const emoji = d.status === "approved" ? (d.decidedBy === "auto-approve" ? "🤖✅" : "✅") : "⛔";
      const who = d.decidedBy === "auto-approve" ? "auto-approved" : `${d.status} by ${d.decidedBy}`;
      post(`${emoji} **Action ${who}** — \`${d.id}\` · **${d.toolName}**${d.error ? `\n⚠ error: ${String(d.error).slice(0, 300)}` : ""}`, d);
    });
    events.on("auto-approve", (d) => {
      post(d.enabled
        ? "🟢 **Auto-approve enabled** — gated actions now run without manual approval."
        : "🔴 **Auto-approve disabled** — gated actions will queue for manual approval.");
    });
    events.on("skill-candidate", (d) => {
      post(`🧪 **Skill candidate mined** — ${d.title ?? d.name ?? "(unnamed)"}\n${(d.rationale ?? d.description ?? "").slice(0, 300)}`);
    });
    events.on("background-review", (d) => {
      const details = [
        d.memoriesAdded ? `${d.memoriesAdded} durable memor${d.memoriesAdded === 1 ? "y" : "ies"}` : null,
        d.duplicatesSkipped ? `${d.duplicatesSkipped} duplicate${d.duplicatesSkipped === 1 ? "" : "s"} merged` : null,
        d.skillPending ? `skill proposal pending: **${d.skillTitle ?? "untitled"}**` : null
      ].filter(Boolean);
      if (details.length > 0) post(`🧠 **Background review** — ${details.join(" · ")}`, d);
    });
    events.on("suggestion-resolved", (d) => {
      post(`✅ Suggestion \`${d.id}\` resolved: **${d.status}**${d.category ? ` (${d.category})` : ""}`);
    });
    events.on("self-update", (d) => {
      post(`🔄 **Self-update** ${d.from ?? "?"} → ${d.to ?? "?"}`);
    });
    events.on("task-reminder", (d) => {
      post(`🗒️ **${d.title ?? "Task"}**${d.body ? `\n${String(d.body).slice(0, 200)}` : ""}`);
    });
    events.on("daily-recap", (d) => {
      if (d?.summary) post(`🌙 **Daily recap**\n${String(d.summary).slice(0, 1500)}`);
    });
    this.log({ op: "activity-feed-bound", channel: this.activityChannel ?? "(dynamic)", mode: "follow-session" });
  }

  async rest(pathname, { method = "GET", body } = {}) {
    for (let attempt = 1; attempt <= DISCORD_REST_MAX_ATTEMPTS; attempt += 1) {
      const response = await (this.restFetch ?? globalThis.fetch)(`${API}${pathname}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.status === 429) {
        const data = await response.json().catch(() => ({}));
        if (attempt >= DISCORD_REST_MAX_ATTEMPTS) {
          const error = new Error(`Discord ${method} ${pathname} remained rate limited after ${attempt} attempts`);
          error.status = 429;
          throw error;
        }
        const retryMs = Math.ceil(Math.max(0, Number(data.retry_after) || 1) * 1000);
        await (this.restSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          Math.min(DISCORD_RETRY_MAX_MS, retryMs)
        );
        continue;
      }
      if (response.status === 204) return null;
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json?.message ?? `Discord ${method} ${pathname} failed with ${response.status}`);
      return json;
    }
    return null;
  }
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Vision plumbing: pull image attachments off an inbound Discord message and
// download them as base64 so a vision-capable model can actually see them.
// Discord serves attachments from cdn.discordapp.com; we cap size + count to
// keep the request sane and skip anything that isn't a supported image type.
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image
const MAX_IMAGES = 4;

async function fetchDiscordImages(message, log) {
  const atts = Array.isArray(message?.attachments) ? message.attachments : [];
  const candidates = atts.filter((a) => {
    const ct = String(a?.content_type ?? "").split(";")[0].trim().toLowerCase();
    if (SUPPORTED_IMAGE_TYPES.has(ct)) return true;
    // Some clients omit content_type — fall back to extension sniffing.
    return /\.(png|jpe?g|webp|gif)$/i.test(String(a?.filename ?? ""));
  }).slice(0, MAX_IMAGES);
  const out = [];
  for (const a of candidates) {
    try {
      if (a.size && a.size > MAX_IMAGE_BYTES) {
        log?.({ op: "image-skip-large", filename: a.filename, size: a.size });
        continue;
      }
      // Bound the CDN download so a stalled fetch can't hang the whole turn.
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      let res;
      try {
        res = await fetch(a.url, { signal: ctrl.signal });
      } finally {
        clearTimeout(to);
      }
      if (!res.ok) { log?.({ op: "image-fetch-failed", filename: a.filename, status: res.status }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) { log?.({ op: "image-skip-large", filename: a.filename, size: buf.length }); continue; }
      let mediaType = String(a?.content_type ?? "").split(";")[0].trim().toLowerCase();
      if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        const ext = (String(a?.filename ?? "").match(/\.([a-z0-9]+)$/i)?.[1] ?? "png").toLowerCase();
        mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      }
      out.push({ mediaType, data: buf.toString("base64"), filename: a.filename ?? "image", bytes: buf.length });
    } catch (err) {
      log?.({ op: "image-fetch-error", filename: a?.filename, error: err?.message ?? String(err) });
    }
  }
  return out;
}


function isPendingApprovalInteraction(interaction) {
  return interaction?.type === 3 && /^pa:(?:approve|deny|session):/.test(String(interaction?.data?.custom_id ?? ""));
}

function approvalComponents(actionId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Approve Once", custom_id: `pa:approve:${actionId}` },
      { type: 2, style: 2, label: "Allow for session", custom_id: `pa:session:${actionId}` },
      { type: 2, style: 4, label: "Deny", custom_id: `pa:deny:${actionId}` }
    ]
  }];
}

function disableComponents(rows = []) {
  return rows.map((row) => ({
    ...row,
    components: (row.components ?? []).map((button) => ({ ...button, disabled: true }))
  }));
}

function catastrophicApprovalEmbed(action) {
  const args = JSON.stringify(action.args ?? {}, null, 2);
  return embed({
    title: "Catastrophic action requires approval",
    color: COLORS.warn,
    fields: [
      { name: "Tool", value: `\`${action.toolName}\``, inline: true },
      { name: "Action", value: action.summary ?? `Run ${action.toolName}` },
      { name: "Why this is gated", value: action.reason ?? "Catastrophic policy match" },
      { name: "Arguments", value: `\`\`\`json\n${args.slice(0, 990)}\n\`\`\`` }
    ],
    footer: "Only an authorized user can decide - expires in 10 minutes"
  });
}

function promptStateFromInteraction(actionId, interaction) {
  return {
    actionId,
    channelId: interaction.channel_id ?? interaction.message?.channel_id ?? null,
    messageId: interaction.message?.id ?? null,
    embed: interaction.message?.embeds?.[0] ?? {},
    components: interaction.message?.components ?? [],
    resolved: false,
    timer: null
  };
}

function resolvedApprovalEmbed(source = {}, color, footer, resultText = null) {
  const fields = [...(source.fields ?? [])].filter((field) => field.name !== "Result");
  if (resultText) fields.push({ name: "Result", value: String(resultText).slice(0, 1024), inline: false });
  return { ...source, color, footer: { text: footer }, fields };
}

function approvalDisplayName(interaction) {
  const user = interaction.member?.user ?? interaction.user ?? {};
  return String(interaction.member?.nick ?? user.global_name ?? user.username ?? user.id ?? "user").slice(0, 100);
}

function approvalResultText(action, result) {
  if (!result?.ok) return `Action \`${action.id}\` (**${action.toolName}**) failed: ${result?.error ?? "unknown error"}`;
  const value = result.result ?? {};
  const exitCode = value.exitCode ?? value.exit_code;
  const stdout = String(value.stdout ?? value.output ?? "").slice(-1200).trim();
  const lines = [`Action \`${action.id}\` (**${action.toolName}**) completed.`];
  if (exitCode != null) lines.push(`exitCode: ${exitCode}`);
  if (stdout) lines.push(`stdout tail:\n\`\`\`\n${stdout.replace(/\`\`\`/g, "'''" )}\n\`\`\``);
  if (exitCode == null && !stdout) lines.push(String(JSON.stringify(value)).slice(0, 1200));
  return lines.join("\n").slice(0, 1900);
}

export function chunkText(text, size = 1990) {
  if (text.length <= size) return [text];
  if (!Number.isInteger(size) || size < 16) throw new Error("Discord chunk size must be an integer of at least 16.");
  const chunks = [];
  let rest = text;
  let carriedFence = null;
  while (rest.length > 0) {
    const prefix = carriedFence ? `${carriedFence.opener}\n` : "";
    let limit = Math.max(1, size - prefix.length);
    let cut = preferredChunkCut(rest, limit);
    let payload = rest.slice(0, cut);
    let nextFence = scanFenceState(payload, carriedFence);
    let suffix = nextFence ? `\n${nextFence.marker}` : "";

    // Closing an open fence consumes part of Discord's limit. Re-select the
    // natural boundary with that overhead included instead of truncating the
    // close marker or emitting an oversized chunk.
    while (prefix.length + payload.length + suffix.length > size) {
      limit = Math.max(1, size - prefix.length - suffix.length);
      cut = preferredChunkCut(rest, Math.min(limit, cut - 1));
      payload = rest.slice(0, cut);
      nextFence = scanFenceState(payload, carriedFence);
      suffix = nextFence ? `\n${nextFence.marker}` : "";
    }

    chunks.push(`${prefix}${payload}${suffix}`);
    rest = rest.slice(cut);
    carriedFence = nextFence;
  }
  return chunks;
}

function preferredChunkCut(text, limit) {
  if (text.length <= limit) return text.length;
  const paragraph = text.lastIndexOf("\n\n", limit);
  if (paragraph >= Math.floor(limit * 0.35)) return paragraph + 2;
  const line = text.lastIndexOf("\n", limit);
  if (line >= Math.floor(limit * 0.35)) return line + 1;
  const whitespace = Math.max(text.lastIndexOf(" ", limit), text.lastIndexOf("\t", limit));
  if (whitespace >= Math.floor(limit * 0.6)) return whitespace + 1;
  return limit;
}

function scanFenceState(text, initialFence = null) {
  let state = initialFence;
  const fenceLine = /^(?: {0,3})(`{3,})([^\r\n]*)/gmu;
  for (const match of text.matchAll(fenceLine)) {
    const marker = match[1];
    const info = match[2].trim();
    if (!state) {
      // Discord language hints are tiny; bounding a malformed multi-kilobyte
      // hint guarantees a continuation prefix can never consume a whole part.
      state = { marker, opener: `${marker}${info.slice(0, 64)}` };
    } else if (!info && marker.length >= state.marker.length) {
      state = null;
    }
  }
  return state;
}

const STREAM_MESSAGE_CHARS = 1990;
const STREAM_EDIT_MIN_MS = 1200;

function streamChunks(text) {
  return chunkText(text, STREAM_MESSAGE_CHARS);
}

// A streaming reply is one append-only text buffer rendered through a small
// REST queue. The queue prevents out-of-order PATCHes, and fixed-size slices
// make overflow deterministic: once a slice reaches Discord's limit, the next
// token starts a new message instead of rewriting or losing earlier prose.
export class DiscordReplyStream {
  constructor(channel, channelId, replyToId, enabled, options = {}) {
    this.channel = channel;
    this.channelId = channelId;
    this.replyToId = replyToId;
    this.enabled = Boolean(enabled);
    this.editMinMs = options.editMinMs ?? STREAM_EDIT_MIN_MS;
    this.text = "";
    this.messages = [];
    this.dirty = false;
    this.closed = false;
    this.finishing = false;
    this.timer = null;
    this.lastFlushAt = 0;
    this.flushQueued = false;
    this.queue = Promise.resolve();
    this.error = null;
  }

  onDelta(chunk) {
    if (!this.enabled || this.closed || this.finishing) return;
    const text = String(chunk ?? "");
    if (!text) return;
    this.text += text;
    this.dirty = true;
    this.schedule();
  }

  schedule() {
    if (this.timer || this.flushQueued || this.closed || this.finishing) return;
    const wait = this.messages.length === 0
      ? 0
      : Math.max(0, this.editMinMs - (Date.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.queueFlush();
    }, wait);
  }

  queueFlush() {
    if (this.flushQueued) return this.queue;
    this.flushQueued = true;
    const run = this.queue.then(() => this.flushSnapshot());
    this.queue = run
      .catch((error) => {
        this.error = error;
        this.channel.log?.({ op: "reply-stream-error", error: error?.message ?? String(error) });
      })
      .finally(() => {
        this.flushQueued = false;
        if (this.dirty && !this.closed && !this.finishing) this.schedule();
      });
    return this.queue;
  }

  async flushSnapshot() {
    if (!this.dirty) return;
    const desired = streamChunks(this.text);
    this.dirty = false;

    for (let i = 0; i < desired.length; i += 1) {
      const content = desired[i];
      const current = this.messages[i];
      if (!current) {
        const sent = await this.channel.sendMessage(
          this.channelId,
          content,
          i === 0 ? this.replyToId : null
        );
        if (!sent?.id) throw new Error("Discord streaming message did not return an id.");
        this.messages[i] = { id: sent.id, content };
      } else if (current.content !== content) {
        await this.channel.editMessage(this.channelId, current.id, content);
        current.content = content;
      }
    }

    while (this.messages.length > desired.length) {
      const stale = this.messages.pop();
      await this.channel.deleteMessage(this.channelId, stale.id).catch(() => {});
    }
    this.lastFlushAt = Date.now();
  }

  async finish(finalText) {
    if (!this.enabled) return false;
    this.finishing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const final = String(finalText ?? "");
    if (final && final !== this.text) {
      this.text = final;
      this.dirty = true;
    }
    await this.queue;
    if (this.dirty) await this.queueFlush();
    await this.queue;
    this.closed = true;
    return this.messages.length > 0 && !this.error;
  }

  async stop() {
    this.finishing = true;
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queue;
  }
}

// ── Live status message ──────────────────────────────────────────────
// Hermes-style "what am I doing right now" render: one message posted at
// turn start and EDITED as scrutiny verdicts land and tools run, so the
// channel shows a live activity trace instead of 30s of silent typing.
// Edits are throttled to 1/1.5s to stay far inside Discord's PATCH limits;
// the final state (✅ done + tool trace) is left in place as a compact
// audit line above the actual reply.
const VERDICT_EMOJI = { act: "⚡", ask: "❓", watch: "👁️", ignore: "💤", propagate: "🧬" };
const VERDICT_COLOR = { act: COLORS.ok, ask: COLORS.warn, watch: COLORS.info, ignore: 0x95a5a6, propagate: COLORS.think };
const STATUS_EDIT_MIN_MS = 1500;
// Heavy turns (≥ this many tool calls) spawn a thread and stream the trace
// there so the channel stays clean. Env: DISCORD_THREAD_TASKS=0 disables.
const THREAD_AFTER_STEPS = 6;

export class LiveStatus {
  constructor(channel, channelId, enabled) {
    this.channel = channel;
    this.channelId = channelId;
    this.enabled = enabled;
    this.messageId = null;
    this.verdict = null;
    this.iteration = null;
    this.subagent = null;
    this.steps = [];        // { name, state: run|ok|err|pend }
    this.startedAt = Date.now();
    this.lastEditAt = 0;
    this.editTimer = null;
    this.done = false;
    this.threadId = null;   // spawned for heavy turns
    this.threadTried = false;
    this.taskLabel = null;
  }

  async begin(replyToId, taskLabel = null) {
    if (!this.enabled) return;
    this.taskLabel = taskLabel;
    try {
      const msg = await this.channel.sendEmbed(this.channelId, embed({
        description: "🧠 *thinking…*",
        color: COLORS.think,
        timestamp: false
      }), replyToId);
      this.messageId = msg?.id ?? null;
    } catch { this.messageId = null; }
    // Presence mirrors the actual task, Hermes-style: "Watching <task…>"
    // so the member list itself shows what he's working on right now.
    this.channel.setPresence?.(this.taskLabel ? `⚙️ ${this.taskLabel.slice(0, 100)}` : "the problem", 3);
    // Keep the animated status card ticking even between tool events so the
    // spinner + elapsed clock feel alive (Discord-side visual only).
    this.tickTimer = setInterval(() => { if (!this.done) this.scheduleEdit(); }, 4000);
  }

  onEvent(ev) {
    if (!this.enabled || !this.messageId || this.done) return;
    if (ev.phase === "iteration") {
      this.iteration = { n: ev.n, max: ev.max };
    } else if (ev.phase === "subagent") {
      this.subagent = ev;
    } else if (ev.phase === "verdict") {
      this.verdict = ev;
    } else if (ev.phase === "start") {
      this.steps.push({ name: ev.name, state: "run", args: summarizeArgs(ev.args), t: Date.now() });
      this.maybeSpawnThread();
    } else if (ev.phase === "awaiting-approval") {
      for (let i = this.steps.length - 1; i >= 0; i -= 1) {
        if (this.steps[i].name === ev.toolName && this.steps[i].state === "run") {
          this.steps[i].state = "pend";
          this.steps[i].actionId = ev.actionId;
          break;
        }
      }
    } else if (ev.phase === "end") {
      // Mark the most recent running step with this name.
      for (let i = this.steps.length - 1; i >= 0; i -= 1) {
        if (this.steps[i].name === ev.name && this.steps[i].state === "run") {
          this.steps[i].state = ev.pending ? "pend" : ev.ok ? "ok" : "err";
          this.steps[i].ms = Date.now() - this.steps[i].t;
          if (!ev.ok && ev.error) this.steps[i].error = String(ev.error).slice(0, 120);
          break;
        }
      }
    }
    this.scheduleEdit();
  }

  // Heavy turn → spawn a thread off the status message; the trace continues
  // there and the channel keeps a single compact card.
  maybeSpawnThread() {
    if (this.threadTried || this.threadId || this.steps.length < THREAD_AFTER_STEPS) return;
    if ((process.env.DISCORD_THREAD_TASKS ?? "1") === "0") return;
    this.threadTried = true;
    const name = `⚙️ ${this.taskLabel ?? "task"} · ${new Date().toISOString().slice(11, 16)}`;
    this.channel.createThread(this.channelId, this.messageId, name)
      .then((thread) => { this.threadId = thread?.id ?? null; })
      .catch(() => {});
  }

  // ANSI step ladder rendered inside the embed description — Discord shows
  // real terminal colors in ```ansi blocks.
  renderAnsi(limit = 8) {
    const rows = [];
    for (const s of this.steps.slice(-limit)) {
      const icon = s.state === "run" ? `${ANSI.yellow}⋯` : s.state === "ok" ? `${ANSI.green}✔` : s.state === "pend" ? `${ANSI.magenta}⏸` : `${ANSI.red}✘`;
      const dur = s.ms != null ? ` ${ANSI.gray}${(s.ms / 1000).toFixed(1)}s` : "";
      const args = s.args ? ` ${ANSI.cyan}${s.args.replace(/_/g, "")}` : "";
      const err = s.error ? ` ${ANSI.red}${s.error}` : "";
      rows.push(`${icon} ${ANSI.bold}${ANSI.white}${s.name}${ANSI.reset}${args}${dur}${err}${ANSI.reset}`);
    }
    return "```ansi\n" + rows.join("\n").slice(0, 3500) + "\n```";
  }

  renderEmbed(suffix = null) {
    const v = this.verdict;
    const spinner = ["◜", "◠", "◝", "◞", "◡", "◟"][Math.floor(Date.now() / 500) % 6];
    const elapsed = ((Date.now() - this.startedAt) / 1000);
    const clock = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${Math.round(elapsed % 60)}s` : `${elapsed.toFixed(0)}s`;
    const head = v
      ? `${VERDICT_EMOJI[v.action] ?? "🧠"} scrutiny: **${v.action}** (${(v.score ?? 0).toFixed(2)})`
      : `${this.done ? "🧠" : spinner} *thinking…*`;
    const iteration = this.iteration ? ` · iteration ${this.iteration.n}/${this.iteration.max}` : "";
    const delegation = this.subagent
      ? ` · delegating ${this.subagent.n}/${this.subagent.total}${this.subagent.state === "running" && this.subagent.iteration ? ` (iteration ${this.subagent.iteration}/${this.subagent.maxIterations})` : ""}`
      : "";
    const clockPart = this.done ? "" : ` · ⏱ ${clock}`;
    const doneCount = this.steps.filter((s) => s.state !== "run").length;
    const total = this.steps.length;
    const progress = total > 0 ? `\n${"▰".repeat(Math.round((doneCount / total) * 10))}${"▱".repeat(10 - Math.round((doneCount / total) * 10))} ${doneCount}/${total}` : "";
    // Spotlight: the tool currently executing, bolded above the ladder.
    const running = this.steps.findLast?.((s) => s.state === "run") ?? [...this.steps].reverse().find((s) => s.state === "run");
    const spotlight = !this.done && running ? `\n${spinner} **${running.name}**${running.args ? ` · ${running.args}` : ""}` : "";
    const label = this.taskLabel ? `📌 \`${this.taskLabel.slice(0, 80)}\`\n` : "";
    const parts = [label + head + iteration + delegation + clockPart + spotlight + progress];
    if (total > 0) parts.push(this.renderAnsi());
    if (this.threadId) parts.push(`🧵 full trace: <#${this.threadId}>`);
    if (suffix) parts.push(suffix);
    return embed({
      description: parts.join("\n").slice(0, 4000),
      color: this.done ? (this.steps.some((s) => s.state === "err") ? COLORS.err : COLORS.ok) : (VERDICT_COLOR[v?.action] ?? COLORS.think),
      timestamp: false
    });
  }

  async pushEdit(suffix = null) {
    const body = { content: "", embeds: [this.renderEmbed(suffix)] };
    await this.channel.rest(`/channels/${this.channelId}/messages/${this.messageId}`, { method: "PATCH", body });
    // Mirror the latest trace into the task thread, if one exists.
    if (this.threadId && this.steps.length > 0) {
      const last = this.steps[this.steps.length - 1];
      if (last && last !== this._lastThreadStep && last.state !== "run") {
        this._lastThreadStep = last;
        const icon = last.state === "ok" ? "✅" : last.state === "pend" ? "⏸️" : "❌";
        this.channel.sendMessage(this.threadId, `${icon} \`${last.name}\`${last.args ? ` ${last.args}` : ""}${last.ms != null ? ` · ${(last.ms / 1000).toFixed(1)}s` : ""}${last.error ? `\n> ${last.error}` : ""}`).catch(() => {});
      }
    }
  }

  scheduleEdit() {
    if (this.editTimer || this.done) return;
    const wait = Math.max(0, STATUS_EDIT_MIN_MS - (Date.now() - this.lastEditAt));
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      if (this.done || !this.messageId) return;
      this.lastEditAt = Date.now();
      this.pushEdit().catch(() => {});
    }, wait);
  }

  async finish(result) {
    this.done = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.channel.refreshIdlePresence?.();
    if (!this.enabled || !this.messageId) return;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const stopReason = result?.model?.stopReason;
    // No verdict + no tools = trivial turn; delete the status to keep the
    // channel clean rather than leave a stale "thinking…" line.
    if (this.steps.length === 0 && (!stopReason || stopReason === "completed")) {
      await this.channel.deleteMessage(this.channelId, this.messageId).catch(() => {});
      return;
    }
    const toolCount = this.steps.length;
    const stopped = stopReason && stopReason !== "completed"
      ? ` · stopped: **${stopReason}**`
      : "";
    await this.pushEdit(`— done in **${secs}s** · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${result?.model?.model ? ` · \`${result.model.model}\`` : ""}${stopped}`).catch(() => {});
    if (this.threadId) {
      this.channel.sendMessage(this.threadId, `🏁 done in ${secs}s · ${toolCount} tool calls`).catch(() => {});
    }
  }

  async fail(error) {
    this.done = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.channel.refreshIdlePresence?.();
    if (!this.enabled || !this.messageId) return;
    await this.pushEdit(`❌ **turn failed:** ${String(error?.message ?? error).slice(0, 200)}`).catch(() => {});
  }
}

// Compact, redaction-safe one-line arg preview: first string-ish value only.
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["query", "content", "prompt", "title", "name", "path", "url", "text"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return `_${v.trim().slice(0, 60).replace(/\n/g, " ")}${v.length > 60 ? "…" : ""}_`;
  }
  return "";
}

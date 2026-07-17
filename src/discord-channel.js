// Discord channel for OpenAGI — gateway (WSS) inbound + REST outbound.
// Zero-dependency: uses Node's native WebSocket (Node >= 22) and fetch.
//
// Config (env or options):
//   DISCORD_BOT_TOKEN     — bot token (required to enable)
//   DISCORD_ALLOW_FROM    — comma-separated user ids allowed to DM the agent
//   DISCORD_GUILDS        — comma-separated guild ids to serve (empty = all)
//   DISCORD_REQUIRE_MENTION — "1" (default) only reply in guilds when pinged
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

const API = "https://discord.com/api/v10";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export class DiscordChannel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
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
    this.busy = Promise.resolve(); // serialize agent turns
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
      return;
    }
    if (t === "RESUMED") { this.log({ op: "resumed" }); return; }
    if (t === "INTERACTION_CREATE") { await this.commands.handle(d); return; }
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
    if (!text) return;

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
      .trim() || text;

    this.log({ op: "inbound", from: message.author?.id, channel: message.channel_id, guild: message.guild_id ?? null, len: text.length });

    // Approvals from Discord: "!approve <id>" / "!deny <id>" from an
    // allowFrom user decides a pending action without opening the dashboard.
    if (this.allowFrom.includes(message.author?.id)) {
      const cmd = /^!(approve|deny|pending)\b\s*(\S+)?/i.exec(cleaned);
      if (cmd) {
        await this.handleApprovalCommand(message, cmd[1].toLowerCase(), cmd[2] ?? null);
        return;
      }
    }

    // Serialize turns so parallel pings don't interleave sessions.
    this.busy = this.busy.then(() => this.runTurn(message, cleaned)).catch(() => {});
    await this.busy;
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
    // approve → re-invoke the original handler with the confirmation bypass.
    const r = await runtime.tools.invoke(action.toolName, action.args, { ...(action.context ?? {}), __confirmed: true });
    store.decide(id, { decision: "approve", decidedBy: `discord:${message.author?.id}`, result: r.ok ? r.result : null, error: r.ok ? null : r.error });
    const tail = r.ok ? "✅ executed" : `❌ failed: ${r.error}`;
    await this.sendMessage(message.channel_id, `👍 Approved \`${id}\` (**${action.toolName}**) — ${tail}`, message.id);
  }

  async runTurn(message, text) {
    let typingTimer = null;
    const status = new LiveStatus(this, message.channel_id, this.liveStatus);
    try {
      await this.rest(`/channels/${message.channel_id}/typing`, { method: "POST" }).catch(() => {});
      typingTimer = setInterval(() => {
        this.rest(`/channels/${message.channel_id}/typing`, { method: "POST" }).catch(() => {});
      }, 8000);
      await status.begin(message.id);
      const authorName = message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? "user";
      const result = await this.agentHost.handleMessage({
        channel: "discord",
        from: message.author?.id ?? "unknown",
        agentId: "main",
        sessionId: `discord:${message.guild_id ?? "dm"}:${message.channel_id}`,
        text: message.guild_id ? `[${authorName}] ${text}` : text,
        onToolEvent: (ev) => status.onEvent(ev),
        metadata: {
          discordMessageId: message.id,
          channelId: message.channel_id,
          guildId: message.guild_id ?? null,
          username: message.author?.username
        }
      });
      await status.finish(result);
      if (result?.reply) await this.sendMessage(message.channel_id, result.reply, message.id);
    } catch (error) {
      this.log({ op: "turn-error", error: error.message });
      await status.fail(error).catch(() => {});
      await this.sendMessage(message.channel_id, `⚠ ${error.message}`.slice(0, 500), message.id).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  }

  async sendMessage(channelId, text, replyToId = null) {
    const chunks = chunkText(String(text), 1990);
    let last = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const body = { content: chunks[i] };
      if (i === 0 && replyToId) body.message_reference = { message_id: replyToId, fail_if_not_exists: false };
      last = await this.rest(`/channels/${channelId}/messages`, { method: "POST", body });
    }
    return last;
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

  // ── Activity feed: runtime bus → Discord home channel ─────────────
  // Mirrors Hermes's observability: proactive-observer suggestions, actions
  // awaiting approval, mined skill candidates, and self-updates land in the
  // configured channel so the Creator can SEE what Azazel is thinking of
  // doing — not just what he replies with.
  bindActivityFeed(events) {
    if (this.feedBound || !events?.on || !this.activityChannel) return;
    this.feedBound = true;
    const chan = this.activityChannel;
    const post = (text) => {
      // Fire-and-forget: the feed must never break the runtime.
      this.sendMessage(chan, text).catch((error) => this.log({ op: "feed-error", error: error.message }));
    };
    events.on("proactive-suggestion", (d) => {
      post(`💡 **Observer suggestion** _(scrutiny-gated, nothing fired)_\n**${d.title ?? "(untitled)"}** · category: \`${d.category ?? "?"}\`\n${(d.rationale ?? "").slice(0, 400)}`);
    });
    events.on("pending-action", (d) => {
      post(`⏸️ **Action awaiting approval** — \`${d.id}\`\n**${d.toolName}** — ${d.summary ?? ""}${d.reason ? `\n_reason: ${d.reason}_` : ""}\nApprove with \`!approve ${d.id}\` · deny with \`!deny ${d.id}\``);
    });
    events.on("skill-candidate", (d) => {
      post(`🧪 **Skill candidate mined** — ${d.title ?? d.name ?? "(unnamed)"}\n${(d.rationale ?? d.description ?? "").slice(0, 300)}`);
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
    this.log({ op: "activity-feed-bound", channel: chan });
  }

  async rest(pathname, { method = "GET", body } = {}) {
    const response = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const wait = Math.ceil((data.retry_after ?? 1) * 1000);
      await new Promise((r) => setTimeout(r, wait));
      return this.rest(pathname, { method, body });
    }
    if (response.status === 204) return null;
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.message ?? `Discord ${method} ${pathname} failed with ${response.status}`);
    return json;
  }
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function chunkText(text, size) {
  if (text.length <= size) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    let cut = rest.length <= size ? rest.length : rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return chunks;
}

// ── Live status message ──────────────────────────────────────────────
// Hermes-style "what am I doing right now" render: one message posted at
// turn start and EDITED as scrutiny verdicts land and tools run, so the
// channel shows a live activity trace instead of 30s of silent typing.
// Edits are throttled to 1/1.5s to stay far inside Discord's PATCH limits;
// the final state (✅ done + tool trace) is left in place as a compact
// audit line above the actual reply.
const VERDICT_EMOJI = { act: "⚡", ask: "❓", watch: "👁️", ignore: "💤", propagate: "🧬" };
const STATUS_EDIT_MIN_MS = 1500;

class LiveStatus {
  constructor(channel, channelId, enabled) {
    this.channel = channel;
    this.channelId = channelId;
    this.enabled = enabled;
    this.messageId = null;
    this.verdict = null;
    this.steps = [];        // { name, state: run|ok|err|pend }
    this.startedAt = Date.now();
    this.lastEditAt = 0;
    this.editTimer = null;
    this.done = false;
  }

  async begin(replyToId) {
    if (!this.enabled) return;
    try {
      const msg = await this.channel.sendMessage(this.channelId, "🧠 *thinking…*", replyToId);
      this.messageId = msg?.id ?? null;
    } catch { this.messageId = null; }
  }

  onEvent(ev) {
    if (!this.enabled || !this.messageId || this.done) return;
    if (ev.phase === "verdict") {
      this.verdict = ev;
    } else if (ev.phase === "start") {
      this.steps.push({ name: ev.name, state: "run", args: summarizeArgs(ev.args) });
    } else if (ev.phase === "end") {
      // Mark the most recent running step with this name.
      for (let i = this.steps.length - 1; i >= 0; i -= 1) {
        if (this.steps[i].name === ev.name && this.steps[i].state === "run") {
          this.steps[i].state = ev.pending ? "pend" : ev.ok ? "ok" : "err";
          if (!ev.ok && ev.error) this.steps[i].error = String(ev.error).slice(0, 120);
          break;
        }
      }
    }
    this.scheduleEdit();
  }

  render(suffix = null) {
    const lines = [];
    const v = this.verdict;
    const head = v
      ? `${VERDICT_EMOJI[v.action] ?? "🧠"} scrutiny: **${v.action}** (${(v.score ?? 0).toFixed(2)})`
      : "🧠 *thinking…*";
    lines.push(head);
    for (const s of this.steps.slice(-8)) {
      const icon = s.state === "run" ? "🔄" : s.state === "ok" ? "✅" : s.state === "pend" ? "⏸️" : "❌";
      lines.push(`${icon} \`${s.name}\`${s.args ? ` ${s.args}` : ""}${s.error ? ` — ${s.error}` : ""}`);
    }
    if (suffix) lines.push(suffix);
    return lines.join("\n").slice(0, 1900);
  }

  scheduleEdit() {
    if (this.editTimer || this.done) return;
    const wait = Math.max(0, STATUS_EDIT_MIN_MS - (Date.now() - this.lastEditAt));
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      if (this.done || !this.messageId) return;
      this.lastEditAt = Date.now();
      this.channel.editMessage(this.channelId, this.messageId, this.render()).catch(() => {});
    }, wait);
  }

  async finish(result) {
    this.done = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    if (!this.enabled || !this.messageId) return;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    // No verdict + no tools = trivial turn; delete the status to keep the
    // channel clean rather than leave a stale "thinking…" line.
    if (this.steps.length === 0) {
      await this.channel.deleteMessage(this.channelId, this.messageId).catch(() => {});
      return;
    }
    const toolCount = this.steps.length;
    await this.channel.editMessage(
      this.channelId, this.messageId,
      this.render(`— done in ${secs}s · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${result?.model?.model ? ` · ${result.model.model}` : ""}`)
    ).catch(() => {});
  }

  async fail(error) {
    this.done = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
    if (!this.enabled || !this.messageId) return;
    await this.channel.editMessage(this.channelId, this.messageId, this.render(`❌ turn failed: ${String(error?.message ?? error).slice(0, 200)}`)).catch(() => {});
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

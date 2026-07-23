import { createHash } from "node:crypto";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
import { TelegramPairing } from "./telegram-pairing.js";
import { DiscordChannel } from "./discord-channel.js";
import { scanDeliverables, stripDeliveredPaths } from "./deliverable.js";
import { redactKnownValues } from "./redact.js";
import { secretRedactionSpellings } from "./credential-redaction.js";

export class ChannelManager {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.runtime = options.runtime ?? options.agentHost?.runtime;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels");
    ensureDir(this.dir);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    const testMode = process.env.OPENAGI_TEST === "1";
    this.telegram = new TelegramChannel({
      agentHost: this.agentHost,
      dir: path.join(this.dir, "telegram"),
      token: testMode ? null : (options.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN)
    });
    this.discord = new DiscordChannel({
      agentHost: this.agentHost,
      dir: path.join(this.dir, "discord"),
      token: testMode ? null : (options.discordToken ?? process.env.DISCORD_BOT_TOKEN)
    });
    if (this.runtime) this.runtime.channels = this;
  }

  async handleLocalMessage(body) {
    return this.agentHost.handleMessage({
      channel: body.channel ?? "local",
      from: body.from ?? "user",
      agentId: body.agentId ?? "main",
      sessionId: body.sessionId,
      text: body.text ?? body.message,
      images: Array.isArray(body.images) ? body.images : [],
      metadata: body.metadata ?? {},
      // Ephemeral turns (setup-wizard test message) leave no trace: no
      // session, no memory write, no outcome — just a model round-trip.
      ephemeral: body.ephemeral === true
    });
  }

  async handleTelegramWebhook(update) {
    return this.telegram.handleUpdate(update);
  }

  async deliver({ channel, target, text, sessionId = null, refId = null }) {
    if (!channel || !text) throw new Error("deliver requires channel and text");
    appendJsonLine(this.eventsPath, { at: nowIso(), op: "deliver", channel, target, text: String(text).slice(0, 400) });
    let result;
    if (channel === "telegram") result = await this.telegram.deliverAgentReply(target, text);
    else if (channel === "discord") result = await this.discord.deliverAgentReply(target, text);
    else if (channel === "local" || channel === "cron") {
      result = { delivered: false, reason: `channel ${channel} has no outbound transport (read from /sessions or stream /events)` };
    } else {
      throw new Error(`Unknown channel: ${channel}`);
    }
    this.runtime?.outcomes?.record({
      kind: "sent-message",
      refId,
      sessionId,
      channel,
      metadata: { target, length: String(text).length, result }
    });
    return result;
  }

  start() {
    if (process.env.TELEGRAM_POLLING === "1") {
      this.telegram.startPolling();
    }
    this.discord.start();
  }

  stop() {
    this.telegram.stopPolling();
    this.discord.stop();
  }

  status() {
    return {
      local: { enabled: true, mode: "http+sse" },
      telegram: this.telegram.status(),
      discord: this.discord.status()
    };
  }
}

export class TelegramChannel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.token = options.token;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels", "telegram");
    this.statePath = path.join(this.dir, "state.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.pollTimer = null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.deliverableOptions = options.deliverableOptions ?? {};
    ensureDir(this.dir);
    this.state = readJsonFile(this.statePath, { offset: 0 });
    // Pairing security: only chats that completed "/pair <code>" may talk to
    // the agent or receive outreach. Injectable for tests.
    this.pairing = options.pairing ?? new TelegramPairing({ dir: this.dir });
  }

  status() {
    return {
      configured: Boolean(this.token),
      polling: Boolean(this.pollTimer),
      offset: this.state.offset ?? 0,
      pairing: this.pairing.status()
    };
  }

  async handleUpdate(update) {
    appendJsonLine(this.eventsPath, { at: nowIso(), update });
    const message = update.message ?? update.edited_message;
    const text = message?.text ?? message?.caption;
    const chatId = message?.chat?.id;
    if (!text || !chatId) return { ignored: true };

    // Pairing handshake: "/pair 123456" from any chat. On success the chat id
    // is persisted to allowlist.json and confirmed; failures are logged but
    // NEVER replied to, so a probing stranger learns nothing.
    const pairMatch = /^\/pair\s+(\d{6})\s*$/.exec(text.trim());
    if (pairMatch) {
      const outcome = this.pairing.attempt(String(chatId), pairMatch[1]);
      appendJsonLine(this.eventsPath, {
        at: nowIso(),
        op: "pair-attempt",
        chatId: String(chatId),
        ok: outcome.ok,
        reason: outcome.reason ?? null
      });
      if (outcome.ok && this.token) {
        await this.sendMessage(chatId, "Paired. This chat now receives OpenAGI messages.");
      }
      return { paired: outcome.ok, reason: outcome.reason ?? null };
    }

    // Allowlist gate: every non-/pair message from an unpaired chat is
    // dropped silently — no agent turn, no reply (replying would confirm the
    // bot is live to whoever found it).
    if (!this.pairing.isAllowed(String(chatId))) {
      appendJsonLine(this.eventsPath, { at: nowIso(), op: "ignored-unpaired", chatId: String(chatId) });
      return { ignored: true, reason: "not-allowlisted" };
    }

    const result = await this.agentHost.handleMessage({
      channel: "telegram",
      from: String(chatId),
      agentId: "main",
      text,
      metadata: {
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        username: message.from?.username,
        firstName: message.from?.first_name
      }
    });

    if (this.token) {
      await this.deliverAgentReply(chatId, result.reply);
    }

    return result;
  }

  async sendMessage(chatId, text) {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    const response = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 3900)
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.description ?? `Telegram send failed with ${response.status}`);
    }
    return body;
  }

  async deliverAgentReply(chatId, text) {
    const original = String(text ?? "");
    let candidates = [];
    try {
      candidates = await scanDeliverables(original, this.deliverableOptions);
      if (!Array.isArray(candidates)) candidates = [];
    } catch (error) {
      this.logDeliverableFailure("scan", null, error);
    }

    const successfulCandidates = [];
    const uploadResults = new Map();
    for (const candidate of candidates) {
      const key = deliverableIdentity(candidate);
      if (uploadResults.has(key)) {
        if (uploadResults.get(key)) successfulCandidates.push(candidate);
        continue;
      }
      try {
        await this.sendDeliverable(chatId, candidate);
        uploadResults.set(key, true);
        successfulCandidates.push(candidate);
      } catch (error) {
        uploadResults.set(key, false);
        this.logDeliverableFailure("upload", candidate, error);
      }
    }

    const stripped = successfulCandidates.length > 0
      ? stripDeliveredPaths(original, successfulCandidates)
      : original;
    const cleaned = String(stripped ?? "").trim() || "Attached file.";
    const message = await this.sendMessage(chatId, cleaned);
    return {
      text: cleaned,
      candidates,
      successfulCandidates,
      message
    };
  }

  async sendDeliverable(chatId, candidate) {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    const delivery = telegramDeliverableRoute(candidate);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      delivery.field,
      new Blob(
        [Buffer.isBuffer(candidate?.buffer) ? candidate.buffer : Buffer.from(candidate?.buffer ?? "")],
        { type: candidate?.mimeType ?? "application/octet-stream" }
      ),
      candidate?.filename ?? "attachment"
    );
    const response = await this.fetch(
      `https://api.telegram.org/bot${this.token}/${delivery.method}`,
      { method: "POST", body: form }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.description ?? `Telegram ${delivery.method} failed with ${response.status}`);
    }
    return body;
  }

  logDeliverableFailure(phase, candidate, error) {
    const safeError = redactKnownValues(
      error?.message ?? String(error),
      secretRedactionSpellings(this.token)
    );
    appendJsonLine(this.eventsPath, {
      at: nowIso(),
      op: "deliverable-error",
      phase,
      category: candidate?.category ?? null,
      delivery: candidate?.delivery ?? null,
      error: String(safeError).replace(/[\r\n]+/gu, " ").slice(0, 300)
    });
  }

  startPolling(intervalMs = Number.parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS ?? "2500", 10)) {
    if (!this.token || this.pollTimer) return;
    const poll = async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        appendJsonLine(this.eventsPath, { at: nowIso(), error: error.message });
      }
    };
    this.pollTimer = setInterval(poll, intervalMs);
    poll();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async pollOnce() {
    if (!this.token) return { configured: false };
    const url = new URL(`https://api.telegram.org/bot${this.token}/getUpdates`);
    url.searchParams.set("timeout", "1");
    if (this.state.offset) url.searchParams.set("offset", String(this.state.offset));

    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(body.description ?? `Telegram poll failed with ${response.status}`);
    }

    for (const update of body.result ?? []) {
      await this.handleUpdate(update);
      this.state.offset = Math.max(this.state.offset ?? 0, update.update_id + 1);
      writeJsonAtomic(this.statePath, this.state);
    }

    return { updates: body.result?.length ?? 0 };
  }
}

function telegramDeliverableRoute(candidate) {
  if (candidate?.category === "image") return { method: "sendPhoto", field: "photo" };
  if (candidate?.category === "video") return { method: "sendVideo", field: "video" };
  if (candidate?.category === "audio") return { method: "sendAudio", field: "audio" };
  return { method: "sendDocument", field: "document" };
}

function deliverableIdentity(candidate) {
  for (const key of [
    "resolvedPath",
    "absolutePath",
    "canonicalPath",
    "filePath",
    "path"
  ]) {
    const value = candidate?.[key];
    if (typeof value === "string" && value) return `path:${path.normalize(value)}`;
  }
  const buffer = Buffer.isBuffer(candidate?.buffer)
    ? candidate.buffer
    : Buffer.from(candidate?.buffer ?? "");
  const digest = createHash("sha256").update(buffer).digest("hex");
  return `content:${candidate?.filename ?? "file"}:${digest}`;
}

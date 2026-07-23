// HTTP MCP client. Implements the Streamable HTTP transport (MCP spec
// 2025-03-26): single endpoint, JSON-RPC over POST, response is either
// application/json (single message) or text/event-stream (one or more
// messages). Mcp-Session-Id is captured from the initialize response and
// echoed on subsequent requests.
//
// Auth modes:
//   - none       — raw POST
//   - bearer     — static Authorization: Bearer <apiKey>
//   - oauth      — McpOAuthClient handles discovery, registration, and tokens
//
// 401 with an oauth client triggers one refresh+retry; if refresh fails the
// caller surfaces an actionable error and the dashboard's MCP tab shows
// "Authorize" so the user can re-run the auth flow.

import { appendJsonLine, ensureDir } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { redactKnownValues, safeRedactionMarker } from "./redact.js";
import { assertSafeMcpServerName, mcpNamedFilePath } from "./mcp-name.js";

const PROTOCOL_VERSION = "2025-03-26";

export class McpHttpClient {
  constructor(options = {}) {
    if (!options.url) throw new Error("McpHttpClient requires url");
    this.name = assertSafeMcpServerName(options.name ?? "mcp");
    this.url = options.url;
    this.staticHeaders = { ...(options.headers ?? {}) };
    this.bearerToken = options.bearerToken ?? null;
    this.redactValues = new Set(options.redactValues ?? []);
    if (this.bearerToken) this.redactValues.add(this.bearerToken);
    this.oauth = options.oauth ?? null;
    this.trustLevel = options.trustLevel ?? "untrusted";
    this.logDir = options.logDir;
    this.logPath = this.logDir
      ? mcpNamedFilePath(this.logDir, this.name, ".jsonl")
      : null;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 5 * 60 * 1000;
    this.nextId = 1;
    this.sessionId = null;
    this.serverInfo = null;
    this.tools = [];
    this.connected = false;
    this.lastError = null;
  }

  status() {
    return {
      name: this.name,
      url: this.url,
      transport: "http",
      authMode: this.oauth ? "oauth" : this.bearerToken ? "bearer" : "none",
      connected: this.connected,
      tools: this.tools.map((t) => t.name),
      serverInfo: this.serverInfo,
      lastError: this.lastError,
      sessionId: this.sessionId == null
        ? null
        : safeRedactionMarker([String(this.sessionId)])
    };
  }

  async connect({ interactive = true } = {}) {
    if (this.connected) return { tools: this.tools, serverInfo: this.serverInfo };
    if (this.logDir) ensureDir(this.logDir);
    try {
      // `interactive` is threaded per-request (not latched on the instance) so
      // a silent boot connect can't leave later tool calls unable to re-auth.
      this.serverInfo = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: { name: "openagi", version: "0.2.0" }
        },
        { timeoutMs: this.initializeTimeoutMs, interactive }
      );
      // notifications/initialized has no response.
      await this.notify("notifications/initialized", {}, { interactive });
      const list = await this.request("tools/list", {}, { interactive });
      this.tools = list?.tools ?? [];
      this.connected = true;
      this.lastError = null;
      return { tools: this.tools, serverInfo: this.serverInfo };
    } catch (error) {
      this.lastError = redactKnownValues(error.message, this.redactValues);
      const safeError = new Error(this.lastError);
      if (error?.code !== undefined) safeError.code = error.code;
      if (error?.status !== undefined) safeError.status = error.status;
      throw safeError;
    }
  }

  async listTools() {
    if (!this.connected) await this.connect();
    const list = await this.request("tools/list", {});
    this.tools = list?.tools ?? this.tools;
    return this.tools;
  }

  async callTool(toolName, args = {}) {
    if (!this.connected) await this.connect();
    return this.request("tools/call", { name: toolName, arguments: args });
  }

  notify(method, params, options = {}) {
    return this.send({ jsonrpc: "2.0", method, params }, { isNotification: true, interactive: options.interactive });
  }

  async request(method, params, options = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return this.send(message, { timeoutMs: options.timeoutMs, interactive: options.interactive });
  }

  /**
   * Send a JSON-RPC message. Awaits response unless `isNotification` is set.
   * On 401 with an oauth client: refresh once, retry once.
   */
  async send(message, { isNotification = false, timeoutMs = this.timeoutMs, retried = false, interactive = true } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.staticHeaders
    };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    let oauthToken = null;
    if (this.oauth) {
      try {
        oauthToken = await this.oauth.ensureToken({ interactive });
      } catch (error) {
        const safeMessage = redactKnownValues(String(error?.message ?? error), this.redactValues);
        const safeError = new Error(safeMessage);
        if (error?.code !== undefined) safeError.code = error.code;
        throw safeError;
      }
      headers.authorization = `Bearer ${oauthToken}`;
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const requestSecrets = new Set(this.redactValues);
    if (oauthToken) {
      requestSecrets.add(oauthToken);
      this.redactValues.add(oauthToken);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const safeMessage = redactKnownValues(String(error?.message ?? error), requestSecrets);
      this.log("error", { method: message.method, error: safeMessage });
      const safeError = new Error(safeMessage);
      if (error?.code !== undefined) safeError.code = error.code;
      throw safeError;
    }
    clearTimeout(timer);

    // Capture or update session id.
    const sid = response.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (response.status === 401 && this.oauth && !retried) {
      // Force a re-auth on next call.
      const cache = this.oauth.loadCache();
      if (cache) this.oauth.saveCache({ ...cache, access_token: null, expires_at: 0 });
      return this.send(message, { isNotification, timeoutMs, retried: true, interactive });
    }

    if (response.status === 202) {
      // Notification accepted.
      this.log("notify", { method: message.method });
      return null;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const safeBody = redactKnownValues(body, requestSecrets);
      this.log("error", { method: message.method, status: response.status, body: safeBody.slice(0, 500) });
      const safeStatus = redactKnownValues(response.statusText ?? "", requestSecrets);
      const err = new Error(`HTTP ${response.status} from ${this.name}: ${safeBody.slice(0, 200) || safeStatus}`);
      err.status = response.status;
      throw err;
    }

    if (isNotification) {
      // Drain body and return.
      try { await response.text(); } catch { /* ignore */ }
      return null;
    }

    const ct = (response.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/event-stream")) {
      return this.readSseForResponse(response, message.id, requestSecrets);
    }
    const json = await response.json().catch(() => ({}));
    return this.unwrap(json, message.id, requestSecrets);
  }

  /**
   * Read the SSE body and pluck out the response with the matching JSON-RPC id.
   * Server may interleave notifications; we route those to the log and keep
   * scanning until our id arrives or the stream ends.
   */
  async readSseForResponse(response, expectedId, redactValues = this.redactValues) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = parseSseBlock(block);
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id != null && msg.id === expectedId) {
            return this.unwrap(msg, expectedId, redactValues);
          }
          // Any other message is a notification or unrelated response — log it.
          this.log("notify", { msg: redactKnownValues(msg, redactValues) });
        } catch (err) {
          this.log("error", {
            sseParse: redactKnownValues(err.message, redactValues),
            raw: redactKnownValues(data, redactValues).slice(0, 200)
          });
        }
      }
    }
    throw new Error(`SSE stream ended without a response for request ${expectedId}`);
  }

  unwrap(json, expectedId, redactValues = this.redactValues) {
    if (json.error) {
      const safeError = redactKnownValues(json.error, redactValues);
      const err = new Error(safeError.message ?? "MCP error");
      err.code = safeError.code;
      err.data = safeError.data;
      throw err;
    }
    if (json.id != null && expectedId != null && json.id !== expectedId) {
      throw new Error(`MCP response id mismatch: expected ${expectedId}, got ${json.id}`);
    }
    return redactKnownValues(json.result ?? null, redactValues);
  }

  log(op, payload) {
    if (!this.logDir) return;
    appendJsonLine(this.logPath, {
      at: nowIso(),
      op,
      ...redactKnownValues(payload, this.redactValues)
    });
  }

  async close() {
    this.connected = false;
  }
}

function parseSseBlock(block) {
  // SSE block format: lines of "key: value", joined data lines, terminator "\n\n".
  const lines = block.split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? data.join("\n") : null;
}

import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import http from "node:http";
import https from "node:https";

export const DEFAULT_API_SERVER_PORT = 8642;
export const DEFAULT_SUBSCRIPTION_PROXY_PORT = 8645;
export const DEFAULT_CAPABILITY_BODY_BYTES = 1024 * 1024;

const LOOPBACK_HOST = "127.0.0.1";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const INBOUND_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token"
]);
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CLEAN_HEADER_VALUE_RE = /^[\x20-\x7e]*$/u;

class HttpRequestError extends Error {
  constructor(status, message, code, type = "invalid_request_error") {
    super(message);
    this.name = "HttpRequestError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export function createApiServer(runtimeOrOptions = {}, maybeOptions) {
  const { runtime, options } = runtimeAndOptions(runtimeOrOptions, maybeOptions);
  const env = options.env ?? process.env;
  const agentHost = options.agentHost ?? runtime?.agentHost;
  if (!agentHost || typeof agentHost.handleMessage !== "function") {
    throw new TypeError("API server requires an AgentHost.");
  }
  const apiKey = requiredCleanSecret(
    options.apiKey ?? env.API_SERVER_KEY,
    "API_SERVER_KEY"
  );
  const host = cleanHost(options.host ?? LOOPBACK_HOST);
  const port = validPort(options.port ?? env.API_SERVER_PORT, DEFAULT_API_SERVER_PORT);
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes,
    DEFAULT_CAPABILITY_BODY_BYTES
  );
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const createId = typeof options.createId === "function"
    ? options.createId
    : () => `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const log = typeof options.log === "function" ? options.log : () => {};

  const server = http.createServer((req, res) => {
    handleApiRequest(req, res, {
      agentHost,
      apiKey,
      maxBodyBytes,
      now,
      createId,
      agentId: options.agentId ?? "main",
      log
    }).catch((error) => {
      log({ op: "api-server-error", error: safeErrorCode(error) });
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        writeSseError(res, "Agent request failed.", "agent_error");
        writeSseDone(res);
        res.end();
        return;
      }
      sendOpenAiError(
        res,
        error instanceof HttpRequestError ? error.status : 500,
        error instanceof HttpRequestError
          ? error.message
          : "The agent request could not be completed.",
        error instanceof HttpRequestError ? error.code : "agent_error",
        error instanceof HttpRequestError ? error.type : "server_error"
      );
    });
  });

  return createServerSurface(server, { host, port, kind: "api" });
}

export function createSubscriptionProxy(runtimeOrOptions = {}, maybeOptions) {
  const { runtime, options } = runtimeAndOptions(runtimeOrOptions, maybeOptions);
  const env = options.env ?? process.env;
  const secretsStore = options.secretsStore
    ?? options.secrets
    ?? runtime?.secrets;
  if (!secretsStore || typeof secretsStore.getSecret !== "function") {
    throw new TypeError("Subscription proxy requires a SecretsStore.");
  }
  const upstream = validatedUpstream(
    options.upstreamUrl
    ?? options.upstream
    ?? env.SUBSCRIPTION_PROXY_UPSTREAM_URL
  );
  const secretName = cleanSecretName(
    options.secretName
    ?? env.SUBSCRIPTION_PROXY_SECRET_NAME
  );
  const authorizationHeader = cleanAuthorizationHeader(
    options.authorizationHeader ?? "authorization"
  );
  const authorizationPrefix = cleanAuthorizationPrefix(
    options.authorizationPrefix ?? "Bearer "
  );
  const host = cleanHost(options.host ?? LOOPBACK_HOST);
  const port = validPort(
    options.port ?? env.SUBSCRIPTION_PROXY_PORT,
    DEFAULT_SUBSCRIPTION_PROXY_PORT
  );
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes,
    DEFAULT_CAPABILITY_BODY_BYTES
  );
  const upstreamTimeoutMs = positiveInteger(options.upstreamTimeoutMs, 30000);
  const log = typeof options.log === "function" ? options.log : () => {};
  const requestHttp = options.requestHttp ?? http.request;
  const requestHttps = options.requestHttps ?? https.request;

  const server = http.createServer((req, res) => {
    handleProxyRequest(req, res, {
      secretsStore,
      secretName,
      upstream,
      authorizationHeader,
      authorizationPrefix,
      maxBodyBytes,
      upstreamTimeoutMs,
      requestHttp,
      requestHttps,
      log
    }).catch((error) => {
      log({ op: "subscription-proxy-error", error: safeErrorCode(error) });
      if (res.writableEnded || res.destroyed || res.headersSent) return;
      sendOpenAiError(
        res,
        error instanceof HttpRequestError ? error.status : 502,
        error instanceof HttpRequestError
          ? error.message
          : "The subscription upstream request failed.",
        error instanceof HttpRequestError ? error.code : "upstream_error",
        error instanceof HttpRequestError ? error.type : "proxy_error"
      );
    });
  });

  return createServerSurface(server, { host, port, kind: "subscription-proxy" });
}

export function startCapabilityServers(options = {}) {
  const runtime = options.runtime ?? null;
  const env = options.env ?? process.env;
  const apiEnabled = enabledFlag(
    options.apiEnabled ?? env.API_SERVER_ENABLED
  );
  const subscriptionProxyEnabled = enabledFlag(
    options.subscriptionProxyEnabled ?? env.SUBSCRIPTION_PROXY_ENABLED
  );
  const modelProvider = runtime?.agentHost?.modelProvider ?? null;
  const upstreamUrl = options.subscriptionProxyUpstreamUrl
    ?? options.upstreamUrl
    ?? env.SUBSCRIPTION_PROXY_UPSTREAM_URL
    ?? modelProvider?.baseUrl;
  const secretName = options.subscriptionProxySecretName
    ?? options.secretName
    ?? env.SUBSCRIPTION_PROXY_SECRET_NAME
    ?? modelProvider?.credentialEnvSecretName;
  const derivedAnthropicAuth = modelProvider?.credentialProviderName === "anthropic";
  const createApi = options.createApiServer ?? createApiServer;
  const createProxy = options.createSubscriptionProxy ?? createSubscriptionProxy;

  const apiServer = apiEnabled
    ? createApi({
        runtime,
        env,
        agentHost: options.agentHost,
        apiKey: options.apiKey,
        host: options.apiHost,
        port: options.apiPort,
        maxBodyBytes: options.apiMaxBodyBytes,
        log: options.log
      })
    : null;
  const subscriptionProxy = subscriptionProxyEnabled
    ? createProxy({
        runtime,
        env,
        secretsStore: options.secretsStore ?? runtime?.secrets,
        upstreamUrl,
        secretName,
        host: options.subscriptionProxyHost,
        port: options.subscriptionProxyPort,
        maxBodyBytes: options.subscriptionProxyMaxBodyBytes,
        upstreamTimeoutMs: options.upstreamTimeoutMs,
        authorizationHeader: options.authorizationHeader
          ?? (derivedAnthropicAuth ? "x-api-key" : "authorization"),
        authorizationPrefix: options.authorizationPrefix
          ?? (derivedAnthropicAuth ? "" : "Bearer "),
        log: options.log
      })
    : null;
  const addresses = {
    apiServer: null,
    subscriptionProxy: null
  };
  let listenPromise = null;

  return {
    apiServer,
    subscriptionProxy,
    addresses,
    listen() {
      if (listenPromise) return listenPromise;
      listenPromise = Promise.all([
        apiServer?.listen?.() ?? null,
        subscriptionProxy?.listen?.() ?? null
      ]).then(([apiAddress, proxyAddress]) => {
        addresses.apiServer = apiAddress;
        addresses.subscriptionProxy = proxyAddress;
        return addresses;
      }).catch(async (error) => {
        await Promise.allSettled([
          apiServer?.close?.(),
          subscriptionProxy?.close?.()
        ]);
        throw error;
      });
      return listenPromise;
    },
    async close() {
      await Promise.all([
        apiServer?.close?.(),
        subscriptionProxy?.close?.()
      ]);
    }
  };
}

async function handleApiRequest(req, res, context) {
  const url = localRequestUrl(req);
  if (url.pathname !== "/v1/chat/completions") {
    throw new HttpRequestError(404, "Route not found.", "not_found");
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    throw new HttpRequestError(405, "Method not allowed.", "method_not_allowed");
  }
  if (!exactBearer(req.headers.authorization, context.apiKey)) {
    res.setHeader("www-authenticate", "Bearer");
    throw new HttpRequestError(401, "Invalid bearer token.", "invalid_api_key");
  }

  const body = await readJsonBody(req, context.maxBodyBytes);
  const text = lastUserText(body.messages);
  if (!text) {
    throw new HttpRequestError(
      400,
      "messages must contain a non-empty user message.",
      "missing_user_message"
    );
  }
  if (body.stream === true) {
    await handleStreamingCompletion(req, res, body, text, context);
    return;
  }

  const abortController = new AbortController();
  const onAborted = () => abortController.abort(new Error("API client disconnected."));
  req.once("aborted", onAborted);
  res.once("close", () => {
    if (!res.writableEnded) onAborted();
  });
  try {
    const result = await context.agentHost.handleMessage({
      channel: "api",
      from: "api-client",
      agentId: context.agentId,
      sessionId: `api:${randomUUID()}`,
      text,
      ephemeral: true,
      abortSignal: abortController.signal,
      metadata: {
        apiModel: cleanModelName(body.model),
        apiStream: false
      }
    });
    sendJson(res, 200, completionResponse(result, body, context));
  } finally {
    req.removeListener("aborted", onAborted);
  }
}

async function handleStreamingCompletion(req, res, body, text, context) {
  const id = context.createId();
  const created = unixSeconds(context.now());
  const model = cleanModelName(body.model) || "openagi";
  const abortController = new AbortController();
  const onAborted = () => abortController.abort(new Error("API client disconnected."));
  req.once("aborted", onAborted);
  res.once("close", () => {
    if (!res.writableEnded) onAborted();
  });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  writeCompletionChunk(res, { id, created, model, delta: { role: "assistant" } });
  let streamedText = "";

  try {
    const result = await context.agentHost.handleMessage({
      channel: "api",
      from: "api-client",
      agentId: context.agentId,
      sessionId: `api:${randomUUID()}`,
      text,
      ephemeral: true,
      abortSignal: abortController.signal,
      onDelta(chunk) {
        const content = String(chunk ?? "");
        if (!content || !canWrite(res)) return;
        streamedText += content;
        writeCompletionChunk(res, {
          id,
          created,
          model,
          delta: { content }
        });
      },
      onToolEvent(event) {
        const progress = sanitizedToolProgress(event);
        if (!progress || !canWrite(res)) return;
        writeCompletionChunk(res, {
          id,
          created,
          model,
          delta: {
            content: inlineToolProgress(progress),
            tool_progress: progress
          }
        });
      },
      metadata: {
        apiModel: cleanModelName(body.model),
        apiStream: true
      }
    });
    const finalText = String(result?.reply ?? "");
    const remainder = completionRemainder(streamedText, finalText);
    if (remainder && canWrite(res)) {
      writeCompletionChunk(res, {
        id,
        created,
        model,
        delta: { content: remainder }
      });
    }
    if (canWrite(res)) {
      writeCompletionChunk(res, {
        id,
        created,
        model,
        delta: {},
        finishReason: finishReason(result)
      });
      writeSseDone(res);
      res.end();
    }
  } catch {
    if (canWrite(res)) {
      writeSseError(res, "The agent request could not be completed.", "agent_error");
      writeSseDone(res);
      res.end();
    }
  } finally {
    req.removeListener("aborted", onAborted);
  }
}

async function handleProxyRequest(req, res, context) {
  if (!nonblankBearer(req.headers.authorization)) {
    res.setHeader("www-authenticate", "Bearer");
    throw new HttpRequestError(401, "A bearer token is required.", "invalid_api_key");
  }
  const body = await readBoundedBody(req, context.maxBodyBytes);
  let credential;
  try {
    credential = await context.secretsStore.getSecret(context.secretName, {
      decidedBy: "subscription-proxy:request"
    });
  } catch {
    credential = null;
  }
  if (typeof credential !== "string" || !credential.trim()) {
    throw new HttpRequestError(
      502,
      "The subscription credential is unavailable.",
      "credential_unavailable",
      "proxy_error"
    );
  }
  if (!cleanCredentialValue(credential)) {
    throw new HttpRequestError(
      502,
      "The subscription credential is invalid.",
      "credential_unavailable",
      "proxy_error"
    );
  }

  const target = proxyTarget(context.upstream, req.url);
  const headers = forwardedRequestHeaders(req.headers);
  headers[context.authorizationHeader] = `${context.authorizationPrefix}${credential}`;
  if (body.length > 0) headers["content-length"] = String(body.length);
  else delete headers["content-length"];

  await forwardRawRequest(req, res, {
    target,
    body,
    headers,
    timeoutMs: context.upstreamTimeoutMs,
    requestImpl: target.protocol === "https:"
      ? context.requestHttps
      : context.requestHttp
  });
}

function forwardRawRequest(clientRequest, clientResponse, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const upstreamRequest = options.requestImpl(options.target, {
      method: clientRequest.method ?? "GET",
      headers: options.headers
    }, (upstreamResponse) => {
      if (settled) return;
      settled = true;
      const headers = forwardedResponseHeaders(upstreamResponse.headers);
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.on("error", () => {
        if (!clientResponse.destroyed) clientResponse.destroy();
      });
      upstreamResponse.on("end", resolve);
      upstreamResponse.pipe(clientResponse);
    });
    upstreamRequest.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    upstreamRequest.setTimeout(options.timeoutMs, () => {
      upstreamRequest.destroy(new Error("Subscription upstream timed out."));
    });
    clientRequest.once("aborted", () => {
      upstreamRequest.destroy(new Error("Subscription proxy client disconnected."));
    });
    if (options.body.length > 0) upstreamRequest.write(options.body);
    upstreamRequest.end();
  });
}

function completionResponse(result, body, context) {
  const model = cleanModelName(body.model)
    || cleanModelName(result?.model?.model)
    || "openagi";
  return {
    id: cleanCompletionId(result?.model?.id) || context.createId(),
    object: "chat.completion",
    created: unixSeconds(context.now()),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: String(result?.reply ?? "")
      },
      finish_reason: finishReason(result)
    }],
    usage: normalizedUsage(result?.model?.usage ?? result?.usage)
  };
}

function writeCompletionChunk(res, {
  id,
  created,
  model,
  delta,
  finishReason = null
}) {
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  });
}

function writeSseError(res, message, code) {
  writeSse(res, {
    error: {
      message,
      type: "server_error",
      param: null,
      code
    }
  });
}

function writeSse(res, value) {
  if (canWrite(res)) res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeSseDone(res) {
  if (canWrite(res)) res.write("data: [DONE]\n\n");
}

function sendOpenAiError(
  res,
  status,
  message,
  code,
  type = "invalid_request_error"
) {
  sendJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code
    }
  });
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length)
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes) {
  const body = await readBoundedBody(req, maxBytes);
  if (body.length === 0) {
    throw new HttpRequestError(400, "Request body must contain JSON.", "invalid_json");
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Request body contains invalid JSON.", "invalid_json");
  }
  if (!isPlainRecord(parsed)) {
    throw new HttpRequestError(400, "Request JSON must be an object.", "invalid_request");
  }
  return parsed;
}

function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new HttpRequestError(
        413,
        `Request body exceeds ${maxBytes} bytes.`,
        "request_too_large"
      ));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        req.resume();
        reject(new HttpRequestError(
          413,
          `Request body exceeds ${maxBytes} bytes.`,
          "request_too_large"
        ));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, bytes));
    });
    req.once("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new HttpRequestError(400, "Request body was interrupted.", "request_aborted"));
    });
    req.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new HttpRequestError(400, "Request body could not be read.", "invalid_request"));
    });
  });
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((part) => (
        part
        && (part.type === "text" || part.type === "input_text")
        && typeof part.text === "string"
      ))
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function sanitizedToolProgress(event) {
  if (!event || typeof event !== "object") return null;
  const phase = cleanProgressValue(event.phase);
  const name = cleanProgressValue(event.name ?? event.toolName);
  if (!["start", "end", "awaiting-approval"].includes(phase)) return null;
  const state = phase === "start"
    ? "running"
    : phase === "end"
      ? (event.ok === false ? "failed" : "completed")
      : "awaiting-approval";
  return {
    phase,
    ...(name ? { name } : {}),
    state
  };
}

function inlineToolProgress(progress) {
  const name = progress.name || "tool";
  return `[tool ${name} ${progress.state}]\n`;
}

function cleanProgressValue(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function completionRemainder(streamed, finalText) {
  if (!streamed) return finalText;
  if (finalText.startsWith(streamed)) return finalText.slice(streamed.length);
  if (streamed === finalText || streamed.startsWith(finalText)) return "";
  return "";
}

function finishReason(result) {
  const reason = String(result?.model?.stopReason ?? "").toLowerCase();
  return reason === "iteration-cap" || reason === "token-cap" ? "length" : "stop";
}

function normalizedUsage(value) {
  const prompt = nonNegativeInteger(
    value?.prompt_tokens ?? value?.input_tokens,
    0
  );
  const completion = nonNegativeInteger(
    value?.completion_tokens ?? value?.output_tokens,
    0
  );
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: nonNegativeInteger(value?.total_tokens, prompt + completion)
  };
}

function forwardedRequestHeaders(input) {
  const connectionTokens = connectionHeaderTokens(input.connection);
  const headers = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined
      || name === "host"
      || name === "content-length"
      || HOP_BY_HOP_HEADERS.has(name)
      || connectionTokens.has(name)
      || INBOUND_CREDENTIAL_HEADERS.has(name)
      || credentialHeaderName(name)
    ) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

function forwardedResponseHeaders(input) {
  const connectionTokens = connectionHeaderTokens(input.connection);
  const headers = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(name)
      || connectionTokens.has(name)
    ) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

function credentialHeaderName(name) {
  return /(?:^|[-_])(?:api[-_]?(?:key|token)|access[-_]?(?:key|token)|auth(?:orization)?|bearer|credentials?|secret|password|cookie)(?:$|[-_])/iu.test(name);
}

function connectionHeaderTokens(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function proxyTarget(upstream, requestUrl) {
  const inbound = new URL(String(requestUrl ?? "/"), "http://local.invalid");
  const target = new URL(upstream.href);
  target.pathname = inbound.pathname;
  target.search = inbound.search;
  target.hash = "";
  return target;
}

function validatedUpstream(value) {
  let upstream;
  try {
    upstream = new URL(String(value ?? ""));
  } catch {
    throw new TypeError("Subscription proxy requires a valid fixed upstream URL.");
  }
  if (
    !["http:", "https:"].includes(upstream.protocol)
    || !upstream.hostname
    || upstream.username
    || upstream.password
    || upstream.hash
  ) {
    throw new TypeError("Subscription proxy requires a clean http(s) upstream URL.");
  }
  return upstream;
}

function exactBearer(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  if (!presented || presented.trim() !== presented) return false;
  return secureEqual(presented, expected);
}

function nonblankBearer(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return Boolean(token && token.trim() === token);
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function cleanCredentialValue(value) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= 8192
    && !/[\r\n\0]/u.test(value);
}

function requiredCleanSecret(value, name) {
  if (!cleanCredentialValue(value)) {
    throw new TypeError(`${name} must be configured with a non-empty clean value.`);
  }
  return value;
}

function cleanSecretName(value) {
  const name = String(value ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) {
    throw new TypeError("Subscription proxy requires a valid secretName.");
  }
  return name;
}

function cleanAuthorizationHeader(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (
    !HEADER_NAME_RE.test(name)
    || HOP_BY_HOP_HEADERS.has(name)
    || name === "host"
    || name === "content-length"
    || name === "cookie"
  ) {
    throw new TypeError("Subscription proxy authorizationHeader is invalid.");
  }
  return name;
}

function cleanAuthorizationPrefix(value) {
  const prefix = String(value ?? "");
  if (
    prefix.length > 128
    || !CLEAN_HEADER_VALUE_RE.test(prefix)
    || /[\r\n\0]/u.test(prefix)
  ) {
    throw new TypeError("Subscription proxy authorizationPrefix is invalid.");
  }
  return prefix;
}

function cleanHost(value) {
  const host = String(value ?? "").trim();
  if (!host || host.length > 255 || /[\s/?#\0]/u.test(host)) {
    throw new TypeError("Capability server host is invalid.");
  }
  return host;
}

function validPort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("Capability server port must be an integer from 0 to 65535.");
  }
  return port;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanModelName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\0]/gu, "").trim().slice(0, 256);
}

function cleanCompletionId(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 200);
}

function unixSeconds(nowValue) {
  const value = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  return Math.floor((Number.isFinite(value) ? value : Date.now()) / 1000);
}

function localRequestUrl(req) {
  try {
    return new URL(String(req.url ?? "/"), "http://local.invalid");
  } catch {
    throw new HttpRequestError(400, "Request URL is invalid.", "invalid_request");
  }
}

function enabledFlag(value) {
  if (value === true) return true;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1"
    || normalized === "true"
    || normalized === "on"
    || normalized === "yes";
}

function runtimeAndOptions(first, second) {
  if (second !== undefined) {
    return {
      runtime: first ?? null,
      options: { ...(second ?? {}), runtime: first ?? second?.runtime ?? null }
    };
  }
  if (
    first
    && typeof first === "object"
    && first.agentHost
    && !Object.hasOwn(first, "runtime")
    && !Object.hasOwn(first, "apiKey")
    && !Object.hasOwn(first, "upstream")
    && !Object.hasOwn(first, "upstreamUrl")
  ) {
    return { runtime: first, options: {} };
  }
  const options = first && typeof first === "object" ? first : {};
  return { runtime: options.runtime ?? null, options };
}

function createServerSurface(server, { host, port, kind }) {
  let listenPromise = null;
  let closePromise = null;
  const surface = {
    server,
    host,
    port,
    kind,
    address() {
      return listeningAddress(server, host, port);
    },
    listen() {
      if (server.listening) return Promise.resolve(surface.address());
      if (listenPromise) return listenPromise;
      listenPromise = new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          listenPromise = null;
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(surface.address());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return listenPromise;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve(listenPromise).catch(() => {}).then(() => (
        new Promise((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections?.();
        })
      ));
      return closePromise;
    }
  };
  return surface;
}

function listeningAddress(server, host, fallbackPort) {
  const address = server.address();
  const port = address && typeof address === "object"
    ? address.port
    : fallbackPort;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    host,
    port,
    url: `http://${urlHost}:${port}`
  };
}

function canWrite(res) {
  return !res.destroyed && !res.writableEnded;
}

function safeErrorCode(error) {
  if (error instanceof HttpRequestError) return error.code;
  return "internal_error";
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

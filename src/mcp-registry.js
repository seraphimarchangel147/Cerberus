import fs from "node:fs";
import path from "node:path";
import { McpStdioClient } from "./mcp-client.js";
import { McpHttpClient } from "./mcp-http-client.js";
import { McpOAuthClient } from "./mcp-oauth.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { isCredentialEnvName, isCredentialHeaderName } from "./redact.js";
import { assertSafePublicUrl } from "./url-guard.js";
import { assertSafeMcpServerName, mcpNamedFilePath } from "./mcp-name.js";
import {
  addInternalCredentialFileRedactions,
  addSecretRedactionSpellings,
  isCredentialUrlParameter
} from "./credential-redaction.js";

// Whitelist of executables permitted as the `command` for stdio MCP servers.
// Anything not in this set is rejected at registerServer() — closes the
// "register /bin/sh -c <payload>" RCE path.
const ALLOWED_STDIO_COMMANDS = new Set([
  "npx", "node", "bun", "bunx", "deno",
  "python", "python3", "uv", "uvx",
  "docker",
  // trycua computer-use driver. The WSL→Windows bridge wrapper
  // (~/.hermes/bin/cua-driver) execs the Windows cua-driver.exe through
  // interop and speaks MCP over stdio — registered as server "cua" so the
  // agent gets real desktop control (mcp_cua_* tools). The wrapper is a fixed
  // known script, not an arbitrary shell, so allowlisting the leaf is safe.
  "cua-driver"
]);

export function isAllowedStdioCommand(command) {
  const leaf = String(command ?? "").trim().split(/[\\/]/).pop();
  return ALLOWED_STDIO_COMMANDS.has(leaf);
}

export function allowedStdioCommands() {
  return [...ALLOWED_STDIO_COMMANDS];
}

// MCP tools are exposed to the model as `mcp_<server>_<tool>`, and that name
// must match OpenAI's tool-name rule ^[a-zA-Z0-9_-]+$. BOTH segments can carry
// spaces/punctuation (e.g. a server literally named "BB Staging"), so sanitize
// each — otherwise the whole tools[] array is rejected and every tool-bearing
// call (autopilot, chat, sweeps) fails. The handler dispatches via stored
// server/tool refs, not by parsing this name, so sanitizing is lossless.
const mcpSeg = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, "_");
const mcpToolName = (server, tool) => `mcp_${mcpSeg(server)}_${mcpSeg(tool)}`;
const mcpToolPrefix = (server) => `mcp_${mcpSeg(server)}_`;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export class McpRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.clients = new Map();
    this.logDir = options.logDir;
    this.dataDir = options.dataDir ?? (options.logDir ? path.dirname(path.dirname(options.logDir)) : resolveDataDir());
    this.toolRegistry = options.toolRegistry ?? null;
    // Set by hosted-interface so OAuth-required surfaces in the dashboard SSE.
    this.onOauthRequired = options.onOauthRequired ?? null;
    this.connecting = new Map(); // name → Promise (in-flight connect)
    // Only explicitly permitted names can flow into ${VAR} substitutions.
    // Legacy .env names, caller-provided names, and stored secret names are
    // merged. Stored names are loaded lazily when a server is registered or
    // connected so constructing the runtime never initializes secret files.
    this.permittedEnvKeys = options.permittedEnvKeys instanceof Set
      ? options.permittedEnvKeys
      : new Set();
    this.dotenvEnvKeys = new Set(loadDotenvKeys(this.dataDir));
    this.legacyEnvKeys = new Set(this.dotenvEnvKeys);
    for (const name of this.legacyEnvKeys) this.permittedEnvKeys.add(name);
    this.secretStore = options.secretStore ?? null;
    this.secretEnvKeys = new Set();
    this.filterManagedLegacyKeys();
    this.stdioClientFactory = options.stdioClientFactory
      ?? ((clientOptions) => new McpStdioClient(clientOptions));
    this.httpClientFactory = options.httpClientFactory
      ?? ((clientOptions) => new McpHttpClient(clientOptions));
    this.oauthClientFactory = options.oauthClientFactory
      ?? ((clientOptions) => new McpOAuthClient(clientOptions));
    // When set, registerServer() persists the current set of registrations
    // back to this path so they survive a daemon restart. loadConfigFile()
    // skips writing (the file is the source of truth, not the destination).
    this.configPath = options.configPath ?? null;
    this._suppressPersist = false;
  }

  /// Allow runtime to whitelist a new env-var name (e.g. when a wizard
  /// step adds STRIPE_MCP_API_KEY to .env mid-session, and a follow-up
  /// registerServer call needs to expand `${STRIPE_MCP_API_KEY}` against it).
  allowEnvKey(name) {
    if (!name) return;
    const normalized = String(name);
    if (!ENV_NAME_RE.test(normalized)) {
      throw new TypeError(`Invalid MCP env name: ${normalized}`);
    }
    this.permittedEnvKeys.add(normalized);
  }

  bindSecretStore(secretStore) {
    this.secretStore = secretStore ?? null;
    this.secretEnvKeys = new Set();
    this.legacyEnvKeys = new Set(this.dotenvEnvKeys);
    this.filterManagedLegacyKeys();
    return this;
  }

  filterManagedLegacyKeys() {
    if (!this.secretStore) return;
    let allowed;
    try {
      allowed = typeof this.secretStore.listAllowedNames === "function"
        ? this.secretStore.listAllowedNames()
        : this.secretStore.allowlist instanceof Set
          ? [...this.secretStore.allowlist]
          : [];
    } catch {
      throw new Error("MCP secret store unavailable.");
    }
    if (allowed && typeof allowed.then === "function") {
      throw new TypeError("Secret store policy operations must be synchronous");
    }
    for (const name of allowed ?? []) this.legacyEnvKeys.delete(String(name));
  }

  refreshSecretEnvKeys({ decidedBy = "mcp-registry:list" } = {}) {
    if (!this.secretStore) {
      this.secretEnvKeys = new Set();
      return this.secretEnvKeys;
    }
    let names;
    try {
      if (typeof this.secretStore.listSecretNames === "function") {
        names = this.secretStore.listSecretNames({ decidedBy });
      } else if (typeof this.secretStore.listSecrets === "function") {
        names = this.secretStore.listSecrets({ decidedBy }).map((entry) => entry?.name);
      } else {
        throw new TypeError("Secret store must implement listSecretNames() or listSecrets()");
      }
    } catch {
      throw new Error("MCP secret store unavailable.");
    }
    if (names && typeof names.then === "function") {
      throw new TypeError("Secret store list operations must be synchronous");
    }
    this.secretEnvKeys = new Set(
      [...(names ?? [])].map((name) => String(name ?? "")).filter(Boolean)
    );
    for (const name of this.secretEnvKeys) this.permittedEnvKeys.add(name);
    return this.secretEnvKeys;
  }

  resolveServerSecrets(server, { decidedBy }) {
    const storedNames = this.refreshSecretEnvKeys({
      decidedBy: `${decidedBy}:list`
    });
    const referencedNames = collectPlaceholderNames([
      ...(server.args ?? []),
      ...Object.values(server.env ?? {}),
      ...Object.values(server.headers ?? {}),
      server.apiKey,
      server.clientId,
      server.clientSecret
    ]);
    for (const name of referencedNames) assertPermittedEnvKey(name, this.permittedEnvKeys);

    // Resolve every configured value for output redaction, but inject only
    // placeholders referenced by this server. This prevents a filesystem-like
    // MCP from reflecting secrets.json or .env contents it read directly.
    const storedValues = resolveStoredValues(this.secretStore, [...storedNames], { decidedBy });
    const valueCache = new Map();
    for (const name of referencedNames) {
      if (storedNames.has(name)) {
        const stored = Object.hasOwn(storedValues, name) ? storedValues[name] : null;
        valueCache.set(name, stored ?? "");
      } else if (!this.secretStore || this.legacyEnvKeys.has(name)) {
        valueCache.set(name, process.env[name] ?? "");
      } else {
        valueCache.set(name, "");
      }
      if (String(valueCache.get(name) ?? "").length === 0) {
        throw new Error(`Secret value unavailable for MCP placeholder: ${name}`);
      }
    }
    const resolve = (value) => resolveValue(value, valueCache);
    const redactValues = new Set();
    for (const name of storedNames) {
      if (Object.hasOwn(storedValues, name)) {
        addSecretRedactionSpellings(redactValues, storedValues[name]);
      }
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (isCredentialEnvName(name)) addSecretRedactionSpellings(redactValues, value);
    }
    for (const value of valueCache.values()) {
      addSecretRedactionSpellings(redactValues, value);
    }
    addInternalCredentialFileRedactions(redactValues, this.dataDir);
    return {
      args: (server.args ?? []).map(resolve),
      env: resolveEnv(server.env, resolve),
      headers: resolveEnv(server.headers, resolve),
      apiKey: resolve(server.apiKey),
      clientId: resolve(server.clientId),
      clientSecret: resolve(server.clientSecret),
      redactValues
    };
  }

  bindToolRegistry(toolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  registerServer(server) {
    validateMcpServerSpec(server);
    const canonicalName = server.name.toLowerCase();
    if (
      [...this.servers.keys()].some(
        (name) => name !== server.name && name.toLowerCase() === canonicalName
      )
    ) {
      throw new Error("MCP server name conflicts with an existing server.");
    }
    this.refreshSecretEnvKeys({ decidedBy: "mcp-registry:register" });
    let transport = server.transport;
    if (!transport) {
      if (server.url) transport = "http";
      else if (server.command) transport = "stdio";
      else transport = "config";
    }

    // stdio command allowlist — must be a known runner.
    if (transport === "stdio") {
      const cmd = server.command;
      if (!cmd) throw new Error("stdio MCP server requires a `command`.");
      if (!isAllowedStdioCommand(cmd)) {
        throw new Error(
          `stdio command "${cmd}" is not in the allowlist. ` +
          `Permitted: ${allowedStdioCommands().join(", ")}.`
        );
      }
    }

    // http URL must be http(s) and not a loopback / link-local / RFC1918 host.
    if (transport === "http") {
      if (!server.url) throw new Error("http MCP server requires a `url`.");
      assertSafeMcpUrl(server.url);
    }

    const allowed = this.permittedEnvKeys;
    const normalized = {
      name: server.name,
      transport,
      // stdio-specific
      command: server.command ?? null,
      // Preserve placeholders in registry state. They are validated here and
      // resolved into a short-lived client configuration inside doConnect.
      args: (server.args ?? []).map((a) => preserveValue(a, allowed)),
      env: preserveEnv(server.env ?? {}, allowed),
      cwd: server.cwd ?? null,
      // http-specific
      url: server.url ?? null,
      auth: server.auth ?? (server.apiKey ? "bearer" : (server.url ? "oauth" : "none")),
      apiKey: preserveValue(server.apiKey ?? null, allowed),
      headers: preserveEnv(server.headers ?? {}, allowed),
      scope: server.scope,
      // OAuth pre-registered client (for servers without dynamic registration)
      clientId: preserveValue(server.clientId ?? null, allowed),
      clientSecret: preserveValue(server.clientSecret ?? null, allowed),
      resourceUrl: server.resourceUrl ?? null,
      // shared
      trustLevel: server.trustLevel ?? "untrusted",
      tools: server.tools ?? [],
      enabled: server.enabled ?? true
    };
    this.servers.set(normalized.name, normalized);
    if (!this._suppressPersist) this._persist(server);
    return normalized;
  }

  /// Save the un-expanded server specs to configPath (if set). We keep the
  /// `${VAR}` indirection so secrets stay in .env, not duplicated into the
  /// JSON. Called automatically from registerServer; no-op if the registry
  /// wasn't constructed with a configPath. Throws on either of:
  ///   - apiKey passed as a literal value (must be `${VAR}` to persist)
  ///   - filesystem write failure
  /// so callers that registered through an HTTP endpoint see a real error
  /// instead of "200 OK but quietly lost on next boot".
  _persist(originalSpec) {
    if (!this.configPath) return;
    // Refuse to write raw bearer tokens to disk. Callers that need a
    // bearer should add the env var via .env + allowEnvKey() and pass
    // the apiKey as `${VAR}`. This catches /mcp/register callers that
    // would otherwise leak an sk_live_… into mcp.json.
    if (originalSpec?.apiKey != null && !looksLikeEnvPlaceholder(originalSpec.apiKey)) {
      throw new Error(
        `MCP server '${originalSpec.name}': refusing to persist a literal apiKey. ` +
        `Pass apiKey: '\${VAR_NAME}' and put the value in .env so it isn't duplicated to mcp.json.`
      );
    }
    const existing = readJsonFile(this.configPath, null) ?? {};
    const servers = existing.servers ?? existing.mcpServers ?? {};
    // Round-trip what the caller passed (with `${VAR}` placeholders intact)
    // so we never write the expanded secret back to disk.
    const spec = {
      ...(originalSpec ?? {}),
      // Drop fields that aren't valid in the file schema.
      name: undefined
    };
    for (const k of Object.keys(spec)) {
      if (spec[k] === undefined) delete spec[k];
    }
    servers[originalSpec.name] = spec;
    const out = existing.mcpServers ? { ...existing, mcpServers: servers } : { ...existing, servers };
    writeJsonAtomic(this.configPath, out);
  }

  loadConfigFile(filePath) {
    if (!filePath) return [];
    const config = readJsonFile(filePath, null);
    if (!config) return [];
    const registered = [];
    const servers = config.servers ?? config.mcpServers ?? {};
    this._suppressPersist = true;
    try {
    for (const [name, spec] of Object.entries(servers)) {
      // Skip comment-only entries (keys like "_comment", "//", "//2").
      if (name.startsWith("_") || name === "//" || /^\/\/\d*$/.test(name)) continue;
      if (typeof spec !== "object" || spec === null) continue;
      registered.push(
        this.registerServer({
          name,
          // stdio
          command: spec.command,
          args: spec.args ?? [],
          env: spec.env ?? {},
          cwd: spec.cwd,
          // http
          url: spec.url,
          auth: spec.auth,
          apiKey: spec.apiKey,
          headers: spec.headers ?? {},
          scope: spec.scope,
          // OAuth pre-registered client (for non-DCR auth servers)
          clientId: spec.clientId,
          clientSecret: spec.clientSecret,
          resourceUrl: spec.resourceUrl,
          // shared
          trustLevel: spec.trustLevel ?? "trusted",
          enabled: spec.enabled ?? true,
          transport: spec.transport
        })
      );
    }
    } finally {
      this._suppressPersist = false;
    }
    return registered;
  }

  listServers() {
    return [...this.servers.values()].map((server) => {
      const client = this.clients.get(server.name);
      return {
        name: server.name,
        trustLevel: server.trustLevel,
        enabled: server.enabled,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        auth: server.auth,
        tools: client?.tools?.map((tool) => tool.name) ?? server.tools.map((tool) => tool.name ?? tool),
        connected: client?.connected ?? false,
        lastError: client?.lastError ?? null
      };
    });
  }

  listTools() {
    const out = [];
    for (const [name, server] of this.servers) {
      const client = this.clients.get(name);
      const tools = client?.tools ?? server.tools ?? [];
      for (const tool of tools) {
        const rawName = tool.name ?? tool;
        out.push({
          server: name,
          trustLevel: server.trustLevel,
          name: rawName,
          // The name the tool is actually registered + callable under (matches
          // exposeAsTools). Consumers that build allowlists must use this.
          registeredName: mcpToolName(name, rawName),
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
          connected: Boolean(client?.connected)
        });
      }
    }
    return out;
  }

  isConnecting(name) {
    return this.connecting.has(name);
  }

  async connect(name, { silent = false } = {}) {
    const inflight = this.connecting.get(name);
    if (inflight) {
      // An interactive (non-silent) in-flight connect serves any caller. A
      // silent in-flight connect serves silent callers. But an interactive
      // caller must NOT be handed a silent attempt (which fails fast without
      // opening a browser) — wait for it, then connect interactively if the
      // silent attempt didn't already get us connected.
      if (!inflight.silent || silent) return inflight.promise;
      return inflight.promise.then(
        (status) => status,
        () => this.connect(name, { silent: false })
      );
    }
    const promise = this.doConnect(name, { silent });
    const entry = { promise, silent };
    this.connecting.set(name, entry);
    // The caller awaits `promise` and handles its rejection; this cleanup chain
    // is separate, so swallow its copy of the rejection to avoid an
    // unhandledRejection when a connect fails (e.g. silent boot reconnect).
    promise.finally(() => {
      if (this.connecting.get(name) === entry) this.connecting.delete(name);
    }).catch(() => {});
    return promise;
  }

  /**
   * Silently obtain a Bearer token for a connected OAuth MCP server, reusing
   * the registry's own OAuth client (or the cached token on disk) — never opens
   * a browser. Returns null when there's no usable token. This is the shared
   * primitive integrations use to call a vendor's REST/GraphQL API with the
   * same login the user already granted to that vendor's MCP server.
   */
  async silentTokenFor(name) {
    try {
      let oauth = this.clients.get(name)?.oauth ?? null;
      if (!oauth) {
        const server = this.servers.get(name);
        if (server?.auth !== "oauth" || !server.url) return null;
        const resolved = this.resolveServerSecrets({
          ...server,
          args: [],
          env: {},
          headers: {},
          apiKey: null
        }, {
          decidedBy: `mcp:${name}:silent-token`
        });
        oauth = this.oauthClientFactory({
          name: server.name,
          resourceUrl: server.resourceUrl ?? deriveResourceUrl(server.url),
          scope: server.scope,
          dataDir: this.dataDir,
          clientId: resolved.clientId,
          clientSecret: resolved.clientSecret
        });
      }
      return await oauth.ensureToken({ interactive: false });
    } catch {
      return null;
    }
  }

  /**
   * Sync probe: is there a usable OAuth token cached on disk for this server
   * (so an integration can report itself "configured" without a network call)?
   * Reads the same <dataDir>/mcp/auth/<name>.json the OAuth client writes.
   */
  hasOAuthToken(name) {
    try {
      const cache = readJsonFile(
        mcpNamedFilePath(path.join(this.dataDir, "mcp", "auth"), name, ".json"),
        null
      );
      if (!cache) return false;
      // Mirror what ensureToken({interactive:false}) can actually do: a
      // refresh_token can always mint a fresh access token silently, but a
      // bare access_token only counts while unexpired (same 30s safety margin
      // as McpOAuthClient.isExpired) — otherwise integrations report
      // "configured", ack webhooks, and then silently fail to authenticate.
      if (cache.refresh_token) return true;
      if (!cache.access_token || !cache.expires_at) return false;
      return Date.now() < cache.expires_at - 30_000;
    } catch {
      return false;
    }
  }

  async doConnect(name, { silent = false } = {}) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (!server.enabled) throw new Error(`MCP server ${name} is disabled.`);

    let client = this.clients.get(name);
    let createdClient = false;
    if (!client) {
      const resolved = this.resolveServerSecrets(server, {
        decidedBy: `mcp:${name}:connect`
      });
      if (server.transport === "stdio") {
        if (!server.command) {
          throw new Error(`MCP server '${name}' is stdio but has no command — set 'command' (and 'args') so it can be spawned.`);
        }
        client = this.stdioClientFactory({
          name: server.name,
          command: server.command,
          args: resolved.args,
          displayArgs: server.args,
          env: resolved.env,
          cwd: server.cwd,
          trustLevel: server.trustLevel,
          logDir: this.logDir,
          redactValues: resolved.redactValues
        });
      } else if (server.transport === "http") {
        if (!server.url) throw new Error(`MCP server '${name}' is http but has no url.`);
        let oauth = null;
        let bearerToken = null;
        if (server.auth === "oauth") {
          const onAuthUrl = ({ url }) => {
            if (this.onOauthRequired) this.onOauthRequired({ name: server.name, url });
            // also keep the stderr banner so headless daemons can be unblocked
            const banner = "\n──────────────────────────────────────────────────────────────────\n" +
              `OAuth required for MCP server: ${server.name}\nOpen this URL in a browser to authorize:\n${url}\n` +
              "──────────────────────────────────────────────────────────────────\n";
            try { process.stderr.write(banner); } catch { /* ignore */ }
          };
          oauth = this.oauthClientFactory({
            name: server.name,
            resourceUrl: server.resourceUrl ?? deriveResourceUrl(server.url),
            scope: server.scope,
            dataDir: this.dataDir,
            clientId: resolved.clientId,
            clientSecret: resolved.clientSecret,
            printAuthUrlFn: onAuthUrl
          });
        } else if (server.auth === "bearer") {
          if (!resolved.apiKey) throw new Error(`MCP server '${name}' has auth=bearer but no apiKey.`);
          bearerToken = resolved.apiKey;
        }
        client = this.httpClientFactory({
          name: server.name,
          url: server.url,
          headers: resolved.headers,
          bearerToken,
          oauth,
          trustLevel: server.trustLevel,
          logDir: this.logDir,
          redactValues: resolved.redactValues
        });
      } else {
        throw new Error(`MCP server '${name}' has unsupported transport '${server.transport}'. Use 'stdio' (with command) or 'http' (with url).`);
      }
      this.clients.set(name, client);
      createdClient = true;
    }
    // silent → never open a browser for OAuth; fail fast if a token isn't cached.
    try {
      await client.connect({ interactive: !silent });
    } catch (error) {
      if (createdClient && this.clients.get(name) === client) {
        this.clients.delete(name);
        try { await client.close?.(); } catch { /* best effort */ }
      }
      throw error;
    }
    this.exposeAsTools(server.name);
    return publicClientStatus(client, server);
  }

  async connectAll({ silent = false } = {}) {
    const targets = [...this.servers].filter(([, server]) => {
      if (!server.enabled) return false;
      if (server.transport === "stdio" && !server.command) return false;
      if (server.transport === "http" && !server.url) return false;
      return server.transport === "stdio" || server.transport === "http";
    });
    const attempt = (name) => this.connect(name, { silent }).then(
      (status) => ({ name, ok: true, status }),
      (error) => ({ name, ok: false, error: error.message, code: error.code ?? null })
    );
    // Silent boot reconnect runs concurrently (no browser, so no popup storm)
    // to pay max-latency, not sum. Interactive connect-all stays sequential so
    // we never open several OAuth browser tabs at once.
    if (silent) return Promise.all(targets.map(([name]) => attempt(name)));
    const results = [];
    for (const [name] of targets) results.push(await attempt(name));
    return results;
  }

  async disconnect(name) {
    const client = this.clients.get(name);
    if (!client) return false;
    client.close();
    this.clients.delete(name);
    if (this.toolRegistry) {
      for (const toolName of [...this.toolRegistry.tools.keys()]) {
        if (toolName.startsWith(mcpToolPrefix(name))) this.toolRegistry.unregister(toolName);
      }
    }
    return true;
  }

  async disconnectAll() {
    for (const name of [...this.clients.keys()]) {
      await this.disconnect(name);
    }
  }

  async callTool(serverName, toolName, args) {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server ${serverName} is not connected. Call /mcp/connect first.`);
    return client.callTool(toolName, args);
  }

  exposeAsTools(serverName) {
    if (!this.toolRegistry) return;
    const client = this.clients.get(serverName);
    if (!client) return;
    for (const toolName of [...this.toolRegistry.tools.keys()]) {
      if (toolName.startsWith(mcpToolPrefix(serverName))) this.toolRegistry.unregister(toolName);
    }
    for (const tool of client.tools ?? []) {
      const safeName = mcpToolName(serverName, tool.name);
      this.toolRegistry.register({
        name: safeName,
        description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
        source: "mcp",
        parameters: tool.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: true
        },
        handler: (args) => client.callTool(tool.name, args ?? {}),
        metadata: { server: serverName, originalName: tool.name }
      });
    }
  }
}

// Validate "${ENV_VAR}" placeholders without expanding them. Registry state,
// persisted config, and status surfaces retain the indirection; doConnect is
// the only boundary that receives resolved values.
function preserveValue(value, allowedKeys) {
  if (typeof value !== "string") return value;
  const matcher = /\$\{([^}]*)\}/g;
  let match;
  while ((match = matcher.exec(value)) !== null) {
    const name = match[1];
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid MCP env placeholder: \${${name}}`);
    }
    assertPermittedEnvKey(name, allowedKeys);
  }
  return value;
}

function assertPermittedEnvKey(name, allowedKeys) {
  if (allowedKeys && allowedKeys.has(name)) return;
  throw new Error(
    `${name} is not in the env allowlist. Add it through the secrets manager or .openagi/.env before referencing it from MCP config.`
  );
}

// Strict-shape predicate: the apiKey field is either entirely a `${VAR}`
// placeholder or empty. Anything else is a literal bearer that we refuse to
// retain in registry state or persist.
function looksLikeEnvPlaceholder(value) {
  if (value == null || value === "") return true;
  if (typeof value !== "string") return false;
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

function looksLikeCredentialHeaderPlaceholder(value) {
  if (looksLikeEnvPlaceholder(value)) return true;
  if (typeof value !== "string") return false;
  return /^[A-Za-z][A-Za-z0-9._-]* \$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

// Pure, side-effect-free validation shared by the registry and the
// register_mcp_server tool's pre-approval boundary. Store lookups and
// placeholder expansion deliberately remain outside this function.
export function validateMcpServerSpec(server) {
  if (!server?.name) throw new Error("MCP server requires a name.");
  assertSafeMcpServerName(server.name);
  assertMcpUrlContainsNoCredentials(server.url);
  assertMcpUrlContainsNoCredentials(server.resourceUrl);
  if (
    server.args !== undefined
    && (!Array.isArray(server.args) || server.args.some((value) => typeof value !== "string"))
  ) {
    throw new TypeError("MCP args must be an array of strings.");
  }
  assertPlainMcpMap(server.env, "env");
  assertPlainMcpMap(server.headers, "headers");
  if (server.apiKey != null && !looksLikeEnvPlaceholder(server.apiKey)) {
    throw new Error(
      "MCP refusing a literal apiKey; credentials must use an exact secret placeholder."
    );
  }
  if (server.clientSecret != null && !looksLikeEnvPlaceholder(server.clientSecret)) {
    throw new Error(
      "MCP refusing a literal clientSecret; credentials must use an exact secret placeholder."
    );
  }
  validateCredentialMap(server.env, {
    kind: "env",
    isCredentialName: isCredentialEnvName,
    acceptsValue: looksLikeEnvPlaceholder
  });
  validateCredentialMap(server.headers, {
    kind: "header",
    isCredentialName: isCredentialHeaderName,
    acceptsValue: looksLikeCredentialHeaderPlaceholder
  });
  validateCredentialArgs(server.args);
  return server;
}

function assertPlainMcpMap(value, label) {
  if (value === null || value === undefined) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`MCP ${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`MCP ${label} must be a plain object.`);
  }
  if (
    Object.values(value).some(
      (item) => item !== null && item !== undefined && typeof item !== "string"
    )
  ) {
    throw new TypeError(`MCP ${label} values must be strings.`);
  }
}

function assertMcpUrlContainsNoCredentials(value) {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string") throw new Error("Invalid MCP URL.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid MCP URL.");
  }
  assertParsedMcpUrlContainsNoCredentials(parsed);
}

function assertParsedMcpUrlContainsNoCredentials(parsed) {
  if (parsed.username || parsed.password) {
    throw new Error("MCP URLs must not contain embedded credentials.");
  }
  for (const name of parsed.searchParams.keys()) {
    if (isCredentialUrlParameter(name)) {
      throw new Error("MCP URLs must not contain credential query parameters.");
    }
  }
}

function assertMcpArgumentContainsNoCredentialUrl(value) {
  const candidates = [value];
  const inline = /^(?:--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+)([\s\S]+)$/.exec(value);
  if (inline) candidates.push(inline[1]);
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    assertParsedMcpUrlContainsNoCredentials(parsed);
  }
}

function validateCredentialMap(values, {
  kind,
  isCredentialName,
  acceptsValue
}) {
  for (const [name, value] of Object.entries(values ?? {})) {
    if (!isCredentialName(name) || acceptsValue(value)) continue;
    // Never interpolate the rejected value: this error can cross HTTP and
    // model boundaries, so even the diagnostic must be safe to reflect.
    throw new Error(
      `MCP ${kind} field '${name}' is credential-shaped and must use a secret placeholder.`
    );
  }
}

const CREDENTIAL_ARG_FLAG = /^--(?:api[-_]?key|token|bearer[-_]?token|access[-_]?token|auth[-_]?token|service[-_]?key|webhook[-_]?secret|account[-_]?sid|credentials?|secret|client[-_]?(?:secret|id)|password|passcode|private[-_]?key|access[-_]?key(?:[-_]?id)?)$/i;
const AUTHORIZATION_ARG_FLAG = /^--(?:authorization|proxy[-_]?authorization)$/i;
const HEADER_ARG_FLAG = /^(?:--header|-H)$/;

function validateCredentialArgs(values) {
  const args = [...(values ?? [])];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (typeof raw !== "string") continue;
    assertMcpArgumentContainsNoCredentialUrl(raw);
    const parsed = splitFlagValue(raw);
    if (!parsed) continue;

    if (CREDENTIAL_ARG_FLAG.test(parsed.flag)) {
      const { value, consumedNext } = argCredentialValue(args, index, parsed);
      if (!looksLikeRequiredEnvPlaceholder(value)) {
        throw new Error(
          `MCP argument '${parsed.flag}' is credential-shaped and must use a secret placeholder.`
        );
      }
      if (consumedNext) index += 1;
      continue;
    }

    if (AUTHORIZATION_ARG_FLAG.test(parsed.flag)) {
      const { value, consumedNext } = argCredentialValue(args, index, parsed);
      if (!looksLikeRequiredCredentialHeaderPlaceholder(value)) {
        throw new Error(
          `MCP argument '${parsed.flag}' is credential-shaped and must use a secret placeholder.`
        );
      }
      if (consumedNext) index += 1;
      continue;
    }

    if (HEADER_ARG_FLAG.test(parsed.flag)) {
      const { value, consumedNext } = argCredentialValue(args, index, parsed);
      validateHeaderArgument(value, parsed.flag);
      if (consumedNext) index += 1;
    }
  }
}

function splitFlagValue(raw) {
  const match = /^(--[A-Za-z][A-Za-z0-9_-]*|-H)(?:=|\s+)?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const hasInlineValue = raw.length > match[1].length;
  return {
    flag: match[1],
    inlineValue: hasInlineValue ? match[2] : null
  };
}

function argCredentialValue(args, index, parsed) {
  if (parsed.inlineValue !== null) {
    return { value: parsed.inlineValue, consumedNext: false };
  }
  return {
    value: args[index + 1],
    consumedNext: index + 1 < args.length
  };
}

function validateHeaderArgument(value, flag) {
  if (typeof value !== "string" || value.startsWith("-")) {
    throw new Error(
      `MCP argument '${flag}' requires a header value.`
    );
  }
  const colon = value.indexOf(":");
  if (colon >= 0) {
    const name = value.slice(0, colon).trim();
    const headerValue = value.slice(colon + 1).trim();
    if (
      isCredentialHeaderName(name)
      && !looksLikeRequiredCredentialHeaderPlaceholder(headerValue)
    ) {
      throw new Error(
        `MCP argument '${flag}' contains a credential-shaped header that must use a secret placeholder.`
      );
    }
    return;
  }
  // Some CLIs accept the Authorization value directly after --header.
  if (
    /^(?:Bearer|Basic|Token)\s+/i.test(value)
    && !looksLikeRequiredCredentialHeaderPlaceholder(value)
  ) {
    throw new Error(
      `MCP argument '${flag}' contains a credential-shaped header that must use a secret placeholder.`
    );
  }
}

function looksLikeRequiredEnvPlaceholder(value) {
  return typeof value === "string"
    && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

function looksLikeRequiredCredentialHeaderPlaceholder(value) {
  return looksLikeRequiredEnvPlaceholder(value)
    || (
      typeof value === "string"
      && /^[A-Za-z][A-Za-z0-9._-]* \$\{[A-Z_][A-Z0-9_]*\}$/.test(value)
    );
}

function preserveEnv(obj, allowedKeys) {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    out[key] = preserveValue(value, allowedKeys);
  }
  return out;
}

function collectPlaceholderNames(values) {
  const names = new Set();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const matcher = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
    let match;
    while ((match = matcher.exec(value)) !== null) names.add(match[1]);
  }
  return names;
}

function resolveStoredValues(secretStore, names, { decidedBy }) {
  if (!secretStore || names.length === 0) return {};
  let values;
  try {
    if (typeof secretStore.exportEnv === "function") {
      values = secretStore.exportEnv({ names, decidedBy });
    } else if (typeof secretStore.getSecret === "function") {
      values = Object.fromEntries(
        names.map((name) => [name, secretStore.getSecret(name, { decidedBy })])
      );
    } else {
      throw new TypeError("Secret store must implement exportEnv() or getSecret()");
    }
  } catch {
    throw new Error("MCP secret store unavailable.");
  }
  if (values && typeof values.then === "function") {
    throw new TypeError("Secret store access operations must be synchronous");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("Secret store exportEnv() must return an object");
  }
  return values;
}

function resolveValue(value, valueCache) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    if (!valueCache.has(name)) throw new Error(`Unresolved MCP secret placeholder: ${name}`);
    return valueCache.get(name);
  });
}

function resolveEnv(obj, resolve) {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) out[key] = resolve(value);
  return out;
}

function publicClientStatus(client, server) {
  const status = client.status();
  if (server.transport !== "stdio") return status;
  return { ...status, args: [...(server.args ?? [])] };
}

// Read keys out of .openagi/.env so registerServer knows what may be expanded.
// We deliberately don't read process.env directly — only what the user has
// explicitly placed in this file is eligible for ${VAR} substitution.
function loadDotenvKeys(dataDir) {
  const file = path.join(dataDir ?? resolveDataDir(), ".env");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Reject MCP URLs that point at loopback / link-local / RFC1918 / cloud
// metadata endpoints. Combined with the env-var allowlist this closes the
// SSRF + secret-exfil chain through `/mcp/register`. Delegates to the shared
// url-guard (same guard the fetch_url tool uses).
function assertSafeMcpUrl(value) {
  assertSafePublicUrl(value, "MCP url");
}

// For OAuth discovery, use the MCP endpoint's origin as the resource URL
// (where /.well-known/oauth-protected-resource lives), unless the user
// explicitly overrides it. e.g. https://mcp.example.com/mcp → https://mcp.example.com
function deriveResourceUrl(mcpUrl) {
  try {
    const u = new URL(mcpUrl);
    return u.origin;
  } catch {
    return mcpUrl;
  }
}

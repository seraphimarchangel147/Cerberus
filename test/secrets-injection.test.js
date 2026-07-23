import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerCodeTools } from "../src/code-tools.js";
import { CliClient } from "../src/cli-client.js";
import { ComputerUseLog } from "../src/computer-use-log.js";
import { DiscordChannel } from "../src/discord-channel.js";
import { registerComputerUseTools } from "../src/integrations/computer-use.js";
import { registerImessageSearchTool } from "../src/integrations/imessage-search-tool.js";
import { McpStdioClient } from "../src/mcp-client.js";
import { McpHttpClient } from "../src/mcp-http-client.js";
import { McpOAuthClient } from "../src/mcp-oauth.js";
import { McpRegistry } from "../src/mcp-registry.js";
import {
  isCredentialHeaderName,
  redactKnownValues,
  sanitizeForAudit
} from "../src/redact.js";
import {
  preflightConnectCatalogMcp,
  preflightRegisterMcpServer,
  registerCoreTools,
  summarizeRegisterMcpServer,
  ToolRegistry
} from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { addInternalCredentialFileRedactions } from "../src/credential-redaction.js";

function makeSecretStore(values, calls = [], allowedNames = Object.keys(values)) {
  return {
    listAllowedNames() {
      return [...allowedNames];
    },
    listSecretNames({ decidedBy }) {
      calls.push({ op: "list", decidedBy });
      return Object.keys(values);
    },
    exportEnv({ names, decidedBy }) {
      calls.push({ op: "export", names: [...names], decidedBy });
      return Object.fromEntries(
        names.filter((name) => Object.hasOwn(values, name))
          .map((name) => [name, values[name]])
      );
    }
  };
}

function fakeClient(options) {
  return {
    options,
    tools: [],
    connected: false,
    async connect() {
      this.connected = true;
    },
    status() {
      return {
        name: options.name,
        command: options.command,
        args: options.args,
        connected: this.connected,
        tools: []
      };
    },
    close() {
      this.connected = false;
    }
  };
}

test("MCP keeps placeholders at rest and resolves stored values only for client construction", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secret-mcp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secret = "mcp-canary-value-93f1";
  const unused = "unused\"mcp\ncanary\\177a";
  const parentOnly = "parent-only-mcp-canary-45ad";
  const oauthCacheToken = "oauth-cache-token-canary-cc18";
  const pairedNodeToken = "paired-node-token-canary-a982";
  const previousParentOnly = process.env.MCP_PARENT_ONLY_TOKEN;
  process.env.MCP_PARENT_ONLY_TOKEN = parentOnly;
  t.after(() => {
    if (previousParentOnly === undefined) delete process.env.MCP_PARENT_ONLY_TOKEN;
    else process.env.MCP_PARENT_ONLY_TOKEN = previousParentOnly;
  });
  fs.mkdirSync(path.join(dataDir, "mcp", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "mcp", "auth", "peer.json"), JSON.stringify({
    access_token: oauthCacheToken,
    client: { client_secret: "dynamic-client-secret-canary-490c" }
  }));
  fs.writeFileSync(path.join(dataDir, "node.json"), JSON.stringify({
    remote: "https://peer.example.com",
    token: pairedNodeToken
  }));
  const calls = [];
  let constructed;
  const registry = new McpRegistry({
    dataDir,
    configPath: path.join(dataDir, "mcp.json"),
    secretStore: makeSecretStore({
      MCP_TEST_SECRET: secret,
      MCP_UNUSED_SECRET: unused
    }, calls),
    stdioClientFactory(options) {
      constructed = options;
      return fakeClient(options);
    }
  });

  const registered = registry.registerServer({
    name: "delayed",
    transport: "stdio",
    command: "node",
    args: ["server.js", "--token=${MCP_TEST_SECRET}"],
    env: {
      MCP_TEST_SECRET: "${MCP_TEST_SECRET}",
      NORMAL_VALUE: "visible"
    }
  });
  assert.equal(registered.args[1], "--token=${MCP_TEST_SECRET}");
  assert.equal(registered.env.MCP_TEST_SECRET, "${MCP_TEST_SECRET}");
  assert.equal(JSON.stringify(registered).includes(secret), false);

  const persisted = fs.readFileSync(path.join(dataDir, "mcp.json"), "utf8");
  assert.match(persisted, /\$\{MCP_TEST_SECRET\}/);
  assert.doesNotMatch(persisted, new RegExp(secret));

  const status = await registry.connect("delayed");
  assert.equal(constructed.args[1], `--token=${secret}`);
  assert.equal(constructed.env.MCP_TEST_SECRET, secret);
  assert.equal(constructed.env.NORMAL_VALUE, "visible");
  assert.deepEqual(
    calls.filter((call) => call.op === "export").at(-1).names,
    ["MCP_TEST_SECRET", "MCP_UNUSED_SECRET"],
    "one connect fetches all configured names for output redaction"
  );
  assert.match(calls.filter((call) => call.op === "export").at(-1).decidedBy, /mcp:delayed:connect/);
  assert.equal(status.args[1], "--token=${MCP_TEST_SECRET}");
  assert.equal(registry.listServers()[0].args[1], "--token=${MCP_TEST_SECRET}");
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.stringify(registry.listServers()).includes(secret), false);
  assert.equal(JSON.stringify(constructed.redactValues).includes(secret), false);
  assert.equal(constructed.redactValues.has(secret), true);
  assert.equal(constructed.redactValues.has(unused), true);
  assert.equal(
    constructed.redactValues.has(JSON.stringify(unused).slice(1, -1)),
    true
  );
  assert.equal(constructed.redactValues.has(parentOnly), true);
  assert.equal(constructed.redactValues.has(oauthCacheToken), true);
  assert.equal(constructed.redactValues.has(pairedNodeToken), true);
  assert.equal(
    redactKnownValues(
      `reflected ${unused} ${parentOnly} ${oauthCacheToken} ${pairedNodeToken}`,
      constructed.redactValues
    )
      .includes("canary"),
    false
  );
});

test("MCP resolves HTTP and OAuth credential fields at connect time", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secret-http-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const values = {
    MCP_API_KEY: "bearer-canary-552c",
    MCP_HEADER: "header-canary-a1e4",
    MCP_CLIENT_ID: "client-id-canary-7721",
    MCP_CLIENT_SECRET: "client-secret-canary-004f"
  };
  const httpOptions = [];
  const oauthOptions = [];
  const registry = new McpRegistry({
    dataDir,
    secretStore: makeSecretStore(values),
    httpClientFactory(options) {
      httpOptions.push(options);
      return fakeClient(options);
    },
    oauthClientFactory(options) {
      oauthOptions.push(options);
      return {
        options,
        ensureToken: async () => "unused-oauth-token"
      };
    }
  });

  const bearer = registry.registerServer({
    name: "bearer",
    transport: "http",
    url: "https://mcp.example.com/api",
    auth: "bearer",
    apiKey: "${MCP_API_KEY}",
    headers: { "x-service-key": "Bearer ${MCP_HEADER}" }
  });
  assert.equal(bearer.apiKey, "${MCP_API_KEY}");
  assert.equal(bearer.headers["x-service-key"], "Bearer ${MCP_HEADER}");
  await registry.connect("bearer");
  assert.equal(httpOptions[0].bearerToken, values.MCP_API_KEY);
  assert.equal(httpOptions[0].headers["x-service-key"], `Bearer ${values.MCP_HEADER}`);

  const oauth = registry.registerServer({
    name: "oauth",
    transport: "http",
    url: "https://oauth.example.com/mcp",
    auth: "oauth",
    clientId: "${MCP_CLIENT_ID}",
    clientSecret: "${MCP_CLIENT_SECRET}"
  });
  assert.equal(oauth.clientId, "${MCP_CLIENT_ID}");
  assert.equal(oauth.clientSecret, "${MCP_CLIENT_SECRET}");
  await registry.connect("oauth");
  assert.equal(oauthOptions.at(-1).clientId, values.MCP_CLIENT_ID);
  assert.equal(oauthOptions.at(-1).clientSecret, values.MCP_CLIENT_SECRET);
  assert.equal(JSON.stringify(registry.listServers()).includes(values.MCP_CLIENT_SECRET), false);
});

test("silent OAuth refresh receives audited store-resolved static credentials", async () => {
  const calls = [];
  let oauthOptions;
  const values = {
    MCP_SILENT_CLIENT_ID: "silent-client-id",
    MCP_SILENT_CLIENT_SECRET: "silent-client-secret"
  };
  const registry = new McpRegistry({
    secretStore: makeSecretStore(values, calls),
    oauthClientFactory(options) {
      oauthOptions = options;
      return {
        ensureToken: async ({ interactive }) => {
          assert.equal(interactive, false);
          return "silent-access-token";
        }
      };
    }
  });
  registry.registerServer({
    name: "silent-static",
    transport: "http",
    url: "https://silent.example.com/mcp",
    auth: "oauth",
    clientId: "${MCP_SILENT_CLIENT_ID}",
    clientSecret: "${MCP_SILENT_CLIENT_SECRET}"
  });

  assert.equal(await registry.silentTokenFor("silent-static"), "silent-access-token");
  assert.equal(oauthOptions.clientId, values.MCP_SILENT_CLIENT_ID);
  assert.equal(oauthOptions.clientSecret, values.MCP_SILENT_CLIENT_SECRET);
  const access = calls.filter((call) => call.op === "export").at(-1);
  assert.deepEqual(access.names, [
    "MCP_SILENT_CLIENT_ID",
    "MCP_SILENT_CLIENT_SECRET"
  ]);
  assert.match(access.decidedBy, /mcp:silent-static:silent-token/);
});

test("MCP rejects unknown, malformed, and literal credential sources", () => {
  const previous = process.env.HOST_ONLY_SECRET;
  process.env.HOST_ONLY_SECRET = "host-value-must-not-flow";
  try {
    const registry = new McpRegistry({
      permittedEnvKeys: new Set(),
      secretStore: makeSecretStore({})
    });
    assert.throws(() => registry.registerServer({
      name: "unknown",
      transport: "stdio",
      command: "node",
      args: ["${HOST_ONLY_SECRET}"]
    }), /not in the env allowlist/);
    assert.throws(() => registry.registerServer({
      name: "malformed",
      transport: "stdio",
      command: "node",
      args: ["${1BAD}"]
    }), /Invalid MCP env placeholder/);
    assert.throws(() => registry.registerServer({
      name: "lowercase",
      transport: "stdio",
      command: "node",
      args: ["${lowercase_secret}"]
    }), /Invalid MCP env placeholder/);
    assert.throws(() => registry.registerServer({
      name: "literal",
      transport: "http",
      url: "https://mcp.example.com/",
      auth: "bearer",
      apiKey: "raw-secret"
    }), /refusing a literal apiKey/);
  } finally {
    if (previous === undefined) delete process.env.HOST_ONLY_SECRET;
    else process.env.HOST_ONLY_SECRET = previous;
  }
});

test("MCP rejects literal credential env and headers before state or persistence", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-literal-fields-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, "mcp.json");
  const rawCanary = "raw-mcp-field-canary-771d";
  const registry = new McpRegistry({
    dataDir,
    configPath,
    secretStore: makeSecretStore({
      MCP_SAFE_TOKEN: "resolved-only-at-connect"
    })
  });

  registry.registerServer({
    name: "safe-fields",
    transport: "stdio",
    command: "node",
    args: [
      "server.js",
      "--mode",
      "readonly",
      "--api-key",
      "${MCP_SAFE_TOKEN}",
      "--header",
      "Authorization: Bearer ${MCP_SAFE_TOKEN}",
      "--header",
      "X-Region: us-east-1"
    ],
    env: {
      NODE_ENV: "production",
      SERVICE_TOKEN: "${MCP_SAFE_TOKEN}"
    }
  });
  registry.registerServer({
    name: "safe-headers",
    transport: "http",
    url: "https://safe-fields.example.com/mcp?region=us-east-1",
    headers: {
      "x-region": "us-east-1",
      "content-type": "application/json",
      "client-version": "2026-07",
      authorization: "Bearer ${MCP_SAFE_TOKEN}"
    }
  });

  assert.throws(() => registry.registerServer({
    name: "raw-env",
    transport: "stdio",
    command: "node",
    env: {
      NODE_ENV: "test",
      SERVICE_TOKEN: rawCanary
    }
  }), /env field 'SERVICE_TOKEN'.*secret placeholder/);
  assert.throws(() => registry.registerServer({
    name: "raw-header",
    transport: "http",
    url: "https://raw-fields.example.com/mcp",
    headers: {
      "x-region": "us-west-2",
      authorization: rawCanary
    }
  }), /header field 'authorization'.*secret placeholder/);
  const credentialHeaderAliases = [
    "x-auth",
    "x-token",
    "api-token",
    "x-signature",
    "x-credentials",
    "webhook-secret",
    "account-sid",
    "private-key"
  ];
  for (const header of credentialHeaderAliases) {
    assert.equal(isCredentialHeaderName(header), true, `${header} must be credential-shaped`);
  }
  assert.equal(isCredentialHeaderName("content-type"), false);
  assert.equal(isCredentialHeaderName("client-version"), false);
  for (const [index, header] of credentialHeaderAliases.entries()) {
    assert.throws(() => registry.registerServer({
      name: `raw-header-alias-${index}`,
      transport: "http",
      url: "https://raw-fields.example.com/mcp",
      headers: { [header]: rawCanary }
    }), (error) => {
      assert.match(error?.message ?? "", /secret placeholder/);
      assert.equal((error?.message ?? "").includes(rawCanary), false);
      return true;
    });
  }
  assert.throws(() => registry.registerServer({
    name: "array-env",
    transport: "stdio",
    command: "node",
    env: [`SERVICE_TOKEN=${rawCanary}`]
  }), /env must be a plain object/);
  assert.throws(() => registry.registerServer({
    name: "string-headers",
    transport: "http",
    url: "https://raw-fields.example.com/mcp",
    headers: `Authorization: Bearer ${rawCanary}`
  }), /headers must be a plain object/);
  assert.throws(() => registry.registerServer({
    name: "raw-url-query",
    transport: "http",
    url: `https://raw-fields.example.com/mcp?api_key=${rawCanary}`
  }), /credential query parameters/);
  assert.throws(() => registry.registerServer({
    name: "raw-url-userinfo",
    transport: "http",
    url: `https://user:${rawCanary}@raw-fields.example.com/mcp`
  }), /embedded credentials/);
  assert.throws(() => registry.registerServer({
    name: "raw-resource-url",
    transport: "http",
    url: "https://raw-fields.example.com/mcp",
    resourceUrl: `https://raw-fields.example.com/resource?token=${rawCanary}`
  }), /credential query parameters/);
  const unsafeArgs = [
    ["--api-key", rawCanary],
    [`--token=${rawCanary}`],
    ["--auth-token", rawCanary],
    ["--secret", rawCanary],
    ["--password", rawCanary],
    ["--authorization", `Bearer ${rawCanary}`],
    ["--header", `Authorization: Bearer ${rawCanary}`]
  ];
  for (const [index, args] of unsafeArgs.entries()) {
    assert.throws(() => registry.registerServer({
      name: `raw-arg-${index}`,
      transport: "stdio",
      command: "node",
      args
    }), /MCP argument.*secret placeholder/);
  }
  const unsafeUrlArgs = [
    [`https://public.example/mcp?token=${rawCanary}`],
    [`https://user:${rawCanary}@public.example/mcp`],
    [`--endpoint=https://public.example/mcp?api_key=${rawCanary}`]
  ];
  for (const [index, args] of unsafeUrlArgs.entries()) {
    assert.throws(() => registry.registerServer({
      name: `raw-url-arg-${index}`,
      transport: "stdio",
      command: "node",
      args
    }), (error) => {
      assert.match(error?.message ?? "", /MCP URLs must not contain/);
      assert.equal((error?.message ?? "").includes(rawCanary), false);
      return true;
    });
  }

  assert.equal(registry.servers.has("raw-env"), false);
  assert.equal(registry.servers.has("raw-header"), false);
  for (const index of credentialHeaderAliases.keys()) {
    assert.equal(registry.servers.has(`raw-header-alias-${index}`), false);
  }
  assert.equal(registry.servers.has("array-env"), false);
  assert.equal(registry.servers.has("string-headers"), false);
  assert.equal(registry.servers.has("raw-url-query"), false);
  assert.equal(registry.servers.has("raw-url-userinfo"), false);
  assert.equal(registry.servers.has("raw-resource-url"), false);
  for (const index of unsafeArgs.keys()) {
    assert.equal(registry.servers.has(`raw-arg-${index}`), false);
  }
  for (const index of unsafeUrlArgs.keys()) {
    assert.equal(registry.servers.has(`raw-url-arg-${index}`), false);
  }
  assert.equal(JSON.stringify([...registry.servers.values()]).includes(rawCanary), false);
  const persisted = fs.readFileSync(configPath, "utf8");
  assert.equal(persisted.includes(rawCanary), false);
  assert.match(persisted, /\$\{MCP_SAFE_TOKEN\}/);
  assert.match(persisted, /"NODE_ENV": "production"/);
  assert.match(persisted, /"x-region": "us-east-1"/);
  assert.match(persisted, /"content-type": "application\/json"/);
  assert.match(persisted, /"client-version": "2026-07"/);
  assert.match(persisted, /region=us-east-1/);
  assert.match(persisted, /Authorization: Bearer \$\{MCP_SAFE_TOKEN\}/);
});

test("MCP server names cannot escape OAuth cache or transport log directories", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-name-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const configPath = path.join(dataDir, "mcp.json");
  const registry = new McpRegistry({ dataDir, configPath });
  const unsafeNames = [
    "../../secrets/secrets",
    "..%2f..%2fsecrets",
    "encoded%2Fslash",
    "slash/name",
    "backslash\\name",
    "nonascii-\u0430",
    "trailing.",
    "trailing ",
    "CON",
    "con.json",
    "LPT1"
  ];

  for (const name of unsafeNames) {
    let caught;
    try {
      registry.registerServer({
        name,
        transport: "stdio",
        command: "node"
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught?.message ?? "", /Invalid MCP server name/);
    assert.equal((caught?.message ?? "").includes(name), false);
  }
  assert.equal(registry.servers.size, 0);
  assert.equal(fs.existsSync(configPath), false);

  const protectedDir = path.join(dataDir, "secrets");
  const protectedPath = path.join(protectedDir, "secrets.json");
  fs.mkdirSync(protectedDir, { recursive: true });
  fs.writeFileSync(protectedPath, "protected-canary");
  assert.throws(() => new McpOAuthClient({
    name: "../../secrets/secrets",
    resourceUrl: "https://mcp.example.com",
    dataDir
  }), /Invalid MCP server name/);
  assert.throws(() => new McpStdioClient({
    name: "../../secrets/secrets",
    logDir: path.join(dataDir, "logs")
  }), /Invalid MCP server name/);
  assert.throws(() => new McpHttpClient({
    name: "../../secrets/secrets",
    url: "https://mcp.example.com",
    logDir: path.join(dataDir, "logs")
  }), /Invalid MCP server name/);
  assert.equal(fs.readFileSync(protectedPath, "utf8"), "protected-canary");

  const authParent = path.join(dataDir, "symlinked-mcp");
  const authTarget = path.join(dataDir, "auth-target");
  const authLink = path.join(authParent, "mcp", "auth");
  fs.mkdirSync(path.dirname(authLink), { recursive: true });
  fs.mkdirSync(authTarget, { recursive: true });
  const symlinkOnlyToken = "symlink-auth-token-canary-913e";
  fs.writeFileSync(path.join(authTarget, "unsafe.json"), JSON.stringify({
    access_token: symlinkOnlyToken
  }));
  try {
    fs.symlinkSync(authTarget, authLink, "dir");
    assert.throws(() => new McpOAuthClient({
      name: "safe-name",
      resourceUrl: "https://mcp.example.com",
      dataDir: authParent
    }), /must not be a symbolic link/);
    const collected = new Set();
    addInternalCredentialFileRedactions(collected, authParent);
    assert.equal(collected.has(symlinkOnlyToken), false);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }

  const readable = registry.registerServer({
    name: "BB Staging",
    transport: "stdio",
    command: "node"
  });
  assert.equal(readable.name, "BB Staging");
  registry.registerServer({
    name: "CaseName",
    transport: "stdio",
    command: "node"
  });
  assert.throws(() => registry.registerServer({
    name: "casename",
    transport: "stdio",
    command: "node"
  }), /conflicts with an existing server/);
});

test("register_mcp_server preflight blocks credential leakage before every gate surface", async (t) => {
  const previousAutoApprove = process.env.OPENAGI_AUTO_APPROVE;
  t.after(() => {
    if (previousAutoApprove === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previousAutoApprove;
  });
  const canary = "pending-credential-canary-180f";

  for (const autoApprove of ["0", "1"]) {
    process.env.OPENAGI_AUTO_APPROVE = autoApprove;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-mcp-preflight-${autoApprove}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pending = new PendingActionStore({ dir });
    let hookCalls = 0;
    let handlerCalls = 0;
    const registry = new ToolRegistry({
      hooks: {
        async beforeToolCall() {
          hookCalls += 1;
          return { action: "allow" };
        }
      }
    });
    registry.bindPendingActions(pending);
    registerCoreTools(registry, {
      mcp: {
        registerServer() {
          handlerCalls += 1;
          return { name: "should-not-run", transport: "stdio" };
        }
      }
    });
    const observerEvents = [];
    const context = {
      sessionId: `preflight-${autoApprove}`,
      __onToolEvent: (event) => observerEvents.push(event)
    };

    const rawResult = await registry.invoke("register_mcp_server", {
      name: "preflight-test",
      transport: "stdio",
      command: "node",
      args: ["server.js", "--auth-token", canary]
    }, context);
    const unknownResult = await registry.invoke("register_mcp_server", {
      name: "preflight-test",
      transport: "stdio",
      command: "node",
      unexpected: canary
    }, context);
    const urlResult = await registry.invoke("register_mcp_server", {
      name: "preflight-url",
      transport: "http",
      url: `https://mcp.example.com/path?token=${canary}`
    }, context);
    const positionalUrlResult = await registry.invoke("register_mcp_server", {
      name: "preflight-positional-url",
      transport: "stdio",
      command: "node",
      args: [`https://public.example/mcp?token=${canary}`]
    }, context);

    assert.equal(rawResult.ok, false);
    assert.equal(unknownResult.ok, false);
    assert.equal(urlResult.ok, false);
    assert.equal(positionalUrlResult.ok, false);
    assert.equal(
      JSON.stringify([rawResult, unknownResult, urlResult, positionalUrlResult]).includes(canary),
      false
    );
    assert.equal(handlerCalls, 0);
    assert.equal(hookCalls, 0);
    assert.deepEqual(observerEvents, []);
    assert.deepEqual(pending.list(), []);
    const journalPath = path.join(dir, "journal.jsonl");
    const journal = fs.existsSync(journalPath)
      ? fs.readFileSync(journalPath, "utf8")
      : "";
    assert.equal(journal.includes(canary), false);
    assert.equal(journal, "");
    assert.equal(
      Object.hasOwn(
        registry.list().find((tool) => tool.name === "register_mcp_server"),
        "preflight"
      ),
      false
    );
  }

  let summaryError;
  try {
    summarizeRegisterMcpServer({
      name: "direct-summary",
      transport: "stdio",
      command: "node",
      args: ["--api-key", canary]
    });
  } catch (error) {
    summaryError = error;
  }
  assert.match(summaryError?.message ?? "", /secret placeholder/);
  assert.equal((summaryError?.message ?? "").includes(canary), false);

  const valid = {
    name: "valid-preflight",
    transport: "stdio",
    command: "node",
    args: ["server.js", "--mode", "readonly", "--token", "${VALID_TOKEN}"]
  };
  const before = structuredClone(valid);
  assert.equal(preflightRegisterMcpServer(valid), true);
  assert.deepEqual(valid, before);
});

test("connect_catalog_mcp preflight rejects legacy credentials before every gate surface", async (t) => {
  const previousAutoApprove = process.env.OPENAGI_AUTO_APPROVE;
  t.after(() => {
    if (previousAutoApprove === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previousAutoApprove;
  });
  const canary = "catalog-credential-canary-8a2f";

  for (const autoApprove of ["0", "1"]) {
    process.env.OPENAGI_AUTO_APPROVE = autoApprove;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-catalog-preflight-${autoApprove}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pending = new PendingActionStore({ dir });
    let hookCalls = 0;
    let handlerCalls = 0;
    const registry = new ToolRegistry({
      hooks: {
        async beforeToolCall() {
          hookCalls += 1;
          return { action: "allow" };
        }
      }
    });
    registry.bindPendingActions(pending);
    registerCoreTools(registry, {
      mcp: {
        registerServer() {
          handlerCalls += 1;
          return { name: "should-not-run", transport: "http" };
        }
      }
    });
    const observerEvents = [];
    const result = await registry.invoke("connect_catalog_mcp", {
      catalogId: "stripe",
      apiKey: canary
    }, {
      sessionId: `catalog-preflight-${autoApprove}`,
      __onToolEvent: (event) => observerEvents.push(event)
    });

    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(handlerCalls, 0);
    assert.equal(hookCalls, 0);
    assert.deepEqual(observerEvents, []);
    assert.deepEqual(pending.list(), []);
    const journalPath = path.join(dir, "journal.jsonl");
    const journal = fs.existsSync(journalPath)
      ? fs.readFileSync(journalPath, "utf8")
      : "";
    assert.equal(journal, "");
    assert.equal(
      Object.hasOwn(
        registry.list().find((tool) => tool.name === "connect_catalog_mcp"),
        "preflight"
      ),
      false
    );
  }

  const valid = { catalogId: "stripe" };
  const before = structuredClone(valid);
  assert.equal(preflightConnectCatalogMcp(valid), true);
  assert.deepEqual(valid, before);
  assert.throws(
    () => preflightConnectCatalogMcp({ catalogId: 1 }),
    /Invalid MCP catalog connection request/
  );
});

test("audit sanitization masks legacy credential-shaped argument arrays", (t) => {
  const canary = "legacy-pending-canary-735c";
  const original = {
    args: [
      "server.js",
      "--token",
      canary,
      "--auth-token",
      canary,
      `--api-key=${canary}`,
      "--authorization",
      `Bearer ${canary}`,
      "--header",
      `Authorization: Bearer ${canary}`,
      `Proxy-Authorization: Basic ${canary}`,
      "--header",
      `X-Auth: ${canary}`,
      "--header",
      `X-Token: ${canary}`,
      "--header",
      `API-Token: ${canary}`,
      "--header",
      `X-Signature: ${canary}`,
      "--header",
      `X-Credentials: ${canary}`,
      "--header",
      `Webhook-Secret: ${canary}`,
      "--header",
      `Account-Sid: ${canary}`,
      "--header",
      `Private-Key: ${canary}`,
      "--header",
      "X-Region: us-east-1",
      "--token",
      "${SAFE_TOKEN}"
    ]
  };
  const safe = sanitizeForAudit(original);
  assert.equal(JSON.stringify(safe).includes(canary), false);
  assert.match(JSON.stringify(safe), /\[REDACTED\]/);
  assert.equal(safe.args.includes("X-Region: us-east-1"), true);
  assert.equal(safe.args.includes("${SAFE_TOKEN}"), true);
  assert.equal(JSON.stringify(original).includes(canary), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-legacy-pending-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pending = new PendingActionStore({ dir });
  pending.enqueue({
    toolName: "register_mcp_server",
    args: original,
    context: {},
    summary: "legacy"
  });
  const journal = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
  assert.equal(journal.includes(canary), false);
  assert.equal(JSON.stringify(sanitizeForAudit(pending.list())).includes(canary), false);
});

test("secret-store failures cross execution and model boundaries as generic errors", async () => {
  const canary = "corrupt-store-error-canary-04df";
  const failingListStore = {
    listAllowedNames() {
      return [];
    },
    listSecretNames() {
      throw new Error(`parse failed near ${canary}`);
    }
  };
  const definitions = new Map();
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, { secrets: failingListStore }, {
    runShell: async () => ({ code: 0, stdout: "", stderr: "" }),
    runTest: async () => ({ ok: true, stdout: "", stderr: "" })
  });
  const isSafeExecutionError = (error) => {
    assert.match(error.message, /Secret store unavailable for execution/);
    assert.equal(error.message.includes(canary), false);
    return true;
  };
  await assert.rejects(
    definitions.get("code_shell").handler({ command: "printf ok" }, {}),
    isSafeExecutionError
  );
  await assert.rejects(
    definitions.get("code_test").handler({}, {}),
    isSafeExecutionError
  );

  const listRegistry = new McpRegistry({ secretStore: failingListStore });
  let listError;
  try {
    listRegistry.registerServer({
      name: "store-list-failure",
      transport: "stdio",
      command: "node"
    });
  } catch (error) {
    listError = error;
  }
  assert.match(listError?.message ?? "", /MCP secret store unavailable/);
  assert.equal((listError?.message ?? "").includes(canary), false);

  let clientConstructed = false;
  const exportRegistry = new McpRegistry({
    secretStore: {
      listAllowedNames() {
        return ["BROKEN_EXPORT_TOKEN"];
      },
      listSecretNames() {
        return ["BROKEN_EXPORT_TOKEN"];
      },
      exportEnv() {
        throw new Error(`decrypt failed near ${canary}`);
      }
    },
    stdioClientFactory() {
      clientConstructed = true;
      return fakeClient({});
    }
  });
  exportRegistry.registerServer({
    name: "store-export-failure",
    transport: "stdio",
    command: "node",
    args: ["--token", "${BROKEN_EXPORT_TOKEN}"]
  });
  await assert.rejects(exportRegistry.connect("store-export-failure"), (error) => {
    assert.match(error.message, /MCP secret store unavailable/);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
  assert.equal(clientConstructed, false);

  const tools = new ToolRegistry();
  registerCoreTools(tools, {
    secrets: failingListStore,
    mcp: {
      allowEnvKey() {},
      registerServer() {
        throw new Error("must not register");
      }
    }
  });
  await assert.rejects(
    tools.get("connect_catalog_mcp").handler({ catalogId: "stripe" }, { agentId: "test" }),
    (error) => {
      assert.match(error.message, /Secret store unavailable for catalog connection/);
      assert.equal(error.message.includes(canary), false);
      return true;
    }
  );
});

test("MCP preserves explicitly permitted process env fallback until connect", async () => {
  const previous = process.env.LEGACY_MCP_SECRET;
  process.env.LEGACY_MCP_SECRET = "legacy-connect-canary";
  let constructed;
  try {
    const registry = new McpRegistry({
      permittedEnvKeys: new Set(["LEGACY_MCP_SECRET"]),
      stdioClientFactory(options) {
        constructed = options;
        return fakeClient(options);
      }
    });
    const registered = registry.registerServer({
      name: "legacy",
      transport: "stdio",
      command: "node",
      args: ["${LEGACY_MCP_SECRET}"]
    });
    assert.equal(registered.args[0], "${LEGACY_MCP_SECRET}");
    await registry.connect("legacy");
    assert.equal(constructed.args[0], "legacy-connect-canary");
  } finally {
    if (previous === undefined) delete process.env.LEGACY_MCP_SECRET;
    else process.env.LEGACY_MCP_SECRET = previous;
  }
});

test("a bound secret store prevents allowEnvKey from bypassing audited resolution", async () => {
  const previous = process.env.BYPASS_MCP_SECRET;
  process.env.BYPASS_MCP_SECRET = "must-not-reach-client";
  let constructed = false;
  try {
    const registry = new McpRegistry({
      secretStore: makeSecretStore({}),
      stdioClientFactory(options) {
        constructed = true;
        return fakeClient(options);
      }
    });
    assert.throws(() => registry.allowEnvKey("1INVALID"), /Invalid MCP env name/);
    registry.allowEnvKey("BYPASS_MCP_SECRET");
    registry.registerServer({
      name: "no-bypass",
      transport: "stdio",
      command: "node",
      args: ["${BYPASS_MCP_SECRET}"]
    });
    await assert.rejects(
      registry.connect("no-bypass"),
      /Secret value unavailable/
    );
    assert.equal(constructed, false);
  } finally {
    if (previous === undefined) delete process.env.BYPASS_MCP_SECRET;
    else process.env.BYPASS_MCP_SECRET = previous;
  }
});

test("legacy .env names retain process fallback with a bound secret store", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-legacy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, ".env"), "LEGACY_CUSTOM_MCP=legacy-custom-value\n");
  const previous = process.env.LEGACY_CUSTOM_MCP;
  process.env.LEGACY_CUSTOM_MCP = "legacy-custom-value";
  t.after(() => {
    if (previous === undefined) delete process.env.LEGACY_CUSTOM_MCP;
    else process.env.LEGACY_CUSTOM_MCP = previous;
  });
  let constructed;
  const registry = new McpRegistry({
    dataDir,
    secretStore: makeSecretStore({}),
    stdioClientFactory(options) {
      constructed = options;
      return fakeClient(options);
    }
  });
  registry.registerServer({
    name: "legacy-store",
    transport: "stdio",
    command: "node",
    args: ["${LEGACY_CUSTOM_MCP}"]
  });
  await registry.connect("legacy-store");
  assert.equal(constructed.args[0], "legacy-custom-value");
});

test("managed .env names cannot resurrect a value removed from the store", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-removed-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, ".env"), "MANAGED_REMOVED_SECRET=stale-projection\n");
  const previous = process.env.MANAGED_REMOVED_SECRET;
  process.env.MANAGED_REMOVED_SECRET = "externally-resurrected-value";
  t.after(() => {
    if (previous === undefined) delete process.env.MANAGED_REMOVED_SECRET;
    else process.env.MANAGED_REMOVED_SECRET = previous;
  });
  let constructed = false;
  const registry = new McpRegistry({
    dataDir,
    secretStore: makeSecretStore({}, [], ["MANAGED_REMOVED_SECRET"]),
    stdioClientFactory(options) {
      constructed = true;
      return fakeClient(options);
    }
  });
  registry.registerServer({
    name: "removed",
    transport: "stdio",
    command: "node",
    args: ["${MANAGED_REMOVED_SECRET}"]
  });
  await assert.rejects(registry.connect("removed"), /Secret value unavailable/);
  assert.equal(constructed, false);
});

test("code_shell injects only referenced managed secrets and redacts child output", async (t) => {
  const previousManaged = process.env.SHELL_UNUSED_SECRET;
  const previousOsOnly = process.env.SHELL_OS_ONLY_SECRET;
  const previousUnmanaged = process.env.OPENAGI_INJECTION_UNMANAGED;
  const previousUnmanagedToken = process.env.SHELL_UNMANAGED_TOKEN;
  process.env.SHELL_UNUSED_SECRET = "hydrated-unused-canary";
  process.env.SHELL_OS_ONLY_SECRET = "os-only-managed-canary";
  process.env.OPENAGI_INJECTION_UNMANAGED = "inherited-visible";
  process.env.SHELL_UNMANAGED_TOKEN = "unmanaged-shell-token";
  t.after(() => {
    if (previousManaged === undefined) delete process.env.SHELL_UNUSED_SECRET;
    else process.env.SHELL_UNUSED_SECRET = previousManaged;
    if (previousOsOnly === undefined) delete process.env.SHELL_OS_ONLY_SECRET;
    else process.env.SHELL_OS_ONLY_SECRET = previousOsOnly;
    if (previousUnmanaged === undefined) delete process.env.OPENAGI_INJECTION_UNMANAGED;
    else process.env.OPENAGI_INJECTION_UNMANAGED = previousUnmanaged;
    if (previousUnmanagedToken === undefined) delete process.env.SHELL_UNMANAGED_TOKEN;
    else process.env.SHELL_UNMANAGED_TOKEN = previousUnmanagedToken;
  });

  const referenced = "shell-canary-a99c";
  const unused = "shell-unused-31d0";
  const calls = [];
  const definitions = new Map();
  let spawned;
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, {
    secrets: makeSecretStore({
      SHELL_REFERENCED_SECRET: referenced,
      SHELL_UNUSED_SECRET: unused
    }, calls, [
      "SHELL_REFERENCED_SECRET",
      "SHELL_UNUSED_SECRET",
      "SHELL_OS_ONLY_SECRET"
    ])
  }, {
    runShell: async (command, args, options) => {
      spawned = { command, args, options };
      return {
        code: 0,
        stdout: `${"x".repeat(50)}${options.env.SHELL_REFERENCED_SECRET}${"y".repeat(5980)}`,
        stderr: `reflected ${referenced} unmanaged-shell-token`
      };
    }
  });

  const shell = definitions.get("code_shell");
  assert.equal(shell.needsConfirmation, true);
  const result = await shell.handler({
    command: "printf '%s' \"$SHELL_REFERENCED_SECRET ${SHELL_REFERENCED_SECRET}\""
  }, { from: "test-user" });
  assert.equal(spawned.options.env.SHELL_REFERENCED_SECRET, referenced);
  assert.equal("SHELL_UNUSED_SECRET" in spawned.options.env, false);
  assert.equal("SHELL_OS_ONLY_SECRET" in spawned.options.env, false);
  assert.equal("SHELL_UNMANAGED_TOKEN" in spawned.options.env, false);
  assert.equal(spawned.options.env.OPENAGI_INJECTION_UNMANAGED, "inherited-visible");
  assert.deepEqual(calls.filter((call) => call.op === "export").at(-1).names, [
    "SHELL_REFERENCED_SECRET",
    "SHELL_UNUSED_SECRET"
  ]);
  assert.equal(calls.filter((call) => call.op === "export").at(-1).decidedBy, "test-user");
  assert.equal(JSON.stringify(result).includes(referenced), false);
  assert.equal(JSON.stringify(result).includes("unmanaged-shell-token"), false);
  assert.equal(result.stdout.includes(referenced.slice(-8)), false);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.match(result.stderr, /\[REDACTED\]/);
});

test("code_shell scrubs all managed secrets when none are referenced", async () => {
  const definitions = new Map();
  let childEnv;
  const calls = [];
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, {
    secrets: makeSecretStore({
      SHELL_FIRST_SECRET: "first-secret",
      SHELL_SECOND_SECRET: "second-secret"
    }, calls)
  }, {
    runShell: async (_command, _args, options) => {
      childEnv = options.env;
      return { code: 0, stdout: "ok", stderr: "" };
    }
  });

  await definitions.get("code_shell").handler({ command: "printf ok" }, {});
  assert.equal("SHELL_FIRST_SECRET" in childEnv, false);
  assert.equal("SHELL_SECOND_SECRET" in childEnv, false);
  assert.deepEqual(calls.filter((call) => call.op === "export").at(-1).names, [
    "SHELL_FIRST_SECRET",
    "SHELL_SECOND_SECRET"
  ]);
});

test("code_shell redacts literal secret snapshot reads without injecting values", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-shell-snapshot-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secret = "quote\"line\nslash\\snapshot-canary";
  const escaped = JSON.stringify(secret).slice(1, -1);
  const oauthToken = "shell-oauth-cache-canary-6ae1";
  const dynamicClientSecret = "shell-dynamic-client-canary-01c7";
  const nodeToken = "shell-node-token-canary-b113";
  const legacyMcpToken = "shell-legacy-mcp-canary-9bd2";
  const legacyMcpUrlToken = "shell-legacy-mcp-url-canary-27aa";
  fs.mkdirSync(path.join(dataDir, "mcp", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "mcp", "auth", "server.json"), JSON.stringify({
    access_token: oauthToken,
    refresh_token: "shell-refresh-token-canary-413c",
    client: { client_secret: dynamicClientSecret }
  }));
  fs.writeFileSync(path.join(dataDir, "node.json"), JSON.stringify({
    remote: "https://peer.example.com",
    token: nodeToken
  }));
  fs.writeFileSync(path.join(dataDir, "mcp.json"), JSON.stringify({
    servers: {
      legacy: {
        command: "node",
        args: [
          "server.js",
          "--auth-token",
          legacyMcpToken,
          `https://public.example/mcp?token=${legacyMcpUrlToken}`
        ],
        headers: { authorization: `Bearer ${legacyMcpToken}` }
      }
    }
  }));
  const definitions = new Map();
  let childEnv;
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, {
    dataDir,
    secrets: makeSecretStore({
      SNAPSHOT_SECRET_TOKEN: secret
    })
  }, {
    runShell: async (_command, _args, options) => {
      childEnv = options.env;
      return {
        code: 0,
        stdout: JSON.stringify({
          SNAPSHOT_SECRET_TOKEN: secret,
          access_token: oauthToken,
          client_secret: dynamicClientSecret,
          node_token: nodeToken,
          legacy_mcp_token: legacyMcpToken,
          legacy_mcp_url_token: legacyMcpUrlToken
        }),
        stderr: `snapshot=${escaped} refresh=shell-refresh-token-canary-413c`
      };
    }
  });

  const result = await definitions.get("code_shell").handler({
    command: `cat ${path.join(dataDir, "secrets", "secrets.json")}`
  }, {});
  assert.equal("SNAPSHOT_SECRET_TOKEN" in childEnv, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(escaped), false);
  assert.equal(JSON.stringify(result).includes(oauthToken), false);
  assert.equal(JSON.stringify(result).includes(dynamicClientSecret), false);
  assert.equal(JSON.stringify(result).includes(nodeToken), false);
  assert.equal(JSON.stringify(result).includes(legacyMcpToken), false);
  assert.equal(JSON.stringify(result).includes(legacyMcpUrlToken), false);
  assert.equal(JSON.stringify(result).includes("shell-refresh-token-canary-413c"), false);
  assert.match(`${result.stdout}\n${result.stderr}`, /\[REDACTED\]/);
});

test("code_test scrubs configured and policy-only secrets without injecting any", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-code-test-redact-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oauthToken = "test-oauth-cache-canary-2c77";
  const nodeToken = "test-node-token-canary-f028";
  const legacyMcpToken = "test-legacy-mcp-canary-814a";
  fs.mkdirSync(path.join(dataDir, "mcp", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "mcp", "auth", "server.json"), JSON.stringify({
    access_token: oauthToken
  }));
  fs.writeFileSync(path.join(dataDir, "node.json"), JSON.stringify({
    remote: "https://peer.example.com",
    token: nodeToken
  }));
  fs.writeFileSync(path.join(dataDir, "mcp.json"), JSON.stringify({
    servers: {
      legacy: {
        apiKey: legacyMcpToken
      }
    }
  }));
  const previousConfigured = process.env.CODE_TEST_CONFIGURED_SECRET;
  const previousPolicyOnly = process.env.CODE_TEST_POLICY_SECRET;
  const previousUnmanaged = process.env.CODE_TEST_UNMANAGED;
  const previousUnmanagedToken = process.env.CODE_TEST_UNMANAGED_TOKEN;
  const previousAutoApprove = process.env.OPENAGI_AUTO_APPROVE;
  process.env.CODE_TEST_CONFIGURED_SECRET = "configured-test-canary";
  process.env.CODE_TEST_POLICY_SECRET = "policy-test-canary";
  process.env.CODE_TEST_UNMANAGED = "ordinary-inherited-value";
  process.env.CODE_TEST_UNMANAGED_TOKEN = "unmanaged-test-token";
  process.env.OPENAGI_AUTO_APPROVE = "1";
  t.after(() => {
    if (previousConfigured === undefined) delete process.env.CODE_TEST_CONFIGURED_SECRET;
    else process.env.CODE_TEST_CONFIGURED_SECRET = previousConfigured;
    if (previousPolicyOnly === undefined) delete process.env.CODE_TEST_POLICY_SECRET;
    else process.env.CODE_TEST_POLICY_SECRET = previousPolicyOnly;
    if (previousUnmanaged === undefined) delete process.env.CODE_TEST_UNMANAGED;
    else process.env.CODE_TEST_UNMANAGED = previousUnmanaged;
    if (previousUnmanagedToken === undefined) delete process.env.CODE_TEST_UNMANAGED_TOKEN;
    else process.env.CODE_TEST_UNMANAGED_TOKEN = previousUnmanagedToken;
    if (previousAutoApprove === undefined) delete process.env.OPENAGI_AUTO_APPROVE;
    else process.env.OPENAGI_AUTO_APPROVE = previousAutoApprove;
  });

  const calls = [];
  const definitions = new Map();
  let testEnv;
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, {
    dataDir,
    secrets: makeSecretStore({
      CODE_TEST_CONFIGURED_SECRET: "configured-test-canary",
      OPENAGI_AUTO_APPROVE: "1"
    }, calls, [
      "CODE_TEST_CONFIGURED_SECRET",
      "CODE_TEST_POLICY_SECRET",
      "OPENAGI_AUTO_APPROVE"
    ])
  }, {
    runTest: async (_command, _args, options) => {
      testEnv = options.env;
      return {
        ok: true,
        code: 0,
        stdout: `# pass 1\n# fail 0\nconfigured-test-canary\nunmanaged-test-token\n${oauthToken}`,
        stderr: `configured-test-canary unmanaged-test-token ${nodeToken} ${legacyMcpToken}`
      };
    }
  });

  const result = await definitions.get("code_test").handler({}, { from: "test-user" });
  assert.equal(result.ok, true);
  assert.equal(result.pass, 1);
  assert.equal(result.fail, 0);
  assert.equal("CODE_TEST_CONFIGURED_SECRET" in testEnv, false);
  assert.equal("CODE_TEST_POLICY_SECRET" in testEnv, false);
  assert.equal("OPENAGI_AUTO_APPROVE" in testEnv, false);
  assert.equal("CODE_TEST_UNMANAGED_TOKEN" in testEnv, false);
  assert.equal(testEnv.CODE_TEST_UNMANAGED, "ordinary-inherited-value");
  assert.equal(testEnv.OPENAGI_TEST, "1");
  assert.equal(result.tail.includes("configured-test-canary"), false);
  assert.equal(result.tail.includes("unmanaged-test-token"), false);
  assert.equal(result.tail.includes(oauthToken), false);
  assert.equal(result.tail.includes(nodeToken), false);
  assert.equal(result.tail.includes(legacyMcpToken), false);
  assert.match(result.tail, /\[REDACTED\]/);
  assert.deepEqual(calls.filter((call) => call.op === "export").at(-1).names, [
    "CODE_TEST_CONFIGURED_SECRET"
  ]);
});

test("direct code tools deny credential files and skip them during recursive search", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-code-sensitive-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secretsDir = path.join(dataDir, "secrets");
  const authDir = path.join(dataDir, "mcp", "auth");
  const checkpointDir = path.join(dataDir, "checkpoints", "blobs");
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(checkpointDir, { recursive: true });
  const canary = "direct-read-secret-canary";
  const secretPath = path.join(secretsDir, "secrets.json");
  const authPath = path.join(authDir, "server.json");
  const checkpointPath = path.join(checkpointDir, "credential-copy");
  const nodeConfigPath = path.join(dataDir, "node.json");
  const mcpConfigPath = path.join(dataDir, "mcp.json");
  const nodeCachePath = path.join(dataDir, "nodes", "cache.json");
  fs.writeFileSync(secretPath, canary);
  fs.writeFileSync(authPath, canary);
  fs.writeFileSync(checkpointPath, canary);
  fs.writeFileSync(nodeConfigPath, JSON.stringify({ token: canary }));
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ servers: { legacy: { apiKey: canary } } }));
  fs.mkdirSync(path.dirname(nodeCachePath), { recursive: true });
  fs.writeFileSync(nodeCachePath, JSON.stringify({ reflected: canary }));
  fs.writeFileSync(path.join(dataDir, ".env"), `TOKEN=${canary}\n`);
  fs.writeFileSync(path.join(dataDir, ".env.local"), `TOKEN=${canary}\n`);
  fs.writeFileSync(path.join(dataDir, ".envrc"), `TOKEN=${canary}\n`);
  fs.writeFileSync(path.join(dataDir, ".env.example"), "TOKEN=example\n");
  fs.writeFileSync(path.join(dataDir, "visible.txt"), "ordinary content\n");

  const definitions = new Map();
  registerCodeTools({
    register(definition) {
      definitions.set(definition.name, definition);
    }
  }, { dataDir });

  for (const target of [
    secretPath,
    authPath,
    checkpointPath,
    nodeConfigPath,
    mcpConfigPath,
    nodeCachePath,
    path.join(dataDir, ".env"),
    path.join(dataDir, ".env.local"),
    path.join(dataDir, ".envrc")
  ]) {
    await assert.rejects(
      definitions.get("code_read").handler({ path: target }),
      /Sensitive credential path/
    );
  }
  const example = await definitions.get("code_read").handler({
    path: path.join(dataDir, ".env.example")
  });
  assert.match(example.content, /TOKEN=example/);

  await assert.rejects(
    definitions.get("code_write").handler({
      path: path.join(secretsDir, "new-secret.txt"),
      content: "blocked"
    }),
    /Sensitive credential path/
  );
  await assert.rejects(
    definitions.get("code_lint").handler({ path: authDir }),
    /Sensitive credential path/
  );

  const search = await definitions.get("code_search").handler({
    dir: dataDir,
    pattern: canary
  });
  assert.deepEqual(search.matches, []);
  assert.equal(JSON.stringify(search).includes(canary), false);

  const linkPath = path.join(dataDir, "innocent-link.txt");
  try {
    fs.symlinkSync(secretPath, linkPath);
  } catch {
    t.skip("symlink creation unavailable");
    return;
  }
  await assert.rejects(
    definitions.get("code_read").handler({ path: linkPath }),
    /Sensitive credential path/
  );
});

test("known-value redaction covers keys and JSON primitives without mutating input", () => {
  const input = {
    secretKey: "secret-value",
    count: 1,
    enabled: true,
    nested: ["secret-value", 2, false]
  };
  const redacted = redactKnownValues(input, ["secret", "secret-value", "1", "true"]);
  assert.deepEqual(input, {
    secretKey: "secret-value",
    count: 1,
    enabled: true,
    nested: ["secret-value", 2, false]
  });
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
  assert.equal(redacted.count, "[REDACTED]");
  assert.equal(redacted.enabled, "[REDACTED]");
  assert.equal(redacted.nested[1], 2);
});

test("known-value redaction never emits a marker containing a short secret", () => {
  const secrets = ["[REDACTED]", "[HIDDEN]", "*"];
  const redacted = redactKnownValues(
    "one=[REDACTED] two=[HIDDEN] three=*",
    secrets
  );
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
});

test("MCP transports redact reflected injected values from results, errors, and logs", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-redact-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secret = "transport-reflection-canary-771b";
  const stdio = new McpStdioClient({
    name: "stdio-redact",
    logDir: dataDir,
    redactValues: [secret, "1", "true"]
  });
  const result = new Promise((resolve, reject) => {
    stdio.pending.set(7, { resolve, reject, method: "tools/call" });
  });
  stdio.handleMessage({
    id: 7,
    result: {
      [secret]: secret,
      numeric: 1,
      boolean: true
    }
  });
  const safeResult = await result;
  assert.equal(JSON.stringify(safeResult).includes(secret), false);
  assert.equal(safeResult.numeric, "[REDACTED]");
  assert.equal(safeResult.boolean, "[REDACTED]");
  const splitAt = Math.floor(secret.length / 2);
  stdio.handleStderr(`child reflected ${secret.slice(0, splitAt)}`);
  stdio.handleStderr(`${secret.slice(splitAt)}\n`);
  stdio.flushStderr();
  const stdioLog = fs.readFileSync(path.join(dataDir, "stdio-redact.jsonl"), "utf8");
  assert.equal(stdioLog.includes(secret), false);
  assert.equal(stdioLog.includes(secret.slice(0, splitAt)), false);
  assert.equal(stdioLog.includes(secret.slice(splitAt)), false);

  const http = new McpHttpClient({
    name: "http-redact",
    url: "https://mcp.example.com/",
    redactValues: [secret, "1", "true"]
  });
  http.sessionId = secret;
  assert.equal(http.status().sessionId.includes(secret), false);
  http.sessionId = "independent-session-capability-4fa1";
  assert.equal(
    http.status().sessionId.includes("independent-session-capability-4fa1"),
    false
  );
  const safeHttp = http.unwrap({
    id: 1,
    result: { value: secret, numeric: 1, boolean: true }
  }, 1);
  assert.equal(JSON.stringify(safeHttp).includes(secret), false);
  assert.equal(safeHttp.numeric, "[REDACTED]");
  assert.throws(() => http.unwrap({
    id: 2,
    error: { message: `remote echoed ${secret}`, data: { secret } }
  }, 2), (error) => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error.data).includes(secret), false);
    return true;
  });
});

test("computer-use node responses cannot reflect the managed bearer token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-computer-node-redact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = "computer\"node\\token-canary-71b8";
  const previousNode = process.env.OPENAGI_COMPUTER_NODE;
  const previousToken = process.env.OPENAGI_COMPUTER_NODE_TOKEN;
  process.env.OPENAGI_COMPUTER_NODE = "https://computer-node.example";
  process.env.OPENAGI_COMPUTER_NODE_TOKEN = token;
  t.after(() => {
    if (previousNode === undefined) delete process.env.OPENAGI_COMPUTER_NODE;
    else process.env.OPENAGI_COMPUTER_NODE = previousNode;
    if (previousToken === undefined) delete process.env.OPENAGI_COMPUTER_NODE_TOKEN;
    else process.env.OPENAGI_COMPUTER_NODE_TOKEN = previousToken;
  });

  const registry = new ToolRegistry();
  const log = new ComputerUseLog({ dir });
  const seenAuth = [];
  let calls = 0;
  registerComputerUseTools(registry, {
    tools: registry,
    computerUseLog: log,
    observations: { search: async () => [] }
  }, {
    fetchImpl: async (_url, options) => {
      calls += 1;
      seenAuth.push(options.headers.authorization);
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            base64: token,
            format: "png",
            width: 100,
            height: 50,
            bytes: 10
          })
        };
      }
      if (calls === 2) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: `node reflected ${token}` })
        };
      }
      throw new Error(JSON.stringify({ authorization: `Bearer ${token}` }));
    }
  });
  const session = await registry.get("start_computer_use_session").handler({
    goal: "verify node redaction"
  });
  const screenshot = await registry.get("computer_screenshot").handler({
    reasoning: "inspect"
  });
  assert.equal(JSON.stringify(screenshot).includes(token), false);
  assert.match(screenshot.image, /\[(?:REDACTED|HIDDEN)\]/);

  for (const invocation of [
    () => registry.get("computer_click").handler({ x: 1, y: 2, reasoning: "click" }),
    () => registry.get("computer_screenshot").handler({ reasoning: "inspect again" })
  ]) {
    await assert.rejects(invocation, (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /\[(?:REDACTED|HIDDEN)\]/);
      return true;
    });
  }
  assert.deepEqual(seenAuth, Array(3).fill(`Bearer ${token}`));
  assert.equal(JSON.stringify(log.listActions({ sessionId: session.sessionId })).includes(token), false);
  assert.equal(fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").includes(token), false);
});

test("iMessage node responses cannot reflect the managed bearer token", async (t) => {
  const token = "imessage\"node\\token-canary-39af";
  const previousNode = process.env.OPENAGI_IMESSAGE_NODE;
  const previousToken = process.env.OPENAGI_IMESSAGE_NODE_TOKEN;
  process.env.OPENAGI_IMESSAGE_NODE = "https://imessage-node.example";
  process.env.OPENAGI_IMESSAGE_NODE_TOKEN = token;
  t.after(() => {
    if (previousNode === undefined) delete process.env.OPENAGI_IMESSAGE_NODE;
    else process.env.OPENAGI_IMESSAGE_NODE = previousNode;
    if (previousToken === undefined) delete process.env.OPENAGI_IMESSAGE_NODE_TOKEN;
    else process.env.OPENAGI_IMESSAGE_NODE_TOKEN = previousToken;
  });

  const registry = new ToolRegistry();
  const seenAuth = [];
  let calls = 0;
  registerImessageSearchTool({ tools: registry }, {
    fetchImpl: async (_url, options) => {
      calls += 1;
      seenAuth.push(options.headers.authorization);
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{
              handle: "+15551234567",
              fromMe: false,
              date: "2026-07-23T12:00:00Z",
              text: `message reflected ${token}`
            }]
          })
        };
      }
      if (calls === 2) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: `node reflected ${token}` })
        };
      }
      throw new Error(JSON.stringify({ authorization: `Bearer ${token}` }));
    }
  });

  for (const query of ["success", "remote-error", "transport-error"]) {
    const output = await registry.invoke("search_imessages", { query });
    assert.equal(output.ok, true);
    assert.equal(JSON.stringify(output).includes(token), false);
    assert.match(JSON.stringify(output), /\[(?:REDACTED|HIDDEN)\]/);
  }
  assert.deepEqual(seenAuth, Array(3).fill(`Bearer ${token}`));
});

test("remote CLI and Discord HTTP responses redact their managed tokens", async (t) => {
  const remoteToken = "remote\"node\\token-canary-08c1";
  const escapedRemoteToken = JSON.stringify(remoteToken).slice(1, -1);
  const cliAuth = [];
  let cliCalls = 0;
  const client = new CliClient({
    url: "https://main.example",
    token: remoteToken,
    source: "test",
    remote: true
  }, {
    fetchImpl: async (_url, options) => {
      cliCalls += 1;
      cliAuth.push(options.headers.authorization);
      if (cliCalls === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            reply: `main reflected ${remoteToken}`
          })
        };
      }
      throw new Error(`transport reflected ${remoteToken}`);
    }
  });
  const cliSuccess = await client.chat("hello");
  const cliError = await client.chat("again");
  assert.equal(JSON.stringify(cliSuccess).includes(remoteToken), false);
  assert.equal(JSON.stringify(cliError).includes(remoteToken), false);
  assert.equal(cliSuccess.text.includes(escapedRemoteToken), false);
  assert.equal(cliSuccess.text.includes(remoteToken), false);
  assert.match(JSON.stringify(cliSuccess), /\[(?:REDACTED|HIDDEN)\]/);
  assert.match(cliError.error, /\[(?:REDACTED|HIDDEN)\]/);
  assert.deepEqual(cliAuth, Array(2).fill(`Bearer ${remoteToken}`));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-discord-token-redact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const discordToken = "discord\"bot\\token-canary-2fd4";
  const discordAuth = [];
  let discordCalls = 0;
  const channel = new DiscordChannel({
    token: discordToken,
    dir,
    fetch: async (_url, options) => {
      discordCalls += 1;
      discordAuth.push(options.headers.authorization);
      if (discordCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: `Discord reflected ${discordToken}` })
        };
      }
      if (discordCalls === 2) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: `Discord reflected ${discordToken}` })
        };
      }
      throw new Error(JSON.stringify({ authorization: `Bot ${discordToken}` }));
    }
  });
  const discordSuccess = await channel.rest("/redaction-test");
  assert.equal(JSON.stringify(discordSuccess).includes(discordToken), false);
  assert.match(JSON.stringify(discordSuccess), /\[(?:REDACTED|HIDDEN)\]/);
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(() => channel.rest("/redaction-test"), (error) => {
      assert.equal(error.message.includes(discordToken), false);
      assert.match(error.message, /\[(?:REDACTED|HIDDEN)\]/);
      return true;
    });
  }
  assert.deepEqual(discordAuth, Array(3).fill(`Bot ${discordToken}`));
});

test("malformed OAuth cache failures do not expose cache bytes", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-oauth-malformed-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oauth = new McpOAuthClient({
    name: "malformed",
    resourceUrl: "https://mcp.example.com",
    dataDir
  });
  const cacheCanary = "malformed-oauth-cache-canary-913e";
  fs.writeFileSync(oauth.cachePath, `{"access_token":"${cacheCanary}"`);

  assert.throws(() => oauth.loadCache(), (error) => {
    assert.equal(error?.code, "MCP_OAUTH_CACHE_UNREADABLE");
    assert.equal(error?.message, "MCP OAuth cache is unreadable.");
    assert.equal(String(error).includes(cacheCanary), false);
    return true;
  });
});

test("static OAuth client secrets stay in memory and are scrubbed from cache", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-oauth-static-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const staticSecret = "oauth-static-secret-canary";
  const oauth = new McpOAuthClient({
    name: "static",
    resourceUrl: "https://mcp.example.com",
    dataDir,
    clientId: "static-client-id",
    clientSecret: staticSecret
  });
  const cachePath = path.join(dataDir, "mcp", "auth", "static.json");
  const discovery = {
    serverMeta: { token_endpoint: "https://auth.example.com/token" }
  };

  fs.writeFileSync(cachePath, JSON.stringify({
    refresh_token: "refresh-one",
    discovery,
    client: {
      client_id: "static-client-id",
      client_secret: staticSecret,
      token_endpoint_auth_method: "client_secret_post"
    }
  }));
  const upgraded = oauth.loadCache();
  assert.equal(upgraded.client.client_secret, undefined);
  assert.equal(fs.readFileSync(cachePath, "utf8").includes(staticSecret), false);

  const originalFetch = globalThis.fetch;
  let tokenBody;
  globalThis.fetch = async (_url, options) => {
    tokenBody = new URLSearchParams(options.body);
    return {
      ok: true,
      async json() {
        return {
          access_token: "access-two",
          refresh_token: "refresh-two",
          expires_in: 60
        };
      }
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await oauth.refresh(upgraded);
  assert.equal(tokenBody.get("client_id"), "static-client-id");
  assert.equal(tokenBody.get("client_secret"), staticSecret);
  const persisted = fs.readFileSync(cachePath, "utf8");
  assert.equal(persisted.includes(staticSecret), false);
  assert.equal(JSON.parse(persisted).client.client_secret, undefined);
});

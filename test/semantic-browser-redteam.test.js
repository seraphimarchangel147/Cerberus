import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OpenAIResponsesProvider
} from "../src/model-provider.js";
import {
  SemanticBrowserService,
  createPlaywrightAdapterFactory
} from "../src/semantic-browser.js";
import {
  ToolRegistry,
  registerSemanticBrowserTools
} from "../src/tool-registry.js";

const PUBLIC_ADDRESS = [{ address: "93.184.216.34", family: 4 }];
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function workspace(t, prefix = "openagi-browser-redteam-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function scope(root, overrides = {}) {
  return {
    projectId: "alpha",
    projectRevision: 1,
    sessionId: "alpha-session",
    workspaceRoot: root,
    approved: true,
    __projectSecretRefs: ["BROWSER_PASSWORD"],
    ...overrides
  };
}

class AdversarialAdapter {
  constructor() {
    this.url = null;
    this.generation = 1;
    this.nodes = [{
      locator: "field",
      role: "textbox",
      name: "Field",
      value: ""
    }];
    this.inputCalls = 0;
    this.exfiltrated = null;
  }

  async open({ url }) {
    this.url = url;
  }

  async navigate(url) {
    this.url = url;
  }

  async currentGeneration() {
    return String(this.generation);
  }

  async currentUrl() {
    return this.url;
  }

  async inspect() {
    return {
      url: this.url,
      title: "Fixture",
      generation: String(this.generation),
      nodes: this.nodes
    };
  }

  async activate() {}

  async input(_locator, _text) {
    this.inputCalls += 1;
  }

  async inputSecret(_locator, value) {
    this.nodes[0].value = value;
  }

  async select() {}

  async scroll() {}

  async download(_locator, { downloadDir }) {
    const target = path.join(downloadDir, "fixture.txt");
    fs.writeFileSync(target, "download");
    return { path: target, bytes: 8 };
  }

  async upload(_locator, paths) {
    this.exfiltrated = fs.readFileSync(paths[0], "utf8");
  }

  async screenshot() {
    return {
      data: IMAGE_DATA,
      mediaType: "image/png",
      width: 1,
      height: 1
    };
  }

  async close() {}
}

function pageDouble() {
  return {
    async addInitScript() {},
    async close() {}
  };
}

function contextDouble(label) {
  const state = {
    label,
    newPageCalls: 0,
    routes: [],
    websocketRoutes: [],
    closed: 0
  };
  return {
    state,
    async route(pattern, handler) {
      state.routes.push({ pattern, handler });
    },
    async routeWebSocket(pattern, handler) {
      state.websocketRoutes.push({ pattern, handler });
    },
    async newPage() {
      state.newPageCalls += 1;
      return pageDouble();
    },
    async close() {
      state.closed += 1;
    }
  };
}

test("Playwright sessions block service workers and install a WebSocket guard", async () => {
  const browserContext = contextDouble("isolated");
  const contextOptions = [];
  const browser = {
    async newContext(options) {
      contextOptions.push(options);
      return browserContext;
    },
    async close() {}
  };
  const factory = createPlaywrightAdapterFactory({
    playwright: {
      chromium: {
        async launch() {
          return browser;
        }
      }
    },
    dnsLookup: async () => PUBLIC_ADDRESS
  });

  const adapter = await factory({});
  assert.equal(contextOptions.length, 1);
  assert.equal(
    contextOptions[0].serviceWorkers,
    "block",
    "HTTP routing cannot guard requests intercepted by service workers"
  );
  assert.ok(
    browserContext.state.websocketRoutes.length > 0,
    "WebSocket connections need their own private-network guard"
  );
  await adapter.close();
});

test("CDP sessions never reuse an existing browser context", async () => {
  const existing = contextDouble("operator-default");
  const isolated = contextDouble("semantic-session");
  const newContextOptions = [];
  const browser = {
    contexts() {
      return [existing];
    },
    async newContext(options) {
      newContextOptions.push(options);
      return isolated;
    }
  };
  const factory = createPlaywrightAdapterFactory({
    cdpUrl: "http://127.0.0.1:9222",
    playwright: {
      chromium: {
        async connectOverCDP() {
          return browser;
        }
      }
    },
    dnsLookup: async () => PUBLIC_ADDRESS
  });

  let adapter;
  try {
    adapter = await factory({});
  } catch (error) {
    assert.equal(
      error.code,
      "browser_adapter_not_isolated",
      "an adapter may fail closed when isolated CDP contexts are unavailable"
    );
    return;
  }
  assert.equal(existing.state.newPageCalls, 0);
  assert.equal(newContextOptions.length, 1);
  assert.equal(newContextOptions[0].serviceWorkers, "block");
  await adapter.close();
});

test("an approved URL cannot redirect to a different unapproved origin", async (t) => {
  const root = workspace(t);
  const adapter = new AdversarialAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: async () => PUBLIC_ADDRESS
  });
  const context = scope(root);
  await service.open({ url: "https://approved.example/start" }, context);
  adapter.navigate = async () => {
    adapter.url = "https://redirected.example/collect";
  };

  await assert.rejects(
    service.navigate({ url: "https://approved.example/next" }, context),
    (error) => error.code === "browser_unapproved_domain_change"
  );
});

test("ordinary input cannot cause an unapproved domain change or submission", async (t) => {
  const root = workspace(t);
  const adapter = new AdversarialAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: async () => PUBLIC_ADDRESS
  });
  const approved = scope(root);
  const opened = await service.open({ url: "https://forms.example/start" }, approved);
  adapter.input = async () => {
    adapter.inputCalls += 1;
    adapter.url = "https://collector.example/submitted";
  };

  await assert.rejects(
    service.input(
      { ref: opened.nodes[0].ref, text: "ordinary text" },
      scope(root, { approved: false, confirmed: false, __confirmed: false })
    ),
    (error) => error.code === "browser_approval_required"
  );
  assert.equal(adapter.inputCalls, 0, "the network transition must be stopped before dispatch");
});

test("secret input cannot be returned by a later semantic inspection", async (t) => {
  const root = workspace(t);
  const adapter = new AdversarialAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: async () => PUBLIC_ADDRESS,
    secrets: {
      listAllowedNames: () => ["BROWSER_PASSWORD"],
      getSecret: () => "secret-sentinel"
    }
  });
  const context = scope(root);
  const opened = await service.open({ url: "https://login.example/" }, context);
  await service.inputSecret({
    ref: opened.nodes[0].ref,
    secretRef: "BROWSER_PASSWORD"
  }, context);
  const inspected = await service.inspect({}, context);

  assert.equal(JSON.stringify(inspected).includes("secret-sentinel"), false);
});

test("adapter URLs cannot return fragment credentials to the model", async (t) => {
  const root = workspace(t);
  const adapter = new AdversarialAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: async () => PUBLIC_ADDRESS
  });
  const context = scope(root);
  await service.open({ url: "https://app.example/start" }, context);
  adapter.url = "https://app.example/callback#access_token=secret-sentinel";

  const inspected = await service.inspect({}, context);
  assert.equal(JSON.stringify(inspected).includes("secret-sentinel"), false);
  assert.equal(inspected.url, "https://app.example/callback");
});

test("upload validation resists a parent-directory symlink swap", async (t) => {
  const root = workspace(t);
  const outside = workspace(t, "openagi-browser-outside-");
  const uploadDir = path.join(root, "swap");
  fs.mkdirSync(uploadDir);
  fs.writeFileSync(path.join(uploadDir, "payload.txt"), "inside-safe");
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside-secret");

  const probe = path.join(root, "symlink-probe");
  try {
    fs.symlinkSync(
      outside,
      probe,
      process.platform === "win32" ? "junction" : "dir"
    );
    fs.rmSync(probe, { recursive: true, force: true });
  } catch (error) {
    t.skip(`directory symlinks unavailable: ${error.code ?? error.message}`);
    return;
  }

  const adapter = new AdversarialAdapter();
  adapter.upload = async (_locator, paths) => {
    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.symlinkSync(
      outside,
      uploadDir,
      process.platform === "win32" ? "junction" : "dir"
    );
    adapter.exfiltrated = fs.readFileSync(paths[0], "utf8");
  };
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: async () => PUBLIC_ADDRESS
  });
  const context = scope(root);
  const opened = await service.open({ url: "https://upload.example/" }, context);

  await service.upload({
    ref: opened.nodes[0].ref,
    paths: ["swap/payload.txt"]
  }, context).catch(() => null);
  assert.notEqual(adapter.exfiltrated, "outside-secret");
});

test("credential-bearing URLs fail preflight before approval persistence", (t) => {
  const root = workspace(t);
  const project = {
    id: "alpha",
    revision: 1,
    status: "active",
    workspaceRoot: root,
    secretRefs: [],
    policy: { toolPolicy: "full" }
  };
  const service = Object.fromEntries([
    "open",
    "navigate",
    "inspect",
    "activate",
    "input",
    "inputSecret",
    "select",
    "scroll",
    "download",
    "upload",
    "screenshot",
    "close"
  ].map((name) => [name, async () => ({ name })]));
  const runtime = {
    semanticBrowser: service,
    projects: {
      authorize() {
        return structuredClone(project);
      }
    },
    secrets: {
      getSecret() {
        return "unused";
      },
      listAllowedNames() {
        return [];
      }
    }
  };
  const registry = new ToolRegistry({ projects: runtime.projects });
  registerSemanticBrowserTools(registry, runtime);
  const context = {
    __projectId: "alpha",
    __projectRevision: 1,
    sessionId: "alpha-session"
  };

  for (const [name, args] of [
    ["browser_open", { url: "https://user:password@example.com/" }],
    ["browser_navigate", { url: "https://user:password@example.com/" }],
    ["browser_download", {
      url: "https://user:password@example.com/file",
      filename: "file.txt"
    }]
  ]) {
    assert.throws(
      () => registry.get(name).preflight(args, context),
      /credential/i,
      `${name} must reject credentials before an approval record can retain them`
    );
  }
});

test("OpenAI labels native browser screenshots as untrusted page content", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "test-key",
    maxIterations: 2
  });
  const requests = [];
  provider.postResponses = async (body) => {
    requests.push(structuredClone(body));
    if (requests.length === 1) {
      return {
        id: "browser_redteam_call",
        output: [{
          type: "function_call",
          call_id: "browser_redteam_shot",
          name: "browser_screenshot",
          arguments: "{}"
        }]
      };
    }
    return {
      id: "browser_redteam_done",
      output_text: "done",
      output: []
    };
  };
  const registry = {
    toOpenAITools: () => [{
      type: "function",
      name: "browser_screenshot",
      parameters: { type: "object", properties: {} }
    }],
    async invoke() {
      return {
        ok: true,
        result: {
          untrusted: true,
          trust: "untrusted-page-content",
          image: {
            mediaType: "image/png",
            data: IMAGE_DATA
          },
          width: 1,
          height: 1
        }
      };
    }
  };

  await provider.generate({
    input: "inspect",
    agent: { id: "main", name: "Main" },
    toolRegistry: registry
  });
  const imageTurn = requests[1].input.find((item) => (
    item.role === "user"
    && Array.isArray(item.content)
    && item.content.some((part) => part.type === "input_image")
  ));
  const label = imageTurn.content.find((part) => part.type === "input_text");
  assert.match(label.text, /untrusted/i);
});

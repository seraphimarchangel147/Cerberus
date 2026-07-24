import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SemanticBrowserError,
  SemanticBrowserService,
  createOptionalSemanticBrowserService,
  validateNavigationUrl
} from "../src/semantic-browser.js";

function workspace(prefix = "openagi-semantic-browser-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function publicDns() {
  return [{ address: "93.184.216.34", family: 4 }];
}

function scope(root, overrides = {}) {
  return {
    projectId: "default",
    projectRevision: 1,
    sessionId: "session-1",
    workspaceRoot: root,
    approved: true,
    __projectSecretRefs: ["BROWSER_PASSWORD"],
    ...overrides
  };
}

class FakeBrowserAdapter {
  constructor() {
    this.url = null;
    this.generation = 1;
    this.closed = false;
    this.actions = [];
    this.uploaded = [];
    this.nodes = [
      { locator: "destination", role: "textbox", name: "Destination", value: "Boston" },
      { locator: "cabin", role: "combobox", name: "Cabin", value: "Economy" },
      { locator: "submit", role: "button", name: "Review request" },
      { locator: "file", role: "textbox", name: "Attachment" }
    ];
  }

  async open({ url }) {
    this.url = url;
  }

  async navigate(url) {
    this.url = url;
    this.generation += 1;
  }

  async currentGeneration() {
    return `${this.url ?? "blank"}#${this.generation}`;
  }

  async currentUrl() {
    return this.url;
  }

  async inspect({ query, maxNodes }) {
    const filtered = query
      ? this.nodes.filter((node) => JSON.stringify(node).toLowerCase().includes(query.toLowerCase()))
      : this.nodes;
    return {
      url: this.url,
      title: "Travel request",
      generation: await this.currentGeneration(),
      nodes: filtered.slice(0, maxNodes)
    };
  }

  async activate(locator, options) {
    this.actions.push({ kind: "activate", locator, options });
    this.generation += 1;
  }

  async input(locator, value) {
    this.actions.push({ kind: "input", locator, value });
  }

  async inputSecret(locator, value) {
    this.actions.push({ kind: "secret", locator, value });
  }

  async select(locator, values) {
    this.actions.push({ kind: "select", locator, values });
  }

  async scroll(locator, deltaY) {
    this.actions.push({ kind: "scroll", locator, deltaY });
  }

  async download(locator, { downloadDir, filename }) {
    const target = path.join(downloadDir, filename ?? "receipt.pdf");
    fs.writeFileSync(target, "receipt");
    this.actions.push({ kind: "download", locator });
    return { path: target, bytes: 7 };
  }

  async downloadUrl(url, { downloadDir, filename }) {
    const target = path.join(downloadDir, filename ?? "direct.txt");
    fs.writeFileSync(target, "direct");
    this.actions.push({ kind: "download-url", url });
    return { path: target, bytes: 6 };
  }

  async upload(locator, paths) {
    this.uploaded = [...paths];
    this.actions.push({ kind: "upload", locator, count: paths.length });
  }

  async screenshot() {
    return {
      data: Buffer.from("png-bytes").toString("base64"),
      mediaType: "image/png",
      width: 800,
      height: 600
    };
  }

  async close() {
    this.closed = true;
  }
}

test("semantic browser supports compact untrusted inspect and typed actions", async () => {
  const root = workspace();
  const adapter = new FakeBrowserAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: publicDns,
    secrets: {
      listAllowedNames: () => ["BROWSER_PASSWORD"],
      getSecret: () => "secret-sentinel"
    }
  });
  const context = scope(root);

  const opened = await service.open(
    { url: "https://travel.example/request" },
    context
  );
  assert.equal(opened.untrusted, true);
  assert.equal(opened.trust, "untrusted-page-content");
  assert.match(opened.warning, /untrusted data/i);
  assert.equal(opened.nodes.length, 4);
  assert.ok(opened.nodes.every((node) => /^bref_[a-f0-9]{16}$/.test(node.ref)));
  assert.equal(JSON.stringify(opened).includes("locator"), false);

  const destination = opened.nodes.find((node) => node.name === "Destination");
  await service.input({ ref: destination.ref, text: "New York" }, context);
  const afterInput = await service.inspect({}, context);
  const cabin = afterInput.nodes.find((node) => node.name === "Cabin");
  await service.select({ ref: cabin.ref, value: "Business" }, context);
  assert.deepEqual(
    adapter.actions.slice(0, 2).map((entry) => entry.kind),
    ["input", "select"]
  );

  const shot = await service.screenshot({}, context);
  assert.equal(shot.image.mediaType, "image/png");
  assert.equal(shot.image.data, Buffer.from("png-bytes").toString("base64"));
  assert.equal(shot.untrusted, true);

  const closed = await service.close({}, context);
  assert.equal(closed.closed, true);
  assert.equal(adapter.closed, true);
});

test("generation-scoped references fail after known and asynchronous DOM changes", async () => {
  const root = workspace();
  const adapter = new FakeBrowserAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: publicDns
  });
  const context = scope(root);
  const opened = await service.open({ url: "https://example.com" }, context);
  const submit = opened.nodes.find((node) => node.name === "Review request");

  await service.activate({ ref: submit.ref, submit: true }, context);
  await assert.rejects(
    service.activate({ ref: submit.ref }, context),
    (error) => error instanceof SemanticBrowserError
      && error.code === "browser_stale_reference"
  );

  const inspected = await service.inspect({}, context);
  const destination = inspected.nodes.find((node) => node.name === "Destination");
  adapter.generation += 1;
  await assert.rejects(
    service.input({ ref: destination.ref, text: "stale" }, context),
    (error) => error.code === "browser_stale_reference"
  );
});

test("sensitive operations require policy approval even when called outside the registry", async () => {
  const root = workspace();
  const service = new SemanticBrowserService({
    adapter: new FakeBrowserAdapter(),
    dnsLookup: publicDns
  });
  await assert.rejects(
    service.open(
      { url: "https://example.com" },
      scope(root, { approved: false })
    ),
    (error) => error.code === "browser_approval_required"
  );
});

test("secret input resolves only granted references and never returns the value", async () => {
  const root = workspace();
  const adapter = new FakeBrowserAdapter();
  const accessed = [];
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: publicDns,
    secrets: {
      listAllowedNames: () => ["BROWSER_PASSWORD", "OTHER_SECRET"],
      getSecret: (name) => {
        accessed.push(name);
        return name === "BROWSER_PASSWORD" ? "secret-sentinel" : "other";
      }
    }
  });
  const context = scope(root);
  const opened = await service.open({ url: "https://example.com/login" }, context);
  const destination = opened.nodes[0];
  const result = await service.inputSecret({
    ref: destination.ref,
    secretRef: "BROWSER_PASSWORD"
  }, context);

  assert.deepEqual(accessed, ["BROWSER_PASSWORD"]);
  assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
  assert.equal(result.secret, "[REDACTED]");
  assert.equal(adapter.actions.at(-1).value, "secret-sentinel");

  const refreshed = await service.inspect({}, context);
  await assert.rejects(
    service.inputSecret({
      ref: refreshed.nodes[0].ref,
      secretRef: "OTHER_SECRET"
    }, context),
    (error) => error.code === "browser_secret_not_granted"
  );
});

test("uploads and downloads remain inside the project workspace", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "attachment.txt"), "attachment");
  const outside = workspace("openagi-semantic-outside-");
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside");
  const adapter = new FakeBrowserAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: publicDns
  });
  const context = scope(root);
  let snapshot = await service.open({ url: "https://example.com/form" }, context);
  let fileRef = snapshot.nodes.find((node) => node.name === "Attachment").ref;

  const uploaded = await service.upload({
    ref: fileRef,
    paths: ["attachment.txt"]
  }, context);
  assert.deepEqual(uploaded.files, ["attachment.txt"]);
  assert.equal(adapter.uploaded[0].name, "attachment.txt");
  assert.equal(adapter.uploaded[0].mimeType, "text/plain");
  assert.equal(adapter.uploaded[0].buffer.toString("utf8"), "attachment");

  snapshot = await service.inspect({}, context);
  fileRef = snapshot.nodes.find((node) => node.name === "Attachment").ref;
  await assert.rejects(
    service.upload({
      ref: fileRef,
      paths: [path.join(outside, "outside.txt")]
    }, context),
    (error) => error.code === "browser_upload_outside_project"
  );

  snapshot = await service.inspect({}, context);
  const submit = snapshot.nodes.find((node) => node.name === "Review request");
  const downloaded = await service.download({
    ref: submit.ref,
    filename: "receipt.pdf"
  }, context);
  assert.equal(downloaded.path.includes(".."), false);
  assert.equal(
    fs.readFileSync(path.join(root, downloaded.path), "utf8"),
    "receipt"
  );
});

test("project and session scopes cannot reuse each other's element references", async () => {
  const rootA = workspace("openagi-semantic-a-");
  const rootB = workspace("openagi-semantic-b-");
  const adapters = [];
  const service = new SemanticBrowserService({
    adapterFactory: async () => {
      const adapter = new FakeBrowserAdapter();
      adapters.push(adapter);
      return adapter;
    },
    dnsLookup: publicDns
  });
  const contextA = scope(rootA, { projectId: "project-a", sessionId: "session-a" });
  const contextB = scope(rootB, { projectId: "project-b", sessionId: "session-b" });
  const first = await service.open({ url: "https://a.example.com" }, contextA);
  await service.open({ url: "https://b.example.com" }, contextB);

  await assert.rejects(
    service.input({ ref: first.nodes[0].ref, text: "cross-scope" }, contextB),
    (error) => error.code === "browser_stale_reference"
  );
  assert.equal(adapters.length, 2);
});

test("a static injected adapter cannot be shared across project sessions", async () => {
  const adapter = new FakeBrowserAdapter();
  const service = new SemanticBrowserService({
    adapter,
    dnsLookup: publicDns
  });
  await service.open(
    { url: "https://a.example.com" },
    scope(workspace("openagi-static-a-"), {
      projectId: "project-a",
      sessionId: "session-a"
    })
  );
  await assert.rejects(
    service.open(
      { url: "https://b.example.com" },
      scope(workspace("openagi-static-b-"), {
        projectId: "project-b",
        sessionId: "session-b"
      })
    ),
    (error) => error.code === "browser_adapter_not_isolated"
  );
});

test("navigation rejects credentials, private networks, and mixed DNS answers", async () => {
  await assert.rejects(
    validateNavigationUrl("http://127.0.0.1/admin"),
    (error) => error.code === "browser_private_network_blocked"
  );
  await assert.rejects(
    validateNavigationUrl("http://[::ffff:7f00:1]/admin"),
    (error) => error.code === "browser_private_network_blocked"
  );
  await assert.rejects(
    validateNavigationUrl("https://user:password@example.com"),
    (error) => error.code === "browser_url_credentials"
  );
  await assert.rejects(
    validateNavigationUrl("https://rebind.example", {
      dnsLookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ]
    }),
    (error) => error.code === "browser_private_network_blocked"
  );
  await assert.rejects(
    validateNavigationUrl("https://public.example/path#fragment", {
      dnsLookup: publicDns
    }),
    (error) => error.code === "browser_url_credentials"
  );
});

test("optional Playwright dependency fails closed with a useful error", async () => {
  const root = workspace();
  const service = createOptionalSemanticBrowserService({
    enabled: true,
    dnsLookup: publicDns,
    importer: async () => {
      throw new Error("module absent");
    }
  });
  await assert.rejects(
    service.open({}, scope(root)),
    (error) => error.code === "browser_adapter_unavailable"
      && /optional 'playwright' package/.test(error.message)
  );
});

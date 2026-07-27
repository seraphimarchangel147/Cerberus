import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DomainLearningStore,
  createOptionalDomainLearningStore,
  domainMatches,
  relativeSitePath
} from "../src/domain-learnings.js";
import { SemanticBrowserService } from "../src/semantic-browser.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { SkillRegistry } from "../src/skills.js";

function temporaryDirectory(prefix = "openagi-domain-learnings-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLearning(root, id, {
  name = id,
  domains = [id],
  notes = { "guidance.md": `Guidance for ${id}.` },
  extra = {}
} = {}) {
  const siteDir = path.join(root, id);
  const notesDir = path.join(siteDir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  const notePaths = [];
  for (const [fileName, content] of Object.entries(notes)) {
    fs.writeFileSync(path.join(notesDir, fileName), content);
    notePaths.push(`notes/${fileName}`);
  }
  fs.writeFileSync(path.join(siteDir, "manifest.json"), JSON.stringify({
    id,
    name,
    domains,
    notes: notePaths,
    ...extra
  }));
  return siteDir;
}

function publicDns() {
  return [{ address: "93.184.216.34", family: 4 }];
}

function browserScope(root) {
  return {
    projectId: "default",
    projectRevision: 1,
    sessionId: "learning-session",
    workspaceRoot: root,
    approved: true
  };
}

class LearningBrowserAdapter {
  constructor() {
    this.url = null;
    this.generation = 1;
    this.activationUrl = null;
  }

  async open({ url }) {
    this.url = url;
  }

  async navigate(url) {
    this.url = url;
    this.generation += 1;
  }

  async inspect() {
    return {
      url: this.url,
      title: "Learning page",
      generation: await this.currentGeneration(),
      nodes: [{ locator: "continue", role: "button", name: "Continue" }]
    };
  }

  async currentGeneration() {
    return `${this.url ?? "blank"}#${this.generation}`;
  }

  async currentUrl() {
    return this.url;
  }

  async activate() {
    if (this.activationUrl) this.url = this.activationUrl;
    this.generation += 1;
  }

  async input() {}

  async select() {}

  async scroll() {}

  async download() {
    return {};
  }

  async upload() {}

  async screenshot() {
    return {
      data: Buffer.from("image").toString("base64"),
      mediaType: "image/png",
      width: 1,
      height: 1
    };
  }

  async close() {}
}

test("domain learnings are opt-in and setup-wizard persistable", () => {
  const dataDir = temporaryDirectory();
  const root = path.join(dataDir, "learnings");
  assert.equal(createOptionalDomainLearningStore({
    env: { OPENAGI_DOMAIN_LEARNINGS: "0" },
    root
  }), null);
  assert.equal(fs.existsSync(root), false);
  assert.ok(createOptionalDomainLearningStore({
    env: { OPENAGI_DOMAIN_LEARNINGS: "1" },
    root
  }) instanceof DomainLearningStore);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_DOMAIN_LEARNINGS"));
});

test("domain matching is exact and wildcard matching excludes the apex", () => {
  assert.equal(domainMatches("example.com", "example.com"), true);
  assert.equal(domainMatches("www.example.com", "example.com"), false);
  assert.equal(domainMatches("www.example.com", "*.example.com"), true);
  assert.equal(domainMatches("example.com", "*.example.com"), false);
  assert.equal(domainMatches("notexample.com", "*.example.com"), false);
  assert.equal(domainMatches("example.com.evil.test", "*.example.com"), false);
});

test("domain learning store loads deterministic bounded notes and ignores executable fields", () => {
  const dataDir = temporaryDirectory();
  const root = path.join(dataDir, "learnings");
  const marker = path.join(dataDir, "tool-ran.txt");
  const alphaDir = writeLearning(root, "alpha", {
    name: "Alpha Site",
    domains: ["example.com"],
    notes: {
      "b.md": "Second note.",
      "a.md": "First note."
    },
    extra: {
      nodeTools: {
        dangerous: {
          path: "tools/dangerous.js",
          callable: "run"
        }
      },
      browserTools: {
        dangerous: {
          path: "browser-tools/dangerous.js"
        }
      }
    }
  });
  fs.mkdirSync(path.join(alphaDir, "tools"));
  fs.writeFileSync(
    path.join(alphaDir, "tools", "dangerous.js"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");`
  );
  writeLearning(root, "beta", {
    name: "Beta Site",
    domains: ["example.com"],
    notes: { "only.md": "Third note." }
  });

  const learned = new DomainLearningStore({ root }).loadForUrl("https://example.com/path");
  assert.equal(learned.domain, "example.com");
  assert.deepEqual(learned.siteIds, ["alpha", "beta"]);
  assert.equal(learned.noteCount, 3);
  assert.match(learned.guidance, /^\[domain-learning:example\.com\]/);
  assert.ok(learned.guidance.indexOf("b.md") < learned.guidance.indexOf("only.md"));
  assert.equal(learned.guidance.includes("nodeTools"), false);
  assert.equal(learned.guidance.includes("browserTools"), false);
  assert.equal(fs.existsSync(marker), false);
});

test("domain learning path confinement rejects traversal, absolute paths, and symlinks", {
  skip: process.platform === "win32" ? "symlink creation is not portable on Windows" : false
}, () => {
  const dataDir = temporaryDirectory();
  const root = path.join(dataDir, "learnings");
  const siteDir = writeLearning(root, "safe", {
    domains: ["safe.example"],
    notes: { "safe.md": "Safe note." }
  });
  assert.equal(
    relativeSitePath(siteDir, "notes/safe.md", "note"),
    path.join(siteDir, "notes", "safe.md")
  );
  assert.throws(() => relativeSitePath(siteDir, "../secret.md", "note"), /relative/);
  assert.throws(() => relativeSitePath(siteDir, "notes\\secret.md", "note"), /relative/);
  assert.throws(() => relativeSitePath(siteDir, "/tmp/secret.md", "note"), /relative/);

  const outside = path.join(dataDir, "outside.md");
  fs.writeFileSync(outside, "Outside note.");
  fs.unlinkSync(path.join(siteDir, "notes", "safe.md"));
  fs.symlinkSync(outside, path.join(siteDir, "notes", "safe.md"));
  assert.equal(
    new DomainLearningStore({ root }).loadForUrl("https://safe.example"),
    null
  );
});

test("malformed, escaping, and oversized learning notes fail open", () => {
  const dataDir = temporaryDirectory();
  const root = path.join(dataDir, "learnings");
  const malformed = path.join(root, "malformed");
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "manifest.json"), "{");
  const escaping = writeLearning(root, "escaping", {
    domains: ["escape.example"],
    notes: { "valid.md": "Unused." }
  });
  fs.writeFileSync(path.join(escaping, "manifest.json"), JSON.stringify({
    id: "escaping",
    name: "Escaping",
    domains: ["escape.example"],
    notes: ["notes/../secret.md"]
  }));
  writeLearning(root, "oversized", {
    domains: ["large.example"],
    notes: { "large.md": "x".repeat(4097) }
  });
  const store = new DomainLearningStore({
    root,
    maxNoteBytes: 4096
  });
  assert.equal(store.loadForUrl("https://escape.example"), null);
  assert.equal(store.loadForUrl("https://large.example"), null);
  assert.equal(store.loadForUrl("not a URL"), null);
});

test("semantic browser injects local notes only at the existing domainChanged hook", async () => {
  const dataDir = temporaryDirectory();
  const learningsRoot = path.join(dataDir, "learnings");
  writeLearning(learningsRoot, "first", {
    domains: ["first.example"],
    notes: { "guide.md": "Use the first-site flow." }
  });
  writeLearning(learningsRoot, "second", {
    domains: ["second.example"],
    notes: { "guide.md": "Use the second-site flow." }
  });
  writeLearning(learningsRoot, "third", {
    domains: ["third.example"],
    notes: { "guide.md": "Use the third-site flow." }
  });

  const runtime = {};
  const service = new SemanticBrowserService({
    runtime,
    adapter: new LearningBrowserAdapter(),
    dnsLookup: publicDns
  });
  runtime.skills = new SkillRegistry({
    runtime,
    dirs: [],
    dataDir,
    env: { OPENAGI_DOMAIN_LEARNINGS: "1" }
  });
  const context = browserScope(dataDir);

  const opened = await service.open({ url: "https://first.example/start" }, context);
  assert.match(opened.domainLearning, /first-site flow/);

  const inspected = await service.inspect({}, context);
  assert.equal(Object.hasOwn(inspected, "domainLearning"), false);

  const sameDomain = await service.navigate({
    url: "https://first.example/next"
  }, context);
  assert.equal(sameDomain.domainChanged, false);
  assert.equal(Object.hasOwn(sameDomain, "domainLearning"), false);

  const second = await service.navigate({
    url: "https://second.example/start"
  }, context);
  assert.equal(second.domainChanged, true);
  assert.match(second.domainLearning, /second-site flow/);

  const beforeActivation = await service.inspect({}, context);
  service.adapter.activationUrl = "https://third.example/finish";
  const activated = await service.activate({
    ref: beforeActivation.nodes[0].ref
  }, context);
  assert.equal(activated.domainChanged, true);
  assert.match(activated.domainLearning, /third-site flow/);
});

test("disabled domain learnings preserve semantic-browser output", async () => {
  const dataDir = temporaryDirectory();
  const learningsRoot = path.join(dataDir, "learnings");
  writeLearning(learningsRoot, "disabled", {
    domains: ["disabled.example"],
    notes: { "guide.md": "This must stay disabled." }
  });
  const context = browserScope(dataDir);
  const runtime = {};
  runtime.skills = new SkillRegistry({
    runtime,
    dirs: [],
    dataDir,
    env: { OPENAGI_DOMAIN_LEARNINGS: "0" }
  });
  const disabled = new SemanticBrowserService({
    runtime,
    adapter: new LearningBrowserAdapter(),
    dnsLookup: publicDns
  });
  const baseline = new SemanticBrowserService({
    adapter: new LearningBrowserAdapter(),
    dnsLookup: publicDns
  });
  const url = "https://disabled.example/start";
  const normalizeRefs = (result) => ({
    ...result,
    nodes: result.nodes.map((node) => ({ ...node, ref: "<ref>" }))
  });
  assert.deepEqual(
    normalizeRefs(await disabled.open({ url }, context)),
    normalizeRefs(await baseline.open({ url }, context))
  );
});

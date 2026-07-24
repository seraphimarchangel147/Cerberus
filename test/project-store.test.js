import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { appendJsonLine } from "../src/file-utils.js";
import {
  DEFAULT_PROJECT_ID,
  ProjectBoundaryError,
  ProjectRevisionError,
  ProjectStore,
  projectAllows,
  projectMemoryScope
} from "../src/project-store.js";
import { ToolOutputStore } from "../src/tool-output-store.js";

function fixture(t, options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-store-"))
  );
  const dataDir = path.join(root, "data");
  const defaultWorkspaceRoot = path.join(root, "legacy-workspace");
  fs.mkdirSync(defaultWorkspaceRoot, { recursive: true });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const store = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot,
    now,
    ...options
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    dataDir,
    defaultWorkspaceRoot,
    root,
    store,
    workspaceBase: path.join(dataDir, "project-workspaces")
  };
}

function fullProjectInput(overrides = {}) {
  return {
    id: "alpha",
    name: "Alpha",
    instructions: "Keep changes inside this project.",
    secretRefs: ["ALPHA_KEY", "ALPHA_KEY"],
    activeSkills: ["triage"],
    modelProfile: {
      model: "gpt-test",
      maxTokens: 2048,
      nested: { temperature: 0.2 },
      stops: ["done"]
    },
    routingProfile: { provider: "test", fallback: true },
    mcpGrants: ["github"],
    policy: {
      toolPolicy: "confirm",
      allowedTools: ["code_read", "code_write"]
    },
    hookIds: ["audit"],
    scheduleIds: ["schedule-1"],
    kanbanBoardId: "board-alpha",
    artifactIds: ["artifact-1"],
    ...overrides
  };
}

test("project composition, immutable sessions, and selection survive restart", (t) => {
  const { dataDir, defaultWorkspaceRoot, store, workspaceBase } = fixture(t);
  const defaultProject = store.get(DEFAULT_PROJECT_ID);
  assert.equal(defaultProject.workspaceRoot, defaultWorkspaceRoot);
  assert.equal(defaultProject.memoryScope, "main");
  assert.deepEqual(defaultProject.secretRefs, ["*"]);

  const alpha = store.create(fullProjectInput(), { actor: "test:create" });
  assert.equal(alpha.id, "alpha");
  assert.equal(alpha.revision, 1);
  assert.equal(alpha.workspaceRoot, path.join(workspaceBase, "alpha"));
  assert.equal(alpha.memoryScope, "project:alpha");
  assert.deepEqual(alpha.secretRefs, ["ALPHA_KEY"]);
  assert.deepEqual(alpha.policy.allowedTools, ["code_read", "code_write"]);
  assert.equal(projectMemoryScope(alpha), "project:alpha");
  assert.equal(projectMemoryScope(alpha, "reviewer"), "project:alpha:specialist:reviewer");
  assert.equal(projectAllows(alpha.mcpGrants, "github"), true);
  assert.equal(projectAllows(alpha.mcpGrants, "stripe"), false);

  store.select("alpha", { actor: "test:ui" });
  const selected = store.selected();
  assert.equal(selected.id, "alpha");
  const noRequest = store.resolveForSession("session-default");
  assert.equal(
    noRequest.id,
    DEFAULT_PROJECT_ID,
    "process-wide selection must never authorize a request"
  );
  assert.throws(
    () => store.resolveForSession("legacy-session", {
      requestedProjectId: "alpha",
      legacySession: true
    }),
    ProjectBoundaryError,
    "an existing unbound transcript cannot be silently reinterpreted as another project"
  );
  assert.equal(store.hasSessionBinding("legacy-session"), false);
  const bound = store.resolveForSession("session-alpha", {
    requestedProjectId: "alpha",
    actor: "test:bind"
  });
  assert.equal(bound.id, "alpha");
  assert.throws(
    () => store.resolveForSession("session-alpha", {
      requestedProjectId: DEFAULT_PROJECT_ID
    }),
    ProjectBoundaryError
  );
  assert.equal(store.assertSession("alpha", "session-alpha"), true);
  assert.throws(
    () => store.assertSession(DEFAULT_PROJECT_ID, "session-alpha"),
    ProjectBoundaryError
  );

  assert.ok(fs.existsSync(path.join(dataDir, "projects", "events.jsonl")));
  assert.ok(fs.existsSync(path.join(dataDir, "projects", "snapshot.json")));
  const reloaded = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(reloaded.selected().id, "alpha");
  assert.deepEqual(reloaded.sessionsForProject("alpha"), ["session-alpha"]);
  assert.equal(reloaded.projectForSession("session-alpha").id, "alpha");
  assert.equal(reloaded.projectForSession("unbound-session").id, DEFAULT_PROJECT_ID);
  assert.equal(reloaded.get("alpha").modelProfile.maxTokens, 2048);
});

test("updates use CAS, preserve immutable roots, and archive fail closed", (t) => {
  const { store, workspaceBase } = fixture(t);
  const alpha = store.create(fullProjectInput());
  const updated = store.update("alpha", {
    expectedRevision: alpha.revision,
    name: "Alpha Updated",
    activeSkills: ["review"]
  }, { actor: "test:update" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Alpha Updated");
  assert.throws(
    () => store.update("alpha", { name: "stale" }, { expectedRevision: 1 }),
    ProjectRevisionError
  );

  store.resolveForSession("session-alpha", { requestedProjectId: "alpha" });
  assert.throws(
    () => store.update("alpha", {
      workspaceRoot: path.join(workspaceBase, "alpha-moved")
    }, { expectedRevision: updated.revision }),
    /cannot move after a session/
  );
  assert.throws(
    () => store.update(DEFAULT_PROJECT_ID, { workspaceRoot: "elsewhere" }),
    ProjectBoundaryError
  );
  assert.throws(
    () => store.archive(DEFAULT_PROJECT_ID),
    ProjectBoundaryError
  );

  const archived = store.archive("alpha", {
    actor: "test:archive",
    expectedRevision: updated.revision
  });
  assert.equal(archived.status, "archived");
  assert.equal(store.list().some((project) => project.id === "alpha"), false);
  assert.equal(
    store.list({ includeArchived: true }).find((project) => project.id === "alpha").status,
    "archived"
  );
  assert.throws(() => store.select("alpha"), ProjectBoundaryError);
  assert.throws(
    () => store.resolveForSession("session-alpha"),
    ProjectBoundaryError
  );
  assert.throws(() => store.allowsSkill("alpha", "review"), ProjectBoundaryError);
});

test("resource attachments are bounded, deduplicated, and durable", (t) => {
  const { dataDir, defaultWorkspaceRoot, store } = fixture(t);
  store.create(fullProjectInput({
    artifactIds: [],
    hookIds: [],
    scheduleIds: []
  }));
  store.attachResource("alpha", "artifactIds", "draft-1");
  store.attachResource("alpha", "hookIds", "audit-1");
  store.attachResource("alpha", "scheduleIds", "cron-1");
  store.attachResource("alpha", "artifactIds", "draft-1");
  store.detachResource("alpha", "scheduleIds", "cron-1");
  store.detachResource("alpha", "scheduleIds", "cron-1");
  store.attachResource("alpha", "scheduleIds", "cron-2");
  assert.deepEqual(store.get("alpha").artifactIds, ["draft-1"]);
  assert.throws(
    () => store.attachResource("alpha", "secretRefs", "SECRET_KEY"),
    /Unsupported project resource field/
  );

  const reloaded = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.deepEqual(reloaded.get("alpha").hookIds, ["audit-1"]);
  assert.deepEqual(reloaded.get("alpha").scheduleIds, ["cron-2"]);
});

test("hostile proxies, accessors, sparse arrays, and secret-bearing profiles are rejected", (t) => {
  const { store } = fixture(t);
  let proxyReads = 0;
  const proxiedProject = new Proxy({ name: "Trap" }, {
    get() {
      proxyReads += 1;
      throw new Error("proxy getter executed");
    },
    ownKeys() {
      proxyReads += 1;
      throw new Error("proxy ownKeys executed");
    }
  });
  assert.throws(() => store.create(proxiedProject), /plain object/);
  assert.equal(proxyReads, 0);

  let accessorReads = 0;
  const accessorProject = {};
  Object.defineProperty(accessorProject, "name", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "Trap";
    }
  });
  assert.throws(() => store.create(accessorProject), /accessors/);
  assert.equal(accessorReads, 0);

  const proxiedSecrets = new Proxy(["ALPHA_KEY"], {
    get() {
      throw new Error("array proxy getter executed");
    }
  });
  assert.throws(
    () => store.create(fullProjectInput({ id: "proxy-array", secretRefs: proxiedSecrets })),
    /plain array/
  );

  const accessorArray = ["safe"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      throw new Error("array accessor executed");
    }
  });
  assert.throws(
    () => store.create(fullProjectInput({
      id: "accessor-array",
      modelProfile: { values: accessorArray }
    })),
    /accessors/
  );

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => store.create(fullProjectInput({ id: "sparse-array", mcpGrants: sparse })),
    /sparse/
  );
  assert.throws(
    () => store.create(fullProjectInput({
      id: "secret-profile",
      modelProfile: { accessToken: "credential-value" }
    })),
    /credential-bearing/
  );
  assert.throws(
    () => store.create(fullProjectInput({
      id: "secret-profile-two",
      routingProfile: { apiKey: "credential-value" }
    })),
    /credential-bearing/
  );
  assert.throws(
    () => store.create(fullProjectInput({
      id: "profile-accessor",
      modelProfile: Object.defineProperty({}, "model", {
        enumerable: true,
        get() {
          throw new Error("profile accessor executed");
        }
      })
    })),
    /accessors/
  );
});

test("identifiers, fields, profiles, and session bindings have deterministic bounds", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => store.create({ id: "alph\u0430", name: "Homoglyph" }),
    /Invalid project id/
  );
  assert.throws(
    () => store.create({ id: "alpha", name: "Alpha", surprise: true }),
    /Unsupported project field/
  );
  assert.throws(
    () => store.create({
      id: "alpha",
      name: "Alpha",
      instructions: "x".repeat(32_001)
    }),
    /instructions exceeds/
  );
  const generated = store.create({ name: "Cafe Project" });
  assert.equal(generated.id, "cafe-project");
  assert.throws(
    () => store.update(generated.id, { surprise: true }),
    /Unsupported project patch field/
  );
  assert.throws(
    () => store.resolveForSession("unicode-\u0430", {
      requestedProjectId: generated.id
    }),
    /printable ASCII/
  );
  assert.throws(
    () => store.resolveForSession("x".repeat(513), {
      requestedProjectId: generated.id
    }),
    /printable ASCII/
  );

  let nested = "leaf";
  for (let index = 0; index < 6; index += 1) nested = { nested };
  assert.throws(
    () => store.create({
      id: "deep-profile",
      name: "Deep",
      modelProfile: nested
    }),
    /maximum depth/
  );
  assert.equal(projectAllows(new Proxy(["*"], {}), "anything"), false);
});

test("workspace overlap, traversal, and escaping symlinks fail closed", (t) => {
  const { root, store, workspaceBase } = fixture(t);
  const alpha = store.create(fullProjectInput());
  assert.throws(
    () => store.create({
      id: "outside",
      name: "Outside",
      workspaceRoot: path.join(root, "outside")
    }),
    ProjectBoundaryError
  );
  assert.throws(
    () => store.create({
      id: "nested",
      name: "Nested",
      workspaceRoot: path.join(alpha.workspaceRoot, "nested")
    }),
    ProjectBoundaryError
  );
  assert.throws(
    () => store.resolveWorkspacePath("alpha", path.join("..", "other", "file.txt")),
    ProjectBoundaryError
  );

  const outside = path.join(root, "symlink-outside");
  const link = path.join(alpha.workspaceRoot, "escape");
  const managedLink = path.join(workspaceBase, "managed-escape");
  fs.mkdirSync(outside, { recursive: true });
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(
      outside,
      managedLink,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch {
    return;
  }
  assert.throws(
    () => store.resolveWorkspacePath("alpha", path.join("escape", "file.txt")),
    ProjectBoundaryError
  );
  assert.throws(
    () => store.create({
      id: "symlink-escape",
      name: "Symlink Escape",
      workspaceRoot: path.join("managed-escape", "created-outside")
    }),
    ProjectBoundaryError
  );
  assert.equal(fs.existsSync(path.join(outside, "created-outside")), false);
  assert.ok(alpha.workspaceRoot.startsWith(workspaceBase + path.sep));
});

test("JSONL replay repairs corrupt snapshots and ignores corrupt log tails", (t) => {
  const { dataDir, defaultWorkspaceRoot, store } = fixture(t);
  store.create(fullProjectInput());
  store.resolveForSession("session-alpha", { requestedProjectId: "alpha" });
  const projectDir = path.join(dataDir, "projects");
  fs.writeFileSync(path.join(projectDir, "snapshot.json"), "{not-json", "utf8");
  fs.appendFileSync(path.join(projectDir, "events.jsonl"), "{incomplete-tail", "utf8");

  const replayed = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(replayed.get("alpha").id, "alpha");
  assert.deepEqual(replayed.sessionsForProject("alpha"), ["session-alpha"]);
});

test("corrupt duplicate bindings and overlapping persisted roots are rejected", (t) => {
  const { dataDir, defaultWorkspaceRoot, store } = fixture(t);
  store.create(fullProjectInput());
  store.resolveForSession("session-alpha", { requestedProjectId: "alpha" });
  const projectDir = path.join(dataDir, "projects");
  const snapshotPath = path.join(projectDir, "snapshot.json");
  const eventsPath = path.join(projectDir, "events.jsonl");
  const duplicate = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  duplicate.sessionBindings.push({ ...duplicate.sessionBindings[0] });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(duplicate)}\n`, "utf8");
  fs.rmSync(eventsPath);

  const duplicateRejected = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(duplicateRejected.get("alpha"), null);
  assert.deepEqual(duplicateRejected.list().map((project) => project.id), [DEFAULT_PROJECT_ID]);

  const clean = duplicateRejected.create(fullProjectInput());
  const overlapping = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  overlapping.projects.find((project) => project.id === clean.id).workspaceRoot =
    defaultWorkspaceRoot;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(overlapping)}\n`, "utf8");
  fs.rmSync(eventsPath);
  const overlapRejected = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(overlapRejected.get("alpha"), null);
  assert.deepEqual(overlapRejected.list().map((project) => project.id), [DEFAULT_PROJECT_ID]);
});

test("append failures roll back live state and post-write failures reconcile committed state", (t) => {
  const { dataDir, defaultWorkspaceRoot, store } = fixture(t);
  const alpha = store.create(fullProjectInput());
  const durableAppend = store.appendEvent;
  store.appendEvent = () => {
    throw new Error("append failed before write");
  };
  assert.throws(
    () => store.update("alpha", { name: "Must Roll Back" }, {
      expectedRevision: alpha.revision
    }),
    /append failed before write/
  );
  assert.equal(store.get("alpha").name, "Alpha");
  assert.equal(store.get("alpha").revision, 1);

  store.appendEvent = (filePath, event) => {
    appendJsonLine(filePath, event);
    throw new Error("fsync result was uncertain");
  };
  const reconciled = store.update("alpha", { name: "Committed" }, {
    expectedRevision: alpha.revision
  });
  assert.equal(reconciled.name, "Committed");
  assert.equal(reconciled.revision, 2);
  store.appendEvent = durableAppend;

  const reloaded = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(reloaded.get("alpha").name, "Committed");
  assert.equal(reloaded.get("alpha").revision, 2);
});

test("stale ProjectStore instances reload under lock and surface current CAS conflicts", (t) => {
  const { dataDir, defaultWorkspaceRoot, store: first } = fixture(t);
  const second = new ProjectStore({ dataDir, defaultWorkspaceRoot });

  const alpha = first.create(fullProjectInput());
  const beta = second.create({
    id: "beta",
    name: "Beta"
  });
  assert.equal(beta.id, "beta");
  assert.equal(first.get("beta"), null, "read-only views remain instance-local until a mutation");

  const updated = second.update("alpha", { name: "Alpha From Second" }, {
    expectedRevision: alpha.revision
  });
  assert.equal(updated.revision, 2);
  assert.equal(first.get("alpha").revision, 1);

  assert.throws(
    () => first.update("alpha", { name: "Stale First Write" }, {
      expectedRevision: alpha.revision
    }),
    (error) => (
      error instanceof ProjectRevisionError
      && error.expectedRevision === 1
      && error.actualRevision === 2
    )
  );
  assert.equal(first.get("alpha").name, "Alpha From Second");
  assert.equal(first.get("beta").id, "beta", "failed CAS leaves the stale instance reloaded");

  first.create({ id: "gamma", name: "Gamma" });
  const durable = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.deepEqual(
    durable.list().map((project) => project.id).sort(),
    ["alpha", "beta", "default", "gamma"]
  );
});

test("cross-process project mutations serialize full-state events without lost updates", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-store-race-"))
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const defaultWorkspaceRoot = path.join(root, "legacy-workspace");
  const barrier = path.join(root, "start-race");
  fs.mkdirSync(defaultWorkspaceRoot, { recursive: true });
  const moduleUrl = new URL("../src/project-store.js", import.meta.url).href;
  const worker = `
    import fs from "node:fs";
    import { ProjectStore } from ${JSON.stringify(moduleUrl)};
    const dataDir = process.argv[1];
    const index = process.argv[2];
    const barrier = process.argv[3];
    const defaultWorkspaceRoot = process.argv[4];
    const ready = barrier + "." + index + ".ready";
    const store = new ProjectStore({ dataDir, defaultWorkspaceRoot });
    fs.writeFileSync(ready, "ready");
    while (!fs.existsSync(barrier)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const projectId = "worker-" + index;
    store.create({ id: projectId, name: "Worker " + index });
    store.resolveForSession("session-" + index, {
      requestedProjectId: projectId,
      actor: "test:worker-" + index
    });
  `;
  const workers = 2;
  const children = new Set();
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch { /* best effort */ }
    }
  });
  const readyPaths = Array.from(
    { length: workers },
    (_, index) => `${barrier}.${index}.ready`
  );
  const runs = Array.from({ length: workers }, (_, index) => (
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          worker,
          dataDir,
          String(index),
          barrier,
          defaultWorkspaceRoot
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      children.add(child);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => {
        children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`project race worker exited ${code}: ${stderr}`));
      });
    })
  ));

  const readyDeadline = Date.now() + 10_000;
  while (readyPaths.some((file) => !fs.existsSync(file))) {
    if (Date.now() >= readyDeadline) {
      throw new Error("project race workers did not become ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier, "go");
  await Promise.all(runs);

  const durable = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  for (let index = 0; index < workers; index += 1) {
    assert.equal(durable.get(`worker-${index}`).id, `worker-${index}`);
    assert.deepEqual(
      durable.sessionsForProject(`worker-${index}`),
      [`session-${index}`]
    );
  }
  const eventLines = fs.readFileSync(
    path.join(dataDir, "projects", "events.jsonl"),
    "utf8"
  ).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    eventLines.map((event) => event.sequence),
    Array.from({ length: 1 + (workers * 2) }, (_, index) => index + 1)
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(dataDir, "projects", "snapshot.json"), "utf8")
    ).sequence,
    1 + (workers * 2)
  );
  assert.equal(
    fs.existsSync(path.join(dataDir, "projects", ".mutation.lock")),
    false,
    "successful writers release the mutation lock"
  );
});

test("ProjectStore change observers run only after the mutation lock is released", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-store-callback-"))
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const defaultWorkspaceRoot = path.join(root, "legacy-workspace");
  fs.mkdirSync(defaultWorkspaceRoot, { recursive: true });
  const lockPath = path.join(dataDir, "projects", ".mutation.lock");
  const observations = [];
  const store = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot,
    onChange(change) {
      observations.push({
        op: change.op,
        lockExists: fs.existsSync(lockPath)
      });
    }
  });
  store.create({ id: "callback-test", name: "Callback Test" });
  assert.deepEqual(
    observations.map((entry) => entry.op),
    ["create-default", "create"]
  );
  assert.equal(observations.every((entry) => entry.lockExists === false), true);
});

test("snapshot failure leaves the authoritative event readable after restart", (t) => {
  const { dataDir, defaultWorkspaceRoot, store } = fixture(t);
  const alpha = store.create(fullProjectInput());
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  store.writeSnapshot = () => {
    throw new Error("snapshot unavailable");
  };
  try {
    const updated = store.update("alpha", { name: "Event Wins" }, {
      expectedRevision: alpha.revision
    });
    assert.equal(updated.name, "Event Wins");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  const reloaded = new ProjectStore({ dataDir, defaultWorkspaceRoot });
  assert.equal(reloaded.get("alpha").name, "Event Wins");
});

test("tool-output references enforce project ownership across restart", (t) => {
  const { dataDir } = fixture(t);
  const dir = path.join(dataDir, "tool-output-isolation");
  const store = new ToolOutputStore({ dir });
  const alphaRef = store.put("alpha evidence", {
    projectId: "alpha",
    ownerType: "turn",
    ownerId: "turn-alpha"
  });
  const betaRef = store.put("beta evidence", {
    projectId: "beta",
    ownerType: "turn",
    ownerId: "turn-beta"
  });
  assert.equal(store.read(alphaRef, { projectId: "alpha" }).content, "alpha evidence");
  assert.throws(
    () => store.read(alphaRef, { projectId: "beta" }),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  const reloaded = new ToolOutputStore({ dir });
  assert.equal(reloaded.read(betaRef, { projectId: "beta" }).content, "beta evidence");
  assert.throws(
    () => reloaded.read(betaRef, { projectId: DEFAULT_PROJECT_ID }),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );
});

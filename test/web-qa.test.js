import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { AbiRuntime } from "../src/abi-runtime.js";
import { buildDefaultInstructions } from "../src/model-provider.js";
import {
  QaArtifactStore,
  QaBaselineStore,
  QaRunStore
} from "../src/qa-store.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import {
  registerWebQaTools,
  WebQaController,
  WEB_QA_INTERNALS
} from "../src/web-qa.js";
import { normalizeExplorationPolicy } from "../src/ui-state-explorer.js";

function harness(t, browser = new FakeQaBrowser()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-web-qa-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = true;\n"
  );
  writeManifest(workspaceRoot);
  const store = new QaRunStore({ dir: path.join(dataDir, "runs") });
  const artifacts = new QaArtifactStore({
    dir: path.join(dataDir, "artifacts")
  });
  const baselines = new QaBaselineStore({
    dir: path.join(dataDir, "baselines")
  });
  const controller = new WebQaController({
    browser,
    store,
    artifacts,
    baselines,
    workspaceDir: workspaceRoot
  });
  const context = {
    __projectId: "alpha",
    projectRevision: 1,
    sessionId: "qa-session",
    __projectWorkspaceDir: workspaceRoot,
    approved: true
  };
  return {
    artifacts,
    baselines,
    browser,
    context,
    controller,
    dataDir,
    root,
    store,
    workspaceRoot
  };
}

class FakeQaBrowser {
  constructor({
    extraControl = false,
    diagnosticError = false,
    accessibilityViolation = false,
    deadSave = false
  } = {}) {
    this.dnsLookup = async () => [];
    this.extraControl = extraControl;
    this.diagnosticError = diagnosticError;
    this.accessibilityViolation = accessibilityViolation;
    this.deadSave = deadSave;
    this.activations = 0;
    this.visualVariant = "";
    this.opened = false;
    this.traceActive = false;
    this.closed = 0;
    this.reset();
  }

  reset() {
    this.url = null;
    this.bodyText = "Editor";
    this.nameValue = "";
    this.nodes = [
      {
        ref: "ref_save",
        role: "button",
        name: "Save",
        disabled: false
      },
      {
        ref: "ref_name",
        role: "textbox",
        name: "Name",
        value: "",
        disabled: false
      },
      ...(this.extraControl
        ? [{
            ref: "ref_extra",
            role: "button",
            name: "Undeclared",
            disabled: false
          }]
        : [])
    ];
  }

  async openForQa({ url }) {
    this.reset();
    this.url = url;
    this.opened = true;
    this.traceActive = true;
    return this.inspect();
  }

  async waitForQaSettled() {
    return this.qaPageState();
  }

  async qaPageState() {
    return {
      url: this.url,
      title: "Fixture editor",
      bodyText: this.bodyText,
      readyState: "complete",
      busyCount: 0,
      active: null
    };
  }

  async inspect() {
    return {
      url: this.url,
      title: "Fixture editor",
      nodes: this.nodes.map((node) => ({ ...node }))
    };
  }

  async activate({ ref }) {
    this.activations += 1;
    if (ref === "ref_save" && !this.deadSave) {
      this.bodyText = "Editor\nSaved";
    }
  }

  async input({ ref, text }) {
    if (ref !== "ref_name") throw new Error("unexpected input ref");
    this.nameValue = text;
    this.bodyText = `Editor\nName:${text}`;
    this.nodes = this.nodes.map((node) => (
      node.ref === ref ? { ...node, value: text } : node
    ));
  }

  async select() {
    throw new Error("select was not expected");
  }

  async qaDiagnostics() {
    return {
      supported: true,
      events: this.diagnosticError
        ? [{
            kind: "pageerror",
            severity: "error",
            message: "fixture exploded"
          }]
        : []
    };
  }

  async qaAccessibility() {
    return {
      supported: true,
      violations: this.accessibilityViolation
        ? [{
            id: "button-name",
            impact: "critical",
            help: "Buttons must have discernible text."
          }]
        : [],
      incomplete: []
    };
  }

  async qaKeyboardAudit() {
    return {
      supported: true,
      total: this.nodes.length,
      visited: this.nodes.length,
      missing: [],
      focusVisibleFailures: [],
      trapped: false
    };
  }

  async screenshot() {
    return {
      image: {
        mediaType: "image/png",
        data: fixturePng(`${this.bodyText}:${this.visualVariant}`).toString(
          "base64"
        )
      },
      width: 1280,
      height: 720
    };
  }

  async stopQaTrace({ retain }) {
    if (!this.traceActive) return null;
    this.traceActive = false;
    return retain
      ? {
          mediaType: "application/zip",
          data: Buffer.from("trace-bytes").toString("base64")
        }
      : null;
  }

  async close() {
    this.opened = false;
    this.closed += 1;
    return { closed: true };
  }

  async closeAll() {
    this.opened = false;
  }
}

function fixturePng(seed) {
  const color = createHash("sha256").update(seed).digest();
  const png = new PNG({ width: 8, height: 8 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function writeManifest(workspaceRoot, patch = {}) {
  const manifest = {
    version: 1,
    title: "Editor QA",
    baseUrl: "http://127.0.0.1:43111",
    fixture: true,
    sourceFiles: ["app.js"],
    viewports: [{
      id: "desktop",
      width: 1280,
      height: 720
    }],
    routes: [{
      id: "editor",
      path: "/editor",
      assertions: {
        text: ["Editor"],
        notText: ["Fatal error"],
        urlPath: "/editor"
      },
      controls: [
        {
          id: "save_button",
          role: "button",
          name: "Save",
          action: "activate",
          expect: { text: ["Saved"] }
        },
        {
          id: "name_input",
          role: "textbox",
          name: "Name",
          action: "input",
          value: "Ada",
          expect: {
            nodes: [{
              role: "textbox",
              name: "Name",
              value: "Ada"
            }]
          }
        }
      ]
    }],
    ...patch
  };
  fs.writeFileSync(
    path.join(workspaceRoot, "qa-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

test("web QA proves routes, all declared controls, and screenshots", async (t) => {
  const { artifacts, context, controller } = harness(t);
  const result = await controller.run({}, context);

  assert.equal(result.ok, true);
  assert.equal(result.run.state, "passed");
  assert.equal(result.run.summary.routes, 1);
  assert.equal(result.run.summary.controls, 2);
  assert.equal(result.run.summary.controlsCovered, 2);
  assert.equal(result.run.summary.failed, 0);
  assert.equal(result.run.results.length, 3);
  assert.ok(result.run.results.every((entry) => entry.status === "passed"));
  assert.equal(result.run.artifacts.length, 3);

  const screenshotRef = result.run.results[0].artifacts[0];
  const screenshot = controller.artifact({
    runId: result.run.id,
    ref: screenshotRef,
    includeData: true
  }, context);
  assert.equal(screenshot.mediaType, "image/png");
  assert.equal(screenshot.image.mediaType, "image/png");
  assert.ok(screenshot.image.data.length > 0);
  assert.equal(
    artifacts.list({
      projectId: "alpha",
      runId: result.run.id
    }).length,
    3
  );
});

test("state exploration builds a bounded semantic graph without page content", async (t) => {
  const { context, controller } = harness(t);
  const result = await controller.run({ mode: "explore" }, context);

  assert.equal(result.ok, true);
  assert.equal(result.run.state, "passed");
  assert.equal(result.run.results.length, 2);
  assert.equal(result.run.summary.exploredStates, 4);
  assert.equal(result.run.summary.exploredTransitions, 4);
  assert.equal(result.run.summary.explorationActions, 4);
  assert.equal(result.run.summary.failedTransitions, 0);
  assert.equal(result.run.summary.explorationTruncated, false);

  const exploration = result.run.results.find(
    (entry) => entry.kind === "exploration"
  );
  assert.equal(exploration.status, "passed");
  assert.equal(exploration.exploration.maxDepthReached, 2);
  const graphArtifact = controller.artifact({
    runId: result.run.id,
    ref: exploration.exploration.graphRef,
    includeData: true
  }, context);
  const graph = JSON.parse(graphArtifact.data);
  assert.equal(graph.states.length, 4);
  assert.equal(graph.transitions.length, 4);
  assert.equal(graph.rootStateId, graph.states[0].id);
  assert.doesNotMatch(graphArtifact.data, /Ada|Saved|Name:/);
  assert.ok(graph.states.every((state) => (
    state.id.startsWith("state_")
    && Array.isArray(state.path)
    && !Object.hasOwn(state, "bodyText")
  )));
});

test("state exploration retains deterministic failure replay and trace evidence", async (t) => {
  const browser = new FakeQaBrowser({ deadSave: true });
  const { context, controller } = harness(t, browser);
  const result = await controller.run({ mode: "explore" }, context);

  assert.equal(result.ok, false);
  assert.equal(result.run.state, "failed");
  const exploration = result.run.results.find(
    (entry) => entry.kind === "exploration"
  );
  assert.equal(exploration.status, "failed");
  assert.ok(exploration.exploration.failedTransitions >= 1);
  assert.ok(exploration.failures.some(
    (failure) => failure.code === "expected_text_missing"
  ));
  assert.ok(exploration.traceRef);
  assert.ok(exploration.exploration.replayRefs.length >= 1);

  const replays = exploration.exploration.replayRefs.map((ref) => {
    const artifact = controller.artifact({
      runId: result.run.id,
      ref,
      includeData: true
    }, context);
    return JSON.parse(artifact.data);
  });
  replays.sort((left, right) => left.steps.length - right.steps.length);
  assert.equal(replays[0].method, "breadth_first_shortest_known_path");
  assert.deepEqual(replays[0].steps, [{
    controlId: "save_button",
    action: "activate"
  }]);
  assert.ok(replays[0].failureCodes.includes("expected_text_missing"));
});

test("state exploration excludes destructive actions unless fixture policy opts in", async (t) => {
  const browser = new FakeQaBrowser();
  const { context, controller, workspaceRoot } = harness(t, browser);
  const controls = [{
    id: "save_button",
    role: "button",
    name: "Save",
    action: "activate",
    destructive: true,
    expect: { text: ["Saved"] }
  }, {
    id: "name_input",
    role: "textbox",
    name: "Name",
    action: "input",
    value: "Ada",
    expect: {
      nodes: [{
        role: "textbox",
        name: "Name",
        value: "Ada"
      }]
    }
  }];
  writeManifest(workspaceRoot, {
    routes: [{
      id: "editor",
      path: "/editor",
      assertions: { text: ["Editor"], urlPath: "/editor" },
      controls
    }]
  });

  const safe = await controller.run({ mode: "explore" }, context);
  assert.equal(safe.ok, true);
  assert.equal(browser.activations, 0);
  assert.equal(safe.run.summary.exploredTransitions, 1);

  writeManifest(workspaceRoot, {
    exploration: { includeDestructive: true },
    routes: [{
      id: "editor",
      path: "/editor",
      assertions: { text: ["Editor"], urlPath: "/editor" },
      controls
    }]
  });
  const optedIn = await controller.run({ mode: "explore" }, context);
  assert.equal(optedIn.ok, true);
  assert.ok(browser.activations > 0);
  assert.throws(
    () => normalizeExplorationPolicy(
      { includeDestructive: true },
      { fixture: false }
    ),
    /only when fixture=true/
  );
});

test("state exploration fails closed when a declared exploration budget is exhausted", async (t) => {
  const { context, controller, workspaceRoot } = harness(t);
  writeManifest(workspaceRoot, {
    exploration: {
      maxActions: 1,
      maxStates: 16,
      maxDepth: 3,
      timeoutMs: 60_000
    }
  });
  const result = await controller.run({ mode: "explore" }, context);

  assert.equal(result.ok, false);
  assert.equal(result.run.summary.explorationTruncated, true);
  const exploration = result.run.results.find(
    (entry) => entry.kind === "exploration"
  );
  assert.equal(exploration.exploration.truncationReason, "action_budget");
  assert.ok(exploration.failures.some(
    (failure) => failure.code === "exploration_incomplete"
  ));
});

test("state exploration rejects action expectations already satisfied before use", async (t) => {
  const { context, controller, workspaceRoot } = harness(t);
  writeManifest(workspaceRoot, {
    routes: [{
      id: "editor",
      path: "/editor",
      assertions: { text: ["Editor"], urlPath: "/editor" },
      controls: [{
        id: "save_button",
        role: "button",
        name: "Save",
        action: "activate",
        expect: { text: ["Editor"] }
      }, {
        id: "name_input",
        role: "textbox",
        name: "Name",
        action: "input",
        value: "Ada",
        expect: {
          nodes: [{
            role: "textbox",
            name: "Name",
            value: "Ada"
          }]
        }
      }]
    }]
  });
  const result = await controller.run({ mode: "explore" }, context);

  assert.equal(result.ok, false);
  const exploration = result.run.results.find(
    (entry) => entry.kind === "exploration"
  );
  assert.ok(exploration.failures.some(
    (failure) => failure.code === "exploration_control_unexercised"
      && failure.controlId === "save_button"
  ));
});

test("unclassified controls, browser errors, and accessibility failures retain traces", async (t) => {
  const browser = new FakeQaBrowser({
    extraControl: true,
    diagnosticError: true,
    accessibilityViolation: true
  });
  const { artifacts, context, controller } = harness(t, browser);
  const result = await controller.run({}, context);

  assert.equal(result.ok, false);
  assert.equal(result.run.state, "failed");
  assert.ok(result.run.summary.failed >= 1);
  const codes = result.run.results.flatMap(
    (entry) => entry.failures.map((item) => item.code)
  );
  assert.ok(codes.includes("unclassified_control"));
  assert.ok(codes.includes("diagnostic_pageerror"));
  assert.ok(codes.includes("a11y_button-name"));
  assert.ok(artifacts.list({
    projectId: "alpha",
    runId: result.run.id
  }).some((artifact) => artifact.kind === "playwright_trace"));
});

test("QA manifests reject destructive host actions and expired exemptions", async (t) => {
  const { context, controller, workspaceRoot } = harness(t);
  writeManifest(workspaceRoot, {
    fixture: false,
    routes: [{
      id: "editor",
      path: "/editor",
      controls: [{
        id: "delete_button",
        role: "button",
        name: "Save",
        action: "activate",
        destructive: true,
        expect: { text: ["Saved"] }
      }]
    }]
  });
  await assert.rejects(
    controller.run({}, context),
    /requires fixture=true/
  );

  const coverage = WEB_QA_INTERNALS.evaluateControlCoverage(
    [{ role: "button", name: "Later" }],
    {
      controls: [],
      exemptions: [{
        role: "button",
        name: "Later",
        nth: 0,
        reason: "Temporary",
        expiresAt: "2020-01-01T00:00:00.000Z"
      }]
    }
  );
  assert.ok(
    coverage.failures.some(
      (entry) => entry.code === "expired_control_exemption"
    )
  );
});

test("QA tools are gated, prompt-visible, and setup-allowlisted", () => {
  const specs = [];
  registerWebQaTools({
    register(spec) {
      specs.push(spec);
    }
  }, {
    webQa: {
      run: async () => ({}),
      status: () => ({}),
      artifact: () => ({}),
      approveBaselines: () => ({})
    }
  });

  assert.deepEqual(
    specs.map((spec) => spec.name),
    ["qa_run", "qa_status", "qa_artifact", "qa_approve_baseline"]
  );
  assert.equal(specs[0].needsConfirmation, true);
  assert.equal(specs[0].sideEffects, true);
  assert.deepEqual(
    specs[0].parameters.properties.mode.enum,
    ["full", "impacted", "explore"]
  );
  assert.equal(specs[1].sideEffects, false);
  assert.equal(specs[3].manualApproval, true);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_WEB_QA"));
  const prompt = buildDefaultInstructions({ agent: { name: "QA" } });
  assert.match(prompt, /qa_run\(manifestPath\?/);
  assert.match(prompt, /bounded breadth-first semantic state exploration/);
  assert.match(prompt, /qa_approve_baseline\(runId/);
  assert.match(prompt, /classify every interactive control/);
});

test("visual baselines require a human and produce deterministic diffs", async (t) => {
  const browser = new FakeQaBrowser();
  const { context, controller } = harness(t, browser);
  const first = await controller.run({}, context);

  assert.throws(
    () => controller.approveBaselines({ runId: first.run.id }, context),
    /manual human approval/
  );
  const manualContext = {
    ...context,
    __pendingActionId: "action_visual_1",
    __approval: { decider: "human-reviewer" }
  };
  const approval = controller.approveBaselines({
    runId: first.run.id
  }, manualContext);
  assert.equal(approval.approved.length, 3);

  const matched = await controller.run({}, context);
  assert.equal(matched.ok, true);
  assert.ok(
    matched.run.results.every((result) => result.visual.status === "matched")
  );

  browser.visualVariant = "changed";
  const changed = await controller.run({}, context);
  assert.equal(changed.ok, false);
  assert.ok(changed.run.summary.visualChanges > 0);
  const visual = changed.run.results.find(
    (result) => result.visual.status === "changed"
  )?.visual;
  assert.ok(visual?.diffRef);
  assert.ok(visual.diffRatio > visual.maxDiffRatio);
});

test("strict visual mode can bootstrap only from otherwise-passing evidence", async (t) => {
  const { context, controller, workspaceRoot } = harness(t);
  const current = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "qa-manifest.json"), "utf8")
  );
  current.routes[0].visual = "strict";
  fs.writeFileSync(
    path.join(workspaceRoot, "qa-manifest.json"),
    `${JSON.stringify(current, null, 2)}\n`
  );
  const missing = await controller.run({}, context);

  assert.equal(missing.ok, false);
  assert.ok(
    missing.run.results.every(
      (result) => result.failures.every(
        (entry) => entry.code === "visual_baseline_missing"
      )
    )
  );
  controller.approveBaselines({
    runId: missing.run.id
  }, {
    ...context,
    __pendingActionId: "action_visual_2",
    __approval: { decider: "human-reviewer" }
  });
  const verified = await controller.run({}, context);
  assert.equal(verified.ok, true);
});

test("runtime opt-in wires and closes the QA controller", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-web-qa-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  const browser = new FakeQaBrowser();
  const runtime = new AbiRuntime({
    dataDir: path.join(root, "data"),
    workspaceDir: workspaceRoot,
    env: { OPENAGI_WEB_QA: "1" },
    webQaOptions: { browser }
  });

  assert.ok(runtime.webQa instanceof WebQaController);
  assert.equal(typeof runtime.tools.get("qa_run")?.handler, "function");
  await runtime.close();
});

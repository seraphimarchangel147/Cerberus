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
import { QaComparisonStore } from "../src/qa-differential.js";

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
    diagnosticWarning = false,
    accessibilityViolation = false,
    deadSave = false
  } = {}) {
    this.dnsLookup = async () => [];
    this.extraControl = extraControl;
    this.diagnosticError = diagnosticError;
    this.diagnosticWarning = diagnosticWarning;
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
    const events = [];
    if (this.diagnosticError) {
      events.push({
        kind: "pageerror",
        severity: "error",
        message: "fixture exploded"
      });
    }
    if (this.diagnosticWarning) {
      events.push({
        kind: "console",
        severity: "warning",
        message: "fixture warning"
      });
    }
    return {
      supported: true,
      events
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

test("revision comparison preserves deterministic behavior intent", async (t) => {
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t);
  writeManifest(workspaceRoot, {
    intent: {
      version: 1,
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "editor_behavior",
        statement: "Editor behavior remains stable.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  const reference = await controller.run({}, context);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'candidate';\n"
  );
  const candidate = await controller.run({
    referenceRunId: reference.run.id
  }, context);

  assert.equal(candidate.ok, true);
  assert.equal(candidate.status, "passed");
  assert.equal(candidate.run.comparison.status, "passed");
  assert.equal(candidate.run.comparison.summary.intended, 1);
  assert.ok(candidate.run.artifacts.includes(
    candidate.run.comparison.artifactRef
  ));
  const comparison = controller.comparisonStatus({
    comparisonId: candidate.run.comparison.id
  }, context);
  assert.equal(comparison.status, "passed");
  assert.equal(comparison.criteria[0].classification, "intended");
  assert.deepEqual(comparison.criteria[0].basis, ["preserved"]);
  assert.equal(comparison.reference.runId, reference.run.id);
  assert.equal(comparison.candidate.runId, candidate.run.id);
  const repeated = controller.compare({
    referenceRunId: reference.run.id,
    candidateRunId: candidate.run.id
  }, context);
  assert.equal(repeated.comparison.id, comparison.id);
  assert.equal(controller.comparisons.list({
    projectId: "alpha",
    sessionId: "qa-session"
  }).length, 1);

  const report = controller.artifact({
    runId: candidate.run.id,
    ref: comparison.artifactRef,
    includeData: true
  }, context);
  assert.equal(JSON.parse(report.data).status, "passed");
  assert.equal(report.data.includes("Editor behavior remains stable."), false);

  const recovered = new QaComparisonStore({
    dir: controller.comparisons.dir
  }).get(comparison.id);
  assert.equal(recovered.status, "passed");
  assert.equal(recovered.artifactRef, comparison.artifactRef);

  const snapshotPath = path.join(
    controller.comparisons.dir,
    "snapshot.json"
  );
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  snapshot.comparisons[0].status = "failed";
  snapshot.comparisons[0].privateContent = "snapshot-must-not-win";
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  fs.appendFileSync(
    path.join(controller.comparisons.dir, "events.jsonl"),
    "{\"truncated\":"
  );
  const journalRecovered = new QaComparisonStore({
    dir: controller.comparisons.dir
  }).get(comparison.id);
  assert.equal(journalRecovered.status, "passed");
  assert.equal(
    JSON.stringify(journalRecovered).includes("snapshot-must-not-win"),
    false
  );
  assert.throws(
    () => new QaComparisonStore({
      dir: controller.comparisons.dir
    }).create(recovered),
    /corrupt suffix/
  );
});

test("revision comparison classifies deterministic behavior regressions", async (t) => {
  const browser = new FakeQaBrowser();
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t, browser);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "save_behavior",
        statement: "Saving continues to produce visible feedback.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor",
        controlId: "save_button"
      }]
    }
  });
  const reference = await controller.run({}, context);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'broken-candidate';\n"
  );
  browser.deadSave = true;
  const candidate = await controller.run({
    referenceRunId: reference.run.id
  }, context);

  assert.equal(candidate.ok, false);
  assert.equal(candidate.run.state, "failed");
  assert.equal(candidate.run.comparison.status, "failed");
  const comparison = controller.comparisonStatus({
    comparisonId: candidate.run.comparison.id
  }, context);
  assert.equal(comparison.implementation.passed, false);
  assert.equal(comparison.criteria[0].classification, "regression");
  assert.ok(comparison.criteria[0].basis.includes(
    "candidate_quality_worsened"
  ));
  assert.ok(comparison.hypotheses.some(
    (hypothesis) => hypothesis.code === "behavior_regression"
  ));
  assert.ok(comparison.hypotheses.some(
    (hypothesis) => hypothesis.code === "candidate_implementation_failed"
  ));
});

test("revision comparison ignores salted state ids and compares graph structure", async (t) => {
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "editor_state_graph",
        statement: "The editor interaction graph remains stable.",
        oracle: "state_graph",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  const reference = await controller.run({ mode: "explore" }, context);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'same-state-graph';\n"
  );
  const candidate = await controller.run({
    mode: "explore",
    referenceRunId: reference.run.id
  }, context);

  assert.equal(candidate.ok, true);
  const comparison = controller.comparisonStatus({
    comparisonId: candidate.run.comparison.id
  }, context);
  assert.equal(comparison.criteria[0].classification, "intended");
  assert.equal(comparison.criteria[0].observed.changed, false);
  assert.equal(comparison.criteria[0].observed.direction, "same");
  assert.ok(comparison.criteria[0].evidenceRefs.length >= 2);
});

test("revision comparison fails when a declared state change never appears", async (t) => {
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "new_editor_state",
        statement: "The candidate introduces a new editor interaction state.",
        oracle: "state_graph",
        expectation: "change",
        routeId: "editor"
      }]
    }
  });
  const reference = await controller.run({ mode: "explore" }, context);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'missing-state-change';\n"
  );
  const candidate = await controller.run({
    mode: "explore",
    referenceRunId: reference.run.id
  }, context);

  assert.equal(candidate.ok, false);
  assert.equal(candidate.run.state, "passed");
  assert.equal(candidate.run.comparison.status, "failed");
  const comparison = controller.comparisonStatus({
    comparisonId: candidate.run.comparison.id
  }, context);
  assert.equal(comparison.criteria[0].classification, "regression");
  assert.deepEqual(
    comparison.criteria[0].basis,
    ["expected_change_missing"]
  );
  assert.ok(comparison.hypotheses.some(
    (hypothesis) => hypothesis.code === "expected_change_missing"
  ));
});

test("revision comparison surfaces possible improvements for review", async (t) => {
  const browser = new FakeQaBrowser({ diagnosticWarning: true });
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t, browser);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "editor_diagnostics",
        statement: "The editor remains free of browser diagnostics.",
        oracle: "diagnostics",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  const reference = await controller.run({}, context);
  assert.equal(reference.ok, true);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'warning-removed';\n"
  );
  browser.diagnosticWarning = false;
  const candidate = await controller.run({
    referenceRunId: reference.run.id
  }, context);

  assert.equal(candidate.ok, false);
  assert.equal(candidate.status, "review_required");
  assert.equal(candidate.run.state, "passed");
  const comparison = controller.comparisonStatus({
    comparisonId: candidate.run.comparison.id
  }, context);
  assert.equal(
    comparison.criteria[0].classification,
    "improvement_candidate"
  );
  assert.equal(comparison.criteria[0].observed.direction, "better");
  assert.ok(comparison.hypotheses.some(
    (hypothesis) => hypothesis.code === "possible_improvement"
  ));
});

test("visual intent changes require an exact human-approved baseline", async (t) => {
  const browser = new FakeQaBrowser();
  const {
    context,
    controller,
    workspaceRoot
  } = harness(t, browser);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "editor_visual",
        statement: "The editor receives the approved visual redesign.",
        oracle: "visual",
        expectation: "change",
        routeId: "editor"
      }]
    }
  });
  const manualContext = {
    ...context,
    __pendingActionId: "action_visual_intent",
    __approval: { decider: "human-reviewer" }
  };
  const reference = await controller.run({}, context);
  controller.approveBaselines({
    runId: reference.run.id
  }, manualContext);

  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'visual-candidate';\n"
  );
  browser.visualVariant = "approved-redesign";
  const unapproved = await controller.run({}, context);
  assert.equal(unapproved.ok, false);
  assert.ok(unapproved.run.results.some(
    (result) => result.visual.status === "changed"
  ));

  const review = controller.compare({
    referenceRunId: reference.run.id,
    candidateRunId: unapproved.run.id
  }, context);
  assert.equal(review.status, "failed");
  assert.equal(
    review.comparison.criteria[0].classification,
    "review_required"
  );
  assert.ok(review.comparison.criteria[0].basis.includes(
    "visual_change_not_human_approved"
  ));

  controller.approveBaselines({
    runId: unapproved.run.id
  }, {
    ...manualContext,
    __pendingActionId: "action_visual_intent_candidate"
  });
  const approved = controller.compare({
    referenceRunId: reference.run.id,
    candidateRunId: unapproved.run.id
  }, context);
  assert.equal(approved.ok, true);
  assert.equal(approved.status, "passed");
  assert.equal(
    approved.comparison.criteria[0].classification,
    "intended"
  );
  assert.equal(
    approved.comparison.criteria[0].observed.humanApproved,
    true
  );

  const rerun = await controller.run({
    referenceRunId: reference.run.id
  }, context);
  assert.equal(rerun.ok, true);
  assert.equal(rerun.run.state, "passed");
  assert.equal(rerun.run.comparison.status, "passed");
});

test("revision comparison rejects incompatible browser epochs", async (t) => {
  const {
    context,
    controller,
    store,
    artifacts,
    baselines,
    workspaceRoot
  } = harness(t);
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "editor-fixture-v1",
      criteria: [{
        id: "editor_behavior",
        statement: "Editor behavior remains stable.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  const reference = await controller.run({}, context);
  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export const app = 'new-process';\n"
  );
  const otherController = new WebQaController({
    browser: new FakeQaBrowser(),
    store,
    artifacts,
    baselines,
    comparisonDir: controller.comparisons.dir,
    workspaceDir: workspaceRoot
  });
  const candidate = await otherController.run({}, context);

  assert.throws(
    () => otherController.compare({
      referenceRunId: reference.run.id,
      candidateRunId: candidate.run.id
    }, context),
    /same browser execution epoch/
  );
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

  writeManifest(workspaceRoot, {
    intent: {
      criteria: [{
        id: "missing_fixture_revision",
        statement: "This comparison contract is incomplete.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  await assert.rejects(
    controller.run({}, context),
    /fixtureRevision/
  );
  writeManifest(workspaceRoot, {
    intent: {
      fixtureRevision: "fixture-\u0430",
      criteria: [{
        id: "ascii_intent",
        statement: "Reject a lookalike fixture identifier.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor"
      }]
    }
  });
  await assert.rejects(
    controller.run({}, context),
    /fixtureRevision/
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
      compare: () => ({}),
      status: () => ({}),
      comparisonStatus: () => ({}),
      artifact: () => ({}),
      approveBaselines: () => ({})
    }
  });

  assert.deepEqual(
    specs.map((spec) => spec.name),
    [
      "qa_run",
      "qa_compare",
      "qa_status",
      "qa_comparison_status",
      "qa_artifact",
      "qa_approve_baseline"
    ]
  );
  assert.equal(specs[0].needsConfirmation, true);
  assert.equal(specs[0].sideEffects, true);
  assert.deepEqual(
    specs[0].parameters.properties.mode.enum,
    ["full", "impacted", "explore"]
  );
  assert.equal(
    specs[0].parameters.properties.referenceRunId.pattern,
    "^qa_[a-f0-9]{16}$"
  );
  assert.equal(specs[1].sideEffects, false);
  assert.equal(specs[3].sideEffects, false);
  assert.equal(specs[5].manualApproval, true);
  assert.ok(SETUP_FIELDS.includes("OPENAGI_WEB_QA"));
  const prompt = buildDefaultInstructions({ agent: { name: "QA" } });
  assert.match(prompt, /qa_run\(manifestPath\?/);
  assert.match(prompt, /bounded breadth-first semantic state exploration/);
  assert.match(prompt, /qa_compare\(referenceRunId, candidateRunId\)/);
  assert.match(prompt, /explicit fixtureRevision/);
  assert.match(prompt, /visual change is never self-approved/);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebQaController } from "../src/web-qa.js";

const BROWSER_UNAVAILABLE_RE
  = /browser|executable|playwright|pixelmatch|pngjs|unavailable/i;

/**
 * A missing Playwright browser (or a missing optional QA package) surfaces two
 * different ways depending on where it is caught:
 *   - thrown out of the run  -> run.error.code === "qa_execution_failed"
 *   - caught per route/control -> rolled into "qa_evidence_failed" with the
 *     real reason nested in run.results[].failures[].
 * Inspect both so the skip guard can actually fire on a machine that has not
 * run `npx playwright install`.
 */
function playwrightUnavailableReason(run) {
  const code = run?.error?.code;
  if (code === "qa_execution_failed") {
    const message = String(run.error.message ?? "");
    return BROWSER_UNAVAILABLE_RE.test(message) ? message : null;
  }
  if (code !== "qa_evidence_failed") return null;
  for (const result of run?.results ?? []) {
    for (const entry of result?.failures ?? []) {
      const message = String(entry?.message ?? "");
      if (
        entry?.code === "page_execution_failed"
        || entry?.code === "browser_adapter_unavailable"
        || entry?.code === "visual_comparator_unavailable"
      ) {
        if (BROWSER_UNAVAILABLE_RE.test(message)) return message;
      }
    }
  }
  return null;
}

test("real Playwright QA clicks controls, audits accessibility, and captures screenshots", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-web-qa-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, "app.js"), "export default true;\n");

  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end([
      "<!doctype html>",
      '<html lang="en">',
      "<head><meta charset=\"utf-8\"><title>Editor fixture</title></head>",
      "<body><main>",
      "<h1>Editor</h1>",
      '<label for="name">Name</label>',
      '<input id="name" type="text">',
      '<button id="save" type="button">Save</button>',
      '<output id="status" aria-live="polite"></output>',
      "</main>",
      "<script>",
      "document.querySelector('#save').addEventListener('click', () => {",
      "  document.querySelector('#status').textContent = 'Saved';",
      "});",
      "</script></body></html>"
    ].join(""));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const manifest = {
    version: 1,
    title: "Real browser fixture",
    baseUrl: `http://127.0.0.1:${address.port}`,
    fixture: true,
    sourceFiles: ["app.js"],
    intent: {
      version: 1,
      fixtureRevision: "real-editor-v1",
      criteria: [{
        id: "editor_behavior",
        statement: "The editor behavior remains stable.",
        oracle: "behavior",
        expectation: "preserve",
        routeId: "editor"
      }]
    },
    routes: [{
      id: "editor",
      path: "/editor",
      assertions: {
        text: ["Editor"],
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
    }]
  };
  fs.writeFileSync(
    path.join(workspaceRoot, "qa-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const controller = new WebQaController({
    dataDir: path.join(root, "data"),
    workspaceDir: workspaceRoot
  });
  t.after(() => controller.close());
  const result = await controller.run({}, {
    __projectId: "alpha",
    sessionId: "real-browser-session",
    __projectWorkspaceDir: workspaceRoot,
    approved: true
  });
  const unavailable = playwrightUnavailableReason(result.run);
  if (unavailable) {
    t.skip(`Playwright browser unavailable: ${unavailable}`);
    return;
  }

  assert.equal(result.ok, true, JSON.stringify({
    error: result.run.error,
    results: result.run.results
  }));
  assert.equal(result.run.summary.routes, 1);
  assert.equal(result.run.summary.controls, 2);
  assert.equal(result.run.summary.failed, 0);
  assert.ok(result.run.results.every(
    (entry) => entry.accessibility.supported === true
  ));
  assert.ok(result.run.results.every(
    (entry) => entry.keyboard.supported === true
      && entry.keyboard.missing === 0
      && entry.keyboard.focusVisibleFailures === 0
      && entry.keyboard.trapped === false
  ));
  assert.ok(result.run.results.every(
    (entry) => /^qaart_[a-f0-9]{64}$/.test(entry.screenshotRef)
  ));

  fs.writeFileSync(
    path.join(workspaceRoot, "app.js"),
    "export default 'candidate';\n"
  );
  const differential = await controller.run({
    referenceRunId: result.run.id
  }, {
    __projectId: "alpha",
    sessionId: "real-browser-session",
    __projectWorkspaceDir: workspaceRoot,
    approved: true
  });
  assert.equal(differential.ok, true, JSON.stringify({
    error: differential.run.error,
    comparison: differential.run.comparison
  }));
  assert.equal(differential.run.comparison.status, "passed");

  const exploration = await controller.run({ mode: "explore" }, {
    __projectId: "alpha",
    sessionId: "real-browser-session",
    __projectWorkspaceDir: workspaceRoot,
    approved: true
  });
  assert.equal(exploration.ok, true, JSON.stringify({
    error: exploration.run.error,
    results: exploration.run.results
  }));
  assert.equal(exploration.run.summary.exploredStates, 4);
  assert.equal(exploration.run.summary.exploredTransitions, 4);
  assert.equal(exploration.run.summary.failedTransitions, 0);
  assert.equal(exploration.run.summary.explorationTruncated, false);
  assert.ok(exploration.run.results.some(
    (entry) => entry.kind === "exploration"
      && /^qaart_[a-f0-9]{64}$/.test(entry.exploration.graphRef)
  ));
});

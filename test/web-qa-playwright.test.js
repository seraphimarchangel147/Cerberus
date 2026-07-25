import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebQaController } from "../src/web-qa.js";

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
  if (
    result.run.error?.code === "qa_execution_failed"
    && /browser|executable|playwright/i.test(result.run.error.message)
  ) {
    t.skip(`Playwright browser unavailable: ${result.run.error.message}`);
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
});

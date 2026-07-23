import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDurableRuntime,
  createHostedInterface
} from "../src/index.js";
import { CliClient } from "../src/cli-client.js";

async function fetchJson(base, token, route, options = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.headers ?? {})
  };
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return {
    response,
    text,
    json: text ? JSON.parse(text) : null
  };
}

test("Kanban tools, HTTP routes, CLI client, and dashboard form one safe surface", async (t) => {
  // Windows cannot fsync a read-only handle. Production runs on Node's
  // supported Unix daemon targets, while the Windows test lane uses the same
  // narrow shim as the CLI persistence tests.
  if (process.platform === "win32") {
    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = () => {};
    t.after(() => { fs.fsyncSync = originalFsync; });
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-kanban-http-"));
  const authToken = "kanban-http-test-token";
  const previousAuthToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = authToken;

  const runtime = createDurableRuntime({
    dataDir,
    autoConnectMcp: false,
    // ObservationStore also owns a SQLite handle but has no close method.
    // This route test does not exercise observations, so avoid leaking an
    // unrelated handle into the temporary-directory cleanup.
    observations: {},
    // SessionIndex has no close surface; keep this focused test on Kanban's
    // SQLite handle so its temporary directory can be removed on Windows.
    sessionIndexOptions: { fallback: true }
  });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken
  });

  try {
    const listened = await app.listen();
    const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
    const unsafeTitle = `Tool task "><img src=x onerror=alert("kanban-xss")>`;
    const unsafeBody = `<script>globalThis.kanbanPwned = true</script>`;

    const toolCreated = await runtime.tools.invoke(
      "kanban_create",
      {
        title: unsafeTitle,
        body: unsafeBody,
        board: "phase-2",
        boardName: `Phase <b>Two</b>`,
        assignee: `worker<&>`
      },
      {
        agentId: "http-test-agent",
        sessionId: "kanban-http-session",
        channel: "local",
        from: "test"
      }
    );
    assert.equal(toolCreated.ok, true, toolCreated.error);
    const toolTask = toolCreated.result;
    assert.ok(toolTask.id);
    assert.equal(toolTask.title, unsafeTitle);

    const listed = await fetchJson(
      base,
      authToken,
      "/kanban?board=phase-2&status=backlog&limit=10"
    );
    assert.equal(listed.response.status, 200);
    assert.deepEqual(
      listed.json.columns,
      ["backlog", "in-progress", "blocked", "review", "done"]
    );
    assert.equal(listed.json.tasks.length, 1);
    assert.equal(listed.json.tasks[0].id, toolTask.id);
    assert.equal(listed.json.tasks[0].title, unsafeTitle);
    assert.ok(listed.json.boards.some((board) => (
      board.id === "phase-2" && board.name === "Phase <b>Two</b>"
    )));

    const toolDetail = await fetchJson(
      base,
      authToken,
      `/kanban/${encodeURIComponent(toolTask.id)}`
    );
    assert.equal(toolDetail.response.status, 200);
    assert.equal(toolDetail.json.body, unsafeBody);
    assert.equal(toolDetail.json.assignee, "worker<&>");

    const created = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "create",
        title: "HTTP lifecycle task",
        body: "Exercise each dashboard action.",
        board: "phase-2"
      }
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.json.status, "backlog");
    const httpTaskId = created.json.id;

    const assigned = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "assign",
        taskId: httpTaskId,
        assignee: "agent-http"
      }
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(assigned.json.assignee, "agent-http");
    assert.equal(assigned.json.status, "in-progress");

    const blocked = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "block",
        taskId: httpTaskId,
        reason: "Waiting on a safe fixture"
      }
    });
    assert.equal(blocked.response.status, 200);
    assert.equal(blocked.json.status, "blocked");
    assert.equal(blocked.json.blockReason, "Waiting on a safe fixture");

    const rejectedCompletion = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "complete",
        taskId: httpTaskId
      }
    });
    assert.equal(rejectedCompletion.response.status, 400);
    assert.match(rejectedCompletion.json.error, /blocked/i);

    const unsafeComment = `<svg onload=alert("kanban-comment")>`;
    const commented = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "comment",
        taskId: httpTaskId,
        body: unsafeComment
      }
    });
    assert.equal(commented.response.status, 200);
    assert.equal(commented.json.comment.body, unsafeComment);

    const unblocked = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "unblock",
        taskId: httpTaskId
      }
    });
    assert.equal(unblocked.response.status, 200);
    assert.equal(unblocked.json.status, "in-progress");

    const completed = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "complete",
        taskId: httpTaskId,
        summary: "HTTP lifecycle complete"
      }
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.json.status, "done");
    assert.ok(completed.json.handoffs.some((handoff) => (
      handoff.summary === "HTTP lifecycle complete"
    )));

    const client = new CliClient({
      url: base,
      token: authToken,
      source: "test",
      remote: false
    });
    const cliList = await client.kanban({
      board: "phase-2",
      status: "done",
      assignee: "agent-http",
      limit: 5
    });
    assert.equal(cliList.ok, true, cliList.text);
    assert.deepEqual(cliList.json.tasks.map((task) => task.id), [httpTaskId]);

    const cliDetail = await client.kanbanTask(httpTaskId);
    assert.equal(cliDetail.ok, true, cliDetail.text);
    assert.equal(cliDetail.json.id, httpTaskId);

    const cliCreated = await client.createKanban({
      title: "CLI-created Kanban task",
      board: "phase-2"
    });
    assert.equal(cliCreated.ok, true, cliCreated.text);
    assert.equal(cliCreated.json.title, "CLI-created Kanban task");

    const missing = await fetchJson(base, authToken, "/kanban/not-a-real-task");
    assert.equal(missing.response.status, 404);
    assert.match(missing.json.error, /unknown Kanban task/i);

    const missingAction = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "assign",
        taskId: "not-a-real-task",
        assignee: "nobody"
      }
    });
    assert.equal(missingAction.response.status, 404);

    const invalidCreate = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "create",
        title: "   "
      }
    });
    assert.equal(invalidCreate.response.status, 400);
    assert.match(invalidCreate.json.error, /title/i);

    const invalidAction = await fetchJson(base, authToken, "/kanban", {
      method: "POST",
      body: {
        action: "launch",
        taskId: httpTaskId
      }
    });
    assert.equal(invalidAction.response.status, 400);
    assert.match(invalidAction.json.error, /unknown Kanban action/i);

    const invalidFilter = await fetchJson(
      base,
      authToken,
      "/kanban?status=teleported"
    );
    assert.equal(invalidFilter.response.status, 400);
    assert.match(invalidFilter.json.error, /status/i);

    const dashboardResponse = await fetch(base, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    const dashboard = await dashboardResponse.text();
    assert.equal(dashboardResponse.status, 200);
    assert.match(dashboard, /data-tab="kanban"/);
    assert.match(dashboard, /async function refreshKanban\(\)/);
    assert.match(dashboard, /async function renderKanbanDetail\(taskId\)/);
    assert.match(
      dashboard,
      /const VALID_TABS = new Set\(\[[^\]]*"kanban"[^\]]*\]\)/
    );

    // Kanban data is loaded over JSON rather than embedded into the page, and
    // every user-controlled field that enters an innerHTML template is
    // escaped before interpolation.
    assert.equal(dashboard.includes(unsafeTitle), false);
    assert.equal(dashboard.includes(unsafeBody), false);
    assert.equal(dashboard.includes(unsafeComment), false);
    for (const escapedInterpolation of [
      "${escapeHtml(task.title)}",
      "${escapeHtml(task.body || \"No description.\")}",
      "${escapeHtml(comment.body)}",
      "${escapeHtml(task.assignee || \"unassigned\")}"
    ]) {
      assert.ok(
        dashboard.includes(escapedInterpolation),
        `dashboard must escape ${escapedInterpolation}`
      );
    }
  } finally {
    await app.close();
    await runtime.kanban?.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousAuthToken === undefined) {
      delete process.env.OPENAGI_AUTH_TOKEN;
    } else {
      process.env.OPENAGI_AUTH_TOKEN = previousAuthToken;
    }
  }
});

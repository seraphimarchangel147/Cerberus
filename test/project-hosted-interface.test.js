import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { DraftStore } from "../src/draft-store.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ProjectStore } from "../src/project-store.js";

async function requestJson(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.headers ?? {})
    },
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });
  const text = await response.text();
  return {
    response,
    text,
    json: text ? JSON.parse(text) : null
  };
}

async function openEventStream(base, token, projectId) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/events?project=${encodeURIComponent(projectId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    }
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async readUntil(needle, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffered.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for SSE payload: ${needle}`);
        }
        let timer;
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out waiting for SSE payload: ${needle}`)),
              remaining
            );
          })
        ]).finally(() => clearTimeout(timer));
        if (result.done) throw new Error("SSE stream closed before expected payload");
        buffered += decoder.decode(result.value, { stream: true });
      }
      return buffered;
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  };
}

function createHarness(root, token) {
  const dataDir = path.join(root, "data");
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: path.join(root, "legacy-workspace"),
    workspaceBase: path.join(root, "project-workspaces")
  });
  const store = new InMemoryAgentStore();
  const handled = [];
  const reset = [];
  const boundaryCalls = [];
  const runtime = {
    projects,
    cron: new CronScheduler(),
    pendingActions: new PendingActionStore({
      dir: path.join(dataDir, "pending-actions")
    }),
    drafts: null,
    tools: { list: () => [] },
    skills: {
      list() {
        return [
          { name: "global-skill", description: "Global" },
          { name: "review-notes", description: "Granted" }
        ];
      },
      mustGet(name) {
        return {
          name,
          description: "Granted",
          category: "test",
          body: "Review the notes.",
          linkedFiles: []
        };
      },
      statsFor: () => ({}),
      view(name) {
        return this.mustGet(name);
      },
      async run(name) {
        boundaryCalls.push(`skill:run:${name}`);
        return { ok: true, name };
      },
      createSkill() {
        boundaryCalls.push("skill:create");
        return { slug: "created" };
      },
      editSkill() {
        boundaryCalls.push("skill:edit");
        return { name: "review-notes" };
      },
      patchSkill() {
        boundaryCalls.push("skill:patch");
        return { name: "review-notes" };
      },
      setPinned() {
        boundaryCalls.push("skill:pin");
        return { name: "review-notes" };
      },
      deleteSkill() {
        boundaryCalls.push("skill:delete");
        return { name: "review-notes" };
      },
      reload() {
        boundaryCalls.push("skill:reload");
      }
    },
    patternMiner: {
      list() {
        boundaryCalls.push("skill:suggestions:list");
        return [{ id: "candidate-1", status: "pending" }];
      },
      async mine() {
        boundaryCalls.push("skill:mine:pattern");
        return { candidates: 1 };
      },
      accept() {
        boundaryCalls.push("skill:suggestion:accept");
        return { id: "candidate-1", status: "accepted" };
      },
      reject() {
        boundaryCalls.push("skill:suggestion:reject");
        return { id: "candidate-1", status: "rejected" };
      }
    },
    sessionMiner: {
      async mine() {
        boundaryCalls.push("skill:mine:session");
        return { candidates: 1 };
      }
    },
    mcp: {
      onOauthRequired: null,
      listServers() {
        boundaryCalls.push("mcp:list");
        return [{ name: "alpha-server", status: "disconnected" }];
      },
      listTools() {
        return [{ server: "alpha-server", name: "granted-tool" }];
      },
      isConnecting: () => false,
      async connect(name) {
        boundaryCalls.push(`mcp:connect:${name}`);
        return { name, status: "connected", tools: [] };
      },
      async disconnect(name) {
        boundaryCalls.push(`mcp:disconnect:${name}`);
      },
      async disconnectAll() {},
      registerServer() {
        boundaryCalls.push("mcp:register");
        return { name: "registered", transport: "http" };
      },
      async callTool(server, tool) {
        boundaryCalls.push(`mcp:call:${server}:${tool}`);
        return { ok: true };
      }
    },
    status: () => ({ ok: true }),
    agentHost: {
      store,
      async handleMessage(input) {
        handled.push(structuredClone(input));
        const sessionId = input.sessionId
          ?? `${input.channel ?? "local"}:${input.from ?? "user"}:${input.agentId ?? "main"}`;
        const project = projects.resolveForSession(sessionId, {
          requestedProjectId: input.projectId,
          actor: "hosted-interface-test"
        });
        const session = store.appendMessage(sessionId, {
          role: "user",
          content: input.text ?? "",
          channel: input.channel ?? "local",
          from: input.from ?? "user",
          metadata: { projectId: project.id }
        });
        return {
          reply: `reply:${input.text ?? ""}`,
          session,
          project,
          agent: store.getAgent(input.agentId ?? "main"),
          output: {}
        };
      },
      resetSession(input) {
        reset.push(structuredClone(input));
        const session = store.getSession(input.sessionId);
        store.saveSession({ ...session, messages: [] });
        return { reset: true, sessionId: input.sessionId };
      }
    }
  };
  runtime.drafts = new DraftStore({
    dir: path.join(dataDir, "drafts"),
    runtime
  });
  const channels = {
    start() {},
    stop() {},
    status() {
      return { local: { enabled: true, mode: "http+sse" } };
    },
    async handleLocalMessage(body) {
      return runtime.agentHost.handleMessage({
        channel: body.channel ?? "local",
        from: body.from ?? "user",
        agentId: body.agentId ?? "main",
        sessionId: body.sessionId,
        projectId: body.projectId ?? body.metadata?.projectId ?? null,
        text: body.text ?? body.message,
        metadata: body.metadata ?? {}
      });
    }
  };
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: token,
    channels
  });
  return {
    app,
    runtime,
    projects,
    store,
    handled,
    reset,
    boundaryCalls
  };
}

test("hosted projects enforce CRUD, request, session, draft, SSE, and dashboard boundaries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-http-"));
  const token = "project-http-test-token";
  const previousToken = process.env.OPENAGI_AUTH_TOKEN;
  const originalFsync = fs.fsyncSync;
  process.env.OPENAGI_AUTH_TOKEN = token;
  if (process.platform === "win32") fs.fsyncSync = () => {};

  const harness = createHarness(root, token);
  let alphaEvents;
  let betaEvents;
  let defaultEvents;

  try {
    const listened = await harness.app.listen();
    const base = listened.url;
    const unsafeName = `Alpha <img src=x onerror="projectPwned()">`;
    const unsafeInstructions = `<script>globalThis.projectPwned=true</script>`;

    await t.test("project CRUD is revision-safe and selection is client-local", async () => {
      const alphaCreated = await requestJson(base, token, "/projects", {
        method: "POST",
        body: {
          id: "alpha",
          name: unsafeName,
          instructions: unsafeInstructions,
          activeSkills: ["review-notes"],
          mcpGrants: ["alpha-server"],
          secretRefs: ["ALPHA_TOKEN"]
        }
      });
      assert.equal(alphaCreated.response.status, 201);
      assert.equal(alphaCreated.json.id, "alpha");
      assert.equal(alphaCreated.json.name, unsafeName);
      assert.equal(alphaCreated.json.status, "active");

      const betaCreated = await requestJson(base, token, "/projects", {
        method: "POST",
        body: { id: "beta", name: "Beta Project" }
      });
      assert.equal(betaCreated.response.status, 201);

      const selected = await requestJson(
        base,
        token,
        "/projects/alpha/select",
        { method: "POST", body: {} }
      );
      assert.equal(selected.response.status, 200);
      assert.equal(selected.json.project.id, "alpha");
      assert.equal(selected.json.selection, "client-local");
      assert.equal(
        harness.projects.selectedProjectId,
        "default",
        "an HTTP client's selection must not become process-global authority"
      );

      const updated = await requestJson(base, token, "/projects/alpha", {
        method: "PATCH",
        body: {
          expectedRevision: alphaCreated.json.revision,
          patch: {
            name: `${unsafeName} updated`,
            instructions: `${unsafeInstructions}\nupdated`
          }
        }
      });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.json.revision, alphaCreated.json.revision + 1);

      const stale = await requestJson(base, token, "/projects/alpha", {
        method: "PATCH",
        body: {
          expectedRevision: alphaCreated.json.revision,
          patch: { name: "stale overwrite" }
        }
      });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.json.code, "PROJECT_REVISION_CONFLICT");

      const detail = await requestJson(base, token, "/projects/alpha");
      assert.equal(detail.response.status, 200);
      assert.equal(detail.json.name, `${unsafeName} updated`);
      assert.notEqual(detail.json.name, "stale overwrite");
    });

    await t.test("messages and immutable session ownership cannot cross projects", async () => {
      harness.store.appendMessage("legacy-session", {
        role: "user",
        content: "legacy default message"
      });

      const alphaMessage = await requestJson(base, token, "/message", {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: {
          sessionId: "alpha-session",
          text: "alpha private message",
          metadata: { projectId: "beta" }
        }
      });
      assert.equal(alphaMessage.response.status, 200);
      assert.equal(harness.handled.at(-1).projectId, "alpha");
      assert.equal(harness.handled.at(-1).metadata.projectId, "alpha");

      const betaMessage = await requestJson(base, token, "/message", {
        method: "POST",
        headers: { "x-openagi-project": "beta" },
        body: {
          sessionId: "beta-session",
          text: "beta private message"
        }
      });
      assert.equal(betaMessage.response.status, 200);

      const alphaSessions = await requestJson(base, token, "/sessions", {
        headers: { "x-openagi-project": "alpha" }
      });
      assert.deepEqual(alphaSessions.json.map((session) => session.id), ["alpha-session"]);

      const betaSessions = await requestJson(base, token, "/sessions", {
        headers: { "x-openagi-project": "beta" }
      });
      assert.deepEqual(betaSessions.json.map((session) => session.id), ["beta-session"]);

      const defaultSessions = await requestJson(base, token, "/sessions");
      assert.deepEqual(defaultSessions.json.map((session) => session.id), ["legacy-session"]);

      const hiddenSession = await requestJson(
        base,
        token,
        "/sessions/beta-session",
        { headers: { "x-openagi-project": "alpha" } }
      );
      assert.equal(hiddenSession.response.status, 404);

      const handledBeforeConflict = harness.handled.length;
      const conflictingSession = await requestJson(base, token, "/message", {
        method: "POST",
        headers: { "x-openagi-project": "beta" },
        body: {
          sessionId: "alpha-session",
          text: "attempted cross-project append"
        }
      });
      assert.notEqual(conflictingSession.response.status, 200);
      assert.equal(
        harness.store.getSession("alpha-session").messages.length,
        1,
        "a rejected project switch must not append to the session"
      );
      assert.equal(harness.handled.length, handledBeforeConflict + 1);

      const crossReset = await requestJson(base, token, "/sessions/reset", {
        method: "POST",
        headers: { "x-openagi-project": "beta" },
        body: { sessionId: "alpha-session" }
      });
      assert.equal(crossReset.response.status, 404);
      assert.equal(harness.reset.length, 0);

      const conflictBeforeDispatch = harness.handled.length;
      const conflictingSelectors = await requestJson(base, token, "/message", {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: {
          projectId: "beta",
          sessionId: "selector-conflict",
          text: "must not dispatch"
        }
      });
      assert.notEqual(conflictingSelectors.response.status, 200);
      assert.equal(harness.handled.length, conflictBeforeDispatch);
    });

    await t.test("session reads fail closed on durable binding disagreement or ProjectStore loss", async () => {
      const betaSession = harness.store.getSession("beta-session");
      betaSession.messages[0].metadata.projectId = "alpha";
      harness.store.saveSession(betaSession);

      const inconsistentList = await requestJson(base, token, "/sessions", {
        headers: { "x-openagi-project": "beta" }
      });
      assert.equal(inconsistentList.response.status, 200);
      assert.deepEqual(inconsistentList.json, []);

      const inconsistentGet = await requestJson(
        base,
        token,
        "/sessions/beta-session",
        { headers: { "x-openagi-project": "beta" } }
      );
      assert.equal(inconsistentGet.response.status, 404);

      delete betaSession.messages[0].metadata.projectId;
      harness.store.saveSession(betaSession);
      const missingBinding = await requestJson(base, token, "/sessions", {
        headers: { "x-openagi-project": "beta" }
      });
      assert.equal(missingBinding.response.status, 200);
      assert.deepEqual(missingBinding.json, []);

      betaSession.messages[0].metadata.projectId = "beta";
      harness.store.saveSession(betaSession);

      const originalProjectForSession =
        harness.projects.projectForSession.bind(harness.projects);
      harness.projects.projectForSession = (sessionId, options) => {
        if (sessionId === "beta-session") throw new Error("binding lookup failed");
        return originalProjectForSession(sessionId, options);
      };
      try {
        const failedLookup = await requestJson(base, token, "/sessions", {
          headers: { "x-openagi-project": "beta" }
        });
        assert.equal(failedLookup.response.status, 200);
        assert.deepEqual(failedLookup.json, []);
      } finally {
        harness.projects.projectForSession = originalProjectForSession;
      }

      const projects = harness.runtime.projects;
      harness.runtime.projects = null;
      try {
        const missingStore = await requestJson(base, token, "/sessions");
        assert.equal(missingStore.response.status, 403);
        assert.equal(
          missingStore.text.includes("alpha private message"),
          false
        );
        assert.equal(
          missingStore.text.includes("beta private message"),
          false
        );
      } finally {
        harness.runtime.projects = projects;
      }
    });

    await t.test("draft reads and mutations are project-contained", async () => {
      const alphaDraft = harness.runtime.drafts.add({
        projectId: "alpha",
        kind: "message",
        title: "Alpha private draft",
        body: "alpha draft body"
      });
      const betaDraft = harness.runtime.drafts.add({
        projectId: "beta",
        kind: "message",
        title: "Beta private draft",
        body: "beta draft body"
      });
      const legacyDraft = harness.runtime.drafts.add({
        kind: "message",
        title: "Legacy draft",
        body: "legacy draft body"
      });

      const alphaList = await requestJson(base, token, "/drafts", {
        headers: { "x-openagi-project": "alpha" }
      });
      assert.deepEqual(alphaList.json.map((draft) => draft.id), [alphaDraft.id]);

      const betaList = await requestJson(base, token, "/drafts", {
        headers: { "x-openagi-project": "beta" }
      });
      assert.deepEqual(betaList.json.map((draft) => draft.id), [betaDraft.id]);

      const defaultList = await requestJson(base, token, "/drafts");
      assert.deepEqual(defaultList.json.map((draft) => draft.id), [legacyDraft.id]);

      const crossEdit = await requestJson(
        base,
        token,
        `/drafts/${encodeURIComponent(betaDraft.id)}`,
        {
          method: "PATCH",
          headers: { "x-openagi-project": "alpha" },
          body: { body: "cross-project overwrite" }
        }
      );
      assert.equal(crossEdit.response.status, 404);
      assert.equal(
        harness.runtime.drafts.get(betaDraft.id).body,
        "beta draft body"
      );

      const alphaEdit = await requestJson(
        base,
        token,
        `/drafts/${encodeURIComponent(alphaDraft.id)}`,
        {
          method: "PATCH",
          headers: { "x-openagi-project": "alpha" },
          body: { body: "alpha revised body" }
        }
      );
      assert.equal(alphaEdit.response.status, 200);
      assert.equal(alphaEdit.json.body, "alpha revised body");

      const crossApprove = await requestJson(
        base,
        token,
        `/drafts/${encodeURIComponent(alphaDraft.id)}/approve`,
        {
          method: "POST",
          headers: { "x-openagi-project": "beta" },
          body: {}
        }
      );
      assert.equal(crossApprove.response.status, 404);
      assert.equal(harness.runtime.drafts.get(alphaDraft.id).status, "pending");
    });

    await t.test("pending approvals are listed and decided only inside their project", async () => {
      const alphaAction = harness.runtime.pendingActions.enqueue({
        toolName: "alpha_mutation",
        args: {},
        context: { __projectId: "alpha", __projectRevision: 2 },
        summary: "alpha only"
      });
      const betaAction = harness.runtime.pendingActions.enqueue({
        toolName: "beta_mutation",
        args: {},
        context: { __projectId: "beta", __projectRevision: 1 },
        summary: "beta only"
      });

      const alphaList = await requestJson(base, token, "/pending-actions", {
        headers: { "x-openagi-project": "alpha" }
      });
      assert.equal(alphaList.response.status, 200);
      assert.deepEqual(alphaList.json.actions.map((action) => action.id), [
        alphaAction.id
      ]);

      const crossDeny = await requestJson(
        base,
        token,
        `/pending-actions/${betaAction.id}/deny`,
        {
          method: "POST",
          headers: { "x-openagi-project": "alpha" },
          body: {}
        }
      );
      assert.equal(crossDeny.response.status, 404);
      assert.equal(harness.runtime.pendingActions.get(betaAction.id).status, "pending");

      const ownDeny = await requestJson(
        base,
        token,
        `/pending-actions/${alphaAction.id}/deny`,
        {
          method: "POST",
          headers: { "x-openagi-project": "alpha" },
          body: { reason: "not now" }
        }
      );
      assert.equal(ownDeny.response.status, 200);
      assert.equal(harness.runtime.pendingActions.get(alphaAction.id).status, "denied");
    });

    await t.test("legacy-global HTTP surfaces remain in the default control plane", async () => {
      const calls = [];
      harness.runtime.tasks = {
        list() {
          calls.push("tasks:list");
          return [{ id: "legacy-task", title: "default only" }];
        },
        stats() {
          calls.push("tasks:stats");
          return { total: 1 };
        },
        add() {
          calls.push("tasks:add");
          return { id: "created" };
        },
        update() {
          calls.push("tasks:update");
          return { id: "legacy-task" };
        },
        complete() {
          calls.push("tasks:complete");
          return { id: "legacy-task", status: "completed" };
        },
        remove() {
          calls.push("tasks:remove");
          return true;
        }
      };
      harness.runtime.clarifications = {
        list() {
          calls.push("clarifications:list");
          return [{ id: "clar-1" }];
        },
        answer() {
          calls.push("clarifications:answer");
          return { clarification: { id: "clar-1" } };
        },
        dismiss() {
          calls.push("clarifications:dismiss");
          return { id: "clar-1" };
        }
      };
      harness.runtime.proactiveObserver = {
        async observe() {
          calls.push("proactive:observe");
          return { created: 1 };
        },
        list() {
          calls.push("proactive:list");
          return [];
        }
      };

      const alphaHeaders = { "x-openagi-project": "alpha" };
      const rejected = [
        { route: "/tasks" },
        {
          route: "/tasks",
          method: "POST",
          body: { projectId: "alpha", title: "must not be added" }
        },
        {
          route: "/tasks/legacy-task",
          method: "PATCH",
          body: { title: "must not change" }
        },
        {
          route: "/tasks/legacy-task/complete",
          method: "POST",
          body: {}
        },
        { route: "/tasks/legacy-task", method: "DELETE" },
        { route: "/tasks/clarifications" },
        {
          route: "/tasks/clarifications/clar-1/answer",
          method: "POST",
          body: { answer: "yes" }
        },
        {
          route: "/tasks/clarifications/clar-1/dismiss",
          method: "POST",
          body: {}
        },
        { route: "/proactive/suggestions" },
        { route: "/proactive/observe", method: "POST", body: {} },
        {
          route: "/proactive/suggestions/sug-1/accept",
          method: "POST",
          body: {}
        },
        {
          route: "/proactive/suggestions/sug-1/edit",
          method: "POST",
          body: { name: "cross-project", body: "must not change" }
        },
        {
          route: "/proactive/suggestions/sug-1/defer",
          method: "POST",
          body: {}
        },
        { route: "/budget" },
        { route: "/admin/provider" },
        { route: "/observations/search?q=private" },
        { route: "/integrations/status" },
        { route: "/auto-approve" },
        { route: "/outreach/config" },
        { route: "/agents" }
      ];
      for (const item of rejected) {
        const response = await requestJson(base, token, item.route, {
          method: item.method,
          headers: alphaHeaders,
          body: item.body
        });
        assert.equal(response.response.status, 403, item.route);
        assert.equal(response.json.code, "PROJECT_BOUNDARY_VIOLATION");
      }
      assert.deepEqual(calls, []);

      const selfProjects = await requestJson(base, token, "/projects?archived=1", {
        headers: alphaHeaders
      });
      assert.deepEqual(
        selfProjects.json.projects.map((project) => project.id),
        ["alpha"]
      );
      const hiddenProject = await requestJson(base, token, "/projects/beta", {
        headers: alphaHeaders
      });
      assert.equal(hiddenProject.response.status, 404);
      const deniedCreate = await requestJson(base, token, "/projects", {
        method: "POST",
        headers: alphaHeaders,
        body: { id: "gamma", name: "Gamma" }
      });
      assert.equal(deniedCreate.response.status, 403);
      assert.equal(harness.projects.get("gamma"), null);

      const scopedHealth = await requestJson(base, token, "/health", {
        headers: alphaHeaders
      });
      assert.equal(scopedHealth.response.status, 200);
      assert.equal(scopedHealth.json.status.project.id, "alpha");
      assert.equal(Object.hasOwn(scopedHealth.json.status, "cron"), false);
      assert.equal(Object.hasOwn(scopedHealth.json.status, "context"), false);

      const legacyTasks = await requestJson(base, token, "/tasks");
      assert.equal(legacyTasks.response.status, 200);
      assert.deepEqual(legacyTasks.json.tasks.map((task) => task.id), [
        "legacy-task"
      ]);
      assert.deepEqual(calls, ["tasks:list", "tasks:stats"]);
    });

    await t.test("nondefault projects use grants but cannot mutate global skill or MCP administration", async () => {
      const projectHeaders = { "x-openagi-project": "alpha" };

      const skills = await requestJson(base, token, "/skills", {
        headers: projectHeaders
      });
      assert.equal(skills.response.status, 200);
      assert.deepEqual(skills.json.map((skill) => skill.name), ["review-notes"]);

      const skillView = await requestJson(
        base,
        token,
        "/skills/review-notes/view?count=0",
        { headers: projectHeaders }
      );
      assert.equal(skillView.response.status, 200);
      assert.equal(skillView.json.name, "review-notes");

      const skillRun = await requestJson(
        base,
        token,
        "/skills/review-notes/run",
        {
          method: "POST",
          headers: projectHeaders,
          body: { input: "allowed project use" }
        }
      );
      assert.equal(skillRun.response.status, 200);
      assert.ok(harness.boundaryCalls.includes("skill:run:review-notes"));

      const suggestions = await requestJson(base, token, "/skills/suggested", {
        headers: projectHeaders
      });
      assert.equal(suggestions.response.status, 403);
      assert.equal(
        harness.boundaryCalls.includes("skill:suggestions:list"),
        false,
        "mined candidates must not be read across the administrative boundary"
      );

      const skillMutations = [
        {
          route: "/skills/create",
          body: { name: "review-notes", body: "replacement" }
        },
        {
          route: "/skills/review-notes/edit",
          body: { body: "replacement" }
        },
        {
          route: "/skills/review-notes/pin",
          body: { pinned: true }
        },
        {
          route: "/skills/review-notes/delete",
          body: {}
        },
        {
          route: "/skills/reload",
          body: {}
        },
        {
          route: "/skills/mine",
          body: {}
        },
        {
          route: "/skills/suggested/candidate-1/accept",
          body: {}
        },
        {
          route: "/skills/suggested/candidate-1/reject",
          body: { reason: "not useful" }
        }
      ];
      for (const item of skillMutations) {
        const response = await requestJson(base, token, item.route, {
          method: "POST",
          headers: projectHeaders,
          body: item.body
        });
        assert.equal(response.response.status, 403, item.route);
      }
      assert.deepEqual(
        harness.boundaryCalls.filter((call) => (
          call.startsWith("skill:")
          && call !== "skill:run:review-notes"
        )),
        []
      );

      harness.runtime.mcp.onOauthRequired({
        name: "alpha-server",
        url: "https://auth.example.invalid/start?state=default-control-only"
      });
      const mcpList = await requestJson(base, token, "/mcp", {
        headers: projectHeaders
      });
      assert.equal(mcpList.response.status, 200);
      assert.deepEqual(mcpList.json.map((server) => server.name), ["alpha-server"]);
      assert.equal(mcpList.json[0].pendingAuthUrl, null);

      const defaultMcpList = await requestJson(base, token, "/mcp");
      assert.match(
        defaultMcpList.json[0].pendingAuthUrl,
        /default-control-only/u
      );

      const mcpCall = await requestJson(base, token, "/mcp/call", {
        method: "POST",
        headers: projectHeaders,
        body: {
          server: "alpha-server",
          tool: "granted-tool",
          args: {}
        }
      });
      assert.equal(mcpCall.response.status, 200);
      assert.ok(harness.boundaryCalls.includes("mcp:call:alpha-server:granted-tool"));

      const mcpMutations = [
        {
          route: "/mcp/connect/alpha-server",
          body: {}
        },
        {
          route: "/mcp/connect-all",
          body: {}
        },
        {
          route: "/mcp/register",
          body: {
            name: "cross-project-server",
            url: "https://example.invalid/mcp"
          }
        },
        {
          route: "/integrations/connect-mcp",
          body: {
            catalogId: "github",
            apiKey: "must-not-be-processed"
          }
        }
      ];
      for (const item of mcpMutations) {
        const response = await requestJson(base, token, item.route, {
          method: "POST",
          headers: projectHeaders,
          body: item.body
        });
        assert.equal(response.response.status, 403, item.route);
        assert.equal(response.text.includes("must-not-be-processed"), false);
      }
      assert.deepEqual(
        harness.boundaryCalls.filter((call) => (
          call === "mcp:register"
          || call.startsWith("mcp:connect:")
        )),
        []
      );
    });

    await t.test("skill schedule ids cannot be preclaimed across projects", async () => {
      const alphaScheduleId = `skill-cron-review-notes-${
        createHash("sha256")
          .update("project-skill-schedule\0alpha\0review-notes")
          .digest("hex")
          .slice(0, 24)
      }`;
      const beta = harness.projects.get("beta");
      harness.runtime.cron.addJob({
        id: alphaScheduleId,
        name: "foreign preclaim",
        task: "prompt",
        dailyAt: "08:00",
        input: {
          prompt: "beta only",
          projectId: "beta",
          projectRevision: beta.revision
        }
      });
      const attachedBeta = harness.projects.attachResource(
        "beta",
        "scheduleIds",
        alphaScheduleId,
        { actor: "test:foreign-preclaim" }
      );
      harness.runtime.cron.updateJob(alphaScheduleId, {
        input: {
          prompt: "beta only",
          projectId: "beta",
          projectRevision: attachedBeta.revision
        }
      });

      const collision = await requestJson(
        base,
        token,
        "/skills/review-notes/schedule",
        {
          method: "POST",
          headers: { "x-openagi-project": "alpha" },
          body: { dailyAt: "09:00" }
        }
      );
      assert.equal(collision.response.status, 409);
      assert.equal(
        harness.runtime.cron.listJobs()
          .find((job) => job.id === alphaScheduleId)
          .input.projectId,
        "beta"
      );
      assert.equal(
        harness.projects.get("alpha").scheduleIds.includes(alphaScheduleId),
        false
      );

      harness.runtime.cron.removeJob(alphaScheduleId);
      harness.projects.detachResource(
        "beta",
        "scheduleIds",
        alphaScheduleId,
        { actor: "test:foreign-preclaim-cleanup" }
      );

      const created = await requestJson(
        base,
        token,
        "/skills/review-notes/schedule",
        {
          method: "POST",
          headers: { "x-openagi-project": "alpha" },
          body: { dailyAt: "09:00" }
        }
      );
      assert.equal(created.response.status, 200);
      assert.equal(created.json.jobId, alphaScheduleId);
      const alpha = harness.projects.get("alpha");
      const job = harness.runtime.cron.listJobs()
        .find((candidate) => candidate.id === alphaScheduleId);
      assert.equal(job.input.projectId, "alpha");
      assert.equal(job.input.projectRevision, alpha.revision);
      assert.ok(alpha.scheduleIds.includes(alphaScheduleId));

      const updated = await requestJson(
        base,
        token,
        "/skills/review-notes/schedule",
        {
          method: "POST",
          headers: { "x-openagi-project": "alpha" },
          body: { dailyAt: "10:30" }
        }
      );
      assert.equal(updated.response.status, 200);
      assert.equal(
        harness.runtime.cron.listJobs()
          .find((candidate) => candidate.id === alphaScheduleId)
          .dailyAt,
        "10:30"
      );
    });

    await t.test("generic project schedules pin the post-attachment revision", async () => {
      const created = await requestJson(base, token, "/cron", {
        method: "POST",
        headers: { "x-openagi-project": "alpha" },
        body: {
          name: "Alpha recurring work",
          prompt: "Continue alpha work.",
          intervalSeconds: 60
        }
      });
      assert.equal(created.response.status, 200);
      const alpha = harness.projects.get("alpha");
      const stored = harness.runtime.cron.listJobs()
        .find((candidate) => candidate.id === created.json.id);
      assert.ok(stored);
      assert.ok(alpha.scheduleIds.includes(stored.id));
      assert.equal(stored.input.projectId, "alpha");
      assert.equal(stored.input.projectRevision, alpha.revision);
      assert.equal(created.json.input.projectRevision, alpha.revision);
    });

    await t.test("legacy runtimes without ProjectStore retain default-project administration", async () => {
      const projects = harness.runtime.projects;
      harness.runtime.projects = null;
      try {
        const suggestions = await requestJson(base, token, "/skills/suggested");
        assert.equal(suggestions.response.status, 200);
        assert.deepEqual(suggestions.json.map((item) => item.id), ["candidate-1"]);

        const pin = await requestJson(
          base,
          token,
          "/skills/review-notes/pin",
          {
            method: "POST",
            body: { pinned: true }
          }
        );
        assert.equal(pin.response.status, 200);
        assert.ok(harness.boundaryCalls.includes("skill:pin"));
      } finally {
        harness.runtime.projects = projects;
      }
    });

    await t.test("SSE clients receive only their selected project's events", async () => {
      [alphaEvents, betaEvents, defaultEvents] = await Promise.all([
        openEventStream(base, token, "alpha"),
        openEventStream(base, token, "beta"),
        openEventStream(base, token, "default")
      ]);
      await Promise.all([
        alphaEvents.readUntil("event: hello"),
        betaEvents.readUntil("event: hello"),
        defaultEvents.readUntil("event: hello")
      ]);

      harness.app.events.emit("draft-created", {
        projectId: "alpha",
        title: "alpha-event-only"
      });
      harness.app.events.emit("draft-created", {
        projectId: "beta",
        title: "beta-event-only"
      });
      harness.app.events.emit("task-updated", {
        op: "update",
        task: { id: "legacy-default-event-only" }
      });

      const [alphaPayload, betaPayload, defaultPayload] = await Promise.all([
        alphaEvents.readUntil("alpha-event-only"),
        betaEvents.readUntil("beta-event-only"),
        defaultEvents.readUntil("legacy-default-event-only")
      ]);
      assert.doesNotMatch(alphaPayload, /beta-event-only/u);
      assert.doesNotMatch(alphaPayload, /legacy-default-event-only/u);
      assert.doesNotMatch(betaPayload, /alpha-event-only/u);
      assert.doesNotMatch(betaPayload, /legacy-default-event-only/u);
      assert.doesNotMatch(defaultPayload, /alpha-event-only/u);
      assert.doesNotMatch(defaultPayload, /beta-event-only/u);

      harness.app.events.emit("project", {
        op: "update",
        projectId: "alpha",
        marker: "alpha-project-change"
      });
      const [alphaProjectPayload, defaultProjectPayload] = await Promise.all([
        alphaEvents.readUntil("alpha-project-change"),
        defaultEvents.readUntil("alpha-project-change")
      ]);
      assert.match(alphaProjectPayload, /event: project/u);
      assert.match(defaultProjectPayload, /event: project/u);
    });

    await t.test("dashboard project data is fetched, escaped, and sent with selection headers", async () => {
      const response = await fetch(base, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/html"
        }
      });
      const dashboard = await response.text();
      assert.equal(response.status, 200);
      assert.match(dashboard, /data-tab="projects"/u);
      assert.match(dashboard, /async function refreshProjects\(\)/u);
      assert.match(
        dashboard,
        /fetchJson\("\/projects\?archived=1", \{ projectScoped: false \}\)/u
      );
      assert.match(dashboard, /escapeHtml\(project\.name\)/u);
      assert.match(dashboard, /escapeHtml\(project\.instructions/u);
      assert.match(
        dashboard,
        /"x-openagi-project": state\.projectId \|\| "default"/u
      );
      assert.match(
        dashboard,
        /new EventSource\("\/events\?project=" \+ encodeURIComponent\(state\.projectId/u
      );
      assert.match(
        dashboard,
        /localStorage\.setItem\("openagi\.projectId", state\.projectId\)/u
      );
      assert.equal(dashboard.includes(unsafeName), false);
      assert.equal(dashboard.includes(unsafeInstructions), false);

      const scripts = [...dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)]
        .map((match) => match[1])
        .filter((source) => source.trim());
      assert.equal(scripts.length, 1, "dashboard should expose one auditable inline script");
      assert.doesNotThrow(
        () => Function(scripts[0]),
        "the fully rendered dashboard script must parse as JavaScript"
      );

      const draftActionsStart = dashboard.indexOf("// Draft review actions.");
      const draftActionsEnd = dashboard.indexOf("async function refreshHealth", draftActionsStart);
      const draftActions = dashboard.slice(draftActionsStart, draftActionsEnd);
      assert.ok(draftActionsStart >= 0 && draftActionsEnd > draftActionsStart);
      assert.match(
        draftActions,
        /headers: projectHeaders\(\{ "content-type": "application\/json" \}\)/u
      );
      assert.match(draftActions, /headers: projectHeaders\(\)/u);
      assert.match(
        dashboard,
        /fetch\(`\/tasks\/\$\{id\}\/complete`, \{ method: "POST", headers: projectHeaders/u
      );
      assert.match(
        dashboard,
        /fetch\(`\/tasks\/\$\{id\}`, \{ method: "DELETE", headers: projectHeaders\(\)/u
      );
      assert.match(
        dashboard,
        /tasks\/clarifications\/" \+ encodeURIComponent\(id\) \+ "\/answer"[\s\S]*?headers: projectHeaders/u
      );
    });

    await t.test("archive is CAS-protected and makes project request scopes fail closed", async () => {
      const alpha = harness.projects.get("alpha");
      const staleArchive = await requestJson(
        base,
        token,
        "/projects/alpha/archive",
        {
          method: "POST",
          body: { expectedRevision: alpha.revision - 1 }
        }
      );
      assert.equal(staleArchive.response.status, 409);
      assert.equal(staleArchive.json.code, "PROJECT_REVISION_CONFLICT");

      const archived = await requestJson(
        base,
        token,
        "/projects/alpha/archive",
        {
          method: "POST",
          body: { expectedRevision: alpha.revision }
        }
      );
      assert.equal(archived.response.status, 200);
      assert.equal(archived.json.status, "archived");

      const activeList = await requestJson(base, token, "/projects");
      assert.equal(
        activeList.json.projects.some((project) => project.id === "alpha"),
        false
      );
      const allList = await requestJson(base, token, "/projects?archived=1");
      assert.equal(
        allList.json.projects.find((project) => project.id === "alpha").status,
        "archived"
      );

      const archivedSelection = await requestJson(
        base,
        token,
        "/projects/alpha/select",
        { method: "POST", body: {} }
      );
      assert.equal(archivedSelection.response.status, 404);

      const archivedScope = await requestJson(base, token, "/sessions", {
        headers: { "x-openagi-project": "alpha" }
      });
      assert.notEqual(archivedScope.response.status, 200);
      assert.equal(
        archivedScope.text.includes("alpha private message"),
        false,
        "fail-closed errors must not include scoped session content"
      );
    });
  } finally {
    await alphaEvents?.close?.();
    await betaEvents?.close?.();
    await defaultEvents?.close?.();
    await harness.app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.fsyncSync = originalFsync;
    if (previousToken === undefined) {
      delete process.env.OPENAGI_AUTH_TOKEN;
    } else {
      process.env.OPENAGI_AUTH_TOKEN = previousToken;
    }
  }
});

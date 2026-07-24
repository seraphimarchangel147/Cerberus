import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CronScheduler } from "../src/cron-scheduler.js";
import { DraftStore } from "../src/draft-store.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { OutreachStore } from "../src/outreach-store.js";
import { ProjectStore } from "../src/project-store.js";

async function requestJson(base, token, route, {
  method = "GET",
  projectId,
  body
} = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(projectId ? { "x-openagi-project": projectId } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    response,
    json: text ? JSON.parse(text) : null
  };
}

function createHarness(root, token) {
  const dataDir = path.join(root, "data");
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: path.join(root, "legacy-workspace"),
    workspaceBase: path.join(root, "project-workspaces")
  });
  projects.create({
    id: "alpha",
    name: "Alpha",
    secretRefs: ["OPENAI_API_KEY"]
  });
  projects.create({
    id: "beta",
    name: "Beta",
    secretRefs: ["OPENAI_API_KEY"]
  });

  const cron = new CronScheduler();
  const secretState = {
    value: "original-value",
    setCalls: []
  };
  const taskUpdates = [];
  const runtime = {
    projects,
    cron,
    tools: { list: () => [] },
    tasks: {
      update(id, patch) {
        taskUpdates.push({ id, patch: structuredClone(patch) });
        return { id, ...patch };
      }
    },
    status: () => ({ ok: true }),
    secrets: {
      listSecrets() {
        return [{
          name: "OPENAI_API_KEY",
          configured: true,
          masked: "orig...alue",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }];
      },
      setSecret(name, value) {
        secretState.value = value;
        secretState.setCalls.push({ name, value });
        return {
          name,
          configured: true,
          masked: `${value.slice(0, 4)}...`,
          updatedAt: "2026-01-02T00:00:00.000Z"
        };
      }
    }
  };
  runtime.drafts = new DraftStore({
    dir: path.join(dataDir, "drafts"),
    runtime
  });
  runtime.outreach = new OutreachStore({
    dir: path.join(dataDir, "outreach"),
    runtime
  });

  const localMessages = [];
  const channels = {
    start() {},
    stop() {},
    async handleLocalMessage(input) {
      localMessages.push(structuredClone(input));
      return { reply: "scoped reply" };
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
    cron,
    secretState,
    localMessages,
    taskUpdates
  };
}

test("hosted shared-state APIs fail closed across project boundaries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-project-shared-"));
  const token = "project-shared-state-token";
  const originalFsync = fs.fsyncSync;
  if (process.platform === "win32") fs.fsyncSync = () => {};
  const harness = createHarness(root, token);

  try {
    const listened = await harness.app.listen();
    const base = listened.url;

    await t.test("a project cannot replace a foreign or unattached cron id", async () => {
      const beta = harness.projects.get("beta");
      const betaJob = harness.cron.addJob({
        id: "shared-job",
        name: "Beta private job",
        task: "prompt",
        intervalMs: 60_000,
        input: {
          prompt: "beta work",
          projectId: "beta",
          projectRevision: beta.revision
        }
      });
      harness.projects.attachResource(
        "beta",
        "scheduleIds",
        betaJob.id,
        { actor: "test" }
      );
      harness.cron.addJob({
        id: "alpha-unattached",
        name: "Unattached alpha job",
        task: "prompt",
        intervalMs: 60_000,
        input: {
          prompt: "orphan",
          projectId: "alpha",
          projectRevision: harness.projects.get("alpha").revision
        }
      });

      const takeover = await requestJson(base, token, "/cron", {
        method: "POST",
        projectId: "alpha",
        body: {
          id: betaJob.id,
          name: "Alpha takeover",
          prompt: "replace beta",
          intervalSeconds: 10
        }
      });
      assert.equal(takeover.response.status, 409);
      assert.equal(
        harness.cron.listJobs().find((job) => job.id === betaJob.id).name,
        "Beta private job"
      );

      const unattached = await requestJson(base, token, "/cron", {
        method: "POST",
        projectId: "alpha",
        body: {
          id: "alpha-unattached",
          name: "Attach by replacement",
          prompt: "must fail",
          intervalSeconds: 10
        }
      });
      assert.equal(unattached.response.status, 409);
      assert.equal(
        harness.cron.listJobs().find((job) => job.id === "alpha-unattached").name,
        "Unattached alpha job"
      );

      const ownReplacement = await requestJson(base, token, "/cron", {
        method: "POST",
        projectId: "beta",
        body: {
          id: betaJob.id,
          name: "Beta replacement",
          prompt: "updated beta work",
          intervalSeconds: 10
        }
      });
      assert.equal(ownReplacement.response.status, 200);
      assert.equal(ownReplacement.json.input.projectId, "beta");
      assert.equal(
        harness.cron.listJobs().find((job) => job.id === betaJob.id).name,
        "Beta replacement"
      );
    });

    await t.test("outreach reads, actions, feedback, and replies stay in project", async () => {
      const alphaDraft = harness.runtime.drafts.add({
        projectId: "alpha",
        kind: "message",
        title: "Alpha draft",
        body: "alpha body"
      });
      const betaDraft = harness.runtime.drafts.add({
        projectId: "beta",
        kind: "message",
        title: "Beta draft",
        body: "beta body"
      });
      const legacyDraft = harness.runtime.drafts.add({
        kind: "message",
        title: "Legacy draft",
        body: "legacy body"
      });
      const alphaItem = harness.runtime.outreach.append({
        projectId: "alpha",
        type: "draft",
        sourceRef: { kind: "draft", id: alphaDraft.id },
        title: "Alpha item",
        actions: ["approve", "dismiss"]
      });
      const betaItem = harness.runtime.outreach.append({
        projectId: "beta",
        type: "draft",
        sourceRef: { kind: "draft", id: betaDraft.id },
        title: "Beta item",
        actions: ["approve", "dismiss"]
      });
      const legacyItem = harness.runtime.outreach.append({
        type: "draft",
        sourceRef: { kind: "draft", id: legacyDraft.id },
        title: "Legacy item",
        actions: ["approve", "dismiss"]
      });
      delete legacyItem.projectId;
      harness.runtime.outreach.snapshot();
      const forgedAlphaItem = harness.runtime.outreach.append({
        projectId: "alpha",
        type: "draft",
        sourceRef: { kind: "draft", id: betaDraft.id },
        title: "Forged alpha reference",
        actions: ["approve"]
      });
      const alphaReplyItem = harness.runtime.outreach.append({
        projectId: "alpha",
        type: "stalled-task",
        sourceRef: { kind: "task", id: "alpha-task" },
        title: "Alpha reply",
        actions: ["keep"]
      });
      const alphaFeedbackItem = harness.runtime.outreach.append({
        projectId: "alpha",
        type: "draft",
        title: "Alpha feedback",
        actions: ["up", "down"]
      });
      const forgedTaskItem = harness.runtime.outreach.append({
        projectId: "alpha",
        type: "stalled-task",
        sourceRef: { kind: "task", id: "global-task" },
        title: "Forged global task reference",
        actions: ["close"]
      });
      harness.runtime.outreach.append({
        projectId: "alpha",
        type: "digest",
        title: "Alpha digest"
      });
      harness.runtime.outreach.append({
        projectId: "beta",
        type: "digest",
        title: "Beta digest"
      });

      const [alphaFeed, betaFeed, defaultFeed] = await Promise.all([
        requestJson(base, token, "/outreach/feed", { projectId: "alpha" }),
        requestJson(base, token, "/outreach/feed", { projectId: "beta" }),
        requestJson(base, token, "/outreach/feed")
      ]);
      assert.ok(alphaFeed.json.items.some((item) => item.id === alphaItem.id));
      assert.equal(alphaFeed.json.items.some((item) => item.id === betaItem.id), false);
      assert.deepEqual(
        betaFeed.json.items
          .filter((item) => item.type === "draft")
          .map((item) => item.id),
        [betaItem.id]
      );
      assert.deepEqual(
        defaultFeed.json.items
          .filter((item) => item.type === "draft")
          .map((item) => item.id),
        [legacyItem.id]
      );

      const [alphaDigest, betaDigest] = await Promise.all([
        requestJson(base, token, "/outreach/digest", { projectId: "alpha" }),
        requestJson(base, token, "/outreach/digest", { projectId: "beta" })
      ]);
      assert.equal(alphaDigest.json.digest.title, "Alpha digest");
      assert.equal(betaDigest.json.digest.title, "Beta digest");

      const crossAct = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(alphaItem.id)}/act`,
        {
          method: "POST",
          projectId: "beta",
          body: { action: "approve" }
        }
      );
      assert.equal(crossAct.response.status, 404);
      assert.equal(harness.runtime.drafts.get(alphaDraft.id).status, "pending");

      const forgedAct = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(forgedAlphaItem.id)}/act`,
        {
          method: "POST",
          projectId: "alpha",
          body: { action: "approve" }
        }
      );
      assert.equal(forgedAct.response.status, 400);
      assert.equal(harness.runtime.drafts.get(betaDraft.id).status, "pending");

      const ownAct = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(alphaItem.id)}/act`,
        {
          method: "POST",
          projectId: "alpha",
          body: { action: "approve" }
        }
      );
      assert.equal(ownAct.response.status, 200);
      assert.equal(harness.runtime.drafts.get(alphaDraft.id).status, "approved");

      const forgedTaskAct = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(forgedTaskItem.id)}/act`,
        {
          method: "POST",
          projectId: "alpha",
          body: { action: "close" }
        }
      );
      assert.equal(forgedTaskAct.response.status, 400);
      assert.match(forgedTaskAct.json.error, /default-project only/u);
      assert.equal(harness.taskUpdates.length, 0);

      const crossFeedback = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(alphaFeedbackItem.id)}/feedback`,
        {
          method: "POST",
          projectId: "beta",
          body: { verdict: "up" }
        }
      );
      assert.equal(crossFeedback.response.status, 404);
      assert.equal(
        harness.runtime.outreach.get(alphaFeedbackItem.id).status,
        "unseen"
      );

      const crossReply = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(alphaReplyItem.id)}/reply`,
        {
          method: "POST",
          projectId: "beta",
          body: { text: "cross-project reply" }
        }
      );
      assert.equal(crossReply.response.status, 404);
      assert.equal(harness.localMessages.length, 0);

      const ownReply = await requestJson(
        base,
        token,
        `/outreach/${encodeURIComponent(alphaReplyItem.id)}/reply`,
        {
          method: "POST",
          projectId: "alpha",
          body: { text: "keep this task" }
        }
      );
      assert.equal(ownReply.response.status, 200);
      assert.equal(harness.localMessages.at(-1).projectId, "alpha");
      assert.equal(harness.localMessages.at(-1).metadata.projectId, "alpha");
    });

    await t.test("only the default control plane can rotate shared secrets", async () => {
      const metadata = await requestJson(base, token, "/secrets", {
        projectId: "alpha"
      });
      assert.equal(metadata.response.status, 200);
      assert.deepEqual(
        metadata.json.secrets.map((secret) => secret.name),
        ["OPENAI_API_KEY"]
      );

      const crossWrite = await requestJson(base, token, "/secrets", {
        method: "POST",
        projectId: "alpha",
        body: {
          name: "OPENAI_API_KEY",
          value: "cross-project-value"
        }
      });
      assert.equal(crossWrite.response.status, 403);
      assert.equal(harness.secretState.value, "original-value");
      assert.equal(harness.secretState.setCalls.length, 0);

      const defaultWrite = await requestJson(base, token, "/secrets", {
        method: "POST",
        body: {
          name: "OPENAI_API_KEY",
          value: "default-rotation"
        }
      });
      assert.equal(defaultWrite.response.status, 200);
      assert.equal(harness.secretState.value, "default-rotation");
      assert.equal(harness.secretState.setCalls.length, 1);
    });
  } finally {
    await harness.app.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.fsyncSync = originalFsync;
  }
});

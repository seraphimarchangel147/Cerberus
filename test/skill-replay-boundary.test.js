import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedInterface } from "../src/hosted-interface.js";
import { ProjectStore } from "../src/project-store.js";
import { SkillReplay } from "../src/skill-replay.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-replay-boundary-"));
  const dataDir = path.join(root, "data");
  const projects = new ProjectStore({
    dataDir,
    defaultWorkspaceRoot: path.join(root, "workspace")
  });
  const skillReplay = new SkillReplay({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dataDir, projects, root, skillReplay };
}

test("replay result persistence rejects traversal job ids before filesystem access", (t) => {
  const { dataDir, skillReplay } = fixture(t);
  const snapshotPath = path.join(dataDir, "projects", "snapshot.json");
  const before = fs.readFileSync(snapshotPath, "utf8");

  assert.throws(
    () => skillReplay.resolveJob("../projects/snapshot", { error: "overwrite" }, {
      projectId: "default"
    }),
    (error) => error.code === "INVALID_REPLAY_JOB_ID"
  );
  assert.throws(
    () => skillReplay.resolveJob("..%2Fprojects%2Fsnapshot", {}, {
      projectId: "default"
    }),
    (error) => error.code === "INVALID_REPLAY_JOB_ID"
  );
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), before);
  assert.equal(
    skillReplay.resolveJob("rep_0123456789abcdef", {}, { projectId: "default" }),
    null
  );
});

test("encoded replay-result traversal is rejected by the hosted route", async (t) => {
  const { dataDir, projects, skillReplay } = fixture(t);
  const token = "replay-boundary-token";
  const snapshotPath = path.join(dataDir, "projects", "snapshot.json");
  const before = fs.readFileSync(snapshotPath, "utf8");
  const runtime = {
    projects,
    skillReplay,
    tools: { list: () => [] },
    cron: { listJobs: () => [] },
    status: () => ({ ok: true })
  };
  const channels = {
    start() {},
    stop() {},
    status: () => ({})
  };
  const app = createHostedInterface(runtime, {
    authToken: token,
    channels,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0
  });
  const address = await app.listen();
  t.after(async () => app.close());

  const response = await fetch(
    `${address.url}/skills/replay-result/..%2Fprojects%2Fsnapshot`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-openagi-project": "default"
      },
      body: JSON.stringify({ error: "overwrite" })
    }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid replay job id",
    code: "INVALID_REPLAY_JOB_ID"
  });
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), before);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopLease,
  DesktopLeaseContendedError
} from "../src/desktop-lease.js";
import { ComputerUseController } from "../src/computer-use-controller.js";
import { ComputerUseLog } from "../src/computer-use-log.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    leasePath: path.join(dir, "desktop.lease.json")
  };
}

function leaseFor({
  leasePath,
  agent,
  pid,
  now = () => Date.now(),
  enabled = true,
  processAlive = () => true
}) {
  return new DesktopLease({
    env: {
      OPENAGI_DESKTOP_LEASE: enabled ? "1" : "0",
      OPENAGI_DESKTOP_LEASE_PATH: leasePath,
      OPENAGI_DESKTOP_LEASE_TTL_MS: "1000",
      OPENAGI_AGENT_NAME: agent
    },
    leasePath,
    now,
    pid,
    host: "lease-test-host",
    processAlive
  });
}

function acquire(lease, {
  sessionId = "cus_session1",
  agentSessionId = "agent-session-1",
  goal = "Test the shared desktop"
} = {}) {
  return lease.acquire({
    sessionId,
    goal,
    projectId: "project-a",
    agentSessionId
  });
}

test("desktop lease reports the current holder on contention", (t) => {
  const { leasePath } = fixture(t);
  const first = leaseFor({ leasePath, agent: "seraphim", pid: 1001 });
  const second = leaseFor({ leasePath, agent: "azazel", pid: 1002 });
  acquire(first);
  assert.throws(
    () => acquire(second, { sessionId: "cus_session2" }),
    (error) => {
      assert.ok(error instanceof DesktopLeaseContendedError);
      assert.match(error.message, /seraphim/);
      assert.equal(error.holder.agent, "seraphim");
      return true;
    }
  );
});

test("desktop lease acquisition is re-entrant for the same identity", (t) => {
  const { leasePath } = fixture(t);
  const lease = leaseFor({ leasePath, agent: "seraphim", pid: 1001 });
  const first = acquire(lease);
  const second = acquire(lease, { sessionId: "cus_session2" });
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 1);
  assert.equal(second.sessionId, "cus_session2");
});

test("expired desktop lease is stolen and increments generation", (t) => {
  const { leasePath } = fixture(t);
  let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  const first = leaseFor({
    leasePath,
    agent: "seraphim",
    pid: 1001,
    now: () => nowMs
  });
  acquire(first);
  nowMs += 1_001;
  const second = leaseFor({
    leasePath,
    agent: "azazel",
    pid: 1002,
    now: () => nowMs
  });
  const stolen = acquire(second, { sessionId: "cus_session2" });
  assert.equal(stolen.generation, 2);
  assert.equal(stolen.holder.agent, "azazel");
});

test("released desktop lease can be acquired by another identity", (t) => {
  const { leasePath } = fixture(t);
  const first = leaseFor({ leasePath, agent: "seraphim", pid: 1001 });
  const second = leaseFor({ leasePath, agent: "azazel", pid: 1002 });
  acquire(first);
  assert.equal(first.release("cus_session1").released, true);
  const acquired = acquire(second, { sessionId: "cus_session2" });
  assert.equal(acquired.holder.agent, "azazel");
});

test("malformed desktop lease is treated as stale", (t) => {
  const { leasePath } = fixture(t);
  fs.writeFileSync(leasePath, "{\"holder\":", "utf8");
  const lease = leaseFor({ leasePath, agent: "seraphim", pid: 1001 });
  const acquired = acquire(lease);
  assert.equal(acquired.generation, 1);
  assert.equal(acquired.holder.agent, "seraphim");
});

test("desktop lease kill switch disables all checks", (t) => {
  const { leasePath } = fixture(t);
  fs.writeFileSync(leasePath, "{\"holder\":", "utf8");
  const lease = leaseFor({
    leasePath,
    agent: "seraphim",
    pid: 1001,
    enabled: false
  });
  assert.equal(acquire(lease).disabled, true);
  assert.equal(lease.renew("cus_missing").disabled, true);
  assert.equal(lease.release("cus_missing").disabled, true);
  assert.equal(fs.readFileSync(leasePath, "utf8"), "{\"holder\":");
});

test("controller contention is audited before any session is created", async (t) => {
  const { dir, leasePath } = fixture(t);
  const holder = leaseFor({
    leasePath,
    agent: "seraphim",
    pid: 1001
  });
  acquire(holder);
  const auditDir = path.join(dir, "audit");
  const log = new ComputerUseLog({ dir: auditDir });
  const controller = new ComputerUseController({
    runtime: { computerUseLog: log },
    env: {
      OPENAGI_DESKTOP_LEASE: "1",
      OPENAGI_DESKTOP_LEASE_PATH: leasePath,
      OPENAGI_AGENT_NAME: "azazel"
    }
  });
  await assert.rejects(
    controller.start({
      goal: "Try to share the desktop",
      surface: "desktop"
    }, {
      sessionId: "agent-session-2",
      __projectId: "project-b",
      __confirmed: true
    }),
    /seraphim/
  );
  assert.equal(log.listSessions().length, 0);
  const journal = fs.readFileSync(
    path.join(auditDir, "journal.jsonl"),
    "utf8"
  );
  assert.match(journal, /"kind":"lease-contended"/);
  assert.doesNotMatch(journal, /"op":"session-start"/);
});

test("renew after takeover aborts the local computer-use session", async (t) => {
  const { dir, leasePath } = fixture(t);
  const log = new ComputerUseLog({ dir: path.join(dir, "audit") });
  const env = {
    OPENAGI_DESKTOP_LEASE: "1",
    OPENAGI_DESKTOP_LEASE_PATH: leasePath,
    OPENAGI_DESKTOP_LEASE_TTL_MS: "1000",
    OPENAGI_AGENT_NAME: "seraphim"
  };
  const runtime = {
    computerUseLog: log,
    observations: { search: async () => [] }
  };
  const controller = new ComputerUseController({ runtime, env });
  const context = {
    sessionId: "agent-session-1",
    __projectId: "project-a",
    __confirmed: true
  };
  const started = await controller.start({
    goal: "Control the desktop",
    surface: "desktop"
  }, context);

  const record = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  record.holder.agent = "azazel";
  record.holder.pid = process.pid + 1;
  record.sessionId = "cus_takeover";
  record.generation += 1;
  fs.writeFileSync(leasePath, `${JSON.stringify(record)}\n`, "utf8");

  await assert.rejects(
    controller.observe({}, context),
    /taken over by azazel/
  );
  assert.equal(log.getSession(started.sessionId).status, "aborted");
});

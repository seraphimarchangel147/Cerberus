import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJsonLine } from "../src/file-utils.js";
import {
  TERMINAL_SESSION_STATUSES,
  TerminalSessionLeaseError,
  TerminalSessionStore
} from "../src/terminal-session-store.js";

const IMAGE = `openagi/terminal@sha256:${"a".repeat(64)}`;

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-terminal-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sessionInput(suffix = "0000000000000001", projectId = "alpha") {
  return {
    id: `terminal_${suffix}`,
    projectId,
    sessionId: "chat:alpha",
    projectRevision: 1,
    profileIdentity: null,
    containerName: `openagi-term-deadbeef-${suffix}`,
    imageDigest: IMAGE,
    cwd: "."
  };
}

test("terminal session journal and atomic snapshot survive reload", (t) => {
  const dataDir = temporaryDirectory(t);
  const store = new TerminalSessionStore({ dataDir });
  const created = store.start(sessionInput());
  const running = store.markRunning(created.id, {
    expectedRevision: created.revision
  });
  const active = store.recordActivity(running.id, {
    commandCount: 1,
    inputBytes: 8,
    outputBytes: 13,
    droppedOutputBytes: 2,
    lastCommandAt: new Date().toISOString()
  }, {
    expectedRevision: running.revision
  });

  assert.equal(active.commandCount, 1);
  assert.equal(active.inputBytes, 8);
  assert.equal(active.outputBytes, 13);
  assert.equal(active.droppedOutputBytes, 2);
  assert.equal(fs.readFileSync(store.eventsPath, "utf8").includes("echo private"), false);

  const reloaded = new TerminalSessionStore({ dataDir });
  assert.deepEqual(reloaded.get(created.id), active);
  const final = reloaded.markFinal(
    created.id,
    TERMINAL_SESSION_STATUSES.CLOSED,
    { expectedRevision: active.revision, reason: "test cleanup" }
  );
  assert.equal(final.status, TERMINAL_SESSION_STATUSES.CLOSED);
  assert.equal(reloaded.listActive().length, 0);
});

test("terminal journal compaction is bounded and replays a post-snapshot suffix", (t) => {
  const dataDir = temporaryDirectory(t);
  const compacting = new TerminalSessionStore({
    dataDir,
    compactAtBytes: 1
  });
  const created = compacting.start(sessionInput());
  const running = compacting.markRunning(created.id, {
    expectedRevision: created.revision
  });

  assert.equal(fs.statSync(compacting.eventsPath).size, 0);
  const staleSnapshot = fs.readFileSync(compacting.snapshotPath, "utf8");

  const suffixWriter = new TerminalSessionStore({
    dataDir,
    compactAtBytes: 32 * 1024 * 1024
  });
  const active = suffixWriter.recordActivity(running.id, {
    commandCount: 1,
    inputBytes: 7
  }, {
    expectedRevision: running.revision
  });
  assert.ok(fs.statSync(suffixWriter.eventsPath).size > 0);

  fs.writeFileSync(suffixWriter.snapshotPath, staleSnapshot, "utf8");
  const replayed = new TerminalSessionStore({ dataDir });
  assert.deepEqual(replayed.get(created.id), active);
});

test("compacted history fails closed without its snapshot", (t) => {
  const dataDir = temporaryDirectory(t);
  const store = new TerminalSessionStore({
    dataDir,
    compactAtBytes: 1
  });
  store.start(sessionInput());
  assert.equal(fs.statSync(store.eventsPath).size, 0);

  fs.writeFileSync(store.snapshotPath, "{broken\n", "utf8");
  const reloaded = new TerminalSessionStore({ dataDir });
  assert.throws(
    () => reloaded.listActive(),
    (error) => error?.code === "TERMINAL_JOURNAL_UNHEALTHY"
  );
});

test("terminal capacity and manager ownership fail closed", (t) => {
  const dataDir = temporaryDirectory(t);
  const first = new TerminalSessionStore({
    dataDir,
    maxActiveGlobal: 2,
    maxActivePerProject: 1
  });
  first.start(sessionInput("0000000000000001", "alpha"));
  assert.throws(
    () => first.start(sessionInput("0000000000000002", "alpha")),
    /Project terminal session limit reached/u
  );
  first.start(sessionInput("0000000000000003", "beta"));
  assert.throws(
    () => first.start(sessionInput("0000000000000004", "gamma")),
    /Terminal session limit reached/u
  );

  const lease = first.acquireManagerLease({ ownerId: "manager:first" });
  const second = new TerminalSessionStore({ dataDir });
  assert.throws(
    () => second.acquireManagerLease({ ownerId: "manager:second" }),
    TerminalSessionLeaseError
  );
  assert.equal(lease.release(), true);
  const recovered = second.acquireManagerLease({ ownerId: "manager:second" });
  assert.equal(recovered.release(), true);
});

test("corrupt journals and uncertain corrupt appends never report success", (t) => {
  const dataDir = temporaryDirectory(t);
  const store = new TerminalSessionStore({ dataDir });
  fs.writeFileSync(store.eventsPath, "{\"not\":\"a terminal event\"}\n", "utf8");
  assert.throws(
    () => store.listActive(),
    (error) => error?.code === "TERMINAL_JOURNAL_UNHEALTHY"
  );

  const uncertainDir = temporaryDirectory(t);
  const uncertain = new TerminalSessionStore({
    dataDir: uncertainDir,
    appendEvent(file, event) {
      appendJsonLine(file, event);
      fs.appendFileSync(file, "{broken\n", "utf8");
      throw new Error("reported append failure");
    }
  });
  assert.throws(
    () => uncertain.start(sessionInput()),
    (error) => error?.code === "TERMINAL_JOURNAL_UNHEALTHY"
  );
});

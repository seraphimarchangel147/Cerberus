import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJsonLine } from "../src/file-utils.js";
import {
  JOB_STATUSES,
  JobResourceConflictError,
  JobRevisionError,
  JobStore
} from "../src/job-store.js";

function fixture(t, name = "case", options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `openagi-job-${name}-`))
  );
  const dir = path.join(root, "jobs");
  let tick = 0;
  const now = () => new Date(
    Date.UTC(2026, 6, 1, 0, 0, tick++)
  ).toISOString();
  const store = new JobStore({ dir, now, ...options });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dir, now, root, store };
}

function boundaries(overrides = {}) {
  return {
    policy: { ref: "policy-1", revision: 2 },
    approval: { ref: "approval-1", mode: "required" },
    budget: { ref: "budget-1", remaining: 10 },
    abort: { ref: "abort-1" },
    checkpoint: { ref: "checkpoint-1", required: true },
    redaction: { ref: "redaction-1", secretRefs: ["SERVICE_KEY"] },
    ...overrides
  };
}

function jobInput(overrides = {}) {
  return {
    kind: "direct-tool",
    target: "code_read",
    projectId: "default",
    sessionId: "session-1",
    idempotent: true,
    idempotencyKey: `key-${Math.random().toString(16).slice(2)}`,
    replayPayload: { args: { path: "README.md" } },
    boundaries: boundaries(),
    ...overrides
  };
}

test("durable lifecycle, status, collection, and project boundaries", async (t) => {
  const { dir, now, store } = fixture(t, "lifecycle");
  assert.deepEqual(JOB_STATUSES, [
    "queued",
    "running",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted"
  ]);
  assert.equal(store.capacity().maxConcurrency, 3);

  const started = store.start(jobInput({
    projectId: "alpha",
    sessionId: "alpha-session",
    metadata: { source: "test", secretRefs: ["SERVICE_KEY"] }
  }));
  assert.equal(started.status, "queued");
  assert.equal(started.revision, 1);
  assert.deepEqual(started.boundaries, boundaries());
  assert.deepEqual(started.resourceLocks, []);
  assert.throws(
    () => store.get(started.id),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => store.get(started.id, {
      projectId: "alpha",
      sessionId: "other-session"
    }),
    (error) => error.code === "JOB_SESSION_BOUNDARY_VIOLATION"
  );

  const running = store.markRunning(started.id, {
    projectId: "alpha",
    sessionId: "alpha-session",
    expectedRevision: 1
  });
  assert.equal(running.status, "running");
  assert.equal(running.attempt, 1);
  await assert.rejects(
    store.wait(started.id, {
      projectId: "alpha",
      sessionId: "alpha-session",
      timeoutMs: 0
    }),
    (error) => error.code === "JOB_WAIT_TIMEOUT"
  );
  assert.throws(
    () => store.collect(started.id, { projectId: "alpha" }),
    (error) => error.code === "JOB_NOT_READY"
  );

  const finished = store.complete(
    started.id,
    { result: { ok: true, rows: 2 } },
    {
      projectId: "alpha",
      sessionId: "alpha-session",
      expectedRevision: 2
    }
  );
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(
    store.collect(started.id, { projectId: "alpha" }).result,
    { ok: true, rows: 2 }
  );
  const consumed = store.collect(started.id, {
    consume: true,
    expectedRevision: 3,
    projectId: "alpha"
  });
  assert.ok(consumed.collectedAt);
  assert.equal(store.status(started.id, { projectId: "alpha" }).revision, 4);

  const reloaded = new JobStore({ dir, now });
  assert.equal(
    reloaded.status(started.id, { projectId: "alpha" }).status,
    "succeeded"
  );
  assert.equal(reloaded.list({ projectId: "alpha" }).length, 1);
  assert.equal(reloaded.list({ projectId: "default" }).length, 0);
  assert.equal(reloaded.listAll({ status: "succeeded" }).length, 1);
  assert.equal(reloaded.health().healthy, true);
});

test("idempotency tuple deduplicates exactly and conflicts fail closed", (t) => {
  const { store } = fixture(t, "dedupe");
  const request = jobInput({
    idempotencyKey: "stable-request-1",
    metadata: { traceRef: "trace-1" }
  });
  const first = store.start(request);
  const duplicate = store.start(structuredClone(request));
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.revision, 1);
  assert.equal(store.listAll().length, 1);

  assert.throws(
    () => store.start({
      ...request,
      target: "code_write",
      effect: "write",
      resourceLocks: ["workspace:readme"]
    }),
    (error) => error.code === "JOB_IDEMPOTENCY_CONFLICT"
  );
  const anotherSession = store.start({
    ...request,
    sessionId: "session-2"
  });
  const anotherProject = store.start({
    ...request,
    projectId: "alpha"
  });
  assert.notEqual(anotherSession.id, first.id);
  assert.notEqual(anotherProject.id, first.id);
});

test("default concurrency and hierarchical resource locks are enforced", (t) => {
  const { store } = fixture(t, "locks");
  const writeOne = store.start(jobInput({
    target: "code_write",
    effect: "write",
    resourceLocks: [
      { resource: "Workspace\\Src", mode: "write" },
      { resource: "workspace/src/file.js", mode: "read" }
    ]
  }));
  assert.deepEqual(writeOne.resourceLocks, [{
    resource: "workspace/src",
    mode: "write"
  }]);
  store.markRunning(writeOne.id);

  const overlap = store.start(jobInput({
    target: "code_write",
    effect: "write",
    resourceLocks: ["workspace/src/file.js"]
  }));
  assert.throws(
    () => store.markRunning(overlap.id),
    (error) => error instanceof JobResourceConflictError
      && error.conflictingJobId === writeOne.id
  );

  const disjoint = store.start(jobInput({
    target: "code_write",
    effect: "write",
    resourceLocks: ["workspace/docs"]
  }));
  store.markRunning(disjoint.id);
  const read = store.start(jobInput({
    target: "code_read",
    resourceLocks: [{ resource: "workspace/config", mode: "read" }]
  }));
  store.markRunning(read.id);
  assert.deepEqual(store.capacity(), {
    maxConcurrency: 3,
    running: 3,
    available: 0
  });

  const fourth = store.start(jobInput());
  assert.throws(
    () => store.markRunning(fourth.id),
    (error) => error.code === "JOB_CONCURRENCY_LIMIT"
  );
  const otherProject = store.start(jobInput({
    projectId: "beta",
    target: "code_write",
    effect: "write",
    resourceLocks: ["workspace/src"]
  }));
  assert.throws(
    () => store.markRunning(otherProject.id, { projectId: "beta" }),
    (error) => error.code === "JOB_CONCURRENCY_LIMIT"
  );
  store.complete(read.id, { result: "done" });
  assert.equal(
    store.markRunning(otherProject.id, { projectId: "beta" }).status,
    "running"
  );

  assert.throws(
    () => store.start(jobInput({
      target: "code_write",
      effect: "write",
      resourceLocks: []
    })),
    (error) => error.code === "JOB_RESOURCE_LOCK_REQUIRED"
  );
});

test("cancel requests are durable and settlement is explicit", async (t) => {
  const { store } = fixture(t, "cancel");
  const running = store.start(jobInput());
  store.markRunning(running.id);
  const requested = store.cancel(
    running.id,
    { reason: "operator request" },
    { expectedRevision: 2 }
  );
  assert.equal(requested.status, "cancel_requested");
  assert.ok(requested.cancel.requestedAt);
  assert.equal(store.cancel(running.id).revision, 3);
  const settled = store.markCancelled(
    running.id,
    { reason: "worker aborted" },
    { expectedRevision: 3 }
  );
  assert.equal(settled.status, "cancelled");
  assert.ok(settled.cancel.acknowledgedAt);
  assert.equal((await store.wait(running.id)).status, "cancelled");

  const queued = store.start(jobInput());
  const queuedRequest = store.cancel(queued.id);
  assert.equal(queuedRequest.status, "cancel_requested");
  assert.equal(queuedRequest.startedAt, null);
  assert.equal(store.capacity().running, 0);
  assert.equal(store.markCancelled(queued.id).status, "cancelled");

  const controller = new AbortController();
  const pending = store.start(jobInput());
  const wait = store.wait(pending.id, {
    signal: controller.signal,
    timeoutMs: 5_000
  });
  controller.abort();
  await assert.rejects(wait, (error) => error.name === "AbortError");
});

test("restart never replays dispatched work and retains only replayable queued jobs", (t) => {
  const { dir, now, store } = fixture(t, "restart", {
    maxConcurrency: 4
  });
  const initialLease = store.acquireSchedulerLease();
  const nonIdempotent = store.start(jobInput({
    idempotent: false,
    idempotencyKey: "non-idempotent",
    replayPayload: { operationRef: "operation-1" }
  }));
  store.markRunning(nonIdempotent.id);
  const idempotent = store.start(jobInput({
    idempotencyKey: "idempotent-running"
  }));
  store.markRunning(idempotent.id);
  const cancelling = store.start(jobInput({
    idempotencyKey: "cancel-requested"
  }));
  store.markRunning(cancelling.id);
  store.cancel(cancelling.id);
  const queuedReplayable = store.start(jobInput({
    idempotencyKey: "queued-replayable"
  }));
  const queuedWithoutPayload = store.start(jobInput({
    idempotencyKey: "queued-no-payload",
    replayPayload: undefined
  }));

  assert.equal(store.releaseSchedulerLease(initialLease), true);
  const restarted = new JobStore({ dir, now, maxConcurrency: 4 });
  assert.equal(restarted.get(nonIdempotent.id).status, "running");
  assert.equal(restarted.get(cancelling.id).status, "cancel_requested");
  const restartedLease = restarted.acquireSchedulerLease();
  for (const id of [nonIdempotent.id, idempotent.id, cancelling.id]) {
    const job = restarted.get(id);
    assert.equal(job.status, "interrupted");
    assert.equal(job.error.code, "JOB_OUTCOME_UNCERTAIN");
    assert.equal(job.error.retryable, false);
  }
  assert.equal(restarted.get(queuedReplayable.id).status, "queued");
  assert.equal(restarted.get(queuedWithoutPayload.id).status, "interrupted");
  assert.equal(
    restarted.get(queuedWithoutPayload.id).error.code,
    "JOB_REPLAY_PAYLOAD_MISSING"
  );
  assert.deepEqual(
    restarted.queued().map((job) => job.id),
    [queuedReplayable.id]
  );

  const secondRestart = new JobStore({ dir, now, maxConcurrency: 4 });
  assert.equal(secondRestart.get(nonIdempotent.id).status, "interrupted");
  assert.equal(secondRestart.get(nonIdempotent.id).revision, 3);
  assert.equal(restarted.releaseSchedulerLease(restartedLease), true);
});

test("scheduler lease keeps live readers passive and fails closed", (t) => {
  const { dir, now, store } = fixture(t, "scheduler-lease", {
    staleLockMs: 10
  });
  const lease = store.acquireSchedulerLease();
  const active = store.start(jobInput({
    idempotencyKey: "live-owner"
  }));
  store.markRunning(active.id);
  const leasePath = path.join(dir, ".scheduler.lease");
  const staleAt = new Date(Date.now() - 1_000);
  fs.utimesSync(leasePath, staleAt, staleAt);

  const reader = new JobStore({ dir, now, staleLockMs: 10 });
  assert.equal(reader.get(active.id).status, "running");
  assert.throws(
    () => reader.acquireSchedulerLease(),
    (error) => error.code === "JOB_SCHEDULER_LEASE_HELD"
      && error.ownerPid === process.pid
  );
  assert.equal(reader.get(active.id).status, "running");
  assert.throws(
    () => store.releaseSchedulerLease({}),
    (error) => error.code === "JOB_SCHEDULER_LEASE_NOT_OWNED"
  );
  assert.ok(fs.existsSync(leasePath));

  assert.equal(store.releaseSchedulerLease(lease), true);
  const takeover = reader.acquireSchedulerLease();
  assert.equal(reader.get(active.id).status, "interrupted");
  assert.equal(reader.get(active.id).error.code, "JOB_OUTCOME_UNCERTAIN");
  assert.equal(reader.releaseSchedulerLease(takeover), true);
});

test("scheduler lease recovers dead and stale ownership records", (t) => {
  const { dir, store } = fixture(t, "scheduler-recovery", {
    staleLockMs: 10
  });
  const leasePath = path.join(dir, ".scheduler.lease");
  fs.writeFileSync(leasePath, JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    acquiredAt: "2026-07-01T00:00:00.000Z",
    nonce: "dead-owner-1234"
  }), "utf8");
  const deadOwnerTakeover = store.acquireSchedulerLease();
  assert.equal(store.releaseSchedulerLease(deadOwnerTakeover), true);

  fs.writeFileSync(leasePath, "{partial", "utf8");
  const staleAt = new Date(Date.now() - 1_000);
  fs.utimesSync(leasePath, staleAt, staleAt);
  const staleTakeover = store.acquireSchedulerLease();
  assert.equal(store.releaseSchedulerLease(staleTakeover), true);
});

test("large results require caller-supplied tool-output references", (t) => {
  const { store } = fixture(t, "result", { maxResultBytes: 128 });
  const job = store.start(jobInput());
  store.markRunning(job.id);
  assert.throws(
    () => store.complete(job.id, { result: "x".repeat(512) }),
    /result exceeds its durable persistence bound/i
  );
  assert.equal(store.get(job.id).status, "running");
  const complete = store.complete(job.id, {
    toolOutputRef: "out_0123456789abcdef"
  });
  assert.equal(complete.result, null);
  assert.equal(complete.toolOutputRef, "out_0123456789abcdef");
  assert.equal(
    store.collect(job.id).toolOutputRef,
    "out_0123456789abcdef"
  );
  assert.throws(
    () => store.complete(job.id, {
      result: "small",
      toolOutputRef: "out_0123456789abcdef"
    }),
    /cannot contain both/i
  );
});

test("hostile inputs, secret values, and unbounded data are rejected", (t) => {
  const { store } = fixture(t, "hostile");
  assert.throws(
    () => new JobStore({ dir: store.dir, surprise: true }),
    /surprise is not supported/i
  );
  assert.throws(
    () => store.start({ ...jobInput(), unexpected: true }),
    /unexpected is not supported/i
  );
  assert.throws(
    () => store.start(jobInput({ projectId: "alpha" }), {
      projectId: "beta"
    }),
    (error) => error.code === "PROJECT_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => store.start(jobInput({ sessionId: "alpha-session" }), {
      sessionId: "beta-session"
    }),
    (error) => error.code === "JOB_SESSION_BOUNDARY_VIOLATION"
  );
  assert.throws(
    () => store.start(jobInput({ boundaries: { policy: {} } })),
    /boundaries\.[a-z]+ is required/i
  );
  assert.throws(
    () => store.start(jobInput({
      metadata: { apiKey: "not-a-reference" }
    })),
    (error) => error.code === "JOB_SECRET_VALUE_REJECTED"
  );
  assert.throws(
    () => store.start(jobInput({
      replayPayload: { value: `sk-${"a".repeat(24)}` }
    })),
    (error) => error.code === "JOB_SECRET_VALUE_REJECTED"
  );
  const placeholder = store.start(jobInput({
    replayPayload: {
      apiKey: "${SERVICE_KEY}",
      secretRef: "SERVICE_KEY"
    }
  }));
  assert.equal(placeholder.replayPayload.apiKey, "${SERVICE_KEY}");
  assert.throws(
    () => store.start(jobInput({ resourceLocks: [{ resource: "../*", mode: "write" }] })),
    /resource lock names/i
  );
  assert.throws(
    () => store.start(jobInput({ resourceLocks: ["workspace/../secrets"] })),
    /dot segments/i
  );
  assert.throws(
    () => store.start(jobInput({ resourceLocks: ["workspace/./file"] })),
    /dot segments/i
  );
  assert.throws(
    () => store.start(jobInput({ metadata: new Proxy({}, {}) })),
    /proxies/i
  );
  let getterCalls = 0;
  const accessorMetadata = {};
  Object.defineProperty(accessorMetadata, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "should-not-run";
    }
  });
  assert.throws(
    () => store.start(jobInput({ metadata: accessorMetadata })),
    /data properties only/i
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => store.start(jobInput({
      metadata: JSON.parse('{"__proto__":{"polluted":true}}')
    })),
    /invalid object key/i
  );
  let arrayGetterCalls = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return "should-not-run";
    }
  });
  accessorArray.length = 1;
  assert.throws(
    () => store.start(jobInput({ metadata: { values: accessorArray } })),
    /sparse or accessor arrays/i
  );
  assert.equal(arrayGetterCalls, 0);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => store.start(jobInput({ metadata: cyclic })),
    /nesting depth|too many values/i
  );
});

test("append uncertainty reconciles committed bytes and rolls back live-only state", (t) => {
  let mode = "normal";
  const { dir, now, store } = fixture(t, "append", {
    appendEvent(filePath, event) {
      if (mode === "before") throw new Error("append failed before write");
      appendJsonLine(filePath, event);
      if (mode === "after") throw new Error("append failed after write");
    }
  });
  mode = "after";
  const durable = store.start(jobInput({
    idempotencyKey: "after-write"
  }));
  assert.equal(store.get(durable.id).status, "queued");
  assert.equal(new JobStore({ dir, now }).get(durable.id).status, "queued");

  mode = "before";
  assert.throws(
    () => store.start(jobInput({ idempotencyKey: "before-write" })),
    /append failed before write/
  );
  assert.equal(
    store.listAll().some((job) => job.idempotencyKey === "before-write"),
    false
  );
  assert.equal(
    new JobStore({ dir, now }).listAll()
      .some((job) => job.idempotencyKey === "before-write"),
    false
  );
});

test("corrupt journals stop replay, block mutation, and do not accept a valid suffix", (t) => {
  const { dir, now, store } = fixture(t, "corrupt");
  const first = store.start(jobInput({ idempotencyKey: "first" }));
  const firstEvent = fs.readFileSync(
    path.join(dir, "events.jsonl"),
    "utf8"
  ).trim();
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    `${firstEvent}\n{"broken":\n${firstEvent}\n`,
    "utf8"
  );
  const corrupt = new JobStore({ dir, now });
  assert.equal(corrupt.health().healthy, false);
  assert.equal(corrupt.get(first.id).id, first.id);
  assert.throws(
    () => corrupt.start(jobInput()),
    (error) => error.code === "JOB_PERSISTENCE_UNHEALTHY"
  );

  fs.writeFileSync(path.join(dir, "snapshot.json"), "{bad", "utf8");
  const journalOnlyDir = path.join(path.dirname(dir), "journal-only");
  const journalOnly = new JobStore({ dir: journalOnlyDir, now });
  const recoverable = journalOnly.start(jobInput());
  fs.writeFileSync(
    path.join(journalOnlyDir, "snapshot.json"),
    "{corrupt",
    "utf8"
  );
  const recovered = new JobStore({ dir: journalOnlyDir, now });
  assert.equal(recovered.get(recoverable.id).status, "queued");
  assert.equal(recovered.health().healthy, true);
});

test("authoritative reads and CAS serialize stale instances", (t) => {
  const { dir, now, store } = fixture(t, "cas");
  const job = store.start(jobInput());
  const second = new JobStore({ dir, now });
  const running = store.markRunning(job.id, { expectedRevision: 1 });
  assert.equal(running.revision, 2);
  assert.equal(second.status(job.id).status, "running");
  assert.throws(
    () => second.cancel(job.id, {}, { expectedRevision: 1 }),
    (error) => error instanceof JobRevisionError
      && error.actualRevision === 2
  );
  const requested = second.cancel(job.id, {}, { expectedRevision: 2 });
  assert.equal(requested.status, "cancel_requested");
  assert.equal(store.status(job.id).status, "cancel_requested");
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line).sequence),
    [1, 2, 3]
  );
});

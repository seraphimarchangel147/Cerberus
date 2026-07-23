import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installGracefulShutdown } from "../src/boot.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCalls = [];
  }

  exit(code) {
    this.exitCalls.push(code);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("termination waits for app.close and coalesces repeated signals", async () => {
  const processLike = new FakeProcess();
  const closeStarted = deferred();
  const releaseClose = deferred();
  let closeCalls = 0;
  const app = {
    async close() {
      closeCalls += 1;
      closeStarted.resolve();
      await releaseClose.promise;
    }
  };
  const controller = installGracefulShutdown(app, { processLike, timeoutMs: 1000 });

  assert.equal(processLike.listenerCount("SIGINT"), 1);
  assert.equal(processLike.listenerCount("SIGTERM"), 1);
  processLike.emit("SIGTERM");
  await closeStarted.promise;

  assert.equal(closeCalls, 1);
  assert.deepEqual(processLike.exitCalls, [], "does not exit before close resolves");
  assert.equal(processLike.listenerCount("SIGINT"), 1, "handlers keep coalescing signals during close");
  assert.equal(processLike.listenerCount("SIGTERM"), 1);
  assert.equal(processLike.emit("SIGINT"), true);
  assert.equal(closeCalls, 1, "a second signal cannot start another close");

  releaseClose.resolve();
  await controller.pending;
  assert.equal(closeCalls, 1);
  assert.deepEqual(processLike.exitCalls, [0]);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
});

test("shutdown is bounded when app.close never settles", async () => {
  const processLike = new FakeProcess();
  const logged = [];
  const app = { close: () => new Promise(() => {}) };
  const controller = installGracefulShutdown(app, {
    processLike,
    timeoutMs: 5,
    log: (message) => logged.push(message)
  });

  await controller.shutdown("SIGINT");
  assert.deepEqual(processLike.exitCalls, [0]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SIGINT shutdown timed out after 5ms; exiting/);
});

test("close failures are logged but never block exit", async () => {
  const processLike = new FakeProcess();
  const logged = [];
  const controller = installGracefulShutdown({
    close: async () => { throw new Error("review flush failed"); }
  }, {
    processLike,
    timeoutMs: 1000,
    log: (message) => logged.push(message)
  });

  processLike.emit("SIGTERM");
  await controller.pending;
  assert.deepEqual(processLike.exitCalls, [0]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SIGTERM shutdown close failed open: review flush failed/);
});

test("a repeated installation replaces stale signal handlers", async () => {
  const processLike = new FakeProcess();
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;
  const first = installGracefulShutdown({
    close: async () => { firstCloseCalls += 1; }
  }, { processLike });
  const second = installGracefulShutdown({
    close: async () => { secondCloseCalls += 1; }
  }, { processLike });

  assert.equal(processLike.listenerCount("SIGINT"), 1);
  assert.equal(processLike.listenerCount("SIGTERM"), 1);
  assert.equal(first.pending, null);

  processLike.emit("SIGINT");
  await second.pending;
  assert.equal(firstCloseCalls, 0, "the stale app is not closed");
  assert.equal(secondCloseCalls, 1);
  assert.deepEqual(processLike.exitCalls, [0]);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
});

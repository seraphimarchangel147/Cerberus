import assert from "node:assert/strict";
import test from "node:test";
import { startServerApplications } from "../src/boot.js";
import {
  createApiServer,
  createSubscriptionProxy,
  startCapabilityServers
} from "../src/index.js";

function fakeHosted(events, options = {}) {
  let listenCalls = 0;
  let closeCalls = 0;
  return {
    marker: "hosted-contract",
    async listen() {
      listenCalls += 1;
      events.push("hosted:listen");
      if (options.listenError) throw options.listenError;
      return { host: "127.0.0.1", port: 43210, url: "http://127.0.0.1:43210" };
    },
    async close() {
      closeCalls += 1;
      events.push("hosted:close");
      if (options.closeError) throw options.closeError;
    },
    get listenCalls() { return listenCalls; },
    get closeCalls() { return closeCalls; }
  };
}

function fakeCapabilities(events, options = {}) {
  let listenCalls = 0;
  let closeCalls = 0;
  const capabilities = {
    apiServer: { name: "api" },
    subscriptionProxy: { name: "proxy" },
    addresses: options.addresses ?? {
      apiServer: { host: "127.0.0.1", port: 8642 },
      subscriptionProxy: { host: "127.0.0.1", port: 8645 }
    },
    async listen() {
      listenCalls += 1;
      events.push("capabilities:listen");
      if (options.listenError) throw options.listenError;
      return this.addresses;
    },
    async close() {
      closeCalls += 1;
      events.push("capabilities:close");
      if (options.closeError) throw options.closeError;
    },
    get listenCalls() { return listenCalls; },
    get closeCalls() { return closeCalls; }
  };
  return capabilities;
}

test("hosted and capability servers form one ordered idempotent lifecycle", async () => {
  const events = [];
  const hosted = fakeHosted(events);
  const capabilities = fakeCapabilities(events);
  const runtime = { id: "runtime" };
  const secretsStore = { id: "secrets" };
  const env = { API_SERVER_ENABLED: "true" };
  let factoryInput = null;

  const started = await startServerApplications({
    app: hosted,
    runtime,
    secretsStore,
    env,
    capabilityServerOptions: { apiPort: 0 },
    capabilityServersFactory(options) {
      factoryInput = options;
      events.push("capabilities:create");
      return capabilities;
    }
  });

  assert.deepEqual(events, [
    "hosted:listen",
    "capabilities:create",
    "capabilities:listen"
  ]);
  assert.strictEqual(started.app, hosted);
  assert.strictEqual(started.capabilities, capabilities);
  assert.strictEqual(hosted.capabilities, capabilities);
  assert.strictEqual(started.capabilityAddresses, capabilities.addresses);
  assert.strictEqual(started.addresses, capabilities.addresses);
  assert.strictEqual(hosted.capabilityAddresses, capabilities.addresses);
  assert.equal(hosted.marker, "hosted-contract");
  assert.deepEqual(factoryInput, {
    runtime,
    secretsStore,
    env,
    apiPort: 0
  });

  const firstClose = hosted.close();
  const secondClose = hosted.close();
  assert.strictEqual(secondClose, firstClose);
  await firstClose;
  assert.deepEqual(events.slice(-2), [
    "capabilities:close",
    "hosted:close"
  ]);
  assert.equal(capabilities.closeCalls, 1);
  assert.equal(hosted.closeCalls, 1);
});

test("a capability listen failure rolls back capabilities and hosted app", async () => {
  const events = [];
  const hosted = fakeHosted(events);
  const failure = new Error("capability port is unavailable");
  const capabilities = fakeCapabilities(events, { listenError: failure });

  await assert.rejects(
    startServerApplications({
      app: hosted,
      runtime: {},
      secretsStore: {},
      env: {},
      capabilityServersFactory: () => capabilities
    }),
    (error) => error === failure
  );
  assert.deepEqual(events, [
    "hosted:listen",
    "capabilities:listen",
    "capabilities:close",
    "hosted:close"
  ]);
  assert.equal(capabilities.closeCalls, 1);
  assert.equal(hosted.closeCalls, 1);
});

test("a capability factory failure closes the already-listening hosted app", async () => {
  const events = [];
  const hosted = fakeHosted(events);
  const failure = new Error("invalid capability configuration");

  await assert.rejects(
    startServerApplications({
      app: hosted,
      runtime: {},
      secretsStore: {},
      env: {},
      capabilityServersFactory: () => {
        events.push("capabilities:create");
        throw failure;
      }
    }),
    (error) => error === failure
  );
  assert.deepEqual(events, [
    "hosted:listen",
    "capabilities:create",
    "hosted:close"
  ]);
  assert.equal(hosted.closeCalls, 1);
});

test("shutdown closes hosted app even when capability cleanup fails", async () => {
  const events = [];
  const hosted = fakeHosted(events);
  const failure = new Error("capability close failed");
  const capabilities = fakeCapabilities(events, { closeError: failure });
  const started = await startServerApplications({
    app: hosted,
    runtime: {},
    secretsStore: {},
    env: {},
    capabilityServersFactory: () => capabilities
  });

  await assert.rejects(started.app.close(), (error) => error === failure);
  assert.deepEqual(events.slice(-2), [
    "capabilities:close",
    "hosted:close"
  ]);
  assert.equal(capabilities.closeCalls, 1);
  assert.equal(hosted.closeCalls, 1);
  await assert.rejects(started.app.close(), (error) => error === failure);
  assert.equal(capabilities.closeCalls, 1);
  assert.equal(hosted.closeCalls, 1);
});

test("index exposes the F10 server construction contract", () => {
  assert.equal(typeof createApiServer, "function");
  assert.equal(typeof createSubscriptionProxy, "function");
  assert.equal(typeof startCapabilityServers, "function");
});

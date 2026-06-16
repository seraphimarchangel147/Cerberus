// test/boot-crash-guards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { installCrashGuards } from "../src/boot.js";

// A reauth-needed / unreachable MCP server rejects asynchronously during
// connect (401, OAuth callback timeout, DNS failure). Node 15+ would terminate
// the daemon on that unhandled rejection — crash-looping a recoverable error.
// installCrashGuards must turn those into logged, non-fatal events.
test("installCrashGuards installs non-fatal handlers and is idempotent", () => {
  const beforeRej = process.listeners("unhandledRejection").length;
  const beforeExc = process.listeners("uncaughtException").length;

  installCrashGuards();
  const rejListeners = process.listeners("unhandledRejection");
  const excListeners = process.listeners("uncaughtException");
  assert.equal(rejListeners.length, beforeRej + 1, "adds one unhandledRejection listener");
  assert.equal(excListeners.length, beforeExc + 1, "adds one uncaughtException listener");

  // Idempotent: a second call must not stack more listeners.
  installCrashGuards();
  assert.equal(process.listeners("unhandledRejection").length, beforeRej + 1, "idempotent (rejection)");
  assert.equal(process.listeners("uncaughtException").length, beforeExc + 1, "idempotent (exception)");

  // The handlers must log and NOT rethrow — an MCP 401 / OAuth timeout is not fatal.
  const ourRej = rejListeners[rejListeners.length - 1];
  const ourExc = excListeners[excListeners.length - 1];
  const origErr = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.doesNotThrow(() => ourRej(new Error("HTTP 401 from buildbetter staging: invalid_token")));
    assert.doesNotThrow(() => ourExc(new Error("OAuth callback timed out")));
    // A non-Error reason (e.g. a rejected string) must also be handled.
    assert.doesNotThrow(() => ourRej("bare string rejection"));
  } finally {
    console.error = origErr;
  }
  assert.ok(logged.some((l) => l.includes("401")), "logged the 401 rejection");
  assert.ok(logged.some((l) => l.includes("OAuth callback timed out")), "logged the exception");
  assert.ok(logged.some((l) => l.includes("bare string rejection")), "logged a non-Error reason");

  // Clean up the listeners we added so they don't leak into the test runner.
  process.removeListener("unhandledRejection", ourRej);
  process.removeListener("uncaughtException", ourExc);
});

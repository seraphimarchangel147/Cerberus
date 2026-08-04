import test from "node:test";
import assert from "node:assert/strict";
import { DenialBreaker, denialSessionKey, DEFAULT_DENIAL_THRESHOLD, MAX_TRACKED_SESSIONS } from "../src/denial-breaker.js";
import { HookRegistry } from "../src/hook-registry.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("below the threshold the addendum is empty", () => {
  const breaker = new DenialBreaker({ threshold: 3 });
  assert.equal(breaker.addendum("s1"), "");
  assert.equal(breaker.record("s1"), 1);
  assert.equal(breaker.addendum("s1"), "");
  assert.equal(breaker.record("s1"), 2);
  assert.equal(breaker.addendum("s1"), "");
});

test("at the threshold the addendum states the count and the escalation", () => {
  const breaker = new DenialBreaker({ threshold: 3 });
  for (let i = 0; i < 3; i += 1) breaker.record("s1");
  const text = breaker.addendum("s1");
  assert.notEqual(text, "");
  assert.match(text, /CIRCUIT BREAKER/);
  assert.match(text, /3 consecutive/);
  assert.match(text, /threshold 3/);
  assert.match(text, /STOP retrying/);
  // It must tell the model what to do INSTEAD, not merely to stop.
  assert.match(text, /explain to the user/i);
  assert.match(text, /different approach|ask the user/i);
});

test("the addendum keeps escalating past the threshold with the live count", () => {
  const breaker = new DenialBreaker({ threshold: 2 });
  breaker.record("s1"); breaker.record("s1"); breaker.record("s1");
  assert.match(breaker.addendum("s1"), /3 consecutive/);
});

test("reset clears the tally and the next denial starts from one", () => {
  const breaker = new DenialBreaker({ threshold: 3 });
  for (let i = 0; i < 5; i += 1) breaker.record("s1");
  assert.notEqual(breaker.addendum("s1"), "");
  breaker.reset("s1");
  assert.equal(breaker.count("s1"), 0);
  assert.equal(breaker.record("s1"), 1);
  assert.equal(breaker.addendum("s1"), "");
});

test("threshold 0 disables the breaker entirely, even after 50 denials", () => {
  const breaker = new DenialBreaker({ threshold: 0 });
  assert.equal(breaker.enabled, false);
  for (let i = 0; i < 50; i += 1) breaker.record("s1");
  assert.equal(breaker.addendum("s1"), "");
  assert.equal(breaker.recordAndAddendum("s1"), "");
});

test("threshold comes from OPENAGI_DENIAL_BREAKER_THRESHOLD, defaulting to 3", () => {
  assert.equal(new DenialBreaker({ env: {} }).threshold, DEFAULT_DENIAL_THRESHOLD);
  assert.equal(new DenialBreaker({ env: { OPENAGI_DENIAL_BREAKER_THRESHOLD: "7" } }).threshold, 7);
  assert.equal(new DenialBreaker({ env: { OPENAGI_DENIAL_BREAKER_THRESHOLD: "0" } }).enabled, false);
  // A malformed value must not disable the safety valve by accident.
  assert.equal(new DenialBreaker({ env: { OPENAGI_DENIAL_BREAKER_THRESHOLD: "banana" } }).threshold, DEFAULT_DENIAL_THRESHOLD);
  // An explicit constructor value wins over the environment.
  assert.equal(new DenialBreaker({ threshold: 5, env: { OPENAGI_DENIAL_BREAKER_THRESHOLD: "9" } }).threshold, 5);
});

test("eviction caps the map at 256 and keeps the most recently touched session", () => {
  const breaker = new DenialBreaker({ threshold: 3 });
  for (let i = 0; i < 300; i += 1) breaker.record(`session-${i}`);
  assert.ok(breaker.stats().trackedSessions <= MAX_TRACKED_SESSIONS, "map must stay bounded");

  // A hot session must survive eviction pressure: delete-then-set moves it to
  // the tail, so insertion-order eviction drops idle keys instead.
  breaker.record("hot");
  breaker.record("hot");
  for (let i = 300; i < 500; i += 1) {
    breaker.record(`session-${i}`);
    breaker.record("hot");
  }
  assert.ok(breaker.count("hot") > 0, "the actively-denying session was evicted");
  assert.ok(breaker.stats().trackedSessions <= MAX_TRACKED_SESSIONS);
});

test("denialSessionKey namespaces by project so two projects cannot share a tally", () => {
  assert.equal(denialSessionKey({ sessionId: "s1" }), "s1");
  assert.equal(denialSessionKey({ sessionId: "s1", projectId: "p1" }), "p1:s1");
  assert.equal(denialSessionKey({ sessionId: "s1", projectId: "p2" }), "p2:s1");
  assert.equal(denialSessionKey({}), "default");
  assert.equal(denialSessionKey(null), "default");
});

// --- integration through the real tool registry -------------------------

function blockingRegistry({ threshold = 3 } = {}) {
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  hooks.register({
    name: "always-block",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => ({ action: "block", message: "blocked by policy" })
  });
  const tools = new ToolRegistry({ hooks, denialBreaker: new DenialBreaker({ threshold }) });
  tools.register({
    name: "probe",
    parameters: { type: "object", additionalProperties: true },
    handler: async () => ({ ok: true })
  });
  return tools;
}

test("integration: the block message gains the addendum on the Nth denial only", async () => {
  const tools = blockingRegistry({ threshold: 3 });
  const context = { sessionId: "loop-session" };
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await tools.invoke("probe", {}, context));
  }

  assert.equal(results[0].error, "blocked by policy", "first denial is unchanged");
  assert.equal(results[1].error, "blocked by policy", "second denial is unchanged");
  assert.notEqual(results[2].error, "blocked by policy");
  assert.ok(results[2].error.startsWith("blocked by policy"), "the addendum appends, it does not replace");
  assert.match(results[2].error, /CIRCUIT BREAKER/);

  // The escalation changed ONLY the result string: same envelope shape, same
  // keys, still a normal blocked tool result. No message-history surgery.
  assert.equal(results[2].ok, false);
  assert.equal(results[2].blocked, true);
  assert.equal(results[2].code, results[0].code);
  assert.deepEqual(
    Object.keys(results[2]).sort(),
    Object.keys(results[0]).sort(),
    "the breaker must not add or remove envelope fields"
  );
});

test("integration: a successful invocation between denials resets the tally", async () => {
  const hooks = new HookRegistry({ loadConfig: false, log: () => {} });
  let blocking = true;
  hooks.register({
    name: "toggle-block",
    event: "pre_tool_call",
    tier: "plugin",
    handler: () => (blocking ? { action: "block", message: "blocked by policy" } : { action: "allow" })
  });
  const tools = new ToolRegistry({ hooks, denialBreaker: new DenialBreaker({ threshold: 3 }) });
  tools.register({
    name: "probe",
    parameters: { type: "object", additionalProperties: true },
    handler: async () => ({ fine: true })
  });
  const context = { sessionId: "recovering" };

  await tools.invoke("probe", {}, context);
  await tools.invoke("probe", {}, context);

  blocking = false;
  const success = await tools.invoke("probe", {}, context);
  assert.equal(success.ok, true, "the allow path must actually dispatch");

  blocking = true;
  const first = await tools.invoke("probe", {}, context);
  const second = await tools.invoke("probe", {}, context);
  assert.equal(first.error, "blocked by policy", "tally restarted after the success");
  assert.equal(second.error, "blocked by policy");
  const third = await tools.invoke("probe", {}, context);
  assert.match(third.error, /CIRCUIT BREAKER/, "three fresh denials trip it again");
});

test("integration: two sessions keep independent tallies", async () => {
  const tools = blockingRegistry({ threshold: 3 });
  for (let i = 0; i < 2; i += 1) {
    await tools.invoke("probe", {}, { sessionId: "a" });
    await tools.invoke("probe", {}, { sessionId: "b" });
  }
  const a = await tools.invoke("probe", {}, { sessionId: "a" });
  assert.match(a.error, /CIRCUIT BREAKER/);
  const b = await tools.invoke("probe", {}, { sessionId: "b" });
  assert.match(b.error, /CIRCUIT BREAKER/);
  // Same session id under a different project is a different tally.
  const scoped = await tools.invoke("probe", {}, { sessionId: "a", projectId: "other" });
  assert.equal(scoped.error, "blocked by policy");
});

test("integration: a disabled breaker leaves the block message byte-identical", async () => {
  const tools = blockingRegistry({ threshold: 0 });
  const context = { sessionId: "never-trips" };
  for (let i = 0; i < 10; i += 1) {
    const result = await tools.invoke("probe", {}, context);
    assert.equal(result.error, "blocked by policy");
  }
});

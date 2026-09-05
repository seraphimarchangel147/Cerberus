import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore, secretFingerprint } from "../src/secrets-store.js";

const KEY_A_VALUE = "sk-test-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const KEY_B_VALUE = "sk-second-key-value-0123456789abcdef0123456789abcdef";

function fixture(t, { allowlist = ["KEY_A", "KEY_B", "KEY_C"], env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-v2-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({
    dataDir,
    allowlist,
    env,
    now: () => new Date("2026-09-03T12:00:00.000Z")
  });
  return { dataDir, env, store };
}

function readAudit(dataDir) {
  return fs.readFileSync(path.join(dataDir, "secrets", "audit.jsonl"), "utf8");
}

test("v2: setSecret persists destinations/scopes and recomputes fingerprint", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, {
    decidedBy: "test:v2:set",
    destinations: ["api.kimi.com"],
    scopes: ["agent:azazel"]
  });
  const meta = store.getSecretRecord("KEY_A", { decidedBy: "test:v2:record" });
  assert.deepEqual(meta.destinations, ["api.kimi.com"]);
  assert.deepEqual(meta.scopes, ["agent:azazel"]);
  assert.equal(meta.fingerprint, secretFingerprint(KEY_A_VALUE));
  assert.equal(meta.fingerprint, "sk-t…GHIJ");
  assert.equal(meta.hasValue, true);
  assert.ok(!("value" in meta), "getSecretRecord must never return material");
});

test("v2: rotating a value carries destination/scope policy forward", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, {
    destinations: ["api.kimi.com"],
    scopes: ["agent:azazel"]
  });
  store.setSecret("KEY_A", KEY_B_VALUE); // no metadata args — rotate value only
  const meta = store.getSecretRecord("KEY_A");
  assert.deepEqual(meta.destinations, ["api.kimi.com"]);
  assert.deepEqual(meta.scopes, ["agent:azazel"]);
  assert.equal(meta.fingerprint, secretFingerprint(KEY_B_VALUE));
});

test("v2: metadata survives a full reload (normalizeSnapshot preserves it)", (t) => {
  const { dataDir, env } = fixture(t);
  const first = new SecretsStore({ dataDir, allowlist: ["KEY_A", "KEY_B", "KEY_C"], env });
  first.setSecret("KEY_A", KEY_A_VALUE, {
    destinations: ["API.Kimi.com", "api.kimi.com"], // dedupe + lowercase
    scopes: ["agent:azazel"]
  });
  first.setSecretMeta("KEY_A", { verifiedStatus: "ok", lastVerifiedAt: "2026-09-03T11:00:00Z" });

  const second = new SecretsStore({ dataDir, allowlist: ["KEY_A", "KEY_B", "KEY_C"], env });
  const meta = second.getSecretRecord("KEY_A");
  assert.deepEqual(meta.destinations, ["api.kimi.com"]);
  assert.deepEqual(meta.scopes, ["agent:azazel"]);
  assert.equal(meta.verifiedStatus, "ok");
  assert.equal(meta.lastVerifiedAt, "2026-09-03T11:00:00.000Z");
});

test("v2: setSecretMeta validates strictly and rejects unknown keys", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE);
  assert.throws(
    () => store.setSecretMeta("KEY_A", { value: "nope" }),
    /Unsupported secret metadata keys: value/
  );
  assert.throws(
    () => store.setSecretMeta("KEY_A", { destinations: "api.kimi.com" }),
    /must be an array/
  );
  assert.throws(
    () => store.setSecretMeta("KEY_A", { destinations: ["not a host!!"] }),
    /Invalid secret destination host/
  );
  assert.throws(
    () => store.setSecretMeta("KEY_A", { scopes: ["everyone"] }),
    /Invalid secret scope/
  );
  assert.throws(
    () => store.setSecretMeta("KEY_A", { verifiedStatus: "maybe" }),
    /Invalid verifiedStatus/
  );
  assert.throws(
    () => store.setSecretMeta("MISSING_KEY", { verifiedStatus: "ok" }),
    /Unknown secret name/
  );
  assert.throws(
    () => store.setSecretMeta("KEY_B", { verifiedStatus: "ok" }),
    /unknown secret/
  );
});

test("v2: wildcard destinations and agent:* scope are storable", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, {
    destinations: ["*.kimi.com", "api.anthropic.com"],
    scopes: ["agent:*", "project:default"]
  });
  const meta = store.getSecretRecord("KEY_A");
  assert.deepEqual(meta.destinations, ["*.kimi.com", "api.anthropic.com"]);
  assert.deepEqual(meta.scopes, ["agent:*", "project:default"]);
});

test("v2: getSecretWithRecord returns value+metadata from one locked load", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, { destinations: ["api.kimi.com"] });
  const pair = store.getSecretWithRecord("KEY_A");
  assert.equal(pair.value, KEY_A_VALUE);
  assert.equal(pair.record.name, "KEY_A");
  assert.deepEqual(pair.record.destinations, ["api.kimi.com"]);
  assert.equal(pair.record.fingerprint, secretFingerprint(KEY_A_VALUE));
  assert.equal(store.getSecretWithRecord("KEY_B"), null);
});

test("v2: setSecretMeta history and rotate bookkeeping", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE);
  const oldFp = secretFingerprint(KEY_A_VALUE);
  store.setSecretMeta("KEY_A", {
    history: [{ fingerprint: oldFp, rotatedAt: "2026-09-03T11:59:00Z" }],
    rotatedAt: "2026-09-03T12:00:00Z"
  });
  store.setSecret("KEY_A", KEY_B_VALUE);
  const meta = store.getSecretRecord("KEY_A");
  assert.equal(meta.history.length, 1);
  assert.equal(meta.history[0].fingerprint, oldFp);
  assert.equal(meta.rotatedAt, "2026-09-03T12:00:00.000Z");
  assert.equal(meta.fingerprint, secretFingerprint(KEY_B_VALUE));
  assert.notEqual(meta.fingerprint, oldFp);
});

test("v2: load-time normalization drops malformed metadata instead of killing the store", (t) => {
  const { dataDir, env, store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, { destinations: ["api.kimi.com"] });
  const snapshotPath = path.join(dataDir, "secrets", "secrets.json");
  const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  raw.secrets.KEY_A.destinations = "definitely-not-an-array";
  raw.secrets.KEY_A.junkField = "dropped";
  fs.writeFileSync(snapshotPath, JSON.stringify(raw), { mode: 0o600 });
  const meta = store.getSecretRecord("KEY_A");
  assert.equal(meta.destinations, undefined, "malformed destinations dropped on load");
  assert.ok(!("junkField" in meta), "unknown fields dropped");
  assert.equal(store.getSecret("KEY_A"), KEY_A_VALUE, "value still readable");
});

test("v2: audit carries meta events and never secret material", (t) => {
  const { dataDir, store } = fixture(t);
  store.setSecret("KEY_A", KEY_A_VALUE, { destinations: ["api.kimi.com"] });
  store.setSecretMeta("KEY_A", { verifiedStatus: "ok" });
  store.getSecretRecord("KEY_A");
  const audit = readAudit(dataDir);
  const metaEvents = audit.trim().split("\n").map((line) => JSON.parse(line))
    .filter((event) => event.action === "meta" || event.action === "access-meta");
  assert.ok(metaEvents.some((event) => event.action === "meta" && event.accepted === true));
  assert.ok(metaEvents.some((event) => event.action === "access-meta"));
  assert.ok(!audit.includes(KEY_A_VALUE), "secret material leaked into audit");
});

test("v2: fingerprint helper matches SPEC shape", () => {
  assert.equal(secretFingerprint(KEY_A_VALUE), `${KEY_A_VALUE.slice(0, 4)}…${KEY_A_VALUE.slice(-4)}`);
  assert.equal(secretFingerprint("short"), "****");
  assert.equal(secretFingerprint(null), "****");
});

test("v2: v1 records (value+updatedAt only) read back cleanly", (t) => {
  const { dataDir, env } = fixture(t);
  const snapshotPath = path.join(dataDir, "secrets", "secrets.json");
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, JSON.stringify({
    version: 1,
    updatedAt: "2026-08-26T11:45:55.354Z",
    secrets: {
      KEY_A: { value: KEY_A_VALUE, updatedAt: "2026-08-26T11:45:55.354Z" }
    }
  }), { mode: 0o600 });
  const store = new SecretsStore({ dataDir, allowlist: ["KEY_A"], env });
  assert.equal(store.getSecret("KEY_A"), KEY_A_VALUE);
  const meta = store.getSecretRecord("KEY_A");
  assert.equal(meta.destinations, undefined);
  assert.equal(meta.verifiedStatus, undefined);
  assert.equal(meta.hasValue, true);
});

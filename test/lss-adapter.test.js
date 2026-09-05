// LSS conformance S1–S7 (tests/conformance/SCENARIOS.md) against the REAL
// openAGI SecretsStore + lss-adapter, plus wildcard and no-ambient-fallback
// behavior. Fixture shape mirrors the shared spec fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore, secretFingerprint } from "../src/secrets-store.js";
import {
  LssError,
  destinationMatches,
  lssEnabled,
  lssInstall,
  lssRotate,
  resolveViaLss,
  urlHost
} from "../src/lss-adapter.js";

const KEY_A_VALUE = "sk-test-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const KEY_B_VALUE = "sk-second-key-value-0123456789abcdef0123456789abcdef";
const KEY_C_VALUE = "sk-third-key-value-0123456789abcdef0123456789abcdef";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lss-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({
    dataDir,
    allowlist: ["KEY_A", "KEY_B", "KEY_C"],
    env: {},
    now: () => new Date("2026-09-03T12:00:00.000Z")
  });
  store.setSecret("KEY_A", KEY_A_VALUE, {
    decidedBy: "test:fixture",
    scopes: ["agent:azazel"],
    destinations: ["api.kimi.com"]
  });
  store.setSecretMeta("KEY_A", { verifiedStatus: "ok" }, { decidedBy: "test:fixture" });
  store.setSecret("KEY_B", KEY_B_VALUE, {
    decidedBy: "test:fixture",
    scopes: ["agent:seraphim"],
    destinations: ["api.anthropic.com"]
  });
  store.setSecretMeta("KEY_B", { verifiedStatus: "ok" }, { decidedBy: "test:fixture" });
  return { dataDir, store };
}

function readAudit(dataDir) {
  return fs.readFileSync(path.join(dataDir, "secrets", "audit.jsonl"), "utf8");
}

test("S3: resolve ok — value, fingerprint, and one secret:requested audit with no material", (t) => {
  const { dataDir, store } = fixture(t);
  const handle = resolveViaLss(store, "KEY_A", {
    agent: "azazel",
    project: "default",
    destination: "api.kimi.com"
  });
  assert.equal(handle.material, KEY_A_VALUE);
  assert.equal(handle.fingerprint, secretFingerprint(KEY_A_VALUE));
  const requested = readAudit(dataDir).trim().split("\n").map((line) => JSON.parse(line))
    .filter((event) => event.action === "secret:requested");
  const ok = requested.find((event) => event.name === "KEY_A" && event.outcome === "ok");
  assert.ok(ok, "missing secret:requested ok event");
  assert.equal(ok.fingerprint, secretFingerprint(KEY_A_VALUE));
  assert.ok(!readAudit(dataDir).includes(KEY_A_VALUE), "material leaked into audit");
});

test("S1: wrong destination is denied and returns no material", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => resolveViaLss(store, "KEY_A", { agent: "azazel", destination: "api.anthropic.com" }),
    (error) => error instanceof LssError && error.code === "LSS_DESTINATION_DENIED"
  );
});

test("S1b: absent destinations pin denies everything (fail closed)", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_C", KEY_C_VALUE, { decidedBy: "test" }); // no destinations
  assert.throws(
    () => resolveViaLss(store, "KEY_C", { agent: "azazel", destination: "api.kimi.com" }),
    (error) => error.code === "LSS_DESTINATION_DENIED"
  );
});

test("S2: wrong agent scope is denied", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => resolveViaLss(store, "KEY_B", { agent: "azazel", destination: "api.anthropic.com" }),
    (error) => error.code === "LSS_SCOPE_DENIED"
  );
});

test("S2b: missing key reports as scope denial, not a value-bearing error", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => resolveViaLss(store, "KEY_C", { agent: "azazel", destination: "api.kimi.com" }),
    (error) => error.code === "LSS_SCOPE_DENIED" && !error.message.includes(KEY_C_VALUE)
  );
});

test("S4: unsafe store perms are enforced before any secret is served", (t) => {
  // DEVIATION FROM THE REFERENCE ADAPTER, deliberate: the reference refuses to
  // open a 0644 store (LSS_STORE_UNSAFE). The openAGI SecretsStore instead
  // self-heals permissions to 0600 on load (see secrets-store.test.js
  // "snapshot, audit, projection, and secrets directory use private modes").
  // The S4 security property -- a loose store is never SERVED loose -- holds
  // either way; openAGI enforces it by repair rather than refusal.
  const { dataDir } = fixture(t);
  const snapshotPath = path.join(dataDir, "secrets", "secrets.json");
  fs.chmodSync(snapshotPath, 0o644);
  const handle = resolveViaLss(new SecretsStore({ dataDir, allowlist: ["KEY_A"], env: {} }), "KEY_A", {
    agent: "azazel",
    destination: "api.kimi.com"
  });
  assert.equal(handle.material, KEY_A_VALUE);
  const mode = fs.statSync(snapshotPath).mode & 0o777;
  assert.equal(mode, 0o600, "store must be repaired to 0600 before serving");
});

test("S5: install with failing probe stays unverified and resolve refuses it", async (t) => {
  const { store } = fixture(t);
  // KEY_C matches no provider preset, so probe cannot verify -> unverified.
  const installed = await lssInstall(store, "KEY_C", KEY_C_VALUE, {
    destinations: ["api.kimi.com"],
    scopes: ["agent:azazel"]
  });
  assert.equal(installed.verifiedStatus, "unverified");
  assert.throws(
    () => resolveViaLss(store, "KEY_C", { agent: "azazel", destination: "api.kimi.com" }),
    (error) => error.code === "LSS_UNVERIFIED"
  );
  // Explicit --unverified installs are recorded, not silently activated.
  const again = await lssInstall(store, "KEY_C", KEY_C_VALUE, {
    destinations: ["api.kimi.com"],
    verify: false
  });
  assert.equal(again.verifiedStatus, "unverified");
});

test("S6: rotate keeps old fingerprint in history and audits both", (t) => {
  const { dataDir, store } = fixture(t);
  const oldFp = secretFingerprint(KEY_A_VALUE);
  const rotated = lssRotate(store, "KEY_A", KEY_B_VALUE, { decidedBy: "test:rotate" });
  assert.equal(rotated.previousFingerprint, oldFp);
  assert.notEqual(rotated.fingerprint, oldFp);
  const meta = store.getSecretRecord("KEY_A");
  assert.ok(meta.history.some((entry) => entry.fingerprint === oldFp));
  assert.equal(meta.verifiedStatus, "unverified", "fresh rotation must re-earn ok");
  // Policy carried forward through the rotation.
  assert.throws(
    () => resolveViaLss(store, "KEY_A", { agent: "seraphim", destination: "api.kimi.com", requireVerified: false }),
    (error) => error.code === "LSS_SCOPE_DENIED"
  );
  const handle = resolveViaLss(store, "KEY_A", {
    agent: "azazel",
    destination: "api.kimi.com",
    requireVerified: false
  });
  assert.equal(handle.material, KEY_B_VALUE);
  const audit = readAudit(dataDir);
  assert.ok(!audit.includes(KEY_A_VALUE) && !audit.includes(KEY_B_VALUE));
});

test("S7: no code path returns secret material into errors or audit", (t) => {
  const { dataDir, store } = fixture(t);
  const attempts = [
    () => resolveViaLss(store, "KEY_A", { agent: "azazel", destination: "evil.com" }),
    () => resolveViaLss(store, "KEY_B", { agent: "azazel", destination: "api.anthropic.com" }),
    () => resolveViaLss(store, "MISSING", { agent: "azazel", destination: "api.kimi.com" })
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      assert.fail("expected denial");
    } catch (error) {
      for (const value of [KEY_A_VALUE, KEY_B_VALUE, KEY_C_VALUE]) {
        assert.ok(!String(error.message).includes(value), `error leaked material: ${error.message}`);
        assert.ok(!String(error.stack).includes(value), "stack leaked material");
      }
    }
  }
  const audit = readAudit(dataDir);
  for (const value of [KEY_A_VALUE, KEY_B_VALUE, KEY_C_VALUE]) {
    assert.ok(!audit.includes(value), "audit leaked material");
  }
});

test("wildcard suffix rule: matches subdomains, rejects lookalikes", () => {
  assert.ok(destinationMatches("api.kimi.com", "*.kimi.com"));
  assert.ok(destinationMatches("kimi.com", "*.kimi.com"));
  assert.ok(!destinationMatches("evil-kimi.com", "*.kimi.com"));
  assert.ok(!destinationMatches("kimi.com.evil.io", "*.kimi.com"));
  assert.ok(!destinationMatches("api.kimi.com.evil.io", "*.kimi.com"));
  assert.ok(destinationMatches("api.kimi.com", "api.kimi.com"));
  assert.ok(!destinationMatches("API.KIMI.COM.evil.io", "api.kimi.com"));
  assert.ok(destinationMatches("API.Kimi.COM", "api.kimi.com"), "case-insensitive");
  assert.ok(!destinationMatches("", "api.kimi.com"));
});

test("project scope intersects per SPEC §2", (t) => {
  const { store } = fixture(t);
  store.setSecret("KEY_C", KEY_C_VALUE, {
    decidedBy: "test",
    scopes: ["project:default"],
    destinations: ["api.kimi.com"]
  });
  const handle = resolveViaLss(store, "KEY_C", {
    agent: "anyone",
    project: "default",
    destination: "api.kimi.com",
    requireVerified: false
  });
  assert.equal(handle.material, KEY_C_VALUE);
  assert.throws(
    () => resolveViaLss(store, "KEY_C", {
      agent: "anyone",
      project: "other",
      destination: "api.kimi.com",
      requireVerified: false
    }),
    (error) => error.code === "LSS_SCOPE_DENIED"
  );
});

test("flag gate: lssEnabled is exact '1' only", () => {
  assert.ok(lssEnabled({ OPENAGI_LSS: "1" }));
  assert.ok(!lssEnabled({ OPENAGI_LSS: "true" }));
  assert.ok(!lssEnabled({}));
  assert.ok(!lssEnabled(undefined));
});

test("urlHost extracts lowercased host, survives garbage", () => {
  assert.equal(urlHost("https://API.Kimi.COM/v1"), "api.kimi.com");
  assert.equal(urlHost("not a url"), "");
  assert.equal(urlHost(""), "");
});

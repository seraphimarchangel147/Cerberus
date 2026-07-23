import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore } from "../src/secrets-store.js";
import { saveEnv, SETUP_FIELDS } from "../src/setup-wizard.js";

function fixture(t, {
  allowlist = ["ALPHA_SECRET", "SHORT_SECRET", "SECOND_SECRET"],
  env = {}
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SecretsStore({
    dataDir,
    allowlist,
    env,
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });
  return { dataDir, env, store };
}

test("setup allowlist includes every built-in runtime credential", () => {
  for (const name of [
    "DISCORD_BOT_TOKEN",
    "OPENAGI_COMPUTER_NODE_TOKEN",
    "OPENAGI_IMESSAGE_NODE_TOKEN",
    "OPENAGI_REMOTE_TOKEN"
  ]) {
    assert.ok(SETUP_FIELDS.includes(name), `missing setup credential: ${name}`);
  }
});

test("secrets round-trip across instances and lists reveal masked metadata only", (t) => {
  const { dataDir, env, store } = fixture(t);
  assert.equal(fs.existsSync(path.join(dataDir, "secrets")), false, "constructor is filesystem-lazy");

  const initialized = store.initialize({ decidedBy: "test:init" });
  assert.equal(initialized.migrated, true);
  assert.equal(initialized.count, 0);
  assert.deepEqual(
    store.listAllowedNames(),
    ["ALPHA_SECRET", "SECOND_SECRET", "SHORT_SECRET"]
  );

  const alpha = store.setSecret("ALPHA_SECRET", "alpha-super-secret", { decidedBy: "test:set" });
  const short = store.setSecret("SHORT_SECRET", "abc", { decidedBy: "test:set" });
  assert.deepEqual(alpha, { name: "ALPHA_SECRET", last4: "cret", preview: "****cret" });
  assert.deepEqual(short, { name: "SHORT_SECRET", last4: null, preview: "****" });
  assert.equal(env.ALPHA_SECRET, "alpha-super-secret");
  assert.equal(store.getSecret("ALPHA_SECRET", { decidedBy: "test:get" }), "alpha-super-secret");

  const listed = store.listSecrets({ decidedBy: "test:list" });
  const serialized = JSON.stringify(listed);
  assert.equal(listed.length, 2);
  assert.doesNotMatch(serialized, /alpha-super-secret/);
  assert.doesNotMatch(serialized, /"abc"/);
  assert.equal(listed.find((entry) => entry.name === "SHORT_SECRET").last4, null);

  const exported = store.exportEnv({
    names: ["ALPHA_SECRET", "SECOND_SECRET"],
    decidedBy: "test:subprocess"
  });
  assert.deepEqual(exported, { ALPHA_SECRET: "alpha-super-secret" });

  const second = new SecretsStore({
    dataDir,
    allowlist: ["ALPHA_SECRET", "SHORT_SECRET", "SECOND_SECRET"],
    env
  });
  second.setSecret("SECOND_SECRET", "second-value-2P9K", { decidedBy: "test:second" });
  assert.equal(
    store.getSecret("SECOND_SECRET", { decidedBy: "test:refresh" }),
    "second-value-2P9K",
    "each operation reloads the atomic snapshot"
  );

  assert.throws(
    () => store.setSecret("NOT_ALLOWED", "must-not-leak", { decidedBy: "test:reject" }),
    /Unknown secret name/
  );
  assert.equal(env.NOT_ALLOWED, undefined);
});

test("exclusive store operations reject async callbacks before invoking them", (t) => {
  const { store } = fixture(t);
  let invoked = false;
  assert.throws(
    () => store.withExclusiveLock(async () => {
      invoked = true;
    }),
    /must be synchronous/
  );
  assert.equal(invoked, false);
  assert.equal(
    store.withExclusiveLock(() => "synchronous-result"),
    "synchronous-result"
  );
});

test("audit JSONL records every operation without values or masked previews", (t) => {
  const { dataDir, store } = fixture(t, { allowlist: ["AUDIT_SECRET"] });
  store.initialize({ decidedBy: "test:init" });
  store.setSecret("AUDIT_SECRET", "audit-value-Q7X9", { decidedBy: "test:set" });
  assert.equal(store.getSecret("AUDIT_SECRET", { decidedBy: "test:get" }), "audit-value-Q7X9");
  store.listSecrets({ decidedBy: "test:list" });
  store.removeSecret("AUDIT_SECRET", { decidedBy: "test:remove" });
  assert.throws(
    () => store.setSecret("UNKNOWN_SECRET", "rejected-value-X1Y2", { decidedBy: "test:reject" }),
    /Unknown secret name/
  );

  const auditPath = path.join(dataDir, "secrets", "audit.jsonl");
  const raw = fs.readFileSync(auditPath, "utf8");
  assert.doesNotMatch(raw, /audit-value-Q7X9|Q7X9|rejected-value-X1Y2|X1Y2|\*{4}/);
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  for (const action of ["migrate", "initialize", "set", "access", "list", "remove"]) {
    assert.ok(events.some((event) => event.action === action), `missing ${action} audit event`);
  }
  assert.ok(events.every((event) => event.timestamp && event.decidedBy));
  assert.equal(
    events.find((event) => event.action === "set" && event.accepted === false)?.name,
    "UNKNOWN_SECRET"
  );
});

test("snapshot, audit, projection, and secrets directory use private modes", (t) => {
  const { dataDir, store } = fixture(t, { allowlist: ["MODE_SECRET"] });
  store.initialize({ decidedBy: "test:init" });
  store.setSecret("MODE_SECRET", "mode-value", { decidedBy: "test:set" });

  if (process.platform === "win32") return;
  const secretsDir = path.join(dataDir, "secrets");
  assert.equal(fs.statSync(secretsDir).mode & 0o777, 0o700);
  for (const file of [
    path.join(secretsDir, "secrets.json"),
    path.join(secretsDir, "audit.jsonl"),
    path.join(dataDir, ".env")
  ]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  }
});

test("cross-process secret mutations cannot lose or resurrect concurrent writes", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-race-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secretsDir = path.join(dataDir, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  const baseNames = Array.from(
    { length: 20_000 },
    (_, index) => `BASE_${String(index).padStart(5, "0")}`
  );
  const seeded = Object.fromEntries(
    baseNames.map((name, index) => [
      name,
      {
        value: `seed-${index}`,
        updatedAt: "2026-07-23T00:00:00.000Z"
      }
    ])
  );
  fs.writeFileSync(
    path.join(secretsDir, "secrets.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
      secrets: seeded
    }),
    { mode: 0o600 }
  );

  const barrier = path.join(dataDir, "start-race");
  const readyA = path.join(dataDir, "ready-a");
  const readyB = path.join(dataDir, "ready-b");
  const worker = (name, ready) => `
    import fs from "node:fs";
    import { SecretsStore } from ${JSON.stringify(new URL("../src/secrets-store.js", import.meta.url).href)};
    const names = Array.from({ length: 20000 }, (_, index) => "BASE_" + String(index).padStart(5, "0"));
    names.push("RACE_A", "RACE_B");
    const store = new SecretsStore({
      dataDir: ${JSON.stringify(dataDir)},
      allowlist: names,
      env: {}
    });
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!fs.existsSync(${JSON.stringify(barrier)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    store.setSecret(${JSON.stringify(name)}, ${JSON.stringify(`value-${name}`)}, {
      decidedBy: ${JSON.stringify(`test:${name}`)}
    });
  `;
  const runWorker = (name, ready) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker(name, ready)], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`secret race worker exited ${code}: ${stderr}`));
    });
  });

  const first = runWorker("RACE_A", readyA);
  const second = runWorker("RACE_B", readyB);
  const readyDeadline = Date.now() + 10_000;
  while (!fs.existsSync(readyA) || !fs.existsSync(readyB)) {
    if (Date.now() >= readyDeadline) throw new Error("secret race workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier, "go");
  await Promise.all([first, second]);

  const finalSnapshot = JSON.parse(
    fs.readFileSync(path.join(secretsDir, "secrets.json"), "utf8")
  );
  assert.equal(finalSnapshot.secrets.RACE_A.value, "value-RACE_A");
  assert.equal(finalSnapshot.secrets.RACE_B.value, "value-RACE_B");
  assert.equal(
    fs.existsSync(path.join(secretsDir, ".mutation.lock")),
    false,
    "successful writers release the mutation lock"
  );
});

test("legacy migration is one-time and stale env edits cannot override the snapshot", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-secrets-migrate-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dataDir, ".env"),
    [
      "# hand-maintained",
      "CUSTOM_LEGACY=keep-this",
      "LEGACY_SECRET=legacy-value",
      ""
    ].join("\n"),
    "utf8"
  );
  const env = {
    LEGACY_SECRET: "loaded-legacy",
    EXTERNAL_ONLY_SECRET: "deployment-value"
  };
  const allowlist = ["LEGACY_SECRET", "NEW_SECRET", "EXTERNAL_ONLY_SECRET"];
  const store = new SecretsStore({ dataDir, allowlist, env });
  const initialized = store.initialize({ decidedBy: "test:migrate" });
  assert.equal(initialized.migrated, true);
  assert.equal(store.getSecret("LEGACY_SECRET", { decidedBy: "test:get" }), "legacy-value");
  assert.equal(env.LEGACY_SECRET, "legacy-value");
  assert.equal(
    env.EXTERNAL_ONLY_SECRET,
    "deployment-value",
    "deployment-only env values survive when they are not in the projection"
  );

  let projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(projection, /# hand-maintained/);
  assert.match(projection, /CUSTOM_LEGACY=keep-this/);
  assert.match(projection, /LEGACY_SECRET=legacy-value/);
  assert.equal((projection.match(/LEGACY_SECRET=/g) ?? []).length, 1);

  store.setSecret("NEW_SECRET", "new-source-value", { decidedBy: "test:set" });
  store.removeSecret("LEGACY_SECRET", { decidedBy: "test:remove" });
  fs.appendFileSync(path.join(dataDir, ".env"), "LEGACY_SECRET=hand-edited-stale\n", "utf8");
  env.LEGACY_SECRET = "hand-edited-stale";

  const reloaded = new SecretsStore({ dataDir, allowlist, env });
  const secondInit = reloaded.initialize({ decidedBy: "test:reload" });
  assert.equal(secondInit.migrated, false);
  assert.equal(reloaded.getSecret("LEGACY_SECRET", { decidedBy: "test:missing" }), null);
  assert.equal(reloaded.getSecret("NEW_SECRET", { decidedBy: "test:get" }), "new-source-value");
  assert.equal(env.LEGACY_SECRET, undefined);
  projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.doesNotMatch(projection, /LEGACY_SECRET=/);
  assert.match(projection, /CUSTOM_LEGACY=keep-this/);
  assert.match(projection, /NEW_SECRET=new-source-value/);
});

test("corrupt snapshot errors never reflect malformed secret bytes", (t) => {
  const { dataDir, store } = fixture(t, { allowlist: ["CORRUPT_SECRET"] });
  const canary = "corrupt-secret-must-not-cross-boundaries";
  fs.mkdirSync(path.join(dataDir, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "secrets", "secrets.json"),
    `{"secrets":{"CORRUPT_SECRET":{"value":"${canary}"}}\n`,
    "utf8"
  );

  assert.throws(
    () => store.listSecrets({ decidedBy: "test:corrupt" }),
    (error) => {
      assert.match(error.message, /could not be read safely/);
      assert.doesNotMatch(error.message, new RegExp(canary));
      return true;
    }
  );
});

test("saveEnv migrates through SecretsStore while preserving its public contract", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-save-secrets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const previousAuth = process.env.OPENAGI_AUTH_TOKEN;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousAuth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = previousAuth;
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
  });

  fs.writeFileSync(
    path.join(dataDir, ".env"),
    "CUSTOM_LEGACY=preserved\nOPENAI_API_KEY=legacy-openai\n",
    "utf8"
  );
  const result = saveEnv({
    dataDir,
    values: {
      OPENAGI_AUTH_TOKEN: "new-auth-token",
      OPENAI_API_KEY: "",
      MALICIOUS_KEY: "ignored"
    },
    decidedBy: "test:wizard"
  });
  assert.equal(result.written, path.join(dataDir, ".env"));
  assert.deepEqual(result.keys, ["OPENAGI_AUTH_TOKEN"]);
  assert.equal(result.totalKeys, 3);
  assert.equal(process.env.OPENAGI_AUTH_TOKEN, "new-auth-token");

  let projection = fs.readFileSync(result.written, "utf8");
  assert.match(projection, /CUSTOM_LEGACY=preserved/);
  assert.match(projection, /OPENAI_API_KEY=legacy-openai/);
  assert.match(projection, /OPENAGI_AUTH_TOKEN=new-auth-token/);
  assert.doesNotMatch(projection, /MALICIOUS_KEY/);

  const store = new SecretsStore({ dataDir, allowlist: SETUP_FIELDS, env: {} });
  assert.equal(store.getSecret("OPENAI_API_KEY", { decidedBy: "test:verify" }), "legacy-openai");
  assert.equal(store.getSecret("OPENAGI_AUTH_TOKEN", { decidedBy: "test:verify" }), "new-auth-token");

  saveEnv({
    dataDir,
    values: {},
    clear: ["OPENAI_API_KEY", "NOT_ALLOWLISTED"],
    decidedBy: "test:clear"
  });
  projection = fs.readFileSync(result.written, "utf8");
  assert.doesNotMatch(projection, /OPENAI_API_KEY=/);
  assert.match(projection, /CUSTOM_LEGACY=preserved/);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
});

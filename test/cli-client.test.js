// CLI client: target resolution precedence, node pairing config, request
// auth, and the doctor diagnostic ladder (with a stubbed daemon).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveTarget, normalizeBase, CliClient, runDoctor,
  writeNodeConfig, readNodeConfig, clearNodeConfig
} from "../src/cli-client.js";

const cleanEnv = (t) => {
  const saved = { r: process.env.OPENAGI_REMOTE, rt: process.env.OPENAGI_REMOTE_TOKEN, a: process.env.OPENAGI_AUTH_TOKEN, p: process.env.PORT };
  delete process.env.OPENAGI_REMOTE; delete process.env.OPENAGI_REMOTE_TOKEN; delete process.env.OPENAGI_AUTH_TOKEN; delete process.env.PORT;
  t.after(() => {
    for (const [k, v] of [["OPENAGI_REMOTE", saved.r], ["OPENAGI_REMOTE_TOKEN", saved.rt], ["OPENAGI_AUTH_TOKEN", saved.a], ["PORT", saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
};

const tolerateWindowsReadHandleFsync = (t) => {
  if (process.platform !== "win32") return;
  const original = fs.fsyncSync;
  fs.fsyncSync = () => {};
  t.after(() => { fs.fsyncSync = original; });
};

test("normalizeBase fills scheme + daemon port", () => {
  assert.equal(normalizeBase("distiller.local"), "http://distiller.local:43210");
  assert.equal(normalizeBase("distiller.local:8080"), "http://distiller.local:8080");
  assert.equal(normalizeBase("http://x:43210"), "http://x:43210");
  assert.equal(normalizeBase("https://main.example.com"), "https://main.example.com");
});

test("resolveTarget precedence: flag > env > node.json > local", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-"));

  // local default when nothing is set
  let tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "local");
  assert.equal(tgt.url, "http://127.0.0.1:43210");
  assert.equal(tgt.remote, false);

  // node.json pairing
  const pairedToken = "paired-token-canary";
  const nodeFile = writeNodeConfig({
    remote: "http://distiller.local:43210",
    token: pairedToken
  }, dir);
  assert.doesNotMatch(fs.readFileSync(nodeFile, "utf8"), new RegExp(pairedToken));
  // A fresh CLI process has not preloaded .env; target resolution must read
  // the authoritative snapshot rather than depending on process.env.
  delete process.env.OPENAGI_REMOTE_TOKEN;
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "node.json");
  assert.equal(tgt.url, "http://distiller.local:43210");
  assert.equal(tgt.token, pairedToken);
  assert.equal(tgt.remote, true);

  // env beats node.json
  process.env.OPENAGI_REMOTE = "main.example.com:9000";
  process.env.OPENAGI_REMOTE_TOKEN = "env-tok";
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "env");
  assert.equal(tgt.url, "http://main.example.com:9000");
  assert.equal(tgt.token, "env-tok");

  // flag beats everything
  tgt = resolveTarget({ remote: "10.0.0.5", token: "flag-tok", dataDir: dir });
  assert.equal(tgt.source, "flag");
  assert.equal(tgt.url, "http://10.0.0.5:43210");
  assert.equal(tgt.token, "flag-tok");

  fs.rmSync(dir, { recursive: true });
});

test("node config persists only remote metadata and clears its stored pairing token", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node2-"));
  const canary = "node-pair-secret-canary-Q7X9";
  const file = writeNodeConfig({ remote: "http://x:43210", token: canary }, dir);
  if (process.platform !== "win32") {
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    remote: "http://x:43210"
  });
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(canary));

  const snapshotPath = path.join(dir, "secrets", "secrets.json");
  const projectionPath = path.join(dir, ".env");
  let snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.secrets.OPENAGI_REMOTE_TOKEN.value, canary);
  assert.match(fs.readFileSync(projectionPath, "utf8"), new RegExp(`OPENAGI_REMOTE_TOKEN=${canary}`));

  delete process.env.OPENAGI_REMOTE_TOKEN;
  assert.deepEqual(readNodeConfig(dir), {
    remote: "http://x:43210",
    token: canary
  });

  assert.equal(clearNodeConfig(dir), true);
  assert.equal(readNodeConfig(dir), null);
  assert.equal(process.env.OPENAGI_REMOTE_TOKEN, undefined);
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.secrets.OPENAGI_REMOTE_TOKEN, undefined);
  assert.doesNotMatch(fs.readFileSync(projectionPath, "utf8"), /OPENAGI_REMOTE_TOKEN=/);

  // A no-op unpair does not erase an independently supplied env credential.
  process.env.OPENAGI_REMOTE_TOKEN = "independent-env-token";
  assert.equal(clearNodeConfig(dir), false);
  assert.equal(process.env.OPENAGI_REMOTE_TOKEN, "independent-env-token");
  fs.rmSync(dir, { recursive: true });
});

test("node pairing metadata strips URL-embedded credentials and query secrets", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-url-secret-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeNodeConfig({
    remote: "https://url-user:url-password@example.com/private?token=query-secret",
    token: "pair-token"
  }, dir);
  const raw = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(raw), {
    remote: "https://example.com"
  });
  assert.doesNotMatch(raw, /url-user|url-password|query-secret/);
});

test("resolveTarget lazily migrates a legacy raw node token without losing auth", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-legacy-"));
  const file = path.join(dir, "node.json");
  const canary = "legacy-node-token-canary-A1B2";
  fs.writeFileSync(file, JSON.stringify({
    remote: "https://legacy-main.example.com",
    token: canary
  }, null, 2), { mode: 0o600 });

  let target = resolveTarget({ dataDir: dir });
  assert.equal(target.source, "node.json");
  assert.equal(target.url, "https://legacy-main.example.com");
  assert.equal(target.token, canary);

  const migratedNodeText = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(migratedNodeText), {
    remote: "https://legacy-main.example.com"
  });
  assert.doesNotMatch(migratedNodeText, new RegExp(canary));
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, "secrets", "secrets.json"), "utf8")
  );
  assert.equal(snapshot.secrets.OPENAGI_REMOTE_TOKEN.value, canary);
  assert.match(
    fs.readFileSync(path.join(dir, ".env"), "utf8"),
    new RegExp(`OPENAGI_REMOTE_TOKEN=${canary}`)
  );

  delete process.env.OPENAGI_REMOTE_TOKEN;
  target = resolveTarget({ dataDir: dir });
  assert.equal(target.token, canary, "a new CLI process resolves the migrated store value");

  fs.rmSync(dir, { recursive: true });
});

test("a saved pairing token is never sent to an explicit or env-selected remote", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-token-scope-"));
  const pairedToken = "paired-main-only-canary";
  writeNodeConfig({
    remote: "https://trusted-main.example",
    token: pairedToken
  }, dir);
  assert.equal(
    process.env.OPENAGI_REMOTE_TOKEN,
    undefined,
    "persisting a pairing does not promote its scoped token to ambient env"
  );

  let target = resolveTarget({
    remote: "https://attacker.example",
    dataDir: dir
  });
  assert.equal(target.url, "https://attacker.example");
  assert.equal(target.token, null);

  process.env.OPENAGI_REMOTE = "https://env-selected.example";
  target = resolveTarget({ dataDir: dir });
  assert.equal(target.url, "https://env-selected.example");
  assert.equal(target.token, null);

  target = resolveTarget({
    remote: "https://explicit.example",
    token: "explicit-token",
    dataDir: dir
  });
  assert.equal(target.token, "explicit-token");

  delete process.env.OPENAGI_REMOTE;
  target = resolveTarget({ dataDir: dir });
  assert.equal(target.url, "https://trusted-main.example");
  assert.equal(target.token, pairedToken);
  fs.rmSync(dir, { recursive: true });
});

test("the authoritative store wins over a stale raw legacy node token", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-token-authority-"));
  const file = writeNodeConfig({
    remote: "https://trusted-main.example",
    token: "new-authoritative-token"
  }, dir);
  fs.writeFileSync(file, JSON.stringify({
    remote: "https://trusted-main.example",
    token: "old-revoked-token"
  }, null, 2), { mode: 0o600 });
  delete process.env.OPENAGI_REMOTE_TOKEN;

  const target = resolveTarget({ dataDir: dir });
  assert.equal(target.token, "new-authoritative-token");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    remote: "https://trusted-main.example"
  });
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, "secrets", "secrets.json"), "utf8")
  );
  assert.equal(
    snapshot.secrets.OPENAGI_REMOTE_TOKEN.value,
    "new-authoritative-token"
  );
  assert.deepEqual(readNodeConfig(dir), {
    remote: "https://trusted-main.example",
    token: "new-authoritative-token"
  });
  fs.rmSync(dir, { recursive: true });
});

test("an existing snapshot with no pairing token keeps a legacy token revoked", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-token-revoked-"));
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "secrets", "secrets.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
      secrets: {}
    }),
    "utf8"
  );
  const file = path.join(dir, "node.json");
  fs.writeFileSync(file, JSON.stringify({
    remote: "https://trusted-main.example",
    token: "revoked-legacy-token"
  }, null, 2), { mode: 0o600 });

  const target = resolveTarget({ dataDir: dir });
  assert.equal(target.token, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    remote: "https://trusted-main.example"
  });
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, "secrets", "secrets.json"), "utf8")
  );
  assert.equal(snapshot.secrets.OPENAGI_REMOTE_TOKEN, undefined);
  fs.rmSync(dir, { recursive: true });
});

test("concurrent node pairing writes never expose a mixed remote and token", async (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-pair-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const barrier = path.join(dir, "start-pair-race");
  const readyA = path.join(dir, "ready-a");
  const readyB = path.join(dir, "ready-b");
  const cliClientUrl = new URL("../src/cli-client.js", import.meta.url).href;
  const pairings = [
    {
      remote: "https://pair-a.example",
      token: "pair-a-token-canary",
      ready: readyA
    },
    {
      remote: "https://pair-b.example",
      token: "pair-b-token-canary",
      ready: readyB
    }
  ];
  const worker = ({ remote, token, ready }) => `
    import fs from "node:fs";
    import { writeNodeConfig } from ${JSON.stringify(cliClientUrl)};
    fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    while (!fs.existsSync(${JSON.stringify(barrier)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeNodeConfig({
      remote: ${JSON.stringify(remote)},
      token: ${JSON.stringify(token)}
    }, ${JSON.stringify(dir)});
  `;
  const childEnv = { ...process.env };
  delete childEnv.OPENAGI_REMOTE;
  delete childEnv.OPENAGI_REMOTE_TOKEN;
  const runWorker = (pairing) => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", worker(pairing)],
      {
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`node pairing worker exited ${code}: ${stderr}`));
    });
  });

  const workers = pairings.map(runWorker);
  const readyDeadline = Date.now() + 10_000;
  while (!fs.existsSync(readyA) || !fs.existsSync(readyB)) {
    if (Date.now() >= readyDeadline) throw new Error("node pairing workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier, "go");
  await Promise.all(workers);

  delete process.env.OPENAGI_REMOTE_TOKEN;
  const paired = readNodeConfig(dir);
  assert.ok(
    pairings.some(({ remote, token }) => (
      paired?.remote === remote && paired?.token === token
    )),
    `observed mixed pairing: ${JSON.stringify(paired)}`
  );
  assert.deepEqual(JSON.parse(
    fs.readFileSync(path.join(dir, "node.json"), "utf8")
  ), {
    remote: paired.remote
  });
});

test("an abrupt exit while publishing node metadata leaves the old remote credentialless", async (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-pair-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldRemote = "https://old-main.example";
  const oldToken = "old-pair-token-canary";
  const newRemote = "https://new-main.example";
  const newToken = "new-pair-token-canary";
  writeNodeConfig({ remote: oldRemote, token: oldToken }, dir);

  const cliClientUrl = new URL("../src/cli-client.js", import.meta.url).href;
  const nodeFile = path.resolve(dir, "node.json");
  const worker = `
    import fs from "node:fs";
    import path from "node:path";
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.resolve(destination) === ${JSON.stringify(nodeFile)}) {
        process.exit(77);
      }
      return originalRename(source, destination);
    };
    const { writeNodeConfig } = await import(${JSON.stringify(cliClientUrl)});
    writeNodeConfig({
      remote: ${JSON.stringify(newRemote)},
      token: ${JSON.stringify(newToken)}
    }, ${JSON.stringify(dir)});
  `;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", worker],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === null) reject(new Error(`pairing crash worker had no exit code: ${stderr}`));
      else resolve(code);
    });
  });
  assert.equal(exitCode, 77, "worker exits at the metadata publication boundary");

  // The abrupt exit intentionally bypasses finally. Removing its orphaned
  // lock simulates stale-lock recovery without waiting for the production
  // timeout.
  fs.rmSync(path.join(dir, "secrets", ".mutation.lock"), { force: true });
  delete process.env.OPENAGI_REMOTE_TOKEN;
  assert.deepEqual(JSON.parse(fs.readFileSync(nodeFile, "utf8")), {
    remote: oldRemote
  });
  assert.deepEqual(readNodeConfig(dir), {
    remote: oldRemote,
    token: null
  });
  const persisted = [
    fs.readFileSync(path.join(dir, "secrets", "secrets.json"), "utf8"),
    fs.readFileSync(path.join(dir, ".env"), "utf8")
  ].join("\n");
  assert.doesNotMatch(persisted, new RegExp(newToken));
});

test("a post-commit projection failure cannot bind a new token to old metadata", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-pair-projection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldRemote = "https://projection-old.example";
  const oldToken = "projection-old-token";
  const newToken = "projection-new-token";
  writeNodeConfig({ remote: oldRemote, token: oldToken }, dir);

  const originalRename = fs.renameSync;
  const projectionPath = path.resolve(dir, ".env");
  let projectionRenames = 0;
  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === projectionPath) {
      projectionRenames += 1;
      if (projectionRenames === 2) {
        const error = new Error("injected projection failure");
        error.code = "EIO";
        throw error;
      }
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.renameSync = originalRename; });

  assert.throws(
    () => writeNodeConfig({
      remote: "https://projection-new.example",
      token: newToken
    }, dir),
    /could not be persisted safely/
  );
  delete process.env.OPENAGI_REMOTE_TOKEN;
  assert.deepEqual(readNodeConfig(dir), {
    remote: oldRemote,
    token: oldToken
  });
  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, ".env"), "utf8"),
    new RegExp(newToken)
  );
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith(".env.") && name.endsWith(".tmp")),
    false,
    "failed atomic projections do not retain secret-bearing temp files"
  );
});

test("a corrupt authoritative store aborts tokenless pairing without changing metadata", (t) => {
  cleanEnv(t);
  tolerateWindowsReadHandleFsync(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-pair-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodeFile = path.join(dir, "node.json");
  const original = `${JSON.stringify({
    remote: "https://original-main.example"
  }, null, 2)}\n`;
  fs.writeFileSync(nodeFile, original, { mode: 0o600 });
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  const canary = "corrupt-pairing-secret-canary";
  fs.writeFileSync(
    path.join(dir, "secrets", "secrets.json"),
    `{"secrets":{"OPENAGI_REMOTE_TOKEN":{"value":"${canary}"}}\n`,
    { mode: 0o600 }
  );

  assert.throws(
    () => writeNodeConfig({
      remote: "https://replacement-main.example",
      token: null
    }, dir),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(canary));
      return true;
    }
  );
  assert.equal(fs.readFileSync(nodeFile, "utf8"), original);
});

test("CliClient attaches the bearer token", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, text: async () => "{}" }; };
  const client = new CliClient({ url: "http://main:43210", token: "secret", remote: true, source: "flag" }, { fetchImpl });
  await client.chat("hi");
  assert.equal(seen[0].url, "http://main:43210/message");
  assert.equal(seen[0].opts.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { text: "hi", from: "cli" });
});

function stubClient(responses) {
  return {
    target: { url: "http://main:43210", remote: true, source: "flag", token: "t" },
    health: async () => responses.health,
    integrations: async () => responses.integrations ?? { ok: false, status: 401 }
  };
}

test("doctor: unreachable daemon stops early with a fix", async () => {
  const r = await runDoctor(stubClient({ health: { ok: false, status: 0, error: "ECONNREFUSED" } }));
  assert.equal(r.ok, false);
  const daemon = r.checks.find((c) => c.name === "daemon");
  assert.equal(daemon.ok, false);
  assert.match(daemon.detail, /unreachable/);
  assert.match(daemon.fix, /HOST=0.0.0.0/);
  assert.ok(!r.checks.some((c) => c.name === "model"), "no further checks when daemon is down");
});

test("doctor: 401 names the token problem", async () => {
  const r = await runDoctor(stubClient({ health: { ok: false, status: 401 } }));
  const daemon = r.checks.find((c) => c.name === "daemon");
  assert.match(daemon.detail, /401/);
  assert.match(daemon.fix, /token/i);
});

test("doctor: healthy but first-run + deterministic + no sources", async () => {
  const r = await runDoctor(stubClient({
    health: { ok: true, status: 200, json: { firstRun: true, status: { agentHost: { providerConfigured: true, provider: "DeterministicModelProvider" } } } },
    integrations: { ok: true, json: { integrations: [{ id: "linear", name: "Linear", paths: [{ kind: "api", configured: false }] }] } }
  }));
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "setup").ok, false);
  const model = r.checks.find((c) => c.name === "model");
  assert.equal(model.ok, false, "deterministic provider is not a real model");
  assert.match(model.detail, /deterministic/i);
  assert.equal(r.checks.find((c) => c.name === "task-sources").ok, false);
});

test("doctor: fully configured main passes", async () => {
  const r = await runDoctor(stubClient({
    health: { ok: true, status: 200, json: { firstRun: false, status: { agentHost: { providerConfigured: true, provider: "OpenAIResponsesProvider" } } } },
    integrations: { ok: true, json: { integrations: [{ id: "buildbetter", name: "BuildBetter", paths: [{ kind: "api", configured: true }] }] } }
  }));
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.ok));
});

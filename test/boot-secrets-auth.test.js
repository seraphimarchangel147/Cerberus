import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../src/boot.js";
import { _resetDataDirCache } from "../src/data-dir.js";

test("remote bind rejects a stale env token absent from the secrets snapshot", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-boot-secrets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "secrets", "secrets.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
      secrets: {}
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, ".env"),
    "OPENAGI_AUTH_TOKEN=stale-token-must-not-authorize-bind\n",
    "utf8"
  );

  const saved = {
    dataDir: process.env.OPENAGI_DATA_DIR,
    auth: process.env.OPENAGI_AUTH_TOKEN,
    unsafe: process.env.OPENAGI_UNSAFE_BIND
  };
  process.env.OPENAGI_DATA_DIR = dataDir;
  delete process.env.OPENAGI_AUTH_TOKEN;
  delete process.env.OPENAGI_UNSAFE_BIND;
  t.after(() => {
    if (saved.dataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = saved.dataDir;
    if (saved.auth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = saved.auth;
    if (saved.unsafe === undefined) delete process.env.OPENAGI_UNSAFE_BIND;
    else process.env.OPENAGI_UNSAFE_BIND = saved.unsafe;
    _resetDataDirCache();
  });

  await assert.rejects(
    startServer({ host: "0.0.0.0", port: 0 }),
    /Refusing to bind 0\.0\.0\.0 without OPENAGI_AUTH_TOKEN/
  );
  assert.equal(process.env.OPENAGI_AUTH_TOKEN, undefined);
  assert.doesNotMatch(
    fs.readFileSync(path.join(dataDir, ".env"), "utf8"),
    /stale-token-must-not-authorize-bind/
  );
});

test("remote bind rejects a removed auth token loaded only from the cwd env", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-boot-cwd-secrets-"));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-boot-cwd-"));
  fs.mkdirSync(path.join(dataDir, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "secrets", "secrets.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-07-23T00:00:00.000Z",
      secrets: {}
    }),
    "utf8"
  );
  const canary = "cwd-token-must-not-be-resurrected";
  fs.writeFileSync(
    path.join(cwdDir, ".env"),
    `OPENAGI_AUTH_TOKEN=${canary}\n`,
    "utf8"
  );

  const originalCwd = process.cwd();
  const saved = {
    dataDir: process.env.OPENAGI_DATA_DIR,
    auth: process.env.OPENAGI_AUTH_TOKEN,
    unsafe: process.env.OPENAGI_UNSAFE_BIND
  };
  process.chdir(cwdDir);
  process.env.OPENAGI_DATA_DIR = dataDir;
  delete process.env.OPENAGI_AUTH_TOKEN;
  delete process.env.OPENAGI_UNSAFE_BIND;
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
    if (saved.dataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = saved.dataDir;
    if (saved.auth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = saved.auth;
    if (saved.unsafe === undefined) delete process.env.OPENAGI_UNSAFE_BIND;
    else process.env.OPENAGI_UNSAFE_BIND = saved.unsafe;
    _resetDataDirCache();
  });

  await assert.rejects(
    startServer({ host: "0.0.0.0", port: 0 }),
    /Refusing to bind 0\.0\.0\.0 without OPENAGI_AUTH_TOKEN/
  );
  assert.equal(process.env.OPENAGI_AUTH_TOKEN, undefined);
  assert.doesNotMatch(
    fs.readFileSync(path.join(dataDir, ".env"), "utf8"),
    new RegExp(canary)
  );
});

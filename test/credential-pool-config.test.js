import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore } from "../src/secrets-store.js";
import { saveEnv, SETUP_FIELDS } from "../src/setup-wizard.js";

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-credential-pool-config-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("credential-pool JSON is accepted only through the setup allowlist", (t) => {
  const dataDir = makeDataDir(t);
  const name = "OPENAGI_CREDENTIAL_POOLS";
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  assert.ok(SETUP_FIELDS.includes(name));

  const value = JSON.stringify({
    version: 1,
    providers: {
      anthropic: {
        strategy: "round_robin",
        credentials: [
          {
            id: "primary",
            type: "api_key",
            secretName: "ANTHROPIC_API_KEY"
          }
        ]
      }
    }
  });
  const saved = saveEnv({
    dataDir,
    values: {
      [name]: value,
      OPENAGI_CREDENTIAL_POOLS_UNSAFE: "ignored"
    },
    decidedBy: "test:credential-pool-config"
  });

  assert.deepEqual(saved.keys, [name]);
  assert.equal(process.env[name], value);
  const projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(projection, /^OPENAGI_CREDENTIAL_POOLS=/m);
  assert.doesNotMatch(projection, /OPENAGI_CREDENTIAL_POOLS_UNSAFE/);

  const store = new SecretsStore({ dataDir, allowlist: SETUP_FIELDS, env: {} });
  assert.equal(
    store.getSecret(name, { decidedBy: "test:credential-pool-config:verify" }),
    value
  );
});

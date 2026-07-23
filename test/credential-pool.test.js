import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import util from "node:util";
import {
  CREDENTIAL_BILLING_COOLDOWN_MS,
  CredentialPool,
  CredentialPoolExhaustedError,
  classifyCredentialFailure,
  createCredentialPoolRegistry,
  loadCredentialPoolConfig
} from "../src/credential-pool.js";

function pool({
  strategy = "round_robin",
  credentials = [
    { id: "first", secretName: "POOL_KEY_ONE" },
    { id: "second", secretName: "POOL_KEY_TWO" }
  ],
  env = {
    POOL_KEY_ONE: "raw-secret-one",
    POOL_KEY_TWO: "raw-secret-two"
  },
  ...options
} = {}) {
  return new CredentialPool({
    provider: "anthropic",
    strategy,
    credentials,
    env,
    ...options
  });
}

function providerError(status, message, body = undefined) {
  return Object.assign(new Error(message), { status, body });
}

test("round_robin, least_used, fill_first, and random select as configured", () => {
  const roundRobin = pool();
  assert.deepEqual(
    [roundRobin.acquire().id, roundRobin.acquire().id, roundRobin.acquire().id],
    ["first", "second", "first"]
  );

  const leastUsed = pool({ strategy: "least_used" });
  assert.deepEqual(
    [leastUsed.acquire().id, leastUsed.acquire().id, leastUsed.acquire().id],
    ["first", "second", "first"]
  );

  const fillFirst = pool({ strategy: "fill_first" });
  assert.deepEqual(
    [fillFirst.acquire().id, fillFirst.acquire().id],
    ["first", "first"]
  );

  const random = pool({ strategy: "random", random: () => 0.999 });
  assert.equal(random.acquire().id, "second");
});

test("plan or usage-limit 429 rotates immediately without retrying the key", async () => {
  const events = [];
  const calls = [];
  const credentialPool = pool({ onEvent: (event) => events.push(event) });
  const result = await credentialPool.execute(async (lease) => {
    calls.push(lease.id);
    if (lease.id === "first") throw providerError(429, "Your usage limit has been reached");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "credential_rotation",
    provider: "anthropic",
    fromId: "first",
    toId: "second",
    reason: "usage_limit",
    promptCacheReset: true,
    pricingImpact: "full-price"
  });
});

test("generic 429 retries the same key once and then rotates", async () => {
  const calls = [];
  const credentialPool = pool();
  const result = await credentialPool.execute(async (lease) => {
    calls.push(lease.id);
    if (lease.id === "first") throw providerError(429, "temporarily rate limited");
    return lease.value;
  });

  assert.equal(result, "raw-secret-two");
  assert.deepEqual(calls, ["first", "first", "second"]);
});

test("402 puts a credential on a 24-hour cooldown across request sessions", async () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const calls = [];
  const credentialPool = pool({ strategy: "fill_first", now: () => clock });

  await credentialPool.execute(async (lease) => {
    calls.push(lease.id);
    if (lease.id === "first") throw providerError(402, "billing required");
    return "rotated";
  });
  assert.deepEqual(calls, ["first", "second"]);

  const cooled = credentialPool.snapshot().credentials[0];
  assert.equal(cooled.available, false);
  assert.equal(
    cooled.cooldownUntil,
    new Date(clock + CREDENTIAL_BILLING_COOLDOWN_MS).toISOString()
  );

  assert.equal((await credentialPool.execute(async (lease) => lease.id)), "second");
  clock += CREDENTIAL_BILLING_COOLDOWN_MS - 1;
  assert.equal((await credentialPool.execute(async (lease) => lease.id)), "second");
  clock += 1;
  assert.equal((await credentialPool.execute(async (lease) => lease.id)), "first");
});

test("OAuth 401 refresh success retries with the refreshed access token", async () => {
  const seen = [];
  const refreshes = [];
  const credentialPool = pool({
    credentials: [{
      id: "oauth-primary",
      type: "oauth",
      secretName: "OAUTH_ACCESS",
      refreshTokenSecretName: "OAUTH_REFRESH"
    }],
    env: {
      OAUTH_ACCESS: "expired-access-secret",
      OAUTH_REFRESH: "refresh-secret"
    },
    refreshOAuth: async (details) => {
      refreshes.push({
        provider: details.provider,
        id: details.id,
        credential: details.credential,
        refreshToken: details.refreshToken
      });
      return { accessToken: "fresh-access-secret" };
    }
  });

  const result = await credentialPool.execute(async (lease) => {
    seen.push(lease.value);
    if (lease.value === "expired-access-secret") throw providerError(401, "token expired");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(seen, ["expired-access-secret", "fresh-access-secret"]);
  assert.deepEqual(refreshes, [{
    provider: "anthropic",
    id: "oauth-primary",
    credential: "expired-access-secret",
    refreshToken: "refresh-secret"
  }]);
});

test("OAuth refresh keeps the same lease when a round-robin backup also exists", async () => {
  const seen = [];
  const credentialPool = pool({
    credentials: [
      { id: "oauth-primary", type: "oauth", secretName: "OAUTH_ACCESS" },
      { id: "backup", type: "api_key", secretName: "BACKUP_KEY" }
    ],
    env: {
      OAUTH_ACCESS: "expired-access-secret",
      BACKUP_KEY: "backup-secret"
    },
    refreshOAuth: async () => ({ accessToken: "fresh-access-secret" })
  });

  const result = await credentialPool.execute(async (lease) => {
    seen.push({ id: lease.id, value: lease.value });
    if (lease.value === "expired-access-secret") throw providerError(401, "token expired");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(seen, [
    { id: "oauth-primary", value: "expired-access-secret" },
    { id: "oauth-primary", value: "fresh-access-secret" }
  ]);
});

test("OAuth 401 refresh failure blocks that key and rotates", async () => {
  const calls = [];
  let refreshCount = 0;
  const credentialPool = pool({
    credentials: [
      { id: "oauth-primary", type: "oauth", secretName: "OAUTH_ACCESS" },
      { id: "backup", type: "api_key", secretName: "BACKUP_KEY" }
    ],
    env: {
      OAUTH_ACCESS: "expired-access-secret",
      BACKUP_KEY: "backup-secret"
    },
    refreshOAuth: async () => {
      refreshCount += 1;
      throw new Error("refresh transport failed with reflected expired-access-secret");
    }
  });

  const result = await credentialPool.execute(async (lease) => {
    calls.push(lease.id);
    if (lease.id === "oauth-primary") throw providerError(401, "expired");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(refreshCount, 1);
  assert.deepEqual(calls, ["oauth-primary", "backup"]);
  assert.equal(
    credentialPool.snapshot().credentials.find((entry) => entry.id === "oauth-primary").blockedReason,
    "auth"
  );
});

test("exhaustion invokes fallback exactly once with a typed, redacted signal", async () => {
  const calls = [];
  const fallbacks = [];
  const credentialPool = pool();
  const result = await credentialPool.execute(
    async (lease) => {
      calls.push(lease.id);
      throw providerError(429, `usage limit reached for ${lease.value}`);
    },
    {
      fallback: (error) => {
        fallbacks.push(error);
        return "provider-fallback";
      }
    }
  );

  assert.equal(result, "provider-fallback");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(fallbacks.length, 1);
  assert.ok(fallbacks[0] instanceof CredentialPoolExhaustedError);
  assert.equal(fallbacks[0].code, "CREDENTIAL_POOL_EXHAUSTED");
  assert.doesNotMatch(JSON.stringify(fallbacks[0]), /raw-secret/);
  assert.doesNotMatch(fallbacks[0].message, /raw-secret/);
});

test("single existing env key is auto-discovered as a one-key pool", () => {
  const registry = createCredentialPoolRegistry({
    config: {},
    env: { OPENAI_API_KEY: "existing-env-secret" },
    providerEnvKeys: { openai: "OPENAI_API_KEY" }
  });

  const openai = registry.get("openai");
  assert.ok(openai);
  assert.equal(openai.size, 1);
  const lease = openai.acquire();
  assert.equal(lease.id, "env");
  assert.equal(lease.value, "existing-env-secret");
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /existing-env-secret/);
});

test("config loads only secret-name references and env JSON overrides file providers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-credential-pool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "credential-pools.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    providers: {
      anthropic: {
        strategy: "fill_first",
        credentials: [{ id: "file", secretName: "ANTHROPIC_POOL_FILE" }]
      },
      openai: {
        credentials: [{ id: "openai", secretName: "OPENAI_POOL_KEY" }]
      }
    }
  }));

  const config = loadCredentialPoolConfig({
    dataDir: dir,
    configPath,
    env: {
      OPENAGI_CREDENTIAL_POOLS: JSON.stringify({
        providers: {
          anthropic: {
            strategy: "least_used",
            credentials: [{ id: "env", secretName: "ANTHROPIC_POOL_ENV" }]
          }
        }
      })
    }
  });

  assert.equal(config.providers.anthropic.strategy, "least_used");
  assert.equal(config.providers.anthropic.credentials[0].secretName, "ANTHROPIC_POOL_ENV");
  assert.equal(config.providers.openai.credentials[0].secretName, "OPENAI_POOL_KEY");
  assert.doesNotMatch(JSON.stringify(config), /(?:sk-|raw-secret)/);
});

test("402 cooldown survives registry reload without persisting raw credentials", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-credential-pool-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "credential-pools.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    providers: {
      anthropic: {
        strategy: "fill_first",
        credentials: [
          { id: "first", secretName: "POOL_KEY_ONE" },
          { id: "second", secretName: "POOL_KEY_TWO" }
        ]
      }
    }
  }));
  const env = {
    POOL_KEY_ONE: "raw-secret-one",
    POOL_KEY_TWO: "raw-secret-two"
  };
  const now = () => Date.parse("2026-01-01T00:00:00.000Z");
  const firstRegistry = createCredentialPoolRegistry({
    dataDir: dir,
    configPath,
    env,
    providerEnvKeys: {},
    now
  });
  await firstRegistry.execute("anthropic", async (lease) => {
    if (lease.id === "first") throw providerError(402, "billing required");
    return "ok";
  });

  const reloadedRegistry = createCredentialPoolRegistry({
    dataDir: dir,
    configPath,
    env,
    providerEnvKeys: {},
    now
  });
  assert.equal(
    await reloadedRegistry.execute("anthropic", async (lease) => lease.id),
    "second"
  );

  const stateDir = path.join(dir, "credential-pools", "anthropic");
  const persistedText = [
    fs.readFileSync(configPath, "utf8"),
    fs.readFileSync(path.join(stateDir, "state.json"), "utf8"),
    fs.readFileSync(path.join(stateDir, "events.jsonl"), "utf8")
  ].join("\n");
  assert.doesNotMatch(persistedText, /raw-secret-one|raw-secret-two/);
});

test("literal secret values in config entries fail closed", () => {
  assert.throws(
    () => createCredentialPoolRegistry({
      config: {
        providers: {
          anthropic: {
            credentials: [{ id: "unsafe", value: "raw-secret-value" }]
          }
        }
      },
      env: {}
    }),
    /cannot contain literal secret field value/
  );
  assert.throws(
    () => createCredentialPoolRegistry({
      config: {
        providers: {
          anthropic: {
            credentials: [{ id: "unsafe", apiKey: "raw-secret-value" }]
          }
        }
      },
      env: {}
    }),
    /cannot contain literal secret field apiKey/
  );
});

test("secrets store resolution, leases, events, state, and inspection never serialize values", async () => {
  const events = [];
  const accesses = [];
  const secrets = new Map([
    ["POOL_KEY_ONE", "store-secret-one"],
    ["POOL_KEY_TWO", "store-secret-two"]
  ]);
  const credentialPool = pool({
    strategy: "fill_first",
    env: {
      POOL_KEY_ONE: "unsafe-env-fallback-one",
      POOL_KEY_TWO: "unsafe-env-fallback-two"
    },
    secretsStore: {
      getSecret(name, options) {
        accesses.push({ name, decidedBy: options.decidedBy });
        return secrets.get(name) ?? null;
      }
    },
    onEvent: (event) => events.push(event)
  });
  const first = credentialPool.acquire();
  assert.equal(first.value, "store-secret-one");
  assert.match(util.inspect(first), /CredentialLease/);
  assert.doesNotMatch(JSON.stringify(first), /store-secret|unsafe-env/);
  assert.doesNotMatch(util.inspect(first, { showHidden: true }), /store-secret|unsafe-env/);

  await credentialPool.execute(async (lease) => {
    if (lease.id === "second") return "ok";
    throw providerError(429, "usage limit reached");
  });

  const safeSurfaces = JSON.stringify({
    events,
    state: credentialPool.snapshot(),
    accesses,
    pool: credentialPool
  });
  assert.doesNotMatch(safeSurfaces, /store-secret|unsafe-env/);
  assert.match(safeSurfaces, /promptCacheReset/);
});

test("failure classification reads ProviderError-style status and nested body messages", () => {
  assert.deepEqual(
    classifyCredentialFailure({ status: 429, message: "usage limit reached" }),
    { kind: "usage_limit", status: 429, retrySame: false }
  );
  assert.deepEqual(
    classifyCredentialFailure({
      response: { status: 429 },
      body: { error: { message: "temporary overload" } }
    }),
    { kind: "transient_rate_limit", status: 429, retrySame: true }
  );
  assert.deepEqual(
    classifyCredentialFailure({ statusCode: 402, message: "billing" }),
    { kind: "billing", status: 402, retrySame: false }
  );
  assert.deepEqual(
    classifyCredentialFailure({ status: 401, message: "expired" }),
    { kind: "auth", status: 401, retrySame: false }
  );
});

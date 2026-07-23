import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecretsStore } from "../src/secrets-store.js";
import {
  renderWizard,
  saveEnv,
  SETUP_FIELDS
} from "../src/setup-wizard.js";

const ROUTING_FIELDS = [
  "OPENAGI_PROVIDER_ROUTING",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL"
];

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-routing-setup-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function isolateEnv(t, names) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function allowWindowsAtomicWrites(t) {
  if (process.platform !== "win32") return;
  const original = fs.fsyncSync;
  fs.fsyncSync = () => {};
  t.after(() => {
    fs.fsyncSync = original;
  });
}

test("provider routing fields are allowlisted and rendered as non-secret configuration", () => {
  for (const name of ROUTING_FIELDS) {
    assert.ok(SETUP_FIELDS.includes(name), `${name} must be setup-wizard persistable`);
  }

  const routing = '{"sort":"latency","only":["anthropic"],"note":"<route>"}';
  const html = renderWizard({
    existingEnv: {
      OPENAGI_PROVIDER_ROUTING: routing,
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1?mode=a&b=<route>",
      ANTHROPIC_BASE_URL: "https://inference-api.nousresearch.com/v1",
      OPENAI_API_KEY: "sk-openai-do-not-render",
      ANTHROPIC_API_KEY: "sk-anthropic-do-not-render"
    }
  });

  assert.match(
    html,
    /name="OPENAI_BASE_URL" value="https:\/\/openrouter\.ai\/api\/v1\?mode=a&amp;b=&lt;route&gt;"/u
  );
  assert.match(
    html,
    /name="ANTHROPIC_BASE_URL" value="https:\/\/inference-api\.nousresearch\.com\/v1"/u
  );
  assert.match(html, /<textarea name="OPENAGI_PROVIDER_ROUTING"[^>]*>/u);
  assert.ok(
    html.includes(
      "{&quot;sort&quot;:&quot;latency&quot;,&quot;only&quot;:[&quot;anthropic&quot;],&quot;note&quot;:&quot;&lt;route&gt;&quot;}"
    )
  );
  assert.match(html, /Provider routing for OpenRouter or Nous Portal/u);
  assert.doesNotMatch(html, /sk-openai-do-not-render|sk-anthropic-do-not-render/u);
  assert.doesNotMatch(html, /<route>/u);
});

test("setup save preserves routing JSON text and base URLs through the normal protocol", (t) => {
  allowWindowsAtomicWrites(t);
  const dataDir = makeDataDir(t);
  const unknown = "OPENAGI_PROVIDER_ROUTING_UNSAFE";
  isolateEnv(t, [...ROUTING_FIELDS, unknown]);
  const routing = '{ "sort": "latency", "only": ["anthropic", "openai"], "require_parameters": true, "data_collection": "deny" }';
  const values = {
    OPENAGI_PROVIDER_ROUTING: routing,
    OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    ANTHROPIC_BASE_URL: "https://inference-api.nousresearch.com/v1",
    [unknown]: '{"sort":"price"}'
  };

  const saved = saveEnv({
    dataDir,
    values,
    decidedBy: "test:provider-routing-setup"
  });

  assert.deepEqual(new Set(saved.keys), new Set(ROUTING_FIELDS));
  assert.equal(process.env.OPENAGI_PROVIDER_ROUTING, routing);
  assert.equal(process.env.OPENAI_BASE_URL, values.OPENAI_BASE_URL);
  assert.equal(process.env.ANTHROPIC_BASE_URL, values.ANTHROPIC_BASE_URL);
  assert.equal(process.env[unknown], undefined);

  const projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.ok(projection.includes(`OPENAGI_PROVIDER_ROUTING=${routing}\n`));
  assert.ok(projection.includes(`OPENAI_BASE_URL=${values.OPENAI_BASE_URL}\n`));
  assert.ok(projection.includes(`ANTHROPIC_BASE_URL=${values.ANTHROPIC_BASE_URL}\n`));
  assert.doesNotMatch(projection, /OPENAGI_PROVIDER_ROUTING_UNSAFE/u);

  const store = new SecretsStore({ dataDir, allowlist: SETUP_FIELDS, env: {} });
  assert.equal(
    store.getSecret("OPENAGI_PROVIDER_ROUTING", {
      decidedBy: "test:provider-routing-setup:verify"
    }),
    routing
  );
});

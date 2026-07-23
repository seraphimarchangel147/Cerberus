import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renderWizard,
  saveEnv,
  SETUP_FIELDS
} from "../src/setup-wizard.js";

const API_SERVER_FIELDS = [
  "API_SERVER_ENABLED",
  "API_SERVER_KEY",
  "API_SERVER_PORT",
  "SUBSCRIPTION_PROXY_ENABLED",
  "SUBSCRIPTION_PROXY_PORT",
  "SUBSCRIPTION_PROXY_UPSTREAM_URL",
  "SUBSCRIPTION_PROXY_SECRET_NAME"
];

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-api-server-setup-"));
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

test("API server and subscription proxy fields are allowlisted and rendered safely", () => {
  for (const name of API_SERVER_FIELDS) {
    assert.ok(SETUP_FIELDS.includes(name), `${name} must be setup-wizard persistable`);
  }

  const apiKey = "api-server-key-do-not-render";
  const html = renderWizard({
    existingEnv: {
      API_SERVER_ENABLED: "true",
      API_SERVER_KEY: apiKey,
      API_SERVER_PORT: "9001",
      SUBSCRIPTION_PROXY_ENABLED: "true",
      SUBSCRIPTION_PROXY_PORT: "9002",
      SUBSCRIPTION_PROXY_UPSTREAM_URL: "https://router.example/v1?mode=a&tag=<proxy>",
      SUBSCRIPTION_PROXY_SECRET_NAME: "ROUTER_KEY<&"
    }
  });

  assert.match(html, /name="API_SERVER_ENABLED"/u);
  assert.match(html, /<option value="true" selected>Enabled<\/option>/u);
  assert.match(html, /name="API_SERVER_PORT" value="9001"/u);
  assert.match(html, /name="API_SERVER_KEY" autocomplete="off"/u);
  assert.match(html, /API_SERVER_KEY.*saved/u);
  assert.doesNotMatch(html, new RegExp(apiKey, "u"));
  assert.match(html, /name="SUBSCRIPTION_PROXY_ENABLED"/u);
  assert.match(html, /name="SUBSCRIPTION_PROXY_PORT" value="9002"/u);
  assert.match(
    html,
    /name="SUBSCRIPTION_PROXY_UPSTREAM_URL" value="https:\/\/router\.example\/v1\?mode=a&amp;tag=&lt;proxy&gt;"/u
  );
  assert.match(
    html,
    /name="SUBSCRIPTION_PROXY_SECRET_NAME" value="ROUTER_KEY&lt;&amp;"/u
  );
  assert.doesNotMatch(html, /<proxy>/u);

  const defaults = renderWizard({ existingEnv: {} });
  assert.match(defaults, /name="API_SERVER_PORT" value="8642"/u);
  assert.match(defaults, /name="SUBSCRIPTION_PROXY_PORT" value="8645"/u);
  assert.match(
    defaults,
    /name="SUBSCRIPTION_PROXY_SECRET_NAME" value="OPENAI_API_KEY"/u
  );
});

test("setup save persists every API server and subscription proxy field exactly", (t) => {
  allowWindowsAtomicWrites(t);
  const dataDir = makeDataDir(t);
  const unknown = "API_SERVER_KEY_UNSAFE";
  isolateEnv(t, [...API_SERVER_FIELDS, unknown]);
  const values = {
    API_SERVER_ENABLED: "true",
    API_SERVER_KEY: "local-api-server-secret",
    API_SERVER_PORT: "9642",
    SUBSCRIPTION_PROXY_ENABLED: "true",
    SUBSCRIPTION_PROXY_PORT: "9645",
    SUBSCRIPTION_PROXY_UPSTREAM_URL: "https://managed.example/v1?tenant=alpha&mode=subscription",
    SUBSCRIPTION_PROXY_SECRET_NAME: "ANTHROPIC_API_KEY",
    [unknown]: "must-not-save"
  };

  const saved = saveEnv({
    dataDir,
    values,
    decidedBy: "test:api-server-setup"
  });

  assert.deepEqual(new Set(saved.keys), new Set(API_SERVER_FIELDS));
  for (const name of API_SERVER_FIELDS) {
    assert.equal(process.env[name], values[name]);
  }
  assert.equal(process.env[unknown], undefined);

  const projection = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  for (const name of API_SERVER_FIELDS) {
    assert.ok(projection.includes(`${name}=${values[name]}\n`));
  }
  assert.doesNotMatch(projection, /API_SERVER_KEY_UNSAFE/u);

  const rerendered = renderWizard({ existingEnv: values });
  assert.doesNotMatch(rerendered, /local-api-server-secret/u);
  assert.match(rerendered, /API_SERVER_KEY.*saved/u);
});

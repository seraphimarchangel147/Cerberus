// A self-QA subprocess must never inherit credentials that can bind a real
// channel. These tests assert both isolation layers without starting sockets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelManager } from "../src/channels.js";
import { registerCodeTools } from "../src/code-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

const SENSITIVE_ENV = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_ACTIVITY_CHANNEL",
  "DISCORD_ALLOW_FROM",
  "DISCORD_GUILDS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "BUILDBETTER_WEBHOOK_SECRET"
];

function isolateEnv(t, keys) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("code_test launches node --test with channel credentials scrubbed", async (t) => {
  isolateEnv(t, [...SENSITIVE_ENV, "OPENAGI_TEST"]);
  for (const key of SENSITIVE_ENV) process.env[key] = `fixture-${key}`;
  delete process.env.OPENAGI_TEST;

  const calls = [];
  const tools = new ToolRegistry();
  registerCodeTools(tools, {}, {
    async runTest(command, args, options) {
      calls.push({ command, args, options });
      return {
        ok: true,
        code: 0,
        stdout: "# pass 1\n# fail 0\n",
        stderr: ""
      };
    }
  });

  const outcome = await tools.get("code_test").handler({});
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ["--test"]);
  assert.equal(calls[0].options.env.OPENAGI_TEST, "1");
  for (const key of SENSITIVE_ENV) {
    assert.equal(Object.hasOwn(calls[0].options.env, key), false, `${key} must not reach node --test`);
    assert.equal(process.env[key], `fixture-${key}`, "scrubbing must not mutate the daemon environment");
  }
});

test("OPENAGI_TEST binds null channel tokens and start cannot connect", (t) => {
  isolateEnv(t, ["OPENAGI_TEST", "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_POLLING"]);
  process.env.OPENAGI_TEST = "1";
  process.env.DISCORD_BOT_TOKEN = "live-discord-fixture";
  process.env.TELEGRAM_BOT_TOKEN = "live-telegram-fixture";
  process.env.TELEGRAM_POLLING = "1";

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfqa-channel-test-"));
  const manager = new ChannelManager({
    dir,
    discordToken: "explicit-discord-fixture",
    telegramToken: "explicit-telegram-fixture",
    agentHost: { runtime: {} }
  });
  let gatewayConnects = 0;
  let telegramPolls = 0;
  manager.discord.connect = () => { gatewayConnects += 1; };
  manager.telegram.pollOnce = async () => { telegramPolls += 1; };

  assert.equal(manager.discord.token, null);
  assert.equal(manager.telegram.token, null);
  manager.start();
  assert.equal(gatewayConnects, 0);
  assert.equal(telegramPolls, 0);
  manager.stop();
});

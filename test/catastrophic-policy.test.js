// Catastrophic policy is intentionally narrow: ordinary destructive work stays
// under the smart gate, while machine-ending actions always stop for a human.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyCommand, isCatastrophicToolCall } from "../src/catastrophic-policy.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const CATASTROPHIC = [
  "rm -rf /",
  "rm -r -f ~",
  "bash -lc 'rm -fr $HOME'",
  "rm --recursive --force /home/*",
  "rm -rf /mnt/c/Users",
  "rm -rf /tmp",
  "wsl.exe --shutdown",
  "shutdown -h now",
  "reboot",
  "poweroff",
  "systemctl --user stop openagi-azazel.service",
  "systemctl disable zerohermes.service",
  "systemctl kill cua-driver.service",
  "systemctl mask hermes-gateway.service",
  "pkill -f hermes-gateway",
  "killall openagi",
  "pkill -f 'node.*hosted-server'",
  "mkfs.ext4 /dev/sda1",
  "fdisk /dev/sda",
  "parted /dev/sda mklabel gpt",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "git push --force origin main",
  "git push origin HEAD:master -f",
  "printf secret > ~/.openagi/.env",
  "cp fresh.env $HOME/.hermes/.env",
  "mv generated-key /tmp/id_rsa",
  "cat key > server.pem",
  ":(){ :|:& };:",
  "boom(){ boom|boom& };boom"
];

test("classifyCommand recognizes every catastrophic class, including bash wrapping", () => {
  for (const command of CATASTROPHIC) {
    const result = classifyCommand(command);
    assert.equal(result.catastrophic, true, command);
    assert.ok(result.reason, command);
  }
});

test("classifyCommand leaves benign lookalikes in the smart-gate lane", () => {
  const benign = [
    "rm -rf node_modules",
    "git push origin feature",
    "git push --force origin feature",
    "systemctl --user status openagi-azazel",
    "systemctl restart openagi-azazel",
    "systemctl stop vacuum.service",
    "pkill unrelated-worker",
    "cat ~/.openagi/.env",
    "cp private.pem ./public-key.txt",
    "echo shutdown"
  ];
  for (const command of benign) {
    assert.deepEqual(classifyCommand(command), { catastrophic: false, reason: null }, command);
  }
  assert.deepEqual(
    isCatastrophicToolCall({ toolName: "some_other_tool", args: { command: "rm -rf /" } }),
    { catastrophic: false, reason: null }
  );
});

test("catastrophic calls divert in both auto-approve lanes without pinning the env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catastrophic-gate-"));
  const pending = new PendingActionStore({ dir });
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async () => { executions += 1; return { exitCode: 0 }; }
  });
  registry.bindPendingActions(pending);

  const result = await registry.invoke("code_shell", { command: "rm -rf /" }, { sessionId: "s1" });
  assert.equal(result.result.status, "awaiting_confirmation");
  assert.equal(executions, 0, "OPENAGI_AUTO_APPROVE must never bypass this gate");
  const action = pending.get(result.result.actionId);
  assert.equal(action.severity, "catastrophic");
  assert.match(action.reason, /delete/i);
  assert.match(action.summary, /CATASTROPHIC/);
});

test("the hosted approval endpoint executes a catastrophic action after a human decision", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catastrophic-endpoint-"));
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  // Replace the real shell handler so this regression proves gate semantics
  // without ever executing the deliberately dangerous fixture command.
  runtime.tools.register({
    name: "code_shell",
    needsConfirmation: true,
    summarize: ({ command }) => `shell: ${command}`,
    handler: async ({ command }) => { calls.push(command); return { exitCode: 0, stdout: "stubbed" }; }
  });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;

  try {
    const diverted = await runtime.tools.invoke("code_shell", { command: "wsl --shutdown" }, { sessionId: "s1" });
    assert.equal(diverted.result.status, "awaiting_confirmation");
    assert.deepEqual(calls, []);

    const response = await fetch(`${base}/pending-actions/${diverted.result.actionId}/approve`, { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(calls, ["wsl --shutdown"]);
    assert.equal(runtime.pendingActions.get(diverted.result.actionId).status, "approved");
  } finally {
    await app.close?.();
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBackedAgentStore } from "../src/agent-store.js";
import { AbiRuntime, createDefaultRuntime, isSilentCronOutput } from "../src/abi-runtime.js";
import { CronScheduler } from "../src/cron-scheduler.js";

function model(provider = "fixture", name = "fixture-model") {
  return { provider, model: name };
}

function scheduledJob(cron, id = "silent-job") {
  return cron.addJob({
    id,
    name: id,
    enabled: true,
    task: "prompt",
    intervalMs: 60_000,
    input: {
      prompt: "Perform the quiet scheduled check",
      channel: "local",
      target: "owner",
      sessionId: `cron:${id}`
    }
  });
}

function scheduledRuntime(reply) {
  const current = model();
  const cron = new CronScheduler({ modelResolver: () => current });
  const deliveries = [];
  const runtime = Object.assign(Object.create(AbiRuntime.prototype), {
    cron,
    agentHost: {
      async handleMessage() {
        return { reply, model: current, toolCalls: [] };
      }
    },
    channels: {
      async deliver(message) {
        deliveries.push(message);
        return { delivered: true };
      }
    }
  });
  return { cron, deliveries, runtime };
}

test("isSilentCronOutput accepts only an exact, outer-whitespace-trimmed marker", () => {
  for (const value of ["[SILENT]", " [SILENT]", "\n[SILENT]\t"]) {
    assert.equal(isSilentCronOutput(value), true, JSON.stringify(value));
  }
  for (const value of ["", null, undefined, "[silent]", "[SILENT] extra", "prefix [SILENT]", "[SILENT]\ntext"]) {
    assert.equal(isSilentCronOutput(value), false, JSON.stringify(value));
  }
});

test("an exact silent result skips delivery while preserving the returned output", async () => {
  const original = " \n[SILENT]\t";
  const { cron, deliveries, runtime } = scheduledRuntime(original);
  const result = await runtime.runScheduledPrompt(scheduledJob(cron));

  assert.equal(deliveries.length, 0);
  assert.equal(result.reply, original, "the marker remains available for audit");
  assert.equal(result.deliverySuppressed, "silent-output");
});

test("near-miss silent markers are delivered normally", async () => {
  for (const reply of ["[silent]", "[SILENT] extra", "prefix [SILENT]", "[SILENT]\ntext"]) {
    const { cron, deliveries, runtime } = scheduledRuntime(reply);
    const result = await runtime.runScheduledPrompt(scheduledJob(cron, `near-${deliveries.length}-${reply.length}`));
    assert.equal(deliveries.length, 1, JSON.stringify(reply));
    assert.equal(deliveries[0].text, reply);
    assert.equal(result.deliverySuppressed, undefined);
  }
});

test("silent scheduled output remains in the durable session transcript", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-silent-audit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new FileBackedAgentStore({ dir: path.join(dataDir, "agent-host") });
  const provider = {
    provider: "fixture",
    name: "fixture",
    model: "fixture-model",
    isConfigured: () => true,
    async generate() {
      return {
        provider: "fixture",
        model: "fixture-model",
        text: "[SILENT]",
        toolCalls: [],
        iterations: 1,
        maxIterations: 1,
        stopReason: "completed"
      };
    }
  };
  const runtime = createDefaultRuntime({
    dataDir,
    agentStore: store,
    modelProvider: provider,
    registerDefaults: false,
    integrations: false,
    skills: false
  });
  const deliveries = [];
  runtime.channels = {
    async deliver(message) {
      deliveries.push(message);
      return { delivered: true };
    }
  };
  const job = runtime.cron.addJob({
    id: "audit-silent",
    name: "Audit silent",
    enabled: true,
    task: "prompt",
    intervalMs: 60_000,
    input: {
      prompt: "Run quietly",
      channel: "cron",
      target: "owner",
      sessionId: "cron:audit-silent"
    }
  });

  const result = await runtime.runScheduledPrompt(job);
  assert.equal(result.deliverySuppressed, "silent-output");
  assert.equal(deliveries.length, 0);

  const session = store.getSession("cron:audit-silent");
  const assistant = session.messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(assistant, "the scheduled turn wrote an assistant transcript row");
  assert.equal(assistant.content, "[SILENT]");
  await runtime.sessionIndex?.rebuildPromise;
});

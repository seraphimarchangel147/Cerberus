import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AbiRuntime } from "../src/abi-runtime.js";
import {
  buildDefaultInstructions,
  spillModelToolOutput
} from "../src/model-provider.js";
import {
  consumeMemoryRequestMetrics,
  initializeMemoryRequestMetrics
} from "../src/memory-request-metrics.js";
import { SETUP_FIELDS } from "../src/setup-wizard.js";
import { SpillStore } from "../src/spill-store.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runtimeAt(dataDir, enabled) {
  return new AbiRuntime({
    dataDir,
    env: {
      OPENAGI_MEMTREE: enabled ? "1" : "0",
      OPENAGI_WAKE_BUDGET: "8",
      OPENAGI_SPILL_BYTES: "64",
      OPENAGI_MEMORY_ENTRY_CHARS: "280"
    },
    registerDefaults: true,
    terminals: false,
    runInspector: false,
    semanticBrowser: false,
    webQa: false
  });
}

test("OPENAGI_MEMTREE gates stores, tools, and agent instructions", () => {
  const disabled = runtimeAt(tempDir("memtree-off-"), false);
  assert.equal(disabled.memtree, null);
  assert.equal(disabled.spills, null);
  assert.equal(disabled.tools.get("memory_wake"), undefined);
  assert.equal(disabled.tools.get("read_spill"), undefined);
  assert.doesNotMatch(
    buildDefaultInstructions({ agent: { name: "Tester" }, budgetedMemory: false }),
    /read_spill|memory_wake/u
  );

  const enabled = runtimeAt(tempDir("memtree-on-"), true);
  assert.ok(enabled.memtree);
  assert.ok(enabled.spills);
  for (const name of [
    "memory_wake",
    "memory_zoom",
    "memory_merge",
    "memory_tree_recall",
    "read_spill"
  ]) {
    assert.ok(enabled.tools.get(name), `${name} must be registered`);
  }
  assert.match(
    buildDefaultInstructions({ agent: { name: "Tester" }, budgetedMemory: true }),
    /read_spill[\s\S]*exact inclusive line slice/u
  );
});

test("memory writes project into the scoped append-only tree", async () => {
  const runtime = runtimeAt(tempDir("memtree-project-"), true);
  const item = runtime.memory.remember({
    content: "A durable projected fact",
    scope: "project:alpha",
    tags: ["test"]
  });
  assert.ok(item.id);

  const wake = runtime.memtree.wake({ scope: "project:alpha", budget: 8 });
  assert.match(wake.text, /A durable projected fact/u);
  const recalled = await runtime.tools.get("memory_tree_recall").handler(
    { regex: "projected fact" },
    {
      __memoryScope: "project:alpha",
      __projectId: "alpha"
    }
  );
  assert.equal(recalled.matches.length, 1);
});

test("oversized model tool output spills once and exposes exact retrieval", () => {
  const dir = tempDir("model-spill-");
  const spills = new SpillStore({ dir, spillBytes: 64 });
  const context = {
    runtime: { spills },
    __projectId: "alpha"
  };
  initializeMemoryRequestMetrics(context);
  const content = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
  const encoded = spillModelToolOutput(content, { context, maxChars: 8000 });
  const skeleton = JSON.parse(encoded);

  assert.equal(skeleton.spilled, true);
  assert.match(skeleton.instruction, /read_spill/u);
  assert.equal(
    spills.read(skeleton.id, "10-12", { projectId: "alpha" }).content,
    "line 10\nline 11\nline 12"
  );
  assert.equal(consumeMemoryRequestMetrics(context).spillCount, 1);
  assert.equal(spillModelToolOutput("small", { context, maxChars: 8000 }), null);
});

test("budgeted memory configuration is setup-wizard persistable", () => {
  for (const name of [
    "OPENAGI_MEMTREE",
    "OPENAGI_WAKE_BUDGET",
    "OPENAGI_SPILL_BYTES",
    "OPENAGI_MEMORY_ENTRY_CHARS"
  ]) {
    assert.ok(SETUP_FIELDS.includes(name), `${name} must be setup-wizard persistable`);
  }
});

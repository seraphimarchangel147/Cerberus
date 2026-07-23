import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime } from "../src/abi-runtime.js";
import {
  createItemId,
  extractReasoningCoverage,
  extractToolStats,
  loadDataset,
  main,
  parseBatchArgs,
  resolveRunPaths,
  runBatch,
  toShareGptTrajectory
} from "../scripts/batcmcp_runner.mjs";

function makeTempDir(t, prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function writeDataset(root, entries, filename = "dataset.jsonl") {
  return writeFile(
    root,
    filename,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function createFixtureProvider(index, state = null) {
  const provider = {
    provider: "fixture",
    model: "fixture-model",
    isConfigured() {
      return true;
    },
    async generate(request) {
      if (state) {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.maxIterations.push(request.maxIterations);
        if (state.active >= 2) state.releasePair();
        try {
          await Promise.race([
            state.pairReady,
            new Promise((resolve) => setTimeout(resolve, 1000))
          ]);
          await new Promise((resolve) => setImmediate(resolve));
        } finally {
          state.active -= 1;
        }
      }
      return {
        provider: "fixture",
        model: "fixture-model",
        id: `fixture-response-${index}`,
        text: `<think>reasoning for ${index}</think>\nAnswer ${index}: ${request.input}`,
        toolCalls: [{
          name: "fixture_tool",
          arguments: { index },
          result: { ok: true, result: { index } }
        }],
        iterations: 1,
        maxIterations: request.maxIterations,
        stopReason: "completed"
      };
    }
  };
  return provider;
}

test("parseBatchArgs accepts space and equals forms and rejects invalid CLI input", () => {
  const parsed = parseBatchArgs([
    "--dataset_file=fixtures.jsonl",
    "--batcmcp_size", "2",
    "--run_name=nightly-1",
    "--model", "openai/fixture-model",
    "--num_workers=2",
    "--max_turns", "4",
    "--resume"
  ]);
  assert.deepEqual(parsed, {
    datasetFile: "fixtures.jsonl",
    batcmcpSize: 2,
    runName: "nightly-1",
    model: "openai/fixture-model",
    numWorkers: 2,
    maxTurns: 4,
    resume: true,
    listDistributions: false
  });

  const failures = [
    [["--batch_size=2"], /Unknown flag: --batch_size/],
    [["loose-value"], /Unexpected positional argument/],
    [["--dataset_file"], /requires a value/],
    [["--resume=true"], /boolean flag and does not take a value/],
    [["--dataset_file=a", "--dataset_file=b"], /Duplicate flag/],
    [[
      "--dataset_file=a",
      "--batcmcp_size=0",
      "--run_name=x"
    ], /--batcmcp_size must be a positive integer/],
    [[
      "--dataset_file=a",
      "--batcmcp_size=1",
      "--run_name=x",
      "--num_workers=1.5"
    ], /--num_workers must be a positive integer/],
    [[
      "--dataset_file=a",
      "--batcmcp_size=1",
      "--run_name=x",
      "--max_turns=-1"
    ], /--max_turns must be a positive integer/],
    [[], /--dataset_file is required/]
  ];
  for (const [argv, pattern] of failures) {
    assert.throws(() => parseBatchArgs(argv), pattern);
  }
});

test("--list_distributions is an early successful mode", async () => {
  const parsed = parseBatchArgs(["--list_distributions"]);
  assert.equal(parsed.listDistributions, true);
  assert.equal(parsed.datasetFile, null);
  assert.equal(parsed.runName, null);

  const lines = [];
  const result = await main(["--list_distributions"], {
    log(line) {
      lines.push(line);
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.distributions.length >= 1);
  assert.ok(lines.some((line) => /^default\t/u.test(line)));
});

test("loadDataset validates JSONL by line and preserves supported fields", (t) => {
  const root = makeTempDir(t, "openagi-batch-dataset");
  const validPath = writeFile(
    root,
    "valid.jsonl",
    "\uFEFF{\"prompt\":\"one\",\"image\":\"image.png\"}\n"
      + "\n"
      + "{\"prompt\":\"two\",\"docker_image\":\"fixture:latest\",\"cwd\":\"workspace\"}\n"
  );
  assert.deepEqual(loadDataset(validPath), [
    { prompt: "one", image: "image.png" },
    {
      prompt: "two",
      docker_image: "fixture:latest",
      cwd: "workspace"
    }
  ]);

  const malformed = writeFile(
    root,
    "malformed.jsonl",
    "{\"prompt\":\"ok\"}\n{\"prompt\":\n"
  );
  assert.throws(() => loadDataset(malformed), /at line 2/);

  const invalidEntries = [
    ["missing-prompt.jsonl", "{}\n", /line 1 requires a non-empty prompt/],
    ["array.jsonl", "[]\n", /line 1 must be a JSON object/],
    [
      "invalid-optional.jsonl",
      "{\"prompt\":\"ok\",\"image\":\"\"}\n",
      /field image must be a non-empty string/
    ],
    ["empty.jsonl", "\n", /Dataset is empty/]
  ];
  for (const [filename, content, pattern] of invalidEntries) {
    const filePath = writeFile(root, filename, content);
    assert.throws(() => loadDataset(filePath), pattern);
  }
  assert.throws(
    () => loadDataset(path.join(root, "missing.jsonl")),
    /Dataset file not found/
  );
});

test("run paths reject traversal and item ids are stable and occurrence-aware", (t) => {
  const outputRoot = makeTempDir(t, "openagi-batch-paths");
  assert.throws(
    () => resolveRunPaths("../escape", { outputRoot }),
    /run_name must .*contain only ASCII/
  );
  assert.throws(
    () => parseBatchArgs([
      "--dataset_file=data.jsonl",
      "--batcmcp_size=1",
      "--run_name=../escape"
    ]),
    /run_name must .*contain only ASCII/
  );

  const paths = resolveRunPaths("safe.run-1", { outputRoot });
  assert.equal(paths.runDir, path.join(outputRoot, "safe.run-1"));
  assert.equal(paths.batchPath(3), path.join(paths.runDir, "batch_3.jsonl"));
  assert.ok(!path.relative(outputRoot, paths.runDir).startsWith(".."));
  assert.throws(() => paths.batchPath(-1), /non-negative integer/);

  const entry = {
    prompt: "same prompt",
    image: "image.png",
    docker_image: "fixture:latest",
    cwd: "workspace"
  };
  assert.equal(createItemId(entry), createItemId({ ...entry }));
  assert.notEqual(createItemId(entry, 0), createItemId(entry, 1));
  assert.notEqual(
    createItemId(entry),
    createItemId({ ...entry, image: "other.png" })
  );
});

test("trajectory helper functions report tools and reasoning deterministically", () => {
  const messages = [
    { role: "system", content: "System" },
    { role: "user", content: "Question" },
    {
      role: "assistant",
      content: "First answer",
      metadata: {
        reasoning: "native reasoning",
        toolCalls: [
          { name: "zeta", arguments: { value: 1 }, ok: true },
          { name: "alpha", arguments: {}, ok: false }
        ]
      }
    },
    {
      role: "assistant",
      content: "<think>hidden work</think>\nSecond answer",
      tool_calls: [
        { function: { name: "alpha" }, result: { ok: true } }
      ]
    },
    { role: "assistant", content: "Third answer" },
    { role: "tool", content: "Tool result" }
  ];

  assert.deepEqual(extractToolStats(messages), {
    alpha: { count: 2, success: 1, failure: 1 },
    zeta: { count: 1, success: 1, failure: 0 }
  });
  assert.deepEqual(extractReasoningCoverage(messages), {
    total_assistant_turns: 3,
    turns_with_reasoning: 2,
    turns_without_reasoning: 1,
    has_any_reasoning: true,
    coverage: 2 / 3
  });

  const trajectory = toShareGptTrajectory(messages);
  assert.deepEqual(
    trajectory.map((message) => message.from),
    ["system", "human", "gpt", "gpt", "gpt", "tool"]
  );
  assert.deepEqual(trajectory[2].tool_calls, [
    { name: "zeta", arguments: { value: 1 }, ok: true },
    { name: "alpha", arguments: {}, ok: false }
  ]);
  assert.match(trajectory[3].value, /<think>hidden work<\/think>/);
});

test("runBatch processes three prompts with bounded concurrency and resumes without duplicates", async (t) => {
  const root = makeTempDir(t, "openagi-batch-run");
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  const datasetEntries = [
    { prompt: "prompt zero", cwd: "workspace" },
    { prompt: "prompt one", cwd: "workspace" },
    { prompt: "prompt two", cwd: "workspace" }
  ];
  const datasetFile = writeDataset(root, datasetEntries);
  const initialCwd = process.cwd();
  let releasePair;
  const pairReady = new Promise((resolve) => {
    releasePair = resolve;
  });
  const state = {
    active: 0,
    maxActive: 0,
    maxIterations: [],
    pairReady,
    releasePair
  };
  const factoryCalls = [];
  const runtimeCalls = [];
  const providers = [];
  const logs = [];
  const fixedNow = () => new Date("2026-07-23T12:00:00.000Z");

  const result = await runBatch({
    datasetFile,
    batcmcpSize: 2,
    runName: "integration",
    model: "fixture-model",
    numWorkers: 2,
    maxTurns: 3
  }, {
    outputRoot,
    now: fixedNow,
    log(line) {
      logs.push(line);
    },
    modelProviderFactory(entry, metadata) {
      factoryCalls.push({ entry, metadata });
      const provider = createFixtureProvider(metadata.index, state);
      providers.push(provider);
      return provider;
    },
    createRuntime(options) {
      runtimeCalls.push(options);
      return createDurableRuntime(options);
    }
  });

  assert.equal(process.cwd(), initialCwd);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.datasetSize, 3);
  assert.equal(result.processed, 3);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(state.maxActive, 2);
  assert.ok(state.maxActive <= 2);
  assert.deepEqual(state.maxIterations.sort(), [3, 3, 3]);
  assert.equal(factoryCalls.length, 3);
  assert.equal(new Set(providers).size, 3);
  assert.deepEqual(
    factoryCalls.map(({ entry, metadata }) => [entry.prompt, metadata.index]).sort((a, b) => a[1] - b[1]),
    datasetEntries.map((entry, index) => [entry.prompt, index])
  );
  assert.ok(factoryCalls.every(({ metadata }) => metadata.model === "fixture-model"));
  assert.equal(new Set(factoryCalls.map(({ metadata }) => metadata.dataDir)).size, 3);
  assert.equal(runtimeCalls.length, 3);
  assert.ok(runtimeCalls.every((options) => options.autoConnectMcp === false));
  assert.ok(runtimeCalls.every((options) => options.modelProvider));
  assert.ok(logs.some((line) => /Completed prompt/u.test(line)));

  const records = readJsonLines(result.paths.trajectoriesPath);
  assert.deepEqual(records.map((record) => record.prompt_index), [0, 1, 2]);
  assert.equal(new Set(records.map((record) => record.item_id)).size, 3);
  for (const record of records) {
    assert.equal(record.completed, true);
    assert.equal(record.partial, false);
    assert.equal(record.api_calls, 1);
    assert.deepEqual(
      record.conversations.map((message) => message.from),
      ["human", "gpt"]
    );
    assert.match(record.conversations[1].value, /<think>reasoning for \d<\/think>/);
    assert.deepEqual(record.tool_stats, {
      fixture_tool: { count: 1, success: 1, failure: 0 }
    });
    assert.deepEqual(record.tool_error_counts, { fixture_tool: 0 });
    assert.equal(record.reasoning_stats.coverage, 1);
    assert.equal(record.reasoning_stats.has_any_reasoning, true);
    assert.equal(record.metadata.attempt, 1);
    assert.equal(record.metadata.resolved_cwd, path.join(root, "workspace"));
  }

  assert.equal(readJsonLines(result.paths.batchPath(0)).length, 2);
  assert.equal(readJsonLines(result.paths.batchPath(1)).length, 1);
  const checkpoint = JSON.parse(fs.readFileSync(result.paths.checkpointPath, "utf8"));
  assert.equal(checkpoint.runName, "integration");
  assert.equal(checkpoint.completedItemIds.length, 3);
  assert.deepEqual(checkpoint.completedPromptIndices, [0, 1, 2]);
  assert.equal(checkpoint.batchStats["0"].completed, 2);
  assert.equal(checkpoint.batchStats["1"].completed, 1);

  const statistics = JSON.parse(fs.readFileSync(result.paths.statisticsPath, "utf8"));
  assert.equal(statistics.completed, 3);
  assert.equal(statistics.processed, 3);
  assert.equal(statistics.failed, 0);
  assert.equal(statistics.num_workers, 2);
  assert.equal(statistics.batcmcp_size, 2);
  assert.equal(statistics.max_turns, 3);
  assert.deepEqual(statistics.tool_stats.fixture_tool, {
    count: 3,
    success: 3,
    failure: 0,
    success_rate: 1,
    failure_rate: 0
  });
  assert.equal(statistics.reasoning_statistics.coverage, 1);
  assert.equal(statistics.updated_at, "2026-07-23T12:00:00.000Z");

  const batchCountsBefore = [
    readJsonLines(result.paths.batchPath(0)).length,
    readJsonLines(result.paths.batchPath(1)).length
  ];
  let unexpectedFactoryCalls = 0;
  const resumed = await runBatch({
    datasetFile,
    batcmcpSize: 2,
    runName: "integration",
    model: "fixture-model",
    numWorkers: 2,
    maxTurns: 3,
    resume: true
  }, {
    outputRoot,
    now: fixedNow,
    modelProviderFactory() {
      unexpectedFactoryCalls += 1;
      throw new Error("completed items must not create providers");
    },
    createRuntime() {
      throw new Error("completed items must not create runtimes");
    }
  });

  assert.equal(process.cwd(), initialCwd);
  assert.equal(unexpectedFactoryCalls, 0);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.processed, 0);
  assert.equal(resumed.completed, 3);
  assert.equal(resumed.failed, 0);
  assert.equal(resumed.skipped, 3);
  assert.deepEqual([
    readJsonLines(result.paths.batchPath(0)).length,
    readJsonLines(result.paths.batchPath(1)).length
  ], batchCountsBefore);
  assert.equal(readJsonLines(result.paths.trajectoriesPath).length, 3);
});

test("resume retries failures and trusts completed batch records over checkpoint claims", async (t) => {
  const root = makeTempDir(t, "openagi-batch-retry");
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  const entries = [
    { prompt: "will succeed", cwd: "workspace" },
    { prompt: "will retry", cwd: "workspace" }
  ];
  const datasetFile = writeDataset(root, entries);
  const baseOptions = {
    datasetFile,
    batcmcpSize: 2,
    runName: "retry-run",
    model: "fixture-model",
    numWorkers: 1,
    maxTurns: 2
  };

  const first = await runBatch(baseOptions, {
    outputRoot,
    modelProviderFactory(entry, metadata) {
      if (metadata.index === 1) throw new Error("intentional first failure");
      return createFixtureProvider(metadata.index);
    },
    createRuntime(options) {
      return createDurableRuntime(options);
    }
  });
  assert.equal(first.ok, false);
  assert.equal(first.exitCode, 1);
  assert.equal(first.processed, 2);
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 1);
  assert.equal(readJsonLines(first.paths.failuresPath).length, 1);
  assert.equal(readJsonLines(first.paths.batchPath(0)).length, 1);

  const failedItemId = createItemId(entries[1]);
  const checkpoint = JSON.parse(fs.readFileSync(first.paths.checkpointPath, "utf8"));
  checkpoint.completedItemIds.push(failedItemId);
  checkpoint.completedPromptIndices.push(1);
  fs.writeFileSync(first.paths.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const retryCalls = [];
  const resumed = await runBatch({ ...baseOptions, resume: true }, {
    outputRoot,
    modelProviderFactory(entry, metadata) {
      retryCalls.push({ entry, metadata });
      return createFixtureProvider(metadata.index);
    },
    createRuntime(options) {
      return createDurableRuntime(options);
    }
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.processed, 1);
  assert.equal(resumed.completed, 2);
  assert.equal(resumed.failed, 0);
  assert.equal(resumed.skipped, 1);
  assert.deepEqual(retryCalls.map(({ metadata }) => metadata.index), [1]);
  const completed = readJsonLines(resumed.paths.batchPath(0));
  assert.equal(completed.length, 2);
  assert.equal(new Set(completed.map((record) => record.item_id)).size, 2);
  const retried = completed.find((record) => record.item_id === failedItemId);
  assert.equal(retried.metadata.attempt, 2);
  assert.equal(readJsonLines(resumed.paths.failuresPath).length, 1);
  assert.equal(readJsonLines(resumed.paths.trajectoriesPath).length, 2);
});

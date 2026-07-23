#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableRuntime } from "../src/abi-runtime.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic
} from "../src/file-utils.js";
import { createModelProvider } from "../src/model-provider.js";

const DEFAULT_NUM_WORKERS = 2;
const DEFAULT_MAX_TURNS = 10;
const RUN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const VALUE_FLAGS = new Map([
  ["--dataset_file", "datasetFile"],
  ["--batcmcp_size", "batcmcpSize"],
  ["--run_name", "runName"],
  ["--model", "model"],
  ["--num_workers", "numWorkers"],
  ["--max_turns", "maxTurns"]
]);
const BOOLEAN_FLAGS = new Map([
  ["--resume", "resume"],
  ["--list_distributions", "listDistributions"]
]);

export const BATCH_DISTRIBUTIONS = Object.freeze({
  default: Object.freeze({
    name: "default",
    description: "All tools registered by the isolated OpenAGI runtime."
  })
});

export function parseBatchArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array.");
  const parsed = {
    datasetFile: null,
    batcmcpSize: null,
    runName: null,
    model: null,
    numWorkers: DEFAULT_NUM_WORKERS,
    maxTurns: DEFAULT_MAX_TURNS,
    resume: false,
    listDistributions: false
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const equalsAt = token.indexOf("=");
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? null : token.slice(equalsAt + 1);
    if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
    seen.add(flag);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== null) {
        throw new Error(`${flag} is a boolean flag and does not take a value.`);
      }
      parsed[BOOLEAN_FLAGS.get(flag)] = true;
      continue;
    }

    const property = VALUE_FLAGS.get(flag);
    if (!property) throw new Error(`Unknown flag: ${flag}`);
    let value = inlineValue;
    if (value === null) {
      value = argv[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
    }
    if (String(value).length === 0) throw new Error(`${flag} requires a non-empty value.`);
    parsed[property] = String(value);
  }

  parsed.numWorkers = positiveInteger(parsed.numWorkers, "--num_workers");
  parsed.maxTurns = positiveInteger(parsed.maxTurns, "--max_turns");
  if (parsed.batcmcpSize !== null) {
    parsed.batcmcpSize = positiveInteger(parsed.batcmcpSize, "--batcmcp_size");
  }
  if (parsed.listDistributions) return parsed;

  if (!parsed.datasetFile) throw new Error("--dataset_file is required.");
  if (!parsed.batcmcpSize) throw new Error("--batcmcp_size is required.");
  if (!parsed.runName) throw new Error("--run_name is required.");
  parsed.runName = validateRunName(parsed.runName);
  return parsed;
}

export function loadDataset(datasetFile) {
  const filePath = path.resolve(String(datasetFile ?? ""));
  if (!datasetFile) throw new Error("datasetFile is required.");
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Dataset file not found: ${filePath}`);
    throw error;
  }

  const entries = [];
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index].trim();
    if (!source) continue;
    let entry;
    try {
      entry = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${filePath} at line ${index + 1}: ${error?.message ?? String(error)}`
      );
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Dataset entry at line ${index + 1} must be a JSON object.`);
    }
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
      throw new Error(`Dataset entry at line ${index + 1} requires a non-empty prompt string.`);
    }
    for (const field of ["image", "docker_image", "cwd"]) {
      if (
        Object.hasOwn(entry, field)
        && (typeof entry[field] !== "string" || !entry[field].trim())
      ) {
        throw new Error(
          `Dataset entry at line ${index + 1} field ${field} must be a non-empty string.`
        );
      }
    }
    entries.push({ ...entry });
  }
  if (entries.length === 0) throw new Error(`Dataset is empty: ${filePath}`);
  return entries;
}

export function resolveRunPaths(runNameOrOptions, maybeOptions = {}) {
  const options = typeof runNameOrOptions === "string"
    ? { ...maybeOptions, runName: runNameOrOptions }
    : { ...(runNameOrOptions ?? {}) };
  const runName = validateRunName(options.runName);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(process.cwd(), "data"));
  const runDir = path.join(outputRoot, runName);
  const paths = {
    outputRoot,
    outputDir: runDir,
    runDir,
    checkpointPath: path.join(runDir, "checkpoint.json"),
    statisticsPath: path.join(runDir, "statistics.json"),
    trajectoriesPath: path.join(runDir, "trajectories.jsonl"),
    failuresPath: path.join(runDir, "failures.jsonl"),
    sessionsDir: path.join(runDir, "sessions")
  };
  paths.batchPath = (batchNumber) => {
    const number = nonNegativeInteger(batchNumber, "batchNumber");
    return path.join(runDir, `batch_${number}.jsonl`);
  };
  return paths;
}

export function createItemId(entry, occurrence = 0) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("createItemId requires a dataset entry object.");
  }
  const duplicateOccurrence = typeof occurrence === "object"
    ? occurrence.occurrence ?? 0
    : occurrence;
  const ordinal = nonNegativeInteger(duplicateOccurrence, "occurrence");
  const identity = stableJson({
    prompt: entry.prompt,
    image: entry.image ?? null,
    docker_image: entry.docker_image ?? null,
    cwd: entry.cwd ?? null,
    occurrence: ordinal
  });
  return `item_${createHash("sha256").update(identity).digest("hex")}`;
}

export function extractToolStats(sessionOrMessages) {
  const stats = new Map();
  for (const message of messagesFrom(sessionOrMessages)) {
    if (message?.role !== "assistant") continue;
    const calls = Array.isArray(message.metadata?.toolCalls)
      ? message.metadata.toolCalls
      : Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
    for (const call of calls) {
      const name = String(call?.name ?? call?.function?.name ?? "").trim();
      if (!name) continue;
      const current = stats.get(name) ?? { count: 0, success: 0, failure: 0 };
      current.count += 1;
      const ok = call?.ok === true || call?.result?.ok === true;
      if (ok) current.success += 1;
      else current.failure += 1;
      stats.set(name, current);
    }
  }
  return Object.fromEntries([...stats.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function extractReasoningCoverage(sessionOrMessages) {
  let total = 0;
  let withReasoning = 0;
  for (const message of messagesFrom(sessionOrMessages)) {
    if (message?.role !== "assistant") continue;
    total += 1;
    const content = String(message.content ?? "");
    const nativeReasoning = String(
      message.reasoning
      ?? message.metadata?.reasoning
      ?? ""
    ).trim();
    if (
      /<REASONING_SCRATCHPAD(?:\s|>)/u.test(content)
      || /<think(?:\s|>)/iu.test(content)
      || nativeReasoning.length > 0
    ) {
      withReasoning += 1;
    }
  }
  return {
    total_assistant_turns: total,
    turns_with_reasoning: withReasoning,
    turns_without_reasoning: total - withReasoning,
    has_any_reasoning: withReasoning > 0,
    coverage: total > 0 ? withReasoning / total : 0
  };
}

export function toShareGptTrajectory(sessionOrMessages) {
  const roleMap = {
    system: "system",
    user: "human",
    assistant: "gpt",
    tool: "tool"
  };
  const conversations = [];
  for (const message of messagesFrom(sessionOrMessages)) {
    const from = roleMap[message?.role];
    if (!from) continue;
    const converted = {
      from,
      value: String(message?.content ?? "")
    };
    if (message.role === "assistant" && Array.isArray(message.metadata?.toolCalls)) {
      converted.tool_calls = message.metadata.toolCalls.map((call) => ({
        name: call?.name ?? null,
        arguments: call?.arguments ?? {},
        ok: call?.ok === true
      }));
    }
    conversations.push(converted);
  }
  return conversations;
}

export async function runBatch(inputOptions = {}, deps = {}) {
  const options = normalizeRunOptions(inputOptions);
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const outputRoot = deps.outputRoot ?? options.outputRoot;
  const paths = resolveRunPaths({ runName: options.runName, outputRoot });
  const datasetFile = path.resolve(options.datasetFile);
  const dataset = loadDataset(datasetFile);
  const annotated = annotateDataset(dataset);
  const datasetFingerprint = createHash("sha256")
    .update(stableJson(dataset))
    .digest("hex");

  if (!options.resume && runHasDurableState(paths)) {
    throw new Error(
      `Run ${options.runName} already contains output at ${paths.runDir}; use --resume or choose another run name.`
    );
  }

  ensureDir(paths.sessionsDir);
  const existingRecords = loadCompletedRecords(paths, log);
  const completed = new Map(existingRecords.map((record) => [record.item_id, record]));
  const failureCounts = countFailures(paths.failuresPath, log);
  const checkpoint = options.resume
    ? loadCheckpoint(paths.checkpointPath, log)
    : null;
  const batchStats = normalizeBatchStats(checkpoint?.batchStats);
  const completedItemIds = new Set(completed.keys());
  const completedPromptIndices = new Set(
    [...completed.values()]
      .map((record) => Number(record.prompt_index))
      .filter(Number.isSafeInteger)
  );
  const startedAtMs = Date.now();
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  const batches = chunkAnnotated(annotated, options.batcmcpSize);
  const pendingBatches = [];
  for (const batch of batches) {
    const pending = batch.items.filter((item) => {
      if (!completedItemIds.has(item.itemId)) return true;
      skipped += 1;
      return false;
    });
    if (pending.length > 0) pendingBatches.push({ ...batch, items: pending });
  }

  const persistCheckpoint = () => {
    writeJsonAtomic(paths.checkpointPath, {
      version: 1,
      runName: options.runName,
      datasetFile,
      datasetFingerprint,
      completedItemIds: [...completedItemIds].sort(),
      completedPromptIndices: [...completedPromptIndices].sort((left, right) => left - right),
      batchStats,
      updatedAt: isoNow(now)
    });
  };

  persistCheckpoint();
  let nextBatch = 0;
  const workerCount = Math.min(options.numWorkers, pendingBatches.length);
  const worker = async () => {
    while (true) {
      const cursor = nextBatch;
      nextBatch += 1;
      if (cursor >= pendingBatches.length) return;
      const batch = pendingBatches[cursor];
      for (const item of batch.items) {
        const stat = batchStats[String(batch.number)] ?? {
          processed: 0,
          completed: 0,
          failed: 0,
          skipped: batch.originalSize - batch.items.length
        };
        batchStats[String(batch.number)] = stat;
        stat.processed += 1;
        processed += 1;
        const attempt = (failureCounts.get(item.itemId) ?? 0) + 1;
        try {
          const record = await processItem({
            item,
            batchNumber: batch.number,
            attempt,
            datasetFile,
            options,
            paths,
            deps,
            now
          });
          appendJsonLine(paths.batchPath(batch.number), record);
          completed.set(item.itemId, record);
          completedItemIds.add(item.itemId);
          completedPromptIndices.add(item.index);
          stat.completed += 1;
          persistCheckpoint();
          log(`Completed prompt ${item.index}.`);
        } catch (error) {
          failed += 1;
          stat.failed += 1;
          failureCounts.set(item.itemId, attempt);
          appendJsonLine(paths.failuresPath, {
            version: 1,
            item_id: item.itemId,
            prompt_index: item.index,
            batch_num: batch.number,
            attempt,
            timestamp: isoNow(now),
            error: boundedError(error)
          });
          persistCheckpoint();
          log(`Failed prompt ${item.index}: ${boundedError(error)}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const records = [...completed.values()].sort(compareTrajectoryRecords);
  const trajectoryText = records.map((record) => JSON.stringify(record)).join("\n");
  writeTextAtomic(
    paths.trajectoriesPath,
    trajectoryText ? `${trajectoryText}\n` : ""
  );
  const statistics = buildStatistics({
    records,
    options,
    datasetFile,
    datasetSize: annotated.length,
    processed,
    failed,
    skipped,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    now
  });
  writeJsonAtomic(paths.statisticsPath, statistics);
  persistCheckpoint();

  return {
    ok: failed === 0,
    exitCode: failed === 0 ? 0 : 1,
    runName: options.runName,
    outputDir: paths.runDir,
    datasetSize: annotated.length,
    processed,
    completed: records.length,
    failed,
    skipped,
    paths,
    statistics
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseBatchArgs(argv);
  const log = typeof deps.log === "function" ? deps.log : console.log;
  if (options.listDistributions) {
    for (const distribution of Object.values(BATCH_DISTRIBUTIONS)) {
      log(`${distribution.name}\t${distribution.description}`);
    }
    return {
      ok: true,
      exitCode: 0,
      distributions: Object.values(BATCH_DISTRIBUTIONS)
    };
  }
  const result = await runBatch(options, { ...deps, log });
  log(
    `Batch run ${result.runName}: ${result.completed} completed, `
    + `${result.failed} failed, ${result.skipped} skipped.`
  );
  log(`Results: ${result.outputDir}`);
  return result;
}

async function processItem({
  item,
  batchNumber,
  attempt,
  datasetFile,
  options,
  paths,
  deps,
  now
}) {
  const workspaceDir = resolveWorkspace(item.entry.cwd, path.dirname(datasetFile));
  const sessionDataDir = path.join(
    paths.sessionsDir,
    `${String(item.index).padStart(6, "0")}-${item.itemId.slice(5, 21)}`,
    `attempt-${attempt}`
  );
  ensureDir(sessionDataDir);
  const providerOptions = buildProviderOptions(options.model, sessionDataDir, deps.env);
  const provider = deps.modelProviderFactory
    ? await deps.modelProviderFactory(item.entry, {
        index: item.index,
        itemId: item.itemId,
        dataDir: sessionDataDir,
        workspaceDir,
        model: options.model,
        options: providerOptions
      })
    : createModelProvider(providerOptions);
  if (!provider || typeof provider.generate !== "function") {
    throw new Error(`Model provider factory returned no provider for prompt ${item.index}.`);
  }

  const runtimeFactory = deps.createRuntime ?? createDurableRuntime;
  const runtime = await runtimeFactory({
    dataDir: sessionDataDir,
    workspaceDir,
    modelProvider: provider,
    modelProviderOptions: providerOptions,
    autoConnectMcp: false
  });
  if (!runtime?.agentHost || typeof runtime.agentHost.handleMessage !== "function") {
    await closeRuntime(runtime);
    throw new Error(`Runtime factory returned no AgentHost for prompt ${item.index}.`);
  }
  runtime.agentHost.workspaceDir = workspaceDir;

  try {
    const result = await runtime.agentHost.handleMessage({
      channel: "batch",
      from: "dataset",
      agentId: "main",
      sessionId: `batch:${options.runName}:${item.itemId}:attempt:${attempt}`,
      text: item.entry.prompt,
      maxIterations: options.maxTurns,
      backgroundReview: false,
      metadata: {
        batchRun: options.runName,
        batchItemId: item.itemId,
        promptIndex: item.index,
        image: item.entry.image ?? null,
        dockerImage: item.entry.docker_image ?? null,
        cwd: item.entry.cwd ?? null
      }
    });
    const session = await readSession(runtime, result, item);
    const conversations = toShareGptTrajectory(session);
    if (conversations.length === 0) {
      conversations.push(
        { from: "human", value: item.entry.prompt },
        { from: "gpt", value: String(result?.reply ?? "") }
      );
    }
    const statsSession = session?.messages?.length
      ? session
      : {
          messages: [{
            role: "assistant",
            content: result?.reply ?? "",
            metadata: { toolCalls: result?.toolCalls ?? [] }
          }]
        };
    let toolStats = extractToolStats(statsSession);
    if (Object.keys(toolStats).length === 0 && Array.isArray(result?.toolCalls)) {
      toolStats = extractToolStats({
        messages: [{
          role: "assistant",
          content: result?.reply ?? "",
          metadata: { toolCalls: result.toolCalls }
        }]
      });
    }
    const reasoning = extractReasoningCoverage(statsSession);
    const stopReason = result?.model?.stopReason ?? null;
    return {
      prompt_index: item.index,
      item_id: item.itemId,
      conversations,
      metadata: {
        batch_num: batchNumber,
        attempt,
        timestamp: isoNow(now),
        run_name: options.runName,
        provider: result?.model?.provider ?? provider.provider ?? provider.name ?? null,
        model: result?.model?.model ?? provider.model ?? options.model ?? null,
        session_id: result?.session?.id ?? null,
        image: item.entry.image ?? null,
        docker_image: item.entry.docker_image ?? null,
        cwd: item.entry.cwd ?? null,
        resolved_cwd: workspaceDir
      },
      completed: true,
      partial: Boolean(stopReason && stopReason !== "completed"),
      api_calls: positiveOrDefault(result?.model?.iterations, 1),
      toolsets_used: [],
      tool_stats: toolStats,
      tool_error_counts: Object.fromEntries(
        Object.entries(toolStats).map(([name, stats]) => [name, stats.failure])
      ),
      reasoning_stats: reasoning,
      reasoning_coverage: reasoning
    };
  } finally {
    await closeRuntime(runtime);
  }
}

async function readSession(runtime, result, item) {
  const sessionId = result?.session?.id;
  if (!sessionId || typeof runtime.agentHost?.store?.getSession !== "function") {
    return {
      id: sessionId ?? null,
      messages: [
        { role: "user", content: item.entry.prompt },
        {
          role: "assistant",
          content: result?.reply ?? "",
          metadata: { toolCalls: result?.toolCalls ?? [] }
        }
      ]
    };
  }
  return runtime.agentHost.store.getSession(sessionId);
}

async function closeRuntime(runtime) {
  if (!runtime) return;
  for (const close of [
    () => runtime.mcp?.disconnectAll?.(),
    () => runtime.lspClient?.close?.(),
    () => runtime.kanban?.close?.(),
    async () => {
      await runtime.sessionIndex?.ready;
      await runtime.sessionIndex?.rebuildPromise;
      runtime.sessionIndex?.db?.close?.();
      if (runtime.sessionIndex) runtime.sessionIndex.db = null;
    },
    async () => {
      await runtime.observations?.ready;
      runtime.observations?.db?.close?.();
      if (runtime.observations) runtime.observations.db = null;
    }
  ]) {
    try {
      await close();
    } catch {
      // Item cleanup is best effort and must not replace the trajectory result.
    }
  }
}

function normalizeRunOptions(input) {
  const options = {
    datasetFile: input.datasetFile ?? input.dataset_file ?? null,
    batcmcpSize: input.batcmcpSize ?? input.batcmcp_size ?? null,
    runName: input.runName ?? input.run_name ?? null,
    model: input.model ?? null,
    numWorkers: input.numWorkers ?? input.num_workers ?? DEFAULT_NUM_WORKERS,
    maxTurns: input.maxTurns ?? input.max_turns ?? DEFAULT_MAX_TURNS,
    resume: input.resume === true,
    listDistributions: input.listDistributions ?? input.list_distributions ?? false,
    outputRoot: input.outputRoot
  };
  if (!options.datasetFile) throw new Error("datasetFile is required.");
  options.batcmcpSize = positiveInteger(options.batcmcpSize, "batcmcpSize");
  options.runName = validateRunName(options.runName);
  options.numWorkers = positiveInteger(options.numWorkers, "numWorkers");
  options.maxTurns = positiveInteger(options.maxTurns, "maxTurns");
  if (options.model !== null && (typeof options.model !== "string" || !options.model.trim())) {
    throw new Error("model must be a non-empty string when provided.");
  }
  return options;
}

function annotateDataset(dataset) {
  const occurrences = new Map();
  return dataset.map((entry, index) => {
    const base = stableJson({
      prompt: entry.prompt,
      image: entry.image ?? null,
      docker_image: entry.docker_image ?? null,
      cwd: entry.cwd ?? null
    });
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      index,
      entry,
      occurrence,
      itemId: createItemId(entry, occurrence)
    };
  });
}

function chunkAnnotated(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    const batchItems = items.slice(index, index + size);
    batches.push({
      number: batches.length,
      originalSize: batchItems.length,
      items: batchItems
    });
  }
  return batches;
}

function loadCompletedRecords(paths, log) {
  const records = new Map();
  if (!fs.existsSync(paths.runDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(paths.runDir);
  } catch {
    return [];
  }
  const batchFiles = entries
    .filter((name) => /^batch_\d+\.jsonl$/u.test(name))
    .sort((left, right) => batchNumber(left) - batchNumber(right));
  for (const filename of batchFiles) {
    const filePath = path.join(paths.runDir, filename);
    for (const value of readJsonLines(filePath, log)) {
      if (
        value?.completed === true
        && typeof value.item_id === "string"
        && value.item_id
      ) {
        records.set(value.item_id, value);
      }
    }
  }
  return [...records.values()];
}

function countFailures(filePath, log) {
  const counts = new Map();
  for (const value of readJsonLines(filePath, log)) {
    const itemId = String(value?.item_id ?? "");
    if (!itemId) continue;
    counts.set(itemId, Math.max(counts.get(itemId) ?? 0, Number(value.attempt) || 1));
  }
  return counts;
}

function readJsonLines(filePath, log) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const values = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      log(
        `Ignoring malformed JSONL record in ${filePath} at line ${index + 1}: `
        + `${error?.message ?? String(error)}`
      );
    }
  }
  return values;
}

function loadCheckpoint(filePath, log) {
  try {
    return readJsonFile(filePath, null);
  } catch (error) {
    log(`Ignoring unreadable checkpoint ${filePath}: ${error?.message ?? String(error)}`);
    return null;
  }
}

function normalizeBatchStats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, stats]) => [
      key,
      {
        processed: nonNegativeNumber(stats?.processed),
        completed: nonNegativeNumber(stats?.completed),
        failed: nonNegativeNumber(stats?.failed),
        skipped: nonNegativeNumber(stats?.skipped)
      }
    ])
  );
}

function runHasDurableState(paths) {
  if (!fs.existsSync(paths.runDir)) return false;
  try {
    return fs.readdirSync(paths.runDir).some((entry) => (
      /^batch_\d+\.jsonl$/u.test(entry)
      || [
        path.basename(paths.checkpointPath),
        path.basename(paths.statisticsPath),
        path.basename(paths.trajectoriesPath),
        path.basename(paths.failuresPath)
      ].includes(entry)
      || entry === path.basename(paths.sessionsDir)
    ));
  } catch {
    return true;
  }
}

function buildProviderOptions(modelValue, dataDir, env = process.env) {
  const raw = typeof modelValue === "string" ? modelValue.trim() : "";
  let preferred = null;
  let model = raw;
  const qualified = /^(anthropic|openai|moa)[/:](.+)$/iu.exec(raw);
  if (qualified) {
    preferred = qualified[1].toLowerCase();
    model = qualified[2];
  }
  return {
    dataDir,
    env,
    ...(preferred ? { preferred } : {}),
    ...(model
      ? {
          openai: { model },
          anthropic: { model },
          moa: { preset: model, model }
        }
      : {})
  };
}

function resolveWorkspace(value, datasetDir) {
  const workspaceDir = value
    ? path.resolve(datasetDir, value)
    : path.resolve(process.cwd());
  let stat;
  try {
    stat = fs.statSync(workspaceDir);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Working directory does not exist: ${workspaceDir}`);
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`Working directory is not a directory: ${workspaceDir}`);
  return workspaceDir;
}

function buildStatistics({
  records,
  options,
  datasetFile,
  datasetSize,
  processed,
  failed,
  skipped,
  durationMs,
  now
}) {
  const toolStats = {};
  let assistantTurns = 0;
  let reasoningTurns = 0;
  for (const record of records) {
    for (const [name, stats] of Object.entries(record.tool_stats ?? {})) {
      const aggregate = toolStats[name] ?? { count: 0, success: 0, failure: 0 };
      aggregate.count += nonNegativeNumber(stats.count);
      aggregate.success += nonNegativeNumber(stats.success);
      aggregate.failure += nonNegativeNumber(stats.failure);
      toolStats[name] = aggregate;
    }
    assistantTurns += nonNegativeNumber(record.reasoning_stats?.total_assistant_turns);
    reasoningTurns += nonNegativeNumber(record.reasoning_stats?.turns_with_reasoning);
  }
  for (const stats of Object.values(toolStats)) {
    stats.success_rate = stats.count > 0 ? stats.success / stats.count : 0;
    stats.failure_rate = stats.count > 0 ? stats.failure / stats.count : 0;
  }
  const reasoning = {
    total_assistant_turns: assistantTurns,
    turns_with_reasoning: reasoningTurns,
    turns_without_reasoning: assistantTurns - reasoningTurns,
    has_any_reasoning: reasoningTurns > 0,
    coverage: assistantTurns > 0 ? reasoningTurns / assistantTurns : 0
  };
  return {
    version: 1,
    run_name: options.runName,
    dataset_file: datasetFile,
    dataset_size: datasetSize,
    completed: records.length,
    processed,
    failed,
    skipped,
    num_workers: options.numWorkers,
    batcmcp_size: options.batcmcpSize,
    max_turns: options.maxTurns,
    model: options.model,
    duration_ms: durationMs,
    tool_stats: Object.fromEntries(
      Object.entries(toolStats).sort(([left], [right]) => left.localeCompare(right))
    ),
    reasoning_statistics: reasoning,
    updated_at: isoNow(now)
  };
}

function compareTrajectoryRecords(left, right) {
  const byIndex = Number(left?.prompt_index) - Number(right?.prompt_index);
  if (Number.isFinite(byIndex) && byIndex !== 0) return byIndex;
  return String(left?.item_id ?? "").localeCompare(String(right?.item_id ?? ""));
}

function batchNumber(filename) {
  return Number(/^batch_(\d+)\.jsonl$/u.exec(filename)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function messagesFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.messages)) return value.messages;
  return [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoNow(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error("now() must return a Date, timestamp, or date string.");
}

function validateRunName(value) {
  const runName = String(value ?? "").trim();
  if (
    runName.length > 64
    ||
    !RUN_NAME_RE.test(runName)
    || runName === "."
    || runName === ".."
  ) {
    throw new Error(
      "run_name must be at most 64 characters, contain only ASCII letters, digits, dots, underscores, and hyphens, and start with a letter or digit."
    );
  }
  return runName;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return number;
}

function positiveOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function boundedError(error) {
  return String(error?.message ?? error ?? "Unknown error")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 1000);
}

const directEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (directEntry === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (result) => {
      process.exitCode = result?.exitCode ?? 0;
    },
    (error) => {
      console.error(`Batch runner failed: ${boundedError(error)}`);
      process.exitCode = 1;
    }
  );
}

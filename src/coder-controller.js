import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CheckpointStore } from "./checkpoint-store.js";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { createId, nowIso } from "./utils.js";
import {
  acceptancePassed,
  createAcceptanceGraph,
  criteriaEqual,
  normalizeCheckIdentities,
  normalizeStoredGraph,
  recordVerificationEvidence,
  sourceRevisionForRun
} from "./acceptance-evidence.js";

const RUN_STATES = new Set([
  "planned",
  "editing",
  "verifying",
  "passed",
  "failed",
  "rolled_back",
  "blocked"
]);
const ACTIVE_STATES = new Set(["editing", "verifying"]);
const ROLLBACK_STATES = new Set(["passed", "failed", "blocked"]);
const MAX_RUNS = 500;
const MAX_FILES = 16;
const MAX_PLAN_STEPS = 24;
const MAX_OPERATIONS = 16;
const MAX_CHECKS = 16;
const MAX_CRITERIA = 32;
const MAX_TEXT = 2_000;
const MAX_TAIL = 2_000;
const RUN_ID_RE = /^coder_[a-f0-9]{16}$/;
const TAG_RE = /^[a-f0-9]{64}$/;
const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".openagi",
  "node_modules"
]);

export class CoderRunStore {
  constructor(options = {}) {
    this.dir = path.resolve(
      options.dir
      ?? path.join(options.dataDir ?? resolveDataDir(), "coder-runs")
    );
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    this.appendEvent = options.appendEvent ?? appendJsonLine;
    this.writeSnapshot = options.writeSnapshot ?? writeJsonAtomic;
    this.now = options.now ?? nowIso;
    this.runs = new Map();
    ensureDir(this.dir);
    this._load();
    this._reconcileInterrupted();
  }

  create(input) {
    const at = this.now();
    const run = normalizeRun({
      version: 1,
      id: input.id ?? createId("coder"),
      revision: 1,
      state: "planned",
      projectId: input.projectId ?? "default",
      sessionId: input.sessionId ?? null,
      workspaceRoot: input.workspaceRoot,
      objective: input.objective,
      plan: input.plan,
      files: input.files,
      checks: input.checks,
      acceptance: input.acceptance ?? createAcceptanceGraph({
        objective: input.objective,
        criteria: input.criteria,
        checks: input.checks,
        allowLegacy: input.criteria == null
      }),
      edits: [],
      verification: null,
      rollback: null,
      error: null,
      createdAt: at,
      updatedAt: at
    });
    if (!run) throw new TypeError("Coder run is invalid.");
    if (this.runs.has(run.id)) throw new Error(`Coder run already exists: ${run.id}`);
    this._commit("create", run);
    return clone(run);
  }

  update(id, expectedRevision, patch) {
    const current = this.runs.get(String(id));
    if (!current) throw new Error(`Unknown coder run: ${id}`);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Coder run revision conflict: expected ${expectedRevision}, found ${current.revision}.`
      );
    }
    if (
      patch?.acceptance?.criteria
      && !criteriaEqual(
        patch.acceptance.criteria,
        current.acceptance?.criteria
      )
    ) {
      throw new Error("Coder acceptance criteria are immutable after planning.");
    }
    const run = normalizeRun({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      version: current.version,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.now()
    });
    if (!run) throw new TypeError("Coder run transition is invalid.");
    this._commit("update", run);
    return clone(run);
  }

  get(id) {
    const run = this.runs.get(String(id));
    return run ? clone(run) : null;
  }

  list({ projectId, sessionId, limit = 50 } = {}) {
    return [...this.runs.values()]
      .filter((run) => projectId == null || run.projectId === String(projectId))
      .filter((run) => sessionId == null || run.sessionId === String(sessionId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)))
      .map(clone);
  }

  _commit(op, run) {
    const event = {
      version: 1,
      op,
      at: run.updatedAt,
      run
    };
    this.appendEvent(this.eventsPath, event);
    this.runs.set(run.id, clone(run));
    this._trim();
    try {
      this.writeSnapshot(this.snapshotPath, {
        version: 1,
        updatedAt: run.updatedAt,
        runs: [...this.runs.values()]
      });
    } catch {
      // The fsynced JSONL event remains authoritative.
    }
  }

  _load() {
    let snapshot = null;
    try {
      snapshot = readJsonFile(this.snapshotPath, null);
    } catch {
      snapshot = null;
    }
    for (const candidate of snapshot?.runs ?? []) this._install(candidate);
    let text = "";
    try {
      text = fs.readFileSync(this.eventsPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.version === 1 && ["create", "update"].includes(event.op)) {
          this._install(event.run);
        }
      } catch {
        // A partial trailing event cannot replace the last valid state.
      }
    }
    this._trim();
  }

  _install(candidate) {
    const run = normalizeRun(candidate);
    if (!run) return;
    const current = this.runs.get(run.id);
    if (!current || run.revision > current.revision) this.runs.set(run.id, run);
  }

  _trim() {
    if (this.runs.size <= MAX_RUNS) return;
    const retained = [...this.runs.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RUNS);
    this.runs = new Map(retained.map((run) => [run.id, run]));
  }

  _reconcileInterrupted() {
    for (const run of [...this.runs.values()]) {
      if (!ACTIVE_STATES.has(run.state)) continue;
      this.update(run.id, run.revision, {
        state: "blocked",
        error: {
          code: "controller_interrupted",
          message: "The coder process restarted during an active transaction; inspect exact file ownership before rollback."
        }
      });
    }
  }
}

export class CoderController {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
    this.store = options.store ?? new CoderRunStore({
      dataDir: options.dataDir
    });
    this.checkpoints = options.checkpoints
      ?? this.runtime?.checkpoints
      ?? new CheckpointStore({
        dataDir: options.dataDir,
        dir: path.join(
          options.dataDir ?? resolveDataDir(),
          "coder-runs",
          "checkpoints"
        ),
        workspaceDir: this.workspaceDir,
        enabled: true
      });
  }

  async start(args, context = {}) {
    const workspaceRoot = resolveWorkspaceRoot(context, this.workspaceDir);
    const projectId = projectIdentity(context);
    const sessionId = context?.sessionId == null ? null : String(context.sessionId);
    const objective = boundedText(args?.objective, "Coder objective", MAX_TEXT);
    const plan = normalizePlan(args?.plan);
    const checks = normalizeChecks(args?.checks);
    const acceptance = createAcceptanceGraph({
      objective,
      criteria: args?.criteria,
      checks
    });
    const requestedFiles = normalizeStartFiles(args?.files, workspaceRoot);
    const id = createId("coder");
    const files = [];

    for (let index = 0; index < requestedFiles.length; index += 1) {
      const file = requestedFiles[index];
      if (file.missing) {
        if (fs.existsSync(file.absolutePath)) {
          throw new Error(`Expected a missing file, but it now exists: ${file.path}`);
        }
      } else {
        const inspected = await this.runtime.tools.invoke(
          "code_read",
          { path: file.absolutePath },
          nestedContext(context, id)
        );
        if (!inspected.ok) {
          throw new Error(`Could not verify inspected baseline for ${file.path}: ${inspected.error}`);
        }
        if (inspected.result.tag !== file.tag) {
          throw new Error(
            `Stale inspected baseline for ${file.path}: expected ${file.tag}, found ${inspected.result.tag}.`
          );
        }
      }
      const [checkpoint] = this.checkpoints.capture({
        turnId: `${id}:${index + 1}`,
        sessionId,
        projectId,
        workspaceRoot,
        toolName: "coder_start",
        targets: [file.absolutePath],
        allowedRoots: [workspaceRoot]
      });
      if (!checkpoint?.id) {
        throw new Error(`Could not create a rollback checkpoint for ${file.path}.`);
      }
      files.push({
        path: file.path,
        tag: file.tag,
        missing: file.missing,
        checkpointId: checkpoint.id
      });
    }

    const run = this.store.create({
      id,
      projectId,
      sessionId,
      workspaceRoot,
      objective,
      plan,
      files,
      checks,
      acceptance
    });
    return publicRun(run);
  }

  async apply(args, context = {}) {
    let run = this._authorizedRun(args?.runId, context);
    const expectedRevision = requiredRevision(args?.expectedRevision);
    if (run.revision !== expectedRevision) {
      throw new Error(
        `Coder run revision conflict: expected ${expectedRevision}, found ${run.revision}.`
      );
    }
    if (run.state !== "planned") {
      throw new Error(`Coder run ${run.id} cannot apply edits from state '${run.state}'.`);
    }
    const operations = normalizeOperations(args?.operations, run);
    await this._assertBaselines(run, operations, context);
    run = this.store.update(run.id, run.revision, {
      state: "editing",
      error: null
    });

    for (const operation of operations) {
      if (context?.__abortSignal?.aborted) {
        return this._block(run, "turn_cancelled", "Turn ended before all coder edits completed.");
      }
      const invocation = await this.runtime.tools.invoke(
        operation.kind === "edit" ? "code_edit" : "code_write",
        operation.arguments,
        nestedContext(context, run.id)
      );
      if (!invocation.ok) {
        if (
          invocation.receipt?.dispatched === true
          && invocation.outcome?.changed === null
        ) {
          return this._block(
            run,
            "edit_completion_uncertain",
            `Edit completion is uncertain for ${operation.path}; inspect the file before recovery.`
          );
        }
        return this._handleFailure(
          run,
          context,
          `Edit failed for ${operation.path}: ${invocation.error}`,
          "edit_failed"
        );
      }
      const postTag = String(invocation.result?.tag ?? "").toLowerCase();
      if (!TAG_RE.test(postTag)) {
        return this._handleFailure(
          run,
          context,
          `Edit for ${operation.path} returned no trustworthy content tag.`,
          "edit_receipt_invalid"
        );
      }
      run = this.store.update(run.id, run.revision, {
        edits: [
          ...run.edits,
          {
            kind: operation.kind,
            path: operation.path,
            postTag,
            receipt: compactReceipt(invocation.receipt)
          }
        ]
      });
    }

    run = this.store.update(run.id, run.revision, {
      state: "verifying"
    });
    const sourceRevision = sourceRevisionForRun(run.files, run.edits);
    const verificationPhase = await this._verifyChecks(
      run,
      context,
      sourceRevision
    );
    const verification = verificationPhase.verification;
    const acceptance = recordVerificationEvidence({
      graph: run.acceptance,
      checks: run.checks,
      verification,
      sourceRevision,
      at: nowIso()
    });
    run = this.store.update(run.id, run.revision, {
      verification,
      acceptance
    });
    if (
      verificationPhase.ok
      && completeVerificationEvidence(verification, run.checks)
      && acceptancePassed(acceptance, sourceRevision)
    ) {
      run = this.store.update(run.id, run.revision, {
        state: "passed",
        error: null
      });
      return {
        ok: true,
        changed: run.edits.length > 0,
        rolledBack: false,
        run: publicRun(run)
      };
    }
    if (context?.__abortSignal?.aborted || verification?.status === "cancelled") {
      return this._block(
        run,
        "verification_cancelled",
        "Verification was cancelled after edits; inspect the owned file versions before recovery."
      );
    }
    return this._handleFailure(
      run,
      context,
      verificationPhase.error ?? "Required verification evidence did not pass.",
      "verification_failed"
    );
  }

  status(args, context = {}) {
    return publicRun(this._authorizedRun(args?.runId, context));
  }

  rollback(args, context = {}) {
    const run = this._authorizedRun(args?.runId, context);
    const expectedRevision = requiredRevision(args?.expectedRevision);
    if (run.revision !== expectedRevision) {
      throw new Error(
        `Coder run revision conflict: expected ${expectedRevision}, found ${run.revision}.`
      );
    }
    if (!ROLLBACK_STATES.has(run.state)) {
      throw new Error(`Coder run ${run.id} cannot roll back from state '${run.state}'.`);
    }
    if (context?.__abortSignal?.aborted) {
      throw new Error("Turn ended before coder rollback dispatch.");
    }
    const rolledBack = this._rollbackOwned(run, context, "tool:coder_rollback");
    return {
      ok: rolledBack.state === "rolled_back",
      changed: rolledBack.state === "rolled_back",
      run: publicRun(rolledBack)
    };
  }

  jobResources(args, context = {}) {
    const workspaceRoot = resolveWorkspaceRoot(context, this.workspaceDir);
    const candidates = Array.isArray(args?.operations)
      ? args.operations.map((operation) => operation?.path)
      : Array.isArray(args?.files)
        ? args.files.map((file) => file?.path)
        : [];
    const resources = [];
    for (const candidate of candidates) {
      try {
        const absolute = resolveCoderPath(workspaceRoot, candidate);
        const identity = process.platform === "win32"
          ? absolute.toLowerCase()
          : absolute;
        resources.push(
          `workspace/file/${createHash("sha256").update(identity).digest("hex")}`
        );
      } catch {
        return [];
      }
    }
    return [...new Set(resources)].sort();
  }

  async _verifyChecks(run, context, sourceRevision) {
    const startedAt = Date.now();
    const resultsById = new Map();
    const receipts = [];
    const codeChecks = run.checks.filter((check) => check.type !== "qa");
    let error = null;

    if (codeChecks.length > 0) {
      const invocation = await this.runtime.tools.invoke(
        "code_verify",
        { checks: codeChecks },
        nestedContext(context, run.id)
      );
      const codeVerification = compactVerification(
        invocation.result,
        invocation.receipt,
        codeChecks
      );
      for (const result of codeVerification.results) {
        resultsById.set(result.id, result);
      }
      if (codeVerification.receipt) receipts.push(codeVerification.receipt);
      if (
        !invocation.ok
        || !completeVerificationEvidence(codeVerification, codeChecks)
      ) {
        error = invocation.error ?? "Isolated code verification did not pass.";
        return combinedVerification({
          checks: run.checks,
          resultsById,
          receipts,
          startedAt,
          error,
          cancelled: codeVerification.status === "cancelled"
        });
      }
    }

    for (const check of run.checks.filter((candidate) => candidate.type === "qa")) {
      if (context?.__abortSignal?.aborted) {
        return combinedVerification({
          checks: run.checks,
          resultsById,
          receipts,
          startedAt,
          error: "QA verification was cancelled.",
          cancelled: true
        });
      }
      const invocation = await this.runtime.tools.invoke(
        "qa_run",
        {
          manifestPath: check.manifestPath,
          mode: check.mode,
          ...(check.routeIds ? { routeIds: check.routeIds } : {}),
          sourceRevision
        },
        nestedContext(context, run.id)
      );
      if (invocation.receipt) receipts.push(compactReceipt(invocation.receipt));
      const result = compactQaVerification(
        invocation,
        check,
        sourceRevision
      );
      resultsById.set(check.id, result);
      if (!result.ok && !error) {
        error = invocation.error
          ?? `QA check '${check.id}' did not pass.`;
      }
    }

    return combinedVerification({
      checks: run.checks,
      resultsById,
      receipts,
      startedAt,
      error,
      cancelled: false
    });
  }

  async _assertBaselines(run, operations, context) {
    const baselineByPath = new Map(run.files.map((file) => [file.path, file]));
    for (const operation of operations) {
      const baseline = baselineByPath.get(operation.path);
      const absolute = resolveCoderPath(run.workspaceRoot, operation.path);
      if (baseline.missing) {
        if (fs.existsSync(absolute)) {
          throw new Error(`Coder baseline lost: ${operation.path} was expected to be missing.`);
        }
        continue;
      }
      const inspected = await this.runtime.tools.invoke(
        "code_read",
        { path: absolute },
        nestedContext(context, run.id)
      );
      if (!inspected.ok || inspected.result?.tag !== baseline.tag) {
        throw new Error(`Coder baseline is stale for ${operation.path}; start a new run.`);
      }
    }
  }

  _handleFailure(run, context, message, code) {
    let current = this.store.update(run.id, run.revision, {
      state: "failed",
      error: {
        code,
        message: String(message).slice(0, MAX_TEXT)
      }
    });
    if (current.edits.length === 0) {
      return {
        ok: false,
        changed: false,
        rolledBack: false,
        error: current.error.message,
        run: publicRun(current)
      };
    }
    if (context?.__abortSignal?.aborted) {
      return this._block(
        current,
        "rollback_deferred_after_cancel",
        "Turn cancellation prevented automatic rollback; inspect exact file ownership before recovery."
      );
    }
    current = this._rollbackOwned(current, context, "coder:auto-rollback");
    return {
      ok: false,
      changed: current.state === "rolled_back" ? false : null,
      rolledBack: current.state === "rolled_back",
      error: current.error?.message ?? String(message).slice(0, MAX_TEXT),
      run: publicRun(current)
    };
  }

  _rollbackOwned(run, context, decidedBy) {
    const baselineByPath = new Map(run.files.map((file) => [file.path, file]));
    for (const edit of run.edits) {
      const absolute = resolveCoderPath(run.workspaceRoot, edit.path);
      const liveTag = currentTextTag(absolute);
      if (liveTag !== edit.postTag) {
        return this.store.update(run.id, run.revision, {
          state: "blocked",
          error: {
            code: "rollback_ownership_lost",
            message: `Automatic rollback refused because ${edit.path} no longer matches the controller-owned post-edit version.`
          }
        });
      }
    }

    const rollbackResults = [];
    let current = run;
    try {
      for (const edit of [...run.edits].reverse()) {
        const baseline = baselineByPath.get(edit.path);
        const result = this.checkpoints.rollback(baseline.checkpointId, {
          decidedBy,
          ...(run.sessionId == null ? {} : { sessionId: run.sessionId }),
          projectId: run.projectId
        });
        if (!result) throw new Error(`Checkpoint ${baseline.checkpointId} is unavailable.`);
        rollbackResults.push({
          path: edit.path,
          checkpointId: baseline.checkpointId,
          rollbackId: result.rollbackId
        });
      }
      for (const edit of run.edits) {
        const baseline = baselineByPath.get(edit.path);
        const absolute = resolveCoderPath(run.workspaceRoot, edit.path);
        if (baseline.missing) {
          if (fs.existsSync(absolute)) {
            throw new Error(`Rollback did not remove newly created file ${edit.path}.`);
          }
        } else if (currentTextTag(absolute) !== baseline.tag) {
          throw new Error(`Rollback did not restore the inspected baseline for ${edit.path}.`);
        }
      }
      current = this.store.update(run.id, run.revision, {
        state: "rolled_back",
        rollback: {
          status: "complete",
          at: nowIso(),
          results: rollbackResults
        }
      });
    } catch (error) {
      current = this.store.update(run.id, run.revision, {
        state: "blocked",
        rollback: {
          status: "failed",
          at: nowIso(),
          results: rollbackResults
        },
        error: {
          code: "rollback_failed",
          message: String(error?.message ?? error).slice(0, MAX_TEXT)
        }
      });
    }
    return current;
  }

  _block(run, code, message) {
    const current = this.store.update(run.id, run.revision, {
      state: "blocked",
      error: {
        code,
        message: String(message).slice(0, MAX_TEXT)
      }
    });
    return {
      ok: false,
      changed: current.edits.length > 0 ? null : false,
      rolledBack: false,
      error: current.error.message,
      run: publicRun(current)
    };
  }

  _authorizedRun(id, context) {
    const run = this.store.get(String(id ?? ""));
    if (!run) throw new Error(`Unknown coder run: ${id}`);
    if (run.projectId !== projectIdentity(context)) {
      throw new Error("Coder run is outside the current project.");
    }
    const sessionId = context?.sessionId == null ? null : String(context.sessionId);
    if (run.sessionId !== sessionId) {
      throw new Error("Coder run is outside the current session.");
    }
    const workspaceRoot = resolveWorkspaceRoot(context, this.workspaceDir);
    if (path.resolve(run.workspaceRoot) !== workspaceRoot) {
      throw new Error("Coder run workspace identity changed.");
    }
    return run;
  }
}

export function registerCoderTools(registry, runtime) {
  const controller = runtime?.coder;
  if (!controller) return [];
  const names = [];
  const register = (spec) => {
    registry.register(spec);
    names.push(spec.name);
  };

  register({
    name: "coder_start",
    description: "Start a durable coding transaction only after inspecting exact file SHA-256 tags. Declares the objective, immutable acceptance criteria, bounded plan, file baselines, and mandatory code or web-QA checks, then captures rollback checkpoints.",
    sideEffects: true,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: MAX_TEXT },
        files: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FILES,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              tag: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
              missing: { type: "boolean" }
            },
            required: ["path"],
            additionalProperties: false
          }
        },
        plan: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PLAN_STEPS,
          items: { type: "string", minLength: 1, maxLength: MAX_TEXT }
        },
        checks: verificationChecksSchema(),
        criteria: acceptanceCriteriaSchema()
      },
      required: ["objective", "files", "plan", "checks", "criteria"],
      additionalProperties: false
    },
    jobResources: (args, context) => controller.jobResources(args, context),
    jobResourceRevision: "coder-transaction-v1",
    handler: (args, context) => controller.start(args, context)
  });

  register({
    name: "coder_apply",
    description: "Apply a planned coder transaction with exact CAS edits/writes, then run mandatory isolated code checks and confirmed web-QA manifests. Any evidence failure rolls back only controller-owned post-edit versions; ownership conflicts fail closed.",
    sideEffects: true,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^coder_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: MAX_OPERATIONS,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["edit", "write"] },
              path: { type: "string", minLength: 1 },
              tag: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
              expectedTag: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
              edits: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    start: { type: "integer", minimum: 1 },
                    end: { type: "integer", minimum: 0 },
                    replace: { type: "string" }
                  },
                  required: ["start", "end", "replace"],
                  additionalProperties: false
                }
              },
              content: { type: "string" },
              summary: { type: "string", maxLength: 500 }
            },
            required: ["kind", "path"],
            additionalProperties: false
          }
        }
      },
      required: ["runId", "expectedRevision", "operations"],
      additionalProperties: false
    },
    jobResources: (args, context) => controller.jobResources(args, context),
    jobResourceRevision: "coder-transaction-v1",
    handler: (args, context) => controller.apply(args, context)
  });

  register({
    name: "coder_status",
    description: "Inspect one durable coder transaction, including its plan, edit receipts, verification evidence, rollback state, and current revision.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^coder_[a-f0-9]{16}$" }
      },
      required: ["runId"],
      additionalProperties: false
    },
    handler: (args, context) => controller.status(args, context)
  });

  register({
    name: "coder_rollback",
    description: "Human-confirmed recovery for a passed, failed, or blocked coder transaction. Rolls back only when every changed file still matches the exact controller-owned post-edit tag.",
    sideEffects: true,
    needsConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^coder_[a-f0-9]{16}$" },
        expectedRevision: { type: "integer", minimum: 1 }
      },
      required: ["runId", "expectedRevision"],
      additionalProperties: false
    },
    summarize: ({ runId }) => `Roll back coder transaction ${runId}`,
    handler: (args, context) => controller.rollback(args, context)
  });

  return names;
}

function normalizeRun(value) {
  if (
    !value
    || typeof value !== "object"
    || !RUN_ID_RE.test(String(value.id ?? ""))
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || !RUN_STATES.has(value.state)
    || !Array.isArray(value.files)
    || value.files.length < 1
    || value.files.length > MAX_FILES
    || !Array.isArray(value.plan)
    || !Array.isArray(value.checks)
    || !Array.isArray(value.edits)
  ) {
    return null;
  }
  try {
    const checks = normalizeCheckIdentities(value.checks);
    const acceptance = normalizeStoredGraph(value.acceptance, {
      objective: value.objective,
      checks
    });
    if (!acceptance) return null;
    return {
      ...clone(value),
      checks,
      acceptance
    };
  } catch {
    return null;
  }
}

function normalizePlan(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLAN_STEPS) {
    throw new TypeError(`Coder plan requires 1-${MAX_PLAN_STEPS} steps.`);
  }
  return value.map((step, index) => boundedText(
    step,
    `Coder plan step ${index + 1}`,
    MAX_TEXT
  ));
}

function normalizeChecks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw new TypeError(`Coder verification requires 1-${MAX_CHECKS} checks.`);
  }
  const identified = normalizeCheckIdentities(value);
  return identified.map((check, index) => {
    const type = String(check?.type ?? "").trim().toLowerCase();
    if (!["qa", "syntax", "test"].includes(type)) {
      throw new TypeError(`Coder check ${index + 1} has an invalid type.`);
    }
    const target = check?.path == null ? null : String(check.path).trim();
    if (type === "syntax" && !target) {
      throw new TypeError(`Coder syntax check ${index + 1} requires a path.`);
    }
    const manifestPath = check?.manifestPath == null
      ? null
      : String(check.manifestPath).trim();
    if (type === "qa" && !manifestPath) {
      throw new TypeError(`Coder QA check ${index + 1} requires a manifestPath.`);
    }
    if (type !== "qa" && manifestPath) {
      throw new TypeError(
        `Coder check ${index + 1} cannot carry a QA manifestPath.`
      );
    }
    const mode = check?.mode === "impacted" ? "impacted" : "full";
    if (
      check?.mode != null
      && !["full", "impacted"].includes(String(check.mode))
    ) {
      throw new TypeError(`Coder QA check ${index + 1} has an invalid mode.`);
    }
    const routeIds = check?.routeIds == null
      ? null
      : normalizeCheckRouteIds(check.routeIds, index);
    if (type !== "qa" && routeIds !== null) {
      throw new TypeError(`Coder check ${index + 1} cannot carry QA routeIds.`);
    }
    if (type === "qa" && target) {
      throw new TypeError(`Coder QA check ${index + 1} cannot carry path.`);
    }
    if (type === "qa" && mode === "impacted" && routeIds === null) {
      throw new TypeError(
        `Coder impacted QA check ${index + 1} requires routeIds.`
      );
    }
    const timeoutMs = check?.timeoutMs == null ? null : Number(check.timeoutMs);
    if (
      timeoutMs !== null
      && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    ) {
      throw new TypeError(`Coder check ${index + 1} has an invalid timeout.`);
    }
    if (type === "qa" && timeoutMs !== null) {
      throw new TypeError(
        `Coder QA check ${index + 1} uses manifest settle bounds, not timeoutMs.`
      );
    }
    return {
      id: check.id,
      type,
      ...(target ? { path: target } : {}),
      ...(manifestPath ? { manifestPath, mode } : {}),
      ...(routeIds === null ? {} : { routeIds }),
      ...(timeoutMs === null ? {} : { timeoutMs })
    };
  });
}

function normalizeCheckRouteIds(value, checkIndex) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new TypeError(
      `Coder QA check ${checkIndex + 1} requires 1-32 routeIds.`
    );
  }
  const ids = value.map((routeId) => String(routeId ?? ""));
  if (
    new Set(ids).size !== ids.length
    || ids.some((routeId) => !/^[a-z][a-z0-9_-]{0,63}$/.test(routeId))
  ) {
    throw new TypeError(
      `Coder QA check ${checkIndex + 1} has invalid routeIds.`
    );
  }
  return ids;
}

function normalizeStartFiles(value, workspaceRoot) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw new TypeError(`Coder transaction requires 1-${MAX_FILES} files.`);
  }
  const seen = new Set();
  return value.map((file, index) => {
    const absolutePath = resolveCoderPath(workspaceRoot, file?.path);
    const relative = relativeCoderPath(workspaceRoot, absolutePath);
    if (seen.has(relative)) throw new Error(`Duplicate coder file: ${relative}`);
    seen.add(relative);
    const missing = file?.missing === true;
    const tag = file?.tag == null ? null : String(file.tag).toLowerCase();
    if (missing === Boolean(tag)) {
      throw new TypeError(
        `Coder file ${index + 1} must provide exactly one of tag or missing=true.`
      );
    }
    if (tag && !TAG_RE.test(tag)) {
      throw new TypeError(`Coder file ${index + 1} has an invalid SHA-256 tag.`);
    }
    return {
      path: relative,
      absolutePath,
      tag,
      missing
    };
  });
}

function normalizeOperations(value, run) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPERATIONS) {
    throw new TypeError(`Coder apply requires 1-${MAX_OPERATIONS} operations.`);
  }
  const baselines = new Map(run.files.map((file) => [file.path, file]));
  const seen = new Set();
  return value.map((raw, index) => {
    const kind = String(raw?.kind ?? "").trim().toLowerCase();
    if (!["edit", "write"].includes(kind)) {
      throw new TypeError(`Coder operation ${index + 1} has an invalid kind.`);
    }
    const absolute = resolveCoderPath(run.workspaceRoot, raw?.path);
    const relative = relativeCoderPath(run.workspaceRoot, absolute);
    const baseline = baselines.get(relative);
    if (!baseline) throw new Error(`Coder operation is outside the inspected plan: ${relative}`);
    if (seen.has(relative)) throw new Error(`Coder apply allows one operation per file: ${relative}`);
    seen.add(relative);
    const summary = raw?.summary == null
      ? `Coder transaction ${run.id}`
      : String(raw.summary).slice(0, 500);

    if (kind === "edit") {
      if (baseline.missing) throw new Error(`Cannot line-edit missing file ${relative}.`);
      const tag = String(raw?.tag ?? "").toLowerCase();
      if (tag !== baseline.tag) {
        throw new Error(`Coder edit tag does not match the inspected baseline for ${relative}.`);
      }
      if (!Array.isArray(raw.edits) || raw.edits.length < 1) {
        throw new TypeError(`Coder edit ${index + 1} requires line edits.`);
      }
      return {
        kind,
        path: relative,
        arguments: {
          path: absolute,
          tag,
          edits: clone(raw.edits),
          summary
        }
      };
    }

    const expectedTag = raw?.expectedTag == null
      ? null
      : String(raw.expectedTag).toLowerCase();
    if (
      baseline.missing
        ? expectedTag !== null
        : expectedTag !== baseline.tag
    ) {
      throw new Error(`Coder write expectedTag does not match the inspected baseline for ${relative}.`);
    }
    if (typeof raw?.content !== "string") {
      throw new TypeError(`Coder write ${index + 1} requires string content.`);
    }
    return {
      kind,
      path: relative,
      arguments: {
        path: absolute,
        content: raw.content,
        ...(expectedTag ? { expectedTag } : {}),
        summary
      }
    };
  });
}

function verificationChecksSchema() {
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_CHECKS,
    items: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: "^[a-z][a-z0-9_-]{0,63}$"
        },
        type: { type: "string", enum: ["qa", "syntax", "test"] },
        path: { type: "string" },
        manifestPath: { type: "string", minLength: 1, maxLength: 1_024 },
        mode: { type: "string", enum: ["full", "impacted"] },
        routeIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,63}$"
          }
        },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 }
      },
      required: ["id", "type"],
      additionalProperties: false
    }
  };
}

function acceptanceCriteriaSchema() {
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_CRITERIA,
    items: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: "^[a-z][a-z0-9_-]{0,63}$"
        },
        statement: { type: "string", minLength: 1, maxLength: 1_000 },
        kind: {
          type: "string",
          enum: [
            "accessibility",
            "behavior",
            "compatibility",
            "performance",
            "security",
            "visual"
          ]
        },
        oracle: {
          type: "string",
          enum: [
            "accessibility",
            "browser",
            "human",
            "keyboard",
            "performance",
            "screenshot",
            "test",
            "visual"
          ]
        },
        required: { type: "boolean" },
        checkIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CHECKS,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,63}$"
          }
        },
        target: { type: "string", minLength: 1, maxLength: 500 },
        threshold: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 500 },
            { type: "number" },
            { type: "boolean" }
          ]
        }
      },
      required: ["id", "statement", "kind", "oracle", "checkIds"],
      additionalProperties: false
    }
  };
}

function resolveWorkspaceRoot(context, fallback) {
  const root = path.resolve(
    String(context?.__projectWorkspaceDir ?? fallback)
  );
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Coder workspace must be a real directory.");
  }
  return root;
}

function resolveCoderPath(workspaceRoot, value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0")) throw new TypeError("Coder file path is required.");
  const absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(workspaceRoot, raw);
  const relative = path.relative(workspaceRoot, absolute);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Coder file is outside the project workspace.");
  }
  const segments = relative.split(path.sep).filter(Boolean);
  if (
    segments.some((segment) => PROTECTED_SEGMENTS.has(segment))
    || path.basename(absolute).toLowerCase().startsWith(".env")
  ) {
    throw new Error("Coder file is inside a protected workspace path.");
  }
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      throw new Error("Coder files cannot be symbolic links.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return absolute;
}

function relativeCoderPath(root, absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function projectIdentity(context) {
  return String(context?.__projectId ?? "default").trim() || "default";
}

function nestedContext(context, runId) {
  const nested = {
    ...(context ?? {}),
    __coderRunId: runId
  };
  delete nested.__confirmed;
  delete nested.__approval;
  delete nested.__pendingActionId;
  return nested;
}

function currentTextTag(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return createHash("sha256")
      .update(fs.readFileSync(filePath, "utf8"), "utf8")
      .digest("hex");
  } catch {
    return null;
  }
}

function compactReceipt(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: String(value.id ?? "").slice(0, 200),
    tool: String(value.tool ?? "").slice(0, 128),
    status: String(value.status ?? "").slice(0, 32),
    code: String(value.code ?? "").slice(0, 80),
    dispatched: value.dispatched === true,
    changed: value.changed === true ? true : value.changed === false ? false : null
  };
}

function compactQaVerification(invocation, check, sourceRevision) {
  const payload = invocation?.result;
  const qaRun = payload?.run && typeof payload.run === "object"
    ? payload.run
    : null;
  const exactRevision = qaRun?.sourceRevision === sourceRevision;
  const runPassed = qaRun?.state === "passed"
    && payload?.ok === true
    && exactRevision;
  const screenshotRefs = uniqueQaArtifactRefs(
    qaRun?.results?.map((result) => result?.screenshotRef)
  );
  const artifactRefs = uniqueQaArtifactRefs([
    ...(qaRun?.artifacts ?? []),
    ...screenshotRefs
  ]);
  const qaResults = Array.isArray(qaRun?.results) ? qaRun.results : [];
  const accessibilityPassed = qaResults.length > 0
    && qaResults.every((result) => (
      result?.accessibility?.supported === true
      && result.accessibility.violations === 0
    ));
  const keyboardPassed = qaResults.length > 0
    && qaResults.every((result) => (
      result?.keyboard?.supported === true
      && result.keyboard.missing === 0
      && result.keyboard.focusVisibleFailures === 0
      && result.keyboard.trapped === false
    ));
  const visualPassed = qaResults.length > 0
    && qaResults.every((result) => result?.visual?.status === "matched");
  const receipt = compactReceipt(invocation?.receipt);
  const ok = invocation?.ok === true && runPassed;
  return {
    id: check.id,
    type: "qa",
    path: check.manifestPath,
    ok,
    code: ok
      ? "ok"
      : !exactRevision && qaRun
        ? "qa_source_revision_mismatch"
        : String(
            qaRun?.error?.code
            ?? invocation?.outcome?.code
            ?? "qa_failed"
          ).slice(0, 80),
    durationMs: Number.isSafeInteger(receipt?.durationMs)
      ? receipt.durationMs
      : 0,
    tail: String(
      qaRun?.error?.message
      ?? invocation?.error
      ?? ""
    ).slice(-MAX_TAIL),
    receiptId: receipt?.id ?? null,
    evidence: {
      qaRunId: /^qa_[a-f0-9]{16}$/.test(String(qaRun?.id ?? ""))
        ? qaRun.id
        : null,
      sourceRevision: exactRevision ? sourceRevision : null,
      browserPassed: runPassed,
      accessibilityPassed: runPassed && accessibilityPassed,
      keyboardPassed: runPassed && keyboardPassed,
      performancePassed: false,
      visualPassed: runPassed && visualPassed,
      screenshotRefs,
      artifactRefs
    }
  };
}

function combinedVerification({
  checks,
  resultsById,
  receipts,
  startedAt,
  error,
  cancelled
}) {
  const results = checks
    .map((check) => resultsById.get(check.id))
    .filter(Boolean);
  const passed = !cancelled
    && results.length === checks.length
    && results.every((result, index) => (
      result.ok === true
      && result.id === checks[index].id
      && result.type === checks[index].type
    ));
  const verification = {
    status: cancelled ? "cancelled" : passed ? "passed" : "failed",
    checksPlanned: checks.length,
    checksCompleted: results.length,
    durationMs: Date.now() - startedAt,
    results,
    receipt: receipts[0] ?? null,
    receipts: receipts.slice(0, MAX_CHECKS)
  };
  return {
    ok: passed,
    error: passed ? null : String(error ?? "Verification failed.").slice(0, MAX_TEXT),
    verification
  };
}

function uniqueQaArtifactRefs(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((ref) => /^qaart_[a-f0-9]{64}$/.test(String(ref ?? "")))
  )].slice(0, 100);
}

function compactVerification(value, receipt, checks = []) {
  if (!value || typeof value !== "object") {
    return {
      status: "failed",
      checksPlanned: 0,
      checksCompleted: 0,
      results: [],
      receipt: compactReceipt(receipt)
    };
  }
  return {
    status: ["passed", "failed", "cancelled"].includes(value.status)
      ? value.status
      : "failed",
    checksPlanned: Number.isSafeInteger(value.checksPlanned) ? value.checksPlanned : 0,
    checksCompleted: Number.isSafeInteger(value.checksCompleted) ? value.checksCompleted : 0,
    durationMs: Number.isSafeInteger(value.durationMs) ? value.durationMs : 0,
    results: Array.isArray(value.results)
      ? value.results.slice(0, MAX_CHECKS).map((result, index) => ({
          id: String(
            result?.id
            ?? checks[index]?.id
            ?? `check_${index + 1}`
          ).slice(0, 64),
          type: String(result?.type ?? "").slice(0, 32),
          path: result?.path == null ? null : String(result.path).slice(0, 500),
          ok: result?.ok === true,
          code: String(result?.code ?? "").slice(0, 80),
          durationMs: Number.isSafeInteger(result?.durationMs) ? result.durationMs : 0,
          tail: String(result?.tail ?? "").slice(-MAX_TAIL)
        }))
      : [],
    receipt: compactReceipt(receipt)
  };
}

function completeVerificationEvidence(verification, checks) {
  return verification?.status === "passed"
    && verification.checksPlanned === checks.length
    && verification.checksCompleted === checks.length
    && verification.results.length === checks.length
    && verification.results.every(
      (result, index) => result.ok === true
        && result.id === checks[index].id
        && result.type === checks[index].type
    );
}

function publicRun(run) {
  const { workspaceRoot: _workspaceRoot, ...visible } = clone(run);
  return visible;
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("Coder run expectedRevision must be a positive integer.");
  }
  return revision;
}

function boundedText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return text;
}

function clone(value) {
  return structuredClone(value);
}

export const CODER_CONTROLLER_LIMITS = Object.freeze({
  maxRuns: MAX_RUNS,
  maxFiles: MAX_FILES,
  maxPlanSteps: MAX_PLAN_STEPS,
  maxOperations: MAX_OPERATIONS,
  maxChecks: MAX_CHECKS,
  maxCriteria: MAX_CRITERIA
});

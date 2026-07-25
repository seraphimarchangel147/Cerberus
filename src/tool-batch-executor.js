export const TOOL_BATCH_MAX_CONCURRENCY = 4;

export async function executeToolBatch(entries, {
  toolRegistry,
  context = {},
  invoke,
  maxConcurrency = TOOL_BATCH_MAX_CONCURRENCY,
  barrierNames = []
} = {}) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Tool batch entries must be an array.");
  }
  if (typeof invoke !== "function") {
    throw new TypeError("Tool batch execution requires an invoke callback.");
  }
  const concurrency = boundedConcurrency(maxConcurrency);
  const barriers = new Set([...barrierNames].map(String));
  const plans = entries.map((entry, index) => classifyEntry(
    entry,
    index,
    toolRegistry,
    context,
    barriers
  ));
  const waves = buildExecutionWaves(plans, concurrency);
  const results = Array(entries.length);

  for (const wave of waves) {
    if (batchWasAborted(context)) {
      for (const plan of wave.entries) {
        results[plan.index] = {
          status: "rejected",
          reason: batchAbortError(),
          batch: {
            wave: wave.index,
            parallel: false,
            width: 0,
            classification: plan.kind,
            skipped: true
          }
        };
      }
      continue;
    }
    const settled = await Promise.allSettled(
      wave.entries.map((plan) => invoke(plan.entry, plan.index))
    );
    for (let offset = 0; offset < wave.entries.length; offset += 1) {
      const plan = wave.entries[offset];
      const result = settled[offset];
      results[plan.index] = {
        ...result,
        batch: {
          wave: wave.index,
          parallel: wave.entries.length > 1,
          width: wave.entries.length,
          classification: plan.kind
        }
      };
    }
  }

  return {
    results,
    waves: waves.map((wave) => ({
      index: wave.index,
      width: wave.entries.length,
      classification: wave.kind,
      entries: wave.entries.map((plan) => plan.index)
    }))
  };
}

function batchWasAborted(context) {
  try {
    return context?.__abortSignal?.aborted === true;
  } catch {
    return true;
  }
}

function batchAbortError() {
  const error = new Error("Tool batch cancelled before this wave was dispatched.");
  error.name = "AbortError";
  error.code = "TOOL_BATCH_CANCELLED";
  return error;
}

function classifyEntry(entry, index, toolRegistry, context, barrierNames) {
  const name = String(entry?.name ?? "");
  const args = entry?.args ?? {};
  const tool = toolRegistry?.get?.(name) ?? null;
  if (
    !tool
    || barrierNames.has(name)
    || tool.needsConfirmation
    || tool.manualApproval
  ) {
    return exclusivePlan(entry, index);
  }
  if (tool.sideEffects === false) {
    return {
      entry,
      index,
      kind: "read",
      exclusive: false,
      locks: []
    };
  }
  if (typeof tool.jobResources !== "function") {
    return exclusivePlan(entry, index);
  }
  try {
    const resolved = tool.jobResources(args, context);
    if (resolved && typeof resolved.then === "function") {
      return exclusivePlan(entry, index);
    }
    const locks = normalizeLocks(resolved);
    if (locks.length === 0) return exclusivePlan(entry, index);
    return {
      entry,
      index,
      kind: "mutation",
      exclusive: false,
      locks
    };
  } catch {
    return exclusivePlan(entry, index);
  }
}

function exclusivePlan(entry, index) {
  return {
    entry,
    index,
    kind: "exclusive",
    exclusive: true,
    locks: []
  };
}

function buildExecutionWaves(plans, maxConcurrency) {
  const waves = [];
  let current = [];
  let currentKind = null;

  const flush = () => {
    if (current.length === 0) return;
    waves.push({
      index: waves.length,
      kind: currentKind,
      entries: current
    });
    current = [];
    currentKind = null;
  };

  for (const plan of plans) {
    if (plan.exclusive) {
      flush();
      waves.push({
        index: waves.length,
        kind: plan.kind,
        entries: [plan]
      });
      continue;
    }
    const fitsKind = currentKind === null || currentKind === plan.kind;
    const fitsWidth = current.length < maxConcurrency;
    const conflict = plan.kind === "mutation"
      && current.some((candidate) => lockSetsConflict(candidate.locks, plan.locks));
    if (!fitsKind || !fitsWidth || conflict) flush();
    currentKind = plan.kind;
    current.push(plan);
  }
  flush();
  return waves;
}

function normalizeLocks(value) {
  if (!Array.isArray(value) || value.length > 32) return [];
  const locks = [];
  for (const item of value) {
    const raw = typeof item === "string" ? item : item?.resource;
    const resource = String(raw ?? "").trim().toLowerCase()
      .replaceAll("\\", "/")
      .replace(/\/+/gu, "/")
      .replace(/^\/|\/$/gu, "");
    if (
      !resource
      || resource.length > 192
      || !/^[a-z0-9][a-z0-9._:/-]*$/u.test(resource)
      || resource.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return [];
    }
    locks.push({
      resource,
      mode: typeof item === "object" && item?.mode === "read" ? "read" : "write"
    });
  }
  const deduped = new Map();
  for (const lock of locks) {
    const existing = deduped.get(lock.resource);
    if (!existing || lock.mode === "write") deduped.set(lock.resource, lock);
  }
  return [...deduped.values()].sort((left, right) => (
    left.resource.localeCompare(right.resource)
  ));
}

function lockSetsConflict(left, right) {
  return left.some((leftLock) => right.some((rightLock) => (
    (leftLock.mode === "write" || rightLock.mode === "write")
    && resourcesOverlap(leftLock.resource, rightLock.resource)
  )));
}

function resourcesOverlap(left, right) {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function boundedConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return TOOL_BATCH_MAX_CONCURRENCY;
  return Math.max(1, Math.min(TOOL_BATCH_MAX_CONCURRENCY, parsed));
}

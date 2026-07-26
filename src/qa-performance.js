import { createHash } from "node:crypto";

const TERMINAL_STATES = new Set([
  "passed",
  "failed",
  "cancelled",
  "blocked"
]);
const MAX_ARTIFACT_REFS = 2_000;
const MAX_SAFE_TOTAL = Number.MAX_SAFE_INTEGER;

export function buildQaPerformanceProof({ run, artifacts }) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new TypeError("QA performance proof requires a run.");
  }
  if (!artifacts || typeof artifacts.metadata !== "function") {
    throw new TypeError("QA performance proof requires an artifact store.");
  }

  const results = Array.isArray(run.results) ? run.results : [];
  const measured = aggregatePerformance(results);
  const artifactEvidence = aggregateArtifacts(run, artifacts);
  const summary = run.summary && typeof run.summary === "object"
    ? run.summary
    : {};
  const routeObservations = results.filter(
    (result) => result?.kind === "route"
  ).length;
  const semanticActions = measured.complete
    ? measured.semanticActions
    : safeTotal(
        results.filter((result) => result?.kind === "control").length,
        safeInteger(summary.explorationActions)
      );
  const visualOnlyCaptures = safeTotal(
    routeObservations,
    safeMultiply(semanticActions, 2)
  );
  const avoidedCaptures = Math.max(
    0,
    visualOnlyCaptures - measured.screenshotCaptures
  );
  const meanScreenshotBytes = measured.screenshotCaptures > 0
    ? Math.ceil(
        measured.screenshotBytes / measured.screenshotCaptures
      )
    : null;
  const visualOnlyBytesEstimate = meanScreenshotBytes == null
    ? null
    : safeMultiply(meanScreenshotBytes, visualOnlyCaptures);
  const meanScreenshotDurationMs = measured.screenshotCaptures > 0
    ? measured.screenshotDurationMs / measured.screenshotCaptures
    : null;
  const visualOnlyCaptureDurationEstimateMs =
    meanScreenshotDurationMs == null
      ? null
      : Math.ceil(meanScreenshotDurationMs * visualOnlyCaptures);
  const wallClockDurationMs = elapsedMs(run.createdAt, run.updatedAt);
  const terminal = TERMINAL_STATES.has(String(run.state ?? ""));
  const implementationPassed = run.state === "passed";
  const designPassed = run.comparison == null
    || run.comparison?.status === "passed";
  const explorationComplete = summary.explorationTruncated !== true;
  const failedChecks = safeInteger(summary.failed);
  const successfulTaskCompletion = terminal
    && implementationPassed
    && designPassed
    && failedChecks === 0
    && explorationComplete;
  const proof = {
    version: 1,
    runId: String(run.id ?? ""),
    sourceRevision: String(run.sourceRevision ?? ""),
    mode: String(run.mode ?? ""),
    qualified: successfulTaskCompletion
      && measured.complete
      && artifactEvidence.complete,
    qualification: {
      terminal,
      implementationPassed,
      designPassed,
      explorationComplete,
      measurementComplete: measured.complete,
      artifactEvidenceComplete: artifactEvidence.complete,
      successfulTaskCompletion
    },
    workload: {
      routes: safeInteger(summary.routes),
      controls: safeInteger(summary.controls),
      semanticActions,
      exploredStates: safeInteger(summary.exploredStates),
      exploredTransitions: safeInteger(summary.exploredTransitions),
      pageLoads: measured.pageLoads,
      deterministicReplayActions: measured.replayedSemanticActions
    },
    quality: {
      failedChecks,
      warnings: safeInteger(summary.warnings),
      failedTransitions: safeInteger(summary.failedTransitions),
      explorationTruncated: summary.explorationTruncated === true,
      keyboardFailures: safeInteger(summary.keyboardFailures),
      accessibilityViolations: results.reduce(
        (total, result) => safeTotal(
          total,
          safeInteger(result?.accessibility?.violations)
        ),
        0
      ),
      diagnosticErrors: results.reduce(
        (total, result) => safeTotal(
          total,
          safeInteger(result?.diagnostics?.errors)
        ),
        0
      ),
      visualChanges: safeInteger(summary.visualChanges),
      visualBaselinesMissing: safeInteger(
        summary.visualBaselinesMissing
      )
    },
    latency: {
      wallClockDurationMs,
      measuredResultDurationMs: measured.durationMs,
      screenshotCaptureDurationMs: measured.screenshotDurationMs,
      visualOnlyCaptureDurationEstimateMs,
      estimatedAvoidedCaptureLatencyMs:
        visualOnlyCaptureDurationEstimateMs == null
          ? null
          : Math.max(
              0,
              visualOnlyCaptureDurationEstimateMs
                - measured.screenshotDurationMs
            )
    },
    retries: {
      blindRetries: measured.blindRetries,
      deterministicReplayActions: measured.replayedSemanticActions
    },
    perception: {
      semanticFirst: {
        screenshotCaptures: measured.screenshotCaptures,
        screenshotBytes: measured.screenshotBytes,
        structuralArtifactBytes: artifactEvidence.structuralBytes,
        ownedArtifactBytes: artifactEvidence.totalBytes
      },
      screenshotOnlyCounterfactual: {
        methodology:
          "one fresh pre-action and one post-action capture, plus each route root",
        screenshotCaptures: visualOnlyCaptures,
        screenshotBytesEstimate: visualOnlyBytesEstimate
      },
      avoidedScreenshotCaptures: avoidedCaptures,
      captureReductionBps: ratioBps(
        avoidedCaptures,
        visualOnlyCaptures
      ),
      estimatedAvoidedScreenshotBytes:
        visualOnlyBytesEstimate == null
          ? null
          : Math.max(
              0,
              visualOnlyBytesEstimate - measured.screenshotBytes
            )
    },
    tokenEfficiency: {
      measurement: "byte_proxy_only",
      providerTokenCount: null,
      reason:
        "Provider and model image tokenization is not observable inside deterministic QA.",
      semanticStructuralBytes: artifactEvidence.structuralBytes,
      actualScreenshotBytes: measured.screenshotBytes,
      screenshotOnlyBytesEstimate: visualOnlyBytesEstimate
    }
  };
  return {
    ...proof,
    proofId: `qaperf_${digestCanonical(proof)}`
  };
}

function aggregatePerformance(results) {
  const totals = {
    complete: true,
    durationMs: 0,
    semanticActions: 0,
    pageLoads: 0,
    replayedSemanticActions: 0,
    blindRetries: 0,
    screenshotCaptures: 0,
    screenshotBytes: 0,
    screenshotDurationMs: 0
  };
  for (const result of results) {
    const performance = result?.performance;
    if (!performance || typeof performance !== "object") {
      totals.complete = false;
      continue;
    }
    for (const key of [
      "durationMs",
      "semanticActions",
      "pageLoads",
      "replayedSemanticActions",
      "blindRetries",
      "screenshotCaptures",
      "screenshotBytes",
      "screenshotDurationMs"
    ]) {
      if (!isSafeNonnegativeInteger(performance[key])) {
        totals.complete = false;
        continue;
      }
      totals[key] = safeTotal(totals[key], performance[key]);
    }
  }
  if (results.length < 1) totals.complete = false;
  return totals;
}

function aggregateArtifacts(run, artifacts) {
  const refs = [...new Set(
    Array.isArray(run.artifacts) ? run.artifacts.map(String) : []
  )];
  const evidence = {
    complete: refs.length <= MAX_ARTIFACT_REFS,
    totalBytes: 0,
    structuralBytes: 0
  };
  for (const ref of refs.slice(0, MAX_ARTIFACT_REFS)) {
    try {
      const metadata = artifacts.metadata(ref, {
        projectId: run.projectId,
        runId: run.id
      });
      evidence.totalBytes = safeTotal(
        evidence.totalBytes,
        safeInteger(metadata.bytes)
      );
      if (
        metadata.mediaType === "application/json"
        || metadata.mediaType === "text/plain"
      ) {
        evidence.structuralBytes = safeTotal(
          evidence.structuralBytes,
          safeInteger(metadata.bytes)
        );
      }
    } catch {
      evidence.complete = false;
    }
  }
  return evidence;
}

function elapsedMs(start, end) {
  const startMs = Date.parse(String(start ?? ""));
  const endMs = Date.parse(String(end ?? ""));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.min(MAX_SAFE_TOTAL, endMs - startMs));
}

function safeInteger(value) {
  return isSafeNonnegativeInteger(value) ? value : 0;
}

function isSafeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeMultiply(left, right) {
  if (!isSafeNonnegativeInteger(left) || !isSafeNonnegativeInteger(right)) {
    return 0;
  }
  if (left === 0 || right === 0) return 0;
  return Math.min(MAX_SAFE_TOTAL, left * right);
}

function safeTotal(left, right) {
  return Math.min(
    MAX_SAFE_TOTAL,
    safeInteger(left) + safeInteger(right)
  );
}

function ratioBps(numerator, denominator) {
  if (denominator < 1) return 0;
  return Math.min(
    10_000,
    Math.floor((numerator * 10_000) / denominator)
  );
}

function digestCanonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortValue(value[key]);
  }
  return output;
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  createSemanticBrowserService,
  validateQaNavigationUrl
} from "./semantic-browser.js";
import { sanitizeForAudit } from "./redact.js";
import {
  QaArtifactStore,
  QaBaselineStore,
  QaRunStore
} from "./qa-store.js";
import {
  normalizeExplorationPolicy,
  UiStateExplorer
} from "./ui-state-explorer.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const RUN_ID_RE = /^qa_[a-f0-9]{16}$/;
const ASCII_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);
const ACTION_REQUIRED_ROLES = new Set([
  "button",
  "checkbox",
  "link",
  "menuitem",
  "radio",
  "switch",
  "tab"
]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILES = 256;
const MAX_ROUTES = 32;
const MAX_CONTROLS = 200;
const MAX_VIEWPORTS = 4;
const MAX_TEXT_ASSERTIONS = 32;
const MAX_RESULTS = 500;
const MAX_VISUAL_PIXELS = 20_000_000;

export function webQaEnabled(env = process.env) {
  const value = String(env?.OPENAGI_WEB_QA ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(value);
}

export class WebQaController {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
    this.browser = options.browser ?? createSemanticBrowserService({
      projects: options.projects ?? this.runtime?.projects,
      secrets: options.secrets ?? this.runtime?.secrets,
      env: options.env ?? process.env,
      adapter: options.adapter,
      adapterFactory: options.adapterFactory,
      dnsLookup: options.dnsLookup,
      headless: options.headless
    });
    this.ownsBrowser = options.browser == null;
    this.store = options.store ?? new QaRunStore({
      dataDir: options.dataDir
    });
    this.artifacts = options.artifacts ?? new QaArtifactStore({
      dataDir: options.dataDir
    });
    this.explorer = options.explorer ?? new UiStateExplorer({
      browser: this.browser,
      artifacts: this.artifacts
    });
    this.baselines = options.baselines ?? new QaBaselineStore({
      dir: path.join(this.store.dir, "baselines")
    });
  }

  async run(args = {}, context = {}) {
    const scope = qaScope(context, this.workspaceDir);
    assertApproved(scope);
    this.artifacts.prune();
    const loaded = loadManifest(
      args.manifestPath ?? "qa-manifest.json",
      scope.workspaceRoot
    );
    await validateQaNavigationUrl(loaded.manifest.baseUrl, {
      dnsLookup: this.browser.dnsLookup
    });
    const sourceRevision = args.sourceRevision == null
      ? workspaceSourceRevision(
          scope.workspaceRoot,
          loaded.manifest.sourceFiles,
          loaded.digest
        )
      : requiredSha256(args.sourceRevision, "QA source revision");
    const mode = normalizeQaMode(args.mode);
    const selectedRoutes = selectRoutes(
      loaded.manifest.routes,
      args.routeIds,
      mode
    );
    const totalResults = mode === "explore"
      ? loaded.manifest.viewports.length * selectedRoutes.length * 2
      : loaded.manifest.viewports.length
        * selectedRoutes.reduce(
          (total, route) => total + 1 + route.controls.filter(
            (control) => control.action !== "inspect"
          ).length,
          0
        );
    let run = this.store.create({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      workspaceRoot: scope.workspaceRoot,
      sourceRevision,
      manifest: {
        version: loaded.manifest.version,
        path: loaded.path,
        digest: loaded.digest,
        title: loaded.manifest.title,
        routeIds: selectedRoutes.map((route) => route.id),
        viewports: loaded.manifest.viewports,
        exploration: loaded.manifest.exploration
      },
      mode
    });
    this._emit(run);
    run = this.store.update(run.id, run.revision, {
      state: "running"
    });
    this._emit(run);

    try {
      const results = [];
      const artifactRefs = new Set();
      for (const viewport of loaded.manifest.viewports) {
        for (const route of selectedRoutes) {
          if (scope.abortSignal?.aborted) {
            run = this.store.update(run.id, run.revision, {
              state: "cancelled",
              results,
              artifacts: [...artifactRefs],
              summary: summarizeResults(results),
              error: {
                code: "qa_cancelled",
                message: "QA was cancelled before all declared surfaces ran."
              }
            });
            this._emit(run);
            return qaRunResult(run);
          }

          const baseline = await this._exercisePage({
            run,
            scope,
            manifest: loaded.manifest,
            route,
            viewport,
            control: null
          });
          results.push(baseline);
          for (const ref of baseline.artifacts) artifactRefs.add(ref);
          this._emitProgress(run, baseline, results.length, totalResults);

          if (mode === "explore") {
            const exploration = await this.explorer.explore({
              run,
              qaContext: qaBrowserContext(scope, run.id),
              route,
              viewport,
              url: routeUrl(loaded.manifest.baseUrl, route.path),
              policy: loaded.manifest.exploration,
              fixture: loaded.manifest.fixture,
              rootScreenshotRef: baseline.screenshotRef,
              abortSignal: scope.abortSignal
            });
            results.push(exploration);
            for (const ref of exploration.artifacts) artifactRefs.add(ref);
            this._emitProgress(
              run,
              exploration,
              results.length,
              totalResults
            );
            if (scope.abortSignal?.aborted) {
              run = this.store.update(run.id, run.revision, {
                state: "cancelled",
                results,
                artifacts: [...artifactRefs],
                summary: summarizeResults(results),
                error: {
                  code: "qa_cancelled",
                  message: "QA was cancelled during state exploration."
                }
              });
              this._emit(run);
              return qaRunResult(run);
            }
            continue;
          }

          for (const control of route.controls) {
            if (control.action === "inspect") continue;
            if (results.length >= MAX_RESULTS) {
              throw new Error("QA result bound exceeded.");
            }
            const result = await this._exercisePage({
              run,
              scope,
              manifest: loaded.manifest,
              route,
              viewport,
              control
            });
            results.push(result);
            for (const ref of result.artifacts) artifactRefs.add(ref);
            this._emitProgress(run, result, results.length, totalResults);
          }
        }
      }
      const summary = summarizeResults(results);
      run = this.store.update(run.id, run.revision, {
        state: summary.failed === 0 ? "passed" : "failed",
        results,
        artifacts: [...artifactRefs],
        summary,
        error: summary.failed === 0
          ? null
          : {
              code: "qa_evidence_failed",
              message: `${summary.failed} QA evidence checks failed.`
            }
      });
    } catch (error) {
      run = this.store.update(run.id, run.revision, {
        state: scope.abortSignal?.aborted ? "cancelled" : "failed",
        error: {
          code: scope.abortSignal?.aborted
            ? "qa_cancelled"
            : "qa_execution_failed",
          message: boundedError(error)
        }
      });
    } finally {
      await this.browser.close({}, qaBrowserContext(scope, run.id))
        .catch(() => {});
    }
    this._emit(run);
    return qaRunResult(run);
  }

  status(args = {}, context = {}) {
    const scope = qaScope(context, this.workspaceDir);
    return publicRun(this._authorizedRun(args.runId, scope));
  }

  artifact(args = {}, context = {}) {
    const scope = qaScope(context, this.workspaceDir);
    const run = this._authorizedRun(args.runId, scope);
    const result = this.artifacts.read(args.ref, {
      projectId: scope.projectId,
      runId: run.id,
      includeData: args.includeData === true
    });
    if (
      result.encoding === "base64"
      && result.mediaType.startsWith("image/")
    ) {
      result.untrusted = true;
      result.trust = "untrusted-page-content";
      result.image = {
        mediaType: result.mediaType,
        data: result.data
      };
      delete result.data;
      delete result.encoding;
    }
    return result;
  }

  approveBaselines(args = {}, context = {}) {
    const scope = qaScope(context, this.workspaceDir);
    assertManualApproval(scope);
    const run = this._authorizedRun(args.runId, scope);
    if (!baselineEligibleRun(run)) {
      throw new Error(
        "Visual baselines require a passing run or one blocked only by missing baselines."
      );
    }
    const selected = selectResultIds(run.results, args.resultIds);
    const approvalId = String(scope.__pendingActionId ?? "");
    const approved = [];
    for (const result of selected) {
      if (!result.screenshotRef) {
        throw new Error(`QA result '${result.id}' has no screenshot evidence.`);
      }
      this.artifacts.metadata(result.screenshotRef, {
        projectId: scope.projectId,
        runId: run.id
      });
      const baseline = this.baselines.approve({
        projectId: scope.projectId,
        manifestDigest: run.manifest.digest,
        resultId: result.id,
        screenshotRef: result.screenshotRef,
        sourceRevision: run.sourceRevision,
        runId: run.id,
        approvalId
      });
      this.artifacts.retain(result.screenshotRef, {
        projectId: scope.projectId,
        runId: run.id,
        kind: `baseline_${safeCode(result.id)}`.slice(0, 64),
        retention: "baseline"
      });
      approved.push(baseline);
    }
    return {
      ok: true,
      runId: run.id,
      sourceRevision: run.sourceRevision,
      approved
    };
  }

  list(args = {}, context = {}) {
    const scope = qaScope(context, this.workspaceDir);
    return this.store
      .list({
        projectId: scope.projectId,
        sessionId: args.allSessions === true ? undefined : scope.sessionId,
        limit: args.limit
      })
      .map(publicRun);
  }

  async close() {
    if (this.ownsBrowser) await this.browser.closeAll?.();
  }

  async _exercisePage({
    run,
    scope,
    manifest,
    route,
    viewport,
    control
  }) {
    const failures = [];
    const warnings = [];
    const artifactRefs = [];
    const pageId = control == null
      ? `${route.id}_${viewport.id}`
      : `${route.id}_${viewport.id}_${control.id}`;
    const url = routeUrl(manifest.baseUrl, route.path);
    const qaContext = qaBrowserContext(scope, run.id);
    let traceStopped = false;
    let diagnostics = { supported: false, events: [] };
    let accessibility = {
      supported: false,
      violations: [],
      incomplete: []
    };
    let keyboard = {
      supported: false,
      total: 0,
      visited: 0,
      missing: [],
      focusVisibleFailures: [],
      trapped: false
    };
    let visual = {
      mode: route.visual.mode,
      status: route.visual.mode === "off" ? "off" : "missing",
      baselineRef: null,
      actualRef: null,
      diffRef: null,
      diffPixels: null,
      diffRatio: null,
      maxDiffRatio: route.visual.maxDiffRatio
    };
    let coverage = null;
    let screenshotRef = null;
    let diagnosticsRef = null;
    let traceRef = null;

    try {
      await this.browser.openForQa({
        url,
        viewport,
        trace: true
      }, qaContext);
      let state = await this.browser.waitForQaSettled({
        timeoutMs: route.settleTimeoutMs
      }, qaContext);
      let snapshot = await this.browser.inspect({
        maxNodes: 500
      }, qaContext);

      if (control == null) {
        coverage = evaluateControlCoverage(snapshot.nodes, route);
        failures.push(...coverage.failures);
        evaluateAssertions(route.assertions, state, snapshot, failures);
      } else {
        const matched = findControl(snapshot.nodes, control);
        if (!matched) {
          failures.push(failure(
            "control_missing",
            `Declared control '${control.id}' was not found.`
          ));
        } else if (matched.disabled) {
          failures.push(failure(
            "control_disabled",
            `Declared control '${control.id}' is disabled.`
          ));
        } else {
          await performControlAction(
            this.browser,
            matched,
            control,
            qaContext
          );
          state = await this.browser.waitForQaSettled({
            timeoutMs: route.settleTimeoutMs
          }, qaContext);
          snapshot = await this.browser.inspect({
            maxNodes: 500
          }, qaContext);
          evaluateAssertions(control.expect, state, snapshot, failures);
        }
      }

      if (state.readyState === "loading") {
        failures.push(failure(
          "page_not_ready",
          "The page remained in the loading readyState."
        ));
      }
      if (state.busyCount > 0) {
        failures.push(failure(
          "stuck_busy_state",
          `${state.busyCount} loading or busy indicators remained after settling.`
        ));
      }

      diagnostics = sanitizeDiagnostics(
        await this.browser.qaDiagnostics({}, qaContext)
      );
      for (const event of diagnostics.events) {
        if (event.severity === "error") {
          failures.push(failure(
            `diagnostic_${event.kind}`,
            diagnosticMessage(event)
          ));
        } else {
          warnings.push({
            code: `diagnostic_${event.kind}`,
            message: diagnosticMessage(event)
          });
        }
      }
      if (route.failOnWarnings && warnings.length > 0) {
        failures.push(...warnings.map((warning) => failure(
          warning.code,
          warning.message
        )));
      }

      if (route.accessibility !== "off") {
        accessibility = sanitizeForAudit(
          await this.browser.qaAccessibility({}, qaContext)
        );
        if (accessibility.supported !== true) {
          failures.push(failure(
            "accessibility_unavailable",
            "Strict accessibility evidence is unavailable."
          ));
        } else if (accessibility.violations.length > 0) {
          for (const violation of accessibility.violations) {
            failures.push(failure(
              `a11y_${safeCode(violation.id)}`,
              `${violation.impact ?? "unknown"}: ${violation.help ?? violation.description}`
            ));
          }
        }
        if (accessibility.incomplete.length > 0) {
          warnings.push({
            code: "accessibility_incomplete",
            message: `${accessibility.incomplete.length} accessibility checks require review.`
          });
        }
      }

      if (route.keyboard !== "off") {
        keyboard = sanitizeKeyboard(
          await this.browser.qaKeyboardAudit({}, qaContext)
        );
        if (keyboard.supported !== true) {
          failures.push(failure(
            "keyboard_audit_unavailable",
            "Strict keyboard-navigation evidence is unavailable."
          ));
        } else {
          if (keyboard.trapped) {
            failures.push(failure(
              "keyboard_focus_trap",
              "Keyboard focus repeated without advancing through the page."
            ));
          }
          for (const item of keyboard.missing) {
            failures.push(failure(
              "keyboard_control_unreachable",
              `${item.role} '${item.name || "unnamed"}' was not reachable with Tab.`
            ));
          }
          for (const item of keyboard.focusVisibleFailures) {
            failures.push(failure(
              "keyboard_focus_not_visible",
              `${item.role} '${item.name || "unnamed"}' had no visible focus indicator.`
            ));
          }
        }
      }

      const screenshot = await this.browser.screenshot({
        fullPage: route.fullPageScreenshot
      }, qaContext);
      const screenshotBytes = Buffer.from(screenshot.image.data, "base64");
      const screenshotArtifact = this.artifacts.put(
        screenshotBytes,
        {
          projectId: run.projectId,
          runId: run.id,
          kind: control == null
            ? "route_screenshot"
            : "control_screenshot",
          mediaType: screenshot.image.mediaType,
          retention: failures.length > 0 ? "failure" : "success"
        }
      );
      artifactRefs.push(screenshotArtifact.ref);
      screenshotRef = screenshotArtifact.ref;
      visual.actualRef = screenshotArtifact.ref;

      if (route.visual.mode !== "off") {
        const baseline = this.baselines.get({
          projectId: run.projectId,
          manifestDigest: run.manifest.digest,
          resultId: pageId
        });
        if (!baseline) {
          const missing = failure(
            "visual_baseline_missing",
            `No human-approved visual baseline exists for '${pageId}'.`
          );
          if (route.visual.mode === "strict") {
            failures.push(missing);
            this.artifacts.retain(screenshotArtifact.ref, {
              projectId: run.projectId,
              runId: run.id,
              kind: "missing_visual_baseline",
              retention: "failure"
            });
          } else {
            warnings.push(missing);
          }
        } else {
          visual.baselineRef = baseline.screenshotRef;
          const expected = this.artifacts.read(baseline.screenshotRef, {
            projectId: run.projectId,
            includeData: true
          });
          const comparison = comparePngScreenshots(
            Buffer.from(expected.data, expected.encoding),
            screenshotBytes,
            route.visual.maxDiffRatio
          );
          visual = {
            ...visual,
            ...comparison,
            status: comparison.passed ? "matched" : "changed"
          };
          if (comparison.diff) {
            const diffArtifact = this.artifacts.put(comparison.diff, {
              projectId: run.projectId,
              runId: run.id,
              kind: "visual_diff",
              mediaType: "image/png",
              retention: "failure"
            });
            artifactRefs.push(diffArtifact.ref);
            visual.diffRef = diffArtifact.ref;
          }
          delete visual.diff;
          delete visual.passed;
          if (!comparison.passed) {
            failures.push(failure(
              comparison.sizeChanged
                ? "visual_size_changed"
                : "visual_regression",
              comparison.sizeChanged
                ? `Visual dimensions changed for '${pageId}'.`
                : `Visual difference ${formatRatio(comparison.diffRatio)} exceeds ${formatRatio(route.visual.maxDiffRatio)} for '${pageId}'.`
            ));
            this.artifacts.retain(screenshotArtifact.ref, {
              projectId: run.projectId,
              runId: run.id,
              kind: "failed_visual_actual",
              retention: "failure"
            });
          }
        }
      }

      if (
        diagnostics.events.length > 0
        || accessibility.violations.length > 0
        || accessibility.incomplete.length > 0
      ) {
        const diagnosticsArtifact = this.artifacts.put(
          Buffer.from(JSON.stringify({
            diagnostics,
            accessibility
          }), "utf8"),
          {
            projectId: run.projectId,
            runId: run.id,
            kind: "qa_diagnostics",
            mediaType: "application/json",
            retention: failures.length > 0 ? "failure" : "success"
          }
        );
        artifactRefs.push(diagnosticsArtifact.ref);
        diagnosticsRef = diagnosticsArtifact.ref;
      }
    } catch (error) {
      failures.push(failure("page_execution_failed", boundedError(error)));
    } finally {
      try {
        const trace = await this.browser.stopQaTrace({
          retain: failures.length > 0
        }, qaContext);
        traceStopped = true;
        if (trace?.data) {
          const traceArtifact = this.artifacts.put(
            Buffer.from(trace.data, "base64"),
            {
              projectId: run.projectId,
              runId: run.id,
              kind: "playwright_trace",
              mediaType: trace.mediaType ?? "application/zip",
              retention: "failure"
            }
          );
          artifactRefs.push(traceArtifact.ref);
          traceRef = traceArtifact.ref;
        }
      } catch (error) {
        failures.push(failure("trace_capture_failed", boundedError(error)));
      }
      if (!traceStopped) {
        await this.browser.stopQaTrace({ retain: false }, qaContext)
          .catch(() => {});
      }
      await this.browser.close({}, qaContext).catch(() => {});
    }

    return {
      id: pageId,
      kind: control == null ? "route" : "control",
      routeId: route.id,
      viewport: {
        id: viewport.id,
        width: viewport.width,
        height: viewport.height
      },
      ...(control == null ? {} : { controlId: control.id }),
      status: failures.length > 0 ? "failed" : "passed",
      failures,
      warnings,
      coverage: coverage == null
        ? null
        : {
            discovered: coverage.discovered,
            covered: coverage.covered,
            exempted: coverage.exempted
          },
      diagnostics: {
        events: diagnostics.events.length,
        errors: diagnostics.events.filter(
          (event) => event.severity === "error"
        ).length
      },
      accessibility: {
        supported: accessibility.supported === true,
        violations: accessibility.violations.length,
        incomplete: accessibility.incomplete.length
      },
      keyboard: {
        supported: keyboard.supported === true,
        total: keyboard.total,
        visited: keyboard.visited,
        missing: keyboard.missing.length,
        focusVisibleFailures: keyboard.focusVisibleFailures.length,
        trapped: keyboard.trapped
      },
      visual,
      artifacts: artifactRefs,
      screenshotRef,
      diagnosticsRef,
      traceRef
    };
  }

  _authorizedRun(id, scope) {
    const run = this.store.get(String(id ?? ""));
    if (!run) throw new Error(`Unknown QA run: ${id}`);
    if (
      run.projectId !== scope.projectId
      || run.sessionId !== scope.sessionId
      || path.resolve(run.workspaceRoot) !== scope.workspaceRoot
    ) {
      throw new Error("QA run is outside the current project session.");
    }
    return run;
  }

  _emit(run) {
    const event = {
      id: run.id,
      revision: run.revision,
      state: run.state,
      projectId: run.projectId,
      sessionId: run.sessionId,
      sourceRevision: run.sourceRevision,
      summary: run.summary,
      error: run.error,
      updatedAt: run.updatedAt
    };
    try {
      this.runtime?.runInspector?.recordQa?.(event);
    } catch {
      // Operational visibility is advisory and cannot break a QA run.
    }
    this.runtime?.events?.emit?.("qa-run", event);
  }

  _emitProgress(run, result, completed, total) {
    const event = {
      id: run.id,
      revision: run.revision,
      state: "running",
      projectId: run.projectId,
      sessionId: run.sessionId,
      sourceRevision: run.sourceRevision,
      completed,
      total,
      result: {
        id: result.id,
        kind: result.kind,
        routeId: result.routeId,
        controlId: result.controlId ?? null,
        viewport: result.viewport,
        status: result.status,
        exploration: result.exploration ?? null
      },
      updatedAt: new Date().toISOString()
    };
    try {
      this.runtime?.runInspector?.recordQa?.(event);
    } catch {
      // Operational visibility is advisory and cannot break a QA run.
    }
    this.runtime?.events?.emit?.("qa-run", event);
  }
}

export function registerWebQaTools(registry, runtime) {
  const controller = runtime?.webQa;
  if (!controller) return [];
  const names = [];
  const register = (spec) => {
    registry.register(spec);
    names.push(spec.name);
  };

  register({
    name: "qa_run",
    description: "Run a project QA manifest in an isolated browser. Full and impacted modes prove declared controls; explore mode performs bounded breadth-first semantic state exploration. Every mode checks deterministic expectations, accessibility, keyboard use, diagnostics, loading state, and screenshots, with replay and trace evidence for failures.",
    sideEffects: true,
    needsConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        manifestPath: {
          type: "string",
          description: "Project-relative JSON manifest path. Default: qa-manifest.json."
        },
        mode: {
          type: "string",
          enum: ["full", "impacted", "explore"]
        },
        routeIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ROUTES,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,63}$"
          }
        },
        sourceRevision: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Optional exact coder source revision; otherwise derived from manifest sourceFiles."
        }
      },
      additionalProperties: false
    },
    summarize: (args) => (
      `Run web QA manifest ${String(args.manifestPath ?? "qa-manifest.json").slice(0, 200)}`
    ),
    handler: (args, context) => controller.run(args, context)
  });

  register({
    name: "qa_status",
    description: "Inspect one project/session QA run and its route, control, accessibility, diagnostic, screenshot, and trace evidence.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^qa_[a-f0-9]{16}$" }
      },
      required: ["runId"],
      additionalProperties: false
    },
    handler: (args, context) => controller.status(args, context)
  });

  register({
    name: "qa_artifact",
    description: "Read metadata for a QA artifact owned by the current project/session run. Set includeData only for a bounded screenshot or text diagnostic; large traces remain local.",
    sideEffects: false,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^qa_[a-f0-9]{16}$" },
        ref: { type: "string", pattern: "^qaart_[a-f0-9]{64}$" },
        includeData: { type: "boolean" }
      },
      required: ["runId", "ref"],
      additionalProperties: false
    },
    handler: (args, context) => controller.artifact(args, context)
  });

  register({
    name: "qa_approve_baseline",
    description: "Approve screenshots from one otherwise-passing QA run as visual baselines. A run may be blocked only by missing baselines. This is a manual human decision: auto-approve and caller confirmation cannot satisfy it.",
    sideEffects: true,
    needsConfirmation: true,
    manualApproval: true,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", pattern: "^qa_[a-f0-9]{16}$" },
        resultIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_RESULTS,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,255}$"
          }
        }
      },
      required: ["runId"],
      additionalProperties: false
    },
    summarize: (args) => (
      `Approve visual baselines from QA run ${String(args.runId ?? "").slice(0, 64)}`
    ),
    handler: (args, context) => controller.approveBaselines(args, context)
  });

  return names;
}

function loadManifest(candidate, workspaceRoot) {
  const manifestPath = resolveProjectFile(
    workspaceRoot,
    candidate,
    "QA manifest"
  );
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("QA manifest must be a bounded regular JSON file.");
  }
  const text = fs.readFileSync(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("QA manifest is not valid JSON.");
  }
  const manifest = normalizeManifest(parsed);
  return {
    path: path.relative(workspaceRoot, manifestPath).replaceAll("\\", "/"),
    digest: digestCanonical(manifest),
    manifest
  };
}

function normalizeManifest(value) {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError("QA manifest requires version 1.");
  }
  const title = boundedText(value.title ?? "Project QA", "manifest title", 200);
  const baseUrl = boundedText(value.baseUrl, "manifest baseUrl", 4_096);
  const sourceFiles = normalizeSourceFiles(value.sourceFiles);
  const fixture = value.fixture === true;
  const exploration = normalizeExplorationPolicy(value.exploration, {
    fixture
  });
  const viewports = normalizeViewports(value.viewports);
  if (
    !Array.isArray(value.routes)
    || value.routes.length < 1
    || value.routes.length > MAX_ROUTES
  ) {
    throw new TypeError(`QA manifest requires 1-${MAX_ROUTES} routes.`);
  }
  const routeIds = new Set();
  const routes = value.routes.map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`QA route ${index + 1} is invalid.`);
    const id = requiredId(raw.id, `route ${index + 1}`);
    if (routeIds.has(id)) throw new TypeError(`Duplicate QA route id: ${id}`);
    routeIds.add(id);
    const routePath = normalizeRoutePath(raw.path);
    const controls = normalizeControls(raw.controls, fixture, id);
    const exemptions = normalizeExemptions(raw.exemptions, id);
    return {
      id,
      path: routePath,
      assertions: normalizeAssertions(raw.assertions, `route ${id}`),
      controls,
      exemptions,
      accessibility: raw.accessibility === "off" ? "off" : "strict",
      keyboard: raw.keyboard === "off" ? "off" : "strict",
      visual: normalizeVisualPolicy(raw.visual, id),
      failOnWarnings: raw.failOnWarnings === true,
      fullPageScreenshot: raw.fullPageScreenshot !== false,
      settleTimeoutMs: boundedInteger(
        raw.settleTimeoutMs,
        100,
        30_000,
        5_000
      )
    };
  });
  return {
    version: 1,
    title,
    baseUrl,
    fixture,
    exploration,
    sourceFiles,
    viewports,
    routes
  };
}

function normalizeVisualPolicy(value, routeId) {
  if (value == null) {
    return { mode: "capture", maxDiffRatio: 0.001 };
  }
  if (typeof value === "string") {
    const mode = value.trim().toLowerCase();
    if (!["off", "capture", "strict"].includes(mode)) {
      throw new TypeError(`QA route '${routeId}' has an invalid visual mode.`);
    }
    return { mode, maxDiffRatio: 0.001 };
  }
  if (!isRecord(value)) {
    throw new TypeError(`QA route '${routeId}' has an invalid visual policy.`);
  }
  const mode = String(value.mode ?? "capture").trim().toLowerCase();
  if (!["off", "capture", "strict"].includes(mode)) {
    throw new TypeError(`QA route '${routeId}' has an invalid visual mode.`);
  }
  const maxDiffRatio = Number(value.maxDiffRatio ?? 0.001);
  if (
    !Number.isFinite(maxDiffRatio)
    || maxDiffRatio < 0
    || maxDiffRatio > 0.25
  ) {
    throw new TypeError(
      `QA route '${routeId}' visual maxDiffRatio must be between 0 and 0.25.`
    );
  }
  return { mode, maxDiffRatio };
}

function normalizeSourceFiles(value) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_SOURCE_FILES
  ) {
    throw new TypeError(
      `QA manifest requires 1-${MAX_SOURCE_FILES} sourceFiles.`
    );
  }
  const seen = new Set();
  return value.map((candidate, index) => {
    const file = boundedText(candidate, `sourceFiles[${index}]`, 1_024);
    const normalized = file.replaceAll("\\", "/");
    if (seen.has(normalized)) {
      throw new TypeError(`Duplicate QA source file: ${normalized}`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function normalizeViewports(value) {
  const input = value == null
    ? [{ id: "desktop", width: 1280, height: 720 }]
    : value;
  if (
    !Array.isArray(input)
    || input.length < 1
    || input.length > MAX_VIEWPORTS
  ) {
    throw new TypeError(`QA manifest accepts 1-${MAX_VIEWPORTS} viewports.`);
  }
  const ids = new Set();
  return input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`QA viewport ${index + 1} is invalid.`);
    }
    const id = requiredId(raw.id, `viewport ${index + 1}`);
    if (ids.has(id)) throw new TypeError(`Duplicate QA viewport id: ${id}`);
    ids.add(id);
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (
      !Number.isSafeInteger(width)
      || width < 320
      || width > 3840
      || !Number.isSafeInteger(height)
      || height < 200
      || height > 2160
    ) {
      throw new TypeError(`QA viewport '${id}' has invalid dimensions.`);
    }
    return { id, width, height };
  });
}

function normalizeControls(value, fixture, routeId) {
  const input = value == null ? [] : value;
  if (!Array.isArray(input) || input.length > MAX_CONTROLS) {
    throw new TypeError(`QA route '${routeId}' has too many controls.`);
  }
  const ids = new Set();
  const identities = new Set();
  return input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`QA control ${index + 1} on '${routeId}' is invalid.`);
    }
    const id = requiredId(raw.id, `control ${index + 1}`);
    if (ids.has(id)) throw new TypeError(`Duplicate QA control id: ${id}`);
    ids.add(id);
    const role = String(raw.role ?? "").trim().toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) {
      throw new TypeError(`QA control '${id}' has an invalid role.`);
    }
    const name = boundedText(raw.name, `control ${id} name`, 500);
    const nth = boundedInteger(raw.nth, 0, 100, 0);
    const identity = controlIdentity({ role, name, nth });
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate QA control identity on '${routeId}'.`);
    }
    identities.add(identity);
    const action = String(raw.action ?? "inspect").trim().toLowerCase();
    if (!["activate", "input", "inspect", "select"].includes(action)) {
      throw new TypeError(`QA control '${id}' has an invalid action.`);
    }
    if (ACTION_REQUIRED_ROLES.has(role) && action === "inspect") {
      throw new TypeError(
        `Enabled action control '${id}' must execute an action or be exempted.`
      );
    }
    if (raw.destructive === true && !fixture) {
      throw new TypeError(
        `Destructive QA control '${id}' requires fixture=true.`
      );
    }
    const value = raw.value == null
      ? null
      : boundedText(raw.value, `control ${id} value`, 10_000);
    if (["input", "select"].includes(action) && value === null) {
      throw new TypeError(`QA control '${id}' action requires a value.`);
    }
    if (!["input", "select"].includes(action) && value !== null) {
      throw new TypeError(`QA control '${id}' cannot carry an unused value.`);
    }
    const expect = normalizeAssertions(raw.expect, `control ${id} expectation`);
    if (action !== "inspect" && assertionCount(expect) < 1) {
      throw new TypeError(
        `QA control '${id}' requires an observable post-action expectation.`
      );
    }
    return {
      id,
      role,
      name,
      nth,
      action,
      ...(value === null ? {} : { value }),
      destructive: raw.destructive === true,
      expect
    };
  });
}

function normalizeExemptions(value, routeId) {
  const input = value == null ? [] : value;
  if (!Array.isArray(input) || input.length > MAX_CONTROLS) {
    throw new TypeError(`QA route '${routeId}' has too many exemptions.`);
  }
  const identities = new Set();
  return input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`QA exemption ${index + 1} on '${routeId}' is invalid.`);
    }
    const role = String(raw.role ?? "").trim().toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) {
      throw new TypeError(`QA exemption ${index + 1} has an invalid role.`);
    }
    const name = boundedText(raw.name, "exemption name", 500);
    const nth = boundedInteger(raw.nth, 0, 100, 0);
    const reason = boundedText(raw.reason, "exemption reason", 500);
    const expiresAt = boundedText(raw.expiresAt, "exemption expiry", 64);
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new TypeError("QA exemption requires an ISO expiry.");
    }
    const identity = controlIdentity({ role, name, nth });
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate QA exemption identity on '${routeId}'.`);
    }
    identities.add(identity);
    return { role, name, nth, reason, expiresAt };
  });
}

function normalizeAssertions(value, label) {
  if (value == null) {
    return {
      text: [],
      notText: [],
      urlPath: null,
      nodes: []
    };
  }
  if (!isRecord(value)) throw new TypeError(`${label} is invalid.`);
  const text = normalizeTextList(value.text, `${label} text`);
  const notText = normalizeTextList(value.notText, `${label} notText`);
  const urlPath = value.urlPath == null
    ? null
    : normalizeRoutePath(value.urlPath);
  const rawNodes = value.nodes == null ? [] : value.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length > MAX_TEXT_ASSERTIONS) {
    throw new TypeError(`${label} has too many node assertions.`);
  }
  const nodes = rawNodes.map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`${label} node ${index + 1} is invalid.`);
    const role = String(raw.role ?? "").trim().toLowerCase();
    if (!role || !/^[a-z][a-z0-9_-]{0,63}$/.test(role)) {
      throw new TypeError(`${label} node ${index + 1} has an invalid role.`);
    }
    return {
      role,
      name: boundedText(raw.name, `${label} node name`, 500),
      nth: boundedInteger(raw.nth, 0, 100, 0),
      ...(typeof raw.checked === "boolean" ? { checked: raw.checked } : {}),
      ...(raw.value == null
        ? {}
        : { value: boundedText(raw.value, `${label} node value`, 1_000) })
    };
  });
  return { text, notText, urlPath, nodes };
}

function normalizeTextList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TEXT_ASSERTIONS) {
    throw new TypeError(`${label} has too many assertions.`);
  }
  return value.map((item, index) => (
    boundedText(item, `${label}[${index}]`, 1_000)
  ));
}

function evaluateControlCoverage(nodes, route) {
  const discovered = interactiveInventory(nodes);
  const declared = new Map(route.controls.map((control) => [
    controlIdentity(control),
    control
  ]));
  const exemptions = new Map(route.exemptions.map((exemption) => [
    controlIdentity(exemption),
    exemption
  ]));
  const failures = [];
  let covered = 0;
  let exempted = 0;

  for (const node of discovered) {
    if (!node.name) {
      failures.push(failure(
        "unlabeled_control",
        `An interactive ${node.role} has no accessible name.`
      ));
      continue;
    }
    const identity = controlIdentity(node);
    if (declared.has(identity)) {
      covered += 1;
      continue;
    }
    const exemption = exemptions.get(identity);
    if (exemption) {
      if (Date.parse(exemption.expiresAt) <= Date.now()) {
        failures.push(failure(
          "expired_control_exemption",
          `Control exemption expired for ${node.role} '${node.name}'.`
        ));
      } else {
        exempted += 1;
      }
      continue;
    }
    failures.push(failure(
      "unclassified_control",
      `Interactive ${node.role} '${node.name}' occurrence ${node.nth} is unclassified.`
    ));
  }

  for (const control of route.controls) {
    if (!discovered.some(
      (node) => controlIdentity(node) === controlIdentity(control)
    )) {
      failures.push(failure(
        "declared_control_missing",
        `Declared control '${control.id}' is absent.`
      ));
    }
  }
  for (const exemption of route.exemptions) {
    if (!discovered.some(
      (node) => controlIdentity(node) === controlIdentity(exemption)
    )) {
      failures.push(failure(
        "stale_control_exemption",
        `Exempted ${exemption.role} '${exemption.name}' is absent.`
      ));
    }
  }
  return {
    discovered: discovered.length,
    covered,
    exempted,
    failures
  };
}

function interactiveInventory(nodes) {
  const occurrences = new Map();
  const output = [];
  for (const raw of nodes ?? []) {
    const role = String(raw?.role ?? "").trim().toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = String(raw?.name ?? "").replace(/\s+/gu, " ").trim();
    const group = `${role}\0${name.toLowerCase()}`;
    const nth = occurrences.get(group) ?? 0;
    occurrences.set(group, nth + 1);
    output.push({
      ...raw,
      role,
      name,
      nth
    });
  }
  return output;
}

function findControl(nodes, control) {
  return interactiveInventory(nodes).find(
    (node) => controlIdentity(node) === controlIdentity(control)
  ) ?? null;
}

async function performControlAction(browser, node, control, context) {
  if (control.action === "activate") {
    await browser.activate({ ref: node.ref }, context);
    return;
  }
  if (control.action === "input") {
    await browser.input({ ref: node.ref, text: control.value }, context);
    return;
  }
  if (control.action === "select") {
    await browser.select({ ref: node.ref, value: control.value }, context);
    return;
  }
  throw new Error(`Unsupported QA control action: ${control.action}`);
}

function evaluateAssertions(assertions, state, snapshot, failures) {
  const bodyText = String(state.bodyText ?? "");
  for (const expected of assertions.text) {
    if (!bodyText.includes(expected)) {
      failures.push(failure(
        "expected_text_missing",
        `Expected text was not visible: ${expected}`
      ));
    }
  }
  for (const forbidden of assertions.notText) {
    if (bodyText.includes(forbidden)) {
      failures.push(failure(
        "forbidden_text_visible",
        `Forbidden text remained visible: ${forbidden}`
      ));
    }
  }
  if (assertions.urlPath != null) {
    let actual = null;
    try {
      const url = new URL(String(state.url ?? snapshot.url ?? ""));
      actual = `${url.pathname}${url.search}`;
    } catch {
      actual = null;
    }
    if (actual !== assertions.urlPath) {
      failures.push(failure(
        "unexpected_url",
        `Expected URL path '${assertions.urlPath}', found '${actual ?? "unknown"}'.`
      ));
    }
  }
  for (const expected of assertions.nodes) {
    const node = findControl(snapshot.nodes, expected)
      ?? findSemanticNode(snapshot.nodes, expected);
    if (!node) {
      failures.push(failure(
        "expected_node_missing",
        `Expected ${expected.role} '${expected.name}' was not visible.`
      ));
      continue;
    }
    if (
      typeof expected.checked === "boolean"
      && node.checked !== expected.checked
    ) {
      failures.push(failure(
        "unexpected_checked_state",
        `Expected ${expected.role} '${expected.name}' checked=${expected.checked}.`
      ));
    }
    if (
      expected.value != null
      && String(node.value ?? "") !== expected.value
    ) {
      failures.push(failure(
        "unexpected_control_value",
        `Expected ${expected.role} '${expected.name}' to have the declared value.`
      ));
    }
  }
}

function findSemanticNode(nodes, expected) {
  const matches = (nodes ?? []).filter((node) => (
    String(node?.role ?? "").toLowerCase() === expected.role
    && normalizedName(node?.name) === normalizedName(expected.name)
  ));
  return matches[expected.nth] ?? null;
}

function sanitizeDiagnostics(value) {
  const sanitized = sanitizeForAudit(value);
  return {
    supported: sanitized?.supported === true,
    events: Array.isArray(sanitized?.events)
      ? sanitized.events.slice(0, 500).map((event) => ({
          kind: safeCode(event?.kind),
          severity: event?.severity === "error" ? "error" : "warning",
          ...(event?.status == null ? {} : { status: Number(event.status) }),
          ...(event?.method == null
            ? {}
            : { method: String(event.method).slice(0, 16) }),
          ...(event?.url == null ? {} : { url: String(event.url).slice(0, 2_000) }),
          ...(event?.message == null
            ? {}
            : { message: String(event.message).slice(0, 2_000) })
        }))
      : []
  };
}

function sanitizeKeyboard(value) {
  const sanitized = sanitizeForAudit(value);
  return {
    supported: sanitized?.supported === true,
    total: boundedInteger(sanitized?.total, 0, 500, 0),
    visited: boundedInteger(sanitized?.visited, 0, 500, 0),
    missing: sanitizeKeyboardItems(sanitized?.missing),
    focusVisibleFailures: sanitizeKeyboardItems(
      sanitized?.focusVisibleFailures
    ),
    trapped: sanitized?.trapped === true
  };
}

function sanitizeKeyboardItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((item) => ({
    role: String(item?.role ?? "unknown").slice(0, 128),
    name: String(item?.name ?? "").slice(0, 500)
  }));
}

function comparePngScreenshots(expectedBytes, actualBytes, maxDiffRatio) {
  const expected = PNG.sync.read(expectedBytes);
  const actual = PNG.sync.read(actualBytes);
  const expectedPixels = expected.width * expected.height;
  const actualPixels = actual.width * actual.height;
  if (
    expectedPixels < 1
    || actualPixels < 1
    || expectedPixels > MAX_VISUAL_PIXELS
    || actualPixels > MAX_VISUAL_PIXELS
  ) {
    throw new RangeError("QA visual comparison exceeds its decoded pixel bound.");
  }
  if (
    expected.width !== actual.width
    || expected.height !== actual.height
  ) {
    return {
      passed: false,
      sizeChanged: true,
      expectedWidth: expected.width,
      expectedHeight: expected.height,
      actualWidth: actual.width,
      actualHeight: actual.height,
      diffPixels: null,
      diffRatio: 1,
      diff: null
    };
  }
  const diff = new PNG({
    width: actual.width,
    height: actual.height
  });
  const diffPixels = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    actual.width,
    actual.height,
    {
      threshold: 0.1,
      includeAA: false
    }
  );
  const diffRatio = diffPixels / actualPixels;
  return {
    passed: diffRatio <= maxDiffRatio,
    sizeChanged: false,
    expectedWidth: expected.width,
    expectedHeight: expected.height,
    actualWidth: actual.width,
    actualHeight: actual.height,
    diffPixels,
    diffRatio,
    diff: diffPixels > 0 ? PNG.sync.write(diff) : null
  };
}

function formatRatio(value) {
  return `${(Number(value) * 100).toFixed(3)}%`;
}

function diagnosticMessage(event) {
  return [
    event.kind,
    event.status == null ? null : `HTTP ${event.status}`,
    event.method,
    event.url,
    event.message
  ].filter(Boolean).join(" ").slice(0, 2_000);
}

function summarizeResults(results) {
  const explorations = results.filter(
    (result) => result.kind === "exploration"
  );
  const summary = {
    routes: results.filter((result) => result.kind === "route").length,
    controls: results.filter((result) => result.kind === "control").length,
    controlsCovered: results.reduce(
      (sum, result) => sum + (result.coverage?.covered ?? 0),
      0
    ),
    assertions: results.reduce(
      (sum, result) => sum + result.failures.length + (
        result.status === "passed" ? 1 : 0
      ),
      0
    ),
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    warnings: results.reduce(
      (sum, result) => sum + result.warnings.length,
      0
    ),
    visualChanges: results.filter(
      (result) => result.visual?.status === "changed"
    ).length,
    visualBaselinesMissing: results.filter(
      (result) => result.visual?.status === "missing"
    ).length,
    keyboardFailures: results.reduce(
      (sum, result) => sum
        + (result.keyboard?.missing ?? 0)
        + (result.keyboard?.focusVisibleFailures ?? 0)
        + (result.keyboard?.trapped ? 1 : 0),
      0
    ),
    exploredStates: explorations.reduce(
      (sum, result) => sum + (result.exploration?.states ?? 0),
      0
    ),
    exploredTransitions: explorations.reduce(
      (sum, result) => sum + (result.exploration?.transitions ?? 0),
      0
    ),
    explorationActions: explorations.reduce(
      (sum, result) => sum + (result.exploration?.actions ?? 0),
      0
    ),
    failedTransitions: explorations.reduce(
      (sum, result) => sum + (result.exploration?.failedTransitions ?? 0),
      0
    ),
    explorationTruncated: explorations.some(
      (result) => result.exploration?.truncated === true
    )
  };
  return summary;
}

function workspaceSourceRevision(workspaceRoot, sourceFiles, manifestDigest) {
  const entries = sourceFiles.map((candidate) => {
    const filePath = resolveProjectFile(workspaceRoot, candidate, "QA source");
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size > MAX_SOURCE_BYTES
    ) {
      throw new Error(`QA source file is invalid or too large: ${candidate}`);
    }
    return {
      path: candidate,
      sha256: createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex")
    };
  });
  return digestCanonical({
    manifestDigest,
    files: entries.sort((left, right) => left.path.localeCompare(right.path))
  });
}

function resolveProjectFile(workspaceRoot, candidate, label) {
  const root = path.resolve(workspaceRoot);
  const raw = boundedText(candidate, label, 1_024);
  if (path.isAbsolute(raw) || raw.includes("\0")) {
    throw new Error(`${label} path must be project-relative.`);
  }
  const resolved = path.resolve(root, raw);
  const relative = path.relative(root, resolved);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} is outside the project workspace.`);
  }
  let current = resolved;
  while (current !== root) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} cannot traverse symbolic links.`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  return resolved;
}

function qaScope(context, fallbackWorkspace) {
  if (!isRecord(context)) throw new TypeError("QA context is invalid.");
  const projectId = String(context.__projectId ?? context.projectId ?? "default");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(projectId)) {
    throw new TypeError("QA project identity is invalid.");
  }
  const sessionId = String(context.sessionId ?? "");
  if (!sessionId || sessionId.length > 256) {
    throw new TypeError("QA session identity is required.");
  }
  const workspaceRoot = path.resolve(
    String(context.__projectWorkspaceDir ?? context.workspaceRoot ?? fallbackWorkspace)
  );
  const stat = fs.lstatSync(workspaceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("QA workspace must be a real directory.");
  }
  return {
    ...context,
    projectId,
    sessionId,
    workspaceRoot,
    abortSignal: context.__abortSignal ?? context.abortSignal ?? null
  };
}

function qaBrowserContext(scope, runId) {
  return {
    ...scope,
    __projectId: scope.projectId,
    __projectWorkspaceDir: scope.workspaceRoot,
    __qaRunId: runId,
    __confirmed: true,
    approved: true
  };
}

function assertApproved(scope) {
  if (
    scope.__confirmed === true
    || scope.confirmed === true
    || scope.approved === true
  ) {
    return;
  }
  throw new Error("QA execution requires approval through the current policy.");
}

function assertManualApproval(scope) {
  const actor = String(
    scope.__approval?.decider
    ?? scope.__approval?.decidedBy
    ?? ""
  ).trim();
  if (
    !scope.__pendingActionId
    || !actor
    || actor === "auto-approve"
  ) {
    throw new Error(
      "Visual baselines require an exact manual human approval."
    );
  }
}

function selectResultIds(results, value) {
  if (value == null) return results.filter((result) => result.screenshotRef);
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_RESULTS
  ) {
    throw new TypeError("QA baseline resultIds are invalid.");
  }
  const ids = new Set(value.map((id) => requiredId(id, "result id")));
  const selected = results.filter((result) => ids.has(result.id));
  if (selected.length !== ids.size) {
    throw new TypeError("QA baseline resultIds include an unknown result.");
  }
  return selected;
}

function baselineEligibleRun(run) {
  if (run.state === "passed") return true;
  if (run.state !== "failed" || !Array.isArray(run.results)) return false;
  const failures = run.results.flatMap((result) => result.failures ?? []);
  return failures.length > 0 && failures.every(
    (entry) => entry?.code === "visual_baseline_missing"
  );
}

function selectRoutes(routes, value, mode) {
  if (mode === "full") return routes;
  if (mode === "explore" && value == null) return routes;
  if (!Array.isArray(value) || value.length < 1) {
    throw new TypeError(`${mode === "explore" ? "Explore" : "Impacted"} QA mode requires routeIds.`);
  }
  const ids = new Set(value.map((id) => requiredId(id, "route id")));
  const selected = routes.filter((route) => ids.has(route.id));
  if (selected.length !== ids.size) {
    throw new TypeError(
      `${mode === "explore" ? "Explore" : "Impacted"} QA routeIds include an unknown route.`
    );
  }
  return selected;
}

function normalizeQaMode(value) {
  const mode = String(value ?? "full").trim().toLowerCase();
  if (!["full", "impacted", "explore"].includes(mode)) {
    throw new TypeError("QA mode must be full, impacted, or explore.");
  }
  return mode;
}

function routeUrl(baseUrl, routePath) {
  let base;
  let target;
  try {
    base = new URL(baseUrl);
    target = new URL(routePath, base);
  } catch {
    throw new TypeError("QA manifest contains an invalid URL.");
  }
  if (target.origin !== base.origin) {
    throw new Error("QA route left the manifest base origin.");
  }
  return target.href;
}

function normalizeRoutePath(value) {
  const text = boundedText(value, "route path", 2_000);
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("#")) {
    throw new TypeError("QA route paths must be absolute-origin paths without fragments.");
  }
  return text;
}

function controlIdentity(value) {
  return [
    String(value.role ?? "").toLowerCase(),
    normalizedName(value.name),
    Number(value.nth ?? 0)
  ].join("\0");
}

function normalizedName(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function assertionCount(value) {
  return value.text.length
    + value.notText.length
    + value.nodes.length
    + (value.urlPath == null ? 0 : 1);
}

function failure(code, message) {
  return {
    code: safeCode(code),
    message: String(message ?? "").slice(0, 2_000)
  };
}

function safeCode(value) {
  const normalized = String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "_")
    .slice(0, 80);
  return normalized || "unknown";
}

function boundedError(error) {
  return String(error?.message ?? error ?? "QA failed.").slice(0, 2_000);
}

function publicRun(run) {
  const { workspaceRoot: _workspaceRoot, ...visible } = structuredClone(run);
  return visible;
}

function qaRunResult(run) {
  return {
    ok: run.state === "passed",
    status: run.state,
    run: publicRun(run)
  };
}

function requiredId(value, label) {
  const id = String(value ?? "");
  if (!ASCII_ID_RE.test(id)) {
    throw new TypeError(`QA ${label} requires an ASCII id.`);
  }
  return id;
}

function requiredSha256(value, label) {
  const digest = String(value ?? "").toLowerCase();
  if (!SHA256_RE.test(digest)) throw new TypeError(`${label} is invalid.`);
  return digest;
}

function boundedText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError(`${label} must be non-empty bounded text.`);
  }
  return text;
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function digestCanonical(value) {
  return createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex");
}

function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const WEB_QA_LIMITS = Object.freeze({
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxSourceFiles: MAX_SOURCE_FILES,
  maxRoutes: MAX_ROUTES,
  maxControls: MAX_CONTROLS,
  maxViewports: MAX_VIEWPORTS,
  maxResults: MAX_RESULTS
});

export const WEB_QA_INTERNALS = Object.freeze({
  normalizeManifest,
  normalizeQaMode,
  evaluateControlCoverage,
  interactiveInventory,
  workspaceSourceRevision
});

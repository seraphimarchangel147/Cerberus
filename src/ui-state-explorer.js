import crypto from "node:crypto";

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
const DEFAULT_POLICY = Object.freeze({
  maxStates: 16,
  maxDepth: 3,
  maxActions: 48,
  timeoutMs: 60_000,
  includeDestructive: false,
  accessibility: true,
  keyboard: true,
  captureStates: true
});
const MAX_FAILURES = 200;
const ARTIFACT_REF_RE = /^qaart_[a-f0-9]{64}$/;

export class UiStateExplorer {
  constructor({ browser, artifacts, now = Date.now } = {}) {
    if (!browser) throw new TypeError("UiStateExplorer requires a browser.");
    if (!artifacts) {
      throw new TypeError("UiStateExplorer requires a QA artifact store.");
    }
    this.browser = browser;
    this.artifacts = artifacts;
    this.now = now;
  }

  async explore({
    run,
    qaContext,
    route,
    viewport,
    url,
    policy,
    fixture,
    rootScreenshotRef = null,
    abortSignal = null
  }) {
    const limits = normalizeExplorationPolicy(policy, { fixture });
    if (
      rootScreenshotRef != null
      && !ARTIFACT_REF_RE.test(String(rootScreenshotRef))
    ) {
      throw new TypeError("QA exploration root screenshot ref is invalid.");
    }
    const startedAt = this.now();
    const salt = crypto.randomBytes(32);
    const states = [];
    const transitions = [];
    const artifacts = new Set();
    if (rootScreenshotRef) artifacts.add(rootScreenshotRef);
    const failures = [];
    const warnings = [];
    const seen = new Map();
    const queue = [];
    const attemptedControlIds = new Set();
    const performance = {
      pageLoads: 0,
      semanticActions: 0,
      replayedSemanticActions: 0,
      screenshotCaptures: 0,
      screenshotBytes: 0,
      screenshotDurationMs: 0
    };
    let actions = 0;
    let truncated = false;
    let truncationReason = null;

    if (abortSignal?.aborted) {
      return this._result({
        run,
        route,
        viewport,
        limits,
        states,
        transitions,
        artifacts,
        failures,
        warnings,
        actions,
        truncated: true,
        truncationReason: "cancelled",
        rootScreenshotRef,
        startedAt,
        performance
      });
    }

    const root = await this._reach({
      path: [],
      qaContext,
      route,
      viewport,
      url,
      trace: false,
      performance,
      abortSignal
    });
    if (root.cancelled) {
      return this._result({
        run,
        route,
        viewport,
        limits,
        states,
        transitions,
        artifacts,
        failures,
        warnings,
        actions,
        truncated: true,
        truncationReason: "cancelled",
        rootScreenshotRef,
        startedAt,
        performance
      });
    }
    if (!root.ok) {
      const rootFailure = finding(
        "exploration_root_failed",
        root.error
      );
      failures.push(rootFailure);
      return this._result({
        run,
        route,
        viewport,
        limits,
        states,
        transitions,
        artifacts,
        failures,
        warnings,
        actions,
        truncated,
        truncationReason,
        rootScreenshotRef,
        startedAt,
        performance
      });
    }
    const rootSignature = stateSignature(root, salt);
    const rootState = stateRecord({
      signature: rootSignature,
      depth: 0,
      path: [],
      reached: root,
      screenshotRef: rootScreenshotRef,
      expectedUrlPath: route.path
    });
    states.push(rootState);
    seen.set(rootSignature, rootState);
    queue.push({
      state: rootState,
      signature: rootSignature,
      path: []
    });

    while (queue.length > 0) {
      if (abortSignal?.aborted) {
        truncated = true;
        truncationReason = "cancelled";
        break;
      }
      if (this.now() - startedAt >= limits.timeoutMs) {
        truncated = true;
        truncationReason = "time_budget";
        break;
      }
      const current = queue.shift();
      const reached = current.path.length === 0
        ? root
        : await this._reach({
            path: current.path,
            qaContext,
            route,
            viewport,
            url,
            trace: false,
            performance,
            abortSignal
          });
      if (reached.cancelled) {
        truncated = true;
        truncationReason = "cancelled";
        break;
      }
      if (!reached.ok) {
        failures.push(finding(
          "state_replay_failed",
          reached.error,
          {
            stateId: current.state.id,
            path: current.path.map((step) => step.controlId)
          }
        ));
        continue;
      }
      const candidates = executableControls(
        reached.snapshot.nodes,
        route.controls,
        limits,
        reached.state,
        reached.snapshot
      );
      if (current.path.length >= limits.maxDepth) {
        if (candidates.length > 0) {
          truncated = true;
          truncationReason = "depth_budget";
        }
        if (truncated) break;
        continue;
      }
      for (const candidate of candidates) {
        if (abortSignal?.aborted) {
          truncated = true;
          truncationReason = "cancelled";
          break;
        }
        if (states.length >= limits.maxStates) {
          truncated = true;
          truncationReason = "state_budget";
          break;
        }
        if (actions >= limits.maxActions) {
          truncated = true;
          truncationReason = "action_budget";
          break;
        }
        if (this.now() - startedAt >= limits.timeoutMs) {
          truncated = true;
          truncationReason = "time_budget";
          break;
        }
        actions += 1;
        attemptedControlIds.add(candidate.id);
        const transition = await this._transition({
          run,
          source: current,
          candidate,
          qaContext,
          route,
          viewport,
          url,
          limits,
          salt,
          seen,
          performance,
          abortSignal
        });
        if (transition.cancelled) {
          truncated = true;
          truncationReason = "cancelled";
          for (const ref of transition.artifacts) artifacts.add(ref);
          break;
        }
        transitions.push(transition.edge);
        for (const ref of transition.artifacts) artifacts.add(ref);
        failures.push(...transition.failures);
        warnings.push(...transition.warnings);
        if (transition.next && states.length < limits.maxStates) {
          states.push(transition.next.state);
          seen.set(transition.next.signature, transition.next.state);
          queue.push(transition.next);
        } else if (transition.next) {
          truncated = true;
          truncationReason = "state_budget";
        }
      }
      if (truncated && [
        "action_budget",
        "time_budget",
        "cancelled",
        "depth_budget",
        "state_budget"
      ].includes(truncationReason)) {
        break;
      }
    }

    if (truncationReason !== "cancelled") {
      for (const control of route.controls) {
        if (
          control.action === "inspect"
          || (control.destructive && !limits.includeDestructive)
          || attemptedControlIds.has(control.id)
        ) {
          continue;
        }
        failures.push(finding(
          "exploration_control_unexercised",
          `Control '${control.id}' had no state where its declared postcondition could discriminate the action.`,
          { controlId: control.id }
        ));
      }
    }
    if (truncated && truncationReason !== "cancelled") {
      failures.push(finding(
        "exploration_incomplete",
        `Exploration exhausted its ${truncationReason.replaceAll("_", " ")} before the state graph was complete.`
      ));
    }
    const graph = {
      version: 1,
      routeId: route.id,
      viewportId: viewport.id,
      policy: limits,
      states,
      transitions,
      rootStateId: rootState.id,
      actions,
      truncated,
      truncationReason
    };
    const graphArtifact = this.artifacts.put(
      Buffer.from(JSON.stringify(graph), "utf8"),
      {
        projectId: run.projectId,
        runId: run.id,
        kind: "state_graph",
        mediaType: "application/json",
        retention: failures.length > 0 ? "failure" : "success"
      }
    );
    artifacts.add(graphArtifact.ref);

    return this._result({
      run,
      route,
      viewport,
      limits,
      states,
      transitions,
      artifacts,
      failures,
      warnings,
      actions,
      truncated,
      truncationReason,
      rootScreenshotRef,
      graphRef: graphArtifact.ref,
      startedAt,
      performance
    });
  }

  async _transition({
    run,
    source,
    candidate,
    qaContext,
    route,
    viewport,
    url,
    limits,
    salt,
    seen,
    performance,
    abortSignal
  }) {
    const artifacts = [];
    const failures = [];
    const warnings = [];
    const path = [...source.path, candidateStep(candidate)];
    let reached = null;
    let traceRef = null;
    let screenshotRef = null;
    let next = null;
    let cancelled = false;
    try {
      reached = await this._reach({
        path: source.path,
        qaContext,
        route,
        viewport,
        url,
        trace: true,
        keepOpen: true,
        performance,
        abortSignal
      });
      if (!reached.ok) {
        if (reached.cancelled) {
          cancelled = true;
        } else {
          failures.push(finding(
            "state_replay_failed",
            reached.error
          ));
        }
      } else {
        const beforeExpectation = evaluateAssertions(
          candidate.expect,
          reached.state,
          reached.snapshot
        );
        const node = findControl(reached.snapshot.nodes, candidate);
        if (!node) {
          failures.push(finding(
            "exploration_control_missing",
            `Declared control '${candidate.id}' was absent while replaying state.`
          ));
        } else if (node.disabled) {
          failures.push(finding(
            "exploration_control_disabled",
            `Declared control '${candidate.id}' was disabled.`
          ));
        } else if (abortSignal?.aborted) {
          cancelled = true;
        } else {
          performance.semanticActions += 1;
          await performAction(this.browser, node, candidate, qaContext);
          reached.state = await this.browser.waitForQaSettled({
            timeoutMs: route.settleTimeoutMs
          }, qaContext);
          reached.snapshot = await this.browser.inspect({
            maxNodes: 500
          }, qaContext);
          failures.push(...evaluateAssertions(
            route.assertions,
            reached.state,
            reached.snapshot
          ));
          const afterExpectation = evaluateAssertions(
            candidate.expect,
            reached.state,
            reached.snapshot
          );
          failures.push(...afterExpectation);
          if (
            beforeExpectation.length === 0
            && afterExpectation.length === 0
          ) {
            failures.push(finding(
              "non_discriminating_expectation",
              `Control '${candidate.id}' expectation was already satisfied before the action.`
            ));
          }
          if (reached.state.readyState === "loading") {
            failures.push(finding(
              "page_not_ready",
              "The page remained in the loading readyState."
            ));
          }
          if (Number(reached.state.busyCount) > 0) {
            failures.push(finding(
              "stuck_busy_state",
              `${reached.state.busyCount} busy indicators remained after settling.`
            ));
          }
          await this._collectOracles({
            route,
            qaContext,
            limits,
            failures,
            warnings
          });
        }
      }
      if (reached?.ok && !cancelled) {
        const signature = stateSignature(reached, salt);
        const previous = seen.get(signature);
        if (
          previous
          && previous.id === source.state.id
          && failures.length === 0
        ) {
          failures.push(finding(
            "dead_control",
            `Control '${candidate.id}' produced no observable state change.`
          ));
        }
        const isNew = !previous;
        if (
          failures.length > 0
          || (isNew && limits.captureStates)
        ) {
          const screenshotStartedAt = this.now();
          const screenshot = await this.browser.screenshot({
            fullPage: route.fullPageScreenshot
          }, qaContext);
          performance.screenshotDurationMs += Math.max(
            0,
            this.now() - screenshotStartedAt
          );
          const screenshotBytes = Buffer.from(
            screenshot.image.data,
            "base64"
          );
          const artifact = this.artifacts.put(
            screenshotBytes,
            {
              projectId: run.projectId,
              runId: run.id,
              kind: failures.length > 0
                ? "state_failure_screenshot"
                : "state_screenshot",
              mediaType: screenshot.image.mediaType,
              retention: failures.length > 0 ? "failure" : "success"
            }
          );
          artifacts.push(artifact.ref);
          screenshotRef = artifact.ref;
          performance.screenshotCaptures += 1;
          performance.screenshotBytes += screenshotBytes.length;
        }
        if (isNew) {
          const state = stateRecord({
            signature,
            depth: path.length,
            path,
            reached,
            screenshotRef,
            expectedUrlPath: route.path
          });
          next = { state, signature, path };
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        cancelled = true;
      } else {
        failures.push(finding(
          "state_transition_failed",
          boundedError(error)
        ));
      }
    } finally {
      try {
        const trace = await this.browser.stopQaTrace({
          retain: failures.length > 0
        }, qaContext);
        if (trace?.data) {
          const artifact = this.artifacts.put(
            Buffer.from(trace.data, "base64"),
            {
              projectId: run.projectId,
              runId: run.id,
              kind: "state_failure_trace",
              mediaType: trace.mediaType ?? "application/zip",
              retention: "failure"
            }
          );
          artifacts.push(artifact.ref);
          traceRef = artifact.ref;
        }
      } catch (error) {
        failures.push(finding(
          "trace_capture_failed",
          boundedError(error)
        ));
      }
      await this.browser.close({}, qaContext).catch(() => {});
    }

    if (cancelled) {
      return {
        cancelled: true,
        artifacts,
        failures: [],
        warnings: []
      };
    }

    let replayRef = null;
    if (failures.length > 0) {
      const replay = {
        version: 1,
        routeId: route.id,
        viewportId: viewport.id,
        method: "breadth_first_shortest_known_path",
        sourceStateId: source.state.id,
        steps: path.map((step) => ({
          controlId: step.controlId,
          action: step.action
        })),
        failureCodes: [...new Set(failures.map((item) => item.code))]
      };
      const artifact = this.artifacts.put(
        Buffer.from(JSON.stringify(replay), "utf8"),
        {
          projectId: run.projectId,
          runId: run.id,
          kind: "state_failure_replay",
          mediaType: "application/json",
          retention: "failure"
        }
      );
      artifacts.push(artifact.ref);
      replayRef = artifact.ref;
    }
    const targetId = next?.state.id
      ?? (reached?.ok ? seen.get(stateSignature(reached, salt))?.id : null)
      ?? source.state.id;
    const edge = {
      id: `edge_${String(source.state.id).slice(6, 18)}_${candidate.id}_${transitionsSafeOrdinal(
        source.state.id,
        candidate.id,
        path.length
      )}`,
      from: source.state.id,
      to: targetId,
      controlId: candidate.id,
      action: candidate.action,
      depth: path.length,
      status: failures.length > 0 ? "failed" : "passed",
      failureCodes: [...new Set(failures.map((item) => item.code))],
      screenshotRef,
      traceRef,
      replayRef
    };
    return {
      edge,
      next,
      cancelled: false,
      artifacts,
      failures: failures.slice(0, MAX_FAILURES).map((item) => ({
        ...item,
        stateId: source.state.id,
        controlId: candidate.id,
        replayRef
      })),
      warnings: warnings.slice(0, MAX_FAILURES)
    };
  }

  async _reach({
    path,
    qaContext,
    route,
    viewport,
    url,
    trace,
    keepOpen = false,
    performance = null,
    abortSignal = null
  }) {
    try {
      if (abortSignal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          error: "QA exploration cancelled."
        };
      }
      if (performance) {
        performance.pageLoads += 1;
        performance.replayedSemanticActions += path.length;
      }
      await this.browser.openForQa({
        url,
        viewport,
        trace
      }, qaContext);
      let state = await this.browser.waitForQaSettled({
        timeoutMs: route.settleTimeoutMs
      }, qaContext);
      let snapshot = await this.browser.inspect({
        maxNodes: 500
      }, qaContext);
      for (const step of path) {
        if (abortSignal?.aborted) {
          await this.browser.stopQaTrace({ retain: false }, qaContext)
            .catch(() => {});
          await this.browser.close({}, qaContext).catch(() => {});
          return {
            ok: false,
            cancelled: true,
            error: "QA exploration cancelled."
          };
        }
        const control = route.controls.find((item) => (
          item.id === step.controlId
        ));
        const node = control
          ? findControl(snapshot.nodes, control)
          : null;
        if (!control || !node || node.disabled) {
          throw new Error(
            `Could not replay control '${step.controlId}' from the current state.`
          );
        }
        await performAction(this.browser, node, control, qaContext);
        state = await this.browser.waitForQaSettled({
          timeoutMs: route.settleTimeoutMs
        }, qaContext);
        snapshot = await this.browser.inspect({
          maxNodes: 500
        }, qaContext);
      }
      const reached = { ok: true, state, snapshot };
      if (!keepOpen) {
        await this.browser.stopQaTrace({ retain: false }, qaContext)
          .catch(() => {});
        await this.browser.close({}, qaContext).catch(() => {});
      }
      return reached;
    } catch (error) {
      await this.browser.stopQaTrace({ retain: false }, qaContext)
        .catch(() => {});
      await this.browser.close({}, qaContext).catch(() => {});
      return {
        ok: false,
        cancelled: abortSignal?.aborted === true,
        error: boundedError(error)
      };
    }
  }

  async _collectOracles({
    route,
    qaContext,
    limits,
    failures,
    warnings
  }) {
    const diagnostics = await this.browser.qaDiagnostics({}, qaContext);
    for (const event of diagnostics?.events ?? []) {
      const code = `diagnostic_${safeCode(event?.kind ?? "unknown")}`;
      const item = finding(
        code,
        boundedError(event?.message ?? event?.kind ?? "Browser diagnostic")
      );
      if (event?.severity === "error" || route.failOnWarnings) {
        failures.push(item);
      } else {
        warnings.push(item);
      }
    }
    if (limits.accessibility && route.accessibility !== "off") {
      const accessibility = await this.browser.qaAccessibility(
        {},
        qaContext
      );
      if (accessibility?.supported !== true) {
        failures.push(finding(
          "accessibility_unavailable",
          "Strict accessibility evidence is unavailable."
        ));
      }
      for (const violation of accessibility?.violations ?? []) {
        failures.push(finding(
          `a11y_${safeCode(violation?.id ?? "unknown")}`,
          boundedError(
            violation?.help
            ?? violation?.description
            ?? "Accessibility violation"
          )
        ));
      }
      if ((accessibility?.incomplete ?? []).length > 0) {
        warnings.push(finding(
          "accessibility_incomplete",
          `${accessibility.incomplete.length} accessibility checks require review.`
        ));
      }
    }
    if (limits.keyboard && route.keyboard !== "off") {
      const keyboard = await this.browser.qaKeyboardAudit({}, qaContext);
      if (keyboard?.supported !== true) {
        failures.push(finding(
          "keyboard_audit_unavailable",
          "Strict keyboard-navigation evidence is unavailable."
        ));
      }
      if (keyboard?.trapped === true) {
        failures.push(finding(
          "keyboard_focus_trap",
          "Keyboard focus repeated without advancing."
        ));
      }
      for (const item of keyboard?.missing ?? []) {
        failures.push(finding(
          "keyboard_control_unreachable",
          `${item.role ?? "control"} '${item.name ?? "unnamed"}' was not reachable with Tab.`
        ));
      }
      for (const item of keyboard?.focusVisibleFailures ?? []) {
        failures.push(finding(
          "keyboard_focus_not_visible",
          `${item.role ?? "control"} '${item.name ?? "unnamed"}' had no visible focus indicator.`
        ));
      }
    }
  }

  _result({
    route,
    viewport,
    limits,
    states,
    transitions,
    artifacts,
    failures,
    warnings,
    actions,
    truncated,
    truncationReason,
    rootScreenshotRef = null,
    graphRef = null,
    startedAt,
    performance
  }) {
    const boundedFailures = failures.slice(0, MAX_FAILURES);
    return {
      id: `${route.id}_${viewport.id}_explore`,
      kind: "exploration",
      routeId: route.id,
      viewport: {
        id: viewport.id,
        width: viewport.width,
        height: viewport.height
      },
      status: boundedFailures.length > 0 ? "failed" : "passed",
      failures: boundedFailures,
      warnings: warnings.slice(0, MAX_FAILURES),
      coverage: null,
      diagnostics: {
        events: transitions.reduce(
          (sum, edge) => sum + edge.failureCodes.filter(
            (code) => code.startsWith("diagnostic_")
          ).length,
          0
        ),
        errors: boundedFailures.filter((item) => (
          item.code.startsWith("diagnostic_")
        )).length
      },
      accessibility: {
        supported: limits.accessibility,
        violations: boundedFailures.filter((item) => (
          item.code.startsWith("a11y_")
        )).length,
        incomplete: warnings.filter((item) => (
          item.code === "accessibility_incomplete"
        )).length
      },
      keyboard: {
        supported: limits.keyboard,
        total: 0,
        visited: 0,
        missing: boundedFailures.filter((item) => (
          item.code === "keyboard_control_unreachable"
        )).length,
        focusVisibleFailures: boundedFailures.filter((item) => (
          item.code === "keyboard_focus_not_visible"
        )).length,
        trapped: boundedFailures.some((item) => (
          item.code === "keyboard_focus_trap"
        ))
      },
      visual: {
        mode: "state-capture",
        status: rootScreenshotRef ? "captured" : "missing",
        baselineRef: null,
        actualRef: rootScreenshotRef,
        diffRef: null,
        diffPixels: null,
        diffRatio: null,
        maxDiffRatio: null
      },
      exploration: {
        states: states.length,
        transitions: transitions.length,
        actions,
        maxDepthReached: states.reduce(
          (max, state) => Math.max(max, state.depth),
          0
        ),
        truncated,
        truncationReason,
        graphRef,
        failedTransitions: transitions.filter((edge) => (
          edge.status === "failed"
        )).length,
        replayRefs: transitions
          .map((edge) => edge.replayRef)
          .filter(Boolean)
      },
      performance: {
        durationMs: Math.max(0, this.now() - startedAt),
        semanticActions: performance.semanticActions,
        pageLoads: performance.pageLoads,
        replayedSemanticActions: performance.replayedSemanticActions,
        blindRetries: 0,
        screenshotCaptures: performance.screenshotCaptures,
        screenshotBytes: performance.screenshotBytes,
        screenshotDurationMs: performance.screenshotDurationMs
      },
      artifacts: [...artifacts],
      screenshotRef: transitions.find((edge) => edge.screenshotRef)
        ?.screenshotRef
        ?? rootScreenshotRef,
      diagnosticsRef: graphRef,
      traceRef: transitions.find((edge) => edge.traceRef)?.traceRef ?? null
    };
  }
}

export function normalizeExplorationPolicy(value, { fixture = false } = {}) {
  const input = value == null ? {} : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("QA exploration policy must be an object.");
  }
  const policy = {
    maxStates: boundedInteger(
      input.maxStates,
      2,
      64,
      DEFAULT_POLICY.maxStates
    ),
    maxDepth: boundedInteger(
      input.maxDepth,
      1,
      8,
      DEFAULT_POLICY.maxDepth
    ),
    maxActions: boundedInteger(
      input.maxActions,
      1,
      128,
      DEFAULT_POLICY.maxActions
    ),
    timeoutMs: boundedInteger(
      input.timeoutMs,
      1_000,
      180_000,
      DEFAULT_POLICY.timeoutMs
    ),
    includeDestructive: input.includeDestructive === true,
    accessibility: input.accessibility !== false,
    keyboard: input.keyboard !== false,
    captureStates: input.captureStates !== false
  };
  if (policy.includeDestructive && !fixture) {
    throw new TypeError(
      "QA exploration can include destructive controls only when fixture=true."
    );
  }
  return policy;
}

function executableControls(nodes, controls, policy, state, snapshot) {
  return controls.filter((control) => (
    control.action !== "inspect"
    && (!control.destructive || policy.includeDestructive)
    && Boolean(findControl(nodes, control))
    && evaluateAssertions(control.expect, state, snapshot).length > 0
  ));
}

function candidateStep(control) {
  return {
    controlId: control.id,
    action: control.action
  };
}

function findControl(nodes, control) {
  const matches = (nodes ?? []).filter((node) => (
    String(node?.role ?? "").toLowerCase() === control.role
    && normalizedName(node?.name) === normalizedName(control.name)
  ));
  return matches[control.nth ?? 0] ?? null;
}

async function performAction(browser, node, control, context) {
  if (control.action === "activate") {
    await browser.activate({ ref: node.ref }, context);
    return;
  }
  if (control.action === "input") {
    await browser.input({
      ref: node.ref,
      text: control.value
    }, context);
    return;
  }
  if (control.action === "select") {
    await browser.select({
      ref: node.ref,
      value: control.value
    }, context);
    return;
  }
  throw new Error(`Unsupported exploration action: ${control.action}`);
}

function evaluateAssertions(assertions, state, snapshot) {
  const failures = [];
  const body = String(state?.bodyText ?? "");
  for (const expected of assertions?.text ?? []) {
    if (!body.includes(expected)) {
      failures.push(finding(
        "expected_text_missing",
        `Expected text was not visible: ${expected}`
      ));
    }
  }
  for (const forbidden of assertions?.notText ?? []) {
    if (body.includes(forbidden)) {
      failures.push(finding(
        "forbidden_text_visible",
        `Forbidden text was visible: ${forbidden}`
      ));
    }
  }
  if (assertions?.urlPath != null) {
    const actual = normalizedUrlTarget(state?.url ?? snapshot?.url);
    if (actual !== assertions.urlPath) {
      failures.push(finding(
        "unexpected_url",
        `The current URL did not match expected path '${assertions.urlPath}'.`
      ));
    }
  }
  for (const expected of assertions?.nodes ?? []) {
    const node = findControl(snapshot?.nodes, expected);
    if (!node) {
      failures.push(finding(
        "expected_node_missing",
        `Expected ${expected.role} '${expected.name}' was not visible.`
      ));
      continue;
    }
    if (
      typeof expected.checked === "boolean"
      && node.checked !== expected.checked
    ) {
      failures.push(finding(
        "unexpected_checked_state",
        `Expected ${expected.role} '${expected.name}' checked=${expected.checked}.`
      ));
    }
    if (
      expected.value != null
      && String(node.value ?? "") !== expected.value
    ) {
      failures.push(finding(
        "unexpected_control_value",
        `Expected ${expected.role} '${expected.name}' to have the declared value.`
      ));
    }
  }
  return failures;
}

function stateSignature(reached, salt) {
  const state = reached.state ?? {};
  const nodes = (reached.snapshot?.nodes ?? []).map((node) => ({
    role: String(node?.role ?? "").toLowerCase(),
    name: normalizedName(node?.name),
    value: String(node?.value ?? ""),
    checked: typeof node?.checked === "boolean" ? node.checked : null,
    disabled: node?.disabled === true
  }));
  const canonical = JSON.stringify({
    urlTarget: normalizedUrlTarget(state.url ?? reached.snapshot?.url),
    readyState: state.readyState ?? "unknown",
    busyCount: Number(state.busyCount) || 0,
    bodyText: String(state.bodyText ?? ""),
    nodes
  });
  return crypto.createHmac("sha256", salt).update(canonical).digest("hex");
}

function stateRecord({
  signature,
  depth,
  path,
  reached,
  screenshotRef,
  expectedUrlPath
}) {
  const interactive = (reached.snapshot?.nodes ?? []).filter((node) => (
    INTERACTIVE_ROLES.has(String(node?.role ?? "").toLowerCase())
  )).length;
  return {
    id: `state_${signature.slice(0, 20)}`,
    depth,
    path: path.map((step) => step.controlId),
    locationChanged: normalizedUrlTarget(
      reached.state?.url ?? reached.snapshot?.url
    ) !== expectedUrlPath,
    interactiveControls: interactive,
    busyCount: Number(reached.state?.busyCount) || 0,
    screenshotRef: screenshotRef ?? null
  };
}

function finding(code, message, extra = {}) {
  return {
    code: safeCode(code),
    message: boundedError(message),
    ...extra
  };
}

function safeCode(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    || "unknown";
}

function normalizedName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedUrlTarget(value) {
  try {
    const url = new URL(String(value ?? ""));
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function boundedError(value) {
  return String(value?.message ?? value ?? "unknown error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > maximum
  ) {
    throw new TypeError(
      `Expected an integer from ${minimum} to ${maximum}.`
    );
  }
  return number;
}

function transitionsSafeOrdinal(stateId, controlId, depth) {
  return crypto.createHash("sha256")
    .update(`${stateId}\0${controlId}\0${depth}`)
    .digest("hex")
    .slice(0, 8);
}

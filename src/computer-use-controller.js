import crypto from "node:crypto";
import { redactKnownValues } from "./redact.js";
import { secretRedactionSpellings } from "./credential-redaction.js";
import { secretsStoreRedactionSnapshot } from "./secrets-store.js";

const DEFAULT_MAX_ACTIONS = 40;
const MAX_ACTIONS = 200;
const MAX_REASONING = 500;
const MAX_TEXT = 100_000;
const MAX_NODE_IMAGE_CHARS = 28 * 1024 * 1024;

export class ComputerUseController {
  constructor({ runtime, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    if (!runtime?.computerUseLog) {
      throw new TypeError("ComputerUseController requires a computer-use log.");
    }
    this.runtime = runtime;
    this.log = runtime.computerUseLog;
    this.fetchImpl = fetchImpl;
    this.env = env;
  }

  capabilities(context = {}) {
    const owner = ownerFromContext(context);
    return {
      semanticBrowser: Boolean(
        this.runtime.semanticBrowser
        && owner.projectId
        && owner.agentSessionId
      ),
      desktopNode: Boolean(this._node()),
      strategies: ["semantic", "visual-fallback"],
      visualFallbackRequires: [
        "fresh viewport screenshot",
        "matching screenshot SHA-256",
        "matching page generation",
        "explicit fallback reason"
      ]
    };
  }

  async start(args = {}, context = {}) {
    const goal = this._auditText(
      requiredText(args.goal, 500, "goal"),
      500
    );
    const owner = ownerFromContext(context);
    const requestedSurface = enumValue(
      args.surface ?? "auto",
      ["auto", "browser", "desktop"],
      "surface"
    );
    const surface = requestedSurface === "auto"
      ? args.url != null ? "browser" : "desktop"
      : requestedSurface;
    const maxActions = boundedInteger(
      args.maxActions,
      1,
      MAX_ACTIONS,
      DEFAULT_MAX_ACTIONS,
      "maxActions"
    );
    if (this._active(context)) {
      throw new Error(
        "A computer-use session is already active for this project session. End it before starting another."
      );
    }
    if (surface === "browser" && !this.runtime.semanticBrowser) {
      throw new Error(
        "Semantic browser control is unavailable. Enable OPENAGI_SEMANTIC_BROWSER or choose surface=desktop."
      );
    }
    const browserContext = surface === "browser"
      ? this._browserContext(context)
      : null;
    const session = this.log.startSession({
      goal,
      approvedBy: context.__confirmed === true ? "user-or-policy" : "user",
      projectId: owner.projectId,
      agentSessionId: owner.agentSessionId,
      surface,
      maxActions
    });
    let initialObservation = null;
    try {
      if (surface === "browser") {
        initialObservation = await this.runtime.semanticBrowser.open(
          { url: args.url ?? null },
          browserContext
        );
        this._recordBrowserObservation(session, initialObservation, "open");
      }
    } catch (error) {
      this.log.endSession(session.id, {
        reason: safeError(error),
        status: "aborted"
      });
      throw error;
    }
    return {
      sessionId: session.id,
      goal: session.goal,
      surface,
      maxActions,
      observationRevision: session.observationRevision,
      capabilities: this.capabilities(context),
      initialObservation
    };
  }

  async end(args = {}, context = {}) {
    const session = this._active(context);
    if (!session) return { ended: false, reason: "no active session" };
    let browserClosed = null;
    if (session.surface === "browser" && this.runtime.semanticBrowser) {
      try {
        browserClosed = await this.runtime.semanticBrowser.close(
          {},
          this._browserContext(context, { allowArchived: true })
        );
      } catch (error) {
        browserClosed = { closed: false, error: safeError(error) };
      }
    }
    this.log.endSession(session.id, {
      reason: this._auditText(
        optionalText(args.reason, 500) ?? "session closed",
        500
      ),
      status: args.aborted === true ? "aborted" : "ended"
    });
    return {
      ended: true,
      sessionId: session.id,
      surface: session.surface,
      browserClosed
    };
  }

  async observe(args = {}, context = {}) {
    const session = this._requireActive(context);
    if (session.surface === "browser") {
      const snapshot = await this.runtime.semanticBrowser.inspect({
        query: optionalText(args.query, 1_000),
        maxNodes: boundedInteger(args.maxNodes, 1, 500, 120, "maxNodes")
      }, this._browserContext(context));
      const observation = this._recordBrowserObservation(
        session,
        snapshot,
        "semantic"
      );
      return {
        sessionId: session.id,
        surface: session.surface,
        observationRevision: observation.revision,
        strategy: "semantic",
        snapshot
      };
    }
    const snippets = await (
      this.runtime.observations?.search?.({ limit: 3 })
      ?? Promise.resolve([])
    );
    const text = snippets
      .map((item) => String(item?.text ?? ""))
      .filter(Boolean)
      .join("\n")
      .slice(0, 4_000);
    const digest = sha256(text || "(empty)");
    const observation = this.log.recordObservation(session.id, {
      source: "desktop-ocr",
      generation: `ocr_${digest.slice(0, 16)}`,
      contentSha256: digest,
      app: optionalText(snippets[0]?.app, 200),
      nodeCount: snippets.length
    });
    return {
      sessionId: session.id,
      surface: session.surface,
      observationRevision: observation.revision,
      generation: observation.generation,
      app: snippets[0]?.app ?? "(unknown)",
      ocrSample: text || "(no recent OCR - capture may not be running)",
      note: "OCR is observation evidence, not coordinate authority. Capture a live screenshot before coordinate actions."
    };
  }

  async screenshot(args = {}, context = {}) {
    const session = this._requireActive(context);
    const reasoning = this._auditText(
      optionalText(args.reasoning, MAX_REASONING),
      MAX_REASONING
    );
    const action = this.log.recordAction({
      sessionId: session.id,
      kind: "screenshot",
      args: { fullPage: args.fullPage === true },
      reasoning,
      mutating: false
    });
    try {
      if (session.surface === "browser") {
        const shot = await this.runtime.semanticBrowser.screenshot({
          fullPage: args.fullPage === true
        }, this._browserContext(context));
        const observation = this._recordBrowserObservation(
          session,
          shot,
          "browser-screenshot"
        );
        this.log.markActionResult(action.id, {
          status: "executed",
          result: {
            source: "browser",
            generation: shot.generation,
            screenshotSha256: shot.evidence?.sha256 ?? null,
            width: shot.width,
            height: shot.height
          }
        });
        return {
          ...shot,
          controlSessionId: session.id,
          actionId: action.id,
          observationRevision: observation.revision
        };
      }
      const node = this._node();
      if (!node) {
        const observed = await this.observe({}, context);
        this.log.markActionResult(action.id, {
          status: "executed",
          result: {
            source: "desktop-ocr",
            generation: observed.generation
          }
        });
        return {
          actionId: action.id,
          ...observed,
          note: "OCR readback only - configure OPENAGI_COMPUTER_NODE for live pixels."
        };
      }
      const shot = normalizeNodeScreenshot(
        await callNode(node, "/screenshot", {}, this.fetchImpl)
      );
      const screenshotSha256 = sha256Base64(shot.base64);
      const observation = this.log.recordObservation(session.id, {
        source: "desktop-screenshot",
        generation: `screen_${screenshotSha256.slice(0, 16)}`,
        screenshotSha256,
        width: shot.width,
        height: shot.height
      });
      this.log.markActionResult(action.id, {
        status: "executed",
        result: {
          source: "desktop-node",
          generation: observation.generation,
          screenshotSha256,
          width: shot.width,
          height: shot.height
        }
      });
      return {
        actionId: action.id,
        controlSessionId: session.id,
        observationRevision: observation.revision,
        generation: observation.generation,
        image: shot.base64,
        format: shot.format,
        width: shot.width,
        height: shot.height,
        evidence: {
          sha256: screenshotSha256,
          capturedAt: observation.capturedAt,
          coordinateEligible: shot.width != null && shot.height != null
        },
        note: "Live screenshot from the computer-use node."
      };
    } catch (error) {
      this.log.markActionResult(action.id, {
        status: "error",
        error: safeError(error)
      });
      throw error;
    }
  }

  async act(args = {}, context = {}) {
    const session = this._requireActive(context);
    const actionName = requiredText(args.action, 64, "action");
    if (session.surface === "browser") {
      return this._browserAct(session, actionName, args, context);
    }
    return this._desktopAct(session, actionName, args, context);
  }

  async legacyDesktopAction({
    kind,
    path,
    args,
    payload,
    reasoning
  }, context = {}) {
    const session = this._requireActive(context);
    const action = this.log.recordAction({
      sessionId: session.id,
      kind,
      args: auditArgs(kind, args),
      reasoning: this._auditText(
        optionalText(reasoning, MAX_REASONING),
        MAX_REASONING
      ),
      mutating: true
    });
    const node = this._node();
    if (!node) {
      this.log.markActionResult(action.id, {
        status: "unavailable",
        result: { reason: "no computer-use node configured" }
      });
      throw new Error(
        "computer-use input synthesis is not available in this build. The intent was recorded to the audit log but NOT performed. Do not assume the action succeeded."
      );
    }
    try {
      await callNode(node, path, payload, this.fetchImpl);
      this.log.markActionResult(action.id, {
        status: "executed",
        result: { via: "node", legacy: true }
      });
      return {
        actionId: action.id,
        ok: true,
        warning: "Legacy coordinate action has no automatic post-action proof. Prefer computer_act."
      };
    } catch (error) {
      this.log.markActionResult(action.id, {
        status: "error",
        error: safeError(error)
      });
      throw error;
    }
  }

  async _browserAct(session, actionName, args, context) {
    const supported = [
      "activate",
      "input",
      "select",
      "scroll",
      "navigate",
      "visual_click"
    ];
    if (!supported.includes(actionName)) {
      throw new Error(
        `Browser computer_act action must be one of: ${supported.join(", ")}.`
      );
    }
    const before = requireObservationPrecondition(session, args);
    if (actionName === "visual_click") {
      requireCoordinateEvidence(before, args);
    }
    const reasoning = this._auditText(
      requiredText(args.reasoning, MAX_REASONING, "reasoning"),
      MAX_REASONING
    );
    const persistedArgs = auditArgs(actionName, {
      ref: args.ref,
      text: args.text,
      value: args.value,
      values: args.values,
      deltaY: args.deltaY,
      url: args.url,
      x: args.x,
      y: args.y,
      button: args.button,
      screenshotSha256: args.screenshotSha256,
      fallbackReason: this._auditText(args.fallbackReason, 500)
    });
    const action = this.log.recordAction({
      sessionId: session.id,
      kind: actionName,
      args: persistedArgs,
      reasoning,
      mutating: actionName !== "scroll",
      beforeObservationRevision: before.revision,
      beforeGeneration: before.generation
    });
    const browserContext = this._browserContext(context);
    try {
      let receipt;
      if (actionName === "activate") {
        receipt = await this.runtime.semanticBrowser.activate({
          ref: requiredText(args.ref, 256, "ref"),
          submit: args.submit === true
        }, browserContext);
      } else if (actionName === "input") {
        receipt = await this.runtime.semanticBrowser.input({
          ref: requiredText(args.ref, 256, "ref"),
          text: boundedRawText(args.text, MAX_TEXT, "text")
        }, browserContext);
      } else if (actionName === "select") {
        const selection = normalizeSelection(args);
        receipt = await this.runtime.semanticBrowser.select({
          ref: requiredText(args.ref, 256, "ref"),
          ...selection
        }, browserContext);
      } else if (actionName === "scroll") {
        receipt = await this.runtime.semanticBrowser.scroll({
          ref: optionalText(args.ref, 256),
          deltaY: boundedInteger(args.deltaY, -100_000, 100_000, 700, "deltaY")
        }, browserContext);
      } else if (actionName === "navigate") {
        receipt = await this.runtime.semanticBrowser.navigate({
          url: requiredText(args.url, 4_096, "url")
        }, browserContext);
      } else {
        receipt = await this.runtime.semanticBrowser.visualClick({
          x: boundedInteger(args.x, 0, 100_000, null, "x"),
          y: boundedInteger(args.y, 0, 100_000, null, "y"),
          button: args.button ?? "left",
          screenshotSha256: requiredSha256(args.screenshotSha256),
          expectedGeneration: before.generation,
          fallbackReason: requiredText(
            args.fallbackReason,
            500,
            "fallbackReason"
          )
        }, browserContext);
      }
      let snapshot;
      try {
        snapshot = await this.runtime.semanticBrowser.inspect(
          {},
          browserContext
        );
      } catch (verificationError) {
        this.log.markActionResult(action.id, {
          status: "executed-unverified",
          result: {
            strategy: actionName === "visual_click"
              ? "visual-fallback"
              : "semantic",
            action: actionName,
            beforeGeneration: before.generation,
            verificationError: safeError(verificationError)
          }
        });
        return {
          actionId: action.id,
          changed: actionName !== "scroll",
          action: actionName,
          strategy: actionName === "visual_click"
            ? "visual-fallback"
            : "semantic",
          receipt,
          postcondition: {
            verified: false,
            error: safeError(verificationError)
          }
        };
      }
      const after = this._recordBrowserObservation(
        session,
        snapshot,
        "post-action"
      );
      this.log.markActionResult(action.id, {
        status: "executed",
        result: {
          strategy: actionName === "visual_click"
            ? "visual-fallback"
            : "semantic",
          action: actionName,
          beforeGeneration: before.generation,
          afterGeneration: after.generation,
          afterObservationRevision: after.revision
        }
      });
      return {
        actionId: action.id,
        changed: actionName !== "scroll",
        action: actionName,
        strategy: actionName === "visual_click"
          ? "visual-fallback"
          : "semantic",
        receipt,
        postcondition: {
          verified: true,
          observationRevision: after.revision,
          snapshot
        }
      };
    } catch (error) {
      this.log.markActionResult(action.id, {
        status: "error",
        error: safeError(error)
      });
      throw error;
    }
  }

  async _desktopAct(session, actionName, args, context) {
    const endpoints = {
      click: ["/click", ["x", "y", "button"]],
      type: ["/type", ["text"]],
      key: ["/key", ["chord"]],
      scroll: ["/scroll", ["x", "y", "deltaX", "deltaY"]],
      move: ["/move", ["x", "y"]]
    };
    if (!Object.hasOwn(endpoints, actionName)) {
      throw new Error(
        `Desktop computer_act action must be one of: ${Object.keys(endpoints).join(", ")}.`
      );
    }
    const before = requireObservationPrecondition(session, args);
    if (["click", "move"].includes(actionName)) {
      requireCoordinateEvidence(before, args);
    }
    const reasoning = this._auditText(
      requiredText(args.reasoning, MAX_REASONING, "reasoning"),
      MAX_REASONING
    );
    const payload = desktopPayload(actionName, args);
    const action = this.log.recordAction({
      sessionId: session.id,
      kind: actionName,
      args: auditArgs(actionName, payload),
      reasoning,
      mutating: actionName !== "move" && actionName !== "scroll",
      beforeObservationRevision: before.revision,
      beforeGeneration: before.generation
    });
    const node = this._node();
    if (!node) {
      this.log.markActionResult(action.id, {
        status: "unavailable",
        result: { reason: "no computer-use node configured" }
      });
      throw new Error(
        "Desktop action execution is unavailable without OPENAGI_COMPUTER_NODE. The intent was logged but not performed."
      );
    }
    try {
      await callNode(node, endpoints[actionName][0], payload, this.fetchImpl);
      let postcondition;
      let image = null;
      let imageWidth = null;
      let imageHeight = null;
      try {
        const shot = normalizeNodeScreenshot(
          await callNode(node, "/screenshot", {}, this.fetchImpl)
        );
        const screenshotSha256 = sha256Base64(shot.base64);
        const after = this.log.recordObservation(session.id, {
          source: "desktop-post-action",
          generation: `screen_${screenshotSha256.slice(0, 16)}`,
          screenshotSha256,
          width: shot.width,
          height: shot.height
        });
        postcondition = {
          verified: true,
          observationRevision: after.revision,
          generation: after.generation,
          screenshotSha256
        };
        image = {
          data: shot.base64,
          mediaType: nodeImageMediaType(shot.format)
        };
        imageWidth = shot.width;
        imageHeight = shot.height;
      } catch (verificationError) {
        postcondition = {
          verified: false,
          error: safeError(verificationError)
        };
      }
      this.log.markActionResult(action.id, {
        status: postcondition.verified ? "executed" : "executed-unverified",
        result: {
          via: "node",
          action: actionName,
          beforeGeneration: before.generation,
          afterGeneration: postcondition.generation ?? null,
          verified: postcondition.verified
        }
      });
      return {
        actionId: action.id,
        changed: !["move", "scroll"].includes(actionName),
        action: actionName,
        strategy: "desktop-node",
        postcondition,
        ...(image
          ? {
              image,
              width: imageWidth,
              height: imageHeight,
              untrusted: true
            }
          : {})
      };
    } catch (error) {
      this.log.markActionResult(action.id, {
        status: "error",
        error: safeError(error)
      });
      throw error;
    }
  }

  _recordBrowserObservation(session, value, source) {
    return this.log.recordObservation(session.id, {
      source,
      generation: requiredText(value?.generation, 128, "generation"),
      screenshotSha256: value?.evidence?.sha256 ?? null,
      urlOrigin: safeOrigin(value?.url),
      nodeCount: Array.isArray(value?.nodes) ? value.nodes.length : null,
      width: value?.width ?? null,
      height: value?.height ?? null
    });
  }

  _active(context) {
    const owner = ownerFromContext(context);
    return this.log.getActiveSession(owner);
  }

  _requireActive(context) {
    const session = this._active(context);
    if (!session) {
      throw new Error(
        "No active computer-use session for this project session. Call start_computer_use_session first."
      );
    }
    return session;
  }

  _browserContext(context, { allowArchived = false } = {}) {
    const projectId = String(context.__projectId ?? "").trim().toLowerCase();
    const sessionId = String(context.sessionId ?? "").trim();
    if (!projectId || !sessionId) {
      throw new Error(
        "Browser computer use requires an authenticated project session."
      );
    }
    if (typeof this.runtime.projects?.authorize !== "function") {
      throw new Error("Browser project authorization is unavailable.");
    }
    const project = this.runtime.projects.authorize(projectId, {
      sessionId,
      includeArchived: allowArchived
    });
    if (!project || (!allowArchived && project.status !== "active")) {
      throw new Error(`Browser project '${projectId}' is unavailable.`);
    }
    const revision = Number(context.__projectRevision);
    if (!Number.isSafeInteger(revision) || revision !== project.revision) {
      throw new Error(`Browser project '${projectId}' revision is stale.`);
    }
    return {
      ...context,
      projectId: project.id,
      projectRevision: project.revision,
      workspaceRoot: project.workspaceRoot,
      scrutinyPolicy: context.__scrutinyPolicy
        ?? project.policy?.toolPolicy
        ?? "full",
      __projectId: project.id,
      __projectRevision: project.revision,
      __projectWorkspaceDir: project.workspaceRoot,
      __projectSecretRefs: [...(project.secretRefs ?? [])],
      sessionId
    };
  }

  _node() {
    const url = String(this.env.OPENAGI_COMPUTER_NODE ?? "")
      .trim()
      .replace(/\/$/, "");
    if (!url) return null;
    return {
      url,
      token: this.env.OPENAGI_COMPUTER_NODE_TOKEN ?? null
    };
  }

  _auditText(value, maxLength) {
    if (value == null) return null;
    const snapshot = secretsStoreRedactionSnapshot(this.runtime.secrets);
    if (snapshot?.overflow === true) {
      return "[REDACTED: secret inventory unavailable]";
    }
    const values = new Set();
    for (const record of snapshot?.records ?? []) {
      for (const spelling of secretRedactionSpellings(record.value)) {
        values.add(spelling);
      }
    }
    for (const spelling of secretRedactionSpellings(this._node()?.token)) {
      values.add(spelling);
    }
    return String(redactKnownValues(
      String(value).slice(0, maxLength),
      values
    )).slice(0, maxLength);
  }
}

export async function callComputerNode(
  node,
  path,
  body,
  fetchImpl = globalThis.fetch
) {
  return callNode(node, path, body, fetchImpl);
}

function ownerFromContext(context = {}) {
  const projectId = String(
    context.__projectId ?? context.projectId ?? ""
  ).trim().toLowerCase() || null;
  const agentSessionId = String(context.sessionId ?? "").trim() || null;
  return { projectId, agentSessionId };
}

function requireObservationPrecondition(session, args) {
  const observation = session.lastObservation;
  if (!observation) {
    throw new Error(
      "computer_act requires a current observation. Call computer_observe or computer_screenshot first."
    );
  }
  const expectedRevision = boundedInteger(
    args.observationRevision,
    1,
    Number.MAX_SAFE_INTEGER,
    null,
    "observationRevision"
  );
  const expectedGeneration = requiredText(
    args.expectedGeneration,
    128,
    "expectedGeneration"
  );
  if (
    expectedRevision !== observation.revision
    || expectedGeneration !== observation.generation
  ) {
    throw new Error(
      "computer_act observation precondition is stale. Observe again before acting."
    );
  }
  return observation;
}

function requireCoordinateEvidence(observation, args) {
  const screenshotSha256 = requiredSha256(args.screenshotSha256);
  if (
    observation.screenshotSha256 !== screenshotSha256
    || !Number.isSafeInteger(observation.width)
    || !Number.isSafeInteger(observation.height)
  ) {
    throw new Error(
      "Coordinate actions require the exact current viewport screenshot evidence."
    );
  }
  requiredInteger(args.x, 0, observation.width - 1, "x");
  requiredInteger(args.y, 0, observation.height - 1, "y");
}

function desktopPayload(action, args) {
  if (action === "click") {
    return {
      x: requiredInteger(args.x, 0, 100_000, "x"),
      y: requiredInteger(args.y, 0, 100_000, "y"),
      button: enumValue(
        args.button ?? "left",
        ["left", "right", "middle"],
        "button"
      )
    };
  }
  if (action === "type") {
    return { text: boundedRawText(args.text, MAX_TEXT, "text") };
  }
  if (action === "key") {
    return { chord: requiredText(args.chord, 200, "chord") };
  }
  if (action === "scroll") {
    return {
      x: boundedInteger(args.x, 0, 100_000, 0, "x"),
      y: boundedInteger(args.y, 0, 100_000, 0, "y"),
      deltaX: boundedInteger(
        args.deltaX,
        -100_000,
        100_000,
        0,
        "deltaX"
      ),
      deltaY: boundedInteger(
        args.deltaY,
        -100_000,
        100_000,
        0,
        "deltaY"
      )
    };
  }
  return {
    x: requiredInteger(args.x, 0, 100_000, "x"),
    y: requiredInteger(args.y, 0, 100_000, "y")
  };
}

function auditArgs(kind, args = {}) {
  const value = {};
  for (const [key, item] of Object.entries(args)) {
    if (item === undefined) continue;
    if (key === "text") {
      const text = String(item);
      value.text = "[REDACTED]";
      value.textLength = text.length;
      continue;
    }
    if (
      kind === "select"
      && (key === "value" || key === "values")
    ) {
      value.selection = "[OMITTED]";
      value.selectionCount = Array.isArray(item) ? item.length : 1;
      continue;
    }
    if (/password|token|secret/i.test(key)) {
      value[key] = "[REDACTED]";
      continue;
    }
    if (key === "url") {
      value.urlOrigin = safeOrigin(item);
      continue;
    }
    value[key] = structuredClone(item);
  }
  value.auditVersion = 1;
  value.kind = kind;
  return value;
}

function normalizeSelection(args) {
  const one = typeof args.value === "string";
  const many = Array.isArray(args.values) && args.values.length > 0;
  if (one === many) {
    throw new Error(
      "select requires exactly one of value or a non-empty values array."
    );
  }
  if (one) return { value: boundedRawText(args.value, 10_000, "value") };
  if (args.values.length > 100) {
    throw new Error("select accepts at most 100 values.");
  }
  return {
    values: args.values.map((item) => (
      boundedRawText(item, 10_000, "values item")
    ))
  };
}

async function callNode(node, path, body, fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Computer-use node transport is unavailable.");
  }
  const redactValues = secretRedactionSpellings(node.token);
  let response;
  try {
    response = await fetchImpl(`${node.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(node.token
          ? { authorization: `Bearer ${node.token}` }
          : {})
      },
      body: JSON.stringify(body ?? {})
    });
  } catch (error) {
    throw new Error(redactKnownValues(safeError(error), redactValues));
  }
  const json = await response.json().catch(() => ({}));
  const safeJson = redactKnownValues(json, redactValues);
  if (!response.ok) {
    throw new Error(
      safeJson.error || `computer node HTTP ${response.status}`
    );
  }
  return safeJson;
}

function normalizeNodeScreenshot(value) {
  const base64 = String(value?.base64 ?? "");
  if (!base64 || base64.length > MAX_NODE_IMAGE_CHARS) {
    throw new Error("Computer-use node returned an invalid or oversized screenshot.");
  }
  const format = String(value?.format ?? "png").toLowerCase();
  if (!["png", "jpeg", "jpg", "webp"].includes(format)) {
    throw new Error("Computer-use node returned an unsupported screenshot format.");
  }
  return {
    base64,
    format,
    width: positiveIntegerOrNull(value?.width),
    height: positiveIntegerOrNull(value?.height)
  };
}

function nodeImageMediaType(format) {
  if (format === "jpg") return "image/jpeg";
  return `image/${format}`;
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.origin;
  } catch {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sha256Base64(value) {
  return crypto.createHash("sha256")
    .update(Buffer.from(String(value), "base64"))
    .digest("hex");
}

function requiredSha256(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error("screenshotSha256 must be an exact SHA-256 digest.");
  }
  return text;
}

function requiredText(value, maxLength, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new TypeError(
      `${label} must contain 1 to ${maxLength} characters.`
    );
  }
  return text;
}

function optionalText(value, maxLength) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function boundedRawText(value, maxLength, label) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(
      `${label} must be a string no longer than ${maxLength} characters.`
    );
  }
  return value;
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number)
    || number < minimum
    || number > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return number;
}

function requiredInteger(value, minimum, maximum, label) {
  const number = boundedInteger(value, minimum, maximum, null, label);
  if (number == null) {
    throw new TypeError(
      `${label} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return number;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function enumValue(value, allowed, label) {
  const text = String(value ?? "");
  if (!allowed.includes(text)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return text;
}

function safeError(error) {
  return String(error?.message ?? error ?? "unknown error").slice(0, 2_000);
}
